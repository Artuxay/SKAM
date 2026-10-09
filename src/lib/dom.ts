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
  '<svg class="appicon" viewBox="0 0 200 200" aria-hidden="true"><rect width="200" height="200" rx="46" fill="url(#skamGrad)"/><use href="#skamMark" x="54.3" y="50.3" width="91.7" height="100.1" fill="#000"/></svg>';
export const APP_ICON_HERO = APP_ICON.replace('class="appicon"', 'class="appicon hero"');
export const BRAND_AVATAR =
  '<svg viewBox="0 0 200 200" aria-hidden="true"><circle cx="100" cy="100" r="100" fill="url(#skamGrad)"/><use href="#skamMark" x="52" y="47" width="96" height="104.8" fill="#000"/></svg>';
export const LOGO = `<span class="logo">${APP_ICON}<span class="wordmark">СКАМ</span></span>`;

export const ICONS = {
  /** Официальная галочка: розетка в цветах логотипа и тёмная галочка. */
  verified: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.6L14.23 3.69L17.2 2.99L18.08 5.92L21.01 6.8L20.31 9.77L22.4 12L20.31 14.23L21.01 17.2L18.08 18.08L17.2 21.01L14.23 20.31L12 22.4L9.77 20.31L6.8 21.01L5.92 18.08L2.99 17.2L3.69 14.23L1.6 12L3.69 9.77L2.99 6.8L5.92 5.92L6.8 2.99L9.77 3.69Z" fill="url(#skamGrad)" stroke="url(#skamGrad)" stroke-width="2" stroke-linejoin="round"/><path d="M7.7 12.3l2.9 2.9 5.8-6.2" fill="none" stroke="#000" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  back: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  send: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>',
  close: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  sun: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/></svg>',
  moon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/></svg>',
  sticker: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.4V8a5 5 0 0 0-5-5H8a5 5 0 0 0-5 5v8a5 5 0 0 0 5 5h4.4"/><path d="M21 12.4 12.4 21A8.6 8.6 0 0 1 21 12.4z" fill="currentColor" fill-opacity=".14"/><path d="M8.4 14.6a4.6 4.6 0 0 0 4.2 1.9"/><path d="M9 9.2h.01M15 9.2h.01" stroke-width="2.8"/></svg>',
  mic: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8.5" y="2.5" width="7" height="12" rx="3.5"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5"/></svg>',
  circle: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><rect x="7" y="9" width="7" height="6" rx="1.4"/><path d="M14 11.2l3-1.7v5l-3-1.7"/></svg>',
  trash: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  lock: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/></svg>',
  up: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>',
  play: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5.6v12.8a1 1 0 0 0 1.5.86l10.2-6.4a1 1 0 0 0 0-1.72L9.5 4.74A1 1 0 0 0 8 5.6z"/></svg>',
  pause: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><rect fill="currentColor" x="6.5" y="5" width="4" height="14" rx="1.3"/><rect fill="currentColor" x="13.5" y="5" width="4" height="14" rx="1.3"/></svg>',
  muted: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M17 9.5l4 5M21 9.5l-4 5"/></svg>',
  clip: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.9-8.9a3.7 3.7 0 0 1 5.2 5.2l-8.9 8.9a1.8 1.8 0 0 1-2.6-2.6l8.2-8.2"/></svg>',
  lockBig: '<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10.5" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.4" r="1.3" fill="currentColor"/><path d="M12 16.6v1.6"/></svg>',
  download: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="M7 10.5l5 5 5-5"/><path d="M5 20h14"/></svg>',
  prev: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  next: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>',  reply: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
  forward: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/></svg>',
  check: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.8 2.8L16.5 9.5"/></svg>',
  copy: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/></svg>',
  phone: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>',
  phoneIn: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/><path d="M21 3l-6 6M15 5v4h4"/></svg>',
  phoneOut: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/><path d="M15 9l6-6M17 3h4v4"/></svg>',
  phoneMissed: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/><path d="M15 3l6 6M21 3l-6 6"/></svg>',
  hangup: '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 8.5c-3.6 0-6.9 1.1-9.3 3a1.6 1.6 0 0 0-.5 1.9l1 2.3a1.6 1.6 0 0 0 1.9.9l3.3-1a1.6 1.6 0 0 0 1.1-1.4l.2-1.8a12 12 0 0 1 4.6 0l.2 1.8a1.6 1.6 0 0 0 1.1 1.4l3.3 1a1.6 1.6 0 0 0 1.9-.9l1-2.3a1.6 1.6 0 0 0-.5-1.9c-2.4-1.9-5.7-3-9.3-3z"/></svg>',
  video: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="6" width="13" height="12" rx="2.5"/><path d="M15.5 10.5l6-3.5v10l-6-3.5"/></svg>',
  videoOff: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.5 13.5v2A2.5 2.5 0 0 1 13 18H5a2.5 2.5 0 0 1-2.5-2.5v-7A2.5 2.5 0 0 1 5 6h1.5M10 6h3a2.5 2.5 0 0 1 2.5 2.5v2l6-3.5v10"/><path d="M3 3l18 18"/></svg>',
  screen: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="4" width="19" height="13" rx="2.5"/><path d="M8 21h8M12 17v4"/><path d="M12 13.5V8M9.5 10.5L12 8l2.5 2.5"/></svg>',
  screenOff: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="4" width="19" height="13" rx="2.5"/><path d="M8 21h8M12 17v4"/><path d="M9.5 8.5l5 5M14.5 8.5l-5 5"/></svg>',
  micOn: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8.5" y="2.5" width="7" height="12" rx="3.5"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5"/></svg>',
  micOff: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.5 10V6a3.5 3.5 0 0 0-6.8-1.2M8.5 8.5V11a3.5 3.5 0 0 0 5.6 2.8"/><path d="M5 11a7 7 0 0 0 11.4 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3.5M3 3l18 18"/></svg>',
  headphones: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="5" height="7" rx="2"/><rect x="16" y="14" width="5" height="7" rx="2"/></svg>',
  headphonesOff: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 15v-3a8 8 0 0 1 12.4-6.7M19.4 9a8 8 0 0 1 .6 3v3"/><rect x="3" y="14" width="5" height="7" rx="2"/><path d="M16 16v3a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3"/><path d="M3 3l18 18"/></svg>',
  gear: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  expand: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
  collapse: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>',
  signal: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="3" y="14" width="4" height="7" rx="1"/><rect x="10" y="9" width="4" height="12" rx="1"/><rect x="17" y="4" width="4" height="17" rx="1"/></svg>',
  support: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.6L3 20.5l1.4-5A8.5 8.5 0 1 1 21 11.5z"/><path d="M9.9 9.3a2.2 2.2 0 0 1 4.3.7c0 1.5-2.2 1.9-2.2 3.2"/><path d="M12 16h.01" stroke-width="2.8"/></svg>',
  star: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.9l2.8 5.7 6.3.9-4.6 4.5 1.1 6.3L12 17.3l-5.6 3 1.1-6.3-4.6-4.5 6.3-.9z"/></svg>',
  starFill: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" d="M12 2.9l2.8 5.7 6.3.9-4.6 4.5 1.1 6.3L12 17.3l-5.6 3 1.1-6.3-4.6-4.5 6.3-.9z"/></svg>',
  done: '<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M7.5 12.5l3 3 6-6.5"/></svg>',
  edit: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
  search: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.3"/><path d="M20 20l-4.6-4.6"/></svg>',
  pin: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 3.5l6 6-2.2.8-3.6 3.6.4 3.9-1.6 1.6-3.3-3.3L5 21l-.1-.1 4.8-5.2-3.3-3.3L8 10.8l3.9.4 3.6-3.6z"/></svg>',
  unpin: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 3.5l6 6-2.2.8-1.9 1.9M13.6 13.6l.1 3.3-1.6 1.6-3.3-3.3L5 21M8.8 11.2L8 10.8l-1.6 1.6 3.3 3.3"/><path d="M3.5 3.5l17 17"/></svg>',
  pinMark: '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M14.9 2.8a1 1 0 0 0-1.6.3l-1 2.3-3.9 3.9-4 .1a1 1 0 0 0-.7 1.7l3.6 3.6-4.6 4.9a.8.8 0 0 0 1.1 1.1l4.9-4.6 3.6 3.6a1 1 0 0 0 1.7-.7l.1-4 3.9-3.9 2.3-1a1 1 0 0 0 .3-1.6z"/></svg>',
  folder: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 7.5a2 2 0 0 1 2-2h3.8l2.2 2.4h7a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>',
  folderAdd: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 12V9.9a2 2 0 0 0-2-2h-7L9.3 5.5H5.5a2 2 0 0 0-2 2v9.6a2 2 0 0 0 2 2H12"/><path d="M18 15v6M15 18h6"/></svg>',
  folderOut: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 12V9.9a2 2 0 0 0-2-2h-7L9.3 5.5H5.5a2 2 0 0 0-2 2v9.6a2 2 0 0 0 2 2H12"/><path d="M15 18h6"/></svg>',
  chats: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.5 9.5a6 6 0 0 1-8.8 5.3L3 16l1-3.4A6 6 0 1 1 15.5 9.5z"/><path d="M9.6 17.3a6 6 0 0 0 7.7 1.5L21 20l-1-3.4a6 6 0 0 0-2.4-8.3"/></svg>',
  read: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 12.5l4 4 8-9"/><path d="M11.5 15.5l1 1 8-9"/></svg>',
  sliders: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/></svg>',
  grip: '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></g></svg>',
  down: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  bell: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>',
  dots: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></g></svg>',
  eye: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  heart: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20.5s-8.5-5-8.5-11A4.8 4.8 0 0 1 12 6.6a4.8 4.8 0 0 1 8.5 2.9c0 6-8.5 11-8.5 11z"/></svg>',
  heartFill: '<svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 20.5s-8.5-5-8.5-11A4.8 4.8 0 0 1 12 6.6a4.8 4.8 0 0 1 8.5 2.9c0 6-8.5 11-8.5 11z"/></svg>',
  sound: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>',
  soundOff: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9.5l4 5M21 9.5l-4 5"/></svg>',
  photo: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="15" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="M21 15.5l-4.5-4.5L7 19.5"/></svg>',
  megaphone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10v4a1 1 0 0 0 1 1h2l6 4.5V4.5L7 9H5a1 1 0 0 0-1 1z" fill="currentColor"/><path d="M17 9a4 4 0 0 1 0 6M19.5 6.5a7.5 7.5 0 0 1 0 11"/><path d="M8 15.5l1.2 4.5"/></svg>',
  dotsV: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></g></svg>',
  smile: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9 9.8h.01M15 9.8h.01M8.8 14.6a4.2 4.2 0 0 0 6.4 0"/></svg>',
  bellOff: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.3 4.6A6 6 0 0 1 18 10v2.9c0 .8.3 1.6.8 2.2l.7.9M15.5 17.5H4.6a.6.6 0 0 1-.5-.9l1.1-1.5c.5-.6.8-1.4.8-2.2V10c0-.6.1-1.2.3-1.7M9.7 20.5a2.6 2.6 0 0 0 4.6 0M3 3l18 18"/></svg>',
  ban: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M5.7 5.7l12.6 12.6"/></svg>',
  users: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.6"/><path d="M2.8 19.8a6.2 6.2 0 0 1 12.4 0M15.8 4.6a3.6 3.6 0 0 1 0 6.8M18.3 14.3a6.2 6.2 0 0 1 2.9 5.5"/></svg>',
  userPlus: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9.5" cy="8" r="3.6"/><path d="M3.3 19.8a6.2 6.2 0 0 1 12.4 0M19 7.5v6M16 10.5h6"/></svg>',
  link: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a4.2 4.2 0 0 0 6 0l3-3a4.2 4.2 0 0 0-6-6l-1 1M14 10a4.2 4.2 0 0 0-6 0l-3 3a4.2 4.2 0 0 0 6 6l1-1"/></svg>',
  camera: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8.6A1.6 1.6 0 0 1 5.6 7h1.6L8.8 4.5h6.4L16.8 7h1.6A1.6 1.6 0 0 1 20 8.6v9A1.6 1.6 0 0 1 18.4 19.2H5.6A1.6 1.6 0 0 1 4 17.6z"/><circle cx="12" cy="13" r="3.4"/></svg>',
  palette: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21a9 9 0 1 1 9-9c0 2.4-1.8 3.6-3.8 3.6h-2a1.8 1.8 0 0 0-1.3 3.1A1.4 1.4 0 0 1 12 21z"/><path d="M7.6 11.2h.01M10 7.4h.01M14.6 7.4h.01" stroke-width="2.8"/></svg>',
  help: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1.1.9-1.1 1.6v.4M12 16.9h.01"/></svg>',
  info: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.4M12 7.9h.01"/></svg>',
  logout: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 8V6.2A2.2 2.2 0 0 0 11.8 4H6.2A2.2 2.2 0 0 0 4 6.2v11.6A2.2 2.2 0 0 0 6.2 20h5.6a2.2 2.2 0 0 0 2.2-2.2V16M9.5 12H21M18 9l3 3-3 3"/></svg>',
  storyAdd: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.6 3.7a9 9 0 0 1 6.8 0M18.4 5.6a9 9 0 0 1 2.4 4.7M20.8 13.7a9 9 0 0 1-2.4 4.7M15.4 20.3a9 9 0 0 1-6.8 0M5.6 18.4a9 9 0 0 1-2.4-4.7M3.2 10.3a9 9 0 0 1 2.4-4.7M12 8.6v6.8M8.6 12h6.8"/></svg>',
  chev: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 6l6 6-6 6"/></svg>',
  tag: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.6 12.4V5.2a1.6 1.6 0 0 1 1.6-1.6h7.2c.4 0 .8.2 1.1.5l7 7a1.6 1.6 0 0 1 0 2.2l-7.2 7.2a1.6 1.6 0 0 1-2.2 0l-7-7a1.6 1.6 0 0 1-.5-1.1z"/><path d="M8.2 8.2h.01" stroke-width="2.8"/></svg>',
  message: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 9.5h8M8 13.5h5"/><path d="M17.5 4a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-5L7 21.2V18H6.5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z"/></svg>',
  media: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="10" r="1.7"/><path d="M20.5 15.5l-4.6-4.6L6 19.4"/></svg>',
  file: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3.5H7.2a2.2 2.2 0 0 0-2.2 2.2v12.6a2.2 2.2 0 0 0 2.2 2.2h9.6a2.2 2.2 0 0 0 2.2-2.2V8.5z"/><path d="M14 3.5v5h5"/></svg>',
  sideOpen: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16M14 10l2 2-2 2"/></svg>',
  sideClose: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16M16 10l-2 2 2 2"/></svg>',
};

/** Знак СКАМ (пузырь-кольцо с хвостиком) — чёрный, для официальных аватарок на градиенте. */
export const MARK_SVG = '<svg viewBox="-1 -1 131 143" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M9.84 98.75A64.5 64.5 0 1 1 39.9 124.1L0.5 140.5Z M34 64.5A30.5 30.5 0 1 0 95 64.5A30.5 30.5 0 1 0 34 64.5Z"/></svg>';

/** Официальная галочка рядом с именем. Выдаёт только владелец СКАМ — подделать её нельзя. */
export function verifiedMark(kind: 'user' | 'channel' | 'bot' = 'user'): HTMLElement {
  const s = el('span', 'vmark');
  s.append(html(ICONS.verified));
  const label = kind === 'channel' ? 'Официальный канал' : kind === 'bot' ? 'Официальный бот СКАМ' : 'Официальный аккаунт';
  s.title = label;
  s.setAttribute('role', 'img');
  s.setAttribute('aria-label', label);
  return s;
}

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

/** Шапка диалога: заголовок и крестик. */
export function dlgHead(title: string, dlg: HTMLDialogElement, closable = true): HTMLElement {
  const head = el('div', 'dlg-head');
  head.append(el('h2', null, title));
  if (closable) {
    const x = button('icon-btn', null, () => closeDialog(dlg));
    x.setAttribute('aria-label', 'Закрыть');
    x.append(html(ICONS.close));
    head.append(x);
  }
  return head;
}

/** Понятный текст ошибки для человека. */
export function errText(e: unknown, fallback = 'Не получилось. Проверьте соединение и попробуйте ещё раз.'): string {
  const err = e as { code?: string; message?: string } | null;
  if (!err) return fallback;
  if (err.message?.includes('Failed to fetch')) return 'Нет связи с сервером.';
  if (err.code === '42501' || err.message?.includes('row-level security')) return 'Недостаточно прав для этого действия.';
  if (err.code === 'P0002') return 'Не найдено.';
  if (err.message && /^[А-Яа-яЁё]/.test(err.message)) return err.message;
  return fallback;
}

/**
 * Что делать с @username и своими эмодзи в тексте — задаёт приложение (здесь нет доступа к профилям и наборам).
 * mention: нажали на @username. emoji: нарисовать своё эмодзи по метке <:название:набор/эмодзи>.
 */
export const textHooks: {
  mention?: (username: string) => void;
  emoji?: (name: string, ref: string, big: boolean) => Node;
} = {};

// Ссылка; метка своего эмодзи; @username (не часть почты и не внутри слова).
const TEXT_RE = /(https?:\/\/[^\s<>"']+)|<:([a-z0-9_а-яё]{2,32}):(u[0-9a-f]{11}\/[a-z0-9]{10})>|(?<![\p{L}\p{N}_@./\\])@([A-Za-z][A-Za-z0-9_]{4,31})(?![\p{L}\p{N}_])/gu;

/** Текст сообщения: ссылки, @username и свои эмодзи. big — только эмодзи (1–3 штуки), рисуем крупно. */
export function fillText(node: HTMLElement, text: string, big = false): void {
  let last = 0;
  let m: RegExpExecArray | null;
  TEXT_RE.lastIndex = 0;
  while ((m = TEXT_RE.exec(text))) {
    node.append(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1]) {
      const a = el('a', null, m[1]);
      a.href = m[1];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      node.append(a);
    } else if (m[3]) {
      node.append(textHooks.emoji ? textHooks.emoji(m[2], m[3], big) : `:${m[2]}:`);
    } else if (m[4]) {
      const u = m[4].toLowerCase();
      if (!textHooks.mention) { node.append(m[0]); continue; }
      const a = el('a', 'mention', m[0]);
      a.href = `#@${u}`;
      a.title = `Открыть @${u}`;
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        textHooks.mention?.(u);
      });
      node.append(a);
    }
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

/** Длительность голосового или кружочка: 0:07, 1:25, 10:00. */
export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} ${one}`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}
