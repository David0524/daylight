# Daylight fetch worker

> **Optional.** The feed is now built by a scheduled GitHub Action
> (`.github/workflows/build-feed.yml`), which needs no account and no deploy.
> This worker predates that and is no longer required for the feed. It is still
> useful for the reader, which fetches arbitrary pasted URLs live, and as a
> fallback when the published feed is unavailable. Paste its URL under the ⋯
> tab in the app.

Server-side fetching for the Daylight reader. The app is a static page, so
without this worker every request it makes depends on a public CORS proxy and
an unauthenticated rate limit. Both were failing, which is what broke article
pulls and made the reader display Cloudflare captcha pages as article text.

## Deploy

```sh
cd worker
npm install
npx wrangler login
npx wrangler secret put JINA_API_KEY   # paste the jina_... key when prompted
npx wrangler deploy
```

Deploy prints a URL like `https://daylight-worker.<subdomain>.workers.dev`.
Put that in `index.html` as `WORKER_BASE`.

Then lock the worker to your site so it is not a public open proxy:

```sh
npx wrangler deploy --var ALLOWED_ORIGINS:"https://david0524.github.io"
```

## Routes

| Route | Purpose |
|---|---|
| `GET /health` | Liveness; reports whether the Jina key is configured |
| `GET /rss?url=` | Raw feed XML with CORS headers |
| `GET /json?url=` | JSON passthrough (Reddit, HN, markets) |
| `GET /article?url=` | Extraction ladder → `{ok, type, text, method, tried}` |
| `GET /meta?url=` | `og:title` / `og:image` for feed cards |

## Why the ladder looks like this

Tried in order, first result that survives `rejectReason()` wins:

1. **googlebot** (paywalled sites first) — publishers allow Googlebot through
   soft paywalls deliberately, since that is how they get indexed.
2. **jina** — renders in a real browser. Needs the API key; anonymous Jina is
   now rate-limited hard enough to return captcha stubs on HTTP 200.
3. **wayback** — CDX index, not the availability API, which rate-limits.
4. **direct / amp** — cheap when they work; datacenter IPs get 403'd often.

Deliberately excluded:

- **Google cache** — removed by Google in 2024. The old client still called it
  and got a 91KB Google Search page back, which it parsed as article text.
- **archive.ph** — behind a Cloudflare challenge no server-side fetch passes.
  It was the direct source of the captcha pages appearing in the reader.

## The 810-byte bug

The old client guarded fetched text with `if (text.length < 800) throw`. The
archive.ph Cloudflare captcha page is **810 bytes**, so it passed by ten bytes
and was rendered to the reader as the article body.

`rejectReason()` replaces that with content inspection: known challenge and
paywall strings, a higher length floor, and a count of actual prose blocks so a
long-but-empty nav dump is still rejected. `test/reject.test.mjs` runs it
against the real captured captcha response.

```sh
npm test
```
