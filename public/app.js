// AutoValuate — front-end logic. Plain JavaScript, no build step.
// Talks to the Worker at /api/meta (form options) and /api/predict (estimates).

const API = ""; // same origin. Set to "https://your-worker.workers.dev" if you host the page elsewhere.

const $ = (id) => document.getElementById(id);
const inr = new Intl.NumberFormat("en-IN");
const rupees = (n) => "₹" + inr.format(Math.round(n));
const lakh = (n) => (n >= 1e7 ? `₹${(n / 1e7).toFixed(2)} crore` : `₹${(n / 1e5).toFixed(2)} lakh`);
const round1k = (n) => Math.round(n / 1000) * 1000;
const shortLakh = (n) => `${(n / 1e5).toFixed(1)}L`;

const state = { family: null, trim: null, year: null, kms: null, fuel: null, transmission: null };
let meta = null;
let hasEstimated = false;
let inFlight = null;

// ---------------------------------------------------------------- setup
init().catch((err) => showError(`Couldn't load the form options (${err.message}). Refresh the page to try again.`));

async function init() {
  const res = await fetch(`${API}/api/meta`);
  if (!res.ok) throw new Error(`server replied ${res.status}`);
  meta = await res.json();

  $("rows").textContent = inr.format(meta.metrics.rows);
  $("mape").textContent = `${Math.round(meta.metrics.cv.mape)}%`;

  const families = Object.entries(meta.catalog).sort((a, b) => b[1].count - a[1].count);
  renderChips($("family"), families.map(([name]) => ({ value: name, label: name })), "family", onFamily);

  renderSegmented($("fuel"), meta.fuels, "fuel");
  renderSegmented($("transmission"), meta.transmissions, "transmission");
  fillYears(meta.bounds.year);
  renderOdometer(null);

  const kms = $("kms"), slider = $("kmsRange");
  kms.addEventListener("input", () => {
    const digits = kms.value.replace(/[^\d]/g, "");
    state.kms = digits ? Number(digits) : null;
    kms.value = digits ? inr.format(Number(digits)) : "";
    if (state.kms) slider.value = Math.min(state.kms, Number(slider.max));
    changed();
  });
  slider.addEventListener("input", () => {
    state.kms = Number(slider.value);
    kms.value = inr.format(state.kms);
    changed();
  });
  $("year").addEventListener("change", (e) => { state.year = Number(e.target.value) || null; changed(); });
  $("form").addEventListener("submit", (e) => { e.preventDefault(); estimate(true); });
}

// ---------------------------------------------------------------- form widgets
function renderChips(container, options, key, onPick) {
  container.innerHTML = "";
  for (const opt of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(state[key] === opt.value));
    b.dataset.value = opt.value;
    b.innerHTML = opt.label + (opt.note ? ` <small>${opt.note}</small>` : "");
    b.addEventListener("click", () => {
      state[key] = opt.value;
      for (const c of container.children) c.setAttribute("aria-checked", String(c === b));
      onPick?.(opt.value);
      changed();
    });
    container.appendChild(b);
  }
}

function renderSegmented(container, values, key) {
  container.innerHTML = "";
  for (const v of values) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "seg";
    b.textContent = v;
    b.dataset.value = v;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", "false");
    b.addEventListener("click", () => { setSegment(container, key, v); changed(); });
    container.appendChild(b);
  }
}

function setSegment(container, key, value) {
  state[key] = value;
  for (const c of container.children) c.setAttribute("aria-checked", String(c.dataset.value === value));
}

/** Only offer fuels/gearboxes that this variant was actually sold with. */
function limitSegment(container, key, allowed) {
  for (const c of container.children) c.disabled = !allowed.includes(c.dataset.value);
  if (!allowed.includes(state[key])) {
    if (allowed.length === 1) setSegment(container, key, allowed[0]);
    else { state[key] = null; for (const c of container.children) c.setAttribute("aria-checked", "false"); }
  }
}

function fillYears([from, to], keep = state.year) {
  const sel = $("year");
  sel.innerHTML = `<option value="">Select year</option>`;
  for (let y = to; y >= from; y--) sel.insertAdjacentHTML("beforeend", `<option value="${y}">${y}</option>`);
  if (keep && keep >= from && keep <= to) sel.value = keep; else state.year = null;
}

function onFamily(family) {
  const fam = meta.catalog[family];
  const trims = Object.entries(fam.trims).map(([t, info]) => ({
    value: t, label: t, note: info.count < 3 ? "rare" : "",
  }));
  state.trim = null;
  renderChips($("trim"), trims, "trim", onTrim);
  fillYears(fam.years);
  // Pre-pick the variant if there's only one.
  if (trims.length === 1) $("trim").firstChild.click();
}

function onTrim(trim) {
  const info = meta.catalog[state.family].trims[trim];
  limitSegment($("fuel"), "fuel", info.fuels);
  limitSegment($("transmission"), "transmission", info.trans);
}

// ---------------------------------------------------------------- estimate
function missing() {
  const names = { family: "model", trim: "variant", year: "year", kms: "kilometres", fuel: "fuel", transmission: "gearbox" };
  return Object.keys(names).filter((k) => !state[k]).map((k) => names[k]);
}

let timer;
function changed() {
  hideError();
  if (!hasEstimated) return;           // live updates start after the first estimate
  clearTimeout(timer);
  timer = setTimeout(() => estimate(false), 250);
}

async function estimate(fromButton) {
  const gaps = missing();
  if (gaps.length) {
    if (fromButton) showError(`Add the ${gaps.join(", ")} to get an estimate.`);
    return;
  }
  inFlight?.abort();
  inFlight = new AbortController();
  document.body.classList.add("is-loading");
  try {
    const res = await fetch(`${API}/api/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
      signal: inFlight.signal,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Server replied ${res.status}`);
    const first = !hasEstimated;
    hasEstimated = true;
    render(data);
    // On phones the result sits below the form, so bring it into view the first time.
    if (first && window.matchMedia("(max-width: 899px)").matches) {
      $("result").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
  } catch (err) {
    if (err.name !== "AbortError") showError(err.message);
  } finally {
    document.body.classList.remove("is-loading");
  }
}

// ---------------------------------------------------------------- rendering
function render(d) {
  renderOdometer(d.price);
  $("priceText").textContent = `Estimated price ${rupees(d.price)}, likely between ${rupees(d.range.low)} and ${rupees(d.range.high)}.`;
  $("readoutLabel").textContent = `Estimated resale price, Honda ${d.input.family} ${d.input.trim} ${d.input.year}`;
  $("lakh").textContent = `About ${lakh(d.price)}`;

  $("rangeBlock").hidden = false;
  $("rangeLow").textContent = rupees(round1k(d.range.low));
  $("rangeHigh").textContent = rupees(round1k(d.range.high));
  const pos = (d.price - d.range.low) / (d.range.high - d.range.low);
  $("rangeMarker").style.left = `${Math.max(0, Math.min(1, pos)) * 100}%`;

  $("details").hidden = false;

  // Factors
  const max = Math.max(10, ...d.factors.map((f) => Math.abs(f.effect)));
  $("factors").innerHTML = d.factors.map((f) => {
    const dir = f.effect > 0.05 ? "up" : f.effect < -0.05 ? "down" : "";
    const sign = f.effect > 0 ? "+" : "";
    const width = (Math.abs(f.effect) / max) * 50;
    return `<li class="factor">
      <span class="factor__label">${escapeHtml(f.label)}</span>
      <span class="factor__val ${dir}">${sign}${f.effect.toFixed(1)}%</span>
      <span class="factor__track"><span class="factor__fill ${dir}" style="width:${width}%"></span></span>
    </li>`;
  }).join("");

  // Projection
  const top = d.projection[0].price;
  $("projection").innerHTML = d.projection.map((p) => `
    <div class="proj" title="${rupees(p.price)} at about ${inr.format(p.kms)} km">
      <span class="proj__val">${shortLakh(p.price)}</span>
      <span class="proj__bar" style="height:${(p.price / top) * 120}px"></span>
      <span class="proj__yr">${p.yearsFromNow === 0 ? "Now" : `+${p.yearsFromNow} yr`}</span>
    </div>`).join("");

  // Similar listings
  $("similar").innerHTML = d.similar.map((s) => `
    <tr><td>${escapeHtml(s.model)}</td><td>${s.year}</td><td>${inr.format(s.kms)}</td>
    <td>${escapeHtml(s.transmission)}</td><td class="num">${rupees(s.price)}</td></tr>`).join("");
}

/** Mechanical odometer: each digit is a strip of 0–9 that rolls into place. */
function renderOdometer(value) {
  const el = $("odometer");
  if (value == null) {
    el.innerHTML = `<span class="odo-rupee">₹</span><span class="odo-blank">– – – – – –</span>`;
    return;
  }
  const text = inr.format(Math.round(value / 1000) * 1000); // round to nearest ₹1,000
  const existing = el.querySelectorAll(".odo-cell, .odo-sep");
  const sameShape = existing.length === text.length &&
    [...text].every((ch, i) => (ch === ",") === existing[i].classList.contains("odo-sep"));

  if (!sameShape) {
    el.innerHTML = `<span class="odo-rupee">₹</span>` + [...text].map((ch) =>
      ch === ","
        ? `<span class="odo-sep">,</span>`
        : `<span class="odo-cell"><span class="odo-strip">${"0123456789".split("").map((n) => `<span>${n}</span>`).join("")}</span></span>`
    ).join("");
    const cells = el.querySelectorAll(".odo-cell");
    cells[cells.length - 1]?.classList.add("is-last");
    el.offsetHeight; // start from 0 so the first reading rolls up
  }
  const parts = el.querySelectorAll(".odo-cell, .odo-sep");
  [...text].forEach((ch, i) => {
    if (ch === ",") return;
    parts[i].firstChild.style.transform = `translateY(-${Number(ch) * 1.2}em)`;
  });
}

function showError(msg) { const e = $("formError"); e.textContent = msg; e.hidden = false; }
function hideError() { $("formError").hidden = true; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
