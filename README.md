# Daylight

A single-page news reader. `index.html` is the whole app — no build step, no
framework, served straight from GitHub Pages.

## How it gets its articles

A browser cannot fetch most news feeds. Publishers do not send CORS headers, so
the page is refused, and the public CORS proxies that used to paper over this
have become unreliable: measured from a real browser origin against the NYT,
WaPo and WSJ feeds, every one of them timed out, returned 401, or failed
outright — **one usable response in eighteen attempts**.

So the fetching happens on GitHub's servers instead:

```
.github/workflows/build-feed.yml     every 30 minutes
        │
        ├── scripts/build-feed.mjs   fetch → parse → rank → dedupe
        │        reads sources.json
        │
        └── force-pushes feed.json + articles.json to the `data` branch
                 │
                 └── index.html reads it at load
```

GitHub's runners have an ordinary TLS stack and unblocked addresses, so the
papers answer normally. The page reads plain JSON, which sidesteps CORS
entirely, needs no third-party service, and renders in ~200ms instead of
spending ~30 seconds fetching.

The same build also publishes the market quotes and resolves `og:image` for
items whose feed carries no picture — both are cross-origin fetches a browser
cannot make, which is why the tiles used to read "—" and the cards were grey.

The `data` branch is force-pushed to a single commit each run, so the
repository never accumulates history from half-hourly builds.

**Nothing to set up.** The repo is public, so Actions minutes are free, and the
workflow runs on its own schedule.

### Optional: prefetched article text

Set a `JINA_API_KEY` repository secret (Settings → Secrets and variables →
Actions; free key at <https://jina.ai/reader>) and the build also resolves the
text of the top stories ahead of time. Tapping one then opens instantly, and
paywalled pieces are already resolved. The key stays in Actions and is never
served to the browser.

Without it the reader falls back to fetching in the browser, which works for
open sites and is hit-or-miss on paywalled ones.

## Fallbacks

The page degrades in order:

1. **Published feed** (`data` branch) — the normal path.
2. **Live fetching** — used if the published feed is missing or over 6 hours
   stale. Works for the feeds that allow browser access; the major papers will
   be thin or absent.
3. **Fetch service** — an optional Cloudflare Worker (`worker/`) whose URL can
   be pasted under the ⋯ tab. Predates the Actions build and is no longer
   needed for the feed, but it still helps the reader with arbitrary pasted
   URLs. See `worker/README.md`.

## Working on it

```sh
npm install

npm test                 # ranking + wall-detection unit tests
npm run audit:feeds      # which feeds are reachable, and which have gone stale
node scripts/build-feed.mjs dist     # build the feed locally

npm run serve            # serve index.html against a local worker on :8080
npm run e2e              # drive it in Chromium and report what rendered
```

### Known gaps

- **AP and Reuters** have no feed that answers anywhere any more. AP's
  feedburner mirror returns nothing and `apnews.com` 403s; Reuters' feed host
  is gone. Publications with no items get no tab, so they are simply absent.
- **Substack refuses GitHub's runner IP ranges**, so `*.substack.com` feeds come
  back empty from the build even though they work locally. The Ideas category
  uses the publications' own domains instead.

`npm run audit:feeds` is worth running occasionally. Feed URLs rot quietly, and
the failure is invisible — a category just thins out. It reports both dead feeds
and *abandoned* ones, which is the nastier case: WSJ's `feeds.a.dj.com`
endpoints answer 200 with a full payload whose newest item is from January 2025.

## Layout

| Path | |
|---|---|
| `index.html` | the entire app |
| `sources.json` | every feed URL, shared by the builder and the page |
| `scripts/build-feed.mjs` | the build that runs in Actions |
| `.github/workflows/build-feed.yml` | schedule and publishing |
| `worker/` | optional Cloudflare Worker fallback |
| `test/` | unit tests, feed audit, local server, browser E2E |
