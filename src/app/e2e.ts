// Сквозное шифрование: ключ личности, пароль шифрования, ключи чатов и их раздача участникам.
// Сервер видит только открытые ключи, завёрнутые ключи чатов и шифротекст.
import { sb } from '../lib/supabase';
import type { KeyShare } from '../lib/database.types';
import {
  type Bytes, type KeyBackup, WrongPasswordError, aesKey, cryptoSupported, generateIdentity, importPrivate,
  keyPairMatches, openJson, openPrivate, rand, sealJson, sealPrivate, unwrapChatKey, wrapChatKey,
} from '../lib/crypto';
import { idbDel, idbGet, idbPut } from '../lib/idb';
import { uuid } from '../lib/dom';

export { WrongPasswordError };
export class KeyExistsError extends Error {}

type Identity = { userId: string; pub: string; priv: CryptoKey };
type ChatKey = { id: string; chatId: string; raw: Bytes; key: CryptoKey };
type ShareRow = Pick<KeyShare, 'key_id' | 'chat_id' | 'wrapped' | 'sender_id' | 'sender_pub'>;

let me: Identity | null = null;
/** Мои доли ключей чатов (завёрнутые для меня), по id ключа. */
const shares = new Map<string, ShareRow[]>();
/** Развёрнутые ключи чатов. */
const keys = new Map<string, ChatKey>();
const unwrapping = new Map<string, Promise<ChatKey | null>>();
/** Когда в последний раз безуспешно искали долю ключа на сервере. */
const missAt = new Map<string, number>();
/** Каким ключом писать в чат: кэш, пока не изменился состав участников. */
const sendKeys = new Map<string, { key: ChatKey; members: string; at: number }>();
const SEND_KEY_TTL = 10 * 60_000;

/** Колбэк: для чата появились новые ключи — можно заново расшифровать ждущие сообщения. */
let keysArrived: (chatId: string) => void = () => {};
export function onKeysArrived(fn: (chatId: string) => void): void {
  keysArrived = fn;
}

export function ready(): boolean {
  return !!me;
}
export function myPublicKey(): string | null {
  return me?.pub ?? null;
}

/** Сквозное шифрование — в обычных чатах: личных и группах. Канал и бот — без него, как в Telegram. */
export function isE2EKind(kind: string | null | undefined): boolean {
  return kind === 'direct' || kind === 'group';
}

const localKey = (uid: string) => `identity:${uid}`;

// ---------------------------------------------------------------------------
// Ключ личности
// ---------------------------------------------------------------------------

export type InitState = 'ready' | 'setup' | 'unlock' | 'unsupported';

/** Есть ли ключ на этом устройстве, на сервере, или его надо создать. */
export async function init(userId: string): Promise<InitState> {
  reset();
  if (!cryptoSupported()) return 'unsupported';
  const [remote, local] = await Promise.all([
    sb.from('user_keys').select('public_key').eq('user_id', userId).maybeSingle(),
    idbGet<{ pub: string; priv: CryptoKey }>(localKey(userId)).catch(() => undefined),
  ]);
  if (remote.error) throw remote.error;
  if (!remote.data) {
    if (local) await idbDel(localKey(userId)).catch(() => {});
    return 'setup';
  }
  if (local && local.pub === remote.data.public_key) {
    me = { userId, pub: local.pub, priv: local.priv };
    return 'ready';
  }
  // Ключ сменили на другом устройстве (сброс пароля) — этот больше не подходит.
  if (local) await idbDel(localKey(userId)).catch(() => {});
  return 'unlock';
}

async function remember(userId: string, pub: string, pkcs8: Bytes): Promise<void> {
  const priv = await importPrivate(pkcs8);
  pkcs8.fill(0);
  me = { userId, pub, priv };
  try {
    await idbPut(localKey(userId), { pub, priv });
  } catch {
    // Приватный режим браузера: ключ живёт до закрытия вкладки, потом снова понадобится пароль.
  }
}

/** Первый запуск (или сброс, если пароль забыт): новая пара ключей + копия под паролем на сервере. */
export async function createIdentity(userId: string, password: string, resetOld = false): Promise<void> {
  const { pub, pkcs8 } = await generateIdentity();
  const b = await sealPrivate(pkcs8, password, pub);
  const { error } = await sb.rpc('set_identity_key', {
    p_public: pub, p_backup: b.backup, p_salt: b.salt, p_iterations: b.iterations, p_reset: resetOld,
  });
  if (error) {
    if (error.code === '23505') throw new KeyExistsError('key exists');
    throw error;
  }
  shares.clear();
  keys.clear();
  sendKeys.clear();
  await remember(userId, pub, pkcs8);
}

async function fetchBackup(): Promise<KeyBackup & { pub: string }> {
  const { data, error } = await sb.rpc('my_key_backup');
  if (error) throw error;
  const row = data?.[0];
  if (!row) throw new Error('Ключ шифрования не найден');
  return { pub: row.public_key, backup: row.backup, salt: row.salt, iterations: row.iterations };
}

/** Новое устройство: расшифровать копию закрытого ключа паролем. */
export async function unlock(userId: string, password: string): Promise<void> {
  const b = await fetchBackup();
  const pkcs8 = await openPrivate(b, password, b.pub);
  await remember(userId, b.pub, pkcs8);
  if (!(await keyPairMatches(me!.priv, b.pub))) {
    me = null;
    await idbDel(localKey(userId)).catch(() => {});
    throw new Error('Копия ключа повреждена');
  }
}

/** Сменить пароль: тот же ключ, новая копия. Нужен текущий пароль. */
export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  const b = await fetchBackup();
  const pkcs8 = await openPrivate(b, oldPassword, b.pub);
  const nb = await sealPrivate(pkcs8, newPassword, b.pub);
  pkcs8.fill(0);
  const { error } = await sb.rpc('update_key_backup', { p_backup: nb.backup, p_salt: nb.salt, p_iterations: nb.iterations });
  if (error) throw error;
}

/** Выход из аккаунта: ключ удаляется с этого устройства (для входа снова понадобится пароль). */
export async function forgetDevice(userId: string): Promise<void> {
  reset();
  await idbDel(localKey(userId)).catch(() => {});
  try { await caches.delete(MEDIA_CACHE); } catch { /* нет Cache API */ }
}

export const MEDIA_CACHE = 'skam-media-v1';

export function reset(): void {
  me = null;
  shares.clear();
  keys.clear();
  unwrapping.clear();
  missAt.clear();
  sendKeys.clear();
  clearTimeout(sweepTimer);
}

// ---------------------------------------------------------------------------
// Ключи чатов
// ---------------------------------------------------------------------------

function addShare(row: ShareRow): void {
  const list = shares.get(row.key_id) ?? [];
  if (!list.some((r) => r.sender_id === row.sender_id)) list.push(row);
  shares.set(row.key_id, list);
  missAt.delete(row.key_id);
}

/** Загрузить все доли ключей, завёрнутые для меня. */
export async function loadMyShares(): Promise<void> {
  if (!me) return;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('chat_key_shares')
      .select('key_id, chat_id, wrapped, sender_id, sender_pub')
      .eq('user_id', me.userId)
      .order('created_at', { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    data.forEach(addShare);
    if (data.length < 1000) break;
  }
}

/** Пришла доля ключа (Realtime). Для меня — пробуем расшифровать ждущие сообщения. */
export function onShare(row: KeyShare): void {
  if (!me) return;
  if (row.user_id === me.userId) {
    addShare(row);
    keysArrived(row.chat_id);
  }
}

async function unwrapFrom(keyId: string, rows: ShareRow[]): Promise<ChatKey | null> {
  if (!me) return null;
  for (const r of rows) {
    try {
      const raw = await unwrapChatKey(r.wrapped, me.priv, r.sender_pub, { chatId: r.chat_id, keyId, userId: me.userId });
      const k: ChatKey = { id: keyId, chatId: r.chat_id, raw, key: await aesKey(raw) };
      keys.set(keyId, k);
      return k;
    } catch {
      // Эта доля не подошла (например, завёрнута для старого ключа) — пробуем следующую.
    }
  }
  return null;
}

/** Ключ чата по id или null, если его у меня нет. */
export function chatKey(keyId: string): Promise<ChatKey | null> {
  const have = keys.get(keyId);
  if (have) return Promise.resolve(have);
  let p = unwrapping.get(keyId);
  if (p) return p;
  p = (async () => {
    if (!me) return null;
    let rows = shares.get(keyId);
    if (!rows?.length) {
      const miss = missAt.get(keyId);
      if (miss && Date.now() - miss < 15_000) return null;
      const { data } = await sb.from('chat_key_shares')
        .select('key_id, chat_id, wrapped, sender_id, sender_pub')
        .eq('key_id', keyId).eq('user_id', me.userId);
      data?.forEach(addShare);
      rows = shares.get(keyId);
      if (!rows?.length) { missAt.set(keyId, Date.now()); return null; }
    }
    return unwrapFrom(keyId, rows);
  })().finally(() => unwrapping.delete(keyId));
  unwrapping.set(keyId, p);
  return p;
}

async function memberIds(chatId: string): Promise<string[]> {
  const { data, error } = await sb.from('chat_members').select('user_id').eq('chat_id', chatId);
  if (error) throw error;
  return data.map((m) => m.user_id);
}

/** Новый ключ чата: 32 случайных байта, завёрнутые для каждого участника с включённым шифрованием. */
async function createChatKey(chatId: string, members: string[]): Promise<ChatKey> {
  if (!me) throw new Error('no identity');
  const id = uuid();
  const raw = rand(32);
  const ins = await sb.from('chat_keys').insert({ id, chat_id: chatId });
  if (ins.error) throw ins.error;
  const { data: pubs, error } = await sb.from('user_keys').select('user_id, public_key').in('user_id', members);
  if (error) throw error;
  const recipients = pubs.some((p) => p.user_id === me!.userId) ? pubs : [...pubs, { user_id: me.userId, public_key: me.pub }];
  const rows = await Promise.all(recipients.map(async (p) => {
    return {
      key_id: id,
      user_id: p.user_id,
      sender_pub: me!.pub,
      wrapped: await wrapChatKey(raw, me!.priv, p.public_key, { chatId, keyId: id, userId: p.user_id }),
    };
  }));
  const res = await sb.from('chat_key_shares').insert(rows);
  if (res.error) throw res.error;
  const k: ChatKey = { id, chatId, raw, key: await aesKey(raw) };
  keys.set(id, k);
  addShare({ key_id: id, chat_id: chatId, wrapped: rows.find((r) => r.user_id === me!.userId)!.wrapped, sender_id: me.userId, sender_pub: me.pub });
  return k;
}

/**
 * Каким ключом шифровать новое сообщение. Берём самый свежий ключ чата, если он у меня есть
 * и его не получал никто, кто уже вышел из чата. Иначе создаём новый — так вышедший участник
 * не прочитает сообщения, написанные после его ухода.
 */
async function sendKey(chatId: string): Promise<ChatKey> {
  // Состав участников проверяем перед каждой отправкой: Realtime может быть недоступен,
  // а вышедший участник не должен получить ключ к новым сообщениям.
  const members = await memberIds(chatId);
  const sig = [...members].sort().join(',');
  const cached = sendKeys.get(chatId);
  if (cached && cached.members === sig && Date.now() - cached.at < SEND_KEY_TTL) return cached.key;
  const { data: latest, error } = await sb.from('chat_keys').select('id').eq('chat_id', chatId)
    .order('created_at', { ascending: false }).limit(1);
  if (error) throw error;
  let k: ChatKey | null = null;
  if (latest[0]) {
    const have = await chatKey(latest[0].id);
    if (have) {
      const { data: got } = await sb.from('chat_key_shares').select('user_id').eq('key_id', have.id);
      const inChat = new Set(members);
      if (got && got.every((g) => inChat.has(g.user_id))) k = have;
    }
  }
  if (!k) k = await createChatKey(chatId, members);
  sendKeys.set(chatId, { key: k, members: sig, at: Date.now() });
  return k;
}

/** Кто-то вышел из чата — следующее сообщение пойдёт новым ключом. */
export function membersChanged(chatId: string): void {
  sendKeys.delete(chatId);
}

// ---------------------------------------------------------------------------
// Раздача ключей: новым участникам и тем, кто включил шифрование позже
// ---------------------------------------------------------------------------

let sweeping = false;
let sweepAgain = false;
let sweepTimer: number | undefined;

export function sweepSoon(delay = 1500): void {
  clearTimeout(sweepTimer);
  sweepTimer = window.setTimeout(() => { void sweep(); }, delay);
}

export async function sweep(): Promise<void> {
  if (!me) return;
  if (sweeping) { sweepAgain = true; return; }
  sweeping = true;
  try {
    const tried = new Set<string>();
    for (let round = 0; round < 10; round++) {
      const { data, error } = await sb.rpc('e2e_pending', { p_limit: 300 });
      if (error || !data?.length) break;
      const fresh = data.filter((r) => !tried.has(`${r.key_id}:${r.user_id}`));
      if (!fresh.length) break;
      const byKey = new Map<string, typeof fresh>();
      fresh.forEach((r) => {
        tried.add(`${r.key_id}:${r.user_id}`);
        byKey.set(r.key_id, [...(byKey.get(r.key_id) ?? []), r]);
      });
      for (const [keyId, rows] of byKey) {
        const k = await chatKey(keyId);
        if (!k) continue;
        const out = await Promise.all(rows.map(async (r) => {
          return {
            key_id: keyId,
            user_id: r.user_id,
            sender_pub: me!.pub,
            wrapped: await wrapChatKey(k.raw, me!.priv, r.public_key, { chatId: r.chat_id, keyId, userId: r.user_id }),
          };
        }));
        // Кто-то мог успеть раньше нас — такие строки просто пропускаются.
        await sb.from('chat_key_shares').upsert(out, { onConflict: 'key_id,user_id,sender_id', ignoreDuplicates: true });
      }
    }
  } catch {
    // Повторим при следующем поводе (новый участник, переподключение, таймер).
  } finally {
    sweeping = false;
    if (sweepAgain) { sweepAgain = false; sweepSoon(); }
  }
}

// ---------------------------------------------------------------------------
// Шифрование сообщений
// ---------------------------------------------------------------------------

/**
 * Содержимое зашифрованного сообщения. Внутри — всё, что в открытых чатах лежит в отдельных колонках:
 * текст, вложения (с ключами файлов), стикер, голосовое или кружочек (путь к файлу и его ключ).
 */
export type Payload = {
  v: 1;
  text?: string;
  files?: unknown[];
  sticker?: string;
  rec?: { kind: 'voice' | 'video_note'; path: unknown; key: unknown; mime: unknown; dur: unknown; wave: unknown };
  /** Ответ: id сообщения, его автор и короткий слепок (цитата видна, даже если оригинал не загружен). */
  reply?: { id: unknown; uid?: unknown; text?: unknown; k?: unknown };
  /** «Переслано от …» — внутри шифротекста, сервер не знает, откуда переслали. */
  fwd?: { name: unknown; from?: unknown; kind?: unknown; at?: unknown };
};

const msgAad = (chatId: string, msgId: string, userId: string) => `skam/msg/v1|${chatId}|${msgId}|${userId}`;

export async function encryptMessage(chatId: string, msgId: string, payload: Payload): Promise<{ enc: string; key_id: string }> {
  if (!me) throw new Error('Шифрование не настроено');
  const k = await sendKey(chatId);
  return { enc: await sealJson(k.key, payload, msgAad(chatId, msgId, me.userId)), key_id: k.id };
}

export class NoKeyError extends Error {}

/** Расшифровать сообщение. NoKeyError — ключа пока нет (придёт, когда кто-то из участников будет в сети). */
export async function decryptMessage(m: { id: string; chat_id: string; user_id: string | null; enc: string | null; key_id: string | null }): Promise<Payload> {
  if (!m.enc || !m.key_id) throw new Error('not encrypted');
  const k = await chatKey(m.key_id);
  if (!k) throw new NoKeyError('no key');
  return openJson<Payload>(k.key, m.enc, msgAad(m.chat_id, m.id, m.user_id ?? ''));
}

// ---------------------------------------------------------------------------
// Звонки: служебные сообщения WebRTC шифруются ключом чата
// ---------------------------------------------------------------------------

/**
 * Ключ, которым участник звонка шифрует свои служебные сообщения (offer/answer/ICE).
 * Сервер не знает ключа чата, поэтому не может подменить отпечатки DTLS и встать посередине.
 */
export type SignalKey = { id: string; chatId: string; key: CryptoKey };

export async function signalKey(chatId: string): Promise<SignalKey> {
  const k = await sendKey(chatId);
  return { id: k.id, chatId, key: k.key };
}

const sigAad = (callId: string, from: string, to: string) => `skam/call/v1|${callId}|${from}|${to}`;

export async function sealSignal(k: SignalKey, callId: string, to: string, value: unknown): Promise<string> {
  if (!me) throw new Error('Шифрование не настроено');
  return JSON.stringify({ k: k.id, e: await sealJson(k.key, value, sigAad(callId, me.userId, to)) });
}

/** Расшифровать служебное сообщение от участника звонка. Ключ должен быть ключом этого же чата. */
export async function openSignal(payload: string, chatId: string, callId: string, from: string): Promise<unknown> {
  if (!me) throw new Error('Шифрование не настроено');
  const box = JSON.parse(payload) as { k?: unknown; e?: unknown };
  if (typeof box.k !== 'string' || typeof box.e !== 'string') throw new Error('bad signal');
  const k = await chatKey(box.k);
  if (!k) throw new NoKeyError('no key');
  if (k.chatId !== chatId) throw new Error('foreign key');
  return openJson<unknown>(k.key, box.e, sigAad(callId, from, me.userId));
}
