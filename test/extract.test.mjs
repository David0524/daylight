// The build's article extraction and licensed-copy matching, against synthetic
// pages built to the same structure as the real ones (no publisher text is
// committed). Run: node test/extract.test.mjs
import { readFileSync } from "node:fs";
import { extractFromHtml, extractFromFragment, translateUrl, siteFor } from "../scripts/extract.mjs";
import { findInIndex } from "../scripts/licensed.mjs";
import { credits, publisherFor, storyKeys, sameStory } from "../scripts/syndicated.mjs";
import { articleId, canonicalUrl, parseFeed } from "../scripts/build-feed.mjs";

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? (pass++, console.log(`  ok   ${name}`))
                                     : (fail++, console.log(`  FAIL ${name}`)); };

const para = (n) => `Paragraph ${n} reports a specific development in the story, with enough detail and context to be worth reading on its own.`;
const paras = (n, from = 1) => Array.from({ length: n }, (_, i) => `<p>${para(i + from)}</p>`).join("");
const page = (head, body) => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;

console.log("NYT layout:");
const nytHead = `<title>A Headline - The New York Times</title>` +
  ld({ "@type": "NewsArticle", headline: "A Headline", isAccessibleForFree: false,
       author: [{ name: "Jane Roe" }, { name: "John Doe" }], datePublished: "2026-10-05T04:00:00Z",
       image: [{ url: "https://static01.nyt.com/x.jpg" }] });
const nytBody = `<header><h1>A Headline</h1><p>The standfirst repeated above the story.</p></header>
  <section name="articleBody">
    <div data-testid="companionColumn-0"><div>${paras(4)}</div></div>
    <div data-testid="inline-interactive"><p>Map label</p><p>Source: Health ministry</p></div>
    <div data-testid="companionColumn-1"><div>${paras(4, 5)}</div></div>
    <p>Jane Roe is the East Africa bureau chief for The New York Times, based in Nairobi.</p>
  </section><p>Advertisement</p>`;
const nyt = extractFromHtml(page(nytHead, nytBody), "https://www.nytimes.com/2026/10/05/world/a.html");
check("reads the story from the article body", nyt && nyt.paragraphs.length === 8);
check("drops inline graphics' labels", !nyt.paragraphs.some(p => /Map label|Source:/.test(p.text)));
check("drops the author bio", !nyt.paragraphs.some(p => /bureau chief/.test(p.text)));
check("takes byline, date and image from JSON-LD",
  nyt.author === "Jane Roe, John Doe" && nyt.date.startsWith("2026-10-05") && nyt.image.endsWith("x.jpg"));
check("strips the site name from the headline", nyt.headline === "A Headline");
check("a whole NYT page is not a preview, despite the paid flag", nyt.partial === false);
const cut = extractFromHtml(page(nytHead, nytBody + `<div data-testid="optimistic-truncator-noscript"></div>`),
  "https://www.nytimes.com/2026/10/05/world/a.html");
check("the truncated NYT page is marked as a preview", cut && cut.partial === true);

console.log("\ngeneric pages (Readability):");
const generic = page(`<title>Story | Example News</title><meta property="og:title" content="Story">`,
  `<nav><ul><li><a href="/">Home</a></li><li><a href="/w">World</a></li></ul></nav>
   <main><div class="story"><h1>Story</h1><p>By Sam Smith</p><p>Published 4 October 2026</p>
   ${paras(6)}<p>Advertisement</p>${paras(3, 7)}<h2>Related</h2></div></main>
   <footer><p>Copyright 2026 Example News. All rights reserved. Terms and privacy.</p></footer>`);
const g = extractFromHtml(generic, "https://example.com/news/story");
check("finds all nine paragraphs", g && g.paragraphs.filter(p => p.tag === "p").length === 9);
check("drops the byline and dateline rows", !g.paragraphs.some(p => /^By Sam|^Published/.test(p.text)));
check("drops ad markers and a trailing section heading",
  !g.paragraphs.some(p => /^Advertisement$|^Related$/.test(p.text)));

const split = page(`<title>Split</title>`, `<article><h1>Split</h1>
  <div class="block">${paras(3)}</div><figure><img src="a.jpg"><figcaption>A caption that runs long enough to look like prose to a naive extractor.</figcaption></figure>
  <div class="block">${paras(3, 4)}</div><figure><img src="b.jpg"></figure><div class="block">${paras(4, 7)}</div></article>`);
const sp = extractFromHtml(split, "https://www.bbc.co.uk/news/articles/x");
check("keeps every block of a story split around photos", sp && sp.paragraphs.length === 10);
check("captions are not body text", !sp.paragraphs.some(p => /caption/.test(p.text)));

const ldOnly = page(`<title>Walled</title>` + ld({ "@type": "NewsArticle", headline: "Walled",
  articleBody: Array.from({ length: 12 }, (_, i) => para(i + 1)).join("\n") }),
  `<article><h1>Walled</h1><p>${para(1)}</p><p>Subscribe to continue reading.</p></article>`);
const lo = extractFromHtml(ldOnly, "https://example.org/walled");
check("prefers JSON-LD articleBody when the page is cut short", lo && lo.paragraphs.length === 12);

check("rejects a page with no article", extractFromHtml(page("<title>x</title>", "<p>Short.</p>"), "https://e.com/a") === null);

console.log("\nnewswire copy:");
const wire = page(`<title>Deal | Morningstar</title>`, `<div class="mdc-article-body"><p>By A Reporter</p>
  ${paras(3)}<p>Write to A Reporter at a.reporter@wsj.com</p><p>(END) Dow Jones Newswires</p>
  <p>October 05, 2026 03:13 ET (07:13 GMT)</p><p>Copyright (c) 2026 Dow Jones &amp; Company, Inc.</p>
  <p>The articles, information, and content displayed on this webpage may include materials prepared by third parties.</p></div>`);
const w = extractFromHtml(wire, "https://www.morningstar.com/news/dow-jones/20261005773/deal", { minWords: 50 });
check("a short wire story is accepted from a licensed copy", w && w.paragraphs.length === 3);
check("the sign-off, terminator and disclaimers are cut",
  !w.paragraphs.some(p => /Write to|Dow Jones|third parties/.test(p.text)));

console.log("\nfeed content:");
const frag = extractFromFragment(paras(8), "https://www.politico.com/news/2026/10/04/x",
  { title: "Feed Story", author: "Pat Lee", date: "2026-10-04T10:00:00Z", image: "https://p.com/i.jpg" });
check("reads the article from a feed's content:encoded", frag && frag.paragraphs.length === 8);
check("with the feed item's own metadata", frag.headline === "Feed Story" && frag.author === "Pat Lee");
const rss = `<rss><channel><item><title>Feed Story</title><link>https://www.politico.com/news/2026/10/04/x</link>
  <pubDate>${new Date().toUTCString()}</pubDate><dc:creator>Pat Lee</dc:creator>
  <description>Short summary.</description><content:encoded><![CDATA[${paras(12)}]]></content:encoded></item></channel></rss>`;
const [item] = parseFeed(rss, 5);
check("the feed parser keeps full content for the article step", item._content?.includes("Paragraph 12"));
check("and the author", item._author === "Pat Lee");

console.log("\nlicensed copies:");
const at = new Date().toISOString();
const index = [
  { list: "dow-jones", id: "202610051385", url: "https://m/1", title: "Dow Jones Top Company Headlines at 5 AM ET: Shionogi to Acquire IntraBio", at },
  { list: "dow-jones", id: "20261005773", url: "https://m/2", title: "Shionogi to Acquire IntraBio for $2 Billion", at },
  { list: "dow-jones", id: "20261005990", url: "https://m/3", title: "Shionogi to Acquire IntraBio for $2 Billion — Update", at },
  { list: "marketwatch", id: "2026100537", url: "https://m/4", title: "My wife never went back to work after raising -2-", at },
  { list: "marketwatch", id: "2026100536", url: "https://m/5", title: "My wife never went back to work after raising our kids. Do I have to share my savings?", at },
];
const hit = (title, lists = ["dow-jones"]) => findInIndex({ title, pubDate: at }, index, lists)?.url;
check("matches a headline, preferring the latest update", hit("Shionogi to Acquire IntraBio for $2 Billion") === "https://m/3");
check("never matches a headlines digest", hit("Dow Jones Top Company Headlines at 5 AM ET") === undefined);
check("never matches a continuation part", hit("My wife never went back to work after raising our kids. Do I have to share my savings?", ["marketwatch"]) === "https://m/5");
check("a short headline inside a long one is not a match", hit("Shionogi Shares Rise") === undefined);
check("ignores copies from days apart",
  findInIndex({ title: "Shionogi to Acquire IntraBio for $2 Billion", pubDate: "2026-09-01T00:00:00Z" }, index, ["dow-jones"]) === null);

console.log("\nsyndicated copies must credit the original:");
const copyPage = (body) => page(`<title>Copy</title>`, `<article><h1>Copy</h1>${body}</article>`);
const judge = (orig, html, url) => {
  const art = extractFromHtml(html, url);
  return art ? credits(html, art, publisherFor(orig), url) : null;
};
check("Bloomberg's dateline credits a Yahoo copy",
  judge("https://www.bloomberg.com/news/articles/x", copyPage(`<p>(Bloomberg) -- ${para(1)}</p>${paras(6, 2)}`), "https://finance.yahoo.com/news/x.html") === true);
check("a byline crediting Bloomberg News credits a trade paper's copy",
  judge("https://www.bloomberg.com/news/articles/x", page(`<title>Copy</title>`, `<article><h1>Copy</h1><div class="field--name-field-byline"><a>Kevin Crowley</a> | Bloomberg News</div>${paras(6)}</article>`), "https://www.ttnews.com/articles/x") === true);
check("a story that only cites Bloomberg is not a copy",
  judge("https://www.bloomberg.com/news/articles/x", copyPage(`<p>According to Bloomberg, ${para(1)}</p>${paras(6, 2)}`), "https://example-news.com/x") === false);
check("WSJ's sign-off credits a Livemint copy",
  judge("https://www.wsj.com/world/x", copyPage(`${paras(6)}<p>Write to A Reporter at a.reporter@wsj.com</p>`), "https://www.livemint.com/global/x.html") === true);
check("the news service line credits an NYT copy",
  judge("https://www.nytimes.com/2026/10/05/world/x.html", copyPage(`${paras(6)}<p>This article originally appeared in The New York Times.</p>`), "https://www.seattletimes.com/x") === true);
check("an outlet's own report on the same news is not an NYT copy",
  judge("https://www.nytimes.com/2026/10/05/world/x.html", copyPage(`${paras(6)}<p>The New York Times first reported the deal.</p>`), "https://www.cbsnews.com/x") === false);

console.log("\nre-headlined copies must tell the same story:");
const chevron = { title: "Chevron Names Gustavson CFO as Oil Giant Eyes CEO Succession",
  desc: "Chevron Corp. named New Energies president Jeff Gustavson as chief financial officer, part of a major leadership reshuffle." };
const keys = storyKeys(chevron);
check("names come from the summary, the subject from both", ["Chevron", "Jeff", "Gustavson", "Energies"].every(k => keys.includes(k)));
check("title-cased headline words are not names", !keys.includes("Eyes") && !keys.includes("Giant"));
check("accented names are kept whole", storyKeys({ title: "Brazil Assets Surge", desc: "Brazilian assets rose as Flávio Bolsonaro led." }).includes("Flávio"));
const copyOf = (h, t) => ({ headline: h, paragraphs: [{ text: t }] });
check("the wire version under its own headline is the same story",
  sameStory(chevron, copyOf("Chevron taps Jeff Gustavson as finance chief", "Chevron Corp. named Jeff Gustavson, who runs its New Energies unit, chief financial officer.")));
check("another story about the same company is not",
  !sameStory(chevron, copyOf("Chevron lifts Permian output", "Chevron Corp. said Permian production rose as the oil giant ramps up drilling.")));
check("too few names to tell is never a match", !sameStory({ title: "The Existential Imperative to Borrow", desc: "More yield-insensitive issuance." }, copyOf("x", "More yield-insensitive issuance.")));

console.log("\nrouting and ids:");
check("NYT goes through the translation proxy first", siteFor("https://www.nytimes.com/x").routes[0] === "translate");
check("an unknown site is read directly", siteFor("https://blog.example.net/p").routes[0] === "direct");
check("translation proxy URL", translateUrl("https://www.nytimes.com/2026/10/05/a.html?x=1") ===
  "https://www-nytimes-com.translate.goog/2026/10/05/a.html?x=1&_x_tr_sl=auto&_x_tr_tl=en&_x_tr_hl=en&_x_tr_pto=wapp");

// The page computes the same id to find an article's file.
const script = readFileSync(new URL("../index.html", import.meta.url), "utf8").match(/<script>([\s\S]*)<\/script>/)[1];
const fn = script.slice(script.indexOf("function articleId(key) {"), script.indexOf("const PREBUILT_ARTICLE_CACHE"));
const page_ = await import("data:text/javascript;base64," + Buffer.from(fn + "\nexport { articleId };").toString("base64"));
const key = canonicalUrl("https://www.wsj.com/world/x-1a2b3c4d?mod=rss_worldnews");
check("the page and the build agree on article ids", page_.articleId(key) === articleId(key) && /^[0-9a-f]{16}$/.test(articleId(key)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
