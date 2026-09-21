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

const OUT_DIR = process.argv[2] || "dist";
const SOURCES = JSON.parse(readFileSync(new URL("../sources.json", import.meta.url), "utf8"));
const JINA_KEY = process.env.JINA_API_KEY || "";
const PREFETCH_LIMIT = Number(process.env.PREFETCH_LIMIT || 60);

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
      if (/^(utm_|at_|cmpid|ref|ito|smid|fbclid|gclid|mc_cid|mc_eid|s_cid)/i.test(k)) u.searchParams.delete(k);
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

async function prefetchArticle(url) {
  if (!JINA_KEY) return null;
  try {
    const r = await withTimeout(fetch(`https://r.jina.ai/${encodeURIComponent(url)}`, {
      headers: { Authorization: `Bearer ${JINA_KEY}`, Accept: "text/plain", "X-Return-Format": "markdown", "X-Timeout": "20" },
    }), 30000, "jina");
    if (!r.ok) return null;
    const text = await r.text();
    const lower = text.toLowerCase();
    // Same wall detection as the reader: a Cloudflare challenge comes back on
    // HTTP 200 and is only ~810 bytes, so length alone never caught it.
    const walls = ["please complete the security check","one more step","this page maybe requiring captcha",
                   "checking if the site connection is secure","ray id:","subscribe to continue reading",
                   "this article is for subscribers","you've used all your free articles"];
    if (walls.some(w => lower.includes(w))) return null;
    if (text.length < 1200) return null;
    return text;
  } catch { return null; }
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

  // Prefetch article text for the top stories so the reader opens instantly and
  // paywalled pieces are already resolved. Skipped without a key.
  const articles = {};
  if (JINA_KEY) {
    const top = Object.values(categories).flat()
      .sort((a, b) => rankScore(b) - rankScore(a))
      .slice(0, PREFETCH_LIMIT);
    log(`  Prefetching ${top.length} articles`);
    let hit = 0;
    const BATCH = 5;
    for (let i = 0; i < top.length; i += BATCH) {
      await Promise.all(top.slice(i, i + BATCH).map(async (item) => {
        const text = await prefetchArticle(item.link);
        if (text) { articles[canonicalUrl(item.link)] = { type: "markdown", text }; hit++; }
      }));
    }
    log(`    ${hit}/${top.length} resolved`);
  } else {
    log("  Prefetch skipped (no JINA_API_KEY)");
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const feed = {
    generatedAt: new Date().toISOString(),
    categoryOrder: SOURCES.categoryOrder,
    categories, papers,
    counts: {
      categories: Object.keys(categories).length,
      items: Object.values(categories).reduce((n, a) => n + a.length, 0),
      papers: Object.keys(papers).length,
      articles: Object.keys(articles).length,
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

main().catch(e => { console.error(e); process.exit(1); });
