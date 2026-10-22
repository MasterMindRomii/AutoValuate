// Pure-JS inference for the AutoValuate Ridge model.
// No dependencies, so it runs the same in a Cloudflare Worker, Node, or a browser.
//
// The model predicts log(price):
//   log(price) = intercept
//              + w.fuel[fuel] + w.trans[trans] + w.family[family] + w.trim[trim] + w.variant[family trim]
//              + a * age + a2 * age^2 + k * log(1 + kms)
// so price = exp(that). Unknown categories simply contribute 0 (same as scikit-learn's
// OneHotEncoder(handle_unknown="ignore")).

const w = (table, key) => (table && key in table ? table[key] : 0);

export function logPrice(model, { family, trim, year, kms, fuel, transmission }) {
  const age = model.ref_year - year;
  const W = model.weights;
  const N = model.numeric;
  return (
    model.intercept +
    w(W.fuel, fuel) +
    w(W.trans, transmission) +
    w(W.family, family) +
    w(W.trim, trim) +
    w(W.variant, `${family} ${trim}`) +
    N.age * age +
    N.age2 * age * age +
    N.log_kms * Math.log1p(kms)
  );
}

export function predictPrice(model, input) {
  return Math.exp(logPrice(model, input));
}

/** Throws an Error with a user-facing message if the input is unusable. */
export function validate(model, body) {
  if (!body || typeof body !== "object") throw new Error("Send a JSON body with the car details.");
  const { family, trim, fuel, transmission } = body;
  const year = Number(body.year);
  const kms = Number(body.kms);
  const fam = model.catalog[family];
  if (!fam) throw new Error(`Unknown model "${family}". Choose one of: ${Object.keys(model.catalog).join(", ")}.`);
  if (!fam.trims[trim]) throw new Error(`"${trim}" is not a known variant of the Honda ${family}.`);
  if (!model.fuels.includes(fuel)) throw new Error(`Fuel must be one of: ${model.fuels.join(", ")}.`);
  if (!model.trans.includes(transmission)) throw new Error(`Transmission must be one of: ${model.trans.join(", ")}.`);
  const [y0, y1] = model.bounds.year;
  if (!Number.isInteger(year) || year < y0 || year > y1) throw new Error(`Year must be between ${y0} and ${y1}.`);
  if (!Number.isFinite(kms) || kms < 500 || kms > 300000) throw new Error("Kilometres driven must be between 500 and 3,00,000.");
  return { family, trim, fuel, transmission, year, kms: Math.round(kms) };
}

/** What moved the price — each factor as a % change against a sensible reference. */
export function explain(model, input) {
  const { family, trim, year, kms, fuel, transmission } = input;
  const W = model.weights;
  const N = model.numeric;
  const age = model.ref_year - year;
  const pct = (x) => Math.round((Math.exp(x) - 1) * 1000) / 10;

  // Variant premium vs. the average variant of this model (weighted by listings).
  const trims = model.catalog[family].trims;
  let total = 0, acc = 0;
  for (const [t, info] of Object.entries(trims)) {
    acc += info.count * (w(W.trim, t) + w(W.variant, `${family} ${t}`));
    total += info.count;
  }
  const variantEffect = w(W.trim, trim) + w(W.variant, `${family} ${trim}`) - acc / total;

  const oneYearOlder = N.age + N.age2 * (2 * age + 1);
  const medianKms = model.bounds.median_kms;

  return [
    { key: "variant", label: `${trim} variant vs. an average ${family}`, effect: pct(variantEffect) },
    { key: "kms", label: `${kms.toLocaleString("en-IN")} km vs. a typical ${medianKms.toLocaleString("en-IN")} km`,
      effect: pct(N.log_kms * (Math.log1p(kms) - Math.log1p(medianKms))) },
    { key: "transmission", label: transmission === "Automatic" ? "Automatic vs. manual" : "Manual vs. automatic",
      effect: pct(w(W.trans, transmission) - w(W.trans, transmission === "Automatic" ? "Manual" : "Automatic")) },
    { key: "fuel", label: fuel === "Petrol" ? "Petrol (baseline)" : `${fuel} vs. petrol`,
      effect: pct(w(W.fuel, fuel) - w(W.fuel, "Petrol")) },
    { key: "age", label: "Each extra year of age, at this point", effect: pct(oneYearOlder) },
  ];
}

/** Projected value for the next `years` years, assuming the car keeps its current yearly mileage. */
export function project(model, input, years = 5) {
  const age = Math.max(1, model.ref_year - input.year);
  const perYear = Math.min(Math.max(input.kms / age, 5000), 25000);
  const out = [];
  for (let i = 0; i <= years; i++) {
    out.push({
      yearsFromNow: i,
      kms: Math.round(input.kms + perYear * i),
      price: Math.round(predictPrice(model, { ...input, year: input.year - i, kms: input.kms + perYear * i })),
    });
  }
  return out;
}

/** Closest real listings from the training data. */
export function similar(listings, input, limit = 5) {
  return listings
    .filter((r) => r[4] === input.family)
    .map((r) => {
      const [year, kms, fuel, trans, family, trim, price] = r;
      const score =
        Math.abs(year - input.year) * 1.0 +
        Math.abs(kms - input.kms) / 20000 +
        (trim === input.trim ? 0 : 1.5) +
        (fuel === input.fuel ? 0 : 1) +
        (trans === input.transmission ? 0 : 1);
      return { year, kms, fuel, transmission: trans, model: `${family} ${trim}`, price, score };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map(({ score, ...rest }) => rest);
}

export function estimate(model, listings, input) {
  const lp = logPrice(model, input);
  const price = Math.exp(lp);
  return {
    input,
    price: Math.round(price),
    range: {
      low: Math.round(Math.exp(lp + model.interval.low)),
      high: Math.round(Math.exp(lp + model.interval.high)),
      coverage: model.interval.coverage,
    },
    factors: explain(model, input),
    projection: project(model, input),
    similar: similar(listings, input),
  };
}
