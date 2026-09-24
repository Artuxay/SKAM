// «в сети» / «был(а) в сети …» — как в Telegram.
import type { Profile } from './database.types';
import { dayKey, plural, timeLabel } from './dom';

type Presence = Pick<Profile, 'online_until' | 'last_seen_at'> | null | undefined;

const fmtDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const fmtDateY = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

export function isOnline(p: Presence, now = Date.now()): boolean {
  return !!p?.online_until && Date.parse(p.online_until) > now;
}

export function statusText(p: Presence, now = Date.now()): string {
  if (isOnline(p, now)) return 'в сети';
  if (!p?.last_seen_at) return 'был(а) недавно';
  const t = Date.parse(p.last_seen_at);
  const diff = Math.max(0, now - t);
  if (diff < 60_000) return 'был(а) в сети только что';
  if (diff < 60 * 60_000) return `был(а) в сети ${plural(Math.floor(diff / 60_000), 'минуту', 'минуты', 'минут')} назад`;
  if (dayKey(t) === dayKey(now)) return `был(а) в сети сегодня в ${timeLabel(t)}`;
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (dayKey(t) === dayKey(y.getTime())) return `был(а) в сети вчера в ${timeLabel(t)}`;
  const date = new Date(t).getFullYear() === new Date(now).getFullYear() ? fmtDate.format(t) : fmtDateY.format(t);
  return `был(а) в сети ${date} в ${timeLabel(t)}`;
}
