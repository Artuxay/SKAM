// Неофициальные стикеры: свои наборы из картинок, ссылка ?stickers=<id>, «Добавить стикеры» по нажатию
// на чужой стикер. Особых меток у них нет — официальным остаётся только «Голубь свободы».
// Картинки: Storage stickers/<набор>/<стикер> (публичный бакет, список файлов закрыт), данные — RPC.
import type { StickerPackInfo } from '../lib/database.types';
import { sb } from '../lib/supabase';
import {
  $, ICONS, button, closeDialog, dlgHead, el, errText, html, openDialog, plural, toast, touchMQ,
} from '../lib/dom';
import {
  CUSTOM_PACK_RE, PACKS, packFromInfo, setCustomPacks, stickerUrl, type Sticker, type StickerPack,
} from '../lib/stickers';
import { S, appUrl } from './store';

/** Что нужно от основного интерфейса. */
export type StickerEnv = {
  /** Можно ли сейчас отправить стикер в открытый чат. */
  canSend: () => boolean;
  send: (s: Sticker) => void;
  /** Мои наборы изменились — перерисовать панель стикеров. */
  changed: () => void;
};
let env: StickerEnv | null = null;

export function mountStickerPacks(e: StickerEnv): void {
  env = e;
}

export const MAX_STICKERS = 120;
const MAX_BYTES = 500 * 1024;
const MAX_INPUT = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Данные
// ---------------------------------------------------------------------------

/** Мои наборы: созданные и добавленные (в порядке добавления). */
let mine: StickerPackInfo[] = [];
const cache = new Map<string, StickerPackInfo>();

export function myPackInfos(): StickerPackInfo[] {
  return mine;
}

export async function loadMyPacks(): Promise<void> {
  const { data, error } = await sb.rpc('my_sticker_packs');
  if (error) throw error;
  const list = ((data ?? []) as StickerPackInfo[]).filter((p) => CUSTOM_PACK_RE.test(p.id));
  const before = JSON.stringify(mine);
  mine = list;
  list.forEach((p) => cache.set(p.id, p));
  setCustomPacks(list);
  if (JSON.stringify(list) !== before) env?.changed();
}

export function resetStickerPacks(): void {
  mine = [];
  cache.clear();
  fetched.clear();
  setCustomPacks([]);
  P.stack = [];
}

/** Наборы, которые уже спрашивали у сервера (null — такого нет), и те, что грузятся сейчас. */
const fetched = new Set<string>();
const inflight = new Set<string>();

async function fetchPack(id: string): Promise<StickerPackInfo | null> {
  inflight.add(id);
  try {
    const { data, error } = await sb.rpc('sticker_pack', { p_pack: id });
    if (error) throw error;
    const info = (data ?? null) as StickerPackInfo | null;
    if (info) cache.set(id, info);
    else cache.delete(id);
    fetched.add(id);
    return info;
  } finally {
    inflight.delete(id);
  }
}

/** Освежить набор с сервера и перерисовать окно. */
function refreshPack(id: string): void {
  if (!CUSTOM_PACK_RE.test(id) || inflight.has(id)) return;
  fetchPack(id).then(() => rerender(), (e) => { fetched.add(id); toast(errText(e, 'Не получилось открыть набор.')); rerender(); });
}

export function packLink(id: string): string {
  return `${appUrl()}?stickers=${encodeURIComponent(id)}`;
}

/** Эмодзи стикера: одно-два эмодзи, без букв и пробелов (так же проверяет сервер). */
export function cleanEmoji(v: string): string | null {
  const t = v.trim();
  if (!t || [...t].length > 16 || /[A-Za-zА-Яа-яЁё<>\s]/.test(t)) return null;
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(t)) return null;
  return t;
}

/** Картинка стикера: до 512 px по большей стороне, WebP (в Safari — PNG), не больше 500 КБ. */
async function toStickerBlob(file: Blob): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('Это не картинка — выберите PNG, WebP, JPG или GIF');
  if (file.size > MAX_INPUT) throw new Error('Картинка больше 20 МБ');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    try { await img.decode(); } catch { throw new Error('Не получилось открыть картинку'); }
    const w0 = img.naturalWidth;
    const h0 = img.naturalHeight;
    if (!w0 || !h0) throw new Error('Не получилось открыть картинку');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Не получилось обработать картинку');
    const as = (type: string, q?: number) => new Promise<Blob | null>((r) => canvas.toBlob(r, type, q));
    for (const side of [512, 384, 256]) {
      const k = Math.min(1, side / Math.max(w0, h0));
      canvas.width = Math.max(1, Math.round(w0 * k));
      canvas.height = Math.max(1, Math.round(h0 * k));
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const q of [0.9, 0.75]) {
        let blob = await as('image/webp', q);
        if (!blob || blob.type !== 'image/webp') blob = await as('image/png');
        if (blob && blob.size <= MAX_BYTES) return blob;
        if (!blob || blob.type === 'image/png') break;
      }
    }
    throw new Error('Картинка слишком сложная — выберите попроще');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function newStickerId(): string {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), (x) => abc[x % 36]).join('');
}

export async function createPack(title: string): Promise<string> {
  const { data, error } = await sb.rpc('create_sticker_pack', { p_title: title });
  if (error) throw error;
  await loadMyPacks();
  return data;
}

export async function renamePack(id: string, title: string): Promise<void> {
  const { error } = await sb.rpc('rename_sticker_pack', { p_pack: id, p_title: title });
  if (error) throw error;
  await loadMyPacks();
}

/** Загрузить картинку и добавить стикер в свой набор. */
export async function uploadSticker(packId: string, file: Blob, emoji: string): Promise<void> {
  const blob = await toStickerBlob(file);
  const id = newStickerId();
  const path = `${packId}/${id}`;
  const up = await sb.storage.from('stickers').upload(path, blob, { contentType: blob.type, cacheControl: '31536000', upsert: false });
  if (up.error) throw up.error;
  const { error } = await sb.rpc('add_sticker', { p_pack: packId, p_id: id, p_emoji: emoji });
  if (error) {
    await sb.storage.from('stickers').remove([path]);
    throw error;
  }
}

export async function setStickerEmoji(packId: string, id: string, emoji: string): Promise<void> {
  const { error } = await sb.rpc('set_sticker_emoji', { p_pack: packId, p_id: id, p_emoji: emoji });
  if (error) throw error;
  await loadMyPacks();
}

export async function removeSticker(packId: string, id: string): Promise<void> {
  const { error } = await sb.rpc('remove_sticker', { p_pack: packId, p_id: id });
  if (error) throw error;
  await sb.storage.from('stickers').remove([`${packId}/${id}`]);
  await loadMyPacks();
}

/** Удалить набор: сначала картинки (пока набор мой — удалить их можно), потом сам набор. */
export async function deletePack(info: StickerPackInfo): Promise<void> {
  const paths = new Set(info.stickers.map((x) => `${info.id}/${x.id}`));
  const listed = await sb.storage.from('stickers').list(info.id, { limit: 200 });
  (listed.data ?? []).forEach((o) => paths.add(`${info.id}/${o.name}`));
  if (paths.size) {
    const r = await sb.storage.from('stickers').remove([...paths]);
    if (r.error) throw r.error;
  }
  const { error } = await sb.rpc('delete_sticker_pack', { p_pack: info.id });
  if (error) throw error;
  cache.delete(info.id);
  await loadMyPacks();
}

export async function addPack(id: string): Promise<void> {
  const { error } = await sb.rpc('add_sticker_pack', { p_pack: id });
  if (error) throw error;
  await loadMyPacks();
}

export async function removePack(id: string): Promise<void> {
  const { error } = await sb.rpc('remove_sticker_pack', { p_pack: id });
  if (error) throw error;
  await loadMyPacks();
}

// ---------------------------------------------------------------------------
// Окно «Стикеры»: мои наборы, набор, стикер, загрузка
// ---------------------------------------------------------------------------

type Item = { file: File; url: string; emoji: string; state: 'wait' | 'up' | 'done' | 'err'; err?: string };
type Page =
  | { p: 'list' }
  | { p: 'create' }
  | { p: 'pack'; id: string }
  | { p: 'sticker'; id: string; sid: string }
  | { p: 'upload'; id: string; items: Item[]; active: number; busy: boolean };

const P = { stack: [] as Page[] };

function dlg(): HTMLDialogElement {
  return $<HTMLDialogElement>('stickerDlg');
}

export function openStickerManager(): void {
  P.stack = [{ p: 'list' }];
  render();
  openDialog(dlg());
  void loadMyPacks().then(() => { if (dlg().open && top().p === 'list') render(); }, () => {});
}

/** Набор по ссылке или по нажатию на стикер в чате. */
export function openStickerPack(id: string): void {
  P.stack = [{ p: 'pack', id }];
  refreshPack(id);
  render();
  openDialog(dlg());
}

function top(): Page {
  return P.stack.at(-1) ?? { p: 'list' };
}

function go(p: Page): void {
  P.stack.push(p);
  render();
  dlg().scrollTop = 0;
}

function back(): void {
  const t = top();
  if (t.p === 'upload') t.items.forEach((x) => URL.revokeObjectURL(x.url));
  if (P.stack.length > 1) P.stack.pop();
  else { closeDialog(dlg()); return; }
  render();
}

/** Данные пришли — перерисовать, если не мешаем вводу. */
function rerender(): void {
  if (!dlg().open) return;
  const t = top();
  if (t.p === 'create' || t.p === 'upload') return;
  render();
}

function head(title: string): HTMLElement {
  const h = dlgHead(title, dlg());
  if (P.stack.length > 1) {
    const b = button('icon-btn dlg-back', null, back);
    b.append(html(ICONS.back));
    b.setAttribute('aria-label', 'Назад');
    h.prepend(b);
  }
  return h;
}

function render(): void {
  const t = top();
  let body: HTMLElement;
  switch (t.p) {
    case 'create': body = pageCreate(); break;
    case 'pack': body = pagePack(t.id); break;
    case 'sticker': body = pageSticker(t.id, t.sid); break;
    case 'upload': body = pageUpload(t); break;
    default: body = pageList();
  }
  dlg().replaceChildren(...body.childNodes);
}

function page(title: string): { root: HTMLElement; stack: HTMLElement } {
  const root = el('div');
  const stack = el('div', 'stack');
  root.append(head(title), stack);
  return { root, stack };
}

function cover(p: StickerPack | StickerPackInfo): HTMLElement {
  const c = el('span', 'spk-cover');
  const first = 'official' in p ? p.stickers[0]?.ref : p.stickers[0] ? `${p.id}/${p.stickers[0].id}` : null;
  if (first) {
    const img = el('img');
    img.src = stickerUrl(first);
    img.alt = '';
    img.loading = 'lazy';
    c.append(img);
  } else {
    c.append(html(ICONS.sticker));
  }
  return c;
}

function packRow(info: StickerPackInfo): HTMLElement {
  const b = button('spk-row', null, () => go({ p: 'pack', id: info.id }));
  const text = el('span', 'spk-text');
  const n = info.stickers.length;
  text.append(el('span', 'nm', info.title), el('span', 'st', `${n ? plural(n, 'стикер', 'стикера', 'стикеров') : 'пока пусто'}${info.mine ? ' · мой набор' : ''}`));
  const chev = el('span', 'ci-chev');
  chev.append(html(ICONS.next));
  b.append(cover(info), text, chev);
  return b;
}

function pageList(): HTMLElement {
  const { root, stack } = page('Стикеры');
  const create = button('btn primary btn-ic', null, () => go({ p: 'create' }));
  create.append(html(ICONS.plus), 'Создать набор');
  create.style.alignSelf = 'flex-start';
  stack.append(
    el('p', 'hint', 'Сделайте свой набор из любых картинок: у каждого стикера — своё эмодзи. Набором можно поделиться ссылкой, а чужой стикер в чате — нажать и добавить весь набор к себе.'),
    create,
  );
  const own = mine.filter((p) => p.mine);
  const added = mine.filter((p) => !p.mine);
  const section = (title: string, list: StickerPackInfo[]) => {
    const f = el('div', 'field');
    f.append(el('span', 'fld', title));
    const box = el('div', 'spk-list');
    list.forEach((p) => box.append(packRow(p)));
    f.append(box);
    stack.append(f);
  };
  if (own.length) section('Мои наборы', own);
  if (added.length) section('Добавленные', added);
  const off = el('div', 'field');
  off.append(el('span', 'fld', 'Официальные'));
  const box = el('div', 'spk-list');
  PACKS.forEach((p) => {
    const b = button('spk-row', null, () => go({ p: 'pack', id: p.id }));
    const text = el('span', 'spk-text');
    const nm = el('span', 'nm', p.title);
    nm.append(el('span', 'sp-badge', 'официальные'));
    text.append(nm, el('span', 'st', `${plural(p.stickers.length, 'стикер', 'стикера', 'стикеров')} · есть у всех`));
    const chev = el('span', 'ci-chev');
    chev.append(html(ICONS.next));
    b.append(cover(p), text, chev);
    box.append(b);
  });
  off.append(box);
  stack.append(off);
  return root;
}

function pageCreate(): HTMLElement {
  const { root, stack } = page('Новый набор');
  const f = el('div', 'field');
  const l = el('label', 'fld', 'Название набора');
  l.htmlFor = 'spkTitle';
  const inp = el('input', 'txt');
  Object.assign(inp, { id: 'spkTitle', maxLength: 64, placeholder: 'Например, «Мой кот»', autocomplete: 'off' });
  f.append(l, inp);
  const err = el('p', 'err');
  const go1 = button('btn primary', 'Создать', () => void submit());
  go1.style.alignSelf = 'flex-start';
  async function submit(): Promise<void> {
    const title = inp.value.replace(/\s+/g, ' ').trim();
    if (!title) { err.textContent = 'Введите название набора.'; inp.focus(); return; }
    go1.disabled = true;
    try {
      const id = await createPack(title);
      P.stack.pop();
      go({ p: 'pack', id });
      toast('Набор создан — добавьте стикеры');
    } catch (e) {
      err.textContent = errText(e, 'Не получилось создать набор.');
      go1.disabled = false;
    }
  }
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void submit(); } });
  stack.append(f, el('p', 'hint', 'Название видят все, с кем вы поделитесь набором. Потом его можно изменить.'), err, go1);
  if (!touchMQ.matches) queueMicrotask(() => inp.focus());
  return root;
}

function grid(stickers: Sticker[], onPick: ((s: Sticker) => void) | null, emojiChip = false): HTMLElement {
  const g = el('div', 'spk-grid');
  stickers.forEach((s) => {
    const b = el(onPick ? 'button' : 'span', 'spk-item');
    if (b instanceof HTMLButtonElement) {
      b.type = 'button';
      b.addEventListener('click', () => onPick!(s));
    }
    const img = el('img');
    img.src = stickerUrl(s.ref);
    img.alt = '';
    img.loading = 'lazy';
    img.draggable = false;
    b.append(img);
    if (emojiChip && s.emoji) b.append(el('span', 'spk-emoji', s.emoji));
    b.title = s.emoji ? `${s.label} ${s.emoji}` : s.label;
    b.setAttribute('aria-label', `Стикер ${s.emoji}`);
    g.append(b);
  });
  return g;
}

async function copyText(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast('Не получилось скопировать — выделите ссылку вручную.');
  }
}

function linkField(id: string, title: string): HTMLElement {
  const link = packLink(id);
  const f = el('div', 'field');
  f.append(el('span', 'fld', 'Ссылка на набор'));
  const box = el('div', 'invite');
  const inp = el('input', 'txt');
  Object.assign(inp, { readOnly: true, value: link });
  inp.setAttribute('aria-label', 'Ссылка на набор');
  inp.addEventListener('focus', () => inp.select());
  const share = button('btn ghost small', 'Копировать', async () => {
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (touchMQ.matches && nav.share) {
      try { await nav.share({ title: `Стикеры «${title}» в СКАМ`, text: 'Добавляй стикеры в СКАМ:', url: link }); return; } catch { /* отменили */ }
    }
    await copyText(link, 'Ссылка на набор скопирована');
  });
  box.append(inp, share);
  f.append(box);
  return f;
}

function armed(cls: string, label: string, confirm: string, fn: () => Promise<void>): HTMLButtonElement {
  let armedAt = 0;
  const b = button(cls, label, async () => {
    if (Date.now() - armedAt > 3000) {
      armedAt = Date.now();
      b.textContent = confirm;
      setTimeout(() => { if (b.isConnected && Date.now() - armedAt >= 3000) b.textContent = label; }, 3100);
      return;
    }
    b.disabled = true;
    try { await fn(); } finally { b.disabled = false; }
  });
  return b;
}

function sendAndClose(s: Sticker): void {
  if (!env?.canSend()) return;
  closeDialog(dlg());
  env.send(s);
}

function pagePack(id: string): HTMLElement {
  // Официальный набор: всегда у всех, особая метка «официальные».
  const official = PACKS.find((p) => p.id === id);
  if (official) {
    const { root, stack } = page(official.title);
    const sub = el('p', 'hint spk-sub');
    sub.append(el('span', 'sp-badge', 'официальные'), ` ${plural(official.stickers.length, 'стикер', 'стикера', 'стикеров')} · маскот СКАМ, есть у всех`);
    stack.append(sub, grid(official.stickers, env?.canSend() ? sendAndClose : null));
    if (env?.canSend()) stack.append(el('p', 'hint', 'Нажмите на стикер, чтобы отправить его в чат.'));
    return root;
  }
  const info = cache.get(id);
  if (!info) {
    const { root, stack } = page('Стикеры');
    const loading = CUSTOM_PACK_RE.test(id) && !fetched.has(id);
    stack.append(el('p', 'hint', loading ? 'Загружаем набор…' : 'Набор не найден: его удалили или ссылка неверная.'));
    if (loading) refreshPack(id);
    return root;
  }
  const pack = packFromInfo(info);
  const n = pack.stickers.length;
  const { root, stack } = page(info.title);

  if (info.mine) {
    stack.append(el('p', 'hint spk-sub', `${n ? plural(n, 'стикер', 'стикера', 'стикеров') : 'Пока пусто'} · мой набор`));
    if (n) stack.append(grid(pack.stickers, (s) => go({ p: 'sticker', id, sid: s.ref.split('/')[1] }), true));
    if (n < MAX_STICKERS) {
      const file = el('input');
      Object.assign(file, { type: 'file', accept: 'image/png,image/webp,image/jpeg,image/gif', multiple: true, hidden: true });
      file.addEventListener('change', () => {
        const files = [...(file.files ?? [])].filter((f) => f.type.startsWith('image/')).slice(0, MAX_STICKERS - n);
        file.value = '';
        if (!files.length) return;
        go({ p: 'upload', id, items: files.map((f) => ({ file: f, url: URL.createObjectURL(f), emoji: '🙂', state: 'wait' })), active: 0, busy: false });
      });
      const add = button('btn primary btn-ic', null, () => file.click());
      add.append(html(ICONS.plus), 'Добавить стикеры');
      add.style.alignSelf = 'flex-start';
      stack.append(add, file, el('p', 'hint', `Картинки PNG или WebP с прозрачным фоном смотрятся лучше всего. До ${MAX_STICKERS} стикеров в наборе. Нажмите на стикер, чтобы сменить эмодзи или удалить его.`));
    }
    // Название
    const f = el('div', 'field');
    const l = el('label', 'fld', 'Название');
    l.htmlFor = 'spkRename';
    const row = el('div', 'invite');
    const inp = el('input', 'txt');
    Object.assign(inp, { id: 'spkRename', maxLength: 64, value: info.title });
    const save = button('btn ghost small', 'Сохранить', async () => {
      const title = inp.value.replace(/\s+/g, ' ').trim();
      if (!title || title === info.title) return;
      save.disabled = true;
      try { await renamePack(id, title); await fetchPack(id); toast('Название сохранено'); render(); } catch (e) { toast(errText(e)); save.disabled = false; }
    });
    row.append(inp, save);
    f.append(l, row);
    stack.append(f, linkField(id, info.title));
    stack.append(el('div', 'hr'), armed('btn danger', 'Удалить набор', 'Точно? У всех он пропадёт', async () => {
      try {
        await deletePack(info);
        toast('Набор удалён');
        if (P.stack.length > 1) back(); else closeDialog(dlg());
      } catch (e) { toast(errText(e, 'Не получилось удалить набор.')); }
    }));
    return root;
  }

  // Чужой набор: добавить к себе или убрать; нажатие на стикер — отправить.
  stack.append(el('p', 'hint spk-sub', n ? plural(n, 'стикер', 'стикера', 'стикеров') : 'В наборе пока нет стикеров'));
  if (n) stack.append(grid(pack.stickers, env?.canSend() ? sendAndClose : null));
  const acts = el('div', 'dlg-actions spk-acts');
  if (info.added) {
    acts.append(button('btn ghost', 'Убрать из моих стикеров', async (ev) => {
      const b = ev.currentTarget as HTMLButtonElement;
      b.disabled = true;
      try { await removePack(id); await fetchPack(id); toast('Набор убран'); render(); } catch (e) { toast(errText(e)); b.disabled = false; }
    }));
  } else if (n) {
    acts.append(button('btn primary', `Добавить ${plural(n, 'стикер', 'стикера', 'стикеров')}`, async (ev) => {
      const b = ev.currentTarget as HTMLButtonElement;
      b.disabled = true;
      try { await addPack(id); await fetchPack(id); toast(`Набор «${info.title}» добавлен`); render(); } catch (e) { toast(errText(e)); b.disabled = false; }
    }));
  }
  if (acts.childNodes.length) stack.append(acts);
  if (env?.canSend() && n) stack.append(el('p', 'hint', 'Нажмите на стикер, чтобы отправить его в чат.'));
  stack.append(linkField(id, info.title));
  if (S.appOwner) {
    stack.append(el('div', 'hr'), armed('btn danger', 'Удалить набор (модерация)', 'Точно удалить у всех?', async () => {
      try {
        await deletePack(info);
        toast('Набор удалён');
        closeDialog(dlg());
      } catch (e) { toast(errText(e, 'Не получилось удалить набор.')); }
    }), el('p', 'hint', 'Вы владелец СКАМ: можно удалить любой неофициальный набор, если он нарушает правила.'));
  }
  return root;
}

// Эмодзи: поле ввода и быстрый выбор (на компьютере эмодзи неудобно набирать).
const QUICK = ['🙂', '😀', '😂', '🤣', '😍', '🥰', '😘', '😎', '🤔', '🙄', '😴', '😢', '😭', '😡', '😱', '🤡',
  '👍', '👎', '👋', '🙏', '👏', '💪', '🔥', '❤️', '💔', '🎉', '💯', '✅', '❌', '🕊️', '🐈', '🍕'];

function quickGrid(onPick: (e: string) => void): HTMLElement {
  const g = el('div', 'emoji-grid spk-quick');
  QUICK.forEach((e) => {
    const b = button('emoji-opt', e, () => onPick(e));
    b.setAttribute('aria-label', e);
    g.append(b);
  });
  return g;
}

function pageSticker(id: string, sid: string): HTMLElement {
  const info = cache.get(id);
  const s = info?.stickers.find((x) => x.id === sid);
  const { root, stack } = page('Стикер');
  if (!info || !s) { stack.append(el('p', 'hint', 'Стикер не найден.')); return root; }
  const big = el('img', 'spk-big');
  big.src = stickerUrl(`${id}/${sid}`);
  big.alt = '';
  const f = el('div', 'field');
  const l = el('label', 'fld', 'Эмодзи');
  l.htmlFor = 'spkEmoji';
  const row = el('div', 'invite');
  const inp = el('input', 'txt spk-emoji-in');
  Object.assign(inp, { id: 'spkEmoji', maxLength: 16, value: s.emoji, autocomplete: 'off' });
  const save = button('btn primary small', 'Сохранить', () => void submit());
  row.append(inp, save);
  f.append(l, row, quickGrid((e) => { inp.value = e; void submit(); }),
    el('p', 'hint', 'По этому эмодзи стикер подсказывается при наборе и виден в списке чатов.'));
  async function submit(): Promise<void> {
    const e = cleanEmoji(inp.value);
    if (!e) { toast('Выберите одно эмодзи — без букв.'); inp.focus(); return; }
    if (e === s!.emoji) return;
    save.disabled = true;
    try { await setStickerEmoji(id, sid, e); toast('Эмодзи сохранено'); back(); } catch (err) { toast(errText(err)); save.disabled = false; }
  }
  stack.append(big, f, el('div', 'hr'), armed('btn danger', 'Удалить стикер', 'Точно удалить?', async () => {
    try { await removeSticker(id, sid); toast('Стикер удалён'); back(); } catch (e) { toast(errText(e, 'Не получилось удалить стикер.')); }
  }));
  return root;
}

function pageUpload(t: Extract<Page, { p: 'upload' }>): HTMLElement {
  const info = cache.get(t.id);
  const { root, stack } = page('Новые стикеры');
  stack.append(el('p', 'hint', 'Выберите эмодзи для каждого стикера: нажмите на картинку, потом на эмодзи ниже или введите своё.'));
  const list = el('div', 'spk-up-list');
  t.items.forEach((it, i) => {
    const row = el('div', `spk-up${i === t.active ? ' on' : ''}${it.state === 'err' ? ' bad' : ''}`);
    const pick = button('spk-up-img', null, () => { t.active = i; render(); });
    pick.setAttribute('aria-label', `Стикер ${i + 1}`);
    const img = el('img');
    img.src = it.url;
    img.alt = '';
    pick.append(img);
    const inp = el('input', 'txt spk-emoji-in');
    Object.assign(inp, { maxLength: 16, value: it.emoji, disabled: t.busy || it.state === 'done' });
    inp.setAttribute('aria-label', `Эмодзи стикера ${i + 1}`);
    inp.addEventListener('focus', () => { if (t.active !== i) { t.active = i; list.querySelectorAll('.spk-up').forEach((r, k) => r.classList.toggle('on', k === i)); } });
    inp.addEventListener('input', () => { it.emoji = inp.value; });
    const st = el('span', 'spk-up-st', it.state === 'up' ? 'загружаем…' : it.state === 'done' ? 'готово ✓' : it.state === 'err' ? it.err ?? 'ошибка' : '');
    row.append(pick, inp, st);
    list.append(row);
  });
  stack.append(list, quickGrid((e) => {
    const it = t.items[t.active];
    if (!it || t.busy || it.state === 'done') return;
    it.emoji = e;
    const next = t.items.findIndex((x, k) => k > t.active && x.state !== 'done');
    if (next >= 0) t.active = next;
    render();
  }));
  const left = t.items.filter((x) => x.state !== 'done').length;
  const upload = button('btn primary', t.busy ? 'Загружаем…' : `Загрузить ${plural(left, 'стикер', 'стикера', 'стикеров')}`, () => void run());
  upload.disabled = t.busy || !left;
  upload.style.alignSelf = 'flex-start';
  stack.append(upload);
  if (info) stack.append(el('p', 'hint', `Набор «${info.title}»: сейчас ${plural(info.stickers.length, 'стикер', 'стикера', 'стикеров')}, можно до ${MAX_STICKERS}.`));

  async function run(): Promise<void> {
    const bad = t.items.findIndex((x) => x.state !== 'done' && !cleanEmoji(x.emoji));
    if (bad >= 0) { t.active = bad; render(); toast('У каждого стикера должно быть эмодзи — без букв.'); return; }
    t.busy = true;
    render();
    let ok = 0;
    for (const it of t.items) {
      if (it.state === 'done') continue;
      it.state = 'up';
      if (top() === t) render();
      try {
        await uploadSticker(t.id, it.file, cleanEmoji(it.emoji)!);
        it.state = 'done';
        ok++;
      } catch (e) {
        it.state = 'err';
        it.err = errText(e, 'не загрузился');
      }
      if (top() === t) render();
    }
    t.busy = false;
    await loadMyPacks().catch(() => {});
    await fetchPack(t.id).catch(() => null);
    if (ok) toast(`Добавлено: ${plural(ok, 'стикер', 'стикера', 'стикеров')}`);
    if (top() !== t) return;
    if (t.items.every((x) => x.state === 'done')) back();
    else render();
  }
  return root;
}
