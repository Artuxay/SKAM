// Вложения как в Telegram: фото (сжимаются, метаданные вроде геометки стираются), видео с превью,
// любые файлы до 50 МБ. Каждый файл шифруется своим случайным ключом прямо в браузере и
// загружается в приватный бакет media уже зашифрованным.
import { SUPABASE_KEY, SUPABASE_URL, sb } from '../lib/supabase';
import type { Attachment } from '../lib/database.types';
import { type Bytes, aesKey, b64, open, rand, seal, unb64, utf8 } from '../lib/crypto';
import { uuid } from '../lib/dom';
import { MEDIA_CACHE } from './e2e';

/** Предел Supabase на бесплатном тарифе — 50 МБ на файл (плюс 28 байт на шифрование). */
export const MAX_FILE = 50 * 1024 * 1024 - 1024;
export const MAX_ALBUM = 10;
const PHOTO_MAX = 2048;
const THUMB_MAX = 720;
const MINI_MAX = 24;
const FILE_AAD = utf8('skam/file/v1');

export type Prepared = {
  id: string;
  kind: Attachment['kind'];
  name: string;
  mime: string;
  size: number;
  main: Blob;
  thumb?: Blob;
  thumbW?: number;
  thumbH?: number;
  w?: number;
  h?: number;
  dur?: number;
  mini?: string;
  /** Локальная картинка для предпросмотра, пока файл загружается. */
  preview?: string;
};

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0).replace('.', ',')} КБ`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2).replace('.', ',')} ГБ`;
}

export function fmtDur(sec: number | undefined): string {
  if (!sec || !Number.isFinite(sec)) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function fileExt(name: string): string {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name);
  return m ? m[1].toUpperCase() : 'ФАЙЛ';
}

// ---------------------------------------------------------------------------
// Подготовка: сжатие фото, превью видео
// ---------------------------------------------------------------------------

type Drawable = ImageBitmap | HTMLImageElement | HTMLVideoElement;

function sizeOf(src: Drawable): { w: number; h: number } {
  if (src instanceof HTMLVideoElement) return { w: src.videoWidth, h: src.videoHeight };
  if (src instanceof HTMLImageElement) return { w: src.naturalWidth, h: src.naturalHeight };
  return { w: src.width, h: src.height };
}

function scaled(src: Drawable, max: number): HTMLCanvasElement {
  const { w, h } = sizeOf(src);
  const k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('canvas');
  // Прозрачность PNG превращается в белый фон, как в Telegram.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

function toJpeg(c: HTMLCanvasElement, q: number): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', q));
}

async function loadImage(file: Blob): Promise<Drawable> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function waitEvent(target: EventTarget, ok: string, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, ms);
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('media error')); };
    const cleanup = () => { clearTimeout(t); target.removeEventListener(ok, done); target.removeEventListener('error', fail); };
    target.addEventListener(ok, done, { once: true });
    target.addEventListener('error', fail, { once: true });
  });
}

async function previews(src: Drawable, p: Prepared): Promise<void> {
  const t = scaled(src, THUMB_MAX);
  p.thumb = await toJpeg(t, 0.8);
  p.thumbW = t.width;
  p.thumbH = t.height;
  p.mini = scaled(src, MINI_MAX).toDataURL('image/jpeg', 0.5);
  p.preview = URL.createObjectURL(p.thumb);
}

async function asPhoto(file: File, p: Prepared): Promise<void> {
  const img = await loadImage(file);
  const { w, h } = sizeOf(img);
  if (!w || !h) throw new Error('empty image');
  p.kind = 'photo';
  if (file.type === 'image/gif') {
    // Гифки не пережимаем, чтобы не пропала анимация.
    p.main = file;
    p.mime = 'image/gif';
    p.w = w;
    p.h = h;
    p.mini = scaled(img, MINI_MAX).toDataURL('image/jpeg', 0.5);
    p.preview = URL.createObjectURL(file);
  } else {
    const c = scaled(img, PHOTO_MAX);
    p.main = await toJpeg(c, 0.86);
    p.mime = 'image/jpeg';
    p.name = p.name.replace(/\.[^.]+$/, '') + '.jpg';
    p.w = c.width;
    p.h = c.height;
    await previews(img, p);
  }
  p.size = p.main.size;
  if ('close' in img) img.close();
}

async function asVideo(file: File, p: Prepared): Promise<void> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = url;
  try {
    await waitEvent(v, 'loadeddata', 10_000);
    if (!v.videoWidth || !v.videoHeight) throw new Error('no video track');
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    const at = Math.min(1, dur / 3);
    if (at > 0.05) {
      v.currentTime = at;
      await waitEvent(v, 'seeked', 5000).catch(() => {});
    }
    p.kind = 'video';
    p.w = v.videoWidth;
    p.h = v.videoHeight;
    p.dur = dur || undefined;
    await previews(v, p);
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
}

/**
 * Подготовить файлы к отправке. compress = true — как «Отправить фото/видео» в Telegram
 * (фото пережимаются до 2048 px, у видео снимается кадр-превью); false — «Отправить как файл».
 */
export async function prepareFiles(files: File[], compress: boolean): Promise<Prepared[]> {
  const out: Prepared[] = [];
  for (const f of files) {
    const p: Prepared = {
      id: uuid(),
      kind: 'file',
      name: f.name || 'файл',
      mime: f.type || 'application/octet-stream',
      size: f.size,
      main: f,
    };
    if (compress && f.type.startsWith('image/') && f.type !== 'image/svg+xml') {
      try { await asPhoto(f, p); } catch { p.kind = 'file'; p.main = f; p.size = f.size; p.name = f.name; p.mime = f.type || 'application/octet-stream'; }
    } else if (compress && f.type.startsWith('video/')) {
      try { await asVideo(f, p); } catch { p.kind = 'file'; }
    }
    out.push(p);
  }
  return out;
}

export function isVisual(f: File): boolean {
  return (f.type.startsWith('image/') && f.type !== 'image/svg+xml') || f.type.startsWith('video/');
}

export function releasePrepared(list: Prepared[]): void {
  list.forEach((p) => { if (p.preview) URL.revokeObjectURL(p.preview); });
}

// ---------------------------------------------------------------------------
// Шифрование и загрузка
// ---------------------------------------------------------------------------

export type Part = { path: string; data: Bytes; done: boolean };
export type Sealed = { att: Attachment; parts: Part[] };

export async function sealPrepared(p: Prepared, chatId: string, userId: string): Promise<Sealed> {
  const raw = rand(32);
  const key = await aesKey(raw);
  const mk = async (blob: Blob): Promise<Part> => ({
    path: `${chatId}/${userId}/${uuid()}.bin`,
    data: await seal(key, new Uint8Array(await blob.arrayBuffer()), FILE_AAD),
    done: false,
  });
  const main = await mk(p.main);
  const parts = [main];
  const att: Attachment = { id: p.id, kind: p.kind, name: p.name.slice(0, 255), mime: p.mime.slice(0, 255), size: p.size, path: main.path, key: b64(raw) };
  if (p.w && p.h) { att.w = p.w; att.h = p.h; }
  if (p.dur) att.dur = Math.round(p.dur * 10) / 10;
  if (p.mini) att.mini = p.mini;
  if (p.thumb && p.thumbW && p.thumbH) {
    const t = await mk(p.thumb);
    parts.push(t);
    att.thumb = { path: t.path, w: p.thumbW, h: p.thumbH };
  }
  raw.fill(0);
  return { att, parts };
}

export class UploadError extends Error {}

/** В кэше храним зашифрованные файлы до 25 МБ: расшифровать их без ключа нельзя. */
const CACHE_LIMIT = 25 * 1024 * 1024;

async function token(): Promise<string> {
  const { data } = await sb.auth.getSession();
  return data.session?.access_token ?? SUPABASE_KEY;
}

const objectUrl = (path: string) => `${SUPABASE_URL}/storage/v1/object/media/${path.split('/').map(encodeURIComponent).join('/')}`;

/** Загрузка с прогрессом (fetch его не показывает, поэтому XMLHttpRequest). */
export async function uploadPart(part: Part, onProgress: (loaded: number) => void, signal: AbortSignal): Promise<void> {
  const auth = await token();
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', objectUrl(part.path));
    xhr.setRequestHeader('Authorization', `Bearer ${auth}`);
    xhr.setRequestHeader('apikey', SUPABASE_KEY);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.setRequestHeader('cache-control', 'max-age=31536000');
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { resolve(); return; }
      // Повторная попытка после обрыва: файл уже на месте.
      if (xhr.status === 409 || /Duplicate|already exists/i.test(xhr.responseText)) { resolve(); return; }
      if (xhr.status === 413 || /too large|exceeded the maximum/i.test(xhr.responseText)) {
        reject(new UploadError('Файл слишком большой: можно до 50 МБ.'));
        return;
      }
      reject(new UploadError(xhr.status === 403 || xhr.status === 400 ? 'Нет прав загрузить файл в этот чат.' : 'Не получилось загрузить файл.'));
    };
    xhr.onerror = () => reject(new UploadError('Нет связи с сервером.'));
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(part.data);
  });
  part.done = true;
  // Свой только что загруженный файл кладём в кэш: открыть его можно будет без скачивания.
  if (part.data.length <= CACHE_LIMIT) void cachePut(part.path, part.data);
}

export async function removeFiles(atts: Attachment[]): Promise<void> {
  const paths = atts.flatMap((a) => [a.path, a.thumb?.path]).filter((p): p is string => !!p);
  if (paths.length) await sb.storage.from('media').remove(paths);
}

// ---------------------------------------------------------------------------
// Скачивание и расшифровка
// ---------------------------------------------------------------------------

const cacheKey = (path: string) => `https://skam.invalid/media/${path}`;

async function cachePut(path: string, data: Bytes): Promise<void> {
  try {
    const cache = await caches.open(MEDIA_CACHE);
    await cache.put(cacheKey(path), new Response(data));
  } catch { /* нет Cache API (например, не HTTPS) — просто скачаем ещё раз */ }
}

async function fetchSealed(path: string, onProgress?: (loaded: number, total: number) => void): Promise<Bytes> {
  let cache: Cache | null = null;
  try { cache = await caches.open(MEDIA_CACHE); } catch { cache = null; }
  const hit = await cache?.match(cacheKey(path)).catch(() => undefined);
  if (hit) return new Uint8Array(await hit.arrayBuffer());

  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/media/${path.split('/').map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${await token()}`, apikey: SUPABASE_KEY },
  });
  if (!res.ok) throw new Error(res.status === 400 || res.status === 404 ? 'Файл не найден — возможно, его удалили.' : 'Не получилось скачать файл.');
  const total = Number(res.headers.get('content-length')) || 0;
  let data: Bytes;
  if (res.body && onProgress) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress(loaded, total);
    }
    data = new Uint8Array(loaded);
    let o = 0;
    for (const c of chunks) { data.set(c, o); o += c.length; }
  } else {
    data = new Uint8Array(await res.arrayBuffer());
  }
  if (data.length <= CACHE_LIMIT) void cachePut(path, data);
  return data;
}

async function decryptFile(att: Pick<Attachment, 'key'>, path: string, onProgress?: (loaded: number, total: number) => void): Promise<Bytes> {
  const sealed = await fetchSealed(path, onProgress);
  const key = await aesKey(unb64(att.key));
  try {
    return await open(key, sealed, FILE_AAD);
  } catch {
    throw new Error('Файл повреждён или подменён — расшифровать не получилось.');
  }
}

// Расшифрованные картинки держим как object URL, чтобы лента перерисовывалась мгновенно.
const urls = new Map<string, string>();
const loading = new Map<string, Promise<string>>();
const fullOrder: string[] = [];
const FULL_KEEP = 8;

export function cachedUrl(path: string): string | null {
  return urls.get(path) ?? null;
}

// ---------------------------------------------------------------------------
// Зашифрованные голосовые и кружочки: файл с ключом из сообщения
// ---------------------------------------------------------------------------

const sealedFiles = new Map<string, { key: string; mime: string }>();

/** Запомнить ключ файла голосового или кружочка из расшифрованного сообщения. */
export function registerSealed(path: string, key: string, mime: string): void {
  sealedFiles.set(path, { key, mime });
}

/** Ссылка на расшифрованный файл (для плеера) или null, если файл не зашифрован. */
export function sealedUrl(path: string): Promise<string> | null {
  const f = sealedFiles.get(path);
  if (!f) return null;
  return load(path, () => decryptFile(f, path), f.mime, false);
}

/** Зашифровать запись перед загрузкой: свой случайный ключ на каждый файл. */
export async function sealBlob(blob: Blob, keyB64?: string): Promise<{ data: Bytes; key: string }> {
  const raw = keyB64 ? unb64(keyB64) : rand(32);
  const data = await seal(await aesKey(raw), new Uint8Array(await blob.arrayBuffer()), FILE_AAD);
  return { data, key: b64(raw) };
}

/** Своё только что отправленное фото: превью уже есть в памяти, скачивать его не нужно. */
export function seedUrl(path: string, url: string): void {
  if (!urls.has(path)) urls.set(path, url);
}

/** Картинка для ленты: уменьшенная копия (или сам файл, если копии нет — например, у гифки). */
export function thumbUrl(att: Attachment): Promise<string> {
  const path = att.thumb?.path ?? att.path;
  const mime = att.thumb ? 'image/jpeg' : att.mime;
  return load(path, () => decryptFile(att, path), mime, false);
}

/** Полный файл (фото/видео в просмотрщике). Старые полные копии вытесняются из памяти. */
export function fullUrl(att: Attachment, onProgress?: (loaded: number, total: number) => void): Promise<string> {
  return load(att.path, () => decryptFile(att, att.path, onProgress), att.mime || 'application/octet-stream', !!att.thumb);
}

function load(path: string, get: () => Promise<Bytes>, mime: string, evictable: boolean): Promise<string> {
  const have = urls.get(path);
  if (have) return Promise.resolve(have);
  let p = loading.get(path);
  if (p) return p;
  p = get().then((bytes) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    urls.set(path, url);
    if (evictable) {
      fullOrder.push(path);
      while (fullOrder.length > FULL_KEEP) {
        const old = fullOrder.shift()!;
        const u = urls.get(old);
        if (u) URL.revokeObjectURL(u);
        urls.delete(old);
      }
    }
    return url;
  }).finally(() => loading.delete(path));
  loading.set(path, p);
  return p;
}

/** Скачать файл на устройство под исходным именем. */
export async function saveFile(att: Attachment, onProgress?: (loaded: number, total: number) => void): Promise<void> {
  const url = urls.get(att.path) ?? URL.createObjectURL(new Blob([await decryptFile(att, att.path, onProgress)], { type: att.mime || 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = att.name;
  document.body.append(a);
  a.click();
  a.remove();
  if (!urls.has(att.path)) setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function dropMediaUrls(): void {
  urls.forEach((u) => URL.revokeObjectURL(u));
  urls.clear();
  loading.clear();
  fullOrder.length = 0;
}
