/**
 * Same-story coverage for articles whose own text is unreachable.
 *
 * WSJ refuses every automated fetch, and only a minority of its stories are
 * republished under licence. For the rest, most are news that other outlets
 * also report. This finds another outlet's full article on the same story,
 * with no API key: Google News' public RSS search to find candidates, Google
 * News' own link resolver to get the real URL, and a direct fetch of the page.
 *
 * Two relations are returned, and the reader labels them differently:
 *   "same"    -- the other article's body contains most of the key terms of
 *                WSJ's own summary, so it reports the same specifics.
 *   "related" -- it only shares the topic. Opinion columns can only ever be
 *                this, since a column exists nowhere but where it was written.
 */
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const GBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Hard paywalls, aggregators and social sites. Anything else is accepted if its
// page actually yields an article, which is checked below.
const DENY = /(^|\.)(wsj\.com|barrons\.com|bloomberg\.com|ft\.com|economist\.com|theaustralian\.com\.au|afr\.com|thetimes\.co\.uk|telegraph\.co\.uk|nytimes\.com|washingtonpost\.com|theatlantic\.com|newyorker\.com|wired\.com|businessinsider\.com|seekingalpha\.com|gurufocus\.com|morningstar\.com|marketwatch\.com|investors\.com|foreignpolicy\.com|scmp\.com|nikkei\.com|livemint\.com|thecurrency\.news|moomoo\.com|futunn\.com|itiger\.com|marketscreener\.com|facebook\.com|x\.com|twitter\.com|linkedin\.com|reddit\.com|youtube\.com|msn\.com|news\.google\.com|flipboard\.com|newsbreak\.com|ground\.news|webwire\.com)$/;
const NON_ENGLISH_TLD = /\.(it|de|fr|es|pt|nl|pl|ru|cn|jp|kr|br|mx|ar|tr|se|no|dk|fi|cz|hu|ro|gr|il|ir|vn|th|id)$/;
export const isOpenHost = (h) => !!h && !DENY.test(h) && !NON_ENGLISH_TLD.test(h);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

// ── Matching ────────────────────────────────────────────────────────────────

const STOP = new Set(("the a an of to in on for and or but with as at by from is are was were be been its it this " +
  "that these those has have had will would could should can may might not no than then into over under after " +
  "before about amid more most new says said how why what who when where which while their there they them his " +
  "her our your you he she we us").split(" "));
// Crude stemming, enough that "annihilate" meets "annihilation" and "prices"
// meets "price" across outlets' different wording.
const stem = (w) => w.length > 4
  ? w.replace(/(ations?|ions?|ments?|ings?|ed|es|ers?|ly|s)$/, "").replace(/e$/, "").replace(/at$/, "")
  : w;
export const salient = (t) => new Set(String(t || "").toLowerCase().normalize("NFKD").replace(/[’']/g, "")
  .replace(/[^a-z0-9$ ]+/g, " ").split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)).map(stem));

// ── Google News ─────────────────────────────────────────────────────────────

const unescape = (s) => String(s).replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");

// Paced, and retried with backoff: in bulk, Google intermittently answers
// empty, which made whole runs look like there was no coverage at all.
let lastSearch = 0, lastDecode = 0;
async function paced(which, gap) {
  const now = Date.now(), prev = which === "s" ? lastSearch : lastDecode;
  const wait = Math.max(0, prev + gap - now);
  if (which === "s") lastSearch = now + wait; else lastDecode = now + wait;
  if (wait) await sleep(wait);
}

export async function newsSearch(q, attempt = 0) {
  await paced("s", 700);
  try {
    const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:3d")}&hl=en-US&gl=US&ceid=US:en`,
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
    if (r.ok) {
      const x = await r.text();
      return [...x.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
        const it = m[1], g = (t) => unescape((it.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || "");
        const src = it.match(/<source url="([^"]+)">([^<]*)/);
        return { title: g("title").replace(/\s+-\s+[^-]+$/, ""), link: g("link"), pubDate: g("pubDate"),
                 sourceUrl: src?.[1] || "", source: unescape(src?.[2] || "") };
      });
    }
  } catch {}
  if (attempt >= 2) return [];
  await sleep(3000 * (attempt + 1));
  return newsSearch(q, attempt + 1);
}

// Google News links are opaque ids now. Its own page resolves them through an
// internal endpoint, given a signature and timestamp embedded in the page.
async function resolveOnce(link) {
  const id = link.split("/articles/")[1]?.split("?")[0];
  if (!id) return null;
  const page = await (await fetch(`https://news.google.com/articles/${id}`,
    { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) })).text();
  const sg = page.match(/data-n-a-sg="([^"]+)"/)?.[1], ts = page.match(/data-n-a-ts="([^"]+)"/)?.[1];
  if (!sg || !ts) return null;
  const inner = JSON.stringify(["garturlreq", [["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],
    "X","X",1,[1,1,1],1,1,null,0,0,null,0], id, Number(ts), sg]);
  const r = await fetch("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
    method: "POST", signal: AbortSignal.timeout(20000),
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: "f.req=" + encodeURIComponent(JSON.stringify([[["Fbv4je", inner, null, "generic"]]])),
  });
  return (await r.text()).match(/\\"garturlres\\",\\"(https?:[^\\"]+)\\"/)?.[1] || null;
}

export async function resolveNewsLink(link, attempt = 0) {
  await paced("d", 500);
  const out = await resolveOnce(link).catch(() => null);
  if (out || attempt >= 2) return out;
  await sleep(2000 * (attempt + 1));
  return resolveNewsLink(link, attempt + 1);
}

// ── Reading a page ──────────────────────────────────────────────────────────

const strip = (h) => unescape(String(h).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "")
  .replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function regroup(text) {
  const sentences = text.match(/[^.!?]+[.!?]+[\u201d"']?(\s+|$)/g) || [text];
  const out = [];
  for (let i = 0; i < sentences.length; i += 3) out.push(sentences.slice(i, i + 3).join("").trim());
  return out.filter(p => p.length > 40);
}

// The article body: JSON-LD articleBody where the site provides it (most major
// outlets do, for search engines), else the paragraphs inside <article>.
export function extractText(html) {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const flat = [JSON.parse(m[1].trim())].flat(4).flatMap(o => [o, ...(o?.["@graph"] || [])]);
      for (const o of flat) {
        const body = o?.articleBody;
        if (typeof body === "string" && body.split(/\s+/).length > 150) {
          let paras = body.split(/\n+|(?<=[.!?”"])\s{2,}/).map(strip).filter(p => p.length > 40);
          // Some sites store the body as one unbroken block. Regroup it into
          // paragraphs of about three sentences, or the reader sees a single
          // wall of text -- and rejects it, since one paragraph is not an article.
          if (paras.length < 3) paras = regroup(strip(body));
          return { headline: strip(o.headline || ""), paras };
        }
      }
    } catch {}
  }
  const scope = (html.match(/<article[\s\S]*?<\/article>/i) || [html])[0];
  const paras = [...scope.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m => strip(m[1]))
    .filter(p => p.length > 60 && !/cookie|subscribe|newsletter|all rights reserved|sign up/i.test(p));
  return { headline: strip((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || ""), paras };
}

export async function readPage(url) {
  for (const ua of [UA, GBOT]) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": ua, Accept: "text/html" }, redirect: "follow",
                                   signal: AbortSignal.timeout(20000) });
      if (!r.ok) continue;
      const { headline, paras } = extractText(await r.text());
      const words = paras.join(" ").split(/\s+/).length;
      if (words >= 250) return { headline, paras, words };
    } catch {}
  }
  return null;
}

/** An articles.json entry, in the markdown shape the reader already parses. */
export function asEntry(page, url, via, relation) {
  const headline = page.headline || "";
  const text = `Title: ${headline}\nURL Source: ${url}\n\nMarkdown Content:\n\n# ${headline}\n\n${page.paras.join("\n\n")}\n`;
  return { type: "markdown", text, source: url, via, relation };
}

// ── The search ──────────────────────────────────────────────────────────────

export async function findCoverage(item) {
  const title = String(item.title || "").replace(/^opinion\s*\|\s*/i, "");
  if (!title) return null;
  const T = salient(title), W = salient(title + " " + (item.desc || ""));
  const pub = Date.parse(item.pubDate || "") || Date.now();
  const keywords = [...new Set([...salient(title), ...salient(item.desc || "")])].slice(0, 8).join(" ");

  const results = [...await newsSearch(title), ...await newsSearch(keywords)];
  const seen = new Set(), cands = [];
  for (const r of results) {
    const h = hostOf(r.sourceUrl);
    if (!isOpenHost(h) || seen.has(r.title)) continue;
    seen.add(r.title);
    if (Math.abs((Date.parse(r.pubDate) || pub) - pub) > 3 * 864e5) continue;   // same news cycle
    const C = salient(r.title);
    const shared = [...W].filter(w => C.has(w)).length, tShared = [...T].filter(w => C.has(w)).length;
    if (shared >= 3 && tShared >= 2) cands.push({ ...r, host: h, score: shared / Math.max(3, Math.min(T.size, C.size)) });
  }
  cands.sort((a, b) => b.score - a.score);

  // WSJ's summary carries the specifics ("a delegation of corporate
  // executives") that a headline on the same topic does not, so the body has
  // to contain most of its key terms to count as the same story.
  const D = salient(item.desc || "");
  const cover = (paras) => D.size < 3 ? null : [...D].filter(w => salient(paras.join(" ")).has(w)).length / D.size;
  const opinion = /^opinion\s*\|/i.test(item.title || "") || /\/opinion\//.test(item.link || "");

  let related = null;
  for (const c of cands.slice(0, 5)) {
    const url = await resolveNewsLink(c.link);
    if (!url || !isOpenHost(hostOf(url)) || /\/(video|videos|live|podcasts?)\//.test(url)) continue;
    const page = await readPage(url);
    if (!page) continue;
    const k = cover(page.paras);
    if (!opinion && (k === null ? c.score >= 0.6 : k >= 0.5)) return asEntry(page, url, c.source || c.host, "same");
    if (!related && (k === null || k >= 0.25)) related = asEntry(page, url, c.source || c.host, "related");
  }
  return related;
}
