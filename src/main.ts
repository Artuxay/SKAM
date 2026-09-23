import './styles.css';
import type { Session } from '@supabase/supabase-js';
import { authLinkError, configured, sb } from './lib/supabase';
import { $, APP_ICON_HERO, html, lsSet } from './lib/dom';
import { applyTheme } from './lib/theme';
import { mountLogin } from './app/login';
import { mountApp, unmountApp } from './app/app';
import { registerServiceWorker } from './app/pwa';

applyTheme();
registerServiceWorker();

// Ссылка-приглашение ?join=КОД: запоминаем и чистим адресную строку.
const url = new URL(location.href);
const join = url.searchParams.get('join');
if (join) {
  lsSet('skam:join', join);
  url.searchParams.delete('join');
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
}

const root = $('root');
let shown: 'none' | 'login' | string = 'none';

function route(session: Session | null): void {
  const user = session?.user ?? null;
  if (!user) {
    if (shown === 'login') return;
    if (shown !== 'none') unmountApp();
    shown = 'login';
    mountLogin(root, authLinkError);
    return;
  }
  if (shown === user.id) return;
  if (shown !== 'none' && shown !== 'login') unmountApp();
  shown = user.id;
  void mountApp(root, user);
}

if (!configured) {
  root.replaceChildren(html(`
    <main class="auth"><div class="auth-card">
      ${APP_ICON_HERO}
      <span class="wordmark">СКАМ</span>
      <h1>Нет ключей Supabase</h1>
      <p class="lead">Скопируйте <b>.env.example</b> в <b>.env</b>, впишите URL проекта и publishable key, затем перезапустите <b>npm run dev</b>.</p>
    </div></main>`));
} else {
  // Колбэк onAuthStateChange не должен ждать другие запросы Supabase — откладываем работу.
  sb.auth.onAuthStateChange((_event, session) => {
    setTimeout(() => route(session), 0);
  });
}
