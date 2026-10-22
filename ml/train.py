"""
AutoValuate — training script
=============================

Reads the raw Honda listings CSV, cleans it, trains a Ridge regression on
log(price), evaluates it with cross-validation, and exports everything the
Cloudflare Worker needs as plain JSON:

    src/data/model.json     -> coefficients, catalog of models/variants, metrics
    src/data/listings.json  -> compact cleaned listings (for "similar cars")
    test/fixtures.json      -> sample inputs + Python predictions (parity test)

Why JSON and not model.pkl?  Cloudflare Workers run JavaScript, not Python +
scikit-learn. A linear model is just "intercept + sum of weights", so we can
ship the weights as JSON and do the maths in ~30 lines of JS. No server, no
cold start, no pickle security issues.

Usage:
    pip install -r ml/requirements.txt
    python ml/train.py                       # uses ml/data/honda_car_selling.csv
    python ml/train.py --data path/to.csv    # any CSV with the same columns
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.linear_model import LinearRegression, Ridge
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import KFold, cross_val_predict, train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder

ROOT = Path(__file__).resolve().parent.parent

# The listings were scraped in 2023. Age is measured against the following year
# so a 2023 car is "1 year old" — keep this fixed unless you retrain on new data.
REF_YEAR = 2024
MAX_KMS = 300_000          # 2 rows claim 6.5 lakh and 11 lakh km — clearly typos
CATEGORICAL = ["fuel", "trans", "family", "trim", "variant"]
NUMERIC = ["age", "age2", "log_kms"]
ALPHAS = [0.25, 0.5, 1.0, 2.0, 4.0]

# Trim tokens as they appear in the raw names (upper-cased) -> display label.
TRIMS = {
    "ZX": "ZX", "VX": "VX", "SV": "SV", "SX": "SX", "EX": "EX", "EXI": "EXi",
    "GXI": "GXi", "DX": "DX", "V": "V", "S": "S", "E": "E", "(E)": "E", "X": "X",
    "RS": "RS", "RVI": "RVi", "VTI-L": "VTi-L", "ELEGANCE": "Elegance",
    "EXCLUSIVE": "Exclusive", "EDGE": "Edge", "SELECT": "Select", "BASIC": "Basic",
    "CORPORATE": "Corporate", "ANNIVERSARY": "Anniversary", "PRIVIL": "Privilege",
}


# --------------------------------------------------------------------------- #
# Cleaning
# --------------------------------------------------------------------------- #
def parse_price(text: str) -> float:
    """'9.29 Lakh' -> 929000, '85,000' -> 85000. No eval() involved."""
    text = str(text).strip().replace(",", "")
    match = re.search(r"[\d.]+", text)
    if not match:
        return np.nan
    value = float(match.group())
    if "crore" in text.lower():
        return value * 1e7
    if "lakh" in text.lower():
        return value * 1e5
    return value


def extract_trim(name: str) -> str:
    for token in name.split()[2:]:
        if token.upper() in TRIMS:
            return TRIMS[token.upper()]
    return "Standard"


def clean(raw: pd.DataFrame) -> pd.DataFrame:
    df = pd.DataFrame({
        "year": pd.to_numeric(raw["Year"], errors="coerce"),
        "kms": pd.to_numeric(
            raw["kms Driven"].astype(str).str.replace(",", "").str.extract(r"(\d+)")[0],
            errors="coerce"),
        "fuel": raw["Fuel Type"].astype(str).str.strip(),
        # The source column is called "Suspension" but it actually holds the
        # gearbox type (Automatic / Manual), so we call it what it is.
        "trans": raw["Suspension"].astype(str).str.strip(),
        "name": raw["Car Model"].astype(str).str.strip().str.replace(r"\s+", " ", regex=True),
        "price": raw["Price"].map(parse_price),
    }).dropna()

    df = df.drop_duplicates()
    df = df[(df["kms"] > 0) & (df["kms"] < MAX_KMS) & (df["price"] > 10_000)]
    df["year"] = df["year"].astype(int)
    df["kms"] = df["kms"].astype(int)
    df["family"] = df["name"].str.split().str[1]
    df["trim"] = df["name"].map(extract_trim)
    df["variant"] = df["family"] + " " + df["trim"]
    return df.reset_index(drop=True)


def features(df: pd.DataFrame) -> pd.DataFrame:
    out = df[["fuel", "trans", "family", "trim", "variant"]].copy()
    out["age"] = REF_YEAR - df["year"]
    out["age2"] = out["age"] ** 2
    out["log_kms"] = np.log1p(df["kms"])
    return out[CATEGORICAL + NUMERIC]


def make_pipeline(alpha: float) -> Pipeline:
    pre = ColumnTransformer(
        [("cat", OneHotEncoder(handle_unknown="ignore"), CATEGORICAL)],
        remainder="passthrough",
        verbose_feature_names_out=False,
    )
    return Pipeline([("pre", pre), ("ridge", Ridge(alpha=alpha))])


def report(y, pred) -> dict:
    return {
        "r2": round(float(r2_score(y, pred)), 4),
        "mae": round(float(mean_absolute_error(y, pred))),
        "mape": round(float(np.mean(np.abs(pred - y) / y) * 100), 2),
    }


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=ROOT / "ml" / "data" / "honda_car_selling.csv")
    args = ap.parse_args()

    raw = pd.read_csv(args.data)
    df = clean(raw)
    X, y = features(df), df["price"].to_numpy()
    log_y = np.log(y)
    kf = KFold(n_splits=5, shuffle=True, random_state=42)
    print(f"Rows: raw={len(raw)}  clean={len(df)}")

    # 1) Baseline = the original project's approach, on the same clean data.
    base_X = pd.get_dummies(df[["year", "kms", "fuel", "trans"]].assign(
        model3=df["name"].str.split().str[:3].str.join(" ")), dtype=int)
    base_pred = cross_val_predict(LinearRegression(), base_X, y, cv=kf)
    baseline = report(y, base_pred)
    baseline["negative_predictions"] = int((base_pred < 0).sum())
    print("Baseline (original LinearRegression):", baseline)

    # 2) Choose alpha by cross-validated MAE.
    best = None
    for alpha in ALPHAS:
        pred = np.exp(cross_val_predict(make_pipeline(alpha), X, log_y, cv=kf))
        m = report(y, pred)
        print(f"  ridge alpha={alpha:<5} {m}")
        if best is None or m["mae"] < best[1]["mae"]:
            best = (alpha, m, pred)
    alpha, cv_metrics, cv_pred = best
    print(f"Chosen alpha={alpha}: {cv_metrics}")

    # 3) Honest hold-out score (never seen during training).
    X_tr, X_te, y_tr, y_te = train_test_split(X, log_y, test_size=0.2, random_state=7)
    holdout = report(np.exp(y_te), np.exp(make_pipeline(alpha).fit(X_tr, y_tr).predict(X_te)))
    print("Hold-out 20%:", holdout)

    # 4) Price range = spread of cross-validated errors (in log space).
    log_resid = np.log(y) - np.log(cv_pred)
    lo_q, hi_q = np.quantile(log_resid, [0.10, 0.90])

    # 5) Fit on all data and export the weights.
    final = make_pipeline(alpha).fit(X, log_y)
    names = final.named_steps["pre"].get_feature_names_out()
    coefs = final.named_steps["ridge"].coef_
    weights = {c: {} for c in CATEGORICAL}
    numeric = {}
    for name, w in zip(names, coefs):
        for c in CATEGORICAL:
            if name.startswith(c + "_"):
                weights[c][name[len(c) + 1:]] = round(float(w), 6)
                break
        else:
            numeric[name] = float(w)

    catalog = {}
    for fam, g in df.groupby("family"):
        catalog[fam] = {
            "count": int(len(g)),
            "years": [int(g.year.min()), int(g.year.max())],
            "trims": {
                t: {
                    "count": int(len(tg)),
                    "years": [int(tg.year.min()), int(tg.year.max())],
                    "fuels": sorted(tg.fuel.unique().tolist()),
                    "trans": sorted(tg.trans.unique().tolist()),
                    "median_price": int(tg.price.median()),
                }
                for t, tg in sorted(g.groupby("trim"), key=lambda kv: -len(kv[1]))
            },
        }

    model = {
        "name": "AutoValuate Honda Ridge v2",
        "trained_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "ref_year": REF_YEAR,
        "alpha": alpha,
        "intercept": float(final.named_steps["ridge"].intercept_),
        "numeric": numeric,
        "weights": weights,
        "interval": {"low": float(lo_q), "high": float(hi_q), "coverage": 0.8},
        "metrics": {"cv": cv_metrics, "holdout": holdout, "baseline": baseline,
                    "rows": int(len(df))},
        "bounds": {"year": [int(df.year.min()), int(df.year.max())],
                   "kms": [int(df.kms.min()), int(df.kms.max())],
                   "median_kms": int(df.kms.median())},
        "fuels": sorted(df.fuel.unique().tolist()),
        "trans": sorted(df.trans.unique().tolist()),
        "catalog": catalog,
    }

    out_dir = ROOT / "src" / "data"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "model.json").write_text(json.dumps(model, indent=1))

    # Compact listings: [year, kms, fuel, trans, family, trim, price]
    listings = df[["year", "kms", "fuel", "trans", "family", "trim", "price"]].copy()
    listings["price"] = listings["price"].astype(int)
    (out_dir / "listings.json").write_text(json.dumps(listings.values.tolist(), separators=(",", ":")))

    # Parity fixtures: the JS implementation must reproduce these numbers.
    sample = df.sample(40, random_state=1)
    preds = np.exp(final.predict(features(sample)))
    fixtures = [
        {"input": {"family": r.family, "trim": r.trim, "year": int(r.year), "kms": int(r.kms),
                   "fuel": r.fuel, "transmission": r.trans},
         "expected": float(p)}
        for r, p in zip(sample.itertuples(), preds)
    ]
    (ROOT / "test" / "fixtures.json").write_text(json.dumps(fixtures, indent=1))
    print(f"Wrote {out_dir/'model.json'}, listings.json and test/fixtures.json")


if __name__ == "__main__":
    main()
