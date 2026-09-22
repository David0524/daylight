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
 * With JINA_API_KEY set it also prefetches article text for the top stories,
 * so tapping one opens instantly and paywalled pieces are already resolved.
 * Without it the page falls back to fetching articles in the browser.
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const OUT_DIR = process.argv[2] || "dist";
const SOURCES = JSON.parse(readFileSync(new URL("../sources.json", import.meta.url), "utf8"));
// Falls back to the key committed in index.html so the scheduled build
// prefetches without a repository secret being configured. The environment
// wins where it is set, which is how a replacement key gets used without a
// code change.
const JINA_KEY = process.env.JINA_API_KEY ||
  (readFileSync(new URL("../index.html", import.meta.url), "utf8")
    .match(/JINA_KEY_DEFAULT\s*=\s*"(jina_[^"]+)"/)?.[1] || "");
const PREFETCH_LIMIT = Number(process.env.PREFETCH_LIMIT || 90);

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
    const title = decodeEntities(tag(b, "title"));

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
    return u.pathname.length >= 5;   // bare domains are section fronts, not stories
  } catch { return false; }
}
const isQuality = (h) => QUALITY.has(h) || [...QUALITY].some(d => h.endsWith("." + d));

function rankScore(item) {
  const t = new Date(item.pubDate).getTime();
  const hours = Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 3600000) : Infinity;
  const recency = Number.isFinite(hours) ? 55 * Math.pow(0.5, hours / 6) : 0;

  const h = hostOf(item.link);
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

// ── Article prefetch ────────────────────────────────────────────────────────

const WALL_MARKERS = ["please complete the security check","one more step","this page maybe requiring captcha",
  "checking if the site connection is secure","ray id:","subscribe to continue reading",
  "this article is for subscribers","you've used all your free articles",
  "already a subscriber? sign in","continue reading your article with"];

async function jinaFetch(url) {
  // No X-No-Cache here, deliberately: NYT's sharing params only return the
  // full article through Jina's cache, and disabling it drops them back to the
  // metered preview (or to a tracking-pixel redirect).
  const r = await withTimeout(fetch(`https://r.jina.ai/${encodeURIComponent(url)}`, {
    headers: { Authorization: `Bearer ${JINA_KEY}`, Accept: "text/plain",
               "X-Return-Format": "markdown", "X-Timeout": "20",
               "X-Referer": "https://www.google.com/" },
  }), 30000, "jina");
  if (!r.ok) return null;
  const text = await r.text();
  const low = text.toLowerCase();
  if (WALL_MARKERS.some(w => low.includes(w))) return null;
  return text.length < 1200 ? null : text;
}

async function prefetchArticle(url) {
  if (!JINA_KEY) return null;

  // NYT honours its own article-sharing params server-side, returning the full
  // text where a plain request gets the metered preview -- 1,569 words against
  // 345 on the same article. Try those first for NYT, then fall back.
  const candidates = [];
  if (/(^|\.)nytimes\.com$/i.test(hostOf(url))) {
    const sep = url.includes("?") ? "&" : "?";
    candidates.push(
      `${url}${sep}unlocked_article_code=1&smid=nytcore-ios-share`,
      `${url}${sep}unlocked_article_code=1&smid=url-share`,
    );
  }
  candidates.push(url);

  // Two passes. A cold URL very often answers with a stub on the first request
  // and the real article on the second -- measured directly: the same keyed
  // request returned 225 bytes, then 34,679. One attempt per variant therefore
  // reported failure for articles that were reachable a moment later.
  let best = null;
  for (let pass = 0; pass < 2 && (!best || best.length < 8000); pass++) {
    for (const c of candidates) {
      try {
        const text = await jinaFetch(c);
        if (text && (!best || text.length > best.length)) best = text;
        if (best && best.length > 20000) break;   // clearly the full piece
      } catch {}
    }
    if (!best && pass === 0) await new Promise(r => setTimeout(r, 800));
  }
  return best;
}

const PUBLISHED_ARTICLES_URL =
  process.env.PUBLISHED_ARTICLES_URL ||
  "https://raw.githubusercontent.com/David0524/daylight/data/articles.json";

const MISS_RETRY_MS = 3 * 60 * 60 * 1000;

async function carryForwardArticles(liveUrls) {
  try {
    const r = await withTimeout(fetch(PUBLISHED_ARTICLES_URL, {
      headers: { "Cache-Control": "no-cache" },
    }), 20000, "articles");
    if (!r.ok) return {};
    const prev = await r.json();
    const out = {};
    for (const [k, v] of Object.entries(prev || {})) {
      if (!liveUrls.has(k)) continue;
      // For a licensed host, only a licensed copy or a recorded miss is worth
      // keeping. Anything else is the host's own paywalled preview, left by a
      // build that fetched the site directly -- and carrying it forward would
      // mark the story done, so its licensed copy would never be looked up.
      const host = k.split("/")[0];
      if (LICENSED.some(r => r.host.test(host)) && !v?.source && !v?.miss) continue;
      // Text is kept for as long as the story is live. A recorded miss is kept
      // for a few hours only, so a story is not searched for again on every
      // build, but still gets another try in case its copy was published late.
      if (v?.text || (v?.miss && Date.now() - v.at < MISS_RETRY_MS)) out[k] = v;
    }
    return out;
  } catch { return {}; }
}

// ── Licensed copies ───────────────────────────────────────────────────────
//
// WSJ cannot be fetched at all: its edge refuses every client in a few
// milliseconds, before any header is read, and no archive holds it. But Dow
// Jones licenses much of its newswire output to Morningstar, which publishes
// it in full and free under /news/dow-jones/. So for a WSJ story, look for
// Morningstar's copy by headline and read that instead.
//
// Coverage is partial by nature -- measured at 5 of 21 on one day's WSJ feed.
// Newswire-style stories (economy, trade, markets, energy) are syndicated;
// features, exclusives and opinion columns are not. Those stay as the feed's
// own summary, with "open original" for a subscriber.

const LICENSED = [
  { host: /(^|\.)wsj\.com$/i, via: "Morningstar (Dow Jones)",
    site: "morningstar.com dow-jones",
    match: /morningstar\.com\/news\/dow-jones\/\d+\/([a-z0-9-]+)/ },
];

const titleWords = (t) => new Set(String(t || "").toLowerCase().normalize("NFKD")
  .replace(/[\u2019']/g, "").replace(/[^a-z0-9]+/g, " ").split(" ").filter(w => w.length > 2));

function headlineOverlap(a, b) {
  const A = titleWords(a), B = titleWords(b);
  let n = 0; A.forEach(w => B.has(w) && n++);
  return n / Math.max(1, Math.min(A.size, B.size));
}

// Kanebridge News republishes a selection of WSJ stories in full, under
// licence -- including opinion columns and features, which Morningstar never
// carries. Its URLs are the headline slugified, so a copy can be checked for
// directly with no search. Each page carries a Dow Jones copyright line, which
// is what confirms it is the licensed story and not an unrelated page.
const KANEBRIDGE = ["https://kanebridgenewsme.com/", "https://www.kanebridgenews.com/"];

const slugify = (t) => String(t || "").replace(/^opinion\s*\|\s*/i, "").toLowerCase()
  .normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[\u2018\u2019']/g, "")
  .replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function kanebridgeCopy(title) {
  const slug = slugify(title);
  if (!slug) return null;
  for (const base of KANEBRIDGE) {
    const url = `${base}${slug}/`;
    try {
      const r = await withTimeout(fetch(url, { headers: { "User-Agent": UA_BROWSER }, redirect: "follow" }), 20000, "kanebridge");
      if (!r.ok || !/Dow Jones &(amp;)? Company/i.test(await r.text())) continue;
      const text = await jinaFetch(url);
      if (text && text.length > 2000) return { type: "markdown", text, source: url, via: "Kanebridge News (WSJ)" };
    } catch {}
  }
  return null;
}

async function licensedCopy(item) {
  if (!JINA_KEY) return null;
  const rule = LICENSED.find(r => r.host.test(hostOf(item.link)));
  if (!rule) return null;
  const title = String(item.title || "").replace(/^opinion\s*\|\s*/i, "");
  if (!title) return null;

  // The direct check is cheaper than a search, so it goes first.
  const kb = await kanebridgeCopy(title);
  if (kb) return kb;

  let hits = [];
  try {
    const q = `${rule.site} "${title}"`;
    const r = await withTimeout(fetch(`https://s.jina.ai/?q=${encodeURIComponent(q)}`, {
      headers: { Authorization: `Bearer ${JINA_KEY}`, Accept: "application/json",
                 "X-Respond-With": "no-content" },
    }), 45000, "search");
    // 402 is an exhausted key, not an absent copy. Recording it as a miss
    // would skip the story for hours after a new key is in place.
    if (r.status === 402) throw new Error("jina key exhausted");
    if (!r.ok) return null;
    hits = (await r.json())?.data || [];
  } catch (e) { if (/exhausted/.test(e.message)) throw e; return null; }

  // The headline has to match the copy's slug closely. Morningstar's slugs
  // track the headline, sometimes with "-update" / "-2nd-update" appended as
  // the story develops, so word overlap rather than equality. Its periodic
  // "Top Markets Headlines" digests mention many stories and must not be
  // mistaken for any one of them.
  const candidates = hits
    .map(h => ({ url: String(h.url || ""), m: String(h.url || "").match(rule.match) }))
    // Roundups ("...-commodities-roundup") bundle the story with unrelated
    // items, which under a WSJ headline would misrepresent what it said.
    .filter(h => h.m && !/top-[a-z]+-headlines|-roundup$/.test(h.m[1]))
    .map(h => ({ url: h.url, score: headlineOverlap(title, h.m[1].replace(/-/g, " ")) }))
    .filter(h => h.score >= 0.7)
    .sort((a, b) => b.score - a.score);

  for (const c of candidates.slice(0, 2)) {
    try {
      const text = await jinaFetch(c.url);
      if (text && text.length > 2000) return { type: "markdown", text, source: c.url, via: rule.via };
    } catch {}
  }
  return null;
}

/**
 * The articles.json entry for one feed item, or null if nothing was resolved.
 * WSJ is unreachable directly, so its stories go straight to the licensed-copy
 * lookup rather than spending fetches on a wall, and a miss is recorded so the
 * next few builds do not search for it again.
 */
async function resolveItem(item) {
  if (LICENSED.some(r => r.host.test(hostOf(item.link)))) {
    try { return (await licensedCopy(item)) || { miss: true, at: Date.now() }; }
    catch { return null; }   // key exhausted: record nothing, retry next build
  }
  const text = await prefetchArticle(item.link);
  return text ? { type: "markdown", text } : null;
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

async function buildCategory(name, cfg) {
  const maxAge = cfg.maxAgeDays || 2;
  const results = await Promise.all(cfg.feeds.map(async (u) => {
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
      const h = hostOf(i.link);
      counts[h] = (counts[h] || 0) + 1;
      return counts[h] <= 3;
    })
    .slice(0, cfg.cap || 24);

  return items;
}

async function main() {
  const started = Date.now();
  const categories = {};

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
      const xml = await fetchFeed(u);
      if (!xml) continue;
      let parsed = parseFeed(xml, 30).filter(i => isRecent(i.pubDate, 3));
      // A publication tab must only ever show that publication. Without this a
      // mis-mapped feed fills the NYT tab with, say, BBC stories and nothing
      // about the result looks wrong.
      if (cfg.domain) {
        parsed = parsed.filter(i => {
          const h = hostOf(i.link);
          return h === cfg.domain || h.endsWith("." + cfg.domain);
        });
      }
      if (parsed.length) { items = parsed; break; }
    }
    items = dedupe(items).sort((a, b) => rankScore(b) - rankScore(a)).slice(0, 30);
    log(`    ${String(items.length).padStart(3)}  ${cfg.name}`);
    if (items.length) papers[id] = { name: cfg.name, emoji: cfg.emoji, items };
  }

  log("  Markets");
  const markets = await marketQuotes();
  log(`    ${markets.length}/${(SOURCES.markets || []).length} quotes`);

  log("  Images");
  const allItems = Object.values(categories).flat();
  const filled = await fillImages(allItems, Number(process.env.IMAGE_LIMIT || 70));
  log(`    ${filled} resolved (${allItems.filter(i => i.image).length}/${allItems.length} now have one)`);

  // Prefetch article text for the top stories so the reader opens instantly and
  // paywalled pieces are already resolved.
  //
  // Text already published is always carried forward first, for as long as its
  // story is still in the feed. The prefetch budget only covers the top of the
  // feed, so without this a story that dropped just below the cut lost the text
  // that had already been resolved for it, and the reader went back to fetching
  // it live.
  const liveUrls = new Set(
    [...Object.values(categories).flat(),
     ...Object.values(papers).flatMap(p => p.items || [])].map(i => canonicalUrl(i.link))
  );
  const articles = await carryForwardArticles(liveUrls);
  const carried = Object.keys(articles).length;

  if (JINA_KEY) {
    // Candidates come from the paper sections as well as the categories. The
    // mastheads are the whole reason prefetch exists -- they are what a browser
    // cannot reach -- and drawing only from the categories left them thinly
    // covered: one build resolved six NYT articles out of the twenty-five in
    // its NYT tab.
    const seen = new Set();
    const pool = [...Object.values(categories).flat(),
                 ...Object.values(papers).flatMap(p => p.items || [])]
      .filter(i => i?.link && !seen.has(canonicalUrl(i.link)) && seen.add(canonicalUrl(i.link)))
      .filter(i => !articles[canonicalUrl(i.link)])   // already carried
      .sort((a, b) => rankScore(b) - rankScore(a));
    // Every WSJ story gets a lookup regardless of rank: a licensed copy is the
    // only way its text is ever available, and each costs a single search.
    const isLicensed = (i) => LICENSED.some(r => r.host.test(hostOf(i.link)));
    const top = [...pool.slice(0, PREFETCH_LIMIT),
                 ...pool.slice(PREFETCH_LIMIT).filter(isLicensed)];
    log(`  Carried ${carried} forward; prefetching ${top.length} more`);
    let hit = 0, licensed = 0;
    const BATCH = 5;
    for (let i = 0; i < top.length; i += BATCH) {
      await Promise.all(top.slice(i, i + BATCH).map(async (item) => {
        const entry = await resolveItem(item);
        if (!entry) return;
        articles[canonicalUrl(item.link)] = entry;
        if (entry.text) { hit++; if (entry.source) licensed++; }
      }));
    }
    log(`    ${hit}/${top.length} resolved, ${licensed} via licensed copies (${Object.values(articles).filter(a => a.text).length} total)`);
  } else {
    log(`  Prefetch skipped (no key) — carried ${carried} published articles forward`);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const feed = {
    generatedAt: new Date().toISOString(),
    categoryOrder: SOURCES.categoryOrder,
    categories, papers, markets,
    counts: {
      categories: Object.keys(categories).length,
      items: Object.values(categories).reduce((n, a) => n + a.length, 0),
      papers: Object.keys(papers).length,
      articles: Object.values(articles).filter(a => a.text).length,
      markets: markets.length,
      withImages: allItems.filter(i => i.image).length,
    },
  };
  writeFileSync(join(OUT_DIR, "feed.json"), JSON.stringify(feed));
  writeFileSync(join(OUT_DIR, "articles.json"), JSON.stringify(articles));

  const kb = (p) => Math.round(readFileSync(join(OUT_DIR, p)).length / 1024);
  log(`\n  feed.json     ${kb("feed.json")} KB  (${feed.counts.items} items, ${feed.counts.categories} categories, ${feed.counts.papers} papers)`);
  log(`  articles.json ${kb("articles.json")} KB  (${feed.counts.articles} prefetched)`);
  log(`  built in ${Math.round((Date.now() - started) / 1000)}s`);

  if (!feed.counts.items) { console.error("\nERROR: no items built — refusing to publish an empty feed"); process.exit(1); }
}

// Importable: scripts/prefetch.mjs reuses canonicalUrl() and prefetchArticle()
// against an already-published feed, so article text can be filled in without
// rebuilding (and re-fetching) the whole feed.
export { canonicalUrl, prefetchArticle, rankScore, licensedCopy, headlineOverlap, resolveItem, carryForwardArticles, slugify };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
