// Группы и каналы как в Telegram: создание (тип канала, ссылка, участники), «О канале / О группе»,
// администраторы с правами, подписчики, чёрный список, фото и описание.
import type { ChatCard, ChatRight, MemberInfo, MyChat } from '../lib/database.types';
import { avatarUrl } from '../lib/supabase';
import {
  $, ICONS, button, closeDialog, dlgHead, el, errText, fillText, html, openDialog, plural, toast, touchMQ, verifiedMark,
} from '../lib/dom';
import { isOnline, statusText } from '../lib/status';
import {
  S, SEARCH_MIN, USERNAME_RE, addMembers, bannedList, channelLink, chatById, chatUsernameAvailable, createChat,
  deleteChat, hasRight, inviteLink, isAdmin, joinChannel, leaveChat, memberList, meId, myContacts, normUsername, removeAdmin,
  removeChatAvatar, removeMember, resetInvite, searchNorm, searchUsers, setAdmin, setChatUsername, setVerified,
  transferOwner, unbanMember, updateChat, uploadChatAvatar, type Banned, type Contact,
} from './store';
import { nickOf } from './nicks';

/** Что нужно от основного интерфейса. */
export type AdminEnv = {
  avatar: (uid: string | null, cls?: string) => HTMLElement;
  personAvatar: (uid: string | null) => HTMLElement;
  chatTile: (c: MyChat, cls?: string) => HTMLElement;
  chatTitle: (c: MyChat) => string;
  name: (uid: string | null) => string;
  openChat: (id: string) => void;
  openPerson: (uid: string) => void;
};
let env: AdminEnv;
export function mountChatAdmin(e: AdminEnv): void {
  env = e;
}

export const EMOJIS = ['💬', '📢', '🕵️', '💸', '🎲', '🍕', '🐈', '🚀', '🎧', '📦', '🤡', '🔥', '🎮', '📚', '🎵'];

export function renderEmojiGrid(grid: HTMLElement, current: string, onPick: (e: string) => void): void {
  grid.replaceChildren();
  EMOJIS.forEach((e) => {
    const b = button(null, e, () => { onPick(e); renderEmojiGrid(grid, e, onPick); });
    b.setAttribute('aria-pressed', String(e === current));
    b.setAttribute('aria-label', `Значок ${e}`);
    grid.append(b);
  });
}

// ---------------------------------------------------------------------------
// Права (как в Telegram)
// ---------------------------------------------------------------------------

const RIGHTS: Record<'channel' | 'group', [ChatRight, string][]> = {
  channel: [
    ['info', 'Изменение профиля канала'],
    ['post', 'Публикация сообщений'],
    ['edit', 'Изменение чужих публикаций'],
    ['delete', 'Удаление чужих публикаций'],
    ['invite', 'Добавление подписчиков'],
    ['ban', 'Блокировка подписчиков'],
    ['admins', 'Назначение администраторов'],
  ],
  group: [
    ['info', 'Изменение профиля группы'],
    ['delete', 'Удаление сообщений'],
    ['ban', 'Блокировка пользователей'],
    ['invite', 'Пригласительные ссылки'],
    ['admins', 'Назначение администраторов'],
  ],
};

function kindOf(c: MyChat): 'channel' | 'group' {
  return c.kind === 'channel' ? 'channel' : 'group';
}

type Target = { user_id: string; role: string; promoted_by: string | null; rights: ChatRight[] | null };

/** Могу ли я менять права человека или удалить его (так же проверяет сервер). */
function canTouch(c: MyChat, t: Target): boolean {
  if (t.user_id === meId() || t.role === 'owner' || c.preview) return false;
  if (c.role === 'owner') return true;
  if (c.role !== 'admin') return false;
  return t.role === 'member' || t.promoted_by === meId();
}

const W = {
  channel: { members: 'Подписчики', member: 'подписчик', add: 'Добавить подписчиков', leave: 'Покинуть канал', del: 'Удалить канал', about: 'О канале', removeFrom: 'Удалить из канала' },
  group: { members: 'Участники', member: 'участник', add: 'Добавить участников', leave: 'Выйти из группы', del: 'Удалить группу', about: 'О группе', removeFrom: 'Удалить из группы' },
};

export function countLabel(c: MyChat): string {
  return c.kind === 'channel'
    ? plural(c.member_count, 'подписчик', 'подписчика', 'подписчиков')
    : plural(c.member_count, 'участник', 'участника', 'участников');
}

// ---------------------------------------------------------------------------
// Мелочи интерфейса
// ---------------------------------------------------------------------------

function field(label: string, control: HTMLElement, id?: string): HTMLElement {
  const f = el('div', 'field');
  const l = el('label', 'fld', label);
  if (id) { l.htmlFor = id; control.id = id; }
  f.append(l, control);
  return f;
}

function textInput(value: string, max: number, placeholder = ''): HTMLInputElement {
  const i = el('input', 'txt');
  Object.assign(i, { value, maxLength: max, placeholder, autocomplete: 'off' });
  return i;
}

function textArea(value: string, max: number, placeholder = ''): HTMLTextAreaElement {
  const t = el('textarea', 'txt area');
  Object.assign(t, { value, maxLength: max, placeholder, rows: 3 });
  return t;
}

/** Две ступени: первое нажатие спрашивает «Точно?», второе — выполняет. */
function armed(cls: string, label: string, confirm: string, fn: () => Promise<void> | void): HTMLButtonElement {
  const b = button(cls, label, async () => {
    if (b.dataset.armed !== '1') {
      b.dataset.armed = '1';
      b.textContent = confirm;
      setTimeout(() => { if (b.isConnected && b.dataset.armed === '1') { b.dataset.armed = ''; b.textContent = label; } }, 4000);
      return;
    }
    b.disabled = true;
    try { await fn(); } finally { if (b.isConnected) { b.disabled = false; b.dataset.armed = ''; b.textContent = label; } }
  });
  return b;
}

async function copyLink(link: string, what = 'Ссылка скопирована'): Promise<void> {
  const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
  if (touchMQ.matches && nav.share) {
    try { await nav.share({ url: link }); return; } catch { /* отменили — скопируем */ }
  }
  try { await navigator.clipboard.writeText(link); toast(what); } catch { toast(link); }
}

function linkBox(link: string, label: string): HTMLElement {
  const box = el('div', 'invite');
  const inp = el('input', 'txt');
  Object.assign(inp, { readOnly: true, value: link });
  inp.setAttribute('aria-label', label);
  inp.addEventListener('focus', () => inp.select());
  box.append(inp, button('btn ghost small', 'Копировать', () => void copyLink(link)));
  return box;
}

/** Ссылка, по которой зовут в чат: у публичного канала — его адрес, иначе — приглашение. */
export function shareLinkOf(c: MyChat): string | null {
  if (c.kind === 'channel' && c.username) return channelLink(c.username);
  return c.invite_code ? inviteLink(c.invite_code) : null;
}

/** Кнопка-строка списка: иконка, название, значение справа. */
function navRow(icon: string, title: string, value: string, fn: () => void): HTMLButtonElement {
  const b = button('ci-row', null, fn);
  const ic = el('span', 'ci-ic', icon);
  ic.setAttribute('aria-hidden', 'true');
  b.append(ic, el('span', 'ci-title', title), el('span', 'ci-val', value));
  const chev = el('span', 'ci-chev');
  chev.append(html(ICONS.next));
  b.append(chev);
  return b;
}

/** Строка-переключатель (вкл./выкл.). */
function switchRow(icon: string, title: string, on: boolean, fn: () => void): HTMLButtonElement {
  const b = button('ci-row', null, fn);
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-checked', String(on));
  const ic = el('span', 'ci-ic', icon);
  ic.setAttribute('aria-hidden', 'true');
  b.append(ic, el('span', 'ci-title', title), el('span', `ci-switch${on ? ' on' : ''}`));
  return b;
}

function personRow(uid: string, sub: string, onClick: (() => void) | null, extra?: HTMLElement): HTMLElement {
  const li = el('li');
  const b = el(onClick ? 'button' : 'div', 'pr');
  if (b instanceof HTMLButtonElement) { b.type = 'button'; b.addEventListener('click', onClick!); }
  const text = el('span', 'pr-text');
  const p = S.profiles.get(uid);
  const on = uid !== meId() && isOnline(p);
  const nm = el('span', 'nm');
  nm.append(el('span', 'nm-t', uid === meId() ? `${env.name(uid)} (вы)` : env.name(uid)));
  if (p?.verified) nm.append(verifiedMark());
  text.append(nm, el('span', `st${on ? ' on' : ''}`, sub));
  b.append(env.personAvatar(uid), text);
  if (extra) b.append(extra);
  li.append(b);
  return li;
}

function statusOf(uid: string): string {
  return uid === meId() ? 'в сети' : statusText(S.profiles.get(uid));
}

// ---------------------------------------------------------------------------
// «О канале» / «О группе»: страницы в одном окне
// ---------------------------------------------------------------------------

type Page =
  | { p: 'main' }
  | { p: 'edit' }
  | { p: 'type' }
  | { p: 'admins'; list?: MemberInfo[]; err?: string }
  | { p: 'members'; list?: MemberInfo[]; q: string; more: boolean; err?: string }
  | { p: 'banned'; list?: Banned[]; err?: string }
  | { p: 'pickAdmin'; list?: MemberInfo[]; q: string }
  | { p: 'member'; uid: string; info?: Target };

const I = { chatId: '', stack: [] as Page[], editEmoji: '' };

function dlg(): HTMLDialogElement {
  return $<HTMLDialogElement>('chatDlg');
}

function chat(): MyChat | undefined {
  return chatById(I.chatId);
}

export function openChatInfo(chatId: string): void {
  I.chatId = chatId;
  I.stack = [{ p: 'main' }];
  I.editEmoji = '';
  render();
  openDialog(dlg());
}

function go(p: Page): void {
  I.stack.push(p);
  render();
  dlg().scrollTop = 0;
}

function back(): void {
  if (I.stack.length > 1) I.stack.pop();
  render();
}

/** Данные изменились (Realtime, список чатов): перерисовать, если не мешаем вводу. */
export function refreshChatInfo(): void {
  const d = document.getElementById('chatDlg') as HTMLDialogElement | null;
  if (!d?.open || !I.chatId) return;
  const c = chat();
  if (!c) { closeDialog(d); return; }
  const top = I.stack.at(-1)!;
  if (top.p === 'main' || top.p === 'admins' || top.p === 'banned') render();
}

function head(title: string): HTMLElement {
  const h = dlgHead(title, dlg());
  if (I.stack.length > 1) {
    const b = button('icon-btn dlg-back', null, back);
    b.append(html(ICONS.back));
    b.setAttribute('aria-label', 'Назад');
    h.prepend(b);
  }
  return h;
}

function render(): void {
  const c = chat();
  if (!c || (c.kind !== 'group' && c.kind !== 'channel')) { closeDialog(dlg()); return; }
  const top = I.stack.at(-1)!;
  let body: HTMLElement;
  switch (top.p) {
    case 'edit': body = pageEdit(c); break;
    case 'type': body = pageType(c); break;
    case 'admins': body = pageAdmins(c, top); break;
    case 'members': body = pageMembers(c, top); break;
    case 'banned': body = pageBanned(c, top); break;
    case 'pickAdmin': body = pagePickAdmin(c, top); break;
    case 'member': body = pageMember(c, top); break;
    default: body = pageMain(c);
  }
  dlg().replaceChildren(...body.childNodes);
}

function page(title: string): { root: HTMLElement; stack: HTMLElement } {
  const root = el('div');
  const stack = el('div', 'stack');
  root.append(head(title), stack);
  return { root, stack };
}

// Главная

function pageMain(c: MyChat): HTMLElement {
  const w = W[kindOf(c)];
  const { root, stack } = page(w.about);
  const canInfo = hasRight(c, 'info');

  const top = el('div', 'ci-head');
  const tile = env.chatTile(c, 'ci-tile');
  if (canInfo) {
    const pick = button('ci-photo', null, () => pickPhoto(c));
    pick.setAttribute('aria-label', c.avatar_path ? 'Сменить фото' : 'Загрузить фото');
    pick.title = pick.getAttribute('aria-label')!;
    const cam = el('span', 'ci-cam');
    cam.append(html(CAMERA));
    pick.append(tile, cam);
    top.append(pick);
  } else {
    top.append(tile);
  }
  const members = S.members.get(c.id) ?? [];
  const online = members.filter((m) => m.user_id !== meId() && isOnline(S.profiles.get(m.user_id))).length;
  const title = el('h2', 'person-name', env.chatTitle(c));
  if (c.verified) title.append(verifiedMark('channel'));
  top.append(title,
    el('p', 'st', `${c.kind === 'channel' ? 'канал' : 'группа'} · ${countLabel(c)}${c.kind === 'group' && online ? `, ${online} в сети` : ''}`));
  stack.append(top);

  const desc = c.description || (c.is_default ? 'Официальный канал СКАМ: новости, обновления и важные объявления.' : '');
  if (desc) {
    const d = el('p', 'ci-desc');
    fillText(d, desc);
    stack.append(d);
  }

  // Ссылка
  if (c.kind === 'channel' && c.username) {
    const f = el('div', 'field');
    f.append(el('span', 'fld', 'Ссылка'), linkBox(channelLink(c.username), 'Ссылка на канал'),
      el('p', 'hint', `@${c.username} · публичный канал — его находят в поиске`));
    stack.append(f);
  } else if (c.invite_code) {
    const f = el('div', 'field');
    f.append(el('span', 'fld', 'Ссылка-приглашение'), linkBox(inviteLink(c.invite_code), 'Ссылка-приглашение'),
      el('p', 'hint', c.kind === 'channel' ? 'Частный канал: подписаться можно только по этой ссылке.' : 'Любой, у кого есть ссылка, может вступить в группу.'));
    if (hasRight(c, 'invite')) {
      const reset = armed('linkish ci-reset', 'Сбросить ссылку', 'Точно сбросить? Старая перестанет работать', async () => {
        try { await resetInvite(c.id); toast('Старая ссылка больше не работает'); render(); } catch (e) { toast(errText(e)); }
      });
      f.append(reset);
    }
    stack.append(f);
  }

  // Быстрые действия
  const acts = el('div', 'ci-actions');
  if (canInfo) acts.append(button('btn ghost small', 'Изменить', () => go({ p: 'edit' })));
  const canAdd = !c.is_default && (c.kind === 'group' || hasRight(c, 'invite'));
  if (canAdd) acts.append(button('btn ghost small', w.add, () => openAddMembers(c.id)));
  if (acts.childNodes.length) stack.append(acts);

  if (c.preview) {
    // Публичный канал открыт до подписки.
    const sub = button('btn primary', 'Подписаться', async () => {
      sub.disabled = true;
      try {
        await joinChannel(c.id);
        toast(`Вы подписались на «${c.name}»`);
        env.openChat(c.id);
        render();
      } catch (e) {
        toast(errText(e, 'Не получилось подписаться.'));
        sub.disabled = false;
      }
    });
    sub.style.alignSelf = 'flex-start';
    stack.append(el('p', 'hint', 'Вы ещё не подписаны: посты видно, а реакции и уведомления — после подписки.'), sub);
  } else if (c.kind === 'channel' && c.role === 'member' && !c.is_default) {
    stack.append(el('p', 'hint', 'Вы подписчик. Писать в канал могут только администраторы, а реакции ставить — все.'));
  }

  // Управление (админам)
  if (isAdmin(c)) {
    const list = el('div', 'ci-list');
    if (c.kind === 'channel' && canInfo) {
      list.append(navRow('🔗', 'Тип канала', c.username ? 'Публичный' : 'Частный', () => go({ p: 'type' })));
    }
    if (c.kind === 'channel') {
      list.append(switchRow('✍️', 'Подписывать сообщения', c.sign_messages, () => {
        if (!canInfo) { toast('Нужно право «Изменение профиля канала».'); return; }
        updateChat(c.id, { sign: !c.sign_messages }).then(() => render(), (e) => toast(errText(e)));
      }));
    }
    const admins = members.filter((m) => m.role !== 'member').length;
    list.append(navRow('⭐', 'Администраторы', admins ? String(admins) : '', () => go({ p: 'admins' })));
    if (c.kind === 'channel') {
      list.append(navRow('👥', 'Подписчики', String(c.member_count), () => go({ p: 'members', q: '', more: false })));
    }
    if (hasRight(c, 'ban') && !c.is_default) list.append(navRow('🚫', 'Чёрный список', '', () => go({ p: 'banned' })));
    stack.append(list);
    if (c.kind === 'channel') {
      stack.append(el('p', 'hint ci-list-hint', c.sign_messages
        ? 'Под постами видно имя автора.'
        : 'Посты публикуются от имени канала. Включите подписи, чтобы под постом было видно автора.'));
    }
  }

  // Участники группы — прямо здесь, как в Telegram
  if (c.kind === 'group') {
    const mf = el('div', 'field');
    mf.append(el('span', 'fld', `Участники · ${c.member_count}`));
    if (!S.members.get(c.id)) mf.append(el('p', 'hint', 'Загружаем…'));
    else mf.append(memberUl(c, members.map((m) => ({ ...m, rights: m.rights ?? null }))));
    stack.append(mf);
  }

  // Официальная галочка — её выдаёт только владелец СКАМ (в том числе каналу, где он не админ).
  if (c.kind === 'channel' && S.appOwner) {
    const list = el('div', 'ci-list');
    const row = switchRow('✅', 'Официальная галочка', !!c.verified, () => {
      row.disabled = true;
      setVerified('channel', c.id, !c.verified).then(
        () => { toast(c.verified ? 'Каналу выдана официальная галочка' : 'Галочка снята'); render(); },
        (e) => { toast(errText(e, 'Не получилось изменить галочку.')); row.disabled = false; },
      );
    });
    list.append(row);
    stack.append(list, el('p', 'hint ci-list-hint', 'Вы владелец СКАМ. Галочку видят все: так подписчики отличают настоящий канал от подделки.'));
  }

  // Выход и удаление
  const foot = el('div', 'ci-foot');
  if (!c.is_default && !c.preview) {
    const soleOwner = c.role === 'owner' && c.kind === 'channel' && c.member_count > 1;
    if (!soleOwner) {
      const heirNote = c.role === 'owner' && c.kind === 'group' && c.member_count > 1 ? 'Точно? Права владельца перейдут другому' : 'Точно выйти?';
      foot.append(armed('btn danger', w.leave, heirNote, async () => {
        try {
          await leaveChat(c.id);
          closeDialog(dlg());
          toast(c.kind === 'channel' ? 'Вы отписались от канала' : 'Вы вышли из группы');
        } catch (e) { toast(errText(e)); }
      }));
    }
    if (c.role === 'owner') {
      foot.append(armed('btn danger', w.del, `Удалить для всех? Это нельзя отменить`, async () => {
        try {
          await deleteChat(c.id);
          closeDialog(dlg());
          toast(c.kind === 'channel' ? 'Канал удалён' : 'Группа удалена');
        } catch (e) { toast(errText(e)); }
      }));
    }
    if (soleOwner) foot.append(el('p', 'hint', 'Чтобы покинуть канал, передайте права владельца другому администратору или удалите канал.'));
  }
  if (foot.childNodes.length) stack.append(el('div', 'hr'), foot);
  return root;
}

function roleLabel(m: Target): string {
  if (m.role === 'owner') return 'владелец';
  if (m.role === 'admin') return 'админ';
  return '';
}

function memberUl(c: MyChat, list: Target[]): HTMLElement {
  const ul = el('ul', 'members');
  const onl = (uid: string) => uid === meId() || isOnline(S.profiles.get(uid));
  const seen = (uid: string) => Date.parse(S.profiles.get(uid)?.last_seen_at ?? '') || 0;
  const rank = (r: string) => (r === 'owner' ? 0 : r === 'admin' ? 1 : 2);
  const sorted = [...list].sort((a, b) =>
    Number(onl(b.user_id)) - Number(onl(a.user_id)) || rank(a.role) - rank(b.role)
    || seen(b.user_id) - seen(a.user_id) || env.name(a.user_id).localeCompare(env.name(b.user_id), 'ru'));
  sorted.slice(0, 300).forEach((m) => {
    const role = roleLabel(m);
    const tag = role ? el('span', 'role', role) : undefined;
    ul.append(personRow(m.user_id, statusOf(m.user_id), () => openMember(c, m), tag));
  });
  return ul;
}

/** Нажали на человека в списке: управляющему — страница с правами, остальным — профиль. */
function openMember(c: MyChat, m: Target): void {
  const manage = canTouch(c, m) && (hasRight(c, 'admins') || hasRight(c, 'ban'));
  if (!manage) { env.openPerson(m.user_id); return; }
  go({ p: 'member', uid: m.user_id, info: m });
}

// Фото

const CAMERA = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';

function pickPhoto(c: MyChat): void {
  const file = el('input');
  Object.assign(file, { type: 'file', accept: 'image/*' });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    toast('Загружаем фото…');
    try {
      await uploadChatAvatar(c.id, f);
      toast('Фото обновлено');
      render();
    } catch (e) {
      toast(errText(e, 'Не получилось загрузить фото.'));
    }
  });
  file.click();
}

// Изменить: фото, название, значок, описание

function pageEdit(c: MyChat): HTMLElement {
  const { root, stack } = page(c.kind === 'channel' ? 'Изменить канал' : 'Изменить группу');
  const keep = (id: string) => (dlg().open ? (document.getElementById(id) as HTMLInputElement | null)?.value : undefined);
  const av = el('div', 'av-edit');
  const btns = el('div', 'btns');
  btns.append(button('btn ghost small', c.avatar_path ? 'Сменить фото' : 'Загрузить фото', () => pickPhoto(c)));
  if (c.avatar_path) {
    btns.append(button('btn danger small', 'Убрать', async () => {
      try { await removeChatAvatar(c.id); render(); } catch (e) { toast(errText(e)); }
    }));
  }
  av.append(env.chatTile(c, 'ci-tile'), btns);

  const name = textInput(keep('ciName') ?? c.name ?? '', 40);
  const desc = textArea(keep('ciDesc') ?? c.description ?? '', 255, 'необязательно');
  I.editEmoji = I.editEmoji || c.emoji;
  const grid = el('div', 'emoji-grid');
  renderEmojiGrid(grid, I.editEmoji, (e) => { I.editEmoji = e; });
  const err = el('p', 'err');
  const save = button('btn primary', 'Сохранить', async () => {
    const v = name.value.trim();
    if (!v) { err.textContent = 'Введите название.'; name.focus(); return; }
    save.disabled = true;
    try {
      await updateChat(c.id, { name: v, emoji: I.editEmoji, description: desc.value });
      toast('Сохранено');
      I.editEmoji = '';
      back();
    } catch (e) {
      err.textContent = errText(e);
      save.disabled = false;
    }
  });
  save.style.alignSelf = 'flex-start';
  const emojiField = el('div', 'field');
  emojiField.append(el('span', 'fld', c.avatar_path ? 'Значок (виден, если убрать фото)' : 'Значок'), grid);
  stack.append(av, field('Название', name, 'ciName'), emojiField,
    field('Описание', desc, 'ciDesc'), err, save);
  return root;
}

// Тип канала: публичный или частный

function typeChooser(initialPublic: boolean, onChange: (pub: boolean) => void): HTMLElement {
  const box = el('div', 'type-radio');
  box.setAttribute('role', 'radiogroup');
  box.setAttribute('aria-label', 'Тип канала');
  const opt = (pub: boolean, title: string, sub: string) => {
    const l = el('label', 'tr-opt');
    const r = el('input');
    Object.assign(r, { type: 'radio', name: 'chanType', checked: pub === initialPublic });
    r.addEventListener('change', () => { if (r.checked) onChange(pub); });
    const t = el('span', 'tr-text');
    t.append(el('b', null, title), el('span', null, sub));
    l.append(r, t);
    return l;
  };
  box.append(
    opt(true, 'Публичный канал', 'Все могут найти канал через поиск и подписаться.'),
    opt(false, 'Частный канал', 'Подписаться можно только по ссылке-приглашению.'),
  );
  return box;
}

/** Поле «Ссылка» с проверкой, свободно ли имя. */
function usernameField(chatId: string | null, initial: string): { root: HTMLElement; value: () => string; ok: () => boolean; input: HTMLInputElement } {
  const root = el('div', 'field');
  const lbl = el('label', 'fld', 'Ссылка');
  const wrap = el('div', 'prefixed');
  const pre = el('span', 'pre', '@');
  const input = textInput(initial, 32, 'имя_канала');
  input.id = 'chanUser';
  lbl.htmlFor = 'chanUser';
  Object.assign(input, { autocapitalize: 'off', spellcheck: false });
  wrap.append(pre, input);
  const hint = el('p', 'hint');
  const full = el('p', 'hint ci-full');
  root.append(lbl, wrap, hint, full);
  const HINT = 'Латиница, цифры и _, от 5 символов. По этому имени канал находят в поиске.';
  let ok = !!initial;
  let seq = 0;
  let timer: number | undefined;
  const check = () => {
    clearTimeout(timer);
    const v = normUsername(input.value);
    hint.classList.remove('ok', 'bad');
    full.textContent = v ? channelLink(v).replace(/^https?:\/\//, '') : '';
    if (!v) { ok = false; hint.textContent = HINT; return; }
    if (!USERNAME_RE.test(v)) { ok = false; hint.textContent = 'Только латиница, цифры и _, от 5 до 32 символов, первая — буква.'; hint.classList.add('bad'); return; }
    ok = false;
    hint.textContent = 'Проверяем…';
    const my = ++seq;
    timer = window.setTimeout(async () => {
      const free = await chatUsernameAvailable(chatId, v).catch(() => false);
      if (my !== seq) return;
      ok = free;
      hint.textContent = free ? `@${v} свободно` : `@${v} уже занято`;
      hint.classList.add(free ? 'ok' : 'bad');
    }, 350);
  };
  input.addEventListener('input', check);
  if (initial) { hint.textContent = HINT; full.textContent = channelLink(initial).replace(/^https?:\/\//, ''); } else hint.textContent = HINT;
  return { root, value: () => normUsername(input.value), ok: () => ok, input };
}

function pageType(c: MyChat): HTMLElement {
  const { root, stack } = page('Тип канала');
  let pub = !!c.username;
  const un = usernameField(c.id, c.username ?? '');
  const priv = el('div', 'field');
  if (c.invite_code) priv.append(el('span', 'fld', 'Ссылка-приглашение'), linkBox(inviteLink(c.invite_code), 'Ссылка-приглашение'),
    el('p', 'hint', 'Пригласить в частный канал можно только по этой ссылке.'));
  const sync = () => { un.root.hidden = !pub; priv.hidden = pub || !c.invite_code; };
  const err = el('p', 'err');
  const save = button('btn primary', 'Сохранить', async () => {
    if (pub && (!un.value() || !un.ok())) { err.textContent = 'Выберите свободное имя для ссылки.'; un.input.focus(); return; }
    save.disabled = true;
    try {
      await setChatUsername(c.id, pub ? un.value() : null);
      toast(pub ? 'Канал стал публичным' : 'Канал стал частным');
      back();
    } catch (e) {
      err.textContent = (e as { code?: string }).code === '23505' ? 'Это имя уже занято.' : errText(e);
      save.disabled = false;
    }
  });
  save.style.alignSelf = 'flex-start';
  stack.append(typeChooser(pub, (p) => { pub = p; sync(); }), un.root, priv, err, save);
  sync();
  return root;
}

// Администраторы

function pageAdmins(c: MyChat, pg: Extract<Page, { p: 'admins' }>): HTMLElement {
  const { root, stack } = page('Администраторы');
  if (!pg.list && !pg.err) {
    memberList(c.id, { admins: true, limit: 200 }).then((l) => { pg.list = l; }, (e) => { pg.err = errText(e); })
      .finally(() => { if (I.stack.at(-1) === pg) render(); });
    stack.append(el('p', 'hint', 'Загружаем…'));
    return root;
  }
  if (pg.err) { stack.append(el('p', 'err', pg.err)); return root; }
  const ul = el('ul', 'members');
  for (const m of pg.list!) {
    const by = m.promoted_by && m.promoted_by !== m.user_id ? env.name(m.promoted_by) : null;
    const sub = m.role === 'owner' ? 'владелец' : by ? `назначил(а) ${by}` : 'администратор';
    const tag = el('span', 'role', m.role === 'owner' ? 'владелец' : plural((m.rights ?? []).length, 'право', 'права', 'прав'));
    ul.append(personRow(m.user_id, sub, () => (canTouch(c, m) ? go({ p: 'member', uid: m.user_id, info: m }) : env.openPerson(m.user_id)), tag));
  }
  stack.append(ul);
  if (hasRight(c, 'admins')) {
    const add = button('btn ghost small', 'Добавить администратора', () => go({ p: 'pickAdmin', q: '' }));
    add.style.alignSelf = 'flex-start';
    stack.append(add);
  }
  stack.append(el('p', 'hint', c.kind === 'channel'
    ? 'Администраторы помогают вести канал. Права каждого можно настроить отдельно.'
    : 'Администраторы помогают управлять группой. Права каждого можно настроить отдельно.'));
  return root;
}

function pagePickAdmin(c: MyChat, pg: Extract<Page, { p: 'pickAdmin' }>): HTMLElement {
  const { root, stack } = page('Новый администратор');
  const q = textInput(pg.q, 64, c.kind === 'channel' ? 'Поиск среди подписчиков' : 'Поиск среди участников');
  q.setAttribute('aria-label', 'Поиск');
  const out = el('ul', 'members');
  let seq = 0;
  const fill = async () => {
    const my = ++seq;
    pg.q = q.value;
    let list: MemberInfo[];
    try {
      list = await memberList(c.id, { query: q.value.trim(), limit: 50 });
    } catch (e) { out.replaceChildren(el('p', 'err', errText(e))); return; }
    if (my !== seq) return;
    const cand = list.filter((m) => m.role === 'member' && m.user_id !== meId());
    if (!cand.length) { out.replaceChildren(el('p', 'hint', q.value.trim() ? 'Никого не нашли.' : 'Здесь пока никого нет.')); return; }
    out.replaceChildren(...cand.map((m) => personRow(m.user_id, statusOf(m.user_id), () => go({ p: 'member', uid: m.user_id, info: m }))));
  };
  let t = 0;
  q.addEventListener('input', () => { clearTimeout(t); t = window.setTimeout(() => void fill(), 250); });
  stack.append(q, out);
  out.append(el('p', 'hint', 'Загружаем…'));
  void fill();
  setTimeout(() => { if (!touchMQ.matches) q.focus(); }, 0);
  return root;
}

// Человек: права администратора, удаление

function pageMember(c: MyChat, pg: Extract<Page, { p: 'member' }>): HTMLElement {
  const w = W[kindOf(c)];
  const m: Target = pg.info ?? S.members.get(c.id)?.find((x) => x.user_id === pg.uid) as Target
    ?? { user_id: pg.uid, role: 'member', promoted_by: null, rights: null };
  const isAdm = m.role === 'admin';
  const { root, stack } = page(isAdm ? 'Права администратора' : c.kind === 'channel' ? 'Подписчик' : 'Участник');
  const p = S.profiles.get(pg.uid);
  const card = el('div', 'ci-person');
  const text = el('div', 'ci-person-text');
  text.append(el('b', null, env.name(pg.uid)));
  if (p?.username) text.append(el('span', 'uname', `@${p.username}`));
  text.append(el('span', 'st', statusOf(pg.uid)));
  const prof = button('btn ghost small', 'Профиль', () => env.openPerson(pg.uid));
  card.append(env.avatar(pg.uid, 'lg'), text, prof);
  stack.append(card);

  const touch = canTouch(c, m);
  const mine = c.rights ?? [];
  if (touch && hasRight(c, 'admins')) {
    const f = el('div', 'field');
    f.append(el('span', 'fld', 'Что может этот администратор'));
    const set = new Set<ChatRight>(isAdm ? m.rights ?? [] : RIGHTS[kindOf(c)].map(([r]) => r).filter((r) => r !== 'admins' && mine.includes(r)));
    const list = el('div', 'rights');
    for (const [r, label] of RIGHTS[kindOf(c)]) {
      const row = el('label', 'check-row right-row');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = set.has(r);
      cb.disabled = !mine.includes(r);
      cb.addEventListener('change', () => { if (cb.checked) set.add(r); else set.delete(r); });
      row.append(cb, el('span', null, label));
      if (cb.disabled) row.title = 'У вас самого нет этого права';
      list.append(row);
    }
    f.append(list);
    if (isAdm && m.promoted_by) f.append(el('p', 'hint', `Назначил(а): ${m.promoted_by === meId() ? 'вы' : env.name(m.promoted_by)}`));
    stack.append(f);
    const err = el('p', 'err');
    const btns = el('div', 'ci-actions');
    const save = button('btn primary small', isAdm ? 'Сохранить' : 'Назначить администратором', async () => {
      save.disabled = true;
      try {
        await setAdmin(c.id, pg.uid, [...set]);
        toast(isAdm ? 'Права изменены' : `${env.name(pg.uid)} — теперь администратор`);
        Object.assign(m, { role: 'admin', rights: [...set], promoted_by: meId() });
        popTo('admins');
      } catch (e) { err.textContent = errText(e); save.disabled = false; }
    });
    btns.append(save);
    if (isAdm) {
      btns.append(armed('btn danger small', 'Разжаловать', 'Точно разжаловать?', async () => {
        try {
          await removeAdmin(c.id, pg.uid);
          toast('Больше не администратор');
          popTo('admins');
        } catch (e) { err.textContent = errText(e); }
      }));
    }
    stack.append(err, btns);
    if (isAdm && c.role === 'owner') {
      stack.append(el('div', 'hr'), armed('btn danger small ci-left', 'Передать права владельца', `Передать ${c.kind === 'channel' ? 'канал' : 'группу'}? Вы станете администратором`, async () => {
        try {
          await transferOwner(c.id, pg.uid);
          toast(`Теперь владелец — ${env.name(pg.uid)}`);
          I.stack = [{ p: 'main' }];
          render();
        } catch (e) { err.textContent = errText(e); }
      }));
    }
  } else if (isAdm) {
    stack.append(el('p', 'hint', `Права: ${(m.rights ?? []).map((r) => RIGHTS[kindOf(c)].find(([k]) => k === r)?.[1]).filter(Boolean).join(', ') || 'нет'}`));
  }
  if (touch && hasRight(c, 'ban') && !c.is_default) {
    stack.append(el('div', 'hr'), armed('btn danger small ci-left', w.removeFrom, 'Удалить и заблокировать?', async () => {
      try {
        await removeMember(c.id, pg.uid, true);
        toast(`${env.name(pg.uid)} удалён(а) и в чёрном списке`);
        back();
      } catch (e) { toast(errText(e)); }
    }), el('p', 'hint', 'Удалённый попадёт в чёрный список и не вернётся по ссылке, пока его не разблокируют.'));
  }
  return root;
}

/** Вернуться к странице (список админов перечитается). */
function popTo(p: Page['p']): void {
  const i = I.stack.map((x) => x.p).lastIndexOf(p);
  I.stack = i >= 0 ? I.stack.slice(0, i + 1) : [I.stack[0], { p } as Page];
  const top = I.stack.at(-1)!;
  if (top.p === 'admins') { top.list = undefined; top.err = undefined; }
  render();
}

// Подписчики канала (только администраторам)

function pageMembers(c: MyChat, pg: Extract<Page, { p: 'members' }>): HTMLElement {
  const w = W[kindOf(c)];
  const { root, stack } = page(`${w.members} · ${c.member_count}`);
  const q = textInput(pg.q, 64, 'Поиск');
  q.setAttribute('aria-label', 'Поиск');
  const out = el('div');
  let seq = 0;
  const fill = async (more = false) => {
    const my = ++seq;
    pg.q = q.value;
    try {
      const got = await memberList(c.id, { query: q.value.trim(), limit: 50, offset: more ? pg.list?.length ?? 0 : 0 });
      if (my !== seq) return;
      pg.list = more ? [...(pg.list ?? []), ...got] : got;
      pg.more = got.length === 50;
    } catch (e) {
      out.replaceChildren(el('p', 'err', errText(e)));
      return;
    }
    draw();
  };
  const draw = () => {
    const list = pg.list ?? [];
    if (!list.length) { out.replaceChildren(el('p', 'hint', q.value.trim() ? 'Никого не нашли.' : 'Подписчиков пока нет.')); return; }
    const ul = memberUlPlain(c, list);
    out.replaceChildren(ul);
    if (pg.more) out.append(button('btn ghost small ci-more', 'Показать ещё', () => void fill(true)));
  };
  let t = 0;
  q.addEventListener('input', () => { clearTimeout(t); t = window.setTimeout(() => void fill(), 250); });
  if (hasRight(c, 'invite') && !c.is_default) {
    const add = button('btn ghost small', w.add, () => openAddMembers(c.id));
    add.style.alignSelf = 'flex-start';
    stack.append(add);
  }
  stack.append(q, out);
  if (pg.list) draw(); else { out.append(el('p', 'hint', 'Загружаем…')); void fill(); }
  return root;
}

/** Список в порядке сервера: владелец, админы, потом новые подписчики. */
function memberUlPlain(c: MyChat, list: Target[]): HTMLElement {
  const ul = el('ul', 'members');
  list.forEach((m) => {
    const role = roleLabel(m);
    ul.append(personRow(m.user_id, statusOf(m.user_id), () => openMember(c, m), role ? el('span', 'role', role) : undefined));
  });
  return ul;
}

// Чёрный список

function pageBanned(c: MyChat, pg: Extract<Page, { p: 'banned' }>): HTMLElement {
  const { root, stack } = page('Чёрный список');
  if (!pg.list && !pg.err) {
    bannedList(c.id).then((l) => { pg.list = l; }, (e) => { pg.err = errText(e); })
      .finally(() => { if (I.stack.at(-1) === pg) render(); });
    stack.append(el('p', 'hint', 'Загружаем…'));
    return root;
  }
  if (pg.err) { stack.append(el('p', 'err', pg.err)); return root; }
  if (!pg.list!.length) {
    stack.append(el('p', 'hint', `Здесь будут те, кого удалили из ${c.kind === 'channel' ? 'канала' : 'группы'}. Они не смогут вернуться по ссылке, пока их не разблокируют.`));
    return root;
  }
  const ul = el('ul', 'members');
  for (const b of pg.list!) {
    const un = button('btn ghost small', 'Разблокировать', async (ev) => {
      ev.stopPropagation();
      un.disabled = true;
      try {
        await unbanMember(c.id, b.user_id);
        pg.list = pg.list!.filter((x) => x.user_id !== b.user_id);
        toast('Разблокирован(а)');
        render();
      } catch (e) { toast(errText(e)); un.disabled = false; }
    });
    ul.append(personRow(b.user_id, b.banned_by_name ? `удалил(а) ${b.banned_by === meId() ? 'вы' : b.banned_by_name}` : 'удалён(а)', null, un));
  }
  stack.append(ul, el('p', 'hint', 'Разблокированный сможет вернуться по ссылке. Добавить его снова может тот, у кого есть общий с ним чат.'));
  return root;
}

// ---------------------------------------------------------------------------
// «Добавить участников»: знакомые с галочками, остальных — по ссылке
// ---------------------------------------------------------------------------

export function openAddMembers(chatId: string, opts: { dialog?: HTMLDialogElement; onDone?: () => void; skip?: boolean } = {}): void {
  const c = chatById(chatId);
  if (!c) return;
  const d = opts.dialog ?? $<HTMLDialogElement>('pickDlg');
  const w = W[kindOf(c)];
  const picked = new Set<string>();
  let contacts: Contact[] | null = null;
  let found: { id: string; is_contact: boolean }[] = [];
  let seq = 0;

  const h = dlgHead(w.add, d, !opts.skip);
  const q = textInput('', 64, 'Поиск');
  q.classList.add('pick-q');
  q.setAttribute('aria-label', 'Поиск');
  const link = shareLinkOf(c);
  const inviteRow = button('pick-link', null, () => { if (link) void copyLink(link, 'Ссылка скопирована — отправьте её'); });
  const ic = el('span', 'pick-link-ic');
  ic.append(html('<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13.5a4.5 4.5 0 0 0 6.4.4l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10.5a4.5 4.5 0 0 0-6.4-.4l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/></svg>'));
  inviteRow.append(ic, el('span', null, 'Пригласить по ссылке'));
  inviteRow.hidden = !link;
  const list = el('div', 'pick-list');
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', 'Знакомые');
  const note = el('p', 'hint pick-note');
  const actions = el('div', 'dlg-actions');
  const done = () => closeDialog(d);
  const cancel = button('btn ghost', opts.skip ? 'Пропустить' : 'Отмена', done);
  const add = button('btn primary', 'Добавить', async () => {
    if (!picked.size) { done(); return; }
    add.disabled = true;
    try {
      const n = await addMembers(c.id, [...picked]);
      toast(n ? `Добавлено: ${plural(n, 'человек', 'человека', 'человек')}` : 'Никого не добавили');
      done();
    } catch (e) {
      toast(errText(e, 'Не получилось добавить.'));
      add.disabled = false;
    }
  });
  actions.append(cancel, add);

  const syncBtn = () => { add.textContent = picked.size ? `Добавить · ${picked.size}` : 'Добавить'; };

  const row = (uid: string, sub: string, state: 'free' | 'in' | 'stranger') => {
    const l = el('label', `pick-row${state !== 'free' ? ' off' : ''}`);
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = state === 'in' || picked.has(uid);
    cb.disabled = state !== 'free';
    cb.addEventListener('change', () => { if (cb.checked) picked.add(uid); else picked.delete(uid); syncBtn(); });
    const text = el('span', 'pr-text');
    const on = isOnline(S.profiles.get(uid));
    const nm = el('span', 'nm');
    nm.append(el('span', 'nm-t', env.name(uid)));
    if (S.profiles.get(uid)?.verified) nm.append(verifiedMark());
    text.append(nm, el('span', `st${on && state === 'free' ? ' on' : ''}`, sub));
    l.append(env.personAvatar(uid), text, cb);
    return l;
  };

  const draw = () => {
    if (!contacts) { list.replaceChildren(el('p', 'hint', 'Загружаем знакомых…')); return; }
    const needle = searchNorm(q.value).replace(/^@+/, '');
    // Ищем по имени, @username и по нику, который вы дали человеку.
    const byName = (v: string) => searchNorm(v).split(/[\s-]+/).some((wd) => wd.startsWith(needle)) || searchNorm(v).startsWith(needle);
    const match = (x: Contact) => !needle || byName(x.name ?? '') || byName(nickOf(x.id) ?? '') || (x.username ?? '').startsWith(needle);
    const mine = contacts.filter(match);
    const rows: HTMLElement[] = mine.map((x) => row(x.id, x.in_chat ? (c.kind === 'channel' ? 'уже подписан(а)' : 'уже в группе') : statusOf(x.id), x.in_chat ? 'in' : 'free'));
    const strangers = found.filter((f) => !f.is_contact && f.id !== meId() && !contacts!.some((x) => x.id === f.id));
    if (strangers.length) {
      rows.push(el('p', 'fld pick-sep', 'Нет общего чата — позовите по ссылке'));
      strangers.forEach((f) => rows.push(row(f.id, 'только по ссылке', 'stranger')));
    }
    if (!rows.length) rows.push(el('p', 'hint', needle ? 'Никого не нашли.' : 'Знакомых пока нет — отправьте ссылку-приглашение.'));
    list.replaceChildren(...rows);
  };

  let t = 0;
  q.addEventListener('input', () => {
    draw();
    clearTimeout(t);
    const raw = q.value.trim();
    if (searchNorm(raw).replace(/^@+/, '').length < SEARCH_MIN) { found = []; return; }
    const my = ++seq;
    t = window.setTimeout(async () => {
      try {
        const got = await searchUsers(raw);
        if (my !== seq) return;
        got.forEach((g) => { if (!S.profiles.has(g.id)) S.profiles.set(g.id, { id: g.id, name: g.name, first_name: g.name, last_name: null, username: g.username, username_optional: false, avatar_path: g.avatar_path, color: g.color, last_seen_at: null, online_until: null, verified: g.verified, bio: null, created_at: '', updated_at: '' }); });
        found = got.map((g) => ({ id: g.id, is_contact: g.is_contact }));
        draw();
      } catch { /* поиск — не главное */ }
    }, 300);
  });

  note.textContent = c.kind === 'channel'
    ? 'Добавить можно тех, с кем у вас есть общий чат. Остальным отправьте ссылку.'
    : 'Добавить можно тех, с кем у вас есть общий чат. Новые участники увидят историю группы.';
  d.replaceChildren(h, q, inviteRow, list, note, actions);
  d.addEventListener('close', () => opts.onDone?.(), { once: true });
  openDialog(d);
  draw();
  syncBtn();
  myContacts(c.id).then((l) => { contacts = l; draw(); }, (e) => { list.replaceChildren(el('p', 'err', errText(e))); });
  if (!touchMQ.matches) q.focus();
}

// ---------------------------------------------------------------------------
// Создание группы или канала
// ---------------------------------------------------------------------------

export function openCreate(kind: 'group' | 'channel'): void {
  const d = $<HTMLDialogElement>('createDlg');
  let emoji = kind === 'channel' ? '📢' : EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
  let photo: File | null = null;
  let photoUrl: string | null = null;

  const title = kind === 'channel' ? 'Новый канал' : 'Новая группа';
  const tile = el('span', 'tile ci-tile create-tile', emoji);
  const drawTile = () => {
    tile.replaceChildren();
    tile.classList.toggle('photo', !!photoUrl);
    if (photoUrl) { const img = el('img'); img.src = photoUrl; img.alt = ''; tile.append(img); } else tile.textContent = emoji;
  };
  const file = el('input');
  Object.assign(file, { type: 'file', accept: 'image/*', hidden: true });
  const pick = button('ci-photo', null, () => file.click());
  pick.setAttribute('aria-label', 'Выбрать фото');
  const cam = el('span', 'ci-cam');
  cam.append(html(CAMERA));
  pick.append(tile, cam);
  const rm = button('linkish', 'Убрать фото', () => { photo = null; if (photoUrl) URL.revokeObjectURL(photoUrl); photoUrl = null; drawTile(); rm.hidden = true; });
  rm.hidden = true;
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    if (!f.type.startsWith('image/')) { toast('Выберите картинку'); return; }
    photo = f;
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = URL.createObjectURL(f);
    drawTile();
    rm.hidden = false;
  });
  const photoBox = el('div', 'create-photo');
  const side = el('div', 'create-photo-side');
  side.append(el('span', 'hint', 'Фото необязательно — без него будет значок.'), rm);
  photoBox.append(pick, side, file);

  const name = textInput('', 40, kind === 'channel' ? 'Например, Новости двора' : 'Например, Мемы отдела');
  const desc = textArea('', 255, 'необязательно');
  const grid = el('div', 'emoji-grid');
  renderEmojiGrid(grid, emoji, (e) => { emoji = e; drawTile(); });
  const err = el('p', 'err');
  const next = button('btn primary', 'Далее', () => void submit());
  const actions = el('div', 'dlg-actions');
  actions.append(button('btn ghost', 'Отмена', () => closeDialog(d)), next);
  const emojiField = el('div', 'field');
  emojiField.append(el('span', 'fld', 'Значок'), grid);
  d.replaceChildren(dlgHead(title, d), photoBox, field('Название', name, 'newName'),
    field(kind === 'channel' ? 'Описание' : 'Описание группы', desc, 'newDesc'), emojiField, err, actions);
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void submit(); } });
  d.addEventListener('close', () => { if (photoUrl) URL.revokeObjectURL(photoUrl); }, { once: true });
  openDialog(d);
  name.focus();

  async function submit(): Promise<void> {
    const v = name.value.trim();
    if (!v) { err.textContent = 'Введите название.'; name.focus(); return; }
    next.disabled = true;
    next.textContent = 'Создаём…';
    let id: string;
    try {
      id = await createChat(v, emoji, kind, desc.value.trim() || null);
    } catch (e) {
      err.textContent = errText(e, kind === 'channel' ? 'Не получилось создать канал.' : 'Не получилось создать группу.');
      next.disabled = false;
      next.textContent = 'Далее';
      return;
    }
    if (photo) await uploadChatAvatar(id, photo).catch((e) => toast(errText(e, 'Фото не загрузилось — его можно поставить позже.')));
    const finish = () => env.openChat(id);
    const addStep = () => openAddMembers(id, { dialog: d, skip: true, onDone: finish });
    if (kind === 'channel') stepType(d, id, addStep); else addStep();
  }
}

/** Шаг мастера: публичный или частный канал (как на экране Telegram). */
function stepType(d: HTMLDialogElement, chatId: string, next: () => void): void {
  let pub = true;
  const c = chatById(chatId);
  const un = usernameField(chatId, '');
  const priv = el('div', 'field');
  if (c?.invite_code) priv.append(el('span', 'fld', 'Ссылка-приглашение'), linkBox(inviteLink(c.invite_code), 'Ссылка-приглашение'),
    el('p', 'hint', 'По этой ссылке можно подписаться на канал. Её можно сбросить в настройках канала.'));
  const sync = () => { un.root.hidden = !pub; priv.hidden = pub || !c?.invite_code; };
  const err = el('p', 'err');
  const save = button('btn primary', 'Сохранить', async () => {
    if (!pub) { next(); return; }
    if (!un.value() || !un.ok()) { err.textContent = 'Выберите свободное имя для ссылки — или сделайте канал частным.'; un.input.focus(); return; }
    save.disabled = true;
    try {
      await setChatUsername(chatId, un.value());
      next();
    } catch (e) {
      err.textContent = (e as { code?: string }).code === '23505' ? 'Это имя уже занято.' : errText(e);
      save.disabled = false;
    }
  });
  const actions = el('div', 'dlg-actions');
  actions.append(button('btn ghost', 'Пропустить', next), save);
  d.replaceChildren(dlgHead('Тип канала', d, false), typeChooser(pub, (p) => { pub = p; sync(); }), un.root, priv, err, actions);
  sync();
  un.input.focus();
}

// ---------------------------------------------------------------------------
// Приглашение и публичная ссылка: карточка группы или канала
// ---------------------------------------------------------------------------

export function cardTile(card: Pick<ChatCard, 'emoji' | 'avatar_path'>): HTMLElement {
  const tile = el('span', `conv-emoji join-tile${card.avatar_path ? ' photo' : ''}`);
  if (card.avatar_path) {
    const img = el('img');
    img.src = avatarUrl(card.avatar_path) ?? '';
    img.alt = '';
    tile.append(img);
  } else tile.textContent = card.emoji;
  return tile;
}
