// Интерфейс звонков, как в Discord: сцена звонка над перепиской, панель «Голосовая связь
// подключена» внизу слева, окно входящего звонка, записи о звонках в ленте и настройки устройств.
import type { ActiveCall, CallMemberInfo, MyChat } from '../lib/database.types';
import { $, ICONS, button, closeDialog, el, html, lsGet, lsSet, openDialog, plural, timeLabel, toast, touchMQ, wideMQ } from '../lib/dom';
import { choiceRow, grp, grpLabel, grpNote, radioRow, rangeRow, row, selectRow, sheetHead, toggleRow, type IconName, type Opt } from './sheet';
import { S, meId, peerBlocked, ts, type Msg } from './store';
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
  // С заблокированным не звонят (и он нам — тоже: это проверяет сервер).
  return !!c && CALL_KINDS.has(c.kind) && calls.canCall() && (c.kind !== 'direct' || !!c.peer_id) && !peerBlocked(c);
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
  /** Связь с участником не удалась. */
  failed?: boolean;
  /** Вместо картинки — подпись (свой экран целиком не показываем сами себе: получится бесконечный коридор). */
  note?: string;
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
    out.push({ key: `${uid}|cam`, uid, kind: 'cam', name, stream: cam, flags: f, me, connecting: !me && p?.state !== 'connected', failed: !me && p?.state === 'failed' });
    const scr = me ? streamFor(s.scr) : f.screen ? p?.scr ?? null : null;
    if (scr) {
      const whole = me && calls.screenInfo()?.surface === 'monitor';
      out.push({
        key: `${uid}|scr`, uid, kind: 'scr', name: me ? 'Ваш экран' : `Экран: ${name}`, stream: whole ? null : scr, flags: f, me, connecting: false,
        note: whole ? 'Идёт показ всего экрана' : undefined,
      });
    }
  }
  return out;
}

function fullscreenOf(box: HTMLElement): void {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  else void box.requestFullscreen?.().catch(() => {});
}

function tool(ic: IconName, label: string, fn: (ev: MouseEvent) => void): HTMLButtonElement {
  const b = button('tile-tool', null, (ev) => { ev.stopPropagation(); fn(ev); });
  b.append(icon(ic));
  b.title = label;
  b.setAttribute('aria-label', label);
  b.addEventListener('dblclick', (ev) => ev.stopPropagation());
  return b;
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
  } else if (t.note) {
    const bg = el('div', 'tile-bg note');
    const ic = el('span', 'tile-note-ic');
    ic.append(icon('screen'));
    bg.append(ic, el('span', 'tile-note', t.note));
    box.append(bg);
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
  if (t.connecting) box.append(el('div', 'tile-state', t.failed ? 'Нет связи' : 'Соединение…'));
  // Кнопки на плитке: звук чужой трансляции и «на весь экран».
  const tools = el('div', 'tile-tools');
  if (!t.me && t.kind === 'scr') tools.append(tool('sound', 'Громкость трансляции', (ev) => {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    openVolume(t.uid, r.left + r.width / 2, r.bottom + 6, 'stream');
  }));
  if (t.stream || t.kind === 'scr') tools.append(tool('expand', 'На весь экран', () => fullscreenOf(box)));
  if (tools.childElementCount) box.append(tools);
  box.title = t.me ? '' : 'Нажмите — крупно, двойное нажатие — на весь экран, правая кнопка — громкость';
  box.addEventListener('click', () => {
    U.focusAuto = false;
    U.focus = U.focus === t.key ? null : t.key;
    renderStage();
  });
  box.addEventListener('dblclick', () => fullscreenOf(box));
  if (!t.me) {
    const kind = t.kind === 'scr' ? 'stream' : 'voice';
    box.addEventListener('contextmenu', (ev) => { ev.preventDefault(); openVolume(t.uid, ev.clientX, ev.clientY, kind); });
    let timer = 0;
    box.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      timer = window.setTimeout(() => { const r = box.getBoundingClientRect(); openVolume(t.uid, r.left + r.width / 2, r.top + 30, kind); }, 500);
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

/** Стрелка рядом с кнопкой микрофона или камеры: быстро выбрать устройство, как в Discord. */
function split(btn: HTMLButtonElement, kind: 'mic' | 'cam'): HTMLElement {
  if (touchMQ.matches) return btn;
  const w = el('div', 'ctl-split');
  const a = button('ctl-arrow', null, (ev) => { ev.stopPropagation(); void openDevices(kind, a); });
  a.append(icon('up'));
  a.title = kind === 'mic' ? 'Выбрать микрофон' : 'Выбрать камеру';
  a.setAttribute('aria-label', a.title);
  w.append(btn, a);
  return w;
}

async function openDevices(kind: 'mic' | 'cam', anchor: HTMLElement): Promise<void> {
  const pop = $('volPop');
  if (!pop.hidden && pop.classList.contains('dev') && pop.dataset.kind === kind) { closeVolume(); return; }
  const d = await calls.listDevices();
  const list = kind === 'mic' ? d.mics : d.cams;
  const cur = calls.chosen()[kind] ?? '';
  const rows: HTMLElement[] = [el('b', 'dev-title', kind === 'mic' ? 'Микрофон' : 'Камера')];
  const opts: [string, string][] = [['', 'Как в системе'], ...list.map((x, i): [string, string] => [x.deviceId, x.label || `${kind === 'mic' ? 'Микрофон' : 'Камера'} ${i + 1}`])];
  const on = opts.some(([id]) => id === cur) ? cur : '';
  for (const [id, label] of opts) {
    const b = button(`dev-row${id === on ? ' on' : ''}`, null, () => { closeVolume(); void calls.useDevice(kind, id); });
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', String(id === on));
    const ck = el('span', 'dev-ck');
    if (id === on) ck.append(icon('check'));
    b.append(ck, el('span', 'dev-name', label));
    rows.push(b);
  }
  rows.push(button('dev-row more', null, () => { closeVolume(); openCallSettings(); }));
  rows[rows.length - 1].append(el('span', 'dev-ck'), el('span', 'dev-name', 'Настройки голоса и видео…'));
  pop.className = 'vol-pop dev';
  pop.dataset.kind = kind;
  pop.replaceChildren(...rows);
  pop.hidden = false;
  const a = anchor.getBoundingClientRect();
  const r = pop.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - r.width - 8, a.left + a.width / 2 - r.width / 2))}px`;
  pop.style.top = `${Math.max(8, a.top - r.height - 8)}px`;
}

/** Кнопка микрофона. В режиме «Рация» на ней видна клавиша, а когда её держат — подсветка. */
function micButton(f: calls.Flags): HTMLButtonElement {
  const st = calls.settings();
  const ptt = st.mode === 'ptt' && !touchMQ.matches;
  const title = f.muted ? 'Включить микрофон (Ctrl+Shift+M)' : 'Выключить микрофон (Ctrl+Shift+M)';
  const b = ctl(`mic${f.muted ? ' off' : ''}${ptt ? ' ptt' : ''}${ptt && calls.pttHeld() && !f.muted ? ' talking' : ''}`,
    f.muted ? 'micOff' : 'micOn', ptt ? `${title}. Рация: ${calls.keyName(st.ptt)}` : title, calls.toggleMute, f.muted);
  if (ptt) b.append(el('span', 'ptt-key', calls.keyName(st.ptt)));
  return b;
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

  // На весь экран открыта плитка звонка: не перестраиваем сцену, иначе полноэкранный просмотр сбросится.
  const fs = document.fullscreenElement as HTMLElement | null;
  if (fs && stage.contains(fs) && mine && active) {
    const key = fs.dataset.key;
    if (key && tiles(active).some((t) => t.key === key)) return;
    void document.exitFullscreen().catch(() => {});
  }

  if (mine && active) {
    const c = active;
    stage.hidden = false;
    // Пока смотрите чужой (или свой) экран — сцена выше, чтобы картинка была крупной.
    const watching = U.focus?.endsWith('|scr') ?? false;
    const people = calls.inCall(c).length;
    stage.className = `call-stage live${U.full ? ' full' : ''}${watching ? ' watching' : ''}${people >= 5 ? ' crowd6' : people >= 3 ? ' crowd' : ''}`;
    main?.classList.toggle('call-full', U.full);

    const top = el('div', 'cs-top');
    const st = el('span', 'cs-status');
    const lock = el('span', 'cs-lock');
    lock.append(icon('lock'));
    lock.title = 'Звук и видео идут напрямую между участниками и зашифрованы. Ключи соединения защищены ключом чата.';
    st.append(lock, el('span', 'cs-text', statusText(c)));
    top.append(st);
    const share = calls.screenInfo();
    if (share) {
      const pill = el('span', 'cs-share');
      // Что выбрали, а не что насчитал браузер: частота кадров в настройках дорожки скачет.
      const pick = share.opts.res === 'src' ? (share.height ? `${share.height}p` : 'Исходное') : `${share.height ? Math.min(share.height, Number(share.opts.res)) : share.opts.res}p`;
      const detail = [pick, `${share.opts.fps} к/с`, share.opts.audio ? 'со звуком' : null].filter(Boolean).join(' · ');
      pill.append(el('i', 'dot'), el('b', null, 'Вы показываете экран'), el('span', 'cs-share-d', detail));
      const q = button('cs-share-btn', 'Качество', openShare);
      q.title = 'Разрешение и частота кадров';
      const stop = button('cs-share-btn stop', 'Остановить', () => void calls.toggleScreen());
      pill.append(q, stop);
      top.append(pill);
    }
    top.append(el('span', 'cs-spacer'));
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
    // Крупная плитка и лента остальных под ней — или ровная сетка, если никого не выбрали.
    const big = U.focus ? list.find((t) => t.key === U.focus) ?? null : null;
    let grid: HTMLElement;
    if (big && list.length > 1) {
      grid = el('div', 'cs-grid has-focus');
      const main = el('div', 'cs-main');
      main.append(tileEl(big, true));
      const strip = el('div', 'cs-strip');
      for (const t of list) if (t !== big) strip.append(tileEl(t, false));
      grid.append(main, strip);
    } else {
      grid = el('div', `cs-grid n${Math.min(list.length, 9)}`);
      for (const t of list) grid.append(tileEl(t, false));
    }
    list.forEach((t) => used.add(t.key));

    const f = s!.flags;
    const controls = el('div', 'cs-controls');
    controls.append(split(
      ctl(`cam${f.camera ? ' on' : ''}`, f.camera ? 'video' : 'videoOff', f.camera ? 'Выключить камеру' : 'Включить камеру', () => void calls.toggleCamera(), f.camera),
      'cam',
    ));
    if (calls.canShareScreen()) {
      controls.append(ctl(`scr${f.screen ? ' on' : ''}`, f.screen ? 'screenOff' : 'screen', f.screen ? 'Прекратить показ экрана' : 'Показать экран', onScreen, f.screen));
    }
    controls.append(
      split(micButton(f), 'mic'),
      ctl(`deaf${f.deafened ? ' off' : ''}`, f.deafened ? 'headphonesOff' : 'headphones', f.deafened ? 'Включить звук (Ctrl+Shift+D)' : 'Выключить звук (Ctrl+Shift+D)', calls.toggleDeafen, f.deafened),
      ctl('gear', 'gear', 'Настройки звонка', openCallSettings),
      ctl('hang', 'hangup', 'Отключиться', () => void calls.hangup()),
    );
    const grip = el('div', 'cs-grip');
    grip.setAttribute('aria-hidden', 'true');
    wireGrip(grip, stage);
    stage.replaceChildren(top, grid, controls, grip);
    fitGrid();
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

/**
 * Ровная сетка плиток 16:9: подбираем число столбцов, при котором плитки получаются самыми крупными.
 * Так и двое, и восемь участников занимают сцену целиком, а не растягиваются в полосы.
 */
export function fitGrid(): void {
  const g = document.querySelector<HTMLElement>('#callStage .cs-grid:not(.has-focus)');
  if (!g) return;
  const n = g.childElementCount;
  const W = g.clientWidth;
  const H = g.clientHeight;
  if (!n || !W || !H) return;
  const gap = 8;
  let best = { w: 0, cols: 1 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = Math.min((W - gap * (cols - 1)) / cols, ((H - gap * (rows - 1)) / rows) * (16 / 9));
    if (w > best.w) best = { w, cols };
  }
  g.style.setProperty('--tw', `${Math.max(60, Math.floor(best.w))}px`);
  g.style.setProperty('--cols', String(best.cols));
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

function openVolume(uid: string, x: number, y: number, kind: 'voice' | 'stream' = 'voice'): void {
  const pop = $('volPop');
  pop.className = 'vol-pop';
  pop.dataset.kind = '';
  const w = env.who(uid);
  const stream = kind === 'stream';
  const range = el('input');
  range.type = 'range';
  range.min = '0';
  range.max = '100';
  range.value = String(Math.round((stream ? calls.streamVolume(uid) : calls.peerVolume(uid)) * 100));
  range.setAttribute('aria-label', `${stream ? 'Громкость трансляции' : 'Громкость'}: ${w.name}`);
  const val = el('span', 'vol-val', `${range.value}%`);
  range.addEventListener('input', () => {
    val.textContent = `${range.value}%`;
    (stream ? calls.setStreamVolume : calls.setPeerVolume)(uid, Number(range.value) / 100);
  });
  const head = el('div', 'vol-head');
  head.append(el('b', null, stream ? `Звук экрана: ${w.name}` : w.name), val);
  pop.replaceChildren(head, range, el('span', 'vol-hint', stream ? 'Громкость трансляции — только у вас' : 'Громкость этого участника — только у вас'));
  pop.hidden = false;
  const r = pop.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - r.width - 8, x - r.width / 2))}px`;
  pop.style.top = `${Math.max(8, Math.min(window.innerHeight - r.height - 8, y))}px`;
  range.focus();
}

function closeVolume(): void {
  const pop = document.getElementById('volPop');
  if (pop) { pop.hidden = true; pop.className = 'vol-pop'; pop.dataset.kind = ''; }
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
    micButton(f),
    ctl(`deaf${f.deafened ? ' off' : ''}`, f.deafened ? 'headphonesOff' : 'headphones', f.deafened ? 'Включить звук' : 'Выключить звук', calls.toggleDeafen, f.deafened),
    ctl(`cam${f.camera ? ' on' : ''}`, f.camera ? 'video' : 'videoOff', f.camera ? 'Выключить камеру' : 'Включить камеру', () => void calls.toggleCamera(), f.camera),
  );
  if (calls.canShareScreen()) {
    btns.append(ctl(`scr${f.screen ? ' on' : ''}`, f.screen ? 'screenOff' : 'screen', f.screen ? 'Прекратить показ' : 'Показать экран', onScreen, f.screen));
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
// Настройки звонка, как «Голос и видео» в Discord: устройства, чувствительность,
// рация, проверка микрофона, предпросмотр камеры
// ---------------------------------------------------------------------------

/** Переключатель, который сам перерисовывается после нажатия. */
function switchRow(ic: IconName, label: string, sub: string | null, get: () => boolean, set: (v: boolean) => void,
  disabled = false): HTMLElement {
  let cur: HTMLElement;
  const build = () => toggleRow(ic, label, sub, get(), (next) => {
    set(next);
    const n = build();
    cur.replaceWith(n);
    cur = n;
    n.focus();
  }, disabled);
  cur = build();
  return cur;
}

function devOpts(list: MediaDeviceInfo[], what: string): Opt<string>[] {
  return [
    { value: '', label: 'Как в системе' },
    ...list.map((d, i) => ({ value: d.deviceId, label: d.label || `${what} ${i + 1}` })),
  ];
}

export function openCallSettings(): void {
  const dlg = $<HTMLDialogElement>('callDlg');
  const touch = touchMQ.matches;
  const body = el('div', 'sh-body');
  let testMic: calls.Mic | null = null;
  let raf = 0;
  let prev: MediaStream | null = null;
  let prevOn = false;
  let capturing: ((ev: KeyboardEvent) => void) | null = null;
  let monitoring = false;
  const offs: (() => void)[] = [];
  const liveMic = () => calls.activeMic() ?? testMic;

  // ---- микрофон: устройство и громкость
  let micRow: HTMLElement = el('div', 'lr');
  const gainRow = rangeRow('Громкость микрофона', 0, 200, calls.settings().gain, (v) => `${v}%`, (v) => calls.setMicGain(v), { icon: 'micOn', id: 'set-gain' });
  const micErr = el('p', 'grp-note err');
  micErr.hidden = true;
  const micNow = grpNote('');
  micNow.hidden = true;

  // ---- режим ввода и полоска уровня с порогом
  const fill = el('div', 'meter-fill');
  const range = el('input', 'meter-range');
  range.type = 'range';
  range.min = '0';
  range.max = '100';
  range.setAttribute('aria-label', 'Чувствительность микрофона');
  range.addEventListener('input', () => calls.setSensitivity(Number(range.value)));
  const state = el('span', 'meter-state', '');
  const meter = el('div', 'lr meter-row');
  const mbar = el('div', 'meter');
  mbar.append(fill, range);
  const mtop = el('div', 'fld-top');
  mtop.append(el('span', 'fld-l', 'Уровень вашего голоса'), state);
  const mbox = el('div', 'fld-box');
  mbox.append(mtop, mbar);
  meter.append(mbox);
  const modeBox = el('div', 'set-sec');

  const renderMode = () => {
    const st = calls.settings();
    const auto = st.sens === null;
    meter.classList.toggle('ptt', st.mode === 'ptt');
    meter.classList.toggle('auto', auto && st.mode === 'vad');
    range.disabled = st.mode === 'ptt' || auto;
    const modes = grp(
      radioRow('Голосовая активность', 'Вас слышно, когда вы говорите', st.mode === 'vad', () => { calls.setInputMode('vad'); renderMode(); }, 'micOn'),
      touch ? null : radioRow('Рация', 'Вас слышно, пока держите клавишу', st.mode === 'ptt', () => { calls.setInputMode('ptt'); renderMode(); }, 'sound'),
    );
    const parts: HTMLElement[] = [grpLabel('Режим ввода'), modes];
    if (st.mode === 'vad') {
      parts.push(grp(
        switchRow('sliders', 'Определять чувствительность автоматически', 'Порог подстраивается под шум в комнате', () => calls.settings().sens === null, (on) => {
          calls.setSensitivity(on ? null : Math.round(calls.rmsToSens(calls.threshold(liveMic()))));
          renderMode();
        }),
        meter,
      ));
      parts.push(grpNote(auto ? 'Полоска показывает вашу громкость. Метка — порог, который СКАМ подбирает сам.' : 'Передвиньте метку: всё, что тише, не передаётся. Говорите — полоска должна заходить за метку.'));
    } else {
      const chip = el('span', 'key-chip', calls.keyName(st.ptt));
      const keyBtn = row({ icon: 'grip', label: 'Клавиша рации', em: chip, fn: () => {
        if (capturing) return;
        chip.textContent = 'Нажмите клавишу…';
        chip.classList.add('wait');
        capturing = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (ev.code !== 'Escape') calls.setPttKey(ev.code);
          window.removeEventListener('keydown', capturing!, true);
          capturing = null;
          renderMode();
        };
        window.addEventListener('keydown', capturing, true);
      } });
      parts.push(grp(keyBtn, meter));
      parts.push(grpNote('Удерживайте клавишу — и вас слышно. Клавиши ловятся, пока вкладка СКАМ открыта и в фокусе: браузер не отдаёт нажатия из других окон. Печатая в поле ввода, рацию не нажать.'));
    }
    modeBox.replaceChildren(...parts);
  };

  // ---- проверка микрофона
  const hearRow = switchRow('headphones', 'Слышать себя', 'Включайте в наушниках — иначе будет эхо', () => monitoring, (on) => {
    monitoring = on;
    const m = liveMic();
    if (m) calls.monitorMic(m, on);
  });

  // ---- камера и предпросмотр
  let camRow: HTMLElement = el('div', 'lr');
  const video = el('video', 'cam-video');
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  const prevBtn = button('btn small cam-start', 'Проверить камеру', () => void startPrev());
  const prevBox = el('div', 'cam-prev');
  prevBox.append(video, prevBtn);
  const prevRow = el('div', 'lr prev-row');
  prevRow.append(prevBox);

  const stopPrev = () => {
    prev?.getTracks().forEach((t) => t.stop());
    prev = null;
    video.srcObject = null;
    prevOn = false;
    prevBox.classList.remove('on');
  };
  const startPrev = async () => {
    stopPrev();
    try {
      const s = C.session;
      if (s?.cam) video.srcObject = new MediaStream([s.cam]);
      else {
        prev = await calls.openCamPreview();
        video.srcObject = prev;
      }
      prevOn = true;
      prevBox.classList.add('on');
      void video.play().catch(() => {});
      if (prev) void refresh();
    } catch {
      toast('Нет доступа к камере — разрешите его в настройках браузера.');
    }
  };

  // ---- динамики
  let outRow: HTMLElement = el('div', 'lr');
  const volRow = rangeRow('Громкость звонка', 0, 100, calls.settings().outVol, (v) => `${v}%`, (v) => calls.setOutputVolume(v), { icon: 'sound', id: 'set-out' });
  const swap = (old: HTMLElement, next: HTMLElement): HTMLElement => { old.replaceWith(next); return next; };

  /** Список устройств: при открытии, после выдачи доступа и когда что-то подключили или отключили. */
  async function refresh(): Promise<void> {
    const d = await calls.listDevices();
    const cur = calls.chosen();
    const has = (list: MediaDeviceInfo[], id: string | null) => (id && list.some((x) => x.deviceId === id) ? id : '');
    micRow = swap(micRow, selectRow('Устройство ввода', devOpts(d.mics, 'Микрофон'), has(d.mics, cur.mic), (v) => void pickMic(v), { icon: 'mic', id: 'set-mic' }));
    camRow = swap(camRow, selectRow('Устройство', devOpts(d.cams, 'Камера'), has(d.cams, cur.cam), (v) => void pickCam(v), { icon: 'camera', id: 'set-cam' }));
    outRow = swap(outRow, selectRow('Устройство вывода', devOpts(d.outs, 'Динамики'), has(d.outs, cur.out), (v) => { void calls.useDevice('out', v); }, { icon: 'sound', id: 'set-outdev' }));
  }
  async function pickMic(v: string): Promise<void> {
    await calls.useDevice('mic', v);
    await refresh();
  }
  async function pickCam(v: string): Promise<void> {
    await calls.useDevice('cam', v);
    if (prevOn) await startPrev();
    await refresh();
  }

  // ---- обработка звука
  const proc = grp(
    switchRow('sliders', 'Шумоподавление', 'Убирает фон: клавиатуру, вентилятор', () => calls.settings().ns, (v) => { void calls.setAudioFlag('ns', v); }),
    switchRow('sliders', 'Подавление эха', 'Чтобы собеседник не слышал себя из ваших колонок', () => calls.settings().ec, (v) => { void calls.setAudioFlag('ec', v); }),
    switchRow('sliders', 'Автоусиление', 'Выравнивает громкость голоса', () => calls.settings().agc, (v) => { void calls.setAudioFlag('agc', v); }),
    switchRow('mic', 'Передавать звук напрямую', 'Включите, если собеседники слышат шум или треск вместо голоса. Громкость микрофона тогда не работает.', () => calls.settings().direct, (v) => { calls.setDirect(v); }),
  );

  renderMode();
  body.append(
    grpLabel('Микрофон'), grp(micRow, gainRow), micNow, micErr,
    modeBox,
    grpLabel('Проверка микрофона'), grp(hearRow),
    grpLabel('Камера'), grp(camRow, prevRow),
    grpLabel('Звук'), grp(calls.canPickOutput() ? outRow : null, volRow), proc,
    grpNote('Громкость каждого участника — правой кнопкой по его плитке (на телефоне — долгое нажатие). Ctrl+Shift+M — микрофон, Ctrl+Shift+D — звук.'),
  );
  dlg.className = 'sheet call-set';
  dlg.replaceChildren(sheetHead(dlg, 'Голос и видео'), body);
  openDialog(dlg);

  // ---- живая полоска
  const tickMeter = () => {
    const m = liveMic();
    const info = calls.micInfo(m);
    const now = info ? `Сейчас работает: ${info.label || 'микрофон'}${info.rate ? ` · ${Math.round(info.rate / 100) / 10} кГц` : ''}${info.direct ? ' · напрямую' : ''}` : '';
    if (micNow.textContent !== now) { micNow.textContent = now; micNow.hidden = !now; }
    const bad = calls.micProblem(m);
    if (bad) { if (micErr.textContent !== bad) micErr.textContent = bad; micErr.hidden = false; }
    else if (micErr.dataset.fixed !== '1') micErr.hidden = true;
    if (m) {
      const st = calls.settings();
      fill.style.width = `${Math.round(calls.rmsToSens(m.lvl))}%`;
      const thr = Math.round(calls.rmsToSens(calls.threshold(m)));
      if (st.mode === 'vad' && (st.sens === null || document.activeElement !== range)) range.value = String(st.sens ?? thr);
      const heard = m.open && m.lvl > 0.01;
      fill.classList.toggle('hot', heard);
      state.textContent = st.mode === 'ptt' ? (calls.pttHeld() ? (heard ? 'Вас слышно' : 'Рация нажата') : `Нажмите ${calls.keyName(st.ptt)}`)
        : heard ? 'Вас слышно' : m.lvl > 0.01 ? 'Тише порога' : 'Тихо';
    } else {
      fill.style.width = '0';
      state.textContent = '';
    }
    raf = requestAnimationFrame(tickMeter);
  };

  const cleanup = () => {
    cancelAnimationFrame(raf);
    stopPrev();
    const m = liveMic();
    if (m && monitoring) calls.monitorMic(m, false);
    if (testMic) calls.closeTestMic(testMic);
    testMic = null;
    if (capturing) window.removeEventListener('keydown', capturing, true);
    capturing = null;
    offs.forEach((f) => f());
  };
  dlg.addEventListener('close', cleanup, { once: true });
  offs.push(calls.onDevices(() => { void refresh(); }));

  void (async () => {
    // Без доступа к микрофону браузер прячет названия устройств — сначала просим его.
    if (!calls.activeMic()) {
      try {
        testMic = await calls.openTestMic();
        if (!dlg.open) { calls.closeTestMic(testMic); testMic = null; return; }
      } catch {
        micErr.textContent = 'Нет доступа к микрофону — разрешите его в настройках браузера (значок замка рядом с адресом).';
        micErr.hidden = false;
        micErr.dataset.fixed = '1';
      }
    }
    await refresh();
    tickMeter();
  })();
  if (C.session?.cam) void startPrev();
}

// ---------------------------------------------------------------------------
// Показать экран: качество, частота кадров, звук
// ---------------------------------------------------------------------------

const FPS_NOTE: Record<number, string> = {
  15: 'Для текста, документов и слайдов: чётко и почти без трафика.',
  30: 'Подходит почти для всего: работа, фильмы, обычные игры.',
  60: 'Для динамичных игр и видео. Нужен быстрый интернет и мощный компьютер.',
};

export function openShare(): void {
  const s = C.session;
  if (!s) return;
  const dlg = $<HTMLDialogElement>('shareDlg');
  const live = !!s.scr;
  const o: calls.ShareOpts = { ...(s.share ?? calls.shareOpts()) };
  const note = grpNote('');
  const load = grpNote('');
  const paint = () => {
    note.textContent = FPS_NOTE[o.fps];
    const n = Math.max(1, s.peers.size);
    const mbit = (calls.plan(o, 0, n).scr.maxBitrate ?? 0) * n / 1e6;
    load.textContent = `Нагрузка на интернет: до ${mbit.toFixed(1).replace('.', ',')} Мбит/с на отдачу. Экран уходит каждому участнику отдельно${n > 1 ? ` — сейчас их ${n}` : ''}.`;
  };
  const res = choiceRow<calls.ShareRes>('Разрешение', [
    { value: '720', label: '720p' }, { value: '1080', label: '1080p' }, { value: 'src', label: 'Исходное' },
  ], o.res, (v) => { o.res = v; paint(); });
  const fps = choiceRow<calls.ShareFps>('Частота кадров', [
    { value: 15, label: '15 к/с' }, { value: 30, label: '30 к/с' }, { value: 60, label: '60 к/с' },
  ], o.fps, (v) => { o.fps = v; paint(); });
  const go = button('btn primary wide', live ? 'Применить' : 'Показать экран', () => {
    closeDialog(dlg);
    // getDisplayMedia нужно вызвать сразу в обработчике нажатия — иначе браузер не покажет выбор окна.
    if (live) void calls.changeScreen({ res: o.res, fps: o.fps });
    else void calls.startScreen(o);
  });
  const actions = el('div', 'sh-actions');
  actions.append(go);
  dlg.className = 'sheet share-set';
  dlg.replaceChildren(
    sheetHead(dlg, live ? 'Качество показа' : 'Показать экран'),
    (() => {
      const b = el('div', 'sh-body');
      b.append(grp(res, fps), note);
      if (!live) b.append(grp(switchRow('sound', 'Со звуком', 'Звук вкладки или всего экрана. Звук отдельного окна браузер обычно не даёт.', () => o.audio, (v) => { o.audio = v; })));
      b.append(load, actions);
      return b;
    })(),
  );
  paint();
  openDialog(dlg);
  go.focus();
}

/** Кнопка «Показать экран»: если уже показываем — прекратить, иначе выбрать качество. */
function onScreen(): void {
  if (C.session?.scr) void calls.toggleScreen();
  else openShare();
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
  const stageEl = document.getElementById('callStage');
  const ro = typeof ResizeObserver === 'function' && stageEl ? new ResizeObserver(() => fitGrid()) : null;
  if (stageEl) ro?.observe(stageEl);
  const onFs = () => { if (!document.fullscreenElement) renderStage(); };
  document.addEventListener('fullscreenchange', onFs);
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
    ro?.disconnect();
    document.removeEventListener('fullscreenchange', onFs);
    dlg?.removeEventListener('click', onDlg);
    videos.forEach((v) => { v.srcObject = null; });
    videos.clear();
    localStreams.clear();
    U.full = false;
    U.focus = null;
    U.focusAuto = true;
  };
}
