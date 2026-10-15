// Edge Function «bot-ai»: бот СКАМ отвечает нейросетью (с 0.4.2).
//
// POST — будильник из базы: человек написал боту, триггер private.bot_reply поставил задание
//        в очередь и через pg_net позвал функцию. Тело не важно: функция сама берёт задания
//        (public.bot_ai_claim), спрашивает модель и пишет ответ (public.bot_ai_finish).
//        Отвечает сразу 202, работа идёт в фоне. Чужой вызов безопасен — он лишь ускоряет
//        обработку уже стоящих в очереди сообщений; посторонний текст функция не принимает.
// GET  — { ok, ready } для проверки, что функция выложена.
//
// Модель — любая с API как у OpenAI (POST <base_url>chat/completions, Authorization: Bearer <ключ>);
// по умолчанию Google Gemini. Google не пускает в Gemini API из России, поэтому запрос может идти
// через посредника (relay_url — веб-приложение Google Apps Script, server/gemini-relay.gs):
// ему уходит { key, path, body }, он отвечает { status, body }.
// Настройки — private.bot_ai_settings (ключ, модели по очереди, посредник); переменные окружения
// AI_API_KEY, AI_BASE_URL, AI_RELAY_URL, AI_MODELS (через запятую), если заданы, важнее таблицы.
// SUPABASE_URL и служебный ключ подставляет сама среда функций.
//
// Время: на своём сервере экземпляр функции живёт не дольше минуты (workerTimeoutMs в main/index.ts
// self-hosted Supabase) и обслуживает несколько запросов подряд. Поэтому функция считает свой возраст:
// новое задание берёт, только пока молода, а модель ждёт не дольше, чем ей осталось жить. Задание,
// которое всё же оборвалось, через 65 секунд снова отдаёт bot_ai_claim — его будит pg_cron.

import { FAIL_TEXT, type ChatMsg, type Hist, plain, split, systemPrompt, toChat } from './text.ts';

const env = (k: string) => Deno.env.get(k)?.trim() || undefined;

function pickKey(legacy: string, modern: string): string {
  const k = env(legacy);
  if (k) return k;
  try {
    const all = JSON.parse(env(modern) ?? '{}') as Record<string, string>;
    return all.default ?? Object.values(all)[0] ?? '';
  } catch {
    return '';
  }
}

const SUPABASE_URL = env('SUPABASE_URL') ?? '';
const SERVICE_KEY = pickKey('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEYS');
/** Когда родился этот экземпляр функции и сколько ему дают жить (AI_WORKER_MS, по умолчанию 55 с). */
const BORN = Date.now();
const LIFE_MS = Number(env('AI_WORKER_MS')) || 55_000;
/** Новое задание берём, только если до конца жизни экземпляра остаётся хотя бы столько. */
const JOB_MIN_MS = 25_000;
/** Одна попытка у модели — не дольше. */
const TRY_MS = 25_000;
const left = () => BORN + LIFE_MS - Date.now();

type Settings = {
  label?: string; base_url?: string; relay_url?: string | null; api_key?: string | null;
  models?: string[]; reasoning?: string | null; temperature?: number | null;
};
type Claim = {
  job: string; skip?: boolean; off?: boolean; chat?: string; name?: string | null; today?: string;
  history?: Hist[]; settings?: Settings;
};
type Cfg = { label: string; base: string; relay: string | null; key: string; models: string[]; reasoning: string | null; temperature: number | null };
type Answer =
  | { ok: true; text: string; model: string; tokens: number | null }
  | { ok: false; code: keyof typeof FAIL_TEXT; detail: string };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

function adminHeaders(): Record<string, string> {
  const h: Record<string, string> = { apikey: SERVICE_KEY, 'Content-Type': 'application/json' };
  // Старые ключи (JWT) передаются и в Authorization; новые sb_secret_… — только в apikey.
  if (SERVICE_KEY.startsWith('eyJ')) h.Authorization = `Bearer ${SERVICE_KEY}`;
  return h;
}

async function rpc<T>(fn: string, args: unknown): Promise<{ ok: boolean; status: number; data: T | null; text: string }> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: adminHeaders(), body: JSON.stringify(args), signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let data: T | null = null;
  try { data = text ? JSON.parse(text) as T : null; } catch { /* не JSON */ }
  return { ok: res.ok, status: res.status, data, text };
}

function config(s: Settings = {}): Cfg {
  const base = env('AI_BASE_URL') ?? s.base_url ?? 'https://generativelanguage.googleapis.com/v1beta/openai/';
  const models = (env('AI_MODELS')?.split(',') ?? s.models ?? ['gemini-flash-latest']).map((m) => m.trim()).filter(Boolean);
  return {
    label: s.label || 'Google Gemini',
    base: base.endsWith('/') ? base : base + '/',
    relay: env('AI_RELAY_URL') ?? (s.relay_url?.trim() || null),
    key: env('AI_API_KEY') ?? s.api_key?.trim() ?? '',
    models: models.length ? models : ['gemini-flash-latest'],
    reasoning: s.reasoning ?? null,
    temperature: typeof s.temperature === 'number' ? s.temperature : s.temperature != null ? Number(s.temperature) : null,
  };
}

/** Запрос к модели — напрямую или через посредника. Ответ: код и тело провайдера. */
async function post(cfg: Cfg, path: string, body: unknown, ms: number): Promise<{ status: number; text: string }> {
  const until = Date.now() + ms;
  if (!cfg.relay) {
    const res = await fetch(cfg.base + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });
    return { status: res.status, text: await res.text() };
  }
  let last = '';
  for (let attempt = 0; attempt < 2 && until - Date.now() > 3000; attempt++) {
    // Apps Script отвечает переадресацией 302 на результат — fetch идёт за ней сам (уже GET).
    const res = await fetch(cfg.relay, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: cfg.key, path, body }),
      redirect: 'follow',
      signal: AbortSignal.timeout(until - Date.now()),
    });
    const text = await res.text();
    try {
      const w = JSON.parse(text) as { status?: unknown; body?: unknown };
      if (typeof w.status === 'number' && typeof w.body === 'string') return { status: w.status, text: w.body };
    } catch { /* не JSON — страница Google или ошибка Apps Script */ }
    last = `relay ${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 200)}`;
  }
  return { status: 502, text: JSON.stringify({ error: { message: last } }) };
}

type Completion = {
  model?: string;
  usage?: { total_tokens?: number };
  choices?: { message?: { content?: unknown }; finish_reason?: string }[];
  error?: { message?: string; status?: string };
};

function parse(text: string): Completion {
  try {
    const d = JSON.parse(text) as Completion | Completion[];
    return Array.isArray(d) ? d[0] ?? {} : d; // Gemini иногда заворачивает ошибку в массив
  } catch {
    return { error: { message: text.replace(/\s+/g, ' ').slice(0, 300) } };
  }
}

function contentOf(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : (p as { text?: string })?.text ?? '')).join('');
  return '';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Спросить модели по очереди: занята, нет квоты, молчит или модели больше нет — берём следующую.
 * Всё укладывается в оставшуюся жизнь экземпляра функции.
 */
async function ask(cfg: Cfg, messages: ChatMsg[]): Promise<Answer> {
  let last: Answer = { ok: false, code: 'error', detail: 'no models' };
  for (let round = 0; round < 2; round++) {
    for (const model of cfg.models) {
      const ms = Math.min(TRY_MS, left() - 2000);
      if (ms < 4000) return last.ok === false && last.code !== 'error' ? last : { ok: false, code: 'busy', detail: 'out of time' };
      const body: Record<string, unknown> = { model, messages };
      if (cfg.reasoning && !/^gemma/i.test(model)) body.reasoning_effort = cfg.reasoning;
      if (cfg.temperature != null) body.temperature = cfg.temperature;
      let r: { status: number; text: string };
      try {
        r = await post(cfg, 'chat/completions', body, ms);
      } catch (e) {
        console.warn(`bot-ai: ${model}: ${e instanceof Error ? e.name + ' ' + e.message : String(e)}`);
        last = { ok: false, code: 'busy', detail: `${model}: ${e instanceof Error ? e.message : String(e)}` };
        continue;
      }
      const d = parse(r.text);
      if (r.status === 200) {
        const choice = d.choices?.[0];
        const text = contentOf(choice?.message?.content).trim();
        if (text) return { ok: true, text, model: d.model ?? model, tokens: d.usage?.total_tokens ?? null };
        const reason = choice?.finish_reason ?? '';
        if (/content_filter|safety|prohibited|blocklist|recitation/i.test(reason)) return { ok: false, code: 'blocked', detail: `${model}: ${reason}` };
        last = { ok: false, code: 'error', detail: `${model}: empty (${reason})` };
        continue;
      }
      const msg = d.error?.message ?? '';
      const detail = `${model}: ${r.status} ${msg}`.slice(0, 400);
      if (/location is not supported/i.test(msg)) return { ok: false, code: 'location', detail };
      if (r.status === 401 || r.status === 403 || /api.?key|auth key|unauthenticated|permission/i.test(msg)) return { ok: false, code: 'key', detail };
      console.warn(`bot-ai: ${detail}`);
      if (r.status === 429) last = { ok: false, code: 'quota', detail };
      else if (r.status >= 500) last = { ok: false, code: 'busy', detail };
      else if (last.ok === false && last.code !== 'quota' && last.code !== 'busy') last = { ok: false, code: 'error', detail };
    }
    // Все заняты (503) — подождать и попробовать ещё раз, если успеваем; нет квоты — ждать бесполезно.
    if (last.ok || last.code !== 'busy' || left() < 15_000) break;
    await sleep(3000);
  }
  return last;
}

async function finish(job: string, parts: string[], status: 'done' | 'failed', model: string | null, error: string | null, tokens: number | null): Promise<void> {
  const r = await rpc<number>('bot_ai_finish', {
    p_job: job, p_parts: parts, p_status: status, p_model: model, p_error: error, p_tokens: tokens,
  });
  if (!r.ok) console.error('bot-ai: finish', r.status, r.text.slice(0, 300));
}

async function handle(c: Claim): Promise<void> {
  if (c.skip) return;
  if (c.off) return finish(c.job, [FAIL_TEXT.off], 'failed', null, 'off', null);
  const cfg = config(c.settings);
  if (!cfg.key) return finish(c.job, [FAIL_TEXT.key], 'failed', null, 'key: no api key', null);
  const chat = toChat(c.history ?? []);
  if (!chat.length) return finish(c.job, [], 'failed', null, 'empty history', null);
  const messages: ChatMsg[] = [{ role: 'system', content: systemPrompt(cfg.label, c.name ?? null, c.today ?? '') }, ...chat];
  const started = Date.now();
  const a = await ask(cfg, messages);
  if (a.ok) {
    const parts = split(plain(a.text));
    await finish(c.job, parts.length ? parts : [FAIL_TEXT.error], parts.length ? 'done' : 'failed', a.model, parts.length ? null : 'empty after cleanup', a.tokens);
    console.log(`bot-ai: ${c.job} ${a.model} ${a.tokens ?? '?'} tok ${Date.now() - started} ms`);
  } else {
    if (a.code === 'location' || a.code === 'key') console.error(`bot-ai: ${a.code} — ${a.detail}`);
    else console.warn(`bot-ai: ${a.code} — ${a.detail}`);
    await finish(c.job, [FAIL_TEXT[a.code] ?? FAIL_TEXT.error], 'failed', null, `${a.code}: ${a.detail}`, null);
  }
}

// Одна очередь на экземпляр функции: пока она идёт, новые будильники только просят пройти ещё круг.
let draining: Promise<void> | null = null;
let again = false;

async function drain(): Promise<void> {
  let n = 0;
  while (n < 20) {
    // Старому экземпляру новое задание не даём: не успеет — его подберёт следующий (pg_cron будит).
    if (left() < JOB_MIN_MS) return;
    again = false;
    const r = await rpc<Claim | null>('bot_ai_claim', {});
    if (!r.ok) { console.error('bot-ai: claim', r.status, r.text.slice(0, 300)); return; }
    if (!r.data) {
      if (again) continue;
      return;
    }
    n++;
    try {
      await handle(r.data);
    } catch (e) {
      console.error('bot-ai: job', r.data.job, e);
      await finish(r.data.job, [FAIL_TEXT.error], 'failed', null, `crash: ${e instanceof Error ? e.message : String(e)}`.slice(0, 400), null).catch(() => {});
    }
  }
}

export function wake(): Promise<void> {
  again = true;
  if (!draining) draining = drain().catch((e) => console.error('bot-ai: drain', e)).finally(() => { draining = null; });
  return draining;
}

Deno.serve((req) => {
  if (req.method === 'GET') return json({ ok: true, ready: !!(SUPABASE_URL && SERVICE_KEY) });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: 'server' }, 500);
  const work = wake();
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt?.waitUntil) {
    rt.waitUntil(work);
    return json({ ok: true }, 202);
  }
  return work.then(() => json({ ok: true }));
});
