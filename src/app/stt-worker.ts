// Расшифровка голосовых (0.5.1): нейросеть Whisper прямо в браузере (transformers.js + onnxruntime-web, WASM).
// Голос никуда не уходит: сюда приходит уже расшифрованный звук (16 кГц, моно), отсюда — только текст.
//
// Модель лежит на нашем сервере (публичный бакет models): Hugging Face из России не открывается.
// Файлы больше 40 МБ разрезаны на части — их склеиваем здесь же, сверяя SHA-256 каждой части
// (список и суммы — models/<модель>/manifest.json). Собранные файлы transformers.js кладёт в Cache Storage
// «skam-models-v1» — второй раз модель не качается.

import { env, pipeline } from '@huggingface/transformers';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import mjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';

export type SttRequest =
  | { type: 'run'; id: string; audio: Float32Array; lang: string; model: string; base: string }
  | { type: 'cancel'; id: string };

export type SttEvent =
  | { type: 'download'; id: string; loaded: number; total: number }
  | { type: 'prepare'; id: string }
  | { type: 'progress'; id: string; done: number; total: number; text: string }
  | { type: 'done'; id: string; text: string }
  | { type: 'error'; id: string; error: string };

type FileInfo = { size: number; sha256: string; type?: string; parts?: { name: string; size: number; sha256: string }[] };
type Manifest = { model: string; files: Record<string, FileInfo> };

const post = (e: SttEvent) => (self as unknown as { postMessage(m: unknown): void }).postMessage(e);

const SR = 16000;
let base = '';
const manifests = new Map<string, Promise<Manifest>>();

function manifest(model: string): Promise<Manifest> {
  let p = manifests.get(model);
  if (!p) {
    p = fetch(`${base}${model}/manifest.json`, { cache: 'no-cache' }).then(async (r) => {
      if (!r.ok) throw new Error(`Модель распознавания недоступна на сервере (${r.status})`);
      return r.json() as Promise<Manifest>;
    });
    p.catch(() => manifests.delete(model));
    manifests.set(model, p);
  }
  return p;
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Файл модели целиком: части по очереди, каждая сверяется по SHA-256. Отдаём потоком — видно прогресс. */
function assemble(model: string, path: string, f: FileInfo): Response {
  const parts = f.parts ?? [{ name: path, size: f.size, sha256: f.sha256 }];
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      try {
        for (const part of parts) {
          const res = await fetch(`${base}${model}/${part.name}`);
          if (!res.ok || !res.body) throw new Error(`Не получилось скачать модель (${res.status})`);
          const reader = res.body.getReader();
          const chunks: Uint8Array[] = [];
          let n = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            n += value.length;
            ctrl.enqueue(value);
          }
          if (n !== part.size) throw new Error('Модель скачалась не полностью — попробуйте ещё раз');
          const all = new Uint8Array(n);
          let at = 0;
          for (const c of chunks) { all.set(c, at); at += c.length; }
          if (hex(await crypto.subtle.digest('SHA-256', all)) !== part.sha256) {
            throw new Error('Файл модели повреждён — попробуйте ещё раз');
          }
        }
        ctrl.close();
      } catch (e) {
        ctrl.error(e);
      }
    },
  });
  return new Response(stream, { headers: { 'content-length': String(f.size), 'content-type': f.type ?? 'application/octet-stream' } });
}

/** Вместо обычного fetch для файлов модели: наш сервер, части, проверка сумм. Остальное — как есть. */
async function modelFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!base || !url.startsWith(base)) return fetch(input, init);
  const rel = url.slice(base.length).split('?')[0];
  const slash = rel.indexOf('/');
  const model = rel.slice(0, slash);
  const path = decodeURIComponent(rel.slice(slash + 1));
  const man = await manifest(model);
  const f = man.files[path];
  if (!f) return new Response('', { status: 404 });
  // transformers.js сначала спрашивает размер (Range: bytes=0-0) — ответим из списка, ничего не скачивая.
  if (new Headers(init?.headers).has('Range')) {
    return new Response(new Uint8Array(1), {
      status: 206, headers: { 'content-range': `bytes 0-0/${f.size}`, 'content-length': '1', 'content-type': f.type ?? 'application/octet-stream' },
    });
  }
  return assemble(model, path, f);
}

env.allowLocalModels = false;
env.useBrowserCache = true;
env.cacheKey = 'skam-models-v1';
env.remotePathTemplate = '{model}/';
env.fetch = modelFetch as typeof fetch;
const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number; proxy?: boolean } };
if (onnx.wasm) {
  // WASM — свой, из нашей сборки (без CDN). Потоки нужны cross-origin isolation — её нет, считаем в одном.
  onnx.wasm.wasmPaths = { wasm: wasmUrl, mjs: mjsUrl };
  onnx.wasm.numThreads = 1;
}

type Asr = (audio: Float32Array, o: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;
let asr: Asr | null = null;
let asrModel = '';
let loading: Promise<Asr> | null = null;

async function load(model: string, id: string): Promise<Asr> {
  if (asr && asrModel === model) return asr;
  if (loading && asrModel === model) return loading;
  asrModel = model;
  // Сколько всего качать — из списка файлов модели (прогресс — от полного размера, а не от первых мелких файлов).
  const man = await manifest(model);
  const whole = Object.values(man.files).reduce((n, f) => n + f.size, 0);
  const files = new Map<string, number>();
  let last = 0;
  loading = (pipeline('automatic-speech-recognition', model, {
    dtype: 'q8',
    device: 'wasm',
    // Полная оптимизация графа в этой сборке onnxruntime-web ломается на квантованном декодере Whisper.
    session_options: { graphOptimizationLevel: 'basic' },
    progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status === 'progress' && p.file) {
        files.set(p.file, p.loaded ?? 0);
        const now = Date.now();
        if (now - last < 150) return;
        last = now;
        let loaded = 0;
        files.forEach((n) => { loaded += n; });
        post({ type: 'download', id, loaded: Math.min(loaded, whole), total: whole });
      } else if (p.status === 'ready') {
        post({ type: 'prepare', id });
      }
    },
  } as never) as Promise<unknown>).then((fn) => {
    asr = fn as Asr;
    return asr;
  }, (e) => {
    asr = null;
    asrModel = '';
    throw e;
  }).finally(() => { loading = null; });
  return loading;
}

function rms(a: Float32Array, from: number, len: number): number {
  let s = 0;
  const to = Math.min(a.length, from + len);
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

/** Режем запись на куски до 28 секунд — по самому тихому месту, чтобы не разрезать слово. */
function cuts(a: Float32Array): [number, number][] {
  const max = 28 * SR, min = 16 * SR, win = Math.round(0.25 * SR), hop = Math.round(0.05 * SR);
  const out: [number, number][] = [];
  let start = 0;
  while (a.length - start > max) {
    let best = start + max, bestE = Infinity;
    for (let p = start + min; p + win <= start + max; p += hop) {
      const e = rms(a, p, win);
      if (e < bestE) { bestE = e; best = p + Math.round(win / 2); }
    }
    out.push([start, best]);
    start = best;
  }
  if (a.length - start > SR / 4 || !out.length) out.push([start, a.length]);
  return out;
}

// Whisper в тишине иногда «додумывает» титры из обучающих видео — такие строки выбрасываем.
const HALLUCINATIONS = [
  /^продолжение следует\.*$/i, /^субтитры (сделал|создавал|делал)/i, /^редактор субтитров/i, /^спасибо за просмотр\.?!?$/i,
  /^подписывайтесь на канал/i, /^thank you for watching\.?!?$/i, /^thanks for watching\.?!?$/i, /^\[?музыка\]?\.?$/i,
  /^♪+$/, /^\.+$/,
];
const clean = (t: string) => {
  const s = t.replace(/\s+/g, ' ').trim();
  return HALLUCINATIONS.some((re) => re.test(s)) ? '' : s;
};

const cancelled = new Set<string>();

async function run(req: Extract<SttRequest, { type: 'run' }>): Promise<void> {
  base = req.base;
  env.remoteHost = req.base;
  const fn = await load(req.model, req.id);
  post({ type: 'prepare', id: req.id });
  const parts = cuts(req.audio);
  let text = '';
  for (let i = 0; i < parts.length; i++) {
    if (cancelled.has(req.id)) { cancelled.delete(req.id); return; }
    const [s, e] = parts[i];
    const piece = req.audio.subarray(s, e);
    // Тишина — пропускаем (иначе модель выдумывает текст).
    if (rms(piece, 0, piece.length) > 0.004) {
      const out = await fn(piece, { language: req.lang, task: 'transcribe' });
      const t = clean(Array.isArray(out) ? out.map((x) => x.text).join(' ') : out.text);
      if (t) text = text ? `${text} ${t}` : t;
    }
    post({ type: 'progress', id: req.id, done: i + 1, total: parts.length, text });
  }
  post({ type: 'done', id: req.id, text });
}

let chain: Promise<void> = Promise.resolve();
self.onmessage = (ev: MessageEvent<SttRequest>) => {
  const req = ev.data;
  if (req.type === 'cancel') { cancelled.add(req.id); return; }
  chain = chain.then(() => run(req)).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    post({ type: 'error', id: req.id, error: msg });
  });
};
