// «в сети» / «был(а) в сети …» — как в Telegram.
// С 0.4.1 точное время приходит только если оба человека разрешают его друг другу; иначе сервер
// присылает лишь примерное: «был(а) недавно», «на этой неделе», «в этом месяце» или «давно».
import type { Presence, SeenBucket } from './database.types';
import { dayKey, plural, timeLabel } from './dom';

type P = Presence | null | undefined;

const fmtDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const fmtDateY = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

const APPROX: Record<SeenBucket, string> = {
  recently: 'был(а) недавно',
  week: 'был(а) на этой неделе',
  month: 'был(а) в этом месяце',
  long: 'был(а) давно',
};

export function isOnline(p: P, now = Date.now()): boolean {
  return !!p?.online_until && Date.parse(p.online_until) > now;
}

/** Время скрыто настройками (видно только примерно). */
export function isApprox(p: P): boolean {
  return !!p && !p.last_seen_at && !!p.seen;
}

/** Строка статуса. Пока время не загружено — пусто, чтобы не мигало «недавно» → точное время. */
export function statusText(p: P, now = Date.now()): string {
  if (!p) return '';
  if (isOnline(p, now)) return 'в сети';
  if (!p.last_seen_at) return APPROX[p.seen ?? 'recently'] ?? APPROX.recently;
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

/** Для сортировки «кто был позже»: точное время, а скрытое — по примерному порядку. */
export function seenRank(p: P, now = Date.now()): number {
  if (!p) return 0;
  if (isOnline(p, now)) return now + 1;
  if (p.last_seen_at) return Date.parse(p.last_seen_at) || 0;
  const DAY = 86_400_000;
  switch (p.seen) {
    case 'recently': return now - 3 * DAY;
    case 'week': return now - 7 * DAY;
    case 'month': return now - 30 * DAY;
    default: return 1;
  }
}
