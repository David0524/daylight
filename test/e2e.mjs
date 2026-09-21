// Drives the real page in Chromium against test/serve.mjs and reports what
// the feed actually rendered. Start serve.mjs first.
import { chromium } from "playwright";

const browser = await chromium.launch({ args: ["--no-sandbox"], ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const page = await browser.newPage({ viewport: { width: 430, height: 932 }, ignoreHTTPSErrors: true });

const errors = [];
page.on("pageerror", e => errors.push(String(e.message)));
page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });

await page.goto("http://localhost:8080/", { waitUntil: "domcontentloaded" });

// Wait for the feed to actually populate.
await page.waitForFunction(
  () => document.querySelectorAll("#feedContent [data-idx]").length > 0
     || document.querySelector(".feed-empty"),
  { timeout: 60000 }
).catch(() => {});
await page.waitForTimeout(22000);  // stagger is 300ms x 18 sources + a 10s per-source timeout

const report = await page.evaluate(() => {
  const cards = [...document.querySelectorAll("#feedContent [data-idx]")];
  const read = (c) => ({
    t: (c.querySelector(".card-hero-title, .card-mini-title")?.textContent || "").trim().slice(0, 58),
    meta: (c.querySelector(".card-hero-meta, .card-mini-meta")?.textContent || "").trim().replace(/\s+/g, " ").slice(0, 34),
    img: Boolean(c.querySelector("img[src^='http']")),
  });
  const cats = [...document.querySelectorAll("#feedContent .cat-title, #feedContent .feed-cat-title, #feedContent h2, #feedContent .section-title")]
    .map(e => e.textContent.trim()).filter(Boolean);
  const titles = cards.map(c => read(c).t.toLowerCase()).filter(Boolean);
  return {
    cardCount: cards.length,
    categories: [...new Set(cats)],
    empty: Boolean(document.querySelector(".feed-empty")),
    sample: cards.slice(0, 10).map(read),
    withImages: cards.filter(c => c.querySelector("img[src^='http']")).length,
    dupTitles: titles.length - new Set(titles).size,
  };
});

console.log("cards rendered :", report.cardCount);
console.log("empty-state    :", report.empty);
console.log("categories     :", report.categories.join(", ") || "(none)");
console.log("with images    :", report.withImages, "/", report.cardCount);
console.log("duplicate titles:", report.dupTitles);
console.log("\ntop items in feed order:");
report.sample.forEach((i, n) => console.log(`  ${String(n + 1).padStart(2)}. ${i.img ? "[img]" : "[   ]"} ${(i.meta || "?").padEnd(34)} ${i.t}`));
if (errors.length) { console.log("\npage errors:"); [...new Set(errors)].slice(0, 8).forEach(e => console.log("  " + e.slice(0, 160))); }
else console.log("\nno page errors");

await page.screenshot({ path: "feed.png", fullPage: false });
await browser.close();
