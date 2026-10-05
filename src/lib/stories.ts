// Истории: лента, файлы, публикация. Интерфейс — в app/stories.ts.
//
// Историю видят люди, с которыми у автора есть личный чат. Живёт сутки; закреплённая в профиле — пока не открепят.
// Файлы лежат в приватном бакете stories (<автор>/<id>.<ext> и превью <id>_t.jpg), их отдают по временным ссылкам —
// проверку делает политика Storage. Ответ на историю — только сердечко.
import { SUPABASE_KEY, SUPABASE_URL, sb } from './supabase';
import type { Story, StoryKind } from './database.types';
import { uuid } from './dom';

export type StoryAuthor = {
  id: string;
  name: string | null;
  avatar_path: string | null;
  color: string | null;
  verified: boolean;
  stories: Story[];
  unseen: number;
  last_at: string;
};

/** Фоны текстовых историй: градиент и цвет текста (чёрный или белый — чтобы читалось). */
export const STORY_BGS: { bg: string; ink: string; name: string }[] = [
  { bg: 'linear-gradient(160deg,#FFAB1A 0%,#E85002 100%)', ink: '#000', name: 'Янтарь' },
  { bg: 'linear-gradient(160deg,#E85002 0%,#C10801 100%)', ink: '#fff', name: 'Огонь' },
  { bg: 'radial-gradient(120% 80% at 0% 100%,#FFAB1A 0%,#E85002 32%,#C10801 58%,#000 92%)', ink: '#fff', name: 'Закат' },
  { bg: 'linear-gradient(200deg,#2E7D0F 0%,#0B2E02 100%)', ink: '#fff', name: 'Лес' },
  { bg: 'linear-gradient(160deg,#333 0%,#0E0E0E 100%)', ink: '#fff', name: 'Графит' },
  { bg: 'linear-gradient(160deg,#FFAB1A 0%,#66EA1B 100%)', ink: '#000', name: 'Лето' },
  { bg: 'linear-gradient(160deg,#FFFFFF 0%,#E6E6E6 100%)', ink: '#000', name: 'Бумага' },
  { bg: 'linear-gradient(160deg,#FFAB1A 0%,#E85002 50%,#66EA1B 100%)', ink: '#000', name: 'СКАМ' },
];

export const STORY_TEXT_MAX = 700;
export const STORY_CAPTION_MAX = 200;
export const STORY_VIDEO_MAX_S = 60;
const FILE_MAX = 50 * 1024 * 1024 - 1024;
/** Сколько показывать фото и текст (видео — свою длину). */
export const STORY_SHOW_MS = 6000;

// ---------------------------------------------------------------------------
// Лента
// ---------------------------------------------------------------------------

export const ST = {
  feed: [] as StoryAuthor[],
  byAuthor: new Map<string, StoryAuthor>(),
  loaded: false,
};

let feedSeq = 0;
/** Загрузить ленту историй. Вернёт false, если за это время запросили новую (результат устарел). */
export async function loadStoryFeed(): Promise<boolean> {
  const seq = ++feedSeq;
  const { data, error } = await sb.rpc('story_feed');
  if (error) throw error;
  if (seq !== feedSeq) return false;
  ST.feed = (data ?? []).map((a) => ({
    id: a.author_id, name: a.name, avatar_path: a.avatar_path, color: a.color, verified: a.verified,
    stories: a.stories ?? [], unseen: a.unseen, last_at: a.last_at,
  }));
  ST.byAuthor = new Map(ST.feed.map((a) => [a.id, a]));
  ST.loaded = true;
  return true;
}

export function resetStories(): void {
  feedSeq++;
  ST.feed = [];
  ST.byAuthor.clear();
  ST.loaded = false;
  signed.clear();
  for (const u of local.values()) URL.revokeObjectURL(u);
  local.clear();
}

/** Живые истории человека в ленте: есть ли и все ли просмотрены. */
export function storyState(uid: string | null | undefined): 'none' | 'seen' | 'new' {
  if (!uid) return 'none';
  const a = ST.byAuthor.get(uid);
  if (!a || !a.stories.length) return 'none';
  return a.unseen > 0 ? 'new' : 'seen';
}

/** Отметить просмотр (локально сразу, на сервер — без ожидания). */
export function markSeen(s: Story, me: string): void {
  if (s.seen || s.author_id === me) return;
  s.seen = true;
  const a = ST.byAuthor.get(s.author_id);
  if (a) {
    const same = a.stories.find((x) => x.id === s.id);
    if (same && same !== s) same.seen = true;
    a.unseen = a.stories.filter((x) => !x.seen).length;
  }
  void sb.rpc('view_story', { p_story: s.id }).then(() => {}, () => {});
}

export async function userStories(uid: string): Promise<Story[]> {
  const { data, error } = await sb.rpc('user_stories', { p_user: uid });
  if (error) throw error;
  return (data ?? []) as Story[];
}

export async function storyViewers(id: string) {
  const { data, error } = await sb.rpc('story_viewers', { p_story: id });
  if (error) throw error;
  return data ?? [];
}

export async function likeStory(s: Story, on: boolean): Promise<void> {
  const before = s.liked;
  s.liked = on;
  const { error } = await sb.rpc('like_story', { p_story: s.id, p_on: on });
  if (error) { s.liked = before; throw error; }
  const twin = ST.byAuthor.get(s.author_id)?.stories.find((x) => x.id === s.id);
  if (twin) twin.liked = on;
}

export async function pinStory(s: Story, on: boolean): Promise<void> {
  const { error } = await sb.rpc('pin_story', { p_story: s.id, p_on: on });
  if (error) throw error;
  s.pinned = on;
  const twin = ST.byAuthor.get(s.author_id)?.stories.find((x) => x.id === s.id);
  if (twin) twin.pinned = on;
}

/** Удалить свою историю: запись — сразу, файлы — следом (не вышло — их уберёт сервер). */
export async function deleteStory(s: Story): Promise<void> {
  const { error } = await sb.rpc('delete_story', { p_story: s.id });
  if (error) throw error;
  const paths = [s.media_path, s.thumb_path].filter((p): p is string => !!p);
  if (paths.length) void sb.storage.from('stories').remove(paths).then(() => {}, () => {});
  const a = ST.byAuthor.get(s.author_id);
  if (a) {
    a.stories = a.stories.filter((x) => x.id !== s.id);
    if (!a.stories.length) {
      ST.byAuthor.delete(a.id);
      ST.feed = ST.feed.filter((x) => x.id !== a.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Ссылки на файлы
// ---------------------------------------------------------------------------

const SIGN_TTL = 3600;
const signed = new Map<string, { url: string; exp: number }>();
const local = new Map<string, string>();
let queue = new Map<string, { resolve: (u: string) => void; reject: (e: unknown) => void }[]>();
let queued = false;

export function cachedStoryUrl(path: string): string | null {
  const own = local.get(path);
  if (own) return own;
  const s = signed.get(path);
  return s && s.exp - Date.now() > 5 * 60_000 ? s.url : null;
}

/** Временная ссылка на файл истории. Запросы одного тика склеиваются в один createSignedUrls. */
export function storyUrl(path: string): Promise<string> {
  const hit = cachedStoryUrl(path);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const list = queue.get(path) ?? [];
    list.push({ resolve, reject });
    queue.set(path, list);
    if (!queued) {
      queued = true;
      setTimeout(flush, 0);
    }
  });
}

async function flush(): Promise<void> {
  const batch = queue;
  queue = new Map();
  queued = false;
  try {
    const { data, error } = await sb.storage.from('stories').createSignedUrls([...batch.keys()], SIGN_TTL);
    if (error) throw error;
    const exp = Date.now() + SIGN_TTL * 1000;
    for (const row of data ?? []) if (row.path && row.signedUrl) signed.set(row.path, { url: row.signedUrl, exp });
    for (const [path, waiters] of batch) {
      const url = signed.get(path)?.url;
      waiters.forEach((w) => (url ? w.resolve(url) : w.reject(new Error('История недоступна'))));
    }
  } catch (e) {
    batch.forEach((ws) => ws.forEach((w) => w.reject(e)));
  }
}

// ---------------------------------------------------------------------------
// Публикация
// ---------------------------------------------------------------------------

/** Подготовленный файл: сжатое фото или видео как есть, плюс превью 360 px. */
export type StoryFile = {
  kind: 'photo' | 'video';
  main: Blob;
  mime: string;
  ext: string;
  thumb: Blob;
  w: number;
  h: number;
  durMs: number | null;
  /** Ссылка для предпросмотра (освободить через releaseStoryFile). */
  preview: string;
};

export class StoryError extends Error {}

function canvasOf(src: CanvasImageSource, sw: number, sh: number, maxW: number, maxH: number): HTMLCanvasElement {
  const k = Math.min(1, maxW / sw, maxH / sh);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * k));
  c.height = Math.max(1, Math.round(sh * k));
  const ctx = c.getContext('2d');
  if (!ctx) throw new StoryError('Браузер не смог обработать картинку.');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

function toBlob(c: HTMLCanvasElement, type: string, q: number): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new StoryError('Не получилось сжать картинку.'))), type, q));
}

function waitFor(target: EventTarget, ok: string, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { done(); reject(new Error('timeout')); }, ms);
    const good = () => { done(); resolve(); };
    const bad = () => { done(); reject(new Error('media error')); };
    const done = () => { clearTimeout(t); target.removeEventListener(ok, good); target.removeEventListener('error', bad); };
    target.addEventListener(ok, good, { once: true });
    target.addEventListener('error', bad, { once: true });
  });
}

/** Фото — до 1080×1920 (WebP или JPEG), видео — как есть, до 60 секунд и 50 МБ. Метаданные (EXIF) у фото не сохраняются. */
export async function prepareStoryFile(file: File): Promise<StoryFile> {
  if (file.size > FILE_MAX) throw new StoryError('Файл слишком большой: можно до 50 МБ.');
  if (file.type.startsWith('image/') && file.type !== 'image/svg+xml') {
    let img: ImageBitmap | HTMLImageElement;
    try {
      img = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      const url = URL.createObjectURL(file);
      try {
        const i = new Image();
        i.src = url;
        await i.decode();
        img = i;
      } catch {
        throw new StoryError('Эту картинку браузер открыть не смог.');
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    const sw = 'naturalWidth' in img ? img.naturalWidth : img.width;
    const sh = 'naturalHeight' in img ? img.naturalHeight : img.height;
    if (!sw || !sh) throw new StoryError('Пустая картинка.');
    const big = canvasOf(img, sw, sh, 1080, 1920);
    let main = await toBlob(big, 'image/webp', 0.86);
    let mime = 'image/webp';
    let ext = 'webp';
    // Safari и старые браузеры WebP не кодируют — тогда JPEG.
    if (main.type !== 'image/webp') { main = await toBlob(big, 'image/jpeg', 0.86); mime = 'image/jpeg'; ext = 'jpg'; }
    const thumb = await toBlob(canvasOf(img, sw, sh, 360, 640), 'image/jpeg', 0.75);
    if ('close' in img) img.close();
    return { kind: 'photo', main, mime, ext, thumb, w: big.width, h: big.height, durMs: null, preview: URL.createObjectURL(main) };
  }
  if (file.type.startsWith('video/')) {
    const mime = file.type === 'video/quicktime' ? 'video/quicktime' : file.type === 'video/webm' ? 'video/webm' : 'video/mp4';
    const ext = mime === 'video/quicktime' ? 'mov' : mime === 'video/webm' ? 'webm' : 'mp4';
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = url;
    try {
      await waitFor(v, 'loadeddata', 12_000);
      if (!v.videoWidth || !v.videoHeight) throw new Error('no video');
    } catch {
      URL.revokeObjectURL(url);
      throw new StoryError('Это видео браузер воспроизвести не может. Попробуйте MP4 (H.264).');
    }
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    if (dur > STORY_VIDEO_MAX_S + 0.5) {
      URL.revokeObjectURL(url);
      throw new StoryError(`Видео в истории — до ${STORY_VIDEO_MAX_S} секунд. Это длится ${Math.round(dur)} с.`);
    }
    const at = Math.min(0.5, dur / 3);
    if (at > 0.05) {
      v.currentTime = at;
      await waitFor(v, 'seeked', 5000).catch(() => {});
    }
    const thumb = await toBlob(canvasOf(v, v.videoWidth, v.videoHeight, 360, 640), 'image/jpeg', 0.75);
    const w = v.videoWidth;
    const h = v.videoHeight;
    v.removeAttribute('src');
    v.load();
    return { kind: 'video', main: file, mime, ext, thumb, w, h, durMs: Math.round(dur * 1000), preview: url };
  }
  throw new StoryError('В историю можно выложить фото или видео.');
}

export function releaseStoryFile(f: StoryFile | null): void {
  if (f) URL.revokeObjectURL(f.preview);
}

async function accessToken(): Promise<string> {
  const { data } = await sb.auth.getSession();
  return data.session?.access_token ?? SUPABASE_KEY;
}

/** Загрузка с прогрессом (fetch его не показывает). */
function upload(path: string, blob: Blob, mime: string, token: string, onProgress: (n: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${SUPABASE_URL}/storage/v1/object/stories/${path.split('/').map(encodeURIComponent).join('/')}`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('apikey', SUPABASE_KEY);
    xhr.setRequestHeader('Content-Type', mime);
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.setRequestHeader('cache-control', 'max-age=86400');
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { resolve(); return; }
      if (xhr.status === 409 || /Duplicate|already exists/i.test(xhr.responseText)) { resolve(); return; }
      if (xhr.status === 413 || /too large|exceeded the maximum/i.test(xhr.responseText)) {
        reject(new StoryError('Файл слишком большой: можно до 50 МБ.'));
        return;
      }
      reject(new StoryError(xhr.status === 403 || xhr.status === 400 ? 'Сервер не принял файл истории.' : 'Не получилось загрузить файл.'));
    };
    xhr.onerror = () => reject(new StoryError('Нет связи с сервером.'));
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}

export type NewStory =
  | { kind: 'text'; body: string; bg: number }
  | { kind: 'media'; file: StoryFile; caption: string };

/** Выложить историю. onProgress — доля загруженного (0…1) для фото и видео. */
export async function publishStory(me: string, s: NewStory, onProgress: (p: number) => void, signal: AbortSignal): Promise<string> {
  const id = uuid();
  let kind: StoryKind;
  const args = {
    p_id: id, p_kind: 'text' as StoryKind, p_media_path: null as string | null, p_thumb_path: null as string | null,
    p_media_mime: null as string | null, p_w: null as number | null, p_h: null as number | null,
    p_duration_ms: null as number | null, p_body: null as string | null, p_bg: null as number | null,
  };
  if (s.kind === 'text') {
    kind = 'text';
    args.p_body = s.body;
    args.p_bg = s.bg;
  } else {
    const f = s.file;
    kind = f.kind;
    const main = `${me}/${id}.${f.ext}`;
    const thumb = `${me}/${id}_t.jpg`;
    const total = f.main.size + f.thumb.size;
    let doneThumb = 0;
    const token = await accessToken();
    await upload(thumb, f.thumb, 'image/jpeg', token, (n) => { doneThumb = n; onProgress(n / total); }, signal);
    doneThumb = f.thumb.size;
    await upload(main, f.main, f.mime, token, (n) => onProgress((doneThumb + n) / total), signal);
    onProgress(1);
    Object.assign(args, {
      p_media_path: main, p_thumb_path: thumb, p_media_mime: f.mime, p_w: f.w, p_h: f.h,
      p_duration_ms: f.kind === 'video' ? f.durMs : null, p_body: s.caption.trim() || null,
    });
    // Свои файлы показываем из памяти — не скачиваем заново.
    local.set(main, URL.createObjectURL(f.main));
    local.set(thumb, URL.createObjectURL(f.thumb));
  }
  args.p_kind = kind;
  const { error } = await sb.rpc('create_story', args);
  if (error) {
    if (args.p_media_path) void sb.storage.from('stories').remove([args.p_media_path, args.p_thumb_path!]).then(() => {}, () => {});
    throw error;
  }
  return id;
}

/** Сколько осталось жить истории: «23 ч», «15 мин». */
export function storyAge(s: Story): string {
  const ms = Date.now() - new Date(s.created_at).getTime();
  const min = Math.max(0, Math.floor(ms / 60000));
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч назад`;
  const d = new Date(s.created_at);
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}
