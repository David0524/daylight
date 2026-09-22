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

console.log("\nsafety:");
const plain = "Title: A Story\n\nMarkdown Content:\n\n" + "Real prose. ".repeat(60);
check("passes through text with no H1", trimJinaChrome(plain).includes("Real prose."));
check("never returns near-empty", trimJinaChrome("Title: X\n\n# X\n\nshort").length > 10);
const noTitle = "Some capture\n\n" + "Body text here. ".repeat(50);
check("handles a capture with no Title header", trimJinaChrome(noTitle).includes("Body text here."));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
