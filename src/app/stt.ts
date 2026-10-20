// Расшифровка голосовых и кружочков (0.5.1), как в Telegram: кнопка «Aa» — и под записью появляется текст.
// Распознаёт нейросеть Whisper прямо на устройстве (stt-worker.ts): звук и текст никуда не отправляются,
// сквозное шифрование не нарушается. Модель (~77 или ~250 МБ) один раз скачивается с нашего сервера.
// Готовый текст хранится только на этом устройстве (IndexedDB), чтобы не распознавать заново.
import { SUPABASE_URL } from '../lib/supabase';
import { el, html, lsGet, lsSet } from '../lib/dom';
import { idbDel, idbGet, idbPut } from '../lib/idb';
import type { Msg } from './store';
import { mediaBlob } from './media';
import type { SttEvent, SttRequest } from './stt-worker';

export type SttModel = 'base' | 'small';
export const STT_MODELS: Record<SttModel, { id: string; label: string; sub: string; mb: number }> = {
  base: { id: 'whisper-base', label: 'Быстрая', sub: 'около 77 МБ, точность средняя', mb: 77 },
  small: { id: 'whisper-small', label: 'Точная', sub: 'около 250 МБ, медленнее в 3 раза', mb: 250 },
};
/** Языки записи. Whisper сам язык не угадывает (в этой сборке) — по умолчанию русский. */
export const STT_LANGS: [string, string][] = [
  ['russian', 'Русский'], ['english', 'English'], ['ukrainian', 'Українська'], ['belarusian', 'Беларуская'],
  ['kazakh', 'Қазақша'], ['tatar', 'Татарча'], ['german', 'Deutsch'], ['spanish', 'Español'],
];
const MODELS_CACHE = 'skam-models-v1';
const BASE = `${SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/public/models/`;
/** Длиннее — не расшифровываем (10 минут — предел голосового). */
const MAX_SEC = 11 * 60;

export type SttPrefs = { model: SttModel; lang: string };
export function sttPrefs(): SttPrefs {
  try {
    const p = JSON.parse(lsGet('skam:stt') ?? 'null') as Partial<SttPrefs> | null;
    return {
      model: p?.model === 'small' ? 'small' : 'base',
      lang: STT_LANGS.some(([k]) => k === p?.lang) ? p!.lang! : 'russian',
    };
  } catch {
    return { model: 'base', lang: 'russian' };
  }
}
export function setSttPrefs(p: SttPrefs): void {
  lsSet('skam:stt', JSON.stringify(p));
}

type State = {
  status: 'queued' | 'audio' | 'download' | 'prepare' | 'run' | 'done' | 'error';
  text: string;
  /** 0…1 — скачивание модели или распознавание. */
  pct: number;
  loaded?: number;
  total?: number;
  error?: string;
  open: boolean;
  lang: string;
  model: SttModel;
};
const states = new Map<string, State>();
const msgs = new Map<string, Msg>();
let worker: Worker | null = null;
let idleTimer = 0;
let busy = 0;

function lsKey(id: string): string {
  return `stt:${id}`;
}

function workerOf(): Worker {
  clearTimeout(idleTimer);
  if (worker) return worker;
  worker = new Worker(new URL('./stt-worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<SttEvent>) => onEvent(ev.data);
  worker.onerror = (ev) => {
    ev.preventDefault();
    states.forEach((st, id) => {
      if (st.status !== 'done' && st.status !== 'error') set(id, { status: 'error', error: 'Распознавание не запустилось в этом браузере' });
    });
    dropWorker();
  };
  return worker;
}

/** Модель в памяти — сотни мегабайт: через 3 минуты без работы освобождаем. */
function idle(): void {
  clearTimeout(idleTimer);
  if (busy > 0) return;
  idleTimer = window.setTimeout(dropWorker, 3 * 60_000);
}

function dropWorker(): void {
  worker?.terminate();
  worker = null;
  busy = 0;
}

function set(id: string, patch: Partial<State>): void {
  const st = states.get(id);
  if (!st) return;
  Object.assign(st, patch);
  paint(id);
}

function onEvent(e: SttEvent): void {
  const st = states.get(e.id);
  if (!st) return;
  switch (e.type) {
    case 'download':
      set(e.id, { status: 'download', loaded: e.loaded, total: e.total, pct: e.total ? e.loaded / e.total : 0 });
      break;
    case 'prepare':
      if (st.status !== 'run') set(e.id, { status: 'prepare', pct: 0 });
      break;
    case 'progress':
      set(e.id, { status: 'run', pct: e.total ? e.done / e.total : 0, text: e.text });
      break;
    case 'done': {
      busy = Math.max(0, busy - 1);
      set(e.id, { status: 'done', text: e.text, pct: 1 });
      void idbPut(lsKey(e.id), { text: e.text, lang: st.lang, model: st.model, at: Date.now() }).catch(() => {});
      idle();
      break;
    }
    case 'error':
      busy = Math.max(0, busy - 1);
      set(e.id, { status: 'error', error: e.error });
      idle();
      break;
  }
}

/** Звук записи → 16 кГц моно (как нужно Whisper). Кружочек — берём звуковую дорожку из видео. */
async function decode(blob: Blob): Promise<Float32Array> {
  const buf = await blob.arrayBuffer();
  const Ctx = window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!Ctx) throw new Error('Браузер не умеет разбирать звук');
  const probe = new Ctx(1, 1, 16000);
  const audio = await probe.decodeAudioData(buf);
  if (audio.duration > MAX_SEC) throw new Error('Слишком длинная запись');
  const out = new Ctx(1, Math.max(1, Math.ceil(audio.duration * 16000)), 16000);
  const src = out.createBufferSource();
  src.buffer = audio;
  src.connect(out.destination);
  src.start();
  const r = await out.startRendering();
  return r.getChannelData(0);
}

async function start(m: Msg, st: State): Promise<void> {
  if (!m.media_path) { set(m.id, { status: 'error', error: 'Запись ещё не загрузилась' }); return; }
  set(m.id, { status: 'audio', pct: 0, text: '', error: undefined });
  let audio: Float32Array;
  try {
    audio = await decode(await mediaBlob(m.media_path));
  } catch (e) {
    set(m.id, { status: 'error', error: (e as Error)?.message || 'Не получилось открыть запись' });
    return;
  }
  busy += 1;
  const req: SttRequest = { type: 'run', id: m.id, audio, lang: st.lang, model: STT_MODELS[st.model].id, base: BASE };
  set(m.id, { status: 'queued' });
  workerOf().postMessage(req, [audio.buffer]);
}

/** Можно ли расшифровать: голосовое или кружочек, файл уже есть. */
export function canTranscribe(m: Msg, view: string): boolean {
  return (view === 'voice' || view === 'video_note') && !!m.media_path && !m.deleted_at && !m.locked && !m.failed;
}

/** «Aa»: показать текст (если уже есть — сразу) или запустить расшифровку; ещё раз — свернуть. */
export async function toggleTranscript(m: Msg): Promise<void> {
  msgs.set(m.id, m);
  const st = states.get(m.id);
  if (st && (st.status === 'done' || st.status === 'error')) {
    if (st.status === 'error') { st.open = true; void start(m, st); return; }
    set(m.id, { open: !st.open });
    return;
  }
  if (st) { set(m.id, { open: !st.open }); return; }
  const p = sttPrefs();
  const fresh: State = { status: 'queued', text: '', pct: 0, open: true, lang: p.lang, model: p.model };
  states.set(m.id, fresh);
  paint(m.id);
  const saved = await idbGet<{ text: string; lang: string; model: SttModel }>(lsKey(m.id)).catch(() => undefined);
  if (saved) {
    Object.assign(fresh, { status: 'done', text: saved.text, lang: saved.lang, model: saved.model, pct: 1 });
    paint(m.id);
    return;
  }
  void start(m, fresh);
}

/** Распознать заново (другой язык или модель из настроек). */
export function retranscribe(m: Msg): void {
  const p = sttPrefs();
  const st: State = { status: 'queued', text: '', pct: 0, open: true, lang: p.lang, model: p.model };
  states.set(m.id, st);
  void idbDel(lsKey(m.id)).catch(() => {});
  paint(m.id);
  void start(m, st);
}

// ---------------------------------------------------------------------------
// Вид: кнопка «Aa» и текст под записью. Лента перерисовывается целиком — состояние живёт здесь,
// а при каждом изменении обновляем уже стоящие на странице элементы.
// ---------------------------------------------------------------------------

const TEXT_IC = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 18L7.5 6 12 18M4.6 14h5.8"/><path d="M15 9h6M15 13.5h6M15 18h4"/></svg>';

function langLabel(k: string): string {
  return STT_LANGS.find(([id]) => id === k)?.[1] ?? k;
}

function mb(n?: number): string {
  return n ? `${Math.round(n / 1048576)}` : '0';
}

/** Кнопка «Aa» у голосового или кружочка. */
export function transcriptButton(m: Msg): HTMLButtonElement {
  msgs.set(m.id, m);
  const b = el('button', 'stt-btn');
  b.type = 'button';
  b.dataset.stt = m.id;
  b.append(html(TEXT_IC));
  b.addEventListener('click', (ev) => { ev.stopPropagation(); void toggleTranscript(m); });
  paintButton(b, states.get(m.id));
  return b;
}

function paintButton(b: HTMLElement, st: State | undefined): void {
  const working = !!st && st.status !== 'done' && st.status !== 'error';
  b.classList.toggle('on', !!st?.open);
  b.classList.toggle('busy', working);
  const label = st?.open ? 'Скрыть текст' : st?.status === 'done' ? 'Показать текст' : 'Расшифровать в текст';
  b.title = `${label} (распознаётся на устройстве)`;
  b.setAttribute('aria-label', label);
  b.setAttribute('aria-expanded', String(!!st?.open));
}

/** Текст под записью (пустой элемент, пока его не открыли). */
export function transcriptBox(m: Msg): HTMLElement {
  msgs.set(m.id, m);
  const box = el('div', 'stt-box');
  box.dataset.sttBox = m.id;
  fillBox(box, m.id);
  return box;
}

function fillBox(box: HTMLElement, id: string): void {
  const st = states.get(id);
  box.hidden = !st?.open;
  if (!st?.open) { box.replaceChildren(); return; }
  const parts: Node[] = [];
  const line = (t: string) => el('span', 'stt-st', t);
  switch (st.status) {
    case 'queued': case 'audio': parts.push(line('Готовим запись…')); break;
    case 'download':
      parts.push(line(`Загружаем модель распознавания (качается один раз): ${Math.round(st.pct * 100)}% · ${mb(st.loaded)} из ${mb(st.total)} МБ`));
      break;
    case 'prepare': parts.push(line('Запускаем распознавание…')); break;
    case 'run':
      if (st.text) parts.push(el('span', 'stt-text', st.text));
      parts.push(line(`Расшифровываем… ${Math.round(st.pct * 100)}%`));
      break;
    case 'done':
      parts.push(el('span', 'stt-text', st.text || 'Речь не распознана — возможно, в записи тишина или музыка.'));
      break;
    case 'error': {
      const err = el('span', 'stt-st err', `Не получилось расшифровать: ${(st.error ?? '').replace(/\.$/, '')}.`);
      const again = el('button', 'stt-link', 'Повторить');
      again.type = 'button';
      again.addEventListener('click', (ev) => { ev.stopPropagation(); const m = msgs.get(id); if (m) retranscribe(m); });
      parts.push(err, again);
      break;
    }
  }
  if (st.status === 'download' || st.status === 'run') {
    const bar = el('span', 'stt-bar');
    const fill = el('i');
    fill.style.width = `${Math.round(st.pct * 100)}%`;
    bar.append(fill);
    parts.push(bar);
  }
  if (st.status === 'done') {
    const foot = el('span', 'stt-foot', `Распознано на устройстве · ${langLabel(st.lang)}`);
    const p = sttPrefs();
    if (p.lang !== st.lang || p.model !== st.model) {
      const again = el('button', 'stt-link', 'Распознать заново');
      again.type = 'button';
      again.title = `С настройками: ${langLabel(p.lang)}, ${STT_MODELS[p.model].label.toLowerCase()} модель`;
      again.addEventListener('click', (ev) => { ev.stopPropagation(); const m = msgs.get(id); if (m) retranscribe(m); });
      foot.append(' · ', again);
    }
    parts.push(foot);
  }
  box.replaceChildren(...parts);
}

function paint(id: string): void {
  const st = states.get(id);
  document.querySelectorAll<HTMLElement>(`.stt-btn[data-stt="${CSS.escape(id)}"]`).forEach((b) => paintButton(b, st));
  document.querySelectorAll<HTMLElement>(`.stt-box[data-stt-box="${CSS.escape(id)}"]`).forEach((b) => fillBox(b, id));
}

// ---------------------------------------------------------------------------
// Настройки: скачанная модель
// ---------------------------------------------------------------------------

/** Сколько места занимают скачанные модели (байты по моделям). */
export async function modelUsage(): Promise<Record<SttModel, number>> {
  const out: Record<SttModel, number> = { base: 0, small: 0 };
  if (!('caches' in window)) return out;
  try {
    const cache = await caches.open(MODELS_CACHE);
    for (const req of await cache.keys()) {
      const which = (Object.keys(STT_MODELS) as SttModel[]).find((k) => req.url.includes(`/models/${STT_MODELS[k].id}/`));
      if (!which) continue;
      const res = await cache.match(req);
      out[which] += Number(res?.headers.get('content-length') ?? 0);
    }
  } catch { /* нет доступа к кэшу — покажем ноль */ }
  return out;
}

/** Удалить скачанную модель с устройства (в следующий раз скачается заново). */
export async function dropModel(model: SttModel): Promise<void> {
  if (!('caches' in window)) return;
  const cache = await caches.open(MODELS_CACHE);
  for (const req of await cache.keys()) if (req.url.includes(`/models/${STT_MODELS[model].id}/`)) await cache.delete(req);
  dropWorker();
}

/** Выход из аккаунта: забыть расшифровки, которые на экране. */
export function resetStt(): void {
  states.clear();
  msgs.clear();
  dropWorker();
}
