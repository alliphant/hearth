/**
 * Hearth /app service worker.
 *
 * Strategy:
 *   - **app.js / app.css / HTML**: NETWORK-first, cache only as the
 *     offline fallback. This means a single refresh picks up any new
 *     code deploy. Previously these used cache-first, which meant
 *     UI changes took TWO refreshes to land (one to update the SW,
 *     a second to serve the new shell).
 *   - **Static assets** (icons, manifest, .webmanifest): cache-first
 *     stale-while-revalidate. These rarely change and benefit from
 *     fast offline-ready loads.
 *   - **/app/api/***: network-only. Never cache — personal data,
 *     stale-immediate.
 *
 * Cache name is versioned. Bump CACHE_VERSION when you ship a UI change
 * that needs old caches purged.
 */

// Bumped 2026-05-24 for multi-user auth (Phase 1). The activate
// handler purges any prior-named cache so stale pre-auth shells
// don't get served past the cookie-required gate.
const CACHE_VERSION = 'v8-multiuser-auth';
const CACHE_NAME = `hearth-app-${CACHE_VERSION}`;
const APP_SHELL = [
  '/app/',
  '/app/app.css',
  '/app/app.js',
  '/app/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (!url.pathname.startsWith('/app/')) return;

  // Never cache API or SSE.
  if (url.pathname.startsWith('/app/api/')) return;

  const is_shell =
    url.pathname === '/app/' ||
    url.pathname.endsWith('/app.js') ||
    url.pathname.endsWith('/app.css') ||
    url.pathname.endsWith('/index.html');

  if (is_shell) {
    // Network-first: latest code is always preferred when online.
    // Falls back to cache only when the network errors (offline).
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok) {
            caches.open(CACHE_NAME).then((c) => c.put(event.request, res.clone()));
          }
          return res;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || Response.error())),
    );
    return;
  }

  // Other shell assets (icons, manifest) — cache-first with
  // background refresh. They rarely change and offline-ready is
  // the bigger win.
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      const network = fetch(event.request)
        .then((res) => {
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
