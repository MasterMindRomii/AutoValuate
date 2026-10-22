# Where to take AutoValuate next

These are ideas for growing the project, grouped by what they improve. Each one says why it's worth doing, roughly how to build it on the current setup, and how big a job it is. Small means an afternoon, medium means a few days, and large means a week or more.

If you're picking what to do for a college submission or a portfolio, the best order is probably: more data (1), condition and owners (2), sell-or-keep advice (8), a shareable link (10), then the price-drop alert (14). Together those turn a prediction demo into something a person would actually use.

---

## Make the estimate more accurate

### 1. Get more and fresher data (medium)

This matters more than anything else on this list. About 1,000 listings from 2023 is a small sample, prices have moved since then, and many variants have only one or two listings.

Write a scraper for public listing sites, or use one of the larger Indian used-car datasets on Kaggle (CarDekho and Cars24 exports cover tens of thousands of cars across many brands). Save each run with the date it was collected. Add a `listed_on` column so the model can learn that prices change over time, and update `REF_YEAR` in `train.py`.

### 2. Ask about condition, owners and city (medium)

Two identical Cities can differ by ₹1 lakh because one is a single-owner car from Pune with full service history and the other is a third-owner car from Delhi with accident damage. The current model can't see any of that.

Add optional fields for number of owners, city, insurance status, accident history and a condition rating. Most large datasets already have owners and city. Start by adding them as categories in `CATEGORICAL` in `train.py`. The Worker and the form pick up new categories from `model.json` automatically, so the code change is mostly in the form.

### 3. Cover other brands (medium)

The whole pipeline is brand-agnostic apart from the trim list in `train.py`. With a multi-brand dataset you'd add a `brand` feature, expand the trim dictionary (Maruti uses LXi, VXi, ZXi; Hyundai uses E, S, SX, Asta) and let the user pick the brand first. "Used Honda estimator" becomes "used car estimator", which is a much bigger audience.

### 4. Try tree models once the data is bigger (medium)

With 20,000 or more rows, gradient-boosted trees (LightGBM or XGBoost) usually beat linear models because they can learn interactions on their own, such as diesel holding its value better on SUVs than on hatchbacks. To keep the Cloudflare setup, export the trained model to ONNX and run it with `onnxruntime-web` inside the Worker, or export the trees to JSON and walk them in JavaScript. Keep the Ridge model as a fallback and compare both in `train.py` before switching.

### 5. Retrain on a schedule (medium)

Set up a GitHub Action that runs once a month: scrape fresh listings, run `train.py`, run `npm test`, and open a pull request with the new `model.json` and the new accuracy numbers. You review the numbers and merge, and the existing deploy workflow puts it live. The model stays current without you having to remember.

---

## Make it more useful to the person using it

### 6. "Is this a good deal?" checker (small)

Let a buyer paste an asking price. Compare it with the estimate and range and say "this is about ₹40,000 above what similar cars were listed for" or "this is a fair price". All the numbers are already in the `/api/predict` response. It's purely a front-end change, and it's probably the feature people would use most.

### 7. Compare two or three cars (small)

Someone choosing between a 2017 City V and a 2019 Amaze VX wants to see them side by side: price now, price in three years, and how much each loses per year. Call `/api/predict` once per car and lay the results out in columns.

### 8. Sell now or keep it? (medium)

The five-year projection already shows the value falling. Add the yearly cost of keeping the car (insurance, servicing, the fuel the user enters) and show the total cost of keeping it each year against the value lost. That gives a plain-language answer like "keeping it two more years costs you about ₹1.6 lakh in total".

### 9. Loan and EMI calculator for buyers (small)

Take the estimated price, let the user set a down payment, interest rate and tenure, and show the monthly EMI. It's a short formula in `app.js` and makes the tool useful for buyers as well as sellers.

### 10. Shareable result links (small)

Put the inputs in the URL (`/?family=City&trim=VX&year=2017&kms=52000&fuel=Petrol&transmission=Automatic`) and fill the form from it on load. People can then send a valuation on WhatsApp. With a little more work the Worker can generate an Open Graph preview image so the link shows the price in the chat.

### 11. Downloadable valuation report (medium)

A one-page PDF with the car details, estimate, range, the factors and the similar listings, which a seller can show a buyer. Generating it in the browser with a library such as `jsPDF` keeps the Worker simple.

### 12. Hindi and other regional languages (small to medium)

Move the interface text into a small translation file and add a language switch. Most used-car buyers and sellers in India would be more comfortable in their own language, and Indian number formatting (lakh and crore) is already in place.

### 13. Install it like an app (small)

Add a web app manifest and a service worker so people can add AutoValuate to their phone's home screen. Because `model.js` has no dependencies, you could even let it estimate prices offline by loading `model.json` in the browser.

---

## Turn it into a product

### 14. Price-drop alerts (large)

Let a user save a car they're watching and an email address, and email them when the estimate or new listings drop below their target. On Cloudflare this uses **D1** (Cloudflare's SQLite database) to store the alerts, a **Cron Trigger** on the Worker to check daily, and an email service such as Resend to send messages.

### 15. Photo-based details (large)

Let the user upload a photo of the car or its RC (registration certificate) and fill in the model, year and fuel automatically. **Workers AI** has vision models that run on Cloudflare itself, so this fits the current setup without another provider. Treat whatever it reads as a suggestion the user confirms, not as fact.

### 16. Ask in plain language (medium)

A chat box where someone types "2016 diesel City, 80k km, second owner, Mumbai" and gets an estimate. Use a language model (Workers AI or the Claude API) only to turn the sentence into the six fields, then call the existing `/api/predict`. The language model never makes up a price, the trained model does.

### 17. Usage analytics (small)

Log which models and years people ask about, without storing anything personal. Cloudflare's **Workers Analytics Engine** can be written to from the Worker in one line per request. It tells you which brands and models to collect more data for, which feeds straight back into idea 1.

### 18. Rate limiting and an API key for heavy users (small)

If other people start using the API from their own apps, add Cloudflare's rate-limiting binding so one caller can't use up the free quota. Give regular users a key stored in **KV**.

---

## Improve the engineering

### 19. TypeScript (small)

Convert `src/` to TypeScript and generate types for `model.json`. Wrangler compiles TypeScript with no extra setup. It catches mistakes such as misspelling `transmission` before they reach users.

### 20. End-to-end tests (small)

Add a Playwright test that opens the page, fills in the form and checks a price appears. Run it in the existing GitHub workflow so a broken page never gets deployed.

### 21. Model monitoring (medium)

Keep a set of recent real listings the model hasn't seen. Each time it's retrained, report the error on that set and fail the build if accuracy drops by more than a set amount. This catches the slow drift that happens as the market changes.
