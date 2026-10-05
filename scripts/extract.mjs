/**
 * Server-side article extraction for the build.
 *
 * The build used to depend entirely on Jina for article text, so when the
 * shared key ran out of balance every request answered 402 and the published
 * articles.json carried no text at all -- 0 of 112 resolved, every run. This
 * reads the publisher's own page instead: fetch the HTML from the runner, take
 * the body from the site's article container where it has a stable one, and
 * otherwise from Mozilla's Readability (the engine behind Firefox's reader
 * view). Jina remains as a fallback for sites that refuse the runner.
 *
 * The output is already structured -- headline, byline, date, image and a list
 * of paragraphs -- so the page renders it without re-parsing a whole web page
 * on the phone.
 */
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

export const UA = {
  browser:   "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  bingbot:   "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  // Link-preview crawlers. Publishers serve these the full server-rendered
  // page so that shared links unfurl; NYT answers Discord's with the whole
  // article while giving every other user agent the metered preview.
  discord:   "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
  facebook:  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
};

/**
 * Per-site handling, measured with research/survey.mjs from a GitHub runner --
 * the only vantage point that matters, since publishers answer a runner, a
 * laptop and a cloud VM differently.
 *
 *   routes  ways to read the site, in order (see scripts/resolve.mjs):
 *           "direct"     the runner fetches the page itself
 *           "translate"  through Google's translation proxy, which fetches from
 *                        Google's addresses rather than the runner's
 *           "jina"       through Jina Reader
 *           "syndicated" a partner's licensed copy, found by headline
 *   ua      user agents to try, in order
 *   body    the article container, where the site has a stable one; extraction
 *           is scoped to it before falling back to Readability
 *   drop    furniture inside the page to remove before extracting
 *   skip    paragraph patterns that are furniture rather than prose
 *   jinaUrls  the addresses to ask Jina for, where one URL is not enough
 *   cut     marks a page the publisher truncated for a non-subscriber; where
 *           a site has one, it alone decides whether a page is a preview
 */
export const SITES = {
  // NYT refuses every GitHub runner whatever it sends, and gives everything
  // but Discord's crawler the metered preview. Google's translation proxy
  // passes Discord's crawler through where the network allows (not from
  // GitHub); Jina does from anywhere, whenever its rolling anonymous block on
  // nytimes.com has lapsed, and always with a key.
  "nytimes.com": {
    // No syndicated copies: the ones Google News turns up are excerpts as
    // often as not (431 of 542 words, wrapped in the reposting site's own
    // furniture), and a summary is better than a mangled story.
    routes: ["translate", "direct", "jina"],
    ua: ["discord", "facebook"],
    // Through Jina: as Discord's crawler -- measured at the whole article,
    // 1,366 of 1,366 words -- then with NYT's article-sharing parameters,
    // which once did the same and now mostly return the preview.
    jinaUrls: (u) => [u, `${u}${u.includes("?") ? "&" : "?"}unlocked_article_code=1&smid=nytcore-ios-share`],
    body: 'section[name="articleBody"]',
    // Every NYT page is flagged paid in its JSON-LD, so that flag says nothing;
    // the truncated version is the one carrying the truncator.
    cut: /data-testid="optimistic-truncator/,
    drop: ['[data-testid="inline-interactive"]', '[data-testid*="photoviewer"]', '[data-testid="inline-message"]',
           '[data-testid="story-ad"]', '[data-testid="Dropzone"]', "figure", "aside", "header", "footer"],
    skip: [/^[A-Z][\w.'’ -]{2,60} (is|are) (a|an|the) .{0,120}\b(for|at) (The New York Times|The Times)\b/,
           /^[A-Z][\w.'’ -]{2,60} contributed reporting\b/, /^(Produced|Graphics|Photographs|Video) by\b/,
           /^(Read by|Narration produced by|Engineered by|Audio produced by|Original music by)\b/],
  },
  // Every other user agent times out from a runner; Bing's crawler is answered.
  "washingtonpost.com": {
    routes: ["direct", "jina"],
    ua: ["bingbot", "googlebot"],
    body: '[data-qa="article-body"], .article-body',
    drop: ['[data-qa="subscribe-promo"]', '[data-qa="article-body-ad"]', '[data-qa="interstitial-link"]', "figure", "aside"],
  },
  "theguardian.com": {
    ua: ["browser"],
    body: '#maincontent, [data-gu-name="body"]',
    drop: ["figure", "aside", '[data-spacefinder-role="inline"]', "gu-island"],
  },
  "bbc.co.uk": {
    ua: ["browser"],
    skip: [/^BBC [A-Z][a-z]+( [A-Z][a-z]+)?$/],                 // "BBC Korean": the reporting service
    drop: ['[data-component="links-block"]', '[data-component="tags"]', '[data-component="image-block"]',
           '[data-component="caption-block"]', '[data-component="ad-slot"]', "figure"],
  },
  "bbc.com": {
    ua: ["browser"],
    drop: ['[data-component="links-block"]', '[data-component="tags"]', '[data-component="image-block"]',
           '[data-component="caption-block"]', '[data-component="ad-slot"]', "figure"],
  },
  "npr.org": {
    ua: ["browser", "discord"],
    body: "#storytext",
    drop: [".bucketwrap", ".enlarge_measure", ".credit-caption", "figure", "aside", ".internallink"],
    skip: [/^\W*prefer to listen to this story\b/i, /^sign up for (alerts|the|our)\b.{0,120}npr/i],
  },
  "cnbc.com": {
    ua: ["browser", "discord"],
    body: '.ArticleBody-articleBody, [data-module="ArticleBody"]',
    drop: [".InlineVideo-container", ".RelatedContent-container", ".InlineImage-imageEmbed", "figure", "aside"],
  },
  // Politico and The Atlantic refuse the runner outright, but publish the full
  // article in their feeds, which is read before any route is tried.
  "politico.com": {
    routes: ["direct", "jina"],
    ua: ["browser", "facebook"],
    drop: [".story-enhancement", ".story-related", "figure", "aside", ".below-article-section"],
  },
  "theatlantic.com": {
    routes: ["direct", "jina"],
    ua: ["browser", "googlebot"],
    drop: ["figure", "aside", '[data-event-module="inline-newsletter"]'],
  },
  "thehill.com": {
    routes: ["direct", "translate"],
    ua: ["facebook", "browser"],
    drop: [".hardwall", "figure", "aside", ".article__related"],
  },
  // Bloomberg and the FT refuse every route; their stories are read from
  // partners that carry them under licence.
  "bloomberg.com": { routes: ["syndicated", "jina"], ua: ["browser"] },
  "ft.com": { routes: ["syndicated"], ua: ["browser"] },
  "newyorker.com": {
    ua: ["browser", "googlebot"],
    drop: ["figure", "aside", ".journey-unit", ".consumer-marketing-unit"],
  },
  // Licensed Dow Jones and MarketWatch copy. The story is clean; the page
  // wraps it in the newswire's sign-off and Morningstar's own disclaimers.
  "morningstar.com": {
    ua: ["browser"],
    body: ".mdc-article-body",
    skip: [/^write to .{3,80}\bat\b.{3,80}$/i, /^this content was created by (marketwatch|barron)/i,
           /^(-\s?[A-Z][\w.'’ -]{2,40}\s*)+$/,                      // "-Barbara Kollmeyer -Britney Nguyen"
           /^\d{2}-\d{2}-\d{2} \d{4}ET$/, /^(january|february|march|april|may|june|july|august|september|october|november|december) \d{1,2}, \d{4} \d{2}:\d{2} ET/i],
  },
  "latimes.com": {
    ua: ["browser", "googlebot"],
    body: '[data-element="story-body"], .rich-text-article-body',
    drop: ["figure", "aside", ".enhancement"],
  },
  "techcrunch.com": {
    ua: ["browser"],
    drop: ["figure", "aside", ".wp-block-techcrunch-inline-cta", ".wp-block-tc23-podcast-player"],
  },
  "engadget.com": { ua: ["googlebot", "browser"] },
  "sciencedaily.com": { ua: ["browser"], body: "#story_text" },
  "sports.yahoo.com": { ua: ["googlebot", "browser"] },
  "finance.yahoo.com": { ua: ["googlebot", "browser"] },
  "longreads.com": { ua: ["browser", "discord"] },
  "motorsport.com": { ua: ["browser", "discord"] },
};
const DEFAULT_SITE = { routes: ["direct", "jina"], ua: ["browser", "googlebot", "facebook"] };

export const titleWords = (t) => new Set(String(t || "").toLowerCase().normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "").replace(/[\u2019']/g, "").replace(/[^a-z0-9]+/g, " ")
  .split(" ").filter(w => w.length > 2));

/** Share of the shorter headline's words that the other one also has. */
export function headlineOverlap(a, b) {
  const A = titleWords(a), B = titleWords(b);
  let n = 0; A.forEach(w => B.has(w) && n++);
  return n / Math.max(1, Math.min(A.size, B.size));
}

export const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
export function siteFor(url) {
  const h = hostOf(url);
  const key = Object.keys(SITES).find(d => h === d || h.endsWith("." + d));
  return key ? { ...DEFAULT_SITE, ...SITES[key] } : DEFAULT_SITE;
}

// ── Cleanup rules ─────────────────────────────────────────────────────────

// Lines that are page furniture wherever they appear.
const JUNK = [
  /^(advertisement|skip advertisement|supported by|image|listen|share|share full article|save|gift this article|continue reading|read more|related|related content|more from .{1,40}|story continues below advertisement)$/i,
  /^·?\s*\d+:\d{2}\s*min$/i,                              // "· 6:32 min" audio length
  /^(published|updated|posted)\s*:?\s*(\d{1,2}\s*[a-z]+\s*\d{4}|\d+\s*(minutes?|hours?|days?)\s*ago)/i,
  /^listen\s*·?\s*\d+:\d{2}/i,
  /^(photo|image|photograph|credit|illustration)( credit)?\s*:/i,
  /^[Bb][Yy]\s+[A-Z][^.!?]{2,80}$/,                       // a bare byline row
  /^(updated|published)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}, \d{4}(,? \d{1,2}:\d{2}\s*[ap]\.?m\.?( [A-Z]{2,4})?)?$/i,
  /^(sign up|subscribe)\b.{0,80}(newsletter|here|today|now)\.?$/i,
  /^(we use cookies|this site uses cookies)\b/i,
  /^(follow|contact) (us|the author)\b.{0,60}$/i,
  /^(like this content|enjoy(ing|ed) this|did you enjoy)\b.{0,80}\b(sign(ing)? up|subscribe|newsletter)/i,
  /^catch all the .{0,80}\b(news|updates)\b.{0,200}$/i,             // Livemint's app pitch
  /^[Bb][Yy]\s*[A-Z][^.!?]{1,60}$/,                        // "ByJuna Moon": byline with the space lost
  /^(by|in|tags|topics|posted|filed under|in brief|view bio|sponsored|download the report)\s*:?$/i,
  /^skip to (main )?content$/i,
  /^[_\-*=~\s]{3,}$/,                                       // rules and dividers
  /^this (page|article|post|story) (may )?contains? affiliate links\b/i,
  /^(stay up[- ]to[- ]date|want the latest|to stay up[- ]to[- ]date)\b.{0,160}\b(newsletter|subscribe|sign up)\b/i,
  /^add [a-z ]{2,30} on google$/i,
  /^(the wall street journal|the new york times|bloomberg news|the associated press|associated press|reuters|afp)\.?$/i,
  /^[A-Z][\w.'’-]+( [A-Z][\w.'’-]+){0,3},$/,                    // "Telis Demos," -- a byline split over lines
  /^write to .{3,160}\bat\b\s*\S+@\S+/i,                         // a newswire's sign-off
  /^the views expressed (by|in) .{0,80}\b(are (their|the author'?s) own|do not)/i,
  /^updated on:\s/i,
  /^(•\s*)?(https?:\/\/\S+\s*)+$/,                              // a line that is only links
  /^\/[\w\-./,]+$/,                                             // a bare site path
  /^this (story|article) was originally (featured|published) on\b/i,
  /^(get the latest updates from|discover special offers)\b/i,
  /^follow (us|bbc|cnn|npr)\b.{0,200}\b(twitter|facebook|instagram|x|tiktok)\b/i,
  /^subscribe\b[^.!?]{0,120}$/i,                               // "Subscribe for the industry's biggest tech news"
  /\bsubscribe here to (receive|get)\b/i,                      // newsletter editions' own pitch
  /^(in this article|watch:\s.{0,140}|listen to [\w' ]{2,40} live at\b.*)$/i,
  // Photo credits: "Vectis Creation/Shutterstock", "Jane Doe for Engadget".
  /^[\w.'’ -]{2,50}\/(shutterstock|getty images|ap|reuters|afp|epa|alamy|bloomberg|unsplash|ap photo|afp via getty images)$/i,
  /^[A-Z][\w.'’-]+( [A-Z][\w.'’-]+){0,3} for [A-Z][\w&]+( [A-Z][\w&]+){0,2}$/,
  /^(illustration|photograph|photo|image|video|graphic)s? (by|courtesy of) [A-Z][^.!?]{1,60}$/i,
  /^[A-Z]{2,6}(\/[A-Z]{2,6})+$/,                              // wire credits: "CBS/AFP"
  /^[A-Z][a-z]+ \d{1,2}, \d{4}\s*\d{1,2}:\d{2}\s*[AP]M( [A-Z]{2,4})?$/,   // "October 4, 20268:29 AM ET"
  /^\d{1,2}:\d{2} [AP]M [A-Z]{2,4} · /,                       // "1:31 PM PDT · October 4, 2026"
];

// Everything from one of these on is after the article.
const TERMINATORS = [
  /^citation: .{10,300}\bretrieved \d{1,2} [a-z]+ \d{4}/i,      // phys.org's footer
  /^this document is subject to copyright\b/i,
  /^who'?s behind this story\??$/i,
  /^\((end|more to follow)\)\s+dow jones newswires/i,
  /^copyright \(c\) \d{4} dow jones/i,
  /^copyright\s+\d{4},\s*dow jones & company/i,
  /^the articles, information, and content displayed on this webpage/i,
  /^(copyright|©)\s*(\(c\)\s*)?(©\s*)?\d{4}\b.{0,80}all rights reserved/i,
];

const WALL = [
  "subscribe to continue reading", "this article is for subscribers", "you've used all your free articles",
  "you have reached your article limit", "to continue, please subscribe", "already a subscriber? sign in",
  "please complete the security check", "verify you are human", "enable javascript and cookies to continue",
  "are you a robot", "access to this page has been denied",
];

const clean = (s) => String(s || "").replace(/[​-‍﻿]/g, "").replace(/\s+/g, " ").trim();
const wordsIn = (s) => (s.match(/\S+/g) || []).length;

// ── Metadata ──────────────────────────────────────────────────────────────

function jsonLd(document) {
  const out = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const walk = (n) => {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) return n.forEach(walk);
        if (n["@graph"]) walk(n["@graph"]);
        const t = [].concat(n["@type"] || []).join(" ");
        if (/Article|Posting|Report|Blog/i.test(t) || n.articleBody) out.push(n);
      };
      walk(JSON.parse(s.textContent));
    } catch {}
  }
  return out[0] || null;
}

function meta(document, ...names) {
  for (const n of names) {
    const el = document.querySelector(`meta[property="${n}"], meta[name="${n}"]`);
    const v = clean(el?.getAttribute("content"));
    if (v) return v;
  }
  return "";
}

const authorName = (a) => [].concat(a || []).map(x => typeof x === "string" ? x : x?.name).filter(Boolean)
  .map(clean).filter(n => n.length < 80 && !/^https?:/.test(n)).join(", ");

const imageUrl = (img) => {
  const first = [].concat(img || [])[0];
  const u = typeof first === "string" ? first : first?.url || first?.contentUrl;
  return /^https?:\/\//.test(u || "") ? u : "";
};

// Entities left encoded in metadata ("Chinese AI &#8216;agent fleet&#8217;").
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–",
                lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”" };
const decode = (t) => String(t || "")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
  .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);

// Strip " - The New York Times", " | Reuters" and the like from a page title.
const tidyHeadline = (t) => clean(decode(decode(t))).replace(/<[^>]+>/g, "").replace(/\s+[|\-–—]\s+(the )?[A-Z][\w.&' ]{1,40}$/, "").trim();

// ── Paragraphs ────────────────────────────────────────────────────────────

const BLOCKS = "p, h2, h3, h4, blockquote, li, pre";

function blocksFrom(root, skip = []) {
  const out = [];
  const seen = new Set();
  for (const el of root.querySelectorAll(BLOCKS)) {
    // Take a quote or list item whole, not its inner paragraphs again.
    const wrap = el.parentElement?.closest?.("blockquote, li");
    if (wrap && root.contains(wrap)) continue;
    if (el.closest("figure, figcaption, nav, aside, footer, form, button, [aria-hidden='true']")) continue;
    // A list item that is mostly a link is navigation or a "related" teaser.
    const tag = el.tagName.toLowerCase();
    const text = clean(el.textContent);
    if (!text) continue;
    if (tag === "li") {
      const linkText = clean([...el.querySelectorAll("a")].map(a => a.textContent).join(" "));
      if (linkText.length > text.length * 0.6) continue;
    }
    if (TERMINATORS.some(re => re.test(text))) break;
    if (JUNK.some(re => re.test(text)) || skip.some(re => re.test(text))) continue;
    if (WALL.some(w => text.toLowerCase().includes(w)) && text.length < 300) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (/^h[2-4]$/.test(tag)) { if (text.length < 140) out.push({ tag: "h2", text }); continue; }
    if (tag === "blockquote") { out.push({ tag: "blockquote", text }); continue; }
    if (tag === "li") { out.push({ tag: "p", text: "• " + text }); continue; }
    if (text.length < 2) continue;
    // A bare name or two with no sentence around it is a photo credit or a
    // caption label ("Apple", "Getty Images"), never a paragraph of prose.
    if (text.length < 30 && /^[A-Z][\w&.'’-]*( [A-Z][\w&.'’-]*){0,2}$/.test(text) && !/[.!?:]$/.test(text)) continue;
    out.push({ tag: "p", text });
  }
  // Headings with nothing after them are section furniture ("Related", "More
  // on this story"), not the article's own subheads.
  while (out.length && out[out.length - 1].tag === "h2") out.pop();
  return out;
}

function fromArticleBody(body) {
  let paras = String(body).split(/\n+/).map(clean).filter(p => p.length > 1);
  // Some sites store the body as one unbroken block; regroup it into
  // paragraphs of about three sentences so it does not read as one wall.
  if (paras.length < 3) {
    const s = clean(body).match(/[^.!?]+[.!?]+["'”’]?(\s+|$)/g) || [clean(body)];
    paras = [];
    for (let i = 0; i < s.length; i += 3) paras.push(s.slice(i, i + 3).join("").trim());
  }
  const out = [];
  for (const text of paras) {
    if (TERMINATORS.some(re => re.test(text))) break;
    if (!JUNK.some(re => re.test(text))) out.push({ tag: "p", text });
  }
  return out;
}

/**
 * Article from a page's HTML, or null if it does not hold one.
 *
 * Returns { headline, author, date, image, paragraphs, words, partial }.
 * `partial` marks a page the publisher flags as paywalled whose visible text
 * is short enough to be the preview rather than the story.
 */
export function extractFromHtml(html, url, { minWords = 120 } = {}) {
  if (!html || html.length < 500) return null;
  const site = siteFor(url);
  const { document } = parseHTML(html);
  const ld = jsonLd(document);

  const headline = tidyHeadline(ld?.headline || meta(document, "og:title", "twitter:title") ||
    document.querySelector("h1")?.textContent || document.title || "");
  let author = (authorName(ld?.author) || meta(document, "author", "article:author", "byl")).replace(/^by\s+/i, "");
  const date = clean(ld?.datePublished || meta(document, "article:published_time", "og:article:published_time",
    "datePublished", "pubdate") || document.querySelector("time[datetime]")?.getAttribute("datetime") || "");
  const image = imageUrl(ld?.image) || meta(document, "og:image", "twitter:image");
  const description = meta(document, "og:description", "description");
  const free = ld?.isAccessibleForFree;
  const flaggedPaid = free === false || /^false$/i.test(String(free ?? ""));

  for (const sel of site.drop || []) {
    try { document.querySelectorAll(sel).forEach(el => el.remove()); } catch {}
  }

  let paragraphs = [];
  const scoped = site.body && document.querySelector(site.body);
  if (scoped) paragraphs = blocksFrom(scoped, site.skip);

  if (wordsIn(paragraphs.map(p => p.text).join(" ")) < 150) {
    // Readability mutates the document it is given, so it gets a fresh one.
    const { document: doc } = parseHTML(html);
    for (const sel of site.drop || []) {
      try { doc.querySelectorAll(sel).forEach(el => el.remove()); } catch {}
    }
    let art = null;
    try { art = new Readability(doc, { charThreshold: 300 }).parse(); } catch {}
    if (art?.content) {
      const { document: frag } = parseHTML(`<!doctype html><html><body>${art.content}</body></html>`);
      const got = blocksFrom(frag.body, site.skip);
      if (wordsIn(got.map(p => p.text).join(" ")) > wordsIn(paragraphs.map(p => p.text).join(" "))) paragraphs = got;
    }
    if (!author && art?.byline) author = clean(art.byline).replace(/^by\s+/i, "");
  }

  // Readability keeps the single best cluster of paragraphs, and some layouts
  // break a story into several -- BBC puts each run of paragraphs in its own
  // block between full-width photos, and Readability kept 230 of 700 words.
  // The page's own article container is the check on that.
  // It also drops the lead when a related-links box sits between the opening
  // paragraphs and the rest. So the container wins when it holds clearly more,
  // or when it holds everything Readability found and more besides -- within
  // reason, since a container twice the size has picked up something else.
  if (!scoped) {
    for (const el of document.querySelectorAll('[itemprop="articleBody"], article')) {
      const got = blocksFrom(el, site.skip);
      const have = wordsIn(paragraphs.map(p => p.text).join(" ")), gotWords = wordsIn(got.map(p => p.text).join(" "));
      const texts = new Set(got.map(p => p.text));
      const superset = paragraphs.length && paragraphs.filter(p => texts.has(p.text)).length >= paragraphs.length * 0.9;
      if (gotWords > have * 1.3 || (superset && gotWords > have && gotWords < have * 2)) paragraphs = got;
    }
  }

  // Search engines are given the body as JSON-LD on many sites, sometimes in
  // full where the rendered page is cut short.
  const ldBody = typeof ld?.articleBody === "string" ? fromArticleBody(ld.articleBody) : [];
  const count = (ps) => wordsIn(ps.map(p => p.text).join(" "));
  if (count(ldBody) > count(paragraphs) * 1.3 && count(ldBody) > 150) paragraphs = ldBody;

  // The headline and standfirst often open the body as well.
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  while (paragraphs.length && [headline, description].some(h => h && norm(h) === norm(paragraphs[0].text))) paragraphs.shift();

  const words = count(paragraphs);
  const substantive = paragraphs.filter(p => p.tag === "p" && p.text.length > 80).length;
  if (words < minWords || substantive < Math.min(2, paragraphs.length)) return null;
  const low = paragraphs.slice(-3).map(p => p.text).join(" ").toLowerCase();
  const walled = WALL.some(w => low.includes(w));

  // Whether this is the whole story. A publisher that states the length in
  // its JSON-LD settles it; otherwise a site's own truncation mark; otherwise
  // a paid flag on very little text.
  const stated = Number(ld?.wordCount) || (typeof ld?.articleBody === "string" ? wordsIn(clean(ld.articleBody)) : 0);
  const cut = stated > 50 ? words < stated * 0.7
    : site.cut ? site.cut.test(html)
    : flaggedPaid && words < 250;
  // Template placeholders leak through as bylines ("list.metadata.agency"),
  // and some sites put a profile URL there.
  author = clean(decode(author));
  if (/^https?:/.test(author) || /^[a-z]+(\.[a-z]+)+$/i.test(author) || author.length > 120) author = "";
  return { headline, author, date, image, paragraphs, words, partial: cut || (walled && words < 600) };
}

// ── Fetching ──────────────────────────────────────────────────────────────

// Politeness: never more than one request in flight to a host from this
// process, and a short gap between them, so a build reading thirty stories
// from one site does not arrive as a burst.
const gates = new Map();
function gate(host, gap = 400) {
  const prev = gates.get(host) || Promise.resolve();
  let release;
  const mine = new Promise(r => (release = r));
  gates.set(host, prev.then(() => mine));
  return prev.then(() => () => setTimeout(release, gap));
}

export async function fetchHtml(url, ua, timeout = 20000) {
  const done = await gate(hostOf(url));
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA[ua] || ua, Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
                 "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow", signal: AbortSignal.timeout(timeout),
    });
    // 202 is how AWS's bot control answers with a challenge instead of a page.
    if (!r.ok || r.status === 202) return { status: r.status };
    const type = r.headers.get("content-type") || "";
    if (type && !/html|xml|text/i.test(type)) return { status: 415 };
    return { status: r.status, html: await r.text(), url: r.url || url };
  } finally { done(); }
}

// Google's translation proxy fetches the page from Google's own addresses and
// passes the user agent through. Asked to translate English into English, it
// returns the page unchanged apart from rewritten links.
export function translateUrl(u) {
  const x = new URL(u);
  const host = x.hostname.replace(/-/g, "--").replace(/\./g, "-");
  const q = new URLSearchParams(x.search);
  q.set("_x_tr_sl", "auto"); q.set("_x_tr_tl", "en"); q.set("_x_tr_hl", "en"); q.set("_x_tr_pto", "wapp");
  return `https://${host}.translate.goog${x.pathname}?${q}`;
}

// A route that keeps failing for a site is given up on for the rest of the
// run: a site timing out at 20 seconds a request, one request at a time,
// would otherwise hold the build for twenty minutes finding out story by story.
const health = new Map();
const tripped = (k) => { const h = health.get(k); return h && !h.ok && h.fail >= 3; };
function record(k, ok) {
  const h = health.get(k) || { ok: 0, fail: 0 };
  ok ? h.ok++ : h.fail++;
  health.set(k, h);
}

const better = (a, b) => !b || (b.partial && !a.partial) || (a.partial === b.partial && a.words > b.words);

/**
 * The article at `url`, trying the site's user agents in turn and keeping the
 * fullest result; stops once one is clearly whole. `via` "translate" sends the
 * same requests through Google's proxy.
 */
export async function readPage(url, { via = "direct", log } = {}) {
  let best = null;
  const tried = [];
  for (const ua of siteFor(url).ua) {
    const k = `${hostOf(url)}|${via}|${ua}`;
    if (tripped(k)) { tried.push(`${ua}:skipped`); continue; }
    try {
      const target = via === "translate" ? translateUrl(url) : url;
      const got = await fetchHtml(target, ua, via === "translate" ? 30000 : 20000);
      if (!got.html) { tried.push(`${ua}:${got.status}`); record(k, false); continue; }
      const art = extractFromHtml(got.html, url);
      record(k, !!art);
      tried.push(`${ua}:${art ? art.words + "w" + (art.partial ? "(partial)" : "") : "none"}`);
      if (art && better(art, best)) best = art;
      if (best && !best.partial && best.words >= 300) break;
    } catch (e) {
      record(k, false);
      tried.push(`${ua}:${e.name === "TimeoutError" ? "timeout" : "err"}`);
    }
  }
  log?.(`${via} ${tried.join(" ")}`);
  return best;
}
export const readDirect = (url, opts) => readPage(url, { ...opts, via: "direct" });

/**
 * An article from HTML the publisher supplied some other way -- a feed's
 * content:encoded -- with the item's own metadata, since a fragment has none.
 */
export function extractFromFragment(fragment, url, { title = "", author = "", date = "", image = "" } = {}) {
  const art = extractFromHtml(`<!doctype html><html><head><title>${title.replace(/</g, "&lt;")}</title></head>` +
    `<body><article>${fragment}</article></body></html>`, url, { minWords: 150 });
  if (!art) return null;
  return { ...art, headline: title || art.headline, author: author || art.author, date: date || art.date, image: image || art.image };
}
