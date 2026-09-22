/**
 * Per-publisher junk analysis.
 *
 * Runs each capture through the app's own trimmer and paragraph extractor, in
 * a real browser so the page's pipeline is used exactly as shipped, then
 * reports which surviving paragraphs are not article prose. That list is what
 * the per-site rules need to target: guessing at boilerplate from memory
 * produces rules that miss the actual cases.
 *
 *   npm run serve &   # page must be served for the pipeline to load
 *   node research/junk.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { chromium } from "playwright";

const dir = new URL("./captures/", import.meta.url);
const files = readdirSync(dir).filter(f => f.endsWith(".md"));
if (!files.length) { console.error("no captures — run research/capture.mjs first"); process.exit(1); }

const browser = await chromium.launch({
  args: ["--no-sandbox"],
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
});
const page = await browser.newPage({ ignoreHTTPSErrors: true });
await page.goto(process.env.APP_URL || "http://localhost:8080/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1200);

// Classify a surviving paragraph: null means it reads like article prose.
await page.evaluate(() => {
  window.__suspect = (text) => {
    const t = (text || "").replace(/\s+/g, " ").trim();
    if (!t) return "empty";
    if (/^\s*[*\-•]/.test(t)) return "list item";
    if ((t.match(/\|/g) || []).length >= 2) return "pipe-separated nav";
    if (/^(share|save|copy link|print|email this|sign in|log in|subscribe|follow us|advertisement|listen|watch|read more|related|more from|most popular|newsletter|comments?)\b/i.test(t)) return "chrome word";
    if (/^(photo|image|credit|caption|illustration|photograph)s?\b\s*[:\/]/i.test(t)) return "media credit";
    if (/(getty|reuters|associated press|\bafp\b|\bepa\b|shutterstock|alamy)\s*(images)?\.?$/i.test(t) && t.length < 90) return "wire credit";
    if (/^by\s+[A-Z]/.test(t) && t.length < 90) return "byline";
    if (/\b(is a|is the|are)\s+(reporter|correspondent|editor|columnist|writer|journalist|bureau chief|staff writer)\b/i.test(t) && t.length < 300) return "author bio";
    if (/^\S+@\S+\.\S+$/.test(t)) return "email";
    if (/^(follow|contact|reach|email)\s+\S+\s+(on|at|via)\b/i.test(t)) return "author contact";
    if (/^copyright\b|^©|all rights reserved/i.test(t)) return "copyright";
    if (/^\d+\s*(min|minute)s?\s*read/i.test(t)) return "read time";
    if (/^(updated|published|posted)\b/i.test(t) && t.length < 90) return "timestamp";
    if (/^\d{1,2}:\d{2}\b/.test(t) && t.length < 60) return "clock";
    if (t.length < 60 && !/[.!?)"'”]$/.test(t)) return "fragment";
    return null;
  };
});

const tally = {}, perSite = {};

for (const f of files) {
  const raw = readFileSync(new URL(f, dir), "utf8");
  const host = f.replace(/\.md$/, "").replace(/_/g, ".");
  const r = await page.evaluate(([text, h]) => {
    const art = parseJinaMarkdown(text, `https://${h}/x`);
    const paras = (art?.paragraphs || []).map(p => p.text || "");
    const bad = paras.map((t, i) => ({ i, t, why: window.__suspect(t) })).filter(x => x.why);
    return {
      rawLines: text.split("\n").length,
      trimLines: trimJinaChrome(text).split("\n").length,
      paras: paras.length,
      words: paras.join(" ").split(/\s+/).filter(Boolean).length,
      bad: bad.map(b => ({ i: b.i, why: b.why, t: b.t.replace(/\s+/g, " ").slice(0, 72) })),
    };
  }, [raw, host]);

  perSite[host] = r;
  console.log(`\n${host.padEnd(20)} ${r.rawLines}→${r.trimLines} lines, ${r.paras} paras, ${r.words}w, ${r.bad.length} suspect`);
  for (const b of r.bad.slice(0, 10)) {
    console.log(`   #${String(b.i).padStart(3)} [${b.why.padEnd(18)}] ${b.t}`);
    tally[b.why] = (tally[b.why] || 0) + 1;
  }
  if (r.bad.length > 10) console.log(`   … ${r.bad.length - 10} more`);
}

console.log("\n\njunk categories, all captures:");
Object.entries(tally).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(4)}  ${k}`));
console.log("\nworst offenders:");
Object.entries(perSite).sort((a, b) => b[1].bad.length - a[1].bad.length).slice(0, 8)
  .forEach(([h, r]) => console.log(`  ${String(r.bad.length).padStart(3)} suspect of ${String(r.paras).padStart(3)} paras   ${h}`));

await browser.close();
