// «Поддержка» и «Оценить СКАМ».
//
// Поддержка: обращение уходит в Edge Function `support`, она сохраняет его и отправляет письмо
// на ящик СКАМ (тот же, с которого приходят коды для входа); ответ придёт человеку на почту.
// Оценка: одна на человека, 1–5 звёзд, можно менять; видна средняя и распределение.

import { sb } from '../lib/supabase';
import { $, ICONS, button, closeDialog, dlgHead, el, errText, html, openDialog, plural, toast } from '../lib/dom';
import { getTheme } from '../lib/theme';
import { S } from './store';
import { realEmail } from '../lib/oauth';

// ---------------------------------------------------------------------------
// Поддержка
// ---------------------------------------------------------------------------

export type Topic = 'bug' | 'question' | 'idea' | 'other';

const TOPICS: [Topic, string, string][] = [
  ['bug', 'Ошибка', 'Что случилось? Что вы делали перед этим и что ожидали увидеть?'],
  ['question', 'Вопрос', 'Ваш вопрос о СКАМ'],
  ['idea', 'Идея', 'Что добавить или улучшить?'],
  ['other', 'Другое', 'Ваше сообщение'],
];
export const SUPPORT_MAX = 4000;
const SUPPORT_MIN = 5;

/** Черновик живёт, пока открыта вкладка: закрыли окно — текст не пропал. */
const draft = { topic: 'bug' as Topic, text: '', device: true };

type SupportResult = { ok: true; id: string; no: string; email: string | null; mailed: boolean };

/** Сведения об устройстве, которые человек может приложить к обращению (всё видно в окне). */
export function deviceInfo(): Record<string, string> {
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string; mobile?: boolean };
    connection?: { effectiveType?: string };
  };
  const theme = getTheme();
  const dark = theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  const info: Record<string, string> = {
    app: __SKAM_BUILD__,
    ua: navigator.userAgent.slice(0, 300),
    platform: [nav.userAgentData?.platform || navigator.platform, nav.userAgentData?.mobile ? 'телефон' : null].filter(Boolean).join(', '),
    lang: navigator.language,
    screen: `${screen.width}×${screen.height}, окно ${innerWidth}×${innerHeight}, ×${Math.round(devicePixelRatio * 100) / 100}`,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone ?? '',
    mode: matchMedia('(display-mode: standalone)').matches ? 'установленное приложение' : 'вкладка браузера',
    theme: `${dark ? 'тёмная' : 'светлая'}${theme === 'auto' ? ' (как в системе)' : ''}`,
    net: [navigator.onLine ? 'в сети' : 'нет сети', nav.connection?.effectiveType].filter(Boolean).join(', '),
  };
  for (const k of Object.keys(info)) if (!info[k]) delete info[k];
  return info;
}

const INFO_LABELS: Record<string, string> = {
  app: 'Версия СКАМ', ua: 'Браузер', platform: 'Система', lang: 'Язык', screen: 'Экран',
  tz: 'Часовой пояс', mode: 'Запуск', theme: 'Тема', net: 'Сеть',
};

async function sendSupport(topic: Topic, text: string, meta: Record<string, string> | null): Promise<SupportResult> {
  const { data, error } = await sb.functions.invoke<SupportResult>('support', { body: { topic, text, meta } });
  if (!error && data?.ok) return data;
  // Ошибка из функции приходит JSON-ом {error}; достаём понятный текст.
  let message = '';
  const ctx = (error as { context?: unknown } | null)?.context;
  if (ctx instanceof Response) {
    try { message = ((await ctx.json()) as { error?: string }).error ?? ''; } catch { /* не JSON */ }
    if (!message && ctx.status === 401) message = 'Сессия устарела — войдите заново.';
  }
  if (!message && error?.name === 'FunctionsFetchError') message = 'Нет связи с сервером.';
  throw new Error(message || 'Не получилось отправить. Попробуйте ещё раз.');
}

export function openSupport(topic?: Topic): void {
  if (topic) draft.topic = topic;
  const dlg = $<HTMLDialogElement>('supportDlg');
  renderSupportForm(dlg);
  openDialog(dlg);
  requestAnimationFrame(() => (dlg.querySelector('textarea') as HTMLTextAreaElement | null)?.focus());
}

function renderSupportForm(dlg: HTMLDialogElement): void {
  const email = realEmail(S.user);
  const stack = el('div', 'stack support');

  const lead = el('p', 'lead-sm');
  lead.append('Нашли ошибку, есть вопрос или идея? Напишите нам');
  if (email) lead.append(' — ответ придёт на ', el('b', null, email), '.');
  // Вход через VK ID без почты: ответить письмом некуда, но обращение мы прочитаем.
  else lead.append(' — мы прочитаем каждое обращение.');

  // Тема
  const topicField = el('div', 'field');
  const topicLbl = el('span', 'fld', 'Тема');
  topicLbl.id = 'supTopicLbl';
  const seg = el('div', 'seg four');
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-labelledby', 'supTopicLbl');
  const segBtns = TOPICS.map(([t, label]) => {
    const b = button(null, label, () => { draft.topic = t; syncTopic(); area.focus(); });
    b.setAttribute('role', 'radio');
    b.dataset.topic = t;
    return b;
  });
  seg.append(...segBtns);
  seg.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const i = TOPICS.findIndex(([t]) => t === draft.topic);
    const d = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    draft.topic = TOPICS[(i + d + TOPICS.length) % TOPICS.length][0];
    syncTopic();
    segBtns.find((b) => b.dataset.topic === draft.topic)?.focus();
  });
  topicField.append(topicLbl, seg);

  // Текст
  const textField = el('div', 'field');
  const area = el('textarea', 'txt support-text');
  area.id = 'supText';
  area.rows = 6;
  area.maxLength = SUPPORT_MAX;
  area.value = draft.text;
  const textLbl = el('label', 'fld', 'Сообщение');
  textLbl.htmlFor = 'supText';
  const count = el('span', 'count');
  count.setAttribute('aria-live', 'polite');
  textField.append(textLbl, area, count);

  // Сведения об устройстве
  const info = deviceInfo();
  const devRow = el('label', 'check-row');
  const dev = el('input');
  dev.type = 'checkbox';
  dev.checked = draft.device;
  dev.addEventListener('change', () => { draft.device = dev.checked; });
  devRow.append(dev, el('span', null, 'Приложить сведения об устройстве'));
  const details = el('details', 'dev-info');
  const summary = el('summary', null, 'Что будет приложено');
  const dl = el('dl');
  for (const [k, v] of Object.entries(info)) dl.append(el('dt', null, INFO_LABELS[k] ?? k), el('dd', null, v));
  details.append(summary, dl);
  const devField = el('div', 'field dev-field');
  devField.append(devRow, details);

  const err = el('p', 'err');
  err.setAttribute('role', 'alert');
  const actions = el('div', 'dlg-actions');
  const cancel = button('btn ghost', 'Отмена', () => closeDialog(dlg));
  const send = button('btn primary', 'Отправить', () => void submit());
  actions.append(cancel, send);

  function syncTopic(): void {
    for (const b of segBtns) {
      const on = b.dataset.topic === draft.topic;
      b.setAttribute('aria-checked', String(on));
      b.setAttribute('aria-pressed', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    area.placeholder = TOPICS.find(([t]) => t === draft.topic)?.[2] ?? '';
  }
  function syncText(): void {
    draft.text = area.value;
    const n = area.value.length;
    count.textContent = n > SUPPORT_MAX - 500 ? `${n} / ${SUPPORT_MAX}` : '';
    send.disabled = area.value.trim().length < SUPPORT_MIN;
    if (err.textContent && !send.disabled) err.textContent = '';
  }
  area.addEventListener('input', syncText);
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); if (!send.disabled) void submit(); }
  });

  let busy = false;
  async function submit(): Promise<void> {
    if (busy) return;
    const text = area.value.trim();
    if (text.length < SUPPORT_MIN) { err.textContent = 'Опишите подробнее — хотя бы пару слов.'; area.focus(); return; }
    busy = true;
    send.disabled = true;
    area.readOnly = true;
    send.textContent = 'Отправляем…';
    try {
      const res = await sendSupport(draft.topic, text, dev.checked ? info : null);
      draft.text = '';
      renderSupportDone(dlg, res);
    } catch (e) {
      err.textContent = errText(e, 'Не получилось отправить. Попробуйте ещё раз.');
      send.textContent = 'Отправить';
      send.disabled = false;
      area.readOnly = false;
    } finally {
      busy = false;
    }
  }

  syncTopic();
  syncText();
  stack.append(lead, topicField, textField, devField, err);
  dlg.replaceChildren(dlgHead('Поддержка', dlg), stack, actions);
}

function renderSupportDone(dlg: HTMLDialogElement, res: SupportResult): void {
  const box = el('div', 'done-box');
  const ic = el('span', 'done-ic');
  ic.append(html(ICONS.done));
  const h = el('h3', null, 'Обращение отправлено');
  const no = el('p', 'done-no', `№ ${res.no}`);
  const p = el('p', 'hint');
  if (res.email) p.append('Ответ придёт на ', el('b', null, res.email), '. Если захотите что-то добавить — просто напишите ещё раз.');
  else p.textContent = 'Мы прочитаем его и учтём. У аккаунта нет почты, поэтому ответа письмом не будет.';
  box.append(ic, h, no, p);
  const actions = el('div', 'dlg-actions');
  const ok = button('btn primary', 'Готово', () => closeDialog(dlg));
  actions.append(ok);
  dlg.replaceChildren(dlgHead('Поддержка', dlg), box, actions);
  ok.focus();
}

// ---------------------------------------------------------------------------
// Оценка
// ---------------------------------------------------------------------------

export type AppRating = { avg: number; count: number; dist: number[]; mine: number | null };

const STAR_WORDS = ['', 'Ужасно', 'Плохо', 'Нормально', 'Хорошо', 'Отлично!'];
const fmtAvg = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

let rating: AppRating | null = null;
let ratingSeq = 0;

function normRating(raw: unknown): AppRating {
  const r = (raw ?? {}) as Partial<AppRating>;
  const dist = Array.isArray(r.dist) ? r.dist.map((n) => Number(n) || 0) : [0, 0, 0, 0, 0];
  return { avg: Number(r.avg) || 0, count: Number(r.count) || 0, dist, mine: r.mine ? Number(r.mine) : null };
}

export async function loadRating(): Promise<AppRating> {
  const { data, error } = await sb.rpc('app_rating');
  if (error) throw error;
  rating = normRating(data);
  return rating;
}

async function rateApp(stars: number): Promise<AppRating> {
  const { data, error } = await sb.rpc('rate_app', { p_stars: stars });
  if (error) throw error;
  rating = normRating(data);
  return rating;
}

/** Строка из пяти звёзд с частичной заливкой (для средней оценки). */
function starsView(value: number, cls = ''): HTMLElement {
  const wrap = el('span', `stars-view ${cls}`);
  wrap.setAttribute('aria-hidden', 'true');
  const bg = el('span', 'sv-bg');
  const fg = el('span', 'sv-fg');
  for (let i = 0; i < 5; i++) { bg.append(html(ICONS.starFill)); fg.append(html(ICONS.starFill)); }
  fg.style.width = `${Math.max(0, Math.min(5, value)) * 20}%`;
  wrap.append(bg, fg);
  return wrap;
}

export function openRate(): void {
  const dlg = $<HTMLDialogElement>('rateDlg');
  renderRate(dlg);
  openDialog(dlg);
  const my = ++ratingSeq;
  loadRating()
    .then(() => { if (my === ratingSeq && dlg.open) renderRate(dlg); })
    .catch((e) => { if (my === ratingSeq && dlg.open) renderRate(dlg, errText(e, 'Не получилось загрузить оценки.')); });
}

function renderRate(dlg: HTMLDialogElement, loadErr?: string): void {
  const r = rating;
  const stack = el('div', 'stack rate');

  // Сводка
  const sum = el('div', 'rate-sum');
  if (loadErr && !r) {
    const p = el('p', 'err', loadErr);
    sum.append(p, button('btn ghost small', 'Повторить', () => openRate()));
  } else if (!r) {
    sum.classList.add('loading');
    sum.append(el('p', 'hint', 'Загружаем оценки…'));
  } else {
    const big = el('div', 'rate-big');
    const num = el('span', r.count ? 'rate-num' : 'rate-num none', r.count ? fmtAvg.format(r.avg) : '—');
    big.append(num, starsView(r.avg), el('span', 'rate-count', r.count ? plural(r.count, 'оценка', 'оценки', 'оценок') : 'оценок пока нет'));
    big.setAttribute('aria-label', r.count
      ? `Средняя оценка СКАМ ${fmtAvg.format(r.avg)} из 5, ${plural(r.count, 'оценка', 'оценки', 'оценок')}`
      : 'Оценок пока нет');
    big.setAttribute('role', 'img');
    const bars = el('div', 'rate-bars');
    bars.setAttribute('aria-hidden', 'true');
    const max = Math.max(1, ...r.dist);
    for (let s = 5; s >= 1; s--) {
      const n = r.dist[s - 1] ?? 0;
      const row = el('div', 'rb-row');
      const track = el('span', 'rb-track');
      const fill = el('span', 'rb-fill');
      fill.style.width = `${(n / max) * 100}%`;
      track.append(fill);
      row.append(el('span', 'rb-lbl', String(s)), track, el('span', 'rb-n', String(n)));
      bars.append(row);
    }
    sum.append(big, bars);
  }

  // Моя оценка
  const mineField = el('div', 'field rate-mine');
  const lbl = el('span', 'fld', 'Ваша оценка');
  lbl.id = 'rateMineLbl';
  const group = el('div', 'star-input');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-labelledby', 'rateMineLbl');
  const word = el('p', 'rate-word');
  word.setAttribute('aria-live', 'polite');
  const mine = r?.mine ?? 0;
  const btns: HTMLButtonElement[] = [];
  const paint = (n: number) => btns.forEach((b, i) => b.classList.toggle('on', i < n));
  const say = (n: number) => { word.textContent = n ? STAR_WORDS[n] : 'Нажмите на звезду'; };
  for (let s = 1; s <= 5; s++) {
    const b = button('star-btn', null, () => void pick(s));
    b.append(html(ICONS.starFill));
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(s === mine));
    b.setAttribute('aria-label', `${plural(s, 'звезда', 'звезды', 'звёзд')} — ${STAR_WORDS[s].replace('!', '')}`);
    b.tabIndex = s === (mine || 1) ? 0 : -1;
    b.disabled = !r;
    b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { paint(s); say(s); } });
    b.addEventListener('focus', () => { if (b.matches(':focus-visible')) { paint(s); say(s); } });
    btns.push(b);
  }
  group.addEventListener('pointerleave', () => { paint(rating?.mine ?? 0); say(rating?.mine ?? 0); });
  group.addEventListener('focusout', (e) => {
    if (!group.contains(e.relatedTarget as Node | null)) { paint(rating?.mine ?? 0); say(rating?.mine ?? 0); }
  });
  group.addEventListener('keydown', (e) => {
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    let j = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') j = Math.min(4, i + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') j = Math.max(0, i - 1);
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = 4;
    else if (/^[1-5]$/.test(e.key)) { e.preventDefault(); void pick(Number(e.key)); return; }
    if (j < 0) return;
    e.preventDefault();
    btns[j].focus();
  });
  group.append(...btns);
  paint(mine);
  say(mine);
  mineField.append(lbl, group, word);

  const note = el('p', 'hint rate-note');
  if (r?.mine) note.textContent = 'Оценку можно изменить в любой момент — просто нажмите на другую звезду.';
  const err = el('p', 'err');
  err.setAttribute('role', 'alert');

  // Плохая оценка — предложим рассказать, что не так.
  const tell = el('div', 'rate-tell');
  if (r?.mine && r.mine <= 3) {
    tell.append(
      el('span', null, 'Расскажите, что не так, — мы постараемся исправить.'),
      button('btn ghost small', 'Написать в поддержку', () => { closeDialog(dlg); openSupport(r.mine! <= 2 ? 'bug' : 'idea'); }),
    );
  }

  let busy = false;
  async function pick(stars: number): Promise<void> {
    if (busy || !rating) return;
    const first = !rating.mine;
    if (rating.mine === stars) { toast('Эта оценка уже стоит'); return; }
    busy = true;
    paint(stars);
    say(stars);
    btns.forEach((b) => { b.disabled = true; });
    try {
      await rateApp(stars);
      toast(first ? 'Спасибо за оценку!' : 'Оценка изменена');
      renderRate(dlg);
      (dlg.querySelectorAll<HTMLButtonElement>('.star-btn')[stars - 1])?.focus();
    } catch (e) {
      err.textContent = errText(e, 'Не получилось сохранить оценку.');
      btns.forEach((b) => { b.disabled = false; });
      paint(rating?.mine ?? 0);
      say(rating?.mine ?? 0);
    } finally {
      busy = false;
    }
  }

  stack.append(sum, el('div', 'hr'), mineField, note, tell, err);
  dlg.replaceChildren(dlgHead('Оценить СКАМ', dlg), stack);
}

/** Для кнопки в профиле: «Оценить СКАМ · 4,7 ★». */
export function ratingShort(): string | null {
  return rating?.count ? fmtAvg.format(rating.avg) : null;
}

/** Сброс при выходе из аккаунта. */
export function resetFeedback(): void {
  rating = null;
  ratingSeq++;
  draft.topic = 'bug';
  draft.text = '';
  draft.device = true;
}
