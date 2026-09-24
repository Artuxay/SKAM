// Состояние приложения и работа с данными Supabase.
import type { User } from '@supabase/supabase-js';
import { sb } from '../lib/supabase';
import type { Database, Member, Message, MyChat, Profile, Reaction, ReactionKey } from '../lib/database.types';
import { uuid } from '../lib/dom';
import type { Sticker } from '../lib/stickers';

export type Msg = Message & {
  pending?: boolean;
  failed?: boolean;
  /** Голосовое или кружочек, записанные здесь: файл, пока он не загружен в хранилище. */
  blob?: Blob;
  uploaded?: boolean;
};
export type Feed = { msgs: Msg[]; loaded: boolean; hasMore: boolean; loadingOlder: boolean; error: boolean };

export const PAGE = 50;
export const REACTIONS: { k: ReactionKey; e: string }[] = [
  { k: 'like', e: '👍' }, { k: 'lol', e: '😂' }, { k: 'fire', e: '🔥' }, { k: 'wow', e: '😱' }, { k: 'clown', e: '🤡' },
];

export const S = {
  user: null as User | null,
  me: null as Profile | null,
  profiles: new Map<string, Profile>(),
  chats: new Map<string, MyChat>(),
  chatsLoaded: false,
  cur: null as string | null,
  feeds: new Map<string, Feed>(),
  reactions: new Map<string, Reaction[]>(),
  members: new Map<string, Member[]>(),
  inChat: new Set<string>(),
  typing: new Map<string, number>(),
  /** Кто сейчас записывает голосовое или кружочек (вместо «печатает…»). */
  typingWhat: new Map<string, 'voice' | 'video_note'>(),
  /** UI сообщает, какой чат сейчас реально виден пользователю (для непрочитанных). */
  visibleChat: (): string | null => null,
};

export function meId(): string {
  return S.user?.id ?? '';
}

// ---------------------------------------------------------------------------
// События → перерисовка (склеиваем несколько изменений за один тик)
// ---------------------------------------------------------------------------

export type Evt = 'chats' | 'feed' | 'head' | 'online' | 'me' | 'members';
const listeners = new Map<Evt, Set<() => void>>();
const pending = new Set<Evt>();
let scheduled = false;

export function on(evt: Evt, fn: () => void): () => void {
  let set = listeners.get(evt);
  if (!set) listeners.set(evt, (set = new Set()));
  set.add(fn);
  return () => set.delete(fn);
}

export function emit(...evts: Evt[]): void {
  evts.forEach((e) => pending.add(e));
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    const now = [...pending];
    pending.clear();
    now.forEach((e) => listeners.get(e)?.forEach((fn) => fn()));
  });
}

export function resetState(): void {
  S.user = null;
  S.me = null;
  S.profiles.clear();
  S.chats.clear();
  S.chatsLoaded = false;
  S.cur = null;
  S.feeds.clear();
  S.reactions.clear();
  S.members.clear();
  S.inChat.clear();
  S.typing.clear();
  S.typingWhat.clear();
  listeners.clear();
  pending.clear();
}

// ---------------------------------------------------------------------------
// Профили
// ---------------------------------------------------------------------------

export class NoProfileError extends Error {}

export async function loadMe(user: User): Promise<void> {
  S.user = user;
  const { data, error } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (error) throw error;
  if (!data) throw new NoProfileError('profile missing');
  S.me = data;
  S.profiles.set(data.id, data);
  emit('me');
}

const inflight = new Set<string>();
export async function ensureProfiles(ids: (string | null | undefined)[]): Promise<void> {
  const need = [...new Set(ids)].filter((x): x is string => !!x && !S.profiles.has(x) && !inflight.has(x));
  if (!need.length) return;
  need.forEach((i) => inflight.add(i));
  try {
    for (let i = 0; i < need.length; i += 100) {
      const { data } = await sb.from('profiles').select('*').in('id', need.slice(i, i + 100));
      data?.forEach((p) => S.profiles.set(p.id, p));
    }
  } finally {
    need.forEach((i) => inflight.delete(i));
  }
  emit('chats', 'feed', 'head', 'online', 'members');
}

/** Перечитать уже известные профили (когда нет Realtime и изменения имён не приходят сами). */
export async function refreshProfiles(): Promise<void> {
  const ids = [...S.profiles.keys()];
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await sb.from('profiles').select('*').in('id', ids.slice(i, i + 100));
    data?.forEach((p) => {
      const old = S.profiles.get(p.id);
      if (!old || old.updated_at !== p.updated_at) putProfile(p);
    });
  }
}

export function putProfile(p: Profile): void {
  const old = S.profiles.get(p.id);
  S.profiles.set(p.id, p);
  if (p.id === meId()) S.me = p;
  // Пульс «в сети» меняет только время — ленту сообщений в этом случае не перерисовываем.
  const onlyPresence = !!old && (['name', 'username', 'avatar_path', 'color'] as const).every((k) => old[k] === p[k]);
  if (onlyPresence) emit('online', 'head', 'chats', 'members', ...(p.id === meId() ? (['me'] as const) : []));
  else emit('chats', 'feed', 'head', 'online', 'members', 'me');
}

/** username = null — только для аккаунтов-исключений (profiles.username_optional). */
export type ProfileFields = { first_name: string; last_name: string | null; username: string | null };

/** Нужен ли мне @username: обязателен всем, кроме аккаунтов-исключений. */
export function usernameRequired(): boolean {
  return !S.me?.username_optional;
}

export async function updateMyProfile(fields: ProfileFields): Promise<void> {
  const { data, error } = await sb.from('profiles').update(fields).eq('id', meId()).select().single();
  if (error) throw error;
  putProfile(data);
}

export async function usernameAvailable(username: string): Promise<boolean> {
  const { data, error } = await sb.rpc('username_available', { p_username: username });
  if (error) throw error;
  return !!data;
}

export type FoundUser = Database['public']['Functions']['search_users']['Returns'][number];

/** Минимум символов в запросе поиска людей (как в search_users на сервере). */
export const SEARCH_MIN = 2;

/**
 * Поиск людей по имени, фамилии или @username.
 * «@ivan» — только по @username; «иван пет» — каждое слово совпадает с началом имени, фамилии или @username.
 */
export async function searchUsers(query: string, limit = 20): Promise<FoundUser[]> {
  const { data, error } = await sb.rpc('search_users', { p_query: query, p_limit: limit });
  if (error) throw error;
  return data ?? [];
}

/** Нормализация для поиска — как private.search_norm на сервере: нижний регистр, «ё» → «е». */
export function searchNorm(v: string): string {
  return v.trim().toLowerCase().replace(/ё/g, 'е');
}

/** Нормализация @username: без @, в нижнем регистре. */
export function normUsername(v: string): string {
  return v.trim().replace(/^@+/, '').toLowerCase();
}
export const USERNAME_RE = /^[a-z][a-z0-9_]{4,31}$/;

async function toSquare(file: Blob, size = 256): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
    const as = (type: string, q: number) => new Promise<Blob | null>((r) => canvas.toBlob(r, type, q));
    let blob = await as('image/webp', 0.86);
    if (!blob || blob.type !== 'image/webp') blob = await as('image/jpeg', 0.88);
    if (!blob) throw new Error('encode');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function uploadAvatar(file: File): Promise<void> {
  if (!file.type.startsWith('image/')) throw new Error('Выберите картинку');
  const blob = await toSquare(file);
  const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${meId()}/${Date.now().toString(36)}.${ext}`;
  const up = await sb.storage.from('avatars').upload(path, blob, { contentType: blob.type, cacheControl: '31536000', upsert: false });
  if (up.error) throw up.error;
  const old = S.me?.avatar_path;
  const { data, error } = await sb.from('profiles').update({ avatar_path: path }).eq('id', meId()).select().single();
  if (error) {
    await sb.storage.from('avatars').remove([path]);
    throw error;
  }
  putProfile(data);
  if (old) void sb.storage.from('avatars').remove([old]);
}

export async function removeAvatar(): Promise<void> {
  const old = S.me?.avatar_path;
  const { data, error } = await sb.from('profiles').update({ avatar_path: null }).eq('id', meId()).select().single();
  if (error) throw error;
  putProfile(data);
  if (old) void sb.storage.from('avatars').remove([old]);
}

// ---------------------------------------------------------------------------
// Чаты
// ---------------------------------------------------------------------------

export function ts(iso: string | null | undefined): number {
  return iso ? Date.parse(iso) : 0;
}

export function sortedChats(): MyChat[] {
  return [...S.chats.values()].sort((a, b) => ts(b.last_at ?? b.created_at) - ts(a.last_at ?? a.created_at));
}

export async function loadChats(): Promise<void> {
  const { data, error } = await sb.rpc('my_chats');
  if (error) throw error;
  const next = new Map<string, MyChat>();
  for (const c of data ?? []) {
    // Если этот чат открыт и виден — не показываем «непрочитанные» из-за гонки.
    if (S.visibleChat() === c.id) c.unread = 0;
    next.set(c.id, c);
  }
  S.chats = next;
  S.chatsLoaded = true;
  for (const id of [...S.feeds.keys()]) if (!next.has(id)) S.feeds.delete(id);
  emit('chats');
  await ensureProfiles((data ?? []).flatMap((c) => [c.peer_id, c.last_user_id]));
  emit('chats', 'head', 'feed');
}

let reloadTimer: number | undefined;
export function reloadChatsSoon(): void {
  clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(() => { loadChats().catch(() => {}); }, 400);
}

export async function createChat(name: string, emoji: string): Promise<string> {
  const { data, error } = await sb.rpc('create_chat', { p_name: name, p_emoji: emoji });
  if (error) throw error;
  await loadChats();
  return data.id;
}

export async function previewInvite(code: string) {
  const { data, error } = await sb.rpc('chat_by_invite', { p_code: code });
  if (error) throw error;
  return data?.[0] ?? null;
}

export async function joinByInvite(code: string): Promise<string> {
  const { data, error } = await sb.rpc('join_chat', { p_code: code });
  if (error) throw error;
  await loadChats();
  return data;
}

export async function openDirect(userId: string): Promise<string> {
  const { data, error } = await sb.rpc('open_direct', { p_user: userId });
  if (error) throw error;
  if (!S.chats.has(data)) await loadChats();
  return data;
}

export async function leaveChat(chatId: string): Promise<void> {
  const { error } = await sb.rpc('leave_chat', { p_chat: chatId });
  if (error) throw error;
  dropChat(chatId);
}

export function dropChat(chatId: string): void {
  S.chats.delete(chatId);
  S.feeds.delete(chatId);
  S.members.delete(chatId);
  emit('chats', 'feed', 'head');
}

export async function renameChat(chatId: string, name: string, emoji: string): Promise<void> {
  const { error } = await sb.from('chats').update({ name, emoji }).eq('id', chatId);
  if (error) throw error;
  const c = S.chats.get(chatId);
  if (c) Object.assign(c, { name, emoji });
  emit('chats', 'head');
}

export async function resetInvite(chatId: string): Promise<string> {
  const { data, error } = await sb.rpc('reset_invite', { p_chat: chatId });
  if (error) throw error;
  const c = S.chats.get(chatId);
  if (c) c.invite_code = data;
  emit('chats');
  return data;
}

/** Адрес приложения с учётом подпути (на GitHub Pages сайт живёт в /<репозиторий>/). */
export function appUrl(): string {
  return `${location.origin}${import.meta.env.BASE_URL}`;
}

export function inviteLink(code: string): string {
  return `${appUrl()}?join=${encodeURIComponent(code)}`;
}

export function totalUnread(): number {
  let n = 0;
  S.chats.forEach((c) => { n += c.unread; });
  return n;
}

// ---------------------------------------------------------------------------
// Непрочитанные
// ---------------------------------------------------------------------------

const readTimers = new Map<string, number>();
export function markRead(chatId: string): void {
  const c = S.chats.get(chatId);
  if (!c) return;
  const feed = S.feeds.get(chatId);
  const lastFeed = feed?.msgs.filter((m) => !m.pending).at(-1)?.created_at;
  const latest = [lastFeed, c.last_at].filter(Boolean).sort().at(-1);
  if (!latest) return;
  const had = c.unread;
  if (ts(latest) <= ts(c.last_read_at) && !had) return;
  c.unread = 0;
  if (ts(latest) > ts(c.last_read_at)) c.last_read_at = latest;
  if (had) emit('chats');
  clearTimeout(readTimers.get(chatId));
  readTimers.set(chatId, window.setTimeout(() => {
    readTimers.delete(chatId);
    // Запросы supabase-js ленивые: без then() они не отправляются.
    sb.rpc('mark_read', { p_chat: chatId, p_at: latest }).then(() => {}, () => {});
  }, 700));
}

// ---------------------------------------------------------------------------
// Сообщения
// ---------------------------------------------------------------------------

export function feedOf(chatId: string): Feed {
  let f = S.feeds.get(chatId);
  if (!f) S.feeds.set(chatId, (f = { msgs: [], loaded: false, hasMore: true, loadingOlder: false, error: false }));
  return f;
}

function cmp(a: Msg, b: Msg): number {
  return ts(a.created_at) - ts(b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Добавить или обновить сообщение в ленте. Возвращает true, если оно новое. */
export function upsertMessage(m: Msg): boolean {
  const f = feedOf(m.chat_id);
  const i = f.msgs.findIndex((x) => x.id === m.id);
  if (i >= 0) {
    f.msgs[i] = m;
    f.msgs.sort(cmp);
    return false;
  }
  const last = f.msgs.at(-1);
  f.msgs.push(m);
  if (last && cmp(last, m) > 0) f.msgs.sort(cmp);
  return true;
}

/** Обновить «последнее сообщение» в списке чатов. */
export function bumpChat(m: Msg): void {
  const c = S.chats.get(m.chat_id);
  if (!c) { reloadChatsSoon(); return; }
  if (c.last_id === m.id || ts(m.created_at) >= ts(c.last_at)) {
    Object.assign(c, {
      last_id: m.id,
      last_body: m.body.slice(0, 200),
      last_user_id: m.user_id,
      last_kind: m.kind,
      last_at: m.created_at,
      last_deleted: m.deleted_at != null,
    });
  }
}

async function fetchPage(chatId: string, before?: Msg) {
  let q = sb.from('messages').select('*').eq('chat_id', chatId);
  if (before) {
    const t = `"${before.created_at}"`;
    q = q.or(`created_at.lt.${t},and(created_at.eq.${t},id.lt.${before.id})`);
  }
  const { data, error } = await q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(PAGE);
  if (error) throw error;
  return data.reverse();
}

export async function loadReactions(ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 60) {
    const chunk = ids.slice(i, i + 60);
    const { data, error } = await sb.from('reactions').select('*').in('message_id', chunk);
    if (error) throw error;
    chunk.forEach((id) => S.reactions.delete(id));
    data.forEach((r) => {
      const list = S.reactions.get(r.message_id) ?? [];
      list.push(r);
      S.reactions.set(r.message_id, list);
    });
  }
}

/** Загрузить (или освежить) последние сообщения и участников чата. */
export async function loadFeed(chatId: string, force = false): Promise<void> {
  const f = feedOf(chatId);
  if (f.loaded && !force) return;
  try {
    const [rows, members] = await Promise.all([
      fetchPage(chatId),
      sb.from('chat_members').select('*').eq('chat_id', chatId),
    ]);
    const fresh = !f.loaded;
    rows.forEach((m) => upsertMessage(m));
    if (fresh) f.hasMore = rows.length === PAGE;
    f.loaded = true;
    f.error = false;
    if (!members.error) S.members.set(chatId, members.data);
    await Promise.all([
      loadReactions(rows.map((r) => r.id)),
      ensureProfiles([...rows.map((r) => r.user_id), ...(members.data ?? []).map((m) => m.user_id)]),
    ]);
  } catch (e) {
    f.loaded = true;
    f.error = true;
    throw e;
  } finally {
    emit('feed', 'head', 'members');
  }
}

export async function loadOlder(chatId: string): Promise<void> {
  const f = feedOf(chatId);
  const oldest = f.msgs.find((m) => !m.pending);
  if (!f.hasMore || f.loadingOlder || !oldest) return;
  f.loadingOlder = true;
  emit('feed');
  try {
    const rows = await fetchPage(chatId, oldest);
    rows.forEach((m) => upsertMessage(m));
    f.hasMore = rows.length === PAGE;
    await Promise.all([loadReactions(rows.map((r) => r.id)), ensureProfiles(rows.map((r) => r.user_id))]);
  } finally {
    f.loadingOlder = false;
    emit('feed');
  }
}

/** Черновик сообщения со всеми колонками (для мгновенного показа до ответа сервера). */
function draftMessage(chatId: string, fields: Partial<Msg> & Pick<Message, 'kind' | 'body'>): Msg {
  return {
    id: uuid(),
    chat_id: chatId,
    user_id: meId(),
    created_at: new Date().toISOString(),
    deleted_at: null,
    sticker: null,
    media_path: null,
    media_mime: null,
    duration_ms: null,
    waveform: null,
    enc: null,
    key_id: null,
    files: null,
    pending: true,
    ...fields,
  };
}

type Insert = Database['public']['Tables']['messages']['Insert'];

function insertRow(m: Msg): Insert {
  const row: Insert = { id: m.id, chat_id: m.chat_id, body: m.body };
  if (m.kind === 'sticker') Object.assign(row, { kind: 'sticker', sticker: m.sticker });
  if (m.kind === 'voice' || m.kind === 'video_note') {
    Object.assign(row, {
      kind: m.kind, media_path: m.media_path, media_mime: m.media_mime, duration_ms: m.duration_ms, waveform: m.waveform,
    });
  }
  return row;
}

function failed(m: Msg): void {
  m.pending = false;
  m.failed = true;
  emit('feed');
}

async function pushMessage(m: Msg): Promise<void> {
  // Голосовое и кружочек: сначала файл в хранилище, потом сообщение со ссылкой на него.
  if (m.blob && m.media_path && !m.uploaded) {
    const up = await sb.storage.from('media').upload(m.media_path, m.blob, {
      contentType: m.media_mime ?? undefined, cacheControl: '31536000', upsert: false,
    });
    // «Уже существует» — файл загрузился при прошлой попытке.
    const dup = up.error && /exists|duplicate/i.test(up.error.message);
    if (up.error && !dup) { failed(m); throw up.error; }
    m.uploaded = true;
  }
  const { data, error } = await sb.from('messages').insert(insertRow(m)).select().single();
  if (error && error.code !== '23505') { failed(m); throw error; }
  if (data) {
    upsertMessage(data);
    bumpChat(data);
  } else {
    m.pending = false;
  }
  emit('feed', 'chats');
}

async function post(m: Msg): Promise<void> {
  upsertMessage(m);
  bumpChat(m);
  emit('feed', 'chats');
  await pushMessage(m);
}

export async function sendMessage(chatId: string, text: string): Promise<void> {
  await post(draftMessage(chatId, { kind: 'text', body: text }));
}

export async function sendSticker(chatId: string, s: Sticker): Promise<void> {
  await post(draftMessage(chatId, { kind: 'sticker', body: s.emoji, sticker: s.ref }));
}

export type Recorded = { blob: Blob; mime: string; ext: string; durationMs: number; waveform: number[] | null };

/** Отправить голосовое или кружочек. onLocal получает путь файла — чтобы сразу играть его локальную копию. */
export async function sendRecorded(chatId: string, kind: 'voice' | 'video_note', rec: Recorded,
  onLocal?: (path: string, blob: Blob) => void): Promise<void> {
  const path = `${chatId}/${meId()}/${uuid()}.${rec.ext}`;
  onLocal?.(path, rec.blob);
  await post(draftMessage(chatId, {
    kind,
    body: '',
    media_path: path,
    media_mime: rec.mime,
    duration_ms: Math.round(rec.durationMs),
    waveform: rec.waveform,
    blob: rec.blob,
  }));
}

export async function retryMessage(m: Msg): Promise<void> {
  m.failed = false;
  m.pending = true;
  emit('feed');
  await pushMessage(m);
}

export function discardMessage(m: Msg): void {
  const f = feedOf(m.chat_id);
  f.msgs = f.msgs.filter((x) => x.id !== m.id);
  // Файл успел загрузиться, а сообщение — нет: не оставляем его в хранилище.
  if (m.uploaded && m.media_path) void sb.storage.from('media').remove([m.media_path]).catch(() => {});
  emit('feed');
  reloadChatsSoon();
}

export async function deleteMessage(m: Msg): Promise<void> {
  const before = {
    body: m.body, deleted_at: m.deleted_at, sticker: m.sticker, media_path: m.media_path, media_mime: m.media_mime,
    duration_ms: m.duration_ms, waveform: m.waveform,
  };
  const reacts = S.reactions.get(m.id);
  Object.assign(m, {
    body: '', deleted_at: new Date().toISOString(), sticker: null, media_path: null, media_mime: null,
    duration_ms: null, waveform: null,
  });
  S.reactions.delete(m.id);
  bumpChat(m);
  emit('feed', 'chats');
  const { error } = await sb.rpc('delete_message', { p_id: m.id });
  if (error) {
    Object.assign(m, before);
    if (reacts) S.reactions.set(m.id, reacts);
    bumpChat(m);
    emit('feed', 'chats');
    throw error;
  }
  // Файл голосового или кружочка удаляет автор (база хранит только ссылку на него).
  if (before.media_path) void sb.storage.from('media').remove([before.media_path]).catch(() => {});
}

// ---------------------------------------------------------------------------
// Реакции
// ---------------------------------------------------------------------------

export function addReaction(r: Reaction): void {
  const list = S.reactions.get(r.message_id) ?? [];
  if (!list.some((x) => x.user_id === r.user_id && x.emoji === r.emoji)) list.push(r);
  S.reactions.set(r.message_id, list);
}

export function removeReaction(messageId: string, userId: string, emoji: string): void {
  const list = S.reactions.get(messageId);
  if (!list) return;
  S.reactions.set(messageId, list.filter((x) => !(x.user_id === userId && x.emoji === emoji)));
}

export async function toggleReaction(m: Msg, key: ReactionKey): Promise<void> {
  const me = meId();
  const has = (S.reactions.get(m.id) ?? []).some((r) => r.user_id === me && r.emoji === key);
  if (has) {
    removeReaction(m.id, me, key);
    emit('feed');
    const { error } = await sb.from('reactions').delete().match({ message_id: m.id, user_id: me, emoji: key });
    if (error) {
      addReaction({ message_id: m.id, user_id: me, emoji: key, chat_id: m.chat_id, created_at: new Date().toISOString() });
      emit('feed');
      throw error;
    }
  } else {
    addReaction({ message_id: m.id, user_id: me, emoji: key, chat_id: m.chat_id, created_at: new Date().toISOString() });
    emit('feed');
    const { error } = await sb.from('reactions').insert({ message_id: m.id, emoji: key });
    if (error && error.code !== '23505') {
      removeReaction(m.id, me, key);
      emit('feed');
      throw error;
    }
  }
}
