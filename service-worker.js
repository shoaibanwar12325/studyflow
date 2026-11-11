/* StudyFlow – service-worker.js
 * Caching strategy
 *   • App shell (HTML, CSS, JS, icons): pre-cached on install → cache-first, so the app opens instantly
 *     and fully offline. Bump VERSION to ship an update (old caches are deleted on activate).
 *   • API calls (Open-Meteo, GOV.UK): network-first with a 6 s timeout, falling back to the last
 *     cached response when offline.
 *   • Notification clicks open/focus the app at the relevant task.
 */
const VERSION = 'v1.0.0';
const SHELL_CACHE = `studyflow-shell-${VERSION}`;
const API_CACHE = 'studyflow-api';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.json',
  'js/boot.js', 'js/core.js', 'js/crypto.js', 'js/store.js', 'js/api.js', 'js/icons.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png', 'icons/badge-96.png',
];
const API_HOSTS = ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'www.gov.uk'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('studyflow-shell-') && n !== SHELL_CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (API_HOSTS.includes(url.hostname)) {
    event.respondWith(networkFirst(req));
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // Single-page app: always serve the cached shell for navigations (works offline).
    event.respondWith(caches.match('index.html').then(r => r || fetch(req)));
    return;
  }
  event.respondWith(cacheFirst(req));
});

async function cacheFirst(req) {
  const cached = await caches.match(req, { ignoreSearch: true });
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) (await caches.open(SHELL_CACHE)).put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(API_CACHE);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 6000)),
    ]);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || '#/today';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if ('focus' in client) {
        await client.focus();
        client.postMessage({ type: 'OPEN', url: target });
        return;
      }
    }
    await self.clients.openWindow(`./index.html?open=${encodeURIComponent(target)}`);
  })());
});
