/**
 * Partners' own lists of the stories they republish.
 *
 * Searching for a partner's copy of a story goes through Google News, whose
 * index misses many copies and whose link resolver throttles a runner; a
 * partner that keeps a page listing what it republishes can be read directly.
 * Two do, measured from a runner:
 *
 *   Mint      livemint.com/wsj -- WSJ stories, under WSJ's own headlines.
 *             Most are for Mint's subscribers (marked isAccessibleForFree:
 *             false); only the free ones are read.
 *   Yahoo     finance.yahoo.com/topic/bloomberg -- Bloomberg's wire as Yahoo
 *             Finance runs it, including stories Google News never shows.
 *
 * Each list holds only the newest couple of dozen, so every build merges what
 * it sees into an index carried forward between builds. Entries are matched
 * on the headline words in the copy's URL; the copy itself must then credit
 * the original and carry the same headline before it is used.
 */
import { extractFromHtml, fetchHtml, hostOf, headlineOverlap } from "./extract.mjs";
import { credits, publisherFor, subscriberOnly } from "./syndicated.mjs";

export const LISTINGS = [
  { list: "mint-wsj", page: "https://www.livemint.com/wsj", original: /(^|\.)wsj\.com$/, via: "Mint (WSJ)",
    link: /(?:https:\/\/www\.livemint\.com)?(\/[a-z0-9-]+\/(?:[a-z0-9-]+\/)?([a-z0-9-]+)-(\d{12,})\.html)/g,
    url: (m) => `https://www.livemint.com${m[1]}` },
  { list: "yahoo-bloomberg", page: "https://finance.yahoo.com/topic/bloomberg/", original: /(^|\.)bloomberg\.com$/,
    via: "Yahoo Finance (Bloomberg)",
    link: /https:\/\/finance\.yahoo\.com\/(?:[a-z0-9-]+\/)*articles\/([a-z0-9-]+)-(\d{6,})\.html/g,
    url: (m) => m[0] },
];
const INDEX_DAYS = 4;

const slugWords = (slug) => slug.split("-").filter(Boolean);
const words = (t) => String(t || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .replace(/[’']/g, "").replace(/&/g, " and ").split(/[^a-z0-9]+/).filter(Boolean);

async function listing(spec) {
  const got = await fetchHtml(spec.page, "browser", 25000).catch(() => ({}));
  if (!got.html) throw new Error(`http ${got.status || "failed"}`);
  const out = new Map();
  for (const m of got.html.matchAll(spec.link)) {
    const url = spec.url(m);
    const slug = spec.list === "mint-wsj" ? m[2] : m[1];
    if (!out.has(url)) out.set(url, { list: spec.list, url, words: slugWords(slug), at: new Date().toISOString() });
  }
  return [...out.values()];
}

/** Merge the partners' current lists into the carried-forward index. */
export async function refreshListings(prev = [], log = () => {}) {
  const byUrl = new Map((Array.isArray(prev) ? prev : []).map(e => [e.url, e]));
  for (const spec of LISTINGS) {
    try {
      const got = await listing(spec);
      // An entry keeps the time it was first seen, which is about when the
      // partner published it.
      got.forEach(e => { if (!byUrl.has(e.url)) byUrl.set(e.url, e); });
      log(`    ${String(got.length).padStart(3)}  ${spec.list}`);
    } catch (e) { log(`    miss  ${spec.list} (${e.message})`); }
  }
  const cutoff = Date.now() - INDEX_DAYS * 864e5;
  return [...byUrl.values()].filter(e => (Date.parse(e.at) || 0) > cutoff);
}

/**
 * The listed copy of `item`, by the headline words in its URL. Mint's URLs
 * carry the whole headline, Yahoo's its first five or so words; either way
 * nearly every word in the URL must be in the story's headline, and the copy's
 * own headline must then match before it is read.
 */
export function findListed(item, index) {
  const host = hostOf(item.link);
  const specs = LISTINGS.filter(s => s.original.test(host)).map(s => s.list);
  if (!specs.length) return [];
  const title = String(item.title || "").replace(/^opinion\s*\|\s*/i, "");
  const T = new Set(words(title));
  const pub = Date.parse(item.pubDate || "") || Date.now();
  return index
    .filter(e => specs.includes(e.list) && e.words.length >= 3)
    .filter(e => Math.abs((Date.parse(e.at) || pub) - pub) < 3 * 864e5)
    .map(e => ({ e, cover: e.words.filter(w => T.has(w)).length / e.words.length }))
    .filter(x => x.cover >= 0.8)
    .sort((a, b) => b.cover - a.cover || b.e.words.length - a.e.words.length)
    .slice(0, 2)
    .map(x => x.e);
}

export async function listedCopy(item, { index = [], log = () => {} } = {}) {
  const pub = publisherFor(item.link);
  if (!pub) return null;
  const title = String(item.title || "").replace(/^opinion\s*\|\s*/i, "");
  for (const e of findListed(item, index)) {
    const spec = LISTINGS.find(s => s.list === e.list);
    let got = await fetchHtml(e.url, "browser", 20000).catch(() => ({}));
    if (!got.html) { log(`listed:${e.list}:http${got.status || "-"}`); continue; }
    if (subscriberOnly(got.html)) { log(`listed:${e.list}:subscriber-only`); continue; }
    const art = extractFromHtml(got.html, got.url || e.url);
    if (!art || art.partial || art.words < 150) { log(`listed:${e.list}:${art ? art.words + "w" : "unreadable"}`); continue; }
    if (headlineOverlap(title, art.headline || "") < 0.6) { log(`listed:${e.list}:another story`); continue; }
    if (!credits(got.html, art, pub, got.url || e.url)) { log(`listed:${e.list}:uncredited`); continue; }
    log(`listed:${e.list}:${art.words}w`);
    return { type: "article", ...art, source: got.url || e.url, via: spec.via };
  }
  return null;
}
