// Regression test for trimJinaChrome, against a real Jina+gift capture of an
// NYT article: 866 lines, of which only ~140 are the story. The rest is site
// navigation before it and author bios, comment counts and related-content
// links after it.
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
const fn = script.slice(script.indexOf("function trimJinaChrome(text) {"),
                        script.indexOf("// Parse Jina markdown into article paragraphs"));
const { trimJinaChrome } = await import(
  "data:text/javascript;base64," + Buffer.from(fn + "\nexport { trimJinaChrome };").toString("base64"));

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? (pass++, console.log(`  ok   ${name}`))
                                     : (fail++, console.log(`  FAIL ${name}`)); };

const raw = readFileSync(new URL("./fixture-nyt-jina-gift.md", import.meta.url), "utf8");
const out = trimJinaChrome(raw);
const rawLines = raw.split("\n").length, outLines = out.split("\n").length;

console.log(`real NYT capture: ${rawLines} lines -> ${outLines} lines`);
check("cuts at least half the capture", outLines < rawLines / 2);
check("starts at the headline", /^#\s+Why the Iran-Backed Houthis/.test(out.trim()));
check("drops the section menu", !out.includes("### SECTIONS"));
check("drops newsletter promos", !out.includes("### NEWSLETTERS"));
check("drops podcast promos", !out.includes("### PODCASTS"));
check("drops the subscribe bar", !out.includes("$0.25/week"));
check("drops skip-to-content links", !out.includes("Skip to site index"));
check("drops related content", !out.includes("## Related Content"));
check("drops the comment count", !/Read \d+ comments/.test(out));
check("keeps the opening paragraph", out.includes("The conflict has opened a second front"));
check("keeps later body text", out.includes("Here is how the war restarted"));

// The sharing-param capture must survive trimming with the whole article
// intact. A previous version of the trimmer anchored on the meta title, which
// does not match NYT's display headline, so the article went unanchored and a
// navigation h2 was mistaken for the footer -- taking the entire story with it
// and leaving a metered-looking stub. That is what "the gift link broke".
console.log("\nsharing-param capture keeps the full article:");
const gift  = readFileSync(new URL("./fixture-nyt-gift-full.md", import.meta.url), "utf8");
const metered = readFileSync(new URL("./fixture-nyt-plain-metered.md", import.meta.url), "utf8");
const gWords = trimJinaChrome(gift).split(/\s+/).length;
const pWords = trimJinaChrome(metered).split(/\s+/).length;
console.log(`  gift ${gWords}w vs plain ${pWords}w`);
check("gift capture keeps well over 1000 words", gWords > 1000);
check("gift yields at least 3x the metered version", gWords > pWords * 3);
check("starts at the display headline, not the meta title",
  /^#\s+Iraq.s Prime Minister Vows to Disarm/.test(trimJinaChrome(gift).trim()));
check("keeps the opening paragraph", trimJinaChrome(gift).includes("pledged to disarm"));
check("drops the nav above it", !trimJinaChrome(gift).includes("Skip to site index"));

// NYT places its share bar and comment count ABOVE the story as well as below
// it, and repeats the headline, dek and photo credit twice before the body.
// Those three long lines satisfied the "article has begun" guard, so the share
// bar above the story was taken for the footer: a 44 KB capture trimmed to
// 1,055 characters and the reader rendered nothing at all.
console.log("\ntop-of-page share bar is not the end of the article:");
const topbar = readFileSync(new URL("./fixture-nyt-top-sharebar.md", import.meta.url), "utf8");
const tOut = trimJinaChrome(topbar);
console.log(`  ${topbar.length}B -> ${tOut.length}B, ${tOut.split(/\s+/).length}w`);
check("keeps the body past the top share bar", tOut.split(/\s+/).length > 1000);
check("keeps a paragraph from deep in the story",
  tOut.includes("no House member has ascended directly to the presidency"));
check("does not repeat the headline block",
  (tOut.match(/^#\s+Alexandria Ocasio-Cortez on 2028/gm) || []).length === 1);
check("still drops the trailing furniture", !/Read \d+ comments/.test(tOut));

console.log("\nsafety:");
const plain = "Title: A Story\n\nMarkdown Content:\n\n" + "Real prose. ".repeat(60);
check("passes through text with no H1", trimJinaChrome(plain).includes("Real prose."));
check("never returns near-empty", trimJinaChrome("Title: X\n\n# X\n\nshort").length > 10);
const noTitle = "Some capture\n\n" + "Body text here. ".repeat(50);
check("handles a capture with no Title header", trimJinaChrome(noTitle).includes("Body text here."));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
