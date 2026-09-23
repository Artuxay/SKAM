import { createClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined;

export const configured = Boolean(url && key);

/**
 * Ошибка из ссылки для входа (например, ссылка просрочена).
 * Читаем её до того, как supabase-js очистит адресную строку.
 */
export const authLinkError: string | null = (() => {
  const raw = location.hash.startsWith('#') ? location.hash.slice(1) : '';
  const params = new URLSearchParams(raw || location.search.slice(1));
  const code = params.get('error_code');
  const desc = params.get('error_description');
  if (!code && !desc) return null;
  if (code === 'otp_expired') return 'Ссылка для входа устарела или уже использована. Запросите новую.';
  return desc ? `Не получилось войти: ${desc.replace(/\+/g, ' ')}` : 'Не получилось войти по ссылке.';
})();

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
