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
const ARCHIVE_BUDGET_MS = 3 * 60 * 1000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function captures(item, deadline) {
  const q = `${WAYBACK}/cdx/search/cdx?url=${encodeURIComponent(item.link)}&output=json&filter=statuscode:200`
          + `&from=${item.archive}&limit=6&fl=timestamp`;
  for (let attempt = 0; attempt < 2 && Date.now() < deadline; attempt++) {
    try {
      const r = await fetch(q, { signal: AbortSignal.timeout(30000) });
      if (r.ok) return (await r.json()).slice(1).map(row => row[0]);
    } catch {}
    await sleep(10000);
  }
  return [];
}

// Bounded: a few minutes per piece at most, so a slow archive cannot hold the
// build. A piece not read this time is retried on a later build.
export async function archivedCopy(item, note = () => {}) {
  const deadline = Date.now() + ARCHIVE_BUDGET_MS;
  const stamps = (await captures(item, deadline)).slice(0, 3);
  note(`wayback:${stamps.length} captures`);
  let best = null, i = 0;
  for (let tries = 0; tries < 6 && i < stamps.length && Date.now() < deadline; tries++) {
    const ts = stamps[i];
    const left = deadline - Date.now();
    const got = await fetchHtml(`${WAYBACK}/web/${ts}id_/${item.link}`, "browser", Math.min(40000, left))
      .catch((e) => ({ status: e.name === "TimeoutError" ? "timeout" : "error" }));
    if (!got.html) {
      note(`${ts.slice(0, 8)}:${got.status || "none"}`);
      // Refused for now: wait and ask again. Gone or timing out: next capture.
      if (got.status === 429 || got.status >= 500) await sleep(Math.min(20000, Math.max(0, deadline - Date.now())));
      else i++;
      continue;
    }
    const art = extractFromHtml(got.html, item.link);
    note(`${ts.slice(0, 8)}:${art ? art.words + "w" : "unreadable"}`);
    if (art && (!best || art.words > best.words)) {
      best = { ...art, archived: `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}` };
    }
    if (best && !best.partial && best.words >= (item.minWords || 250)) break;
    i++;
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
