// Статьи внутри СКАМ (0.4.0): мгновенный просмотр (как Instant View в Telegram), редактор, «Мои статьи»
// и карточки статей в сообщениях. Сама статья живёт по адресу skam-messenger.ru/a/<адрес> (src/article/page.ts).
import { $, ICONS, button, closeDialog, el, errText, html, openDialog, plural, toast } from '../lib/dom';
import {
  type ArticleCard, type ArticleFull, type MyArticle, articleDate, articleHeader, articleImageUrl, articleCards,
  applyArticleLook, articleUrl, countView, deleteArticle, getArticle, myArticles, readerMenu, removeArticleImages, renderNodes, saveArticle,
  slugFromUrl,
} from '../lib/article';
import { type Editor, createEditor, droppedImages } from '../lib/article-editor';

export type ArticleEnv = {
  /** Прикрепить ссылку на статью к сообщению в открытом чате (null — чат не открыт или писать нельзя). */
  attachTarget: () => ((url: string) => void) | null;
  /** Отправить ссылку в чат по выбору. */
  shareToChat: (url: string) => void;
  /** @username автора — открыть в СКАМ. */
  openUsername: (u: string) => void;
  /** Моё имя — подставляется автором новой статьи. */
  myName: () => string;
  /** Перерисовать ленту (пришли карточки статей). */
  rerender: () => void;
};
let env: ArticleEnv;
export function mountArticles(e: ArticleEnv): void {
  env = e;
  // Закрыли окно (крестиком, Esc или жестом): новая статья остаётся черновиком, редактор убираем.
  dlg().addEventListener('close', () => {
    if (editor && editorNew && editor.dirty()) writeDraft({ ...editor.value(), at: Date.now() });
    editor?.destroy();
    editor = null;
  });
}

const DRAFT_KEY = 'skam:article-draft';
let editor: Editor | null = null;
/** Открыт редактор новой статьи (а не правка опубликованной). */
let editorNew = false;

function dlg(): HTMLDialogElement {
  return $<HTMLDialogElement>('articleDlg');
}

function iconBtn(icon: keyof typeof ICONS, label: string, fn: () => void, cls = 'icon-btn ad-ic'): HTMLButtonElement {
  const b = button(cls, null, fn);
  b.append(html(ICONS[icon]));
  b.title = label;
  b.setAttribute('aria-label', label);
  return b;
}

function closeArticle(): void {
  editor?.destroy();
  editor = null;
  closeDialog(dlg());
}

function bar(title: string, left: HTMLElement[], right: HTMLElement[]): HTMLElement {
  const h = el('header', 'ad-bar');
  const t = el('span', 'ad-title', title);
  h.append(...left, t, el('span', 'ad-spacer'), ...right);
  return h;
}

function show(barEl: HTMLElement, content: HTMLElement, editing = false): void {
  const d = dlg();
  const scroll = el('div', 'ad-scroll');
  scroll.append(content);
  d.replaceChildren(barEl, scroll);
  d.classList.toggle('editing', editing);
  if (!d.open) openDialog(d);
}

/** Ссылка на статью СКАМ внутри другой статьи или автор @username — открываем в приложении. */
function linkHook(href: string, ev: MouseEvent): boolean {
  if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button !== 0) return false;
  const slug = slugFromUrl(href);
  if (slug) { void openArticle(slug); return true; }
  return false;
}

// ---------------------------------------------------------------------------
// Мгновенный просмотр
// ---------------------------------------------------------------------------

export async function openArticle(slug: string, o: { attach?: boolean } = {}): Promise<void> {
  editor?.destroy();
  editor = null;
  const close = iconBtn('close', 'Закрыть', closeArticle);
  show(bar('Статья', [close], []), el('p', 'ad-note', 'Загружаем статью…'));
  let a: ArticleFull | null;
  try {
    a = await getArticle(slug);
  } catch (e) {
    show(bar('Статья', [close], []), el('p', 'ad-note', errText(e, 'Не получилось загрузить статью.')));
    return;
  }
  if (!a) {
    cards.set(slug.toLowerCase(), 'missing');
    show(bar('Статья', [close], []), el('p', 'ad-note', 'Статья не найдена — возможно, автор её удалил.'));
    return;
  }
  showArticle(a, o);
}

function showArticle(a: ArticleFull, o: { attach?: boolean } = {}): void {
  editor?.destroy();
  editor = null;
  const url = articleUrl(a.slug);
  const right: HTMLElement[] = [
    iconBtn('link', 'Скопировать ссылку', () => {
      navigator.clipboard?.writeText(url).then(() => toast('Ссылка скопирована'), () => toast(url));
    }),
    iconBtn('external', 'Открыть в браузере', () => { window.open(url, '_blank', 'noopener'); }),
    iconBtn('forward', 'Отправить в чат', () => { closeArticle(); env.shareToChat(url); }),
  ];
  if (a.mine) right.push(iconBtn('edit', 'Изменить', () => openArticleEditor(a)));
  const attach = o.attach ? env.attachTarget() : null;
  if (attach) {
    right.push(button('btn primary small ad-main', 'Прикрепить', () => { closeArticle(); attach(url); }));
  }
  const art = el('article', 'tl');
  if (a.hidden) {
    art.append(el('p', 'tl-hidden-note', a.mine
      ? 'Команда СКАМ скрыла эту статью — по ссылке её больше не видно.'
      : 'Статья скрыта модерацией: её видят только автор и команда СКАМ.'));
  }
  art.append(...articleHeader(a, {
    onAuthor: (href) => {
      if (!href.startsWith('@')) return false;
      closeArticle();
      env.openUsername(href.slice(1));
      return true;
    },
  }));
  const body = el('div', 'tl-body');
  body.append(renderNodes(a.content, { onLink: linkHook }));
  art.append(body);
  const foot = el('p', 'ad-foot');
  foot.append(el('span', null, url.replace(/^https:\/\//, '')));
  art.append(foot);
  // Шрифт автора и настройки читателя: «Aa» в шапке (шрифт и размер, запоминается на устройстве).
  applyArticleLook(art, a.font);
  right.unshift(readerMenu(() => applyArticleLook(art, a.font)));
  show(bar('Статья', [iconBtn('close', 'Закрыть', closeArticle)], right), art);
  cards.set(a.slug.toLowerCase(), a);
  if (!a.mine && !a.hidden) countView(a.slug);
}

// ---------------------------------------------------------------------------
// Редактор
// ---------------------------------------------------------------------------

type Draft = { title: string; author: string; authorUrl: string; content: ArticleFull['content']; font?: ArticleFull['font']; at: number };
function readDraft(): Draft | null {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as Draft | null;
    return d && Date.now() - d.at < 30 * 86400_000 && Array.isArray(d.content) ? d : null;
  } catch { return null; }
}
function writeDraft(d: Draft | null): void {
  try {
    if (d) localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    else localStorage.removeItem(DRAFT_KEY);
  } catch { /* без хранилища черновик не сохранится */ }
}

/** Новая статья (a = null) или правка своей. attach — после публикации прикрепить ссылку к сообщению. */
export function openArticleEditor(a: ArticleFull | null, o: { attach?: boolean } = {}): void {
  editor?.destroy();
  const draft = a ? null : readDraft();
  const init = a
    ? { title: a.title, author: a.author_name ?? '', authorUrl: a.author_url ?? '', content: a.content, font: a.font ?? null }
    : draft ?? { title: '', author: env.myName(), authorUrl: '', content: [] };
  let draftTimer = 0;
  const ed = createEditor(init, {
    toast,
    onChange: () => {
      if (a) return;
      clearTimeout(draftTimer);
      draftTimer = window.setTimeout(() => writeDraft({ ...ed.value(), at: Date.now() }), 600);
    },
  });
  editor = ed;
  editorNew = !a;

  let armed = false;
  const cancel = button('btn ghost small', a ? 'Отмена' : 'Закрыть', () => {
    if (a && ed.dirty() && !armed) {
      armed = true;
      cancel.textContent = 'Не сохранять?';
      setTimeout(() => { armed = false; cancel.textContent = 'Отмена'; }, 3000);
      return;
    }
    if (a) {
      removeArticleImages(ed.uploaded());
      showArticle(a);
    } else {
      // Новая статья остаётся черновиком — допишете потом (здесь или на skam-messenger.ru/a/).
      if (ed.dirty()) toast('Черновик сохранён на этом устройстве');
      closeDialog(dlg());
    }
  });
  const right: HTMLElement[] = [];
  if (a) {
    let delArmed = false;
    const del = button('btn ghost small danger', 'Удалить', () => {
      if (!delArmed) {
        delArmed = true;
        del.textContent = 'Точно удалить?';
        setTimeout(() => { delArmed = false; del.textContent = 'Удалить'; }, 3000);
        return;
      }
      deleteArticle(a.id).then(() => {
        cards.set(a.slug.toLowerCase(), 'missing');
        removeArticleImages(ed.uploaded());
        toast('Статья удалена');
        closeArticle();
        env.rerender();
      }).catch((e) => toast(errText(e, 'Не получилось удалить статью.')));
    });
    right.push(del);
  }
  const publish = button('btn primary small ad-main', a ? 'Сохранить' : 'Опубликовать', () => void doSave());
  right.push(publish);
  const doSave = async () => {
    const problem = ed.check();
    if (problem) { toast(problem); return; }
    const v = ed.value();
    publish.disabled = true;
    try {
      const res = await saveArticle({ id: a?.id ?? null, title: v.title, author: v.author, authorUrl: v.authorUrl, content: v.content, font: v.font });
      removeArticleImages(droppedImages(a?.content ?? [], v.content, ed.uploaded()));
      if (!a) { writeDraft(null); editorNew = false; }
      cards.delete(res.slug.toLowerCase());
      env.rerender();
      const url = articleUrl(res.slug);
      const target = !a && o.attach ? env.attachTarget() : null;
      if (target) {
        closeArticle();
        target(url);
        toast('Статья опубликована — ссылка уже в сообщении');
        return;
      }
      const fresh = await getArticle(res.slug);
      if (fresh) showArticle(fresh);
      else closeArticle();
      toast(a ? 'Сохранено' : 'Опубликовано — ссылкой можно делиться');
    } catch (e) {
      toast(errText(e, 'Не получилось сохранить статью.'));
    } finally {
      publish.disabled = false;
    }
  };
  show(bar(a ? 'Правка статьи' : 'Новая статья', [cancel], right), ed.root, true);
  if (draft) toast('Восстановили черновик');
  setTimeout(() => ed.focus(), 50);
}

// ---------------------------------------------------------------------------
// Мои статьи
// ---------------------------------------------------------------------------

/** «Мои статьи»: browse — из профиля (открыть, изменить), attach — из скрепки (выбрать и прикрепить). */
export async function openMyArticles(mode: 'browse' | 'attach' = 'browse'): Promise<void> {
  editor?.destroy();
  editor = null;
  const close = iconBtn('close', 'Закрыть', closeArticle);
  const fresh = button('btn primary small ad-main', 'Новая статья', () => openArticleEditor(null, { attach: mode === 'attach' }));
  const head = bar(mode === 'attach' ? 'Прикрепить статью' : 'Мои статьи', [close], [fresh]);
  const box = el('div', 'ad-list');
  box.append(el('p', 'ad-note', 'Загружаем…'));
  show(head, box);
  let list: MyArticle[];
  try {
    list = await myArticles();
  } catch (e) {
    box.replaceChildren(el('p', 'ad-note', errText(e, 'Не получилось загрузить статьи.')));
    return;
  }
  const intro = el('div', 'ad-intro');
  intro.append(el('h2', null, 'Статьи как в Telegraph'),
    el('p', null, 'Заголовок, ваше имя и текст с картинками — и ссылка, которую можно отправить в любой чат или куда угодно. Прочитать статью можно и без СКАМ.'));
  if (!list.length) {
    const start = button('btn primary', 'Написать первую статью', () => openArticleEditor(null, { attach: mode === 'attach' }));
    intro.append(start);
    box.replaceChildren(intro);
    return;
  }
  const rows = list.map((a) => {
    const r = button('ad-row', null, () => {
      if (mode === 'attach') {
        const t = env.attachTarget();
        if (t) { closeArticle(); t(articleUrl(a.slug)); return; }
      }
      void openArticle(a.slug);
    });
    const thumb = el('span', 'ad-thumb');
    if (a.cover) {
      const im = el('img');
      im.src = articleImageUrl(a.cover);
      im.alt = '';
      im.loading = 'lazy';
      thumb.append(im);
    } else {
      thumb.append(html(ICONS.article));
    }
    const t = el('span', 'ad-row-t');
    t.append(el('span', 'ad-row-title', a.title));
    const sub = `${articleDate(a.created_at)} · ${plural(a.views, 'просмотр', 'просмотра', 'просмотров')}${a.hidden ? ' · скрыта модерацией' : ''}`;
    t.append(el('span', 'ad-row-sub', sub));
    r.append(thumb, t);
    if (mode === 'attach') r.append(el('span', 'ad-row-act', 'Прикрепить'));
    return r;
  });
  box.replaceChildren(...rows);
}

// ---------------------------------------------------------------------------
// Карточки статей в сообщениях
// ---------------------------------------------------------------------------

const cards = new Map<string, ArticleCard | 'missing'>();
const wanted = new Set<string>();
let cardTimer = 0;

function want(slug: string): void {
  wanted.add(slug);
  clearTimeout(cardTimer);
  cardTimer = window.setTimeout(() => {
    const list = [...wanted];
    wanted.clear();
    articleCards(list).then((found) => {
      const got = new Set(found.map((c) => c.slug.toLowerCase()));
      found.forEach((c) => cards.set(c.slug.toLowerCase(), c));
      list.forEach((s) => { if (!got.has(s.toLowerCase())) cards.set(s.toLowerCase(), 'missing'); });
      env.rerender();
    }).catch(() => { /* попробуем при следующей перерисовке */ });
  }, 60);
}

/** Карточка статьи под текстом сообщения (как превью ссылки в Telegram с кнопкой мгновенного просмотра). */
export function articleCardEl(slug: string): HTMLElement {
  const key = slug.toLowerCase();
  const c = cards.get(key);
  if (!c) want(slug);
  if (c === 'missing') {
    const gone = el('div', 'art-card gone');
    gone.append(el('span', 'art-site', 'СКАМ · Статья'), el('span', 'art-desc', 'Статья удалена или скрыта'));
    return gone;
  }
  const card = button(`art-card${c ? '' : ' loading'}`, null, (ev) => { ev.stopPropagation(); void openArticle(slug); });
  card.append(el('span', 'art-site', 'СКАМ · Статья'));
  if (!c) {
    card.append(el('span', 'art-title', 'Загружаем…'));
    return card;
  }
  card.append(el('span', 'art-title', c.title));
  if (c.description) card.append(el('span', 'art-desc', c.description));
  if (c.cover) {
    const im = el('img', 'art-cover');
    im.src = articleImageUrl(c.cover);
    im.alt = '';
    im.loading = 'lazy';
    im.decoding = 'async';
    card.append(im);
  }
  const iv = el('span', 'art-iv');
  iv.append(html(ICONS.article), 'Мгновенный просмотр');
  card.append(iv);
  card.setAttribute('aria-label', `Статья «${c.title}» — открыть`);
  return card;
}

/** Заголовок статьи, если карточка уже загружена (для превью в поле ввода). */
export function articleTitle(slug: string): string | null | undefined {
  const c = cards.get(slug.toLowerCase());
  if (c === 'missing') return null;
  if (!c) { want(slug); return undefined; }
  return c.title;
}
