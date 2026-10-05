// Service worker СКАМ: оболочка приложения работает офлайн и открывается мгновенно.
// Запросы к Supabase (API, Realtime, Storage) никогда не кэшируются.
// Все пути считаются от области действия SW: сайт может жить и в корне, и в подпапке (GitHub Pages).
const CACHE = 'skam-v7';
// Кэш зашифрованных вложений ведёт само приложение (расшифровать их без ключа нельзя) — его не трогаем.
const KEEP = (k) => k === CACHE || k.startsWith('skam-media');
const BASE = new URL('./', self.registration.scope).pathname; // например '/' или '/skam/'
const SHELL = ['', 'manifest.webmanifest', 'favicon.svg', 'icons/icon-192.png', 'icons/icon-512.png'].map((p) => BASE + p);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP(k)).map((k) => caches.delete(k))))
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

  // Чужие адреса (API, Realtime, Storage) — только сеть.
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(BASE)) return;
  if (req.mode === 'navigate') {
    // Само приложение кэшируется под одним адресом BASE (с любыми ?join=… и т.п.);
    // отдельные страницы (соглашение, политика) — под своими адресами.
    const app = url.pathname === BASE || url.pathname === BASE + 'index.html';
    event.respondWith(app ? networkFirst(req, BASE) : networkFirst(req));
    return;
  }
  if (url.pathname.startsWith(BASE + 'assets/') || url.pathname.startsWith(BASE + 'fonts/')) {
    event.respondWith(cacheFirst(req)); // файлы с хэшем в имени и шрифты не меняются
    return;
  }
  event.respondWith(staleWhileRevalidate(req));
});

// Нажали на уведомление о сообщении: показываем открытый СКАМ и просим открыть этот чат.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const chat = event.notification.data && event.notification.data.chat;
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = list.find((c) => new URL(c.url).pathname.startsWith(BASE));
    if (win) {
      await win.focus();
      if (chat) win.postMessage({ type: 'skam-open', chat });
      return;
    }
    if (self.clients.openWindow) await self.clients.openWindow(BASE + (chat ? '?chat=' + encodeURIComponent(chat) : ''));
  })());
});
