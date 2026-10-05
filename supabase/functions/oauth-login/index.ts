// Edge Function «oauth-login»: вход через Яндекс ID и VK ID.
//
// GET  → какие провайдеры настроены: { providers: [{ id, clientId }] } — по нему экран входа
//        показывает кнопки. Не настроен ни один — кнопок нет.
// POST { provider, code, codeVerifier, redirectUri, deviceId?, state? }
//      → меняет код на профиль у провайдера, находит аккаунт СКАМ (по прежнему входу или по той же
//        почте) или создаёт новый и возвращает { tokenHash, isNew } — одноразовый токен, которым
//        браузер входит: supabase.auth.verifyOtp({ token_hash, type: 'magiclink' }).
//
// Переменные (на своём сервере — functions.environment в docker-compose.skam.yml,
// см. server/README.md; в облаке Supabase — Edge Functions → Secrets):
//   YANDEX_CLIENT_ID, YANDEX_CLIENT_SECRET — приложение на oauth.yandex.ru;
//   VK_CLIENT_ID — приложение VK ID на id.vk.ru (секрет не нужен: вход защищён PKCE);
//   OAUTH_REDIRECT_URLS — необязательно: адреса сайта через запятую,
//     по умолчанию https://skam-messenger.ru/ и http://localhost:5173/.
// SUPABASE_URL и ключи Supabase подставляет сама.
//
// Функция публичная (verify_jwt = false): ею пользуются до входа.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
const SERVICE_KEY = pickKey('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEYS');

type Provider = 'yandex' | 'vk';
const PROVIDERS: Provider[] = ['yandex', 'vk'];

const YANDEX = { clientId: env('YANDEX_CLIENT_ID'), secret: env('YANDEX_CLIENT_SECRET') };
const VK = { clientId: env('VK_CLIENT_ID') };

const REDIRECTS = (env('OAUTH_REDIRECT_URLS') ?? 'https://skam-messenger.ru/,http://localhost:5173/')
  .split(',').map((s) => s.trim()).filter(Boolean);

/** Служебный домен для аккаунтов, у которых провайдер не дал почту. */
const SERVICE_DOMAIN = 'oauth.skam.invalid';

function clientId(p: Provider): string | undefined {
  if (p === 'yandex') return YANDEX.clientId && YANDEX.secret ? YANDEX.clientId : undefined;
  return VK.clientId;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** Ошибка с кодом для экрана входа (тексты — на стороне сайта). */
class Fail extends Error {
  constructor(readonly code: string, readonly status = 400, detail?: string) {
    super(detail ?? code);
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

// ---------------------------------------------------------------------------
// Провайдеры
// ---------------------------------------------------------------------------

type Profile = {
  subject: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  avatar: string | null;
  nick: string | null;
};

async function postForm(url: string, params: Record<string, string>): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new Fail('provider_unavailable', 502, String(e));
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
  return { ok: res.ok, status: res.status, data };
}

/** Имя одной строкой → имя и фамилия. */
function splitName(full: string | null): [string | null, string | null] {
  const s = full?.replace(/\s+/g, ' ').trim();
  if (!s) return [null, null];
  const i = s.indexOf(' ');
  return i < 0 ? [s, null] : [s.slice(0, i), s.slice(i + 1)];
}

async function yandexProfile(code: string, verifier: string): Promise<Profile> {
  const t = await postForm('https://oauth.yandex.ru/token', {
    grant_type: 'authorization_code',
    code,
    client_id: YANDEX.clientId!,
    client_secret: YANDEX.secret!,
    code_verifier: verifier,
  });
  const token = str(t.data.access_token);
  if (!t.ok || !token) throw new Fail('provider_rejected', 400, `yandex token ${t.status}: ${JSON.stringify(t.data).slice(0, 300)}`);

  let res: Response;
  try {
    res = await fetch('https://login.yandex.ru/info?format=json', {
      headers: { Authorization: `OAuth ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new Fail('provider_unavailable', 502, String(e));
  }
  if (!res.ok) throw new Fail('provider_rejected', 400, `yandex info ${res.status}`);
  const u = await res.json() as Record<string, unknown>;
  const subject = str(String(u.id ?? ''));
  if (!subject) throw new Fail('provider_rejected', 400, 'yandex: no id');
  const emails = Array.isArray(u.emails) ? u.emails : [];
  let first = str(u.first_name);
  let last = str(u.last_name);
  if (!first) [first, last] = splitName(str(u.real_name) ?? str(u.display_name));
  const avatarId = str(u.default_avatar_id);
  return {
    subject,
    email: str(u.default_email) ?? str(emails[0]),
    firstName: first,
    lastName: last,
    avatar: avatarId && u.is_avatar_empty !== true
      ? `https://avatars.yandex.net/get-yapic/${encodeURIComponent(avatarId)}/islands-200`
      : null,
    nick: str(u.login),
  };
}

async function vkProfile(code: string, verifier: string, deviceId: string, redirectUri: string, state: string): Promise<Profile> {
  const t = await postForm('https://id.vk.ru/oauth2/auth', {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: VK.clientId!,
    device_id: deviceId,
    redirect_uri: redirectUri,
    state,
  });
  const token = str(t.data.access_token);
  if (!t.ok || !token) throw new Fail('provider_rejected', 400, `vk token ${t.status}: ${JSON.stringify(t.data).slice(0, 300)}`);

  const info = await postForm('https://id.vk.ru/oauth2/user_info', { client_id: VK.clientId!, access_token: token });
  const u = (info.data.user ?? {}) as Record<string, unknown>;
  const subject = str(String(u.user_id ?? t.data.user_id ?? ''));
  if (!info.ok || !subject) throw new Fail('provider_rejected', 400, `vk user_info ${info.status}: ${JSON.stringify(info.data).slice(0, 300)}`);
  const avatar = str(u.avatar);
  return {
    subject,
    email: str(u.email),
    firstName: str(u.first_name),
    lastName: str(u.last_name),
    avatar: avatar && avatar.startsWith('https://') ? avatar : null,
    nick: null,
  };
}

// ---------------------------------------------------------------------------
// Supabase: аккаунты
// ---------------------------------------------------------------------------

function adminHeaders(): Record<string, string> {
  const h: Record<string, string> = { apikey: SERVICE_KEY, 'Content-Type': 'application/json' };
  // Старые ключи (JWT) передаются и в Authorization; новые sb_secret_… — только в apikey.
  if (SERVICE_KEY.startsWith('eyJ')) h.Authorization = `Bearer ${SERVICE_KEY}`;
  return h;
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ ok: boolean; status: number; data: T & { code?: string; error_code?: string; msg?: string; message?: string } }> {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: adminHeaders(),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let data: unknown = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 300) }; }
  return { ok: res.ok, status: res.status, data: data as T & { code?: string; error_code?: string; msg?: string; message?: string } };
}

const rpc = <T>(fn: string, args: unknown) => call<T>(`/rest/v1/rpc/${fn}`, { method: 'POST', body: args });

type AuthUser = { id: string; email?: string | null; app_metadata?: Record<string, unknown>; banned_until?: string | null };

async function resolveUser(p: Provider, prof: Profile): Promise<string | null> {
  const r = await rpc<Record<string, never>>('oauth_resolve', { p_provider: p, p_subject: prof.subject, p_email: prof.email });
  if (!r.ok) throw new Fail('server', 500, `oauth_resolve ${r.status}: ${r.data.message}`);
  return (r.data as unknown as string | null) || null;
}

async function createUser(p: Provider, prof: Profile): Promise<AuthUser | null> {
  const email = prof.email ?? `${p}-${prof.subject}@${SERVICE_DOMAIN}`;
  const r = await call<AuthUser>('/auth/v1/admin/users', {
    method: 'POST',
    body: {
      email,
      email_confirm: true,
      // handle_new_user берёт отсюда имя и фамилию; фото и ник — подсказки на экране «Создание аккаунта».
      user_metadata: {
        first_name: prof.firstName?.slice(0, 40) ?? null,
        last_name: prof.lastName?.slice(0, 40) ?? null,
        avatar_url: prof.avatar,
        preferred_username: prof.nick,
        skam_oauth: p,
      },
      app_metadata: { skam_oauth: [p] },
    },
  });
  if (r.ok) return r.data;
  // Аккаунт с этой почтой появился только что (два входа одновременно) — найдём его ещё раз.
  if (r.data.error_code === 'email_exists' || /already (been )?registered/i.test(r.data.msg ?? r.data.message ?? '')) return null;
  throw new Fail('server', 500, `create user ${r.status}: ${r.data.msg ?? r.data.message}`);
}

async function getUser(id: string): Promise<AuthUser> {
  const r = await call<AuthUser>(`/auth/v1/admin/users/${id}`);
  if (!r.ok) throw new Fail('server', 500, `get user ${r.status}`);
  return r.data;
}

/** Отметить в app_metadata, что этим провайдером можно входить (для «Вход: …» в профиле). */
async function rememberProvider(u: AuthUser, p: Provider): Promise<void> {
  const list = Array.isArray(u.app_metadata?.skam_oauth) ? (u.app_metadata!.skam_oauth as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  if (list.includes(p)) return;
  const r = await call<AuthUser>(`/auth/v1/admin/users/${u.id}`, {
    method: 'PUT',
    body: { app_metadata: { ...(u.app_metadata ?? {}), skam_oauth: [...list, p] } },
  });
  if (!r.ok) console.error('remember provider', r.status, r.data.msg ?? r.data.message);
}

async function loginToken(email: string): Promise<string> {
  const r = await call<{ hashed_token?: string; properties?: { hashed_token?: string } }>('/auth/v1/admin/generate_link', {
    method: 'POST',
    body: { type: 'magiclink', email },
  });
  const hash = r.data.hashed_token ?? r.data.properties?.hashed_token;
  if (!r.ok || !hash) throw new Fail('server', 500, `generate_link ${r.status}: ${r.data.msg ?? r.data.message}`);
  return hash;
}

async function signIn(p: Provider, prof: Profile): Promise<{ tokenHash: string; isNew: boolean }> {
  let isNew = false;
  let uid = await resolveUser(p, prof);
  let user: AuthUser | null = null;
  if (!uid) {
    user = await createUser(p, prof);
    if (user) {
      isNew = true;
      uid = user.id;
    } else {
      uid = await resolveUser(p, prof);
      if (!uid) throw new Fail('server', 500, 'user vanished');
    }
  }
  user ??= await getUser(uid);
  if (!user.email) throw new Fail('no_email', 409);
  if (!isNew) await rememberProvider(user, p);
  const link = await rpc<Record<string, never>>('oauth_link', { p_provider: p, p_subject: prof.subject, p_user: uid });
  if (!link.ok) throw new Fail('server', 500, `oauth_link ${link.status}: ${link.data.message}`);
  return { tokenHash: await loginToken(user.email), isNew };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type Body = {
  provider?: unknown;
  code?: unknown;
  codeVerifier?: unknown;
  redirectUri?: unknown;
  deviceId?: unknown;
  state?: unknown;
};

const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: 'server' }, 500);

  if (req.method === 'GET') {
    const providers = PROVIDERS.flatMap((id) => {
      const c = clientId(id);
      return c ? [{ id, clientId: c }] : [];
    });
    return json({ providers });
  }
  if (req.method !== 'POST') return json({ error: 'bad_request' }, 405);

  let b: Body;
  try { b = await req.json() as Body; } catch { return json({ error: 'bad_request' }, 400); }

  try {
    const p = b.provider;
    if (p !== 'yandex' && p !== 'vk') throw new Fail('bad_request');
    if (!clientId(p)) throw new Fail('not_configured', 404);
    const code = str(b.code);
    const verifier = str(b.codeVerifier);
    const redirectUri = str(b.redirectUri);
    if (!code || code.length > 2048 || !verifier || !VERIFIER_RE.test(verifier)) throw new Fail('bad_request');
    if (!redirectUri || !REDIRECTS.includes(redirectUri)) throw new Fail('bad_redirect');

    let prof: Profile;
    if (p === 'yandex') {
      prof = await yandexProfile(code, verifier);
    } else {
      const deviceId = str(b.deviceId);
      const state = str(b.state);
      if (!deviceId || deviceId.length > 512 || !state || state.length > 256) throw new Fail('bad_request');
      prof = await vkProfile(code, verifier, deviceId, redirectUri, state);
    }
    return json(await signIn(p, prof));
  } catch (e) {
    if (e instanceof Fail) {
      if (e.status >= 500 || e.code === 'provider_rejected') console.error(e.code, e.message);
      return json({ error: e.code }, e.status);
    }
    console.error('oauth-login', e);
    return json({ error: 'server' }, 500);
  }
});
