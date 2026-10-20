// Статьи в стиле Telegraph (0.4.0): формат, показ, разбор правок и запросы к серверу.
// Модуль общий для приложения и отдельной страницы статьи /a/<адрес> — приложение за собой не тянет.
//
// Формат — как у Telegraph: массив узлов; узел — строка или { tag, attrs?, children? }.
// Блоки: p, h3, h4, blockquote, aside (выделенная цитата), ul/ol + li, pre, figure (img + figcaption), hr.
// Внутри строки: b, i, u, s, code, a (href), br, span (font — шрифт фрагмента, 0.5.1). Всё остальное при разборе
// отбрасывается (остаётся текст). Шрифт всей статьи — отдельное поле font (null — с засечками, как раньше).
// Пользовательский текст никогда не попадает в innerHTML — только textContent и проверенные атрибуты.
import './article.css';
import { sb } from './supabase';
import type { ArticleCard, ArticleFont, ArticleFull, ArticleNode, Json } from './database.types';

export type { ArticleCard, ArticleFont, ArticleFull, ArticleNode };

/** Основной адрес сайта: ссылки на статьи всегда ведут туда (тестовая копия и локальная сборка — та же база). */
export const SITE = 'https://skam-messenger.ru';
export const IMG_RE = /^[0-9a-f-]{36}\.(webp|jpg|png|gif)$/;
export const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{1,118}[A-Za-z0-9]$/;
export const TITLE_MAX = 256;
export const AUTHOR_MAX = 128;
/** Сервер принимает до 128 КБ JSON — оставляем запас. */
export const CONTENT_MAX_BYTES = 120_000;

const BLOCKS = new Set(['p', 'h3', 'h4', 'blockquote', 'aside', 'ul', 'ol', 'pre', 'figure', 'hr']);
const INLINE = new Set(['b', 'i', 'u', 's', 'code', 'a', 'br']);

// ---------------------------------------------------------------------------
// Шрифты (0.5.1): у всей статьи (автор), у фрагмента (span font) и у читателя (на его устройстве)
// ---------------------------------------------------------------------------

/** Шрифты статей. Файлы — у нас на сервере (public/fonts, лицензия OFL), браузер качает только нужные. */
export const ARTICLE_FONTS: { id: ArticleFont; label: string }[] = [
  { id: 'serif', label: 'С засечками' },
  { id: 'sans', label: 'Без засечек' },
  { id: 'mono', label: 'Моноширинный' },
  { id: 'hand', label: 'Рукописный' },
  { id: 'wide', label: 'Широкий' },
];
const FONT_IDS = new Set<string>(ARTICLE_FONTS.map((f) => f.id));

export function isArticleFont(v: unknown): v is ArticleFont {
  return typeof v === 'string' && FONT_IDS.has(v);
}

export function fontLabel(f: ArticleFont | null | undefined): string {
  return ARTICLE_FONTS.find((x) => x.id === f)?.label ?? 'С засечками';
}

/** Как читатель настроил статьи под себя: шрифт (auto — как у автора) и размер текста (0…4, 2 — обычный). */
export type ReaderPrefs = { font: 'auto' | 'serif' | 'sans'; size: number };
const READER_KEY = 'skam:reader';
export const READER_SIZES = [0.86, 0.94, 1, 1.12, 1.25];

export function readerPrefs(): ReaderPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(READER_KEY) ?? 'null') as Partial<ReaderPrefs> | null;
    const font = p?.font === 'serif' || p?.font === 'sans' ? p.font : 'auto';
    const size = typeof p?.size === 'number' && p.size >= 0 && p.size < READER_SIZES.length ? Math.round(p.size) : 2;
    return { font, size };
  } catch {
    return { font: 'auto', size: 2 };
  }
}

export function setReaderPrefs(p: ReaderPrefs): void {
  try { localStorage.setItem(READER_KEY, JSON.stringify(p)); } catch { /* без хранилища — только до перезагрузки */ }
}

/** Шрифт автора и настройки читателя → классы и размер у <article class="tl">. */
export function applyArticleLook(art: HTMLElement, authorFont: ArticleFont | null | undefined, reader: ReaderPrefs | null = readerPrefs()): void {
  [...art.classList].filter((c) => c.startsWith('tl-font-') || c.startsWith('tl-read-')).forEach((c) => art.classList.remove(c));
  if (isArticleFont(authorFont) && authorFont !== 'serif') art.classList.add(`tl-font-${authorFont}`);
  if (reader && reader.font !== 'auto') art.classList.add(`tl-read-${reader.font}`);
  art.style.setProperty('--tl-k', String(READER_SIZES[reader?.size ?? 2] ?? 1));
}

/**
 * Кнопка «Aa» и окошко настроек чтения: шрифт (как у автора / с засечками / без засечек) и размер текста.
 * onChange — перерисовать статьи (настройки уже сохранены).
 */
export function readerMenu(onChange: () => void): HTMLElement {
  const box = document.createElement('div');
  box.className = 'tl-reader';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'tl-reader-btn';
  toggle.textContent = 'Aa';
  toggle.title = 'Шрифт и размер текста';
  toggle.setAttribute('aria-label', 'Шрифт и размер текста');
  toggle.setAttribute('aria-haspopup', 'true');
  toggle.setAttribute('aria-expanded', 'false');
  const pop = document.createElement('div');
  pop.className = 'tl-reader-pop';
  pop.hidden = true;
  const render = () => {
    const p = readerPrefs();
    const fonts = document.createElement('div');
    fonts.className = 'tl-reader-fonts';
    fonts.setAttribute('role', 'radiogroup');
    fonts.setAttribute('aria-label', 'Шрифт');
    ([['auto', 'Как у автора'], ['serif', 'С засечками'], ['sans', 'Без засечек']] as const).forEach(([id, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `tl-reader-font${id === 'auto' ? '' : ` tl-f-${id}`}`;
      b.textContent = label;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(p.font === id));
      b.addEventListener('click', () => { setReaderPrefs({ ...p, font: id }); render(); onChange(); });
      fonts.append(b);
    });
    const size = document.createElement('div');
    size.className = 'tl-reader-size';
    const minus = document.createElement('button');
    minus.type = 'button';
    minus.className = 'tl-reader-step small';
    minus.textContent = 'A−';
    minus.setAttribute('aria-label', 'Мельче');
    minus.disabled = p.size <= 0;
    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'tl-reader-step';
    plus.textContent = 'A+';
    plus.setAttribute('aria-label', 'Крупнее');
    plus.disabled = p.size >= READER_SIZES.length - 1;
    const dots = document.createElement('span');
    dots.className = 'tl-reader-dots';
    dots.setAttribute('aria-label', `Размер ${p.size + 1} из ${READER_SIZES.length}`);
    READER_SIZES.forEach((_, i) => {
      const d = document.createElement('i');
      if (i <= p.size) d.className = 'on';
      dots.append(d);
    });
    const step = (d: number) => { setReaderPrefs({ ...p, size: Math.max(0, Math.min(READER_SIZES.length - 1, p.size + d)) }); render(); onChange(); };
    minus.addEventListener('click', () => step(-1));
    plus.addEventListener('click', () => step(1));
    size.append(minus, dots, plus);
    const hint = document.createElement('p');
    hint.className = 'tl-reader-hint';
    hint.textContent = 'Только у вас, на этом устройстве.';
    pop.replaceChildren(fonts, size, hint);
  };
  const close = () => { pop.hidden = true; toggle.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', outside, true); };
  const outside = (e: Event) => { if (!box.contains(e.target as Node)) close(); };
  toggle.addEventListener('click', () => {
    if (!pop.hidden) { close(); return; }
    render();
    pop.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
  });
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { e.stopPropagation(); close(); toggle.focus(); } });
  box.append(toggle, pop);
  return box;
}

export function articleUrl(slug: string): string {
  return `${SITE}/a/${slug}`;
}

export function articleImageUrl(path: string): string {
  return sb.storage.from('articles').getPublicUrl(path).data.publicUrl;
}

// Ссылка на статью в тексте: основной адрес, www, тестовая копия и адрес, где открыт СКАМ сейчас (локальная сборка).
const HOSTS = [...new Set(['skam-messenger.ru', 'www.skam-messenger.ru', 'test.skam-messenger.ru', location.host])]
  .map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const LINK_RE = new RegExp(`^https?://(?:${HOSTS.join('|')})/a/([A-Za-z0-9][A-Za-z0-9-]{1,118}[A-Za-z0-9])/?(?:[?#].*)?$`);

/** Адрес статьи из ссылки (или null, если это не ссылка на статью СКАМ). */
export function slugFromUrl(url: string): string | null {
  const m = LINK_RE.exec(url.trim());
  return m ? m[1] : null;
}

/** Ссылки на статьи в тексте сообщения — по порядку, без повторов. */
export function articleLinks(text: string): { url: string; slug: string }[] {
  const out: { url: string; slug: string }[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    const slug = slugFromUrl(m[0].replace(/[.,!?;:)»]+$/, ''));
    if (slug && !out.some((x) => x.slug.toLowerCase() === slug.toLowerCase())) out.push({ url: m[0], slug });
  }
  return out;
}

const fmtDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
export function articleDate(iso: string): string {
  return fmtDate.format(new Date(iso)).replace(/\s*г\.$/, '');
}

export function safeHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  const h = href.trim();
  if (h.length > 2048 || /\s/.test(h)) return null;
  return /^(https?:\/\/|mailto:)\S+$/i.test(h) ? h : null;
}

/** Ссылка автора: https://… или @username (у @username — ссылка на профиль в СКАМ). */
export function authorHref(v: string | null | undefined): string | null {
  if (!v) return null;
  if (/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(v)) return `${SITE}/?c=${v.slice(1)}`;
  return safeHref(v);
}

// ---------------------------------------------------------------------------
// Показ
// ---------------------------------------------------------------------------

export type RenderOpts = {
  /** Для редактора: картинки — с подписью, которую можно править, и кнопкой «убрать». */
  edit?: boolean;
  /** Нажали на ссылку: true — обработано (например, открыли статью внутри СКАМ). */
  onLink?: (href: string, ev: MouseEvent) => boolean;
};

function text(s: string): Text {
  return document.createTextNode(s);
}

function childrenOf(n: ArticleNode): ArticleNode[] {
  return typeof n === 'string' || !Array.isArray(n.children) ? [] : n.children;
}

/** Картинка статьи в редакторе: не редактируется сама, но подпись под ней — да. */
export function editorFigure(path: string | null, src: string, caption: ArticleNode[] = []): HTMLElement {
  const fig = document.createElement('figure');
  fig.contentEditable = 'false';
  fig.className = 'tl-fig';
  if (path) fig.dataset.src = path;
  else fig.classList.add('uploading');
  const img = document.createElement('img');
  img.src = src;
  img.alt = '';
  img.draggable = false;
  const cap = document.createElement('figcaption');
  cap.contentEditable = 'true';
  cap.dataset.ph = 'Подпись к картинке (необязательно)';
  caption.forEach((c) => appendNode(cap, c, {}));
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'tl-fig-x';
  x.title = 'Убрать картинку';
  x.setAttribute('aria-label', 'Убрать картинку');
  x.textContent = '×';
  const wait = document.createElement('span');
  wait.className = 'tl-fig-wait';
  wait.textContent = 'Загружаем…';
  fig.append(img, cap, x, wait);
  return fig;
}

function appendNode(parent: Node, n: ArticleNode, o: RenderOpts): void {
  if (typeof n === 'string') { parent.appendChild(text(n)); return; }
  if (!n || typeof n !== 'object' || typeof n.tag !== 'string') return;
  const tag = n.tag;
  if (tag === 'figure') {
    const kids = childrenOf(n);
    const img = kids.find((k) => typeof k !== 'string' && k.tag === 'img') as Exclude<ArticleNode, string> | undefined;
    const cap = kids.find((k) => typeof k !== 'string' && k.tag === 'figcaption');
    const src = img?.attrs?.src;
    if (!src || !IMG_RE.test(src)) return;
    if (o.edit) { parent.appendChild(editorFigure(src, articleImageUrl(src), cap ? childrenOf(cap) : [])); return; }
    const fig = document.createElement('figure');
    const im = document.createElement('img');
    im.src = articleImageUrl(src);
    im.alt = cap ? plainOf(childrenOf(cap)) : '';
    im.loading = 'lazy';
    im.decoding = 'async';
    fig.appendChild(im);
    if (cap && plainOf(childrenOf(cap)).trim()) {
      const fc = document.createElement('figcaption');
      childrenOf(cap).forEach((c) => appendNode(fc, c, o));
      fig.appendChild(fc);
    }
    parent.appendChild(fig);
    return;
  }
  if (tag === 'img') {
    // Картинка вне figure — показываем так же.
    appendNode(parent, { tag: 'figure', children: [n] }, o);
    return;
  }
  if (tag === 'span') {
    // Шрифт фрагмента. Неизвестный шрифт — просто текст.
    const font = n.attrs?.font;
    if (!isArticleFont(font)) { childrenOf(n).forEach((c) => appendNode(parent, c, o)); return; }
    const sp = document.createElement('span');
    sp.className = `tl-f tl-f-${font}`;
    sp.dataset.font = font;
    childrenOf(n).forEach((c) => appendNode(sp, c, o));
    parent.appendChild(sp);
    return;
  }
  if (!BLOCKS.has(tag) && !INLINE.has(tag) && tag !== 'li' && tag !== 'figcaption') {
    childrenOf(n).forEach((c) => appendNode(parent, c, o));
    return;
  }
  const e = document.createElement(tag === 'figcaption' ? 'span' : tag);
  if (tag === 'a') {
    const href = safeHref(n.attrs?.href);
    if (href) {
      (e as HTMLAnchorElement).href = href;
      if (!o.edit) {
        (e as HTMLAnchorElement).target = '_blank';
        (e as HTMLAnchorElement).rel = 'noopener noreferrer nofollow ugc';
        if (o.onLink) e.addEventListener('click', (ev) => { if (o.onLink!(href, ev)) ev.preventDefault(); });
      }
    }
  }
  if (tag !== 'br' && tag !== 'hr') childrenOf(n).forEach((c) => appendNode(e, c, o));
  if (tag === 'p' && o.edit && !e.childNodes.length) e.appendChild(document.createElement('br'));
  parent.appendChild(e);
}

/** Статья в DOM (только разрешённые теги и атрибуты). */
export function renderNodes(nodes: ArticleNode[], o: RenderOpts = {}): DocumentFragment {
  const f = document.createDocumentFragment();
  (Array.isArray(nodes) ? nodes : []).forEach((n) => appendNode(f, n, o));
  return f;
}

/** Текст узлов одной строкой (для подписи картинки, описания). */
export function plainOf(nodes: ArticleNode[]): string {
  return nodes.map((n) => (typeof n === 'string' ? n : n.tag === 'br' ? ' ' : plainOf(childrenOf(n)))).join('');
}

// ---------------------------------------------------------------------------
// Разбор: DOM редактора (или вставленный HTML) → узлы
// ---------------------------------------------------------------------------

type Inline = ArticleNode[];

function pushText(out: Inline, s: string): void {
  if (!s) return;
  const last = out[out.length - 1];
  if (typeof last === 'string') out[out.length - 1] = last + s;
  else out.push(s);
}

const INLINE_TAGS: Record<string, string> = { B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u', INS: 'u', S: 's', STRIKE: 's', DEL: 's', CODE: 'code', KBD: 'code', TT: 'code' };
const BLOCK_ELEMS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'ASIDE', 'UL', 'OL', 'LI', 'PRE', 'FIGURE', 'HR', 'TABLE', 'TR', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'NAV', 'DL', 'DT', 'DD', 'ADDRESS', 'FIGCAPTION']);
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'HEAD', 'TITLE', 'META', 'LINK']);

function styleWrap(e: HTMLElement, kids: Inline): Inline {
  // Вставка из Google Docs и Word: жирный и курсив задаются стилем.
  const st = e.getAttribute('style') ?? '';
  let out = kids;
  if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(st) && e.tagName !== 'B') out = [{ tag: 'b', children: out }];
  if (/font-style\s*:\s*italic/i.test(st)) out = [{ tag: 'i', children: out }];
  return out;
}

/** Строчное содержимое элемента: блоки внутри строки становятся переносами. */
function inlineOf(node: Node, out: Inline, o: { paste: boolean }): void {
  node.childNodes.forEach((c) => {
    if (c.nodeType === Node.TEXT_NODE) { pushText(out, (c.textContent ?? '').replace(/\u200b/g, '')); return; }
    if (c.nodeType !== Node.ELEMENT_NODE) return;
    const e = c as HTMLElement;
    if (SKIP.has(e.tagName) || e.classList.contains('tl-fig-x') || e.classList.contains('tl-fig-wait')) return;
    if (e.tagName === 'BR') { out.push({ tag: 'br' }); return; }
    if (e.tagName === 'IMG' || e.tagName === 'FIGURE') return;
    const kids: Inline = [];
    inlineOf(e, kids, o);
    if (BLOCK_ELEMS.has(e.tagName)) {
      if (out.length && !(typeof out[out.length - 1] !== 'string' && (out[out.length - 1] as { tag: string }).tag === 'br')) out.push({ tag: 'br' });
      out.push(...kids);
      return;
    }
    const tag = INLINE_TAGS[e.tagName];
    if (e.tagName === 'A') {
      const href = safeHref(e.getAttribute('href'));
      if (href && kids.length) { out.push({ tag: 'a', attrs: { href }, children: kids }); return; }
      out.push(...kids);
      return;
    }
    if (tag) { if (kids.length) out.push({ tag, children: kids }); return; }
    // Шрифт фрагмента: наш span (data-font) или <font face>, который ставит браузер в редакторе.
    const font = e.tagName === 'SPAN' ? e.dataset.font : e.tagName === 'FONT' ? e.getAttribute('face') : null;
    if (isArticleFont(font) && kids.length) {
      out.push(...(o.paste ? styleWrap(e, [{ tag: 'span', attrs: { font }, children: kids }]) : [{ tag: 'span', attrs: { font }, children: kids }]));
      return;
    }
    out.push(...(o.paste ? styleWrap(e, kids) : kids));
  });
}

function trimInline(kids: Inline): Inline {
  const out = [...kids];
  while (out.length && typeof out[0] !== 'string' && out[0].tag === 'br') out.shift();
  while (out.length && typeof out[out.length - 1] !== 'string' && (out[out.length - 1] as { tag: string }).tag === 'br') out.pop();
  return out;
}

function isBlank(kids: Inline): boolean {
  return !plainOf(kids).replace(/ /g, ' ').trim();
}

/**
 * DOM → узлы статьи. paste — разбираем чужой HTML (вставку): картинки не берём (только свои загруженные),
 * стилевой жирный и курсив превращаем в b и i.
 */
export function domToNodes(root: Node, o: { paste?: boolean } = {}): ArticleNode[] {
  const out: ArticleNode[] = [];
  const opt = { paste: !!o.paste };
  let loose: Inline = [];
  const flush = () => {
    const kids = trimInline(loose);
    if (!isBlank(kids)) out.push({ tag: 'p', children: kids });
    loose = [];
  };
  const block = (tag: string, e: Node) => {
    const kids: Inline = [];
    inlineOf(e, kids, opt);
    const t = trimInline(kids);
    if (!isBlank(t)) out.push({ tag, children: t });
  };
  const list = (tag: 'ul' | 'ol', e: HTMLElement) => {
    const items: ArticleNode[] = [];
    const walk = (l: HTMLElement) => l.childNodes.forEach((c) => {
      if (c.nodeType !== Node.ELEMENT_NODE) return;
      const li = c as HTMLElement;
      if (li.tagName === 'UL' || li.tagName === 'OL') { walk(li); return; }
      // Вложенные списки — тем же уровнем (как в Telegraph).
      const clone = li.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('ul,ol').forEach((x) => x.remove());
      const kids: Inline = [];
      inlineOf(clone, kids, opt);
      const t = trimInline(kids);
      if (!isBlank(t)) items.push({ tag: 'li', children: t });
      li.querySelectorAll(':scope > ul, :scope > ol').forEach((sub) => walk(sub as HTMLElement));
    });
    walk(e);
    if (items.length) out.push({ tag, children: items });
  };
  const visit = (parent: Node) => parent.childNodes.forEach((c) => {
    if (c.nodeType === Node.TEXT_NODE) { pushText(loose, (c.textContent ?? '').replace(/\u200b/g, '')); return; }
    if (c.nodeType !== Node.ELEMENT_NODE) return;
    const e = c as HTMLElement;
    if (SKIP.has(e.tagName)) return;
    if (!BLOCK_ELEMS.has(e.tagName) && e.tagName !== 'IMG') {
      // Строчный элемент на верхнем уровне — копим в абзац.
      const holder = document.createElement('span');
      holder.appendChild(e.cloneNode(true));
      inlineOf(holder, loose, opt);
      return;
    }
    flush();
    switch (e.tagName) {
      case 'H1': case 'H2': case 'H3': block('h3', e); break;
      case 'H4': case 'H5': case 'H6': block('h4', e); break;
      case 'BLOCKQUOTE': block('blockquote', e); break;
      case 'ASIDE': block('aside', e); break;
      case 'UL': list('ul', e); break;
      case 'OL': list('ol', e); break;
      case 'PRE': {
        // Код — простой текст; <br> (так переносит строку часть браузеров) — тоже перенос.
        let raw = '';
        const walk = (n: Node) => n.childNodes.forEach((k) => {
          if (k.nodeType === Node.TEXT_NODE) raw += k.textContent ?? '';
          else if ((k as Element).tagName === 'BR') raw += '\n';
          else walk(k);
        });
        walk(e);
        const t = raw.replace(/\u200b/g, '').replace(/\n+$/, '');
        if (t.trim()) out.push({ tag: 'pre', children: [t] });
        break;
      }
      case 'HR': out.push({ tag: 'hr' }); break;
      case 'FIGURE': case 'IMG': {
        const path = e.dataset.src ?? '';
        if (opt.paste || !IMG_RE.test(path)) break;
        const cap = e.querySelector('figcaption');
        const kids: Inline = [];
        if (cap) inlineOf(cap, kids, opt);
        const t = trimInline(kids);
        const fig: ArticleNode[] = [{ tag: 'img', attrs: { src: path } }];
        if (!isBlank(t)) fig.push({ tag: 'figcaption', children: t });
        out.push({ tag: 'figure', children: fig });
        break;
      }
      case 'DIV': case 'SECTION': case 'ARTICLE': case 'MAIN': case 'HEADER': case 'FOOTER': case 'NAV': case 'TABLE': case 'TR': case 'DL':
        // Обёртки: если внутри есть блоки — разбираем их, иначе это абзац.
        if ([...e.children].some((k) => BLOCK_ELEMS.has(k.tagName))) visit(e);
        else block('p', e);
        break;
      default: block('p', e);
    }
  });
  visit(root);
  flush();
  // Подряд идущие разделители и разделитель в начале/конце не нужны.
  return out.filter((n, i, a) => !(typeof n !== 'string' && n.tag === 'hr'
    && (i === 0 || i === a.length - 1 || (typeof a[i - 1] !== 'string' && (a[i - 1] as { tag: string }).tag === 'hr'))));
}

/** Вставленный HTML → узлы (через инертный документ: скрипты не выполняются, картинки не грузятся). */
export function htmlToNodes(html: string): ArticleNode[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return domToNodes(doc.body, { paste: true });
}

/** Простой текст → абзацы (пустая строка — новый абзац, одиночный перенос — перенос строки). */
export function textToNodes(t: string): ArticleNode[] {
  return t.replace(/\r\n?/g, '\n').split(/\n{2,}/).map((para) => para.trim()).filter(Boolean).map((para) => {
    const kids: ArticleNode[] = [];
    para.split('\n').forEach((line, i) => { if (i) kids.push({ tag: 'br' }); if (line) kids.push(line); });
    return { tag: 'p', children: kids };
  });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Узлы → HTML для вставки в редактор (execCommand insertHTML). Только наши теги, текст экранирован. */
export function nodesToHtml(nodes: ArticleNode[]): string {
  return nodes.map((n) => {
    if (typeof n === 'string') return esc(n);
    const tag = n.tag;
    if (!BLOCKS.has(tag) && !INLINE.has(tag) && tag !== 'li') return nodesToHtml(childrenOf(n));
    if (tag === 'br') return '<br>';
    if (tag === 'hr') return '<hr>';
    if (tag === 'figure' || tag === 'img') return '';
    if (tag === 'span') {
      const font = n.attrs?.font;
      return isArticleFont(font)
        ? `<span class="tl-f tl-f-${font}" data-font="${font}">${nodesToHtml(childrenOf(n))}</span>`
        : nodesToHtml(childrenOf(n));
    }
    const href = tag === 'a' ? safeHref(n.attrs?.href) : null;
    if (tag === 'a' && !href) return nodesToHtml(childrenOf(n));
    return `<${tag}${href ? ` href="${esc(href)}"` : ''}>${nodesToHtml(childrenOf(n))}</${tag}>`;
  }).join('');
}

/** Пути картинок статьи. */
export function imagesOf(nodes: ArticleNode[]): string[] {
  const out: string[] = [];
  const walk = (list: ArticleNode[]) => list.forEach((n) => {
    if (typeof n === 'string') return;
    if (n.tag === 'img' && n.attrs?.src && IMG_RE.test(n.attrs.src)) out.push(n.attrs.src);
    walk(childrenOf(n));
  });
  walk(nodes);
  return [...new Set(out)];
}

export function contentBytes(nodes: ArticleNode[]): number {
  return new TextEncoder().encode(JSON.stringify(nodes)).length;
}

// ---------------------------------------------------------------------------
// Картинки
// ---------------------------------------------------------------------------

const IMG_MAX_SIDE = 2000;
const IMG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Подготовить картинку: GIF — как есть (анимация), остальное — перекодировать в WebP (или JPEG) до 2000 px.
 * Перекодирование заодно убирает EXIF — в том числе координаты, где сделано фото.
 */
export async function prepareImage(file: Blob): Promise<{ blob: Blob; ext: 'webp' | 'jpg' | 'png' | 'gif' }> {
  if (!file.type.startsWith('image/')) throw new Error('Это не картинка');
  if (file.type === 'image/gif') {
    if (file.size > IMG_MAX_BYTES) throw new Error('GIF больше 5 МБ');
    return { blob: file, ext: 'gif' };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => { throw new Error('Не получилось открыть картинку'); });
    const k = Math.min(1, IMG_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k));
    const h = Math.max(1, Math.round(img.naturalHeight * k));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    const as = (type: string, q?: number) => new Promise<Blob | null>((r) => canvas.toBlob(r, type, q));
    for (const q of [0.86, 0.75, 0.6]) {
      const b = await as('image/webp', q);
      if (b && b.type === 'image/webp' && b.size <= IMG_MAX_BYTES) return { blob: b, ext: 'webp' };
      if (b && b.type !== 'image/webp') break;
    }
    for (const q of [0.88, 0.75, 0.6]) {
      const b = await as('image/jpeg', q);
      if (b && b.size <= IMG_MAX_BYTES) return { blob: b, ext: 'jpg' };
    }
    throw new Error('Картинка слишком большая');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Загрузить картинку статьи: сервер выдаёт случайное имя файла, записанное за мной. Возвращает путь. */
export async function uploadArticleImage(file: Blob): Promise<string> {
  const { blob, ext } = await prepareImage(file);
  const { data: path, error } = await sb.rpc('article_image_slot', { p_ext: ext });
  if (error) throw error;
  const up = await sb.storage.from('articles').upload(path, blob, {
    contentType: ext === 'jpg' ? 'image/jpeg' : `image/${ext}`, cacheControl: '31536000', upsert: false,
  });
  if (up.error) throw new Error('Не получилось загрузить картинку');
  return path;
}

export function removeArticleImages(paths: string[]): void {
  const list = paths.filter((p) => IMG_RE.test(p));
  if (list.length) void sb.storage.from('articles').remove(list).then(() => {}, () => {});
}

// ---------------------------------------------------------------------------
// Сервер
// ---------------------------------------------------------------------------

export async function getArticle(slug: string): Promise<ArticleFull | null> {
  const { data, error } = await sb.rpc('article_get', { p_slug: slug });
  if (error) throw error;
  return (data as ArticleFull | null) ?? null;
}

export type ArticleDraft = {
  id: string | null; title: string; author: string; authorUrl: string; content: ArticleNode[]; font?: ArticleFont | null;
};

export async function saveArticle(d: ArticleDraft): Promise<{ id: string; slug: string }> {
  const { data, error } = await sb.rpc('article_save', {
    p_id: d.id, p_title: d.title, p_author_name: d.author || null, p_author_url: d.authorUrl || null,
    p_content: d.content as unknown as Json, p_font: d.font && d.font !== 'serif' ? d.font : null,
  });
  if (error) throw error;
  return data;
}

/** Удалить свою статью вместе с её картинками. */
export async function deleteArticle(id: string): Promise<void> {
  const { data, error } = await sb.rpc('article_delete', { p_id: id });
  if (error) throw error;
  removeArticleImages(data ?? []);
}

export type MyArticle = ArticleCard & { id: string; updated_at: string; hidden: boolean };
export async function myArticles(): Promise<MyArticle[]> {
  const { data, error } = await sb.rpc('my_articles', { p_limit: 200 });
  if (error) throw error;
  return data ?? [];
}

export async function articleCards(slugs: string[]): Promise<ArticleCard[]> {
  if (!slugs.length) return [];
  const { data, error } = await sb.rpc('article_cards', { p_slugs: slugs.slice(0, 50) });
  if (error) throw error;
  return data ?? [];
}

export async function hideArticle(id: string, on: boolean): Promise<void> {
  const { error } = await sb.rpc('article_hide', { p_id: id, p_on: on });
  if (error) throw error;
}

/** +1 просмотр — один раз за сеанс браузера на статью. */
export function countView(slug: string): void {
  const key = `skam:av:${slug.toLowerCase()}`;
  try {
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
  } catch { /* без хранилища — просто считаем */ }
  void sb.rpc('article_view', { p_slug: slug }).then(() => {}, () => {});
}

/** Шапка статьи: заголовок и строка «автор · дата · просмотры». */
export function articleHeader(a: Pick<ArticleFull, 'title' | 'author_name' | 'author_url' | 'created_at' | 'views'>,
  o: { onAuthor?: (href: string, ev: MouseEvent) => boolean } = {}): HTMLElement[] {
  const h1 = document.createElement('h1');
  h1.textContent = a.title;
  const addr = document.createElement('address');
  if (a.author_name) {
    const href = authorHref(a.author_url);
    const who = document.createElement(href ? 'a' : 'span');
    who.className = 'tl-author';
    who.textContent = a.author_name;
    if (href && who instanceof HTMLAnchorElement) {
      who.href = href;
      who.target = '_blank';
      who.rel = 'noopener noreferrer nofollow ugc';
      if (o.onAuthor) who.addEventListener('click', (ev) => { if (o.onAuthor!(a.author_url ?? href, ev)) ev.preventDefault(); });
    }
    addr.append(who, ' · ');
  }
  const time = document.createElement('time');
  time.dateTime = a.created_at;
  time.textContent = articleDate(a.created_at);
  addr.append(time);
  if (a.views > 0) addr.append(` · ${a.views.toLocaleString('ru-RU')} ${viewsWord(a.views)}`);
  return [h1, addr];
}

function viewsWord(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'просмотр';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'просмотра';
  return 'просмотров';
}
