# Review of v1 and what changed

This is a walk through the original project: what it did well, what was holding it back, and what v2 does about each problem. The numbers come from running both models on the same cleaned data with the same 5-fold cross-validation, so the comparison is fair.

## What v1 got right

The foundations were good. The notebook cleans every column step by step and explains each step, which makes it easy to follow. Using k-fold cross-validation instead of a single train/test split is the right instinct. One-hot encoding the categories is the correct approach for a linear model, and the app checked that every input was filled in before predicting. For a first regression project it's well organised.

## Problems, in order of how much they matter

### 1. The model couldn't value any car worth more than ₹10 lakh

Both the notebook and the app removed every car priced at ₹10 lakh or more before training:

```python
df5 = df5[df5["Price"] < 1000000]
```

That's 72 of the 999 cars, and they aren't random. They are the newest Cities, the CR-Vs, the Accords and the Civics. The model never saw them, so if you ask about a 2022 City ZX it can't say "₹14 lakh", because it has never seen a price that high. The app still offered all those models in the dropdown, so it would give a confidently wrong answer.

Removing them also made the score look better than it was, because the hardest cars were taken out of the test.

**v2:** keeps every price. It only removes two rows that are obviously typos (a car with 6.5 lakh km and another with 11 lakh km) and 25 exact duplicates.

### 2. Linear regression on raw price can predict negative prices

Car prices don't fall by a fixed number of rupees each year. They fall by a percentage. A ₹20 lakh car might lose ₹2 lakh in a year while a ₹3 lakh car loses ₹30,000. A straight-line model on raw rupees can't express that, so for old, high-mileage cars the line runs below zero. In testing the v1 approach gave 7 cars a negative price, and the app had to catch this with an error message.

**v2:** predicts the logarithm of the price and converts back. In log space "lose 10% a year" becomes a straight line, which is exactly what a linear model is good at. And because `exp()` of anything is positive, a negative price is impossible.

It also adds age squared, because cars lose value fastest in their first few years and more slowly after that, and uses the log of kilometres, because the first 20,000 km hurt the price more than the jump from 120,000 to 140,000.

### 3. The "Car Model" column was cut at the wrong place

The notebook kept the first three words of each name:

```python
df1["Car Model"].str.split(" ").str.slice(start=0, stop=3).str.join(" ")
```

That works for "Honda City ZX" but not for names like "Honda City i VTEC VX" or "Honda City i DTEC V", which both turn into "Honda City i". So a petrol VX and a diesel V ended up in the same group, and the trim, which is one of the biggest price drivers, was lost for a large share of the cars. It also created near-duplicate groups such as "Honda Amaze i-Dtech" and "Honda Amaze i-DTEC".

**v2:** splits each name into the **model** (City, Amaze, Jazz…) and the **trim** (E, S, SV, V, VX, ZX…) by looking for the trim token anywhere in the name. The model learns a weight for each model, each trim across all models (so it knows VX is generally above V, even for a model with few VX listings), and each model-and-trim pair. That alone was the biggest accuracy gain.

### 4. The score was described as accuracy

The README says "Achieved an average prediction accuracy of ~82%". The 0.82 is R², which is the share of the variation in price that the model explains. It isn't the share of predictions that are right, and someone reading "82% accurate" would expect something quite different. The more useful numbers for a person pricing a car are the average error in rupees and in percent.

**v2:** reports R², the average error in rupees (MAE) and the average percentage error (MAPE), and the page shows the typical error in the footer.

### 5. A single number with no sense of uncertainty

With roughly 1,000 rows the model is often ₹50,000 to ₹1 lakh off. Showing "₹6,45,211" suggests precision it doesn't have.

**v2:** shows a range. It's built from the model's own cross-validated errors: the range covers what happened for 8 out of 10 real listings during testing. It also rounds the headline price to the nearest ₹1,000.

### 6. Hosting

Streamlit Community Cloud puts apps to sleep when nobody is using them, and the first visitor waits 30 seconds or more for it to wake up. Every interaction also reruns the whole Python script on the server.

**v2:** the website is static files served from Cloudflare's edge, and the price calculation runs in a Cloudflare Worker that starts in milliseconds. Nothing sleeps, and it's free at this scale.

### 7. Smaller code issues

- `price_cleaner` used `eval()` on text from the CSV. `eval` runs any Python it's given, so a malicious row could run code on your machine. v2 parses the number with a regular expression.
- The column called "Suspension" actually holds the gearbox type (Automatic or Manual). v2 calls it `transmission` everywhere, and the UI says "Gearbox".
- The app kept the full 67-feature list hard-coded, so retraining the model would silently break the app unless someone also edited the list by hand. In v2 the training script writes everything the Worker needs into `model.json`, so the two can't drift apart, and `npm test` checks it.
- `model.pkl` was saved with scikit-learn 1.3.2. Loading it with a newer version prints a version warning and isn't guaranteed to work. Pickles can also run code when loaded, so they shouldn't be loaded from untrusted sources. JSON has neither problem.
- The kilometre input had a minimum of 2,000 although the data includes cars with less, and the year slider stopped at 2023 with no explanation.
- `requirements.txt` listed `pip` as a dependency, and the `.ipynb_checkpoints` folder was committed.
- There were no tests.

## Results side by side

Same cleaned data (972 cars), same 5-fold cross-validation:

| Model | R² | Average error | Average % error | Negative prices |
|---|---|---|---|---|
| v1: LinearRegression on price | 0.804 | ₹83,160 | 19.7% | 7 |
| v2: Ridge on log(price), model + trim | 0.883 | ₹70,456 | 15.7% | 0 |

A single 80/20 split, which is the more conservative check, gives v2 an R² of 0.82 and an average error of 15.1%.

On the narrower "under ₹10 lakh" slice that v1 was designed for, v1 scores about 0.84 and v2 about 0.85. So v2 is slightly better where v1 worked and much better where v1 didn't work at all.

## Things that were tried and not used

A gradient-boosted tree model scored almost exactly the same as the Ridge model (R² 0.879 against 0.876 in an early comparison). It would need a much bigger file and more complex code to run in the browser or a Worker, and its predictions are harder to explain. With this amount of data the simpler model is the better choice. Once there is a lot more data, trees are worth another look (see the roadmap).
