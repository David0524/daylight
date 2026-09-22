// Same-story coverage: the pieces that decide what the reader is shown.
import { salient, isOpenHost, extractText, asEntry } from "../scripts/coverage.mjs";

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? (pass++, console.log(`  ok   ${name}`))
                                     : (fail++, console.log(`  FAIL ${name}`)); };
const shared = (a, b) => [...salient(a)].filter(w => salient(b).has(w));

console.log("matching across outlets' wording:");
check("annihilate meets annihilation", shared("Trump Threatens to Annihilate Iran", "Annihilation, AI and a walkout").includes("annihil"));
check("prices meets price", shared("Oil prices fall", "Oil price dips").length === 2);
check("settles meets settlement", shared("Paramount settles", "Paramount settlement").length === 2);
check("stopwords never count", shared("What is the new plan", "Why the new rules").length === 0);

console.log("\nwhich outlets are eligible:");
check("an open outlet is eligible", isOpenHost("adweek.com"));
check("WSJ itself never is", !isOpenHost("wsj.com"));
check("a paywalled outlet is not", !isOpenHost("bloomberg.com") && !isOpenHost("ft.com"));
check("a WSJ licensee that paywalls it is not", !isOpenHost("livemint.com"));
check("social and aggregators are not", !isOpenHost("x.com") && !isOpenHost("msn.com"));
check("non-English sites are not", !isOpenHost("corriere.it"));

console.log("\nextracting the article:");
const sentence = (n) => `Sentence ${n} reports a specific development in the story with enough detail to matter.`;
const body = Array.from({ length: 24 }, (_, i) => sentence(i + 1)).join(" ");
const ld = (b) => `<html><script type="application/ld+json">${JSON.stringify({ "@type": "NewsArticle", headline: "A Headline", articleBody: b })}</script></html>`;
const one = extractText(ld(body));
check("a single-block body is regrouped into paragraphs", one.paras.length >= 6);
check("regrouping keeps every sentence", one.paras.join(" ").includes("Sentence 1 ") && one.paras.join(" ").includes("Sentence 24 "));
const multi = extractText(ld(Array.from({ length: 6 }, (_, i) => sentence(i) + " " + sentence(i + 10)).join("\n")));
check("existing paragraph breaks are kept", multi.paras.length === 6);
const tags = extractText(`<article><h1>H</h1>${Array.from({ length: 5 }, (_, i) => `<p>${sentence(i)} ${sentence(i + 5)}</p>`).join("")}<p>Subscribe to our newsletter for more stories like this one today.</p></article>`);
check("falls back to paragraphs inside <article>", tags.paras.length === 5);
check("drops newsletter furniture", !tags.paras.some(p => /newsletter/i.test(p)));

console.log("\nthe entry the reader parses:");
const e = asEntry({ headline: "H", paras: ["One.", "Two."] }, "https://x.com/a", "X News", "same");
check("carries its source, outlet and relation", e.source === "https://x.com/a" && e.via === "X News" && e.relation === "same");
check("is in the reader's markdown shape", /^Title: H\n/.test(e.text) && e.text.includes("# H\n\nOne.\n\nTwo."));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
