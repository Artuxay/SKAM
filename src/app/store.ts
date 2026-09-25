// Состояние приложения и работа с данными Supabase.
import type { User } from '@supabase/supabase-js';
import { sb } from '../lib/supabase';
import type {
  Attachment, Database, Forward, Member, Message, MessageKind, MyChat, Profile, Reaction, ReactionKey,
} from '../lib/database.types';
import { uuid } from '../lib/dom';
import type { Sticker } from '../lib/stickers';
import * as e2e from './e2e';
import {
  type Prepared, type Sealed, cachedUrl, registerSealed, removeFiles, sealBlob, sealPrepared, seedUrl, uploadPart,
} from './attach';

/** Что показывать в пузыре: текст и вложения (для зашифрованных — после расшифровки). */
export type Content = { text: string; files: Attachment[] };
export type Upload = { sealed: Sealed[]; loaded: number; total: number; ctrl: AbortController; error?: string };
export type Msg = Message & {
  pending?: boolean;
  failed?: boolean;
  /** Голосовое или кружочек, записанные здесь: файл, пока он не загружен в хранилище. */
  blob?: Blob;
  uploaded?: boolean;
  /** Ключ файла зашифрованного голосового или кружочка (base64). */
  fileKey?: string;
  /** Как выглядит зашифрованное сообщение после расшифровки: стикер, голосовое, кружочек или текст с вложениями. */
  view?: MessageKind;
  /** Текст и вложения; null — удалено или ещё не расшифровано. */
  content?: Content | null;
  /** Не удалось расшифровать: nokey — ключа пока нет, bad — шифротекст повреждён. */
  locked?: 'nokey' | 'bad' | null;
  /** Загрузка вложений до отправки. */
  upload?: Upload;
  /** Локальные превью вложений, пока сообщение отправляется. */
  local?: Map<string, string>;
  /** Слепок сообщения, на которое ответили (у зашифрованных — из шифротекста). */
  replySnap?: ReplySnap | null;
};

/** Как выглядело сообщение, на которое ответили: автор, вид и коротко текст. */
export type ReplySnap = { uid: string | null; k: MessageKind; text: string };

/** Ответить или переслать при отправке. */
export type SendOpts = { reply?: Msg | null; fwd?: Forward | null };

/** Вид сообщения для показа: у зашифрованного — то, что внутри. */
export function viewKind(m: Msg): MessageKind {
  return m.view ?? m.kind;
}

/** Расшифрованное последнее сообщение для списка чатов. */
export type Preview = { view: MessageKind; text: string; files: Attachment[] };
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
  /** Расшифрованные последние сообщения для списка чатов (по id сообщения); 'locked' — ключа нет. */
  previews: new Map<string, Preview | 'locked'>(),
  /** Есть ли живое соединение Realtime (иначе всё подтягивается опросом). */
  live: false,
    /** Сообщения, на которые отвечают, но которых нет в загруженной ленте (для цитат). */
  quoted: new Map<string, Msg | 'missing'>(),
  /** UI сообщает, какой чат сейчас реально виден пользователю (для непрочитанных). */
  visibleChat: (): string | null => null,
};

export function meId(): string {
  return S.user?.id ?? '';
}

// ---------------------------------------------------------------------------
// События → перерисовка (склеиваем несколько изменений за один тик)
// ---------------------------------------------------------------------------

export type Evt = 'chats' | 'feed' | 'head' | 'online' | 'me' | 'members' | 'call';
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
  S.previews.clear();
  S.quoted.clear();
  e2e.reset();
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
  void decryptPreviews();
  await ensureProfiles((data ?? []).flatMap((c) => [c.peer_id, c.last_user_id]));
  emit('chats', 'head', 'feed');
}

/** Расшифровать последние сообщения зашифрованных чатов для превью в списке. */
async function decryptPreviews(): Promise<void> {
  const jobs = [...S.chats.values()]
    .filter((c) => c.last_kind === 'e2e' && c.last_id && c.last_enc && c.last_key_id && !S.previews.has(c.last_id))
    .map(async (c) => {
      const m = { id: c.last_id!, chat_id: c.id, user_id: c.last_user_id, enc: c.last_enc, key_id: c.last_key_id } as Msg;
      await prepareMsg(Object.assign(m, { kind: 'e2e', body: '', deleted_at: null }));
      S.previews.set(c.last_id!, m.content ? previewOf(m) : 'locked');
    });
  if (!jobs.length) return;
  await Promise.all(jobs);
  emit('chats');
}

function previewOf(m: Msg): Preview {
  return { view: viewKind(m), text: m.content?.text ?? '', files: m.content?.files ?? [] };
}

/** Пришли новые ключи чата: пробуем расшифровать то, что ждало ключа. */
e2e.onKeysArrived((chatId) => {
  void (async () => {
    const f = S.feeds.get(chatId);
    const waiting = f?.msgs.filter((m) => m.locked === 'nokey') ?? [];
    await Promise.all(waiting.map((m) => prepareMsg(m)));
    const c = S.chats.get(chatId);
    if (c?.last_id && S.previews.get(c.last_id) === 'locked') {
      S.previews.delete(c.last_id);
      await decryptPreviews();
    }
    if (waiting.length) emit('feed');
  })();
});

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
      last_enc: m.enc,
      last_key_id: m.key_id,
      last_files: m.files,
    });
    if (m.kind === 'e2e' && m.content) S.previews.set(m.id, previewOf(m));
    else if (m.kind === 'e2e' && m.locked) S.previews.set(m.id, 'locked');
  }
}

// ---------------------------------------------------------------------------
// Содержимое сообщений: расшифровка и проверка вложений
// ---------------------------------------------------------------------------

const KINDS = new Set(['photo', 'video', 'file']);
const PATH_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.bin$/;
const KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const STICKER_RE = /^[a-z0-9_]{1,32}\/[a-z0-9_]{1,32}$/;
const REC_MIME = new Set(['audio/webm', 'audio/ogg', 'audio/mp4', 'video/webm', 'video/mp4']);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

/** Вложения из чужого сообщения: берём только то, что похоже на настоящее описание файла. */
function cleanFiles(list: unknown): Attachment[] {
  if (!Array.isArray(list)) return [];
  const out: Attachment[] = [];
  for (const raw of list.slice(0, 10)) {
    const f = raw as Record<string, unknown>;
    if (!f || typeof f !== 'object') continue;
    if (typeof f.path !== 'string' || !PATH_RE.test(f.path) || typeof f.key !== 'string' || !KEY_RE.test(f.key)) continue;
    const kind = KINDS.has(f.kind as string) ? (f.kind as Attachment['kind']) : 'file';
    const a: Attachment = {
      id: typeof f.id === 'string' ? f.id.slice(0, 64) : f.path,
      kind,
      name: typeof f.name === 'string' && f.name.trim() ? f.name.slice(0, 255) : 'файл',
      mime: typeof f.mime === 'string' ? f.mime.slice(0, 255) : 'application/octet-stream',
      size: num(f.size) ?? 0,
      path: f.path,
      key: f.key,
    };
    const w = num(f.w), h = num(f.h), dur = num(f.dur);
    if (w && h) { a.w = w; a.h = h; }
    if (dur) a.dur = dur;
    if (typeof f.mini === 'string' && f.mini.startsWith('data:image/jpeg;base64,') && f.mini.length < 4000) a.mini = f.mini;
    const t = f.thumb as Record<string, unknown> | undefined;
    if (t && typeof t.path === 'string' && PATH_RE.test(t.path) && num(t.w) && num(t.h)) a.thumb = { path: t.path, w: num(t.w)!, h: num(t.h)! };
    // Картинка или видео без размеров показываются как файл.
    if (a.kind !== 'file' && !(a.w && a.h)) a.kind = 'file';
    out.push(a);
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SNAP_KINDS = new Set<MessageKind>(['text', 'system', 'sticker', 'voice', 'video_note', 'e2e', 'media']);

/** «Переслано от …» из чужого сообщения: только имя, id и время, остальное отбрасываем. */
export function cleanFwd(raw: unknown): Forward | null {
  const f = raw as Record<string, unknown> | null;
  if (!f || typeof f !== 'object' || typeof f.name !== 'string' || !f.name.trim()) return null;
  const out: Forward = { name: f.name.trim().slice(0, 128) };
  if (typeof f.from === 'string' && UUID_RE.test(f.from)) out.from = f.from;
  if (f.kind === 'channel' || f.kind === 'bot') out.kind = f.kind;
  if (typeof f.at === 'string' && !Number.isNaN(Date.parse(f.at))) out.at = f.at;
  return out;
}

function cleanReply(raw: unknown): { id: string; snap: ReplySnap | null } | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !UUID_RE.test(r.id)) return null;
  const k = SNAP_KINDS.has(r.k as MessageKind) ? (r.k as MessageKind) : 'text';
  const snap: ReplySnap = {
    uid: typeof r.uid === 'string' && UUID_RE.test(r.uid) ? r.uid : null,
    k,
    text: typeof r.text === 'string' ? r.text.slice(0, 200) : '',
  };
  return { id: r.id, snap };
}

/** Короткий слепок сообщения для цитаты в ответе. */
export function snapOf(m: Msg): ReplySnap {
  const view = viewKind(m);
  const text = view === 'sticker' ? m.body : (m.content?.text ?? m.body);
  const files = m.content?.files ?? [];
  const k: MessageKind = view === 'e2e' ? (files.length ? 'media' : 'text') : view;
  return { uid: m.user_id, k, text: (text || files[0]?.name || '').replace(/\s+/g, ' ').trim().slice(0, 200) };
}

/** Разложить расшифрованное содержимое по полям сообщения (только в памяти). */
function applyPayload(m: Msg, p: e2e.Payload): void {
  m.content = { text: typeof p.text === 'string' ? p.text.slice(0, 4000) : '', files: cleanFiles(p.files) };
  m.view = 'e2e';
  const reply = cleanReply(p.reply);
  m.reply_to = reply?.id ?? null;
  m.replySnap = reply?.snap ?? null;
  m.fwd = cleanFwd(p.fwd);
  if (typeof p.sticker === 'string' && STICKER_RE.test(p.sticker)) {
    m.view = 'sticker';
    m.sticker = p.sticker;
    m.body = m.content.text.slice(0, 16);
    return;
  }
  const r = p.rec as Record<string, unknown> | undefined;
  if (r && (r.kind === 'voice' || r.kind === 'video_note') && typeof r.path === 'string' && PATH_RE.test(r.path)
      && typeof r.key === 'string' && KEY_RE.test(r.key) && typeof r.mime === 'string' && REC_MIME.has(r.mime)) {
    m.view = r.kind;
    m.media_path = r.path;
    m.media_mime = r.mime;
    m.duration_ms = Math.round(num(r.dur) ?? 0);
    m.waveform = Array.isArray(r.wave) ? r.wave.slice(0, 100).map((x) => Math.max(0, Math.min(100, Number(x) || 0))) : null;
    registerSealed(r.path, r.key, r.mime);
  }
}

/** Подготовить сообщение к показу: расшифровать, разобрать вложения. Меняет объект на месте. */
export async function prepareMsg(m: Msg): Promise<Msg> {
  if (m.deleted_at) { m.content = null; m.locked = null; m.view = undefined; return m; }
  if (m.kind === 'e2e') {
    try {
      applyPayload(m, await e2e.decryptMessage(m));
      m.locked = null;
    } catch (e) {
      m.content = null;
      m.locked = e instanceof e2e.NoKeyError ? 'nokey' : 'bad';
    }
  } else if (m.kind === 'media') {
    m.content = { text: m.body, files: cleanFiles(m.files) };
  } else {
    m.content = { text: m.body, files: [] };
  }
  if (m.kind !== 'e2e') m.fwd = cleanFwd(m.fwd);
  return m;
}

async function fetchPage(chatId: string, before?: Msg) {
  let q = sb.from('messages').select('*').eq('chat_id', chatId);
  if (before) {
    const t = `"${before.created_at}"`;
    q = q.or(`created_at.lt.${t},and(created_at.eq.${t},id.lt.${before.id})`);
  }
  const { data, error } = await q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(PAGE);
  if (error) throw error;
  const rows = data.reverse() as Msg[];
  await Promise.all(rows.map(prepareMsg));
  return rows;
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
    reply_to: null,
    fwd: null,
    call_id: null,
    pending: true,
    ...fields,
  };
}

/**
 * Шифровать ли сообщение сквозным шифрованием: в обычных чатах (личных и группах) — всё,
 * в том числе фото и видео. Канал новостей и чат с ботом — без сквозного шифрования.
 */
export function secretFor(chatId: string): boolean {
  return e2e.isE2EKind(S.chats.get(chatId)?.kind);
}

type Insert = Database['public']['Tables']['messages']['Insert'];

/** Строка для базы: в личных чатах и группах — только шифротекст, в канале и с ботом — как есть. */
async function insertRow(m: Msg): Promise<Insert> {
  const view = viewKind(m);
  const content = m.content ?? { text: m.body, files: [] };
  if (m.kind === 'e2e') {
    const payload: e2e.Payload = { v: 1 };
    if (m.reply_to) {
      const snap = m.replySnap ?? { uid: null, k: 'text' as MessageKind, text: '' };
      payload.reply = { id: m.reply_to, uid: snap.uid ?? undefined, k: snap.k, text: snap.text };
    }
    if (m.fwd) payload.fwd = m.fwd;
    if (view === 'sticker') {
      payload.sticker = m.sticker ?? undefined;
      if (m.body) payload.text = m.body;
    } else if (view === 'voice' || view === 'video_note') {
      payload.rec = {
        kind: view, path: m.media_path, key: m.fileKey, mime: m.media_mime, dur: m.duration_ms, wave: m.waveform,
      };
    } else {
      if (content.text) payload.text = content.text;
      if (content.files.length) payload.files = content.files;
    }
    const { enc, key_id } = await e2e.encryptMessage(m.chat_id, m.id, payload);
    return { id: m.id, chat_id: m.chat_id, body: '', kind: 'e2e', enc, key_id };
  }
  // Открытые чаты (канал, бот): ответ и пересылка — в отдельных колонках.
  const extra: Pick<Insert, 'reply_to' | 'fwd'> = {};
  if (m.reply_to) extra.reply_to = m.reply_to;
  if (m.fwd) extra.fwd = m.fwd;
  if (view === 'sticker') return { id: m.id, chat_id: m.chat_id, body: m.body, kind: 'sticker', sticker: m.sticker, ...extra };
  if (view === 'voice' || view === 'video_note') {
    return {
      id: m.id, chat_id: m.chat_id, body: '', kind: view,
      media_path: m.media_path, media_mime: m.media_mime, duration_ms: m.duration_ms, waveform: m.waveform, ...extra,
    };
  }
  if (content.files.length) return { id: m.id, chat_id: m.chat_id, body: content.text, kind: 'media', files: content.files, ...extra };
  return { id: m.id, chat_id: m.chat_id, body: content.text, ...extra };
}

let progressHook: (m: Msg) => void = () => {};
/** Прогресс загрузки вложений: интерфейс обновляет полоску, не перерисовывая ленту. */
export function onUploadProgress(fn: (m: Msg) => void): void {
  progressHook = fn;
}

/** Загрузить файлы (вложения, голосовое, кружочек), зашифровать и записать сообщение. */
async function pushMessage(m: Msg): Promise<void> {
  try {
    const up = m.upload;
    if (up) {
      if (up.ctrl.signal.aborted) up.ctrl = new AbortController();
      up.error = undefined;
      const parts = up.sealed.flatMap((x) => x.parts);
      const doneBytes = () => parts.filter((p) => p.done).reduce((n, p) => n + p.data.length, 0);
      let last = 0;
      for (const part of parts) {
        if (part.done) continue;
        const base = doneBytes();
        await uploadPart(part, (loaded) => {
          up.loaded = base + loaded;
          const now = Date.now();
          if (now - last > 100) { last = now; progressHook(m); }
        }, up.ctrl.signal);
        up.loaded = doneBytes();
        progressHook(m);
      }
      // Свои картинки уже есть локально — не будем их скачивать обратно.
      m.local?.forEach((url, attId) => {
        const a = m.content?.files.find((f) => f.id === attId);
        if (a) seedUrl(a.thumb?.path ?? a.path, url);
      });
    }
    // Голосовое и кружочек: сначала файл в хранилище, потом сообщение со ссылкой на него.
    if (m.blob && m.media_path && !m.uploaded) {
      if (m.kind === 'e2e') {
        // Файл шифруется своим ключом, ключ уходит внутрь зашифрованного сообщения.
        const sealed = await sealBlob(m.blob, m.fileKey);
        m.fileKey = sealed.key;
        await uploadPart({ path: m.media_path, data: sealed.data, done: false }, () => {}, new AbortController().signal);
      } else {
        const res = await sb.storage.from('media').upload(m.media_path, m.blob, {
          contentType: m.media_mime ?? undefined, cacheControl: '31536000', upsert: false,
        });
        // «Уже существует» — файл загрузился при прошлой попытке.
        if (res.error && !/exists|duplicate/i.test(res.error.message)) throw res.error;
      }
      m.uploaded = true;
    }
    const { data, error } = await sb.from('messages').insert(await insertRow(m)).select().single();
    if (error && error.code !== '23505') throw error;
    if (data) {
      // Своё сообщение уже расшифровано — переносим содержимое, чтобы не расшифровывать заново.
      const saved = Object.assign(data as Msg, {
        content: m.content ?? null, view: m.view, locked: null,
        sticker: m.sticker, media_path: m.media_path, media_mime: m.media_mime, duration_ms: m.duration_ms, waveform: m.waveform,
        body: m.kind === 'e2e' ? m.body : data.body,
        reply_to: m.reply_to, replySnap: m.replySnap ?? null, fwd: m.fwd,
      });
      upsertMessage(saved);
      bumpChat(saved);
    } else {
      m.pending = false;
      m.upload = undefined;
    }
    emit('feed', 'chats');
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') return;
    m.pending = false;
    m.failed = true;
    if (m.upload) m.upload.error = (error as Error)?.message;
    emit('feed');
    throw error;
  }
}

async function post(m: Msg): Promise<void> {
  upsertMessage(m);
  bumpChat(m);
  emit('feed', 'chats');
  await pushMessage(m);
}

/** Черновик: зашифрованное сообщение имеет вид e2e, а что внутри — в view. */
function draftFor(chatId: string, view: MessageKind, fields: Partial<Msg> & { body: string }, opts: SendOpts = {}): Msg {
  // Отвечать можно только на сообщение этого же чата.
  const reply = opts.reply && opts.reply.chat_id === chatId && !opts.reply.pending ? opts.reply : null;
  if (reply) Object.assign(fields, { reply_to: reply.id, replySnap: snapOf(reply) });
  if (opts.fwd) fields.fwd = opts.fwd;
  if (!secretFor(chatId)) return draftMessage(chatId, { ...fields, kind: view, view });
  // Текст и вложения внутри шифротекста показываются как «e2e» — так же, как после расшифровки.
  return draftMessage(chatId, { ...fields, kind: 'e2e', view: view === 'text' || view === 'media' ? 'e2e' : view });
}

/**
 * Отправить сообщение. В личных чатах и группах оно шифруется, вложения — всегда.
 * files — подготовленные вложения (одно сообщение — до 10 штук, как альбом в Telegram).
 */
export async function sendMessage(chatId: string, text: string, files: Prepared[] = [], opts: SendOpts = {}): Promise<void> {
  const m = draftFor(chatId, files.length ? 'media' : 'text', { body: text, content: { text, files: [] } }, opts);
  if (files.length) {
    m.local = new Map(files.filter((p) => p.preview).map((p) => [p.id, p.preview!]));
    // Сначала показываем сообщение с локальными превью, потом шифруем и грузим.
    m.content = {
      text,
      files: files.map((p) => ({ id: p.id, kind: p.kind, name: p.name, mime: p.mime, size: p.size, path: '', key: '', w: p.w, h: p.h, dur: p.dur, mini: p.mini })),
    };
    m.upload = { sealed: [], loaded: 0, total: files.reduce((n, p) => n + p.size + (p.thumb?.size ?? 0), 0), ctrl: new AbortController() };
    upsertMessage(m);
    bumpChat(m);
    emit('feed', 'chats');
    try {
      const sealed = await Promise.all(files.map((p) => sealPrepared(p, chatId, meId())));
      m.upload.sealed = sealed;
      m.upload.total = sealed.reduce((n, x) => n + x.parts.reduce((k, p) => k + p.data.length, 0), 0);
      m.content = { text, files: sealed.map((x) => x.att) };
    } catch (e) {
      m.pending = false;
      m.failed = true;
      emit('feed');
      throw e;
    }
    await pushMessage(m);
    return;
  }
  await post(m);
}

export async function sendSticker(chatId: string, s: Sticker, opts: SendOpts = {}): Promise<void> {
  await post(draftFor(chatId, 'sticker', { body: s.emoji, sticker: s.ref, content: { text: s.emoji, files: [] } }, opts));
}

export type Recorded = { blob: Blob; mime: string; ext: string; durationMs: number; waveform: number[] | null };

/** Отправить голосовое или кружочек. onLocal получает путь файла — чтобы сразу играть его локальную копию. */
export async function sendRecorded(chatId: string, kind: 'voice' | 'video_note', rec: Recorded,
  onLocal?: (path: string, blob: Blob) => void, opts: SendOpts = {}): Promise<void> {
  // В зашифрованных чатах файл хранится как .bin — снаружи не видно даже его формата.
  const path = `${chatId}/${meId()}/${uuid()}.${secretFor(chatId) ? 'bin' : rec.ext}`;
  onLocal?.(path, rec.blob);
  await post(draftFor(chatId, kind, {
    body: '',
    media_path: path,
    media_mime: rec.mime,
    duration_ms: Math.round(rec.durationMs),
    waveform: rec.waveform,
    blob: rec.blob,
    content: { text: '', files: [] },
  }, opts));
}

export async function retryMessage(m: Msg): Promise<void> {
  m.failed = false;
  m.pending = true;
  emit('feed');
  await pushMessage(m);
}

export function discardMessage(m: Msg): void {
  m.upload?.ctrl.abort();
  // Файлы успели загрузиться, а сообщение — нет: не оставляем их в хранилище.
  const uploaded = m.upload?.sealed.flatMap((x) => x.parts).filter((p) => p.done).map((p) => p.path) ?? [];
  if (m.uploaded && m.media_path) uploaded.push(m.media_path);
  if (uploaded.length) void sb.storage.from('media').remove(uploaded).catch(() => {});
  m.local?.forEach((url) => URL.revokeObjectURL(url));
  const f = feedOf(m.chat_id);
  f.msgs = f.msgs.filter((x) => x.id !== m.id);
  emit('feed');
  reloadChatsSoon();
}

export async function deleteMessage(m: Msg): Promise<void> {
  const before = {
    body: m.body, deleted_at: m.deleted_at, sticker: m.sticker, media_path: m.media_path, media_mime: m.media_mime,
    duration_ms: m.duration_ms, waveform: m.waveform, content: m.content, view: m.view, enc: m.enc, key_id: m.key_id, files: m.files,
    reply_to: m.reply_to, replySnap: m.replySnap, fwd: m.fwd,
  };
  const files = m.content?.files ?? [];
  const reacts = S.reactions.get(m.id);
  Object.assign(m, {
    body: '', deleted_at: new Date().toISOString(), sticker: null, media_path: null, media_mime: null,
    duration_ms: null, waveform: null, content: null, view: undefined, enc: null, key_id: null, files: null,
    reply_to: null, replySnap: null, fwd: null,
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
  // Файлы удаляет автор: база хранит только ссылки на них (у зашифрованных — внутри шифротекста).
  if (m.user_id === meId()) {
    if (before.media_path) void sb.storage.from('media').remove([before.media_path]).catch(() => {});
    if (files.length) void removeFiles(files).catch(() => {});
  }
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

// ---------------------------------------------------------------------------
// Ответы: сообщения, на которые ответили, но которых нет в загруженной ленте
// ---------------------------------------------------------------------------

const quoting = new Set<string>();

/** Найти сообщение для цитаты: в ленте, среди догруженных или null (тогда догрузим). */
export function quotedMsg(chatId: string, id: string): Msg | 'missing' | null {
  const inFeed = S.feeds.get(chatId)?.msgs.find((x) => x.id === id);
  if (inFeed) return inFeed;
  return S.quoted.get(id) ?? null;
}

/** Догрузить (и расшифровать) сообщения, на которые отвечают, — чтобы показать цитату. */
export async function loadQuoted(chatId: string, ids: string[]): Promise<void> {
  const need = [...new Set(ids)].filter((id) => !S.quoted.has(id) && !quoting.has(id)
    && !S.feeds.get(chatId)?.msgs.some((x) => x.id === id));
  if (!need.length) return;
  need.forEach((id) => quoting.add(id));
  try {
    const { data, error } = await sb.from('messages').select('*').eq('chat_id', chatId).in('id', need);
    if (error) return;
    const rows = data as Msg[];
    await Promise.all(rows.map(prepareMsg));
    rows.forEach((r) => S.quoted.set(r.id, r));
    need.filter((id) => !rows.some((r) => r.id === id)).forEach((id) => S.quoted.set(id, 'missing'));
    await ensureProfiles(rows.map((r) => r.user_id));
  } finally {
    need.forEach((id) => quoting.delete(id));
  }
  emit('feed');
}

/** Догружать историю, пока не найдётся сообщение (для перехода к оригиналу по цитате). */
export async function loadUntil(chatId: string, id: string, maxPages = 40): Promise<boolean> {
  const f = feedOf(chatId);
  for (let i = 0; i < maxPages; i++) {
    if (f.msgs.some((x) => x.id === id)) return true;
    if (!f.hasMore) return false;
    await loadOlder(chatId);
  }
  return f.msgs.some((x) => x.id === id);
}

// ---------------------------------------------------------------------------
// Пересылка
// ---------------------------------------------------------------------------

/** Можно ли переслать сообщение: не удалено, расшифровано, не служебная запись о звонке. */
export function canForward(m: Msg): boolean {
  if (m.deleted_at || m.locked || m.pending || m.failed || m.kind === 'call') return false;
  const view = viewKind(m);
  if (view === 'voice' || view === 'video_note') return !!m.media_path;
  return true;
}

/** «Переслано от …» для сообщения: сохраняем исходного автора, если его уже пересылали. */
export function forwardOf(m: Msg): Forward {
  if (m.fwd) return m.fwd;
  const chat = S.chats.get(m.chat_id);
  if (chat?.kind === 'channel') return { name: chat.name ?? 'Канал', kind: 'channel', at: m.created_at };
  if (m.kind === 'system' || !m.user_id) return { name: 'СКАМ', kind: 'bot', at: m.created_at };
  const p = S.profiles.get(m.user_id);
  return { name: p?.name || 'Участник', from: m.user_id, kind: 'user', at: m.created_at };
}

const REC_EXT: Record<string, string> = {
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'video/webm': 'webm', 'video/mp4': 'mp4',
};

/**
 * Скопировать зашифрованный файл вложения в папку другого чата. Файл тот же, ключ тот же —
 * он переезжает внутри нового сообщения. Скачивать и заново загружать ничего не нужно.
 */
async function copyAttachment(a: Attachment, chatId: string): Promise<Attachment> {
  const move = async (from: string) => {
    const to = `${chatId}/${meId()}/${uuid()}.bin`;
    const { error } = await sb.storage.from('media').copy(from, to);
    if (error) throw new Error('Не получилось скопировать файл — возможно, его удалили.');
    const have = cachedUrl(from);
    if (have) seedUrl(to, have);
    return to;
  };
  const out: Attachment = { ...a, id: uuid(), path: await move(a.path) };
  if (a.thumb) out.thumb = { ...a.thumb, path: await move(a.thumb.path) };
  return out;
}

/**
 * Переслать сообщения в чат (по порядку, как в Telegram). hideSender — без пометки «Переслано от …».
 * getBlob отдаёт файл голосового или кружочка (расшифрованный): его отправляем заново — в чате-получателе
 * он может шифроваться по-другому (или не шифроваться, если это канал).
 */
export async function forwardMessages(chatId: string, list: Msg[], hideSender: boolean,
  io: { getBlob: (m: Msg) => Promise<Blob>; onLocal?: (path: string, blob: Blob) => void }): Promise<void> {
  const msgs = list.filter(canForward).sort(cmp);
  for (const src of msgs) {
    const opts: SendOpts = { fwd: hideSender ? null : forwardOf(src) };
    const view = viewKind(src);
    if (view === 'sticker') {
      await post(draftFor(chatId, 'sticker', { body: src.body, sticker: src.sticker, content: { text: src.body, files: [] } }, opts));
    } else if (view === 'voice' || view === 'video_note') {
      const blob = await io.getBlob(src);
      const mime = src.media_mime ?? (view === 'voice' ? 'audio/webm' : 'video/webm');
      await sendRecorded(chatId, view, {
        blob, mime, ext: REC_EXT[mime] ?? 'webm', durationMs: Math.max(300, src.duration_ms ?? 0), waveform: src.waveform,
      }, io.onLocal, opts);
    } else {
      const text = src.content?.text ?? src.body;
      const files = src.content?.files ?? [];
      if (files.length) {
        const copied = await Promise.all(files.map((a) => copyAttachment(a, chatId)));
        const m = draftFor(chatId, 'media', { body: text, content: { text, files: copied } }, opts);
        await post(m);
      } else if (text.trim()) {
        await post(draftFor(chatId, 'text', { body: text, content: { text, files: [] } }, opts));
      }
    }
  }
}
