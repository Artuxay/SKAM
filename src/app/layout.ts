// Папки с чатами и закреплённые чаты — как в Telegram.
// Хранятся на сервере (одинаковые на всех устройствах); здесь — их копия и правила, какой чат куда попадает.
import { sb } from '../lib/supabase';
import type { ChatFolder, ChatLayout, FolderKind, MyChat } from '../lib/database.types';
import { lsGet, lsSet, plural } from '../lib/dom';
import { S, chatMuted, emit, ts } from './store';

export const MAX_PINS = 10;
export const MAX_FOLDERS = 20;
export const MAX_FOLDER_CHATS = 200;
export const FOLDER_TITLE_MAX = 24;

export const FOLDER_KINDS: { k: FolderKind; label: string; icon: string }[] = [
  { k: 'direct', label: 'Личные чаты', icon: '👤' },
  { k: 'group', label: 'Группы', icon: '👥' },
  { k: 'channel', label: 'Каналы', icon: '📢' },
  { k: 'bot', label: 'Боты', icon: '🤖' },
];

/** Значки папок на выбор. */
export const FOLDER_ICONS = [
  '📁', '💬', '👤', '👥', '📢', '🤖', '⭐', '❤️', '🔥', '✅', '🔔', '💼',
  '🏠', '🎓', '📚', '🎮', '🎵', '⚽', '✈️', '🛒', '💰', '🎉', '👑', '🐱',
];

/** Вкладки по типу чата — пока своих папок нет: «Все», «Личные», «Группы», «Каналы». */
export type KindTab = 'all' | 'direct' | 'group' | 'channel';
export const KIND_TABS: { k: KindTab; label: string }[] = [
  { k: 'all', label: 'Все' },
  { k: 'direct', label: 'Личные' },
  { k: 'group', label: 'Группы' },
  { k: 'channel', label: 'Каналы' },
];

function savedKind(): KindTab {
  const k = lsGet('skam:kind');
  return k === 'direct' || k === 'group' || k === 'channel' ? k : 'all';
}

export const L = {
  /** Открытая вкладка по типу (действует, только когда своих папок нет). */
  kind: savedKind(),
  /** Закреплённые в «Все чаты», сверху вниз. */
  pins: [] as string[],
  folders: [] as ChatFolder[],
  loaded: false,
  /** Открытая папка; null — «Все чаты». */
  cur: null as string | null,
};

let loadedAt = 0;
let lastJson = '';
/** Счётчик изменений: ответ загрузки, начатой до изменения, устарел — его не применяем. */
let mut = 0;
/** Изменения, которые ещё едут на сервер, и была ли за это время отброшена загрузка. */
let inflight = 0;
let staleLoad = false;

export function resetLayout(): void {
  inflight = 0;
  staleLoad = false;
  L.pins = [];
  L.folders = [];
  L.loaded = false;
  L.cur = null;
  L.kind = savedKind();
  loadedAt = 0;
  lastJson = '';
}

/** Загрузить папки и закреплённые. Без force — не чаще раза в 15 секунд (для опроса и возврата во вкладку). */
export async function loadLayout(force = false): Promise<void> {
  if (!force && L.loaded && Date.now() - loadedAt < 15_000) return;
  const my = mut;
  const { data, error } = await sb.rpc('my_chat_layout');
  if (error) throw error;
  // Пока изменение едет на сервер, ответ может быть старым — перечитаем, когда оно доедет.
  if (my !== mut || inflight) { staleLoad = true; return; }
  loadedAt = Date.now();
  apply(data ?? { pins: [], folders: [] });
}

function apply(data: ChatLayout): void {
  const json = JSON.stringify(data);
  const first = !L.loaded;
  L.loaded = true;
  if (json === lastJson && !first) return;
  lastJson = json;
  L.pins = data.pins ?? [];
  L.folders = (data.folders ?? []).map((f) => ({
    ...f, kinds: f.kinds ?? [], include: f.include ?? [], exclude: f.exclude ?? [], pinned: f.pinned ?? [],
  }));
  if (first) {
    const saved = lsGet('skam:folder');
    L.cur = saved && L.folders.some((f) => f.id === saved) ? saved : null;
  } else if (L.cur && !folderById(L.cur)) {
    L.cur = null;
    lsSet('skam:folder', null);
  }
  emit('chats', 'layout');
}

export function folderById(id: string | null | undefined): ChatFolder | undefined {
  return id ? L.folders.find((f) => f.id === id) : undefined;
}

/** Бот — в «Личных»: это переписка один на один. */
export function kindOf(c: MyChat): KindTab {
  return c.kind === 'group' ? 'group' : c.kind === 'channel' ? 'channel' : 'direct';
}

/** Вкладка по типу, которая сейчас действует (со своими папками — всегда «Все»). */
export function activeKind(): KindTab {
  return L.folders.length ? 'all' : L.kind;
}

export function setKind(k: KindTab): void {
  L.kind = k;
  lsSet('skam:kind', k === 'all' ? null : k);
  emit('chats', 'layout');
}

/** Открыть папку (null — «Все чаты»). Запоминается на этом устройстве. */
export function setFolder(id: string | null): void {
  L.cur = id && folderById(id) ? id : null;
  lsSet('skam:folder', L.cur);
  emit('chats', 'layout');
}

// ---------------------------------------------------------------------------
// Какой чат куда попадает
// ---------------------------------------------------------------------------

/** Чат в папке: закреплённый — всегда; исключённый — никогда; иначе выбранный или подходящего типа. */
export function inFolder(c: MyChat, f: ChatFolder): boolean {
  if (f.pinned.includes(c.id)) return true;
  if (f.exclude.includes(c.id)) return false;
  if (!f.include.includes(c.id) && !f.kinds.includes(c.kind as FolderKind)) return false;
  // «Без прочитанных»: открытый сейчас чат не пропадает, пока его читают (как в Telegram).
  if (f.no_read && !c.unread && c.id !== S.cur) return false;
  return true;
}

function byRecent(a: MyChat, b: MyChat): number {
  return ts(b.last_at ?? b.created_at) - ts(a.last_at ?? a.created_at);
}

/** Закреплённые в списке (в папке — свои). */
export function pinsOf(folderId: string | null): string[] {
  const f = folderById(folderId);
  return f ? f.pinned : L.pins;
}

export function isPinned(chatId: string, folderId: string | null): boolean {
  return pinsOf(folderId).includes(chatId);
}

/** Чаты списка: сначала закреплённые по порядку, потом остальные — свежие сверху. kind — вкладка по типу (вне папок). */
export function listChats(folderId: string | null = L.cur, kind: KindTab = 'all'): MyChat[] {
  const f = folderById(folderId);
  const fits = (c: MyChat) => !!f || kind === 'all' || kindOf(c) === kind;
  const pinned = pinsOf(folderId).map((id) => S.chats.get(id)).filter((c): c is MyChat => !!c && fits(c));
  const pinSet = new Set(pinned.map((c) => c.id));
  const rest = [...S.chats.values()].filter((c) => !pinSet.has(c.id) && (!f || inFolder(c, f)) && fits(c)).sort(byRecent);
  return [...pinned, ...rest];
}

/** Непрочитанные в папке (или во всех чатах, или во вкладке по типу) — без открытого чата и чатов «без звука». */
export function unreadIn(folderId: string | null, kind: KindTab = 'all'): number {
  const f = folderById(folderId);
  const visible = S.visibleChat();
  let n = 0;
  S.chats.forEach((c) => {
    if (c.unread && c.id !== visible && !chatMuted(c.id) && (!f || inFolder(c, f)) && (f || kind === 'all' || kindOf(c) === kind)) n += c.unread;
  });
  return n;
}

/** Значок папки: выбранный или по содержимому. */
export function folderIcon(f: ChatFolder): string {
  if (f.emoji) return f.emoji;
  if (f.no_read) return '🔔';
  if (!f.include.length && f.kinds.length === 1) return FOLDER_KINDS.find((k) => k.k === f.kinds[0])!.icon;
  if (!f.include.length && f.kinds.length === 2 && f.kinds.includes('direct') && f.kinds.includes('bot')) return '👤';
  return '📁';
}

/** Коротко о содержимом папки: «Группы, каналы» или «3 чата». */
export function folderSummary(f: ChatFolder): string {
  const parts: string[] = f.kinds.map((k) => FOLDER_KINDS.find((x) => x.k === k)!.label.toLowerCase());
  const extra = f.include.filter((id) => {
    const c = S.chats.get(id);
    return c && !f.kinds.includes(c.kind as FolderKind);
  }).length;
  if (extra) parts.push(plural(extra, 'чат', 'чата', 'чатов'));
  let s = parts.join(', ') || 'пусто';
  if (f.no_read) s += ', без прочитанных';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Изменения: сразу на экране, потом на сервере; ошибка — вернуть как было на сервере
// ---------------------------------------------------------------------------

async function mutate<T>(local: () => void, call: () => PromiseLike<{ data: T | null; error: unknown }>): Promise<T | null> {
  mut++;
  inflight++;
  local();
  emit('chats', 'layout');
  let res: { data: T | null; error: unknown };
  try {
    res = await call();
  } finally {
    inflight--;
  }
  if (res.error) {
    await loadLayout(true).catch(() => {});
    throw res.error;
  }
  lastJson = '';
  if (staleLoad && !inflight) {
    staleLoad = false;
    void loadLayout(true).catch(() => {});
  }
  return res.data;
}

const without = (arr: string[], id: string) => arr.filter((x) => x !== id);

export async function pinChat(chatId: string, on: boolean, folderId: string | null = L.cur): Promise<void> {
  const f = folderById(folderId);
  const pins = pinsOf(folderId);
  if (on && !pins.includes(chatId) && pins.length >= MAX_PINS) {
    throw new Error(f ? `В папке можно закрепить не больше ${MAX_PINS} чатов — открепите ненужные`
      : `Закрепить можно не больше ${MAX_PINS} чатов — открепите ненужные`);
  }
  await mutate(() => {
    if (!f) {
      L.pins = on ? [chatId, ...without(L.pins, chatId)] : without(L.pins, chatId);
      return;
    }
    f.pinned = on ? [chatId, ...without(f.pinned, chatId)] : without(f.pinned, chatId);
    if (on) {
      if (!f.include.includes(chatId)) f.include = [...f.include, chatId];
      f.exclude = without(f.exclude, chatId);
    }
  }, () => sb.rpc('pin_chat', { p_chat: chatId, p_on: on, p_folder: f ? f.id : null }));
}

/** Новый порядок закреплённых (после перетаскивания). */
export async function reorderPins(ids: string[], folderId: string | null = L.cur): Promise<void> {
  const f = folderById(folderId);
  await mutate(() => {
    if (f) f.pinned = ids;
    else L.pins = ids;
  }, () => sb.rpc('reorder_pinned_chats', { p_ids: ids, p_folder: f ? f.id : null }));
}

/** Добавить чат в папку или убрать из неё. */
export async function setChatInFolder(folderId: string, chatId: string, on: boolean): Promise<void> {
  const f = folderById(folderId);
  const c = S.chats.get(chatId);
  if (!f || !c) return;
  if (on && !f.include.includes(chatId) && f.include.length >= MAX_FOLDER_CHATS) {
    throw new Error(`В папку можно выбрать не больше ${MAX_FOLDER_CHATS} чатов`);
  }
  await mutate(() => {
    if (on) {
      if (!f.include.includes(chatId)) f.include = [...f.include, chatId];
      f.exclude = without(f.exclude, chatId);
    } else {
      f.include = without(f.include, chatId);
      f.pinned = without(f.pinned, chatId);
      if (f.kinds.includes(c.kind as FolderKind) && !f.exclude.includes(chatId)) f.exclude = [...f.exclude, chatId];
    }
  }, () => sb.rpc('folder_set_chat', { p_folder: folderId, p_chat: chatId, p_in: on }));
}

export type FolderDraft = Omit<ChatFolder, 'id' | 'pinned'> & { id: string | null };

/** Создать или сохранить папку. Возвращает её id. */
export async function saveFolder(d: FolderDraft): Promise<string> {
  if (!d.id && L.folders.length >= MAX_FOLDERS) throw new Error(`Можно создать не больше ${MAX_FOLDERS} папок`);
  mut++;
  inflight++;
  let res;
  try {
    res = await sb.rpc('save_chat_folder', {
      p_id: d.id, p_title: d.title, p_emoji: d.emoji, p_kinds: d.kinds,
      p_include: d.include, p_exclude: d.exclude, p_no_read: d.no_read,
    });
  } finally {
    inflight--;
  }
  if (res.error) throw res.error;
  staleLoad = false;
  await loadLayout(true).catch(() => {});
  return res.data;
}

export async function deleteFolder(id: string): Promise<void> {
  await mutate(() => {
    L.folders = L.folders.filter((f) => f.id !== id);
    if (L.cur === id) { L.cur = null; lsSet('skam:folder', null); }
  }, () => sb.rpc('delete_chat_folder', { p_id: id }));
}

export async function reorderFolders(ids: string[]): Promise<void> {
  await mutate(() => {
    const byId = new Map(L.folders.map((f) => [f.id, f]));
    L.folders = ids.map((id) => byId.get(id)).filter((f): f is ChatFolder => !!f);
  }, () => sb.rpc('reorder_chat_folders', { p_ids: ids }));
}
