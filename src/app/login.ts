// Вход и регистрация как в Telegram: номер телефона или почта → код → (для новых) создание аккаунта.
import type { AuthError } from '@supabase/supabase-js';
import { SUPABASE_KEY, SUPABASE_URL, sb } from '../lib/supabase';
import { $, APP_ICON_HERO, button, el, html, lsGet, lsSet } from '../lib/dom';

type Method = 'phone' | 'email';
type Target = { method: Method; value: string };

const LAST_KEY = 'skam:login';
/** Длина кода: почта — Supabase → Auth → Providers → Email → «Email OTP length» (сейчас 8), SMS — 6. */
const CODE_LEN: Record<Method, number> = {
  email: Number(import.meta.env.VITE_EMAIL_OTP_LENGTH) || 8,
  phone: Number(import.meta.env.VITE_SMS_OTP_LENGTH) || 6,
};
let cooldownTimer: number | undefined;
let phoneEnabled: boolean | null = null;

/** Включён ли вход по телефону в Supabase (Auth → Providers → Phone + SMS-провайдер). */
async function detectPhone(): Promise<boolean> {
  if (phoneEnabled !== null) return phoneEnabled;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: SUPABASE_KEY } });
    const j = await r.json();
    phoneEnabled = !!j?.external?.phone;
  } catch {
    phoneEnabled = false;
  }
  return phoneEnabled;
}

export function mountLogin(root: HTMLElement, notice?: string | null): void {
  clearInterval(cooldownTimer);
  root.replaceChildren(html(`
    <main class="auth">
      <div class="auth-card">
        ${APP_ICON_HERO}
        <span class="wordmark">СКАМ</span>
        <h1>Не развод, а мессенджер</h1>
        <p class="lead" id="authLead">Войдите или создайте аккаунт.</p>
        <div id="authBody"></div>
      </div>
    </main>`));
  const saved = readSaved();
  startStep(saved, notice ?? null);
  void detectPhone().then((on) => {
    // Вкладка «Телефон» появляется сама, как только в Supabase включат SMS.
    if (on && document.getElementById('authStart')) startStep(readSaved(), notice ?? null);
  });
}

function readSaved(): Target {
  try {
    const j = JSON.parse(lsGet(LAST_KEY) ?? 'null') as Target | null;
    if (j && (j.method === 'phone' || j.method === 'email') && typeof j.value === 'string') return j;
  } catch { /* ignore */ }
  return { method: 'email', value: '' };
}

function authMessage(e: AuthError | Error | null | undefined): string {
  if (!e) return 'Что-то пошло не так. Попробуйте ещё раз.';
  const code = 'code' in e ? (e as AuthError).code : undefined;
  const status = 'status' in e ? (e as AuthError).status : undefined;
  if (code === 'over_email_send_rate_limit' || code === 'over_sms_send_rate_limit' || status === 429) {
    return 'Слишком много попыток подряд. Подождите немного и попробуйте снова.';
  }
  if (code === 'email_address_invalid' || code === 'validation_failed') return 'Проверьте адрес почты.';
  if (code === 'email_address_not_authorized') return 'Не получилось отправить письмо на этот адрес. Попробуйте позже.';
  if (code === 'phone_provider_disabled' || code === 'sms_send_failed') return 'Не получилось отправить SMS. Войдите по почте или попробуйте позже.';
  if (code === 'otp_expired' || code === 'otp_disabled') return 'Неверный или устаревший код.';
  if (code === 'signup_disabled') return 'Регистрация новых пользователей сейчас закрыта.';
  if (e.message?.includes('Failed to fetch')) return 'Нет связи с сервером. Проверьте интернет.';
  return e.message || 'Что-то пошло не так. Попробуйте ещё раз.';
}

/** +7 900 123-45-67 → +79001234567. Российская «8…» превращается в «+7…». */
export function normalizePhone(raw: string): string | null {
  let d = raw.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('8')) d = `7${d.slice(1)}`;
  if (d.length === 10 && d.startsWith('9')) d = `7${d}`;
  return d.length >= 10 && d.length <= 15 ? `+${d}` : null;
}

function prettyPhone(e164: string): string {
  const d = e164.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('7')) return `+7 ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
  return `+${d}`;
}

// ---------------------------------------------------------------------------
// Шаг 1: номер или почта
// ---------------------------------------------------------------------------

function startStep(saved: Target, notice: string | null): void {
  const body = $('authBody');
  $('authLead').textContent = 'Войдите или создайте аккаунт.';
  let method: Method = phoneEnabled ? saved.method : 'email';

  const wrap = el('div', 'auth-form');
  wrap.id = 'authStart';
  const tabs = el('div', 'seg');
  tabs.setAttribute('role', 'tablist');
  const form = el('form', 'auth-form');
  form.noValidate = true;
  const label = el('label', 'fld');
  label.htmlFor = 'authId';
  const input = el('input', 'txt');
  input.id = 'authId';
  const err = el('p', 'err', notice);
  err.setAttribute('role', 'alert');
  const submit = el('button', 'btn primary', 'Далее');
  submit.type = 'submit';
  form.append(label, input, err, submit);

  const values: Record<Method, string> = { phone: saved.method === 'phone' ? saved.value : '+7 ', email: saved.method === 'email' ? saved.value : '' };

  function applyMethod(): void {
    label.textContent = method === 'phone' ? 'Номер телефона' : 'Электронная почта';
    Object.assign(input, method === 'phone'
      ? { type: 'tel', inputMode: 'tel', autocomplete: 'tel', placeholder: '+7 900 123-45-67' }
      : { type: 'email', inputMode: 'email', autocomplete: 'email', placeholder: 'you@example.com' });
    input.value = values[method];
    tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === method)));
    err.textContent = notice ?? '';
    notice = null;
    input.focus();
  }

  if (phoneEnabled) {
    (['phone', 'email'] as Method[]).forEach((m) => {
      const b = button(null, m === 'phone' ? 'Телефон' : 'Почта', () => {
        values[method] = input.value;
        method = m;
        applyMethod();
      });
      b.dataset.m = m;
      b.setAttribute('role', 'tab');
      tabs.append(b);
    });
    tabs.style.gridTemplateColumns = 'repeat(2,1fr)';
    wrap.append(tabs);
  }
  wrap.append(form);
  body.replaceChildren(wrap, el('p', 'auth-note', 'Пришлём код подтверждения. Если аккаунта ещё нет — создадим его.'));
  applyMethod();

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    let value: string;
    if (method === 'phone') {
      const p = normalizePhone(input.value);
      if (!p) { err.textContent = 'Введите номер полностью, например +7 900 123-45-67.'; input.focus(); return; }
      value = p;
    } else {
      value = input.value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) { err.textContent = 'Введите адрес почты, например you@example.com.'; input.focus(); return; }
    }
    submit.disabled = true;
    submit.textContent = 'Отправляем код…';
    err.textContent = '';
    const { error } = await sendCode({ method, value });
    submit.disabled = false;
    submit.textContent = 'Далее';
    if (error) { err.textContent = authMessage(error); return; }
    lsSet(LAST_KEY, JSON.stringify({ method, value }));
    codeStep({ method, value });
  });
}

function sendCode(t: Target) {
  if (t.method === 'phone') {
    return sb.auth.signInWithOtp({ phone: t.value, options: { shouldCreateUser: true, channel: 'sms' } });
  }
  return sb.auth.signInWithOtp({
    email: t.value,
    options: { shouldCreateUser: true, emailRedirectTo: `${location.origin}${import.meta.env.BASE_URL}` },
  });
}

// ---------------------------------------------------------------------------
// Шаг 2: код
// ---------------------------------------------------------------------------

function codeStep(t: Target): void {
  const body = $('authBody');
  $('authLead').textContent = 'Введите код подтверждения.';
  const p = el('p', 'auth-sent-text');
  if (t.method === 'phone') p.append('Мы отправили SMS с кодом на номер ', el('b', null, prettyPhone(t.value)), '.');
  else p.append('Мы отправили письмо с кодом на ', el('b', null, t.value), '. Можно ввести код или просто нажать кнопку в письме.');

  const form = el('form', 'auth-form');
  form.noValidate = true;
  const code = el('input', 'txt code-input');
  const len = CODE_LEN[t.method];
  Object.assign(code, { id: 'authCode', inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 10, placeholder: '•'.repeat(len) });
  code.setAttribute('aria-label', 'Код подтверждения');
  const err = el('p', 'err');
  err.setAttribute('role', 'alert');
  const submit = el('button', 'btn primary', 'Войти');
  submit.type = 'submit';
  form.append(code, err, submit);

  const again = button('linkish', '', async () => {
    again.disabled = true;
    const { error } = await sendCode(t);
    if (error) { err.textContent = authMessage(error); again.disabled = false; return; }
    err.textContent = '';
    startCooldown();
  });
  const other = button('linkish', t.method === 'phone' ? 'Изменить номер' : 'Изменить почту', () => {
    clearInterval(cooldownTimer);
    startStep(t, null);
  });
  const note = el('p', 'auth-note');
  note.append(again, el('br'), other);
  body.replaceChildren(p, form, note);
  code.focus();

  function startCooldown(): void {
    let left = 60;
    const tick = () => {
      again.textContent = left > 0 ? `Отправить код ещё раз через ${left} с` : 'Отправить код ещё раз';
      again.disabled = left > 0;
      if (left-- <= 0) clearInterval(cooldownTimer);
    };
    clearInterval(cooldownTimer);
    tick();
    cooldownTimer = window.setInterval(tick, 1000);
  }
  startCooldown();

  let busy = false;
  async function verify(): Promise<void> {
    const token = code.value.trim();
    if (busy) return;
    if (token.length < Math.min(6, len)) { err.textContent = 'Введите код целиком.'; code.focus(); return; }
    busy = true;
    submit.disabled = true;
    submit.textContent = 'Проверяем…';
    const { error } = t.method === 'phone'
      ? await sb.auth.verifyOtp({ phone: t.value, token, type: 'sms' })
      : await sb.auth.verifyOtp({ email: t.value, token, type: 'email' });
    busy = false;
    if (error) {
      submit.disabled = false;
      submit.textContent = 'Войти';
      err.textContent = authMessage(error);
      code.select();
      return;
    }
    clearInterval(cooldownTimer);
    // Дальше onAuthStateChange откроет приложение или экран создания аккаунта.
  }

  code.addEventListener('input', () => {
    code.value = code.value.replace(/\D/g, '');
    err.textContent = '';
    if (code.value.length === len) void verify();
  });
  form.addEventListener('submit', (ev) => { ev.preventDefault(); void verify(); });
}
