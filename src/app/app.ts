// Временная заглушка шага 1 — будет заменена интерфейсом мессенджера.
import type { User } from '@supabase/supabase-js';
import { sb } from '../lib/supabase';
import { html, LOGO } from '../lib/dom';

export async function mountApp(root: HTMLElement, user: User): Promise<void> {
  root.replaceChildren(html(`<main class="auth"><div class="auth-card">${LOGO}<p class="lead">Вы вошли как ${user.email ?? ''}</p><button class="btn primary" id="out" type="button">Выйти</button></div></main>`));
  document.getElementById('out')?.addEventListener('click', () => { void sb.auth.signOut(); });
}

export function unmountApp(): void {}
