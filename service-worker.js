/**
 * service-worker.js
 * Caches the app shell so Melody launches instantly and works offline.
 * Song files themselves will be cached separately by the (upcoming)
 * library/import service using the Cache Storage API or IndexedDB blobs —
 * this worker only owns the static shell for now.
 */

const CACHE_NAME = 'melody-shell-v2';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/tokens.css',
  './css/base.css',
  './css/onboarding.css',
  './css/home.css',
  './js/app.js',
  './js/utils/db.js',
  './js/utils/storage.js',
  './js/utils/router.js',
  './js/utils/time-of-day.js',
  './js/utils/filename-cleaner.js',
  './js/services/theme-service.js',
  './js/services/import-service.js',
  './js/services/library-service.js',
  './js/components/nickname-screen.js',
  './js/components/greeting-screen.js',
  './js/components/home-screen.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Cache-first for the app shell, network fallback for anything uncached.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).catch(() => cached);
    })
  );
});
