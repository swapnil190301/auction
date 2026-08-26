'use strict';

/**
 * Service worker for the "installable app" side of the PWA (Add to Home
 * Screen / desktop install prompt). Deliberately does almost nothing:
 *
 *  - Never touches API calls (/api/...) or the WebSocket upgrade (/ws) — an
 *    auction is only meaningful live, so nothing about bids, state, PINs, or
 *    accounts may ever be served from a cache. Those requests are left
 *    completely alone (event.respondWith is never called for them), so they
 *    behave exactly as if this file didn't exist.
 *  - For the static app shell (/, styles.css, app.js, manifest.json, icons),
 *    it's network-first: always try the live network response first (so a
 *    deploy is picked up on the very next load), and only fall back to
 *    whatever's cached if the network is unreachable — enough to avoid a
 *    hard browser error if a connection drops for a moment, not a promise of
 *    real offline auctioning.
 *
 * Bump CACHE_NAME whenever shell assets change materially — install() only
 * repopulates a *new* cache, and activate() deletes every other one, so an
 * old cached app.js can't linger once the new SW takes over.
 */

const CACHE_NAME = 'cricket-auction-shell-v1';
const SHELL_ASSETS = [
  '/',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only ever handle same-origin GETs; everything else (API POSTs, the /ws
  // upgrade, cross-origin requests like the Google Fonts CSS) passes straight
  // through untouched.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || Promise.reject('offline-and-uncached')))
  );
});
