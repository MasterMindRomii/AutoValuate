# API reference

The Worker has three endpoints. All of them return JSON and allow requests from any website (CORS is open), so you can call them from another front end, a mobile app or a script.

Replace `https://autovaluate.example.workers.dev` with your own URL, or `http://localhost:8787` while developing.

---

## `GET /api/health`

A quick check that the Worker is up and which model it's serving.

```json
{ "ok": true, "model": "AutoValuate Honda Ridge v2", "trained_at": "2026-10-22T06:50:54Z" }
```

---

## `GET /api/meta`

Everything a form needs: the list of models and their variants, which fuels and gearboxes each variant was sold with, the years available, and the model's accuracy figures. The website calls this once on load. It's cached for an hour.

```json
{
  "fuels": ["CNG", "Diesel", "Petrol"],
  "transmissions": ["Automatic", "Manual"],
  "bounds": { "year": [2000, 2023], "kms": [1425, 235702], "median_kms": 60000 },
  "metrics": { "cv": { "r2": 0.8826, "mae": 70456, "mape": 15.72 }, "rows": 972, "...": "..." },
  "catalog": {
    "City": {
      "count": 476,
      "years": [2000, 2022],
      "trims": {
        "V":  { "count": 142, "years": [2008, 2022], "fuels": ["Diesel", "Petrol"], "trans": ["Automatic", "Manual"], "median_price": 575000 },
        "VX": { "...": "..." }
      }
    }
  }
}
```

---

## `POST /api/predict`

Send the car's details:

```bash
curl -X POST https://autovaluate.example.workers.dev/api/predict \
  -H "Content-Type: application/json" \
  -d '{"family":"City","trim":"V","year":2018,"kms":40000,"fuel":"Petrol","transmission":"Manual"}'
```

| Field | Type | Allowed values |
|---|---|---|
| `family` | string | A key of `catalog`: `City`, `Amaze`, `Jazz`, `Brio`, `WR-V`, `Civic`, `BR-V`, `Mobilio`, `CR-V`, `Accord` |
| `trim` | string | A key of `catalog[family].trims`, such as `V` or `VX` |
| `year` | integer | Between `bounds.year[0]` and `bounds.year[1]` |
| `kms` | number | 500 to 300,000 |
| `fuel` | string | `Petrol`, `Diesel` or `CNG` |
| `transmission` | string | `Automatic` or `Manual` |

For quick testing in a browser you can also use `GET` with the same fields as query parameters:
`/api/predict?family=City&trim=V&year=2018&kms=40000&fuel=Petrol&transmission=Manual`

### Response

```json
{
  "input": { "family": "City", "trim": "V", "fuel": "Petrol", "transmission": "Manual", "year": 2018, "kms": 40000 },
  "price": 792515,
  "range": { "low": 624908, "high": 1004491, "coverage": 0.8 },
  "factors": [
    { "key": "variant", "label": "V variant vs. an average City", "effect": 2.8 },
    { "key": "kms", "label": "40,000 km vs. a typical 60,000 km", "effect": 3 },
    { "key": "transmission", "label": "Manual vs. automatic", "effect": -11 },
    { "key": "fuel", "label": "Petrol (baseline)", "effect": 0 },
    { "key": "age", "label": "Each extra year of age, at this point", "effect": -9 }
  ],
  "projection": [
    { "yearsFromNow": 0, "kms": 40000, "price": 792515 },
    { "yearsFromNow": 1, "kms": 46667, "price": 713399 }
  ],
  "similar": [
    { "year": 2018, "kms": 33412, "fuel": "Petrol", "transmission": "Manual", "model": "City V", "price": 840000 }
  ]
}
```

- `price` is the estimate in rupees.
- `range` is where 80% of comparable listings landed during testing (`coverage: 0.8`).
- `factors[].effect` is a percentage change. `-11` means "about 11% less than the alternative".
- `projection` has six entries, from now to five years out, assuming the car keeps being driven at its current yearly rate.
- `similar` holds up to five real listings from the training data that are closest to this car.

### Errors

Bad input returns status `422` with a message you can show to the user as it is:

```json
{ "error": "\"Turbo\" is not a known variant of the Honda City." }
```

| Status | Meaning |
|---|---|
| 400 | The body isn't valid JSON |
| 404 | No endpoint at that path |
| 405 | Wrong HTTP method |
| 422 | A field is missing or out of range. The message says which |
