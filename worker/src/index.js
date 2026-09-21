/**
 * Daylight fetch worker.
 *
 * The app is a static page, so every network call it makes is subject to CORS
 * and to whatever rate limit the upstream service feels like applying that
 * week. Routing those calls through this worker gives us one place that:
 *
 *   - adds CORS headers we control (no more third-party proxy roulette),
 *   - sends real browser headers, so fewer upstreams serve us a bot wall,
 *   - holds the Jina API key as a secret instead of publishing it in the
 *     page source,
 *   - caches responses at the edge, which is what actually keeps us under
 *     the free-tier limits that were being blown before.
 *
 * Routes:
 *   GET /health          — liveness + which secrets are configured
 *   GET /rss?url=        — raw feed XML (client parses it with DOMParser)
 *   GET /json?url=       — JSON passthrough (Reddit, HN, market data)
 *   GET /article?url=    — runs the extraction ladder, returns {type,text,method}
 *   GET /meta?url=       — just og:title / og:image, for feed card enrichment
 */

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept":
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif," +
    "image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
};

// Googlebot gets waved past a lot of soft paywalls that block normal clients.
// Publishers allow this deliberately (it is how their articles get indexed).
const GOOGLEBOT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "From": "googlebot(at)googlebot.com",
};

const CACHE_TTL = {
  rss: 300,      // 5 min — feeds do not move faster than this
  json: 180,
  article: 3600, // an article's text does not change; cache it hard
  meta: 86400,
};

// ── Guards ───────────────────────────────────────────────────────────────────

// Without this the worker is an open proxy that anyone can point at internal
// addresses or at whatever they want to launder traffic through.
const BLOCKED_HOSTS =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[?::1\]?|172\.(1[6-9]|2\d|3[01])\.)/i;

function validateTarget(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { error: "malformed url" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    return { error: "protocol not allowed" };
  if (BLOCKED_HOSTS.test(u.hostname)) return { error: "host not allowed" };
  // Return the caller's original string, not u.toString(). URL normalisation
  // percent-encodes characters some upstreams insist on seeing literally --
  // stooq 404s when "^dji" arrives as "%5Edji" -- so validate the URL but
  // fetch exactly what was asked for.
  return { url: raw };
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // No allowlist configured => permissive, so the worker is usable the moment
  // it is deployed. Set ALLOWED_ORIGINS in production to lock it down.
  const allow =
    !allowed.length || allowed.includes(origin) ? origin || "*" : allowed[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function reply(body, request, env, { status = 200, type = "application/json", ttl = 0 } = {}) {
  return new Response(body, {
    status,
    headers: {
      ...corsHeaders(request, env),
      "Content-Type": type,
      "Cache-Control": ttl ? `public, max-age=${ttl}` : "no-store",
    },
  });
}

function fail(request, env, message, status = 502) {
  return reply(JSON.stringify({ ok: false, error: message }), request, env, { status });
}

async function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`${label} timed out`)), ms)
    ),
  ]);
}

// ── Challenge / paywall detection ────────────────────────────────────────────
//
// This is the bug that made the app render Cloudflare captcha pages as though
// they were articles. The old client-side check was `if (text.length < 800)
// throw` — and the archive.ph captcha page is 810 bytes, so it sailed through
// and got rendered to the reader. Length alone is not a usable signal; we have
// to look at what the text actually says.

const CHALLENGE_SIGNALS = [
  // Cloudflare interstitials (archive.ph, and anything else behind CF)
  "please complete the security check",
  "complete the security check to access",
  "one more step",
  "why do i have to complete a captcha",
  "completing the captcha proves you are a human",
  "checking if the site connection is secure",
  "enable javascript and cookies to continue",
  "please make sure your browser supports javascript and cookies",
  "please enable js and disable any ad blocker",
  "ray id:",
  "cf-browser-verification",
  "attention required! | cloudflare",
  // Jina emits this as a plain-text Warning: line on a 200 response
  "this page maybe requiring captcha",
  "page maybe not yet fully loaded",
  // Generic bot walls
  "are you a robot",
  "unusual traffic from your computer network",
  "verify you are human",
  "access denied",
  "request blocked",
];

const PAYWALL_SIGNALS = [
  "subscribe to continue reading",
  "subscribe to read the full",
  "this article is for subscribers",
  "you've used all your free articles",
  "you have reached your article limit",
  "to continue, please subscribe",
  "already a subscriber? sign in",
  "this content is available to subscribers",
];

/**
 * Decide whether fetched text is a real article or a wall.
 * Returns null when usable, or a string reason when it is not.
 */
export function rejectReason(text, { minLength = 1200, minParagraphs = 3 } = {}) {
  if (!text) return "empty";
  const lower = text.toLowerCase();

  for (const s of CHALLENGE_SIGNALS) if (lower.includes(s)) return `challenge: ${s}`;
  for (const s of PAYWALL_SIGNALS) if (lower.includes(s)) return `paywall: ${s}`;

  // Note: we deliberately do NOT reject on the mere presence of a Jina
  // "Warning:" line. Jina emits benign ones (e.g. "This is a cached snapshot
  // of the original page") on perfectly good content, and treating any
  // warning as fatal threw away real articles. The specific fatal warnings
  // are listed in CHALLENGE_SIGNALS above.

  if (text.length < minLength) return `too short (${text.length})`;

  // A real article has multiple prose blocks. A wall is one or two lines of
  // boilerplate, which is how a long-but-empty nav dump gets caught here.
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 120 && !p.startsWith("!") && !p.startsWith("["));
  if (paragraphs.length < minParagraphs)
    return `only ${paragraphs.length} prose blocks`;

  return null;
}

// ── Fetch strategies ─────────────────────────────────────────────────────────

async function viaJina(target, env, { headers = {}, minLength } = {}) {
  if (!env.JINA_API_KEY) throw new Error("no jina key configured");
  // The target must be encoded. Un-encoded nesting made Jina collapse the
  // "https://" in the inner URL down to "https:/", so archive.ph and friends
  // were being handed a malformed URL and returned their error page.
  const r = await withTimeout(
    fetch(`https://r.jina.ai/${encodeURIComponent(target)}`, {
      headers: {
        Authorization: `Bearer ${env.JINA_API_KEY}`,
        Accept: "text/plain",
        "X-Return-Format": "markdown",
        "X-Timeout": "20",
        ...headers,
      },
    }),
    25000,
    "jina"
  );
  if (!r.ok) throw new Error(`jina http ${r.status}`);
  const text = await r.text();
  const bad = rejectReason(text, { minLength });
  if (bad) throw new Error(bad);
  return { type: "markdown", text };
}

async function viaDirect(target, headers, label) {
  const r = await withTimeout(fetch(target, { headers, redirect: "follow" }), 8000, label);
  if (!r.ok) throw new Error(`${label} http ${r.status}`);
  const text = await r.text();
  const bad = rejectReason(text, { minLength: 2000, minParagraphs: 0 });
  if (bad) throw new Error(bad);
  return { type: "html", text };
}

async function viaWayback(target, env) {
  // Ask the CDX index for a recent 200-status snapshot. The availability API
  // rate-limits aggressively; CDX holds up better.
  const year = new Date().getFullYear();
  const cdxUrl =
    `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(target)}` +
    `&output=json&limit=3&fl=timestamp&filter=statuscode:200&from=${year - 2}` +
    `&to=${year}&fastLatest=true`;

  let stamp = null;
  try {
    const rows = await withTimeout(
      fetch(cdxUrl, { headers: BROWSER_HEADERS }).then((r) => r.json()),
      12000,
      "wayback cdx"
    );
    stamp = rows?.[1]?.[0] || null;
  } catch {}

  if (!stamp) throw new Error("no wayback snapshot");
  // The id_ suffix returns the original bytes without the archive's toolbar.
  const snap = `https://web.archive.org/web/${stamp}id_/${target}`;
  return viaDirect(snap, BROWSER_HEADERS, "wayback");
}

/**
 * Ordered extraction ladder. Each rung is tried in turn and the first one that
 * survives rejectReason() wins.
 *
 * Deliberately NOT included:
 *   - Google cache: Google removed it in 2024. The old code still called it and
 *     got a 91KB Google Search page back, which then got parsed as article text.
 *   - archive.ph: it sits behind a Cloudflare challenge that no server-side
 *     fetch gets past. It is the direct source of the captcha pages the reader
 *     was displaying. Wayback fills the same role and actually answers.
 */
function ladderFor(host) {
  const googlebotFirst = [
    "googlebot", "jina", "jina-googlebot", "wayback", "amp", "direct",
  ];
  const openSite = ["direct", "jina", "googlebot", "wayback"];

  // Hard paywalls: a plain fetch only ever returns the wall, so skip it.
  const hardPaywall = /(\.|^)(wsj|barrons|ft|economist|nytimes|bloomberg|theathletic|newyorker|theatlantic|washingtonpost|latimes|thetimes\.co)\.(com|uk)$/i;
  if (hardPaywall.test(host)) return googlebotFirst;
  return openSite;
}

async function runLadder(target, env) {
  const host = new URL(target).hostname.replace(/^www\./, "");
  const tried = [];

  for (const rung of ladderFor(host)) {
    try {
      let out;
      switch (rung) {
        case "direct":
          out = await viaDirect(target, BROWSER_HEADERS, "direct");
          break;
        case "googlebot":
          out = await viaDirect(target, GOOGLEBOT_HEADERS, "googlebot");
          break;
        case "jina":
          out = await viaJina(target, env);
          break;
        case "jina-googlebot":
          out = await viaJina(target, env, {
            headers: { "X-Set-User-Agent": GOOGLEBOT_HEADERS["User-Agent"] },
          });
          break;
        case "wayback":
          out = await viaWayback(target, env);
          break;
        case "amp": {
          const u = new URL(target);
          const amp = `${u.origin}${u.pathname.replace(/\/$/, "")}/amp${u.search}`;
          out = await viaDirect(amp, BROWSER_HEADERS, "amp");
          break;
        }
        default:
          continue;
      }
      return { ok: true, ...out, method: rung, tried };
    } catch (e) {
      tried.push({ method: rung, error: String(e.message || e).slice(0, 160) });
    }
  }
  return { ok: false, error: "all methods failed", tried };
}

// ── og: metadata ─────────────────────────────────────────────────────────────

function extractMeta(html) {
  const grab = (prop) => {
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, "i"),
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m) return m[1];
    }
    return "";
  };
  const decode = (s) =>
    s
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
      .trim();

  const title =
    decode(grab("og:title") || grab("twitter:title")) ||
    decode(html.match(/<title[^>]*>([^<]{5,300})<\/title>/i)?.[1] || "");
  const image = decode(grab("og:image") || grab("twitter:image"));
  const published = decode(grab("article:published_time") || grab("og:published_time"));
  return {
    title: title.slice(0, 300),
    image: image.startsWith("http") ? image : "",
    published,
  };
}

// ── Router ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    if (request.method !== "GET")
      return fail(request, env, "method not allowed", 405);

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health" || path === "/") {
      return reply(
        JSON.stringify({
          ok: true,
          service: "daylight-worker",
          jinaKey: Boolean(env.JINA_API_KEY),
          originLock: Boolean(env.ALLOWED_ORIGINS),
          time: new Date().toISOString(),
        }),
        request,
        env
      );
    }

    const raw = url.searchParams.get("url");
    if (!raw) return fail(request, env, "missing url parameter", 400);
    const { url: target, error } = validateTarget(raw);
    if (error) return fail(request, env, error, 400);

    // Edge cache. This is what keeps us inside the upstream free tiers — the
    // previous design re-fetched everything on every page load from every
    // visitor, which is how the RSS quota got burned through.
    const cache = caches.default;
    const cacheKey = new Request(`${url.origin}${path}?url=${encodeURIComponent(target)}`);
    const hit = await cache.match(cacheKey);
    if (hit) {
      const h = new Headers(hit.headers);
      Object.entries(corsHeaders(request, env)).forEach(([k, v]) => h.set(k, v));
      h.set("X-Daylight-Cache", "hit");
      return new Response(hit.body, { status: hit.status, headers: h });
    }

    let response;
    try {
      if (path === "/rss") {
        const r = await withTimeout(
          fetch(target, { headers: { ...BROWSER_HEADERS, Accept: "application/rss+xml, application/xml, text/xml, */*" } }),
          15000, "rss"
        );
        if (!r.ok) return fail(request, env, `upstream ${r.status}`);
        const text = await r.text();
        if (!text.includes("<item") && !text.includes("<entry"))
          return fail(request, env, "not a feed");
        response = reply(text, request, env, { type: "application/xml; charset=utf-8", ttl: CACHE_TTL.rss });

      } else if (path === "/json") {
        const r = await withTimeout(
          fetch(target, { headers: { ...BROWSER_HEADERS, Accept: "application/json" } }),
          15000, "json"
        );
        if (!r.ok) return fail(request, env, `upstream ${r.status}`);
        response = reply(await r.text(), request, env, { ttl: CACHE_TTL.json });

      } else if (path === "/article") {
        const result = await runLadder(target, env);
        if (!result.ok) return reply(JSON.stringify(result), request, env, { status: 502 });
        response = reply(JSON.stringify(result), request, env, { ttl: CACHE_TTL.article });

      } else if (path === "/meta") {
        let meta = null;
        try {
          const r = await withTimeout(fetch(target, { headers: BROWSER_HEADERS }), 10000, "meta");
          if (r.ok) {
            // Metadata lives in <head>; reading the whole body wastes CPU.
            meta = extractMeta((await r.text()).slice(0, 200000));
          }
        } catch {}
        // Publishers 403 datacenter IPs routinely, which is why feed cards were
        // showing up with neither a title nor an image. Jina renders in a real
        // browser, so it gets through where a plain fetch does not.
        if ((!meta || !meta.title) && env.JINA_API_KEY) {
          try {
            const { text } = await viaJina(target, env, { minLength: 1 });
            const title = text.match(/^Title:\s*(.+)$/m)?.[1]?.trim() || "";
            const image = text.match(/^!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/m)?.[1] || "";
            meta = { title: title.slice(0, 300), image, published: "" };
          } catch {}
        }
        if (!meta) return fail(request, env, "meta unavailable");
        response = reply(JSON.stringify({ ok: true, ...meta }), request, env, { ttl: CACHE_TTL.meta });

      } else {
        return fail(request, env, "unknown route", 404);
      }
    } catch (e) {
      return fail(request, env, String(e.message || e).slice(0, 200));
    }

    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};
