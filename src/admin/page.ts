// Страница владельцев СКАМ https://skam-messenger.ru/admin/ (0.5.3): статистика и обращения в поддержку.
// Вход — общий с мессенджером (та же сессия skam-auth в этом браузере). Данные отдают RPC admin_stats,
// admin_support и admin_support_set: сервер сам проверяет, что вы из private.app_owners.
// Все тексты от людей (обращения, имена) вставляются через textContent — никакого innerHTML.
import './page.css';
import { configured, sb } from '../lib/supabase';
import { applyTheme } from '../lib/theme';
import { el, lsGet, lsSet } from '../lib/dom';
import type { AdminNow, AdminStats, AdminSupport, AdminSupportItem, SupportStatus } from '../lib/database.types';
import { columnChart, compact, dayShort, type Point } from './chart';

applyTheme();

// Цели из плана роста (claude/skam-growth.md, 23.10.2026) — поменять здесь, когда план обновится.
const GOALS = {
  until: '30 ноября',
  groups: 3,
  writers: 20,
  /** Доля людей, у которых есть с кем общаться. */
  partneredPct: 75,
};

type Tab = 'stats' | 'support';
type Metric = 'writers' | 'messages' | 'new_users' | 'calls' | 'seen';
type Filter = SupportStatus | 'all';

const METRICS: { id: Metric; label: string; unit: (n: number) => string; about: string }[] = [
  { id: 'writers', label: 'Писали', unit: (n) => `${n} ${plural(n, 'человек', 'человека', 'человек')}`, about: 'Сколько людей отправили хотя бы одно сообщение в личный чат, группу или канал.' },
  { id: 'messages', label: 'Сообщения', unit: (n) => `${n} ${plural(n, 'сообщение', 'сообщения', 'сообщений')}`, about: 'Сообщения людей в личных чатах, группах и каналах (с комментариями). Без чатов с ботом и «Избранного».' },
  { id: 'new_users', label: 'Новые люди', unit: (n) => `${n} ${plural(n, 'регистрация', 'регистрации', 'регистраций')}`, about: 'Регистрации за день.' },
  { id: 'calls', label: 'Звонки', unit: (n) => `${n} ${plural(n, 'звонок', 'звонка', 'звонков')}`, about: 'Начатые звонки — и отвеченные, и пропущенные.' },
  { id: 'seen', label: 'Заходили', unit: (n) => `${n} ${plural(n, 'человек', 'человека', 'человек')}`, about: 'Сколько людей открывали СКАМ за день. Сервер помнит только последний заход, поэтому этот ряд копится снимками каждые 10 минут.' },
];

const TOPICS: Record<string, string> = { bug: 'Ошибка', question: 'Вопрос', idea: 'Идея', other: 'Другое' };
const STATUSES: { id: SupportStatus; label: string }[] = [
  { id: 'new', label: 'Новое' },
  { id: 'work', label: 'В работе' },
  { id: 'done', label: 'Готово' },
];
const META_KEYS: Record<string, string> = {
  app: 'Версия СКАМ', ua: 'Браузер', platform: 'Система', lang: 'Язык', screen: 'Экран',
  tz: 'Часовой пояс', mode: 'Запуск', theme: 'Тема', net: 'Сеть',
};
const PAGE = 50;
const REFRESH_MS = 60_000;

const page = document.getElementById('page')!;
const tabsEl = document.getElementById('tabs')!;
const tools = document.getElementById('tools')!;

const st = {
  tab: (location.hash === '#support' ? 'support' : 'stats') as Tab,
  days: lsGet('skam:admin:days') === '90' ? 90 : 30,
  metric: (METRICS.some((m) => m.id === lsGet('skam:admin:metric')) ? lsGet('skam:admin:metric') : 'writers') as Metric,
  filter: (['new', 'work', 'done', 'all'].includes(lsGet('skam:admin:filter') ?? '') ? lsGet('skam:admin:filter') : 'new') as Filter,
  stats: null as AdminStats | null,
  sup: null as AdminSupport | null,
  more: false,
  loadedAt: 0,
  busy: false,
};
/** Недописанные заметки: переживают автообновление списка. */
const drafts = new Map<string, string>();
let unchart: (() => void) | null = null;
let toastTimer = 0;

// ---------------------------------------------------------------------------
// Мелочи
// ---------------------------------------------------------------------------

function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

function btn(label: string, fn: () => void, cls = 'ad-btn'): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
}

function toast(text: string): void {
  const t = document.getElementById('toast')!;
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t.hidden = true; }, 3200);
}

function errText(e: unknown): string {
  const err = e as { code?: string; message?: string } | null;
  if (!err) return 'Что-то пошло не так.';
  if (err.message?.includes('Failed to fetch') || err.message?.includes('NetworkError')) return 'Нет связи с сервером.';
  if (err.code === 'PGRST202') return 'На сервере ещё нет функций админки — нужна миграция 20261023120000_admin_dashboard.';
  if (err.message && /^[А-ЯЁ]/.test(err.message)) return err.message;
  return err.message || 'Что-то пошло не так.';
}

const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dayMonthFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const whenFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const whenYearFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function when(iso: string): string {
  const d = new Date(iso);
  return (d.getFullYear() === new Date().getFullYear() ? whenFmt : whenYearFmt).format(d);
}

function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return 'только что';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.round(h / 24);
  return `${d} ${plural(d, 'день', 'дня', 'дней')} назад`;
}

function card(title: string | null, cls = ''): HTMLElement {
  const c = el('section', `ad-card ${cls}`.trim());
  if (title) c.append(el('h2', 'ad-h', title));
  return c;
}

// ---------------------------------------------------------------------------
// Шапка: вкладки и «Обновить»
// ---------------------------------------------------------------------------

function renderTabs(): void {
  tabsEl.hidden = false;
  const n = st.sup?.counts.new ?? st.stats?.now.support.new ?? 0;
  const mk = (id: Tab, label: string, badge?: number) => {
    const b = el('button', 'ad-tab');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(st.tab === id));
    b.append(label);
    if (badge) {
      const s = el('span', 'ad-badge', String(badge));
      s.title = `${badge} ${plural(badge, 'новое обращение', 'новых обращения', 'новых обращений')}`;
      b.append(s);
    }
    b.addEventListener('click', () => go(id));
    return b;
  };
  tabsEl.replaceChildren(mk('stats', 'Статистика'), mk('support', 'Поддержка', n));
}

function renderTools(): void {
  const r = el('button', 'ad-icon-btn');
  r.type = 'button';
  r.title = 'Обновить';
  r.setAttribute('aria-label', 'Обновить');
  r.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>';
  if (st.busy) r.classList.add('spin');
  r.addEventListener('click', () => void refresh(true));
  const at = el('span', 'ad-at', st.loadedAt ? `обновлено в ${timeFmt.format(st.loadedAt)}` : '');
  tools.replaceChildren(at, r);
}

function go(tab: Tab): void {
  if (st.tab === tab) return;
  st.tab = tab;
  history.replaceState(null, '', tab === 'support' ? '#support' : location.pathname);
  render();
  window.scrollTo({ top: 0 });
}

// ---------------------------------------------------------------------------
// Загрузка
// ---------------------------------------------------------------------------

async function loadStats(): Promise<void> {
  const { data, error } = await sb.rpc('admin_stats', { p_days: st.days });
  if (error) throw error;
  st.stats = data;
}

async function loadSupport(): Promise<void> {
  const { data, error } = await sb.rpc('admin_support', { p_status: st.filter === 'all' ? null : st.filter, p_limit: PAGE });
  if (error) throw error;
  st.sup = data;
  st.more = data.items.length >= PAGE;
}

async function refresh(manual = false): Promise<void> {
  if (st.busy) return;
  st.busy = true;
  page.classList.add('loading');
  renderTools();
  try {
    await Promise.all([loadStats(), loadSupport()]);
    st.loadedAt = Date.now();
    render();
    if (manual) toast('Обновлено');
  } catch (e) {
    if (!st.stats) fail(errText(e));
    else toast(errText(e));
  } finally {
    st.busy = false;
    page.classList.remove('loading');
    renderTools();
  }
}

/** Автообновление: только когда вкладка видна и человек не пишет заметку. */
function autoRefresh(): void {
  window.setInterval(() => {
    if (document.hidden) return;
    const a = document.activeElement;
    if (a instanceof HTMLTextAreaElement) return;
    void refresh();
  }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - st.loadedAt > REFRESH_MS) void refresh();
  });
}

// ---------------------------------------------------------------------------
// Пустые экраны
// ---------------------------------------------------------------------------

function screen(title: string, text: string, actions: HTMLElement[] = []): void {
  tabsEl.hidden = true;
  const box = el('div', 'ad-empty');
  box.append(el('h1', null, title), el('p', null, text));
  if (actions.length) {
    const row = el('div', 'ad-row');
    row.append(...actions);
    box.append(row);
  }
  page.replaceChildren(box);
}

function fail(text: string): void {
  screen('Не загрузилось', text, [btn('Попробовать ещё раз', () => void refresh(), 'ad-btn primary')]);
}

function signedOut(): void {
  const a = el('a', 'ad-btn primary', 'Открыть СКАМ');
  a.href = '/';
  screen('Войдите в СКАМ', 'Админка открывается в том же браузере, где вы вошли в СКАМ аккаунтом владельца. Войдите и вернитесь на эту страницу.', [a]);
}

function notOwner(): void {
  const a = el('a', 'ad-btn', 'Вернуться в СКАМ');
  a.href = '/';
  screen('Только для владельцев', 'Эта страница — для команды СКАМ. Ваш аккаунт не в списке владельцев.', [a]);
}

// ---------------------------------------------------------------------------
// Статистика
// ---------------------------------------------------------------------------

function tile(label: string, value: string, sub: string | null, o: { onClick?: () => void; warn?: boolean } = {}): HTMLElement {
  const t = o.onClick ? el('button', 'ad-tile link') : el('div', 'ad-tile');
  if (t instanceof HTMLButtonElement) { t.type = 'button'; t.addEventListener('click', o.onClick!); }
  if (o.warn) t.classList.add('warn');
  t.append(el('span', 'ad-tl', label), el('strong', 'ad-tv', value));
  if (sub) t.append(el('span', 'ad-ts', sub));
  return t;
}

function meter(label: string, part: number, whole: number, o: { goal?: number; text?: string; sub?: string } = {}): HTMLElement {
  const box = el('div', 'ad-meter');
  const p = whole > 0 ? Math.min(100, (part / whole) * 100) : 0;
  const head = el('div', 'ad-mh');
  head.append(el('span', 'ad-ml', label), el('strong', 'ad-mv', o.text ?? `${part} из ${whole}`));
  const track = el('div', 'ad-track');
  track.setAttribute('role', 'meter');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', String(whole || 1));
  track.setAttribute('aria-valuenow', String(part));
  track.setAttribute('aria-label', label);
  const fill = el('div', 'ad-fill');
  fill.style.width = `${p}%`;
  if (p >= 100) fill.classList.add('full');
  track.append(fill);
  if (o.goal != null && o.goal > 0 && o.goal < 100) {
    const g = el('span', 'ad-goal');
    g.style.left = `${o.goal}%`;
    g.title = `Цель — ${o.goal}%`;
    track.append(g);
  }
  box.append(head, track);
  if (o.sub) box.append(el('p', 'ad-ms', o.sub));
  return box;
}

function seg<T extends string | number>(items: { id: T; label: string }[], cur: T, on: (v: T) => void, label: string): HTMLElement {
  const g = el('div', 'ad-seg');
  g.setAttribute('role', 'radiogroup');
  g.setAttribute('aria-label', label);
  for (const it of items) {
    const b = el('button', null, it.label);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(it.id === cur));
    b.addEventListener('click', () => { if (it.id !== cur) on(it.id); });
    g.append(b);
  }
  return g;
}

function renderHeadline(n: AdminNow): HTMLElement {
  const grid = el('div', 'ad-kpis');
  const hero = el('div', 'ad-hero');
  hero.append(
    el('span', 'ad-tl', 'Людей в СКАМ'),
    el('strong', 'ad-hv', compact(n.users)),
    el('span', 'ad-ts', `${n.new_7d ? `+${n.new_7d}` : 'нет новых'} за 7 дней · +${n.new_30d} за 30`),
    el('span', 'ad-ts dim', `без ${n.test_accounts} ${plural(n.test_accounts, 'тестового аккаунта', 'тестовых аккаунтов', 'тестовых аккаунтов')}`),
  );
  const lonelyP = pct(n.lonely, n.users);
  grid.append(
    hero,
    tile('Заходили за 7 дней', String(n.seen_7d), `сегодня ${n.seen_1d} · за 30 дней ${n.seen_30d}`),
    tile('Писали за 7 дней', String(n.writers_7d), `сегодня ${n.writers_1d} · за 30 дней ${n.writers_30d}`),
    tile('Сообщений за 7 дней', compact(n.messages_7d), `сегодня ${n.messages_1d} · в ${n.chats_active_7d} ${plural(n.chats_active_7d, 'чате', 'чатах', 'чатах')}`),
    tile('Живые группы', String(n.groups_alive_7d), `где за неделю писали трое и больше · всего групп ${n.content.groups}`),
    tile('Не с кем общаться', `${lonelyP}%`, `${n.lonely} из ${n.users} — ни одного чата с другим человеком`, { warn: lonelyP > 100 - GOALS.partneredPct }),
    tile('Звонки за 7 дней', String(n.calls_7d), `отвечено ${n.calls_answered_7d} · ${n.call_minutes_7d} мин разговора`),
  );
  return grid;
}

function renderGoals(n: AdminNow): HTMLElement {
  const c = card(`Цели к ${GOALS.until}`, 'ad-goals');
  const partnered = n.users - n.lonely;
  const pp = pct(partnered, n.users);
  c.append(
    meter('Живые группы', n.groups_alive_7d, GOALS.groups, { sub: 'Группы, где за последние 7 дней писали трое и больше.' }),
    meter('Пишут за неделю', n.writers_7d, GOALS.writers, { sub: 'Люди, отправившие хоть одно сообщение за 7 дней.' }),
    meter('Есть с кем общаться', pp, 100, {
      text: `${pp}%`, goal: GOALS.partneredPct,
      sub: `Цель — ${GOALS.partneredPct}%: не больше четверти людей без собеседника. Сейчас ${partnered} из ${n.users}.`,
    }),
  );
  return c;
}

function renderChart(s: AdminStats): HTMLElement {
  const c = card(null, 'ad-chart');
  const m = METRICS.find((x) => x.id === st.metric)!;
  const head = el('div', 'ad-chart-head');
  head.append(el('h2', 'ad-h', 'По дням'));
  const filters = el('div', 'ad-filters');
  filters.append(
    seg(METRICS.map(({ id, label }) => ({ id, label })), st.metric, (v) => {
      st.metric = v; lsSet('skam:admin:metric', v); render();
    }, 'Что показать'),
    seg([{ id: 30, label: '30 дней' }, { id: 90, label: '90 дней' }], st.days, (v) => {
      st.days = v; lsSet('skam:admin:days', String(v)); void refresh();
    }, 'Период'),
  );
  head.append(filters);

  const pts: Point[] = s.daily.map((d) => ({ day: d.day, value: d[st.metric] as number | null }));
  const sum = pts.reduce((a, p) => a + (p.value ?? 0), 0);
  const known = pts.filter((p) => p.value != null).length;
  const sumLine = el('p', 'ad-sum');
  if (st.metric === 'seen') {
    const since = s.snapshots_since ? dayMonthFmt.format(new Date(`${s.snapshots_since}T00:00:00Z`)) : 'сегодня';
    sumLine.textContent = `Считаем с ${since}: дней с данными — ${known}. ${m.about}`;
  } else {
    const avg = known ? (sum / known) : 0;
    const avgText = avg >= 10 ? Math.round(avg).toString() : avg.toFixed(1).replace('.', ',');
    sumLine.textContent = st.metric === 'writers'
      ? `В среднем ${avgText} в день. ${m.about}`
      : `Всего ${sum} за ${s.days} ${plural(s.days, 'день', 'дня', 'дней')}, в среднем ${avgText} в день. ${m.about}`;
  }
  const host = el('div', 'ad-plot');
  c.append(head, sumLine, host);

  // Таблица — те же числа без наведения (и для экранного диктора).
  const det = el('details', 'ad-table-wrap');
  det.append(el('summary', null, 'Показать таблицей'));
  const tbl = el('table', 'ad-table');
  const thead = el('thead');
  const hr = el('tr');
  ['День', 'Писали', 'Сообщения', 'Новые', 'Звонки', 'Заходили'].forEach((h) => hr.append(el('th', null, h)));
  thead.append(hr);
  const tb = el('tbody');
  [...s.daily].reverse().forEach((d) => {
    const tr = el('tr');
    tr.append(el('td', null, dayShort(d.day)));
    [d.writers, d.messages, d.new_users, d.calls].forEach((v) => tr.append(el('td', 'num', String(v))));
    tr.append(el('td', 'num', d.seen == null ? '—' : String(d.seen)));
    tb.append(tr);
  });
  tbl.append(thead, tb);
  det.append(tbl);
  c.append(det);

  queueMicrotask(() => { unchart = columnChart(host, pts, { unit: m.unit, label: m.label }); });
  return c;
}

function renderNewbies(n: AdminNow): HTMLElement {
  const c = card('Новички');
  c.append(
    meter('Написали кому-то в первые сутки', n.activation.done, n.activation.total, {
      text: n.activation.total ? `${n.activation.done} из ${n.activation.total} · ${pct(n.activation.done, n.activation.total)}%` : 'нет новичков',
      sub: 'Зарегистрировались за последние 30 дней (кроме самых свежих, у кого сутки ещё не прошли).',
    }),
    meter('Вернулись через неделю', n.week_return.done, n.week_return.total, {
      text: n.week_return.total ? `${n.week_return.done} из ${n.week_return.total} · ${pct(n.week_return.done, n.week_return.total)}%` : 'пока не с кого считать',
      sub: 'Зарегистрировались 7–37 дней назад и заходили или писали спустя неделю после регистрации.',
    }),
  );
  return c;
}

function renderRatings(n: AdminNow): HTMLElement {
  const r = n.ratings;
  const c = card('Оценки');
  const head = el('p', 'ad-rate');
  if (r.count) {
    head.append(el('strong', null, (r.avg ?? 0).toFixed(1).replace('.', ',')), ` из 5 · ${r.count} ${plural(r.count, 'оценка', 'оценки', 'оценок')}`);
  } else {
    head.textContent = 'Оценок пока нет.';
  }
  c.append(head);
  const max = Math.max(1, ...r.dist);
  const list = el('div', 'ad-dist');
  for (let s = 5; s >= 1; s--) {
    const v = r.dist[s - 1] ?? 0;
    const rowEl = el('div', 'ad-dr');
    const bar = el('span', 'ad-db');
    const fill = el('span', 'ad-dbf');
    fill.style.width = `${(v / max) * 100}%`;
    bar.append(fill);
    rowEl.append(el('span', 'ad-ds', `${s} ★`), bar, el('span', 'ad-dv', String(v)));
    list.append(rowEl);
  }
  c.append(list);
  return c;
}

function renderChannels(s: AdminStats): HTMLElement {
  const c = card('Публичные каналы');
  c.append(el('p', 'ad-sub', 'Посты и комментарии — за последние 7 дней.'));
  if (!s.top_channels.length) {
    c.append(el('p', 'ad-muted', 'Публичных каналов пока нет.'));
    return c;
  }
  const tbl = el('table', 'ad-table');
  const hr = el('tr');
  [['Канал', ''], ['Подписчики', 'num'], ['Посты', 'num'], ['Комм.', 'num']].forEach(([h, cls]) => {
    const th = el('th', cls || null, h);
    if (h === 'Комм.') th.title = 'Комментарии';
    hr.append(th);
  });
  const thead = el('thead');
  thead.append(hr);
  const tb = el('tbody');
  for (const ch of s.top_channels) {
    const tr = el('tr');
    const name = el('td', 'ad-chn');
    const line = el('span', 'nm');
    line.append(ch.name || `@${ch.username}`);
    if (ch.verified) {
      const vf = el('span', 'ad-vf', '✓');
      vf.title = 'Официальная галочка';
      line.append(vf);
    }
    name.append(line, el('span', 'un', `@${ch.username}`));
    tr.append(name, el('td', 'num', String(ch.members)), el('td', 'num', String(ch.posts_7d)), el('td', 'num', String(ch.comments_7d)));
    tb.append(tr);
  }
  tbl.append(thead, tb);
  c.append(tbl);
  return c;
}

function renderContent(n: AdminNow): HTMLElement {
  const c = card('Что создают');
  const dl = el('dl', 'ad-dl');
  const add = (k: string, v: number) => { dl.append(el('dt', null, k), el('dd', null, String(v))); };
  add('Группы', n.content.groups);
  add('Каналы', n.content.channels);
  add('из них публичные', n.content.public_channels);
  add('Статьи', n.content.articles);
  add('Опросы за 30 дней', n.content.polls_30d);
  add('Истории за 7 дней', n.content.stories_7d);
  c.append(dl);
  return c;
}

function renderStats(): void {
  const s = st.stats!;
  const n = s.now;
  const wrap = el('div', 'ad-wrap');
  if (n.support.new) {
    const b = el('button', 'ad-banner');
    b.type = 'button';
    b.append(el('strong', null, `${n.support.new} ${plural(n.support.new, 'новое обращение', 'новых обращения', 'новых обращений')}`), ' в поддержку — открыть →');
    b.addEventListener('click', () => go('support'));
    wrap.append(b);
  }
  wrap.append(renderHeadline(n), renderGoals(n), renderChart(s));
  const two = el('div', 'ad-two');
  two.append(renderNewbies(n), renderRatings(n));
  const two2 = el('div', 'ad-two');
  two2.append(renderChannels(s), renderContent(n));
  wrap.append(two, two2);
  const foot = el('p', 'ad-foot');
  foot.textContent = `Тестовые аккаунты (@skam.test) не считаются. Дни — по московскому времени. «Заходили» копится снимками каждые 10 минут. Тексты сообщений сервер не читает — только количества. Данные на ${timeFmt.format(new Date(s.at))}.`;
  wrap.append(foot);
  page.replaceChildren(wrap);
}

// ---------------------------------------------------------------------------
// Поддержка
// ---------------------------------------------------------------------------

function replyHref(it: AdminSupportItem): string | null {
  if (!it.email) return null;
  const first = it.body.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const short = first.length > 60 ? `${first.slice(0, 59).trimEnd()}…` : first;
  // Та же тема, что у письма поддержки (supabase/functions/support/letter.ts) — ответ ляжет в ту же цепочку.
  const subject = `Re: СКАМ · ${TOPICS[it.topic] ?? 'Обращение'}: ${short} [#${it.no}]`;
  const quote = it.body.split('\n').map((l) => `> ${l}`).join('\n');
  const body = `Здравствуйте${it.profile_name || it.name ? `, ${(it.profile_name || it.name)!.split(' ')[0]}` : ''}!\n\n\n\n—\nКоманда СКАМ\n\n${when(it.created_at)} вы написали:\n${quote}`;
  return `mailto:${encodeURIComponent(it.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

async function setStatus(it: AdminSupportItem, status: SupportStatus, cardEl: HTMLElement): Promise<void> {
  const prev = it.status;
  if (prev === status) return;
  cardEl.classList.add('saving');
  const { data, error } = await sb.rpc('admin_support_set', { p_id: it.id, p_status: status });
  cardEl.classList.remove('saving');
  if (error) { toast(errText(error)); return; }
  it.status = data.status;
  it.handled_at = data.handled_at;
  it.handled_by_name = data.handled_by_name;
  if (st.sup) {
    st.sup.counts[prev] = Math.max(0, st.sup.counts[prev] - 1);
    st.sup.counts[status] += 1;
  }
  if (st.stats) {
    st.stats.now.support[prev] = Math.max(0, st.stats.now.support[prev] - 1);
    st.stats.now.support[status] += 1;
  }
  const label = STATUSES.find((s) => s.id === status)!.label;
  if (st.sup && st.filter !== 'all' && st.filter !== status) {
    st.sup.items = st.sup.items.filter((x) => x.id !== it.id);
    toast(`Обращение №${it.no} — «${label}»`);
  }
  renderTabs();
  renderSupport();
}

async function saveNote(it: AdminSupportItem, text: string, cardEl: HTMLElement): Promise<void> {
  cardEl.classList.add('saving');
  const { data, error } = await sb.rpc('admin_support_set', { p_id: it.id, p_note: text });
  cardEl.classList.remove('saving');
  if (error) { toast(errText(error)); return; }
  it.note = data.note;
  drafts.delete(it.id);
  toast(data.note ? 'Заметка сохранена' : 'Заметка удалена');
  renderSupport();
}

function supportCard(it: AdminSupportItem): HTMLElement {
  const c = el('article', `ad-req st-${it.status}`);
  c.dataset.id = it.id;

  const top = el('div', 'ad-req-top');
  top.append(
    el('span', `ad-topic t-${it.topic}`, TOPICS[it.topic] ?? it.topic),
    el('span', 'ad-no', `№${it.no}`),
  );
  const time = el('time', 'ad-when', when(it.created_at));
  time.dateTime = it.created_at;
  time.title = ago(it.created_at);
  top.append(time);
  c.append(top);

  const who = el('div', 'ad-who');
  who.append(el('strong', null, it.profile_name || it.name || 'Без имени'));
  const uname = it.profile_username || it.username;
  if (uname) who.append(el('span', 'ad-un', `@${uname}`));
  if (it.email) {
    const mail = el('span', 'ad-mail', it.email);
    who.append(mail);
  }
  if (it.user_total > 1) {
    who.append(el('span', 'ad-chip', `${it.user_total} ${plural(it.user_total, 'обращение', 'обращения', 'обращений')} от этого человека`));
  }
  c.append(who);

  c.append(el('p', 'ad-body', it.body));

  const meta = it.meta && Object.keys(it.meta).length ? it.meta : null;
  if (meta) {
    const d = el('details', 'ad-meta');
    d.append(el('summary', null, 'Об устройстве'));
    const dl = el('dl', 'ad-dl small');
    for (const k of Object.keys(META_KEYS)) {
      if (typeof meta[k] === 'string') dl.append(el('dt', null, META_KEYS[k]), el('dd', null, meta[k]));
    }
    d.append(dl);
    c.append(d);
  }

  const mailState = el('p', 'ad-mailstate');
  if (it.mailed_at) {
    mailState.textContent = `Письмо на ящик поддержки ушло ${when(it.mailed_at)}.`;
  } else if (it.last_error) {
    mailState.classList.add('bad');
    mailState.append(el('span', 'ad-warn-ic', '!'), `Письмо на ящик поддержки не ушло — это обращение есть только здесь. Ошибка: ${it.last_error}`);
  } else {
    mailState.classList.add('bad');
    mailState.append(el('span', 'ad-warn-ic', '!'), 'Письмо на ящик поддержки не отправлялось — это обращение есть только здесь.');
  }
  c.append(mailState);

  // Действия: статус, ответ, заметка
  const actions = el('div', 'ad-req-actions');
  actions.append(seg(STATUSES, it.status, (v) => void setStatus(it, v, c), 'Статус обращения'));
  const href = replyHref(it);
  if (href) {
    const a = el('a', 'ad-btn', 'Ответить на почту');
    a.href = href;
    actions.append(a);
  } else {
    actions.append(el('span', 'ad-muted small', 'Почты нет — ответить можно только в СКАМ'));
  }
  c.append(actions);

  if (it.handled_at && it.status !== 'new') {
    const lab = STATUSES.find((s) => s.id === it.status)!.label;
    c.append(el('p', 'ad-handled', `«${lab}» — ${it.handled_by_name ?? 'владелец'}, ${when(it.handled_at)}`));
  }

  const note = el('div', 'ad-note-box');
  const ta = el('textarea', 'ad-ta');
  const hasNote = Boolean(drafts.get(it.id) ?? it.note);
  if (!hasNote) {
    note.hidden = true;
    const add = btn('Заметка', () => { note.hidden = false; add.remove(); ta.focus(); }, 'ad-btn ghost');
    add.title = 'Заметка для команды — человек её не видит';
    actions.append(add);
  }
  ta.rows = 2;
  ta.maxLength = 2000;
  ta.placeholder = 'Заметка для команды — человек её не видит';
  ta.value = drafts.get(it.id) ?? it.note ?? '';
  ta.setAttribute('aria-label', `Заметка к обращению №${it.no}`);
  const save = btn('Сохранить заметку', () => void saveNote(it, ta.value, c), 'ad-btn small');
  const sync = () => {
    const dirty = ta.value.trim() !== (it.note ?? '').trim();
    save.hidden = !dirty;
    if (dirty) drafts.set(it.id, ta.value); else drafts.delete(it.id);
  };
  ta.addEventListener('input', sync);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !save.hidden) { e.preventDefault(); save.click(); }
  });
  note.append(ta, save);
  sync();
  c.append(note);
  return c;
}

async function loadMore(b: HTMLButtonElement): Promise<void> {
  if (!st.sup) return;
  const last = st.sup.items[st.sup.items.length - 1];
  b.disabled = true;
  const { data, error } = await sb.rpc('admin_support', {
    p_status: st.filter === 'all' ? null : st.filter, p_limit: PAGE, p_before: last?.created_at ?? null,
  });
  b.disabled = false;
  if (error) { toast(errText(error)); return; }
  st.sup.items.push(...data.items);
  st.sup.counts = data.counts;
  st.more = data.items.length >= PAGE;
  renderSupport();
}

function renderSupport(): void {
  const s = st.sup!;
  const wrap = el('div', 'ad-wrap narrow');
  const head = el('div', 'ad-sup-head');
  head.append(el('h1', 'ad-title', 'Обращения в поддержку'));
  const counts = s.counts;
  head.append(seg<Filter>([
    { id: 'new', label: `Новые · ${counts.new}` },
    { id: 'work', label: `В работе · ${counts.work}` },
    { id: 'done', label: `Готово · ${counts.done}` },
    { id: 'all', label: `Все · ${counts.all}` },
  ], st.filter, (v) => {
    st.filter = v; lsSet('skam:admin:filter', v);
    page.classList.add('loading');
    void loadSupport().then(() => renderSupport(), (e) => toast(errText(e))).finally(() => page.classList.remove('loading'));
  }, 'Какие обращения показать'));
  wrap.append(head);

  if (counts.unmailed) {
    const w = el('p', 'ad-alert');
    w.append(el('span', 'ad-warn-ic', '!'), `${counts.unmailed} ${plural(counts.unmailed, 'обращение', 'обращения', 'обращений')} не ${counts.unmailed === 1 ? 'дошло' : 'дошли'} до почты поддержки — их видно только здесь. Они помечены в карточке.`);
    wrap.append(w);
  }

  if (!s.items.length) {
    const empty = el('div', 'ad-empty small');
    const text = st.filter === 'new' ? 'Новых обращений нет.' : st.filter === 'work' ? 'В работе ничего нет.' : st.filter === 'done' ? 'Готовых пока нет.' : 'Обращений пока нет.';
    empty.append(el('p', null, text));
    wrap.append(empty);
  } else {
    const list = el('div', 'ad-list');
    s.items.forEach((it) => list.append(supportCard(it)));
    wrap.append(list);
    if (st.more) {
      const more = btn('Показать ещё', () => void loadMore(more), 'ad-btn wide');
      wrap.append(more);
    }
  }
  const foot = el('p', 'ad-foot');
  foot.textContent = 'Обращения приходят из «Мой профиль» → «Поддержка» и, как раньше, уходят письмом на skam.messenger@yandex.com. Статус и заметки видят только владельцы СКАМ. Храним до 3 лет (Политика конфиденциальности).';
  wrap.append(foot);
  // Перерисовка не должна сбрасывать прокрутку и фокус в заметке.
  const y = window.scrollY;
  const focused = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement.closest<HTMLElement>('.ad-req')?.dataset.id : null;
  page.replaceChildren(wrap);
  window.scrollTo({ top: y });
  if (focused) page.querySelector<HTMLTextAreaElement>(`.ad-req[data-id="${focused}"] textarea`)?.focus();
}

// ---------------------------------------------------------------------------

function render(): void {
  unchart?.();
  unchart = null;
  renderTabs();
  renderTools();
  if (!st.stats || !st.sup) return;
  if (st.tab === 'stats') renderStats();
  else renderSupport();
}

async function boot(): Promise<void> {
  if (!configured) { screen('Сервер не задан', 'Эта сборка собрана без адреса сервера СКАМ.'); return; }
  const { data } = await sb.auth.getSession();
  if (!data.session) { signedOut(); return; }
  const own = await sb.rpc('am_app_owner');
  if (own.error) { fail(errText(own.error)); return; }
  if (own.data !== true) { notOwner(); return; }
  window.addEventListener('hashchange', () => {
    const t: Tab = location.hash === '#support' ? 'support' : 'stats';
    if (t !== st.tab) { st.tab = t; render(); }
  });
  await refresh();
  autoRefresh();
}

void boot();
