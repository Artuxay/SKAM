// Регистрация service worker (только в production-сборке, чтобы не мешать dev-серверу).
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* офлайн-режим просто не включится */ });
  });
}
