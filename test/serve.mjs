// Local dev harness: serves index.html with WORKER_BASE pointed at a local
// instance of the worker, so the real page can be driven end to end without
// deploying anything.
//
//   JINA_API_KEY=jina_... node test/serve.mjs
//   node test/e2e.mjs            (in another shell)
//
// The worker normally runs on Cloudflare, so this shim supplies the one
// runtime global it uses (caches.default). Note that Node's fetch has a
// different TLS fingerprint from Cloudflare's, so a few publishers that
// allow Cloudflare will refuse this shim -- a local 403 is not necessarily
// a production one.
import http from "node:http";
import { readFileSync } from "node:fs";
import worker from "../worker/src/index.js";

const store = new Map();
globalThis.caches = {
  default: {
    async match(r) { return store.get(r.url)?.clone(); },
    async put(r, v) { store.set(r.url, v.clone()); },
  },
};
const env = { JINA_API_KEY: process.env.JINA_API_KEY || "", ALLOWED_ORIGINS: "" };

// Worker on :8787
http.createServer(async (req, res) => {
  const r = await worker.fetch(
    new Request("https://w.local" + req.url, { headers: { Origin: "http://localhost:8080" } }),
    env, { waitUntil: (p) => p?.catch?.(() => {}) }
  );
  const body = Buffer.from(await r.arrayBuffer());
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(body);
}).listen(8787, () => console.log("worker on :8787"));

// Page on :8080
const page = readFileSync(new URL("../index.html", import.meta.url), "utf8")
  // Left exactly as shipped: WORKER_BASE_DEFAULT stays empty so the runtime
  // configuration flow (Fetch service box under the ⋯ tab) is what gets tested.
  ;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page);
}).listen(8080, () => console.log("page on :8080"));
