// AutoValuate — Cloudflare Worker entry point.
//
// Requests to /api/* are handled here. Everything else (the website in /public)
// is served by Cloudflare's static-assets layer before the Worker even runs.

import model from "./data/model.json";
import listings from "./data/listings.json";
import { estimate, validate } from "./model.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra },
  });

// The public slice of model.json the UI needs to build its form.
const meta = {
  name: model.name,
  trained_at: model.trained_at,
  fuels: model.fuels,
  transmissions: model.trans,
  bounds: model.bounds,
  metrics: model.metrics,
  catalog: model.catalog,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (pathname === "/api/health") return json({ ok: true, model: model.name, trained_at: model.trained_at });

    if (pathname === "/api/meta" && request.method === "GET")
      return json(meta, 200, { "Cache-Control": "public, max-age=3600" });

    if (pathname === "/api/predict") {
      let body;
      if (request.method === "POST") {
        try {
          body = await request.json();
        } catch {
          return json({ error: "The request body is not valid JSON." }, 400);
        }
      } else if (request.method === "GET") {
        // Handy for quick tests in the browser: /api/predict?family=City&trim=V&year=2018&kms=40000&fuel=Petrol&transmission=Manual
        body = Object.fromEntries(url.searchParams);
      } else {
        return json({ error: "Use POST (or GET with query parameters)." }, 405);
      }

      try {
        const input = validate(model, body);
        return json(estimate(model, listings, input));
      } catch (err) {
        return json({ error: err.message }, 422);
      }
    }

    if (pathname.startsWith("/api/")) return json({ error: `No endpoint at ${pathname}.` }, 404);

    // Anything else falls through to the static site.
    return env.ASSETS.fetch(request);
  },
};
