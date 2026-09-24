// Мелкие DOM-помощники, логотип, форматирование времени.

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} not found`);
  return node as T;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string | null,
  text?: string | null,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function button(cls: string | null, text: string | null, onClick: (ev: MouseEvent) => void): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** Разметка из доверенной строки (только наши собственные шаблоны, никогда — пользовательский текст). */
export function html(markup: string): DocumentFragment {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content;
}

// ---------------------------------------------------------------------------
// Бренд
// ---------------------------------------------------------------------------

export const APP_ICON =
  '<svg class="appicon" viewBox="0 0 200 200" aria-hidden="true"><rect width="200" height="200" rx="46" fill="url(#skamGrad)"/><use href="#skamMark" x="54.3" y="50.3" width="91.7" height="100.1" fill="#0E0E10"/></svg>';
export const APP_ICON_HERO = APP_ICON.replace('class="appicon"', 'class="appicon hero"');
export const BRAND_AVATAR =
  '<svg viewBox="0 0 200 200" aria-hidden="true"><circle cx="100" cy="100" r="100" fill="url(#skamGrad)"/><use href="#skamMark" x="58" y="52" width="84" height="91.7" fill="#0E0E10"/></svg>';
export const LOGO = `<span class="logo">${APP_ICON}<span class="wordmark">СКАМ</span></span>`;

export const ICONS = {
  plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  back: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  send: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>',
  close: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  sun: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/></svg>',
  moon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/></svg>',
};

// ---------------------------------------------------------------------------
// Всплывающие уведомления
// ---------------------------------------------------------------------------

let toastTimer: number | undefined;
export function toast(text: string): void {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t.hidden = true; }, 3500);
}

// ---------------------------------------------------------------------------
// Разное
// ---------------------------------------------------------------------------

export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function lsGet(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
export function lsSet(k: string, v: string | null): void {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch { /* приватный режим и т.п. */ }
}

export const wideMQ = window.matchMedia('(min-width: 761px)');
export const touchMQ = window.matchMedia('(hover: none)');

export function openDialog(d: HTMLDialogElement): void {
  if (!d.open) d.showModal();
}
export function closeDialog(d: HTMLDialogElement): void {
  if (d.open) d.close();
}

/** Текст с кликабельными ссылками — без innerHTML. */
export function fillText(node: HTMLElement, text: string): void {
  const re = /https?:\/\/[^\s<>"']+/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    node.append(text.slice(last, m.index));
    const a = el('a', null, m[0]);
    a.href = m[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    node.append(a);
    last = m.index + m[0].length;
  }
  node.append(text.slice(last));
}

// ---------------------------------------------------------------------------
// Время
// ---------------------------------------------------------------------------

const fmtTime = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const fmtDayY = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const fmtShort = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });

export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
export function dayLabel(ts: number): string {
  const now = new Date();
  if (dayKey(ts) === dayKey(now.getTime())) return 'Сегодня';
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (dayKey(ts) === dayKey(y.getTime())) return 'Вчера';
  return new Date(ts).getFullYear() === now.getFullYear() ? fmtDay.format(ts) : fmtDayY.format(ts);
}
export function timeLabel(ts: number): string {
  return fmtTime.format(ts);
}
export function listTime(ts: number): string {
  return dayKey(ts) === dayKey(Date.now()) ? fmtTime.format(ts) : fmtShort.format(ts);
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} ${one}`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}
