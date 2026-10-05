// Temporary: every WSJ and Bloomberg story in the feed, every way of finding a
// partner copy, and what each candidate turns out to be. Run from a runner.
import { newsSearch, resolveNewsLink } from "../scripts/coverage.mjs";
import { extractFromHtml, fetchHtml, hostOf, headlineOverlap, titleWords } from "../scripts/extract.mjs";
import { credits, publisherFor, storyKeys, sameStory, subscriberOnly } from "../scripts/syndicated.mjs";

const PARTNERS = {
  "bloomberg.com": ["finance.yahoo.com", "advisorperspectives.com", "livemint.com", "japantimes.co.jp", "straitstimes.com",
                    "businesstimes.com.sg", "thestar.com.my", "financialpost.com", "theprint.in", "ttnews.com",
                    "insurancejournal.com", "latimes.com", "bnnbloomberg.ca", "gulfnews.com", "businesslive.co.za"],
  "wsj.com": ["livemint.com", "news.com.au", "nzherald.co.nz", "theaustralian.com.au", "morningstar.com",
              "kanebridgenews.com", "mansionglobal.com", "fnlondon.com", "nypost.com", "foxbusiness.com"],
};
const ORIGINAL = /(^|\.)(bloomberg\.com|wsj\.com)$/;
const feed = await (await fetch("https://raw.githubusercontent.com/david0524/daylight/data/feed.json?x=" + Date.now())).json();
const all = [...Object.values(feed.categories).flat(), ...Object.values(feed.papers).flatMap(p => p.items)];
const seen = new Set();
const items = all.filter(i => /(^|\.)(bloomberg|wsj)\.com/.test(hostOf(i.link)) && !seen.has(i.link) && seen.add(i.link));
console.log(`${items.length} stories`);

const hostStats = {};
const bump = (h, k) => { (hostStats[h] ||= {})[k] = (hostStats[h][k] || 0) + 1; };
let found = { "bloomberg.com": [0, 0], "wsj.com": [0, 0] };

for (const it of items) {
  const orig = hostOf(it.link).endsWith("bloomberg.com") ? "bloomberg.com" : "wsj.com";
  const pub = publisherFor(it.link);
  const title = it.title.replace(/^opinion\s*\|\s*/i, "");
  const main = [...titleWords(title)].slice(0, 6).join(" ");
  const keys = storyKeys(it);
  const sites = "(" + PARTNERS[orig].map(s => `site:${s}`).join(" OR ") + ")";
  const queries = [`"${title}"`, main, ...(keys.length >= 3 ? [keys.slice(0, 6).join(" ")] : []), `${sites} ${main}`];
  const cands = new Map();
  for (const q of queries) {
    for (const r of await newsSearch(q).catch(() => [])) {
      const h = hostOf(r.sourceUrl);
      if (!h || ORIGINAL.test(h) || cands.has(r.link)) continue;
      const s = headlineOverlap(title, r.title);
      if (s >= 0.4) cands.set(r.link, { ...r, host: h, s, q: queries.indexOf(q) });
    }
  }
  const list = [...cands.values()].sort((a, b) => b.s - a.s).slice(0, 6);
  const results = [];
  let ok = null;
  for (const c of list) {
    bump(c.host, "candidates");
    const url = await resolveNewsLink(c.link).catch(() => null);
    if (!url) { results.push(`${c.host}:unresolved`); bump(c.host, "unresolved"); continue; }
    let got = await fetchHtml(url, "browser", 20000).catch(() => ({}));
    if (!got.html) got = await fetchHtml(url, "googlebot", 20000).catch(() => ({}));
    if (!got.html) { results.push(`${c.host}:http${got.status}`); bump(c.host, `http${got.status}`); continue; }
    const art = extractFromHtml(got.html, got.url || url);
    if (!art) { results.push(`${c.host}:unreadable`); bump(c.host, "unreadable"); continue; }
    const cred = credits(got.html, art, pub, got.url || url);
    const same = c.s >= 0.8 ? headlineOverlap(title, art.headline || c.title) >= 0.6 : sameStory(it, art);
    const mentions = new RegExp(pub.name === "WSJ" ? "wall street journal|dow jones|wsj" : "bloomberg", "i").test(got.html);
    const walled = subscriberOnly(got.html);
    const tag = `${c.host}:${art.words}w${walled ? "/SUBSCRIBER" : ""}${art.partial ? "/partial" : ""}${cred ? "/credited" : mentions ? "/mentions" : "/uncredited"}${same ? "/same" : "/other"}(h${c.s.toFixed(2)},q${c.q})`;
    results.push(tag);
    const good = cred && same && !walled && !art.partial && art.words >= 150;
    bump(c.host, good ? "verified" : `${walled ? "subscriber" : ""}${art.partial ? "partial" : ""}${cred ? "" : "uncredited"}${same ? "" : "other"}` || "short");
    if (good && !ok) ok = c.host;
  }
  found[orig][1]++; if (ok) found[orig][0]++;
  console.log(`${ok ? "OK " + ok.padEnd(24) : "-- ".padEnd(27)} ${orig.padEnd(13)} ${title.slice(0, 64).padEnd(64)} | ${results.join(" ")}`);
}
console.log("\nby original:", JSON.stringify(found));
console.log("by host:");
for (const [h, s] of Object.entries(hostStats).sort((a, b) => (b[1].candidates || 0) - (a[1].candidates || 0))) console.log(" ", h.padEnd(28), JSON.stringify(s));

// Partner pages the build might list directly.
console.log("\nlistings:");
for (const u of ["https://www.advisorperspectives.com/", "https://www.advisorperspectives.com/news/bloomberg",
                 "https://www.livemint.com/rss/companies", "https://www.livemint.com/rss/markets", "https://www.livemint.com/rss/news",
                 "https://www.japantimes.co.jp/feed/", "https://www.straitstimes.com/news/business/rss.xml",
                 "https://www.businesstimes.com.sg/rss/top-stories", "https://www.nzherald.co.nz/arc/outboundfeeds/rss/section/business/?outputType=xml"]) {
  const g = await fetchHtml(u, "browser", 20000).catch(e => ({ status: e.message }));
  const n = (g.html || "").match(/<item>|<entry>|href="[^"]*\/articles?\//g)?.length || 0;
  const credited = (g.html || "").match(/Bloomberg|Wall Street Journal|Dow Jones/g)?.length || 0;
  console.log(" ", g.status, String((g.html || "").length).padStart(7), `items~${n}`, `credits~${credited}`, u);
}
process.exit(0);
