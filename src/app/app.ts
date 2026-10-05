// Интерфейс мессенджера: список чатов, лента, композер и диалоги.
import type { User } from '@supabase/supabase-js';
import { avatarUrl, sb } from '../lib/supabase';
import type { Attachment, ChatCard, CommonGroup, Forward, MyChat, ReactionKey } from '../lib/database.types';
import {
  $, APP_ICON_HERO, BRAND_AVATAR, ICONS, LOGO, MARK_SVG, button, closeDialog, dayKey, dayLabel, dlgHead, el, errText, fillText, html,
  listTime, lsGet, lsSet, openDialog, plural, timeLabel, toast, touchMQ, verifiedMark, wideMQ,
} from '../lib/dom';
import {
  PACKS, customPacks, findSticker, recentStickers, rememberSticker, stickerUrl, stickersForEmoji, type Sticker,
} from '../lib/stickers';
import {
  loadMyPacks, mountStickerPacks, openStickerManager, openStickerPack, resetStickerPacks,
} from './stickerpacks';
import { isOnline, statusText } from '../lib/status';
import { getTheme, setTheme, type Theme } from '../lib/theme';
import { mountRegister } from './register';
import {
  NoProfileError, REACTIONS, S, USERNAME_RE, usernameRequired, deleteMessage, discardMessage, emit, ensureProfiles,
  feedOf, joinByInvite, loadFeed, loadMe, loadOlder, markRead, meId,
  normUsername, on, openDirect, previewInvite, removeAvatar, resetState, retryMessage,
  SEARCH_MIN, searchNorm, searchUsers, sendMessage, sendRecorded, sendSticker, sortedChats, toggleReaction, totalUnread, ts,
  updateMyProfile, uploadAvatar, usernameAvailable, viewKind, onUploadProgress, type Content, type FoundUser, type Msg,
  canForward, forwardMessages, forwardOf, loadQuoted, loadUntil, quotedMsg, snapOf,
  chatById, chatByUsername, editMessage, hasRight, joinChannel, loadChats, searchChats, setPreview,
  loadAppOwner, rememberProfiles, setVerified, BIO_MAX, normBio, userBio, chatMuted, peerBlocked,
} from './store';
import { NICK_MAX, loadNicknames, nickHits, nickOf, resetNicks, setNickname } from './nicks';
import {
  cardTile, countLabel, mountChatAdmin, openAddMembers, openChatInfo as openChatAdmin, openCreate, refreshChatInfo, shareLinkOf,
} from './chatadmin';
import { goOffline, joinChatChannel, sendTyping, startRealtime, stopRealtime } from './realtime';
import { dropNotes, mediaBlob, setLocalMedia, setVoiceQueue, stopVoice, videoNoteEl, voiceEl } from './media';
import { mountRecorder, type RecordUI } from './record-ui';
import * as e2e from './e2e';
import { MIN_PASSWORD, mountKeySetup, mountKeyUnlock, mountNoCrypto } from './keysetup';
import { MAX_ALBUM, cachedUrl, dropMediaUrls, thumbUrl, type Prepared } from './attach';
import * as calls from './calls';
import { call, callPreview, callRow, mountCallUI, renderCallBtns, renderCalls } from './callui';
import { openRate, openSupport, ratingShort, resetFeedback } from './feedback';
import {
  L, activeKind, folderById, folderIcon, isPinned, listChats, loadLayout, pinChat, pinsOf, reorderPins, resetLayout, setChatInFolder,
} from './layout';
import {
  emptyFolderNote, foldersOf, layoutChanged, mountFolders, openFolderEditor, openFolderSettings, renderFolderBar, type MenuItem,
} from './folders';
import { loginMethods, providerProfile, realEmail } from '../lib/oauth';
import { LEGAL_VERSION, acceptedVersion, privacyLink, termsLink } from '../lib/legal';
import { mountTerms } from './terms';
import { ST, resetStories, storyState } from '../lib/stories';
import { mountStories, openComposer, openStoriesOf, refreshStories, renderStoryStrip, ringClass, storyGrid } from './stories';
import {
  fileRow, filesLabel, mediaTile, openSendDialog, renderAttachments, sendDialogOpen, updateProgress, wireSendDialog, wireViewer,
} from './attachui';
import {
  MUTE_FOR, blockUser, commonGroups, loadPrefs, muteChat, muteLabel, notifyPrefs, resetPrefs, setNotifyPrefs,
} from './prefs';
import { askPermission, chime, mountNotify, notifyPermission, testNotify } from './notify';
import { unlock as soundUnlock } from './sounds';
import { actionTile, grp, grpLabel, grpNote, row, sheetHead, toggleRow, type IconName } from './sheet';

const MAX_LEN = 4000;

const SHELL = `
<div class="app" id="app">
  <aside class="side" id="side" aria-label="Чаты">
    <header class="side-head">
      ${LOGO}
      <span class="spacer"></span>
      <button class="icon-btn new-btn fd" id="newBtn" type="button" aria-label="Новый чат" title="Новый чат">${ICONS.edit}</button>
    </header>
    <div class="side-search" id="sideSearch" role="search">
      <span class="ss-ic" aria-hidden="true">${ICONS.search}</span>
      <input class="ss-q" id="chatSearch" type="search" maxlength="64" autocomplete="off" autocapitalize="off" spellcheck="false"
        enterkeyhint="search" placeholder="Поиск" aria-label="Поиск: чаты, группы, каналы, боты и люди" aria-controls="chatList">
      <button class="icon-btn ss-clear" id="searchClear" type="button" aria-label="Очистить поиск" hidden>${ICONS.close}</button>
    </div>
    <div class="stories" id="stories" aria-label="Истории"></div>
    <div class="story-mini" id="storyMini"></div>
    <nav class="folder-tabs" id="folderTabs" role="tablist" aria-label="Папки" hidden></nav>
    <div class="banner" id="banner" role="status" hidden></div>
    <nav class="chat-list" id="chatList" aria-label="Список чатов"></nav>
    <div class="voice-panel" id="voicePanel" hidden></div>
    <footer class="side-foot">
      <button class="me" id="meBox" type="button" aria-label="Профиль и настройки" title="Профиль и настройки"></button>
    </footer>
    <button class="side-grip" id="sideGrip" type="button" aria-label="Свернуть список чатов" title="Свернуть список"></button>
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
        <button class="icon-btn side-tgl" id="sideTgl" type="button" aria-label="Свернуть список чатов" title="Свернуть список">${ICONS.sideClose}</button>
        <span class="conv-emoji" id="convEmoji"></span>
        <button class="head-btn" id="headBtn" type="button" aria-label="О чате">
          <span class="conv-title">
            <span class="conv-name" id="convName"></span>
            <span class="conv-sub" id="convSub" aria-live="polite"></span>
          </span>
        </button>
        <button class="icon-btn head-ic" id="findBtn" type="button" aria-label="Поиск по чату" title="Поиск по чату">${ICONS.search}</button>
        <div class="call-btns" id="callBtns" hidden></div>
        <button class="icon-btn head-ic" id="headMenuBtn" type="button" aria-label="Ещё" title="Ещё" aria-haspopup="menu">${ICONS.dotsV}</button>
      </header>
      <div class="chat-find" id="chatFind" role="search" hidden>
        <span class="cf-ic" aria-hidden="true">${ICONS.search}</span>
        <input class="cf-q" id="chatFindQ" type="search" maxlength="64" autocomplete="off" spellcheck="false" enterkeyhint="search"
          placeholder="Поиск по сообщениям" aria-label="Поиск по сообщениям этого чата">
        <span class="cf-n" id="chatFindN" aria-live="polite"></span>
        <button class="icon-btn cf-btn" id="chatFindUp" type="button" aria-label="Раньше" title="Раньше (Enter)">${ICONS.up}</button>
        <button class="icon-btn cf-btn" id="chatFindDown" type="button" aria-label="Позже" title="Позже (Shift+Enter)">${ICONS.down}</button>
        <button class="icon-btn cf-btn" id="chatFindX" type="button" aria-label="Закрыть поиск" title="Закрыть (Esc)">${ICONS.close}</button>
      </div>
      <div class="call-return" id="callReturn" hidden></div>
      <section class="call-stage" id="callStage" aria-label="Звонок" hidden></section>
      <div class="feed" id="feed" role="log" aria-label="Сообщения"></div>
      <button class="jump" id="jumpBtn" type="button" hidden>Новые сообщения ↓</button>
      <div class="rec-stage" id="recStage" hidden></div>
      <div class="join-bar" id="joinBar" hidden>
        <button class="btn primary" id="joinBtn" type="button">Подписаться</button>
      </div>
      <div class="block-bar" id="blockBar" hidden></div>
      <div class="composer" id="composer">
        <p class="composer-note" id="composerNote" hidden>Это канал: писать могут только администраторы. А реакции — пожалуйста 🔥</p>
        <div class="sticker-panel" id="stickerPanel" role="dialog" aria-label="Стикеры" hidden></div>
        <div class="sticker-suggest" id="stickerSuggest" role="listbox" aria-label="Стикеры к эмодзи" hidden></div>
        <div class="select-bar" id="selectBar" hidden></div>
        <div class="reply-bar" id="replyBar" hidden></div>
        <div class="composer-inner">
          <button class="cbtn attach" id="attachBtn" type="button" aria-label="Прикрепить фото, видео или файл" title="Фото, видео или файл">${ICONS.clip}</button>
          <input type="file" id="fileInput" multiple hidden>
          <div class="input-wrap">
            <textarea class="input" id="input" rows="1" maxlength="${MAX_LEN}" placeholder="Сообщение" aria-label="Сообщение"></textarea>
            <button class="cbtn smile" id="stickerBtn" type="button" aria-label="Стикеры" title="Стикеры" aria-expanded="false" aria-controls="stickerPanel">${ICONS.smile}</button>
          </div>
          <div class="rec-bar" id="recBar" hidden></div>
          <button class="send" id="sendBtn" type="button" aria-label="Отправить" disabled hidden>${ICONS.send}</button>
          <button class="rec-btn" id="recBtn" type="button"></button>
        </div>
      </div>
      <div class="drop" id="drop" hidden>
        <div class="drop-box">${ICONS.clip}<b>Отпустите, чтобы отправить</b><span>Фото, видео и файлы до 50 МБ</span></div>
      </div>
    </section>
  </main>
</div>

<dialog id="newDlg" class="sheet new-dlg" aria-labelledby="newDlgTitle">
  <div class="nd-view" id="newHome">
    <header class="sh-head">
      <h2 class="sh-title" id="newDlgTitle">Новый чат</h2>
      <button class="sh-btn sh-x" id="cancelBtn" type="button" aria-label="Закрыть">${ICONS.close}</button>
    </header>
    <div class="grp">
      <button class="lr" id="newFindBtn" type="button"><span class="lr-ic acc">${ICONS.userPlus}</span><span class="lr-t"><span class="lr-l">Написать человеку</span></span><span class="lr-chev">${ICONS.chev}</span></button>
      <button class="lr" id="newGroupBtn" type="button"><span class="lr-ic acc">${ICONS.users}</span><span class="lr-t"><span class="lr-l">Создать группу</span></span><span class="lr-chev">${ICONS.chev}</span></button>
      <button class="lr" id="newChannelBtn" type="button"><span class="lr-ic acc">${ICONS.megaphone}</span><span class="lr-t"><span class="lr-l">Создать канал</span></span><span class="lr-chev">${ICONS.chev}</span></button>
      <button class="lr" id="newLinkBtn" type="button"><span class="lr-ic acc">${ICONS.link}</span><span class="lr-t"><span class="lr-l">Войти по ссылке</span></span><span class="lr-chev">${ICONS.chev}</span></button>
    </div>
    <div class="grp">
      <button class="lr" id="newStoryBtn" type="button"><span class="lr-ic acc">${ICONS.storyAdd}</span><span class="lr-t"><span class="lr-l">Новая история</span><span class="lr-sub">Фото, видео или текст на сутки</span></span><span class="lr-chev">${ICONS.chev}</span></button>
    </div>
  </div>
  <div class="nd-view" id="newFind" hidden>
    <header class="sh-head">
      <button class="sh-btn" id="newFindBack" type="button" aria-label="Назад">${ICONS.back}</button>
      <h2 class="sh-title">Написать человеку</h2>
      <button class="sh-btn sh-x" id="newFindX" type="button" aria-label="Закрыть">${ICONS.close}</button>
    </header>
    <form class="find-form sh-body" id="findForm" novalidate>
      <div class="invite">
        <input class="txt" id="findUser" maxlength="64" autocomplete="off" autocapitalize="off" spellcheck="false"
          enterkeyhint="search" placeholder="Имя или @username" aria-label="Найти человека или канал">
        <button class="btn ghost small" id="findSubmit" type="submit">Найти</button>
      </div>
      <div id="findResult"></div>
    </form>
  </div>
  <div class="nd-view" id="newLink" hidden>
    <header class="sh-head">
      <button class="sh-btn" id="newLinkBack" type="button" aria-label="Назад">${ICONS.back}</button>
      <h2 class="sh-title">Войти по ссылке</h2>
      <button class="sh-btn sh-x" id="newLinkX" type="button" aria-label="Закрыть">${ICONS.close}</button>
    </header>
    <form class="sh-body stack" id="linkForm" novalidate>
      <input class="txt" id="linkInput" maxlength="300" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go"
        placeholder="Ссылка, код приглашения или @канал" aria-label="Ссылка-приглашение, код или @имя канала">
      <p class="hint">Например, skam-messenger.ru/?join=… — приглашение в группу или канал, или @имя публичного канала.</p>
      <p class="err" id="linkErr"></p>
      <button class="btn primary" id="linkGo" type="submit">Открыть</button>
    </form>
  </div>
</dialog>
<dialog id="createDlg" class="create-dlg" aria-label="Новая группа или канал"></dialog>
<dialog id="pickDlg" class="pick-dlg" aria-label="Добавить участников"></dialog>
<dialog id="profileDlg" class="sheet" aria-label="Профиль"></dialog>
<dialog id="chatDlg" aria-label="О чате"></dialog>
<dialog id="personDlg" class="sheet" aria-label="Профиль участника"></dialog>
<dialog id="joinDlg" aria-label="Приглашение в чат"></dialog>
<dialog id="keyDlg" aria-label="Ключ шифрования"></dialog>
<dialog id="mediaDlg" class="media-dlg" aria-label="Отправка файлов"></dialog>
<dialog id="viewer" class="viewer" aria-label="Просмотр"></dialog>
<dialog id="fwdDlg" class="fwd-dlg" aria-label="Переслать"></dialog>
<dialog id="callDlg" aria-label="Настройки звонка"></dialog>
<dialog id="supportDlg" class="support-dlg" aria-label="Поддержка"></dialog>
<dialog id="rateDlg" class="rate-dlg" aria-label="Оценить СКАМ"></dialog>
<dialog id="stickerDlg" class="sticker-dlg" aria-label="Стикеры"></dialog>
<dialog id="folderDlg" class="folder-dlg" aria-label="Папка"></dialog>
<dialog id="folderPickDlg" class="pick-dlg" aria-label="Выбор чатов"></dialog>
<dialog id="foldersDlg" class="folders-dlg" aria-label="Папки с чатами"></dialog>
<dialog id="storyDlg" class="story-dlg" aria-label="История"></dialog>
<dialog id="storyNewDlg" class="story-new" aria-label="Новая история"></dialog>
<div class="ctx-menu" id="ctxMenu" role="menu" hidden></div>
<div class="vol-pop" id="volPop" hidden></div>
<div class="ring-box" id="ringBox" role="alertdialog" aria-live="assertive" hidden></div>
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
  stickerImgs: new Map<string, HTMLElement>(),
  /** Ответ, который готовится в чате (как в Telegram — у каждого чата свой). */
  reply: new Map<string, Msg>(),
  /** Что переслать в чат: сообщения ждут отправки вместе с комментарием. */
  fwd: new Map<string, { msgs: Msg[]; hide: boolean }>(),
  /** Выбор нескольких сообщений. */
  sel: null as { chatId: string; ids: Set<string> } | null,
  armedSel: false,
  /** Подсветить сообщение после перехода к нему по цитате. */
  flash: null as string | null,
  /** Пост канала, который сейчас изменяют (текст — в поле ввода). */
  edit: new Map<string, Msg>(),
  /** Строка поиска над списком чатов. */
  q: '',
  /** Глобальный поиск (люди и публичные каналы) по запросу key. */
  found: null as { key: string; people: FoundUser[]; chans: ChatCard[]; loading: boolean; error?: string } | null,
  /** Выбранная стрелками строка результатов поиска. */
  kbd: -1,
  /** Какой закреплённый чат сейчас перетаскивают (список не перерисовываем, пока тянут). */
  drag: null as string | null,
  dragAt: 0,
  sidePending: false,
  /** Когда открыли меню чата долгим нажатием: следующее касание — не «открыть чат». */
  lpAt: 0,
  /** Папка и вкладка, которые были на экране в прошлый раз (сменились — список наверх). */
  shownFolder: undefined as string | undefined,
  /** Поиск по сообщениям открытого чата. */
  find: null as { chatId: string; q: string; hits: string[]; i: number } | null,
};
let unsubs: (() => void)[] = [];
let mounted = false;
let recUI: RecordUI | null = null;

// ---------------------------------------------------------------------------
// Кто есть кто
// ---------------------------------------------------------------------------

type Who = {
  id: string | null; name: string; avatar: string | null; color: string | null; brand?: boolean; emoji?: string;
  /** Официальная галочка. */
  verified?: boolean;
};

function who(uid: string | null | undefined, kind: string = 'text'): Who {
  if (kind === 'system') return { id: null, name: 'СКАМ', avatar: null, color: null, brand: true };
  if (!uid) return { id: null, name: 'Удалённый аккаунт', avatar: null, color: null };
  const p = S.profiles.get(uid);
  // Свой ник для человека (видите только вы) — везде вместо его имени, как «имя контакта» в Telegram.
  const name = nickOf(uid) || p?.name || (uid === meId() ? 'Вы' : 'Участник');
  return { id: uid, name, avatar: avatarUrl(p?.avatar_path), color: p?.color ?? null, verified: !!p?.verified };
}

/** Имя с официальной галочкой: текст обрезается многоточием, галочка остаётся видна. */
function nameWithMark(cls: string, name: string, verified: boolean, kind: 'user' | 'channel' | 'bot' = 'user'): HTMLElement {
  const n = el('span', cls);
  n.append(el('span', 'nm-t', name));
  if (verified) n.append(verifiedMark(kind));
  return n;
}

/** Есть ли у чата официальная галочка: у личного — у собеседника, у канала и бота — у самого чата. */
function chatVerified(c: MyChat): boolean {
  if (c.kind === 'direct') return !!(c.peer_id && S.profiles.get(c.peer_id)?.verified);
  return !!c.verified;
}

function markKind(c: MyChat): 'user' | 'channel' | 'bot' {
  return c.kind === 'bot' ? 'bot' : c.kind === 'channel' ? 'channel' : 'user';
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
  if (!w.avatar && w.emoji) {
    node.classList.add('emoji');
    node.textContent = w.emoji;
    return node;
  }
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
const BRAND_SVG = BRAND_AVATAR;

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

/** Можно ли мне писать в этот чат (в канал — владельцу и админам с правом публикации). */
function canPost(c: MyChat | null | undefined): boolean {
  return !!c && !c.preview && !peerBlocked(c) && (c.kind !== 'channel' || hasRight(c, 'post'));
}

/** Как канал выглядит автором постов: фото или значок (канал новостей — логотип СКАМ). */
function chatWho(c: MyChat): Who {
  const avatar = avatarUrl(c.avatar_path);
  return { id: null, name: c.name ?? 'Канал', avatar, color: null, brand: c.is_default && !avatar, emoji: c.emoji, verified: !!c.verified };
}

/** Можно ли удалить сообщение: своё — всегда, чужое — админу группы или канала с правом удаления. */
function canDelete(m: Msg, c: MyChat): boolean {
  if (m.kind === 'call' && m.user_id !== meId()) return false;
  if (m.user_id === meId() && m.kind !== 'system') return true;
  return (c.kind === 'group' || c.kind === 'channel') && hasRight(c, 'delete');
}

/** Изменить можно пост канала: свой (пока можешь публиковать) или чужой — с правом «Изменение чужих публикаций». */
function canEdit(m: Msg, c: MyChat): boolean {
  if (c.kind !== 'channel' || m.deleted_at || m.pending || m.failed || (m.kind !== 'text' && m.kind !== 'media')) return false;
  return (m.user_id === meId() && canPost(c)) || hasRight(c, 'edit');
}

/** Сквозное шифрование — в личных чатах и группах (канал и бот — без него, как в Telegram). */
function isE2E(c: MyChat | null | undefined): boolean {
  return !!c && e2e.isE2EKind(c.kind);
}

/** Живой канал (presence, «печатает…») нужен только там, где переписываются люди. */
function isConversation(c: MyChat | null | undefined): boolean {
  return !!c && (c.kind === 'group' || c.kind === 'direct');
}

function convVisible(): boolean {
  return !!S.cur && (wideMQ.matches || document.body.classList.contains('chat-open'));
}

function currentChat(): MyChat | null {
  return chatById(S.cur) ?? null;
}

function setBanner(text: string | null): void {
  const b = $('banner');
  b.textContent = text ?? '';
  b.hidden = !text;
}

// ---------------------------------------------------------------------------
// Боковая панель
// ---------------------------------------------------------------------------

/** Текст с вложениями: «🖼 Фото», «🖼 подпись», «📎 отчёт.pdf». */
function contentPreview(text: string, files: { kind?: unknown; name?: unknown }[]): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!files.length) return t || '…';
  const label = filesLabel(files);
  return t ? `${label.split(' ')[0]} ${t}` : label;
}

/** Как сообщение выглядит в списке чатов: текст, «👋 Стикер», «Голосовое сообщение», «🖼 Фото»… */
function kindText(kind: string | null, body: string | null, files: { kind?: unknown; name?: unknown }[] = []): string {
  switch (kind) {
    case 'sticker': return `${body ? `${body} ` : ''}Стикер`;
    case 'voice': return 'Голосовое сообщение';
    case 'video_note': return 'Кружочек';
    case 'e2e': return '🔒 Зашифрованное сообщение';
    case 'media': return contentPreview(body ?? '', files);
    case 'call': return '📞 Звонок';
    default: return body || '…';
  }
}

function previewText(c: MyChat): string {
  if (!c.last_id) return c.kind === 'direct' ? 'Напишите первым' : 'Пока пусто';
  if (c.last_deleted) return 'Сообщение удалено';
  let t: string;
  if (c.last_kind === 'call') return callPreview(c);
  if (c.last_kind === 'e2e') {
    // Зашифрованное: показываем то, что внутри, после расшифровки.
    const p = S.previews.get(c.last_id);
    t = !p ? '🔒 …' : p === 'locked' ? '🔒 Зашифрованное сообщение'
      : p.view === 'e2e' || p.view === 'media' || p.view === 'text' ? contentPreview(p.text, p.files) : kindText(p.view, p.text);
  } else {
    t = kindText(c.last_kind, c.last_body, Array.isArray(c.last_files) ? c.last_files : []);
  }
  t = t.replace(/\s+/g, ' ');
  if (c.kind === 'channel') return t;
  if (c.last_user_id === meId()) return `Вы: ${t}`;
  if (c.kind === 'group' && c.last_kind !== 'system') return `${who(c.last_user_id).name}: ${t}`;
  return t;
}

/** Текст уведомления: «Аня: привет», «🖼 Фото», в канале — без автора. */
function notifyText(m: Msg, c: MyChat): string {
  const view = viewKind(m);
  let t = m.locked ? '🔒 Зашифрованное сообщение'
    : view === 'e2e' || view === 'media' || view === 'text' ? contentPreview(m.content?.text ?? m.body ?? '', m.content?.files ?? [])
      : kindText(view, m.content?.text ?? m.body);
  t = t.replace(/\s+/g, ' ').trim().slice(0, 160);
  if (c.kind === 'group') return `${who(m.user_id).name}: ${t}`;
  return t;
}

function renderSide(): void {
  // Пока тянут закреплённый чат, список не перерисовываем — иначе перетаскивание оборвётся.
  if (U.drag && Date.now() - U.dragAt < 30_000) { U.sidePending = true; return; }
  renderFolderBar();
  renderStoryStrip();
  const list = $('chatList');
  if (searchActive()) { renderSearch(); return; }
  list.classList.remove('searching');
  if (!S.chatsLoaded) {
    list.replaceChildren(el('p', 'list-empty', 'Загружаем чаты…'));
    return;
  }
  if (!S.chats.size) {
    list.replaceChildren(el('p', 'list-empty', 'Чатов пока нет. Нажмите «Новый чат», чтобы завести первый.'));
    return;
  }
  const folder = folderById(L.cur);
  const kind = activeKind();
  const chats = listChats(L.cur, kind);
  if (!chats.length && folder) {
    list.replaceChildren(emptyFolderNote(folder));
  } else if (!chats.length) {
    const what = kind === 'direct' ? 'Личных чатов пока нет.' : kind === 'group' ? 'Групп пока нет.' : 'Каналов пока нет.';
    list.replaceChildren(el('p', 'list-empty', `${what} Нажмите «Новый чат», чтобы начать.`));
  } else {
    const pins = new Set(pinsOf(L.cur));
    const frag = document.createDocumentFragment();
    for (const c of chats) {
      const row = chatRow(c, { pinned: pins.has(c.id) });
      if (pins.has(c.id)) pinDrag(row, c.id);
      frag.append(row);
    }
    list.replaceChildren(frag);
  }
  // Сменили папку или вкладку — список с начала.
  const shown = `${L.cur ?? ''}|${kind}`;
  if (U.shownFolder !== shown) {
    U.shownFolder = shown;
    list.scrollTop = 0;
  }
}

/** Строка чата в списке (и в результатах поиска — с подсветкой совпадений). */
function chatRow(c: MyChat, opts: { pinned?: boolean; toks?: string[] } = {}): HTMLButtonElement {
  const b = el('button', 'chat');
  b.type = 'button';
  b.dataset.chat = c.id;
  const active = c.id === S.cur && convVisible();
  if (active) b.setAttribute('aria-current', 'true');
  const title = chatTitle(c);
  const name = nameWithMark('name', title, chatVerified(c), markKind(c));
  if (opts.toks?.length) name.querySelector('.nm-t')!.replaceChildren(highlight(title, opts.toks));
  const muted = chatMuted(c.id);
  if (muted) {
    const mi = el('span', 'mute-ic');
    mi.append(html(ICONS.bellOff));
    mi.setAttribute('role', 'img');
    mi.setAttribute('aria-label', 'без звука');
    mi.title = muteLabel(c.id);
    name.append(mi);
  }
  const live = calls.callInChat(c.id);
  if (live) {
    const ic = el('span', `live-call${calls.C.session?.callId === live.id ? ' mine' : ''}`);
    ic.append(html(live.video ? ICONS.video : ICONS.phone));
    ic.title = 'Идёт звонок';
    name.append(ic);
  }
  b.append(
    chatTileEl(c),
    name,
    el('span', 'time', c.last_at ? listTime(ts(c.last_at)) : ''),
    el('span', 'preview', previewText(c)),
  );
  // В свёрнутом списке текст спрятан: имя — во всплывающей подсказке, непрочитанные — на аватарке.
  b.title = title;
  if (c.unread && !active) {
    const tile = b.querySelector('.tile');
    tile?.append(el('span', `cb${muted ? ' muted' : ''}`, c.unread > 99 ? '99+' : String(c.unread)));
  }
  if (c.kind === 'direct' && c.peer_id && storyState(c.peer_id) !== 'none') {
    const peer = c.peer_id;
    const tile = b.querySelector<HTMLElement>('.tile');
    tile?.addEventListener('click', (ev) => { ev.stopPropagation(); if (Date.now() - U.lpAt < 700) return; openStoriesOf(peer); });
    tile?.setAttribute('title', 'Смотреть истории');
  }
  if (c.unread && !active) {
    const d = el('span', `badge${muted ? ' muted' : ''}`, c.unread > 99 ? '99+' : String(c.unread));
    d.setAttribute('aria-label', plural(c.unread, 'новое сообщение', 'новых сообщения', 'новых сообщений'));
    b.append(d);
    b.classList.add('unread');
  } else if (opts.pinned) {
    const p = el('span', 'pin-ic');
    p.append(html(ICONS.pinMark));
    p.setAttribute('role', 'img');
    p.setAttribute('aria-label', 'закреплён');
    p.title = 'Закреплён';
    b.append(p);
  }
  if (opts.pinned) b.classList.add('pinned');
  b.addEventListener('click', () => {
    if (Date.now() - U.lpAt < 700) return;
    openChat(c.id);
  });
  b.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    // Клавиша меню / Shift+F10 — у события нет координат: открываем у строки.
    const r = b.getBoundingClientRect();
    const kb = !e.clientX && !e.clientY;
    openChatMenu(c, kb ? r.left + 24 : e.clientX, kb ? r.top + r.height / 2 : e.clientY);
  });
  longPress(b, () => {
    U.lpAt = Date.now();
    const r = b.getBoundingClientRect();
    openChatMenu(c, r.left + 24, r.top + r.height / 2);
  });
  return b;
}

/** Перетаскивание закреплённых мышью — новый порядок сразу на сервер (как в Telegram на компьютере). */
function pinDrag(row: HTMLElement, id: string): void {
  if (touchMQ.matches) return;
  row.draggable = true;
  const clear = () => document.querySelectorAll('.chat.drop-before,.chat.drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
  const done = () => {
    U.drag = null;
    clear();
    if (U.sidePending) { U.sidePending = false; renderSide(); }
  };
  row.addEventListener('dragstart', (e) => {
    U.drag = id;
    U.dragAt = Date.now();
    closeMenu();
    e.dataTransfer?.setData('text/plain', '');
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => { row.classList.remove('dragging'); done(); });
  row.addEventListener('dragover', (e) => {
    if (!U.drag || U.drag === id) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const r = row.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    row.classList.toggle('drop-after', after);
    row.classList.toggle('drop-before', !after);
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
  row.addEventListener('drop', (e) => {
    const moving = U.drag;
    if (!moving || moving === id) return;
    e.preventDefault();
    const after = row.classList.contains('drop-after');
    const ids = pinsOf(L.cur).filter((x) => x !== moving);
    ids.splice(ids.indexOf(id) + (after ? 1 : 0), 0, moving);
    U.sidePending = false;
    done();
    reorderPins(ids).catch((err) => toast(errText(err, 'Не получилось поменять порядок.')));
  });
}

// ---------------------------------------------------------------------------
// Меню чата в списке: закрепить, папки, прочитано
// ---------------------------------------------------------------------------

function openChatMenu(c: MyChat, x: number, y: number): void {
  // В результатах поиска — как в «Все чаты»: папку сейчас не видно.
  const ctx = searchActive() ? null : L.cur;
  const folder = folderById(ctx);
  const pinned = isPinned(c.id, ctx);
  const items: MenuItem[] = [];
  items.push({
    icon: pinned ? 'unpin' : 'pin',
    label: pinned ? 'Открепить' : folder ? 'Закрепить в папке' : 'Закрепить',
    fn: () => { pinChat(c.id, !pinned, ctx).catch((e) => toast(errText(e, pinned ? 'Не получилось открепить.' : 'Не получилось закрепить.'))); },
  });
  if (c.unread) items.push({ icon: 'read', label: 'Отметить прочитанным', fn: () => markRead(c.id) });
  items.push({ icon: 'folderAdd', label: 'Добавить в папку', fn: () => openFolderMenu(c, x, y) });
  if (folder) {
    items.push({
      icon: 'folderOut', label: `Убрать из «${folder.title}»`,
      fn: () => {
        setChatInFolder(folder.id, c.id, false).then(
          () => toast(`«${chatTitle(c)}» больше не в папке «${folder.title}»`),
          (e) => toast(errText(e, 'Не получилось убрать из папки.')),
        );
      },
    });
  }
  items.push(...muteBlockItems(c, x, y, () => openChatMenu(c, x, y)));
  showMenu(items, x, y);
}

/** «Добавить в папку»: все папки с галочками + новая папка с этим чатом. */
function openFolderMenu(c: MyChat, x: number, y: number): void {
  const items: MenuItem[] = [{ head: 'Добавить в папку', back: () => openChatMenu(c, x, y) }];
  foldersOf(c).forEach(({ f, on }) => {
    items.push({
      icon: 'folder', emoji: folderIcon(f), label: f.title, checked: on,
      fn: () => {
        setChatInFolder(f.id, c.id, !on).then(
          () => toast(on ? `Чат убран из папки «${f.title}»` : `Чат добавлен в папку «${f.title}»`),
          (e) => toast(errText(e, 'Не получилось изменить папку.')),
        );
      },
    });
  });
  items.push({ icon: 'plus', label: 'Новая папка', fn: () => openFolderEditor(null, { include: [c.id] }) });
  showMenu(items, x, y);
}

/** Контекстное меню из пунктов (для чатов и папок). */
function showMenu(items: MenuItem[], x: number, y: number): void {
  const menu = $('ctxMenu');
  const box = el('div', 'cm-items');
  for (const it of items) {
    if ('head' in it) {
      const h = el('div', 'cm-head');
      if (it.back) {
        const back = button('cm-back', null, () => it.back!());
        back.append(html(ICONS.back));
        back.setAttribute('aria-label', 'Назад');
        h.append(back);
      }
      h.append(el('span', null, it.head));
      box.append(h);
      continue;
    }
    let armed = false;
    const label = el('span', 'cm-label', it.label);
    const b = button(`cm-item${it.danger ? ' danger' : ''}`, null, () => {
      if (it.confirm && !armed) { armed = true; label.textContent = it.confirm; return; }
      closeMenu();
      it.fn();
    });
    if (it.checked === undefined) b.setAttribute('role', 'menuitem');
    else {
      b.setAttribute('role', 'menuitemcheckbox');
      b.setAttribute('aria-checked', String(it.checked));
    }
    if (it.emoji) b.append(el('span', 'cm-emoji', it.emoji));
    else b.append(html(ICONS[it.icon]));
    b.append(label);
    if (it.checked) b.append(el('span', 'cm-tick', '✓'));
    box.append(b);
  }
  menu.replaceChildren(box);
  menu.hidden = false;
  document.body.classList.add('menu-open');
  const r = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - r.width - 8, x));
  let top = y;
  if (top + r.height > window.innerHeight - 8) top = Math.max(8, y - r.height);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  (box.querySelector('.cm-item') as HTMLButtonElement | null)?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// Поиск над списком: мои чаты (личные, группы, каналы, бот) и глобально — люди и публичные каналы
// ---------------------------------------------------------------------------

let gSeq = 0;
let gTimer = 0;

function searchActive(): boolean {
  return !!U.q.trim();
}

function onSearchInput(): void {
  U.q = $<HTMLInputElement>('chatSearch').value;
  $('searchClear').hidden = !U.q;
  U.kbd = -1;
  document.querySelector('.side')?.classList.toggle('is-searching', searchActive());
  scheduleGlobal();
  renderSide();
  $('chatList').scrollTop = 0;
}

function clearSearch(): void {
  $<HTMLInputElement>('chatSearch').value = '';
  onSearchInput();
}

/** Людей и публичные каналы ищем на сервере — с паузой в наборе, от 2 символов. */
function scheduleGlobal(): void {
  const raw = U.q;
  const q = parseQuery(raw);
  const key = searchNorm(raw);
  clearTimeout(gTimer);
  if (q.s.length < SEARCH_MIN || (q.at && !/^[a-z0-9_]+$/.test(q.s))) {
    gSeq++;
    U.found = null;
    return;
  }
  if (U.found?.key === key) return;
  const my = ++gSeq;
  // Пока дописывают запрос, старые результаты остаются на месте — без мигания при наборе.
  const keep = U.found && key.startsWith(U.found.key) ? U.found : null;
  U.found = { key, people: keep?.people ?? [], chans: keep?.chans ?? [], loading: true };
  gTimer = window.setTimeout(async () => {
    try {
      const [people, chans] = await Promise.all([searchUsers(raw), searchChats(raw).catch(() => [] as ChatCard[])]);
      if (my !== gSeq) return;
      U.found = { key, people, chans, loading: false };
    } catch (e) {
      if (my !== gSeq) return;
      U.found = { key, people: [], chans: [], loading: false, error: errText(e, 'Не получилось поискать людей и каналы.') };
    }
    renderSide();
  }, 300);
}

/** Насколько чат подходит под запрос: 0 — не подходит. Ищем по названию, имени собеседника и @username. */
function matchScore(c: MyChat, q: { at: boolean; s: string; toks: string[] }): number {
  const users: string[] = [];
  if (c.kind === 'direct' && c.peer_id) {
    const u = S.profiles.get(c.peer_id)?.username;
    if (u) users.push(u.toLowerCase());
  }
  if (c.username) users.push(c.username.toLowerCase());
  if (q.at) {
    if (users.includes(q.s)) return 100;
    return users.some((u) => u.startsWith(q.s)) ? 80 : 0;
  }
  const title = searchNorm(chatTitle(c));
  if (title === q.s) return 100;
  if (users.includes(q.s)) return 95;
  if (title.startsWith(q.s)) return 90;
  // Человека с ником находят и по настоящему имени.
  const real = c.kind === 'direct' && nickOf(c.peer_id) ? searchNorm(S.profiles.get(c.peer_id!)?.name ?? '') : '';
  if (real && real.startsWith(q.s)) return 85;
  // Бота находят и по слову «бот».
  const extra = c.kind === 'bot' ? ['бот', 'bot'] : [];
  const split = (v: string) => v.split(/[\s\-—–«»"'.,:;!?()]+/);
  const words = [...split(title), ...split(real), ...users, ...extra].filter(Boolean);
  if (q.toks.every((t) => words.some((w) => w.startsWith(t)))) return 70;
  // Середина слова — только для запросов подлиннее, иначе на одну букву находится всё подряд.
  return q.s.length >= 3 && title.includes(q.s) ? 50 : 0;
}

function searchLabel(text: string): HTMLElement {
  const h = el('p', 'sr-sec', text);
  h.setAttribute('role', 'presentation');
  return h;
}

function renderSearch(): void {
  const list = $('chatList');
  list.classList.add('searching');
  const q = parseQuery(U.q);
  const toks = q.at ? [] : q.toks;
  const mine = [...S.chats.values()]
    .map((c) => ({ c, s: matchScore(c, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || ts(b.c.last_at ?? b.c.created_at) - ts(a.c.last_at ?? a.c.created_at))
    .map((x) => x.c);
  const frag = document.createDocumentFragment();
  const mineIds = new Set(mine.map((c) => c.id));
  const minePeers = new Set(mine.map((c) => c.peer_id).filter(Boolean));
  // Люди, которым вы дали ник, — даже без личного чата с ними.
  const nicked = nickHits(q).filter((p) => !minePeers.has(p.id));
  const nickedIds = new Set(nicked.map((p) => p.id));
  if (mine.length || nicked.length) {
    frag.append(searchLabel(nicked.length ? 'Чаты и контакты' : 'Чаты'));
    mine.forEach((c) => frag.append(chatRow(c, { toks })));
    nicked.forEach((p) => frag.append(personResult(p, q)));
  }
  const g = U.found && U.found.key === searchNorm(U.q) ? U.found : null;
  const people = (g?.people ?? []).filter((p) => p.id !== meId() && !minePeers.has(p.id) && !nickedIds.has(p.id));
  const chans = (g?.chans ?? []).filter((ch) => !mineIds.has(ch.id));
  if (people.length || chans.length) {
    frag.append(searchLabel('Глобальный поиск'));
    // Точное @имя канала — наверх, как в «Новом чате».
    const exact = chans.filter((ch) => ch.username === q.s);
    exact.forEach((ch) => frag.append(channelResult(ch, q)));
    people.forEach((p) => frag.append(personResult(p, q)));
    chans.filter((ch) => ch.username !== q.s).forEach((ch) => frag.append(channelResult(ch, q)));
  }
  if (q.at && !/^[a-z0-9_]*$/.test(q.s)) {
    frag.append(el('p', 'list-empty', 'В @username бывают только латиница, цифры и _.'));
  } else if (g?.loading && !people.length && !chans.length) {
    frag.append(el('p', 'list-empty sr-wait', mine.length || nicked.length ? 'Ищем людей и каналы…' : 'Ищем…'));
  } else if (!mine.length && !nicked.length && !people.length && !chans.length) {
    const box = el('div', 'sr-empty');
    if (q.s.length < SEARCH_MIN) {
      box.append(el('b', null, 'Среди ваших чатов такого нет'), el('p', null, 'Людей и каналы ищем от 2 символов.'));
    } else {
      box.append(el('b', null, 'Ничего не нашли'),
        el('p', null, g?.error ?? 'Проверьте запрос. Человека можно найти по имени или @username, канал — по названию.'));
    }
    frag.append(box);
  }
  list.replaceChildren(frag);
  applyKbd();
}

function personResult(p: FoundUser, q: { at: boolean; s: string; toks: string[] }): HTMLButtonElement {
  rememberProfiles([p]);
  const nick = nickOf(p.id);
  const w: Who = { id: p.id, name: nick || p.name || 'Участник', avatar: avatarUrl(p.avatar_path), color: p.color, verified: p.verified };
  const b = el('button', 'chat sr-global');
  b.type = 'button';
  const tile = el('span', 'tile person');
  tile.append(avatarEl(w));
  const name = el('span', 'name');
  const nt = el('span', 'nm-t');
  nt.append(q.at ? document.createTextNode(w.name) : highlight(w.name, q.toks));
  name.append(nt);
  if (w.verified) name.append(verifiedMark());
  const sub = el('span', 'preview');
  if (p.username) sub.append('@', highlight(p.username, q.at ? [q.s] : q.toks, true));
  else if (!nick || !p.name) sub.append('пользователь СКАМ');
  // С ником — рядом настоящее имя: по нему тоже ищут.
  if (nick && p.name) sub.append(p.username ? ' · ' : '', q.at ? document.createTextNode(p.name) : highlight(p.name, q.toks));
  if (p.is_contact) sub.append(el('span', 'sr-tag', ' · есть общий чат'));
  b.append(tile, name, el('span', 'time'), sub);
  b.setAttribute('aria-label', `${w.name}${p.username ? `, @${p.username}` : ''} — открыть профиль`);
  b.addEventListener('click', () => openPerson(p.id));
  return b;
}

function channelResult(card: ChatCard, q: { at: boolean; s: string; toks: string[] }): HTMLButtonElement {
  const b = el('button', 'chat sr-global');
  b.type = 'button';
  const tile = el('span', `tile${card.avatar_path ? ' photo' : ''}`);
  if (card.avatar_path) {
    const img = el('img');
    img.src = avatarUrl(card.avatar_path) ?? '';
    img.alt = '';
    img.decoding = 'async';
    tile.append(img);
  } else tile.textContent = card.emoji;
  const name = el('span', 'name');
  const nt = el('span', 'nm-t');
  nt.append(q.at ? document.createTextNode(card.name) : highlight(card.name, q.toks));
  name.append(nt);
  if (card.verified) name.append(verifiedMark('channel'));
  const sub = el('span', 'preview');
  if (card.username) sub.append('@', highlight(card.username, q.at ? [q.s] : q.toks, true), ' · ');
  sub.append(`канал, ${plural(card.member_count, 'подписчик', 'подписчика', 'подписчиков')}`);
  b.append(tile, name, el('span', 'time'), sub);
  b.addEventListener('click', () => openCard(card));
  return b;
}

/** Стрелки ↑↓ в поле поиска выбирают строку, Enter открывает. */
function applyKbd(): void {
  const rows = [...document.querySelectorAll<HTMLElement>('#chatList .chat')];
  rows.forEach((r, i) => r.classList.toggle('kbd', i === U.kbd));
  if (U.kbd >= rows.length) U.kbd = rows.length - 1;
}

function onSearchKey(e: KeyboardEvent): void {
  const inp = e.currentTarget as HTMLInputElement;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    if (inp.value) clearSearch();
    else inp.blur();
    return;
  }
  if (!searchActive()) return;
  const rows = [...document.querySelectorAll<HTMLElement>('#chatList .chat')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!rows.length) return;
    U.kbd = e.key === 'ArrowDown' ? Math.min(rows.length - 1, U.kbd + 1) : Math.max(0, U.kbd - 1);
    applyKbd();
    rows[U.kbd]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    rows[Math.max(0, U.kbd)]?.click();
  }
}

/** Официальный чат СКАМ: бот и канал с галочкой без своего фото — аватарка в градиенте логотипа. */
function isOfficial(c: MyChat): boolean {
  return c.kind === 'bot' || (c.kind === 'channel' && !!c.verified && !c.avatar_path);
}

/** Чёрный знак на градиенте: у бота — пузырь СКАМ, у канала — рупор. */
function officialMark(c: MyChat): DocumentFragment {
  return html(c.kind === 'bot' ? MARK_SVG : ICONS.megaphone);
}

/** Значок чата: аватар собеседника, бот или эмодзи группы. */
function chatTileEl(c: MyChat, cls = ''): HTMLElement {
  let tile: HTMLElement;
  if (c.kind === 'direct') {
    tile = el('span', `tile person ${cls} ${ringClass(c.peer_id)}`.trim());
    tile.append(avatarEl(who(c.peer_id)));
    if (c.peer_id && isOnline(S.profiles.get(c.peer_id))) tile.append(el('span', 'on-dot'));
  } else if (isOfficial(c)) {
    tile = el('span', `tile official ${c.kind === 'bot' ? 'mark' : ''} ${cls}`.trim());
    tile.append(officialMark(c));
  } else if (c.avatar_path) {
    tile = el('span', `tile photo ${cls}`);
    const img = el('img');
    img.src = avatarUrl(c.avatar_path) ?? '';
    img.alt = '';
    img.decoding = 'async';
    tile.append(img);
  } else {
    tile = el('span', `tile ${cls}`, c.emoji);
  }
  return tile;
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
  text.append(nameWithMark('nm', S.me.name || 'Без имени', !!S.me.verified), st);
  const av = el('span', 'me-av');
  av.append(avatarEl(who(meId())));
  if (on) av.append(el('span', 'on-dot'));
  const gear = el('span', 'me-gear fd');
  gear.append(html(ICONS.gear));
  text.classList.add('fd');
  box.replaceChildren(av, text, gear);
}

// ---------------------------------------------------------------------------
// Свёрнутый список чатов (компьютер): узкая колонка аватарок
// ---------------------------------------------------------------------------

function sideMini(): boolean {
  return document.getElementById('app')?.classList.contains('side-mini') ?? false;
}

function setSideMini(on: boolean, save = true): void {
  const app = document.getElementById('app');
  if (!app) return;
  if (on && searchActive()) clearSearch();
  app.classList.toggle('side-mini', on);
  if (save) lsSet('skam:side', on ? 'mini' : null);
  const label = on ? 'Развернуть список чатов' : 'Свернуть список чатов';
  for (const id of ['sideTgl', 'sideGrip']) {
    const b = document.getElementById(id);
    if (!b) continue;
    b.setAttribute('aria-label', label);
    b.title = on ? 'Развернуть список' : 'Свернуть список';
  }
  document.getElementById('sideTgl')?.replaceChildren(html(on ? ICONS.sideOpen : ICONS.sideClose));
}

function updateTitle(): void {
  const n = totalUnread();
  document.title = calls.ringing().length ? '📞 Входящий звонок — СКАМ' : n ? `(${n}) СКАМ` : 'СКАМ';
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
  const blocked = peerBlocked(c);
  const ro = !!c && !canPost(c) && !blocked;
  const preview = !!c?.preview;
  $('composer').classList.toggle('readonly', ro);
  $('composer').hidden = preview || blocked;
  $('joinBar').hidden = !preview;
  $('composerNote').hidden = !ro;
  renderBlockBar(c, blocked);
  if (ro) { closeStickers(); recUI?.cancel(); }
  renderSelectBar();
  renderComposerBar();
  updateSendBtn();
}

/** В личном чате с заблокированным вместо поля ввода — «Вы заблокировали … [Разблокировать]». */
function renderBlockBar(c: MyChat | null, blocked: boolean): void {
  const bar = $('blockBar');
  bar.hidden = !blocked;
  if (!blocked || !c?.peer_id) { bar.replaceChildren(); return; }
  const peer = c.peer_id;
  const name = who(peer).name;
  const btn = button('btn ghost small', 'Разблокировать', async () => {
    btn.disabled = true;
    try {
      await blockUser(peer, false);
      toast(`${name} разблокирован(а)`);
      void refreshStories();
    } catch (e) {
      toast(errText(e, 'Не получилось разблокировать.'));
      btn.disabled = false;
    }
  });
  const ic = el('span', 'bb-ic');
  ic.append(html(ICONS.ban));
  bar.replaceChildren(ic, el('span', 'bb-t', `Вы заблокировали ${name}. Писать и звонить друг другу нельзя.`), btn);
}

function renderHead(): void {
  const c = currentChat();
  if (!c) return;
  renderCallBtns();
  const emoji = $('convEmoji');
  emoji.className = 'conv-emoji';
  if (c.kind === 'direct') {
    emoji.replaceChildren(personAvatar(c.peer_id));
    emoji.style.border = '0';
    emoji.style.background = 'transparent';
    const rc = ringClass(c.peer_id);
    if (rc) emoji.className = `conv-emoji ${rc}`;
  } else if (isOfficial(c)) {
    emoji.replaceChildren(officialMark(c));
    emoji.classList.add('official');
    if (c.kind === 'bot') emoji.classList.add('mark');
    emoji.style.border = '';
    emoji.style.background = '';
  } else if (c.avatar_path) {
    const img = el('img');
    img.src = avatarUrl(c.avatar_path) ?? '';
    img.alt = '';
    emoji.replaceChildren(img);
    emoji.style.border = '0';
    emoji.style.background = 'transparent';
  } else {
    emoji.replaceChildren(c.emoji);
    emoji.style.border = '';
    emoji.style.background = '';
  }
  emoji.classList.toggle('photo', (c.kind === 'group' || c.kind === 'channel') && !!c.avatar_path);
  const nameEl = $('convName');
  nameEl.replaceChildren(el('span', 'nm-t', chatTitle(c)));
  if (chatVerified(c)) nameEl.append(verifiedMark(markKind(c)));
  if (chatMuted(c.id)) {
    const mi = el('span', 'mute-ic');
    mi.append(html(ICONS.bellOff));
    mi.title = muteLabel(c.id);
    mi.setAttribute('aria-label', 'без звука');
    nameEl.append(mi);
  }
  if (isE2E(c)) {
    const lock = el('span', 'lock');
    lock.title = 'Сквозное шифрование';
    lock.setAttribute('aria-label', 'сквозное шифрование');
    lock.append(html(ICONS.lock));
    nameEl.append(lock);
  }

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
    sub.textContent = `${c.username ? 'публичный канал' : 'канал'} · ${countLabel(c)}`;
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
    return { k: R.k, e: R.e, n: rs.length, on: rs.some((r) => r.user_id === meId()), who: rs.filter((r) => r.user_id).map((r) => who(r.user_id).name) };
  }).filter((x) => x.n > 0);
}

/** Только что пришедший стикер «подпрыгивает», старые — нет. */
function fresh(m: Msg): boolean {
  return !!m.pending || Date.now() - ts(m.created_at) < 15_000;
}

/** Стикер в ленте. Нажатие открывает его набор (чужой неофициальный — с кнопкой «Добавить»). */
function stickerEl(m: Msg): HTMLElement {
  const s = findSticker(m.sticker, m.body);
  if (!s) return el('span', 'sticker-missing', kindText('sticker', m.body));
  let box = U.stickerImgs.get(m.id);
  if (!box || box.dataset.ref !== s.ref) {
    const b = button('sticker-open', null, (ev) => { ev.stopPropagation(); openStickerPack(s.pack); });
    b.dataset.ref = s.ref;
    b.setAttribute('aria-label', `Стикер ${s.emoji} — открыть набор`);
    const img = el('img', `sticker-img${fresh(m) ? ' pop' : ''}`);
    img.src = stickerUrl(s.ref);
    img.alt = `Стикер «${s.label}» ${s.emoji}`;
    img.title = s.label;
    img.width = img.height = 256;
    img.draggable = false;
    img.decoding = 'async';
    // Набор удалили — вместо картинки подпись «👋 Стикер».
    img.addEventListener('error', () => b.replaceChildren(el('span', 'sticker-missing', kindText('sticker', m.body))), { once: true });
    b.append(img);
    box = b;
    U.stickerImgs.set(m.id, box);
  }
  return box;
}

/**
 * Содержимое сообщения по его виду (у зашифрованного — по тому, что внутри).
 * Возвращает элемент, в конец которого ставится время: у текста с вложениями это подпись.
 */
function messageBody(b: HTMLElement, m: Msg, author: string): HTMLElement {
  if (m.locked) {
    const ic = el('span', 'lock');
    ic.append(html(ICONS.lock));
    b.append(ic, m.locked === 'nokey' ? 'Ожидание ключа шифрования…' : 'Не удалось расшифровать сообщение');
    b.title = m.locked === 'nokey'
      ? 'Ключ этого сообщения ещё не пришёл на это устройство. Он придёт сам, когда кто-то из участников чата будет в сети.'
      : 'Шифротекст повреждён или подменён.';
    return b;
  }
  switch (viewKind(m)) {
    case 'sticker': b.append(stickerEl(m)); return b;
    case 'voice': b.append(voiceEl(m)); return b;
    case 'video_note': b.append(videoNoteEl(m)); return b;
    default: {
      const content: Content = m.content ?? { text: m.body, files: [] };
      if (!content.files.length) { fillText(b, content.text); return b; }
      b.append(renderAttachments(m, content.files, author));
      if (!content.text) return b;
      const cap = el('div', 'caption');
      fillText(cap, content.text);
      b.append(cap);
      return cap;
    }
  }
}

/** Долгое нажатие на телефоне открывает меню сообщения (обычное касание кружочка его включает). */
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

/** Смахнуть сообщение влево — ответить на него (как в Telegram на телефоне). */
function swipeToReply(row: HTMLElement, target: HTMLElement, onReply: () => void): void {
  let x0 = 0;
  let y0 = 0;
  let dx = 0;
  let id = -1;
  let active = false;
  let decided = false;
  let horizontal = false;
  target.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || (e.target as HTMLElement).closest('.wave,.vnote,.vplay,input,a')) return;
    x0 = e.clientX; y0 = e.clientY; dx = 0; id = e.pointerId;
    active = true; decided = false; horizontal = false;
  });
  target.addEventListener('pointermove', (e) => {
    if (!active || e.pointerId !== id) return;
    const ddx = e.clientX - x0;
    const ddy = e.clientY - y0;
    if (!decided) {
      if (Math.hypot(ddx, ddy) < 10) return;
      decided = true;
      horizontal = ddx < 0 && Math.abs(ddx) > Math.abs(ddy) * 1.3;
      if (!horizontal) { active = false; return; }
    }
    dx = Math.max(-96, Math.min(0, ddx));
    row.style.transform = `translateX(${dx}px)`;
    row.classList.add('swiping');
    row.classList.toggle('swipe-ready', dx < -60);
  });
  const end = () => {
    if (!active) return;
    active = false;
    row.style.transform = '';
    row.classList.remove('swiping', 'swipe-ready');
    if (horizontal && dx < -60) { navigator.vibrate?.(8); onReply(); }
  };
  target.addEventListener('pointerup', end);
  target.addEventListener('pointercancel', end);
}

/** Имя автора сообщения для цитаты и «Переслано от …». */
function authorOf(m: { user_id: string | null; kind?: string }, chat: MyChat): Who {
  if (chat.kind === 'channel') return chatWho(chat);
  return who(m.user_id, m.kind ?? 'text');
}

/** Как выглядит сообщение одной строкой: «🖼 Фото», «Голосовое сообщение», текст… */
function oneLine(k: string, text: string, files: { kind?: unknown; name?: unknown }[] = []): string {
  switch (k) {
    case 'sticker': return `${text ? `${text} ` : ''}Стикер`;
    case 'voice': return '🎤 Голосовое сообщение';
    case 'video_note': return '⚪ Кружочек';
    case 'media': case 'e2e': return files.length ? contentPreview(text, files) : text || '…';
    default: return text || '…';
  }
}

const quoteWanted = new Map<string, Set<string>>();
let quoteTimer = 0;
function wantQuoted(chatId: string, id: string): void {
  const set = quoteWanted.get(chatId) ?? new Set<string>();
  set.add(id);
  quoteWanted.set(chatId, set);
  if (quoteTimer) return;
  quoteTimer = window.setTimeout(() => {
    quoteTimer = 0;
    const all = [...quoteWanted];
    quoteWanted.clear();
    all.forEach(([chat, ids]) => { void loadQuoted(chat, [...ids]); });
  }, 50);
}

/** Цитата в ответе: автор и коротко, что было в сообщении; нажатие — перейти к нему. */
function quoteEl(m: Msg, chat: MyChat): HTMLElement {
  const id = m.reply_to!;
  const q = button('quote', null, (ev) => { ev.stopPropagation(); void jumpTo(id); });
  const target = quotedMsg(chat.id, id);
  let uid: string | null = null;
  let line: string;
  let author: Who | null = null;
  let thumb: HTMLElement | null = null;
  if (target && target !== 'missing') {
    author = authorOf(target, chat);
    if (target.deleted_at) line = 'Сообщение удалено';
    else if (target.locked) line = '🔒 Зашифрованное сообщение';
    else {
      const view = viewKind(target);
      const files = target.content?.files ?? [];
      line = oneLine(view, view === 'sticker' ? target.body : target.content?.text ?? target.body, files);
      const pic = files.find((f) => f.kind === 'photo' || f.kind === 'video');
      if (pic) {
        const img = el('img', 'quote-thumb');
        img.alt = '';
        const path = pic.thumb?.path ?? pic.path;
        const have = cachedUrl(path);
        if (have) img.src = have;
        else void thumbUrl(pic).then((u) => { img.src = u; }, () => img.remove());
        thumb = img;
      } else if (view === 'sticker' && target.sticker) {
        const st = findSticker(target.sticker, target.body);
        if (st) {
          const img = el('img', 'quote-thumb sticker');
          img.src = stickerUrl(st.ref);
          img.alt = '';
          thumb = img;
        }
      }
    }
  } else if (m.replySnap) {
    uid = m.replySnap.uid;
    author = authorOf({ user_id: uid, kind: m.replySnap.k }, chat);
    line = oneLine(m.replySnap.k, m.replySnap.text);
    if (!target) wantQuoted(chat.id, id);
  } else if (target === 'missing') {
    line = 'Сообщение не найдено';
  } else {
    wantQuoted(chat.id, id);
    line = '…';
  }
  const name = el('span', 'quote-name', author?.name ?? 'Сообщение');
  if (author?.color) name.style.color = author.color;
  if (author?.color) q.style.setProperty('--q', author.color);
  const text = el('span', 'quote-text', line.replace(/\s+/g, ' '));
  const body = el('span', 'quote-body');
  body.append(name, text);
  if (thumb) q.append(thumb);
  q.append(body);
  q.title = 'Перейти к сообщению';
  return q;
}

/** «Переслано от …»: нажатие на имя открывает профиль. */
function fwdEl(f: Forward): HTMLElement {
  const d = el('div', 'fwd');
  const ic = el('span', 'fwd-ic');
  ic.append(html(ICONS.forward));
  d.append(ic, f.kind === 'channel' ? 'Переслано из ' : 'Переслано от ');
  if (f.from) {
    const known = S.profiles.get(f.from);
    const b = button('fwd-name', nickOf(f.from) || known?.name || f.name, (ev) => { ev.stopPropagation(); openPerson(f.from!); });
    d.append(b);
  } else {
    d.append(el('b', 'fwd-name', f.name));
  }
  if (f.at) d.title = `Отправлено ${new Date(ts(f.at)).toLocaleString('ru-RU')}`;
  return d;
}

function iconAction(name: keyof typeof ICONS, label: string, fn: () => void): HTMLButtonElement {
  const b = button('act-ic', null, (ev) => { ev.stopPropagation(); U.openMsg = null; fn(); });
  b.append(html(ICONS[name]));
  b.title = label;
  b.setAttribute('aria-label', label);
  return b;
}

function renderMsg(m: Msg, first: boolean, readUpTo: number, chat: MyChat): HTMLElement {
  if (m.kind === 'call') return callRow(m, chat);
  const channel = chat.kind === 'channel';
  const own = m.user_id === meId() && m.kind !== 'system';
  // В канале посты публикуются от имени канала и стоят слева.
  const mine = own && !channel;
  const deleted = !!m.deleted_at;
  const view = viewKind(m);
  // Стикер и кружочек — без «пузыря», время поверх картинки.
  const bare = !deleted && !m.locked && (view === 'sticker' || view === 'video_note');
  const files = !deleted && !m.locked && (view === 'e2e' || view === 'media') ? m.content?.files ?? [] : [];
  const mediaOnly = files.length > 0 && !m.content?.text && files.every((f) => f.kind !== 'file');
  const selecting = U.sel?.chatId === chat.id;
  const selectable = selecting && !deleted && !m.pending && !m.failed;
  const selected = selectable && U.sel!.ids.has(m.id);
  const row = el('div', `row${mine ? ' mine' : ''}${first ? ' first' : ''}${bare ? ' bare' : ''}`
    + `${selecting ? ' selecting' : ''}${selected ? ' selected' : ''}${U.flash === m.id ? ' flash' : ''}`);
  row.dataset.id = m.id;
  if (U.openMsg === m.id) row.classList.add('open');
  const w: Who = channel ? chatWho(chat) : who(m.user_id, m.kind);
  if (selecting) {
    const mark = el('span', `sel-mark${selectable ? '' : ' off'}`);
    mark.setAttribute('aria-hidden', 'true');
    row.append(mark);
  }
  // В личном чате и с ботом — без аватарок и имён: и так понятно, кто пишет (как в Telegram).
  const oneToOne = chat.kind === 'direct' || chat.kind === 'bot';
  if (!oneToOne) {
    const slot = el('div', 'avslot');
    if (first && !mine) slot.append(avatarEl(w, '', !selecting));
    row.append(slot);
  }

  const wrap = el('div', 'bwrap');
  const kindCls = deleted || m.locked ? '' : view === 'voice' ? ' voice-msg' : bare ? ` media ${view}` : '';
  const b = el('div', `bubble${kindCls}${deleted ? ' deleted' : ''}${m.pending ? ' pending' : ''}${m.failed ? ' failed' : ''}`
    + `${files.length ? ' has-media' : ''}${mediaOnly ? ' media-only' : ''}${m.locked ? ' locked' : ''}`);
  if (first && !mine && !oneToOne) {
    const a = el(w.id ? 'button' : 'span', 'author', w.name);
    if (a instanceof HTMLButtonElement) {
      a.type = 'button';
      a.addEventListener('click', (ev) => { ev.stopPropagation(); openPerson(w.id!); });
    }
    if (w.verified) a.append(verifiedMark(channel ? 'channel' : 'user'));
    if (w.brand) a.style.color = 'var(--ink)';
    else if (w.color) a.style.color = w.color;
    b.append(a);
  }
  if (!deleted && !m.locked && m.fwd) b.append(fwdEl(m.fwd));
  if (!deleted && !m.locked && m.reply_to) b.append(quoteEl(m, chat));
  let textBox: HTMLElement = b;
  if (deleted) b.append('Сообщение удалено');
  else textBox = messageBody(b, m, w.name);
  const meta = el('span', `meta${bare ? ' pill' : ''}${mediaOnly ? ' over' : ''}`);
  if (channel && m.signature && !deleted) meta.append(el('span', 'sign', m.signature), ', ');
  if (m.edited_at && !deleted) meta.append(el('span', 'edited', 'изменено '));
  meta.append(timeLabel(ts(m.created_at)));
  meta.title = new Date(ts(m.created_at)).toLocaleString('ru-RU')
    + (m.edited_at ? ` · изменено ${new Date(ts(m.edited_at)).toLocaleString('ru-RU')}` : '');
  if (mine && !deleted && !m.failed) {
    const read = !m.pending && readUpTo >= ts(m.created_at);
    const tick = el('span', `tick${read ? ' read' : ''}`, m.pending ? '✓' : read ? '✓✓' : '✓');
    tick.setAttribute('aria-label', m.pending ? 'отправляется' : read ? 'прочитано' : 'доставлено');
    if (m.pending) tick.style.opacity = '.45';
    meta.append(tick);
  }
  textBox.append(meta);
  wrap.append(b);

  if (m.failed) {
    const r = el('div', 'retry');
    r.append(
      el('span', null, m.upload?.error ? `Не отправлено: ${m.upload.error.replace(/\.$/, '')}.` : 'Не отправлено.'),
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
        if (chat.preview) chip.disabled = true;
        else chip.addEventListener('click', () => react(m, c.k));
        rs.append(chip);
      });
      wrap.append(rs);
    }
    b.tabIndex = 0;
    if (!selecting) {
      // Над сообщением (при наведении): реакции, «Ответить», «Переслать», «Удалить».
      const act = el('div', 'actions');
      if (!chat.preview) {
        REACTIONS.forEach((R) => {
          const btn = button(null, R.e, (ev) => { ev.stopPropagation(); U.openMsg = null; react(m, R.k); });
          btn.setAttribute('aria-label', `Реакция ${R.e}`);
          act.append(btn);
        });
        act.append(el('span', 'act-sep'));
      }
      if (canPost(chat)) act.append(iconAction('reply', 'Ответить', () => setReply(m)));
      if (canEdit(m, chat)) act.append(iconAction('edit', 'Изменить', () => startEdit(m)));
      if (canForward(m)) act.append(iconAction('forward', 'Переслать', () => openForward([m])));
      if (!chat.preview) act.append(iconAction('check', 'Выбрать', () => startSelect(m)));
      if (canDelete(m, chat)) {
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
      // Правая кнопка мыши — меню сообщения, как в Telegram Desktop.
      b.addEventListener('contextmenu', (ev) => {
        if ((ev.target as HTMLElement).closest('a')) return;
        ev.preventDefault();
        openMenu(m, chat, ev.clientX, ev.clientY);
      });
      // На телефоне — касание или долгое нажатие открывает то же меню.
      const menuAtBubble = () => {
        const r = b.getBoundingClientRect();
        openMenu(m, chat, mine ? r.right : r.left, r.bottom, true);
      };
      b.addEventListener('click', (ev) => {
        if ((ev.target as HTMLElement).closest('a,button,.wave,.vnote') || !touchMQ.matches) return;
        menuAtBubble();
      });
      longPress(b, menuAtBubble);
      if (canPost(chat)) swipeToReply(row, b, () => setReply(m));
    }
  }
  if (selecting) {
    row.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (selectable) toggleSelect(m);
    }, true);
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
      if (canPost(c)) {
        q.append(el('strong', null, 'Здесь пока нет постов'), 'Напишите первый — подписчики увидят его от имени канала.');
        if (shareLinkOf(c)) q.append(el('br'), button('btn primary small', 'Позвать подписчиков', () => void shareInvite(c)));
      } else {
        q.append(el('strong', null, 'Постов пока нет'), 'Как только появятся — они будут здесь.');
      }
    } else {
      q.append(el('strong', null, 'Здесь пока тихо'), 'Напишите первое сообщение или позовите друзей.');
      q.append(el('br'), button('btn primary small', 'Добавить участников', () => openAddMembers(c.id)));
    }
    inner.append(q);
  }

  // ✓✓: сообщение прочитал хотя бы один собеседник; в чате с ботом — бот ответил.
  const others = (S.members.get(c.id) ?? []).filter((m) => m.user_id !== meId());
  const botSeen = c.kind === 'bot' ? f.msgs.filter((m) => m.kind === 'system').map((m) => ts(m.created_at)) : [];
  const readUpTo = Math.max(0, ...others.map((m) => ts(m.last_read_at)), ...botSeen);

  // Плашка о шифровании: в начале чата, перед первым зашифрованным сообщением
  // (если до него была старая открытая переписка) или в конце старой переписки.
  let noteBefore: string | null = null;
  let noteEnd = false;
  if (isE2E(c) && f.loaded) {
    const firstEnc = f.msgs.find((m) => m.kind === 'e2e');
    const isPlain = (m: Msg) => m.kind !== 'e2e' && m.kind !== 'system' && m.kind !== 'call' && !!m.user_id;
    const plainBefore = firstEnc
      ? f.msgs.some((m) => isPlain(m) && ts(m.created_at) < ts(firstEnc.created_at))
      : f.msgs.some(isPlain);
    if (firstEnc && plainBefore) noteBefore = firstEnc.id;
    else if (!firstEnc && plainBefore) noteEnd = true;
    else inner.insertBefore(e2eNote(c, 'top'), inner.querySelector('.quiet'));
  }

  let prev: Msg | null = null;
  let day: string | null = null;
  for (const m of f.msgs) {
    const t = ts(m.created_at);
    if (m.id === noteBefore) { inner.append(e2eNote(c, 'from')); prev = null; day = null; }
    if (day !== dayKey(t)) {
      inner.append(el('div', 'day', dayLabel(t)));
      day = dayKey(t);
      prev = null;
    }
    // Запись о звонке — посередине ленты, как в Discord; после неё автор показывается заново.
    if (m.kind === 'call') { inner.append(renderMsg(m, false, readUpTo, c)); prev = null; continue; }
    const sameAuthor = c.kind === 'channel' || (prev?.user_id === m.user_id && (prev.kind === 'system') === (m.kind === 'system'));
    const first = !prev || !sameAuthor || t - ts(prev.created_at) > 5 * 60 * 1000;
    inner.append(renderMsg(m, first, readUpTo, c));
    prev = m;
  }
  if (noteEnd) inner.append(e2eNote(c, 'next'));

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

function e2eNote(c: MyChat, where: 'top' | 'from' | 'next'): HTMLElement {
  const b = button('e2e-note', null, () => openEncryptionInfo(c));
  const ic = el('span', 'lock');
  ic.append(html(ICONS.lock));
  const text = where === 'from'
    ? 'Дальше сообщения защищены сквозным шифрованием'
    : where === 'next'
      ? 'Новые сообщения в этом чате будут защищены сквозным шифрованием'
      : 'Сообщения, файлы, голосовые и кружочки в этом чате защищены сквозным шифрованием. Прочитать их могут только участники — даже сервер видит лишь шифротекст.';
  b.append(ic, text);
  return b;
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
  if (S.preview && S.preview.id !== id) { S.feeds.delete(S.preview.id); S.preview = null; }
  if (S.cur !== id) {
    // Во время правки поста в поле — текст поста, а черновик сохранён отдельно.
    if (S.cur && !U.edit.delete(S.cur)) U.drafts.set(S.cur, inp.value);
    stopTyping();
    recUI?.cancel();
    closeStickers();
    stopVoice();
    dropNotes(id);
    U.stickerImgs.clear();
    closeMenu();
    if (U.find) closeChatFind();
    if (U.sel && U.sel.chatId !== id) { U.sel = null; U.armedSel = false; }
    S.cur = id;
    U.stick = true;
    U.openMsg = null;
    U.armedDelete = null;
    U.lastCount = 0;
    $('jumpBtn').hidden = true;
    if (!S.preview) lsSet('skam:last', id);
    inp.value = U.drafts.get(id) ?? '';
    loadFeed(id).catch(() => toast('Не удалось загрузить сообщения.'));
  }
  joinChatChannel(isConversation(chatById(id)) ? id : null);
  if (!wideMQ.matches && !document.body.classList.contains('chat-open')) {
    history.pushState({ skamChat: id }, '');
  }
  document.body.classList.add('chat-open');
  renderAll();
  renderCalls();
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
  const target = saved && S.chats.has(saved) ? saved : (listChats(L.cur)[0] ?? sortedChats()[0]).id;
  openChat(target, { silent: true });
}

function closeMissingChat(): void {
  if (S.cur && S.chatsLoaded && !chatById(S.cur)) {
    S.cur = null;
    joinChatChannel(null);
    document.body.classList.remove('chat-open');
    closeDialog($<HTMLDialogElement>('chatDlg'));
    closeDialog($<HTMLDialogElement>('pickDlg'));
    renderConv();
  }
}

/** Записи о звонках в открытой ленте: «Идёт звонок» → «Входящий звонок · 5 мин» без перерисовки всей ленты. */
function refreshCallRows(): void {
  const c = currentChat();
  if (!c) return;
  const msgs = feedOf(c.id).msgs;
  document.querySelectorAll<HTMLElement>('#feed .call-row').forEach((row) => {
    const m = msgs.find((x) => x.id === row.dataset.id);
    if (m) row.replaceWith(callRow(m, c));
  });
}

function renderAll(): void {
  renderSide();
  renderMe();
  renderConv();
  renderHead();
  renderFeed();
  renderCalls();
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
  // Пересылка ждёт отправки — «Отправить» доступна и без текста.
  const has = !!$<HTMLTextAreaElement>('input').value.trim() || (!!S.cur && (U.fwd.has(S.cur) || U.edit.has(S.cur)));
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

/** Почему не отправилось: в личном чате отказ базы значит, что собеседник ограничил сообщения (заблокировал). */
function sendErr(e: unknown, chatId: string | null, fallback: string): string {
  const err = e as { code?: string; message?: string } | null;
  const denied = err?.code === '42501' || !!err?.message?.includes('row-level security');
  if (denied && chatById(chatId)?.kind === 'direct') return 'Не отправлено: этот человек ограничил, кто может ему писать.';
  return errText(e, fallback);
}

async function send(): Promise<void> {
  const inp = $<HTMLTextAreaElement>('input');
  const text = inp.value.trim();
  const id = S.cur;
  const ed = id ? U.edit.get(id) : undefined;
  if (id && ed) { await saveEdit(id, ed, text); return; }
  const fw = id ? U.fwd.get(id) : undefined;
  if (!id || (!text && !fw)) return;
  if (text.length > MAX_LEN) { toast(`Слишком длинное сообщение — до ${MAX_LEN} символов.`); return; }
  inp.value = '';
  U.drafts.delete(id);
  const reply = takeReply(id);
  if (fw) U.fwd.delete(id);
  renderComposerBar();
  autosize();
  stopTyping();
  U.stick = true;
  try {
    // Как в Telegram: сначала комментарий, потом пересланные сообщения.
    if (text) await sendMessage(id, text, [], { reply });
    if (fw) await forwardMessages(id, fw.msgs, fw.hide, { getBlob: (m) => mediaBlob(m.media_path!), onLocal: setLocalMedia });
  } catch (e) {
    toast(sendErr(e, id, fw ? 'Не получилось переслать.' : 'Сообщение не отправилось. Нажмите «Повторить».'));
  }
}

// ---------------------------------------------------------------------------
// Изменить пост канала
// ---------------------------------------------------------------------------

function startEdit(m: Msg): void {
  const c = chatById(m.chat_id);
  if (!c || !canEdit(m, c)) return;
  closeMenu();
  if (U.sel) exitSelect();
  const inp = $<HTMLTextAreaElement>('input');
  if (!U.edit.has(m.chat_id)) U.drafts.set(m.chat_id, inp.value);
  U.edit.set(m.chat_id, m);
  U.reply.delete(m.chat_id);
  U.fwd.delete(m.chat_id);
  inp.value = m.content?.text ?? m.body;
  renderComposerBar();
  autosize();
  inp.focus();
  inp.setSelectionRange(inp.value.length, inp.value.length);
}

function cancelEdit(chatId: string): void {
  if (!U.edit.delete(chatId)) return;
  if (chatId === S.cur) {
    const inp = $<HTMLTextAreaElement>('input');
    inp.value = U.drafts.get(chatId) ?? '';
    renderComposerBar();
    autosize();
  }
}

async function saveEdit(chatId: string, m: Msg, text: string): Promise<void> {
  const files = m.content?.files ?? [];
  if (!text && !files.length) { toast('Пост не может быть пустым — его можно удалить.'); return; }
  if (text.length > MAX_LEN) { toast(`Слишком длинный текст — до ${MAX_LEN} символов.`); return; }
  U.edit.delete(chatId);
  const inp = $<HTMLTextAreaElement>('input');
  inp.value = U.drafts.get(chatId) ?? '';
  U.drafts.delete(chatId);
  renderComposerBar();
  autosize();
  try {
    await editMessage(m, text);
  } catch (e) {
    toast(errText(e, 'Не получилось изменить пост.'));
  }
}

// ---------------------------------------------------------------------------
// Ответить, переслать, выбрать несколько — как в Telegram
// ---------------------------------------------------------------------------

function setReply(m: Msg): void {
  const c = S.chats.get(m.chat_id);
  if (!c || !canPost(c) || m.pending || m.failed || m.deleted_at || m.kind === 'call') return;
  closeMenu();
  if (U.sel) exitSelect();
  cancelEdit(m.chat_id);
  U.reply.set(m.chat_id, m);
  U.fwd.delete(m.chat_id);
  renderComposerBar();
  updateSendBtn();
  if (S.cur === m.chat_id && canPost(c)) $('input').focus({ preventScroll: true });
}

/** Забрать ответ для отправки (он одноразовый). */
function takeReply(chatId: string): Msg | null {
  const r = U.reply.get(chatId) ?? null;
  if (r) {
    U.reply.delete(chatId);
    if (chatId === S.cur) renderComposerBar();
  }
  return r;
}

function cancelComposerBar(): void {
  const id = S.cur;
  if (!id) return;
  if (U.edit.has(id)) { cancelEdit(id); return; }
  U.reply.delete(id);
  U.fwd.delete(id);
  renderComposerBar();
  updateSendBtn();
}

/** Полоска над полем ввода: «ответ на …» или «переслать …» с крестиком. */
function renderComposerBar(): void {
  const bar = document.getElementById('replyBar');
  if (!bar) return;
  const c = currentChat();
  const ed = c ? U.edit.get(c.id) : undefined;
  const fw = c && !ed ? U.fwd.get(c.id) : undefined;
  const r = c && !fw && !ed ? U.reply.get(c.id) : undefined;
  if (!c || (!fw && !r && !ed) || (!canPost(c) && !ed) || U.sel) { bar.hidden = true; bar.replaceChildren(); return; }
  bar.hidden = false;
  const ic = el('span', 'cb-ic');
  ic.append(html(ed ? ICONS.edit : fw ? ICONS.forward : ICONS.reply));
  ic.title = ed ? 'Изменение' : fw ? 'Переслать' : 'Ответ';
  const body = el('button', 'cb-body');
  body.type = 'button';
  const title = el('span', 'cb-title');
  const sub = el('span', 'cb-sub');
  if (ed) {
    title.textContent = 'Изменение поста';
    const snap = snapOf(ed);
    sub.textContent = oneLine(snap.k, snap.text, ed.content?.files ?? []);
    body.title = 'Перейти к посту';
    body.addEventListener('click', () => void jumpTo(ed.id));
  } else if (fw) {
    const n = fw.msgs.length;
    title.textContent = n === 1 ? 'Переслать сообщение' : `Переслать ${plural(n, 'сообщение', 'сообщения', 'сообщений')}`;
    if (fw.hide) sub.textContent = 'без имени отправителя';
    else if (n === 1) {
      const m = fw.msgs[0];
      const snap = snapOf(m);
      sub.textContent = `${forwardOf(m).name}: ${oneLine(snap.k, snap.text, m.content?.files ?? [])}`;
    } else {
      sub.textContent = `от ${[...new Set(fw.msgs.map((m) => forwardOf(m).name))].join(', ')}`;
    }
    body.title = 'Добавьте комментарий или просто нажмите «Отправить»';
    body.addEventListener('click', () => $('input').focus());
  } else if (r) {
    const src = S.chats.get(r.chat_id) ?? c;
    const author = authorOf(r, src);
    title.textContent = author.name;
    if (author.color) title.style.color = author.color;
    const snap = snapOf(r);
    sub.textContent = r.locked ? '🔒 Зашифрованное сообщение' : oneLine(snap.k, snap.text, r.content?.files ?? []);
    body.title = 'Перейти к сообщению';
    body.addEventListener('click', () => void jumpTo(r.id));
  }
  body.append(title, sub);
  const x = button('icon-btn cb-x', null, cancelComposerBar);
  x.append(html(ICONS.close));
  x.setAttribute('aria-label', ed ? 'Отменить изменение' : fw ? 'Не пересылать' : 'Отменить ответ');
  bar.replaceChildren(ic, body, x);
}

/** Ctrl+↑ / Ctrl+↓ в пустом поле — выбрать, на какое сообщение ответить (как в Telegram Desktop). */
function replyStep(dir: -1 | 1): void {
  const c = currentChat();
  if (!c || !canPost(c)) return;
  const list = feedOf(c.id).msgs.filter((m) => !m.deleted_at && !m.pending && !m.failed && m.kind !== 'call');
  const cur = U.reply.get(c.id);
  const i = (cur ? list.findIndex((m) => m.id === cur.id) : list.length) + dir;
  if (i < 0 || i >= list.length) { cancelComposerBar(); return; }
  setReply(list[i]);
  document.querySelector(`#feed .row[data-id="${CSS.escape(list[i].id)}"]`)?.scrollIntoView({ block: 'nearest' });
}

/** Перейти к сообщению по цитате: догружаем историю, если нужно, и подсвечиваем. */
async function jumpTo(id: string): Promise<void> {
  const c = currentChat();
  if (!c) return;
  closeMenu();
  let found = feedOf(c.id).msgs.some((x) => x.id === id);
  if (!found) {
    toast('Ищем сообщение…');
    found = await loadUntil(c.id, id).catch(() => false);
    if (S.cur !== c.id) return;
    if (!found) { toast('Сообщение не найдено — возможно, его удалили.'); return; }
  }
  U.flash = id;
  U.stick = false;
  renderFeed();
  document.querySelector(`#feed .row[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  window.setTimeout(() => {
    if (U.flash !== id) return;
    U.flash = null;
    document.querySelectorAll('#feed .row.flash').forEach((r) => r.classList.remove('flash'));
  }, 1800);
}

// Выбор нескольких сообщений.

function startSelect(m: Msg): void {
  closeMenu();
  if (m.pending || m.failed || m.deleted_at) return;
  U.sel = { chatId: m.chat_id, ids: new Set([m.id]) };
  U.armedSel = false;
  U.openMsg = null;
  renderSelection();
}

function toggleSelect(m: Msg): void {
  if (!U.sel) return;
  if (U.sel.ids.has(m.id)) U.sel.ids.delete(m.id);
  else U.sel.ids.add(m.id);
  U.armedSel = false;
  if (!U.sel.ids.size) { exitSelect(); return; }
  renderSelection();
}

function exitSelect(): void {
  if (!U.sel) return;
  U.sel = null;
  U.armedSel = false;
  renderSelection();
}

function selectedMsgs(): Msg[] {
  const sel = U.sel;
  if (!sel) return [];
  return feedOf(sel.chatId).msgs.filter((m) => sel.ids.has(m.id) && !m.deleted_at);
}

function renderSelection(): void {
  renderSelectBar();
  renderComposerBar();
  renderFeed();
}

function renderSelectBar(): void {
  const bar = document.getElementById('selectBar');
  if (!bar) return;
  const c = currentChat();
  const on = !!c && U.sel?.chatId === c.id;
  $('composer').classList.toggle('selecting', on);
  if (!on) { bar.hidden = true; bar.replaceChildren(); return; }
  bar.hidden = false;
  const list = selectedMsgs();
  const cancel = button('icon-btn sb-x', null, exitSelect);
  cancel.append(html(ICONS.close));
  cancel.setAttribute('aria-label', 'Отменить выбор');
  cancel.title = 'Отменить (Esc)';
  const count = el('span', 'sb-count', `Выбрано: ${list.length}`);
  const fwd = button('btn primary small sb-btn', null, () => openForward(list));
  fwd.append(html(ICONS.forward), el('span', null, 'Переслать'));
  fwd.disabled = !list.length || !list.every(canForward);
  bar.replaceChildren(cancel, count, el('span', 'sb-spacer'), fwd);
  const own = list.length > 0 && !!c && list.every((m) => canDelete(m, c));
  if (own) {
    const del = button('btn danger small sb-btn', U.armedSel ? 'Точно удалить?' : 'Удалить', () => {
      if (!U.armedSel) {
        U.armedSel = true;
        renderSelectBar();
        setTimeout(() => { if (U.armedSel) { U.armedSel = false; renderSelectBar(); } }, 3000);
        return;
      }
      const all = selectedMsgs();
      exitSelect();
      void Promise.all(all.map((m) => deleteMessage(m))).catch((e) => toast(errText(e, 'Не получилось удалить сообщения.')));
    });
    bar.append(del);
  }
}

// Окно «Переслать»: выбрать чат, как в Telegram.

function chatKindLabel(c: MyChat): string {
  if (c.kind === 'direct') return 'личный чат';
  if (c.kind === 'bot') return 'бот';
  if (c.kind === 'channel') return 'канал';
  return plural(c.member_count, 'участник', 'участника', 'участников');
}

function openForward(msgs: Msg[]): void {
  closeMenu();
  const list = msgs.filter(canForward);
  if (!list.length) { toast('Эти сообщения нельзя переслать.'); return; }
  const dlg = $<HTMLDialogElement>('fwdDlg');
  const head = dlgHead(list.length === 1 ? 'Переслать' : `Переслать ${plural(list.length, 'сообщение', 'сообщения', 'сообщений')}`, dlg);
  const q = el('input', 'txt fwd-q');
  q.placeholder = 'Кому переслать…';
  q.setAttribute('aria-label', 'Поиск чата');
  q.autocomplete = 'off';
  const box = el('div', 'fwd-list');
  box.setAttribute('role', 'list');
  const hideRow = el('label', 'check-row');
  const hide = el('input');
  hide.type = 'checkbox';
  hideRow.append(hide, el('span', null, 'Скрыть имя отправителя'));
  const fill = () => {
    const needle = searchNorm(q.value);
    const chats = listChats(null).filter((c) => canPost(c) && (!needle || searchNorm(chatTitle(c)).includes(needle)));
    if (!chats.length) { box.replaceChildren(el('p', 'list-empty', 'Такого чата нет')); return; }
    box.replaceChildren(...chats.map((c) => {
      const b = button('fwd-chat', null, () => pickForward(c, list, hide.checked));
      b.setAttribute('role', 'listitem');
      const text = el('span', 'fwd-text');
      text.append(el('span', 'name', chatTitle(c)), el('span', 'sub', chatKindLabel(c)));
      b.append(chatTileEl(c, 'small'), text);
      return b;
    }));
  };
  q.addEventListener('input', fill);
  q.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    box.querySelector<HTMLButtonElement>('.fwd-chat')?.click();
  });
  fill();
  dlg.replaceChildren(head, q, box, hideRow);
  openDialog(dlg);
  if (!touchMQ.matches) q.focus();
}

function pickForward(c: MyChat, list: Msg[], hide: boolean): void {
  closeDialog($<HTMLDialogElement>('fwdDlg'));
  exitSelect();
  U.fwd.set(c.id, { msgs: list, hide });
  U.reply.delete(c.id);
  openChat(c.id);
  renderComposerBar();
  updateSendBtn();
}

// Меню сообщения: правая кнопка мыши, касание или долгое нажатие на телефоне.

function copyText(m: Msg): string {
  if (m.deleted_at || m.locked) return '';
  const view = viewKind(m);
  if (view === 'sticker' || view === 'voice' || view === 'video_note') return '';
  return (m.content?.text ?? m.body ?? '').trim();
}

function closeMenu(): void {
  const menu = document.getElementById('ctxMenu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  menu.replaceChildren();
  document.body.classList.remove('menu-open');
}

function openMenu(m: Msg, chat: MyChat, x: number, y: number, fromBubble = false): void {
  if (m.pending || m.failed || m.deleted_at) return;
  const menu = $('ctxMenu');
  const own = m.user_id === meId() && m.kind !== 'system';
  const rs = el('div', 'cm-reacts');
  rs.hidden = !!chat.preview;
  REACTIONS.forEach((R) => {
    const b = button(null, R.e, () => { closeMenu(); react(m, R.k); });
    b.setAttribute('aria-label', `Реакция ${R.e}`);
    rs.append(b);
  });
  const items = el('div', 'cm-items');
  const item = (ic: keyof typeof ICONS, label: string, fn: () => void, cls = '') => {
    const b = button(`cm-item${cls ? ` ${cls}` : ''}`, null, fn);
    b.setAttribute('role', 'menuitem');
    b.append(html(ICONS[ic]), el('span', null, label));
    items.append(b);
    return b;
  };
  if (canPost(chat)) item('reply', 'Ответить', () => setReply(m));
  if (canEdit(m, chat)) item('edit', 'Изменить', () => startEdit(m));
  const text = copyText(m);
  if (text) {
    item('copy', 'Копировать текст', () => {
      closeMenu();
      navigator.clipboard.writeText(text).then(() => toast('Текст скопирован'), () => toast('Не получилось скопировать'));
    });
  }
  if (canForward(m)) item('forward', 'Переслать', () => openForward([m]));
  if (!chat.preview) item('check', 'Выбрать', () => startSelect(m));
  if (canDelete(m, chat)) {
    let armed = false;
    const del = item('trash', 'Удалить', () => {
      if (!armed) { armed = true; del.querySelector('span')!.textContent = 'Точно удалить?'; return; }
      closeMenu();
      deleteMessage(m).catch((e) => toast(errText(e, 'Не получилось удалить сообщение.')));
    }, 'danger');
  }
  menu.replaceChildren(rs, items);
  menu.hidden = false;
  document.body.classList.add('menu-open');
  const r = menu.getBoundingClientRect();
  const mine = own && chat.kind !== 'channel';
  let left = fromBubble && mine ? x - r.width : x;
  left = Math.max(8, Math.min(window.innerWidth - r.width - 8, left));
  let top = y + (fromBubble ? 6 : 0);
  if (top + r.height > window.innerHeight - 8) top = Math.max(8, y - r.height - (fromBubble ? 12 : 0));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  (items.querySelector('button') as HTMLButtonElement | null)?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// Вложения: скрепка, перетаскивание, вставка из буфера
// ---------------------------------------------------------------------------

function startSendFiles(files: File[]): void {
  const c = currentChat();
  if (!c || !canPost(c) || !files.length) return;
  const inp = $<HTMLTextAreaElement>('input');
  const first = !sendDialogOpen();
  // Как в Telegram: набранный текст становится подписью, а при отмене возвращается в поле ввода.
  const caption = first ? inp.value : '';
  closeStickers();
  openSendDialog(files, {
    caption,
    send: (cap, prepared) => { void sendFiles(c.id, cap, prepared); },
    onCancel: (cap) => { if (!inp.value) { inp.value = cap; autosize(); } },
  });
  if (first && sendDialogOpen()) {
    inp.value = '';
    autosize();
    stopTyping();
  }
}

async function sendFiles(chatId: string, caption: string, prepared: Prepared[]): Promise<void> {
  U.stick = true;
  U.drafts.delete(chatId);
  const reply = takeReply(chatId);
  for (let i = 0; i < prepared.length; i += MAX_ALBUM) {
    const chunk = prepared.slice(i, i + MAX_ALBUM);
    try {
      await sendMessage(chatId, i === 0 ? caption : '', chunk, i === 0 ? { reply } : {});
    } catch (e) {
      toast(sendErr(e, chatId, 'Не получилось отправить. Нажмите «Повторить».'));
    }
  }
}

function hasFiles(e: DragEvent): boolean {
  return !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
}

// ---------------------------------------------------------------------------
// Шифрование: ключ собеседника, сведения о шифровании, смена пароля
// ---------------------------------------------------------------------------

function openEncryptionInfo(c: MyChat): void {
  const dlg = $<HTMLDialogElement>('keyDlg');
  const stack = el('div', 'stack');
  const where = c.kind === 'direct' ? 'в этом чате' : 'в этой группе';
  stack.append(
    el('p', null, `Сообщения, фото, видео, файлы, стикеры, голосовые и кружочки ${where} шифруются прямо на устройствах участников и расшифровываются только у них. На сервере СКАМ лежит лишь шифротекст.`),
  );
  if (c.kind === 'group') {
    stack.append(el('p', 'hint', 'Новые участники получают ключ и видят историю группы. Когда кто-то выходит, группа переходит на новый ключ — вышедший не прочитает то, что напишут после него.'));
  }
  stack.append(el('p', 'hint', 'Ключ шифрования хранится на ваших устройствах. На новом устройстве его восстанавливает пароль шифрования.'));
  dlg.replaceChildren(dlgHead('Сквозное шифрование', dlg), stack);
  openDialog(dlg);
}

function openChangePassword(): void {
  const dlg = $<HTMLDialogElement>('keyDlg');
  const form = el('form', 'stack');
  form.noValidate = true;
  const mk = (id: string, label: string, ac: string) => {
    const f = el('div', 'field');
    const l = el('label', 'fld', label);
    l.htmlFor = id;
    const i = el('input', 'txt');
    Object.assign(i, { id, type: 'password', autocomplete: ac, maxLength: 200 });
    f.append(l, i);
    return { f, i };
  };
  const cur = mk('pwCur', 'Текущий пароль шифрования', 'current-password');
  const n1 = mk('pwNew1', 'Новый пароль', 'new-password');
  const n2 = mk('pwNew2', 'Повторите новый пароль', 'new-password');
  const err = el('p', 'err');
  const save = el('button', 'btn primary', 'Сменить пароль');
  save.type = 'submit';
  save.style.alignSelf = 'flex-start';
  form.append(cur.f, n1.f, n2.f, el('p', 'hint', `Ключ шифрования останется прежним — переписка никуда не денется. Не короче ${MIN_PASSWORD} символов.`), err, save);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (n1.i.value.length < MIN_PASSWORD) { err.textContent = `Новый пароль должен быть не короче ${MIN_PASSWORD} символов.`; n1.i.focus(); return; }
    if (n1.i.value !== n2.i.value) { err.textContent = 'Новые пароли не совпадают.'; n2.i.focus(); return; }
    save.disabled = true;
    save.textContent = 'Сохраняем…';
    try {
      await e2e.changePassword(cur.i.value, n1.i.value);
      closeDialog(dlg);
      toast('Пароль шифрования изменён');
    } catch (e) {
      err.textContent = e instanceof e2e.WrongPasswordError ? 'Неверный текущий пароль.' : errText(e);
      save.disabled = false;
      save.textContent = 'Сменить пароль';
    }
  });
  dlg.replaceChildren(dlgHead('Пароль шифрования', dlg), form);
  openDialog(dlg);
  cur.i.focus();
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
  // Неофициальные наборы — без особых меток. У своего пустого набора — кнопка «Добавить стикеры».
  for (const p of customPacks()) {
    if (!p.stickers.length && !p.mine) continue;
    section(p.id, p.title, p.stickers);
    const sec = body.lastElementChild;
    const h = sec?.querySelector('.sp-title');
    const more = button('sp-more', null, () => { closeStickers(); openStickerPack(p.id); });
    more.append(html(p.mine ? ICONS.edit : ICONS.next));
    more.title = p.mine ? 'Изменить набор' : 'О наборе';
    more.setAttribute('aria-label', `${more.title}: ${p.title}`);
    h?.append(more);
    if (!p.stickers.length) {
      sec?.append(button('btn ghost small sp-empty', 'Пока пусто — добавить стикеры', () => { closeStickers(); openStickerPack(p.id); }));
    }
    const cover = p.stickers[0] ? el('img') : el('span', 'sp-letter', p.title.trim().charAt(0).toUpperCase() || '?');
    if (cover instanceof HTMLImageElement) { cover.src = stickerUrl(p.stickers[0].ref); cover.alt = ''; }
    tab(p.id, p.title, cover);
  }
  // «＋» — свои наборы: создать, изменить, добавленные.
  const add = button('sp-tab sp-add', null, () => { closeStickers(); openStickerManager(); });
  add.append(html(ICONS.plus));
  add.title = 'Свои стикеры';
  add.setAttribute('aria-label', 'Свои стикеры: создать набор');
  tabs.append(add);
  panel.replaceChildren(tabs, body);
}

function stickersOpen(): boolean {
  return !$('stickerPanel').hidden;
}

function openStickers(): void {
  if (!canPost(currentChat())) return;
  // Наборы могли добавить на другом устройстве — освежаем тихо.
  void loadMyPacks().catch(() => {});
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
    await sendSticker(id, st, { reply: takeReply(id) });
  } catch (e) {
    toast(sendErr(e, id, 'Стикер не отправился. Нажмите «Повторить».'));
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
  sendRecorded(chatId, kind, rec, setLocalMedia, { reply: takeReply(chatId) }).catch((e) => {
    toast(sendErr(e, chatId, kind === 'voice' ? 'Голосовое не отправилось. Нажмите «Повторить».' : 'Кружочек не отправился. Нажмите «Повторить».'));
  });
}

/** Следующее голосовое после этого — играем подряд. */
function nextVoiceAfter(cur: { id: string; chatId: string }): Msg | null {
  const msgs = feedOf(cur.chatId).msgs;
  const i = msgs.findIndex((x) => x.id === cur.id);
  if (i < 0) return null;
  return msgs.slice(i + 1).find((x) => viewKind(x) === 'voice' && !x.deleted_at && x.media_path) ?? null;
}

// ---------------------------------------------------------------------------
// Диалог «Новый чат»
// ---------------------------------------------------------------------------

function openNew(view: 'home' | 'find' | 'link' = 'home'): void {
  $<HTMLInputElement>('findUser').value = '';
  $<HTMLInputElement>('linkInput').value = '';
  $('linkErr').textContent = '';
  findSeq++;
  clearTimeout(findTimer);
  showFindHint();
  newView(view);
  openDialog($<HTMLDialogElement>('newDlg'));
  if (view !== 'home' && !touchMQ.matches) (view === 'find' ? $('findUser') : $('linkInput')).focus();
}

/** «Новый чат»: список действий, поиск человека или вход по ссылке — в одном окне. */
function newView(view: 'home' | 'find' | 'link'): void {
  $('newHome').hidden = view !== 'home';
  $('newFind').hidden = view !== 'find';
  $('newLink').hidden = view !== 'link';
  if (view === 'find') setTimeout(() => $('findUser').focus(), 30);
  if (view === 'link') setTimeout(() => $('linkInput').focus(), 30);
}

/**
 * «Войти по ссылке»: ссылка-приглашение (…?join=КОД), публичный канал (…?c=имя или @имя),
 * набор стикеров (…?stickers=…) или просто код приглашения.
 */
function openByLink(): void {
  const raw = $<HTMLInputElement>('linkInput').value.trim();
  const err = $('linkErr');
  err.textContent = '';
  if (!raw) { err.textContent = 'Вставьте ссылку или код.'; return; }
  let join: string | null = null;
  let pub: string | null = null;
  let pack: string | null = null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (/[./]/.test(raw)) {
      join = u.searchParams.get('join');
      pub = u.searchParams.get('c');
      pack = u.searchParams.get('stickers');
    }
  } catch { /* не ссылка */ }
  if (!join && !pub && !pack) {
    if (/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(raw)) pub = raw;
    else if (/^[A-Za-z0-9_-]{6,64}$/.test(raw)) join = raw;
  }
  if (pub && /^@?[A-Za-z][A-Za-z0-9_]{4,31}$/.test(pub)) lsSet('skam:open', pub.replace(/^@/, '').toLowerCase());
  else if (pack && /^u[0-9a-f]{11}$/.test(pack)) lsSet('skam:stickers', pack);
  else if (join) lsSet('skam:join', join);
  else { err.textContent = 'Это не похоже на ссылку СКАМ. Проверьте, что скопировали её целиком.'; return; }
  closeDialog($<HTMLDialogElement>('newDlg'));
  void handlePendingJoin();
}

function startCreate(kind: 'group' | 'channel'): void {
  closeDialog($<HTMLDialogElement>('newDlg'));
  openCreate(kind);
}

// Поиск людей: по имени, фамилии или @username — прямо во время набора.
const FIND_HINT = 'Имя, фамилия, @username или название публичного канала — от 2 символов.';
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
  // Профиль найденного человека открывается по нажатию на имя или фото, даже без общего чата.
  rememberProfiles([person]);
  const nick = nickOf(person.id);
  const w: Who = {
    id: person.id, name: nick || person.name || 'Участник', avatar: avatarUrl(person.avatar_path), color: person.color, verified: person.verified,
  };
  const text = button('found-text found-open', null, () => openPerson(person.id));
  text.setAttribute('aria-label', `Профиль: ${w.name}`);
  const nm = el('span', 'nm');
  nm.append(q.at ? document.createTextNode(w.name) : highlight(w.name, q.toks));
  if (w.verified) nm.append(verifiedMark());
  const sub = el('span', 'uname');
  if (person.username) {
    sub.append('@', highlight(person.username, q.at ? [q.s] : q.toks, true));
  }
  if (nick && person.name) {
    const real = el('span', 'found-tag');
    if (person.username) real.append(el('span', 'sep', ' · '));
    real.append(q.at ? document.createTextNode(person.name) : highlight(person.name, q.toks));
    sub.append(real);
  }
  if (person.is_contact) {
    const tag = el('span', 'found-tag');
    if (sub.childNodes.length) tag.append(el('span', 'sep', ' · '));
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
  row.append(avatarEl(w, '', true), text, action);
  return row;
}

/** Публичный канал в результатах поиска: «Открыть» — лента до подписки. */
function foundChannel(card: ChatCard, q: { at: boolean; s: string; toks: string[] }): HTMLElement {
  const row = el('div', 'found');
  const text = el('span', 'found-text');
  const nm = el('span', 'nm');
  nm.append(q.at ? document.createTextNode(card.name) : highlight(card.name, q.toks));
  if (card.verified) nm.append(verifiedMark('channel'));
  const sub = el('span', 'uname');
  if (card.username) sub.append('@', highlight(card.username, q.at ? [q.s] : q.toks, true));
  const tag = el('span', 'found-tag');
  tag.append(el('span', 'sep', ' · '), `канал, ${plural(card.member_count, 'подписчик', 'подписчика', 'подписчиков')}`);
  sub.append(tag);
  text.append(nm, sub);
  const action = button(`btn ${card.is_member ? 'ghost' : 'primary'} small`, 'Открыть', () => {
    closeDialog($<HTMLDialogElement>('newDlg'));
    openCard(card);
  });
  action.setAttribute('aria-label', `Открыть канал ${card.name}`);
  row.append(cardTile(card), text, action);
  return row;
}

/** Открыть группу или канал по карточке: свой — сразу, публичный канал — до подписки. */
function openCard(card: ChatCard): void {
  if (card.is_member && S.chats.has(card.id)) { openChat(card.id); return; }
  setPreview(card);
  openChat(card.id);
}

async function subscribePreview(): Promise<void> {
  const c = currentChat();
  if (!c?.preview) return;
  const btn = $<HTMLButtonElement>('joinBtn');
  btn.disabled = true;
  try {
    await joinChannel(c.id);
    toast(`Вы подписались на «${c.name}»`);
    renderAll();
  } catch (e) {
    toast(errText(e, 'Не получилось подписаться.'));
  } finally {
    btn.disabled = false;
  }
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
    let chans: ChatCard[];
    try {
      [found, chans] = await Promise.all([searchUsers(raw), searchChats(raw).catch(() => [] as ChatCard[])]);
    } catch (e) {
      if (my === findSeq) out.replaceChildren(el('p', 'err', errText(e, 'Не получилось найти. Попробуйте ещё раз.')));
      return;
    }
    if (my !== findSeq) return;
    // Сначала те, кому вы дали ник, — по нику их ищет только ваш поиск.
    const nicked = nickHits(q);
    const nickedIds = new Set(nicked.map((p) => p.id));
    found = [...nicked, ...found.filter((p) => !nickedIds.has(p.id))];
    if (!found.length && !chans.length) {
      out.replaceChildren(el('p', 'err', q.at ? `@${q.s} не найден — ни человек, ни публичный канал.` : `Никого не нашли по запросу «${raw.trim()}».`));
      return;
    }
    const list = el('div', 'found-list');
    list.setAttribute('role', 'list');
    // Точное @имя канала — наверх.
    const exact = chans.filter((c) => c.username === q.s);
    const rest = chans.filter((c) => c.username !== q.s);
    const addChans = (cs: ChatCard[]) => cs.forEach((c) => { const r = foundChannel(c, q); r.setAttribute('role', 'listitem'); list.append(r); });
    addChans(exact);
    found.forEach((p) => { const r = foundRow(p, q); r.setAttribute('role', 'listitem'); list.append(r); });
    if (rest.length) {
      if (found.length || exact.length) list.append(el('p', 'fld found-sep', 'Каналы'));
      addChans(rest);
    }
    out.replaceChildren(list);
  }
}

// ---------------------------------------------------------------------------
// Мой профиль: главный экран и вложенные — «Изменить профиль», истории, конфиденциальность, уведомления
// ---------------------------------------------------------------------------

type ProfView = 'home' | 'edit' | 'stories' | 'privacy' | 'blocked' | 'notify' | 'about';
let profView: ProfView = 'home';

function openProfile(view: ProfView = 'home'): void {
  const dlg = $<HTMLDialogElement>('profileDlg');
  profView = view;
  renderProfile();
  if (!dlg.open) openDialog(dlg);
}

function profGo(view: ProfView): void {
  profView = view;
  renderProfile();
  $('profileDlg').scrollTop = 0;
}

function contactLine(): string {
  const u = S.user;
  if (!u) return '';
  if (u.phone) return `Телефон: +${u.phone.replace(/^\+/, '')}`;
  const email = realEmail(u);
  return email ? `Почта: ${email}` : '';
}

function renderProfile(): void {
  const dlg = $<HTMLDialogElement>('profileDlg');
  if (!S.me) return;
  const parts = profView === 'edit' ? profEdit(dlg)
    : profView === 'stories' ? profStories(dlg)
      : profView === 'privacy' ? profPrivacy(dlg)
        : profView === 'blocked' ? profBlocked(dlg)
          : profView === 'notify' ? profNotify(dlg)
            : profView === 'about' ? profAbout(dlg)
              : profHome(dlg);
  dlg.classList.toggle('sub', profView !== 'home');
  dlg.replaceChildren(...parts);
}

/** Загрузить новое фото профиля (кнопка с камерой и «Изменить профиль»). */
function avatarPicker(onDone: () => void): { input: HTMLInputElement; pick: () => void } {
  const input = el('input');
  Object.assign(input, { type: 'file', accept: 'image/*', hidden: true });
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    if (!f) return;
    toast('Загружаем фото…');
    try {
      await uploadAvatar(f);
      toast('Фото обновлено');
    } catch (e) {
      toast(errText(e, 'Не получилось загрузить фото.'));
    }
    onDone();
  });
  return { input, pick: () => input.click() };
}

/** «Оформление»: как в системе, светлая или тёмная. */
function themeRow(): HTMLElement {
  const r = el('div', 'lr theme-row');
  const ic = el('span', 'lr-ic');
  ic.append(html(ICONS.palette));
  const seg = el('div', 'seg-mini');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Тема');
  const cur = getTheme();
  ([['auto', 'Авто'], ['light', 'Светлая'], ['dark', 'Тёмная']] as [Theme, string][]).forEach(([t, label]) => {
    const b = button(null, label, () => { setTheme(t); renderProfile(); });
    b.setAttribute('aria-pressed', String(t === cur));
    if (t === 'auto') b.title = 'Как в системе';
    seg.append(b);
  });
  const text = el('span', 'lr-t');
  text.append(el('span', 'lr-l', 'Оформление'));
  r.append(ic, text, seg);
  return r;
}

/** Состояние уведомлений одним словом — справа в строке «Уведомления». */
function notifyState(): string {
  const perm = notifyPermission();
  if (perm === 'unsupported') return 'Нет';
  return notifyPrefs().on && perm === 'granted' ? 'Вкл' : 'Выкл';
}

async function logout(): Promise<void> {
  closeDialog($<HTMLDialogElement>('profileDlg'));
  await calls.hangup(true);
  await goOffline();
  await e2e.forgetDevice(meId());
  dropMediaUrls();
  void sb.auth.signOut();
}

function profHome(dlg: HTMLDialogElement): HTMLElement[] {
  const me = S.me!;
  const hero = el('div', 'sh-hero');
  const av = el('div', 'sh-av');
  const pick = avatarPicker(() => renderProfile());
  av.append(avatarEl(who(meId()), 'xxl'));
  const cam = button('sh-cam', null, () => pick.pick());
  cam.append(html(ICONS.camera));
  cam.setAttribute('aria-label', me.avatar_path ? 'Сменить фото' : 'Загрузить фото');
  cam.title = me.avatar_path ? 'Сменить фото' : 'Загрузить фото';
  av.append(cam, pick.input);
  const name = el('h2', 'sh-name');
  name.append(el('span', 'nm-t', me.name || 'Без имени'));
  if (me.verified) name.append(verifiedMark());
  const sub = el('p', 'sh-sub');
  if (me.username) sub.append(`@${me.username} · `);
  sub.append(navigator.onLine !== false ? el('span', 'on', 'в сети') : 'нет подключения');
  hero.append(av, name, sub);

  const mine = ST.byAuthor.get(meId())?.stories.length ?? 0;
  const avg = ratingShort();
  return [
    sheetHead(dlg, null),
    hero,
    grp(
      row({ icon: 'edit', label: 'Изменить профиль', chev: true, fn: () => profGo('edit') }),
      row({ icon: 'storyAdd', label: 'Мои истории', em: mine ? String(mine) : 'Добавить', chev: true, fn: () => profGo('stories') }),
      row({
        icon: 'folder', label: 'Папки с чатами', em: L.folders.length ? String(L.folders.length) : null, chev: true,
        fn: () => { closeDialog(dlg); openFolderSettings(); },
      }),
      themeRow(),
    ),
    grp(
      row({ icon: 'lock', label: 'Конфиденциальность', em: S.blocks.size ? `${S.blocks.size} в блоке` : null, chev: true, fn: () => profGo('privacy') }),
      row({ icon: 'bell', label: 'Уведомления', em: notifyState(), chev: true, fn: () => profGo('notify') }),
      row({ icon: 'help', label: 'Поддержка', chev: true, fn: () => { closeDialog(dlg); openSupport(); } }),
      row({ icon: 'star', label: 'Оценить СКАМ', em: avg, chev: true, fn: () => { closeDialog(dlg); openRate(); } }),
      row({ icon: 'info', label: 'О приложении', em: __SKAM_VERSION__, chev: true, fn: () => profGo('about') }),
    ),
    grp(row({ icon: 'logout', label: 'Выйти', danger: true, confirm: 'Точно выйти? Нажмите ещё раз', fn: () => void logout() })),
  ];
}

function profEdit(dlg: HTMLDialogElement): HTMLElement[] {
  const me = S.me!;
  const stack = el('div', 'sh-body stack');

  // Фото
  const avEdit = el('div', 'av-edit');
  const btns = el('div', 'btns');
  const pick = avatarPicker(() => renderProfile());
  btns.append(button('btn ghost small', me.avatar_path ? 'Сменить фото' : 'Загрузить фото', () => pick.pick()));
  if (me.avatar_path) {
    btns.append(button('btn danger small', 'Убрать', async () => {
      try { await removeAvatar(); renderProfile(); } catch (e) { toast(errText(e)); }
    }));
  }
  avEdit.append(avatarEl(who(meId()), 'xl'), btns, pick.input);

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
  const first = mk('profFirst', 'Имя', { maxLength: 40, autocomplete: 'given-name', value: keep('profFirst') ?? me.first_name ?? '' });
  const last = mk('profLast', 'Фамилия', { maxLength: 40, autocomplete: 'family-name', placeholder: 'необязательно', value: keep('profLast') ?? me.last_name ?? '' });
  const unRequired = usernameRequired();
  const user = mk('profUser', 'Имя пользователя', { maxLength: 33, autocomplete: 'username', placeholder: unRequired ? '@username' : 'необязательно', required: unRequired, value: keep('profUser') ?? (me.username ? `@${me.username}` : '') });
  const UN_HINT = unRequired
    ? 'Обязательно. По нему вас находят и пишут вам. Латиница, цифры и _, от 5 символов.'
    : 'Для этого аккаунта необязательно. Латиница, цифры и _, от 5 символов.';
  const unHint = el('p', 'hint', UN_HINT);
  user.f.append(unHint);

  // О себе — видят все, кто откроет профиль.
  const bioF = el('div', 'field');
  const bioL = el('label', 'fld', 'О себе');
  bioL.htmlFor = 'profBio';
  const bio = el('textarea', 'txt area bio-input');
  Object.assign(bio, {
    id: 'profBio', maxLength: BIO_MAX, rows: 3, placeholder: 'Пара слов о себе: чем занимаетесь, что любите',
    value: keep('profBio') ?? me.bio ?? '',
  });
  const bioHint = el('p', 'hint bio-hint');
  const bioCount = el('span', 'bio-count');
  bioHint.append(el('span', null, 'Видят все, кто откроет ваш профиль.'), bioCount);
  const syncBio = () => {
    const left = BIO_MAX - bio.value.length;
    bioCount.textContent = String(left);
    bioCount.classList.toggle('low', left <= 10);
    bioCount.setAttribute('aria-label', `Осталось символов: ${left}`);
  };
  bio.addEventListener('input', syncBio);
  syncBio();
  bioF.append(bioL, bio, bioHint);
  const err = el('p', 'err');
  const save = button('btn primary', 'Сохранить', () => void saveProfile());

  let unOk = true;
  let seq = 0;
  let unTimer: number | undefined;
  user.i.addEventListener('input', () => {
    clearTimeout(unTimer);
    const v = normUsername(user.i.value);
    unHint.classList.remove('ok', 'bad');
    if (!v) {
      unOk = !unRequired;
      unHint.textContent = unRequired ? 'Имя пользователя обязательно.' : UN_HINT;
      if (unRequired) unHint.classList.add('bad');
      return;
    }
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
    if (!un && unRequired) { err.textContent = 'Имя пользователя обязательно — по нему вас находят.'; user.i.focus(); return; }
    if (un && (!USERNAME_RE.test(un) || !unOk)) { err.textContent = 'Выберите другое имя пользователя.'; user.i.focus(); return; }
    save.disabled = true;
    try {
      const about = normBio(bio.value);
      await updateMyProfile({ first_name: fn, last_name: ln || null, username: un || null, bio: about || null });
      toast('Профиль сохранён');
      profGo('home');
    } catch (e) {
      err.textContent = (e as { code?: string }).code === '23505' ? 'Это имя пользователя уже занято.' : errText(e, 'Не получилось сохранить.');
      save.disabled = false;
    }
  }
  [first.i, last.i, user.i].forEach((i) => i.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void saveProfile(); }
  }));
  // В «О себе» Enter — новая строка, Ctrl+Enter (⌘+Enter) — сохранить.
  bio.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); void saveProfile(); }
  });
  const actions = el('div', 'dlg-actions');
  actions.append(button('btn ghost', 'Отмена', () => profGo('home')), save);
  stack.append(avEdit, first.f, last.f, user.f, bioF, err, actions);
  return [sheetHead(dlg, 'Изменить профиль', () => profGo('home')), stack];
}

function profStories(dlg: HTMLDialogElement): HTMLElement[] {
  const body = el('div', 'sh-body');
  body.append(storyGrid(meId()));
  return [sheetHead(dlg, 'Мои истории', () => profGo('home')), body];
}

function profPrivacy(dlg: HTMLDialogElement): HTMLElement[] {
  const methods = loginMethods(S.user);
  const enc = el('div', 'lr');
  const encIc = el('span', 'lr-ic ok');
  encIc.append(html(ICONS.lock));
  const encT = el('span', 'lr-t');
  encT.append(el('span', 'lr-l', 'Сквозное шифрование включено'), el('span', 'lr-sub', 'Личные чаты и группы шифруются на ваших устройствах.'));
  enc.append(encIc, encT);
  const who2 = el('div', 'lr');
  const whoIc = el('span', 'lr-ic');
  whoIc.append(html(ICONS.storyAdd));
  const whoT = el('span', 'lr-t');
  whoT.append(el('span', 'lr-l', 'Мои истории видят'), el('span', 'lr-sub', 'Все, с кем у вас личный чат, — кроме заблокированных.'));
  who2.append(whoIc, whoT);
  const login = el('div', 'lr');
  const loginIc = el('span', 'lr-ic');
  loginIc.append(html(ICONS.userPlus));
  const loginT = el('span', 'lr-t');
  loginT.append(el('span', 'lr-l', contactLine() || 'Аккаунт СКАМ'));
  if (methods.length) loginT.append(el('span', 'lr-sub', `Вход: ${methods.join(', ')}`));
  login.append(loginIc, loginT);
  return [
    sheetHead(dlg, 'Конфиденциальность', () => profGo('home')),
    grp(row({
      icon: 'ban', label: 'Заблокированные', em: S.blocks.size ? String(S.blocks.size) : 'Нет', chev: true, fn: () => profGo('blocked'),
    })),
    grpNote('Заблокированные не могут писать вам в личный чат и звонить и не видят ваши истории — а вы их.'),
    grpLabel('Шифрование'),
    grp(enc, row({ icon: 'edit', label: 'Сменить пароль шифрования', chev: true, fn: () => openChangePassword() })),
    grpLabel('Истории'),
    grp(who2),
    grpLabel('Вход'),
    grp(login),
    grpNote(`После выхода ключ шифрования удалится с этого устройства: чтобы войти снова, понадобятся ${
      methods.some((m) => m !== 'почта' && m !== 'телефон') ? 'вход' : 'код'} и пароль шифрования.`),
  ];
}

function profBlocked(dlg: HTMLDialogElement): HTMLElement[] {
  const head = sheetHead(dlg, 'Заблокированные', () => profGo('privacy'));
  if (!S.blocks.size) {
    return [head, grpNote('Вы никого не заблокировали. Заблокировать человека можно в его профиле или в меню «⋮» личного чата.')];
  }
  const rows = [...S.blocks.values()].map((b) => {
    const r = el('div', 'lr person-lr');
    const w: Who = { id: b.user_id, name: nickOf(b.user_id) || b.name || 'Участник', avatar: avatarUrl(b.avatar_path), color: b.color, verified: b.verified };
    const open = button('pl-open', null, () => openPerson(b.user_id));
    const t = el('span', 'lr-t');
    const nm = el('span', 'lr-l');
    nm.append(el('span', 'nm-t', w.name));
    if (w.verified) nm.append(verifiedMark());
    t.append(nm, el('span', 'lr-sub', b.username ? `@${b.username}` : 'пользователь СКАМ'));
    open.append(avatarEl(w), t);
    open.setAttribute('aria-label', `Профиль: ${w.name}`);
    const un = button('btn ghost small', 'Разблокировать', async () => {
      un.disabled = true;
      try {
        await blockUser(b.user_id, false);
        toast(`${w.name} разблокирован(а)`);
        void refreshStories();
      } catch (e) {
        toast(errText(e, 'Не получилось разблокировать.'));
        un.disabled = false;
      }
    });
    r.append(open, un);
    return r;
  });
  return [head, grp(...rows), grpNote('Разблокированный снова сможет писать и звонить вам и увидит ваши истории.')];
}

function profNotify(dlg: HTMLDialogElement): HTMLElement[] {
  const P = notifyPrefs();
  const perm = notifyPermission();
  const permSub = perm === 'unsupported' ? 'Этот браузер не умеет показывать уведомления'
    : perm === 'denied' ? 'Запрещены в браузере — разрешите их для этого сайта в настройках'
      : 'Когда СКАМ свёрнут или открыт в другой вкладке';
  const muted = [...S.chats.values()].filter((c) => chatMuted(c.id))
    .sort((a, b) => chatTitle(a).localeCompare(chatTitle(b), 'ru'));
  const mutedRows = muted.map((c) => {
    const r = el('div', 'lr person-lr');
    const open = button('pl-open', null, () => { closeDialog(dlg); openChat(c.id); });
    const t = el('span', 'lr-t');
    t.append(el('span', 'lr-l', chatTitle(c)), el('span', 'lr-sub', muteLabel(c.id)));
    open.append(chatTileEl(c), t);
    const on = button('btn ghost small', 'Включить', () => setMute(c.id, null));
    r.append(open, on);
    return r;
  });
  return [
    sheetHead(dlg, 'Уведомления', () => profGo('home')),
    grp(
      toggleRow('bell', 'Уведомления', permSub, P.on && perm === 'granted', async (next) => {
        if (!next) { setNotifyPrefs({ on: false }); renderProfile(); return; }
        const r = await askPermission();
        if (r === 'granted') {
          setNotifyPrefs({ on: true });
          soundUnlock();
        } else {
          toast(r === 'denied' ? 'Браузер запретил уведомления — разрешите их для этого сайта в настройках браузера.'
            : 'Уведомления не включились.');
        }
        renderProfile();
      }, perm === 'unsupported'),
      toggleRow('eye', 'Текст сообщения', 'Показывать в уведомлении, что написали', P.preview, (next) => {
        setNotifyPrefs({ preview: next });
        renderProfile();
      }),
      toggleRow('sound', 'Звук', 'Короткий сигнал о новом сообщении', P.sound, (next) => {
        setNotifyPrefs({ sound: next });
        if (next) { soundUnlock(); setTimeout(chime, 60); }
        renderProfile();
      }),
      perm === 'granted' && P.on ? row({ icon: 'bell', label: 'Проверить уведомление', fn: () => void testNotify() }) : null,
    ),
    grpNote('Уведомления приходят, пока СКАМ открыт — во вкладке браузера или как приложение. Закрытый СКАМ не уведомляет. Чаты без звука молчат.'),
    grpLabel('Без звука'),
    muted.length ? grp(...mutedRows) : grpNote('Таких чатов нет. Выключить звук чата можно в меню «⋮» в его шапке или правой кнопкой мыши по чату в списке.'),
  ];
}

function profAbout(dlg: HTMLDialogElement): HTMLElement[] {
  const hero = el('div', 'sh-hero about');
  hero.append(html(APP_ICON_HERO), el('span', 'wordmark', 'СКАМ'), el('p', 'sh-sub', 'Не развод, а мессенджер'),
    el('p', 'sh-sub', `Версия ${__SKAM_VERSION__}`));
  const linkRow = (a: HTMLAnchorElement, icon: IconName, text: string) => {
    a.className = 'lr';
    const ic = el('span', 'lr-ic');
    ic.append(html(ICONS[icon]));
    const t = el('span', 'lr-t');
    t.append(el('span', 'lr-l', text));
    const ch = el('span', 'lr-chev');
    ch.append(html(ICONS.chev));
    a.replaceChildren(ic, t, ch);
    return a;
  };
  return [
    sheetHead(dlg, 'О приложении', () => profGo('home')),
    hero,
    grp(
      linkRow(termsLink(), 'file', 'Пользовательское соглашение'),
      linkRow(privacyLink(), 'lock', 'Политика конфиденциальности'),
      row({ icon: 'help', label: 'Написать в поддержку', chev: true, fn: () => { closeDialog(dlg); openSupport(); } }),
    ),
    grpNote('Нашли ошибку или есть идея — напишите в поддержку. Ответ придёт на почту.'),
  ];
}

/** «Без звука» или «Включить звук» — с подсказкой, что получилось. */
function setMute(chatId: string, until: number | null): void {
  muteChat(chatId, until).then(
    () => toast(until === null ? 'Звук включён' : until === Infinity ? 'Чат без звука' : `${muteLabel(chatId)}`),
    (e) => toast(errText(e, 'Не получилось изменить звук чата.')),
  );
}

/** Заблокировать или разблокировать — из карточки, меню чата или списка заблокированных. */
async function toggleBlock(uid: string, on: boolean): Promise<void> {
  const name = who(uid).name;
  try {
    await blockUser(uid, on);
    toast(on ? `${name} заблокирован(а)` : `${name} разблокирован(а)`);
    void refreshStories();
  } catch (e) {
    toast(errText(e, on ? 'Не получилось заблокировать.' : 'Не получилось разблокировать.'));
  }
}

// ---------------------------------------------------------------------------
// Карточка человека: «Чат», «Звонок», «Видео», «Без звука», медиа, общие группы, ник, блокировка
// ---------------------------------------------------------------------------

type PersonView = 'home' | 'media' | 'groups' | 'nick';
let personUid: string | null = null;
let personView: PersonView = 'home';
let mediaTab: 'media' | 'files' = 'media';
/** Сроки «Без звука» раскрыты под плитками. */
let muteOpen = false;
/** «О себе» людей без общего чата (их профиль целиком не виден), чтобы не мигало при повторном открытии. */
const bioCache = new Map<string, string | null>();
/** Общие группы — чтобы число не мигало при перерисовке. */
const groupsCache = new Map<string, CommonGroup[]>();

/** Личный чат с человеком, если он уже есть. */
function directWith(uid: string): MyChat | undefined {
  for (const c of S.chats.values()) if (c.kind === 'direct' && c.peer_id === uid) return c;
  return undefined;
}

/** Статус и «О себе» в открытой карточке человека обновляются вместе со всеми остальными. */
function refreshPersonStatus(): void {
  if (!personUid) return;
  const p = S.profiles.get(personUid);
  const about = document.getElementById('personAbout');
  // «О себе» из профиля — только если профиль прочитан целиком (иначе его подгружает user_bio).
  if (about && p?.created_at) fillAbout(about, p.bio);
  const st = document.getElementById('personSt');
  if (!st) return;
  st.textContent = statusText(p);
  st.classList.toggle('on', isOnline(p));
}

/** Строка «О себе» в карточке: пусто — строки не видно. */
function fillAbout(box: HTMLElement, bio: string | null | undefined): void {
  const text = bio?.trim() ?? '';
  if (box.dataset.bio === text && box.childNodes.length) return;
  box.dataset.bio = text;
  box.hidden = !text;
  if (!text) { box.replaceChildren(); return; }
  const t = el('span', 'lr-t');
  const l = el('span', 'lr-l pa-text');
  fillText(l, text);
  t.append(l, el('span', 'lr-sub', 'О себе'));
  box.replaceChildren(t);
}

function closePersonAnd(): void {
  closeDialog($<HTMLDialogElement>('personDlg'));
  closeDialog($<HTMLDialogElement>('chatDlg'));
  closeDialog($<HTMLDialogElement>('newDlg'));
  closeDialog($<HTMLDialogElement>('profileDlg'));
}

async function writeTo(uid: string, then?: (chatId: string) => void): Promise<void> {
  try {
    const id = await openDirect(uid);
    closePersonAnd();
    openChat(id);
    then?.(id);
  } catch (e) {
    toast(errText(e, then ? 'Не получилось позвонить.' : 'Не получилось открыть личный чат.'));
  }
}

function openPerson(uid: string, view: PersonView = 'home'): void {
  // Свою карточку не показываем — это «Мой профиль».
  if (uid === meId()) { openProfile(); return; }
  const dlg = $<HTMLDialogElement>('personDlg');
  void ensureProfiles([uid]);
  if (personUid !== uid) muteOpen = false;
  personUid = uid;
  personView = view;
  renderPerson();
  if (!dlg.open) openDialog(dlg);
}

function personGo(view: PersonView): void {
  personView = view;
  renderPerson();
  $('personDlg').scrollTop = 0;
}

function renderPerson(): void {
  const uid = personUid;
  if (!uid) return;
  const dlg = $<HTMLDialogElement>('personDlg');
  const parts = personView === 'media' ? personMedia(dlg, uid)
    : personView === 'groups' ? personGroups(dlg, uid)
      : personView === 'nick' ? personNick(dlg, uid)
        : personHome(dlg, uid);
  dlg.classList.toggle('sub', personView !== 'home');
  dlg.replaceChildren(...parts);
}

/** Сроки «Без звука» прямо в карточке (меню поверх окна не видно). */
function muteChoices(chatId: string, done: () => void): HTMLElement {
  const box = el('div', 'mute-opts');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Без звука');
  MUTE_FOR.forEach((m) => {
    box.append(button('mo-btn', m.label.replace(/^На /, ''), () => {
      setMute(chatId, m.ms === Infinity ? Infinity : Date.now() + m.ms);
      done();
    }));
  });
  return box;
}

/** Плитки «Чат», «Звонок», «Видео», «Без звука». */
function personTiles(uid: string, chat: MyChat | undefined): HTMLElement[] {
  const blocked = S.blocks.has(uid);
  const canRing = calls.canCall() && !blocked;
  const ringTitle = blocked ? 'Вы заблокировали этого человека' : !calls.canCall() ? 'Звонки в этом браузере недоступны' : undefined;
  const muted = !!chat && chatMuted(chat.id);
  const tiles = el('div', 'sh-tiles');
  tiles.append(
    actionTile('message', 'Чат', () => void writeTo(uid)),
    actionTile('phone', 'Звонок', () => void writeTo(uid, (id) => call(id, false)), { disabled: !canRing, title: ringTitle }),
    actionTile('video', 'Видео', () => void writeTo(uid, (id) => call(id, true)), { disabled: !canRing, title: ringTitle }),
    actionTile(muted ? 'bellOff' : 'bell', muted ? 'Без звука' : 'Звук', () => {
      if (!chat) return;
      if (muted) { setMute(chat.id, null); return; }
      muteOpen = !muteOpen;
      renderPerson();
    }, {
      disabled: !chat, on: muted || muteOpen,
      title: !chat ? 'Появится, когда начнёте личный чат' : muted ? `${muteLabel(chat.id)} — нажмите, чтобы включить звук` : 'Выключить звук',
    }),
  );
  const out: HTMLElement[] = [tiles];
  if (chat && muteOpen && !muted) out.push(muteChoices(chat.id, () => { muteOpen = false; }));
  return out;
}

function personHome(dlg: HTMLDialogElement, uid: string): HTMLElement[] {
  const p = S.profiles.get(uid);
  const w = who(uid);
  const nick = nickOf(uid);
  const chat = directWith(uid);
  const blocked = S.blocks.has(uid);

  const hero = el('div', 'sh-hero');
  // Есть истории — аватарка в кольце, по нажатию они открываются.
  const rc = ringClass(uid);
  if (rc) {
    const ring = button(`person-ring ${rc}`, null, () => { closeDialog(dlg); openStoriesOf(uid); });
    ring.append(avatarEl(w, 'xxl'));
    ring.setAttribute('aria-label', 'Смотреть истории');
    ring.title = 'Смотреть истории';
    hero.append(ring);
  } else {
    const av = el('div', 'sh-av');
    av.append(avatarEl(w, 'xxl'));
    hero.append(av);
  }
  const name = el('h2', 'sh-name');
  name.append(el('span', 'nm-t', w.name));
  if (w.verified) name.append(verifiedMark());
  hero.append(name);
  // С ником — под ним настоящее имя, как человек назвал себя сам.
  if (nick && p?.name) {
    const real = el('p', 'sh-real', p.name);
    real.title = 'Имя в профиле';
    hero.append(real);
  }
  const st = el('p', `sh-sub st${isOnline(p) ? ' on' : ''}`, blocked ? 'заблокирован(а)' : statusText(p));
  if (!blocked) st.id = 'personSt';
  hero.append(st);

  // @username и «О себе»
  const uname = p?.username ? row({
    label: `@${p.username}`, sub: 'Имя пользователя', title: 'Скопировать',
    fn: () => { navigator.clipboard.writeText(`@${p.username}`).then(() => toast('Имя пользователя скопировано'), () => {}); },
  }) : null;
  const about = el('div', 'lr lr-about');
  about.id = 'personAbout';
  about.hidden = true;
  if (p?.created_at) fillAbout(about, p.bio);
  else {
    // Уже загружали — показываем сразу (без мигания), а свежее подтягиваем.
    if (bioCache.has(uid)) fillAbout(about, bioCache.get(uid));
    void userBio(uid).then((bio) => {
      bioCache.set(uid, bio);
      if (personUid === uid && about.isConnected) fillAbout(about, bio);
    }, () => {});
  }

  // Медиа и файлы — из загруженных сообщений личного чата.
  const files = chat ? chatFiles(chat.id) : [];
  const media = chat ? row({
    icon: 'media', label: 'Медиа и файлы', em: files.length ? String(files.length) : null, chev: true,
    fn: () => { mediaTab = 'media'; personGo('media'); },
  }) : null;
  const known = groupsCache.get(uid);
  const groups = row({
    icon: 'users', label: 'Общие группы', em: known ? String(known.length) : '…', chev: true, fn: () => personGo('groups'),
  });
  void commonGroups(uid).then((list) => {
    const before = groupsCache.get(uid)?.length;
    groupsCache.set(uid, list);
    if (before !== list.length && personUid === uid && personView === 'home' && groups.isConnected) {
      const em = groups.querySelector('.lr-em');
      if (em) em.textContent = String(list.length);
    }
  }, () => {});
  const nickRow = row({
    icon: 'tag', label: nick ? 'Изменить ник' : 'Дать ник', em: nick, chev: true, title: 'Ник видите только вы',
    fn: () => personGo('nick'),
  });

  const out: HTMLElement[] = [
    sheetHead(dlg, null),
    hero,
    ...personTiles(uid, chat),
    grp(uname, about),
    storyGrid(uid),
    grp(media, groups, nickRow),
    grp(blocked
      ? row({ icon: 'ban', label: 'Разблокировать', fn: () => void toggleBlock(uid, false) })
      : row({ icon: 'ban', label: 'Заблокировать', danger: true, confirm: 'Точно заблокировать? Нажмите ещё раз', fn: () => void toggleBlock(uid, true) })),
  ];
  if (blocked) out.push(grpNote('Вы заблокировали этого человека: он не может писать и звонить вам и не видит ваши истории.'));
  // Владелец СКАМ выдаёт и снимает официальные галочки прямо из профиля.
  if (S.appOwner && p) {
    const on = !!p.verified;
    const owner = el('div', 'owner-box');
    const tgl = button(`btn ${on ? 'ghost' : 'primary'} small`, null, async () => {
      tgl.disabled = true;
      try {
        await setVerified('user', uid, !on);
        toast(on ? 'Галочка снята' : 'Официальная галочка выдана');
        renderPerson();
      } catch (e) {
        toast(errText(e, 'Не получилось изменить галочку.'));
        tgl.disabled = false;
      }
    });
    tgl.append(html(ICONS.verified), on ? 'Снять галочку' : 'Выдать галочку');
    owner.append(tgl, el('p', 'hint', 'Вы владелец СКАМ: официальную галочку видят все.'));
    out.push(owner);
  }
  return out;
}

/** Вложения из загруженных сообщений чата — свежие первыми. */
function chatFiles(chatId: string): { m: Msg; a: Attachment }[] {
  const out: { m: Msg; a: Attachment }[] = [];
  const msgs = S.feeds.get(chatId)?.msgs ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.deleted_at || m.pending || m.failed || m.locked) continue;
    for (const a of m.content?.files ?? []) if (a.path) out.push({ m, a });
  }
  return out;
}

function personMedia(dlg: HTMLDialogElement, uid: string): HTMLElement[] {
  const head = sheetHead(dlg, 'Медиа и файлы', () => personGo('home'));
  const chat = directWith(uid);
  if (!chat) return [head, grpNote('Личного чата пока нет.')];
  const feed = feedOf(chat.id);
  if (!feed.loaded) void loadFeed(chat.id).then(() => { if (personView === 'media') renderPerson(); }, () => {});
  const all = chatFiles(chat.id);
  const visual = all.filter((x) => x.a.kind === 'photo' || x.a.kind === 'video');
  const docs = all.filter((x) => x.a.kind !== 'photo' && x.a.kind !== 'video');
  const seg = el('div', 'seg two');
  seg.setAttribute('role', 'group');
  ([['media', `Медиа${visual.length ? ` · ${visual.length}` : ''}`], ['files', `Файлы${docs.length ? ` · ${docs.length}` : ''}`]] as const).forEach(([k, label]) => {
    const b = button(null, label, () => { mediaTab = k; renderPerson(); });
    b.setAttribute('aria-pressed', String(mediaTab === k));
    seg.append(b);
  });
  const body = el('div', 'sh-body');
  body.append(seg);
  const list = mediaTab === 'media' ? visual : docs;
  if (!feed.loaded) body.append(el('p', 'hint mf-empty', 'Загружаем…'));
  else if (!list.length) {
    body.append(el('p', 'hint mf-empty', mediaTab === 'media'
      ? 'Фото и видео из вашей переписки появятся здесь.' : 'Файлы из вашей переписки появятся здесь.'));
  } else if (mediaTab === 'media') {
    const grid = el('div', 'mf-grid');
    list.forEach(({ m, a }) => grid.append(mediaTile(m, a, who(m.user_id).name)));
    body.append(grid);
  } else {
    const docsBox = el('div', 'mf-docs docs');
    list.forEach(({ m, a }) => docsBox.append(fileRow(m, a)));
    body.append(docsBox);
  }
  if (feed.loaded && feed.hasMore) {
    const more = button('btn ghost small mf-more', feed.loadingOlder ? 'Загружаем…' : 'Показать более ранние', () => {
      more.disabled = true;
      void loadOlder(chat.id).then(() => { if (personView === 'media') renderPerson(); }, () => { more.disabled = false; });
    });
    more.disabled = feed.loadingOlder;
    body.append(more);
  }
  return [head, body];
}

function personGroups(dlg: HTMLDialogElement, uid: string): HTMLElement[] {
  const head = sheetHead(dlg, 'Общие группы', () => personGo('home'));
  const list = groupsCache.get(uid);
  if (!list) {
    void commonGroups(uid).then((l) => { groupsCache.set(uid, l); if (personView === 'groups') renderPerson(); }, () => {});
    return [head, grpNote('Загружаем…')];
  }
  if (!list.length) return [head, grpNote('Общих групп нет.')];
  const rows = list.map((g) => {
    const c = S.chats.get(g.id);
    const r = button('lr person-lr', null, () => { closePersonAnd(); openChat(g.id); });
    const t = el('span', 'lr-t');
    t.append(el('span', 'lr-l', g.name ?? 'Группа'), el('span', 'lr-sub', plural(g.member_count, 'участник', 'участника', 'участников')));
    r.append(c ? chatTileEl(c) : cardTile(g), t);
    return r;
  });
  return [head, grp(...rows)];
}

/** Ник человека: видит его только тот, кто дал. */
function personNick(dlg: HTMLDialogElement, uid: string): HTMLElement[] {
  const nick = nickOf(uid);
  const realName = S.profiles.get(uid)?.name ?? '';
  const body = el('div', 'sh-body stack');
  const lbl = el('label', 'fld', 'Ник');
  lbl.htmlFor = 'nickInput';
  const inp = el('input', 'txt');
  Object.assign(inp, {
    id: 'nickInput', maxLength: NICK_MAX, value: nick ?? '', placeholder: realName || 'Как вы его назовёте',
    autocomplete: 'off', spellcheck: false,
  });
  inp.setAttribute('enterkeyhint', 'done');
  const err = el('p', 'err');
  const btns = el('div', 'dlg-actions');
  const save = button('btn primary', 'Сохранить', () => void commit(inp.value));
  if (nick) btns.append(button('btn danger', 'Убрать', () => void commit('')));
  btns.append(save);
  const commit = async (v: string) => {
    save.disabled = true;
    try {
      const got = await setNickname(uid, v);
      toast(got ? `Ник сохранён: ${got}` : 'Ник убран');
      if (personUid === uid) personGo('home');
    } catch (e) {
      err.textContent = errText(e, 'Не получилось сохранить ник.');
      save.disabled = false;
    }
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void commit(inp.value); }
  });
  body.append(lbl, inp,
    el('p', 'hint', `Ник видите только вы — везде вместо ${realName ? `«${realName}»` : 'имени'}: в чатах, группах, звонках и поиске.`),
    err, btns);
  setTimeout(() => { inp.focus(); inp.select(); }, 30);
  return [sheetHead(dlg, nick ? 'Изменить ник' : 'Дать ник', () => personGo('home')), body];
}

// ---------------------------------------------------------------------------
// О чате: участники, приглашение, переименование, выход
// ---------------------------------------------------------------------------

async function shareInvite(c: MyChat): Promise<void> {
  const link = shareLinkOf(c);
  if (!link) return;
  const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
  if (touchMQ.matches && nav.share) {
    const what = c.kind === 'channel' ? `Канал «${chatTitle(c)}» в СКАМ` : `Чат «${chatTitle(c)}» в СКАМ`;
    try { await nav.share({ title: what, text: c.kind === 'channel' ? 'Подписывайся на канал в СКАМ:' : 'Заходи в чат в СКАМ:', url: link }); return; } catch { /* отменили */ }
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
  openChatAdmin(c.id);
}

function openBotCard(): void {
  const dlg = $<HTMLDialogElement>('personDlg');
  const c = currentChat();
  personUid = null;
  dlg.classList.remove('sub');
  const hero = el('div', 'sh-hero');
  const av = el('div', 'sh-av');
  const tile = el('span', 'tile official mark xxl');
  tile.append(html(MARK_SVG));
  av.append(tile);
  const h = el('h2', 'sh-name');
  h.append(el('span', 'nm-t', 'СКАМ'), verifiedMark('bot'));
  hero.append(av, h, el('p', 'sh-sub', 'бот'));
  const muted = !!c && chatMuted(c.id);
  const tiles = el('div', 'sh-tiles two');
  tiles.append(
    actionTile('message', 'Чат', () => closeDialog(dlg)),
    actionTile(muted ? 'bellOff' : 'bell', muted ? 'Без звука' : 'Звук', () => {
      if (!c) return;
      setMute(c.id, muted ? null : Infinity);
      setTimeout(openBotCard, 0);
    }, { on: muted, disabled: !c, title: muted ? 'Включить звук' : 'Выключить звук навсегда' }),
  );
  dlg.replaceChildren(
    sheetHead(dlg, null), hero, tiles,
    grp(row({ label: 'Бот-помощник СКАМ. Напишите ему «помощь» — расскажет, что умеет.', sub: 'О боте' })),
  );
  if (!dlg.open) openDialog(dlg);
}

// ---------------------------------------------------------------------------
// Меню «⋮» в шапке чата и поиск по сообщениям
// ---------------------------------------------------------------------------

function infoLabel(c: MyChat): string {
  return c.kind === 'direct' ? 'Профиль' : c.kind === 'bot' ? 'О боте' : c.kind === 'channel' ? 'О канале' : 'О группе';
}

/** «Без звука»: сроки, как в Telegram. */
function openMuteMenu(c: MyChat, x: number, y: number, back?: () => void): void {
  const items: MenuItem[] = [{ head: 'Без звука', back }];
  MUTE_FOR.forEach((m) => items.push({
    icon: 'bellOff', label: m.label, fn: () => setMute(c.id, m.ms === Infinity ? Infinity : Date.now() + m.ms),
  }));
  showMenu(items, x, y);
}

/** Пункты про звук и блокировку — в меню «⋮» и в меню чата в списке. */
function muteBlockItems(c: MyChat, x: number, y: number, back: () => void): MenuItem[] {
  const items: MenuItem[] = [];
  if (c.preview) return items;
  if (chatMuted(c.id)) items.push({ icon: 'bell', label: 'Включить звук', fn: () => setMute(c.id, null) });
  else items.push({ icon: 'bellOff', label: 'Без звука…', fn: () => openMuteMenu(c, x, y, back) });
  if (c.kind === 'direct' && c.peer_id) {
    const peer = c.peer_id;
    if (S.blocks.has(peer)) items.push({ icon: 'ban', label: 'Разблокировать', fn: () => void toggleBlock(peer, false) });
    else items.push({ icon: 'ban', label: 'Заблокировать', danger: true, confirm: 'Точно заблокировать?', fn: () => void toggleBlock(peer, true) });
  }
  return items;
}

function openHeadMenu(): void {
  const c = currentChat();
  if (!c) return;
  const r = $('headMenuBtn').getBoundingClientRect();
  const x = r.right;
  const y = r.bottom + 6;
  const items: MenuItem[] = [
    { icon: 'info', label: infoLabel(c), fn: openChatInfo },
    { icon: 'search', label: 'Поиск по чату', fn: openChatFind },
    ...muteBlockItems(c, x, y, openHeadMenu),
  ];
  showMenu(items, x, y);
}

/** Поиск по сообщениям открытого чата: среди загруженных, «↑» догружает более ранние. */
function openChatFind(): void {
  const c = currentChat();
  if (!c) return;
  if (!U.find || U.find.chatId !== c.id) U.find = { chatId: c.id, q: '', hits: [], i: -1 };
  $('chatFind').hidden = false;
  const q = $<HTMLInputElement>('chatFindQ');
  q.value = U.find.q;
  q.focus();
  q.select();
  renderChatFind();
}

function closeChatFind(): void {
  U.find = null;
  $('chatFind').hidden = true;
  $('chatFindN').textContent = '';
}

function findText(m: Msg): string {
  return searchNorm(`${copyText(m)} ${(m.content?.files ?? []).map((a) => a.name).join(' ')}`);
}

function findHits(chatId: string, q: string): string[] {
  const msgs = feedOf(chatId).msgs;
  const out: string[] = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m.pending && !m.deleted_at && findText(m).includes(q)) out.push(m.id);
  }
  return out;
}

let findTimer2 = 0;
function onChatFindInput(): void {
  clearTimeout(findTimer2);
  findTimer2 = window.setTimeout(() => {
    const f = U.find;
    if (!f) return;
    f.q = searchNorm($<HTMLInputElement>('chatFindQ').value).trim();
    f.hits = f.q.length >= 2 ? findHits(f.chatId, f.q) : [];
    f.i = f.hits.length ? 0 : -1;
    renderChatFind();
    if (f.i >= 0) void jumpTo(f.hits[0]);
  }, 220);
}

/** d = 1 — раньше (вверх по ленте), -1 — позже. */
async function chatFindStep(d: 1 | -1): Promise<void> {
  const f = U.find;
  if (!f || f.q.length < 2) return;
  if (d === -1) {
    if (f.i > 0) { f.i--; renderChatFind(); void jumpTo(f.hits[f.i]); }
    return;
  }
  if (f.i + 1 < f.hits.length) { f.i++; renderChatFind(); void jumpTo(f.hits[f.i]); return; }
  // Дальше совпадений нет — догружаем более ранние сообщения (до 5 страниц за раз).
  const feed = feedOf(f.chatId);
  const had = f.hits.length;
  for (let n = 0; n < 5 && feed.hasMore; n++) {
    $('chatFindN').textContent = 'Ищем…';
    await loadOlder(f.chatId).catch(() => {});
    if (U.find !== f) return;
    f.hits = findHits(f.chatId, f.q);
    if (f.hits.length > had) break;
  }
  if (f.hits.length > had) { f.i = had; void jumpTo(f.hits[f.i]); } else toast('Раньше совпадений нет');
  renderChatFind();
}

function renderChatFind(): void {
  const f = U.find;
  const n = $('chatFindN');
  if (!f || f.q.length < 2) { n.textContent = ''; return; }
  const more = feedOf(f.chatId).hasMore;
  n.textContent = f.hits.length ? `${f.i + 1} из ${f.hits.length}${more ? '+' : ''}` : more ? 'Нет — ↑ искать раньше' : 'Ничего';
  $<HTMLButtonElement>('chatFindDown').disabled = f.i <= 0;
}

// ---------------------------------------------------------------------------
// Приглашения ?join=КОД
// ---------------------------------------------------------------------------

async function handlePendingJoin(): Promise<void> {
  // Чат из уведомления (?chat=<id>), когда СКАМ был закрыт.
  const chatId = lsGet('skam:chat');
  if (chatId) {
    lsSet('skam:chat', null);
    if (S.chats.has(chatId)) openChat(chatId);
  }
  // Набор стикеров по ссылке ?stickers=<id>.
  const pack = lsGet('skam:stickers');
  if (pack) {
    lsSet('skam:stickers', null);
    openStickerPack(pack);
  }
  // Публичный канал: ?c=имя — открываем ленту (до подписки — с кнопкой «Подписаться»).
  const pub = lsGet('skam:open');
  if (pub) {
    lsSet('skam:open', null);
    try {
      const card = await chatByUsername(pub);
      if (!card) toast(`Канал @${pub} не найден.`);
      else openCard(card);
    } catch (e) {
      toast(errText(e, 'Не получилось открыть канал.'));
    }
  }
  const code = lsGet('skam:join');
  if (!code) return;
  lsSet('skam:join', null);
  let info: ChatCard | null;
  try {
    info = await previewInvite(code);
  } catch (e) {
    toast(errText(e, 'Не получилось открыть приглашение.'));
    return;
  }
  if (!info) { toast('Приглашение не найдено или устарело.'); return; }
  if (info.is_member) { openChat(info.id); return; }
  const card = info;
  const channel = card.kind === 'channel';
  const dlg = $<HTMLDialogElement>('joinDlg');
  const box = el('div', 'person-card');
  const tile = cardTile(card);
  tile.style.cssText = 'margin:0 auto 12px;width:72px;height:72px;font-size:36px;border-radius:22px';
  const title = el('h2', 'person-name', card.name);
  if (card.verified) title.append(verifiedMark('channel'));
  box.append(tile, title, el('p', 'st', channel
    ? `Вас пригласили в канал · ${plural(card.member_count, 'подписчик', 'подписчика', 'подписчиков')}`
    : `Вас пригласили в группу · ${plural(card.member_count, 'участник', 'участника', 'участников')}`));
  if (card.description) {
    const d = el('p', 'join-desc');
    fillText(d, card.description);
    box.append(d);
  }
  const actions = el('div', 'dlg-actions');
  const joinBtn = button('btn primary', channel ? 'Подписаться' : 'Вступить', async () => {
    joinBtn.disabled = true;
    try {
      const id = await joinByInvite(code);
      closeDialog(dlg);
      openChat(id);
      toast(channel ? `Вы подписались на «${card.name}»` : `Вы вступили в «${card.name}»`);
    } catch (e) {
      toast(errText(e, channel ? 'Не получилось подписаться.' : 'Не получилось вступить в группу.'));
      joinBtn.disabled = false;
    }
  });
  actions.append(button('btn ghost', 'Не сейчас', () => closeDialog(dlg)), joinBtn);
  box.append(actions);
  dlg.replaceChildren(box);
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
  listen($('newBtn'), 'click', () => openNew());
  listen($('emptyNewBtn'), 'click', () => openNew());
  listen($('cancelBtn'), 'click', () => closeDialog($<HTMLDialogElement>('newDlg')));
  listen($('newFindX'), 'click', () => closeDialog($<HTMLDialogElement>('newDlg')));
  listen($('newLinkX'), 'click', () => closeDialog($<HTMLDialogElement>('newDlg')));
  listen($('newFindBtn'), 'click', () => newView('find'));
  listen($('newLinkBtn'), 'click', () => newView('link'));
  listen($('newFindBack'), 'click', () => newView('home'));
  listen($('newLinkBack'), 'click', () => newView('home'));
  listen($('linkForm'), 'submit', (e: Event) => { e.preventDefault(); openByLink(); });
  listen($('newGroupBtn'), 'click', () => startCreate('group'));
  listen($('newChannelBtn'), 'click', () => startCreate('channel'));
  listen($('newStoryBtn'), 'click', () => { closeDialog($<HTMLDialogElement>('newDlg')); openComposer(); });
  listen($('joinBtn'), 'click', () => void subscribePreview());
  listen($('backBtn'), 'click', () => backToList());
  listen($('headBtn'), 'click', openChatInfo);
  listen($('findBtn'), 'click', () => { if (U.find && !$('chatFind').hidden) closeChatFind(); else openChatFind(); });
  listen($('headMenuBtn'), 'click', (e: MouseEvent) => { e.stopPropagation(); openHeadMenu(); });
  listen($('chatFindQ'), 'input', onChatFindInput);
  listen($('chatFindQ'), 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void chatFindStep(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeChatFind(); }
  });
  listen($('chatFindUp'), 'click', () => void chatFindStep(1));
  listen($('chatFindDown'), 'click', () => void chatFindStep(-1));
  listen($('chatFindX'), 'click', closeChatFind);
  // Аватарка в шапке: у собеседника есть истории — открыть их, иначе — «О чате».
  listen($('convEmoji'), 'click', () => {
    const c = currentChat();
    if (c?.kind === 'direct' && c.peer_id && storyState(c.peer_id) !== 'none') openStoriesOf(c.peer_id);
    else openChatInfo();
  });
  listen($('sideTgl'), 'click', () => setSideMini(!sideMini()));
  listen($('sideGrip'), 'click', () => setSideMini(!sideMini()));
  // В свёрнутом списке поиск — кнопка: разворачиваем и ставим курсор в поле.
  listen($('sideSearch'), 'pointerdown', (e: PointerEvent) => {
    if (!sideMini() || !wideMQ.matches) return;
    e.preventDefault();
    setSideMini(false);
    setTimeout(() => $('chatSearch').focus(), 80);
  });
  listen($('chatSearch'), 'focus', () => { if (sideMini() && wideMQ.matches) setSideMini(false); });
  listen($('meBox'), 'click', () => openProfile());
  listen($('sendBtn'), 'click', () => void send());
  listen($('stickerBtn'), 'click', () => { if (stickersOpen()) closeStickers(); else openStickers(); });
  const inp = $<HTMLTextAreaElement>('input');
  listen(inp, 'input', () => { autosize(); onType(); });
  listen(inp, 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touchMQ.matches) { e.preventDefault(); void send(); }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && (e.ctrlKey || e.metaKey) && !inp.value) {
      e.preventDefault();
      replyStep(e.key === 'ArrowUp' ? -1 : 1);
    }
    if (e.key === 'Escape' && S.cur && (U.reply.has(S.cur) || U.fwd.has(S.cur) || U.edit.has(S.cur)) && !stickersOpen()) {
      e.preventDefault();
      cancelComposerBar();
    }
  });
  listen(inp, 'blur', () => { setTimeout(stopTyping, 800); });
  listen(inp, 'paste', (e: ClipboardEvent) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length) { e.preventDefault(); startSendFiles(files); }
  });
  const fileInput = $<HTMLInputElement>('fileInput');
  listen($('attachBtn'), 'click', () => fileInput.click());
  listen(fileInput, 'change', () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = '';
    startSendFiles(files);
  });
  // Перетаскивание файлов в беседу.
  const conv = $('convMain');
  const drop = $('drop');
  let dragDepth = 0;
  listen(conv, 'dragenter', (e: DragEvent) => {
    if (!hasFiles(e) || !canPost(currentChat())) return;
    e.preventDefault();
    dragDepth++;
    drop.hidden = false;
  });
  listen(conv, 'dragover', (e: DragEvent) => {
    if (!hasFiles(e) || !canPost(currentChat())) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  listen(conv, 'dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) drop.hidden = true;
  });
  listen(conv, 'drop', (e: DragEvent) => {
    dragDepth = 0;
    drop.hidden = true;
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (canPost(currentChat())) startSendFiles([...(e.dataTransfer?.files ?? [])]);
  });
  // Файл, брошенный мимо беседы, браузер не должен открывать вместо СКАМ.
  listen(window, 'dragover', (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); });
  listen(window, 'drop', (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); });
  unsubs.push(wireViewer(), wireSendDialog());
  const feed = $('feed');
  // Меню сообщения закрываем, когда листают сами (лента прокручивается и при перерисовке — это не повод).
  listen(feed, 'wheel', closeMenu);
  listen(feed, 'touchmove', closeMenu);
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
    if (document.visibilityState === 'visible') {
      renderSide();
      markVisibleRead();
      // Папки, ники, блокировки и «без звука» могли поменять на другом устройстве.
      void loadLayout().catch(() => {});
      void loadNicknames().catch(() => {});
      void loadPrefs().catch(() => {});
    } else stopTyping();
  });
  listen(document, 'keydown', (e: KeyboardEvent) => {
    // Ctrl+Shift+E (⌘+Shift+E) — свернуть или развернуть список чатов.
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'E' || e.key === 'e' || e.code === 'KeyE') && wideMQ.matches) {
      e.preventDefault();
      setSideMini(!sideMini());
      return;
    }
    if (e.key !== 'Escape') return;
    const menu = document.getElementById('ctxMenu');
    if (menu && !menu.hidden) { closeMenu(); return; }
    if (stickersOpen()) { closeStickers(); $('stickerBtn').focus(); return; }
    if (U.sel && !document.querySelector('dialog[open]')) exitSelect();
  });
  listen(document, 'pointerdown', (e: PointerEvent) => {
    const t = e.target as HTMLElement;
    if (stickersOpen() && !t.closest('#stickerPanel,#stickerBtn')) closeStickers();
    if (!t.closest('#ctxMenu')) closeMenu();
  });
  listen(window, 'resize', closeMenu);
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
  listen($('chatSearch'), 'input', onSearchInput);
  listen($('chatSearch'), 'keydown', onSearchKey);
  listen($('searchClear'), 'click', () => { clearSearch(); $('chatSearch').focus(); });
  listen($('chatList'), 'scroll', closeMenu);
  listen($('findForm'), 'submit', (e: Event) => { e.preventDefault(); void runFind(true); });
  listen($('findUser'), 'input', () => void runFind(false));
  for (const id of ['newDlg', 'profileDlg', 'chatDlg', 'personDlg', 'joinDlg', 'keyDlg', 'fwdDlg', 'supportDlg', 'rateDlg', 'pickDlg', 'stickerDlg',
    'folderDlg', 'folderPickDlg', 'foldersDlg']) {
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
  // @username обязателен: без него база не даст писать сообщения. Исключение — username_optional.
  if (!S.me?.first_name || (!S.me?.username && usernameRequired())) {
    // «Старый аккаунт без @username» — только если имя вводили сами; после Яндекс ID / VK ID имя
    // подставляет база, но это новый аккаунт — показываем «Создание аккаунта».
    mountRegister(root, () => { if (mounted) void keyGate(root, user); }, { existing: !!S.me?.first_name && !providerProfile(user) });
    return;
  }
  // Соглашение и Политика: кто ещё не принимал текущую редакцию — один раз экран «Правила СКАМ».
  // Не удалось узнать (нет связи) — не держим человека на пороге, спросим при следующем входе.
  const accepted = await acceptedVersion();
  if (!mounted) return;
  if (accepted !== undefined && (accepted ?? '') < LEGAL_VERSION) {
    mountTerms(root, accepted !== null, () => { if (mounted) void keyGate(root, user); });
    return;
  }
  await keyGate(root, user);
}

/** Ключ шифрования: уже есть на устройстве — дальше; нет — создать или восстановить паролем. */
async function keyGate(root: HTMLElement, user: User): Promise<void> {
  let st: e2e.InitState;
  try {
    st = await e2e.init(user.id);
  } catch (e) {
    if (!mounted) return;
    const err = e as { code?: string };
    if (err.code === 'PGRST205' || err.code === '42P01') {
      showFatal(root, 'База ещё не настроена', 'Примените SQL из supabase/migrations в Supabase → SQL Editor и обновите страницу.');
    } else {
      showFatal(root, 'Нет связи с сервером', 'Не получилось проверить ключ шифрования. Проверьте интернет и обновите страницу.');
    }
    return;
  }
  if (!mounted) return;
  const go = () => { if (mounted) void mountShell(root, user); };
  if (st === 'ready') go();
  else if (st === 'unsupported') mountNoCrypto(root);
  else if (st === 'setup') mountKeySetup(root, user.id, go);
  else mountKeyUnlock(root, user.id, go);
}

async function mountShell(root: HTMLElement, user: User): Promise<void> {
  root.replaceChildren(html(SHELL));
  // Свёрнутый список помним между запусками (до первой отрисовки — без анимации).
  if (lsGet('skam:side') === 'mini') setSideMini(true, false);
  wire();
  onUploadProgress(updateProgress);
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
  mountChatAdmin({
    avatar: (uid, cls) => avatarEl(who(uid), cls),
    personAvatar: (uid) => personAvatar(uid),
    chatTile: (c, cls) => chatTileEl(c, cls),
    chatTitle,
    name: (uid) => who(uid).name,
    openChat: (id) => openChat(id),
    openPerson: (uid) => openPerson(uid),
  });
  mountFolders({
    chatTile: (c, cls) => chatTileEl(c, cls),
    chatTitle,
    menu: showMenu,
    clearSearch,
    searching: searchActive,
  });
  unsubs.push(mountStories({
    me: meId,
    name: (uid) => who(uid).name,
    short: (uid) => (uid === meId() ? 'Вы' : (who(uid).name || '').trim().split(/\s+/)[0] || 'Участник'),
    avatar: (uid, cls) => avatarEl(who(uid), cls),
    verified: (uid) => !!S.profiles.get(uid)?.verified,
    remember: (list) => rememberProfiles(list.map((a) => ({
      id: a.id, name: a.name, username: null, avatar_path: a.avatar_path, color: a.color ?? '#E85002', verified: a.verified,
    }))),
    searching: searchActive,
    changed: () => emit('stories'),
  }));
  mountStickerPacks({
    canSend: () => !!S.cur && canPost(currentChat()),
    send: (st) => void pickSticker(st),
    changed: () => { if (stickersOpen()) renderStickerPanel(); updateSuggest(); },
  });
  unsubs.push(mountCallUI({
    who: (uid) => who(uid),
    avatar: (uid, cls) => avatarEl(who(uid), cls),
    chatTile: (c, cls) => chatTileEl(c, cls),
    chatTitle,
    openChat: (id) => openChat(id),
    currentChat,
  }));
  S.visibleChat = () => (S.cur && convVisible() && document.visibilityState === 'visible' ? S.cur : null);
  unsubs.push(
    on('call', () => { renderCalls(); renderSide(); updateTitle(); refreshCallRows(); }),
    on('chats', () => { closeMissingChat(); renderSide(); updateTitle(); refreshChatInfo(); }),
    on('feed', () => {
      renderFeed();
      if (U.find) renderChatFind();
      if (personView === 'media' && personUid && $<HTMLDialogElement>('personDlg').open) renderPerson();
    }),
    on('head', renderHead),
    on('online', () => { renderMe(); renderSide(); if ($<HTMLDialogElement>('personDlg').open) refreshPersonStatus(); }),
    on('me', () => {
      renderMe();
      renderSide();
      if ($<HTMLDialogElement>('profileDlg').open && profView === 'home') renderProfile();
    }),
    on('prefs', () => {
      renderConv();
      renderHead();
      updateTitle();
      if ($<HTMLDialogElement>('profileDlg').open && ['home', 'privacy', 'blocked', 'notify'].includes(profView)) renderProfile();
      if ($<HTMLDialogElement>('personDlg').open && personUid && personView === 'home') renderPerson();
    }),
    on('members', () => refreshChatInfo()),
    on('layout', layoutChanged),
    on('stories', () => {
      renderStoryStrip();
      renderSide();
      renderHead();
      if ($<HTMLDialogElement>('personDlg').open && personUid) refreshPersonStatus();
      if ($<HTMLDialogElement>('profileDlg').open && profView === 'home') renderProfile();
    }),
  );
  unsubs.push(mountNotify({
    title: chatTitle,
    text: notifyText,
    icon: (c) => (c.kind === 'direct' ? who(c.peer_id).avatar : avatarUrl(c.avatar_path)),
    open: (id) => { window.focus(); closeMenu(); openChat(id); },
  }));
  renderAll();
  void refreshStories();

  void loadAppOwner().catch(() => {});
  void loadMyPacks().catch(() => {});
  // Папки, закреплённые, ники, блокировки и «без звука» — параллельно с чатами.
  void loadLayout(true).catch(() => {});
  void loadNicknames(true).catch(() => {});
  void loadPrefs(true).catch(() => {});
  try {
    // Сначала свои ключи чатов — чтобы превью в списке сразу расшифровались.
    await e2e.loadMyShares().catch(() => {});
    await loadChats();
  } catch {
    setBanner('Не удалось загрузить чаты. Обновите страницу.');
    S.chatsLoaded = true;
  }
  if (!mounted) return;
  autoOpen();
  renderAll();
  calls.startCalls();

  startRealtime(
    (ok) => setBanner(ok ? null : 'Нет живого соединения — новые сообщения подтягиваются раз в несколько секунд.'),
    () => {
      // Ключ сбросили на другом устройстве: здесь нужен новый пароль.
      toast('Ключ шифрования сменили на другом устройстве');
      unmountApp();
      void mountApp(root, user);
    },
  ).catch(() => {});
  void handlePendingJoin();
}

export function unmountApp(): void {
  mounted = false;
  calls.stopCalls();
  closeMenu();
  stopTyping();
  stopVoice();
  dropNotes(null);
  U.stickerImgs.clear();
  resetStickerPacks();
  resetLayout();
  resetNicks();
  resetStories();
  resetPrefs();
  bioCache.clear();
  groupsCache.clear();
  U.find = null;
  personUid = null;
  profView = 'home';
  U.q = '';
  U.found = null;
  U.drag = null;
  U.shownFolder = undefined;
  void stopRealtime();
  unsubs.forEach((f) => f());
  unsubs = [];
  resetState();
  resetFeedback();
  dropMediaUrls();
  U.drafts.clear();
  U.reply.clear();
  U.fwd.clear();
  U.edit.clear();
  U.sel = null;
  document.body.classList.remove('chat-open', 'ringing');
  document.title = 'СКАМ';
  S.visibleChat = () => null;
}

// Для отладки в консоли разработчика.
if (import.meta.env.DEV) Object.assign(window, { skam: { S, sb, sendRecorded, sendSticker, calls: calls.C } });
