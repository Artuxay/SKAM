// Вход через Яндекс ID и VK ID.
//
// С 7 июля 2026 года российским сайтам нельзя пускать людей через иностранные сервисы входа,
// поэтому GitHub и Discord убраны. Яндекс ID и VK ID подключены не через Supabase Auth, а через
// Edge Function «oauth-login»: браузер уходит к провайдеру (OAuth 2.0 + PKCE), возвращается с кодом,
// функция меняет код на профиль, находит или создаёт аккаунт и отдаёт одноразовый токен входа.
// Кнопки показываются только для провайдеров, чьи ключи заданы в секретах функции:
// задали — кнопка появилась сама, пересобирать сайт не нужно.
import type { User } from '@supabase/supabase-js';
import { SUPABASE_KEY, SUPABASE_URL, sb } from './supabase';
import { lsGet, lsSet } from './dom';

export type OAuthId = 'yandex' | 'vk';

export const OAUTH: { id: OAuthId; label: string }[] = [
  { id: 'yandex', label: 'Яндекс ID' },
  { id: 'vk', label: 'VK ID' },
];

const LABEL: Record<OAuthId, string> = { yandex: 'Яндекс ID', vk: 'VK ID' };

export function isOAuth(p: unknown): p is OAuthId {
  return p === 'yandex' || p === 'vk';
}

export function providerLabel(p: string): string {
  return isOAuth(p) ? LABEL[p] : p;
}

const FN_URL = `${SUPABASE_URL}/functions/v1/oauth-login`;

/** Куда провайдер возвращает человека — этот же адрес указан в настройках приложений Яндекса и VK. */
function redirectUri(): string {
  return `${location.origin}${import.meta.env.BASE_URL}`;
}

// ---------------------------------------------------------------------------
// Что включено
// ---------------------------------------------------------------------------

export type OAuthProvider = { id: OAuthId; clientId: string };
export type AuthSettings = { phone: boolean; oauth: OAuthProvider[] };
let cached: AuthSettings | null = null;
let pending: Promise<AuthSettings> | null = null;

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { apikey: SUPABASE_KEY } });
  if (!r.ok) throw new Error(String(r.status));
  return r.json() as Promise<T>;
}

/** Вход по телефону (включается в Supabase) и настроенные Яндекс ID / VK ID. */
export function authSettings(): Promise<AuthSettings> {
  if (cached) return Promise.resolve(cached);
  pending ??= Promise.all([
    getJson<{ external?: Record<string, boolean> }>(`${SUPABASE_URL}/auth/v1/settings`)
      .then((j) => !!j?.external?.phone)
      .catch(() => false),
    getJson<{ providers?: { id?: unknown; clientId?: unknown }[] }>(FN_URL)
      .then((j) => (j.providers ?? []).flatMap((p) => (isOAuth(p.id) && typeof p.clientId === 'string' && p.clientId
        ? [{ id: p.id, clientId: p.clientId }] : [])))
      .catch(() => [] as OAuthProvider[]),
  ]).then(([phone, oauth]) => {
    cached = { phone, oauth: OAUTH.flatMap((o) => oauth.filter((p) => p.id === o.id)) };
    return cached;
  }).finally(() => { pending = null; });
  return pending;
}

/** Уже известные настройки (без запроса) — чтобы первый экран сразу был полным. */
export function knownSettings(): AuthSettings | null {
  return cached;
}

// ---------------------------------------------------------------------------
// Переход к провайдеру
// ---------------------------------------------------------------------------

const LAST_KEY = 'skam:oauth';
const PENDING_KEY = 'skam:oauth-pending';
/** Сколько ждём возвращения от провайдера. */
const PENDING_TTL = 30 * 60 * 1000;

type Pending = { p: OAuthId; state: string; verifier: string; redirect: string; at: number };

/** Через какого провайдера входили на этом устройстве в прошлый раз. */
export function lastProvider(): OAuthId | null {
  const v = lsGet(LAST_KEY);
  return isOAuth(v) ? v : null;
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(bytes: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function challengeOf(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(hash));
}

/**
 * Уводит на страницу входа провайдера. Возвращает текст ошибки, если уйти не получилось.
 * Обратно провайдер вернёт на главную страницу сайта с ?code=…&state=… — там вход и завершится.
 */
export async function signInWith(p: OAuthId): Promise<string | null> {
  const st = await authSettings();
  const cfg = st.oauth.find((x) => x.id === p);
  if (!cfg) return `Вход через ${LABEL[p]} сейчас недоступен. Войдите по почте.`;
  if (!crypto?.subtle) return 'Браузер не поддерживает безопасный вход. Откройте сайт по https.';
  const state = randomString(32);
  const verifier = randomString(48);
  const redirect = redirectUri();
  const pend: Pending = { p, state, verifier, redirect, at: Date.now() };
  lsSet(PENDING_KEY, JSON.stringify(pend));
  lsSet(LAST_KEY, p);

  const url = new URL(p === 'yandex' ? 'https://oauth.yandex.ru/authorize' : 'https://id.vk.ru/authorize');
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: redirect,
    state,
    code_challenge: await challengeOf(verifier),
    code_challenge_method: 'S256',
    ...(p === 'vk' ? { scope: 'email' } : {}),
  }).toString();
  location.assign(url.toString());
  return null;
}

// ---------------------------------------------------------------------------
// Возвращение от провайдера
// ---------------------------------------------------------------------------

export type OAuthReturn =
  | { ok: true; provider: OAuthId; label: string; code: string; state: string; deviceId: string | null; pending: Pending }
  | { ok: false; message: string };

function readPending(): Pending | null {
  try {
    const j = JSON.parse(lsGet(PENDING_KEY) ?? 'null') as Pending | null;
    if (j && isOAuth(j.p) && typeof j.state === 'string' && typeof j.verifier === 'string' && Date.now() - j.at < PENDING_TTL) return j;
  } catch { /* ignore */ }
  return null;
}

/**
 * Вернулись ли мы от Яндекса или VK: разбираем адрес до того, как его кто-то тронет,
 * и сразу чистим его, чтобы код не остался в истории и не сработал при обновлении страницы.
 * Ошибку провайдера (?error=…, «Отмена») показывает authLinkError в supabase.ts.
 */
export const oauthReturn: OAuthReturn | null = (() => {
  const q = new URLSearchParams(location.search);
  let code = q.get('code');
  let state = q.get('state');
  let deviceId = q.get('device_id');
  // VK ID может прислать всё одним JSON в параметре payload.
  const payload = q.get('payload');
  if (payload) {
    try {
      const j = JSON.parse(payload) as Record<string, unknown>;
      if (typeof j.code === 'string') code ??= j.code;
      if (typeof j.state === 'string') state ??= j.state;
      if (typeof j.device_id === 'string') deviceId ??= j.device_id;
    } catch { /* ignore */ }
  }
  if (!state) return null;
  const pend = readPending();
  if (!pend || pend.state !== state) {
    // Чужой или устаревший state: не наш возврат (или вкладку открыли заново). Код не трогаем,
    // но и не используем.
    if (!code) return null;
    cleanUrl();
    return { ok: false, message: 'Вход устарел или открыт в другом браузере. Нажмите кнопку входа ещё раз.' };
  }
  lsSet(PENDING_KEY, null);
  cleanUrl();
  if (!code) return null; // отмена у провайдера — сообщение даст authLinkError
  return { ok: true, provider: pend.p, label: LABEL[pend.p], code, state, deviceId, pending: pend };
})();

function cleanUrl(): void {
  const clean = new URL(location.href);
  for (const k of ['code', 'state', 'device_id', 'payload', 'type', 'expires_in', 'ext_id', 'cid']) clean.searchParams.delete(k);
  history.replaceState(history.state, '', clean.pathname + clean.search + clean.hash);
}

const ERRORS: Record<string, string> = {
  not_configured: 'Этот способ входа сейчас отключён. Войдите по почте.',
  provider_rejected: 'Сервис входа не подтвердил вход. Попробуйте ещё раз.',
  provider_unavailable: 'Сервис входа не отвечает. Попробуйте позже или войдите по почте.',
  bad_redirect: 'Вход с этого адреса сайта не настроен.',
  no_email: 'У этого аккаунта нет почты для входа. Войдите по почте.',
};

/** Завершить вход: обменять код через функцию и войти одноразовым токеном. null — всё хорошо. */
export async function finishOAuth(r: Extract<OAuthReturn, { ok: true }>): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(FN_URL, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: r.provider,
        code: r.code,
        codeVerifier: r.pending.verifier,
        redirectUri: r.pending.redirect,
        deviceId: r.deviceId,
        state: r.state,
      }),
    });
  } catch {
    return 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.';
  }
  const j = await res.json().catch(() => null) as { tokenHash?: string; error?: string } | null;
  if (!res.ok || !j?.tokenHash) return ERRORS[j?.error ?? ''] ?? `Не получилось войти через ${r.label}. Попробуйте ещё раз.`;
  const { error } = await sb.auth.verifyOtp({ token_hash: j.tokenHash, type: 'magiclink' });
  if (error) {
    if (/banned/i.test(error.code ?? error.message)) return 'Этот аккаунт заблокирован.';
    return `Не получилось войти через ${r.label}. Попробуйте ещё раз.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Что прислал провайдер (для «Создание аккаунта») и как можно войти
// ---------------------------------------------------------------------------

/** Служебный адрес аккаунтов, у которых провайдер не дал почту: на него ничего не отправляется. */
const SERVICE_EMAIL = /@oauth\.skam\.invalid$/i;

/** Настоящая почта аккаунта (без служебного адреса). */
export function realEmail(user: User | null | undefined): string | null {
  const e = user?.email;
  return e && !SERVICE_EMAIL.test(e) ? e : null;
}

export type ProviderProfile = {
  provider: OAuthId;
  label: string;
  /** Фото профиля у провайдера (https). */
  avatar: string | null;
  /** Ник у провайдера — подсказка для @username. */
  nick: string | null;
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Если аккаунт создан входом через Яндекс ID или VK ID — что о человеке известно от провайдера. */
export function providerProfile(user: User | null): ProviderProfile | null {
  const p = user?.user_metadata?.skam_oauth;
  if (!user || !isOAuth(p)) return null;
  const d = user.user_metadata as Record<string, unknown>;
  const raw = str(d.avatar_url);
  return {
    provider: p,
    label: LABEL[p],
    avatar: raw && /^https:\/\//.test(raw) ? raw : null,
    nick: str(d.preferred_username),
  };
}

/** Как человек может войти в свой аккаунт: «почта, Яндекс ID». */
export function loginMethods(user: User | null): string[] {
  if (!user) return [];
  const out: string[] = [];
  if (realEmail(user)) out.push('почта');
  if (user.phone) out.push('телефон');
  const via = user.app_metadata?.skam_oauth;
  if (Array.isArray(via)) via.forEach((p) => { if (isOAuth(p)) out.push(LABEL[p]); });
  return [...new Set(out)];
}
