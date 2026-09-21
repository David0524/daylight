// Runs the worker's fetch handler in Node against real upstreams.
// Shims the two Workers-runtime globals the worker touches.
import worker from "../src/index.js";

const store = new Map();
globalThis.caches = {
  default: {
    async match(req) { return store.get(req.url)?.clone(); },
    async put(req, res) { store.set(req.url, res.clone()); },
  },
};

const env = {
  JINA_API_KEY: process.env.JINA_API_KEY || "",
  ALLOWED_ORIGINS: "",
};
const ctx = { waitUntil: (p) => p.catch(() => {}) };

const call = async (path) => {
  const t0 = Date.now();
  const res = await worker.fetch(
    new Request(`https://worker.test${path}`, { headers: { Origin: "https://david0524.github.io" } }),
    env, ctx
  );
  const body = await res.text();
  return { status: res.status, ms: Date.now() - t0, body, cors: res.headers.get("Access-Control-Allow-Origin") };
};

const cases = process.argv.slice(2);
for (const c of cases) {
  const r = await call(c);
  let summary = r.body.slice(0, 160).replace(/\s+/g, " ");
  try {
    const j = JSON.parse(r.body);
    if (j.ok && j.text) summary = `method=${j.method} chars=${j.text.length} tried=${(j.tried||[]).map(t=>t.method).join(",")||"none"}`;
    else if (j.ok) summary = JSON.stringify(j).slice(0, 160);
    else summary = `ERR ${j.error} | ${(j.tried||[]).map(t=>`${t.method}:${t.error}`).join(" | ").slice(0,220)}`;
  } catch {}
  console.log(`[${String(r.status).padEnd(3)}] ${String(r.ms).padStart(5)}ms cors=${r.cors||"-"}  ${c.slice(0, 60)}`);
  console.log(`        ${summary}\n`);
}
