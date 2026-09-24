// Интерфейс мессенджера: список чатов, лента, композер и диалоги.
import type { User } from '@supabase/supabase-js';
import { avatarUrl, sb } from '../lib/supabase';
import type { MyChat, ReactionKey } from '../lib/database.types';
import {
  $, APP_ICON_HERO, ICONS, LOGO, button, closeDialog, dayKey, dayLabel, el, fillText, html,
  listTime, lsGet, lsSet, openDialog, plural, timeLabel, toast, touchMQ, wideMQ,
} from '../lib/dom';
import { PACKS, findSticker, recentStickers, rememberSticker, stickerUrl, stickersForEmoji, type Sticker } from '../lib/stickers';
import { isOnline, statusText } from '../lib/status';
import { getTheme, setTheme, type Theme } from '../lib/theme';
import { mountRegister } from './register';
import {
  NoProfileError, REACTIONS, S, USERNAME_RE, createChat, deleteMessage, discardMessage, emit, ensureProfiles,
  feedOf, inviteLink, joinByInvite, leaveChat, loadChats, loadFeed, loadMe, loadOlder, markRead, meId,
  normUsername, on, openDirect, previewInvite, removeAvatar, renameChat, resetInvite, resetState, retryMessage,
  SEARCH_MIN, searchNorm, searchUsers, sendMessage, sendRecorded, sendSticker, sortedChats, toggleReaction, totalUnread, ts,
  updateMyProfile, uploadAvatar, usernameAvailable, type FoundUser, type Msg,
} from './store';
import { goOffline, joinChatChannel, sendTyping, startRealtime, stopRealtime } from './realtime';
import { dropNotes, setLocalMedia, setVoiceQueue, stopVoice, videoNoteEl, voiceEl } from './media';
import { mountRecorder, type RecordUI } from './record-ui';

const EMOJIS = ['💬', '🕵️', '💸', '🎲', '🍕', '🐈', '🚀', '🎧', '📦', '🤡'];
const MAX_LEN = 4000;

const SHELL = `
<div class="app">
  <aside class="side" aria-label="Чаты">
    <header class="side-head">
      ${LOGO}
      <button class="new-btn" id="newBtn" type="button">${ICONS.plus} Новый чат</button>
    </header>
    <div class="banner" id="banner" role="status" hidden></div>
    <nav class="chat-list" id="chatList"></nav>
    <footer class="side-foot">
      <button class="me" id="meBox" type="button" aria-label="Профиль и настройки"></button>
      <button class="icon-btn theme-btn" id="themeBtn" type="button"></button>
    </footer>
  </aside>

  <main class="conv">
    <section class="empty" id="convEmpty">
      <div>
        ${APP_ICON_HERO}
        <h2>Не развод, а мессенджер</h2>
        <p>Выберите чат слева или заведите новый — позовите друзей и болтайте в реальном времени.</p>
        <button class="btn primary" id="emptyNewBtn" type="button">Создать чат</button>
      </div>
    </section>

    <section class="conv-main" id="convMain" hidden>
      <header class="conv-head">
        <button class="icon-btn back" id="backBtn" type="button" aria-label="К списку чатов">${ICONS.back}</button>
        <button class="head-btn" id="headBtn" type="button" aria-label="О чате">
          <span class="conv-emoji" id="convEmoji" aria-hidden="true"></span>
          <span class="conv-title">
            <span class="conv-name" id="convName"></span>
            <span class="conv-sub" id="convSub" aria-live="polite"></span>
          </span>
        </button>
      </header>
      <div class="feed" id="feed" role="log" aria-label="Сообщения"></div>
      <button class="jump" id="jumpBtn" type="button" hidden>Новые сообщения ↓</button>
      <div class="rec-stage" id="recStage" hidden></div>
      <div class="composer" id="composer">
        <p class="composer-note" id="composerNote" hidden>Это канал: писать могут только авторы. А реакции — пожалуйста 🔥</p>
        <div class="sticker-panel" id="stickerPanel" role="dialog" aria-label="Стикеры" hidden></div>
        <div class="sticker-suggest" id="stickerSuggest" role="listbox" aria-label="Стикеры к эмодзи" hidden></div>
        <div class="composer-inner">
          <button class="cbtn" id="stickerBtn" type="button" aria-label="Стикеры" title="Стикеры" aria-expanded="false" aria-controls="stickerPanel">${ICONS.sticker}</button>
          <textarea class="input" id="input" rows="1" maxlength="${MAX_LEN}" placeholder="Сообщение" aria-label="Сообщение"></textarea>
          <div class="rec-bar" id="recBar" hidden></div>
          <button class="send" id="sendBtn" type="button" aria-label="Отправить" disabled hidden>${ICONS.send}</button>
          <button class="rec-btn" id="recBtn" type="button"></button>
        </div>
      </div>
    </section>
  </main>
</div>

<dialog id="newDlg" aria-labelledby="newDlgTitle">
  <h2 id="newDlgTitle">Новый чат</h2>
  <form class="find-form" id="findForm" novalidate>
    <label class="fld" for="findUser">Написать человеку</label>
    <div class="invite">
      <input class="txt" id="findUser" maxlength="64" autocomplete="off" autocapitalize="off" spellcheck="false"
        enterkeyhint="search" placeholder="Имя или @username">
      <button class="btn ghost small" id="findBtn" type="submit">Найти</button>
    </div>
    <div id="findResult"></div>
  </form>
  <div class="hr" style="margin:18px 0 16px"></div>
  <span class="fld" style="font-size:15px;color:var(--text);margin-bottom:10px">Или создайте группу</span>
  <label class="fld" for="chatName">Название</label>
  <input class="txt" id="chatName" maxlength="40" autocomplete="off" placeholder="Например, Мемы отдела">
  <p class="err" id="chatErr"></p>
  <span class="fld" id="emojiLbl">Значок</span>
  <div class="emoji-grid" id="emojiGrid" role="group" aria-labelledby="emojiLbl"></div>
  <div class="dlg-actions">
    <button class="btn ghost" id="cancelBtn" type="button">Отмена</button>
    <button class="btn primary" id="createBtn" type="button">Создать группу</button>
  </div>
</dialog>
<dialog id="profileDlg" aria-label="Профиль"></dialog>
<dialog id="chatDlg" aria-label="О чате"></dialog>
<dialog id="personDlg" aria-label="Профиль участника"></dialog>
<dialog id="joinDlg" aria-label="Приглашение в чат"></dialog>
`;

// Локальное состояние интерфейса
const U = {
  stick: true,
  openMsg: null as string | null,
  lastCount: 0,
  armedDelete: null as string | null,
  drafts: new Map<string, string>(),
  restoreScroll: null as { height: number; top: number } | null,
  /** Картинки стикеров открытого чата: не пересоздаём при каждой перерисовке (без мигания). */
  stickerImgs: new Map<string, HTMLImageElement>(),
};
let unsubs: (() => void)[] = [];
let mounted = false;
let recUI: RecordUI | null = null;

// ---------------------------------------------------------------------------
// Кто есть кто
// ---------------------------------------------------------------------------

type Who = { id: string | null; name: string; avatar: string | null; color: string | null; brand?: boolean };

function who(uid: string | null | undefined, kind: string = 'text'): Who {
  if (kind === 'system') return { id: null, name: 'СКАМ', avatar: null, color: null, brand: true };
  if (!uid) return { id: null, name: 'Удалённый аккаунт', avatar: null, color: null };
  const p = S.profiles.get(uid);
  const name = p?.name || (uid === meId() ? 'Вы' : 'Участник');
  return { id: uid, name, avatar: avatarUrl(p?.avatar_path), color: p?.color ?? null };
}

function avatarEl(w: Who, cls = '', clickable = false): HTMLElement {
  let node: HTMLElement;
  if (w.brand) {
    node = el('div', `av brand ${cls}`);
    node.append(html(BRAND_SVG));
    return node;
  }
  const tag = clickable && w.id ? 'button' : 'div';
  node = el(tag, `av ${cls}`);
  if (w.avatar) {
    const img = el('img');
    img.src = w.avatar;
    img.alt = '';
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block';
    node.append(img);
  } else {
    node.textContent = (w.name || '?').trim().charAt(0).toUpperCase() || '?';
    if (w.color) node.style.background = w.color;
  }
  if (tag === 'button') {
    (node as HTMLButtonElement).type = 'button';
    node.setAttribute('aria-label', `Профиль: ${w.name}`);
    node.addEventListener('click', (ev) => { ev.stopPropagation(); openPerson(w.id!); });
  }
  return node;
}
const BRAND_SVG = '<svg viewBox="0 0 200 200" aria-hidden="true"><circle cx="100" cy="100" r="100" fill="url(#skamGrad)"/><use href="#skamMark" x="58" y="52" width="84" height="91.7" fill="#0E0E10"/></svg>';

function personAvatar(uid: string | null, cls = '', clickable = false): HTMLElement {
  const wrap = el('span', 'person-av');
  wrap.append(avatarEl(who(uid), cls, clickable));
  if (uid && uid !== meId() && isOnline(S.profiles.get(uid))) {
    const d = el('span', 'on-dot');
    d.setAttribute('aria-label', 'в сети');
    wrap.append(d);
  }
  return wrap;
}

function chatTitle(c: MyChat): string {
  if (c.kind === 'direct') return c.peer_id ? who(c.peer_id).name : 'Личный чат';
  return c.name ?? 'Без названия';
}

/** Можно ли мне писать в этот чат (в канал — только авторам). */
function canPost(c: MyChat | null): boolean {
  return !!c && (c.kind !== 'channel' || c.role === 'owner');
}

/** Живой канал (presence, «печатает…») нужен только там, где переписываются люди. */
function isConversation(c: MyChat | null | undefined): boolean {
  return !!c && (c.kind === 'group' || c.kind === 'direct');
}

function brandAvatar(cls = ''): HTMLElement {
  const node = el('div', `av brand ${cls}`);
  node.append(html(BRAND_SVG));
  return node;
}


function errText(e: unknown, fallback = 'Не получилось. Проверьте соединение и попробуйте ещё раз.'): string {
  const err = e as { code?: string; message?: string } | null;
  if (!err) return fallback;
  if (err.message?.includes('Failed to fetch')) return 'Нет связи с сервером.';
  if (err.code === '42501' || err.message?.includes('row-level security')) return 'Недостаточно прав для этого действия.';
  if (err.code === 'P0002') return 'Не найдено.';
  if (err.message && /^[А-Яа-яЁё]/.test(err.message)) return err.message;
  return fallback;
}

function convVisible(): boolean {
  return !!S.cur && (wideMQ.matches || document.body.classList.contains('chat-open'));
}

function currentChat(): MyChat | null {
  return S.cur ? S.chats.get(S.cur) ?? null : null;
}

function setBanner(text: string | null): void {
  const b = $('banner');
  b.textContent = text ?? '';
  b.hidden = !text;
}

// ---------------------------------------------------------------------------
// Боковая панель
// ---------------------------------------------------------------------------

/** Как сообщение выглядит в списке чатов: текст, «👋 Стикер», «Голосовое сообщение»… */
function kindText(kind: string | null, body: string | null): string {
  switch (kind) {
    case 'sticker': return `${body ? `${body} ` : ''}Стикер`;
    case 'voice': return 'Голосовое сообщение';
    case 'video_note': return 'Кружочек';
    case 'e2e': return '🔒 Зашифрованное сообщение';
    case 'media': return body ? `📎 ${body}` : '📎 Вложение';
    default: return body || '…';
  }
}

function previewText(c: MyChat): string {
  if (!c.last_id) return c.kind === 'direct' ? 'Напишите первым' : 'Пока пусто';
  if (c.last_deleted) return 'Сообщение удалено';
  const t = kindText(c.last_kind, c.last_body).replace(/\s+/g, ' ');
  if (c.kind === 'channel') return t;
  if (c.last_user_id === meId()) return `Вы: ${t}`;
  if (c.kind === 'group' && c.last_kind !== 'system') return `${who(c.last_user_id).name}: ${t}`;
  return t;
}

function renderSide(): void {
  const list = $('chatList');
  if (!S.chatsLoaded) {
    list.replaceChildren(el('p', 'list-empty', 'Загружаем чаты…'));
    return;
  }
  const chats = sortedChats();
  if (!chats.length) {
    list.replaceChildren(el('p', 'list-empty', 'Чатов пока нет. Нажмите «Новый чат», чтобы завести первый.'));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const c of chats) {
    const b = el('button', 'chat');
    b.type = 'button';
    const active = c.id === S.cur && convVisible();
    if (active) b.setAttribute('aria-current', 'true');
    let tile: HTMLElement;
    if (c.kind === 'direct') {
      tile = el('span', 'tile person');
      tile.append(avatarEl(who(c.peer_id)));
      if (c.peer_id && isOnline(S.profiles.get(c.peer_id))) tile.append(el('span', 'on-dot'));
    } else if (c.kind === 'bot') {
      tile = el('span', 'tile person');
      tile.append(brandAvatar());
    } else {
      tile = el('span', 'tile', c.emoji);
    }
    b.append(
      tile,
      el('span', 'name', chatTitle(c)),
      el('span', 'time', c.last_at ? listTime(ts(c.last_at)) : ''),
      el('span', 'preview', previewText(c)),
    );
    if (c.unread && !active) {
      const d = el('span', 'badge', c.unread > 99 ? '99+' : String(c.unread));
      d.setAttribute('aria-label', plural(c.unread, 'новое сообщение', 'новых сообщения', 'новых сообщений'));
      b.append(d);
      b.classList.add('unread');
    }
    b.addEventListener('click', () => openChat(c.id));
    frag.append(b);
  }
  list.replaceChildren(frag);
}

/** Внизу слева — только я: имя и мой статус. Списка «кто ещё в сети» нет. */
function renderMe(): void {
  const box = $('meBox');
  if (!S.me) { box.replaceChildren(); return; }
  const text = el('span', 'me-text');
  // Пока приложение открыто, мы «в сети» (сервер узнаёт об этом из пульса ping).
  const on = navigator.onLine !== false;
  const st = el('span', `me-st${on ? ' on' : ''}`);
  if (on) st.append(el('span', 'pulse'));
  st.append(on ? 'в сети' : 'нет подключения');
  text.append(el('span', 'nm', S.me.name || 'Без имени'), st);
  box.replaceChildren(avatarEl(who(meId())), text);
}

function effectiveTheme(): 'light' | 'dark' {
  const t = getTheme();
  if (t !== 'auto') return t;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function renderThemeBtn(): void {
  const btn = $('themeBtn');
  const dark = effectiveTheme() === 'dark';
  btn.replaceChildren(html(dark ? ICONS.sun : ICONS.moon));
  const label = dark ? 'Включить светлую тему' : 'Включить тёмную тему';
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

function updateTitle(): void {
  const n = totalUnread();
  document.title = n ? `(${n}) СКАМ` : 'СКАМ';
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  if (n) nav.setAppBadge?.(n).catch(() => {});
  else nav.clearAppBadge?.().catch(() => {});
}

// ---------------------------------------------------------------------------
// Беседа
// ---------------------------------------------------------------------------

function renderConv(): void {
  const c = currentChat();
  $('convMain').hidden = !c;
  $('convEmpty').hidden = !!c;
  const ro = !!c && !canPost(c);
  $('composer').classList.toggle('readonly', ro);
  $('composerNote').hidden = !ro;
  if (ro) { closeStickers(); recUI?.cancel(); }
  updateSendBtn();
}

function renderHead(): void {
  const c = currentChat();
  if (!c) return;
  const emoji = $('convEmoji');
  if (c.kind === 'direct' || c.kind === 'bot') {
    emoji.replaceChildren(c.kind === 'bot' ? brandAvatar() : personAvatar(c.peer_id));
    emoji.style.border = '0';
    emoji.style.background = 'transparent';
  } else {
    emoji.replaceChildren(c.emoji);
    emoji.style.border = '';
    emoji.style.background = '';
  }
  $('convName').textContent = chatTitle(c);

  const sub = $('convSub');
  const typers = [...S.typing.keys()].filter((k) => k !== meId());
  if (typers.length) {
    const names = typers.map((k) => who(k).name);
    const doing = (uid: string) => {
      const a = S.typingWhat.get(uid);
      return a === 'voice' ? 'записывает голосовое…' : a === 'video_note' ? 'записывает кружочек…' : 'печатает…';
    };
    let t: string;
    if (c.kind === 'direct') t = doing(typers[0]);
    else if (names.length === 1) t = `${names[0]} ${doing(typers[0])}`;
    else if (names.length === 2) t = `${names[0]} и ${names[1]} печатают…`;
    else t = 'Несколько человек печатают…';
    sub.textContent = t;
    sub.classList.add('typing');
    return;
  }
  sub.classList.remove('typing');
  if (c.kind === 'direct') {
    // Как в Telegram: «в сети» или «был(а) в сети …».
    const peer = c.peer_id ? S.profiles.get(c.peer_id) : null;
    sub.textContent = statusText(peer);
    sub.classList.toggle('online', isOnline(peer));
    return;
  }
  sub.classList.remove('online');
  if (c.kind === 'bot') { sub.textContent = 'бот'; return; }
  if (c.kind === 'channel') {
    sub.textContent = `канал · ${plural(c.member_count, 'подписчик', 'подписчика', 'подписчиков')}`;
    return;
  }
  // Группа: «5 участников, 2 в сети» — считаем только участников этого чата.
  const members = S.members.get(c.id) ?? [];
  const onlineMembers = members.filter((m) => isOnline(S.profiles.get(m.user_id))).length;
  const parts = [plural(c.member_count, 'участник', 'участника', 'участников')];
  if (onlineMembers > 0) parts.push(`${onlineMembers} в сети`);
  sub.textContent = parts.join(', ');
}

function reactionCounts(m: Msg) {
  const list = S.reactions.get(m.id) ?? [];
  return REACTIONS.map((R) => {
    const rs = list.filter((r) => r.emoji === R.k);
    return { k: R.k, e: R.e, n: rs.length, on: rs.some((r) => r.user_id === meId()), who: rs.map((r) => who(r.user_id).name) };
  }).filter((x) => x.n > 0);
}

/** Только что пришедший стикер «подпрыгивает», старые — нет. */
function fresh(m: Msg): boolean {
  return !!m.pending || Date.now() - ts(m.created_at) < 15_000;
}

function stickerEl(m: Msg): HTMLElement {
  const s = findSticker(m.sticker);
  if (!s) return el('span', 'sticker-missing', kindText('sticker', m.body));
  let img = U.stickerImgs.get(m.id);
  if (!img || img.dataset.ref !== s.ref) {
    img = el('img', `sticker-img${fresh(m) ? ' pop' : ''}`);
    img.dataset.ref = s.ref;
    img.src = stickerUrl(s.ref);
    img.alt = `Стикер «${s.label}» ${s.emoji}`;
    img.title = s.label;
    img.width = img.height = 256;
    img.draggable = false;
    img.decoding = 'async';
    U.stickerImgs.set(m.id, img);
  }
  return img;
}

/** Содержимое сообщения по его виду. */
function messageBody(b: HTMLElement, m: Msg): void {
  switch (m.kind) {
    case 'sticker': b.append(stickerEl(m)); break;
    case 'voice': b.append(voiceEl(m)); break;
    case 'video_note': b.append(videoNoteEl(m)); break;
    case 'e2e':
      b.append(el('span', 'unsupported', '🔒 Зашифрованное сообщение. Эта версия СКАМ пока не умеет его показать.'));
      break;
    case 'media':
      if (m.body) { fillText(b, m.body); b.append(el('br')); }
      b.append(el('span', 'unsupported', '📎 Вложение. Эта версия СКАМ пока не умеет его показать.'));
      break;
    default: fillText(b, m.body);
  }
}

/** Долгое нажатие на телефоне открывает реакции и «Удалить» (обычное касание кружочка его включает). */
function longPress(target: HTMLElement, open: () => void): void {
  let timer = 0;
  let fired = false;
  let at = { x: 0, y: 0 };
  const stop = () => clearTimeout(timer);
  target.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    fired = false;
    at = { x: e.clientX, y: e.clientY };
    timer = window.setTimeout(() => { fired = true; open(); navigator.vibrate?.(8); }, 450);
  });
  target.addEventListener('pointermove', (e) => { if (Math.hypot(e.clientX - at.x, e.clientY - at.y) > 10) stop(); });
  target.addEventListener('pointerup', stop);
  target.addEventListener('pointercancel', stop);
  target.addEventListener('click', (e) => {
    if (!fired) return;
    fired = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

function renderMsg(m: Msg, first: boolean, readUpTo: number, chat: MyChat): HTMLElement {
  const channel = chat.kind === 'channel';
  const own = m.user_id === meId() && m.kind !== 'system';
  // В канале посты публикуются от имени канала и стоят слева.
  const mine = own && !channel;
  const deleted = !!m.deleted_at;
  // Стикер и кружочек — без «пузыря», время поверх картинки.
  const bare = !deleted && (m.kind === 'sticker' || m.kind === 'video_note');
  const row = el('div', `row${mine ? ' mine' : ''}${first ? ' first' : ''}${bare ? ' bare' : ''}`);
  row.dataset.id = m.id;
  if (U.openMsg === m.id) row.classList.add('open');
  const w: Who = channel ? { id: null, name: chat.name ?? 'Канал', avatar: null, color: null, brand: true } : who(m.user_id, m.kind);
  const slot = el('div', 'avslot');
  if (first && !mine) slot.append(avatarEl(w, '', true));
  row.append(slot);

  const wrap = el('div', 'bwrap');
  const kindCls = deleted ? '' : m.kind === 'voice' ? ' voice-msg' : bare ? ` media ${m.kind}` : '';
  const b = el('div', `bubble${kindCls}${deleted ? ' deleted' : ''}${m.pending ? ' pending' : ''}${m.failed ? ' failed' : ''}`);
  if (first && !mine) {
    const a = el(w.id ? 'button' : 'span', 'author', w.name);
    if (a instanceof HTMLButtonElement) {
      a.type = 'button';
      a.addEventListener('click', (ev) => { ev.stopPropagation(); openPerson(w.id!); });
    }
    if (w.brand) a.style.color = 'var(--ink)';
    else if (w.color) a.style.color = w.color;
    b.append(a);
  }
  if (deleted) b.append('Сообщение удалено');
  else messageBody(b, m);
  const meta = el('span', `meta${bare ? ' pill' : ''}`, timeLabel(ts(m.created_at)));
  meta.title = new Date(ts(m.created_at)).toLocaleString('ru-RU');
  if (mine && !deleted && !m.failed) {
    const read = !m.pending && readUpTo >= ts(m.created_at);
    const tick = el('span', `tick${read ? ' read' : ''}`, m.pending ? '✓' : read ? '✓✓' : '✓');
    tick.setAttribute('aria-label', m.pending ? 'отправляется' : read ? 'прочитано' : 'доставлено');
    if (m.pending) tick.style.opacity = '.45';
    meta.append(tick);
  }
  b.append(meta);
  wrap.append(b);

  if (m.failed) {
    const r = el('div', 'retry');
    r.append(
      el('span', null, 'Не отправлено.'),
      button(null, 'Повторить', () => { retryMessage(m).catch((e) => toast(errText(e))); }),
      button(null, 'Убрать', () => discardMessage(m)),
    );
    wrap.append(r);
  }

  if (!deleted && !m.pending && !m.failed) {
    const counts = reactionCounts(m);
    if (counts.length) {
      const rs = el('div', 'reacts');
      counts.forEach((c) => {
        const chip = el('button', `chip${c.on ? ' on' : ''}`);
        chip.type = 'button';
        chip.append(el('span', 'e', c.e), el('span', 'n', String(c.n)));
        chip.setAttribute('aria-label', `${c.e} ${c.n}`);
        chip.setAttribute('aria-pressed', String(c.on));
        chip.title = c.who.join(', ');
        chip.addEventListener('click', () => react(m, c.k));
        rs.append(chip);
      });
      wrap.append(rs);
    }
    b.tabIndex = 0;
    const act = el('div', 'actions');
    REACTIONS.forEach((R) => {
      const btn = button(null, R.e, (ev) => { ev.stopPropagation(); U.openMsg = null; react(m, R.k); });
      btn.setAttribute('aria-label', `Реакция ${R.e}`);
      act.append(btn);
    });
    if (own) {
      const armed = U.armedDelete === m.id;
      const del = button('del', armed ? 'Точно?' : 'Удалить', (ev) => {
        ev.stopPropagation();
        if (U.armedDelete !== m.id) {
          U.armedDelete = m.id;
          del.textContent = 'Точно?';
          setTimeout(() => { if (U.armedDelete === m.id) { U.armedDelete = null; emit('feed'); } }, 3000);
          return;
        }
        U.armedDelete = null;
        U.openMsg = null;
        deleteMessage(m).catch((e) => toast(errText(e, 'Не получилось удалить сообщение.')));
      });
      act.append(del);
    }
    row.append(act);
    const toggleActions = (force?: boolean) => {
      U.openMsg = (force ?? U.openMsg !== m.id) ? m.id : null;
      document.querySelectorAll('.row.open').forEach((r) => r.classList.remove('open'));
      if (U.openMsg) row.classList.add('open');
    };
    b.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('a,button,.wave') || !touchMQ.matches) return;
      toggleActions();
    });
    longPress(b, () => toggleActions(true));
  }
  row.append(wrap);
  return row;
}

function react(m: Msg, key: ReactionKey): void {
  toggleReaction(m, key).catch((e) => toast(errText(e, 'Не получилось поставить реакцию.')));
}

function renderFeed(): void {
  const c = currentChat();
  if (!c) return;
  const f = feedOf(c.id);
  const feed = $('feed');
  const inner = el('div', 'feed-inner');

  if (f.loaded && f.hasMore) {
    inner.append(button('older', f.loadingOlder ? 'Загружаем…' : 'Показать более ранние', () => requestOlder()));
  }
  if (!f.loaded) {
    inner.append(el('p', 'feed-note', 'Загружаем сообщения…'));
  } else if (f.error && !f.msgs.length) {
    inner.append(el('p', 'feed-note', 'Не удалось загрузить сообщения.'));
  } else if (!f.msgs.length) {
    const q = el('div', 'quiet');
    if (c.kind === 'direct' || c.kind === 'bot') {
      q.append(el('strong', null, 'Здесь пока тихо'), 'Напишите первое сообщение — обещаем, это не развод.');
    } else if (c.kind === 'channel') {
      q.append(el('strong', null, 'Новостей пока нет'), 'Как только появятся — они будут здесь.');
    } else {
      q.append(el('strong', null, 'Здесь пока тихо'), 'Напишите первое сообщение или позовите друзей по ссылке.');
      if (c.invite_code) q.append(el('br'), button('btn primary small', 'Пригласить', () => shareInvite(c)));
    }
    inner.append(q);
  }

  // ✓✓: сообщение прочитал хотя бы один собеседник; в чате с ботом — бот ответил.
  const others = (S.members.get(c.id) ?? []).filter((m) => m.user_id !== meId());
  const botSeen = c.kind === 'bot' ? f.msgs.filter((m) => m.kind === 'system').map((m) => ts(m.created_at)) : [];
  const readUpTo = Math.max(0, ...others.map((m) => ts(m.last_read_at)), ...botSeen);
  let prev: Msg | null = null;
  for (const m of f.msgs) {
    const t = ts(m.created_at);
    if (!prev || dayKey(ts(prev.created_at)) !== dayKey(t)) {
      inner.append(el('div', 'day', dayLabel(t)));
      prev = null;
    }
    const sameAuthor = c.kind === 'channel' || (prev?.user_id === m.user_id && (prev.kind === 'system') === (m.kind === 'system'));
    const first = !prev || !sameAuthor || t - ts(prev.created_at) > 5 * 60 * 1000;
    inner.append(renderMsg(m, first, readUpTo, c));
    prev = m;
  }

  const keepFocus = document.activeElement && feed.contains(document.activeElement);
  feed.replaceChildren(inner);
  if (keepFocus) $('input').focus({ preventScroll: true });
  if (U.restoreScroll) {
    feed.scrollTop = feed.scrollHeight - U.restoreScroll.height + U.restoreScroll.top;
    U.restoreScroll = null;
  } else if (U.stick) {
    feed.scrollTop = feed.scrollHeight;
  } else if (f.msgs.length > U.lastCount && U.lastCount > 0) {
    $('jumpBtn').hidden = false;
  }
  U.lastCount = f.msgs.length;
  markVisibleRead();
}

function requestOlder(): void {
  const id = S.cur;
  if (!id) return;
  const f = feedOf(id);
  if (!f.hasMore || f.loadingOlder) return;
  const feed = $('feed');
  const before = { height: feed.scrollHeight, top: feed.scrollTop };
  loadOlder(id)
    .then(() => { if (S.cur === id) { U.restoreScroll = { height: before.height, top: feed.scrollTop }; emit('feed'); } })
    .catch(() => toast('Не удалось загрузить историю.'));
}

function markVisibleRead(): void {
  const id = S.visibleChat();
  if (id && feedOf(id).loaded) markRead(id);
}

// ---------------------------------------------------------------------------
// Открытие чатов, навигация
// ---------------------------------------------------------------------------

function openChat(id: string, opts: { silent?: boolean } = {}): void {
  const inp = $<HTMLTextAreaElement>('input');
  if (S.cur !== id) {
    if (S.cur) U.drafts.set(S.cur, inp.value);
    stopTyping();
    recUI?.cancel();
    closeStickers();
    stopVoice();
    dropNotes(id);
    U.stickerImgs.clear();
    S.cur = id;
    U.stick = true;
    U.openMsg = null;
    U.armedDelete = null;
    U.lastCount = 0;
    $('jumpBtn').hidden = true;
    lsSet('skam:last', id);
    inp.value = U.drafts.get(id) ?? '';
    loadFeed(id).catch(() => toast('Не удалось загрузить сообщения.'));
  }
  joinChatChannel(isConversation(S.chats.get(id)) ? id : null);
  if (!wideMQ.matches && !document.body.classList.contains('chat-open')) {
    history.pushState({ skamChat: id }, '');
  }
  document.body.classList.add('chat-open');
  renderAll();
  autosize();
  if (!opts.silent && !touchMQ.matches && canPost(currentChat())) inp.focus();
}

function backToList(fromHistory = false): void {
  stopTyping();
  recUI?.cancel();
  closeStickers();
  stopVoice();
  document.body.classList.remove('chat-open');
  if (!wideMQ.matches) joinChatChannel(null);
  if (!fromHistory && history.state?.skamChat) history.back();
  renderAll();
}

function autoOpen(): void {
  if (S.cur || !wideMQ.matches || !S.chats.size) return;
  const saved = lsGet('skam:last');
  const target = saved && S.chats.has(saved) ? saved : sortedChats()[0].id;
  openChat(target, { silent: true });
}

function closeMissingChat(): void {
  if (S.cur && S.chatsLoaded && !S.chats.has(S.cur)) {
    S.cur = null;
    joinChatChannel(null);
    document.body.classList.remove('chat-open');
    closeDialog($<HTMLDialogElement>('chatDlg'));
    renderConv();
  }
}

function renderAll(): void {
  renderSide();
  renderMe();
  renderThemeBtn();
  renderConv();
  renderHead();
  renderFeed();
}

// ---------------------------------------------------------------------------
// Композер
// ---------------------------------------------------------------------------

function autosize(): void {
  const inp = $<HTMLTextAreaElement>('input');
  inp.style.height = 'auto';
  if (inp.scrollHeight > 0) inp.style.height = `${Math.min(inp.scrollHeight + 3, 160)}px`;
  updateSendBtn();
}

/** Есть текст — кнопка «Отправить», пусто — микрофон/кружочек (как в Telegram). */
function updateSendBtn(): void {
  const has = !!$<HTMLTextAreaElement>('input').value.trim();
  const sendBtn = $<HTMLButtonElement>('sendBtn');
  sendBtn.disabled = !currentChat() || !has;
  sendBtn.hidden = !has;
  $('recBtn').hidden = has;
  updateSuggest();
}

let typingIdle: number | undefined;
function onType(): void {
  if (!S.cur || !isConversation(currentChat())) return;
  if (!$<HTMLTextAreaElement>('input').value.trim()) { stopTyping(); return; }
  sendTyping(true);
  clearTimeout(typingIdle);
  typingIdle = window.setTimeout(stopTyping, 3000);
}
function stopTyping(): void {
  clearTimeout(typingIdle);
  sendTyping(false);
}

async function send(): Promise<void> {
  const inp = $<HTMLTextAreaElement>('input');
  const text = inp.value.trim();
  const id = S.cur;
  if (!text || !id) return;
  if (text.length > MAX_LEN) { toast(`Слишком длинное сообщение — до ${MAX_LEN} символов.`); return; }
  inp.value = '';
  U.drafts.delete(id);
  autosize();
  stopTyping();
  U.stick = true;
  try {
    await sendMessage(id, text);
  } catch (e) {
    toast(errText(e, 'Сообщение не отправилось. Нажмите «Повторить».'));
  }
}

// ---------------------------------------------------------------------------
// Стикеры, голосовые и кружочки
// ---------------------------------------------------------------------------

function stickerButton(s: Sticker, cls: string, onPick: (s: Sticker) => void): HTMLButtonElement {
  const b = button(cls, null, () => onPick(s));
  const img = el('img');
  img.src = stickerUrl(s.ref);
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.draggable = false;
  b.append(img);
  b.title = `${s.label} ${s.emoji}`;
  b.setAttribute('aria-label', `Стикер «${s.label}» ${s.emoji}`);
  return b;
}

function renderStickerPanel(): void {
  const panel = $('stickerPanel');
  const tabs = el('div', 'sp-tabs');
  tabs.setAttribute('aria-label', 'Наборы стикеров');
  const body = el('div', 'sp-body');
  const section = (id: string, title: string, list: Sticker[], badge?: string) => {
    const sec = el('section', 'sp-sec');
    sec.id = `sp-${id}`;
    const h = el('h3', 'sp-title', title);
    if (badge) h.append(el('span', 'sp-badge', badge));
    const grid = el('div', 'sp-grid');
    list.forEach((st) => grid.append(stickerButton(st, 'sp-item', (x) => void pickSticker(x))));
    sec.append(h, grid);
    body.append(sec);
  };
  const tab = (id: string, label: string, content: Node) => {
    const t = button('sp-tab', null, () => {
      document.getElementById(`sp-${id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    t.setAttribute('aria-label', label);
    t.title = label;
    t.append(content);
    tabs.append(t);
  };
  const recent = recentStickers();
  if (recent.length) {
    section('recent', 'Недавние', recent);
    tab('recent', 'Недавние', html('<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'));
  }
  for (const p of PACKS) {
    section(p.id, p.title, p.stickers, p.official ? 'официальные' : undefined);
    const cover = el('img');
    cover.src = stickerUrl(p.stickers[0].ref);
    cover.alt = '';
    tab(p.id, p.title, cover);
  }
  panel.replaceChildren(tabs, body);
}

function stickersOpen(): boolean {
  return !$('stickerPanel').hidden;
}

function openStickers(): void {
  if (!canPost(currentChat())) return;
  renderStickerPanel();
  $('stickerPanel').hidden = false;
  $('stickerBtn').setAttribute('aria-expanded', 'true');
  $('stickerBtn').classList.add('on');
  hideSuggest();
}

function closeStickers(): void {
  const p = document.getElementById('stickerPanel');
  if (!p || p.hidden) return;
  p.hidden = true;
  $('stickerBtn').setAttribute('aria-expanded', 'false');
  $('stickerBtn').classList.remove('on');
}

async function pickSticker(st: Sticker, fromSuggest = false): Promise<void> {
  const id = S.cur;
  if (!id || !canPost(currentChat())) return;
  rememberSticker(st.ref);
  closeStickers();
  hideSuggest();
  if (fromSuggest) {
    const inp = $<HTMLTextAreaElement>('input');
    inp.value = '';
    U.drafts.delete(id);
    autosize();
    stopTyping();
  }
  U.stick = true;
  try {
    await sendSticker(id, st);
  } catch (e) {
    toast(errText(e, 'Стикер не отправился. Нажмите «Повторить».'));
  }
}

// Подсказки: набрали одно эмодзи — предлагаем стикеры с ним.
function hideSuggest(): void {
  const box = document.getElementById('stickerSuggest');
  if (box) box.hidden = true;
}

function updateSuggest(): void {
  const box = document.getElementById('stickerSuggest');
  const inp = document.getElementById('input') as HTMLTextAreaElement | null;
  if (!box || !inp) return;
  const list = canPost(currentChat()) && !stickersOpen() ? stickersForEmoji(inp.value.trim()) : [];
  if (!list.length) { box.hidden = true; return; }
  box.replaceChildren(...list.slice(0, 5).map((st) => {
    const b = stickerButton(st, 'ss-item', (x) => void pickSticker(x, true));
    b.setAttribute('role', 'option');
    return b;
  }));
  box.hidden = false;
}

function sendRecording(chatId: string, kind: 'voice' | 'video_note', rec: Parameters<typeof sendRecorded>[2]): void {
  if (chatId === S.cur) U.stick = true;
  sendRecorded(chatId, kind, rec, setLocalMedia).catch((e) => {
    toast(errText(e, kind === 'voice' ? 'Голосовое не отправилось. Нажмите «Повторить».' : 'Кружочек не отправился. Нажмите «Повторить».'));
  });
}

/** Следующее голосовое после этого — играем подряд. */
function nextVoiceAfter(cur: { id: string; chatId: string }): Msg | null {
  const msgs = feedOf(cur.chatId).msgs;
  const i = msgs.findIndex((x) => x.id === cur.id);
  if (i < 0) return null;
  return msgs.slice(i + 1).find((x) => x.kind === 'voice' && !x.deleted_at && x.media_path) ?? null;
}

// ---------------------------------------------------------------------------
// Диалог «Новый чат»
// ---------------------------------------------------------------------------

let picked = EMOJIS[0];
function renderEmojiGrid(grid: HTMLElement, current: string, onPick: (e: string) => void): void {
  grid.replaceChildren();
  EMOJIS.forEach((e) => {
    const b = button(null, e, () => { onPick(e); renderEmojiGrid(grid, e, onPick); });
    b.setAttribute('aria-pressed', String(e === current));
    b.setAttribute('aria-label', `Значок ${e}`);
    grid.append(b);
  });
}

function openNew(): void {
  $<HTMLInputElement>('chatName').value = '';
  $('chatErr').textContent = '';
  $<HTMLInputElement>('findUser').value = '';
  findSeq++;
  clearTimeout(findTimer);
  showFindHint();
  picked = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
  renderEmojiGrid($('emojiGrid'), picked, (e) => { picked = e; });
  openDialog($<HTMLDialogElement>('newDlg'));
  $('findUser').focus();
}

// Поиск людей: по имени, фамилии или @username — прямо во время набора.
const FIND_HINT = 'Имя, фамилия или @username — от 2 символов.';
let findSeq = 0;
let findTimer = 0;

function showFindHint(): void {
  $('findResult').replaceChildren(el('p', 'hint', FIND_HINT));
}

/** Разбор запроса так же, как на сервере: «@» — только по @username, дальше слова. */
function parseQuery(raw: string): { at: boolean; s: string; toks: string[] } {
  const n = searchNorm(raw);
  const s = n.replace(/^@+/, '').replace(/\s+/g, ' ').trim();
  return { at: n.startsWith('@'), s, toks: s ? s.split(' ') : [] };
}

/** Подсветка совпавших начал слов (регистр и «ё/е» не важны). */
function highlight(text: string, toks: string[], wholeOnly = false): Node {
  const n = searchNorm(text);
  if (!toks.length || n.length !== text.length) return document.createTextNode(text);
  const on = new Array<boolean>(text.length).fill(false);
  for (let i = 0; i < n.length; i++) {
    if (i > 0 && (wholeOnly || !/[\s-]/.test(n[i - 1]))) continue;
    for (const t of toks) if (n.startsWith(t, i)) on.fill(true, i, i + t.length);
  }
  const frag = document.createDocumentFragment();
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && on[j] === on[i]) j++;
    const part = text.slice(i, j);
    frag.append(on[i] ? el('mark', null, part) : document.createTextNode(part));
    i = j;
  }
  return frag;
}

function foundRow(person: FoundUser, q: { at: boolean; s: string; toks: string[] }): HTMLElement {
  const row = el('div', 'found');
  const w: Who = { id: person.id, name: person.name ?? 'Участник', avatar: avatarUrl(person.avatar_path), color: person.color };
  const text = el('span', 'found-text');
  const nm = el('span', 'nm');
  nm.append(q.at ? document.createTextNode(w.name) : highlight(w.name, q.toks));
  const sub = el('span', 'uname');
  if (person.username) {
    sub.append('@', highlight(person.username, q.at ? [q.s] : q.toks, true));
  }
  if (person.is_contact) {
    const tag = el('span', 'found-tag');
    if (person.username) tag.append(el('span', 'sep', ' · '));
    tag.append('есть общий чат');
    sub.append(tag);
  }
  text.append(nm);
  if (sub.childNodes.length) text.append(sub);
  const isMe = person.id === meId();
  const action = isMe
    ? button('btn ghost small', 'Это вы', () => { closeDialog($<HTMLDialogElement>('newDlg')); openProfile(); })
    : button('btn primary small', 'Написать', async () => {
      action.disabled = true;
      try {
        const id = await openDirect(person.id);
        closeDialog($<HTMLDialogElement>('newDlg'));
        openChat(id);
      } catch (e) {
        toast(errText(e, 'Не получилось открыть личный чат.'));
        action.disabled = false;
      }
    });
  if (!isMe) action.setAttribute('aria-label', `Написать: ${w.name}`);
  row.append(avatarEl(w), text, action);
  return row;
}

/** Найти людей по введённому запросу. now = true — по кнопке «Найти»/Enter, иначе во время набора. */
async function runFind(now: boolean): Promise<void> {
  const out = $('findResult');
  const raw = $<HTMLInputElement>('findUser').value;
  const q = parseQuery(raw);
  const my = ++findSeq;
  clearTimeout(findTimer);
  if (!q.s) { showFindHint(); return; }
  if (q.s.length < SEARCH_MIN) {
    out.replaceChildren(el('p', now ? 'err' : 'hint', 'Введите хотя бы 2 символа.'));
    return;
  }
  if (q.at && !/^[a-z0-9_]+$/.test(q.s)) {
    out.replaceChildren(el('p', 'err', 'В @username бывают только латиница, цифры и _.'));
    return;
  }
  if (!now) {
    findTimer = window.setTimeout(() => { if (my === findSeq) void search(); }, 300);
    return;
  }
  await search();

  async function search(): Promise<void> {
    // Пока ищем, старые результаты остаются на месте — без мигания при наборе.
    if (!out.querySelector('.found')) out.replaceChildren(el('p', 'hint', 'Ищем…'));
    let found: FoundUser[];
    try {
      found = await searchUsers(raw);
    } catch (e) {
      if (my === findSeq) out.replaceChildren(el('p', 'err', errText(e, 'Не получилось найти. Попробуйте ещё раз.')));
      return;
    }
    if (my !== findSeq) return;
    if (!found.length) {
      out.replaceChildren(el('p', 'err', q.at ? `Пользователь @${q.s} не найден.` : `Никого не нашли по запросу «${raw.trim()}».`));
      return;
    }
    const list = el('div', 'found-list');
    list.setAttribute('role', 'list');
    found.forEach((p) => { const r = foundRow(p, q); r.setAttribute('role', 'listitem'); list.append(r); });
    out.replaceChildren(list);
  }
}

async function submitNew(): Promise<void> {
  const name = $<HTMLInputElement>('chatName').value.trim();
  if (!name) {
    $('chatErr').textContent = 'Введите название чата.';
    $('chatName').focus();
    return;
  }
  const btn = $<HTMLButtonElement>('createBtn');
  btn.disabled = true;
  try {
    const id = await createChat(name, picked);
    closeDialog($<HTMLDialogElement>('newDlg'));
    openChat(id);
  } catch (e) {
    $('chatErr').textContent = errText(e, 'Не получилось создать чат.');
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Профиль
// ---------------------------------------------------------------------------

function dlgHead(title: string, dlg: HTMLDialogElement, closable = true): HTMLElement {
  const head = el('div', 'dlg-head');
  head.append(el('h2', null, title));
  if (closable) {
    const x = button('icon-btn', null, () => closeDialog(dlg));
    x.setAttribute('aria-label', 'Закрыть');
    x.append(html(ICONS.close));
    head.append(x);
  }
  return head;
}

function openProfile(): void {
  const dlg = $<HTMLDialogElement>('profileDlg');
  renderProfile();
  openDialog(dlg);
}

function contactLine(): string {
  const u = S.user;
  if (!u) return '';
  if (u.phone) return `Телефон: +${u.phone.replace(/^\+/, '')}`;
  return u.email ? `Почта: ${u.email}` : '';
}

function renderProfile(): void {
  const dlg = $<HTMLDialogElement>('profileDlg');
  if (!S.me) return;
  const stack = el('div', 'stack');

  // Фото
  const avEdit = el('div', 'av-edit');
  const btns = el('div', 'btns');
  const file = el('input');
  Object.assign(file, { type: 'file', accept: 'image/*', hidden: true, id: 'avatarFile' });
  const up = button('btn ghost small', S.me.avatar_path ? 'Сменить фото' : 'Загрузить фото', () => file.click());
  btns.append(up);
  if (S.me.avatar_path) {
    btns.append(button('btn danger small', 'Убрать', async () => {
      try { await removeAvatar(); renderProfile(); } catch (e) { toast(errText(e)); }
    }));
  }
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    up.disabled = true;
    up.textContent = 'Загружаем…';
    try {
      await uploadAvatar(f);
      toast('Фото обновлено');
    } catch (e) {
      toast(errText(e, 'Не получилось загрузить фото.'));
    }
    renderProfile();
  });
  avEdit.append(avatarEl(who(meId()), 'xl'), btns, file);

  // Имя, фамилия, @username
  const keep = (id: string) => (dlg.open ? (document.getElementById(id) as HTMLInputElement | null)?.value : undefined);
  const mk = (id: string, label: string, attrs: Partial<HTMLInputElement>) => {
    const f = el('div', 'field');
    const l = el('label', 'fld', label);
    l.htmlFor = id;
    const i = el('input', 'txt');
    Object.assign(i, { id, ...attrs });
    f.append(l, i);
    return { f, i };
  };
  const first = mk('profFirst', 'Имя', { maxLength: 40, autocomplete: 'given-name', value: keep('profFirst') ?? S.me.first_name ?? '' });
  const last = mk('profLast', 'Фамилия', { maxLength: 40, autocomplete: 'family-name', placeholder: 'необязательно', value: keep('profLast') ?? S.me.last_name ?? '' });
  const user = mk('profUser', 'Имя пользователя', { maxLength: 33, autocomplete: 'username', placeholder: '@username', required: true, value: keep('profUser') ?? (S.me.username ? `@${S.me.username}` : '') });
  const UN_HINT = 'Обязательно. По нему вас находят и пишут вам. Латиница, цифры и _, от 5 символов.';
  const unHint = el('p', 'hint', UN_HINT);
  user.f.append(unHint);
  const err = el('p', 'err');
  const save = button('btn primary', 'Сохранить', () => void saveProfile());
  save.style.alignSelf = 'flex-start';

  let unOk = true;
  let seq = 0;
  let unTimer: number | undefined;
  user.i.addEventListener('input', () => {
    clearTimeout(unTimer);
    const v = normUsername(user.i.value);
    unHint.classList.remove('ok', 'bad');
    if (!v) { unOk = false; unHint.textContent = 'Имя пользователя обязательно.'; unHint.classList.add('bad'); return; }
    if (v === S.me?.username) { unOk = true; unHint.textContent = UN_HINT; return; }
    if (!USERNAME_RE.test(v)) { unOk = false; unHint.textContent = 'Только латиница, цифры и _, от 5 до 32 символов, первая — буква.'; unHint.classList.add('bad'); return; }
    unOk = false;
    unHint.textContent = 'Проверяем…';
    const my = ++seq;
    unTimer = window.setTimeout(async () => {
      const free = await usernameAvailable(v).catch(() => false);
      if (my !== seq) return;
      unOk = free;
      unHint.textContent = free ? `@${v} свободно` : `@${v} уже занято`;
      unHint.classList.add(free ? 'ok' : 'bad');
    }, 350);
  });

  async function saveProfile(): Promise<void> {
    const fn = first.i.value.trim();
    const ln = last.i.value.trim();
    const un = normUsername(user.i.value);
    if (!fn) { err.textContent = 'Введите имя — так вас увидят в чатах.'; first.i.focus(); return; }
    if (!un) { err.textContent = 'Имя пользователя обязательно — по нему вас находят.'; user.i.focus(); return; }
    if (!USERNAME_RE.test(un) || !unOk) { err.textContent = 'Выберите другое имя пользователя.'; user.i.focus(); return; }
    save.disabled = true;
    try {
      await updateMyProfile({ first_name: fn, last_name: ln || null, username: un });
      err.textContent = '';
      toast('Профиль сохранён');
    } catch (e) {
      err.textContent = (e as { code?: string }).code === '23505' ? 'Это имя пользователя уже занято.' : errText(e, 'Не получилось сохранить.');
    } finally {
      save.disabled = false;
    }
  }
  [first.i, last.i, user.i].forEach((i) => i.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void saveProfile(); }
  }));

  // Тема
  const themeField = el('div', 'field');
  themeField.append(el('span', 'fld', 'Тема'));
  const seg = el('div', 'seg');
  seg.setAttribute('role', 'group');
  const cur = getTheme();
  ([['auto', 'Как в системе'], ['light', 'Светлая'], ['dark', 'Тёмная']] as [Theme, string][]).forEach(([t, label]) => {
    const b = button(null, label, () => { setTheme(t); renderThemeBtn(); renderProfile(); });
    b.setAttribute('aria-pressed', String(t === cur));
    seg.append(b);
  });
  themeField.append(seg);

  // Выход
  const out = el('div', 'field');
  out.append(
    button('btn danger', 'Выйти из аккаунта', async () => { closeDialog(dlg); await goOffline(); void sb.auth.signOut(); }),
    el('p', 'hint', contactLine()),
  );

  stack.append(avEdit, first.f, last.f, user.f, err, save, el('div', 'hr'), themeField, el('div', 'hr'), out);
  dlg.replaceChildren(dlgHead('Профиль', dlg), stack);
}

// ---------------------------------------------------------------------------
// Карточка участника
// ---------------------------------------------------------------------------

let personUid: string | null = null;

/** Статус в открытой карточке человека обновляется вместе со всеми остальными. */
function refreshPersonStatus(): void {
  const st = document.getElementById('personSt');
  if (!personUid || !st || personUid === meId()) return;
  const p = S.profiles.get(personUid);
  st.textContent = statusText(p);
  st.classList.toggle('on', isOnline(p));
}

function openPerson(uid: string): void {
  const dlg = $<HTMLDialogElement>('personDlg');
  void ensureProfiles([uid]);
  personUid = uid;
  const p = S.profiles.get(uid);
  const w = who(uid);
  const card = el('div', 'person-card');
  const isMe = uid === meId();
  const online = isOnline(p);
  card.append(avatarEl(w, 'xl'), el('h2', null, w.name));
  if (p?.username) card.append(el('p', 'uname', `@${p.username}`));
  const st = el('p', `st${online ? ' on' : ''}`, isMe ? 'это вы' : statusText(p));
  st.id = 'personSt';
  card.append(st);
  const actions = el('div', 'dlg-actions');
  actions.append(button('btn ghost', 'Закрыть', () => closeDialog(dlg)));
  if (isMe) {
    actions.append(button('btn primary', 'Редактировать', () => { closeDialog(dlg); openProfile(); }));
  } else {
    const write = button('btn primary', 'Написать', async () => {
      write.disabled = true;
      try {
        const id = await openDirect(uid);
        closeDialog(dlg);
        closeDialog($<HTMLDialogElement>('chatDlg'));
        closeDialog($<HTMLDialogElement>('newDlg'));
        openChat(id);
      } catch (e) {
        toast(errText(e, 'Не получилось открыть личный чат.'));
        write.disabled = false;
      }
    });
    actions.append(write);
  }
  card.append(actions);
  dlg.replaceChildren(card);
  openDialog(dlg);
}

// ---------------------------------------------------------------------------
// О чате: участники, приглашение, переименование, выход
// ---------------------------------------------------------------------------

async function shareInvite(c: MyChat): Promise<void> {
  if (!c.invite_code) return;
  const link = inviteLink(c.invite_code);
  const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
  if (touchMQ.matches && nav.share) {
    try { await nav.share({ title: `Чат «${chatTitle(c)}» в СКАМ`, text: 'Заходи в чат в СКАМ:', url: link }); return; } catch { /* отменили */ }
  }
  try {
    await navigator.clipboard.writeText(link);
    toast('Ссылка-приглашение скопирована');
  } catch {
    openChatInfo();
  }
}

function openChatInfo(): void {
  const c = currentChat();
  if (!c) return;
  if (c.kind === 'direct') {
    if (c.peer_id) openPerson(c.peer_id);
    return;
  }
  if (c.kind === 'bot') {
    openBotCard();
    return;
  }
  renderChatInfo();
  openDialog($<HTMLDialogElement>('chatDlg'));
}

function openBotCard(): void {
  const dlg = $<HTMLDialogElement>('personDlg');
  const card = el('div', 'person-card');
  const p = el('p', null, 'Бот-помощник СКАМ. Напишите ему «помощь» — расскажет, что умеет.');
  p.style.margin = '0 0 18px';
  const actions = el('div', 'dlg-actions');
  actions.append(button('btn primary', 'Понятно', () => closeDialog(dlg)));
  personUid = null;
  card.append(brandAvatar('xl'), el('h2', null, 'СКАМ'), el('p', 'st', 'бот'), p, actions);
  dlg.replaceChildren(card);
  openDialog(dlg);
}

function renderChannelInfo(dlg: HTMLDialogElement, c: MyChat): void {
  const stack = el('div', 'stack');
  const row = el('div', 'chat-title-row');
  const text = el('span');
  text.append(el('strong', null, chatTitle(c)), el('br'),
    el('span', 'hint', `канал · ${plural(c.member_count, 'подписчик', 'подписчика', 'подписчиков')}`));
  row.append(el('span', 'conv-emoji', c.emoji), text);
  stack.append(row, el('p', null, 'Официальный канал СКАМ: новости, обновления и важные объявления. Читать и ставить реакции могут все, писать — только авторы.'));
  if (c.role === 'owner') stack.append(el('p', 'hint', 'Вы автор канала: ваши посты публикуются от имени канала.'));
  dlg.replaceChildren(dlgHead('О канале', dlg), stack);
}

let editEmoji = '';
function renderChatInfo(): void {
  const dlg = $<HTMLDialogElement>('chatDlg');
  const c = currentChat();
  if (c?.kind === 'channel') { renderChannelInfo(dlg, c); return; }
  if (!c || c.kind !== 'group') { closeDialog(dlg); return; }
  const owner = c.role === 'owner';
  const stack = el('div', 'stack');

  if (owner) {
    editEmoji = editEmoji && dlg.open ? editEmoji : c.emoji;
    const f = el('div', 'field');
    const lbl = el('label', 'fld', 'Название');
    lbl.htmlFor = 'editName';
    const inp = el('input', 'txt');
    const typed = dlg.open ? (document.getElementById('editName') as HTMLInputElement | null)?.value : undefined;
    Object.assign(inp, { id: 'editName', maxLength: 40, value: typed ?? c.name ?? '' });
    const grid = el('div', 'emoji-grid');
    grid.style.margin = '10px 0 0';
    renderEmojiGrid(grid, editEmoji, (e) => { editEmoji = e; });
    const err = el('p', 'err');
    const save = button('btn primary small', 'Сохранить', async () => {
      const v = inp.value.trim();
      if (!v) { err.textContent = 'Введите название.'; return; }
      try {
        await renameChat(c.id, v, editEmoji);
        toast('Сохранено');
        err.textContent = '';
      } catch (e) {
        err.textContent = errText(e);
      }
    });
    save.style.alignSelf = 'flex-start';
    f.append(lbl, inp, grid, err, save);
    stack.append(f);
  } else {
    const row = el('div', 'chat-title-row');
    row.append(el('span', 'conv-emoji', c.emoji), el('strong', null, chatTitle(c)));
    stack.append(row);
  }

  if (c.invite_code) {
    const f = el('div', 'field');
    f.append(el('span', 'fld', 'Ссылка-приглашение'));
    const box = el('div', 'invite');
    const link = el('input', 'txt');
    Object.assign(link, { readOnly: true, value: inviteLink(c.invite_code), id: 'inviteLink' });
    link.setAttribute('aria-label', 'Ссылка-приглашение');
    link.addEventListener('focus', () => link.select());
    box.append(link, button('btn ghost small', 'Копировать', async () => {
      try { await navigator.clipboard.writeText(link.value); toast('Ссылка скопирована'); } catch { link.select(); }
    }));
    f.append(box, el('p', 'hint', 'Любой, у кого есть ссылка, может вступить в чат.'));
    if (owner) {
      const reset = button('linkish', 'Сбросить ссылку', async () => {
        try { await resetInvite(c.id); renderChatInfo(); toast('Старая ссылка больше не работает'); } catch (e) { toast(errText(e)); }
      });
      reset.style.cssText = 'align-self:flex-start;margin-top:6px;font-size:13px';
      f.append(reset);
    }
    stack.append(f);
  }

  const members = S.members.get(c.id);
  const mf = el('div', 'field');
  mf.append(el('span', 'fld', `Участники · ${c.member_count}`));
  if (!members) {
    mf.append(el('p', 'hint', 'Загружаем…'));
  } else {
    const ul = el('ul', 'members');
    const onl = (uid: string) => uid === meId() || isOnline(S.profiles.get(uid));
    const seen = (uid: string) => Date.parse(S.profiles.get(uid)?.last_seen_at ?? '') || 0;
    const sorted = [...members].sort((a, b) =>
      Number(onl(b.user_id)) - Number(onl(a.user_id))
      || (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : 0)
      || seen(b.user_id) - seen(a.user_id)
      || who(a.user_id).name.localeCompare(who(b.user_id).name, 'ru'));
    sorted.slice(0, 200).forEach((m) => {
      const li = el('li');
      const isMe = m.user_id === meId();
      const p = S.profiles.get(m.user_id);
      const on = isMe || isOnline(p);
      const b = button(null, null, () => openPerson(m.user_id));
      const text = el('span');
      text.style.minWidth = '0';
      text.append(el('span', 'nm', isMe ? `${who(m.user_id).name} (вы)` : who(m.user_id).name), el('br'),
        el('span', `st${on ? ' on' : ''}`, isMe ? 'в сети' : statusText(p)));
      b.append(personAvatar(m.user_id), text);
      if (m.role === 'owner') b.append(el('span', 'role', 'владелец'));
      li.append(b);
      ul.append(li);
    });
    mf.append(ul);
  }
  stack.append(mf);

  if (!c.is_default) {
    const leave = button('btn danger', 'Выйти из чата', async () => {
      if (leave.dataset.armed !== '1') {
        leave.dataset.armed = '1';
        leave.textContent = owner && c.member_count > 1 ? 'Точно? Вы владелец' : 'Точно выйти?';
        return;
      }
      try {
        await leaveChat(c.id);
        closeDialog(dlg);
        toast('Вы вышли из чата');
      } catch (e) {
        toast(errText(e));
      }
    });
    leave.style.alignSelf = 'flex-start';
    stack.append(el('div', 'hr'), leave);
  }

  dlg.replaceChildren(dlgHead('О чате', dlg), stack);
}

// ---------------------------------------------------------------------------
// Приглашения ?join=КОД
// ---------------------------------------------------------------------------

async function handlePendingJoin(): Promise<void> {
  const code = lsGet('skam:join');
  if (!code) return;
  lsSet('skam:join', null);
  let info: Awaited<ReturnType<typeof previewInvite>>;
  try {
    info = await previewInvite(code);
  } catch (e) {
    toast(errText(e, 'Не получилось открыть приглашение.'));
    return;
  }
  if (!info) { toast('Приглашение не найдено или устарело.'); return; }
  if (info.is_member) { openChat(info.id); return; }
  const dlg = $<HTMLDialogElement>('joinDlg');
  const card = el('div', 'person-card');
  const tile = el('span', 'conv-emoji', info.emoji);
  tile.style.cssText = 'margin:0 auto 12px;width:72px;height:72px;font-size:36px;border-radius:22px';
  card.append(tile, el('h2', null, info.name), el('p', 'st', `Вас пригласили в чат · ${plural(info.member_count, 'участник', 'участника', 'участников')}`));
  const actions = el('div', 'dlg-actions');
  const joinBtn = button('btn primary', 'Вступить', async () => {
    joinBtn.disabled = true;
    try {
      const id = await joinByInvite(code);
      closeDialog(dlg);
      openChat(id);
      toast(`Вы вступили в «${info!.name}»`);
    } catch (e) {
      toast(errText(e, 'Не получилось вступить в чат.'));
      joinBtn.disabled = false;
    }
  });
  actions.append(button('btn ghost', 'Не сейчас', () => closeDialog(dlg)), joinBtn);
  card.append(actions);
  dlg.replaceChildren(card);
  openDialog(dlg);
}

// ---------------------------------------------------------------------------
// Монтирование
// ---------------------------------------------------------------------------

function listen<K extends keyof HTMLElementEventMap>(target: EventTarget, type: K | string, fn: (ev: HTMLElementEventMap[K]) => void): void {
  target.addEventListener(type, fn as EventListener);
  unsubs.push(() => target.removeEventListener(type, fn as EventListener));
}

function wire(): void {
  listen($('newBtn'), 'click', openNew);
  listen($('emptyNewBtn'), 'click', openNew);
  listen($('cancelBtn'), 'click', () => closeDialog($<HTMLDialogElement>('newDlg')));
  listen($('createBtn'), 'click', () => void submitNew());
  listen($('chatName'), 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void submitNew(); }
  });
  listen($('backBtn'), 'click', () => backToList());
  listen($('headBtn'), 'click', openChatInfo);
  listen($('meBox'), 'click', () => openProfile());
  listen($('sendBtn'), 'click', () => void send());
  listen($('stickerBtn'), 'click', () => { if (stickersOpen()) closeStickers(); else openStickers(); });
  const inp = $<HTMLTextAreaElement>('input');
  listen(inp, 'input', () => { autosize(); onType(); });
  listen(inp, 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touchMQ.matches) { e.preventDefault(); void send(); }
  });
  listen(inp, 'blur', () => { setTimeout(stopTyping, 800); });
  const feed = $('feed');
  listen(feed, 'scroll', () => {
    U.stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    if (U.stick) { $('jumpBtn').hidden = true; markVisibleRead(); }
    if (feed.scrollTop < 60) requestOlder();
  });
  listen($('jumpBtn'), 'click', () => {
    U.stick = true;
    feed.scrollTop = feed.scrollHeight;
    $('jumpBtn').hidden = true;
  });
  listen(document, 'visibilitychange', () => {
    if (document.visibilityState === 'visible') { renderSide(); markVisibleRead(); } else stopTyping();
  });
  listen(document, 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && stickersOpen()) { closeStickers(); $('stickerBtn').focus(); }
  });
  listen(document, 'pointerdown', (e: PointerEvent) => {
    const t = e.target as HTMLElement;
    if (stickersOpen() && !t.closest('#stickerPanel,#stickerBtn')) closeStickers();
  });
  listen(document, 'click', (e: MouseEvent) => {
    if (U.openMsg && !(e.target as HTMLElement).closest('.row')) {
      U.openMsg = null;
      document.querySelectorAll('.row.open').forEach((r) => r.classList.remove('open'));
    }
  });
  listen(window, 'popstate', () => {
    if (document.body.classList.contains('chat-open') && !wideMQ.matches && !history.state?.skamChat) backToList(true);
  });
  const onWide = () => { if (wideMQ.matches && isConversation(currentChat())) joinChatChannel(S.cur); autoOpen(); renderAll(); };
  wideMQ.addEventListener('change', onWide);
  unsubs.push(() => wideMQ.removeEventListener('change', onWide));
  listen(window, 'online', renderMe);
  listen(window, 'offline', renderMe);
  listen($('findForm'), 'submit', (e: Event) => { e.preventDefault(); void runFind(true); });
  listen($('findUser'), 'input', () => void runFind(false));
  listen($('themeBtn'), 'click', () => {
    setTheme(effectiveTheme() === 'dark' ? 'light' : 'dark');
    renderThemeBtn();
    if ($<HTMLDialogElement>('profileDlg').open) renderProfile();
  });
  const sysDark = window.matchMedia('(prefers-color-scheme: dark)');
  const onSys = () => renderThemeBtn();
  sysDark.addEventListener('change', onSys);
  unsubs.push(() => sysDark.removeEventListener('change', onSys));
  for (const id of ['newDlg', 'profileDlg', 'chatDlg', 'personDlg', 'joinDlg']) {
    const d = $<HTMLDialogElement>(id);
    listen(d, 'click', (e: MouseEvent) => { if (e.target === d) closeDialog(d); });
  }
}

function showFatal(root: HTMLElement, title: string, text: string): void {
  root.replaceChildren(html(`
    <main class="auth"><div class="auth-card">
      ${APP_ICON_HERO}
      <span class="wordmark">СКАМ</span>
      <h1></h1><p class="lead"></p>
      <button class="btn primary" type="button" id="fatalRetry">Обновить</button>
      <p class="auth-note"><button class="linkish" type="button" id="fatalOut">Выйти из аккаунта</button></p>
    </div></main>`));
  root.querySelector('h1')!.textContent = title;
  root.querySelector('.lead')!.textContent = text;
  $('fatalRetry').addEventListener('click', () => location.reload());
  $('fatalOut').addEventListener('click', () => void sb.auth.signOut());
}

const SPLASH = `
<main class="auth"><div class="auth-card">
  ${APP_ICON_HERO}
  <span class="wordmark">СКАМ</span>
  <p class="lead">Загружаем…</p>
</div></main>`;

export async function mountApp(root: HTMLElement, user: User): Promise<void> {
  mounted = true;
  root.replaceChildren(html(SPLASH));
  try {
    await loadMe(user);
  } catch (e) {
    if (!mounted) return;
    const err = e as { code?: string };
    if (e instanceof NoProfileError || err.code === 'PGRST205' || err.code === '42P01') {
      showFatal(root, 'База ещё не настроена', 'Примените SQL из supabase/migrations в Supabase → SQL Editor и обновите страницу.');
    } else {
      showFatal(root, 'Нет связи с сервером', 'Не получилось загрузить профиль. Проверьте интернет и обновите страницу.');
    }
    return;
  }
  if (!mounted) return;
  // Новый аккаунт (или старый без имени или @username) — сначала «Создание аккаунта», как в Telegram.
  // @username обязателен: без него база не даст писать сообщения.
  if (!S.me?.first_name || !S.me?.username) {
    mountRegister(root, () => { if (mounted) void mountShell(root); }, { existing: !!S.me?.first_name });
    return;
  }
  await mountShell(root);
}

async function mountShell(root: HTMLElement): Promise<void> {
  root.replaceChildren(html(SHELL));
  wire();
  setVoiceQueue(nextVoiceAfter);
  recUI = mountRecorder({
    btn: $<HTMLButtonElement>('recBtn'),
    composer: $('composer'),
    bar: $('recBar'),
    stage: $('recStage'),
    chat: () => (S.cur && canPost(currentChat()) ? S.cur : null),
    send: sendRecording,
    activity: (kind) => {
      if (!isConversation(currentChat())) return;
      if (kind) sendTyping(true, kind);
      else sendTyping(false);
    },
  });
  unsubs.push(() => { recUI?.destroy(); recUI = null; });
  S.visibleChat = () => (S.cur && convVisible() && document.visibilityState === 'visible' ? S.cur : null);
  unsubs.push(
    on('chats', () => { closeMissingChat(); renderSide(); updateTitle(); if ($<HTMLDialogElement>('chatDlg').open) renderChatInfo(); }),
    on('feed', renderFeed),
    on('head', renderHead),
    on('online', () => { renderMe(); renderSide(); if ($<HTMLDialogElement>('personDlg').open) refreshPersonStatus(); }),
    on('me', () => { renderMe(); renderSide(); }),
    on('members', () => { if ($<HTMLDialogElement>('chatDlg').open) renderChatInfo(); }),
  );
  renderAll();

  try {
    await loadChats();
  } catch {
    setBanner('Не удалось загрузить чаты. Обновите страницу.');
    S.chatsLoaded = true;
  }
  if (!mounted) return;
  autoOpen();
  renderAll();

  startRealtime((ok) => setBanner(ok ? null : 'Нет живого соединения — новые сообщения подтягиваются раз в несколько секунд.')).catch(() => {});
  void handlePendingJoin();
}

export function unmountApp(): void {
  mounted = false;
  stopTyping();
  stopVoice();
  dropNotes(null);
  U.stickerImgs.clear();
  void stopRealtime();
  unsubs.forEach((f) => f());
  unsubs = [];
  resetState();
  U.drafts.clear();
  document.body.classList.remove('chat-open');
  document.title = 'СКАМ';
  S.visibleChat = () => null;
}

// Для отладки в консоли разработчика.
if (import.meta.env.DEV) Object.assign(window, { skam: { S, sb } });
