// СКАМ переехал на https://skam-messenger.ru. Этот service worker заменяет старый на
// https://artuxay.github.io/SKAM/: удаляет кэш прежней версии, снимает себя и
// перезагружает открытые вкладки (они попадут на страницу перенаправления).
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.registration.unregister();
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const tab of tabs) {
      try {
        await tab.navigate(tab.url);
      } catch {
        // вкладка не под этим service worker — её обновит следующий переход
      }
    }
  })());
});
