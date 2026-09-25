/* ╔══════════════════════════════════════════════════════╗
   ║  IB Day Programme — Service Worker (PWA Offline)    ║
   ╚══════════════════════════════════════════════════════╝ */

const CACHE_NAME = 'ib-planner-v15';
const ASSETS = [
  './',
  './index.html',
  './login.html',
  './style.css',
  './app.js',
  './firebase-config.js',
  './manifest.json',
  './icon-192.svg',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css'
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

// ─── Fetch: Network-First strategy (always fresh online, fallback to cache offline) ───
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  
  e.respondWith(
    fetch(e.request)
      .then(networkResponse => {
        if (networkResponse && networkResponse.status === 200) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(e.request).then(cached => {
          if (cached) return cached;
          if (e.request.destination === 'document') {
            return caches.match('./index.html');
          }
        });
      })
  );
});

// ─── Push Notifications from Server ───
self.addEventListener('push', e => {
  let title = 'IB Student Planner';
  let body  = 'Upcoming class or task reminder!';
  let data  = { url: './index.html' };
  if (e.data) {
    try {
      const d = e.data.json();
      title = d.title || title;
      body  = d.body  || body;
      data  = d.data  || data;
    } catch {
      body = e.data.text();
    }
  }
  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: './icon-192.svg',
      badge: './icon-192.svg',
      vibrate: [200, 100, 200],
      data
    })
  );
});

// ─── Message from Client Page to Dispatch Notification ───
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SHOW_NOTIFICATION') {
    const { title, options } = e.data;
    e.waitUntil(
      self.registration.showNotification(title || 'IB Student Planner', {
        body: options?.body || '',
        icon: options?.icon || './icon-192.svg',
        badge: options?.badge || './icon-192.svg',
        vibrate: options?.vibrate || [200, 100, 200],
        tag: options?.tag || 'ib-alert-' + Date.now(),
        data: options?.data || { url: './index.html' }
      })
    );
  }
});

// ─── Notification Click Handler ───
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const targetUrl = e.notification.data?.url || './index.html';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) {
          if (e.notification.data?.courseId && 'postMessage' in client) {
            client.postMessage({
              type: 'OPEN_COURSE',
              courseId: e.notification.data.courseId
            });
          }
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
