// «Заблокировать», «Без звука» и настройки уведомлений.
// Блокировки и «без звука» хранятся на сервере (одинаковые на всех устройствах), уведомления — на этом устройстве.
import { sb } from '../lib/supabase';
import type { CommonGroup } from '../lib/database.types';
import { lsGet, lsSet } from '../lib/dom';
import { S, emit } from './store';

let loadedAt = 0;
/** Счётчик изменений: ответ загрузки, начатой до изменения, устарел. */
let mut = 0;

export function resetPrefs(): void {
  loadedAt = 0;
  mut++;
}

/** Загрузить заблокированных и чаты без звука. Без force — не чаще раза в 15 секунд. */
export async function loadPrefs(force = false): Promise<void> {
  if (!force && loadedAt && Date.now() - loadedAt < 15_000) return;
  const my = mut;
  const [b, m] = await Promise.all([sb.rpc('my_blocks'), sb.rpc('my_mutes')]);
  if (b.error) throw b.error;
  if (m.error) throw m.error;
  if (my !== mut) return;
  loadedAt = Date.now();
  const blocks = new Map((b.data ?? []).map((x) => [x.user_id, x]));
  const mutes = new Map((m.data ?? []).map((x) => [x.chat_id, x.until ? Date.parse(x.until) : Infinity]));
  const same = blocks.size === S.blocks.size && [...blocks.keys()].every((k) => S.blocks.has(k))
    && mutes.size === S.mutes.size && [...mutes].every(([k, v]) => S.mutes.get(k) === v);
  S.blocks.clear();
  blocks.forEach((v, k) => S.blocks.set(k, v));
  S.mutes.clear();
  mutes.forEach((v, k) => S.mutes.set(k, v));
  if (!same) emit('prefs', 'chats', 'head');
}

/** Заблокировать или разблокировать человека: сразу на экране, потом на сервере. */
export async function blockUser(uid: string, on: boolean): Promise<void> {
  mut++;
  const before = S.blocks.get(uid);
  if (on) {
    const p = S.profiles.get(uid);
    S.blocks.set(uid, {
      user_id: uid, name: p?.name ?? null, username: p?.username ?? null, avatar_path: p?.avatar_path ?? null,
      color: p?.color ?? null, verified: !!p?.verified, created_at: new Date().toISOString(),
    });
  } else S.blocks.delete(uid);
  emit('prefs', 'chats', 'head');
  const { error } = await sb.rpc('block_user', { p_user: uid, p_on: on });
  if (error) {
    if (before) S.blocks.set(uid, before); else S.blocks.delete(uid);
    emit('prefs', 'chats', 'head');
    throw error;
  }
}

/** «Без звука»: until — до какого момента (мс), Infinity — навсегда, null — включить звук. */
export async function muteChat(chatId: string, until: number | null): Promise<void> {
  mut++;
  const before = S.mutes.get(chatId);
  if (until === null) S.mutes.delete(chatId); else S.mutes.set(chatId, until);
  emit('prefs', 'chats', 'head');
  const { error } = await sb.rpc('mute_chat', {
    p_chat: chatId, p_on: until !== null, p_until: until === null || until === Infinity ? null : new Date(until).toISOString(),
  });
  if (error) {
    if (before === undefined) S.mutes.delete(chatId); else S.mutes.set(chatId, before);
    emit('prefs', 'chats', 'head');
    throw error;
  }
}

/** Сроки «Без звука», как в Telegram. */
export const MUTE_FOR: { label: string; ms: number }[] = [
  { label: 'На 1 час', ms: 3_600_000 },
  { label: 'На 8 часов', ms: 8 * 3_600_000 },
  { label: 'На 2 дня', ms: 2 * 86_400_000 },
  { label: 'Навсегда', ms: Infinity },
];

/** «без звука до 18:30», «без звука до 12 окт.», «без звука». */
export function muteLabel(chatId: string): string {
  const until = S.mutes.get(chatId);
  if (until === undefined || until <= Date.now()) return '';
  if (until === Infinity) return 'Без звука';
  const d = new Date(until);
  const today = new Date();
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Без звука до ${time}`;
  return `Без звука до ${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}, ${time}`;
}

export async function commonGroups(uid: string): Promise<CommonGroup[]> {
  const { data, error } = await sb.rpc('common_groups', { p_user: uid });
  if (error) throw error;
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Уведомления на этом устройстве
// ---------------------------------------------------------------------------

export type NotifyPrefs = {
  /** Показывать уведомления системы, когда СКАМ свёрнут или в другой вкладке. */
  on: boolean;
  /** Текст сообщения в уведомлении (иначе — «Новое сообщение»). */
  preview: boolean;
  /** Звук нового сообщения. */
  sound: boolean;
};

const NOTIFY_KEY = 'skam:notify';

export function notifyPrefs(): NotifyPrefs {
  const def: NotifyPrefs = { on: true, preview: true, sound: true };
  try {
    const raw = lsGet(NOTIFY_KEY);
    if (!raw) return def;
    const v = JSON.parse(raw) as Partial<NotifyPrefs>;
    return { on: v.on !== false, preview: v.preview !== false, sound: v.sound !== false };
  } catch {
    return def;
  }
}

export function setNotifyPrefs(patch: Partial<NotifyPrefs>): NotifyPrefs {
  const next = { ...notifyPrefs(), ...patch };
  lsSet(NOTIFY_KEY, JSON.stringify(next));
  return next;
}
