// v5: bumping this name makes the activate step below delete the old v4 cache.
// Also now caches the two PDF-export libraries so "Export PDF" works fully offline
// once the app has been opened online at least once after this update.
const CACHE_NAME = 'warehouse-scanner-v5';
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './html5-qrcode.min.js',
  './xlsx.full.min.js',
  './jspdf.umd.min.js',
  './html2canvas.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const host = new URL(event.request.url).hostname;

  // GitHub API calls (users.csv, FileUploade.csv, lock files...) carry a unique
  // "_=timestamp" in the URL and custom headers (ETag / If-None-Match). They must
  // never be stored in the cache: every response would become a new entry that is
  // never reused or deleted, and it would keep an unencrypted copy of users.csv on
  // the device. Not calling respondWith() lets the request go straight to the network.
  if (host === 'api.github.com') return;

  // version.json is the app's "new version available?" marker: always ask the network, never keep a copy.
  if (new URL(event.request.url).pathname.endsWith('/version.json')) return;

  // Any raw.githubusercontent.com file (items/shelves/groups AND FileUploade, which
  // lives in a different repo) is live data: network only, never cached here.
  const isLookupData = host === 'raw.githubusercontent.com';

  if (isLookupData) {
    // Network-only, no cache involved at all: these are the live item/group/
    // shelf CSVs. The page keeps its own localStorage-based offline copy and
    // "last successful update" timestamp — if the Service Worker served a
    // cached response here instead of hitting the real network, the app
    // would think it just synced successfully even while fully offline.
    event.respondWith(fetch(event.request));
    return;
  }

  const isPage = event.request.mode === 'navigate' || event.request.destination === 'document';

  if (isPage) {
    // Network-first for the HTML page itself: always try to get the latest
    // version when online, so updates appear immediately without anyone
    // having to clear cache/data manually. Only fall back to the cached
    // copy if there's truly no connection.
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first with background revalidation for other static assets
  // (icons, manifest) — these change rarely, so this is fine and fast.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
