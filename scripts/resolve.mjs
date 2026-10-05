/**
 * Article text for one feed item: every way of reading it, in order of cost,
 * stopping at the first whole article.
 *
 *   1. the publisher's own feed, where it carries the full article
 *   2. a licensed copy, for the Dow Jones titles nothing else can reach
 *   3. the site's routes (scripts/extract.mjs): direct, translation proxy,
 *      a partner's syndicated copy, Jina
 *   4. for a long-form piece that names a snapshot (`item.archive`, the
 *      Deep list in sources.json), the Internet Archive's copy from before
 *      its publisher walled it
 *
 * The result is an articles.json entry: { type: "article", headline, author,
 * date, image, paragraphs, words, partial?, source?, via? }, or null.
 */
import { extractFromFragment, extractFromHtml, fetchHtml, readPage, siteFor, UA } from "./extract.mjs";
import { licensedCopy, licensedRule } from "./licensed.mjs";
import { syndicatedCopy } from "./syndicated.mjs";

const whole = (a) => a && !a.partial && a.words >= 250;
const better = (a, b) => a && (!b || (b.partial && !a.partial) || (a.partial === b.partial && a.words > b.words));

export async function resolveArticle(item, { jina, index = [], log = () => {} } = {}) {
  const notes = [];
  let best = null;
  // A hand-picked long read sets its own floor: a few hundred words of it is
  // the publisher's preview, however cleanly it reads.
  const enough = (a) => whole(a) && a.words >= (item.minWords || 0);
  const take = (art, how) => {
    notes.push(`${how}:${art ? art.words + "w" + (art.partial ? "(partial)" : "") : "-"}`);
    if (better(art, best)) best = { ...art, how };
    return enough(best);
  };

  try {
    // 1. Several publishers put the whole article in their feed -- including
    //    Politico and The Atlantic, which refuse every request from a runner.
    if (item._content) {
      const art = extractFromFragment(item._content, item.link,
        { title: item.title, author: item._author, date: item.pubDate, image: item.image });
      if (take(art, "feed")) return finish(best, item);
    }

    // 2. WSJ, Barron's and MarketWatch: licensed copies only.
    if (licensedRule(item.link)) {
      const copy = await licensedCopy(item, { index, search: jina?.search, syndicated: syndicatedCopy,
                                              log: (s) => notes.push(s.trim()) });
      take(copy, "licensed");
      return finish(best, item);
    }

    // 3. The site's own routes.
    for (const route of siteFor(item.link).routes) {
      let art = null;
      if (route === "direct" || route === "translate") {
        art = await readPage(item.link, { via: route, log: (s) => notes.push(s) });
      } else if (route === "syndicated") {
        art = await syndicatedCopy(item, { log: (s) => notes.push(s.trim()) });
      } else if (route === "jina" && jina) {
        const site = siteFor(item.link);
        const ua = site.ua.find(u => u !== "browser");
        for (const target of site.jinaUrls ? site.jinaUrls(item.link) : [item.link]) {
          const html = await jina.html(target, { ua: ua ? UA[ua] : undefined, selector: site.body });
          const got = html ? extractFromHtml(html, item.link) : null;
          if (better(got, art)) art = got;
          if (whole(art)) break;
        }
      }
      if (take(art, route)) break;
    }
    if (item.archive && !enough(best)) take(await archivedCopy(item, (n) => notes.push(n)), "archive");
    if (item.minWords && best && !enough(best)) best.partial = true;
    return finish(best, item);
  } finally {
    log(`    ${best ? String(best.words).padStart(5) + "w" : "  miss"}  ${item.link.replace(/^https?:\/\/(www\.)?/, "").slice(0, 70)}  [${notes.join(" ")}]`);
  }
}

// The Wayback Machine's raw capture (`id_`) of the page: the publisher's own
// HTML, without the archive's toolbar. Only asked for pieces chosen by hand
// whose publishers have since walled them, so the earliest captures -- from
// before the wall -- are tried first. Exact timestamps come from the archive's
// index, which answers readily; captures themselves are rate-limited hard
// (measured from a runner: one request in four answered when asked a few
// seconds apart), so each is asked for patiently.
const WAYBACK = "https://web.archive.org";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function captures(item) {
  const q = `${WAYBACK}/cdx/search/cdx?url=${encodeURIComponent(item.link)}&output=json&filter=statuscode:200`
          + `&from=${item.archive}&limit=6&fl=timestamp`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(q, { signal: AbortSignal.timeout(60000) });
      if (r.ok) return (await r.json()).slice(1).map(row => row[0]);
    } catch {}
    await sleep(15000 * (attempt + 1));
  }
  return [];
}

async function archivedCopy(item, note = () => {}) {
  const stamps = await captures(item);
  note(`wayback:${stamps.length} captures`);
  let best = null;
  for (const ts of stamps.slice(0, 3)) {
    for (let attempt = 0; attempt < 4; attempt++) {
      await sleep(attempt ? 30000 * attempt : 5000);
      const got = await fetchHtml(`${WAYBACK}/web/${ts}id_/${item.link}`, "browser", 60000)
        .catch((e) => ({ status: e.name === "TimeoutError" ? "timeout" : "error" }));
      if (!got.html) {
        note(`${ts.slice(0, 8)}:${got.status || "none"}`);
        if (got.status === 429 || got.status >= 500 || typeof got.status === "string") continue;
        break;
      }
      const art = extractFromHtml(got.html, item.link);
      note(`${ts.slice(0, 8)}:${art ? art.words + "w" : "unreadable"}`);
      if (art && (!best || art.words > best.words)) {
        best = { ...art, archived: `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}` };
      }
      break;
    }
    if (best && !best.partial && best.words >= (item.minWords || 250)) break;
  }
  return best;
}

// Whatever a route could not say about the story, the feed item can: a page
// read through a proxy or cut down to its article container keeps the text but
// can lose the headline, date and picture.
function finish(best, item) {
  if (!best) return null;
  const { how, ...art } = best;
  // A copy read from a partner carries the partner's picture -- Morningstar's
  // is its own logo -- so the original's picture from the feed goes first.
  const image = art.source ? item.image || art.image : art.image || item.image;
  return { type: "article", ...art, headline: art.headline || item.title || "",
           date: art.date || item.pubDate || "", image: image || "", how };
}
