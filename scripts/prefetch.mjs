/**
 * Fills in article text for a feed that has already been published, without
 * rebuilding (and re-fetching) the feed itself.
 *
 *   node scripts/prefetch.mjs [outDir] [feedUrlOrPath]
 *
 * Writes outDir/articles.json, outDir/a/<id>.json and a copy of the feed with
 * each item marked as read or not -- the same files build-feed.mjs publishes.
 * JINA_API_KEY is read from the environment if set, and never written out.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { canonicalUrl, resolveItem, rankScore, articleId } from "./build-feed.mjs";
import { createJina } from "./jina.mjs";
import { refreshIndex } from "./licensed.mjs";

const OUT_DIR = process.argv[2] || "dist";
const FEED_SRC = process.argv[3] ||
  "https://raw.githubusercontent.com/David0524/daylight/data/feed.json";
const LIMIT = Number(process.env.PREFETCH_LIMIT || 400);

async function loadFeed(src) {
  if (existsSync(src)) return JSON.parse(readFileSync(src, "utf8"));
  const r = await fetch(src, { headers: { "Cache-Control": "no-cache" } });
  if (!r.ok) throw new Error(`feed ${src}: http ${r.status}`);
  return r.json();
}

async function main() {
  const feed = await loadFeed(FEED_SRC);
  const items = [
    ...Object.values(feed.categories || {}).flat(),
    ...Object.values(feed.papers || {}).flatMap(p => p.items || []),
  ];
  const seen = new Set();
  const top = items
    .filter(i => i?.link && !seen.has(canonicalUrl(i.link)) && seen.add(canonicalUrl(i.link)))
    .sort((a, b) => rankScore(b) - rankScore(a))
    .slice(0, LIMIT);
  console.log(`Reading ${top.length} of ${items.length} stories`);

  const ctx = { jina: createJina(process.env.JINA_API_KEY || "", console.log), index: await refreshIndex([], console.log), log: console.log };
  const articles = {};
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < top.length) {
      const item = top[next++];
      articles[canonicalUrl(item.link)] = await resolveItem(item, ctx);
    }
  }));

  mkdirSync(join(OUT_DIR, "a"), { recursive: true });
  let hit = 0;
  for (const [key, e] of Object.entries(articles)) {
    if (!e?.paragraphs) continue;
    hit++;
    const { how, at, av, ...pub } = e;
    writeFileSync(join(OUT_DIR, "a", `${articleId(key)}.json`), JSON.stringify(pub));
  }
  for (const i of items) {
    const e = articles[canonicalUrl(i.link)];
    delete i.a; delete i.ap; delete i.am;
    if (e?.paragraphs) { i.a = articleId(canonicalUrl(i.link)); if (e.partial) i.ap = 1; }
    else if (e?.miss) i.am = 1;
  }
  if (!hit) { console.error("No articles resolved — refusing to publish"); process.exit(1); }
  writeFileSync(join(OUT_DIR, "articles.json"), JSON.stringify(articles));
  writeFileSync(join(OUT_DIR, "feed.json"), JSON.stringify(feed));
  console.log(`\n  ${hit}/${top.length} stories have text`);
}

main().catch(e => { console.error(e); process.exit(1); });
