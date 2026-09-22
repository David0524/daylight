/**
 * Paywall/extraction strategy harness.
 *
 * Each strategy takes an article URL and returns raw text (HTML or markdown)
 * or null. scoreText() then reports how much genuine article prose came back,
 * so strategies are compared on what a reader would actually get rather than
 * on response size — nav chrome is bulky and would otherwise win.
 *
 *   node research/strategies.mjs <url> [strategy ...]
 */
const KEY = process.env.JINA_API_KEY || "";

export const UA = {
  browser:  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  googlebot:"Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  bingbot:  "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  fb:       "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  twitter:  "Twitterbot/1.0",
  slack:    "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  iphone:   "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  gnews:    "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
};

export const t = (p, ms, label="timeout") =>
  Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(label)), ms))]);

// ── Scoring ─────────────────────────────────────────────────────────────────

const WALLS = [
  "please complete the security check","one more step","requiring captcha","ray id:",
  "checking if the site connection is secure","attention required","access denied",
  "subscribe to continue reading","subscribe to read","this article is for subscribers",
  "already a subscriber","you've used all your free articles","to continue, please subscribe",
  "enable javascript and cookies","unusual traffic",
];

/** Approximate the readable article: prose blocks, ignoring nav/lists/links. */
export function scoreText(text) {
  if (!text) return { words: 0, blocks: 0, wall: null };
  let body = text;
  // For HTML, strip tags first but keep block boundaries.
  if (/<\/?(html|body|div|p|script)\b/i.test(body.slice(0, 4000))) {
    body = body
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<\/(p|div|h[1-6]|li|br)>/gi, "\n\n")
      .replace(/<[^>]+>/g, " ");
  }
  const low = text.toLowerCase();
  const wall = WALLS.find(w => low.includes(w)) || null;
  const blocks = body.split(/\n\s*\n/)
    .map(b => b.replace(/\s+/g, " ").trim())
    .filter(b => b.length > 140 && !/^[*\-#[!]/.test(b) && (b.match(/\]\(/g)||[]).length <= 1);
  return { words: blocks.join(" ").split(/\s+/).filter(Boolean).length, blocks: blocks.length, wall };
}

// ── Primitive fetchers ──────────────────────────────────────────────────────

export async function raw(url, { ua = UA.browser, referer, ms = 20000, extra = {} } = {}) {
  const r = await t(fetch(url, {
    headers: { "User-Agent": ua, Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
               "Accept-Language": "en-US,en;q=0.9",
               ...(referer ? { Referer: referer } : {}), ...extra },
    redirect: "follow",
  }), ms, "raw timeout");
  if (!r.ok) throw new Error(`http ${r.status}`);
  return await r.text();
}

export async function jina(url, { fmt = "markdown", extra = {}, ms = 45000 } = {}) {
  const r = await t(fetch(`https://r.jina.ai/${encodeURIComponent(url)}`, {
    headers: { Accept: "text/plain", "X-Return-Format": fmt, "X-Timeout": "25",
               ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}), ...extra },
  }), ms, "jina timeout");
  if (!r.ok) throw new Error(`jina http ${r.status}`);
  return await r.text();
}

/** Pull JSON-LD articleBody out of raw HTML — often full text even when the
 *  rendered page shows a wall, because publishers feed it to search engines. */
export function jsonLdBody(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (n) => {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) return n.forEach(walk);
        if (typeof n.articleBody === "string" && n.articleBody.length > 200) out.push(n.articleBody);
        Object.values(n).forEach(walk);
      };
      walk(JSON.parse(m[1].trim()));
    } catch {}
  }
  // Some sites emit it as a bare key in inline state rather than valid JSON-LD.
  if (!out.length) {
    const m = html.match(/"articleBody"\s*:\s*"((?:[^"\\]|\\.){400,}?)"/);
    if (m) { try { out.push(JSON.parse(`"${m[1]}"`)); } catch { out.push(m[1]); } }
  }
  return out.length ? out.sort((a,b)=>b.length-a.length)[0].replace(/\\n/g, "\n\n") : null;
}

// ── Strategies ──────────────────────────────────────────────────────────────
//
// Scope note: these are archives, publisher-provided access paths (crawler
// allowances, AMP, article-sharing params, feeds) and syndicated copies. No
// credential use, no auth bypass.

const ampCandidates = (u) => {
  const x = new URL(u);
  const p = x.pathname.replace(/\/$/, "");
  return [
    `${x.origin}${p}?outputType=amp`,
    `${x.origin}${p}/amp`,
    `${x.origin}/amp${p}`,
    `${x.origin}${p}?amp=1`,
    `${x.origin}${p}.amp`,
  ];
};

export const STRATEGIES = {
  // --- direct, various user agents -----------------------------------------
  "direct":            (u) => raw(u),
  "googlebot":         (u) => raw(u, { ua: UA.googlebot, referer: "https://www.google.com/" }),
  "bingbot":           (u) => raw(u, { ua: UA.bingbot }),
  "facebookbot":       (u) => raw(u, { ua: UA.fb }),
  "twitterbot":        (u) => raw(u, { ua: UA.twitter }),
  "slackbot":          (u) => raw(u, { ua: UA.slack }),
  "googlebot-mobile":  (u) => raw(u, { ua: UA.gnews, referer: "https://news.google.com/" }),
  "iphone+google-ref": (u) => raw(u, { ua: UA.iphone, referer: "https://www.google.com/" }),

  // --- JSON-LD articleBody from whatever HTML we can get -------------------
  "jsonld-direct":     async (u) => jsonLdBody(await raw(u)),
  "jsonld-googlebot":  async (u) => jsonLdBody(await raw(u, { ua: UA.googlebot, referer: "https://www.google.com/" })),
  "jsonld-bingbot":    async (u) => jsonLdBody(await raw(u, { ua: UA.bingbot })),
  "jsonld-jina-html":  async (u) => jsonLdBody(await jina(u, { fmt: "html" })),

  // --- AMP (publishers serve AMP unwalled far more often than canonical) ---
  "amp": async (u) => {
    let last;
    for (const a of ampCandidates(u)) {
      try {
        const h = await raw(a, { ua: UA.googlebot, referer: "https://www.google.com/", ms: 12000 });
        if (scoreText(h).words > 120) return h;
        last = h;
      } catch (e) { last = null; }
    }
    return last;
  },
  "amp-jsonld": async (u) => {
    for (const a of ampCandidates(u)) {
      try {
        const b = jsonLdBody(await raw(a, { ua: UA.googlebot, ms: 12000 }));
        if (b) return b;
      } catch {}
    }
    return null;
  },

  // --- Jina variants --------------------------------------------------------
  "jina":              (u) => jina(u),
  "jina-googlebot":    (u) => jina(u, { extra: { "X-Set-User-Agent": UA.googlebot } }),
  "jina-google-ref":   (u) => jina(u, { extra: { "X-Referer": "https://www.google.com/" } }),
  "jina-browser":      (u) => jina(u, { extra: { "X-Engine": "browser" } }),
  "jina-html":         (u) => jina(u, { fmt: "html" }),
  "jina-share-params": async (u) => {
    const sep = u.includes("?") ? "&" : "?";
    const vs = [
      `${u}${sep}unlocked_article_code=1&smid=nytcore-ios-share`,
      `${u}${sep}unlocked_article_code=1&smid=url-share`,
      `${u}${sep}smid=nytcore-ios-share`,
      `${u}${sep}shareToken=1`,
      `${u}${sep}st=1&reflink=share_mobilewebshare`,
    ];
    let best = null;
    for (const v of vs) {
      try {
        const txt = await jina(v, { extra: { "X-Referer": "https://www.google.com/" }, ms: 30000 });
        const s = scoreText(txt);
        if (!s.wall && (!best || s.words > scoreText(best).words)) best = txt;
      } catch {}
    }
    return best;
  },

  // --- Archives -------------------------------------------------------------
  "wayback": async (u) => {
    const year = new Date().getFullYear();
    const cdx = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(u)}&output=json&limit=5&fl=timestamp&filter=statuscode:200&from=${year-1}&fastLatest=true`;
    let stamps = [];
    try { stamps = (await t(fetch(cdx).then(r=>r.json()), 20000, "cdx")).slice(1).map(r=>r[0]); } catch {}
    if (!stamps.length) {
      try {
        const av = await t(fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(u)}`).then(r=>r.json()), 20000, "avail");
        const c = av?.archived_snapshots?.closest?.timestamp;
        if (c) stamps = [c];
      } catch {}
    }
    for (const ts of stamps) {
      // id_ returns the original bytes with no archive toolbar injected.
      try { return await raw(`https://web.archive.org/web/${ts}id_/${u}`, { ms: 25000 }); } catch {}
    }
    return null;
  },
  "wayback-save": async (u) => {
    try { await t(fetch(`https://web.archive.org/save/${u}`, { headers: { "User-Agent": UA.browser } }), 75000, "spn"); } catch {}
    await new Promise(r => setTimeout(r, 4000));
    return STRATEGIES["wayback"](u);
  },
  "archive-today": async (u) => {
    for (const host of ["archive.ph","archive.is","archive.li","archive.md","archive.vn","archive.today"]) {
      try {
        const h = await raw(`https://${host}/newest/${u}`, { ms: 20000 });
        if (scoreText(h).words > 150) return h;
      } catch {}
    }
    return null;
  },
  "archive-today-jina": async (u) => {
    for (const host of ["archive.ph","archive.is","archive.md"]) {
      try {
        const txt = await jina(`https://${host}/newest/${u}`, { ms: 40000 });
        if (!scoreText(txt).wall && scoreText(txt).words > 150) return txt;
      } catch {}
    }
    return null;
  },

  // --- Third-party readers --------------------------------------------------
  "txtify":     (u) => raw(`https://txtify.it/${u}`, { ms: 25000 }),
  "urltotext":  (u) => raw(`https://urltotext.com/api/v1/urltotext/?url=${encodeURIComponent(u)}`, { ms: 20000 }),
  "allorigins-googlebot": async (u) =>
    (await t(fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(u)}`).then(r=>r.json()), 25000, "ao"))?.contents || null,
};

// ── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.argv[2];
  const want = process.argv.slice(3);
  const names = want.length ? want : Object.keys(STRATEGIES);
  console.log(`\n${url}\n`);
  for (const n of names) {
    const t0 = Date.now();
    let line;
    try {
      const txt = await STRATEGIES[n](url);
      const s = scoreText(txt);
      line = txt == null ? "null"
           : s.wall ? `WALL(${s.wall.slice(0,22)}) ${s.words}w`
           : `${String(s.words).padStart(5)}w / ${String(s.blocks).padStart(3)} blocks`;
    } catch (e) { line = `err: ${String(e.message||e).slice(0,38)}`; }
    console.log(`  ${n.padEnd(24)} ${String(Date.now()-t0).padStart(6)}ms  ${line}`);
  }
}
