// Эмодзи-статус у имени (0.5.1), как в Telegram: обычное эмодзи или своё (c:набор/эмодзи), на срок или навсегда.
// Хранится в профиле (emoji_status, emoji_status_until), ставится через set_emoji_status. Истёкший статус
// сервер ещё помнит — не показываем его сами и раз в полминуты перерисовываем, когда чей-то срок вышел.
import { sb } from '../lib/supabase';
import { el } from '../lib/dom';
import { emojiByRef, emojiUrl } from '../lib/emoji';
import { S, emit, meId, putProfile } from './store';

/** Сроки статуса, как в Telegram (null — навсегда). */
export const STATUS_FOR: { label: string; ms: number | null }[] = [
  { label: 'Навсегда', ms: null },
  { label: '1 час', ms: 3_600_000 },
  { label: '2 часа', ms: 7_200_000 },
  { label: '8 часов', ms: 8 * 3_600_000 },
  { label: '2 дня', ms: 48 * 3_600_000 },
];

const CUSTOM_RE = /^c:u[0-9a-f]{11}\/[a-z0-9]{10}$/;

/** Статус, если он ещё действует. */
export function activeStatus(emoji: string | null | undefined, until: string | null | undefined): string | null {
  if (!emoji) return null;
  if (until && Date.parse(until) <= Date.now()) return null;
  if (emoji.startsWith('c:') && !CUSTOM_RE.test(emoji)) return null;
  return emoji;
}

/** Эмодзи-статус человека (null — нет или срок вышел). */
export function statusOf(uid: string | null | undefined): string | null {
  if (!uid) return null;
  const p = S.profiles.get(uid);
  return activeStatus(p?.emoji_status, p?.emoji_status_until);
}

/** До какого момента статус (мс); null — навсегда или статуса нет. */
export function statusUntil(uid: string | null | undefined): number | null {
  const p = uid ? S.profiles.get(uid) : undefined;
  if (!p?.emoji_status || !p.emoji_status_until) return null;
  return Date.parse(p.emoji_status_until);
}

/** Своё ли эмодзи в статусе: ссылка «набор/эмодзи» (для перехода к набору). */
export function statusRef(status: string | null): string | null {
  return status && status.startsWith('c:') ? status.slice(2) : null;
}

/** Значок статуса рядом с именем: эмодзи или картинка своего эмодзи (без картинки — ничего). */
export function statusEl(status: string, cls = ''): HTMLElement {
  const s = el('span', `estatus${cls ? ` ${cls}` : ''}`);
  const ref = statusRef(status);
  if (ref) {
    const img = el('img');
    img.src = emojiUrl(ref);
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    img.addEventListener('error', () => s.remove(), { once: true });
    s.append(img);
    const known = emojiByRef(ref);
    s.title = known ? `Статус :${known.name}:` : 'Эмодзи-статус';
  } else {
    s.textContent = status;
    s.title = `Статус ${status}`;
  }
  s.setAttribute('role', 'img');
  s.setAttribute('aria-label', s.title);
  return s;
}

/** Поставить свой статус (null — убрать). forMs — на сколько; null — навсегда. */
export async function setMyStatus(emoji: string | null, forMs: number | null): Promise<void> {
  const until = emoji && forMs ? new Date(Date.now() + forMs).toISOString() : null;
  const { error } = await sb.rpc('set_emoji_status', { p_emoji: emoji, p_until: until });
  if (error) throw error;
  const me = S.profiles.get(meId());
  if (me) putProfile({ ...me, emoji_status: emoji, emoji_status_until: until });
}

/** Как долго ещё статус: «до 15:30», «до завтра, 9:00», «до 23 октября». */
export function untilLabel(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  if (day(d) === day(now)) return `до ${time}`;
  const tomorrow = new Date(now.getTime() + 86_400_000);
  if (day(d) === day(tomorrow)) return `до завтра, ${time}`;
  return `до ${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}, ${time}`;
}

// Срок чьего-то статуса вышел — перерисовать имена (без запросов: всё уже есть в профилях).
let shown = '';
function signature(): string {
  const now = Date.now();
  let sig = '';
  S.profiles.forEach((p, id) => {
    if (p.emoji_status && p.emoji_status_until && Date.parse(p.emoji_status_until) <= now) sig += id;
  });
  return sig;
}
let tick: number | undefined;
export function startStatusClock(): void {
  clearInterval(tick);
  shown = signature();
  tick = window.setInterval(() => {
    const sig = signature();
    if (sig === shown) return;
    shown = sig;
    emit('chats', 'feed', 'head', 'members', 'me');
  }, 30_000);
}
export function stopStatusClock(): void {
  clearInterval(tick);
  tick = undefined;
}
