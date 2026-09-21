// Audits every feed URL referenced by index.html and reports which ones
// actually return items.
//
// Feed URLs rot, and the failures are silent: a category just quietly thins
// out. Worse, several publishers (NYT, the Guardian, LA Times, The Atlantic)
// block on TLS fingerprint rather than IP or headers, so a feed can work from
// one client and fail from another at the same address. That means the only
// audit that really counts is one run through the deployed worker.
//
//   node test/audit-feeds.mjs                      # local client stacks
//   node test/audit-feeds.mjs https://<worker-url> # what production sees
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const WORKER = process.argv[2]?.replace(/\/$/, "") || null;
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

const urls = [...new Set(
  [...html.matchAll(/https?:\/\/[^"`\s]+?(?:rss|feed|\.xml)[^"`\s]*/gi)].map(m => m[0])
)].filter(u =>
  !u.includes("${") && !u.includes("w3.org") && !u.includes("purl.org") &&
  !u.includes("yahoo.com/mrss") && !u.includes("sitemap") && !u.includes("CBMi")
);

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const GB = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const countItems = (b) => (b.match(/<item|<entry/g) || []).length;

// Item count alone is not enough: a feed can return a full payload and still be
// abandoned. WSJ's feeds.a.dj.com endpoints answer 200 with 21 items whose
// newest entry is from January 2025. Age of the newest item is the real test.
function newestAgeHours(body) {
  const stamps = [...body.matchAll(/<(?:pubDate|published|updated|dc:date)>([^<]+)</g)]
    .map(m => new Date(m[1].trim()).getTime())
    .filter(Number.isFinite);
  if (!stamps.length) return null;
  return (Date.now() - Math.max(...stamps)) / 3600000;
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), ms))]);

async function viaNode(u, ua) {
  try {
    const r = await withTimeout(fetch(u, { headers: { "User-Agent": ua, Accept: "application/rss+xml, application/xml, text/xml, */*" }, redirect: "follow" }), 12000);
    if (!r.ok) return { n: 0 };
    const b = await r.text();
    return { n: countItems(b), age: newestAgeHours(b) };
  } catch { return { n: 0 }; }
}
function viaCurl(u, ua) {
  try {
    const b = execFileSync("curl", ["-sL", "-m", "15", "-A", ua, u], { maxBuffer: 2e7 }).toString();
    return { n: countItems(b), age: newestAgeHours(b) };
  } catch { return { n: 0 }; }
}
async function viaWorker(u) {
  try {
    const r = await withTimeout(fetch(`${WORKER}/rss?url=${encodeURIComponent(u)}`), 25000);
    if (!r.ok) return { n: 0 };
    const b = await r.text();
    return { n: countItems(b), age: newestAgeHours(b) };
  } catch { return { n: 0 }; }
}

const results = [];
for (const u of urls) {
  if (WORKER) {
    const r = await viaWorker(u);
    results.push({ u, ...r, how: "worker" });
  } else {
    let r = await viaNode(u, UA), how = "node";
    if (!r.n) { r = await viaNode(u, GB); how = "node+googlebot"; }
    if (!r.n) { r = viaCurl(u, UA); how = "curl"; }
    if (!r.n) { r = viaCurl(u, GB); how = "curl+googlebot"; }
    results.push({ u, ...r, how: r.n ? how : "none" });
  }
}

const STALE_HOURS = 72;
const live  = results.filter(r => r.n && (r.age == null || r.age < STALE_HOURS));
const stale = results.filter(r => r.n && r.age != null && r.age >= STALE_HOURS);
const bad   = results.filter(r => !r.n);

console.log(`${WORKER ? "via deployed worker" : "via local client stacks"}: ${live.length}/${results.length} feeds live\n`);
if (bad.length) {
  console.log("NOT RETURNING ITEMS:");
  bad.forEach(r => console.log(`  ${r.u}`));
  console.log("");
}
if (stale.length) {
  console.log(`ABANDONED (newest item older than ${STALE_HOURS}h -- these answer 200 but publish nothing):`);
  stale.forEach(r => console.log(`  ${String(Math.round(r.age / 24)).padStart(4)}d old  ${r.u}`));
  console.log("");
}
if (!WORKER) {
  const odd = live.filter(r => r.how !== "node");
  if (odd.length) {
    console.log("needed a non-default client stack (these are the fingerprint-sensitive ones):");
    odd.forEach(r => console.log(`  ${r.how.padEnd(15)} ${r.u}`));
  }
}
process.exit(bad.length + stale.length ? 1 : 0);
