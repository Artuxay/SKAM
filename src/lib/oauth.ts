// Вход через GitHub и Discord (OAuth в Supabase Auth).
// Кнопки показываются только для тех провайдеров, что включены в Supabase → Authentication → Sign In / Providers:
// включили — кнопка появилась сама, пересобирать сайт не нужно.
import type { AuthError, User } from '@supabase/supabase-js';
import { SUPABASE_KEY, SUPABASE_URL, sb } from './supabase';
import { lsGet, lsSet } from './dom';

export type OAuthId = 'github' | 'discord';

export const OAUTH: { id: OAuthId; label: string }[] = [
  { id: 'github', label: 'GitHub' },
  { id: 'discord', label: 'Discord' },
];

const LABEL: Record<string, string> = { github: 'GitHub', discord: 'Discord' };

export function isOAuth(p: unknown): p is OAuthId {
  return p === 'github' || p === 'discord';
}

export function providerLabel(p: string): string {
  return LABEL[p] ?? p;
}

// ---------------------------------------------------------------------------
// Что включено в Supabase
// ---------------------------------------------------------------------------

export type AuthSettings = { phone: boolean; oauth: OAuthId[] };
let cached: AuthSettings | null = null;
let pending: Promise<AuthSettings> | null = null;

/** Публичные настройки Auth: вход по телефону и включённые OAuth-провайдеры. */
export function authSettings(): Promise<AuthSettings> {
  if (cached) return Promise.resolve(cached);
  pending ??= fetch(`${SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: SUPABASE_KEY } })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((j: { external?: Record<string, boolean> }) => {
      const ext = j?.external ?? {};
      cached = { phone: !!ext.phone, oauth: OAUTH.map((p) => p.id).filter((id) => ext[id]) };
      return cached;
    })
    .catch(() => ({ phone: false, oauth: [] as OAuthId[] }))
    .finally(() => { pending = null; });
  return pending;
}

/** Уже известные настройки (без запроса) — чтобы первый экран сразу был полным. */
export function knownSettings(): AuthSettings | null {
  return cached;
}

// ---------------------------------------------------------------------------
// Вход
// ---------------------------------------------------------------------------

const LAST_KEY = 'skam:oauth';

/** Через какого провайдера входили на этом устройстве в прошлый раз. */
export function lastProvider(): OAuthId | null {
  const v = lsGet(LAST_KEY);
  return isOAuth(v) ? v : null;
}

/**
 * Уводит на страницу входа провайдера. Вернётся человек на этот же адрес
 * (его нужно добавить в Supabase → Authentication → URL Configuration → Redirect URLs).
 */
export async function signInWith(p: OAuthId): Promise<AuthError | null> {
  lsSet(LAST_KEY, p);
  const { error } = await sb.auth.signInWithOAuth({
    provider: p,
    options: { redirectTo: `${location.origin}${import.meta.env.BASE_URL}` },
  });
  return error;
}

// ---------------------------------------------------------------------------
// Что прислал провайдер (для «Создание аккаунта»)
// ---------------------------------------------------------------------------

export type ProviderProfile = {
  provider: OAuthId;
  label: string;
  /** Фото профиля у провайдера (https), побольше размером. */
  avatar: string | null;
  /** Ник у провайдера — подсказка для @username. */
  nick: string | null;
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Фото покрупнее: у GitHub и Discord размер задаётся в адресе. */
function bigAvatar(url: string, p: OAuthId): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return url;
    if (p === 'github') { u.searchParams.set('s', '512'); return u.toString(); }
    if (p === 'discord') { u.searchParams.set('size', '512'); return u.toString(); }
  } catch { /* не URL */ }
  return url;
}

/** Если аккаунт создан через GitHub или Discord — что о человеке известно от провайдера. */
export function providerProfile(user: User | null): ProviderProfile | null {
  const p = user?.app_metadata?.provider;
  if (!user || !isOAuth(p)) return null;
  const idn = user.identities?.find((i) => i.provider === p);
  const d = { ...(user.user_metadata ?? {}), ...(idn?.identity_data ?? {}) } as Record<string, unknown>;
  const raw = str(d.avatar_url) ?? str(d.picture);
  const avatar = raw && /^https:\/\//.test(raw) ? bigAvatar(raw, p) : null;
  // GitHub — login; Discord — username (full_name у Discord — это ник).
  const nick = p === 'github' ? str(d.user_name) ?? str(d.preferred_username)
    : str(d.full_name) ?? str(d.name)?.replace(/#\d+$/, '') ?? null;
  return { provider: p, label: LABEL[p], avatar, nick };
}

/** Как человек может войти в свой аккаунт: «почта, GitHub». */
export function loginMethods(user: User | null): string[] {
  const list = user?.identities?.map((i) => i.provider) ?? (user?.app_metadata?.providers as string[] | undefined) ?? [];
  const names: Record<string, string> = { email: 'почта', phone: 'телефон', ...LABEL };
  return [...new Set(list)].map((p) => names[p] ?? p);
}
