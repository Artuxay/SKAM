// Опросы в чатах (0.4.0), как в Telegram: вопрос и 2–12 вариантов; анонимный или открытый, один или несколько
// ответов, викторина с правильным ответом и пояснением. Голоса считает сервер (только номера вариантов),
// а в личных чатах и группах вопрос и варианты — внутри шифротекста сообщения.
import { $, ICONS, button, closeDialog, el, errText, html, openDialog, plural, toast } from '../lib/dom';
import type { MyChat, PollState } from '../lib/database.types';
import { grp, grpLabel, grpNote, sheetHead, toggleRow } from './sheet';
import {
  type Msg, type PollSpec, POLL_MAX_OPTIONS, POLL_OPT_MAX, POLL_Q_MAX, POLL_SOLUTION_MAX, S, closePoll, pollSolution,
  pollVoters, refreshPollSoon, sendPoll, votePoll,
} from './store';

export type PollEnv = {
  /** Аватар человека (маленький кружок). */
  avatar: (uid: string, cls: string) => HTMLElement;
  /** Как человек подписан (ник или имя). */
  name: (uid: string) => string;
  openPerson: (uid: string) => void;
};
let env: PollEnv;
export function mountPolls(e: PollEnv): void {
  env = e;
}

/** Выбранные, но ещё не отправленные варианты (опрос с несколькими ответами). */
const picked = new Map<string, Set<number>>();
/** Опросы, по которым сейчас уходит голос. */
const voting = new Set<string>();
/** Опросы, состояние которых уже запросили сами (если оно не пришло вместе с лентой). */
const asked = new Set<string>();

function dlg(): HTMLDialogElement {
  return $<HTMLDialogElement>('pollDlg');
}

// ---------------------------------------------------------------------------
// Опрос в ленте
// ---------------------------------------------------------------------------

/** Проценты как в Telegram: целые, в сумме ровно 100 (метод наибольшего остатка). */
function percents(counts: number[], total: number): number[] {
  if (!total) return counts.map(() => 0);
  const raw = counts.map((c) => (c * 100) / total);
  const out = raw.map(Math.floor);
  const sum = counts.reduce((a, b) => a + b, 0);
  // Несколько ответов: сумма может быть больше 100 — тогда просто округляем.
  if (sum !== total) return raw.map(Math.round);
  let left = 100 - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) { if (left <= 0) break; if (counts[i]) { out[i]++; left--; } }
  return out;
}

function kindLabel(st: PollState | undefined, closed: boolean): string {
  if (closed) return 'Опрос завершён';
  if (!st) return 'Опрос';
  const parts = [st.quiz ? (st.anonymous ? 'Анонимная викторина' : 'Викторина') : st.anonymous ? 'Анонимный опрос' : 'Открытый опрос'];
  if (st.multiple) parts.push('несколько ответов');
  return parts.join(' · ');
}

async function doVote(m: Msg, options: number[]): Promise<void> {
  if (voting.has(m.id)) return;
  voting.add(m.id);
  try {
    await votePoll(m.id, options);
    picked.delete(m.id);
    const st = S.polls.get(m.id);
    if (st?.quiz && st.correct !== null && options.length) {
      const right = options[0] === st.correct;
      const sol = await pollSolution(m, st);
      toast(`${right ? 'Верно! 🎉' : 'Мимо 🙈'}${sol ? ` ${sol}` : ''}`);
    }
  } catch (e) {
    toast(errText(e, 'Не получилось проголосовать.'));
  } finally {
    voting.delete(m.id);
  }
}

/** Опрос внутри пузыря сообщения. */
export function pollEl(m: Msg, chat: MyChat): HTMLElement {
  const box = el('div', 'poll');
  const st = S.polls.get(m.id);
  const poll = m.poll;
  const options = poll?.o.length ? poll.o : st?.options ?? [];
  box.append(el('div', 'poll-q', poll?.q ?? m.body));
  const closed = !!st?.closed;
  const meta = el('div', 'poll-kind', kindLabel(st, closed));
  if (st && !st.anonymous && st.recent?.length) {
    const faces = el('span', 'poll-faces');
    st.recent.slice(0, 3).forEach((uid) => faces.append(env.avatar(uid, 'poll-face')));
    meta.append(faces);
  }
  box.append(meta);
  if (!st || !options.length) {
    // Состояние не пришло с лентой (например, опрос расшифровался позже) — спросим один раз сами.
    if (!m.pending && !m.failed && !asked.has(m.id)) { asked.add(m.id); refreshPollSoon(m.id); }
    box.append(el('p', 'poll-wait', m.pending ? 'Отправляем опрос…' : 'Загружаем опрос…'));
    return box;
  }
  const voted = st.mine.length > 0;
  const showResults = voted || closed || !st.can_vote;
  const list = el('div', `poll-opts${showResults ? ' results' : ''}`);
  list.setAttribute('role', showResults ? 'list' : st.multiple ? 'group' : 'radiogroup');
  const pct = percents(st.counts, st.voters);
  const busy = voting.has(m.id) || !!m.pending;
  const sel = picked.get(m.id) ?? new Set<number>();
  options.forEach((text, i) => {
    if (showResults) {
      const mine = st.mine.includes(i);
      const correct = st.quiz && st.correct === i;
      const wrong = st.quiz && mine && st.correct !== null && st.correct !== i;
      const row = el('div', `poll-res${mine ? ' mine' : ''}${correct ? ' correct' : ''}${wrong ? ' wrong' : ''}`);
      row.setAttribute('role', 'listitem');
      const top = el('div', 'poll-res-top');
      top.append(el('span', 'poll-pct', `${pct[i]}%`), el('span', 'poll-text', text));
      if (mine || correct) top.append(el('span', 'poll-mark', wrong ? '✕' : '✓'));
      const bar = el('div', 'poll-bar');
      const fill = el('span');
      fill.style.width = `${Math.max(st.counts[i] ? 2 : 0, Math.min(100, st.voters ? (st.counts[i] * 100) / st.voters : 0))}%`;
      bar.append(fill);
      row.append(top, bar);
      row.title = plural(st.counts[i] ?? 0, 'голос', 'голоса', 'голосов');
      list.append(row);
      return;
    }
    const on = sel.has(i);
    const b = button(`poll-opt${on ? ' on' : ''}`, null, (ev) => {
      ev.stopPropagation();
      if (busy) return;
      if (!st.multiple) { void doVote(m, [i]); return; }
      const next = new Set(sel);
      if (next.has(i)) next.delete(i); else next.add(i);
      picked.set(m.id, next);
      box.replaceWith(pollEl(m, chat));
    });
    b.setAttribute('role', st.multiple ? 'checkbox' : 'radio');
    b.setAttribute('aria-checked', String(on));
    b.disabled = busy;
    b.append(el('span', `poll-dot${st.multiple ? ' sq' : ''}`), el('span', 'poll-text', text));
    list.append(b);
  });
  box.append(list);

  const foot = el('div', 'poll-foot');
  foot.append(el('span', 'poll-count', st.voters ? plural(st.voters, 'голос', 'голоса', 'голосов') : 'Пока никто не голосовал'));
  const acts = el('span', 'poll-acts');
  if (!showResults && st.multiple) {
    const go = button('poll-btn primary', 'Голосовать', (ev) => { ev.stopPropagation(); void doVote(m, [...sel].sort((a, b) => a - b)); });
    go.disabled = busy || !sel.size;
    acts.append(go);
  }
  if (voted && !closed && !st.quiz && st.can_vote) {
    acts.append(button('poll-btn', 'Отменить голос', (ev) => { ev.stopPropagation(); void doVote(m, []); }));
  }
  if (st.quiz && st.solution && (voted || closed)) {
    acts.append(button('poll-btn', '💡 Пояснение', (ev) => {
      ev.stopPropagation();
      void pollSolution(m, st).then((t) => toast(t || 'Пояснение не расшифровалось — ключ ещё не пришёл.'));
    }));
  }
  if (!st.anonymous && st.voters && (voted || closed) && !chat.preview) {
    acts.append(button('poll-btn', 'Кто голосовал', (ev) => { ev.stopPropagation(); void openPollVoters(m); }));
  }
  if (acts.childElementCount) foot.append(acts);
  box.append(foot);
  return box;
}

/** Строка опроса для списка чатов, цитат и уведомлений. */
export function pollLine(q: string): string {
  return `📊 ${q || 'Опрос'}`;
}

// ---------------------------------------------------------------------------
// Кто голосовал (открытый опрос)
// ---------------------------------------------------------------------------

async function openPollVoters(m: Msg): Promise<void> {
  const st = S.polls.get(m.id);
  if (!st) return;
  const d = dlg();
  d.className = 'sheet poll-dlg';
  const head = sheetHead(d, 'Кто голосовал');
  const body = el('div', 'sh-body');
  body.append(el('p', 'hint', 'Загружаем…'));
  d.replaceChildren(head, body);
  openDialog(d);
  try {
    const votes = await pollVoters(m.id);
    const options = m.poll?.o.length ? m.poll.o : st.options ?? [];
    const groups: HTMLElement[] = [];
    options.forEach((text, i) => {
      const who = votes.filter((v) => v.option === i);
      if (!who.length) return;
      const rows = who.map((v) => {
        const r = button('lr', null, () => { closeDialog(d); env.openPerson(v.user_id); });
        r.append(env.avatar(v.user_id, 'lr-av'));
        const t = el('span', 'lr-t');
        t.append(el('span', 'lr-l', env.name(v.user_id)));
        r.append(t);
        return r;
      });
      groups.push(grpLabel(`${text} — ${plural(who.length, 'голос', 'голоса', 'голосов')}`), grp(...rows));
    });
    body.replaceChildren(...(groups.length ? groups : [el('p', 'hint', 'Пока никто не голосовал.')]));
  } catch (e) {
    body.replaceChildren(el('p', 'err', errText(e, 'Не получилось загрузить голоса.')));
  }
}

/** Завершить опрос (пункт меню сообщения). */
export async function stopPoll(m: Msg): Promise<void> {
  try {
    await closePoll(m.id);
    toast('Опрос завершён');
  } catch (e) {
    toast(errText(e, 'Не получилось завершить опрос.'));
  }
}

// ---------------------------------------------------------------------------
// Новый опрос
// ---------------------------------------------------------------------------

export function openPollCreator(chat: MyChat): void {
  const d = dlg();
  d.className = 'sheet poll-dlg poll-new';
  const channel = chat.kind === 'channel';
  const st = {
    q: '', o: ['', ''], anonymous: true, multiple: false, quiz: false, correct: null as number | null, solution: '',
  };
  const head = sheetHead(d, 'Новый опрос');
  const body = el('div', 'sh-body');
  const qBox = el('textarea', 'txt poll-q-in');
  qBox.rows = 2;
  qBox.maxLength = POLL_Q_MAX;
  qBox.placeholder = 'Задайте вопрос';
  qBox.setAttribute('aria-label', 'Вопрос');
  const qCount = el('span', 'poll-left');
  const optsBox = el('div', 'poll-in-list');
  const settings = el('div');
  const solBox = el('textarea', 'txt poll-sol-in');
  solBox.rows = 2;
  solBox.maxLength = POLL_SOLUTION_MAX;
  solBox.placeholder = 'Пояснение после ответа (необязательно)';
  solBox.setAttribute('aria-label', 'Пояснение к правильному ответу');
  const solWrap = el('div', 'poll-sol');
  solWrap.append(grpLabel('Пояснение'), solBox);
  const err = el('p', 'err');
  const create = button('btn primary poll-create', 'Создать опрос', () => void submit());

  const clean = (v: string) => v.replace(/\s+/g, ' ').trim();
  const filled = () => st.o.map(clean).filter(Boolean);
  const problem = (): string | null => {
    if (!clean(st.q)) return 'Задайте вопрос';
    const o = filled();
    if (o.length < 2) return 'Нужно хотя бы два варианта ответа';
    if (new Set(o.map((x) => x.toLowerCase())).size !== o.length) return 'Варианты не должны повторяться';
    if (st.quiz && (st.correct === null || !clean(st.o[st.correct] ?? ''))) return 'Отметьте правильный ответ — кружок слева от варианта';
    return null;
  };
  const refresh = () => {
    qCount.textContent = String(POLL_Q_MAX - st.q.length);
    create.disabled = !!problem();
    err.textContent = '';
  };

  const renderOpts = () => {
    // Пустое поле в конце — для следующего варианта (пока их меньше 12).
    while (st.o.length < POLL_MAX_OPTIONS && clean(st.o[st.o.length - 1] ?? 'x')) st.o.push('');
    const focused = document.activeElement instanceof HTMLInputElement && optsBox.contains(document.activeElement)
      ? Number(document.activeElement.dataset.i) : -1;
    optsBox.replaceChildren(...st.o.map((v, i) => {
      const row = el('div', `poll-in${st.quiz && st.correct === i ? ' correct' : ''}`);
      if (st.quiz) {
        const mark = button('poll-in-mark', null, () => { st.correct = i; renderOpts(); refresh(); });
        mark.setAttribute('role', 'radio');
        mark.setAttribute('aria-checked', String(st.correct === i));
        mark.setAttribute('aria-label', `Правильный ответ: вариант ${i + 1}`);
        row.append(mark);
      }
      const inp = el('input', 'txt');
      inp.value = v;
      inp.maxLength = POLL_OPT_MAX;
      inp.placeholder = i < 2 ? `Вариант ${i + 1}` : 'Ещё вариант';
      inp.dataset.i = String(i);
      inp.setAttribute('aria-label', `Вариант ${i + 1}`);
      inp.addEventListener('input', () => {
        st.o[i] = inp.value;
        const grew = i === st.o.length - 1 && clean(inp.value) && st.o.length < POLL_MAX_OPTIONS;
        if (grew) renderOpts();
        refresh();
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const next = optsBox.querySelector<HTMLInputElement>(`input[data-i="${i + 1}"]`);
        if (next) next.focus(); else if (!create.disabled) void submit();
      });
      row.append(inp);
      if (st.o.length > 2 && (v || i < st.o.length - 1)) {
        const x = button('poll-in-x', null, () => {
          st.o.splice(i, 1);
          if (st.correct === i) st.correct = null;
          else if (st.correct !== null && st.correct > i) st.correct--;
          if (st.o.length < 2) st.o.push('');
          renderOpts();
          refresh();
        });
        x.append(html(ICONS.close));
        x.setAttribute('aria-label', `Убрать вариант ${i + 1}`);
        row.append(x);
      }
      return row;
    }));
    if (focused >= 0) optsBox.querySelector<HTMLInputElement>(`input[data-i="${focused}"]`)?.focus();
  };

  const renderSettings = () => {
    settings.replaceChildren(
      grp(
        toggleRow('lock', 'Анонимное голосование', channel ? 'В каналах опросы всегда анонимные' : 'Видно только, сколько голосов, но не кто',
          channel || st.anonymous, (v) => { st.anonymous = v; renderSettings(); }, channel),
        toggleRow('check', 'Несколько ответов', st.quiz ? 'В викторине ответ один' : 'Можно отметить больше одного варианта',
          st.multiple && !st.quiz, (v) => { st.multiple = v; renderSettings(); }, st.quiz),
        toggleRow('star', 'Викторина', 'Один правильный ответ — его видно после голоса', st.quiz, (v) => {
          st.quiz = v;
          if (v) st.multiple = false;
          renderSettings();
          renderOpts();
          refresh();
        }),
      ),
    );
    solWrap.hidden = !st.quiz;
  };

  const submit = async () => {
    const p = problem();
    if (p) { err.textContent = p; return; }
    const o = st.o.map(clean);
    // Пустые поля выкидываем, номер правильного ответа пересчитываем.
    const idx = o.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
    const spec: PollSpec = {
      q: clean(st.q), o: idx.map((i) => o[i]), multiple: st.multiple && !st.quiz, anonymous: channel || st.anonymous,
      quiz: st.quiz, correct: st.quiz && st.correct !== null ? idx.indexOf(st.correct) : null, solution: st.quiz ? solBox.value.trim() : '',
    };
    create.disabled = true;
    closeDialog(d);
    try {
      await sendPoll(chat.id, spec);
    } catch (e) {
      toast(errText(e, 'Опрос не отправился.'));
    }
  };

  qBox.addEventListener('input', () => { st.q = qBox.value; refresh(); });
  qBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); optsBox.querySelector<HTMLInputElement>('input')?.focus(); }
  });
  const qWrap = el('div', 'poll-q-wrap');
  qWrap.append(qBox, qCount);
  body.append(
    grpLabel('Вопрос'), qWrap,
    grpLabel('Варианты ответа'), optsBox,
    grpNote(`До ${POLL_MAX_OPTIONS} вариантов. ${chat.kind === 'channel' || chat.kind === 'bot' ? '' : 'Вопрос и варианты зашифрованы, как и всё в этом чате: сервер знает только номера вариантов, за которые голосуют.'}`),
    settings, solWrap, err, create,
  );
  d.replaceChildren(head, body);
  renderOpts();
  renderSettings();
  refresh();
  openDialog(d);
  qBox.focus();
}
