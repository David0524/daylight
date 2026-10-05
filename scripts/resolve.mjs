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
    if (item.archive && !enough(best)) take(await archivedCopy(item), "archive");
    if (item.minWords && best && !enough(best)) best.partial = true;
    return finish(best, item);
  } finally {
    log(`    ${best ? String(best.words).padStart(5) + "w" : "  miss"}  ${item.link.replace(/^https?:\/\/(www\.)?/, "").slice(0, 70)}  [${notes.join(" ")}]`);
  }
}

// The Wayback Machine's raw capture (`id_`) of the page nearest the given
// date: the publisher's own HTML, without the archive's toolbar. Only asked
// for pieces chosen by hand, whose publishers have since put them behind a
// wall -- a capture from before then holds the whole article.
async function archivedCopy(item) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const got = await fetchHtml(`https://web.archive.org/web/${item.archive}id_/${item.link}`, "browser", 60000)
      .catch(() => ({}));
    if (got.html) {
      const art = extractFromHtml(got.html, item.link);
      const at = (got.url || "").match(/\/web\/(\d{4})(\d{2})(\d{2})/);
      return art && { ...art, archived: at ? `${at[1]}-${at[2]}-${at[3]}` : item.archive };
    }
    if (got.status && got.status !== 429 && got.status < 500) return null;
    await new Promise(r => setTimeout(r, 10000 * (attempt + 1)));
  }
  return null;
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
