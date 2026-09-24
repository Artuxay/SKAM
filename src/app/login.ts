// Экран входа: magic link на почту + вход по коду из письма (удобно для PWA на телефоне).
import type { AuthError } from '@supabase/supabase-js';
import { sb } from '../lib/supabase';
import { $, APP_ICON_HERO, button, el, html, lsGet, lsSet } from '../lib/dom';

const EMAIL_KEY = 'skam:email';
let cooldownTimer: number | undefined;

export function mountLogin(root: HTMLElement, notice?: string | null): void {
  clearInterval(cooldownTimer);
  root.replaceChildren(html(`
    <main class="auth">
      <div class="auth-card">
        ${APP_ICON_HERO}
        <span class="wordmark">СКАМ</span>
        <h1>Не развод, а мессенджер</h1>
        <p class="lead">Войдите по почте — пришлём ссылку для входа. Пароль не нужен.</p>
        <div id="authBody"></div>
      </div>
    </main>`));
  emailStep(notice ?? null);
}

function authMessage(e: AuthError | Error | null | undefined): string {
  if (!e) return 'Что-то пошло не так. Попробуйте ещё раз.';
  const code = 'code' in e ? (e as AuthError).code : undefined;
  const status = 'status' in e ? (e as AuthError).status : undefined;
  if (code === 'over_email_send_rate_limit' || status === 429) return 'Слишком много писем подряд. Подождите минуту и попробуйте снова.';
  if (code === 'email_address_invalid' || code === 'validation_failed') return 'Проверьте адрес почты.';
  if (code === 'otp_expired' || code === 'otp_disabled') return 'Код неверный или устарел. Запросите новое письмо.';
  if (code === 'signup_disabled') return 'Регистрация новых пользователей сейчас закрыта.';
  if (e.message?.includes('Failed to fetch')) return 'Нет связи с сервером. Проверьте интернет.';
  return e.message || 'Что-то пошло не так. Попробуйте ещё раз.';
}

function emailStep(notice: string | null): void {
  const body = $('authBody');
  const form = el('form', 'auth-form');
  form.noValidate = true;
  const label = el('label', 'fld', 'Электронная почта');
  label.htmlFor = 'authEmail';
  const input = el('input', 'txt');
  Object.assign(input, { id: 'authEmail', type: 'email', autocomplete: 'email', inputMode: 'email', placeholder: 'you@example.com', required: true });
  input.value = lsGet(EMAIL_KEY) ?? '';
  const err = el('p', 'err', notice);
  err.setAttribute('role', 'alert');
  const submit = el('button', 'btn primary', 'Получить ссылку для входа');
  submit.type = 'submit';
  form.append(label, input, err, submit);
  body.replaceChildren(form, el('p', 'auth-note', 'Новый аккаунт создаётся автоматически при первом входе.'));
  input.focus();

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const email = input.value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      err.textContent = 'Введите адрес почты, например you@example.com.';
      input.focus();
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Отправляем…';
    err.textContent = '';
    const { error } = await sendLink(email);
    submit.disabled = false;
    submit.textContent = 'Получить ссылку для входа';
    if (error) {
      err.textContent = authMessage(error);
      return;
    }
    lsSet(EMAIL_KEY, email);
    sentStep(email);
  });
}

function sendLink(email: string) {
  return sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${location.origin}${import.meta.env.BASE_URL}`, shouldCreateUser: true },
  });
}

function sentStep(email: string): void {
  const body = $('authBody');
  const box = el('div', 'auth-sent');
  const p = el('p');
  p.append('Письмо отправлено на ', el('b', null, email), '. Откройте ссылку из письма — и вы внутри.');

  const form = el('form', 'auth-form');
  form.noValidate = true;
  const label = el('label', 'fld', 'Или введите код из письма');
  label.htmlFor = 'authCode';
  const code = el('input', 'txt code-input');
  Object.assign(code, { id: 'authCode', inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 10, placeholder: '••••••' });
  const err = el('p', 'err');
  err.setAttribute('role', 'alert');
  const submit = el('button', 'btn primary', 'Войти по коду');
  submit.type = 'submit';
  form.append(label, code, err, submit);
  box.append(p, form);

  const again = button('linkish', '', async () => {
    again.disabled = true;
    const { error } = await sendLink(email);
    if (error) {
      err.textContent = authMessage(error);
      again.disabled = false;
      return;
    }
    err.textContent = '';
    startCooldown();
  });
  const other = button('linkish', 'Другая почта', () => { clearInterval(cooldownTimer); emailStep(null); });
  const note = el('p', 'auth-note');
  note.append(again, ' · ', other);
  body.replaceChildren(box, note);
  code.focus();

  function startCooldown(): void {
    let left = 60;
    again.disabled = true;
    const tick = () => {
      again.textContent = left > 0 ? `Отправить ещё раз через ${left} с` : 'Отправить ещё раз';
      again.disabled = left > 0;
      if (left-- <= 0) clearInterval(cooldownTimer);
    };
    clearInterval(cooldownTimer);
    tick();
    cooldownTimer = window.setInterval(tick, 1000);
  }
  startCooldown();

  code.addEventListener('input', () => { code.value = code.value.replace(/\D/g, ''); });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const token = code.value.trim();
    if (token.length < 6) {
      err.textContent = 'Введите код из письма целиком.';
      code.focus();
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Проверяем…';
    const { error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
    if (error) {
      submit.disabled = false;
      submit.textContent = 'Войти по коду';
      err.textContent = authMessage(error);
      return;
    }
    clearInterval(cooldownTimer);
    // Дальше onAuthStateChange откроет приложение.
  });
}
