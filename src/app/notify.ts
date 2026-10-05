// Уведомления о новых сообщениях: звук, пока СКАМ открыт, и уведомление системы, когда он свёрнут
// или в другой вкладке. Без сервера пуш-уведомлений: закрытый СКАМ не уведомляет.
import type { MyChat } from '../lib/database.types';
import { S, chatMuted, meId, type Msg } from './store';
import { notifyPrefs } from './prefs';
import { audioContext } from './sounds';

type Env = {
  title: (c: MyChat) => string;
  /** Текст сообщения для уведомления («Аня: привет», «🖼 Фото»). */
  text: (m: Msg, c: MyChat) => string;
  icon: (c: MyChat) => string | null;
  open: (chatId: string) => void;
};
let env: Env | null = null;

export function notifySupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notifyPermission(): NotificationPermission | 'unsupported' {
  return notifySupported() ? Notification.permission : 'unsupported';
}

/** Спросить разрешение (только по нажатию человека — иначе браузер откажет молча). */
export async function askPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!notifySupported()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function mountNotify(e: Env): () => void {
  env = e;
  // Нажали на уведомление, показанное service worker'ом, — он присылает, какой чат открыть.
  const onSw = (ev: MessageEvent) => {
    const d = ev.data as { type?: string; chat?: string } | null;
    if (d?.type === 'skam-open' && typeof d.chat === 'string' && S.chats.has(d.chat)) env?.open(d.chat);
  };
  navigator.serviceWorker?.addEventListener('message', onSw);
  return () => {
    navigator.serviceWorker?.removeEventListener('message', onSw);
    env = null;
  };
}

let lastChime = 0;

/** Короткий звук нового сообщения (Web Audio, без файлов). */
export function chime(): void {
  const now = Date.now();
  if (now - lastChime < 1500) return;
  lastChime = now;
  const c = audioContext();
  if (!c || c.state !== 'running') return;
  const t0 = c.currentTime + 0.01;
  [[880, 0], [1320, 0.09]].forEach(([f, at]) => {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    g.gain.setValueAtTime(0, t0 + at);
    g.gain.linearRampToValueAtTime(0.08, t0 + at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.22);
    o.connect(g).connect(c.destination);
    o.start(t0 + at);
    o.stop(t0 + at + 0.25);
  });
}

/** Новое чужое сообщение, которое прибавилось к непрочитанным. */
export function incoming(m: Msg): void {
  if (!env || m.user_id === meId() || m.kind === 'system' || m.kind === 'call' || m.deleted_at) return;
  const c = S.chats.get(m.chat_id);
  if (!c || chatMuted(c.id)) return;
  const P = notifyPrefs();
  const away = document.visibilityState !== 'visible' || !document.hasFocus();
  if (away && P.on && notifyPermission() === 'granted') {
    void show(c, m, P.preview, !P.sound);
    return;
  }
  if (P.sound) chime();
}

async function show(c: MyChat, m: Msg, preview: boolean, silent: boolean): Promise<void> {
  if (!env) return;
  const title = env.title(c);
  const body = preview ? env.text(m, c) : 'Новое сообщение';
  const icon = env.icon(c) ?? `${import.meta.env.BASE_URL}icons/icon-192.png`;
  const opts: NotificationOptions & { renotify?: boolean } = {
    body, icon, tag: `chat:${c.id}`, renotify: true, silent, data: { chat: c.id },
    badge: `${import.meta.env.BASE_URL}icons/favicon-32.png`,
  };
  // Через service worker уведомления работают и на телефоне (там new Notification() запрещён).
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) { await reg.showNotification(title, opts); return; }
  } catch { /* покажем обычным способом */ }
  try {
    const n = new Notification(title, opts);
    n.onclick = () => { window.focus(); env?.open(c.id); n.close(); };
  } catch { /* браузер не умеет */ }
}

/** «Проверить уведомление» в настройках. */
export async function testNotify(): Promise<void> {
  if (notifyPermission() !== 'granted') return;
  const title = 'СКАМ';
  const opts: NotificationOptions = {
    body: 'Так выглядят уведомления о новых сообщениях.', tag: 'skam-test',
    icon: `${import.meta.env.BASE_URL}icons/icon-192.png`,
  };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) { await reg.showNotification(title, opts); return; }
  } catch { /* покажем обычным способом */ }
  try { new Notification(title, opts); } catch { /* браузер не умеет */ }
}
