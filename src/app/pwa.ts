// Регистрация service worker (только в production-сборке, чтобы не мешать dev-серверу).
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    const base = import.meta.env.BASE_URL;
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => { /* офлайн-режим просто не включится */ });
  });
}
