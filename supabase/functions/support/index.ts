// Edge Function «support»: обращение из кнопки «Поддержка» → письмо на ящик СКАМ.
//
// 1. Обращение сохраняется от имени человека (support_submit — там же проверки и лимиты).
// 2. Письмо уходит с ящика СКАМ на него же (тот же ящик, с которого приходят коды для входа);
//    Reply-To — почта человека, так что ответить можно обычной кнопкой «Ответить».
// 3. Если письмо не ушло, обращение остаётся в базе и досылается при следующем удачном письме.
//
// Секреты (Supabase → Edge Functions → Secrets):
//   SMTP_PASS  — обязательно: пароль приложения Яндекса (тот же, что в Auth → SMTP Settings);
//   SMTP_USER  — ящик, по умолчанию skam.messenger@yandex.com;
//   SMTP_HOST / SMTP_PORT — по умолчанию smtp.yandex.ru:465;
//   SUPPORT_TO — куда слать, по умолчанию тот же ящик.
// SUPABASE_URL и ключи Supabase подставляет сама.

import { letterOf, cleanMeta, subjectOf, type SupportRow } from './letter.ts';
import { SmtpSession, type Mail, type SmtpConfig } from './smtp.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

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
const ANON_KEY = pickKey('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEYS');
const SERVICE_KEY = pickKey('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEYS');

const SMTP: SmtpConfig = {
  host: env('SMTP_HOST') ?? 'smtp.yandex.ru',
  port: Number(env('SMTP_PORT') ?? 465),
  user: env('SMTP_USER') ?? 'skam.messenger@yandex.com',
  pass: env('SMTP_PASS') ?? '',
  timeoutMs: 20_000,
};
const SUPPORT_TO = env('SUPPORT_TO') ?? SMTP.user;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

type RpcResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; message: string };

async function rpc<T>(fn: string, args: unknown, auth: { apikey: string; bearer?: string }): Promise<RpcResult<T>> {
  const headers: Record<string, string> = { apikey: auth.apikey, 'Content-Type': 'application/json' };
  // Старые ключи (JWT) передаются и в Authorization; новые sb_secret_… — только в apikey.
  const bearer = auth.bearer ?? (auth.apikey.startsWith('eyJ') ? `Bearer ${auth.apikey}` : undefined);
  if (bearer) headers.Authorization = bearer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (res.ok) return { ok: true, data: data as T };
  const e = (data ?? {}) as { code?: string; message?: string };
  return { ok: false, status: res.status, code: e.code ?? String(res.status), message: e.message ?? 'Ошибка сервера' };
}

const admin = <T>(fn: string, args: unknown) => rpc<T>(fn, args, { apikey: SERVICE_KEY });

function mailOf(r: SupportRow): Mail {
  const { text, html } = letterOf(r);
  return {
    from: SMTP.user,
    fromName: 'СКАМ · Поддержка',
    to: SUPPORT_TO,
    replyTo: r.email,
    replyToName: r.name,
    subject: subjectOf(r),
    text,
    html,
    messageId: `<support-${r.id}@${SMTP.user.split('@')[1] ?? 'skam.local'}>`,
  };
}

/** Отправляет обращения одним сеансом SMTP. Возвращает, сколько ушло. */
async function deliver(rows: SupportRow[], session?: SmtpSession): Promise<{ sent: string[]; error: string | null }> {
  const sent: string[] = [];
  let s = session;
  try {
    s ??= await SmtpSession.open(SMTP);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    for (const r of rows) await admin('support_mark', { p_id: r.id, p_error: msg });
    return { sent, error: msg };
  }
  let lastErr: string | null = null;
  for (const r of rows) {
    try {
      await s.send(mailOf(r));
      sent.push(r.id);
      await admin('support_mark', { p_id: r.id, p_error: null });
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      await admin('support_mark', { p_id: r.id, p_error: lastErr });
    }
  }
  if (!session) await s.quit();
  return { sent, error: lastErr };
}

/** Досылаем то, что не ушло раньше (например, пока не был задан пароль SMTP). */
async function backlog(): Promise<void> {
  const rows = await admin<SupportRow[]>('support_claim', { p_id: null, p_limit: 5 });
  if (!rows.ok || !rows.data.length) return;
  const { sent, error } = await deliver(rows.data);
  console.log(`support backlog: sent ${sent.length}/${rows.data.length}${error ? `, error: ${error}` : ''}`);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Только POST' }, 405);
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) return json({ error: 'Функция не настроена' }, 500);

  const authz = req.headers.get('Authorization') ?? '';
  if (!/^Bearer\s+\S+$/.test(authz)) return json({ error: 'Войдите в аккаунт' }, 401);

  let input: { topic?: unknown; text?: unknown; meta?: unknown };
  try {
    input = await req.json();
  } catch {
    return json({ error: 'Неверный запрос' }, 400);
  }
  const topic = typeof input.topic === 'string' ? input.topic : '';
  const text = typeof input.text === 'string' ? input.text : '';
  if (text.length > 8000) return json({ error: 'Слишком длинно: не больше 4000 символов' }, 400);

  // 1. Сохраняем от имени человека: сервер сам проверит вход, регистрацию, тему, длину и лимиты.
  const made = await rpc<{ id: string; no: string; email: string | null }>(
    'support_submit',
    { p_topic: topic, p_body: text, p_meta: cleanMeta(input.meta) },
    { apikey: ANON_KEY, bearer: authz },
  );
  if (!made.ok) {
    const status = made.code === '54000' ? 429 : made.status === 401 || made.code.startsWith('PGRST3') ? 401 : made.status >= 500 ? 502 : made.status;
    return json({ error: made.message, code: made.code }, status);
  }
  const { id, no, email } = made.data;

  // 2. Письмо.
  if (!SMTP.pass) {
    console.warn('support: секрет SMTP_PASS не задан — обращение сохранено без письма');
    return json({ ok: true, id, no, email, mailed: false });
  }
  const claimed = await admin<SupportRow[]>('support_claim', { p_id: id, p_limit: 1 });
  if (!claimed.ok || !claimed.data.length) {
    console.error('support: не удалось забрать обращение', claimed);
    return json({ ok: true, id, no, email, mailed: false });
  }
  const { sent, error } = await deliver(claimed.data);
  if (error) console.error(`support #${no}: ${error}`);

  // 3. Раз почта работает — досылаем старые, уже после ответа.
  if (sent.length) {
    const job = backlog().catch((e) => console.error('support backlog', e));
    (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime?.waitUntil(job);
  }
  return json({ ok: true, id, no, email, mailed: sent.length > 0 });
});
