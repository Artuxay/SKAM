// Service worker СКАМ: оболочка приложения работает офлайн и открывается мгновенно.
// Запросы к Supabase (API, Realtime, Storage) никогда не кэшируются.
// Все пути считаются от области действия SW: сайт может жить и в корне, и в подпапке (GitHub Pages).
const CACHE = 'skam-v3';
const BASE = new URL('./', self.registration.scope).pathname; // например '/' или '/skam/'
const SHELL = ['', 'manifest.webmanifest', 'favicon.svg', 'icons/icon-192.png', 'icons/icon-512.png'].map((p) => BASE + p);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(req, fallbackUrl) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(fallbackUrl || req, res.clone());
    return res;
  } catch {
    return (await cache.match(fallbackUrl || req)) || Response.error();
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const fresh = fetch(req)
    .then((res) => { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; })
    .catch(() => hit || Response.error());
  return hit || fresh;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) {
    // Шрифты Google можно держать в кэше; всё остальное (Supabase и т.п.) — только сеть.
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
      event.respondWith(staleWhileRevalidate(req));
    }
    return;
  }
  if (!url.pathname.startsWith(BASE)) return;
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, BASE));
    return;
  }
  if (url.pathname.startsWith(BASE + 'assets/')) {
    event.respondWith(cacheFirst(req)); // файлы с хэшем в имени не меняются
    return;
  }
  event.respondWith(staleWhileRevalidate(req));
});
