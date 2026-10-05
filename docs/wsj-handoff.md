# Handoff: WSJ article text in Daylight

## The problem

Most WSJ stories in the app open as a summary, not the full article. In the
latest production build (2026-10-05 18:01 UTC), 5 of the 26 stories in the WSJ
tab, and 5 of 35 WSJ stories across the app, open in full. The owner's target
was 75%.

For comparison, from the same build: Bloomberg 25/25 (its tab is built from
the Bloomberg stories Yahoo Finance runs), NYT 20/21, and 285/330 overall.

## Why WSJ is different

- **wsj.com refuses every automated fetch.** Its edge answers HTTP 401 in a few
  milliseconds, before any header is read: from GitHub's runners (Ubuntu, ARM,
  macOS and Windows), from this development container, and through Jina Reader.
- **No archive holds it.** Neither the Internet Archive nor anything else
  gives a usable copy of current WSJ stories.
- **Full text never reaches non-subscribers.** WSJ does not put the
  article text in the page it serves them.
- **The app's other mechanisms don't apply.** NYT and WaPo are read by
  presenting a crawler's identity (Discord's and Bing's), which those sites
  serve in full. The project's maintainer (Claude) declined to build the
  equivalent for WSJ: getting past a publisher's paywall is out of scope for
  it, whether the wall is soft or hard. It considers the NYT and WaPo routes
  an inconsistency of its own. The owner has chosen to keep them.

## What the build does for WSJ now

All in `scripts/` and run by `.github/workflows/build-feed.yml`.

| Route | How | Typical yield |
|---|---|---|
| Morningstar's Dow Jones newswire (`licensed.mjs`) | listing of the newest 50 items, merged into `licensed-index.json` every build; matched by headline | a few business and markets stories a day |
| Kanebridge News (`licensed.mjs`, `partners.mjs`) | front-page list; a copy counts only if it carries Dow Jones's licence line | several WSJ features a week |
| Mint (`partners.mjs`) | `livemint.com/wsj` list; **free copies only** | 2–3 a day (most of Mint's WSJ copies are marked `isAccessibleForFree: false` and are skipped) |
| Partner copies found via Google News (`syndicated.mjs`) | search by headline and by names and figures, then credit and same-story checks | occasional |

The WSJ tab keeps WSJ's own feed and adds the free partner copies, readable
first (`sources.json` → `papers.wsj.add`, `readableFirst`). Stories with no
copy show the summary, with a link to the original.

Safeguards that must stay:
- A partner copy must credit WSJ (Dow Jones licence line or a reporter's
  `@wsj.com` sign-off) and be the same story.
- A copy the partner marks subscriber-only is never used.
- `extract.mjs` never takes a preloaded "next story" for the page's own
  (Kanebridge preloads them).

## Measured dead ends

- **Moomoo:** Dow Jones stories sit behind a sign-in.
- **FN London, The Australian:** 401 or paywalled.
- **NZ Herald:** its WSJ author page loads stories client-side, and its WSJ
  stories are mostly premium.
- **news.com.au:** only occasional WSJ stories.
- **Morningstar's own search:** covers its editorial, not the newswire.
- **Morningstar's newswire listing:** does not paginate (one page, about 7
  hours).
- **Bing News:** finds no copies Google News misses.

## Ways forward that stay within the above

1. **Owner access.** A library WSJ pass, a subscription or Apple News+ makes
   each summary's "original" link open the full story in the owner's own
   browser. The build cannot use a login: wsj.com refuses the runner before
   authentication matters.
2. **WSJ tab from free copies only.** Every story in it opens, but there are
   only about 10–15 a day, mostly features. This is a one-line change in
   `sources.json`: make `partner:wsj-free` the paper's feed.
3. ~~Retry WSJ misses every build~~ -- done: a missed WSJ, Barron's or
   MarketWatch story is retried on every build while it is in the feed. The
   newswire index, partner lists and Kanebridge are checked each time; the
   Google News search at most every two hours per story (`LICENSED_RETRY_MS`,
   `LICENSED_SEARCH_MS` in `build-feed.mjs`).
4. **More licensees.** Add any partner that republishes WSJ for free with a
   list page to `LISTINGS` in `partners.mjs`. Check it from a runner first
   (see `research/` and the temporary `claude/runner-survey` workflow
   pattern).

## Housekeeping

- The branch `claude/runner-survey` holds temporary probe workflows and can be
  deleted. This session's proxy refuses branch deletion.
- `npm test` must pass (133 checks) before pushing. Builds publish to the
  `data` branch about every 30 minutes, and on every push to `main` that
  touches `scripts/` or `sources.json`.
