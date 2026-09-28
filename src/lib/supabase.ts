import { createClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined;

export const configured = Boolean(url && key);
export const SUPABASE_URL = url ?? '';
export const SUPABASE_KEY = key ?? '';

/**
 * Ошибка входа, с которой нас вернули на сайт: просроченная ссылка из письма
 * или отказ/сбой при входе через GitHub или Discord.
 * Читаем её до того, как supabase-js очистит адресную строку.
 */
export const authLinkError: string | null = (() => {
  const raw = location.hash.startsWith('#') ? location.hash.slice(1) : '';
  const params = new URLSearchParams(raw.includes('error') ? raw : location.search.slice(1));
  const error = params.get('error');
  const code = params.get('error_code');
  const desc = (params.get('error_description') ?? '').replace(/\+/g, ' ');
  if (!error && !code && !desc) return null;
  if (code === 'otp_expired') return 'Ссылка для входа устарела или уже использована. Запросите новую.';
  if (error === 'access_denied' && !/email/i.test(desc)) return 'Вход отменён. Можно попробовать ещё раз или войти по почте.';
  if (code === 'signup_disabled') return 'Регистрация новых пользователей сейчас закрыта.';
  if (code === 'provider_email_needs_verification') return 'Подтвердите почту: мы отправили письмо со ссылкой. Потом войдите ещё раз.';
  if (/email/i.test(desc) && /(provider|external)/i.test(desc)) {
    return 'Сервис входа не передал адрес почты. Проверьте, что в аккаунте есть подтверждённая почта, или войдите по почте.';
  }
  return desc ? `Не получилось войти: ${desc}` : 'Не получилось войти.';
})();

// Ошибку показали — убираем её из адресной строки, чтобы она не всплывала при обновлении страницы.
if (authLinkError) {
  const clean = new URL(location.href);
  clean.hash = '';
  for (const k of ['error', 'error_code', 'error_description']) clean.searchParams.delete(k);
  history.replaceState(history.state, '', clean.pathname + clean.search);
}

export const sb = createClient<Database>(url || 'http://localhost:54321', key || 'missing-key', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    // implicit-поток: ссылку из письма можно открыть в любом браузере, а не только там, где её запросили.
    flowType: 'implicit',
    storageKey: 'skam-auth',
  },
  realtime: { params: { eventsPerSecond: 20 } },
});

export function avatarUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return sb.storage.from('avatars').getPublicUrl(path).data.publicUrl;
}
