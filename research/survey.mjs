/**
 * Which user agent, if any, gets each outlet's article HTML from this machine,
 * and how much readable text Readability pulls out of it.
 *
 *   node research/survey.mjs [feed.json] [perDomain] [--jina] [--gnews]
 *
 * Reads the published feed by default and samples the newest stories per
 * domain. Run it wherever the build runs -- publishers answer a GitHub runner,
 * a laptop and a cloud VM differently, so a result here is only true there.
 *
 *   --jina   also tries anonymous Jina once per domain (paced for its limit)
 *   --gnews  also checks Google News search + link resolution, and Morningstar
 */
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

const UAS = {
  browser:   "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  discord:   "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
  facebook:  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  bingbot:   "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
};

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith("--")));
const [src = "https://raw.githubusercontent.com/David0524/daylight/data/feed.json", perArg = "2"] = args.filter(a => !a.startsWith("--"));
const per = Number(perArg);
const feed = src.startsWith("http") ? await (await fetch(src)).json() : JSON.parse(readFileSync(src, "utf8"));
const items = [...Object.values(feed.categories).flat(), ...Object.values(feed.papers).flatMap(p => p.items)];
const byHost = {};
for (const i of items) {
  if (/\/(video|videos|live|podcasts?)\//.test(i.link)) continue;
  (byHost[i.source] ||= new Map()).set(i.link, i);
}

function readable(html, url) {
  const { document } = parseHTML(html);
  const art = new Readability(document, { charThreshold: 300 }).parse();
  if (!art) return 0;
  return (art.textContent || "").trim().split(/\s+/).filter(Boolean).length;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let lastJina = 0;
async function jinaWords(url) {
  const wait = lastJina + 3500 - Date.now();
  if (wait > 0) await sleep(wait);
  lastJina = Date.now();
  try {
    const r = await fetch(`https://r.jina.ai/${encodeURIComponent(url)}`,
      { headers: { Accept: "text/plain", "X-Return-Format": "html" }, signal: AbortSignal.timeout(40000) });
    if (!r.ok) return `j${r.status}`;
    return String(readable(await r.text(), url));
  } catch { return "jerr"; }
}

console.log(`${"".padEnd(24)} ${Object.keys(UAS).map(k => k.slice(0, 6).padStart(6)).join(" ")}${flags.has("--jina") ? "   jina" : ""}`);
for (const [host, map] of Object.entries(byHost).sort()) {
  const sample = [...map.values()].slice(0, per);
  for (const [n, item] of sample.entries()) {
    const row = {};
    for (const [name, ua] of Object.entries(UAS)) {
      try {
        const r = await fetch(item.link, { headers: { "User-Agent": ua, Accept: "text/html,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" },
                                           redirect: "follow", signal: AbortSignal.timeout(20000) });
        row[name] = r.ok ? String(readable(await r.text(), item.link)) : String(r.status);
      } catch { row[name] = "err"; }
    }
    const j = flags.has("--jina") && n === 0 ? await jinaWords(item.link) : "";
    console.log(`${host.padEnd(24)} ${Object.keys(UAS).map(k => row[k].padStart(6)).join(" ")} ${j.padStart(6)}  ${item.link.slice(0, 70)}`);
  }
}

if (flags.has("--gnews")) {
  const UA = UAS.browser;
  console.log("\nGoogle News:");
  const wsj = items.filter(i => /wsj\.com/.test(i.link)).slice(0, 3);
  for (const i of wsj) {
    const q = `"${i.title.replace(/^opinion\s*\|\s*/i, "")}"`;
    try {
      const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`, { headers: { "User-Agent": UA } });
      const x = await r.text();
      const links = [...x.matchAll(/<item>[\s\S]*?<link>([^<]+)<\/link>[\s\S]*?<source url="([^"]+)"/g)];
      console.log(`  search ${r.status} ${links.length} results  ${q.slice(0, 50)}  [${links.map(l => l[2].replace(/^https?:\/\/(www\.)?/, "")).join(", ")}]`);
      if (links[0]) {
        const id = links[0][1].split("/articles/")[1]?.split("?")[0];
        const p = await fetch(`https://news.google.com/articles/${id}`, { headers: { "User-Agent": UA } });
        console.log(`  resolve page ${p.status} signature=${/data-n-a-sg/.test(await p.text())}`);
      }
    } catch (e) { console.log("  gnews err", e.message); }
    await sleep(1500);
  }
  for (const u of ["https://www.morningstar.com/news/dow-jones", "https://kanebridgenews.com/", "https://www.moomoo.com/news/"]) {
    try {
      const r = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
      console.log(`  ${u}  ${r.status} ${(await r.text()).length}`);
    } catch (e) { console.log(`  ${u}  err`); }
  }
}
