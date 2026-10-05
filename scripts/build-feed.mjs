/**
 * Builds the static feed that the page reads.
 *
 * The app is a static page, so in the browser it can only fetch what a
 * publisher is willing to serve cross-origin — which, for the major papers, is
 * nothing. Measured from a real browser origin against the NYT, WaPo and WSJ
 * feeds, every public CORS proxy timed out, returned 401, or failed outright:
 * one usable response in eighteen attempts.
 *
 * Running the fetch here instead sidesteps that entirely. GitHub's runners have
 * an ordinary TLS stack and unblocked addresses, so the papers answer normally,
 * and the result is published as plain JSON the browser reads from its own
 * side. No CORS, no proxies, no third-party service to keep alive.
 *
 *   node scripts/build-feed.mjs [outDir]
 *
 * It also resolves the text of every story, so tapping one opens instantly and
 * paywalled pieces are already resolved -- see scripts/resolve.mjs for how each
 * outlet is read. None of that needs a key; JINA_API_KEY, where set, only adds
 * a fallback for the few pages nothing else reaches.
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findCoverage } from "./coverage.mjs";
import { resolveArticle } from "./resolve.mjs";
import { createJina } from "./jina.mjs";
import { refreshIndex, licensedRule, headlineOverlap, slugify } from "./licensed.mjs";
import { refreshListings, partnerFeed } from "./partners.mjs";

const OUT_DIR = process.argv[2] || "dist";
const SOURCES = JSON.parse(readFileSync(new URL("../sources.json", import.meta.url), "utf8"));
// Falls back to the key committed in index.html so the scheduled build
// prefetches without a repository secret being configured. The environment
// wins where it is set, which is how a replacement key gets used without a
// code change.
const JINA_KEY = process.env.JINA_API_KEY ||
  (readFileSync(new URL("../index.html", import.meta.url), "utf8")
    .match(/JINA_KEY_DEFAULT\s*=\s*"(jina_[^"]+)"/)?.[1] || "");
const PREFETCH_LIMIT = Number(process.env.PREFETCH_LIMIT || 400);

const UA_BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const UA_GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const FEED_ACCEPT = "application/rss+xml, application/xml, text/xml, */*";

const log = (...a) => console.log(...a);
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms))]);

// ── Fetching ────────────────────────────────────────────────────────────────

async function fetchFeed(url) {
  // Publishers split roughly three ways: most serve anyone, NPR and Engadget
  // refuse every browser UA but serve Googlebot, and a few block on TLS
  // fingerprint rather than headers. The first two are handled here; the third
  // does not arise on GitHub's runners, which present an ordinary stack.
  for (const ua of [UA_BROWSER, UA_GOOGLEBOT]) {
    try {
      const r = await withTimeout(
        fetch(url, { headers: { "User-Agent": ua, Accept: FEED_ACCEPT }, redirect: "follow" }),
        20000, "feed"
      );
      if (!r.ok) continue;
      const body = await r.text();
      if (body.includes("<item") || body.includes("<entry")) return body;
    } catch {}
  }
  return null;
}

// ── Parsing ─────────────────────────────────────────────────────────────────
// Node has no DOMParser and feeds are simple enough that a dependency is not
// worth it, so this pulls the handful of fields we use directly.

const strip = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? strip(m[1]).trim() : "";
};

function decodeEntities(str) {
  if (!str || !str.includes("&")) return str || "";
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&hellip;/g, "…").replace(/&mdash;/g, "—").replace(/&ndash;/g, "–")
    .replace(/&lsquo;/g, "‘").replace(/&rsquo;/g, "’")
    .replace(/&ldquo;/g, "“").replace(/&rdquo;/g, "”")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");   // last, so "&amp;#x27;" resolves correctly
}

function parseFeed(xml, limit) {
  const blocks = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map(m => m[2]);
  const out = [];
  for (const b of blocks.slice(0, limit)) {
    // Some feeds mark up their titles (The Atlantic italicises its own name).
    const title = decodeEntities(tag(b, "title")).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

    // RSS puts the URL in the element text; Atom puts it in link/@href.
    let link = tag(b, "link");
    if (!link.startsWith("http")) {
      link = (b.match(/<link[^>]+href=["']([^"']+)["']/i) || [])[1] || "";
    }
    link = decodeEntities(link).trim();

    const rawDate = tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date");
    // Undated items are dropped rather than stamped with the current time —
    // stamping them "now" makes them outrank real breaking news forever.
    const ts = rawDate ? new Date(rawDate).getTime() : NaN;
    if (!title || !link.startsWith("http") || !Number.isFinite(ts)) continue;
    if (!isArticleUrl(link)) continue;

    const descRaw = tag(b, "description") || tag(b, "summary") || tag(b, "content:encoded");
    // Some publishers put the whole article in the feed. Kept in memory for
    // the article step and never written to feed.json.
    const content = tag(b, "content:encoded") || (/<content[^>]+type=["'](html|xhtml)/i.test(b) ? tag(b, "content") : "");
    const author = decodeEntities(tag(b, "dc:creator") || tag(b, "name")).replace(/<[^>]+>/g, "").replace(/^by\s+/i, "").trim();
    const image =
      (b.match(/<enclosure[^>]+type=["']image[^"']*["'][^>]+url=["']([^"']+)["']/i) || [])[1] ||
      (b.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]+type=["']image/i) || [])[1] ||
      (b.match(/<media:(?:thumbnail|content)[^>]+url=["']([^"']+)["']/i) || [])[1] ||
      (descRaw.match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1] || "";

    out.push({
      title,
      link,
      desc: decodeEntities(descRaw.replace(/<[^>]+>/g, "")).trim().slice(0, 300),
      image: image.startsWith("http") ? decodeEntities(image) : "",
      pubDate: new Date(ts).toISOString(),
      source: (() => { try { return new URL(link).hostname.replace(/^www\./, ""); } catch { return ""; } })(),
      // CDATA content is already HTML; escaped content needs decoding once.
      ...(content.length > 1500 ? { _content: /<[a-z]/i.test(content) ? content : decodeEntities(content) } : {}),
      ...(author && author.length < 80 ? { _author: author } : {}),
    });
  }
  return out;
}

// ── Ranking ─────────────────────────────────────────────────────────────────
// Mirrors the ranking in index.html so the prebuilt feed and the live fallback
// order stories the same way. See the commentary there for the reasoning.

const QUALITY = new Set(["nytimes.com","wsj.com","washingtonpost.com","latimes.com","usatoday.com","cnn.com","foxnews.com","cbsnews.com","nbcnews.com","abcnews.go.com","npr.org","pbs.org","theatlantic.com","newyorker.com","politico.com","axios.com","vox.com","slate.com","propublica.org","apnews.com","reuters.com","bloomberg.com","cnbc.com","marketwatch.com","forbes.com","fortune.com","businessinsider.com","techcrunch.com","theverge.com","wired.com","arstechnica.com","engadget.com","time.com","newsweek.com","theguardian.com","bbc.com","bbc.co.uk","ft.com","economist.com","independent.co.uk","telegraph.co.uk","aljazeera.com","dw.com","france24.com","cbc.ca","espn.com","si.com","cbssports.com","scientificamerican.com","nature.com","science.org","newscientist.com","sciencedaily.com","phys.org","livescience.com","technologyreview.com","thehill.com"]);
const WIRES = new Set(["reuters.com","apnews.com","bloomberg.com","afp.com"]);

const hostOf = (link) => { try { return new URL(link).hostname.replace(/^www\./, ""); } catch { return ""; } };

// Hacker News surfaces plenty of links that are not articles — repos, docs,
// tool pages, PDFs — and they were landing in the feed as cards.
const BLOCKED = new Set(["github.com","gitlab.com","gist.github.com","raw.githubusercontent.com","codepen.io","jsfiddle.net","codesandbox.io","stackblitz.com","news.ycombinator.com","twitter.com","x.com","youtube.com","youtu.be","reddit.com","old.reddit.com","linear.app","notion.so","docs.google.com","arxiv.org","ssrn.com","researchgate.net","semanticscholar.org","openreview.net","huggingface.co","paperswithcode.com","medium.com","substack.com"]);
const MEDIA_EXT = new Set(["mp4","mp3","mov","avi","mkv","webm","gif","jpg","jpeg","png","webp","svg","pdf","zip","tar","gz"]);

function isArticleUrl(link) {
  try {
    const u = new URL(link);
    const h = u.hostname.replace(/^www\./, "");
    if (BLOCKED.has(h) || [...BLOCKED].some(d => h.endsWith("." + d))) return false;
    if (h.endsWith(".github.io")) return false;
    const ext = u.pathname.split(".").pop().toLowerCase();
    if (MEDIA_EXT.has(ext)) return false;
    // Video and audio pages have nothing to read, and a reader tapping one
    // waited out every route before seeing the summary.
    if (/\/(videos?|audio|podcasts?)\//i.test(u.pathname)) return false;
    return u.pathname.length >= 5;   // bare domains are section fronts, not stories
  } catch { return false; }
}
const isQuality = (h) => QUALITY.has(h) || [...QUALITY].some(d => h.endsWith("." + d));

function rankScore(item) {
  const t = new Date(item.pubDate).getTime();
  const hours = Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 3600000) : Infinity;
  const recency = Number.isFinite(hours) ? 55 * Math.pow(0.5, hours / 6) : 0;

  // A partner's copy ranks as the original it is (Bloomberg's story on Yahoo).
  const h = item.origin || hostOf(item.link);
  const quality = (isQuality(h) ? 18 : 0) + (WIRES.has(h) ? 7 : 0);

  const raw = Number(item.engagement) || 0;
  const engagement = raw > 0 ? Math.min(20, (Math.log10(raw + 1) / 3) * 20) : 0;

  return recency + quality + engagement;
}

function canonicalUrl(link) {
  try {
    const u = new URL(link);
    [...u.searchParams.keys()].forEach(k => {
      if (/^(utm_|at_|cmpid|ref|ito|smid|fbclid|gclid|mc_cid|mc_eid|s_cid|mod$|reflink|st$)/i.test(k)) u.searchParams.delete(k);
    });
    return (u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, "") + u.search).toLowerCase();
  } catch { return String(link || "").toLowerCase(); }
}

const titleKey = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9\s]/g, "")
  .split(/\s+/).filter(w => w.length > 3).slice(0, 6).join(" ");

function dedupe(items, seenUrls = new Set(), seenTitles = new Set()) {
  return items.filter(i => {
    const u = canonicalUrl(i.link);
    if (seenUrls.has(u)) return false;
    const t = titleKey(i.title);
    if (t && t.split(" ").length >= 4 && seenTitles.has(t)) return false;
    seenUrls.add(u);
    if (t) seenTitles.add(t);
    return true;
  });
}

const isRecent = (pubDate, maxDays) => {
  const t = new Date(pubDate).getTime();
  if (!Number.isFinite(t)) return false;
  const age = Date.now() - t;
  return age > -6 * 3600e3 && age <= maxDays * 86400e3;
};

// ── Hacker News ─────────────────────────────────────────────────────────────

const AI_WORDS = ["ai","llm","gpt","claude","gemini","openai","anthropic","model","neural","machine learning","deep learning","transformer","diffusion","agent","inference","llama","mistral","chatbot","rag","embedding"];

async function hackerNews(limit, aiOnly) {
  try {
    const ids = await withTimeout(fetch("https://hacker-news.firebaseio.com/v0/topstories.json").then(r => r.json()), 15000, "hn");
    const stories = await Promise.all(ids.slice(0, 40).map(id =>
      fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then(r => r.json()).catch(() => null)
    ));
    return stories
      .filter(s => s?.url && s.title && isArticleUrl(s.url) && isRecent(new Date(s.time * 1000).toISOString(), 2))
      .filter(s => !aiOnly || AI_WORDS.some(w => s.title.toLowerCase().includes(w)))
      .slice(0, limit)
      .map(s => ({
        title: s.title, link: s.url,
        desc: `${s.score} points · ${s.descendants || 0} comments`,
        image: "", pubDate: new Date(s.time * 1000).toISOString(),
        source: hostOf(s.url),
        engagement: (s.score || 0) + (s.descendants || 0) * 2,
      }));
  } catch { return []; }
}

// ── Articles ────────────────────────────────────────────────────────────────

const DATA_BASE = process.env.PUBLISHED_DATA_BASE ||
  "https://raw.githubusercontent.com/David0524/daylight/data";

// A story nothing could read is recorded as a miss, so the next builds do not
// spend the same fetches on it again, but only for a while: copies get
// published late, and a site that refused one build may answer the next.
const MISS_RETRY_MS = 3 * 60 * 60 * 1000;
const PARTIAL_RETRY_MS = 2 * 60 * 60 * 1000;
const SOFT_RETRY_MS = 20 * 60 * 1000;
// WSJ, Barron's and MarketWatch stories have no route but licensed copies,
// which partners publish hours after the original. A missed one is tried
// again on every build while it is in the feed; the cheap checks (newswire
// index, partner lists, Kanebridge) each time, the news search only every
// couple of hours, since Google throttles a runner that searches too often.
const LICENSED_RETRY_MS = 0;
const LICENSED_SEARCH_MS = 2 * 60 * 60 * 1000;
const MISS_VERSION = 7;   // bump whenever the way articles are read changes
// Likewise for text: entries read under older rules (an NYT excerpt accepted
// as a syndicated copy, say) are read again rather than carried forward.
const ARTICLE_VERSION = 2;
// Copies read from a partner (licensed, syndicated or listed) are read again
// when the rules for which copies may be used change: since version 1, never a
// copy the partner marks for its subscribers.
const SOURCE_VERSION = 1;
// The Deep pieces are kept for good, so a change to how one site's pages are
// cleaned would otherwise never reach them; this re-reads just those.
const DEEP_VERSION = 1;

async function published(name) {
  try {
    const r = await withTimeout(fetch(`${DATA_BASE}/${name}`, { headers: { "Cache-Control": "no-cache" } }), 20000, name);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/**
 * Entries from the last published articles.json that are still worth keeping:
 * text for as long as its story is in the feed, and recent misses. Anything
 * from an older way of reading (Jina markdown, or a miss recorded before the
 * current routes existed) is dropped so the story is read again.
 */
async function carryForwardArticles(liveUrls, keepTrying = new Set(), stale = {}, retried = {}) {
  const prev = await published("articles.json");
  const out = {};
  for (const [k, v] of Object.entries(prev || {})) {
    if (!liveUrls.has(k) || v?.relation) continue;
    // Read again under the current rules, but held on to in case the read
    // fails -- the archive throttles, and text it gave once is better than none.
    if (keepTrying.has(k) && v?.dv !== DEEP_VERSION) { if (v?.paragraphs) stale[k] = v; continue; }
    if (v?.source && v.sv !== SOURCE_VERSION) continue;
    if (v?.type === "article" && v.paragraphs?.length && v.av === ARTICLE_VERSION) {
      // A paywalled preview is kept until something better turns up, but
      // retried rather than trusted as the final answer -- on every build for
      // a Deep piece (as is a Deep piece not read at all), which has an
      // archived copy to be had and only a few of them ever need it.
      if (v.partial && (keepTrying.has(k) || Date.now() - (v.at || 0) > PARTIAL_RETRY_MS)) continue;
      out[k] = v;
    } else if (v?.miss && v.v === MISS_VERSION && !keepTrying.has(k)) {
      const licensed = !!licensedRule(`https://${k}`);
      const wait = licensed ? LICENSED_RETRY_MS : v.soft ? SOFT_RETRY_MS : MISS_RETRY_MS;
      if (Date.now() - v.at < wait) out[k] = v;
      else if (licensed) retried[k] = v;
    }
  }
  return out;
}

// Each article is also published as its own small file, named by a hash of
// its canonical URL, so the page fetches only the story that was tapped
// rather than every article at once. index.html computes the same id.
function articleId(key) {
  let h1 = 0x811c9dc5, h2 = 0x5bd1e995;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/** An item's articles.json entry, or a miss record when nothing was read. */
async function resolveItem(item, ctx) {
  const entry = await resolveArticle(item, ctx).catch(() => null);
  // Another outlet's article on the same story is not the original's
  // reporting and was never asked for, so it stays off unless enabled.
  if (!entry && licensedRule(item.link) && process.env.SAME_STORY_COVERAGE === "1") {
    const other = await findCoverage(item).catch(() => null);
    if (other) return other;
  }
  if (entry) return { ...entry, at: Date.now(), av: ARTICLE_VERSION, ...(entry.source ? { sv: SOURCE_VERSION } : {}) };
  // Jina's anonymous blocks last an hour or so, and NYT is read through Jina
  // once they lapse -- so a miss caused by one is retried on the next build
  // rather than three hours later.
  const soft = ctx.jina?.isBlocked?.(item.link) || undefined;
  // When the news search last ran for it, so a retry can skip it.
  const searched = ctx.skipSearch ? ctx.searchedAt : Date.now();
  return { miss: true, at: Date.now(), v: MISS_VERSION, ...(soft ? { soft } : {}),
           ...(licensedRule(item.link) ? { searched } : {}) };
}

// ── Markets ─────────────────────────────────────────────────────────────────

async function marketQuotes() {
  // Nasdaq's public quote API, which is the only keyless source left that
  // answers from a build runner. Yahoo blocks cloud IP ranges outright, and
  // stooq, CNBC, MarketWatch, Google Finance and slickcharts all refuse too.
  //
  // It carries Nasdaq's own indices but not the Dow or S&P, so those two are
  // quoted via DIA and SPY, the standard ETF proxies. The tiles are labelled
  // for what is actually quoted rather than for the index, since an ETF's
  // price is not the index level and its move differs slightly.
  const out = [];
  for (const { id, label, symbol, assetclass } of (SOURCES.markets || [])) {
    try {
      const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/info?assetclass=${assetclass}`;
      const r = await withTimeout(fetch(url, {
        headers: { "User-Agent": UA_BROWSER, Accept: "application/json" },
      }), 15000, "market");
      if (!r.ok) { log(`    miss  ${symbol} (http ${r.status})`); continue; }

      const d = (await r.json())?.data?.primaryData;
      // Prices arrive as display strings: "$773.50", "27,122.09", "+2.26%".
      const num = (v) => {
        const n = parseFloat(String(v ?? "").replace(/[$,%+\s]/g, ""));
        return Number.isFinite(n) ? n : null;
      };
      const price = num(d?.lastSalePrice);
      const pctRaw = String(d?.percentageChange ?? "");
      let pct = num(pctRaw);
      if (pct !== null && pctRaw.trim().startsWith("-")) pct = -Math.abs(pct);

      if (price === null || pct === null) { log(`    miss  ${symbol} (no data)`); continue; }
      out.push({ id, label, price, pct });
    } catch (e) {
      log(`    miss  ${symbol} (${String(e.message || e).slice(0, 40)})`);
    }
  }
  return out;
}

// ── Images ──────────────────────────────────────────────────────────────────

// Plenty of feeds carry no image, which left the top of the page as a row of
// grey boxes. The browser cannot scrape og:image cross-origin, so do it here.
async function resolveImage(url) {
  try {
    const r = await withTimeout(fetch(url, { headers: { "User-Agent": UA_BROWSER } }), 10000, "og");
    if (!r.ok) return "";
    const html = (await r.text()).slice(0, 120000);
    const grab = (prop) =>
      (html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i")) || [])[1] ||
      (html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, "i")) || [])[1] || "";
    const img = decodeEntities(grab("og:image") || grab("twitter:image"));
    return img.startsWith("http") ? img : "";
  } catch { return ""; }
}

async function fillImages(items, limit) {
  const need = items.filter(i => !i.image).slice(0, limit);
  const BATCH = 8;
  let filled = 0;
  for (let i = 0; i < need.length; i += BATCH) {
    await Promise.all(need.slice(i, i + BATCH).map(async (item) => {
      const img = await resolveImage(item.link);
      if (img) { item.image = img; filled++; }
    }));
  }
  return filled;
}

// ── Build ───────────────────────────────────────────────────────────────────

// Partner feeds (scripts/partners.mjs) are named "partner:<name>" in
// sources.json. Read once per build and shared by every category and paper
// that lists them.
let partnerIndex = [];
const partnerTexts = new Map();
const partnerFeeds = new Map();
function readPartnerFeed(name) {
  if (!partnerFeeds.has(name)) {
    partnerFeeds.set(name, partnerFeed(name, partnerIndex, { log }).then(({ items, texts }) => {
      texts.forEach((v, k) => partnerTexts.set(k, v));
      return items;
    }).catch(() => []));
  }
  return partnerFeeds.get(name);
}
const partnerName = (u) => u.startsWith("partner:") ? u.slice(8) : null;

async function buildCategory(name, cfg) {
  const maxAge = cfg.maxAgeDays || 2;
  const results = await Promise.all(cfg.feeds.map(async (u) => {
    if (partnerName(u)) {
      return (await readPartnerFeed(partnerName(u))).filter(i => isRecent(i.pubDate, maxAge)).slice(0, cfg.perFeed || 8);
    }
    const xml = await fetchFeed(u);
    if (!xml) { log(`    miss  ${u}`); return []; }
    const items = parseFeed(xml, cfg.perFeed || 8).filter(i => isRecent(i.pubDate, maxAge));
    log(`    ${String(items.length).padStart(3)}  ${u}`);
    return items;
  }));

  let items = results.flat();
  if (name === "Technology") items = items.concat(await hackerNews(5, false));   // supplement the mastheads, do not flood them
  if (name === "AI")         items = items.concat(await hackerNews(5, true));

  // Cap any single outlet so one prolific feed cannot own a category.
  const counts = {};
  items = dedupe(items)
    .sort((a, b) => rankScore(b) - rankScore(a))
    .filter(i => {
      const h = i.origin || hostOf(i.link);
      counts[h] = (counts[h] || 0) + 1;
      return counts[h] <= 3;
    })
    .slice(0, cfg.cap || 24);

  return items;
}

async function main() {
  const started = Date.now();
  const categories = {};

  // Partners' lists come first: some categories and papers are built from them.
  log("  Partner lists");
  partnerIndex = await refreshListings(await published("partner-index.json") || [], log);
  log(`    ${partnerIndex.length} partner copies listed`);

  for (const [name, cfg] of Object.entries(SOURCES.categories)) {
    log(`  ${name}`);
    categories[name] = await buildCategory(name, cfg);
  }

  // Cross-category dedupe, in display order, so a wire story stays in the most
  // relevant category rather than appearing three times.
  const seenUrls = new Set(), seenTitles = new Set();
  const order = [...SOURCES.categoryOrder.filter(c => categories[c]),
                 ...Object.keys(categories).filter(c => !SOURCES.categoryOrder.includes(c))];
  for (const c of order) categories[c] = dedupe(categories[c], seenUrls, seenTitles);
  for (const c of Object.keys(categories)) if (!categories[c].length) delete categories[c];

  log("  Papers");
  const papers = {};
  for (const [id, cfg] of Object.entries(SOURCES.papers)) {
    let items = [];
    for (const u of cfg.feeds) {
      let parsed;
      if (partnerName(u)) parsed = (await readPartnerFeed(partnerName(u))).filter(i => isRecent(i.pubDate, 3));
      else {
        const xml = await fetchFeed(u);
        if (!xml) continue;
        parsed = parseFeed(xml, 30).filter(i => isRecent(i.pubDate, 3));
      }
      // A publication tab must only ever show that publication. Without this a
      // mis-mapped feed fills the NYT tab with, say, BBC stories and nothing
      // about the result looks wrong.
      if (cfg.domain) {
        parsed = parsed.filter(i => {
          const h = i.origin || hostOf(i.link);
          return h === cfg.domain || h.endsWith("." + cfg.domain);
        });
      }
      if (parsed.length) { items = parsed; break; }
    }
    // Free partner copies of the paper's stories, ahead of its own items so
    // that where both carry a story, the readable one is kept.
    // Partners republish features days after the paper does, so a week.
    let added = 0;
    for (const u of cfg.add || []) {
      const extra = (await readPartnerFeed(partnerName(u) || u)).filter(i => isRecent(i.pubDate, 7));
      items = [...extra, ...items];
      added += extra.length;
    }
    items = dedupe(items).sort((a, b) => rankScore(b) - rankScore(a)).slice(0, 30 + added);
    log(`    ${String(items.length).padStart(3)}  ${cfg.name}`);
    if (items.length) papers[id] = { name: cfg.name, emoji: cfg.emoji, items };
  }

  log("  Markets");
  const markets = await marketQuotes();
  log(`    ${markets.length}/${(SOURCES.markets || []).length} quotes`);

  // ── Article text ──────────────────────────────────────────────────────────
  //
  // Every story in the feed, categories and paper sections alike. Text already
  // published is carried forward for as long as its story is live, so each
  // build only reads what is new -- and a story read once stays readable even
  // if its site refuses a later build.
  const allItems = Object.values(categories).flat();
  const everything = [...allItems, ...Object.values(papers).flatMap(p => p.items || [])];
  // The Deep tab's long reads never leave the feed, so their text is read
  // once and then kept for good. A minimum length keeps a publisher's preview
  // from passing for the whole piece.
  const deepItems = (SOURCES.deep || []).flatMap(s => s.items)
    .map(d => ({ title: d.title, link: d.url, desc: d.desc, pubDate: "", archive: d.archive, minWords: 1000 }));
  const liveUrls = new Set([...everything, ...deepItems].map(i => canonicalUrl(i.link)));
  const staleDeep = {};
  const retried = {};
  const articles = await carryForwardArticles(liveUrls, new Set(deepItems.map(i => canonicalUrl(i.link))), staleDeep, retried);
  const carried = Object.keys(articles).length;
  // Copies read while checking a partner's list need not be read again.
  for (const [url, art] of partnerTexts) {
    const k = canonicalUrl(url);
    if (liveUrls.has(k) && !articles[k]) articles[k] = { ...art, at: Date.now(), av: ARTICLE_VERSION, sv: SOURCE_VERSION, how: "listed" };
  }

  log("  Licensed index");
  const index = await refreshIndex(await published("licensed-index.json") || [], log);
  log(`    ${index.length} stories indexed`);
  const listings = partnerIndex;

  const jina = createJina(JINA_KEY, log);
  const seen = new Set();
  const todo = [...deepItems, ...everything
    .filter(i => !/\/(videos?|podcasts?|audio)\//.test(i?.link || ""))
    .sort((a, b) => rankScore(b) - rankScore(a))]
    .filter(i => i?.link && !seen.has(canonicalUrl(i.link)) && seen.add(canonicalUrl(i.link)))
    .filter(i => !articles[canonicalUrl(i.link)])
    .slice(0, PREFETCH_LIMIT);
  // Requests to one host go one at a time, so a run of top stories from the
  // same paper would leave the other workers queued behind it. Dealing the
  // list out a host at a time keeps every worker on a different site while
  // still taking each site's stories best-first.
  const byHost = new Map();
  for (const i of todo) { const h = hostOf(i.link); byHost.set(h, [...(byHost.get(h) || []), i]); }
  todo.length = 0;
  while (byHost.size) {
    for (const [h, list] of byHost) { todo.push(list.shift()); if (!list.length) byHost.delete(h); }
  }
  log(`  Articles: ${carried} carried forward, reading ${todo.length} (${Object.keys(retried).length} licensed misses retried)`);
  const t0 = Date.now();
  const ctx = { jina, index, listings, log };
  let next = 0;
  // Stories are read best-first within a time budget, so a slow day leaves
  // the least important ones for the next build instead of overrunning the
  // job's limit; anything not reached gets no miss record and is tried again.
  const deadline = t0 + Number(process.env.ARTICLE_BUDGET_S || 900) * 1000;
  // Six at a time overall; scripts/extract.mjs also keeps it to one request
  // at a time per host.
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < todo.length && Date.now() < deadline) {
      const item = todo[next++];
      const prev = retried[canonicalUrl(item.link)];
      const skipSearch = !!prev?.searched && Date.now() - prev.searched < LICENSED_SEARCH_MS;
      articles[canonicalUrl(item.link)] = await resolveItem(item, { ...ctx, skipSearch, searchedAt: prev?.searched });
    }
  }));
  if (next < todo.length) log(`    time budget reached; ${todo.length - next} stories left for the next build`);
  for (const d of deepItems) {
    const k = canonicalUrl(d.link), e = articles[k], old = staleDeep[k];
    // A re-read that came back worse keeps the old text, still marked stale so
    // the next build tries again.
    if (old && (!e?.paragraphs || (e.partial && !old.partial))) articles[k] = old;
    else if (e) e.dv = DEEP_VERSION;
  }

  // A paper that asks for it lists its readable stories first, keeping its
  // own order otherwise (WSJ, whose free copies are a minority).
  for (const [id, cfg] of Object.entries(SOURCES.papers)) {
    if (!cfg.readableFirst || !papers[id]) continue;
    const has = (i) => (articles[canonicalUrl(i.link)]?.paragraphs && !articles[canonicalUrl(i.link)]?.partial) ? 0 : 1;
    papers[id].items = papers[id].items.map((i, n) => [i, n]).sort((a, b) => has(a[0]) - has(b[0]) || a[1] - b[1]).map(([i]) => i);
  }

  // Per-outlet tallies, so a site that stops answering shows up in the log as
  // a falling number rather than as a reader quietly showing summaries.
  const tally = {};
  for (const i of everything) {
    const h = i.origin || hostOf(i.link), e = articles[canonicalUrl(i.link)];
    const t = (tally[h] ||= { n: 0, full: 0, partial: 0 });
    if (t.seen?.has(i.link)) continue;
    (t.seen ||= new Set()).add(i.link);
    t.n++;
    if (e?.paragraphs) e.partial ? t.partial++ : t.full++;
  }
  const withText = Object.values(articles).filter(a => a.paragraphs).length;
  log(`    ${withText}/${liveUrls.size} stories have text (${Math.round((Date.now() - t0) / 1000)}s)`);
  for (const [h, t] of Object.entries(tally).sort((a, b) => b[1].n - a[1].n).slice(0, 30)) {
    log(`    ${String(t.full).padStart(3)}/${String(t.n).padEnd(3)} ${h}${t.partial ? `  (+${t.partial} preview only)` : ""}`);
  }

  log("  Images");
  // Most image-less items now have one from the article that was just read;
  // only the rest cost a page fetch.
  for (const i of everything) {
    const e = articles[canonicalUrl(i.link)];
    if (!i.image && e?.image) i.image = e.image;
  }
  const filled = await fillImages(allItems, Number(process.env.IMAGE_LIMIT || 70));
  log(`    ${filled} resolved (${allItems.filter(i => i.image).length}/${allItems.length} now have one)`);

  // ── Output ────────────────────────────────────────────────────────────────

  mkdirSync(join(OUT_DIR, "a"), { recursive: true });
  for (const i of everything) {
    const key = canonicalUrl(i.link), e = articles[key];
    delete i._content; delete i._author;
    // Tried this build or recently and nothing could read it: the page goes
    // straight to the summary instead of spending half a minute finding out.
    if (e?.miss) i.am = 1;
    if (!e?.paragraphs) continue;
    // The item says its text is published, so the page knows to fetch it
    // rather than trying the live routes.
    i.a = articleId(key);
    if (e.partial) i.ap = 1;
  }
  for (const [key, e] of Object.entries(articles)) {
    if (!e?.paragraphs) continue;
    const { how, at, av, dv, sv, ...pub } = e;
    writeFileSync(join(OUT_DIR, "a", `${articleId(key)}.json`), JSON.stringify(pub));
  }

  // The Deep list as the page shows it, with each piece's reading time taken
  // from the text itself and, like a feed item, the id of its published file.
  const deep = (SOURCES.deep || []).map(s => ({
    section: s.section,
    items: s.items.map(({ archive, ...d }) => {
      const e = articles[canonicalUrl(d.url)];
      if (!e?.paragraphs) return e?.miss ? { ...d, am: 1 } : d;
      return { ...d, a: articleId(canonicalUrl(d.url)), ...(e.partial ? { ap: 1 } : { mins: Math.max(1, Math.round(e.words / 230)) }) };
    }),
  }));
  log(`    deep: ${deep.flatMap(s => s.items).filter(d => d.a && !d.ap).length}/${deepItems.length} read in full`);

  const feed = {
    generatedAt: new Date().toISOString(),
    categoryOrder: SOURCES.categoryOrder,
    categories, papers, markets, deep,
    counts: {
      categories: Object.keys(categories).length,
      items: Object.values(categories).reduce((n, a) => n + a.length, 0),
      papers: Object.keys(papers).length,
      articles: withText,
      markets: markets.length,
      withImages: allItems.filter(i => i.image).length,
    },
  };
  writeFileSync(join(OUT_DIR, "feed.json"), JSON.stringify(feed));
  // The whole set, read back by the next build to carry text forward.
  writeFileSync(join(OUT_DIR, "articles.json"), JSON.stringify(articles));
  writeFileSync(join(OUT_DIR, "licensed-index.json"), JSON.stringify(index));
  writeFileSync(join(OUT_DIR, "partner-index.json"), JSON.stringify(partnerIndex));

  const kb = (p) => Math.round(readFileSync(join(OUT_DIR, p)).length / 1024);
  log(`\n  feed.json     ${kb("feed.json")} KB  (${feed.counts.items} items, ${feed.counts.categories} categories, ${feed.counts.papers} papers)`);
  log(`  articles.json ${kb("articles.json")} KB  (${feed.counts.articles} with text)`);
  log(`  built in ${Math.round((Date.now() - started) / 1000)}s`);

  if (!feed.counts.items) { console.error("\nERROR: no items built — refusing to publish an empty feed"); process.exit(1); }
}

// Importable: scripts/prefetch.mjs fills in article text for an already
// published feed, and the tests check the matching and URL helpers.
export { canonicalUrl, rankScore, headlineOverlap, resolveItem, carryForwardArticles, slugify, articleId, parseFeed };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
