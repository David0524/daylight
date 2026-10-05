/**
 * Licensed copies found by headline, for publishers that refuse every route.
 *
 * Bloomberg's newswire runs in full on Yahoo Finance, BNN Bloomberg, the
 * Financial Post and dozens of papers; FT and WSJ pieces are republished by
 * partners too. (NYT is defined here but not routed here: its reposted
 * copies were excerpts as often as not -- see scripts/extract.mjs.) Google News indexes those copies, its search answers from a
 * GitHub runner, and its link resolver turns a result into the partner's URL.
 *
 * A candidate only counts if it is the same story *and* credits the original
 * publisher -- a byline or provider of "Bloomberg", Bloomberg's "(Bloomberg)
 * --" dateline, a Dow Jones copyright line. Another outlet's own reporting on
 * the same news is never passed off as the original.
 */
import { parseHTML } from "linkedom";
import { newsSearch, resolveNewsLink } from "./coverage.mjs";
import { extractFromHtml, fetchHtml, hostOf, headlineOverlap, titleWords } from "./extract.mjs";
import { readCopy, DIGEST } from "./licensed.mjs";

export const PUBLISHERS = {
  // credit  a byline, provider or publisher naming the original
  // marks   lines in the story only the original's copy carries
  // stamps  the same, looked for anywhere in the page: they are cut from the
  //         text as furniture, so the paragraphs no longer hold them
  // Bloomberg's partners take the wire version of a story, which often runs
  // under a different headline from bloomberg.com's, so its copies are also
  // looked for by the story's names and figures (see `keywords`).
  "bloomberg.com": {
    name: "Bloomberg",
    keywords: true,
    credit: /\bbloomberg\b/i,
    marks: [/^\(bloomberg\)\s*[-—–]/i, /bloomberg l\.p\./i, /^[-—–]+\s*with assistance from\b/i],
    stamps: [/\(Bloomberg\)\s*(--|—|–)/],
  },
  "ft.com": {
    name: "FT",
    credit: /financial times/i,
    marks: [/©\s*the financial times limited/i, /copyright the financial times/i],
    stamps: [/©\s*The Financial Times Limited/],
  },
  // Livemint re-cases WSJ's headlines, which an exact-phrase search misses;
  // the stamps below are strict enough to allow a looser search here.
  "wsj.com": {
    name: "WSJ",
    loose: true,
    credit: /dow jones|wall street journal/i,
    marks: [/dow jones & company/i, /\(end\) dow jones newswires/i, /@wsj\.com\b/i],
    stamps: [/\((END|MORE TO FOLLOW)\) Dow Jones Newswires/, /Copyright \(c\) \d{4} Dow Jones &(amp;)? Company/i,
             /Write to [^<]{3,160}@wsj\.com/],
  },
  // NYT licenses its stories to papers worldwide through its news service,
  // and every copy carries the service's line.
  "nytimes.com": {
    name: "NYT",
    credit: /new york times/i,
    marks: [/originally appeared in the new york times/i, /c\.\s?\d{4} the new york times company/i],
    stamps: [/originally appeared in The New York Times/i, /c\.\s?\d{4} The New York Times Company/i],
  },
};

// Never the original itself, nor anything walled or aggregated.
const DENY = /(^|\.)(bloomberg\.com|wsj\.com|ft\.com|barrons\.com|marketwatch\.com|nytimes\.com|economist\.com|theaustralian\.com\.au|afr\.com|thetimes\.co\.uk|telegraph\.co\.uk|scmp\.com|nikkei\.com|seekingalpha\.com|msn\.com|news\.google\.com|facebook\.com|x\.com|twitter\.com|linkedin\.com|reddit\.com|youtube\.com|flipboard\.com|newsbreak\.com|ground\.news|moomoo\.com|futunn\.com)$/;

export const publisherFor = (url) => {
  const h = hostOf(url);
  const k = Object.keys(PUBLISHERS).find(d => h === d || h.endsWith("." + d));
  return k ? PUBLISHERS[k] : null;
};

/** Does this page credit the original publisher, not merely mention it? */
export function credits(html, art, pub, url) {
  if (pub.credit.test(hostOf(url)) && pub.name === "Bloomberg") return true;   // bnnbloomberg.ca
  if ((pub.stamps || []).some(re => re.test(html))) return true;
  if (pub.credit.test(art.author || "")) return true;
  const { document } = parseHTML(html);
  const names = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const walk = (n) => {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) return n.forEach(walk);
        for (const k of ["author", "provider", "sourceOrganization", "creator"]) {
          [].concat(n[k] || []).forEach(v => names.push(typeof v === "string" ? v : v?.name || ""));
        }
        if (n["@graph"]) walk(n["@graph"]);
      };
      walk(JSON.parse(s.textContent));
    } catch {}
  }
  for (const m of document.querySelectorAll('meta[name="author"], meta[property="article:author"], meta[name="provider"], meta[name="article:source"]')) {
    names.push(m.getAttribute("content") || "");
  }
  // Yahoo labels a partner story with the provider's name beside the byline.
  for (const el of document.querySelectorAll('[class*="provider"], [data-testid*="provider"], [class*="caas-attr"]')) {
    names.push(el.textContent || "");
  }
  if (names.some(n => pub.credit.test(n))) return true;
  const ends = [...art.paragraphs.slice(0, 2), ...art.paragraphs.slice(-4)].map(p => p.text);
  return ends.some(t => pub.marks.some(re => re.test(t)));
}

// The names and figures that identify a story. Headlines are title-cased, so
// names come from the summary, which is in sentence case: its capitalised
// words other than a sentence's first. Figures come from both.
const COMMON = /^(the|and|for|with|after|as|in|on|its|is|to|of|a|an|says|new|how|why|what|this|that|from|at|by|more|than|but|will|has|have|are|was|it|i|we|they)$/i;
export function storyKeys(item) {
  const clean = (t) => String(t || "").replace(/[’']s\b/g, "");
  const names = [];
  const inTitle = new Set(clean(item.title).toLowerCase().split(/[^\p{L}\d]+/u));
  for (const sentence of clean(item.desc).split(/(?<=[.!?])\s+/)) {
    sentence.split(/\s+/).forEach((w, i) => {
      const m = w.match(/^[“"(]?(\p{Lu}[\p{L}-]+)/u);
      // A sentence's first word is capitalised anyway; it counts as a name
      // only when the headline names it too ("Chevron Corp. named...").
      if (m && (i > 0 || inTitle.has(m[1].toLowerCase()))) names.push(m[1]);
    });
  }
  const figures = `${clean(item.title)} ${clean(item.desc)}`.match(/\$?\d[\d.,]*%?/g) || [];
  return [...new Set([...names, ...figures].map(w => w.replace(/[.,]$/, "")).filter(w => w.length > 1 && !COMMON.test(w)))];
}

// Whether a page found by keywords tells the same story: most of the story's
// names and figures appear in its opening paragraphs. Two Bloomberg stories on
// the same subject share a few of them, not most.
export function sameStory(item, art) {
  const keys = storyKeys(item);
  if (keys.length < 4) return false;
  const opening = art.paragraphs.slice(0, 8).map(p => p.text).join(" ") + " " + (art.headline || "");
  const found = keys.filter(k => new RegExp(`(^|[^\\p{L}\\d])${k.replace(/[.$%]/g, "\\$&")}`, "iu").test(opening));
  return found.length / keys.length >= 0.6;
}

/**
 * A partner's licensed copy of `item`, or null. Costs one or two news
 * searches and a fetch or two; callers should record a miss so a story is not
 * searched for on every build.
 */
export async function syndicatedCopy(item, { log } = {}) {
  const pub = publisherFor(item.link);
  if (!pub) return null;
  const title = String(item.title || "").replace(/^opinion\s*\|\s*/i, "").trim();
  if (title.split(/\s+/).length < 4) return null;

  // Partners run the story under its own headline, so the exact headline is
  // searched for. A loose search mostly turns up other outlets' reporting on
  // the same news, each costing a fetch only to fail the credit check.
  const cands = [], seen = new Set();
  let results = 0;
  const queries = [`"${title}"`, ...(pub.loose || pub.keywords ? [title] : [])];
  // Google News sometimes finds nothing for a whole headline that it finds
  // for its main words; and a search by the story's names and figures turns
  // up re-headlined copies, at the price of a looser headline match -- which
  // sameStory() below makes up for.
  const keys = pub.keywords ? storyKeys(item) : [];
  if (pub.keywords) queries.push([...titleWords(title)].slice(0, 5).join(" "));
  if (keys.length >= 4) queries.push(keys.slice(0, 6).join(" "));
  for (const q of queries) {
    const byKeys = keys.length >= 4 && !q.startsWith('"') && q !== title;
    const res = await newsSearch(q).catch(() => []);
    results += res.length;
    for (const r of res) {
      const h = hostOf(r.sourceUrl);
      // A digest lists many stories and quotes this headline among them.
      if (!h || DENY.test(h) || DIGEST.test(r.title) || seen.has(r.link)) continue;
      seen.add(r.link);
      const score = headlineOverlap(title, r.title);
      if (score >= 0.8 || (byKeys && score >= 0.4)) cands.push({ ...r, host: h, score, byKeys: score < 0.8 });
    }
    if (cands.length) break;
  }
  cands.sort((a, b) => b.score - a.score);
  log?.(`gnews:${results}/${cands.length}`);

  for (const c of cands.slice(0, 3)) {
    const url = await resolveNewsLink(c.link).catch(() => null);
    if (!url || DENY.test(hostOf(url))) continue;
    // Dow Jones' own licensees are read the way the index reads them, which
    // copes with Morningstar's bot control and its split stories.
    if (/(^|\.)(morningstar\.com|kanebridgenews\.com|kanebridgenewsme\.com)$/.test(hostOf(url))) {
      if (pub.name !== "WSJ") continue;
      const copy = await readCopy(url, `${c.source || c.host} (Dow Jones)`).catch(() => null);
      if (copy && headlineOverlap(title, copy.headline || c.title) >= 0.6) return copy;
      continue;
    }
    for (const ua of ["browser", "googlebot"]) {
      const got = await fetchHtml(url, ua, 20000).catch(() => ({}));
      if (!got.html) continue;
      const art = extractFromHtml(got.html, got.url || url);
      if (!art || art.partial || art.words < 150) continue;
      if (c.byKeys ? !sameStory(item, art) : headlineOverlap(title, art.headline || c.title) < 0.6) {
        log?.(`    ${c.host}: another story`); break;
      }
      if (!credits(got.html, art, pub, got.url || url)) { log?.(`    ${c.host}: not credited to ${pub.name}`); break; }
      return { type: "article", ...art, source: got.url || url, via: `${c.source || c.host} (${pub.name})` };
    }
  }
  return null;
}
