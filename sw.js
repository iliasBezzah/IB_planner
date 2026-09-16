/* ╔══════════════════════════════════════════════════════╗
   ║  IB Day Programme — Service Worker (PWA Offline)    ║
   ╚══════════════════════════════════════════════════════╝ */

const CACHE_NAME = 'ib-planner-v2';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon-192.svg',
  './icon-512.svg',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/webfonts/fa-solid-900.woff2',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/webfonts/fa-regular-400.woff2'
];

// ─── Install: Cache all assets ───
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return Promise.allSettled(ASSETS.map(url => cache.add(url)));
    })
  );
});

// ─── Activate: Remove old caches ───
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch: Cache-first strategy ───
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        if (!response || response.status !== 200) return response;
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        return response;
      }).catch(() => {
        // Offline fallback for navigation
        if (e.request.destination === 'document') {
          return caches.match('./index.html');
        }
      });
    })
  );
});

// ─── Push Notifications ───
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : { title: 'IB Planner', body: 'You have an upcoming event!' };
  e.waitUntil(
    self.registration.showNotification(data.title || 'IB Planner', {
      body: data.body || '',
      icon: './icon-192.svg',
      badge: './icon-192.svg',
      vibrate: [200, 100, 200],
      tag: 'ib-reminder',
      data: { url: data.url || './' }
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data.url || './'));
});
