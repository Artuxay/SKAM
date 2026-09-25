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
  cam: MediaStreamTrack | null;
  scr: MediaStreamTrack | null;
  scrAudio: MediaStreamTrack | null;
  flags: Flags;
  mutedBeforeDeafen: boolean;
  peers: Map<string, Peer>;
  firstSeen: Map<string, number>;
  early: Map<string, RTCIceCandidateInit[]>;
  startedAt: number;
  connectedAt: number | null;
  hadCompany: boolean;
  aloneSince: number | null;
  meter: Meter | null;
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
// Настройки: устройства, громкость, шумоподавление
// ---------------------------------------------------------------------------

const pref = {
  mic: () => lsGet('skam:call:mic'),
  cam: () => lsGet('skam:call:cam'),
  out: () => lsGet('skam:call:out'),
  ns: () => lsGet('skam:call:ns') !== '0',
};

export function noiseSuppression(): boolean {
  return pref.ns();
}

function micConstraints(deviceId = pref.mic()): MediaTrackConstraints {
  const ns = pref.ns();
  return {
    deviceId: deviceId ? { ideal: deviceId } : undefined,
    echoCancellation: true,
    noiseSuppression: ns,
    autoGainControl: true,
  };
}

function camConstraints(deviceId = pref.cam()): MediaTrackConstraints {
  return {
    deviceId: deviceId ? { ideal: deviceId } : undefined,
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 24, max: 30 },
  };
}

function volumeOf(uid: string): number {
  const v = Number(lsGet(`skam:call:vol:${uid}`));
  return Number.isFinite(v) && v > 0 ? Math.min(1, v) : 1;
}

export function peerVolume(uid: string): number {
  return volumeOf(uid);
}

/** Громкость собеседника (0–100 %), запоминается. */
export function setPeerVolume(uid: string, v: number): void {
  const vol = Math.max(0, Math.min(1, v));
  lsSet(`skam:call:vol:${uid}`, vol >= 0.999 ? null : String(vol || 0.0001));
  const p = C.session?.peers.get(uid);
  if (p) { p.audio.volume = vol; p.audio2.volume = vol; }
}

export type DeviceList = { mics: MediaDeviceInfo[]; cams: MediaDeviceInfo[]; outs: MediaDeviceInfo[] };

export async function listDevices(): Promise<DeviceList> {
  const all = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
  return {
    mics: all.filter((d) => d.kind === 'audioinput'),
    cams: all.filter((d) => d.kind === 'videoinput'),
    outs: all.filter((d) => d.kind === 'audiooutput'),
  };
}

export function chosen(): { mic: string | null; cam: string | null; out: string | null } {
  return { mic: pref.mic(), cam: pref.cam(), out: pref.out() };
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

async function getMic(deviceId?: string | null): Promise<MediaStreamTrack> {
  const st = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(deviceId ?? pref.mic()) });
  return st.getAudioTracks()[0];
}

async function getCam(deviceId?: string | null): Promise<MediaStreamTrack> {
  const st = await navigator.mediaDevices.getUserMedia({ video: camConstraints(deviceId ?? pref.cam()) });
  const t = st.getVideoTracks()[0];
  t.contentHint = 'motion';
  return t;
}

type Media = { mic: MediaStreamTrack | null; cam: MediaStreamTrack | null };

/** Микрофон (и камера): без микрофона всё равно пускаем в звонок — слушать. */
async function openMedia(video: boolean): Promise<Media> {
  if (!canCall()) throw new CallError('Этот браузер не умеет звонить. Откройте СКАМ в Chrome, Edge, Firefox или Safari.');
  let mic: MediaStreamTrack | null = null;
  let cam: MediaStreamTrack | null = null;
  try { mic = await getMic(); } catch (e) { const t = mediaError(e, 'mic'); if (t) notice(`${t} Вы в звонке без микрофона.`); }
  if (video) {
    try { cam = await getCam(); } catch (e) { const t = mediaError(e, 'cam'); if (t) notice(t); }
  }
  return { mic, cam };
}

function stopMedia(m: Media): void {
  m.mic?.stop();
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
    mic: media.mic, cam: media.cam, scr: null, scrAudio: null,
    flags: { muted: !media.mic, deafened: false, camera: !!media.cam, screen: false },
    mutedBeforeDeafen: false,
    peers: new Map(), firstSeen: new Map(), early: new Map(),
    startedAt: Date.now(), connectedAt: null, hadCompany: false, aloneSince: null,
    meter: media.mic ? meter(new MediaStream([media.mic])) : null,
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
  [s.mic, s.cam, s.scr, s.scrAudio].forEach((t) => t?.stop());
  dropMeter(s.meter);
  s.meter = null;
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
    const t = await getMic();
    if (C.session !== s) { t.stop(); return; }
    s.mic = t;
    setTrack(s, MIC, t);
    dropMeter(s.meter);
    s.meter = meter(new MediaStream([t]));
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

export async function toggleScreen(): Promise<void> {
  const s = C.session;
  if (!s) return;
  if (s.scr) { stopScreen(s); return; }
  if (!canShareScreen()) { notice('На этом устройстве показать экран нельзя — попробуйте с компьютера.'); return; }
  try {
    const st = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: true });
    if (C.session !== s) { st.getTracks().forEach((t) => t.stop()); return; }
    const v = st.getVideoTracks()[0];
    v.contentHint = 'detail';
    s.scr = v;
    s.scrAudio = st.getAudioTracks()[0] ?? null;
    s.flags.screen = true;
    // «Прекратить показ» в окне браузера.
    v.addEventListener('ended', () => { if (s.scr === v) stopScreen(s); });
    setTrack(s, SCR, v);
    setTrack(s, SCR_AUDIO, s.scrAudio);
    stateChanged(s);
  } catch (e) {
    const m = mediaError(e, 'screen');
    if (m && (e as { name?: string })?.name !== 'NotAllowedError') notice(m);
  }
}

function stopScreen(s: Session): void {
  s.scr?.stop();
  s.scrAudio?.stop();
  s.scr = null;
  s.scrAudio = null;
  s.flags.screen = false;
  setTrack(s, SCR, null);
  setTrack(s, SCR_AUDIO, null);
  stateChanged(s);
}

/** Сменить микрофон или камеру на лету. */
export async function useDevice(kind: 'mic' | 'cam' | 'out', deviceId: string): Promise<void> {
  lsSet(`skam:call:${kind}`, deviceId || null);
  const s = C.session;
  if (!s) return;
  if (kind === 'out') {
    s.peers.forEach((p) => setSink(p, deviceId));
    return;
  }
  try {
    if (kind === 'mic') {
      const t = await getMic(deviceId);
      if (C.session !== s) { t.stop(); return; }
      s.mic?.stop();
      s.mic = t;
      t.enabled = !s.flags.muted;
      setTrack(s, MIC, t);
      dropMeter(s.meter);
      s.meter = meter(new MediaStream([t]));
    } else if (s.cam) {
      const t = await getCam(deviceId);
      if (C.session !== s) { t.stop(); return; }
      s.cam.stop();
      s.cam = t;
      setTrack(s, CAM, t);
    }
    emit('call');
  } catch (e) {
    notice(mediaError(e, kind === 'mic' ? 'mic' : 'cam') || 'Не получилось переключить устройство.');
  }
}

export async function setNoiseSuppression(on: boolean): Promise<void> {
  lsSet('skam:call:ns', on ? null : '0');
  const t = C.session?.mic;
  if (t) await t.applyConstraints({ ...micConstraints(), deviceId: undefined }).catch(() => {});
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

/** Потолок битрейта: чем больше людей, тем меньше каждому (соединения «каждый с каждым»). */
function tune(s: Session): void {
  const n = Math.max(1, s.peers.size);
  const cam = n <= 1 ? 1_200_000 : n <= 3 ? 600_000 : 300_000;
  const scr = n <= 1 ? 2_500_000 : n <= 3 ? 1_500_000 : 800_000;
  s.peers.forEach((p) => {
    if (p.state !== 'connected') return;
    const trs = p.pc.getTransceivers();
    void setMax(trs[CAM]?.sender, cam);
    void setMax(trs[SCR]?.sender, scr);
  });
}

async function setMax(sender: RTCRtpSender | undefined, bps: number): Promise<void> {
  if (!sender) return;
  try {
    const prm = sender.getParameters();
    if (!prm.encodings?.length) return;
    if (prm.encodings[0].maxBitrate === bps) return;
    prm.encodings[0].maxBitrate = bps;
    await sender.setParameters(prm);
  } catch { /* браузер не умеет — не страшно */ }
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
  const upd = (cur: boolean, lvl: number, loudAt: number, set: (v: boolean, at: number) => void) => {
    const loud = lvl > 0.03;
    const at = loud ? now : loudAt;
    const v = loud || (cur && now - at < 350);
    if (v !== cur) changed = true;
    set(v, at);
  };
  upd(s.speaking, s.flags.muted ? 0 : level(s.meter), s.loudAt, (v, at) => { s.speaking = v; s.loudAt = at; });
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
  const vol = volumeOf(uid);
  const p: Peer = {
    uid, pc, sid, offerer, dc, ice: [], out: [], ready: false, state: 'connecting', since: Date.now(), fixAt: 0,
    flags: null, voice: null, cam: null, scr: null, audio: audioEl(), audio2: audioEl(), meter: null, speaking: false, loudAt: 0,
  };
  p.audio.volume = vol;
  p.audio2.volume = vol;
  p.audio.muted = s.flags.deafened;
  p.audio2.muted = s.flags.deafened;
  const out = pref.out();
  if (out) setSink(p, out);
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
