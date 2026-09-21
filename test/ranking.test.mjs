// Exercises the feed ranking/dedupe logic by lifting those functions out of
// index.html and running them in isolation.
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

// Pull the self-contained ranking block plus the two helpers it leans on.
const slice = (startMarker, endMarker) => {
  const a = script.indexOf(startMarker);
  const b = script.indexOf(endMarker, a);
  if (a === -1 || b === -1) throw new Error(`markers not found: ${startMarker}`);
  return script.slice(a, b);
};

const src = [
  slice("const QUALITY_DOMAINS = new Set([", "// Non-English TLD patterns"),
  slice("function isQualitySource(url) {", "function redditImage"),
  slice("const MAX_AGE_DAYS", "// ── Ranking"),
  slice("const WIRE_SERVICES", "function sourceDomain(url) {"),
  "export { rankItems, dedupeItems, canonicalUrl, titleKey, isRecent, rankScore, recencyScore, engagementScore };",
].join("\n");

let mod;
try {
  mod = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
} catch (e) {
  console.error("extracted source failed to load:", e.message);
  process.exit(1);
}
const { rankItems, dedupeItems, canonicalUrl, isRecent, rankScore, recencyScore, engagementScore } = mod;

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
};
const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();

console.log("recency:");
check("fresher item scores higher", recencyScore(hoursAgo(1)) > recencyScore(hoursAgo(12)));
check("halves about every 6h", Math.abs(recencyScore(hoursAgo(6)) / recencyScore(hoursAgo(0)) - 0.5) < 0.02);
check("undated scores zero", recencyScore(undefined) === 0);

console.log("\nrecency cutoff:");
check("undated is NOT recent (was the top-ranking bug)", isRecent(undefined) === false);
check("unparseable is NOT recent", isRecent("not a date") === false);
check("2h old is recent", isRecent(hoursAgo(2)) === true);
check("5 days old is not recent", isRecent(hoursAgo(120)) === false);
check("far-future date rejected", isRecent(new Date(Date.now() + 86400000 * 3).toISOString()) === false);

console.log("\nengagement:");
check("log-scaled, not linear", engagementScore({engagement:1000}) < engagementScore({engagement:10}) * 4);
check("1000 pts hits the ceiling", Math.abs(engagementScore({engagement:1000}) - 20) < 0.1);
check("zero engagement is zero", engagementScore({engagement:0}) === 0);

console.log("\nranking:");
const items = [
  { title:"Old but massive viral post", link:"https://example.com/viral", pubDate:hoursAgo(40), engagement:5000 },
  { title:"Fresh wire story on a real masthead", link:"https://reuters.com/a", pubDate:hoursAgo(1), engagement:5 },
  { title:"Fresh unknown blog", link:"https://randomblog.xyz/b", pubDate:hoursAgo(1), engagement:0 },
];
const ranked = rankItems(items);
check("fresh wire story ranks first", ranked[0].link.includes("reuters"));
check("quality beats unknown at equal recency",
  rankScore(items[1]) > rankScore(items[2]));
check("stale viral does not top fresh quality", ranked[0].link.includes("reuters"));

console.log("\ndedupe:");
check("tracking params ignored",
  canonicalUrl("https://bbc.co.uk/news/x?at_medium=RSS&at_campaign=rss") === canonicalUrl("https://www.bbc.co.uk/news/x/"));
const dupes = [
  { title:"Senate passes sweeping budget bill after long debate", link:"https://a.com/1" },
  { title:"Senate passes sweeping budget bill after marathon session", link:"https://b.com/2" },
  { title:"Something else entirely happened today", link:"https://c.com/3" },
];
check("near-identical headlines collapse", dedupeItems(dupes).length === 2);
check("distinct headline survives", dedupeItems(dupes).some(i => i.link === "https://c.com/3"));
check("same url twice collapses",
  dedupeItems([{title:"A",link:"https://x.com/p"},{title:"B",link:"https://www.x.com/p/"}]).length === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
