// Вход и регистрация как в Telegram: номер телефона или почта → код → (для новых) создание аккаунта.
// Или одной кнопкой — через Яндекс ID или VK ID (те, что настроены в функции oauth-login).
import type { AuthError } from '@supabase/supabase-js';
import { sb } from '../lib/supabase';
import { $, APP_ICON_HERO, button, el, html, lsGet, lsSet } from '../lib/dom';
import { OAUTH, authSettings, finishOAuth, knownSettings, lastProvider, oauthReturn, signInWith, type OAuthId } from '../lib/oauth';

type Method = 'phone' | 'email';
type Target = { method: Method; value: string };

const LAST_KEY = 'skam:login';
/** Длина кода: почта — Supabase → Auth → Providers → Email → «Email OTP length» (сейчас 8), SMS — 6. */
const CODE_LEN: Record<Method, number> = {
  email: Number(import.meta.env.VITE_EMAIL_OTP_LENGTH) || 8,
  phone: Number(import.meta.env.VITE_SMS_OTP_LENGTH) || 6,
};
let cooldownTimer: number | undefined;
/** Возвращение от Яндекса или VK — обрабатываем один раз. */
let returned = oauthReturn;

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
  const known = knownSettings();
  const ret = returned;
  returned = null;
  if (ret?.ok) {
    void finishStep(ret, saved);
    return;
  }
  if (ret && !ret.ok) notice = ret.message;
  startStep(saved, notice ?? null);
  void authSettings().then((st) => {
    // Вкладка «Телефон» и кнопки Яндекс ID / VK ID появляются сами, как только их настроят.
    const ids = (x: typeof st | null) => x?.oauth.map((p) => p.id).join() ?? '';
    const changed = !known || known.phone !== st.phone || ids(known) !== ids(st);
    const start = document.getElementById('authStart') as HTMLElement | null;
    if (changed && start && (st.phone || st.oauth.length)) {
      const typed = (document.getElementById('authId') as HTMLInputElement | null)?.value;
      const keep = readSaved();
      if (typed != null && keep.method === 'email') keep.value = typed;
      startStep(keep, notice ?? null);
    }
  });
}

/** Вернулись от провайдера: «Входим через Яндекс ID…», затем приложение или ошибка на экране входа. */
async function finishStep(r: Extract<typeof oauthReturn, { ok: true }>, saved: Target): Promise<void> {
  $('authLead').textContent = `Входим через ${r.label}…`;
  const wait = el('p', 'auth-note', 'Проверяем вход. Это займёт пару секунд.');
  wait.setAttribute('role', 'status');
  $('authBody').replaceChildren(wait);
  const error = await finishOAuth(r);
  // Без ошибки onAuthStateChange сам откроет приложение или «Создание аккаунта».
  if (error && document.getElementById('authBody')) {
    await authSettings();
    startStep(saved, error);
  }
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
  const st = knownSettings();
  const phoneEnabled = !!st?.phone;
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
  const note = el('p', 'auth-note', 'Пришлём код подтверждения. Если аккаунта ещё нет — создадим его.');
  const providers = st?.oauth.map((p) => p.id) ?? [];
  if (providers.length) wrap.append(oauthBlock(providers, (msg) => { err.textContent = msg; }));
  body.replaceChildren(wrap, note);
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

/** «или» и кнопки «Войти через Яндекс ID / VK ID». Тот, через кого входили в прошлый раз, — первым. */
function oauthBlock(ids: OAuthId[], showError: (msg: string) => void): HTMLElement {
  const box = el('div', 'oauth');
  const sep = el('div', 'oauth-or');
  sep.append(el('span', null, 'или'));
  const list = el('div', 'oauth-list');
  const last = lastProvider();
  const order = OAUTH.filter((p) => ids.includes(p.id)).sort((a, b) => Number(b.id === last) - Number(a.id === last));
  const btns = order.map((p) => {
    const b = button(`btn ghost oauth-btn oauth-${p.id}`, null, async () => {
      btns.forEach((x) => { x.disabled = true; });
      label.textContent = `Открываем ${p.label}…`;
      const error = await signInWith(p.id);
      // Без ошибки браузер уже уходит на страницу входа провайдера.
      if (error) {
        btns.forEach((x) => { x.disabled = false; });
        label.textContent = `Войти через ${p.label}`;
        showError(error);
      }
    });
    const label = el('span', null, `Войти через ${p.label}`);
    b.append(label);
    if (p.id === last) b.append(el('span', 'oauth-last', 'в прошлый раз'));
    b.dataset.provider = p.id;
    return b;
  });
  list.append(...btns);
  box.append(sep, list);
  return box;
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
