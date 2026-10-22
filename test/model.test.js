// Run with:  npm test
// Checks that the JavaScript model gives the same answers as the Python model
// it was exported from, and that the API's validation behaves.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { predictPrice, validate, estimate } from "../src/model.js";

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const model = load("../src/data/model.json");
const listings = load("../src/data/listings.json");
const fixtures = load("./fixtures.json");

test("JS predictions match scikit-learn within 0.1%", () => {
  for (const { input, expected } of fixtures) {
    const got = predictPrice(model, input);
    const diff = Math.abs(got - expected) / expected;
    assert.ok(diff < 0.001, `${JSON.stringify(input)}: JS ${got.toFixed(0)} vs Python ${expected.toFixed(0)}`);
  }
});

test("prices are always positive and the range contains the estimate", () => {
  const r = estimate(model, listings, { family: "Brio", trim: "S", year: 2010, kms: 290000, fuel: "Petrol", transmission: "Manual" });
  assert.ok(r.price > 0);
  assert.ok(r.range.low < r.price && r.price < r.range.high);
  assert.equal(r.projection.length, 6);
  assert.ok(r.projection[5].price < r.projection[0].price, "car should lose value over time");
  assert.ok(r.similar.length > 0);
});

test("validation rejects bad input with a clear message", () => {
  const good = { family: "City", trim: "V", year: 2018, kms: 40000, fuel: "Petrol", transmission: "Manual" };
  assert.doesNotThrow(() => validate(model, good));
  assert.throws(() => validate(model, { ...good, family: "Swift" }), /Unknown model/);
  assert.throws(() => validate(model, { ...good, trim: "Turbo" }), /not a known variant/);
  assert.throws(() => validate(model, { ...good, year: 1990 }), /Year must be/);
  assert.throws(() => validate(model, { ...good, kms: -5 }), /Kilometres/);
  assert.throws(() => validate(model, { ...good, fuel: "Electric" }), /Fuel must be/);
});
