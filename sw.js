/**
 * Offline support.
 *
 * The page and its own files: network first, so a new deploy shows up on the
 * next open, with the cached copy when there is no connection.
 * The feed (feed.json): the same, with the query string that busts the CDN
 * cache ignored, so the last feed fetched is what an offline open shows.
 * Article text (a/<id>.json): cache first; the page warms the cache with the
 * top stories after each feed load, so they open on a plane.
 * Google Fonts: cache first, refreshed in the background.
 */
const VERSION = "v1";
const SHELL = `daylight-shell-${VERSION}`;
const DATA = `daylight-data-${VERSION}`;
const FONTS = `daylight-fonts-${VERSION}`;
const ARTICLE_LIMIT = 300;

const SHELL_FILES = [
  "./", "./index.html", "./manifest.webmanifest", "./fonts/paper-mono.woff2",
  "./fonts/michelangelus-regular.woff2", "./fonts/michelangelus-bold.woff2",
  "./fonts/michelangelus-italic.woff2", "./fonts/michelangelus-bolditalic.woff2",
  "./icons/icon-180.png", "./icons/icon-192.png", "./icons/favicon-32.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL, DATA, FONTS]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

const isDataHost = (u) => u.hostname === "raw.githubusercontent.com" && /\/daylight\/data\//i.test(u.pathname);

async function networkFirst(req, cacheName, key = req) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(key, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(key, { ignoreSearch: true });
    if (hit) return hit;
    throw e;
  }
}

async function cacheFirst(req, cacheName, { refresh = false, trim = 0 } = {}) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const update = fetch(req).then(res => {
    if (res.ok || res.type === "opaque") {
      cache.put(req, res.clone());
      if (trim) trimCache(cache, trim);
    }
    return res;
  });
  if (hit) {
    if (refresh) update.catch(() => {});
    return hit;
  }
  return update;
}

async function trimCache(cache, max) {
  const keys = await cache.keys();
  const articles = keys.filter(k => /\/a\/[0-9a-f]+\.json$/.test(k.url));
  for (const k of articles.slice(0, Math.max(0, articles.length - max))) await cache.delete(k);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    // Shared links arrive as ?read=..., which should still open offline.
    const key = req.mode === "navigate" ? "./index.html" : req;
    event.respondWith(networkFirst(req, SHELL, key));
    return;
  }
  if (isDataHost(url)) {
    if (/\/feed\.json$/.test(url.pathname)) {
      // One cached copy, whatever the cache-busting query.
      event.respondWith(networkFirst(req, DATA, url.origin + url.pathname));
    } else if (/\/a\/[0-9a-f]+\.json$/.test(url.pathname)) {
      event.respondWith(cacheFirst(req, DATA, { trim: ARTICLE_LIMIT }));
    }
    return;
  }
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(cacheFirst(req, FONTS, { refresh: url.hostname === "fonts.googleapis.com" }));
  }
});
