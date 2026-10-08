// Звонки, как в Discord: голос, видео и демонстрация экрана в личных чатах и группах.
//
// Как это устроено:
//  • Звук и видео идут напрямую между участниками (WebRTC «каждый с каждым», до 8 человек),
//    шифруются DTLS-SRTP и через сервер СКАМ не проходят.
//  • Кто в звонке — таблицы calls и call_members. Служебные сообщения WebRTC (offer/answer/ICE)
//    идут через таблицу call_signals и шифруются ключом чата (e2e.sealSignal): сервер не может
//    подменить отпечатки DTLS и незаметно встать посередине.
//  • Новичок сам предлагает соединение тем, кто уже в звонке. Если двое предложили друг другу
//    одновременно, уступает «вежливый» — тот, чей id больше.
//  • У каждого соединения четыре заранее договорённых потока: микрофон, камера, экран и звук экрана.
//    Включить камеру или экран — просто подставить дорожку (replaceTrack), без новых переговоров.
//  • Изменения приходят через Realtime; если живого соединения нет — опросом (во время звонка — раз в секунду).
import { SUPABASE_KEY, SUPABASE_URL, sb } from '../lib/supabase';
import type { ActiveCall, Call, CallMember, CallMemberInfo, CallSignal } from '../lib/database.types';
import { lsGet, lsSet, uuid } from '../lib/dom';
import { S, emit, ensureProfiles, meId, reloadChatsSoon } from './store';
import * as e2e from './e2e';
import * as snd from './sounds';

/** В звонке — до 8 человек (как ограничивает сервер). */
export const MAX_PEOPLE = 8;
const PING_MS = 12_000;
const RING_MS = 45_000;
/** Одни в звонке дольше трёх минут — отключаемся сами (как забытый открытый микрофон в Discord). */
const ALONE_MS = 3 * 60_000;
/** Эта вкладка: с другого устройства зашли в тот же звонок — эта отключается. */
const DEVICE = uuid();

// Порядок потоков в каждом соединении.
const MIC = 0;
const CAM = 1;
const SCR = 2;
const SCR_AUDIO = 3;
const KINDS = ['audio', 'video', 'video', 'audio'] as const;

export type Flags = { muted: boolean; deafened: boolean; camera: boolean; screen: boolean };

type Meter = { an: AnalyserNode; src: MediaStreamAudioSourceNode; buf: Float32Array<ArrayBuffer> };

/**
 * Наш микрофон: устройство → громкость → «ворота» → дорожка, которая уходит собеседникам.
 * Ворота открываются голосом выше порога (или клавишей рации). Дорожка `out` не меняется,
 * даже если сменить микрофон, поэтому переговоры заново не нужны.
 */
export type Mic = {
  raw: MediaStreamTrack;
  out: MediaStreamTrack;
  ctx: AudioContext | null;
  src: MediaStreamAudioSourceNode | null;
  gain: GainNode | null;
  an: AnalyserNode | null;
  delay: DelayNode | null;
  gate: GainNode | null;
  dst: MediaStreamAudioDestinationNode | null;
  monitor: GainNode | null;
  /** Откуда слышим себя в проверке микрофона. */
  monSrc: MediaStreamAudioSourceNode | null;
  monOn: boolean;
  buf: Float32Array<ArrayBuffer> | null;
  /**
   * Звук уходит как есть, дорожкой самого устройства, а не через Web Audio. Громкости микрофона тогда нет,
   * зато никакая цепочка не может испортить звук; «ворота» открываются и закрываются самой дорожкой.
   */
  direct: boolean;
  /** Устройство, которое открылось на самом деле (а не то, что просили). */
  label: string;
  devId: string;
  rate: number;
  born: number;
  /** С какого момента почти тишина (для подсказки «микрофон ничего не слышит»). */
  hushAt: number;
  /** Ворота открыты: сейчас нас слышат. */
  open: boolean;
  voiceAt: number;
  /** Громкость сейчас (RMS, после усиления, до ворот). */
  lvl: number;
  /** Оценка шума в комнате: самое тихое за последние секунды. */
  floor: number;
  mins: number[];
  winMin: number;
  winAt: number;
  timer: number;
  dead: boolean;
};

export type Peer = {
  uid: string;
  pc: RTCPeerConnection;
  /** Номер соединения: служебные сообщения от старых попыток отбрасываются. */
  sid: string;
  offerer: boolean;
  dc: RTCDataChannel;
  /** Кандидаты ICE, пришедшие раньше описания соединения. */
  ice: RTCIceCandidateInit[];
  /** Наши кандидаты: отправляем пачкой, когда описание уже ушло. */
  out: RTCIceCandidateInit[];
  outTimer?: number;
  ready: boolean;
  state: 'connecting' | 'connected' | 'failed';
  since: number;
  fixAt: number;
  /** Что собеседник сообщил о себе по каналу данных (быстрее, чем через базу). */
  flags: Flags | null;
  voice: MediaStream | null;
  cam: MediaStream | null;
  scr: MediaStream | null;
  audio: HTMLAudioElement;
  audio2: HTMLAudioElement;
  meter: Meter | null;
  speaking: boolean;
  loudAt: number;
};

export type Session = {
  callId: string;
  chatId: string;
  key: e2e.SignalKey;
  mic: MediaStreamTrack | null;
  pipe: Mic | null;
  cam: MediaStreamTrack | null;
  scr: MediaStreamTrack | null;
  scrAudio: MediaStreamTrack | null;
  /** Как мы сейчас показываем экран. */
  share: ShareOpts | null;
  flags: Flags;
  mutedBeforeDeafen: boolean;
  peers: Map<string, Peer>;
  firstSeen: Map<string, number>;
  early: Map<string, RTCIceCandidateInit[]>;
  startedAt: number;
  connectedAt: number | null;
  hadCompany: boolean;
  aloneSince: number | null;
  speaking: boolean;
  loudAt: number;
  processed: Set<number>;
  chain: Promise<void>;
  timers: number[];
  pingTimer?: number;
  lastToken: string | null;
  present: Set<string>;
  warnedKey: boolean;
};

export const C = {
  /** Идущие звонки в моих чатах (по id звонка). */
  active: new Map<string, ActiveCall>(),
  /** Звонки для записей в ленте («Входящий звонок · 5 мин»). */
  rows: new Map<string, Call>(),
  session: null as Session | null,
  /** Разница часов сервера и устройства. */
  skew: 0,
  /** Входящие, закрытые крестиком (без «Отклонить»): id|rung_at. */
  dismissed: new Set<string>(),
  /** В какой чат сейчас подключаемся. */
  joining: null as string | null,
  /** Задержка до собеседника, мс. */
  rtt: null as number | null,
};

let notice: (text: string) => void = () => {};
/** Интерфейс показывает короткие сообщения (toast). */
export function onNotice(fn: (text: string) => void): void {
  notice = fn;
}

const speakFns = new Set<() => void>();
/** Кто говорит — меняется часто, поэтому отдельно от общей перерисовки. */
export function onSpeaking(fn: () => void): () => void {
  speakFns.add(fn);
  return () => speakFns.delete(fn);
}

export function serverNow(): number {
  return Date.now() + C.skew;
}

// ---------------------------------------------------------------------------
// Настройки: устройства, громкость, чувствительность, рация, шумоподавление
// ---------------------------------------------------------------------------

export type InputMode = 'vad' | 'ptt';
export type ShareRes = '720' | '1080' | 'src';
export type ShareFps = 15 | 30 | 60;
/** Как показывать экран: разрешение, частота кадров, со звуком ли. */
export type ShareOpts = { res: ShareRes; fps: ShareFps; audio: boolean };

function num(key: string, def: number, min: number, max: number): number {
  const raw = lsGet(key);
  if (raw === null) return def;
  const v = Number(raw);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
}

function loadShare(): ShareOpts {
  const def: ShareOpts = { res: '1080', fps: 30, audio: true };
  try {
    const v = JSON.parse(lsGet('skam:call:share') ?? 'null') as Partial<ShareOpts> | null;
    if (!v) return def;
    return {
      res: v.res === '720' || v.res === 'src' ? v.res : '1080',
      fps: v.fps === 15 || v.fps === 60 ? v.fps : 30,
      audio: v.audio !== false,
    };
  } catch {
    return def;
  }
}

/** Настройки звонка на этом устройстве. Читаем один раз, дальше держим в памяти (микрофон проверяется 40 раз в секунду). */
const cfg = {
  mic: lsGet('skam:call:mic'),
  cam: lsGet('skam:call:cam'),
  out: lsGet('skam:call:out'),
  ns: lsGet('skam:call:ns') !== '0',
  ec: lsGet('skam:call:ec') !== '0',
  agc: lsGet('skam:call:agc') !== '0',
  mode: (lsGet('skam:call:mode') === 'ptt' ? 'ptt' : 'vad') as InputMode,
  /** Клавиша рации (KeyboardEvent.code). */
  ptt: lsGet('skam:call:ptt') || 'KeyV',
  /** Чувствительность: null — подбирается сама, число 0–100 — порог вручную. */
  sens: lsGet('skam:call:sens') === null || lsGet('skam:call:sens') === 'auto' ? (null as number | null) : num('skam:call:sens', 30, 0, 100),
  /** Громкость микрофона, %. */
  gain: num('skam:call:gain', 100, 0, 200),
  /** Общая громкость звонка, %. */
  outVol: num('skam:call:outvol', 100, 0, 100),
  /** Микрофон «напрямую»: без Web Audio. */
  direct: lsGet('skam:call:direct') === '1',
  share: loadShare(),
};

export type CallSettings = {
  mode: InputMode;
  ptt: string;
  /** null — автоматически. */
  sens: number | null;
  gain: number;
  outVol: number;
  ns: boolean;
  ec: boolean;
  agc: boolean;
  direct: boolean;
};

export function settings(): CallSettings {
  return { mode: cfg.mode, ptt: cfg.ptt, sens: cfg.sens, gain: cfg.gain, outVol: cfg.outVol, ns: cfg.ns, ec: cfg.ec, agc: cfg.agc, direct: cfg.direct };
}

export function noiseSuppression(): boolean {
  return cfg.ns;
}

function micConstraints(deviceId = cfg.mic): MediaTrackConstraints {
  return {
    // exact: если выбранного микрофона нет, браузер скажет об этом, а не подсунет другой (системный).
    deviceId: deviceId ? { exact: deviceId } : undefined,
    echoCancellation: cfg.ec,
    noiseSuppression: cfg.ns,
    autoGainControl: cfg.agc,
    channelCount: { ideal: 1 },
  };
}

function camConstraints(deviceId = cfg.cam): MediaTrackConstraints {
  return {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 24, max: 30 },
  };
}

function volumeOf(uid: string): number {
  const v = Number(lsGet(`skam:call:vol:${uid}`));
  return Number.isFinite(v) && v > 0 ? Math.min(1, v) : 1;
}

function streamVolumeOf(uid: string): number {
  const v = Number(lsGet(`skam:call:svol:${uid}`));
  return Number.isFinite(v) && v > 0 ? Math.min(1, v) : 1;
}

export function peerVolume(uid: string): number {
  return volumeOf(uid);
}

/** Громкость звука показа экрана у этого человека (отдельно от его голоса). */
export function streamVolume(uid: string): number {
  return streamVolumeOf(uid);
}

function applyVolumes(p: Peer): void {
  p.audio.volume = Math.min(1, volumeOf(p.uid) * (cfg.outVol / 100));
  p.audio2.volume = Math.min(1, streamVolumeOf(p.uid) * (cfg.outVol / 100));
}

/** Громкость собеседника (0–100 %), запоминается. */
export function setPeerVolume(uid: string, v: number): void {
  const vol = Math.max(0, Math.min(1, v));
  lsSet(`skam:call:vol:${uid}`, vol >= 0.999 ? null : String(vol || 0.0001));
  const p = C.session?.peers.get(uid);
  if (p) applyVolumes(p);
}

/** Громкость звука показа экрана (0–100 %), запоминается. */
export function setStreamVolume(uid: string, v: number): void {
  const vol = Math.max(0, Math.min(1, v));
  lsSet(`skam:call:svol:${uid}`, vol >= 0.999 ? null : String(vol || 0.0001));
  const p = C.session?.peers.get(uid);
  if (p) applyVolumes(p);
}

/** Общая громкость звонка (0–100 %): все голоса и звук экрана сразу. */
export function setOutputVolume(percent: number): void {
  cfg.outVol = Math.round(Math.max(0, Math.min(100, percent)));
  lsSet('skam:call:outvol', cfg.outVol >= 100 ? null : String(cfg.outVol));
  C.session?.peers.forEach(applyVolumes);
}

export type DeviceList = { mics: MediaDeviceInfo[]; cams: MediaDeviceInfo[]; outs: MediaDeviceInfo[] };

export async function listDevices(): Promise<DeviceList> {
  const all = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
  // «default» и «communications» в Chrome дублируют настоящие устройства — «Как в системе» уже есть в списке.
  const real = (d: MediaDeviceInfo) => d.deviceId !== 'default' && d.deviceId !== 'communications';
  return {
    mics: all.filter((d) => d.kind === 'audioinput' && real(d)),
    cams: all.filter((d) => d.kind === 'videoinput'),
    outs: all.filter((d) => d.kind === 'audiooutput' && real(d)),
  };
}

export function chosen(): { mic: string | null; cam: string | null; out: string | null } {
  return { mic: cfg.mic, cam: cfg.cam, out: cfg.out };
}

const deviceFns = new Set<() => void>();
let deviceWatch = false;
/** Подключили или отключили микрофон, камеру, наушники. */
export function onDevices(fn: () => void): () => void {
  deviceFns.add(fn);
  if (!deviceWatch && navigator.mediaDevices?.addEventListener) {
    deviceWatch = true;
    navigator.mediaDevices.addEventListener('devicechange', () => deviceFns.forEach((f) => f()));
  }
  return () => deviceFns.delete(fn);
}

/**
 * Браузер скрывает названия устройств, пока не получен доступ. Просим его один раз
 * (и сразу отпускаем), чтобы в списке были «Микрофон HyperX», а не «Микрофон 1».
 */
export async function unlockLabels(kind: 'mic' | 'cam'): Promise<boolean> {
  try {
    const st = await navigator.mediaDevices.getUserMedia(kind === 'mic' ? { audio: true } : { video: true });
    st.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

export function canPickOutput(): boolean {
  return typeof (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId === 'function';
}

export function canShareScreen(): boolean {
  return !!navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function';
}

export function canCall(): boolean {
  return typeof RTCPeerConnection === 'function' && !!navigator.mediaDevices?.getUserMedia;
}

// ---------------------------------------------------------------------------
// Что сейчас происходит
// ---------------------------------------------------------------------------

export function callInChat(chatId: string): ActiveCall | null {
  for (const c of C.active.values()) if (c.chat_id === chatId) return c;
  return null;
}

export function inCall(c: ActiveCall): CallMemberInfo[] {
  return c.members.filter((m) => m.state === 'in');
}

function isRinging(c: ActiveCall): boolean {
  if (C.session?.callId === c.id) return false;
  if (C.dismissed.has(`${c.id}|${c.rung_at}`)) return false;
  const mine = c.members.find((m) => m.user_id === meId());
  if (mine && (mine.state === 'in' || mine.state === 'declined')) return false;
  if (!c.members.some((m) => m.state === 'in' && m.user_id !== meId())) return false;
  return Date.parse(c.rung_at) + RING_MS > serverNow();
}

/** Входящие звонки, которые сейчас звонят мне. */
export function ringing(): ActiveCall[] {
  return [...C.active.values()].filter(isRinging).sort((a, b) => Date.parse(b.rung_at) - Date.parse(a.rung_at));
}

/** Звонок моей сессии (из списка идущих). */
export function sessionCall(): ActiveCall | null {
  const s = C.session;
  return s ? C.active.get(s.callId) ?? null : null;
}

/** Кто, кроме меня, сейчас в моём звонке. */
export function othersInSession(): CallMemberInfo[] {
  const c = sessionCall();
  return c ? inCall(c).filter((m) => m.user_id !== meId()) : [];
}

/** Звоним и ещё никто не ответил (идут гудки). */
export function waitingAnswer(): boolean {
  const s = C.session;
  const c = sessionCall();
  if (!s || !c || s.hadCompany || othersInSession().length) return false;
  return !c.answered_at && Date.parse(c.rung_at) + RING_MS > serverNow();
}

// ---------------------------------------------------------------------------
// Список звонков: my_calls + Realtime
// ---------------------------------------------------------------------------

let refreshTimer: number | undefined;
let refreshing = false;
let refreshAgain = false;

export function refreshSoon(delay = 150): void {
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => { void refreshCalls(); }, delay);
}

export async function refreshCalls(): Promise<void> {
  if (refreshing) { refreshAgain = true; return; }
  refreshing = true;
  const askedAt = Date.now();
  try {
    const { data, error } = await sb.rpc('my_calls');
    if (error || !data) return;
    const before = new Set(C.active.keys());
    const next = new Map<string, ActiveCall>();
    for (const c of data) {
      c.members = Array.isArray(c.members) ? c.members : [];
      next.set(c.id, c);
      C.skew = Date.parse(c.server_now) - Date.now();
    }
    C.active = next;
    const gone = [...before].filter((id) => !next.has(id));
    if (gone.length) { void loadCallRows(gone, true); reloadChatsSoon(); }
    void ensureProfiles(data.flatMap((c) => [c.started_by, ...c.members.map((m) => m.user_id)]));
    const s = C.session;
    // Мой звонок пропал из идущих — он закончился (если запрос ушёл уже после того, как мы вошли).
    if (s && !next.has(s.callId) && s.startedAt < askedAt) {
      void finished(s);
      return;
    }
    afterChange();
  } finally {
    refreshing = false;
    if (refreshAgain) { refreshAgain = false; refreshSoon(0); }
  }
}

/** Чем закончился звонок — для короткого сообщения. */
function endedText(s: Session, row: Call | undefined): string {
  if (s.hadCompany || row?.status === 'ended') return 'Звонок завершён';
  if (row?.status === 'declined') return 'Звонок отклонён';
  if (row?.status === 'missed') return 'Никто не ответил';
  return 'Звонок завершён';
}

/** Сервер сообщил, что звонок закончился: узнаём итог и выходим. */
async function finished(s: Session): Promise<void> {
  if (C.session !== s) return;
  const { data } = await sb.from('calls').select('*').eq('id', s.callId).maybeSingle();
  if (data) { C.rows.set(data.id, data); emit('feed'); }
  endLocal(s, endedText(s, data ?? C.rows.get(s.callId)));
}

const rowLoading = new Set<string>();
const rowAgain = new Set<string>();
/** Загрузить звонки для записей в ленте. force — перечитать (звонок закончился). */
export async function loadCallRows(ids: string[], force = false): Promise<void> {
  const uniq = [...new Set(ids)];
  // Уже грузится — но, возможно, со старым состоянием: перечитаем, когда загрузка закончится.
  if (force) uniq.filter((id) => rowLoading.has(id)).forEach((id) => rowAgain.add(id));
  const need = uniq.filter((id) => (force || !C.rows.has(id)) && !rowLoading.has(id));
  if (!need.length) return;
  need.forEach((id) => rowLoading.add(id));
  try {
    const { data } = await sb.from('calls').select('*').in('id', need);
    data?.forEach((r) => C.rows.set(r.id, r));
  } finally {
    need.forEach((id) => rowLoading.delete(id));
  }
  emit('feed', 'call');
  const again = need.filter((id) => rowAgain.delete(id));
  if (again.length) void loadCallRows(again, true);
}

/** Realtime: звонок начался или закончился. */
export function onCallRow(row: Call): void {
  C.rows.set(row.id, row);
  if (row.ended_at) {
    C.active.delete(row.id);
    reloadChatsSoon();
    const s = C.session;
    if (s && s.callId === row.id) endLocal(s, endedText(s, row));
  }
  refreshSoon();
  emit('feed', 'call');
}

/** Realtime: кто-то вошёл, вышел, выключил микрофон… Пульс (seen_at) сам по себе ничего не меняет. */
export function onCallMemberRow(row: CallMember): void {
  const c = C.active.get(row.call_id);
  if (!c) { refreshSoon(); return; }
  const info: CallMemberInfo = {
    user_id: row.user_id, state: row.state, device: row.device, joined_at: row.joined_at,
    muted: row.muted, deafened: row.deafened, camera: row.camera, screen: row.screen,
  };
  const i = c.members.findIndex((m) => m.user_id === row.user_id);
  const prev = i >= 0 ? c.members[i] : null;
  if (i >= 0) c.members[i] = info; else c.members.push(info);
  const same = prev && (['state', 'device', 'joined_at', 'muted', 'deafened', 'camera', 'screen'] as const)
    .every((k) => prev[k] === info[k]);
  if (same) return;
  void ensureProfiles([row.user_id]);
  // Я в этом звонке с другого устройства — проверим, не нас ли заменили.
  const s = C.session;
  if (s && s.callId === row.call_id && row.user_id === meId() && row.state === 'in' && row.device !== DEVICE) void heartbeat(s);
  if (!prev || prev.state !== info.state) refreshSoon(400);
  afterChange();
}

/** Realtime: служебное сообщение WebRTC для меня. */
export function onSignalRow(row: CallSignal): void {
  if (row.to_user === meId()) takeSignals([row]);
}

let tick: number | undefined;
let pollTimer: number | undefined;
let sigTimer: number | undefined;

/** Запуск при входе в приложение. */
export function startCalls(): void {
  stopTimers();
  void refreshCalls();
  schedulePoll();
  // Раз в секунду: входящий перестаёт звонить через 45 секунд, гудки — когда никто не ответил.
  tick = window.setInterval(updateTones, 1000);
  window.addEventListener('pagehide', onPageHide);
  watchKeys(true);
}

export function stopCalls(): void {
  const s = C.session;
  if (s) {
    teardown(s);
    C.session = null;
    sb.rpc('call_leave', { p_call: s.callId, p_device: DEVICE }).then(() => {}, () => {});
  }
  stopTimers();
  snd.stopTones();
  C.active.clear();
  C.rows.clear();
  C.dismissed.clear();
  C.joining = null;
  window.removeEventListener('pagehide', onPageHide);
  watchKeys(false);
  ptt.down = false;
}

function stopTimers(): void {
  clearInterval(tick);
  clearTimeout(pollTimer);
  clearTimeout(sigTimer);
  clearTimeout(refreshTimer);
}

function schedulePoll(): void {
  clearTimeout(pollTimer);
  const busy = !!C.session || ringing().length > 0;
  // С живым Realtime опрос — только подстраховка.
  const ms = S.live ? (busy ? 10_000 : 30_000) : (busy ? 2500 : 6000);
  pollTimer = window.setTimeout(() => {
    void refreshCalls().finally(schedulePoll);
  }, ms);
}

function scheduleSignalPoll(s: Session): void {
  clearTimeout(sigTimer);
  if (C.session !== s) return;
  sigTimer = window.setTimeout(() => {
    void pollSignals(s).finally(() => scheduleSignalPoll(s));
  }, S.live ? 4000 : 900);
}

async function pollSignals(s: Session): Promise<void> {
  if (C.session !== s) return;
  const { data } = await sb.from('call_signals').select('*').eq('to_user', meId()).order('id', { ascending: true }).limit(200);
  if (data?.length) takeSignals(data);
}

let prevRinging = '';
let prevWaiting = false;
function updateTones(): void {
  const r = ringing();
  const key = r.map((c) => c.id).join(',');
  if (key !== prevRinging) {
    prevRinging = key;
    if (r.length) navigator.vibrate?.([400, 200, 400]);
    emit('chats', 'call');
  }
  const w = waitingAnswer();
  if (w !== prevWaiting) { prevWaiting = w; emit('call'); }
  if (r.length) snd.ringStart();
  else if (w) snd.backStart();
  else snd.stopTones();
}

function afterChange(): void {
  const s = C.session;
  if (s) {
    // Звуки «вошёл/вышел», как в Discord.
    const now = new Set(othersInSession().map((m) => m.user_id));
    now.forEach((u) => { if (!s.present.has(u)) snd.joined(); });
    s.present.forEach((u) => { if (!now.has(u)) snd.left(); });
    s.present = now;
    reconcile(s);
  }
  updateTones();
  emit('call');
}

// ---------------------------------------------------------------------------
// Вход и выход
// ---------------------------------------------------------------------------

export class CallError extends Error {}

function mediaError(e: unknown, what: 'mic' | 'cam' | 'screen'): string {
  const name = (e as { name?: string })?.name;
  const thing = what === 'mic' ? 'микрофону' : what === 'cam' ? 'камере' : 'экрану';
  if (name === 'NotAllowedError' || name === 'SecurityError') return `Нет доступа к ${thing} — разрешите его в настройках браузера.`;
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return what === 'mic' ? 'Микрофон не найден.' : what === 'cam' ? 'Камера не найдена.' : 'Не получилось показать экран.';
  if (name === 'NotReadableError') return what === 'mic' ? 'Микрофон занят другой программой.' : 'Камера занята другой программой.';
  if (name === 'AbortError') return '';
  return what === 'mic' ? 'Не получилось включить микрофон.' : what === 'cam' ? 'Не получилось включить камеру.' : 'Не получилось показать экран.';
}

/** Выбранного устройства нет (отключили, сменился адрес) — браузер ответил отказом по «exact». */
function gone(e: unknown): boolean {
  const n = (e as { name?: string })?.name;
  return n === 'OverconstrainedError' || n === 'NotFoundError';
}

/**
 * Микрофон. deviceId: undefined — тот, что выбран в настройках; null — системный.
 * Если выбранного больше нет: при `fallback` берём системный и забываем выбор, иначе — ошибка.
 */
async function getRawMic(deviceId?: string | null, fallback = true): Promise<MediaStreamTrack> {
  const id = deviceId === undefined ? cfg.mic : deviceId;
  let st: MediaStream;
  try {
    st = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(id) });
  } catch (e) {
    if (!id || !fallback || !gone(e)) throw e;
    if (cfg.mic === id) { cfg.mic = null; lsSet('skam:call:mic', null); }
    notice('Выбранный микрофон не найден — взяли микрофон «Как в системе».');
    st = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(null) });
  }
  const t = st.getAudioTracks()[0];
  return t;
}

/** Микрофон с обработкой (громкость, ворота), готовый к отправке. */
async function getMic(deviceId?: string | null): Promise<Mic> {
  return makeMic(await getRawMic(deviceId));
}

async function getCam(deviceId?: string | null, fallback = true): Promise<MediaStreamTrack> {
  const id = deviceId === undefined ? cfg.cam : deviceId;
  let st: MediaStream;
  try {
    st = await navigator.mediaDevices.getUserMedia({ video: camConstraints(id) });
  } catch (e) {
    if (!id || !fallback || !gone(e)) throw e;
    if (cfg.cam === id) { cfg.cam = null; lsSet('skam:call:cam', null); }
    notice('Выбранная камера не найдена — взяли камеру «Как в системе».');
    st = await navigator.mediaDevices.getUserMedia({ video: camConstraints(null) });
  }
  const t = st.getVideoTracks()[0];
  t.contentHint = 'motion';
  return t;
}

type Media = { mic: Mic | null; cam: MediaStreamTrack | null };

/** Микрофон (и камера): без микрофона всё равно пускаем в звонок — слушать. */
async function openMedia(video: boolean): Promise<Media> {
  if (!canCall()) throw new CallError('Этот браузер не умеет звонить. Откройте СКАМ в Chrome, Edge, Firefox или Safari.');
  let mic: Mic | null = null;
  let cam: MediaStreamTrack | null = null;
  try { mic = await getMic(); } catch (e) { const t = mediaError(e, 'mic'); if (t) notice(`${t} Вы в звонке без микрофона.`); }
  if (video) {
    try { cam = await getCam(); } catch (e) { const t = mediaError(e, 'cam'); if (t) notice(t); }
  }
  return { mic, cam };
}

function stopMedia(m: Media): void {
  if (m.mic) dropMic(m.mic);
  m.cam?.stop();
}

function errMsg(e: unknown, fallback: string): string {
  const err = e as { message?: string; code?: string } | null;
  if (err?.message && /^[А-ЯЁ]/.test(err.message)) return err.message;
  if (err?.message?.includes('Failed to fetch')) return 'Нет связи с сервером.';
  return fallback;
}

/** Позвонить в чат (или присоединиться, если там уже идёт звонок). */
export async function startCall(chatId: string, video: boolean): Promise<void> {
  if (C.session?.chatId === chatId || C.joining) return;
  snd.unlock();
  C.joining = chatId;
  emit('call');
  let media: Media | null = null;
  try {
    media = await openMedia(video);
    const key = await e2e.signalKey(chatId);
    if (C.session) await hangup(true);
    const { data, error } = await sb.rpc('call_start', { p_chat: chatId, p_video: video && !!media.cam, p_device: DEVICE });
    if (error || !data) throw error ?? new Error('call_start');
    begin(data, chatId, key, media);
    media = null;
  } catch (e) {
    if (media) stopMedia(media);
    throw new CallError(errMsg(e, 'Не получилось позвонить. Проверьте соединение.'));
  } finally {
    C.joining = null;
    emit('call');
  }
}

/** Войти в идущий звонок (принять входящий или «Присоединиться»). */
export async function joinCall(callId: string, video = false): Promise<void> {
  const c = C.active.get(callId);
  if (!c || C.joining) return;
  if (C.session?.callId === callId) return;
  snd.unlock();
  C.joining = c.chat_id;
  emit('call');
  let media: Media | null = null;
  try {
    media = await openMedia(video);
    const key = await e2e.signalKey(c.chat_id);
    if (C.session) await hangup(true);
    const { error } = await sb.rpc('call_join', { p_call: callId, p_device: DEVICE });
    if (error) throw error;
    begin(callId, c.chat_id, key, media);
    media = null;
  } catch (e) {
    if (media) stopMedia(media);
    throw new CallError(errMsg(e, 'Не получилось войти в звонок.'));
  } finally {
    C.joining = null;
    emit('call');
  }
}

function begin(callId: string, chatId: string, key: e2e.SignalKey, media: Media): void {
  const s: Session = {
    callId, chatId, key,
    mic: media.mic?.out ?? null, pipe: media.mic, cam: media.cam, scr: null, scrAudio: null, share: null,
    flags: { muted: !media.mic, deafened: false, camera: !!media.cam, screen: false },
    mutedBeforeDeafen: false,
    peers: new Map(), firstSeen: new Map(), early: new Map(),
    startedAt: Date.now(), connectedAt: null, hadCompany: false, aloneSince: null,
    speaking: false, loudAt: 0,
    processed: new Set(), chain: Promise.resolve(), timers: [],
    lastToken: null, present: new Set(), warnedKey: false,
  };
  C.session = s;
  C.dismissed.forEach((k) => { if (k.startsWith(`${callId}|`)) C.dismissed.delete(k); });
  s.timers.push(
    window.setInterval(() => { void heartbeat(s); }, PING_MS),
    window.setInterval(() => reconcile(s), 2000),
    window.setInterval(() => measureSpeaking(s), 120),
    window.setInterval(() => { void measureRtt(s); }, 5000),
  );
  if (media.mic) watchMic(s, media.mic);
  void heartbeat(s);
  void refreshCalls();
  void pollSignals(s);
  scheduleSignalPoll(s);
  schedulePoll();
  emit('call', 'chats');
}

/** Положить трубку. quiet — без звука (переходим в другой звонок). */
export async function hangup(quiet = false): Promise<void> {
  const s = C.session;
  if (!s) return;
  if (!quiet) snd.hangup();
  // Предупредим собеседников, чтобы они не ждали, пока истечёт пульс.
  const byes = [...s.peers.keys()].map((uid) => send(s, uid, { t: 'bye' }).catch(() => {}));
  teardown(s);
  C.session = null;
  C.rtt = null;
  emit('call', 'chats');
  await Promise.race([Promise.all(byes), new Promise((r) => setTimeout(r, 1500))]);
  await sb.rpc('call_leave', { p_call: s.callId, p_device: DEVICE }).then(() => {}, () => {});
  await refreshCalls();
}

/** Звонок закончился не по нашей воле (завершён, заменён другим устройством). */
function endLocal(s: Session, text: string): void {
  if (C.session !== s) return;
  snd.hangup();
  teardown(s);
  C.session = null;
  C.rtt = null;
  if (text) notice(text);
  afterChange();
  emit('chats');
}

function teardown(s: Session): void {
  s.timers.forEach((t) => clearInterval(t));
  s.timers = [];
  clearTimeout(sigTimer);
  clearTimeout(s.pingTimer);
  s.peers.forEach((p) => closePeer(s, p, false));
  [s.cam, s.scr, s.scrAudio].forEach((t) => t?.stop());
  if (s.pipe) dropMic(s.pipe);
  s.pipe = null;
  s.mic = null;
  snd.stopTones();
}

/** Отклонить входящий (в личном чате — завершает звонок). */
export async function decline(callId: string): Promise<void> {
  const c = C.active.get(callId);
  if (c) {
    const mine = c.members.find((m) => m.user_id === meId());
    if (mine) mine.state = 'declined';
    else c.members.push({ user_id: meId(), state: 'declined', device: null, joined_at: null, muted: false, deafened: false, camera: false, screen: false });
  }
  afterChange();
  const { error } = await sb.rpc('call_decline', { p_call: callId });
  if (error) notice('Не получилось отклонить звонок.');
  await refreshCalls();
}

/** Закрыть окно входящего, не отклоняя (звонок продолжится, можно присоединиться позже). */
export function dismiss(callId: string): void {
  const c = C.active.get(callId);
  if (c) C.dismissed.add(`${c.id}|${c.rung_at}`);
  afterChange();
}

/** Позвонить ещё раз тем, кто не в звонке (в группе). */
export async function ringAgain(): Promise<void> {
  const s = C.session;
  if (!s) return;
  const { error } = await sb.rpc('call_ring', { p_call: s.callId });
  if (error) notice('Не получилось позвонить ещё раз.');
  else notice('Звоним ещё раз');
  await refreshCalls();
}

// ---------------------------------------------------------------------------
// Пульс и состояние
// ---------------------------------------------------------------------------

async function heartbeat(s: Session): Promise<void> {
  if (C.session !== s) return;
  const f = s.flags;
  const { data, error } = await sb.rpc('call_ping', {
    p_call: s.callId, p_device: DEVICE, p_muted: f.muted, p_deafened: f.deafened, p_camera: f.camera, p_screen: f.screen,
  });
  sb.auth.getSession().then(({ data: d }) => { s.lastToken = d.session?.access_token ?? null; }, () => {});
  if (C.session !== s || error) return;
  if (data === 'ended') void finished(s);
  else if (data === 'replaced') endLocal(s, 'Вы подключились к звонку с другого устройства');
  else if (data === 'gone') {
    // Нас сочли выбывшими (например, устройство засыпало) — пробуем вернуться.
    const again = await sb.rpc('call_join', { p_call: s.callId, p_device: DEVICE });
    if (C.session !== s) return;
    if (again.error) endLocal(s, 'Связь со звонком потеряна');
    else { s.peers.forEach((p) => closePeer(s, p, false)); void refreshCalls(); }
  }
}

function stateChanged(s: Session): void {
  const msg = JSON.stringify({ t: 'st', ...s.flags });
  s.peers.forEach((p) => { if (p.dc.readyState === 'open') { try { p.dc.send(msg); } catch { /* закрылся */ } } });
  // Своё состояние в списке — сразу, не дожидаясь сервера.
  const c = sessionCall();
  const mine = c?.members.find((m) => m.user_id === meId());
  if (mine) Object.assign(mine, s.flags);
  clearTimeout(s.pingTimer);
  s.pingTimer = window.setTimeout(() => { void heartbeat(s); }, 300);
  emit('call');
}

export function toggleMute(): void {
  const s = C.session;
  if (!s) return;
  if (!s.mic) { void retryMic(s); return; }
  if (s.flags.deafened) {
    // Как в Discord: включили микрофон — включается и звук.
    s.flags.deafened = false;
    applyDeafen(s);
    s.flags.muted = false;
  } else {
    s.flags.muted = !s.flags.muted;
  }
  s.mic.enabled = !s.flags.muted;
  snd.muted(s.flags.muted);
  stateChanged(s);
}

async function retryMic(s: Session): Promise<void> {
  try {
    const m = await getMic();
    if (C.session !== s) { dropMic(m); return; }
    s.pipe = m;
    s.mic = m.out;
    watchMic(s, m);
    setTrack(s, MIC, m.out);
    s.flags.muted = false;
    stateChanged(s);
  } catch (e) {
    notice(mediaError(e, 'mic') || 'Не получилось включить микрофон.');
  }
}

export function toggleDeafen(): void {
  const s = C.session;
  if (!s) return;
  s.flags.deafened = !s.flags.deafened;
  if (s.flags.deafened) {
    s.mutedBeforeDeafen = s.flags.muted;
    s.flags.muted = true;
  } else {
    s.flags.muted = s.mutedBeforeDeafen || !s.mic;
  }
  if (s.mic) s.mic.enabled = !s.flags.muted;
  applyDeafen(s);
  snd.muted(s.flags.deafened);
  stateChanged(s);
}

function applyDeafen(s: Session): void {
  s.peers.forEach((p) => { p.audio.muted = s.flags.deafened; p.audio2.muted = s.flags.deafened; });
}

export async function toggleCamera(): Promise<void> {
  const s = C.session;
  if (!s) return;
  if (s.cam) {
    s.cam.stop();
    s.cam = null;
    s.flags.camera = false;
    setTrack(s, CAM, null);
    stateChanged(s);
    return;
  }
  try {
    const t = await getCam();
    if (C.session !== s) { t.stop(); return; }
    s.cam = t;
    s.flags.camera = true;
    t.addEventListener('ended', () => { if (s.cam === t) { s.cam = null; s.flags.camera = false; setTrack(s, CAM, null); stateChanged(s); } });
    setTrack(s, CAM, t);
    stateChanged(s);
  } catch (e) {
    const m = mediaError(e, 'cam');
    if (m) notice(m);
  }
}

/** Показать экран (или прекратить показ). Без аргумента берутся сохранённые настройки. */
export async function toggleScreen(opts?: ShareOpts): Promise<void> {
  const s = C.session;
  if (!s) return;
  if (s.scr) { stopScreen(s); return; }
  await startScreen(opts ?? cfg.share);
}

/** Сохранённые настройки показа экрана. */
export function shareOpts(): ShareOpts {
  return { ...cfg.share };
}

function rememberShare(o: ShareOpts): void {
  cfg.share = { ...o };
  lsSet('skam:call:share', JSON.stringify(o));
}

const SHARE_SIZE: Record<ShareRes, [number, number]> = { '720': [1280, 720], '1080': [1920, 1080], src: [3840, 2160] };

function shareVideo(o: ShareOpts): MediaTrackConstraints {
  const [w, h] = SHARE_SIZE[o.res];
  return { frameRate: { ideal: o.fps, max: o.fps }, width: { max: w }, height: { max: h } };
}

export async function startScreen(opts: ShareOpts): Promise<boolean> {
  const s = C.session;
  if (!s || s.scr) return false;
  if (!canShareScreen()) { notice('На этом устройстве показать экран нельзя — попробуйте с компьютера.'); return false; }
  rememberShare(opts);
  try {
    // Дополнительные поля есть только в Chrome и Edge; остальные браузеры их просто не заметят.
    const req = {
      video: shareVideo(opts),
      audio: opts.audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: 'include',
      suppressLocalAudioPlayback: true,
    } as MediaStreamConstraints;
    const st = await navigator.mediaDevices.getDisplayMedia(req);
    if (C.session !== s) { st.getTracks().forEach((t) => t.stop()); return false; }
    const v = st.getVideoTracks()[0];
    // Браузер мог дать больше, чем просили (особенно «окно»), — подрежем и частоту кадров.
    await v.applyConstraints(shareVideo(opts)).catch(() => {});
    v.contentHint = opts.fps >= 60 ? 'motion' : 'detail';
    s.scr = v;
    s.scrAudio = opts.audio ? st.getAudioTracks()[0] ?? null : null;
    st.getAudioTracks().forEach((t) => { if (t !== s.scrAudio) t.stop(); });
    s.share = { ...opts, audio: !!s.scrAudio };
    s.flags.screen = true;
    // «Прекратить показ» в окне браузера.
    v.addEventListener('ended', () => { if (s.scr === v) stopScreen(s); });
    setTrack(s, SCR, v);
    setTrack(s, SCR_AUDIO, s.scrAudio);
    stateChanged(s);
    if (opts.audio && !s.scrAudio) notice('Показ идёт без звука: браузер не дал звук этого окна. Для звука выберите вкладку или весь экран и отметьте «Поделиться звуком».');
    return true;
  } catch (e) {
    const m = mediaError(e, 'screen');
    if (m && (e as { name?: string })?.name !== 'NotAllowedError') notice(m);
    return false;
  }
}

/** Сменить качество показа на лету (звук уже выбран и меняется только новым показом). */
export async function changeScreen(opts: Pick<ShareOpts, 'res' | 'fps'>): Promise<void> {
  const s = C.session;
  if (!s?.scr || !s.share) return;
  const next: ShareOpts = { ...s.share, ...opts };
  rememberShare({ ...next, audio: cfg.share.audio });
  s.share = next;
  s.scr.contentHint = next.fps >= 60 ? 'motion' : 'detail';
  await s.scr.applyConstraints(shareVideo(next)).catch(() => {});
  tune(s);
  emit('call');
}

/** Что сейчас показываем: для строки «Вы показываете экран». */
export function screenInfo(): { opts: ShareOpts; surface: string; width: number; height: number; fps: number } | null {
  const s = C.session;
  if (!s?.scr || !s.share) return null;
  const st = s.scr.getSettings();
  return {
    opts: s.share,
    surface: (st as { displaySurface?: string }).displaySurface ?? '',
    width: st.width ?? 0,
    height: st.height ?? 0,
    fps: Math.round(st.frameRate ?? 0),
  };
}

function stopScreen(s: Session): void {
  s.scr?.stop();
  s.scrAudio?.stop();
  s.scr = null;
  s.scrAudio = null;
  s.share = null;
  s.flags.screen = false;
  setTrack(s, SCR, null);
  setTrack(s, SCR_AUDIO, null);
  stateChanged(s);
}

/** Сменить микрофон или камеру на лету. Если выбранное устройство не открылось, остаётся прежнее. */
export async function useDevice(kind: 'mic' | 'cam' | 'out', deviceId: string): Promise<void> {
  const id = deviceId || null;
  const prev = cfg[kind];
  const save = (v: string | null) => { cfg[kind] = v; lsSet(`skam:call:${kind}`, v); };
  save(id);
  const s = C.session;
  if (kind === 'out') {
    s?.peers.forEach((p) => setSink(p, deviceId));
    return;
  }
  const fail = (e: unknown) => {
    save(prev);
    notice(gone(e) ? 'Это устройство сейчас недоступно — осталось прежнее.' : mediaError(e, kind === 'mic' ? 'mic' : 'cam') || 'Не получилось переключить устройство.');
    emit('call');
  };
  try {
    if (kind === 'mic') {
      const m = s?.pipe ?? null;
      if (s && m) {
        const raw = await getRawMic(id, false);
        if (C.session !== s || s.pipe !== m) { raw.stop(); return; }
        replaceRaw(s, m, raw);
      } else if (s) {
        await retryMic(s);
      }
      // Микрофон, который сейчас слушает проверка в настройках, переключается вместе со звонком.
      for (const t of [...mics]) {
        if (!t.dead && t !== s?.pipe) swapRaw(t, await getRawMic(id, false));
      }
    } else if (s?.cam) {
      const t = await getCam(id, false);
      if (C.session !== s) { t.stop(); return; }
      s.cam.stop();
      s.cam = t;
      t.addEventListener('ended', () => { if (s.cam === t) { s.cam = null; s.flags.camera = false; setTrack(s, CAM, null); stateChanged(s); } });
      setTrack(s, CAM, t);
    }
    emit('call');
  } catch (e) {
    fail(e);
  }
}

/** Шумоподавление, эхоподавление и автоусиление браузера. */
export async function setAudioFlag(flag: 'ns' | 'ec' | 'agc', on: boolean): Promise<void> {
  cfg[flag] = on;
  lsSet(`skam:call:${flag}`, on ? null : '0');
  const c = micConstraints();
  for (const m of mics) await m.raw.applyConstraints({ echoCancellation: c.echoCancellation, noiseSuppression: c.noiseSuppression, autoGainControl: c.autoGainControl }).catch(() => {});
}

export function setNoiseSuppression(on: boolean): Promise<void> {
  return setAudioFlag('ns', on);
}

function setSink(p: Peer, deviceId: string | null): void {
  const set = (a: HTMLAudioElement) => (a as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> })
    .setSinkId?.(deviceId || '').catch(() => {});
  set(p.audio);
  set(p.audio2);
}

function localTracks(s: Session): (MediaStreamTrack | null)[] {
  return [s.mic, s.cam, s.scr, s.scrAudio];
}

function setTrack(s: Session, idx: number, track: MediaStreamTrack | null): void {
  s.peers.forEach((p) => {
    const tr = p.pc.getTransceivers()[idx];
    if (tr && tr.currentDirection !== 'stopped') void tr.sender.replaceTrack(track).catch(() => {});
  });
  tune(s);
}

/** Битрейт показа экрана при 1 зрителе, бит/с. */
const SHARE_BPS: Record<ShareRes, Record<ShareFps, number>> = {
  '720': { 15: 900_000, 30: 1_500_000, 60: 2_500_000 },
  '1080': { 15: 1_800_000, 30: 3_000_000, 60: 4_500_000 },
  src: { 15: 2_500_000, 30: 4_000_000, 60: 6_000_000 },
};

/** Во сколько раз урезать битрейт, когда зрителей много: своё видео мы отправляем каждому отдельно. */
function crowd(n: number): number {
  return n <= 1 ? 1 : n === 2 ? 0.8 : n === 3 ? 0.65 : n === 4 ? 0.5 : n === 5 ? 0.42 : n === 6 ? 0.36 : 0.3;
}

type Enc = { maxBitrate?: number; maxFramerate?: number; scaleResolutionDownBy?: number };

/** Потолки для камеры и экрана: чем больше людей в звонке, тем меньше каждому (соединения «каждый с каждым»). */
export function plan(share: ShareOpts | null, scrWidth: number, n: number): { cam: Enc; scr: Enc } {
  const k = Math.max(1, n);
  const cam: Enc = {
    maxBitrate: k <= 1 ? 1_200_000 : k <= 3 ? 600_000 : k <= 5 ? 350_000 : 250_000,
    maxFramerate: k >= 4 ? 24 : 30,
    scaleResolutionDownBy: k >= 6 ? 2 : k >= 4 ? 1.5 : 1,
  };
  const o = share ?? { res: '1080' as ShareRes, fps: 30 as ShareFps, audio: false };
  const target = SHARE_SIZE[o.res][0];
  const scr: Enc = {
    maxBitrate: Math.max(400_000, Math.round(SHARE_BPS[o.res][o.fps] * crowd(k))),
    maxFramerate: o.fps,
    scaleResolutionDownBy: scrWidth > target * 1.02 ? Math.round((scrWidth / target) * 100) / 100 : 1,
  };
  return { cam, scr };
}

function tune(s: Session): void {
  const w = s.scr?.getSettings().width ?? 0;
  const { cam, scr } = plan(s.share, w, s.peers.size);
  s.peers.forEach((p) => {
    if (p.state !== 'connected') return;
    const trs = p.pc.getTransceivers();
    void setEnc(trs[CAM]?.sender, cam);
    void setEnc(trs[SCR]?.sender, scr);
  });
}

async function setEnc(sender: RTCRtpSender | undefined, want: Enc): Promise<void> {
  if (!sender) return;
  try {
    const prm = sender.getParameters();
    const e = prm.encodings?.[0];
    if (!e) return;
    let changed = false;
    for (const k of Object.keys(want) as (keyof Enc)[]) {
      const v = want[k];
      if (v !== undefined && e[k] !== v) { e[k] = v; changed = true; }
    }
    if (changed) await sender.setParameters(prm);
  } catch { /* браузер не умеет — не страшно */ }
}

// ---------------------------------------------------------------------------
// Микрофон: громкость, «ворота» по чувствительности, рация
// ---------------------------------------------------------------------------

/** Все живые микрофоны: в звонке и в проверке из настроек. */
const mics = new Set<Mic>();

/** Шкала чувствительности 0–100 → громкость (RMS). Ползунок и полоска уровня стоят на одной шкале. */
export function sensToRms(v: number): number {
  const x = Math.max(0, Math.min(100, v)) / 100;
  return 0.004 + x * x * 0.16;
}

export function rmsToSens(rms: number): number {
  return Math.min(100, Math.sqrt(Math.max(0, (rms - 0.004) / 0.16)) * 100);
}

/** Порог голоса сейчас: заданный вручную или подобранный по шуму в комнате. */
export function threshold(m: Mic | null): number {
  if (cfg.sens !== null) return sensToRms(cfg.sens);
  const f = m?.floor ?? 0.004;
  return Math.min(0.08, Math.max(0.012, f * 2.2 + 0.006));
}

const ptt = { down: false, upAt: 0 };

let micCtx: AudioContext | null = null;

/**
 * Свой AudioContext для микрофона. Общий (со звонками и гудками) привязан к динамикам: стоит наушникам
 * переключить профиль (Bluetooth уходит в режим гарнитуры) — и звук, который уходит собеседникам, ломается
 * вместе с ним. Здесь, где браузер умеет, звук считается без устройства вывода вообще.
 */
function micContext(): AudioContext | null {
  try {
    if (micCtx && micCtx.state !== 'closed') return micCtx;
    micCtx = null;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return snd.audioContext();
    const tries: Record<string, unknown>[] = [
      { latencyHint: 'interactive', sampleRate: 48000, sinkId: { type: 'none' } },
      { latencyHint: 'interactive', sampleRate: 48000 },
      { latencyHint: 'interactive' },
      {},
    ];
    for (const o of tries) {
      try { micCtx = new Ctor(o as AudioContextOptions); break; } catch { /* браузер не знает этих настроек */ }
    }
    return micCtx ?? snd.audioContext();
  } catch {
    return snd.audioContext();
  }
}

/** Что за устройство открылось на самом деле. */
function noteDevice(m: Mic): void {
  const st = m.raw.getSettings();
  m.label = m.raw.label || '';
  m.devId = st.deviceId ?? '';
  m.rate = st.sampleRate ?? 0;
  m.hushAt = 0;
}

/** Собрать цепочку звука из m.raw: устройство → громкость → задержка → ворота → дорожка (или напрямую). */
function buildMic(m: Mic): void {
  m.ctx = null; m.src = null; m.gain = null; m.an = null; m.delay = null; m.gate = null; m.dst = null; m.buf = null;
  m.out = m.raw;
  m.direct = true;
  m.open = true;
  const c = micContext();
  if (!c) return;
  try {
    const src = c.createMediaStreamSource(new MediaStream([m.raw]));
    const an = c.createAnalyser();
    an.fftSize = 1024;
    an.smoothingTimeConstant = 0;
    m.ctx = c; m.src = src; m.an = an;
    m.buf = new Float32Array(an.fftSize);
    if (cfg.direct) {
      src.connect(an);
      // Анализатору нужен приёмник, иначе браузер его не считает; в никуда, звука на выходе нет.
      const sink = c.createMediaStreamDestination();
      an.connect(sink);
      m.dst = sink;
      // Уходит копия дорожки: ворота её выключают, а слушать голос мы должны и при закрытых воротах.
      m.out = m.raw.clone();
    } else {
      const gain = c.createGain();
      gain.gain.value = cfg.gain / 100;
      // Звук чуть задержан (30 мс), чтобы ворота успели открыться до первого слога.
      const delay = c.createDelay(0.1);
      delay.delayTime.value = 0.03;
      const gate = c.createGain();
      const dst = c.createMediaStreamDestination();
      src.connect(gain);
      gain.connect(an);
      gain.connect(delay);
      delay.connect(gate);
      gate.connect(dst);
      m.gain = gain; m.delay = delay; m.gate = gate; m.dst = dst;
      m.out = dst.stream.getAudioTracks()[0];
      m.direct = false;
    }
    m.timer = window.setInterval(() => micTick(m), 25);
  } catch {
    // без обработки — звук уйдёт как есть
    m.ctx = null; m.src = null; m.gain = null; m.an = null; m.delay = null; m.gate = null; m.dst = null; m.buf = null;
    m.out = m.raw;
    m.direct = true;
  }
  if (m.monOn) hear(m);
}

/** Разобрать цепочку (устройство не трогаем). */
function unbuildMic(m: Mic): void {
  clearInterval(m.timer);
  try { m.src?.disconnect(); m.gain?.disconnect(); m.delay?.disconnect(); m.gate?.disconnect(); m.an?.disconnect(); } catch { /* уже */ }
  try { m.monSrc?.disconnect(); } catch { /* уже */ }
  m.monSrc = null;
  if (m.out !== m.raw) m.out.stop();
}

function makeMic(raw: MediaStreamTrack): Mic {
  const m: Mic = {
    raw, out: raw, ctx: null, src: null, gain: null, an: null, delay: null, gate: null, dst: null, monitor: null, monSrc: null, monOn: false,
    buf: null, direct: true, label: '', devId: '', rate: 0, born: Date.now(), hushAt: 0,
    open: true, voiceAt: 0, lvl: 0, floor: 0.004, mins: [], winMin: 1, winAt: Date.now(), timer: 0, dead: false,
  };
  noteDevice(m);
  buildMic(m);
  mics.add(m);
  return m;
}

function micTick(m: Mic): void {
  if (m.dead || !m.an || !m.buf || !m.ctx) return;
  if (m.ctx.state === 'suspended') void m.ctx.resume().catch(() => {});
  m.an.getFloatTimeDomainData(m.buf);
  let sum = 0;
  for (let i = 0; i < m.buf.length; i++) sum += m.buf[i] * m.buf[i];
  const lvl = Math.sqrt(sum / m.buf.length);
  m.lvl = lvl;
  const now = Date.now();
  // Шум комнаты — самое тихое за последние ~6 секунд.
  m.winMin = Math.min(m.winMin, lvl);
  if (now - m.winAt > 1000) {
    m.mins.push(m.winMin);
    if (m.mins.length > 6) m.mins.shift();
    m.floor = Math.max(0.001, Math.min(...m.mins));
    m.winMin = 1;
    m.winAt = now;
  }
  // Полная тишина дольше нескольких секунд — микрофон ничего не слышит.
  if (lvl > 0.0006) m.hushAt = 0;
  else if (!m.hushAt) m.hushAt = now;
  let open: boolean;
  if (cfg.mode === 'ptt') {
    open = ptt.down || now - ptt.upAt < 150;
  } else if (document.hidden) {
    open = true; // в фоновой вкладке таймеры замедляются — лучше не обрезать голос
  } else {
    if (lvl > threshold(m)) m.voiceAt = now;
    open = now - m.voiceAt < 350;
  }
  if (m.direct) {
    // Уходит копия дорожки устройства: ворота — это её «включена»; «выключить микрофон» тоже она.
    const muted = !!C.session && C.session.pipe === m && C.session.flags.muted;
    m.out.enabled = open && !muted;
    m.open = open;
  } else if (open !== m.open && m.gate) {
    m.open = open;
    m.gate.gain.setTargetAtTime(open ? 1 : 0, m.ctx.currentTime, open ? 0.006 : 0.03);
  }
}

function dropMic(m: Mic): void {
  if (m.dead) return;
  m.dead = true;
  unbuildMic(m);
  try { m.monitor?.disconnect(); } catch { /* уже */ }
  mics.delete(m);
  m.raw.stop();
  m.out.stop();
}

/** Микрофон тихий или молчит — для подсказки в настройках. */
export function micProblem(m: Mic | null): string {
  if (!m || m.dead) return '';
  if (m.raw.readyState !== 'live') return 'Микрофон отключился.';
  if (m.raw.muted) return 'Браузер не получает звук с этого микрофона. Проверьте, что он включён и не выключен кнопкой на гарнитуре.';
  if (m.hushAt && (cfg.gain > 0 || m.direct) && Date.now() - m.hushAt > 4000) return 'С этого микрофона идёт полная тишина — он выключен или не подключён. Выберите другой в списке.';
  return '';
}

/** Какое устройство и в каком режиме работает. */
export function micInfo(m: Mic | null): { label: string; rate: number; direct: boolean } | null {
  if (!m || m.dead) return null;
  return { label: m.label, rate: m.rate, direct: m.direct };
}

/** Подставить другое устройство под тот же исходящий поток. true — исходящая дорожка сменилась (обработки нет). */
function swapRaw(m: Mic, raw: MediaStreamTrack): boolean {
  const old = m.raw;
  m.raw = raw;
  old.stop();
  noteDevice(m);
  if (m.ctx && m.src && (m.direct ? m.an : m.gain)) {
    try { m.src.disconnect(); } catch { /* уже */ }
    m.src = m.ctx.createMediaStreamSource(new MediaStream([raw]));
    m.src.connect((m.direct ? m.an : m.gain)!);
  }
  if (m.direct) {
    const prevOut = m.out;
    m.out = m.ctx ? raw.clone() : raw;
    if (prevOut !== old) prevOut.stop();
    if (m.monOn) hear(m);
    return true;
  }
  return false;
}

/** Передавать звук напрямую (без Web Audio) или через обработку. Меняется на лету, в том числе в звонке. */
export function setDirect(on: boolean): void {
  if (cfg.direct === on) return;
  cfg.direct = on;
  lsSet('skam:call:direct', on ? '1' : null);
  const s = C.session;
  for (const m of [...mics]) {
    if (m.dead) continue;
    const prev = m.out;
    unbuildMic(m);
    // Старая дорожка обработки сама остановилась в unbuild; устройство продолжает работать.
    buildMic(m);
    m.mins = []; m.floor = 0.004; m.winMin = 1; m.winAt = Date.now();
    if (s && s.pipe === m && m.out !== prev) {
      s.mic = m.out;
      m.out.enabled = !s.flags.muted;
      setTrack(s, MIC, m.out);
    }
  }
  emit('call');
}

function replaceRaw(s: Session, m: Mic, raw: MediaStreamTrack): void {
  if (swapRaw(m, raw)) {
    s.mic = m.out;
    m.out.enabled = !s.flags.muted;
    setTrack(s, MIC, m.out);
  }
  watchMic(s, m);
}

/** Устройство отключили: переходим на микрофон по умолчанию. */
function watchMic(s: Session, m: Mic): void {
  const raw = m.raw;
  raw.addEventListener('ended', () => {
    if (C.session === s && s.pipe === m && m.raw === raw && !m.dead) void micLost(s, m);
  });
}

async function micLost(s: Session, m: Mic): Promise<void> {
  try {
    const raw = await getRawMic(null);
    if (C.session !== s || s.pipe !== m) { raw.stop(); return; }
    replaceRaw(s, m, raw);
    notice('Микрофон отключился — переключились на микрофон по умолчанию.');
    emit('call');
  } catch {
    if (C.session !== s || s.pipe !== m) return;
    dropMic(m);
    s.pipe = null;
    s.mic = null;
    setTrack(s, MIC, null);
    s.flags.muted = true;
    notice('Микрофон отключился. Нажмите на значок микрофона, когда подключите другой.');
    stateChanged(s);
  }
}

/** Микрофон звонка (если мы в звонке). */
export function activeMic(): Mic | null {
  return C.session?.pipe ?? null;
}

/** Камера для предпросмотра в настройках (вызывающий сам остановит дорожки). */
export async function openCamPreview(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ video: camConstraints() });
}

/** Микрофон для проверки в настройках — вне звонка. */
export async function openTestMic(): Promise<Mic> {
  return makeMic(await getRawMic());
}

export function closeTestMic(m: Mic): void {
  if (m !== C.session?.pipe) dropMic(m);
}

/** Слышать себя в наушниках (проверка микрофона): берём то, что уходит собеседникам. */
export function monitorMic(m: Mic, on: boolean): void {
  m.monOn = on;
  if (on) hear(m);
  else if (m.monitor) m.monitor.gain.value = 0;
}

function hear(m: Mic): void {
  const c = snd.audioContext();
  if (!c) return;
  try {
    m.monSrc?.disconnect();
    if (!m.monitor) {
      m.monitor = c.createGain();
      m.monitor.connect(c.destination);
    }
    m.monSrc = c.createMediaStreamSource(new MediaStream([m.out]));
    m.monSrc.connect(m.monitor);
    m.monitor.gain.value = 1;
  } catch { /* не получилось — не слышим */ }
}

export function setInputMode(mode: InputMode): void {
  cfg.mode = mode;
  lsSet('skam:call:mode', mode === 'ptt' ? 'ptt' : null);
  if (mode !== 'ptt') ptt.down = false;
  emit('call');
}

export function setPttKey(code: string): void {
  cfg.ptt = code;
  lsSet('skam:call:ptt', code === 'KeyV' ? null : code);
  ptt.down = false;
  emit('call');
}

/** Чувствительность: null — подбирать самой, число 0–100 — порог вручную. */
export function setSensitivity(v: number | null): void {
  cfg.sens = v === null ? null : Math.round(Math.max(0, Math.min(100, v)));
  lsSet('skam:call:sens', cfg.sens === null ? null : String(cfg.sens));
}

/** Громкость микрофона, %. */
export function setMicGain(percent: number): void {
  cfg.gain = Math.round(Math.max(0, Math.min(200, percent)));
  lsSet('skam:call:gain', cfg.gain === 100 ? null : String(cfg.gain));
  mics.forEach((m) => { if (m.gain) m.gain.gain.value = cfg.gain / 100; });
}

/** Рация нажата прямо сейчас. */
export function pttHeld(): boolean {
  return ptt.down;
}

/** Как называется клавиша: «V», «Пробел», «Левый Ctrl». */
export function keyName(code: string): string {
  const names: Record<string, string> = {
    Space: 'Пробел', Backquote: '` (Ё)', Tab: 'Tab', CapsLock: 'Caps Lock', ControlLeft: 'Левый Ctrl', ControlRight: 'Правый Ctrl',
    ShiftLeft: 'Левый Shift', ShiftRight: 'Правый Shift', AltLeft: 'Левый Alt', AltRight: 'Правый Alt', Enter: 'Enter',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
  };
  if (names[code]) return names[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad/.test(code)) return `Num ${code.slice(6)}`;
  return code;
}

function isTyping(t: EventTarget | null): boolean {
  const e = t as HTMLElement | null;
  return !!e && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.tagName === 'SELECT' || e.isContentEditable);
}

const MODIFIERS = /^(Control|Shift|Alt|Meta)(Left|Right)$/;

function onPttKey(ev: KeyboardEvent, down: boolean): void {
  if (cfg.mode !== 'ptt' || ev.code !== cfg.ptt) return;
  if (down) {
    if (ev.repeat || ptt.down) return;
    if (!C.session && !mics.size) return;
    // Печатаете сообщение — клавиша должна печатать, а не включать микрофон.
    if (ev.key.length === 1 && isTyping(ev.target)) return;
    if (!MODIFIERS.test(ev.code) && (ev.ctrlKey || ev.metaKey || ev.altKey)) return;
    ptt.down = true;
  } else {
    if (!ptt.down) return;
    ptt.down = false;
    ptt.upAt = Date.now();
  }
  emit('call');
  pttFns.forEach((f) => f());
}

const pttFns = new Set<() => void>();
/** Рацию нажали или отпустили. */
export function onPtt(fn: () => void): () => void {
  pttFns.add(fn);
  return () => pttFns.delete(fn);
}

function releasePtt(): void {
  if (!ptt.down) return;
  ptt.down = false;
  ptt.upAt = Date.now();
  pttFns.forEach((f) => f());
  emit('call');
}

const onKeyDown = (ev: KeyboardEvent) => onPttKey(ev, true);
const onKeyUp = (ev: KeyboardEvent) => onPttKey(ev, false);

function watchKeys(on: boolean): void {
  if (on) {
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', releasePtt);
  } else {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('blur', releasePtt);
  }
}

// ---------------------------------------------------------------------------
// Громкость голосов: кто сейчас говорит (зелёная рамка, как в Discord)
// ---------------------------------------------------------------------------

function meter(stream: MediaStream): Meter | null {
  const c = snd.audioContext();
  if (!c) return null;
  try {
    const src = c.createMediaStreamSource(stream);
    const an = c.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    return { an, src, buf: new Float32Array(an.fftSize) };
  } catch {
    return null;
  }
}

function dropMeter(m: Meter | null): void {
  try { m?.src.disconnect(); } catch { /* уже */ }
}

function level(m: Meter | null): number {
  if (!m) return 0;
  m.an.getFloatTimeDomainData(m.buf);
  let sum = 0;
  for (let i = 0; i < m.buf.length; i++) sum += m.buf[i] * m.buf[i];
  return Math.sqrt(sum / m.buf.length);
}

function measureSpeaking(s: Session): void {
  if (C.session !== s) return;
  const now = Date.now();
  let changed = false;
  const upd = (cur: boolean, lvl: number, loudAt: number, set: (v: boolean, at: number) => void, thr = 0.03) => {
    const loud = lvl > thr;
    const at = loud ? now : loudAt;
    const v = loud || (cur && now - at < 350);
    if (v !== cur) changed = true;
    set(v, at);
  };
  // Себя считаем говорящим, когда ворота открыты (голос выше порога или нажата рация) и есть звук.
  const mine = s.pipe && !s.flags.muted && s.pipe.open ? s.pipe.lvl : 0;
  upd(s.speaking, mine, s.loudAt, (v, at) => { s.speaking = v; s.loudAt = at; }, 0.012);
  s.peers.forEach((p) => {
    const muted = p.flags?.muted ?? false;
    upd(p.speaking, muted ? 0 : level(p.meter), p.loudAt, (v, at) => { p.speaking = v; p.loudAt = at; });
  });
  if (changed) speakFns.forEach((fn) => fn());
}

async function measureRtt(s: Session): Promise<void> {
  const p = [...s.peers.values()].find((x) => x.state === 'connected');
  if (!p) { C.rtt = null; return; }
  try {
    const stats = await p.pc.getStats();
    let rtt: number | null = null;
    stats.forEach((r) => {
      const x = r as { type: string; state?: string; nominated?: boolean; currentRoundTripTime?: number };
      if (x.type === 'candidate-pair' && x.state === 'succeeded' && x.nominated && typeof x.currentRoundTripTime === 'number') {
        rtt = Math.round(x.currentRoundTripTime * 1000);
      }
    });
    C.rtt = rtt;
  } catch { /* соединение закрыли */ }
}

// ---------------------------------------------------------------------------
// Соединения с участниками
// ---------------------------------------------------------------------------

function iceServers(): RTCIceServer[] {
  const list: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  const turn = import.meta.env.VITE_TURN_URL;
  if (turn) {
    list.push({
      urls: turn.split(',').map((x) => x.trim()).filter(Boolean),
      username: import.meta.env.VITE_TURN_USERNAME,
      credential: import.meta.env.VITE_TURN_CREDENTIAL,
    });
  }
  return list;
}

let audioBox: HTMLElement | null = null;
function audioEl(): HTMLAudioElement {
  if (!audioBox || !audioBox.isConnected) {
    audioBox = document.createElement('div');
    audioBox.hidden = true;
    audioBox.id = 'callAudio';
    document.body.append(audioBox);
  }
  const a = document.createElement('audio');
  a.autoplay = true;
  audioBox.append(a);
  return a;
}

function newPeer(s: Session, uid: string, offerer: boolean, sid: string): Peer {
  const pc = new RTCPeerConnection({ iceServers: iceServers(), bundlePolicy: 'max-bundle' });
  // Канал данных договорён заранее (одинаковый id у обоих) — сразу входит в первое предложение.
  const dc = pc.createDataChannel('skam-state', { negotiated: true, id: 0 });
  const p: Peer = {
    uid, pc, sid, offerer, dc, ice: [], out: [], ready: false, state: 'connecting', since: Date.now(), fixAt: 0,
    flags: null, voice: null, cam: null, scr: null, audio: audioEl(), audio2: audioEl(), meter: null, speaking: false, loudAt: 0,
  };
  applyVolumes(p);
  p.audio.muted = s.flags.deafened;
  p.audio2.muted = s.flags.deafened;
  if (cfg.out) setSink(p, cfg.out);
  if (offerer) {
    const tracks = localTracks(s);
    KINDS.forEach((kind, i) => pc.addTransceiver(tracks[i] ?? kind, { direction: 'sendrecv' }));
  }
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    p.out.push(e.candidate.toJSON());
    flushIce(s, p);
  };
  pc.ontrack = (e) => onTrack(p, e);
  pc.onconnectionstatechange = () => onConn(s, p);
  dc.onopen = () => { try { dc.send(JSON.stringify({ t: 'st', ...s.flags })); } catch { /* закрылся */ } };
  dc.onmessage = (e) => onData(p, e.data);
  s.peers.set(uid, p);
  const early = s.early.get(`${uid}|${sid}`);
  if (early) { p.ice.push(...early); s.early.delete(`${uid}|${sid}`); }
  return p;
}

function closePeer(s: Session, p: Peer, sound: boolean): void {
  if (s.peers.get(p.uid) === p) s.peers.delete(p.uid);
  clearTimeout(p.outTimer);
  try { p.dc.close(); } catch { /* уже */ }
  try { p.pc.close(); } catch { /* уже */ }
  dropMeter(p.meter);
  p.audio.srcObject = null;
  p.audio2.srcObject = null;
  p.audio.remove();
  p.audio2.remove();
  if (sound) snd.left();
  emit('call');
}

function onTrack(p: Peer, e: RTCTrackEvent): void {
  const idx = p.pc.getTransceivers().indexOf(e.transceiver);
  const st = new MediaStream([e.track]);
  if (idx === MIC) {
    p.voice = st;
    p.audio.srcObject = st;
    void p.audio.play().catch(() => {});
    dropMeter(p.meter);
    p.meter = meter(st);
  } else if (idx === CAM) {
    p.cam = st;
  } else if (idx === SCR) {
    p.scr = st;
  } else if (idx === SCR_AUDIO) {
    p.audio2.srcObject = st;
    void p.audio2.play().catch(() => {});
  }
  emit('call');
}

function onConn(s: Session, p: Peer): void {
  if (s.peers.get(p.uid) !== p) return;
  const st = p.pc.connectionState;
  if (st === 'connected') {
    if (p.state !== 'connected') {
      p.state = 'connected';
      s.hadCompany = true;
      s.connectedAt ??= Date.now();
      tune(s);
      void p.audio.play().catch(() => {});
    }
  } else if (st === 'failed') {
    p.state = 'failed';
    fix(s, p);
  } else if (st === 'disconnected') {
    window.setTimeout(() => { if (p.pc.connectionState === 'disconnected') fix(s, p); }, 4000);
  }
  updateTones();
  emit('call');
}

/** Соединение оборвалось: перезапускаем ICE (или просим об этом того, кто предлагал соединение). */
function fix(s: Session, p: Peer): void {
  if (C.session !== s || s.peers.get(p.uid) !== p || Date.now() - p.fixAt < 8000) return;
  p.fixAt = Date.now();
  p.state = 'connecting';
  if (p.offerer) void offer(s, p.uid, p.pc.signalingState === 'stable');
  else void send(s, p.uid, { t: 'restart', sid: p.sid });
}

function onData(p: Peer, raw: unknown): void {
  if (typeof raw !== 'string' || raw.length > 500) return;
  try {
    const m = JSON.parse(raw) as Record<string, unknown>;
    if (m.t !== 'st') return;
    p.flags = { muted: !!m.muted, deafened: !!m.deafened, camera: !!m.camera, screen: !!m.screen };
    emit('call');
  } catch { /* не наше */ }
}

function flushIce(s: Session, p: Peer): void {
  if (!p.ready || p.outTimer) return;
  p.outTimer = window.setTimeout(() => {
    p.outTimer = undefined;
    const c = p.out.splice(0);
    if (c.length && s.peers.get(p.uid) === p) void send(s, p.uid, { t: 'ice', sid: p.sid, c });
  }, 120);
}

async function offer(s: Session, uid: string, restart = false): Promise<void> {
  if (C.session !== s) return;
  let p = s.peers.get(uid);
  if (!p || !restart || !p.offerer) {
    if (p) closePeer(s, p, false);
    p = newPeer(s, uid, true, uuid());
  }
  try {
    const o = await p.pc.createOffer(restart ? { iceRestart: true } : {});
    await p.pc.setLocalDescription(o);
    await send(s, uid, { t: 'offer', sid: p.sid, sdp: p.pc.localDescription?.sdp ?? o.sdp ?? '' });
    p.ready = true;
    flushIce(s, p);
  } catch {
    p.state = 'failed';
  }
}

async function answerOffer(s: Session, from: string, sid: string, sdp: string): Promise<void> {
  let p = s.peers.get(from);
  if (p && p.sid === sid) {
    // Повторные переговоры в том же соединении (перезапуск ICE).
    await p.pc.setRemoteDescription({ type: 'offer', sdp });
  } else {
    if (p) {
      const polite = meId() > from;
      const collision = p.offerer && p.state !== 'connected';
      // Предложили друг другу одновременно: «невежливый» ждёт ответа на своё.
      if (collision && !polite) return;
      closePeer(s, p, false);
    }
    p = newPeer(s, from, false, sid);
    await p.pc.setRemoteDescription({ type: 'offer', sdp });
    const tracks = localTracks(s);
    const trs = p.pc.getTransceivers();
    for (let i = 0; i < trs.length && i < KINDS.length; i++) {
      trs[i].direction = 'sendrecv';
      await trs[i].sender.replaceTrack(tracks[i]).catch(() => {});
    }
  }
  const ans = await p.pc.createAnswer();
  await p.pc.setLocalDescription(ans);
  await addQueuedIce(p);
  await send(s, from, { t: 'answer', sid, sdp: p.pc.localDescription?.sdp ?? ans.sdp ?? '' });
  p.ready = true;
  flushIce(s, p);
}

async function addQueuedIce(p: Peer): Promise<void> {
  const list = p.ice.splice(0);
  for (const c of list) await p.pc.addIceCandidate(c).catch(() => {});
}

type Signal =
  | { t: 'offer' | 'answer'; sid: string; sdp: string }
  | { t: 'ice'; sid: string; c: RTCIceCandidateInit[] }
  | { t: 'restart'; sid: string }
  | { t: 'bye' };

function parseSignal(v: unknown): Signal | null {
  const m = v as Record<string, unknown> | null;
  if (!m || typeof m !== 'object') return null;
  const sidOk = typeof m.sid === 'string' && m.sid.length <= 64;
  if ((m.t === 'offer' || m.t === 'answer') && sidOk && typeof m.sdp === 'string' && m.sdp.length < 30_000) {
    return { t: m.t, sid: m.sid as string, sdp: m.sdp };
  }
  if (m.t === 'ice' && sidOk && Array.isArray(m.c)) {
    const c = m.c.slice(0, 60).filter((x): x is RTCIceCandidateInit =>
      !!x && typeof x === 'object' && typeof (x as RTCIceCandidateInit).candidate === 'string');
    return { t: 'ice', sid: m.sid as string, c };
  }
  if (m.t === 'restart' && sidOk) return { t: 'restart', sid: m.sid as string };
  if (m.t === 'bye') return { t: 'bye' };
  return null;
}

async function send(s: Session, to: string, msg: Signal): Promise<void> {
  if (C.session !== s && msg.t !== 'bye') return;
  const payload = await e2e.sealSignal(s.key, s.callId, to, msg);
  await sb.from('call_signals').insert({ call_id: s.callId, to_user: to, payload });
}

function takeSignals(rows: CallSignal[]): void {
  const s = C.session;
  if (!s) {
    // Не в звонке: свежие не трогаем (может, мы как раз входим — их подберёт первый опрос),
    // а старые, из закончившихся звонков, удаляем.
    const old = rows.filter((r) => serverNow() - Date.parse(r.created_at) > 60_000).map((r) => r.id);
    if (old.length) sb.from('call_signals').delete().in('id', old).then(() => {}, () => {});
    return;
  }
  const fresh = rows.filter((r) => !s.processed.has(r.id));
  fresh.sort((a, b) => a.id - b.id).forEach((r) => {
    s.processed.add(r.id);
    s.chain = s.chain.then(() => handleSignal(s, r)).catch(() => {});
  });
  // Прочитанное удаляем (и чужое из закончившихся звонков — тоже).
  const ids = fresh.map((r) => r.id);
  if (ids.length) sb.from('call_signals').delete().in('id', ids).then(() => {}, () => {});
}

async function handleSignal(s: Session, r: CallSignal): Promise<void> {
  if (C.session !== s || r.call_id !== s.callId || r.from_user === meId()) return;
  let msg: Signal | null;
  try {
    msg = parseSignal(await e2e.openSignal(r.payload, s.chatId, s.callId, r.from_user));
  } catch {
    if (!s.warnedKey) {
      s.warnedKey = true;
      notice('Не удалось установить защищённое соединение: ключ шифрования этого чата ещё не дошёл до собеседника.');
      e2e.sweepSoon(0);
    }
    return;
  }
  if (!msg) return;
  const from = r.from_user;
  const p = s.peers.get(from);
  switch (msg.t) {
    case 'offer':
      await answerOffer(s, from, msg.sid, msg.sdp);
      break;
    case 'answer':
      if (p && p.sid === msg.sid && p.offerer && p.pc.signalingState === 'have-local-offer') {
        await p.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
        await addQueuedIce(p);
      }
      break;
    case 'ice':
      if (p && p.sid === msg.sid) {
        if (p.pc.remoteDescription) for (const c of msg.c) await p.pc.addIceCandidate(c).catch(() => {});
        else p.ice.push(...msg.c);
      } else {
        // Кандидаты обогнали предложение соединения — придержим.
        const k = `${from}|${msg.sid}`;
        s.early.set(k, [...(s.early.get(k) ?? []), ...msg.c].slice(-100));
      }
      break;
    case 'restart':
      if (p && p.sid === msg.sid) void offer(s, from, p.offerer && p.pc.signalingState === 'stable');
      break;
    case 'bye':
      if (p) closePeer(s, p, true);
      s.firstSeen.delete(from);
      refreshSoon(300);
      break;
  }
}

/** Раз в 2 секунды: соединиться с новыми участниками, закрыть ушедших, не сидеть одному. */
function reconcile(s: Session): void {
  if (C.session !== s) return;
  const c = C.active.get(s.callId);
  if (!c) return;
  const mine = c.members.find((m) => m.user_id === meId());
  const myJoin = mine?.state === 'in' && mine.joined_at ? Date.parse(mine.joined_at) : Infinity;
  const now = Date.now();
  const here = new Set<string>();
  for (const m of c.members) {
    if (m.state !== 'in' || m.user_id === meId()) continue;
    here.add(m.user_id);
    if (!s.firstSeen.has(m.user_id)) s.firstSeen.set(m.user_id, now);
    const p = s.peers.get(m.user_id);
    if (!p) {
      // Новичок предлагает соединение тем, кто уже был; если предложения всё нет — предложим сами.
      const theirJoin = m.joined_at ? Date.parse(m.joined_at) : 0;
      if (theirJoin <= myJoin || now - s.firstSeen.get(m.user_id)! > 7000) void offer(s, m.user_id);
    } else if (p.state !== 'connected' && now - p.since > 25_000 && now - p.fixAt > 15_000) {
      // Долго не соединяется — начинаем заново.
      p.fixAt = now;
      if (p.offerer || meId() < m.user_id) void offer(s, m.user_id);
    }
  }
  for (const p of [...s.peers.values()]) {
    if (!here.has(p.uid)) { closePeer(s, p, false); s.firstSeen.delete(p.uid); }
  }
  if (here.size) {
    s.aloneSince = null;
  } else if (s.hadCompany || c.answered_at || now - s.startedAt > RING_MS) {
    s.aloneSince ??= now;
    if (now - s.aloneSince > ALONE_MS) {
      notice('Вы были одни в звонке — отключились');
      void hangup(true);
    }
  }
}

// ---------------------------------------------------------------------------
// Закрыли вкладку — выходим из звонка сразу, а не через 40 секунд
// ---------------------------------------------------------------------------

function onPageHide(): void {
  const s = C.session;
  if (!s?.lastToken) return;
  try {
    void fetch(`${SUPABASE_URL}/rest/v1/rpc/call_leave`, {
      method: 'POST',
      keepalive: true,
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${s.lastToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_call: s.callId, p_device: DEVICE }),
    });
  } catch { /* не успели — пульс истечёт сам */ }
}

// Для отладки и проверок.
export const debug = { DEVICE };
