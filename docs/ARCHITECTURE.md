# How AutoValuate fits together

There are three pieces: a Python script that learns from the data, a small Worker that does the maths, and a static website. They only talk to each other through JSON files and one HTTP API, which keeps each piece simple and lets you change one without touching the others.

```
 ┌──────────── offline, on your laptop ────────────┐      ┌──────────── on Cloudflare ─────────────┐
 │                                                 │      │                                        │
 │  ml/data/honda_car_selling.csv                  │      │   public/  ──▶  served as static files  │
 │            │                                    │      │                                        │
 │            ▼                                    │      │   /api/*   ──▶  src/index.js (Worker)   │
 │  ml/train.py                                    │      │                      │                 │
 │   clean → features → Ridge → evaluate → export  │      │                      ▼                 │
 │            │                                    │      │                 src/model.js           │
 │            ├──▶ src/data/model.json  ───────────┼──────┼──▶  weights, catalog, metrics          │
 │            ├──▶ src/data/listings.json ─────────┼──────┼──▶  for "similar cars"                 │
 │            └──▶ test/fixtures.json              │      │                                        │
 └─────────────────────────────────────────────────┘      └────────────────────────────────────────┘
```

## The training script (`ml/train.py`)

It does five things in order.

**Cleaning.** It turns "19006 kms" into 19006 and "9.29 Lakh" into 929000 (it also understands "Crore" and plain numbers), strips stray spaces, drops exact duplicates and two impossible mileages, and splits each car name into a model (City) and a trim (VX).

**Features.** The model sees eight inputs: fuel, gearbox, model, trim, model-and-trim together, age, age squared and log(1 + kilometres). Age is counted from 2024 because the listings are from 2023.

**Training.** It fits a Ridge regression to log(price). Ridge is linear regression with a small penalty on large weights. With 55 model-and-trim combinations and some of them seen only once, that penalty stops the model from trusting a single listing too much.

**Evaluation.** It runs 5-fold cross-validation for several penalty strengths, picks the one with the lowest average error, and also reports a 20% hold-out score and the old v1 approach on the same data for comparison. The cross-validated errors are also used to build the price range: the 10th and 90th percentiles of the errors become the low and high ends.

**Export.** It writes the weights to `model.json`, a compact copy of the cleaned listings to `listings.json`, and 40 sample predictions to `test/fixtures.json`.

## The prediction maths (`src/model.js`)

The whole model is this:

```
log(price) = intercept
           + weight[fuel] + weight[gearbox] + weight[model] + weight[trim] + weight[model + trim]
           + a × age + b × age² + c × log(1 + km)

price = e^(log price)
```

If a value wasn't seen in training its weight is zero, which is the same thing scikit-learn does with `handle_unknown="ignore"`.

Because the model works in logs, each weight is a percentage effect. A gearbox weight difference of 0.117 means `e^0.117 − 1 ≈ 12.4%` more for an automatic. That's how the "What moved the price" panel is built: each line compares the car with a sensible alternative (manual vs. automatic, your kilometres vs. the typical 60,000, your trim vs. the average trim for that model).

The five-year projection runs the same formula with the car one, two, three, four and five years older and with extra kilometres at the car's current yearly rate (kept between 5,000 and 25,000 a year). The similar-cars list scores every listing of the same model by how far it is in year, kilometres, trim, fuel and gearbox, and returns the five closest.

`model.js` has no imports, so the same file works in the Worker, in Node for the tests, and in a browser if you ever want to run the model client-side.

## The Worker (`src/index.js`)

Cloudflare reads `wrangler.jsonc`, which says two things: the website lives in `public/`, and any request to `/api/*` should go to the Worker first. So a request for `/styles.css` is answered straight from Cloudflare's cache without running any code, and only API calls run the Worker.

The Worker imports `model.json` and `listings.json` directly. Wrangler bundles them into the deployed script, so there's no file reading or database at request time, and a prediction takes well under a millisecond of CPU.

## The website (`public/`)

Plain HTML, CSS and JavaScript with no framework and no build step. `app.js` loads `/api/meta` once to build the form, so adding a new model or variant to the data adds it to the page automatically after retraining. After the first estimate, any change re-runs the prediction after a short pause, and an in-flight request is cancelled if a newer one starts.

The visual design borrows from Indian roads: number-plate yellow, the blue "IND" strip on the logo, asphalt grey and road-marking white. The price is shown on an odometer whose digits roll into place, which is the one animated element on the page. It respects the "reduce motion" setting, works in light and dark mode, and is laid out for phones first.

## Why not run Python on Cloudflare?

Cloudflare does offer Python Workers, but scikit-learn, NumPy and pandas would make every cold start slower and the bundle far bigger, all to calculate a weighted sum. Exporting the weights is faster, cheaper and easier to test. If you later switch to a model that genuinely needs Python, the cleanest options are to export it to ONNX and run it with ONNX Runtime Web, or to host the Python part separately and have the Worker call it.
