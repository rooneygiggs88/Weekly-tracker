const CACHE = 'tracker-v42';
const ASSETS = [
  '/Weekly-tracker/',
  '/Weekly-tracker/index.html',
  '/Weekly-tracker/manifest.json',
  '/Weekly-tracker/icon-192.png',
  '/Weekly-tracker/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Navigation/HTML requests go network-first, so a fresh deploy shows up the very next
  // time the app is opened instead of waiting on a background cache refresh - this was
  // the cause of fixes appearing "not deployed" when they'd actually already shipped.
  // Falls back to cache only when offline, which is what the cache is actually for.
  const isHTML = e.request.mode === 'navigate' || (e.request.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
