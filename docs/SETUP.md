# Setting up AutoValuate

This guide takes you from a fresh computer to a live website. It's written for someone who has run a Python notebook before but hasn't used Cloudflare. Each part says what you're doing and why, so if something goes wrong you'll know where to look.

There are four parts. You only need parts 1 and 3 to get a live site. Part 2 is for when you want to change the model, and part 4 makes deployment automatic.

1. Run it locally
2. Retrain the model (optional)
3. Deploy to Cloudflare
4. Auto-deploy from GitHub (optional)

At the end there's a troubleshooting section for the problems people usually hit.

---

## Before you start

You need:

- **Node.js 20 or newer.** Download the LTS version from [nodejs.org](https://nodejs.org). Check it worked by opening a terminal and running `node -v`. You should see something like `v22.x.x`.
- **A Cloudflare account.** Sign up free at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up). You don't need a credit card or a domain name.
- **Python 3.10 or newer** only if you want to retrain the model. Check with `python --version` (on some Macs and Linux machines it's `python3`).
- **Git** if you want to push to GitHub.

On Windows, use PowerShell or the VS Code terminal. Every command below works the same there.

---

## Part 1: Run it locally

Unzip the project, open a terminal in the `autovaluate` folder and run:

```bash
npm install
```

This downloads Wrangler, Cloudflare's command-line tool, into a `node_modules` folder. It only does this once and takes about a minute.

Now start the local server:

```bash
npm run dev
```

You'll see `Ready on http://localhost:8787`. Open that address in your browser. What's running is a real copy of the Cloudflare runtime on your machine, so if it works here it will work when deployed.

Try a car. Pick City, then VX, 2017, 52,000 km, Petrol, Automatic and press **Estimate price**. You should get about ₹8.5 lakh. Once you've got one estimate, changing any field updates it automatically.

You can also call the API directly. Open this in a browser tab:

```
http://localhost:8787/api/predict?family=City&trim=V&year=2018&kms=40000&fuel=Petrol&transmission=Manual
```

To make sure the JavaScript model matches the Python one, run the tests:

```bash
npm test
```

All three should pass. Stop the server with `Ctrl + C`.

**Editing the site:** the files in `public/` are served as they are. Change `styles.css`, save, and refresh the browser. There is no build step.

---

## Part 2: Retrain the model (optional)

Do this when you change `ml/train.py`, add more data, or swap in a different CSV.

It's good practice to keep the Python packages in a virtual environment so they don't clash with anything else on your machine:

```bash
python -m venv .venv
# macOS / Linux:
source .venv/bin/activate
# Windows PowerShell:
.venv\Scripts\Activate.ps1

pip install -r ml/requirements.txt
```

Then train:

```bash
python ml/train.py
```

You'll see something like this:

```
Rows: raw=999  clean=972
Baseline (original LinearRegression): {'r2': 0.8042, 'mae': 83160, 'mape': 19.7, 'negative_predictions': 7}
  ridge alpha=0.25  {'r2': 0.8838, 'mae': 70629, 'mape': 15.82}
  ...
Chosen alpha=1.0: {'r2': 0.8826, 'mae': 70456, 'mape': 15.72}
Hold-out 20%: {'r2': 0.8205, 'mae': 79321, 'mape': 15.09}
Wrote .../src/data/model.json, listings.json and test/fixtures.json
```

Here's what each line means:

- **Baseline** is the v1 approach run on the same cleaned data, so you can see whether the new model actually beats it.
- **ridge alpha=…** lines try different amounts of regularisation (how strongly the model is pulled away from extreme weights). The script picks the one with the lowest average error.
- **Hold-out 20%** is a score on cars the model never saw while training. It's a bit lower than the cross-validated score because it's a single random split, which is normal with this little data.
- **mae** is the average error in rupees. **mape** is the average error as a percentage of the price.

The script overwrites three files: `src/data/model.json`, `src/data/listings.json` and `test/fixtures.json`. Run `npm test` again to confirm the Worker still agrees with Python, then `npm run dev` to try the new model.

**Using your own data:** any CSV with the columns `Year`, `kms Driven`, `Fuel Type`, `Suspension`, `Price` and `Car Model` in the same format will work:

```bash
python ml/train.py --data path/to/your.csv
```

If you scrape fresh listings from a later year, also change `REF_YEAR` at the top of `train.py` to the year after the data was collected.

---

## Part 3: Deploy to Cloudflare

Sign in to Cloudflare from the terminal. This opens your browser and asks you to allow Wrangler to manage Workers on your account:

```bash
npx wrangler login
```

Then deploy:

```bash
npm run deploy
```

Wrangler uploads the Worker code and the files in `public/`, and prints your URL:

```
Deployed autovaluate triggers
  https://autovaluate.<your-subdomain>.workers.dev
```

Open it. That's your live site. Every time you run `npm run deploy` again, the new version replaces the old one within a few seconds, with no downtime.

**Changing the name in the URL:** edit `"name"` in `wrangler.jsonc` before deploying. `"name": "honda-price"` gives you `honda-price.<your-subdomain>.workers.dev`.

**Using your own domain:** if you own a domain and it's added to Cloudflare, go to the Cloudflare dashboard, open **Workers & Pages**, click **autovaluate**, then **Settings → Domains & Routes → Add → Custom domain**, and type something like `price.yourdomain.com`. Cloudflare creates the DNS record and the HTTPS certificate for you.

**Seeing logs:** run `npx wrangler tail` to watch live requests and errors, or look at the **Logs** tab for the Worker in the dashboard. Logging is already switched on through `"observability"` in `wrangler.jsonc`.

**What it costs:** the free Workers plan covers 100,000 API requests a day, and requests for the static files in `public/` don't count towards that. A college project or a portfolio piece won't come close.

---

## Part 4: Auto-deploy from GitHub (optional)

This makes every push to `main` run the tests and, if they pass, deploy the site. There are two ways to do it. Pick one.

### Option A: Let Cloudflare do it (simplest)

1. Push the project to a GitHub repository.
2. In the Cloudflare dashboard, open **Workers & Pages → autovaluate → Settings → Build**.
3. Click **Connect** next to Git repository and choose your repo.
4. Set the build command to `npm test` and the deploy command to `npx wrangler deploy`.

If you use this option, delete `.github/workflows/deploy.yml` so you don't deploy twice.

### Option B: GitHub Actions (already set up in this project)

The workflow in `.github/workflows/deploy.yml` runs `npm test` on every push and pull request, and deploys when `main` changes. It needs two secrets:

1. **Create an API token.** In the Cloudflare dashboard, click your profile icon, then **My Profile → API Tokens → Create Token**. Choose the **Edit Cloudflare Workers** template, select your account, and create it. Copy the token. Cloudflare only shows it once.
2. **Find your account ID.** It's on the right-hand side of the **Workers & Pages** overview page.
3. **Add both to GitHub.** In your repository go to **Settings → Secrets and variables → Actions → New repository secret** and add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

Push to `main` and watch it run under the **Actions** tab.

---

## Troubleshooting

**`npm` or `node` is not recognised.** Node.js isn't installed or the terminal was open before you installed it. Close the terminal, open a new one and try `node -v` again.

**`Address already in use` when running `npm run dev`.** Something else is using port 8787, often an old dev server. Close it, or run `npx wrangler dev --port 8788`.

**The page loads but the model chips never appear, and you see "Couldn't load the form options".** The browser can't reach `/api/meta`. If you opened `public/index.html` straight from your file system, that's the reason: the page needs the Worker. Use `npm run dev` and open `http://localhost:8787`. If you've hosted the page somewhere else, set `API` at the top of `public/app.js` to your Worker's URL.

**`Authentication error` during deploy.** Your login expired. Run `npx wrangler login` again. In GitHub Actions, check that the token was made with the Edit Cloudflare Workers template and that both secrets are spelled exactly as above.

**`npm test` fails with "JS … vs Python …".** `model.json` and `fixtures.json` came from different training runs. Run `python ml/train.py` once so both are regenerated together, then test again.

**`ModuleNotFoundError: No module named 'sklearn'`.** The virtual environment isn't active, or the packages weren't installed into it. Activate it (see Part 2) and run `pip install -r ml/requirements.txt`.

**The font looks plain.** The page uses the Archivo font from Google Fonts. If your network blocks Google Fonts it falls back to your system font. Everything still works.

**Estimates look strange for a rare variant.** Variants marked "rare" in the picker have fewer than three listings in the data, so the model mostly leans on the model family and other cars. That's expected, and it's why more data is the top item in the roadmap.
