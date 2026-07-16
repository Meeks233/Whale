/// <reference lib="webworker" />

// Orca service worker. Built to ../web/sw.js by build.ts. Registered at the
// origin root (/sw.js) so its scope covers the whole app.
export {};
declare const self: ServiceWorkerGlobalScope;

// Cache name is versioned so activate() can purge stale generations. The fetch
// handler below is network-first, so code edits load without bumping this.
const CACHE = 'orca-shell-v6';
const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/theme.js',
  '/style.css',
  '/manifest.webmanifest',
  '/favicon.ico',
  '/icons/favicon-32.png',
  '/third-party-notices.txt',
  '/icons/192.png',
  '/icons/512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // Best-effort: don't fail install if an optional asset (e.g. an icon) is missing.
      .then((cache) => Promise.allSettled(SHELL.map((u) => cache.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin GETs; everything else goes straight to the network.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Never cache API traffic — data must always be live.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(req));
    return;
  }

  // App shell: network-first so code edits (app.js/style.css/index.html) load
  // immediately; warm the cache and fall back to it only when offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((m) => m || Response.error()))
  );
});
