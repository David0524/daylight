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
        ├── scripts/build-feed.mjs   fetch → parse → rank → dedupe → read articles
        │        reads sources.json
        │
        └── force-pushes feed.json + a/<id>.json to the `data` branch
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

### Article text

The same build reads every story in the feed, so tapping one opens at once —
one small file (`a/<id>.json` on the `data` branch) rather than a fetch through
a reader service from the phone. **No key is needed.** Each outlet is read the
way that actually works from a GitHub runner, measured with
`research/survey.mjs` (see `scripts/extract.mjs` for the per-site table):

| Route | Used for |
|---|---|
| The publisher's own page, parsed with Readability | most sites; WaPo answers Bing's crawler, The Hill Facebook's |
| The publisher's feed (`content:encoded`) | Politico, The Atlantic, Fortune, Tech Review, Substack-style newsletters |
| Licensed copies (Morningstar, Kanebridge, Livemint) | WSJ, MarketWatch, Barron's |
| Jina Reader, as Discord's link crawler | NYT (see Known gaps) |
| A partner's syndicated copy, found through Google News and credit-checked | Bloomberg, FT |
| Jina Reader | last resort for anything else |

The Deep tab's long reads (listed in `sources.json` under `deep`) are read the
same way, once, and kept for good. A few are walled now but were free when
published; for those the build reads the Internet Archive's capture from before
the wall went up, and the reader labels it as an archived copy.

Text is carried forward between builds while its story is live, so anything
read once stays readable. A story nothing could read is recorded as a miss and
retried a few hours later; the page shows its summary at once, with a live
retry and an archived-copy link, instead of half a minute of failed fetches.

`JINA_API_KEY` (Settings → Secrets and variables → Actions; free key at
<https://jina.ai/reader>) is optional. With it, the Jina fallback is no longer
subject to the anonymous rate limit and to Jina's habit of blocking anonymous
access to whole domains — `nytimes.com` most of all — which is what makes NYT
reliable (see Known gaps). A key that runs out of balance is detected and
dropped for the rest of the run rather than failing every request.

## Fallbacks

The page degrades in order:

1. **Published feed** (`data` branch) — the normal path.
2. **Live fetching** — used if the published feed is missing or over 36 hours
   stale. Works for the feeds that allow browser access; the major papers will
   be thin or absent.
3. **Fetch service** — an optional Cloudflare Worker (`worker/`) whose URL can
   be pasted under the ⋯ tab. Predates the Actions build and is no longer
   needed for the feed, but it still helps the reader with arbitrary pasted
   URLs. See `worker/README.md`.

A published feed is used for up to 36 hours. GitHub runs scheduled workflows
late under load — builds land hours apart against the 30-minute schedule — and
the live fallback cannot reach the major papers at all, so an older prebuilt
feed is the better of the two. Run **Build feed** from the Actions tab to
refresh it on demand.

For an article that is not in the published set (a pasted link, or a story
newer than the last build) the page reads it live through Jina. The public
CORS proxies it once used (AllOrigins, codetabs, corsproxy) are all dead and
are no longer waited on.

## Working on it

```sh
npm install

npm test                 # ranking, extraction, matching and wall-detection tests
npm run audit:feeds      # which feeds are reachable, and which have gone stale
node scripts/build-feed.mjs dist     # build the feed and article text locally
npm run survey           # which routes read which outlet from this machine

npm run serve            # serve index.html against a local worker on :8080
npm run e2e              # drive it in Chromium and report what rendered
```

### Known gaps

- **NYT is read through Jina, which a key makes reliable.** NYT refuses every
  GitHub runner (Ubuntu, ARM, macOS and Windows alike, measured) and gives
  everything but Discord's link crawler a metered preview. Jina, asked to
  fetch as Discord's crawler, gets the whole article — but Jina blocks
  *anonymous* access to `nytimes.com` for an hour at a time whenever someone
  abuses it, which is often. Without a key, NYT stories are read by whichever
  builds land between those blocks (a miss caused by a block is retried on the
  next build, and text once read is kept), and the rest show their summary.
  With `JINA_API_KEY` set, the blocks do not apply and every build reads them.
  A key pasted under ⋯ in the app does the same for NYT stories opened live,
  and stories the build missed are then fetched live automatically.
- **Bloomberg and the FT** refuse every route and are rarely syndicated in a
  form that can be found and verified; most of their stories are summary only.
- **WSJ** is readable only where Dow Jones has licensed a copy (Morningstar,
  Kanebridge, Livemint): its markets, business and economy news usually, its
  features and opinion sometimes. Morningstar's listing holds only a few hours
  of newswire, so each build adds to an index (`licensed-index.json`) that is
  carried forward.
- **AP and Reuters** have no feed that answers anywhere any more. AP's
  feedburner mirror returns nothing and `apnews.com` 403s; Reuters' feed host
  is gone. Publications with no items get no tab, so they are simply absent.
- **Index quotes need an API key.** Yahoo blocks cloud IP ranges, stooq's CSV
  export 404s, and CNBC, MarketWatch, Google Finance and slickcharts all refuse
  — there is no keyless source left that answers from a build runner or a
  browser. The market row hides itself rather than showing three dashes. To turn
  it on, take a free key from a quote provider, add it as a repo secret, and
  extend `marketQuotes()` in `scripts/build-feed.mjs`; note that most free tiers
  cover ETFs (DIA, SPY, QQQ) rather than the indices themselves.
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
| `sources.json` | every feed URL and the Deep reading list, shared by the builder and the page |
| `scripts/build-feed.mjs` | the build that runs in Actions |
| `scripts/resolve.mjs` | reads one story: feed, licensed copy, then the site's routes |
| `scripts/extract.mjs` | per-site routes and cleanup; HTML to paragraphs |
| `scripts/licensed.mjs`, `scripts/syndicated.mjs` | licensed and syndicated copies |
| `research/survey.mjs` | which user agent reads which outlet, from wherever it runs |
| `.github/workflows/build-feed.yml` | schedule and publishing |
| `worker/` | optional Cloudflare Worker fallback |
| `test/` | unit tests, feed audit, local server, browser E2E |
