// Запись голосовых и кружочков через MediaRecorder.
//
// Голосовое: микрофон → Opus (webm/ogg) или AAC (mp4 в Safari) + «волна» громкости для плеера.
// Кружочек: фронтальная камера → квадрат 400×400 (обрезаем центр на холсте) + звук, до 60 секунд.
import type { Recorded } from './store';

export type RecKind = 'voice' | 'video_note';

/** Пределы совпадают с ограничениями в базе (messages_media_shape). */
export const REC_LIMIT_MS: Record<RecKind, number> = { voice: 10 * 60_000, video_note: 60_000 };
/** Короче — считаем, что человек просто нажал кнопку. */
export const REC_MIN_MS = 700;

const WAVE_BARS = 64;
const NOTE_SIZE = 400;

const TYPES: Record<RecKind, string[]> = {
  voice: ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm', 'audio/ogg'],
  video_note: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4'],
};

export class RecError extends Error {
  readonly reason: 'denied' | 'notfound' | 'busy' | 'insecure' | 'unsupported';
  constructor(reason: RecError['reason'], message: string) {
    super(message);
    this.reason = reason;
  }
}

function pickType(kind: RecKind): string {
  if (typeof MediaRecorder === 'undefined') throw new RecError('unsupported', 'Этот браузер не умеет записывать звук и видео.');
  const ok = TYPES[kind].find((t) => MediaRecorder.isTypeSupported?.(t));
  return ok ?? '';
}

/** Тип файла → разрешённый в базе mime и расширение. */
function fileType(kind: RecKind, type: string): { mime: string; ext: string } {
  const base = type.split(';')[0].trim().toLowerCase();
  if (kind === 'voice') {
    if (base.endsWith('/webm')) return { mime: 'audio/webm', ext: 'webm' };
    if (base.endsWith('/ogg')) return { mime: 'audio/ogg', ext: 'ogg' };
    if (base.endsWith('/mp4') || base.endsWith('/aac') || base.endsWith('/x-m4a')) return { mime: 'audio/mp4', ext: 'm4a' };
  } else {
    if (base.endsWith('/webm')) return { mime: 'video/webm', ext: 'webm' };
    if (base.endsWith('/mp4')) return { mime: 'video/mp4', ext: 'mp4' };
  }
  throw new RecError('unsupported', 'Этот браузер записывает в формате, который СКАМ пока не принимает.');
}

function explain(e: unknown, kind: RecKind): RecError {
  const name = (e as { name?: string })?.name;
  const what = kind === 'voice' ? 'микрофону' : 'камере и микрофону';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new RecError('denied', `Нет доступа к ${what}. Разрешите его в настройках браузера для этого сайта.`);
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new RecError('notfound', kind === 'voice' ? 'Микрофон не найден.' : 'Камера или микрофон не найдены.');
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return new RecError('busy', kind === 'voice' ? 'Микрофон занят другим приложением.' : 'Камера занята другим приложением.');
  }
  return e instanceof RecError ? e : new RecError('unsupported', 'Не получилось начать запись.');
}

export class Recorder {
  readonly kind: RecKind;
  /** Живое изображение с камеры (для кружочка). */
  readonly preview: HTMLVideoElement | null = null;
  /** Текущая громкость 0…1 — для индикатора записи. */
  level = 0;

  private stream: MediaStream;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private type = '';
  private startedAt = 0;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private samples: number[] = [];
  private sampleTimer: number | undefined;
  private canvas: HTMLCanvasElement | null = null;
  private out: MediaStream | null = null;
  private drawTimer: number | undefined;
  private closed = false;

  private constructor(kind: RecKind, stream: MediaStream) {
    this.kind = kind;
    this.stream = stream;
    if (kind === 'video_note') {
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.autoplay = true;
      v.srcObject = stream;
      void v.play().catch(() => {});
      this.preview = v;
    }
  }

  /** Спросить доступ к микрофону (и камере). Бросает RecError с понятным текстом. */
  static async open(kind: RecKind): Promise<Recorder> {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new RecError('insecure', 'Запись работает только по защищённому адресу (https).');
    }
    pickType(kind);
    const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    try {
      const stream = await navigator.mediaDevices.getUserMedia(kind === 'voice'
        ? { audio }
        : { audio, video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 640 }, frameRate: { ideal: 30 } } });
      return new Recorder(kind, stream);
    } catch (e) {
      throw explain(e, kind);
    }
  }

  get elapsed(): number {
    return this.startedAt ? performance.now() - this.startedAt : 0;
  }

  get limit(): number {
    return REC_LIMIT_MS[this.kind];
  }

  start(): void {
    this.type = pickType(this.kind);
    let out = this.stream;
    if (this.kind === 'video_note') out = this.squareStream() ?? this.stream;
    const opts: MediaRecorderOptions = this.kind === 'voice'
      ? { audioBitsPerSecond: 48_000 }
      : { audioBitsPerSecond: 64_000, videoBitsPerSecond: 1_000_000 };
    if (this.type) opts.mimeType = this.type;
    this.rec = new MediaRecorder(out, opts);
    this.rec.ondataavailable = (e) => { if (e.data?.size) this.chunks.push(e.data); };
    this.rec.start(250);
    this.startedAt = performance.now();
    this.listen();
  }

  /** Холст с квадратным центром кадра: кружочек у всех одинаковый и лёгкий. */
  private squareStream(): MediaStream | null {
    const v = this.preview;
    const canvas = document.createElement('canvas');
    if (!v || typeof canvas.captureStream !== 'function') return null;
    canvas.width = canvas.height = NOTE_SIZE;
    const g = canvas.getContext('2d');
    if (!g) return null;
    this.canvas = canvas;
    const draw = () => {
      const w = v.videoWidth, h = v.videoHeight;
      if (w && h) {
        const s = Math.min(w, h);
        g.drawImage(v, (w - s) / 2, (h - s) / 2, s, s, 0, 0, NOTE_SIZE, NOTE_SIZE);
      }
    };
    draw();
    // Таймер, а не requestAnimationFrame: запись не должна замирать, если вкладку свернули.
    this.drawTimer = window.setInterval(draw, 1000 / 30);
    const out = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...this.stream.getAudioTracks()]);
    this.out = out;
    return out;
  }

  /** Громкость: для индикатора и «волны» голосового. */
  private listen(): void {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC || !this.stream.getAudioTracks().length) return;
    try {
      this.ctx = new AC();
      void this.ctx.resume().catch(() => {});
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      src.connect(this.analyser);
      const buf = new Float32Array(this.analyser.fftSize);
      this.sampleTimer = window.setInterval(() => {
        if (!this.analyser) return;
        this.analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        this.level = Math.min(1, Math.sqrt(rms) * 1.8);
        this.samples.push(this.level);
      }, 50);
    } catch {
      this.ctx = null;
    }
  }

  private wave(): number[] | null {
    const s = this.samples;
    if (s.length < 4) return null;
    const n = Math.min(WAVE_BARS, s.length);
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = Math.floor((i * s.length) / n);
      const b = Math.max(a + 1, Math.floor(((i + 1) * s.length) / n));
      out.push(Math.max(...s.slice(a, b)));
    }
    const peak = Math.max(...out) || 1;
    return out.map((v) => Math.round(Math.min(100, (v / peak) * 100)));
  }

  /** Закончить запись и получить файл. */
  async stop(): Promise<Recorded> {
    const rec = this.rec;
    const durationMs = Math.min(this.elapsed, this.limit);
    if (!rec) throw new RecError('unsupported', 'Запись не началась.');
    const done = new Promise<void>((resolve) => {
      rec.addEventListener('stop', () => resolve(), { once: true });
    });
    if (rec.state !== 'inactive') rec.stop();
    await done;
    const waveform = this.kind === 'voice' ? this.wave() : null;
    const type = rec.mimeType || this.type || (this.kind === 'voice' ? 'audio/webm' : 'video/webm');
    this.close();
    const { mime, ext } = fileType(this.kind, type);
    const blob = new Blob(this.chunks, { type: mime });
    if (!blob.size) throw new RecError('unsupported', 'Запись получилась пустой. Попробуйте ещё раз.');
    return { blob, mime, ext, durationMs, waveform };
  }

  /** Отменить: выключить микрофон и камеру, ничего не отправлять. */
  cancel(): void {
    try { if (this.rec && this.rec.state !== 'inactive') this.rec.stop(); } catch { /* уже остановлено */ }
    this.close();
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sampleTimer);
    clearInterval(this.drawTimer);
    this.stream.getTracks().forEach((t) => t.stop());
    this.out?.getTracks().forEach((t) => t.stop());
    this.canvas?.getContext('2d')?.clearRect(0, 0, NOTE_SIZE, NOTE_SIZE);
    if (this.preview) this.preview.srcObject = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.analyser = null;
  }
}
