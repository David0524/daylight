# Extraction research

Tooling for working out how each publisher can be read, and what junk needs
stripping from their pages. Not shipped with the app — this is what the rules
in `index.html` and `scripts/build-feed.mjs` were derived from.

```sh
export JINA_API_KEY=jina_…

# Every strategy against one article, scored on readable prose
node research/strategies.mjs "https://www.example.com/article"

# Just a few
node research/strategies.mjs "https://…" jina jina-share-params wayback

# Save one capture per outlet into research/captures/ (gitignored)
node research/capture.mjs '{"nytimes.com":"https://…"}'
```

`scoreText()` reports words and prose blocks rather than response size, because
navigation chrome is bulky and would otherwise beat the article.

## Strategy groups

- **User agents** — direct fetches as a browser, Googlebot, Bingbot, and the
  Facebook/Twitter/Slack link crawlers.
- **JSON-LD** — publishers feed `articleBody` to search engines, so it is
  sometimes present in HTML whose rendered form shows a wall.
- **AMP** — five URL patterns; AMP is unwalled more often than canonical.
- **Jina** — engine, format, referer and user-agent variants, plus the
  article-sharing parameters some publishers honour server-side.
- **Archives** — Wayback (CDX and Save Page Now) and six archive.today mirrors.
- **Third-party readers** — txtify and similar.

Scope: archives, publisher-provided access paths (crawler allowances, AMP,
sharing parameters, feeds) and syndicated copies. No credential use and no
attempt to defeat bot protection.

## Findings

### WSJ is not reachable from a server

All 32 strategies fail. Direct fetches return 403 in 6–192ms for every user
agent, which is Cloudflare rejecting on IP reputation at the edge — nothing we
send is being read, so no header or referer changes the outcome. AMP does not
exist, JSON-LD cannot be reached, every Jina variant draws a captcha, Wayback
holds no snapshots (WSJ has blocked that crawler for years) and no archive.today
mirror has anything.

What remains would be residential proxies, captcha-solving services or TLS
impersonation, all of which exist to defeat protection WSJ actively maintains.
The app instead opens WSJ in the reader's own browser, where their session
applies, and surfaces MarketWatch and Barron's (same publisher, reachable) as
alternatives.

### Jina key freshness matters

A rate-limited key returns captcha stubs on cold URLs that a fresh key reads
fine — the same NYT article went from 322 words to 4,324. Intermittent
paywalled reads are usually this, not the publisher.
