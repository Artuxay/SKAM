'use strict';
// Мост между сайтом СКАМ и приложением. Сайт работает так же, как в браузере; здесь только то, чего
// вкладка не умеет: уведомления Windows вместо уведомлений браузера, рация из других окон,
// цвет заголовка окна под тему СКАМ.
const { contextBridge, ipcRenderer } = require('electron');

function arg(name) {
  const p = `--${name}=`;
  const a = process.argv.find((x) => x.startsWith(p));
  return a ? a.slice(p.length) : '';
}

// Сайт может узнать, что открыт в приложении (подсказки про рацию и звук экрана).
contextBridge.exposeInMainWorld('skamDesktop', Object.freeze({
  version: arg('skam-version'),
  platform: process.platform,
  pttEverywhere: process.platform === 'win32',
  systemAudio: process.platform === 'win32',
}));

// --- Уведомления --------------------------------------------------------------------------------
// Сайт показывает уведомления через service worker (registration.showNotification). В приложении
// их показывает Windows: они видны и при закрытом окне, а нажатие открывает нужный чат.
function patchNotifications(send) {
  const SWR = window.ServiceWorkerRegistration;
  if (!SWR || SWR.prototype.__skamDesktop) return;
  const iconData = async (src) => {
    if (!src) return null;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 2500);
      const r = await fetch(new URL(String(src), location.href).href, { signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) return null;
      const b = await r.blob();
      if (b.size > 2e6 || !/^image\/(png|jpeg|webp|gif)$/.test(b.type)) return null;
      return await new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = () => res(null);
        fr.readAsDataURL(b);
      });
    } catch {
      return null;
    }
  };
  const plain = (v) => {
    try {
      return v === undefined ? null : JSON.parse(JSON.stringify(v));
    } catch {
      return null;
    }
  };
  Object.defineProperty(SWR.prototype, 'showNotification', {
    configurable: true,
    writable: true,
    value: async function showNotification(title, options) {
      const o = options || {};
      const icon = await iconData(o.icon);
      await send({
        title: String(title == null ? '' : title),
        body: String(o.body == null ? '' : o.body),
        tag: String(o.tag == null ? '' : o.tag),
        silent: !!o.silent,
        icon,
        data: plain(o.data),
      });
    },
  });
  Object.defineProperty(SWR.prototype, '__skamDesktop', { value: true });
}

contextBridge.executeInMainWorld({
  func: patchNotifications,
  args: [(p) => ipcRenderer.invoke('notify', p)],
});

// Нажали на уведомление — сайт открывает чат так же, как после нажатия на уведомление браузера.
ipcRenderer.on('notification-click', (_e, data) => {
  const chat = data && typeof data.chat === 'string' ? data.chat : null;
  if (!chat) return;
  contextBridge.executeInMainWorld({
    func: (id) => {
      const sw = navigator.serviceWorker;
      if (sw) sw.dispatchEvent(new MessageEvent('message', { data: { type: 'skam-open', chat: id } }));
    },
    args: [chat],
  });
});

// --- Рация и тема ---------------------------------------------------------------------------------
// Режим микрофона, клавишу рации и тему сайт хранит в localStorage, звонок отмечает атрибутом
// data-call — сообщаем это приложению.
let last = '';
function report() {
  let s;
  try {
    s = {
      mode: localStorage.getItem('skam:call:mode'),
      ptt: localStorage.getItem('skam:call:ptt'),
      theme: localStorage.getItem('skam:theme'),
      // Сайт ставит data-call, пока идёт звонок: клавишу рации слушаем только во время звонка.
      call: !!document.documentElement && document.documentElement.hasAttribute('data-call'),
    };
  } catch {
    return;
  }
  const j = JSON.stringify(s);
  if (j === last) return;
  last = j;
  ipcRenderer.send('state', s);
}
setInterval(report, 1000);
window.addEventListener('DOMContentLoaded', () => {
  report();
  new MutationObserver(report).observe(document.documentElement, { attributes: true, attributeFilter: ['data-call'] });
});
window.addEventListener('storage', report);

// Окно не в фокусе, а клавишу рации нажали — передаём нажатие сайту, как будто окно в фокусе.
function keyOf(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (code === 'Space') return ' ';
  return code;
}
ipcRenderer.on('ptt', (_e, msg) => {
  if (!msg || typeof msg.code !== 'string') return;
  window.dispatchEvent(new KeyboardEvent(msg.down ? 'keydown' : 'keyup', {
    code: msg.code,
    key: keyOf(msg.code),
    bubbles: true,
    cancelable: true,
  }));
});
