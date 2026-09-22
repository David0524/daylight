/**
 * Fills in article text for a feed that has already been published.
 *
 * build-feed.mjs prefetches as part of a full build, which means a build runner
 * without JINA_API_KEY publishes a feed with an empty articles.json — every
 * article then has to be fetched from the browser, where the paywalled papers
 * are unreachable. This script closes that gap: it reads the published
 * feed.json, resolves the text for its top stories, and writes articles.json
 * alone, leaving the feed untouched.
 *
 *   node scripts/prefetch.mjs [outDir] [feedUrlOrPath]
 *
 * The key is only ever read from the environment. It is never written into the
 * output, which is published to a public branch.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { canonicalUrl, resolveItem, rankScore } from "./build-feed.mjs";

const OUT_DIR = process.argv[2] || "dist";
const FEED_SRC = process.argv[3] ||
  "https://raw.githubusercontent.com/David0524/daylight/data/feed.json";
const LIMIT = Number(process.env.PREFETCH_LIMIT || 70);
const BATCH = 5;


async function loadFeed(src) {
  if (existsSync(src)) return JSON.parse(readFileSync(src, "utf8"));
  const r = await fetch(src, { headers: { "Cache-Control": "no-cache" } });
  if (!r.ok) throw new Error(`feed ${src}: http ${r.status}`);
  return r.json();
}

async function main() {
  const feed = await loadFeed(FEED_SRC);

  // Categories carry the front page; the paper sections carry the mastheads the
  // browser cannot reach on its own, so both feed the candidate list. Ranking
  // then decides what is worth the fetch budget.
  const items = [
    ...Object.values(feed.categories || {}).flat(),
    ...Object.values(feed.papers || {}).flatMap(p => p.items || []),
  ];

  const seen = new Set();
  const top = items
    .filter(i => i?.link && !seen.has(canonicalUrl(i.link)) && seen.add(canonicalUrl(i.link)))
    .sort((a, b) => rankScore(b) - rankScore(a))
    .slice(0, LIMIT);

  console.log(`Prefetching ${top.length} of ${items.length} articles`);

  const articles = {};
  let hit = 0;
  for (let i = 0; i < top.length; i += BATCH) {
    await Promise.all(top.slice(i, i + BATCH).map(async (item) => {
      const entry = await resolveItem(item);
      if (entry) articles[canonicalUrl(item.link)] = entry;
      const text = entry?.text;
      if (text) hit++;
      const host = (() => { try { return new URL(item.link).hostname.replace(/^www\./, ""); } catch { return "?"; } })();
      console.log(`  ${text ? String(text.length).padStart(7) : "   miss"}  ${host}`);
    }));
  }

  if (!hit) { console.error("No articles resolved — refusing to publish an empty articles.json"); process.exit(1); }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "articles.json"), JSON.stringify(articles));
  const kb = Math.round(readFileSync(join(OUT_DIR, "articles.json")).length / 1024);
  console.log(`\n  articles.json ${kb} KB  (${hit}/${top.length} resolved)`);
}

main().catch(e => { console.error(e); process.exit(1); });
