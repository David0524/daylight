/**
 * Jina Reader, as a fallback for pages the runner cannot fetch itself.
 *
 * Three ways it fails, all of which used to leave the build with nothing:
 *   - a key that has run out answers 402 to every call, which is worse than
 *     sending no key at all -- so the first 402 drops it for the rest of the run
 *   - anonymous use is limited to 20 requests a minute, so anonymous calls are
 *     paced instead of fired in parallel
 *   - Jina blocks anonymous access to a whole domain for a while when others
 *     abuse it (nytimes.com was blocked for an hour at a time) -- the block is
 *     remembered so the rest of that domain's stories skip straight past it
 */
import { hostOf } from "./extract.mjs";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function createJina(key, log = () => {}) {
  let keyOk = !!key;
  let last = 0;
  const blocked = new Set();

  async function pace() {
    if (keyOk) return;
    const wait = last + 3300 - Date.now();
    last = Math.max(Date.now(), last + 3300);
    if (wait > 0) await sleep(wait);
  }

  /** Raw HTML of a page as Jina's browser rendered it, or null. */
  async function html(url, { ua, selector } = {}) {
    const host = hostOf(url);
    if (blocked.has(host) && !keyOk) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      await pace();
      const headers = { Accept: "text/html", "X-Return-Format": "html", "X-Timeout": "20" };
      if (ua) headers["X-User-Agent"] = ua;
      // Only the article container, where the site has one: a fraction of the
      // page, which is what a keyed account is billed for.
      if (selector) headers["X-Target-Selector"] = selector;
      if (keyOk) headers.Authorization = `Bearer ${key}`;
      let r;
      try {
        r = await fetch(`https://r.jina.ai/${url}`, { headers, signal: AbortSignal.timeout(45000) });
      } catch { return null; }
      if ((r.status === 402 || r.status === 401) && keyOk) {
        keyOk = false;
        log("    jina key refused (out of balance?) -- continuing anonymously");
        attempt--; continue;
      }
      if (r.status === 429) { await sleep(15000); continue; }
      if (r.status === 403 || r.status === 451) {
        const body = await r.text().catch(() => "");
        if (/AbuseAlleviation|blocked/i.test(body)) blocked.add(host);
        return null;
      }
      if (!r.ok) return null;
      return r.text();
    }
    return null;
  }

  /** URLs from Jina's search. Needs a working key; empty without one. */
  async function search(q) {
    if (!keyOk) return [];
    try {
      const r = await fetch(`https://s.jina.ai/?q=${encodeURIComponent(q)}`, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "X-Respond-With": "no-content" },
        signal: AbortSignal.timeout(45000),
      });
      if (r.status === 402 || r.status === 401) { keyOk = false; return []; }
      if (!r.ok) return [];
      return ((await r.json())?.data || []).map(h => String(h.url || "")).filter(Boolean);
    } catch { return []; }
  }

  return { html, search, get keyOk() { return keyOk; } };
}
