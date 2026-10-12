// Страница статьи https://skam-messenger.ru/a/<адрес> — как Telegraph: читать может кто угодно (без входа),
// автор правит прямо здесь. /a/ без адреса — новая статья (нужно войти в СКАМ).
// Отдельная лёгкая сборка: мессенджер (чаты, шифрование, звонки) сюда не грузится.
import './page.css';
import { configured, sb } from '../lib/supabase';
import { applyTheme } from '../lib/theme';
import { SKAM_FULL } from '../lib/dom';
import {
  type ArticleFull, SLUG_RE, articleHeader, articleUrl, countView, deleteArticle, getArticle, hideArticle,
  removeArticleImages, renderNodes, saveArticle, slugFromUrl,
} from '../lib/article';
import { type Editor, createEditor, droppedImages } from '../lib/article-editor';

applyTheme();

const DRAFT_KEY = 'skam:article-draft';
const page = document.getElementById('page')!;
const actions = document.getElementById('actions')!;
let editor: Editor | null = null;
let toastTimer = 0;

function toast(text: string): void {
  const t = document.getElementById('toast')!;
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t.hidden = true; }, 3200);
}

function errText(e: unknown, fallback: string): string {
  const err = e as { code?: string; message?: string } | null;
  if (err?.message?.includes('Failed to fetch')) return 'Нет связи с сервером.';
  if (err?.code === '42501' && !/^[А-ЯЁ]/.test(err.message ?? '')) return 'Недостаточно прав.';
  if (err?.message && /^[А-ЯЁ]/.test(err.message)) return err.message;
  return fallback;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, text?: string | null): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function abtn(label: string, fn: () => void, cls = 'ap-btn'): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
}

/** Адрес статьи из адресной строки: /a/<адрес>, а пока сервер не знает таких адресов — /a/?<адрес> или /a/#<адрес>. */
function slugHere(): string | null {
  const m = /^\/a\/([^/?#]+)\/?$/.exec(location.pathname);
  let s = m && m[1] !== 'index.html' ? decodeURIComponent(m[1]) : '';
  if (!s && location.search.length > 1 && !location.search.includes('=')) s = decodeURIComponent(location.search.slice(1));
  if (!s && location.hash.length > 1 && !location.hash.includes('=')) s = decodeURIComponent(location.hash.slice(1));
  return s || null;
}

async function myId(): Promise<string | null> {
  if (!configured) return null;
  const { data } = await sb.auth.getSession();
  return data.session?.user.id ?? null;
}

async function myName(uid: string): Promise<string> {
  const { data } = await sb.from('profiles').select('name').eq('id', uid).maybeSingle();
  return data?.name ?? '';
}

function share(a: { title: string; slug: string }): void {
  const url = articleUrl(a.slug);
  if (navigator.share && matchMedia('(hover: none)').matches) {
    void navigator.share({ title: a.title, url }).catch(() => {});
    return;
  }
  navigator.clipboard?.writeText(url).then(() => toast('Ссылка скопирована'), () => toast(url));
}

function footer(a: ArticleFull | null): HTMLElement {
  const f = el('footer', 'ap-foot');
  const line = el('p');
  line.append('Опубликовано в ');
  const home = el('a', null, 'СКАМ');
  home.href = '/';
  line.append(home, ` — ${SKAM_FULL}. `);
  const write = el('a', null, 'Написать свою статью');
  write.href = '/a/';
  line.append(write);
  f.append(line);
  if (a) {
    const rep = el('a', 'ap-report', 'Пожаловаться на статью');
    rep.href = `mailto:skam.messenger@yandex.com?subject=${encodeURIComponent('Жалоба на статью в СКАМ')}&body=${encodeURIComponent(`Статья: ${articleUrl(a.slug)}\nЧто не так: `)}`;
    f.append(rep);
  }
  return f;
}

function setMeta(title: string, description: string): void {
  document.title = `${title} — СКАМ`;
  document.querySelector('meta[name="description"]')?.setAttribute('content', description || title);
}

// ---------------------------------------------------------------------------
// Чтение
// ---------------------------------------------------------------------------

function showArticle(a: ArticleFull): void {
  editor?.destroy();
  editor = null;
  setMeta(a.title, a.description);
  if (location.pathname !== `/a/${a.slug}`) history.replaceState(null, '', `/a/${a.slug}`);
  const art = el('article', 'tl');
  if (a.hidden) {
    art.append(el('p', 'tl-hidden-note', a.mine
      ? 'Команда СКАМ скрыла эту статью — по ссылке её больше не видно. Если это ошибка, напишите в поддержку.'
      : 'Статья скрыта модерацией: её видят только автор и команда СКАМ.'));
  }
  art.append(...articleHeader(a, {
    onAuthor: (href) => {
      // @username — откроем в СКАМ.
      if (href.startsWith('@')) { location.href = `/?c=${encodeURIComponent(href.slice(1))}`; return true; }
      return false;
    },
  }));
  const body = el('div', 'tl-body');
  body.append(renderNodes(a.content, {
    onLink: (href, ev) => {
      const slug = slugFromUrl(href);
      if (!slug || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button !== 0) return false;
      location.href = `/a/${slug}`;
      return true;
    },
  }));
  art.append(body);
  page.replaceChildren(art, footer(a));
  actions.replaceChildren();
  if (a.mine) {
    actions.append(abtn('Изменить', () => void startEdit(a)));
  }
  if (a.moderator && !a.mine) {
    actions.append(abtn(a.hidden ? 'Вернуть статью' : 'Скрыть статью', () => {
      hideArticle(a.id, !a.hidden)
        .then(() => { a.hidden = !a.hidden; toast(a.hidden ? 'Статья скрыта' : 'Статья снова видна'); showArticle(a); })
        .catch((e) => toast(errText(e, 'Не получилось.')));
    }, 'ap-btn ghost'));
  }
  actions.append(abtn('Поделиться', () => share(a), 'ap-btn primary'));
  if (!a.mine && !a.hidden) countView(a.slug);
}

function showMissing(): void {
  setMeta('Статья не найдена', '');
  const box = el('div', 'ap-empty');
  box.append(el('h1', null, 'Статья не найдена'),
    el('p', null, 'Возможно, автор удалил её или в ссылке опечатка. Проверьте адрес — он выглядит так: skam-messenger.ru/a/Nazvanie-10-12.'));
  const write = el('a', 'ap-btn primary', 'Написать свою статью');
  write.href = '/a/';
  box.append(write);
  page.replaceChildren(box, footer(null));
  actions.replaceChildren();
}

function showLogin(): void {
  setMeta('Новая статья', '');
  const box = el('div', 'ap-empty');
  box.append(el('h1', null, 'Напишите статью'),
    el('p', null, 'Как в Telegraph: заголовок, ваше имя и текст с картинками — и ссылка, которую можно отправить кому угодно. Прочитать статью можно и без СКАМ, а написать — только из своего аккаунта.'));
  const go = el('a', 'ap-btn primary', 'Войти в СКАМ');
  go.href = '/';
  box.append(go);
  page.replaceChildren(box, footer(null));
  actions.replaceChildren();
}

// ---------------------------------------------------------------------------
// Правка
// ---------------------------------------------------------------------------

type Draft = { title: string; author: string; authorUrl: string; content: ArticleFull['content']; at: number };
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
  } catch { /* без хранилища черновик не сохранится — не страшно */ }
}

async function startEdit(a: ArticleFull | null): Promise<void> {
  const uid = await myId();
  if (!uid) { showLogin(); return; }
  const draft = a ? null : readDraft();
  const init = a
    ? { title: a.title, author: a.author_name ?? '', authorUrl: a.author_url ?? '', content: a.content }
    : draft ?? { title: '', author: await myName(uid), authorUrl: '', content: [] };
  editor?.destroy();
  let draftTimer = 0;
  const ed = createEditor(init, {
    toast,
    onChange: () => {
      if (a) return;
      clearTimeout(draftTimer);
      draftTimer = window.setTimeout(() => { const v = ed.value(); writeDraft({ ...v, at: Date.now() }); }, 700);
    },
  });
  editor = ed;
  setMeta(a ? `Правка: ${a.title}` : 'Новая статья', '');
  page.replaceChildren(ed.root);
  if (draft) toast('Восстановили черновик');
  actions.replaceChildren();
  if (a) actions.append(abtn('Отмена', () => {
    if (ed.dirty() && !confirm('Не сохранять изменения?')) return;
    // Картинки, загруженные в эту правку, в статью не попали — убираем их из хранилища.
    removeArticleImages(ed.uploaded());
    showArticle(a);
  }, 'ap-btn ghost'));
  if (a) actions.append(abtn('Удалить', () => {
    if (!confirm('Удалить статью? Ссылка перестанет открываться, восстановить её будет нельзя.')) return;
    deleteArticle(a.id).then(() => { toast('Статья удалена'); location.href = '/a/'; })
      .catch((e) => toast(errText(e, 'Не получилось удалить статью.')));
  }, 'ap-btn ghost danger'));
  const publish = abtn(a ? 'Сохранить' : 'Опубликовать', () => void doSave(), 'ap-btn primary');
  actions.append(publish);
  const doSave = async () => {
    const problem = ed.check();
    if (problem) { toast(problem); return; }
    const v = ed.value();
    publish.disabled = true;
    try {
      const res = await saveArticle({ id: a?.id ?? null, title: v.title, author: v.author, authorUrl: v.authorUrl, content: v.content });
      removeArticleImages(droppedImages(a?.content ?? [], v.content, ed.uploaded()));
      if (!a) writeDraft(null);
      const fresh = await getArticle(res.slug);
      if (fresh) showArticle(fresh);
      toast(a ? 'Сохранено' : 'Опубликовано — ссылкой можно делиться');
    } catch (e) {
      toast(errText(e, 'Не получилось сохранить статью.'));
    } finally {
      publish.disabled = false;
    }
  };
  ed.focus();
}

window.addEventListener('beforeunload', (e) => {
  if (editor?.dirty() && editor.root.isConnected) { e.preventDefault(); }
});

// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  if (!configured) { page.replaceChildren(el('p', 'ap-note', 'Сайт собран без ключей сервера.')); return; }
  const slug = slugHere();
  if (!slug) { await startEdit(null); return; }
  if (!SLUG_RE.test(slug)) { showMissing(); return; }
  try {
    const a = await getArticle(slug);
    if (!a) showMissing();
    else showArticle(a);
  } catch (e) {
    page.replaceChildren(el('p', 'ap-note', errText(e, 'Не получилось загрузить статью. Проверьте соединение и обновите страницу.')));
  }
}

void start();
