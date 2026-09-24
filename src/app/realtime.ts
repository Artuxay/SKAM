// Supabase Realtime: изменения в базе, «печатает…» (broadcast), а также пульс «в сети» (ping).
import type { RealtimeChannel, RealtimeChannelOptions } from '@supabase/supabase-js';
import { SUPABASE_KEY, SUPABASE_URL, sb } from '../lib/supabase';
import type { Member, Message, Profile, Reaction } from '../lib/database.types';
import {
  S, addReaction, bumpChat, dropChat, emit, ensureProfiles, loadChats, loadFeed, meId,
  putProfile, refreshProfiles, reloadChatsSoon, removeReaction, ts, upsertMessage,
} from './store';

const TYPING_TTL = 6000;
/** Если WebSocket недоступен (корпоративная сеть, прокси) — подтягиваем изменения опросом. */
const POLL_MS = 8000;
/** Как часто сообщаем «я в сети» (сервер держит статус 75 секунд). */
const PING_MS = 45_000;

let dbChannel: RealtimeChannel | null = null;
let chatChannel: RealtimeChannel | null = null;
let chatTopicId: string | null = null;
let everConnected = false;
let hiddenAt = 0;
let typingSweep: number | undefined;
let pingTimer: number | undefined;
let statusTick: number | undefined;
let lastToken: string | null = null;
let statusCb: (ok: boolean) => void = () => {};
let pollTimer: number | undefined;
let connectTimer: number | undefined;
let connected: boolean | null = null;

function setConnected(ok: boolean): void {
  clearTimeout(connectTimer);
  if (connected === ok) return;
  connected = ok;
  statusCb(ok);
  if (ok) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  } else if (pollTimer === undefined) {
    pollTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void resync(true);
    }, POLL_MS);
  }
}

/** Приватный канал: слушать и писать в него могут только участники чата (RLS-политики на realtime.messages). */
function channel(topic: string, config: NonNullable<RealtimeChannelOptions['config']>, setup: (ch: RealtimeChannel) => void,
  onJoin: (ch: RealtimeChannel) => void): RealtimeChannel {
  const ch = sb.channel(topic, { config: { ...config, private: true } });
  setup(ch);
  ch.subscribe((status) => { if (status === 'SUBSCRIBED') onJoin(ch); });
  return ch;
}

// ---------------------------------------------------------------------------
// Изменения в базе
// ---------------------------------------------------------------------------

function onMessageInsert(m: Message): void {
  const f = S.feeds.get(m.chat_id);
  const isNew = f ? !f.msgs.some((x) => x.id === m.id) : true;
  if (f) upsertMessage(m);
  const c = S.chats.get(m.chat_id);
  if (!c) { reloadChatsSoon(); return; }
  const newer = ts(m.created_at) > ts(c.last_at);
  if (isNew && newer && m.user_id !== meId() && !m.deleted_at
      && ts(m.created_at) > ts(c.last_read_at) && S.visibleChat() !== m.chat_id) {
    c.unread += 1;
  }
  bumpChat(m);
  if (m.user_id && S.typing.delete(m.user_id)) { S.typingWhat.delete(m.user_id); emit('head'); }
  void ensureProfiles([m.user_id]);
  emit('chats', 'feed');
}

function onMessageUpdate(m: Message): void {
  const old = S.feeds.get(m.chat_id)?.msgs.find((x) => x.id === m.id);
  if (old) Object.assign(old, m, { pending: false, failed: false });
  if (m.deleted_at) S.reactions.delete(m.id);
  const c = S.chats.get(m.chat_id);
  if (c?.last_id === m.id) bumpChat(m);
  if (m.deleted_at && c && c.unread && m.user_id !== meId()) reloadChatsSoon();
  emit('chats', 'feed');
}

function onReactionInsert(r: Reaction): void {
  const loaded = S.feeds.get(r.chat_id)?.msgs.some((m) => m.id === r.message_id);
  if (!loaded) return;
  addReaction(r);
  void ensureProfiles([r.user_id]);
  emit('feed');
}

function onReactionDelete(r: Partial<Reaction>): void {
  if (!r.message_id || !r.user_id || !r.emoji) return;
  removeReaction(r.message_id, r.user_id, r.emoji);
  emit('feed');
}

function onMember(event: string, row: Partial<Member>): void {
  if (!row.chat_id || !row.user_id) return;
  const c = S.chats.get(row.chat_id);
  const list = S.members.get(row.chat_id);
  const mine = row.user_id === meId();
  if (event === 'INSERT') {
    if (mine) { reloadChatsSoon(); return; }
    if (!c) return;
    if (list && !list.some((m) => m.user_id === row.user_id)) {
      list.push(row as Member);
      c.member_count = list.length;
    } else if (!list) {
      c.member_count += 1;
    }
    void ensureProfiles([row.user_id]);
  } else if (event === 'UPDATE') {
    const m = list?.find((x) => x.user_id === row.user_id);
    if (m) Object.assign(m, row);
    if (mine && c && row.last_read_at && ts(row.last_read_at) > ts(c.last_read_at)) {
      // Прочитано на другом устройстве.
      c.last_read_at = row.last_read_at;
      if (ts(c.last_read_at) >= ts(c.last_at)) c.unread = 0;
    }
  } else if (event === 'DELETE') {
    if (mine) { dropChat(row.chat_id); return; }
    if (!c) return;
    if (list) {
      S.members.set(row.chat_id, list.filter((m) => m.user_id !== row.user_id));
      c.member_count = list.length - 1;
    } else {
      c.member_count = Math.max(1, c.member_count - 1);
    }
  }
  emit('chats', 'head', 'members', 'feed');
}

function onChat(event: string, row: Partial<{ id: string; name: string | null; emoji: string; invite_code: string | null }>): void {
  if (!row.id) return;
  if (event === 'DELETE') { dropChat(row.id); return; }
  const c = S.chats.get(row.id);
  if (!c) return;
  if (event === 'UPDATE') {
    c.name = row.name ?? c.name;
    c.emoji = row.emoji ?? c.emoji;
    if ('invite_code' in row) c.invite_code = row.invite_code ?? null;
    emit('chats', 'head', 'members');
  }
}

let resyncing = false;
async function resync(withProfiles = false): Promise<void> {
  if (resyncing) return;
  resyncing = true;
  try {
    await loadChats();
    if (S.cur && S.chats.has(S.cur)) await loadFeed(S.cur, true);
    if (withProfiles) await refreshProfiles();
  } catch { /* повторим при следующем переподключении */ } finally {
    resyncing = false;
  }
}

// ---------------------------------------------------------------------------
// Присутствие
// ---------------------------------------------------------------------------

// «Я в сети»: пульс раз в 45 секунд, пока вкладка видна; при уходе — сразу «был(а) в сети».
function ping(online: boolean): void {
  sb.rpc('ping', { p_online: online }).then(() => {}, () => {});
  sb.auth.getSession().then(({ data }) => { lastToken = data.session?.access_token ?? null; }, () => {});
  const me = S.me;
  if (me) {
    const now = Date.now();
    me.last_seen_at = new Date(now).toISOString();
    me.online_until = new Date(online ? now + 75_000 : now).toISOString();
    emit('me');
  }
}

/** Перед выходом из аккаунта: сразу «был(а) в сети». */
export async function goOffline(): Promise<void> {
  try { await sb.rpc('ping', { p_online: false }); } catch { /* не страшно */ }
}

/** Закрытие вкладки: обычный запрос может не успеть — отправляем keepalive-запрос. */
function onPageHide(): void {
  if (!lastToken) return;
  try {
    void fetch(`${SUPABASE_URL}/rest/v1/rpc/ping`, {
      method: 'POST',
      keepalive: true,
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${lastToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_online: false }),
    });
  } catch { /* браузер мог не дать отправить — статус истечёт сам через 75 секунд */ }
}

function onVisibility(): void {
  if (document.visibilityState === 'visible') {
    ping(true);
    if (chatChannel) void chatChannel.track({ user_id: meId() });
    // Телефон мог «усыпить» сокет — догоняем пропущенное.
    if (hiddenAt && Date.now() - hiddenAt > 30_000) void resync();
    hiddenAt = 0;
  } else {
    hiddenAt = Date.now();
    sendTyping(false);
    ping(false);
    void chatChannel?.untrack();
  }
}

export async function startRealtime(onStatus: (ok: boolean) => void): Promise<void> {
  statusCb = onStatus;
  everConnected = false;
  connected = null;
  await sb.realtime.setAuth();
  // Нет подтверждения подписки за 10 секунд — считаем, что живого соединения нет.
  connectTimer = window.setTimeout(() => setConnected(false), 10_000);

  dbChannel = sb
    .channel('skam-db')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) => onMessageInsert(p.new as Message))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (p) => onMessageUpdate(p.new as Message))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'reactions' }, (p) => onReactionInsert(p.new as Reaction))
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'reactions' }, (p) => onReactionDelete(p.old as Partial<Reaction>))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_members' }, (p) =>
      onMember(p.eventType, (p.eventType === 'DELETE' ? p.old : p.new) as Partial<Member>))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'chats' }, (p) =>
      onChat(p.eventType, (p.eventType === 'DELETE' ? p.old : p.new) as Record<string, never>))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, (p) => putProfile(p.new as Profile))
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        setConnected(true);
        if (everConnected) void resync();
        everConnected = true;
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        setConnected(false);
      }
    });

  if (document.visibilityState === 'visible') ping(true);
  pingTimer = window.setInterval(() => { if (document.visibilityState === 'visible') ping(true); }, PING_MS);
  // Статусы «в сети» истекают и «N минут назад» растёт — перерисовываем раз в 30 секунд.
  statusTick = window.setInterval(() => emit('online', 'head', 'chats', 'members'), 30_000);
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onVisibility);
  typingSweep = window.setInterval(() => {
    const now = Date.now();
    let changed = false;
    S.typing.forEach((until, uid) => { if (until < now) { S.typing.delete(uid); S.typingWhat.delete(uid); changed = true; } });
    if (changed) emit('head');
  }, 1500);
}

export async function stopRealtime(): Promise<void> {
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('pagehide', onPageHide);
  clearInterval(typingSweep);
  clearInterval(pingTimer);
  clearInterval(statusTick);
  clearInterval(pollTimer);
  clearTimeout(connectTimer);
  pollTimer = undefined;
  connected = null;
  const all = [dbChannel, chatChannel];
  dbChannel = chatChannel = null;
  chatTopicId = null;
  await Promise.all(all.map((ch) => (ch ? sb.removeChannel(ch) : null)));
  await sb.removeAllChannels();
}

// ---------------------------------------------------------------------------
// Канал открытого чата: кто сейчас в чате и кто печатает
// ---------------------------------------------------------------------------

export function joinChatChannel(chatId: string | null): void {
  if (chatTopicId === chatId && (chatChannel || !chatId)) return;
  if (chatChannel) void sb.removeChannel(chatChannel);
  chatChannel = null;
  chatTopicId = chatId;
  S.inChat.clear();
  S.typing.clear();
  S.typingWhat.clear();
  emit('head');
  if (!chatId) return;
  chatChannel = channel(
    `chat:${chatId}`,
    { presence: { key: meId() }, broadcast: { self: false } },
    (ch) => ch
      .on('presence', { event: 'sync' }, () => {
        if (chatTopicId !== chatId) return;
        S.inChat = new Set(Object.keys(ch.presenceState()));
        emit('head');
      })
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        const uid = typeof payload?.user_id === 'string' ? payload.user_id : null;
        if (chatTopicId !== chatId || !uid || uid === meId()) return;
        if (payload.typing) {
          S.typing.set(uid, Date.now() + TYPING_TTL);
          // Старые клиенты action не присылают — тогда это обычное «печатает…».
          if (payload.action === 'voice' || payload.action === 'video_note') S.typingWhat.set(uid, payload.action);
          else S.typingWhat.delete(uid);
        } else {
          S.typing.delete(uid);
          S.typingWhat.delete(uid);
        }
        void ensureProfiles([uid]);
        emit('head');
      }),
    (ch) => { if (document.visibilityState === 'visible') void ch.track({ user_id: meId() }); },
  );
}

let typingOn = false;
let typingSentAt = 0;
let typingAction: TypingAction = 'text';
export type TypingAction = 'text' | 'voice' | 'video_note';
/** «печатает…», «записывает голосовое…» или «записывает кружочек…». */
export function sendTyping(on: boolean, action: TypingAction = 'text'): void {
  if (!chatChannel) { typingOn = false; return; }
  const now = Date.now();
  // Повторяем раз в 3 секунды, пока человек набирает текст или записывает.
  if (on && typingOn && action === typingAction && now - typingSentAt < 3000) return;
  if (!on && !typingOn) return;
  typingOn = on;
  typingAction = action;
  typingSentAt = now;
  const payload: Record<string, unknown> = { user_id: meId(), typing: on };
  if (on && action !== 'text') payload.action = action;
  void chatChannel.send({ type: 'broadcast', event: 'typing', payload });
}
