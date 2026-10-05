// Свои ники для людей — как «имя контакта» в Telegram: вы называете человека как хотите,
// и это имя видите только вы — в списке чатов, шапке, группах, ответах, звонках и поиске.
// Хранятся на сервере (одинаковые на всех ваших устройствах); здесь — их копия.
import { sb } from '../lib/supabase';
import type { Nickname } from '../lib/database.types';
import { S, emit, meId, rememberProfiles, searchNorm, type FoundUser } from './store';

export const NICK_MAX = 64;

const nicks = new Map<string, string>();
let loaded = false;
let loadedAt = 0;
/** Счётчик изменений: ответ загрузки, начатой до изменения, устарел — его не применяем. */
let mut = 0;
/** Изменения, которые ещё едут на сервер, и была ли за это время отброшена загрузка. */
let inflight = 0;
let staleLoad = false;

/** Мой ник для человека; null — ника нет (и у себя ника не бывает). */
export function nickOf(uid: string | null | undefined): string | null {
  if (!uid || uid === meId()) return null;
  return nicks.get(uid) ?? null;
}

export function resetNicks(): void {
  nicks.clear();
  loaded = false;
  loadedAt = 0;
  inflight = 0;
  staleLoad = false;
  mut++;
}

/** Как на сервере: управляющие символы и переносы — в пробел, лишние пробелы — убрать. */
export function normNick(v: string): string {
  return v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Загрузить ники. Без force — не чаще раза в 15 секунд (для опроса и возврата во вкладку). */
export async function loadNicknames(force = false): Promise<void> {
  if (!force && loaded && Date.now() - loadedAt < 15_000) return;
  const my = mut;
  const { data, error } = await sb.rpc('my_nicknames');
  if (error) throw error;
  // Пока изменение едет на сервер, ответ может быть старым — перечитаем, когда оно доедет.
  if (my !== mut || inflight) { staleLoad = true; return; }
  loadedAt = Date.now();
  apply(data ?? []);
}

function apply(list: Nickname[]): void {
  // Как выглядит человек — чтобы ник и карточка показывались и без общего чата.
  rememberProfiles(list.map((n) => ({
    id: n.user_id, name: n.name, username: n.username, avatar_path: n.avatar_path, color: n.color, verified: n.verified,
  })));
  const first = !loaded;
  loaded = true;
  const same = list.length === nicks.size && list.every((n) => nicks.get(n.user_id) === n.nickname);
  if (same && !first) return;
  nicks.clear();
  list.forEach((n) => nicks.set(n.user_id, n.nickname));
  changed();
}

function changed(): void {
  emit('chats', 'feed', 'head', 'members', 'call');
}

/** Дать, изменить или убрать ник (пусто — убрать). Сразу на экране, потом на сервере. */
export async function setNickname(uid: string, value: string): Promise<string | null> {
  const v = normNick(value);
  const prev = nicks.get(uid);
  mut++;
  inflight++;
  if (v) nicks.set(uid, v);
  else nicks.delete(uid);
  changed();
  try {
    const { data, error } = await sb.rpc('set_nickname', { p_user: uid, p_nickname: v || null });
    if (error) throw error;
    if (data) nicks.set(uid, data);
    else nicks.delete(uid);
    changed();
    return data ?? null;
  } catch (e) {
    if (prev !== undefined) nicks.set(uid, prev);
    else nicks.delete(uid);
    changed();
    throw e;
  } finally {
    inflight--;
    if (!inflight && staleLoad) {
      staleLoad = false;
      void loadNicknames(true).catch(() => {});
    }
  }
}

/** Насколько ник подходит под запрос (как поиск по имени): 0 — не подходит. По @username ники не ищем. */
export function nickScore(nick: string, q: { at: boolean; s: string; toks: string[] }): number {
  if (q.at || !q.s) return 0;
  const n = searchNorm(nick);
  if (n === q.s) return 100;
  if (n.startsWith(q.s)) return 90;
  const words = n.split(/[\s\-—–«»"'.,:;!?()]+/).filter(Boolean);
  if (q.toks.every((t) => words.some((w) => w.startsWith(t)))) return 70;
  return q.s.length >= 3 && n.includes(q.s) ? 50 : 0;
}

/** Люди, чей ник подходит под запрос, — в том же виде, что результаты search_users. */
export function nickHits(q: { at: boolean; s: string; toks: string[] }): FoundUser[] {
  const hits: { f: FoundUser; s: number }[] = [];
  for (const [uid, nick] of nicks) {
    const s = nickScore(nick, q);
    if (!s) continue;
    const p = S.profiles.get(uid);
    hits.push({
      s,
      f: {
        id: uid, name: p?.name ?? null, username: p?.username ?? null, avatar_path: p?.avatar_path ?? null,
        color: p?.color ?? '#E85002',
        // Профиль целиком читается только при общем чате — значит, общий чат есть.
        is_contact: !!p?.created_at, verified: !!p?.verified,
      },
    });
  }
  return hits.sort((a, b) => b.s - a.s || (nicks.get(a.f.id) ?? '').localeCompare(nicks.get(b.f.id) ?? '', 'ru')).map((h) => h.f);
}
