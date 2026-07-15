/**
 * service-worker.js
 * Caches the app shell so Melody launches instantly and works offline.
 * Song files themselves will be cached separately by the (upcoming)
 * library/import service using the Cache Storage API or IndexedDB blobs —
 * this worker only owns the static shell for now.
 *
 * IMPORTANT — why this file changed:
 * The old strategy was pure cache-first with a hardcoded, incomplete
 * APP_SHELL list, and CACHE_NAME hadn't been bumped in a long time. That
 * combination meant that once a device had this shell cached, it could
 * keep serving OLD app.js/premium-screen.js/settings-screen.js/etc.
 * indefinitely — every later code fix (Admin Dashboard, Royal Navy theme,
 * the ad overlay bug, etc.) would silently never reach an already-visited
 * device, because the browser only reinstalls a service worker when the
 * service worker FILE ITSELF changes byte-for-byte, and pure cache-first
 * fetch handling never re-checks the network once something is cached.
 *
 * Fix: app-shell files (HTML/CSS/JS) now use network-first — always try
 * the network for the freshest code, only falling back to cache when
 * truly offline. The cache is kept fresh automatically as a side effect
 * of every successful network fetch, so routine code changes reach
 * devices immediately without needing a manual version bump every time.
 * CACHE_NAME is still bumped here once, to force an immediate purge of
 * whatever was stuck from before this fix existed.
 */

const CACHE_NAME = 'melody-shell-v13'; // bumped: Elite build pass (Gold Theme, Visualizer, Stats, Smart Queue) — forces a clean cache purge

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',

  './css/tokens.css',
  './css/base.css',
  './css/onboarding.css',
  './css/home.css',
  './css/player.css',
  './css/lyrics.css',
  './css/screens.css',
  './css/toast.css',
  './css/library-premium.css',
  './css/premium.css',
  './css/auth.css',
  './css/admin.css',
  './css/elite.css',

  './js/app.js',

  './js/utils/db.js',
  './js/utils/storage.js',
  './js/utils/router.js',
  './js/utils/time-of-day.js',
  './js/utils/filename-cleaner.js',
  './js/utils/toast.js',
  './js/utils/upgrade-dialog.js',
  './js/utils/elite-startup.js',

  './js/services/theme-service.js',
  './js/services/import-service.js',
  './js/services/library-service.js',
  './js/services/player-service.js',
  './js/services/artwork-service.js',
  './js/services/coverart-service.js',
  './js/services/favorites-service.js',
  './js/services/history-service.js',
  './js/services/playlist-service.js',
  './js/services/lyrics-service.js',
  './js/services/metadata-service.js',
  './js/services/metadata-writer.js',
  './js/services/firebase-config.js',
  './js/services/auth-service.js',
  './js/services/premium-service.js',
  './js/services/cloud-backup-service.js',
  './js/services/ad-manager.js',
  './js/services/admin-service.js',
  './js/services/stats-service.js',

  './js/components/login-screen.js',
  './js/components/verify-email-screen.js',
  './js/components/nickname-screen.js',
  './js/components/greeting-screen.js',
  './js/components/home-screen.js',
  './js/components/player-screen.js',
  './js/components/search-screen.js',
  './js/components/library-screen.js',
  './js/components/settings-screen.js',
  './js/components/premium-screen.js',
  './js/components/admin-screen.js',
  './js/components/lyrics-screen.js',
  './js/components/manual-lyrics-sheet.js',
  './js/components/metadata-editor.js',
  './js/components/music-hub.js',
  './js/components/playlist-sheet.js',
  './js/components/shell.js',
  './js/components/song-list.js',
  './js/components/stats-screen.js',

  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      // Precaching is best-effort — a missing/renamed file in the list
      // shouldn't block the whole install; network-first fetch handling
      // below still serves everything correctly either way.
      .catch((err) => console.warn('[Melody SW] Precache had a partial failure (non-fatal):', err))
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

// Network-first for the app shell (always get the latest code when
// online), falling back to whatever's cached only when the network
// request fails (i.e. actually offline). Every successful network
// response also refreshes the cache, so it self-heals over time.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        const copy = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return networkResponse;
      })
      .catch(() => caches.match(event.request))
  );
});
