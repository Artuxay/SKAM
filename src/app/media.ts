// Голосовые и кружочки в ленте: ссылки на файлы, плеер голосовых, круглые видео.
//
// Файлы лежат в приватном бакете media, поэтому играем их по временным подписанным ссылкам
// (выдаются только участникам чата — проверяет политика хранилища). Только что записанное
// своё сообщение играем из локальной копии, не скачивая заново.
//
// Лента перерисовывается целиком, поэтому:
//  • голосовые играет один общий <audio> вне DOM — перерисовка его не прерывает;
//  • элемент кружочка создаётся один раз на сообщение и переносится в новую разметку.
import { sb } from '../lib/supabase';
import { ICONS, el, fmtDur, html, lsGet, lsSet, toast } from '../lib/dom';
import type { Msg } from './store';
import { cachedUrl, sealedUrl } from './attach';

// ---------------------------------------------------------------------------
// Ссылки на файлы
// ---------------------------------------------------------------------------

const SIGN_TTL = 6 * 3600;
const signed = new Map<string, { url: string; exp: number }>();
const local = new Map<string, string>();
let queue = new Map<string, { resolve: (u: string) => void; reject: (e: unknown) => void }[]>();
let queued = false;

/** Своя свежая запись: играем её из памяти. */
export function setLocalMedia(path: string, blob: Blob): void {
  local.set(path, URL.createObjectURL(blob));
}

export function cachedMediaUrl(path: string): string | null {
  const own = local.get(path) ?? cachedUrl(path);
  if (own) return own;
  const s = signed.get(path);
  return s && s.exp - Date.now() > 5 * 60_000 ? s.url : null;
}

/** Подписанная ссылка на файл. Запросы из одного тика склеиваются в один вызов createSignedUrls. */
export function mediaUrl(path: string): Promise<string> {
  const hit = cachedMediaUrl(path);
  if (hit) return Promise.resolve(hit);
  // Голосовое или кружочек из зашифрованного чата: скачиваем и расшифровываем.
  const sealed = sealedUrl(path);
  if (sealed) return sealed;
  return new Promise((resolve, reject) => {
    const list = queue.get(path) ?? [];
    list.push({ resolve, reject });
    queue.set(path, list);
    if (!queued) {
      queued = true;
      setTimeout(flushQueue, 0);
    }
  });
}

async function flushQueue(): Promise<void> {
  const batch = queue;
  queue = new Map();
  queued = false;
  const paths = [...batch.keys()];
  try {
    const { data, error } = await sb.storage.from('media').createSignedUrls(paths, SIGN_TTL);
    if (error) throw error;
    const exp = Date.now() + SIGN_TTL * 1000;
    for (const row of data ?? []) {
      if (row.path && row.signedUrl) signed.set(row.path, { url: row.signedUrl, exp });
    }
    for (const [path, waiters] of batch) {
      const url = signed.get(path)?.url;
      waiters.forEach((w) => (url ? w.resolve(url) : w.reject(new Error('Файл не найден'))));
    }
  } catch (e) {
    batch.forEach((waiters) => waiters.forEach((w) => w.reject(e)));
  }
}

// ---------------------------------------------------------------------------
// Голосовые
// ---------------------------------------------------------------------------

const RATES = [1, 1.5, 2];
const audio = new Audio();
audio.preload = 'auto';
let cur: { id: string; chatId: string; dur: number } | null = null;
let rate = RATES.includes(Number(lsGet('skam:voice-rate'))) ? Number(lsGet('skam:voice-rate')) : 1;
let raf = 0;
let loadSeq = 0;
/** Следующее голосовое в ленте — играем подряд, как в Telegram. */
let nextVoice: (m: { id: string; chatId: string }) => Msg | null = () => null;
const byId = new Map<string, Msg>();

export function setVoiceQueue(fn: typeof nextVoice): void {
  nextVoice = fn;
}

function curTime(): number {
  return Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
}

/** onlyCurrent — во время воспроизведения обновляем только играющее голосовое. */
function paintVoice(onlyCurrent = false): void {
  const sel = onlyCurrent && cur ? `.voice[data-voice="${cur.id}"]` : '.voice[data-voice]';
  document.querySelectorAll<HTMLElement>(sel).forEach((node) => {
    const id = node.dataset.voice!;
    const on = cur?.id === id;
    const playing = on && !audio.paused;
    node.classList.toggle('playing', playing);
    node.classList.toggle('active', on);
    const dur = Number(node.dataset.dur) || 0;
    const t = on ? curTime() * 1000 : 0;
    node.style.setProperty('--p', `${on && dur ? Math.min(100, (t / dur) * 100) : 0}%`);
    const time = node.querySelector('.vtime');
    if (time) time.textContent = on && (t > 0 || playing) ? fmtDur(t) : fmtDur(dur);
    const btn = node.querySelector<HTMLButtonElement>('.vplay');
    if (btn && btn.dataset.state !== (playing ? 'pause' : 'play')) {
      btn.dataset.state = playing ? 'pause' : 'play';
      btn.replaceChildren(html(playing ? ICONS.pause : ICONS.play));
      btn.setAttribute('aria-label', playing ? 'Пауза' : `Слушать голосовое, ${fmtDur(dur)}`);
    }
    const r = node.querySelector('.vrate');
    if (r) r.textContent = `${rate}×`;
  });
}

function loop(): void {
  cancelAnimationFrame(raf);
  paintVoice(true);
  if (!audio.paused) raf = requestAnimationFrame(loop);
}

audio.addEventListener('play', () => { paintVoice(); loop(); });
audio.addEventListener('pause', () => { cancelAnimationFrame(raf); paintVoice(); });
audio.addEventListener('ended', () => {
  const done = cur;
  cur = null;
  paintVoice();
  const next = done ? nextVoice(done) : null;
  if (next) void playVoice(next);
});
audio.addEventListener('error', () => {
  if (!cur || !audio.src) return;
  cur = null;
  paintVoice();
  toast('Не получилось воспроизвести голосовое: этот браузер не знает такой формат или файл недоступен.');
});

async function playVoice(m: Msg, fromFrac = 0): Promise<void> {
  if (!m.media_path) return;
  pauseNotes();
  const my = ++loadSeq;
  cur = { id: m.id, chatId: m.chat_id, dur: (m.duration_ms ?? 0) / 1000 };
  byId.set(m.id, m);
  paintVoice();
  let url: string;
  try {
    url = await mediaUrl(m.media_path);
  } catch {
    if (my === loadSeq) { cur = null; paintVoice(); toast('Не получилось загрузить голосовое.'); }
    return;
  }
  if (my !== loadSeq) return;
  if (audio.src !== url) audio.src = url;
  audio.playbackRate = rate;
  if (fromFrac > 0 && cur.dur) audio.currentTime = fromFrac * cur.dur;
  try {
    await audio.play();
  } catch (e) {
    if ((e as Error).name !== 'AbortError' && my === loadSeq) { cur = null; paintVoice(); }
  }
}

export function toggleVoice(m: Msg): void {
  if (cur?.id === m.id) {
    if (audio.paused) void audio.play().catch(() => {});
    else audio.pause();
    return;
  }
  void playVoice(m);
}

export function seekVoice(m: Msg, frac: number): void {
  frac = Math.min(1, Math.max(0, frac));
  if (cur?.id === m.id && audio.src) {
    if (cur.dur) audio.currentTime = frac * cur.dur;
    if (audio.paused) void audio.play().catch(() => {});
    paintVoice();
    return;
  }
  void playVoice(m, frac);
}

export function stopVoice(id?: string): void {
  if (id && cur?.id !== id) return;
  loadSeq++;
  audio.pause();
  cur = null;
  paintVoice();
}

export function isVoicePlaying(): boolean {
  return !!cur && !audio.paused;
}

function cycleRate(): void {
  rate = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
  lsSet('skam:voice-rate', String(rate));
  audio.playbackRate = rate;
  paintVoice();
}

/** Столбики громкости под нужную ширину: берём максимум по каждому отрезку. */
function bars(wave: number[] | null, n: number, seed: string): number[] {
  if (!wave?.length) {
    // Старые записи без волны — ровные «псевдо-столбики», одинаковые при каждой отрисовке.
    let h = 0;
    for (const c of seed) h = (h * 31 + c.charCodeAt(0)) | 0;
    return Array.from({ length: n }, (_, i) => 25 + (Math.abs(Math.sin(h + i * 1.7)) * 45));
  }
  return Array.from({ length: n }, (_, i) => {
    const a = Math.floor((i * wave.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * wave.length) / n));
    return Math.max(...wave.slice(a, b));
  });
}

export function voiceEl(m: Msg): HTMLElement {
  byId.set(m.id, m);
  const dur = m.duration_ms ?? 0;
  const count = Math.round(Math.min(48, Math.max(22, 20 + dur / 1000 * 1.3)));
  const root = el('div', 'voice');
  root.dataset.voice = m.id;
  root.dataset.dur = String(dur);

  const play = el('button', 'vplay');
  play.type = 'button';
  play.addEventListener('click', (ev) => { ev.stopPropagation(); toggleVoice(m); });

  const body = el('div', 'vbody');
  const wave = el('div', 'wave');
  wave.setAttribute('role', 'slider');
  wave.setAttribute('aria-label', 'Перемотка голосового');
  wave.setAttribute('aria-valuemin', '0');
  wave.setAttribute('aria-valuemax', String(Math.round(dur / 1000)));
  wave.tabIndex = 0;
  const heights = bars(m.waveform, count, m.id);
  for (const layer of ['bars', 'bars fill']) {
    const b = el('div', layer);
    b.setAttribute('aria-hidden', 'true');
    heights.forEach((v) => {
      const s = el('span');
      s.style.height = `${Math.max(12, Math.min(100, v))}%`;
      b.append(s);
    });
    wave.append(b);
  }
  const seekTo = (x: number) => {
    const r = wave.getBoundingClientRect();
    if (r.width) seekVoice(m, (x - r.left) / r.width);
  };
  wave.addEventListener('pointerdown', (ev) => {
    ev.stopPropagation();
    seekTo(ev.clientX);
    wave.setPointerCapture(ev.pointerId);
    const move = (e: PointerEvent) => seekTo(e.clientX);
    const up = () => { wave.removeEventListener('pointermove', move); wave.removeEventListener('pointerup', up); };
    wave.addEventListener('pointermove', move);
    wave.addEventListener('pointerup', up);
  });
  wave.addEventListener('click', (ev) => ev.stopPropagation());
  wave.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    ev.preventDefault();
    const now = cur?.id === m.id ? curTime() * 1000 : 0;
    seekVoice(m, (now + (ev.key === 'ArrowRight' ? 5000 : -5000)) / Math.max(1, dur));
  });

  const meta = el('div', 'vmeta');
  const rateBtn = el('button', 'vrate', `${rate}×`);
  rateBtn.type = 'button';
  rateBtn.setAttribute('aria-label', 'Скорость воспроизведения');
  rateBtn.addEventListener('click', (ev) => { ev.stopPropagation(); cycleRate(); });
  meta.append(el('span', 'vtime', fmtDur(dur)), rateBtn);
  body.append(wave, meta);
  root.append(play, body);
  root.style.setProperty('--bars', String(count));
  // Состояние плеера (идёт ли это голосовое, на какой секунде) — сразу, без мигания.
  queueMicrotask(paintVoice);
  return root;
}

// ---------------------------------------------------------------------------
// Кружочки
// ---------------------------------------------------------------------------

type Note = {
  id: string;
  chatId: string;
  root: HTMLElement;
  video: HTMLVideoElement;
  ring: SVGCircleElement;
  time: HTMLElement;
  dur: number;
  loud: boolean;
  visible: boolean;
};

const notes = new Map<string, Note>();
const RING = 2 * Math.PI * 48;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let loudNote: Note | null = null;

const io = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      const n = [...notes.values()].find((x) => x.root === e.target);
      if (!n) continue;
      n.visible = e.isIntersecting;
      if (!n.loud) quietPlay(n);
    }
  }, { threshold: 0.6 })
  : null;

/** Без звука кружочки крутятся по кругу, пока видны (если человек не просил меньше анимации). */
function quietPlay(n: Note): void {
  if (n.loud) return;
  if (n.visible && !reduceMotion.matches && n.video.src && document.visibilityState === 'visible') {
    n.video.muted = true;
    n.video.loop = true;
    void n.video.play().catch(() => {});
  } else {
    n.video.pause();
  }
}

function paintNote(n: Note): void {
  const t = n.loud ? n.video.currentTime * 1000 : 0;
  const p = n.loud && n.dur ? Math.min(1, t / n.dur) : 0;
  n.ring.style.strokeDashoffset = String(RING * (1 - p));
  n.root.classList.toggle('loud', n.loud);
  n.root.classList.toggle('paused', n.loud && n.video.paused);
  n.time.replaceChildren(fmtDur(n.loud ? n.dur - t : n.dur));
  if (!n.loud) n.time.append(html(ICONS.muted));
}

function setLoud(n: Note, on: boolean): void {
  if (on) {
    if (loudNote && loudNote !== n) setLoud(loudNote, false);
    stopVoice();
    loudNote = n;
    n.loud = true;
    n.video.loop = false;
    n.video.muted = false;
    n.video.currentTime = 0;
    void n.video.play().catch(() => { setLoud(n, false); });
  } else {
    if (loudNote === n) loudNote = null;
    n.loud = false;
    quietPlay(n);
  }
  paintNote(n);
}

/** Поставить на паузу кружочек со звуком (начали слушать голосовое или записывать). */
export function pauseNotes(): void {
  if (loudNote) setLoud(loudNote, false);
}

/** Уходим из чата — кружочки других чатов больше не нужны. */
export function dropNotes(keepChat: string | null): void {
  for (const [id, n] of notes) {
    if (n.chatId === keepChat) continue;
    if (loudNote === n) loudNote = null;
    n.video.pause();
    n.video.removeAttribute('src');
    n.video.load();
    io?.unobserve(n.root);
    notes.delete(id);
  }
}

export function videoNoteEl(m: Msg): HTMLElement {
  const had = notes.get(m.id);
  if (had && had.root.dataset.path === m.media_path) return had.root;
  const dur = m.duration_ms ?? 0;
  const root = el('div', 'vnote');
  root.dataset.path = m.media_path ?? '';
  const video = el('video');
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.setAttribute('playsinline', '');
  video.disablePictureInPicture = true;
  const svg = html(`<svg class="vnote-ring" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="48" stroke-dasharray="${RING}" stroke-dashoffset="${RING}"/></svg>`);
  const ring = svg.querySelector('circle') as SVGCircleElement;
  const time = el('span', 'vnote-time');
  const btn = el('button', 'vnote-btn');
  btn.type = 'button';
  btn.setAttribute('aria-label', `Кружочек, ${fmtDur(dur)} — смотреть со звуком`);
  const icon = el('span', 'vnote-play');
  icon.append(html(ICONS.play));
  root.append(video, svg, icon, time, btn);

  const n: Note = { id: m.id, chatId: m.chat_id, root, video, ring, time, dur, loud: false, visible: false };
  notes.set(m.id, n);

  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (!n.loud) { setLoud(n, true); return; }
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
    paintNote(n);
  });
  video.addEventListener('timeupdate', () => { if (n.loud) paintNote(n); });
  video.addEventListener('pause', () => paintNote(n));
  video.addEventListener('play', () => paintNote(n));
  video.addEventListener('ended', () => { if (n.loud) setLoud(n, false); });
  video.addEventListener('error', () => {
    if (!video.getAttribute('src')) return;
    root.classList.add('broken');
    btn.setAttribute('aria-label', 'Кружочек не воспроизводится в этом браузере');
  });

  if (m.media_path) {
    mediaUrl(m.media_path).then((url) => {
      // #t — чтобы Safari показал первый кадр до воспроизведения.
      video.src = url.startsWith('blob:') ? url : `${url}#t=0.001`;
      quietPlay(n);
    }, () => {
      // Файла нет (удалён или нет доступа) — это не то же самое, что «браузер не умеет».
      root.classList.add('missing');
      btn.setAttribute('aria-label', 'Кружочек недоступен');
    });
  }
  io?.observe(root);
  paintNote(n);
  return root;
}

// Голосовое продолжает играть и в фоне (как в Telegram), а видео в скрытой вкладке ни к чему.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    notes.forEach((n) => { if (n.loud) setLoud(n, false); else n.video.pause(); });
  } else {
    notes.forEach((n) => quietPlay(n));
  }
});
