'use strict';
// «Нет связи»: каждые 5 секунд и при появлении сети проверяем сервер и возвращаемся в СКАМ.
(() => {
  const params = new URLSearchParams(location.search);
  let target = 'https://skam-messenger.ru/';
  try {
    const u = new URL(params.get('u') || target);
    if (u.protocol === 'https:' || u.protocol === 'http:') target = u.href;
  } catch { /* остаётся адрес по умолчанию */ }
  const state = document.getElementById('state');
  let busy = false;

  async function attempt(manual) {
    if (busy) return;
    busy = true;
    if (manual) state.textContent = 'Подключаемся…';
    try {
      await fetch(target, { mode: 'no-cors', cache: 'no-store' });
      location.replace(target);
    } catch {
      state.textContent = manual ? 'Пока нет связи. Попробуем ещё раз через несколько секунд.' : '';
    } finally {
      busy = false;
    }
  }

  document.getElementById('retry').addEventListener('click', () => attempt(true));
  window.addEventListener('online', () => attempt(false));
  setInterval(() => attempt(false), 5000);
})();
