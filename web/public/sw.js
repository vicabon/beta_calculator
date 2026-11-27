/**
 * @fileoverview Lightweight offline-capable Service Worker for iOS & Android PWA support.
 * Caches ONLY static shell assets (never caches /api/vault or sensitive user data!).
 */

const CACHE_NAME = 'dwz-beta-shell-v2';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/js/charts.js',
  '/js/storage-adapters.js',
  '/core/config.mjs',
  '/core/fire-engine.mjs',
  '/core/beta-engine.mjs',
  '/core/reconciler.mjs',
  '/core/crypto-vault.mjs',
  '/manifest.webmanifest',
  '/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // NEVER intercept or cache API calls (especially /api/vault and live stock quotes)
  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.origin !== self.location.origin) {
    return;
  }

  // Network-first with cache fallback so updates arrive immediately while still working offline
  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        if (resp && resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
        }
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});
