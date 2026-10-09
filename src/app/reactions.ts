// Реакции на сообщения: обычные пять, свои эмодзи и супер-реакции.
//
// • От одного человека на одно сообщение — не больше трёх реакций (проверяет и сервер).
// • Своё эмодзи — 'c:<набор>/<эмодзи>'; картинку видят все, набор можно открыть правой кнопкой (долгим нажатием) по реакции.
// • Супер-реакция — та же реакция, выделенная цветом. Открывается тем, кто давно и постоянно в группе или канале:
//   читает, пишет, ставит реакции (очки за 30 дней, см. миграцию 20261009060000). Три в день в каждом таком чате.
import type { MyChat, ReactionKey, SuperStatus } from '../lib/database.types';
import { $, ICONS, button, closeDialog, el, errText, html, openDialog, plural, toast } from '../lib/dom';
import { customRef, emojiPacks, emojiUrl, recentEmoji, rememberEmoji } from '../lib/emoji';
import {
  MAX_REACTIONS, REACTIONS, S, cachedSuperStatus, meId, superStatus, toggleReaction, type Msg,
} from './store';
import { loadMyEmojiPacks, openEmojiManager, openStickerPack } from './stickerpacks';
import { sheetHead } from './sheet';

export type ReactEnv = {
  whoName: (uid: string) => string;
};
let env: ReactEnv | null = null;

export function mountReactions(e: ReactEnv): void {
  env = e;
}

const STAR = '<svg class="rx-star" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2.2l2.6 6.3 6.8.5-5.2 4.4 1.6 6.6L12 16.4 6.2 20l1.6-6.6L2.6 9l6.8-.5z"/></svg>';

function canSuper(chat: MyChat | null | undefined): boolean {
  return !!chat && !chat.preview && (chat.kind === 'group' || chat.kind === 'channel');
}

/** Картинка реакции: обычная — эмодзи, своя — картинка (нет картинки — значок). */
export function reactionFace(key: ReactionKey, cls = 'e'): HTMLElement {
  const std = REACTIONS.find((r) => r.k === key);
  if (std) return el('span', cls, std.e);
  const ref = customRef(key);
  const box = el('span', `${cls} rx-c`);
  if (!ref) { box.textContent = '❔'; return box; }
  const img = el('img', 'rx-img');
  img.src = emojiUrl(ref);
  img.alt = '';
  img.draggable = false;
  img.decoding = 'async';
  img.addEventListener('error', () => { box.textContent = '❔'; }, { once: true });
  box.append(img);
  return box;
}

type Chip = { k: ReactionKey; sup: boolean; n: number; on: boolean; who: string[]; first: number };

function chipsOf(m: Msg): Chip[] {
  const list = S.reactions.get(m.id) ?? [];
  const me = meId();
  const map = new Map<string, Chip>();
  list.forEach((r, i) => {
    if (!REACTIONS.some((x) => x.k === r.emoji) && !customRef(r.emoji)) return;
    const sup = !!r.super;
    const id = `${r.emoji}|${sup ? 1 : 0}`;
    let c = map.get(id);
    if (!c) { c = { k: r.emoji, sup, n: 0, on: false, who: [], first: i }; map.set(id, c); }
    c.n++;
    if (r.user_id === me) c.on = true;
    if (r.user_id) c.who.push(env?.whoName(r.user_id) ?? 'Участник');
  });
  const rank = (c: Chip) => {
    const std = REACTIONS.findIndex((x) => x.k === c.k);
    return (c.sup ? 0 : 1000) + (std >= 0 ? std : 10 + c.first);
  };
  return [...map.values()].sort((a, b) => rank(a) - rank(b));
}

/** Сколько реакций уже поставил я. */
function myCount(m: Msg): number {
  const me = meId();
  return (S.reactions.get(m.id) ?? []).filter((r) => r.user_id === me).length;
}

/** Плашки реакций под сообщением (null — реакций нет). */
export function reactionChips(m: Msg, chat: MyChat): HTMLElement | null {
  const chips = chipsOf(m);
  if (!chips.length) return null;
  const rs = el('div', 'reacts');
  chips.forEach((c) => {
    const chip = el('button', `chip${c.on ? ' on' : ''}${c.sup ? ' super' : ''}`);
    chip.type = 'button';
    if (c.sup) chip.append(html(STAR));
    chip.append(reactionFace(c.k), el('span', 'n', String(c.n)));
    const ref = customRef(c.k);
    const label = ref ? 'своё эмодзи' : REACTIONS.find((r) => r.k === c.k)?.e ?? '';
    chip.setAttribute('aria-label', `${c.sup ? 'Супер-реакция ' : ''}${label} ${c.n}`);
    chip.setAttribute('aria-pressed', String(c.on));
    chip.title = (c.sup ? 'Супер-реакция' + (c.who.length ? ': ' : '') : '') + c.who.join(', ')
      + (ref ? `${c.who.length || c.sup ? '\n' : ''}Правая кнопка — открыть набор эмодзи` : '');
    if (chat.preview) chip.disabled = true;
    else {
      chip.addEventListener('click', (ev) => { ev.stopPropagation(); void tapChip(m, chat, c); });
      if (ref) {
        chip.addEventListener('contextmenu', (ev) => { ev.preventDefault(); ev.stopPropagation(); openStickerPack(ref.split('/')[0]); });
      }
    }
    rs.append(chip);
  });
  return rs;
}

async function tapChip(m: Msg, chat: MyChat, c: Chip): Promise<void> {
  if (c.sup && !c.on) {
    // Чужая супер-реакция: «и я так же» — только если супер-реакция мне доступна.
    let st = cachedSuperStatus(chat.id);
    if (!st) st = await superStatus(chat.id).catch(() => null);
    if (st && !st.eligible) { toast(progressText(st)); return; }
    if (st && st.left <= 0) { toast('Супер-реакции в этом чате на сегодня закончились — завтра будут новые.'); return; }
  }
  react(m, c.k, c.sup);
}

/** Поставить или убрать реакцию (ошибку показывает всплывашкой). */
export function react(m: Msg, key: ReactionKey, sup = false): void {
  const ref = customRef(key);
  if (ref) rememberEmoji(ref);
  toggleReaction(m, key, sup).catch((e) => toast(errText(e, 'Не получилось поставить реакцию.')));
}

/** Быстрые реакции над сообщением и в меню: пять обычных и «＋» — все реакции. */
export function quickReactions(m: Msg, chat: MyChat, done: () => void): HTMLButtonElement[] {
  const out = REACTIONS.map((R) => {
    const b = button(null, R.e, (ev) => { ev.stopPropagation(); done(); react(m, R.k); });
    b.setAttribute('aria-label', `Реакция ${R.e}`);
    return b;
  });
  const more = button('rx-more', null, (ev) => { ev.stopPropagation(); done(); openReactionPicker(m, chat); });
  more.append(html(ICONS.plus));
  more.title = canSuper(chat) ? 'Все реакции, свои эмодзи и супер-реакция' : 'Все реакции и свои эмодзи';
  more.setAttribute('aria-label', 'Все реакции');
  out.push(more);
  return out;
}

function progressText(st: SuperStatus): string {
  const parts = [`${Math.min(st.score, st.need)} из ${st.need} очков активности`];
  if (st.member_days < st.need_days) parts.push(`в чате ${st.member_days} из ${st.need_days} дней`);
  return `Супер-реакция откроется за активность в этом чате: ${parts.join(', ')}.`;
}

// ---------------------------------------------------------------------------
// Окно «Реакция»: обычные, недавние свои, наборы эмодзи, супер-реакция
// ---------------------------------------------------------------------------

const R = { msg: null as Msg | null, chat: null as MyChat | null, sup: false, st: null as SuperStatus | null, loading: false, how: false };

function dlg(): HTMLDialogElement {
  return $<HTMLDialogElement>('reactDlg');
}

export function openReactionPicker(m: Msg, chat: MyChat): void {
  R.msg = m;
  R.chat = chat;
  R.sup = false;
  R.how = false;
  R.st = canSuper(chat) ? cachedSuperStatus(chat.id) : null;
  R.loading = canSuper(chat) && !R.st;
  renderPicker();
  openDialog(dlg());
  if (canSuper(chat)) {
    void superStatus(chat.id, true).then((st) => {
      if (R.chat?.id !== chat.id) return;
      R.st = st;
      R.loading = false;
      if (dlg().open) renderPicker();
    }, () => { R.loading = false; if (dlg().open) renderPicker(); });
  }
  // Наборы могли добавить на другом устройстве.
  void loadMyEmojiPacks().then(() => { if (dlg().open && R.msg === m) renderPicker(); }, () => {});
}

/** Перерисовать окно, если наборы эмодзи изменились. */
export function reactionPacksChanged(): void {
  if (dlg().open && R.msg) renderPicker();
}

function pick(key: ReactionKey): void {
  const m = R.msg;
  if (!m) return;
  const sup = R.sup;
  closeDialog(dlg());
  react(m, key, sup);
}

function superBlock(): HTMLElement | null {
  const chat = R.chat;
  if (!canSuper(chat)) return null;
  const box = el('div', 'rx-super-box');
  const st = R.st;
  if (R.loading && !st) {
    box.append(el('div', 'rx-super-load', 'Проверяем супер-реакцию…'));
    return box;
  }
  if (!st) return null;
  if (st.eligible && st.left > 0) {
    const t = button(`rx-super-toggle${R.sup ? ' on' : ''}`, null, () => { R.sup = !R.sup; renderPicker(); });
    t.setAttribute('aria-pressed', String(R.sup));
    const txt = el('span', 'rx-super-t');
    txt.append(el('b', null, 'Супер-реакция'), el('span', null, R.sup
      ? 'Включена — выберите эмодзи, оно будет выделено цветом'
      : `Осталось ${st.left} из ${st.per_day} на сегодня в этом чате`));
    const sw = el('span', 'rx-switch');
    t.append(html(STAR), txt, sw);
    box.append(t);
  } else if (st.eligible) {
    box.append(infoCard('Супер-реакции на сегодня закончились', `В этом чате можно ${plural(st.per_day, 'супер-реакцию', 'супер-реакции', 'супер-реакций')} в день — завтра будут новые.`));
  } else {
    const pct = Math.round(Math.min(1, st.score / st.need) * 100);
    const card = infoCard('Супер-реакция пока закрыта', progressText(st));
    const bar = el('div', 'rx-bar');
    const fill = el('span');
    fill.style.width = `${pct}%`;
    bar.append(fill);
    card.append(bar);
    box.append(card);
  }
  const how = button('rx-how', R.how ? 'Скрыть' : 'Как это работает?', () => { R.how = !R.how; renderPicker(); });
  box.append(how);
  if (R.how) {
    box.append(el('p', 'hint rx-how-t',
      `Супер-реакция выделяется цветом среди других — её видят все участники. Она открывается тем, кто давно и постоянно в группе или канале. `
      + `Очки считаются за последние 30 дней: день, когда вы открывали чат, — 1, ставили реакции — ещё 1, писали сообщения — ещё 2. `
      + `Нужно ${st.need} очков и не меньше ${st.need_days} дней в чате. Каждый день — ${plural(st.per_day, 'супер-реакция', 'супер-реакции', 'супер-реакций')} в этом чате.`));
  }
  return box;
}

function infoCard(title: string, text: string): HTMLElement {
  const c = el('div', 'rx-super-card');
  const head = el('div', 'rx-super-h');
  head.append(html(STAR), el('b', null, title));
  c.append(head, el('span', 'rx-super-sub', text));
  return c;
}

function renderPicker(): void {
  const d = dlg();
  const m = R.msg;
  const chat = R.chat;
  if (!m || !chat) return;
  const me = meId();
  const mineKeys = new Map((S.reactions.get(m.id) ?? []).filter((r) => r.user_id === me).map((r) => [r.emoji as string, !!r.super]));
  const body = el('div', `sh-body rx-body${R.sup ? ' sup' : ''}`);
  const used = myCount(m);
  if (used) {
    body.append(el('p', 'hint rx-used', used >= MAX_REACTIONS
      ? `У вас уже ${MAX_REACTIONS} реакции на этом сообщении — это максимум. Нажмите на свою, чтобы убрать её.`
      : `Ваших реакций на сообщении: ${used} из ${MAX_REACTIONS}.`));
  }
  const sb = superBlock();
  if (sb) body.append(sb);

  const cell = (key: ReactionKey, face: HTMLElement, label: string) => {
    const on = mineKeys.has(key);
    const b = button(`rx-cell${on ? ' on' : ''}${on && mineKeys.get(key) ? ' sup-on' : ''}`, null, () => pick(key));
    b.append(face);
    b.title = label;
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-pressed', String(on));
    return b;
  };
  const section = (title: string, cells: HTMLElement[], extra?: HTMLElement) => {
    const sec = el('section', 'rx-sec');
    const h = el('h3', 'rx-title', title);
    if (extra) h.append(extra);
    const g = el('div', 'rx-grid');
    g.append(...cells);
    sec.append(h, g);
    body.append(sec);
  };

  section('Реакции', REACTIONS.map((r) => cell(r.k, el('span', 'rx-std', r.e), `Реакция ${r.e}`)));

  const packs = emojiPacks().filter((p) => p.emojis.length);
  const known = new Map(packs.flatMap((p) => p.emojis.map((e) => [e.ref, e] as const)));
  const recent = recentEmoji().filter((ref) => known.has(ref)).slice(0, 12);
  if (recent.length) {
    section('Недавние', recent.map((ref) => cell(`c:${ref}`, reactionFace(`c:${ref}`, 'rx-face'), `:${known.get(ref)!.name}:`)));
  }
  packs.forEach((p) => {
    const more = button('rx-pack-more', null, () => { closeDialog(d); openStickerPack(p.id); });
    more.append(html(p.mine ? ICONS.edit : ICONS.next));
    more.title = p.mine ? 'Изменить набор' : 'О наборе';
    more.setAttribute('aria-label', `${more.title}: ${p.title}`);
    section(p.title, p.emojis.map((e) => cell(`c:${e.ref}`, reactionFace(`c:${e.ref}`, 'rx-face'), `:${e.name}:`)), more);
  });
  if (!packs.length) {
    const empty = el('div', 'rx-empty');
    empty.append(el('p', 'hint', 'Своих эмодзи пока нет. Сделайте набор из картинок — и ставьте их реакцией и в сообщениях.'));
    body.append(empty);
  }
  const own = button('btn ghost btn-ic rx-own', null, () => { closeDialog(d); openEmojiManager(); });
  own.append(html(ICONS.plus), packs.length ? 'Свои эмодзи' : 'Создать свои эмодзи');
  body.append(own);
  d.replaceChildren(sheetHead(d, R.sup ? 'Супер-реакция' : 'Реакция'), body);
}
