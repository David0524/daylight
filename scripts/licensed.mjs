/**
 * Licensed copies of Dow Jones stories.
 *
 * WSJ and MarketWatch refuse every automated fetch: their edge answers 401 in
 * a few milliseconds, before any header is read, and no archive holds them.
 * But Dow Jones licenses much of its output to Morningstar, which publishes it
 * in full and free -- the newswire (including many WSJ stories) under
 * /news/dow-jones/ and MarketWatch's articles under /news/marketwatch/. Its
 * article URLs carry a numeric id that cannot be derived from a headline, so
 * copies are found from Morningstar's own listing pages.
 *
 * Those listings hold only the newest 50 stories each -- about five hours of
 * newswire, about a day of MarketWatch -- so every build merges what it sees
 * into an index that is carried forward between builds, and a WSJ story can be
 * matched against several days of copy rather than the last few hours.
 *
 * Kanebridge News republishes a selection of WSJ features and opinion columns,
 * which Morningstar never carries; its URLs are the headline slugified, so a
 * copy is checked for directly.
 */
import { parseHTML } from "linkedom";
import { UA, extractFromHtml, fetchHtml, hostOf, headlineOverlap, titleWords } from "./extract.mjs";

export const LICENSED = [
  { host: /(^|\.)wsj\.com$/i, lists: ["dow-jones"], kanebridge: true },
  { host: /(^|\.)barrons\.com$/i, lists: ["dow-jones"] },
  { host: /(^|\.)marketwatch\.com$/i, lists: ["marketwatch"] },
];
export const licensedRule = (url) => LICENSED.find(r => r.host.test(hostOf(url))) || null;

const VIA = { "dow-jones": "Morningstar (Dow Jones)", marketwatch: "Morningstar (MarketWatch)" };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Morningstar sits behind AWS's bot control, which intermittently answers a
// cloud address with a challenge (HTTP 202, empty body) instead of the page.
// Measured from a cloud machine at a polite pace: 202 202 202 200 202 200 200
// 200 200 200 -- so waiting and asking again gets through.
async function fetchPatient(url, tries = 4) {
  let got = {};
  for (let i = 0; i < tries; i++) {
    got = await fetchHtml(url, "browser", 25000).catch(() => ({}));
    if (got.html || (got.status && got.status !== 202 && got.status !== 429)) return got;
    await sleep(3000 * (i + 1));
  }
  return got;
}
const INDEX_DAYS = 6;

// ── Matching ────────────────────────────────────────────────────────────────

const stripOpinion = (t) => String(t || "").replace(/^opinion\s*\|\s*/i, "").trim();

// Digests mention many stories and must not stand in for any one of them;
// roundups bundle the story with unrelated items.
export const DIGEST = /^(dow jones top .* headlines|top [a-z]+ headlines|.*\broundup\b|.*\bbriefing\b|.*\bmorning briefing\b|.*\bmidday briefing\b)/i;

/**
 * The best copy of a story in the index, or null. A headline has to match
 * closely: newswire slugs track the headline, sometimes with "— Update" or
 * "— 2nd Update" appended as the story develops, so word overlap rather than
 * equality, and among matching updates the latest wins.
 */
export function findInIndex(item, index, lists) {
  const title = stripOpinion(item.title);
  const A = titleWords(title);
  if (A.size < 3) return null;
  const pub = Date.parse(item.pubDate || "") || Date.now();
  let best = null;
  for (const e of index) {
    // "-2-" entries are continuations of a split story, read with its first part.
    if (!lists.includes(e.list) || DIGEST.test(e.title) || /-\d+-\s*$/.test(e.title)) continue;
    // The copy appears around when the story does; days apart is another story
    // that happens to share words.
    if (Math.abs((Date.parse(e.at) || pub) - pub) > 3 * 864e5) continue;
    const t = e.title.replace(/\s*[—–-]+\s*(\d+(st|nd|rd|th)\s+)?update\s*$/i, "");
    const score = headlineOverlap(title, t);
    // Both directions: a short headline wholly inside a long one is not a match.
    const B = titleWords(t);
    const cover = [...B].filter(w => A.has(w)).length / Math.max(1, B.size);
    if (score < 0.75 || cover < 0.6) continue;
    if (!best || score > best.score || (score === best.score && e.id > best.id)) best = { ...e, score };
  }
  return best;
}

// ── The index ───────────────────────────────────────────────────────────────

async function listing(list) {
  const got = await fetchPatient(`https://www.morningstar.com/news/${list}`);
  if (!got.html) throw new Error(`listing ${list}: http ${got.status}`);
  const { document } = parseHTML(got.html);
  const out = [];
  for (const a of document.querySelectorAll(`a[href^="/news/${list}/"]`)) {
    const href = a.getAttribute("href");
    const m = href.match(/^\/news\/[a-z-]+\/(\d+)\/[a-z0-9-]+/);
    if (!m) continue;
    const title = (a.querySelector("h2, h3, h4, [class*='headline'], [class*='title']")?.textContent || "")
      .replace(/\s+/g, " ").trim();
    const at = a.querySelector("time")?.getAttribute("datetime") || new Date().toISOString();
    if (title) out.push({ list, id: m[1], url: `https://www.morningstar.com${m[0]}`, title, at });
  }
  return out;
}

/** Merge the current listings into the carried-forward index. */
export async function refreshIndex(prev = [], log = () => {}) {
  const byUrl = new Map((Array.isArray(prev) ? prev : []).map(e => [e.url, e]));
  for (const list of [...new Set(LICENSED.flatMap(r => r.lists))]) {
    try {
      const got = await listing(list);
      got.forEach(e => byUrl.set(e.url, e));
      log(`    ${String(got.length).padStart(3)}  morningstar ${list}`);
    } catch (e) { log(`    miss  morningstar ${list} (${e.message})`); }
  }
  const cutoff = Date.now() - INDEX_DAYS * 864e5;
  return [...byUrl.values()].filter(e => (Date.parse(e.at) || 0) > cutoff)
    .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
}

// ── Reading a copy ──────────────────────────────────────────────────────────

const KANEBRIDGE = ["https://kanebridgenews.com/", "https://kanebridgenewsme.com/"];

export const slugify = (t) => stripOpinion(t).toLowerCase()
  .normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[‘’']/g, "")
  .replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export async function readCopy(url, via) {
  const got = /morningstar\.com/.test(url) ? await fetchPatient(url) : await fetchHtml(url, "browser", 25000);
  if (!got.html) return null;
  // Kanebridge also hosts its own stories; the Dow Jones copyright line is
  // what confirms a page is the licensed WSJ piece.
  if (/kanebridge/.test(url) && !/Dow Jones &(amp;)? Company/i.test(got.html)) return null;
  // Whole newswire stories can be short, so the floor is lower than for an
  // arbitrary page: this is a known-clean copy, not a guess at one.
  const art = extractFromHtml(got.html, url, { minWords: 50 });
  if (!art || art.partial) return null;

  // The newswire splits long stories into parts: the first ends "(MORE TO
  // FOLLOW)" and the rest are published under the next ids, titled with the
  // headline's opening words and "-2-", "-3-". Morningstar resolves an article
  // by id alone, so each continuation is the next id.
  let html = got.html, id = url.match(/\/news\/([a-z-]+)\/(\d+)\//);
  for (let part = 2; id && part <= 6 && /\(MORE TO FOLLOW\)\s*Dow Jones Newswires/i.test(html); part++) {
    const next = `https://www.morningstar.com/news/${id[1]}/${BigInt(id[2]) + 1n}/continued`;
    const more = await fetchPatient(next);
    if (!more.html || !new RegExp(`-${part}-\\s*(\\||<)`).test(more.html.match(/<title>[^<]*<\/title>/i)?.[0] || "")) break;
    const rest = extractFromHtml(more.html, next, { minWords: 1 });
    if (!rest) break;
    art.paragraphs.push(...rest.paragraphs.filter(p => !/^-?\d+-?$/.test(p.text)));
    html = more.html;
    id = next.match(/\/news\/([a-z-]+)\/(\d+)\//);
  }
  art.words = art.paragraphs.reduce((n, p) => n + p.text.split(/\s+/).length, 0);
  return { type: "article", ...art, source: url, via };
}

async function kanebridgeCopy(title) {
  const slug = slugify(title);
  if (!slug) return null;
  for (const base of KANEBRIDGE) {
    try {
      const copy = await readCopy(`${base}${slug}/`, "Kanebridge News (WSJ)");
      if (copy) return copy;
    } catch {}
  }
  return null;
}

/**
 * A licensed copy of a WSJ, Barron's or MarketWatch story, or null.
 *
 * In order: Morningstar's copy from the carried-forward index; Kanebridge's,
 * checked by slug; a partner's copy found through Google News (`syndicated`);
 * and a Morningstar copy found by a keyed Jina search (`search`), which is
 * skipped when no working key is available.
 */
export async function licensedCopy(item, { index = [], search, syndicated, log = () => {} } = {}) {
  const rule = licensedRule(item.link);
  if (!rule) return null;
  const title = stripOpinion(item.title);
  if (!title) return null;

  const hit = findInIndex(item, index, rule.lists);
  if (hit) {
    const copy = await readCopy(hit.url, VIA[hit.list]).catch(() => null);
    log(`index:${copy ? "read" : "unreadable"}`);
    if (copy) return copy;
  } else log("index:-");
  if (rule.kanebridge) {
    const kb = await kanebridgeCopy(title);
    log(`kanebridge:${kb ? "read" : "-"}`);
    if (kb) return kb;
  }
  if (syndicated && rule.kanebridge) {
    const copy = await syndicated(item, { log }).catch(() => null);
    if (copy) return copy;
  }
  if (search) {
    for (const list of rule.lists) {
      const urls = await search(`morningstar.com ${list} "${title}"`).catch(() => []);
      const found = urls
        .map(u => ({ u, m: u.match(new RegExp(`morningstar\\.com/news/${list}/\\d+/([a-z0-9-]+)`)) }))
        .filter(x => x.m && !DIGEST.test(x.m[1].replace(/-/g, " ")))
        .map(x => ({ u: x.u, s: headlineOverlap(title, x.m[1].replace(/-/g, " ")) }))
        .filter(x => x.s >= 0.75).sort((a, b) => b.s - a.s)[0];
      if (found) {
        const copy = await readCopy(found.u, VIA[list]).catch(() => null);
        if (copy) return copy;
      }
    }
  }
  return null;
}

export { UA, headlineOverlap };
