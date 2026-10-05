/**
 * Article text for one feed item: every way of reading it, in order of cost,
 * stopping at the first whole article.
 *
 *   1. the publisher's own feed, where it carries the full article
 *   2. a licensed copy, for the Dow Jones titles nothing else can reach
 *   3. the site's routes (scripts/extract.mjs): direct, translation proxy,
 *      a partner's syndicated copy, Jina
 *
 * The result is an articles.json entry: { type: "article", headline, author,
 * date, image, paragraphs, words, partial?, source?, via? }, or null.
 */
import { extractFromFragment, extractFromHtml, readPage, siteFor, UA } from "./extract.mjs";
import { licensedCopy, licensedRule } from "./licensed.mjs";
import { syndicatedCopy } from "./syndicated.mjs";

const whole = (a) => a && !a.partial && a.words >= 250;
const better = (a, b) => a && (!b || (b.partial && !a.partial) || (a.partial === b.partial && a.words > b.words));

export async function resolveArticle(item, { jina, index = [], log = () => {} } = {}) {
  const notes = [];
  let best = null;
  const take = (art, how) => {
    notes.push(`${how}:${art ? art.words + "w" + (art.partial ? "(partial)" : "") : "-"}`);
    if (better(art, best)) best = { ...art, how };
    return whole(best);
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
    return finish(best, item);
  } finally {
    log(`    ${best ? String(best.words).padStart(5) + "w" : "  miss"}  ${item.link.replace(/^https?:\/\/(www\.)?/, "").slice(0, 70)}  [${notes.join(" ")}]`);
  }
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
