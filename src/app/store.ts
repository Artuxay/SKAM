// Состояние приложения и работа с данными Supabase.
import type { User } from '@supabase/supabase-js';
import { sb } from '../lib/supabase';
import type {
  Attachment, BlockedUser, ChatCard, ChatRight, CommentStats, Database, Forward, LastSeenPrivacy, Member, MemberInfo, Message,
  MessageKind, MyChat, PersonalChannel, PollState, Presence, Profile, Reaction, ReactionKey, SeenBucket, SuperStatus,
} from '../lib/database.types';
import { lsGet, lsSet, uuid } from '../lib/dom';
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
  /** Опрос: вопрос и варианты (в зашифрованном чате — из шифротекста; в канале варианты приходят с poll_state). */
  poll?: { q: string; o: string[] } | null;
  /** Опрос, который ещё отправляется: его настройки (для повторной попытки). */
  pollSend?: PollSpec;
};

/** Новый опрос: вопрос, 2–12 вариантов и настройки, как в Telegram. correct — номер правильного (викторина). */
export type PollSpec = {
  q: string; o: string[]; multiple: boolean; anonymous: boolean; quiz: boolean; correct: number | null; solution: string;
};
export const POLL_Q_MAX = 255;
export const POLL_OPT_MAX = 100;
export const POLL_SOLUTION_MAX = 200;
export const POLL_MAX_OPTIONS = 12;

/** Как выглядело сообщение, на которое ответили: автор, вид и коротко текст. */
export type ReplySnap = { uid: string | null; k: MessageKind; text: string };

/** Ответить или переслать при отправке; thread — комментарий к этому посту канала (0.5.1). */
export type SendOpts = { reply?: Msg | null; fwd?: Forward | null; thread?: string | null };

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
/** Сколько реакций один человек может поставить на одно сообщение (так же проверяет сервер). */
export const MAX_REACTIONS = 3;

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
  /** Время захода людей — каким его отдал сервер с учётом настроек обеих сторон (0.4.1). */
  presence: new Map<string, Presence>(),
  /** Кто видит моё время захода; null — ещё не загрузили. */
  lastSeen: null as LastSeenPrivacy | null,
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
  /** Публичный канал, открытый до подписки (его нет в списке чатов). */
  preview: null as MyChat | null,
  /** Я владелец СКАМ: могу выдавать и снимать официальные галочки. */
  appOwner: false,
  /** Кого я заблокировал (по id человека). */
  blocks: new Map<string, BlockedUser>(),
  /** Чаты без звука: до какого момента (мс); Infinity — навсегда. */
  mutes: new Map<string, number>(),
  /** Опросы (по id сообщения): числа голосов, мой голос, ответ викторины. */
  polls: new Map<string, PollState>(),
  /** Открытое обсуждение поста (id поста) в открытом канале S.cur (0.5.1). */
  thread: null as string | null,
  /** Комментарии под постами: сколько, когда последний, трое последних авторов (по id поста). */
  comments: new Map<string, CommentInfo>(),
  /** Комментарии в канале: включены ли и могу ли я писать (по id канала). */
  commentsOn: new Map<string, { on: boolean; can: boolean }>(),
};

export type CommentInfo = { n: number; last: string | null; recent: string[] };

/** Чат без звука: не звенит, не показывает уведомления, его непрочитанные — серые и не в общем счёте. */
export function chatMuted(id: string | null | undefined): boolean {
  if (!id) return false;
  const until = S.mutes.get(id);
  return until !== undefined && until > Date.now();
}

/** Я заблокировал собеседника этого личного чата. */
export function peerBlocked(c: MyChat | null | undefined): boolean {
  return !!c && c.kind === 'direct' && !!c.peer_id && S.blocks.has(c.peer_id);
}

/** Чат из списка или открытый до подписки публичный канал. */
export function chatById(id: string | null | undefined): MyChat | undefined {
  if (!id) return undefined;
  return S.chats.get(id) ?? (S.preview?.id === id ? S.preview : undefined);
}

/** Моё «Избранное» из списка чатов (null — ещё не создано или список не загружен). */
export function savedChat(): MyChat | null {
  for (const c of S.chats.values()) if (c.kind === 'saved') return c;
  return null;
}

let savedOpening: Promise<string> | null = null;
/** id «Избранного»: из списка или создать на сервере (один раз на всех вызывающих). */
export function ensureSaved(): Promise<string> {
  const have = savedChat();
  if (have) return Promise.resolve(have.id);
  savedOpening ??= (async () => {
    const { data, error } = await sb.rpc('open_saved');
    if (error) throw error;
    if (!S.chats.has(data)) await loadChats();
    return data;
  })().finally(() => { savedOpening = null; });
  return savedOpening;
}

/** Есть ли у меня право в чате (у владельца — все). */
export function hasRight(c: MyChat | null | undefined, r: ChatRight): boolean {
  return !!c && !c.preview && (c.rights ?? []).includes(r);
}

/** Админ или владелец. */
export function isAdmin(c: MyChat | null | undefined): boolean {
  return !!c && !c.preview && (c.role === 'owner' || c.role === 'admin');
}

export function meId(): string {
  return S.user?.id ?? '';
}

// ---------------------------------------------------------------------------
// События → перерисовка (склеиваем несколько изменений за один тик)
// ---------------------------------------------------------------------------

export type Evt = 'chats' | 'feed' | 'head' | 'online' | 'me' | 'members' | 'call' | 'layout' | 'stories' | 'prefs';
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
  partialTried.clear();
  S.chats.clear();
  S.chatsLoaded = false;
  S.cur = null;
  S.feeds.clear();
  S.reactions.clear();
  superCache.clear();
  S.members.clear();
  S.presence.clear();
  S.lastSeen = null;
  presenceAt = 0;
  S.typing.clear();
  S.typingWhat.clear();
  S.previews.clear();
  S.quoted.clear();
  S.preview = null;
  S.appOwner = false;
  S.blocks.clear();
  S.mutes.clear();
  S.polls.clear();
  S.thread = null;
  S.comments.clear();
  S.commentsOn.clear();
  counted.clear();
  bumpedAt.clear();
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
/** Когда последний раз пробовали прочитать целиком профиль, известный лишь по поиску, нику или списку участников. */
const partialTried = new Map<string, number>();
export async function ensureProfiles(ids: (string | null | undefined)[]): Promise<void> {
  const now = Date.now();
  const need = [...new Set(ids)].filter((x): x is string => {
    if (!x || inflight.has(x)) return false;
    const have = S.profiles.get(x);
    if (!have) return true;
    // Неполный профиль (created_at пустой): раз в минуту пробуем прочитать целиком — вдруг появился общий чат.
    if (have.created_at || now - (partialTried.get(x) ?? 0) < 60_000) return false;
    partialTried.set(x, now);
    return true;
  });
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
  void loadPresence(need.filter((x) => !S.presence.has(x)));
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
  // Старый сервер мог прислать время захода в профиле — его берём только из user_presence.
  const clean = { ...p } as Profile & { last_seen_at?: unknown; online_until?: unknown };
  delete clean.last_seen_at;
  delete clean.online_until;
  const old = S.profiles.get(p.id);
  S.profiles.set(p.id, clean);
  if (p.id === meId()) S.me = clean;
  // Ничего видимого не поменялось (например, только updated_at) — ленту сообщений не перерисовываем.
  const same = !!old && (['name', 'username', 'avatar_path', 'color', 'verified', 'bio', 'emoji_status', 'emoji_status_until'] as const)
    .every((k) => (old[k] ?? null) === (clean[k] ?? null));
  if (same) emit('head', 'chats', 'members', ...(p.id === meId() ? (['me'] as const) : []));
  else emit('chats', 'feed', 'head', 'online', 'members', 'me');
}

// ---------------------------------------------------------------------------
// Время захода (0.4.1): точное — только если оба разрешают друг другу, иначе «был(а) недавно» и т. п.
// Сервер считает это сам (user_presence) — в профилях времени больше нет, Realtime его не рассылает.
// ---------------------------------------------------------------------------

let presenceAt = 0;
const presenceQueue = new Set<string>();
let presenceTimer: number | undefined;
let presenceRun: Promise<void> | null = null;

function samePresence(a: Presence | undefined, b: Presence): boolean {
  return !!a && a.online_until === b.online_until && a.last_seen_at === b.last_seen_at && a.seen === b.seen;
}

const SEEN: SeenBucket[] = ['recently', 'week', 'month', 'long'];

/** Записать время захода из ответа сервера (user_presence, списки участников и контактов). */
export function putPresence(rows: { id: string; online_until?: string | null; last_seen_at?: string | null; seen?: string | null }[]): void {
  let changed = false;
  for (const r of rows) {
    if (!r.id || r.id === meId()) continue;
    const next: Presence = {
      online_until: r.online_until ?? null,
      last_seen_at: r.last_seen_at ?? null,
      seen: SEEN.includes(r.seen as SeenBucket) ? r.seen as SeenBucket : null,
    };
    if (samePresence(S.presence.get(r.id), next)) continue;
    S.presence.set(r.id, next);
    changed = true;
  }
  if (changed) emit('online', 'head', 'chats', 'members');
}

/** Время захода человека, каким его можно показать мне. undefined — ещё не загружено. */
export function presenceOf(uid: string | null | undefined): Presence | undefined {
  return uid ? S.presence.get(uid) : undefined;
}

/** Подтянуть время захода этих людей (запросы склеиваются в один). */
export function loadPresence(ids: (string | null | undefined)[]): Promise<void> {
  ids.forEach((x) => { if (x && x !== meId()) presenceQueue.add(x); });
  if (!presenceQueue.size) return presenceRun ?? Promise.resolve();
  clearTimeout(presenceTimer);
  return new Promise((resolve) => {
    presenceTimer = window.setTimeout(() => {
      const list = [...presenceQueue];
      presenceQueue.clear();
      const run = (async () => {
        for (let i = 0; i < list.length; i += 500) {
          const { data, error } = await sb.rpc('user_presence', { p_ids: list.slice(i, i + 500) });
          if (error) return;
          putPresence((data ?? []).map((r) => ({ ...r, id: r.user_id })));
        }
      })().catch(() => {});
      presenceRun = run;
      void run.then(() => { if (presenceRun === run) presenceRun = null; resolve(); });
    }, 40);
  });
}

/** Освежить время захода всех, кого видно на экране (раз в 30 секунд из Realtime и при открытии карточки). */
export function refreshPresence(force = false): Promise<void> {
  if (!force && Date.now() - presenceAt < 20_000) return Promise.resolve();
  presenceAt = Date.now();
  const ids = new Set<string>(S.profiles.keys());
  for (const c of S.chats.values()) if (c.peer_id) ids.add(c.peer_id);
  return loadPresence([...ids]);
}

/** Кто видит моё время захода. */
export async function loadPrivacy(): Promise<LastSeenPrivacy> {
  const { data, error } = await sb.rpc('my_privacy');
  if (error) throw error;
  const v = data?.last_seen;
  S.lastSeen = v === 'contacts' || v === 'nobody' ? v : 'everybody';
  emit('me');
  return S.lastSeen;
}

export async function setLastSeenPrivacy(v: LastSeenPrivacy): Promise<void> {
  const before = S.lastSeen;
  S.lastSeen = v;
  emit('me');
  const { error } = await sb.rpc('set_privacy', { p_key: 'last_seen', p_value: v });
  if (error) {
    S.lastSeen = before;
    emit('me');
    throw error;
  }
  // Из-за взаимности могло поменяться и то, что вижу я.
  void refreshPresence(true);
}

// ---------------------------------------------------------------------------
// Личный канал в профиле (0.4.1)
// ---------------------------------------------------------------------------

const personalCache = new Map<string, { at: number; ch: PersonalChannel | null }>();

/** Личный канал человека (с последним постом). Кэш на минуту; fresh — без кэша. */
export async function personalChannel(uid: string, fresh = false): Promise<PersonalChannel | null> {
  const hit = personalCache.get(uid);
  if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.ch;
  const { data, error } = await sb.rpc('personal_channel', { p_user: uid });
  if (error) throw error;
  const ch = data?.[0] ?? null;
  personalCache.set(uid, { at: Date.now(), ch });
  return ch;
}

/** Уже загруженный личный канал (без запроса): undefined — не знаем. */
export function knownPersonalChannel(uid: string): PersonalChannel | null | undefined {
  return personalCache.get(uid)?.ch;
}

/** Закрепить свой публичный канал в профиле (null — убрать). */
export async function setPersonalChannel(chatId: string | null): Promise<void> {
  const { error } = await sb.rpc('set_personal_channel', { p_chat: chatId });
  if (error) throw error;
  personalCache.delete(meId());
  await personalChannel(meId(), true).catch(() => null);
  emit('me');
}

/** Владелец ли я СКАМ (кнопки «Выдать галочку»). Ошибка — просто «нет». */
export async function loadAppOwner(): Promise<void> {
  const { data } = await sb.rpc('am_app_owner');
  S.appOwner = data === true;
}

/** Выдать или снять официальную галочку (только владелец СКАМ). */
export async function setVerified(kind: 'user' | 'channel', id: string, on: boolean): Promise<void> {
  const { error } = await sb.rpc('set_verified', { p_kind: kind, p_id: id, p_on: on });
  if (error) throw error;
  if (kind === 'user') {
    const p = S.profiles.get(id);
    if (p) putProfile({ ...p, verified: on });
  } else {
    const c = chatById(id);
    if (c) c.verified = on;
    emit('chats', 'head');
  }
}

/** username = null — только для аккаунтов-исключений (profiles.username_optional); bio = null — «О себе» пусто. */
export type ProfileFields = { first_name: string; last_name: string | null; username: string | null; bio?: string | null };

/** Сколько символов в «О себе» (как на сервере) и сколько строк. */
export const BIO_MAX = 140;
export const BIO_LINES = 5;

/** «О себе» как его сохранит сервер: без лишних пробелов по краям, без \r и управляющих символов, до 5 строк. */
export function normBio(v: string): string {
  const t = v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const lines = t.split('\n');
  if (lines.length <= BIO_LINES) return t;
  return [...lines.slice(0, BIO_LINES - 1), lines.slice(BIO_LINES - 1).join(' ')].join('\n');
}

/** «О себе» человека: профиль целиком виден только при общем чате, а «О себе» — всем. */
export async function userBio(uid: string): Promise<string | null> {
  const { data, error } = await sb.rpc('user_bio', { p_user: uid });
  if (error) throw error;
  return data ?? null;
}

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

export async function toSquare(file: Blob, size = 256): Promise<Blob> {
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
  // Комментарии в канале включили или выключили (на другом устройстве, другой админ) — счётчики заново.
  for (const c of next.values()) {
    const known = S.commentsOn.get(c.id);
    if (c.kind === 'channel' && known && known.on !== !!c.comments) {
      S.commentsOn.delete(c.id);
      if (S.feeds.get(c.id)?.loaded) refreshCommentStats(c.id);
    }
  }
  if (S.preview && next.has(S.preview.id)) S.preview = null;
  for (const key of [...S.feeds.keys()]) {
    const chat = chatOfKey(key);
    if (!next.has(chat) && S.preview?.id !== chat) S.feeds.delete(key);
  }
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
    // Расшифровались опросы — нужны их голоса.
    const polls = waiting.filter(isPoll).map((m) => m.id);
    if (polls.length) void loadPollStates(polls).catch(() => {});
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

export async function createChat(name: string, emoji: string, kind: 'group' | 'channel' = 'group',
  description: string | null = null): Promise<string> {
  const { data, error } = await sb.rpc('create_chat', { p_name: name, p_emoji: emoji, p_kind: kind, p_description: description });
  if (error) throw error;
  await loadChats();
  return data.id;
}

export async function previewInvite(code: string): Promise<ChatCard | null> {
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
  dropFeeds(chatId);
  if (S.cur === chatId) S.thread = null;
  S.members.delete(chatId);
  emit('chats', 'feed', 'head');
}

/** Название, значок, описание и подписи (null — не менять, пустое описание — убрать). */
export async function updateChat(chatId: string, f: { name?: string; emoji?: string; description?: string; sign?: boolean }): Promise<void> {
  const { error } = await sb.rpc('update_chat', {
    p_chat: chatId, p_name: f.name ?? null, p_emoji: f.emoji ?? null,
    p_description: f.description ?? null, p_sign: f.sign ?? null,
  });
  if (error) throw error;
  const c = S.chats.get(chatId);
  if (c) {
    if (f.name) c.name = f.name.trim().slice(0, 40);
    if (f.emoji) c.emoji = f.emoji;
    if (f.description !== undefined) c.description = f.description.trim() || null;
    if (f.sign !== undefined) c.sign_messages = f.sign;
  }
  // Список, который уже грузился, мог прийти со старыми данными — перечитаем.
  reloadChatsSoon();
  emit('chats', 'head', 'feed');
}

/** Фото группы или канала: квадрат 320×320 в avatars/chat/<id>/. */
export async function uploadChatAvatar(chatId: string, file: Blob): Promise<void> {
  if (!file.type.startsWith('image/')) throw new Error('Выберите картинку');
  const blob = await toSquare(file, 320);
  const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `chat/${chatId}/${Date.now().toString(36)}.${ext}`;
  const up = await sb.storage.from('avatars').upload(path, blob, { contentType: blob.type, cacheControl: '31536000', upsert: false });
  if (up.error) throw up.error;
  const { data: old, error } = await sb.rpc('set_chat_avatar', { p_chat: chatId, p_path: path });
  if (error) {
    await sb.storage.from('avatars').remove([path]);
    throw error;
  }
  const c = S.chats.get(chatId);
  if (c) c.avatar_path = path;
  // Список, который уже грузился, мог прийти со старыми данными — перечитаем.
  reloadChatsSoon();
  emit('chats', 'head', 'feed');
  if (old && old !== path) void sb.storage.from('avatars').remove([old]);
}

export async function removeChatAvatar(chatId: string): Promise<void> {
  const { data: old, error } = await sb.rpc('set_chat_avatar', { p_chat: chatId, p_path: null });
  if (error) throw error;
  const c = S.chats.get(chatId);
  if (c) c.avatar_path = null;
  // Список, который уже грузился, мог прийти со старыми данными — перечитаем.
  reloadChatsSoon();
  emit('chats', 'head', 'feed');
  if (old) void sb.storage.from('avatars').remove([old]);
}

/** Публичная ссылка канала (null — сделать частным). */
export async function setChatUsername(chatId: string, username: string | null): Promise<void> {
  const { error } = await sb.rpc('set_chat_username', { p_chat: chatId, p_username: username });
  if (error) throw error;
  const c = S.chats.get(chatId);
  if (c) c.username = username ? normUsername(username) : null;
  // Список, который уже грузился, мог прийти со старыми данными — перечитаем.
  reloadChatsSoon();
  emit('chats', 'head');
}

export async function chatUsernameAvailable(chatId: string | null, username: string): Promise<boolean> {
  const { data, error } = await sb.rpc('chat_username_available', { p_chat: chatId, p_username: username });
  if (error) throw error;
  return !!data;
}

export async function deleteChat(chatId: string): Promise<void> {
  const c = S.chats.get(chatId);
  // Фото удаляем сами и заранее: после удаления чата прав на его папку уже ни у кого нет.
  if (c?.avatar_path && c.role === 'owner') {
    const path = c.avatar_path;
    const { error } = await sb.rpc('set_chat_avatar', { p_chat: chatId, p_path: null });
    if (!error) await sb.storage.from('avatars').remove([path]).then(() => {}, () => {});
  }
  const { error } = await sb.rpc('delete_chat', { p_chat: chatId });
  if (error) throw error;
  dropChat(chatId);
}

// ---------------------------------------------------------------------------
// Участники, администраторы, чёрный список
// ---------------------------------------------------------------------------

/** Профили из списков участников: у подписчиков канала их иначе не прочитать. */
export function rememberProfiles(list: { id: string; name: string | null; username: string | null; avatar_path: string | null;
  color: string | null; last_seen_at?: string | null; online_until?: string | null; seen?: string | null; verified?: boolean;
  emoji_status?: string | null; emoji_status_until?: string | null }[]): boolean {
  // Списки участников и контактов приходят уже со временем захода, каким его можно показать мне.
  putPresence(list.filter((p) => p.seen !== undefined));
  let changed = false;
  for (const p of list) {
    const have = S.profiles.get(p.id);
    if (have) {
      // Галочку и эмодзи-статус обновляем и у уже известных: их могли выдать, снять или сменить.
      if (p.verified !== undefined && have.verified !== p.verified) { have.verified = p.verified; changed = true; }
      if (p.emoji_status !== undefined && (have.emoji_status !== p.emoji_status || have.emoji_status_until !== p.emoji_status_until)) {
        have.emoji_status = p.emoji_status;
        have.emoji_status_until = p.emoji_status_until ?? null;
        changed = true;
      }
      continue;
    }
    changed = true;
    S.profiles.set(p.id, {
      id: p.id, name: p.name, first_name: p.name, last_name: null, username: p.username, username_optional: false,
      avatar_path: p.avatar_path, color: p.color ?? '#646464', verified: !!p.verified, bio: null, created_at: '', updated_at: '',
      emoji_status: p.emoji_status ?? null, emoji_status_until: p.emoji_status_until ?? null,
    });
  }
  return changed;
}

/** Карточки людей без общего чата (авторы комментариев): имя, фото, галочка, эмодзи-статус. Запросы склеиваются. */
const cardQueue = new Set<string>();
let cardTimer: number | undefined;
export function loadProfileCards(ids: (string | null | undefined)[]): void {
  ids.forEach((x) => { if (x && !S.profiles.get(x)?.created_at) cardQueue.add(x); });
  if (!cardQueue.size) return;
  clearTimeout(cardTimer);
  cardTimer = window.setTimeout(async () => {
    const list = [...cardQueue];
    cardQueue.clear();
    for (let i = 0; i < list.length; i += 200) {
      const { data } = await sb.rpc('profile_cards', { p_ids: list.slice(i, i + 200) });
      if (data && rememberProfiles(data)) emit('chats', 'feed', 'head', 'members');
    }
  }, 60);
}

export async function memberList(chatId: string, o: { query?: string; admins?: boolean; limit?: number; offset?: number } = {}): Promise<MemberInfo[]> {
  const { data, error } = await sb.rpc('chat_member_list', {
    p_chat: chatId, p_query: o.query || null, p_admins: !!o.admins, p_limit: o.limit ?? 50, p_offset: o.offset ?? 0,
  });
  if (error) throw error;
  rememberProfiles((data ?? []).map((m) => ({ ...m, id: m.user_id })));
  return data ?? [];
}

export type Contact = Database['public']['Functions']['my_contacts']['Returns'][number];
export async function myContacts(chatId: string | null = null): Promise<Contact[]> {
  const { data, error } = await sb.rpc('my_contacts', { p_chat: chatId, p_limit: 500 });
  if (error) throw error;
  rememberProfiles(data ?? []);
  return data ?? [];
}

export async function addMembers(chatId: string, ids: string[]): Promise<number> {
  const { data, error } = await sb.rpc('add_chat_members', { p_chat: chatId, p_users: ids });
  if (error) throw error;
  await loadChats();
  return data ?? 0;
}

export async function removeMember(chatId: string, userId: string, ban = true): Promise<void> {
  const { error } = await sb.rpc('remove_chat_member', { p_chat: chatId, p_user: userId, p_ban: ban });
  if (error) throw error;
  const list = S.members.get(chatId);
  if (list) S.members.set(chatId, list.filter((m) => m.user_id !== userId));
  const c = S.chats.get(chatId);
  if (c) c.member_count = Math.max(1, c.member_count - 1);
  e2e.membersChanged(chatId);
  emit('chats', 'head', 'members');
}

export type Banned = Database['public']['Functions']['chat_banned']['Returns'][number];
export async function bannedList(chatId: string): Promise<Banned[]> {
  const { data, error } = await sb.rpc('chat_banned', { p_chat: chatId });
  if (error) throw error;
  rememberProfiles((data ?? []).map((b) => ({ ...b, id: b.user_id })));
  return data ?? [];
}

export async function unbanMember(chatId: string, userId: string): Promise<void> {
  const { error } = await sb.rpc('unban_chat_member', { p_chat: chatId, p_user: userId });
  if (error) throw error;
}

function patchMember(chatId: string, userId: string, f: Partial<Member>): void {
  const m = S.members.get(chatId)?.find((x) => x.user_id === userId);
  if (m) Object.assign(m, f);
  emit('members', 'chats');
}

export async function setAdmin(chatId: string, userId: string, rights: ChatRight[]): Promise<void> {
  const { error } = await sb.rpc('set_chat_admin', { p_chat: chatId, p_user: userId, p_rights: rights });
  if (error) throw error;
  patchMember(chatId, userId, { role: 'admin', rights, promoted_by: meId() });
}

export async function removeAdmin(chatId: string, userId: string): Promise<void> {
  const { error } = await sb.rpc('remove_chat_admin', { p_chat: chatId, p_user: userId });
  if (error) throw error;
  patchMember(chatId, userId, { role: 'member', rights: null, promoted_by: null });
}

export async function transferOwner(chatId: string, userId: string): Promise<void> {
  const { error } = await sb.rpc('transfer_chat_owner', { p_chat: chatId, p_user: userId });
  if (error) throw error;
  patchMember(chatId, userId, { role: 'owner', rights: null, promoted_by: null });
  await loadChats();
}

// ---------------------------------------------------------------------------
// Публичные каналы: поиск, карточка, лента до подписки
// ---------------------------------------------------------------------------

export async function searchChats(query: string): Promise<ChatCard[]> {
  const { data, error } = await sb.rpc('search_chats', { p_query: query, p_limit: 10 });
  if (error) throw error;
  return data ?? [];
}

export async function chatByUsername(username: string): Promise<ChatCard | null> {
  const { data, error } = await sb.rpc('chat_by_username', { p_username: username });
  if (error) throw error;
  return data?.[0] ?? null;
}

/** Открыть публичный канал до подписки: он живёт отдельно от списка чатов. */
export function setPreview(card: ChatCard): MyChat {
  const c: MyChat = {
    id: card.id, kind: card.kind, name: card.name, emoji: card.emoji, invite_code: null, is_default: false,
    created_at: new Date().toISOString(), role: 'member', last_read_at: new Date().toISOString(),
    member_count: card.member_count, peer_id: null, unread: 0, last_id: null, last_body: null, last_user_id: null,
    last_kind: null, last_at: null, last_deleted: null, last_enc: null, last_key_id: null, last_files: null, last_call: null,
    description: card.description, username: card.username, avatar_path: card.avatar_path, sign_messages: false,
    rights: [], verified: !!card.verified, preview: true,
  };
  if (S.preview?.id !== c.id) S.feeds.delete(c.id);
  S.preview = c;
  return c;
}

export async function joinChannel(chatId: string): Promise<void> {
  const { error } = await sb.rpc('join_channel', { p_chat: chatId });
  if (error) throw error;
  await loadChats();
  // Теперь посты читаются как подписчиком: с авторами для админов и настоящими реакциями.
  void loadFeed(chatId, true).catch(() => {});
}

/** Ссылка на публичный канал. */
export function channelLink(username: string): string {
  return `${appUrl()}?c=${encodeURIComponent(username)}`;
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

/** Непрочитанные во всех чатах — без чатов «без звука» (как в Telegram). */
export function totalUnread(): number {
  let n = 0;
  S.chats.forEach((c) => { if (!chatMuted(c.id)) n += c.unread; });
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

/** Лента по ключу: id чата или обсуждение поста (threadKey). */
export function feedOf(key: string): Feed {
  let f = S.feeds.get(key);
  if (!f) S.feeds.set(key, (f = { msgs: [], loaded: false, hasMore: true, loadingOlder: false, error: false }));
  return f;
}

// ---------------------------------------------------------------------------
// Комментарии к постам каналов (0.5.1): комментарий — сообщение канала с thread_id = id поста.
// Лента обсуждения лежит в S.feeds под ключом «канал~пост».
// ---------------------------------------------------------------------------

/** Ключ ленты обсуждения поста. */
export function threadKey(chatId: string, postId: string): string {
  return `${chatId}~${postId}`;
}

/** В какой ленте лежит сообщение: комментарий — в обсуждении своего поста. */
export function feedKeyOf(m: { chat_id: string; thread_id?: string | null }): string {
  return m.thread_id ? threadKey(m.chat_id, m.thread_id) : m.chat_id;
}

/** Чат ленты по её ключу. */
export function chatOfKey(key: string): string {
  const i = key.indexOf('~');
  return i < 0 ? key : key.slice(0, i);
}

/** Пост обсуждения по ключу ленты (null — обычная лента чата). */
export function postOfKey(key: string): string | null {
  const i = key.indexOf('~');
  return i < 0 ? null : key.slice(i + 1);
}

/** Убрать ленты чата — саму и все обсуждения. */
export function dropFeeds(chatId: string): void {
  for (const key of [...S.feeds.keys()]) if (chatOfKey(key) === chatId) S.feeds.delete(key);
}

/** Загруженное сообщение чата — в ленте или в любом из его обсуждений. */
export function findLoaded(chatId: string, id: string): Msg | undefined {
  for (const [key, f] of S.feeds) {
    if (chatOfKey(key) !== chatId) continue;
    const m = f.msgs.find((x) => x.id === id);
    if (m) return m;
  }
  return undefined;
}

/** Включены ли комментарии и могу ли я их писать (пока сервер не ответил — по списку чатов). */
export function commentsInfo(chatId: string | null | undefined): { on: boolean; can: boolean } {
  if (!chatId) return { on: false, can: false };
  const known = S.commentsOn.get(chatId);
  if (known) return known;
  const c = chatById(chatId);
  const on = c?.kind === 'channel' && !!c.comments;
  return { on, can: on && !c?.preview };
}

/** Комментарии, уже учтённые в счётчиках (чтобы своё сообщение и его эхо из Realtime не посчитать дважды). */
const counted = new Set<string>();

/** Когда счётчик поста последний раз поменялся здесь (чтобы ответ сервера, ушедший раньше, его не затёр). */
const bumpedAt = new Map<string, number>();

/** Новый комментарий: +1 к счётчику поста и автор — в «последние». */
function noteComment(m: Msg): void {
  if (!m.thread_id || m.deleted_at || counted.has(m.id)) return;
  counted.add(m.id);
  bumpedAt.set(m.thread_id, Date.now());
  const st = S.comments.get(m.thread_id) ?? { n: 0, last: null, recent: [] };
  st.n += 1;
  if (!st.last || ts(m.created_at) > ts(st.last)) st.last = m.created_at;
  if (m.user_id) st.recent = [m.user_id, ...st.recent.filter((x) => x !== m.user_id)].slice(0, 3);
  S.comments.set(m.thread_id, st);
}

const statsWanted = new Map<string, Set<string>>();
let statsTimer: number | undefined;
let statsWaiting: (() => void)[] = [];

/** Счётчики комментариев под постами (запросы склеиваются, до 200 постов за раз). */
export function loadCommentStats(chatId: string, postIds: string[]): Promise<void> {
  const set = statsWanted.get(chatId) ?? new Set<string>();
  postIds.forEach((id) => set.add(id));
  statsWanted.set(chatId, set);
  clearTimeout(statsTimer);
  return new Promise((resolve) => {
    // Склеенный запрос отвечает всем, кто его ждал (иначе ожидание более раннего вызова повисло бы).
    statsWaiting.push(resolve);
    statsTimer = window.setTimeout(() => {
      const jobs = [...statsWanted];
      const waiting = statsWaiting;
      statsWanted.clear();
      statsWaiting = [];
      void (async () => {
        for (const [chat, ids] of jobs) {
          const list = [...ids];
          for (let i = 0; i < list.length || i === 0; i += 200) {
            const part = list.slice(i, i + 200);
            const asked = Date.now();
            const { data, error } = await sb.rpc('comment_stats', { p_chat: chat, p_ids: part });
            if (error || !data) break;
            putCommentStats(chat, part, data, asked);
          }
        }
      })().catch(() => {}).finally(() => waiting.forEach((r) => r()));
    }, 50);
  });
}

function putCommentStats(chatId: string, asked: string[], data: CommentStats, at: number): void {
  S.commentsOn.set(chatId, { on: !!data.on, can: !!data.can });
  const c = chatById(chatId);
  if (c && c.kind === 'channel' && c.comments !== !!data.on) c.comments = !!data.on;
  for (const id of asked) {
    // Пока запрос шёл, здесь появился новый комментарий — свежее то, что посчитали мы.
    if ((bumpedAt.get(id) ?? 0) > at) continue;
    const st = data.posts?.[id];
    S.comments.set(id, st ? { n: st.n, last: st.last, recent: st.recent ?? [] } : { n: 0, last: null, recent: [] });
  }
  rememberProfiles(Object.values(data.people ?? {}));
  emit('feed', 'head');
}

/** Посты ленты канала, у которых могут быть комментарии. */
function commentable(rows: Msg[]): string[] {
  return rows.filter((m) => !m.thread_id && !m.deleted_at && m.kind !== 'system' && m.kind !== 'call' && !m.pending).map((m) => m.id);
}

/** Освежить счётчики постов, которые сейчас в ленте канала (включили комментарии, удалили комментарий…). */
export function refreshCommentStats(chatId: string, postIds?: string[]): void {
  const ids = postIds ?? commentable(S.feeds.get(chatId)?.msgs ?? []);
  if (ids.length || !postIds) void loadCommentStats(chatId, ids);
}

/** Включить или выключить комментарии в канале. */
export async function setChatComments(chatId: string, on: boolean): Promise<void> {
  const { error } = await sb.rpc('set_chat_comments', { p_chat: chatId, p_on: on });
  if (error) throw error;
  const c = S.chats.get(chatId);
  if (c) c.comments = on;
  S.commentsOn.set(chatId, { on, can: on });
  emit('feed', 'head', 'chats');
  refreshCommentStats(chatId);
}

/** Обсуждение поста страницами (новые с конца), с карточками авторов. До подписки — реакции только числами. */
async function fetchThreadPage(chatId: string, postId: string, before?: Msg): Promise<Msg[]> {
  const { data, error } = await sb.rpc('comment_feed', {
    p_post: postId, p_before: before?.created_at ?? null, p_before_id: before?.id ?? null, p_limit: PAGE,
  });
  if (error) throw error;
  const rows = (data ?? []).reverse();
  rememberProfiles(rows.map((r) => r.author).filter((a): a is NonNullable<typeof a> => !!a));
  if (!S.chats.has(chatId)) {
    for (const r of rows) {
      const list: Reaction[] = [];
      Object.entries(r.reacts ?? {}).forEach(([key, n]) => {
        const sup = key.endsWith('*');
        const emoji = (sup ? key.slice(0, -1) : key) as ReactionKey;
        for (let i = 0; i < (n ?? 0); i++) list.push({ message_id: r.id, user_id: '', emoji, chat_id: chatId, created_at: '', super: sup });
      });
      S.reactions.set(r.id, list);
    }
  }
  const msgs = rows.map(({ reacts: _r, author: _a, ...m }) => m as Msg);
  msgs.forEach((m) => counted.add(m.id));
  await Promise.all(msgs.map(prepareMsg));
  return msgs;
}

function cmp(a: Msg, b: Msg): number {
  return ts(a.created_at) - ts(b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Добавить или обновить сообщение в ленте. Возвращает true, если оно новое. */
export function upsertMessage(m: Msg): boolean {
  const f = feedOf(feedKeyOf(m));
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
  // Комментарий — не «последнее сообщение» канала: он только прибавляет к счётчику под постом.
  if (m.thread_id) { noteComment(m); return; }
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
const SNAP_KINDS = new Set<MessageKind>(['text', 'system', 'sticker', 'voice', 'video_note', 'e2e', 'media', 'poll']);

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

/** Опрос из шифротекста: вопрос и 2–12 непустых вариантов, иначе это не опрос. */
function cleanPoll(raw: unknown): { q: string; o: string[] } | null {
  const p = raw as { q?: unknown; o?: unknown } | null;
  if (!p || typeof p !== 'object' || typeof p.q !== 'string' || !Array.isArray(p.o)) return null;
  const q = p.q.replace(/\s+/g, ' ').trim().slice(0, POLL_Q_MAX);
  const o = p.o.slice(0, POLL_MAX_OPTIONS).map((x) => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim().slice(0, POLL_OPT_MAX) : ''));
  if (!q || o.length < 2 || o.some((x) => !x)) return null;
  return { q, o };
}

/** Разложить расшифрованное содержимое по полям сообщения (только в памяти). */
function applyPayload(m: Msg, p: e2e.Payload): void {
  m.content = { text: typeof p.text === 'string' ? p.text.slice(0, 4000) : '', files: cleanFiles(p.files) };
  m.view = 'e2e';
  const reply = cleanReply(p.reply);
  m.reply_to = reply?.id ?? null;
  m.replySnap = reply?.snap ?? null;
  m.fwd = cleanFwd(p.fwd);
  const poll = cleanPoll(p.poll);
  if (poll) {
    m.view = 'poll';
    m.poll = poll;
    m.content = { text: poll.q, files: [] };
    return;
  }
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
  } else if (m.kind === 'poll') {
    // Опрос в канале или чате с ботом: вопрос — в сообщении, варианты — с poll_state.
    m.content = { text: m.body, files: [] };
    m.poll = { q: m.body, o: S.polls.get(m.id)?.options ?? [] };
  } else {
    m.content = { text: m.body, files: [] };
  }
  if (m.kind !== 'e2e') m.fwd = cleanFwd(m.fwd);
  return m;
}

/** Лента публичного канала до подписки: через функцию (таблица сообщений открыта только подписчикам). */
async function fetchPreviewPage(chatId: string, before?: Msg) {
  const { data, error } = await sb.rpc('channel_feed', {
    p_chat: chatId, p_before: before?.created_at ?? null, p_before_id: before?.id ?? null, p_limit: PAGE,
  });
  if (error) throw error;
  const rows = (data ?? []).reverse();
  for (const r of rows) {
    // Реакции — только числа: кто их поставил, до подписки не видно. Супер-реакции — с «*» на конце ключа.
    const list: Reaction[] = [];
    Object.entries(r.reacts ?? {}).forEach(([key, n]) => {
      const sup = key.endsWith('*');
      const emoji = (sup ? key.slice(0, -1) : key) as ReactionKey;
      for (let i = 0; i < (n ?? 0); i++) list.push({ message_id: r.id, user_id: '', emoji, chat_id: chatId, created_at: '', super: sup });
    });
    S.reactions.set(r.id, list);
  }
  const msgs = rows.map(({ reacts: _r, ...m }) => m as Msg);
  await Promise.all(msgs.map(prepareMsg));
  return msgs;
}

async function fetchPage(key: string, before?: Msg) {
  const chatId = chatOfKey(key);
  const post = postOfKey(key);
  if (post) return fetchThreadPage(chatId, post, before);
  if (S.preview?.id === chatId) return fetchPreviewPage(chatId, before);
  // Комментарии к постам — в своих лентах, не в ленте канала.
  let q = sb.from('messages').select('*').eq('chat_id', chatId).is('thread_id', null);
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
export async function loadFeed(key: string, force = false): Promise<void> {
  const f = feedOf(key);
  if (f.loaded && !force) return;
  const chatId = chatOfKey(key);
  const thread = postOfKey(key);
  const preview = S.preview?.id === chatId;
  try {
    const [rows, members] = await Promise.all([
      fetchPage(key),
      preview || thread ? Promise.resolve({ data: null as Member[] | null, error: null }) : sb.from('chat_members').select('*').eq('chat_id', chatId),
    ]);
    const fresh = !f.loaded;
    rows.forEach((m) => upsertMessage(m));
    if (fresh) f.hasMore = rows.length === PAGE;
    f.loaded = true;
    f.error = false;
    if (!members.error && members.data) S.members.set(chatId, members.data);
    // В канале профили есть смысл спрашивать только у администраторов (подписчиков всё равно не видно).
    const chat = chatById(chatId);
    const channel = chat?.kind === 'channel';
    const people = (members.data ?? []).filter((m) => !channel || m.role !== 'member').map((m) => m.user_id);
    // Авторы комментариев пришли карточками вместе с обсуждением — их профили не читаем.
    await Promise.all([
      preview ? Promise.resolve() : loadReactions(rows.map((r) => r.id)),
      thread ? Promise.resolve() : ensureProfiles([...rows.map((r) => r.user_id), ...people]),
      loadPollStates(rows.filter(isPoll).map((r) => r.id)).catch(() => {}),
      // Счётчики комментариев под постами (у канала, где их включили; до подписки — спрашиваем сервер).
      channel && !thread && (chat?.comments || preview) ? loadCommentStats(chatId, commentable(rows)) : Promise.resolve(),
    ]);
  } catch (e) {
    f.loaded = true;
    f.error = true;
    throw e;
  } finally {
    emit('feed', 'head', 'members');
  }
}

export async function loadOlder(key: string): Promise<void> {
  const f = feedOf(key);
  const oldest = f.msgs.find((m) => !m.pending);
  if (!f.hasMore || f.loadingOlder || !oldest) return;
  f.loadingOlder = true;
  emit('feed');
  try {
    const rows = await fetchPage(key, oldest);
    rows.forEach((m) => upsertMessage(m));
    f.hasMore = rows.length === PAGE;
    const chatId = chatOfKey(key);
    const thread = postOfKey(key);
    const chat = chatById(chatId);
    const preview = S.preview?.id === chatId;
    await Promise.all([
      preview ? Promise.resolve() : loadReactions(rows.map((r) => r.id)),
      thread ? Promise.resolve() : ensureProfiles(rows.map((r) => r.user_id)),
      loadPollStates(rows.filter(isPoll).map((r) => r.id)).catch(() => {}),
      chat?.kind === 'channel' && !thread && (chat.comments || preview) ? loadCommentStats(chatId, commentable(rows)) : Promise.resolve(),
    ]);
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
    edited_at: null,
    signature: null,
    thread_id: null,
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
  const extra: Pick<Insert, 'reply_to' | 'fwd' | 'thread_id'> = {};
  if (m.reply_to) extra.reply_to = m.reply_to;
  if (m.fwd) extra.fwd = m.fwd;
  if (m.thread_id) extra.thread_id = m.thread_id;
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
    if (m.pollSend) { await pushPoll(m, m.pollSend); return; }
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
  // Отвечать можно только на сообщение этого же чата и той же ветки (пост — в ленте, комментарий — в обсуждении).
  const thread = opts.thread ?? null;
  const reply = opts.reply && opts.reply.chat_id === chatId && !opts.reply.pending && (opts.reply.thread_id ?? null) === thread
    ? opts.reply : null;
  if (reply) Object.assign(fields, { reply_to: reply.id, replySnap: snapOf(reply) });
  if (opts.fwd) fields.fwd = opts.fwd;
  if (thread) fields.thread_id = thread;
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
  const f = feedOf(feedKeyOf(m));
  f.msgs = f.msgs.filter((x) => x.id !== m.id);
  emit('feed');
  reloadChatsSoon();
}

/** Изменить пост канала (текст или подпись к вложениям). */
export async function editMessage(m: Msg, text: string): Promise<void> {
  const before = { body: m.body, content: m.content, edited_at: m.edited_at };
  const body = text.trim();
  if (body === m.body) return;
  m.body = body;
  m.content = { text: body, files: m.content?.files ?? [] };
  m.edited_at = new Date().toISOString();
  bumpChat(m);
  emit('feed', 'chats');
  const { error } = await sb.rpc('edit_message', { p_id: m.id, p_body: body });
  if (error) {
    Object.assign(m, before);
    bumpChat(m);
    emit('feed', 'chats');
    throw error;
  }
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
  if (m.thread_id) refreshCommentStats(m.chat_id, [m.thread_id]);
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
  const i = list.findIndex((x) => x.user_id === r.user_id && x.emoji === r.emoji);
  if (i < 0) list.push(r);
  else list[i] = { ...list[i], super: !!r.super };
  S.reactions.set(r.message_id, list);
}

export function removeReaction(messageId: string, userId: string, emoji: string): void {
  const list = S.reactions.get(messageId);
  if (!list) return;
  S.reactions.set(messageId, list.filter((x) => !(x.user_id === userId && x.emoji === emoji)));
}

/**
 * Нажали на реакцию: такая же моя (того же вида) — убрать; иначе поставить. sup — супер-реакция.
 * Если та же эмодзи стоит, но другого вида (обычная ↔ супер), вид меняется.
 */
export async function toggleReaction(m: Msg, key: ReactionKey, sup = false): Promise<void> {
  const me = meId();
  const list = S.reactions.get(m.id) ?? [];
  const cur = list.find((r) => r.user_id === me && r.emoji === key);
  if (cur && !!cur.super === sup) {
    removeReaction(m.id, me, key);
    emit('feed');
    const { error } = await sb.from('reactions').delete().match({ message_id: m.id, user_id: me, emoji: key });
    if (error) {
      addReaction(cur);
      emit('feed');
      throw error;
    }
    if (sup) dropSuperStatus(m.chat_id);
    return;
  }
  if (!cur && list.filter((r) => r.user_id === me).length >= MAX_REACTIONS) {
    throw new Error(`На одно сообщение — не больше ${MAX_REACTIONS} реакций. Уберите одну из своих`);
  }
  addReaction({ message_id: m.id, user_id: me, emoji: key, chat_id: m.chat_id, created_at: new Date().toISOString(), super: sup });
  emit('feed');
  const { error } = await sb.rpc('set_reaction', { p_message: m.id, p_emoji: key, p_super: sup });
  if (error) {
    if (cur) addReaction(cur);
    else removeReaction(m.id, me, key);
    emit('feed');
    throw error;
  }
  if (sup || cur?.super) dropSuperStatus(m.chat_id);
}

// ---------------------------------------------------------------------------
// Супер-реакции и активность в группах и каналах
// ---------------------------------------------------------------------------

const superCache = new Map<string, { at: number; st: SuperStatus }>();

/** Можно ли мне супер-реакцию в этом чате (кэш на минуту). */
export async function superStatus(chatId: string, force = false): Promise<SuperStatus | null> {
  const hit = superCache.get(chatId);
  if (hit && !force && Date.now() - hit.at < 60_000) return hit.st;
  const { data, error } = await sb.rpc('super_reaction_status', { p_chat: chatId });
  if (error) throw error;
  const st = (data ?? null) as SuperStatus | null;
  if (st) superCache.set(chatId, { at: Date.now(), st });
  return st;
}

export function cachedSuperStatus(chatId: string): SuperStatus | null {
  return superCache.get(chatId)?.st ?? null;
}

export function dropSuperStatus(chatId: string): void {
  superCache.delete(chatId);
}

/** День по Москве — как считает сервер. */
function mskDay(): string {
  return new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
}

/** Открыл группу или канал — засчитать день активности (раз в день на чат, с этого устройства). */
export function noteVisit(chatId: string): void {
  const c = S.chats.get(chatId);
  if (!c || c.preview || (c.kind !== 'group' && c.kind !== 'channel')) return;
  const day = mskDay();
  let seen: Record<string, string> = {};
  try { seen = JSON.parse(lsGet('skam:visit') ?? '{}') as Record<string, string>; } catch { /* пусто */ }
  if (seen[chatId] === day) return;
  for (const k of Object.keys(seen)) if (seen[k] !== day) delete seen[k];
  seen[chatId] = day;
  lsSet('skam:visit', JSON.stringify(seen));
  sb.rpc('chat_visit', { p_chat: chatId }).then(() => {}, () => {});
}

// ---------------------------------------------------------------------------
// Ответы: сообщения, на которые ответили, но которых нет в загруженной ленте
// ---------------------------------------------------------------------------

const quoting = new Set<string>();

/** Найти сообщение для цитаты: в ленте, среди догруженных или null (тогда догрузим). */
export function quotedMsg(chatId: string, id: string): Msg | 'missing' | null {
  const inFeed = findLoaded(chatId, id);
  if (inFeed) return inFeed;
  return S.quoted.get(id) ?? null;
}

/** Догрузить (и расшифровать) сообщения, на которые отвечают, — чтобы показать цитату. */
export async function loadQuoted(chatId: string, ids: string[]): Promise<void> {
  const need = [...new Set(ids)].filter((id) => !S.quoted.has(id) && !quoting.has(id)
    && !findLoaded(chatId, id));
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
  // Опрос живёт в своём чате (голоса — там), переслать его нельзя.
  if (view === 'poll') return false;
  if (view === 'voice' || view === 'video_note') return !!m.media_path;
  return true;
}

/** «Переслано от …» для сообщения: сохраняем исходного автора, если его уже пересылали. */
export function forwardOf(m: Msg): Forward {
  if (m.fwd) return m.fwd;
  const chat = chatById(m.chat_id);
  // Пост — от имени канала, комментарий — от его автора.
  if (chat?.kind === 'channel' && !m.thread_id) return { name: chat.name ?? 'Канал', kind: 'channel', at: m.created_at };
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

// ---------------------------------------------------------------------------
// Опросы (0.4.0)
// ---------------------------------------------------------------------------

export function isPoll(m: Msg): boolean {
  return !m.deleted_at && viewKind(m) === 'poll';
}

/** Состояния опросов с сервера (до 200 за раз). Варианты опросов из канала подставляются в сообщения. */
export async function loadPollStates(ids: string[]): Promise<void> {
  const list = [...new Set(ids)];
  for (let i = 0; i < list.length; i += 200) {
    const { data, error } = await sb.rpc('poll_state', { p_ids: list.slice(i, i + 200) });
    if (error) throw error;
    (data ?? []).forEach(putPollState);
  }
  if (list.length) emit('feed');
}

/** Новое состояние опроса (после голоса, из Realtime или опроса сервера). */
export function putPollState(st: PollState): void {
  S.polls.set(st.id, st);
  if (st.options) {
    const m = S.feeds.get(st.chat_id)?.msgs.find((x) => x.id === st.id);
    if (m && m.kind === 'poll') m.poll = { q: m.body, o: st.options };
  }
}

const pollWanted = new Set<string>();
let pollTimer = 0;
/** Освежить опросы чуть позже (голоса приходят пачками — один запрос на всех). */
export function refreshPollSoon(id: string): void {
  pollWanted.add(id);
  clearTimeout(pollTimer);
  pollTimer = window.setTimeout(() => {
    const ids = [...pollWanted];
    pollWanted.clear();
    void loadPollStates(ids).catch(() => {});
  }, 250);
}

/** Отправить опрос. В зашифрованном чате вопрос и варианты уходят внутри шифротекста. */
export async function sendPoll(chatId: string, spec: PollSpec): Promise<void> {
  const secret = secretFor(chatId);
  const m = draftFor(chatId, 'poll', { body: secret ? '' : spec.q, content: { text: spec.q, files: [] } });
  m.poll = { q: spec.q, o: spec.o };
  m.pollSend = spec;
  S.polls.set(m.id, {
    id: m.id, chat_id: chatId, n: spec.o.length, options: secret ? null : spec.o, multiple: spec.multiple && !spec.quiz,
    anonymous: spec.anonymous || chatById(chatId)?.kind === 'channel', quiz: spec.quiz,
    counts: spec.o.map(() => 0), voters: 0, closed: false, mine: [], correct: null, solution: null, recent: null,
    can_close: false, can_vote: false,
  });
  await post(m);
}

async function pushPoll(m: Msg, sp: PollSpec): Promise<void> {
  const e2eChat = m.kind === 'e2e';
  let enc: string | null = null;
  let keyId: string | null = null;
  let solution: string | null = sp.quiz && sp.solution.trim() ? sp.solution.trim() : null;
  if (e2eChat) {
    ({ enc, key_id: keyId } = await e2e.encryptMessage(m.chat_id, m.id, { v: 1, poll: { q: sp.q, o: sp.o } }));
    if (solution) solution = await e2e.sealPollSolution(m.chat_id, m.id, solution);
  }
  const { data, error } = await sb.rpc('send_poll', {
    p_id: m.id, p_chat: m.chat_id, p_question: e2eChat ? null : sp.q, p_options: e2eChat ? null : sp.o,
    p_enc: enc, p_key_id: keyId, p_count: sp.o.length, p_multiple: sp.multiple, p_anonymous: sp.anonymous,
    p_quiz: sp.quiz, p_correct: sp.quiz ? sp.correct : null, p_solution: solution,
  });
  if (error) throw error;
  const row = (data ?? [])[0];
  if (row) {
    const saved = Object.assign(row as Msg, {
      content: m.content ?? null, view: m.view, locked: null, poll: m.poll, body: e2eChat ? m.body : row.body,
    });
    upsertMessage(saved);
    bumpChat(saved);
  } else {
    m.pending = false;
  }
  await loadPollStates([m.id]).catch(() => {});
  emit('feed', 'chats');
}

/** Проголосовать: номера вариантов (пусто — отменить голос). */
export async function votePoll(id: string, options: number[]): Promise<void> {
  const { data, error } = await sb.rpc('poll_vote', { p_message: id, p_options: options });
  if (error) throw error;
  putPollState(data);
  emit('feed');
}

export async function closePoll(id: string): Promise<void> {
  const { data, error } = await sb.rpc('poll_close', { p_message: id });
  if (error) throw error;
  putPollState(data);
  emit('feed');
}

/** Кто голосовал в открытом опросе (по вариантам). */
export async function pollVoters(id: string): Promise<{ user_id: string; option: number; voted_at: string }[]> {
  const { data, error } = await sb.rpc('poll_voters', { p_message: id, p_limit: 500 });
  if (error) throw error;
  await ensureProfiles((data ?? []).map((v) => v.user_id));
  return data ?? [];
}

/** Пояснение к викторине: в зашифрованном чате — расшифровать (кэшируется на сообщении). */
const solutions = new Map<string, string>();
export async function pollSolution(m: Msg, st: PollState): Promise<string | null> {
  if (!st.solution) return null;
  if (m.kind !== 'e2e') return st.solution;
  const have = solutions.get(m.id);
  if (have !== undefined) return have;
  try {
    const t = await e2e.openPollSolution(m.chat_id, m.id, m.user_id ?? '', st.solution);
    solutions.set(m.id, t);
    return t;
  } catch {
    return null;
  }
}
