// Интерфейс звонков, как в Discord: сцена звонка над перепиской, панель «Голосовая связь
// подключена» внизу слева, окно входящего звонка, записи о звонках в ленте и настройки устройств.
import type { ActiveCall, CallMemberInfo, MyChat } from '../lib/database.types';
import { $, ICONS, button, closeDialog, el, html, lsGet, lsSet, openDialog, plural, timeLabel, toast, wideMQ } from '../lib/dom';
import { S, meId, ts, type Msg } from './store';
import * as calls from './calls';
import { C } from './calls';
import * as snd from './sounds';

type Who = { id: string | null; name: string; avatar: string | null; color: string | null };

export type CallEnv = {
  who: (uid: string | null) => Who;
  avatar: (uid: string | null, cls?: string) => HTMLElement;
  chatTile: (c: MyChat, cls?: string) => HTMLElement;
  chatTitle: (c: MyChat) => string;
  openChat: (id: string) => void;
  currentChat: () => MyChat | null;
};

let env: CallEnv;
const U = {
  /** Развёрнутый на всю беседу звонок. */
  full: false,
  /** Какую плитку смотрим крупно (uid|cam, uid|scr). null — выбираем сами (демонстрация экрана). */
  focus: null as string | null,
  focusAuto: true,
  clock: 0,
};
/** Видео-элементы живут между перерисовками (иначе видео мигало бы каждую секунду). */
const videos = new Map<string, HTMLVideoElement>();
const localStreams = new Map<string, MediaStream>();

export const CALL_KINDS = new Set(['direct', 'group']);

export function canCallIn(c: MyChat | null | undefined): boolean {
  return !!c && CALL_KINDS.has(c.kind) && calls.canCall() && (c.kind !== 'direct' || !!c.peer_id);
}

// ---------------------------------------------------------------------------
// Действия
// ---------------------------------------------------------------------------

export function call(chatId: string, video: boolean): void {
  const active = calls.callInChat(chatId);
  const p = active ? calls.joinCall(active.id, video) : calls.startCall(chatId, video);
  p.catch((e: Error) => toast(e.message || 'Не получилось позвонить.'));
}

function join(c: ActiveCall, video = false): void {
  calls.joinCall(c.id, video).catch((e: Error) => toast(e.message || 'Не получилось войти в звонок.'));
}

// ---------------------------------------------------------------------------
// Мелочи
// ---------------------------------------------------------------------------

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Длительность звонка словами: «45 сек», «5 мин», «1 ч 12 мин». */
export function callDur(sec: number | null | undefined): string {
  const s = Math.max(0, Math.round(sec ?? 0));
  if (s < 60) return `${s} сек`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин`;
  return `${Math.floor(m / 60)} ч${m % 60 ? ` ${m % 60} мин` : ''}`;
}

function icon(name: keyof typeof ICONS): DocumentFragment {
  return html(ICONS[name]);
}

function ctl(cls: string, ic: keyof typeof ICONS, label: string, on: () => void, pressed?: boolean): HTMLButtonElement {
  const b = button(`ctl ${cls}`, null, (ev) => { ev.stopPropagation(); on(); });
  b.append(icon(ic));
  b.title = label;
  b.setAttribute('aria-label', label);
  if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
  return b;
}

function chatOf(chatId: string): MyChat | null {
  return S.chats.get(chatId) ?? null;
}

function sessionTime(): string {
  const s = C.session;
  return s ? clock(Date.now() - s.startedAt) : '';
}

/** Состояние участника: из канала данных (быстрее) или из базы. */
function flagsOf(uid: string, m: CallMemberInfo | undefined): calls.Flags {
  const s = C.session;
  if (s && uid === meId()) return s.flags;
  const p = s?.peers.get(uid);
  // Канал данных быстрее базы, но если он закрыт — верим базе (там состояние обновляет пульс).
  if (p?.flags && p.dc.readyState === 'open') return p.flags;
  return { muted: !!m?.muted, deafened: !!m?.deafened, camera: !!m?.camera, screen: !!m?.screen };
}

function streamFor(track: MediaStreamTrack | null): MediaStream | null {
  if (!track) return null;
  let st = localStreams.get(track.id);
  if (!st) { st = new MediaStream([track]); localStreams.set(track.id, st); }
  return st;
}

function videoEl(key: string, stream: MediaStream, mirror: boolean): HTMLVideoElement {
  let v = videos.get(key);
  if (!v) {
    v = el('video', 'tile-video');
    v.autoplay = true;
    v.muted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.disablePictureInPicture = true;
    videos.set(key, v);
  }
  if (v.srcObject !== stream) { v.srcObject = stream; void v.play().catch(() => {}); }
  v.classList.toggle('mirror', mirror);
  return v;
}

// ---------------------------------------------------------------------------
// Сцена звонка над перепиской
// ---------------------------------------------------------------------------

type TileSpec = {
  key: string;
  uid: string;
  kind: 'cam' | 'scr';
  name: string;
  stream: MediaStream | null;
  flags: calls.Flags;
  me: boolean;
  connecting: boolean;
};

function tiles(c: ActiveCall): TileSpec[] {
  const s = C.session!;
  const out: TileSpec[] = [];
  const members = calls.inCall(c);
  // Я — первым, как в Discord.
  const ids = [meId(), ...members.map((m) => m.user_id).filter((u) => u !== meId())];
  for (const uid of ids) {
    const m = members.find((x) => x.user_id === uid);
    const me = uid === meId();
    const p = s.peers.get(uid);
    const f = flagsOf(uid, m);
    const name = me ? 'Вы' : env.who(uid).name;
    const cam = me ? streamFor(s.cam) : f.camera ? p?.cam ?? null : null;
    out.push({ key: `${uid}|cam`, uid, kind: 'cam', name, stream: cam, flags: f, me, connecting: !me && p?.state !== 'connected' });
    const scr = me ? streamFor(s.scr) : f.screen ? p?.scr ?? null : null;
    if (scr) out.push({ key: `${uid}|scr`, uid, kind: 'scr', name: me ? 'Ваш экран' : `Экран: ${name}`, stream: scr, flags: f, me, connecting: false });
  }
  return out;
}

function tileEl(t: TileSpec, focused: boolean): HTMLElement {
  const box = el('div', `ctile ${t.kind}${t.me ? ' me' : ''}${focused ? ' focused' : ''}${t.connecting ? ' connecting' : ''}`);
  box.dataset.uid = t.uid;
  box.dataset.key = t.key;
  if (t.kind === 'cam') {
    const p = C.session?.peers.get(t.uid);
    if ((t.me ? C.session?.speaking : p?.speaking) && !t.flags.muted) box.classList.add('speaking');
  }
  if (t.stream) {
    box.append(videoEl(t.key, t.stream, t.me && t.kind === 'cam'));
    box.classList.add('has-video');
  } else {
    const w = env.who(t.uid);
    const bg = el('div', 'tile-bg');
    if (w.color) bg.style.setProperty('--c', w.color);
    bg.append(env.avatar(t.uid, 'tile-av'));
    box.append(bg);
  }
  const label = el('div', 'tile-name');
  if (t.kind === 'cam' && t.flags.deafened) label.append(icon('headphonesOff'));
  else if (t.kind === 'cam' && t.flags.muted) label.append(icon('micOff'));
  label.append(el('span', null, t.name));
  box.append(label);
  if (t.connecting) box.append(el('div', 'tile-state', 'Соединение…'));
  box.title = t.me ? '' : 'Нажмите — крупно, двойное нажатие — на весь экран, правая кнопка — громкость';
  box.addEventListener('click', () => {
    U.focusAuto = false;
    U.focus = U.focus === t.key ? null : t.key;
    renderStage();
  });
  box.addEventListener('dblclick', () => {
    const f = box.requestFullscreen?.bind(box);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void f?.().catch(() => {});
  });
  if (!t.me && t.kind === 'cam') {
    box.addEventListener('contextmenu', (ev) => { ev.preventDefault(); openVolume(t.uid, ev.clientX, ev.clientY); });
    let timer = 0;
    box.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      timer = window.setTimeout(() => { const r = box.getBoundingClientRect(); openVolume(t.uid, r.left + r.width / 2, r.top + 30); }, 500);
    });
    ['pointerup', 'pointercancel', 'pointermove'].forEach((ev) => box.addEventListener(ev, () => clearTimeout(timer)));
  }
  return box;
}

function statusText(c: ActiveCall): string {
  if (calls.waitingAnswer()) return 'Вызов…';
  const others = calls.othersInSession();
  const s = C.session!;
  if (!others.length) return s.hadCompany ? 'Вы одни в звонке' : 'Ожидание участников…';
  if (![...s.peers.values()].some((p) => p.state === 'connected')) return 'Соединение…';
  const n = calls.inCall(c).length;
  return `${sessionTime()}${n > 2 ? ` · ${plural(n, 'участник', 'участника', 'участников')}` : ''}`;
}

export function renderStage(): void {
  const stage = document.getElementById('callStage');
  if (!stage) return;
  const chat = env.currentChat();
  const main = document.getElementById('convMain');
  const s = C.session;
  const active = chat ? calls.callInChat(chat.id) : null;
  const mine = !!s && !!chat && s.chatId === chat.id;
  const used = new Set<string>();

  if (mine && active) {
    const c = active;
    stage.hidden = false;
    stage.className = `call-stage live${U.full ? ' full' : ''}`;
    main?.classList.toggle('call-full', U.full);

    const top = el('div', 'cs-top');
    const st = el('span', 'cs-status');
    const lock = el('span', 'cs-lock');
    lock.append(icon('lock'));
    lock.title = 'Звук и видео идут напрямую между участниками и зашифрованы. Ключи соединения защищены ключом чата.';
    st.append(lock, el('span', 'cs-text', statusText(c)));
    top.append(st, el('span', 'cs-spacer'));
    const missing = chat!.kind === 'group' && chat!.member_count > calls.inCall(c).length && !calls.waitingAnswer();
    if (missing) {
      const ring = button('cs-top-btn', null, () => void calls.ringAgain());
      ring.append(icon('bell'), el('span', null, 'Позвонить ещё раз'));
      ring.title = 'Позвонить тем, кого нет в звонке';
      top.append(ring);
    }
    const exp = button('cs-top-btn icon', null, () => { U.full = !U.full; renderStage(); });
    exp.append(icon(U.full ? 'collapse' : 'expand'));
    exp.title = U.full ? 'Свернуть' : 'Развернуть';
    exp.setAttribute('aria-label', exp.title);
    top.append(exp);

    const list = tiles(c);
    // Демонстрация экрана сама выходит на первый план (пока вы не выбрали другую плитку).
    if (U.focusAuto || (U.focus && !list.some((t) => t.key === U.focus))) {
      const scr = list.filter((t) => t.kind === 'scr' && !t.me).at(-1);
      U.focus = scr?.key ?? null;
      U.focusAuto = true;
    }
    const grid = el('div', `cs-grid n${Math.min(list.length, 9)}${U.focus ? ' has-focus' : ''}`);
    for (const t of list) {
      used.add(t.key);
      grid.append(tileEl(t, t.key === U.focus));
    }

    const f = s!.flags;
    const controls = el('div', 'cs-controls');
    controls.append(
      ctl(`cam${f.camera ? ' on' : ''}`, f.camera ? 'video' : 'videoOff', f.camera ? 'Выключить камеру' : 'Включить камеру', () => void calls.toggleCamera(), f.camera),
    );
    if (calls.canShareScreen()) {
      controls.append(ctl(`scr${f.screen ? ' on' : ''}`, f.screen ? 'screenOff' : 'screen', f.screen ? 'Прекратить показ экрана' : 'Показать экран', () => void calls.toggleScreen(), f.screen));
    }
    controls.append(
      ctl(`mic${f.muted ? ' off' : ''}`, f.muted ? 'micOff' : 'micOn', f.muted ? 'Включить микрофон (Ctrl+Shift+M)' : 'Выключить микрофон (Ctrl+Shift+M)', calls.toggleMute, f.muted),
      ctl(`deaf${f.deafened ? ' off' : ''}`, f.deafened ? 'headphonesOff' : 'headphones', f.deafened ? 'Включить звук (Ctrl+Shift+D)' : 'Выключить звук (Ctrl+Shift+D)', calls.toggleDeafen, f.deafened),
      ctl('gear', 'gear', 'Настройки звонка', openSettings),
      ctl('hang', 'hangup', 'Отключиться', () => void calls.hangup()),
    );
    const grip = el('div', 'cs-grip');
    grip.setAttribute('aria-hidden', 'true');
    wireGrip(grip, stage);
    stage.replaceChildren(top, grid, controls, grip);
  } else if (active && chat && !mine) {
    // В чате идёт звонок, а нас в нём нет — «Присоединиться», как в Discord.
    stage.hidden = false;
    stage.className = 'call-stage invite';
    main?.classList.remove('call-full');
    const people = calls.inCall(active);
    const avs = el('div', 'cs-avs');
    people.slice(0, 5).forEach((m) => avs.append(env.avatar(m.user_id, 'cs-mini')));
    const text = el('div', 'cs-invite-text');
    text.append(
      el('b', null, active.video ? 'Идёт видеозвонок' : 'Идёт звонок'),
      el('span', null, people.length ? people.map((m) => (m.user_id === meId() ? 'вы' : env.who(m.user_id).name)).join(', ') : 'подключаются…'),
    );
    const busy = C.joining === chat.id;
    const go = button('btn call-go', busy ? 'Подключаемся…' : 'Присоединиться', () => join(active));
    go.disabled = busy || !!C.joining;
    const vid = ctl('cam small', 'video', 'Присоединиться с камерой', () => join(active, true));
    vid.disabled = go.disabled;
    stage.replaceChildren(avs, text, vid, go);
  } else {
    stage.hidden = true;
    stage.replaceChildren();
    main?.classList.remove('call-full');
    if (!s) { U.full = false; U.focus = null; U.focusAuto = true; }
  }
  // Видео, которых больше нет на экране, отпускаем.
  for (const [k, v] of videos) {
    if (!used.has(k)) { v.srcObject = null; videos.delete(k); }
  }
  for (const id of [...localStreams.keys()]) {
    const s2 = C.session;
    if (!s2 || (s2.cam?.id !== id && s2.scr?.id !== id)) localStreams.delete(id);
  }
  const h = Number(lsGet('skam:call:h'));
  if (h > 0) stage.style.setProperty('--stage-h', `${h}px`);
}

/** Потянуть за нижний край — сцена выше или ниже (запоминается). */
function wireGrip(grip: HTMLElement, stage: HTMLElement): void {
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = stage.getBoundingClientRect().height;
    grip.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const h = Math.max(180, Math.min(window.innerHeight * 0.8, startH + ev.clientY - startY));
      stage.style.setProperty('--stage-h', `${Math.round(h)}px`);
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      const h = Math.round(stage.getBoundingClientRect().height);
      lsSet('skam:call:h', String(h));
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up, { once: true });
    grip.addEventListener('pointercancel', up, { once: true });
  });
}

/** Кто говорит — зелёная рамка. Только классы, без перерисовки. */
function paintSpeaking(): void {
  const s = C.session;
  document.querySelectorAll<HTMLElement>('.ctile.cam').forEach((t) => {
    const uid = t.dataset.uid!;
    const on = uid === meId() ? !!s?.speaking && !s.flags.muted : !!s?.peers.get(uid)?.speaking;
    t.classList.toggle('speaking', on);
  });
  const me = document.querySelector('.voice-panel .vp-me');
  me?.classList.toggle('speaking', !!s?.speaking && !s.flags.muted);
}

// ---------------------------------------------------------------------------
// Громкость собеседника
// ---------------------------------------------------------------------------

function openVolume(uid: string, x: number, y: number): void {
  const pop = $('volPop');
  const w = env.who(uid);
  const range = el('input');
  range.type = 'range';
  range.min = '0';
  range.max = '100';
  range.value = String(Math.round(calls.peerVolume(uid) * 100));
  range.setAttribute('aria-label', `Громкость: ${w.name}`);
  const val = el('span', 'vol-val', `${range.value}%`);
  range.addEventListener('input', () => {
    val.textContent = `${range.value}%`;
    calls.setPeerVolume(uid, Number(range.value) / 100);
  });
  const head = el('div', 'vol-head');
  head.append(el('b', null, w.name), val);
  pop.replaceChildren(head, range, el('span', 'vol-hint', 'Громкость этого участника — только у вас'));
  pop.hidden = false;
  const r = pop.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - r.width - 8, x - r.width / 2))}px`;
  pop.style.top = `${Math.max(8, Math.min(window.innerHeight - r.height - 8, y))}px`;
  range.focus();
}

function closeVolume(): void {
  const pop = document.getElementById('volPop');
  if (pop) pop.hidden = true;
}

// ---------------------------------------------------------------------------
// Панель «Голосовая связь подключена» (внизу слева) и полоска «вернуться к звонку»
// ---------------------------------------------------------------------------

export function renderVoicePanel(): void {
  const box = document.getElementById('voicePanel');
  if (!box) return;
  const s = C.session;
  const chat = s ? chatOf(s.chatId) : null;
  if (!s || !chat) { box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;
  const c = calls.sessionCall();
  const connected = [...s.peers.values()].some((p) => p.state === 'connected');
  const title = calls.waitingAnswer() ? 'Вызов…' : connected ? 'Голосовая связь подключена' : calls.othersInSession().length ? 'Подключение…' : 'В звонке';
  const row = el('div', 'vp-row');
  const sig = el('span', `vp-signal${connected ? ' ok' : ''}`);
  sig.append(icon('signal'));
  sig.title = C.rtt != null ? `Задержка ${C.rtt} мс` : 'Соединение';
  const text = el('div', 'vp-text');
  const t1 = el('span', `vp-title${connected ? ' ok' : ''}`, title);
  const go = button('vp-chat', null, () => env.openChat(chat.id));
  go.append(el('span', 'vp-chat-name', env.chatTitle(chat)), el('span', 'vp-time', `· ${sessionTime()}`));
  go.title = 'Открыть чат звонка';
  text.append(t1, go);
  const hang = ctl('hang small', 'hangup', 'Отключиться', () => void calls.hangup());
  row.append(sig, text, hang);
  const f = s.flags;
  const btns = el('div', 'vp-btns');
  btns.append(
    ctl(`mic${f.muted ? ' off' : ''}`, f.muted ? 'micOff' : 'micOn', f.muted ? 'Включить микрофон' : 'Выключить микрофон', calls.toggleMute, f.muted),
    ctl(`deaf${f.deafened ? ' off' : ''}`, f.deafened ? 'headphonesOff' : 'headphones', f.deafened ? 'Включить звук' : 'Выключить звук', calls.toggleDeafen, f.deafened),
    ctl(`cam${f.camera ? ' on' : ''}`, f.camera ? 'video' : 'videoOff', f.camera ? 'Выключить камеру' : 'Включить камеру', () => void calls.toggleCamera(), f.camera),
  );
  if (calls.canShareScreen()) {
    btns.append(ctl(`scr${f.screen ? ' on' : ''}`, f.screen ? 'screenOff' : 'screen', f.screen ? 'Прекратить показ' : 'Показать экран', () => void calls.toggleScreen(), f.screen));
  }
  const me = el('span', 'vp-me');
  me.append(env.avatar(meId(), 'vp-av'));
  btns.prepend(me);
  box.replaceChildren(row, btns);
  if (c) paintSpeaking();
}

export function renderReturnBar(): void {
  const bar = document.getElementById('callReturn');
  if (!bar) return;
  const s = C.session;
  const chat = s ? chatOf(s.chatId) : null;
  const cur = env.currentChat();
  const show = !!s && !!chat && !wideMQ.matches && cur?.id !== s.chatId;
  bar.hidden = !show;
  if (!show) { bar.replaceChildren(); return; }
  const b = button('cr-go', null, () => env.openChat(chat!.id));
  b.append(icon('phone'), el('span', null, `Звонок · ${env.chatTitle(chat!)}`), el('span', 'vp-time', sessionTime()));
  bar.replaceChildren(b, ctl('hang small', 'hangup', 'Отключиться', () => void calls.hangup()));
}

// ---------------------------------------------------------------------------
// Входящий звонок
// ---------------------------------------------------------------------------

export function renderRing(): void {
  const box = document.getElementById('ringBox');
  if (!box) return;
  const c = calls.ringing()[0];
  const chat = c ? chatOf(c.chat_id) : null;
  if (!c || !chat) { box.hidden = true; box.replaceChildren(); document.body.classList.remove('ringing'); return; }
  document.body.classList.add('ringing');
  box.hidden = false;
  box.dataset.call = c.id;
  const caller = c.started_by && c.started_by !== meId() ? c.started_by
    : calls.inCall(c).find((m) => m.user_id !== meId())?.user_id ?? null;
  const av = el('div', 'rb-av');
  av.append(chat.kind === 'group' ? env.chatTile(chat, 'rb-tile') : env.avatar(caller, 'rb-avatar'));
  const name = chat.kind === 'group' ? env.chatTitle(chat) : env.who(caller).name;
  const sub = chat.kind === 'group'
    ? `${env.who(caller).name} звонит в группу${c.video ? ' · видео' : ''}`
    : c.video ? 'Входящий видеозвонок' : 'Входящий звонок';
  const x = button('rb-x', null, () => calls.dismiss(c.id));
  x.append(icon('close'));
  x.title = 'Скрыть (звонок продолжится — можно присоединиться позже)';
  x.setAttribute('aria-label', 'Скрыть');
  const actions = el('div', 'rb-actions');
  const decline = button('rb-btn decline', null, () => { void calls.decline(c.id); });
  decline.append(icon('hangup'));
  decline.title = 'Отклонить';
  decline.setAttribute('aria-label', 'Отклонить');
  const video = button('rb-btn video', null, () => join(c, true));
  video.append(icon('video'));
  video.title = 'Принять с камерой';
  video.setAttribute('aria-label', 'Принять с камерой');
  const accept = button('rb-btn accept', null, () => join(c));
  accept.append(icon('phone'));
  accept.title = 'Принять';
  accept.setAttribute('aria-label', 'Принять');
  const busy = !!C.joining;
  [decline, video, accept].forEach((b) => { b.disabled = busy; });
  actions.append(decline, video, accept);
  const labels = el('div', 'rb-labels');
  labels.append(el('span', null, 'Отклонить'), el('span', null, 'С видео'), el('span', null, busy ? 'Подключаемся…' : 'Принять'));
  const openBtn = button('rb-open', 'Открыть чат', () => env.openChat(chat.id));
  box.replaceChildren(x, av, el('div', 'rb-name', name), el('div', 'rb-sub', sub), actions, labels, openBtn);
  box.setAttribute('aria-label', `${sub}: ${name}`);
}

// ---------------------------------------------------------------------------
// Кнопки в шапке чата
// ---------------------------------------------------------------------------

export function renderCallBtns(): void {
  const box = document.getElementById('callBtns');
  if (!box) return;
  const c = env.currentChat();
  if (!canCallIn(c)) { box.replaceChildren(); box.hidden = true; return; }
  box.hidden = false;
  const s = C.session;
  if (s?.chatId === c!.id) { box.replaceChildren(); return; }
  const busy = !!C.joining;
  const active = calls.callInChat(c!.id);
  const voice = ctl('head-call', 'phone', active ? 'Присоединиться к звонку' : 'Позвонить', () => call(c!.id, false));
  const video = ctl('head-call', 'video', active ? 'Присоединиться с камерой' : 'Видеозвонок', () => call(c!.id, true));
  voice.disabled = video.disabled = busy;
  if (active) voice.classList.add('live');
  box.replaceChildren(voice, video);
}

// ---------------------------------------------------------------------------
// Записи о звонках в ленте и в списке чатов
// ---------------------------------------------------------------------------

let rowQueue: string[] = [];
let rowTimer = 0;
function needRow(id: string): void {
  rowQueue.push(id);
  if (rowTimer) return;
  rowTimer = window.setTimeout(() => {
    const ids = rowQueue;
    rowQueue = [];
    rowTimer = 0;
    void calls.loadCallRows(ids);
  }, 30);
}

type CallLook = { text: string; icon: keyof typeof ICONS; bad: boolean; dur: string | null; live: boolean };

function look(status: string, mine: boolean, direct: boolean, video: boolean, durSec: number | null): CallLook {
  const kind = video ? 'видеозвонок' : 'звонок';
  const Kind = video ? 'Видеозвонок' : 'Звонок';
  if (status === 'active') return { text: `Идёт ${kind}`, icon: video ? 'video' : 'phone', bad: false, dur: null, live: true };
  if (status === 'ended') {
    const text = direct ? `${mine ? 'Исходящий' : 'Входящий'} ${kind}` : `Групповой ${kind}`;
    return { text, icon: mine ? 'phoneOut' : 'phoneIn', bad: false, dur: callDur(durSec), live: false };
  }
  if (status === 'declined') return { text: mine ? `${Kind} отклонён` : `Отклонённый ${kind}`, icon: 'phoneMissed', bad: !mine, dur: null, live: false };
  if (mine) return { text: status === 'missed' ? 'Нет ответа' : `Отменённый ${kind}`, icon: 'phoneOut', bad: false, dur: null, live: false };
  return { text: `Пропущенный ${kind}`, icon: 'phoneMissed', bad: true, dur: null, live: false };
}

/** Строка о звонке в ленте: «Входящий звонок · 5 мин», «Пропущенный звонок», «Идёт звонок [Присоединиться]». */
export function callRow(m: Msg, chat: MyChat): HTMLElement {
  const row = el('div', 'call-row');
  row.dataset.id = m.id;
  if (m.deleted_at || !m.call_id) {
    row.append(el('span', 'cr-text muted', 'Запись о звонке удалена'));
    return row;
  }
  const active = C.active.get(m.call_id);
  const rec = C.rows.get(m.call_id);
  if (!active && !rec) needRow(m.call_id);
  const status = active ? 'active' : rec?.status ?? 'active';
  const video = (active ?? rec)?.video ?? false;
  const dur = rec?.ended_at && rec.answered_at ? (ts(rec.ended_at) - ts(rec.answered_at)) / 1000 : null;
  const mine = m.user_id === meId();
  const L = look(status, mine, chat.kind === 'direct', video, dur);
  const pill = el('div', `cr-pill${L.bad ? ' bad' : ''}${L.live ? ' live' : ''}`);
  const ic = el('span', 'cr-icon');
  ic.append(icon(L.icon));
  const body = el('div', 'cr-body');
  const t = el('span', 'cr-text', L.text);
  const sub = el('span', 'cr-sub');
  const parts: string[] = [];
  if (chat.kind === 'group' && m.user_id) parts.push(mine ? 'вы' : env.who(m.user_id).name);
  parts.push(timeLabel(ts(m.created_at)));
  if (L.dur) parts.push(L.dur);
  sub.textContent = parts.join(' · ');
  body.append(t, sub);
  pill.append(ic, body);
  if (L.live && active && C.session?.callId !== active.id) {
    const b = button('btn small call-go', 'Присоединиться', () => join(active));
    b.disabled = !!C.joining;
    pill.append(b);
  } else if (!L.live && canCallIn(chat) && !C.session) {
    const again = button('cr-again', null, () => call(chat.id, video));
    again.append(icon(video ? 'video' : 'phone'));
    again.title = video ? 'Видеозвонок' : 'Позвонить';
    again.setAttribute('aria-label', again.title);
    pill.append(again);
  }
  row.append(pill);
  return row;
}

/** Последнее сообщение — звонок: как его показать в списке чатов. */
export function callPreview(c: MyChat): string {
  const lc = c.last_call;
  const active = calls.callInChat(c.id);
  if (active && (!lc || lc.status === 'active')) return active.video ? '📹 Идёт видеозвонок' : '📞 Идёт звонок';
  if (!lc) return '📞 Звонок';
  const L = look(lc.status, c.last_user_id === meId(), c.kind === 'direct', lc.video, lc.dur);
  return `${lc.video ? '📹' : '📞'} ${L.text}${L.dur ? ` · ${L.dur}` : ''}`;
}

// ---------------------------------------------------------------------------
// Настройки звонка: микрофон, камера, динамики, шумоподавление
// ---------------------------------------------------------------------------

function openSettings(): void {
  const dlg = $<HTMLDialogElement>('callDlg');
  const form = el('div', 'stack');
  const head = el('div', 'dlg-head');
  head.append(el('h2', null, 'Настройки звонка'));
  const x = button('icon-btn', null, () => closeDialog(dlg));
  x.append(icon('close'));
  x.setAttribute('aria-label', 'Закрыть');
  head.append(x);
  const fill = async () => {
    const d = await calls.listDevices();
    const cur = calls.chosen();
    const s = C.session;
    const pick = (label: string, list: MediaDeviceInfo[], kind: 'mic' | 'cam' | 'out', active: string | null) => {
      const f = el('div', 'field');
      const id = `dev-${kind}`;
      const l = el('label', 'fld', label);
      l.htmlFor = id;
      const sel = el('select', 'txt');
      sel.id = id;
      const def = el('option', null, 'Как в системе');
      def.value = '';
      sel.append(def);
      list.forEach((dev, i) => {
        const o = el('option', null, dev.label || `${label} ${i + 1}`);
        o.value = dev.deviceId;
        if (dev.deviceId === active) o.selected = true;
        sel.append(o);
      });
      sel.addEventListener('change', () => void calls.useDevice(kind, sel.value));
      f.append(l, sel);
      return f;
    };
    const micId = s?.mic?.getSettings().deviceId ?? cur.mic;
    const camId = s?.cam?.getSettings().deviceId ?? cur.cam;
    form.replaceChildren(pick('Микрофон', d.mics, 'mic', micId ?? null), pick('Камера', d.cams, 'cam', camId ?? null));
    if (calls.canPickOutput() && d.outs.length) form.append(pick('Динамики или наушники', d.outs, 'out', cur.out));
    const ns = el('label', 'check-row');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = calls.noiseSuppression();
    box.addEventListener('change', () => void calls.setNoiseSuppression(box.checked));
    ns.append(box, el('span', null, 'Шумоподавление'));
    form.append(ns, el('p', 'hint', 'Громкость каждого участника — правой кнопкой по его плитке (на телефоне — долгое нажатие). Горячие клавиши: Ctrl+Shift+M — микрофон, Ctrl+Shift+D — звук.'));
  };
  form.append(el('p', 'hint', 'Загружаем список устройств…'));
  dlg.replaceChildren(head, form);
  openDialog(dlg);
  void fill();
}

// ---------------------------------------------------------------------------
// Подключение
// ---------------------------------------------------------------------------

export function renderCalls(): void {
  renderCallBtns();
  renderStage();
  renderVoicePanel();
  renderReturnBar();
  renderRing();
}

/** Только часы: раз в секунду, без перерисовки плиток. */
function tickClock(): void {
  if (!C.session) return;
  const t = sessionTime();
  document.querySelectorAll('.vp-time').forEach((x) => {
    x.textContent = x.closest('.vp-chat') ? `· ${t}` : t;
  });
  const c = calls.sessionCall();
  const st = document.querySelector('.call-stage.live .cs-text');
  if (st && c) st.textContent = statusText(c);
}

export function mountCallUI(e: CallEnv): () => void {
  env = e;
  const offSpeak = calls.onSpeaking(paintSpeaking);
  calls.onNotice((t) => toast(t));
  U.clock = window.setInterval(tickClock, 1000);
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') closeVolume();
    if (!C.session || !ev.ctrlKey || !ev.shiftKey) return;
    const k = ev.key.toLowerCase();
    if (k === 'm' || k === 'ь') { ev.preventDefault(); calls.toggleMute(); }
    if (k === 'd' || k === 'в') { ev.preventDefault(); calls.toggleDeafen(); }
  };
  const onDown = (ev: PointerEvent) => {
    const t = ev.target as HTMLElement;
    if (!t.closest('#volPop')) closeVolume();
    snd.unlock();
  };
  const onWide = () => renderReturnBar();
  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onDown);
  wideMQ.addEventListener('change', onWide);
  const dlg = document.getElementById('callDlg') as HTMLDialogElement | null;
  const onDlg = (ev: MouseEvent) => { if (dlg && ev.target === dlg) closeDialog(dlg); };
  dlg?.addEventListener('click', onDlg);
  return () => {
    offSpeak();
    clearInterval(U.clock);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('pointerdown', onDown);
    wideMQ.removeEventListener('change', onWide);
    dlg?.removeEventListener('click', onDlg);
    videos.forEach((v) => { v.srcObject = null; });
    videos.clear();
    localStreams.clear();
    U.full = false;
    U.focus = null;
    U.focusAuto = true;
  };
}
