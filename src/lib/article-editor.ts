// Редактор статьи как в Telegraph: заголовок, имя автора и текст прямо «на странице».
// Выделили текст — над ним панель (жирный, курсив, зачёркнутый, ссылка, шрифт, заголовок, подзаголовок, цитата).
// Шрифт всей статьи — кнопка «Aa» рядом с именем автора (0.5.1).
// Пустая строка — слева «+»: картинка, разделитель, списки, код. Работают и привычные сокращения:
// «- » или «* » — список, «1. » — нумерованный, «> » — цитата, «# » и «## » — заголовки, «```» — код, «---» — разделитель.
import {
  ARTICLE_FONTS, type ArticleFont, type ArticleNode, AUTHOR_MAX, CONTENT_MAX_BYTES, TITLE_MAX, applyArticleLook, contentBytes,
  domToNodes, editorFigure, htmlToNodes, imagesOf, isArticleFont, nodesToHtml, renderNodes, safeHref, textToNodes,
  uploadArticleImage,
} from './article';

/** font — шрифт всей статьи; null — с засечками (как раньше). */
export type EditorValue = { title: string; author: string; authorUrl: string; content: ArticleNode[]; font: ArticleFont | null };
export type Editor = {
  root: HTMLElement;
  value(): EditorValue;
  /** Идёт загрузка картинок — публиковать рано. */
  busy(): boolean;
  /** Что-то поменяли с момента открытия. */
  dirty(): boolean;
  /** Проверка перед публикацией: текст ошибки или null. */
  check(): string | null;
  /** Картинки, загруженные в этот раз (чтобы убрать те, что в статью так и не попали). */
  uploaded(): string[];
  focus(): void;
  destroy(): void;
};
export type EditorOpts = {
  toast: (text: string) => void;
  onChange?: () => void;
};

const SVG = (d: string, extra = '') =>
  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;
const IC = {
  bold: '<b class="tt-b">Ж</b>',
  italic: '<i class="tt-i">К</i>',
  strike: '<s class="tt-s">З</s>',
  link: SVG('<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>'),
  h3: '<b class="tt-h">T</b>',
  h4: '<b class="tt-h small">T</b>',
  quote: SVG('<path d="M5 17c1.5-1 3-2.8 3-5.5V7H4v5h3M14 17c1.5-1 3-2.8 3-5.5V7h-4v5h3"/>'),
  plus: SVG('<path d="M12 5v14M5 12h14"/>'),
  image: SVG('<rect x="3" y="4.5" width="18" height="15" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="M21 15.5l-4.5-4.5L7 19.5"/>'),
  hr: SVG('<path d="M4 12h16"/><path d="M8 7h.01M12 7h.01M16 7h.01" stroke-width="3"/>'),
  ul: SVG('<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" stroke-width="3"/>'),
  ol: SVG('<path d="M10 6h10M10 12h10M10 18h10"/><path d="M4 5l1.5-1v5M3.8 15.2a1.4 1.4 0 0 1 2.4.8c0 1-2.4 2-2.4 3h2.6"/>'),
  code: SVG('<path d="M8.5 7L4 12l4.5 5M15.5 7L20 12l-4.5 5"/>'),
  font: '<span class="tt-aa">Aa</span>',
};

function btn(cls: string, iconHtml: string, label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.title = label;
  b.setAttribute('aria-label', label);
  // Значки — наши собственные строки, не пользовательский текст.
  b.innerHTML = iconHtml;
  // Не забираем фокус у текста: выделение должно остаться.
  b.addEventListener('pointerdown', (e) => e.preventDefault());
  b.addEventListener('mousedown', (e) => e.preventDefault());
  return b;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export function createEditor(init: Partial<EditorValue>, o: EditorOpts): Editor {
  const root = document.createElement('div');
  root.className = 'tl tl-editor';

  const title = document.createElement('h1');
  title.className = 'tl-title';
  title.contentEditable = 'true';
  title.spellcheck = true;
  title.dataset.ph = 'Заголовок';
  title.setAttribute('aria-label', 'Заголовок статьи');
  title.textContent = init.title ?? '';

  const byline = document.createElement('div');
  byline.className = 'tl-byline';
  const author = document.createElement('address');
  author.className = 'tl-author-ed';
  author.contentEditable = 'true';
  author.dataset.ph = 'Ваше имя';
  author.setAttribute('aria-label', 'Имя автора (видно всем, можно оставить пустым)');
  author.textContent = init.author ?? '';
  const linkToggle = btn('tl-ulink', IC.link, 'Ссылка автора');
  const authorUrl = document.createElement('input');
  authorUrl.className = 'tl-author-url';
  authorUrl.type = 'text';
  authorUrl.maxLength = 512;
  authorUrl.autocomplete = 'off';
  authorUrl.spellcheck = false;
  authorUrl.placeholder = 'Ссылка автора: https://… или @username';
  authorUrl.setAttribute('aria-label', 'Ссылка автора (необязательно)');
  authorUrl.value = init.authorUrl ?? '';
  authorUrl.hidden = !authorUrl.value;
  linkToggle.addEventListener('click', () => {
    authorUrl.hidden = false;
    authorUrl.focus();
  });
  // Шрифт всей статьи: «Aa» и список с образцами.
  let articleFont: ArticleFont | null = isArticleFont(init.font) && init.font !== 'serif' ? init.font : null;
  const fontToggle = btn('tl-ufont', IC.font, 'Шрифт статьи');
  fontToggle.setAttribute('aria-haspopup', 'true');
  const fontMenu = document.createElement('div');
  fontMenu.className = 'tl-font-menu';
  fontMenu.hidden = true;
  fontMenu.setAttribute('role', 'menu');
  fontMenu.setAttribute('aria-label', 'Шрифт статьи');
  const renderFontMenu = () => {
    fontMenu.replaceChildren(...ARTICLE_FONTS.map((f) => {
      const b = btn(`tl-font-opt tl-f-${f.id}`, '', f.label);
      b.textContent = f.label;
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String((articleFont ?? 'serif') === f.id));
      b.addEventListener('click', () => {
        articleFont = f.id === 'serif' ? null : f.id;
        applyArticleLook(root, articleFont, null);
        fontMenu.hidden = true;
        fontToggle.title = `Шрифт статьи: ${f.label}`;
        changed();
      });
      return b;
    }));
  };
  fontToggle.addEventListener('click', () => {
    if (!fontMenu.hidden) { fontMenu.hidden = true; return; }
    renderFontMenu();
    fontMenu.hidden = false;
  });
  byline.append(author, linkToggle, fontToggle, fontMenu);

  const body = document.createElement('div');
  body.className = 'tl-body';
  body.contentEditable = 'true';
  body.spellcheck = true;
  body.setAttribute('role', 'textbox');
  body.setAttribute('aria-multiline', 'true');
  body.setAttribute('aria-label', 'Текст статьи');
  body.dataset.ph = 'Ваша история…';
  body.append(renderNodes(init.content ?? [], { edit: true }));

  // Панель над выделением.
  const tools = document.createElement('div');
  tools.className = 'tl-tools';
  tools.hidden = true;
  tools.setAttribute('role', 'toolbar');
  tools.setAttribute('aria-label', 'Оформление текста');
  const tBold = btn('tt', IC.bold, 'Жирный (Ctrl+B)');
  const tItalic = btn('tt', IC.italic, 'Курсив (Ctrl+I)');
  const tStrike = btn('tt', IC.strike, 'Зачёркнутый');
  const tLink = btn('tt', IC.link, 'Ссылка (Ctrl+K)');
  const tFont = btn('tt', IC.font, 'Шрифт выделенного');
  const tH3 = btn('tt', IC.h3, 'Заголовок');
  const tH4 = btn('tt', IC.h4, 'Подзаголовок');
  const tQuote = btn('tt', IC.quote, 'Цитата (ещё раз — выделенная цитата)');
  const sep = () => { const s = document.createElement('span'); s.className = 'tt-sep'; return s; };
  const toolRow = document.createElement('div');
  toolRow.className = 'tt-row';
  toolRow.append(tBold, tItalic, tStrike, tLink, tFont, sep(), tH3, tH4, tQuote);
  // Шрифт выделенного текста: «Обычный» и шрифты с образцами.
  const fontRow = document.createElement('div');
  fontRow.className = 'tt-fonts';
  fontRow.hidden = true;
  const linkRow = document.createElement('div');
  linkRow.className = 'tt-link';
  linkRow.hidden = true;
  const linkInput = document.createElement('input');
  linkInput.type = 'url';
  linkInput.placeholder = 'Вставьте или напишите ссылку…';
  linkInput.setAttribute('aria-label', 'Адрес ссылки');
  linkRow.append(linkInput);
  tools.append(toolRow, linkRow, fontRow);

  // «+» у пустой строки.
  const plus = btn('tl-plus', IC.plus, 'Добавить: картинку, разделитель, список, код');
  plus.hidden = true;
  const plusMenu = document.createElement('div');
  plusMenu.className = 'tl-plus-menu';
  plusMenu.hidden = true;
  const pImage = btn('tp', IC.image, 'Картинка');
  const pHr = btn('tp', IC.hr, 'Разделитель');
  const pUl = btn('tp', IC.ul, 'Список');
  const pOl = btn('tp', IC.ol, 'Нумерованный список');
  const pCode = btn('tp', IC.code, 'Код');
  plusMenu.append(pImage, pHr, pUl, pOl, pCode);

  const files = document.createElement('input');
  files.type = 'file';
  files.accept = 'image/*';
  files.multiple = true;
  files.hidden = true;

  root.append(title, byline, authorUrl, body, tools, plus, plusMenu, files);

  applyArticleLook(root, articleFont, null);
  const initial = JSON.stringify({
    t: oneLine(init.title ?? ''), a: oneLine(init.author ?? ''), u: (init.authorUrl ?? '').trim(), c: init.content ?? [], f: articleFont,
  });
  const uploadedPaths: string[] = [];
  let pending = 0;
  let savedRange: Range | null = null;
  let plusFor: HTMLElement | null = null;
  /** Куда вставить выбранные картинки (пустой абзац, у которого нажали «+»). */
  let imgBefore: HTMLElement | null = null;

  // ------------------------------------------------------------------ помощники

  const changed = () => { refreshEmpty(); o.onChange?.(); };

  function refreshEmpty(): void {
    title.classList.toggle('empty', !title.textContent?.trim());
    author.classList.toggle('empty', !author.textContent?.trim());
    const only = body.children.length <= 1 && !body.querySelector('figure,hr,ul,ol,pre') && !body.textContent?.replace(/\u200b/g, '').trim();
    body.classList.toggle('empty', only);
    body.querySelectorAll('figcaption').forEach((c) => c.classList.toggle('empty', !c.textContent?.trim()));
  }

  /** Блок верхнего уровня (прямой ребёнок body), в котором узел. */
  function blockOf(n: Node | null): HTMLElement | null {
    while (n && n.parentNode !== body) n = n.parentNode;
    return n && n.nodeType === Node.ELEMENT_NODE ? n as HTMLElement : null;
  }

  function selRange(): Range | null {
    const s = getSelection();
    if (!s || !s.rangeCount) return null;
    const r = s.getRangeAt(0);
    return body.contains(r.commonAncestorContainer) ? r : null;
  }

  function placeCaret(node: Node, atEnd = false): void {
    const r = document.createRange();
    r.selectNodeContents(node);
    r.collapse(!atEnd);
    const s = getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
  }

  function newPara(): HTMLParagraphElement {
    const p = document.createElement('p');
    p.append(document.createElement('br'));
    return p;
  }

  /** После картинки, разделителя, списка и кода всегда есть строка, куда писать дальше. */
  function ensureTail(): void {
    const last = body.lastElementChild;
    if (!last || /^(FIGURE|HR|UL|OL|PRE|H3|H4|BLOCKQUOTE|ASIDE)$/.test(last.tagName)) body.append(newPara());
  }

  /** Список из абзаца (сами, без execCommand: Chrome вкладывает список внутрь абзаца). */
  function makeList(p: HTMLElement, tag: 'ul' | 'ol'): void {
    const list = document.createElement(tag);
    const li = document.createElement('li');
    li.append(...p.childNodes);
    if (!li.textContent?.trim()) li.replaceChildren(document.createElement('br'));
    list.append(li);
    p.replaceWith(list);
    ensureTail();
    placeCaret(li, true);
  }

  const NESTED = /^(UL|OL|P|DIV|PRE|H[1-6]|BLOCKQUOTE|ASIDE|FIGURE|HR)$/;
  /** Блоки, вложенные в абзац или заголовок (так делают браузеры и вставка), — поднимаем на верхний уровень. */
  function hoist(): boolean {
    let moved = false;
    [...body.children].forEach((e) => {
      if (!/^(P|H3|H4|BLOCKQUOTE|ASIDE)$/.test(e.tagName) || ![...e.children].some((c) => NESTED.test(c.tagName))) return;
      const parts: Node[] = [];
      const runs = new Set<Node>();
      let run: HTMLElement | null = null;
      [...e.childNodes].forEach((c) => {
        if (c.nodeType === Node.ELEMENT_NODE && NESTED.test((c as Element).tagName)) {
          run = null;
          parts.push(c);
          return;
        }
        if (!run) { run = document.createElement(e.tagName.toLowerCase()); parts.push(run); runs.add(run); }
        run.append(c);
      });
      // Пустые обрывки (только <br> или пробелы) между поднятыми блоками не нужны.
      const keep = parts.filter((x) => !runs.has(x) || !!(x as HTMLElement).textContent?.replace(/\u200b/g, '').trim());
      e.replaceWith(...keep);
      moved = true;
    });
    return moved;
  }

  /** Порядок в body: только блоки; текст и строчные элементы на верхнем уровне — в абзацы, div — в p. */
  function normalize(): void {
    const s = getSelection();
    const r = s && s.rangeCount ? s.getRangeAt(0).cloneRange() : null;
    let touched = hoist();
    if (touched) hoist();
    let loose: HTMLParagraphElement | null = null;
    [...body.childNodes].forEach((c) => {
      if (c.nodeType === Node.TEXT_NODE && !(c.textContent ?? '').trim() && !loose) { c.remove(); return; }
      const isBlock = c.nodeType === Node.ELEMENT_NODE && /^(P|H3|H4|BLOCKQUOTE|ASIDE|UL|OL|PRE|FIGURE|HR|DIV|H1|H2|H5|H6)$/.test((c as Element).tagName);
      if (!isBlock) {
        if (!loose) { loose = document.createElement('p'); body.insertBefore(loose, c); }
        loose.append(c);
        touched = true;
        return;
      }
      loose = null;
      const e = c as HTMLElement;
      const swap = e.tagName === 'DIV' ? 'p' : /^H[12]$/.test(e.tagName) ? 'h3' : /^H[56]$/.test(e.tagName) ? 'h4' : null;
      if (swap) {
        const n = document.createElement(swap);
        n.append(...e.childNodes);
        e.replaceWith(n);
        touched = true;
      }
      if (e.tagName === 'FIGURE' && !e.querySelector('img')) { e.remove(); touched = true; }
    });
    if (!body.firstChild) { body.append(newPara()); touched = true; }
    ensureTail();
    if (touched && r && body.contains(r.startContainer)) {
      try { s!.removeAllRanges(); s!.addRange(r); } catch { /* каретка останется, где поставил браузер */ }
    }
  }

  /** Сменить вид блоков в выделении: p ↔ h3/h4/blockquote/aside. */
  function setBlock(tag: string): void {
    const r = selRange();
    if (!r) return;
    const first = blockOf(r.startContainer);
    const last = blockOf(r.endContainer);
    if (!first) return;
    const blocks: HTMLElement[] = [];
    for (let b: Element | null = first; b; b = b.nextElementSibling) {
      blocks.push(b as HTMLElement);
      if (b === last) break;
    }
    const sc = r.startContainer, so = r.startOffset, ec = r.endContainer, eo = r.endOffset;
    const map = new Map<Node, Node>();
    for (const b of blocks) {
      if (!/^(P|H3|H4|BLOCKQUOTE|ASIDE)$/.test(b.tagName)) continue;
      const n = document.createElement(tag);
      n.append(...b.childNodes);
      if (!n.childNodes.length) n.append(document.createElement('br'));
      b.replaceWith(n);
      map.set(b, n);
    }
    const nr = document.createRange();
    try {
      nr.setStart(map.get(sc) ?? sc, so);
      nr.setEnd(map.get(ec) ?? ec, eo);
      const s = getSelection();
      s?.removeAllRanges();
      s?.addRange(nr);
    } catch { /* выделение потерялось — не страшно */ }
    ensureTail();
    changed();
    updateUi();
  }

  function curBlockTag(): string {
    const r = selRange();
    return r ? blockOf(r.startContainer)?.tagName.toLowerCase() ?? '' : '';
  }

  function inLink(): HTMLAnchorElement | null {
    const r = selRange();
    let n: Node | null = r ? r.commonAncestorContainer : null;
    while (n && n !== body) {
      if (n instanceof HTMLAnchorElement) return n;
      n = n.parentNode;
    }
    return null;
  }

  /** Шрифт, в котором стоит начало выделения (span data-font). */
  function inFont(): HTMLElement | null {
    const r = selRange();
    let n: Node | null = r ? r.startContainer : null;
    while (n && n !== body) {
      if (n instanceof HTMLElement && n.dataset.font) return n;
      n = n.parentNode;
    }
    return null;
  }

  function openFontRow(): void {
    const r = selRange();
    if (!r || r.collapsed) return;
    savedRange = r.cloneRange();
    const cur = inFont()?.dataset.font ?? null;
    const opts: { id: ArticleFont | null; label: string }[] = [{ id: null, label: 'Обычный' }, ...ARTICLE_FONTS];
    fontRow.replaceChildren(...opts.map((f) => {
      const b = btn(`tt-font${f.id ? ` tl-f-${f.id}` : ''}`, '', f.id ? f.label : 'Обычный шрифт');
      b.textContent = f.label;
      b.classList.toggle('on', cur === f.id || (!cur && !f.id));
      b.addEventListener('click', () => applyFont(f.id));
      return b;
    }));
    toolRow.hidden = true;
    fontRow.hidden = false;
    positionAbove(tools, r.getBoundingClientRect());
  }

  function closeFontRow(): void {
    toolRow.hidden = false;
    fontRow.hidden = true;
  }

  /**
   * Шрифт выделенному тексту. Браузер сам аккуратно оборачивает выделение (fontName → <font face>, с отменой
   * по Ctrl+Z), а мы сразу меняем <font> на свой span data-font. «Обычный» снимает шрифт с затронутых кусков.
   */
  function applyFont(id: ArticleFont | null): void {
    const r = savedRange;
    savedRange = null;
    closeFontRow();
    if (!r) { tools.hidden = true; return; }
    const s = getSelection();
    body.focus({ preventScroll: true });
    s?.removeAllRanges();
    s?.addRange(r);
    if (id) {
      document.execCommand('styleWithCSS', false, 'false');
      document.execCommand('fontName', false, id);
    } else {
      body.querySelectorAll<HTMLElement>('span[data-font]').forEach((sp) => {
        if (r.intersectsNode(sp)) sp.replaceWith(...sp.childNodes);
      });
    }
    body.querySelectorAll('font').forEach((f) => {
      const face = f.getAttribute('face');
      if (isArticleFont(face)) {
        const sp = document.createElement('span');
        sp.className = `tl-f tl-f-${face}`;
        sp.dataset.font = face;
        sp.append(...f.childNodes);
        // Шрифт внутри другого шрифта: внутренний и так главнее, внешний не трогаем.
        f.replaceWith(sp);
      } else {
        f.replaceWith(...f.childNodes);
      }
    });
    body.querySelectorAll<HTMLElement>('span[data-font]').forEach((sp) => { if (!sp.textContent) sp.remove(); });
    body.normalize();
    changed();
    updateUi();
  }

  function caretAt(edge: 'start' | 'end', block: HTMLElement): boolean {
    const r = selRange();
    if (!r || !r.collapsed) return false;
    const t = document.createRange();
    if (edge === 'end') { t.setStart(r.endContainer, r.endOffset); t.setEnd(block, block.childNodes.length); }
    else { t.setStart(block, 0); t.setEnd(r.startContainer, r.startOffset); }
    return !t.toString().replace(/\u200b/g, '') && !t.cloneContents().querySelector?.('img');
  }

  // ------------------------------------------------------------------ панель и «+»

  function positionAbove(el: HTMLElement, rect: DOMRect): void {
    const base = root.getBoundingClientRect();
    el.hidden = false;
    const w = el.offsetWidth, h = el.offsetHeight;
    let top = rect.top - base.top - h - 10;
    if (top < 0) top = rect.bottom - base.top + 10;
    const left = Math.max(0, Math.min(base.width - w, rect.left - base.left + rect.width / 2 - w / 2));
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
  }

  function updateUi(): void {
    const r = selRange();
    // Панель над выделением.
    if (r && !r.collapsed && linkRow.hidden && fontRow.hidden) {
      const rect = r.getBoundingClientRect();
      if (rect.width || rect.height) {
        const blockTag = curBlockTag();
        const inPre = blockTag === 'pre';
        tBold.classList.toggle('on', document.queryCommandState('bold'));
        tItalic.classList.toggle('on', document.queryCommandState('italic'));
        tStrike.classList.toggle('on', document.queryCommandState('strikeThrough'));
        tLink.classList.toggle('on', !!inLink());
        tFont.classList.toggle('on', !!inFont());
        tH3.classList.toggle('on', blockTag === 'h3');
        tH4.classList.toggle('on', blockTag === 'h4');
        tQuote.classList.toggle('on', blockTag === 'blockquote' || blockTag === 'aside');
        [tBold, tItalic, tStrike, tLink, tFont, tH3, tH4, tQuote].forEach((b) => { b.disabled = inPre; });
        positionAbove(tools, rect);
      }
    } else if (linkRow.hidden && fontRow.hidden) {
      tools.hidden = true;
    }
    // «+» у пустого абзаца.
    const b = r && r.collapsed ? blockOf(r.startContainer) : null;
    const emptyP = b && b.tagName === 'P' && !b.textContent?.replace(/\u200b/g, '').trim() && !b.querySelector('img') ? b : null;
    if (emptyP) {
      plusFor = emptyP;
      const base = root.getBoundingClientRect();
      const pr = emptyP.getBoundingClientRect();
      plus.hidden = false;
      plus.style.top = `${pr.top - base.top + pr.height / 2 - plus.offsetHeight / 2}px`;
    } else if (plusMenu.hidden) {
      plus.hidden = true;
      plusFor = null;
    }
  }

  function closePlus(): void {
    plusMenu.hidden = true;
    plus.classList.remove('open');
  }

  function openLinkInput(): void {
    const a = inLink();
    if (a) {
      // Уже ссылка — убираем её.
      const r = document.createRange();
      r.selectNodeContents(a);
      const s = getSelection();
      s?.removeAllRanges();
      s?.addRange(r);
      document.execCommand('unlink');
      changed();
      updateUi();
      return;
    }
    const r = selRange();
    if (!r || r.collapsed) return;
    savedRange = r.cloneRange();
    toolRow.hidden = true;
    linkRow.hidden = false;
    linkInput.value = '';
    positionAbove(tools, r.getBoundingClientRect());
    linkInput.focus();
  }

  function closeLinkInput(apply: boolean): void {
    const raw = linkInput.value.trim();
    toolRow.hidden = false;
    linkRow.hidden = true;
    const r = savedRange;
    savedRange = null;
    if (!r) { tools.hidden = true; return; }
    const s = getSelection();
    body.focus({ preventScroll: true });
    s?.removeAllRanges();
    s?.addRange(r);
    if (apply && raw) {
      const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? `mailto:${raw}` : `https://${raw}`;
      if (!safeHref(url)) { o.toast('Ссылка должна начинаться с https:// или http://'); }
      else {
        document.execCommand('createLink', false, url);
        changed();
      }
    }
    updateUi();
  }

  // ------------------------------------------------------------------ картинки

  async function insertImages(list: File[], before: Node | null): Promise<void> {
    const imgs = list.filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) { if (list.length) o.toast('Можно вставить только картинки'); return; }
    for (const file of imgs.slice(0, 20)) {
      const local = URL.createObjectURL(file);
      const fig = editorFigure(null, local);
      body.insertBefore(fig, before && before.parentNode === body ? before : null);
      ensureTail();
      pending++;
      changed();
      uploadArticleImage(file).then((path) => {
        uploadedPaths.push(path);
        fig.dataset.src = path;
        fig.classList.remove('uploading');
      }).catch((e: unknown) => {
        fig.remove();
        o.toast((e as Error)?.message && /^[А-ЯЁ]/.test((e as Error).message) ? (e as Error).message : 'Не получилось загрузить картинку');
      }).finally(() => {
        pending--;
        // Локальную копию держим, пока картинка на экране: адрес хранилища подставится при следующем открытии.
        changed();
      });
    }
  }

  // ------------------------------------------------------------------ события

  tBold.addEventListener('click', () => { document.execCommand('bold'); changed(); updateUi(); });
  tItalic.addEventListener('click', () => { document.execCommand('italic'); changed(); updateUi(); });
  tStrike.addEventListener('click', () => { document.execCommand('strikeThrough'); changed(); updateUi(); });
  tLink.addEventListener('click', openLinkInput);
  tFont.addEventListener('click', openFontRow);
  tH3.addEventListener('click', () => setBlock(curBlockTag() === 'h3' ? 'p' : 'h3'));
  tH4.addEventListener('click', () => setBlock(curBlockTag() === 'h4' ? 'p' : 'h4'));
  tQuote.addEventListener('click', () => {
    const t = curBlockTag();
    setBlock(t === 'blockquote' ? 'aside' : t === 'aside' ? 'p' : 'blockquote');
  });
  linkInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); closeLinkInput(true); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeLinkInput(false); }
  });
  linkInput.addEventListener('blur', () => { if (!linkRow.hidden) closeLinkInput(true); });
  // В поле ссылки фокус нужен — остальные кнопки панели фокус не забирают.
  linkInput.addEventListener('pointerdown', (e) => e.stopPropagation());

  plus.addEventListener('click', () => {
    if (!plusMenu.hidden) { closePlus(); return; }
    plusMenu.hidden = false;
    plus.classList.add('open');
    plusMenu.style.top = plus.style.top;
  });
  const withPara = (fn: (p: HTMLElement) => void) => () => {
    const p = plusFor;
    closePlus();
    if (!p || p.parentNode !== body) return;
    fn(p);
    changed();
    updateUi();
  };
  pImage.addEventListener('click', withPara((p) => { imgBefore = p; files.click(); }));
  files.addEventListener('change', () => {
    const list = [...(files.files ?? [])];
    files.value = '';
    const p = imgBefore && imgBefore.parentNode === body ? imgBefore : null;
    imgBefore = null;
    void insertImages(list, p);
  });
  pHr.addEventListener('click', withPara((p) => {
    p.before(document.createElement('hr'));
    placeCaret(p);
  }));
  pUl.addEventListener('click', withPara((p) => makeList(p, 'ul')));
  pOl.addEventListener('click', withPara((p) => makeList(p, 'ol')));
  pCode.addEventListener('click', withPara((p) => {
    const pre = document.createElement('pre');
    pre.append(document.createElement('br'));
    p.replaceWith(pre);
    ensureTail();
    placeCaret(pre);
  }));

  // Убрать картинку крестиком.
  body.addEventListener('click', (e) => {
    const x = (e.target as HTMLElement).closest('.tl-fig-x');
    if (!x) return;
    e.preventDefault();
    const fig = x.closest('figure');
    const next = fig?.nextElementSibling;
    fig?.remove();
    normalize();
    if (next) placeCaret(next);
    changed();
  });

  // Заголовок и имя — одной строкой, только текст.
  const plainLine = (el: HTMLElement, max: number, next: () => void) => {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); next(); }
    });
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      const t = oneLine(e.clipboardData?.getData('text/plain') ?? '');
      document.execCommand('insertText', false, t.slice(0, max));
    });
    el.addEventListener('input', () => {
      // Браузер иногда оставляет <br> или разметку — держим чистый текст.
      if (el.querySelector('*')) {
        const t = el.textContent ?? '';
        el.textContent = t;
        placeCaret(el, true);
      }
      changed();
    });
  };
  plainLine(title, TITLE_MAX, () => author.focus());
  plainLine(author, AUTHOR_MAX, () => { body.focus(); placeCaret(body.firstElementChild ?? body); });
  authorUrl.addEventListener('input', changed);
  authorUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); body.focus(); } });

  body.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openLinkInput();
      return;
    }
    const r = selRange();
    if (!r) return;
    const cap = (r.startContainer.nodeType === Node.ELEMENT_NODE ? r.startContainer as Element : r.startContainer.parentElement)?.closest('figcaption');
    if (cap) {
      // Подпись картинки — одна строка; Enter — к тексту под картинкой.
      if (e.key === 'Enter') {
        e.preventDefault();
        const fig = cap.closest('figure')!;
        let next = fig.nextElementSibling;
        if (!next || next.tagName !== 'P') { next = newPara(); fig.after(next); }
        placeCaret(next);
      }
      return;
    }
    const block = blockOf(r.startContainer);
    if (!block) return;
    const tag = block.tagName;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      if (tag === 'PRE') {
        e.preventDefault();
        // В коде Enter — новая строка; на пустой последней строке — выход из блока кода (как в Telegraph).
        const before = document.createRange();
        before.setStart(block, 0);
        before.setEnd(r.startContainer, r.startOffset);
        const after = document.createRange();
        after.setStart(r.endContainer, r.endOffset);
        after.setEnd(block, block.childNodes.length);
        const b = before.toString().replace(/\u200b/g, '');
        if (/\n$/.test(b) && b.trim() && !after.toString().replace(/[\s\u200b]/g, '')) {
          block.textContent = b.replace(/\n+$/, '');
          const p = newPara();
          block.after(p);
          placeCaret(p);
        } else {
          document.execCommand('insertLineBreak');
        }
        changed();
        return;
      }
      if (/^(H3|H4|BLOCKQUOTE|ASIDE)$/.test(tag) && caretAt('end', block)) {
        e.preventDefault();
        const p = newPara();
        block.after(p);
        placeCaret(p);
        changed();
        updateUi();
        return;
      }
    }
    if (e.key === 'Backspace' && r.collapsed && /^(H3|H4|BLOCKQUOTE|ASIDE|PRE)$/.test(tag) && caretAt('start', block)) {
      // Как в Telegraph: Backspace в начале заголовка или цитаты делает из неё обычный абзац.
      e.preventDefault();
      setBlock('p');
    }
  });

  // Сокращения в начале пустого абзаца.
  body.addEventListener('input', (e) => {
    const ie = e as InputEvent;
    normalize();
    const r = selRange();
    const block = r ? blockOf(r.startContainer) : null;
    if (block && block.tagName === 'P' && ie.inputType === 'insertText' && r?.collapsed) {
      const t = (block.textContent ?? '').replace(/ /g, ' ');
      const turn = (fn: () => void) => { block.textContent = ''; block.append(document.createElement('br')); placeCaret(block); fn(); };
      if (t === '- ' || t === '* ') turn(() => makeList(block, 'ul'));
      else if (t === '1. ') turn(() => makeList(block, 'ol'));
      else if (t === '> ') turn(() => setBlock('blockquote'));
      else if (t === '# ') turn(() => setBlock('h3'));
      else if (t === '## ') turn(() => setBlock('h4'));
      else if (t === '```') {
        const pre = document.createElement('pre');
        pre.append(document.createElement('br'));
        block.replaceWith(pre);
        ensureTail();
        placeCaret(pre);
      } else if (t === '---') {
        const hr = document.createElement('hr');
        block.before(hr);
        block.textContent = '';
        block.append(document.createElement('br'));
        placeCaret(block);
      }
    }
    changed();
    updateUi();
  });

  body.addEventListener('paste', (e) => {
    const cd = e.clipboardData;
    if (!cd) return;
    const r = selRange();
    const inPre = r && blockOf(r.startContainer)?.tagName === 'PRE';
    const inCap = r && (r.startContainer.parentElement?.closest('figcaption') || (r.startContainer as Element).closest?.('figcaption'));
    e.preventDefault();
    const pics = [...cd.files].filter((f) => f.type.startsWith('image/'));
    if (pics.length && !inPre && !inCap) {
      void insertImages(pics, r ? blockOf(r.startContainer)?.nextSibling ?? null : null);
      return;
    }
    const plain = cd.getData('text/plain');
    if (inPre || inCap) {
      document.execCommand('insertText', false, inCap ? oneLine(plain) : plain);
      changed();
      return;
    }
    const html = cd.getData('text/html');
    const nodes = html ? htmlToNodes(html) : textToNodes(plain);
    if (!nodes.length) return;
    const only = nodes.length === 1 && typeof nodes[0] !== 'string' && nodes[0].tag === 'p' ? nodes[0] : null;
    document.execCommand('insertHTML', false, only ? nodesToHtml(only.children ?? []) : nodesToHtml(nodes));
    normalize();
    changed();
  });

  body.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types ?? [])].includes('Files')) e.preventDefault();
  });
  body.addEventListener('drop', (e) => {
    const list = [...(e.dataTransfer?.files ?? [])];
    if (!list.length) return;
    e.preventDefault();
    const at = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    const block = at ? blockOf(at.startContainer) : null;
    void insertImages(list, block ? block.nextSibling : null);
  });

  const onSel = () => { if (root.isConnected) updateUi(); };
  document.addEventListener('selectionchange', onSel);
  const onDocDown = (e: PointerEvent) => {
    if (!plusMenu.hidden && !plusMenu.contains(e.target as Node) && e.target !== plus && !plus.contains(e.target as Node)) closePlus();
    if (!fontRow.hidden && !tools.contains(e.target as Node)) { savedRange = null; closeFontRow(); tools.hidden = true; }
    if (!fontMenu.hidden && !fontMenu.contains(e.target as Node) && !fontToggle.contains(e.target as Node)) fontMenu.hidden = true;
  };
  document.addEventListener('pointerdown', onDocDown);

  document.execCommand('defaultParagraphSeparator', false, 'p');
  normalize();
  refreshEmpty();

  // ------------------------------------------------------------------ наружу

  const value = (): EditorValue => ({
    title: oneLine(title.textContent ?? ''),
    author: oneLine(author.textContent ?? ''),
    authorUrl: authorUrl.value.trim(),
    content: domToNodes(body),
    font: articleFont,
  });

  return {
    root,
    value,
    busy: () => pending > 0,
    dirty: () => {
      const v = value();
      return JSON.stringify({ t: v.title, a: v.author, u: v.authorUrl, c: v.content, f: v.font }) !== initial;
    },
    check: () => {
      const v = value();
      if (pending > 0) return 'Подождите: картинки ещё загружаются';
      if (!v.title) return 'Добавьте заголовок';
      if (v.title.length > TITLE_MAX) return `Заголовок длиннее ${TITLE_MAX} символов`;
      if (v.author.length > AUTHOR_MAX) return `Имя автора длиннее ${AUTHOR_MAX} символов`;
      if (v.authorUrl && !/^@?[A-Za-z][A-Za-z0-9_]{4,31}$/.test(v.authorUrl) && !safeHref(v.authorUrl)) {
        return 'Ссылка автора — адрес https://… или @username';
      }
      if (!v.content.length) return 'Статья пустая — напишите хоть что-нибудь';
      if (contentBytes(v.content) > CONTENT_MAX_BYTES) return 'Статья слишком длинная — разделите её на две';
      return null;
    },
    uploaded: () => [...uploadedPaths],
    focus: () => {
      if (!title.textContent?.trim()) { title.focus(); return; }
      body.focus();
      const last = body.lastElementChild;
      if (last) placeCaret(last, true);
    },
    destroy: () => {
      document.removeEventListener('selectionchange', onSel);
      document.removeEventListener('pointerdown', onDocDown);
      root.querySelectorAll('img').forEach((im) => { if (im.src.startsWith('blob:')) URL.revokeObjectURL(im.src); });
    },
  };
}

/** Картинки, которые были в статье до правки и пропали из неё после (их можно удалить из хранилища). */
export function droppedImages(before: ArticleNode[], after: ArticleNode[], uploaded: string[] = []): string[] {
  const keep = new Set(imagesOf(after));
  return [...new Set([...imagesOf(before), ...uploaded])].filter((p) => !keep.has(p));
}
