// Экраны шифрования: «Пароль шифрования» (первый запуск или сброс) и «Введите пароль» (новое устройство).
// Пароль нужен только чтобы восстановить ключ на другом устройстве — как облачный пароль в Telegram.
import { sb } from '../lib/supabase';
import { $, ICONS, button, el, html } from '../lib/dom';
import * as e2e from './e2e';

export const MIN_PASSWORD = 8;

function shell(root: HTMLElement, title: string, lead: string): HTMLElement {
  root.replaceChildren(html(`
    <main class="auth">
      <div class="auth-card">
        <div class="key-hero">${ICONS.lockBig}</div>
        <h1></h1>
        <p class="lead"></p>
        <div id="keyBody"></div>
      </div>
    </main>`));
  root.querySelector('h1')!.textContent = title;
  root.querySelector('.lead')!.textContent = lead;
  return $('keyBody');
}

function passwordField(id: string, label: string, autocomplete: string): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = el('div', 'pw');
  const l = el('label', 'fld', label);
  l.htmlFor = id;
  const row = el('div', 'pw-row');
  const input = el('input', 'txt');
  Object.assign(input, { id, type: 'password', autocomplete, maxLength: 200, spellcheck: false });
  input.setAttribute('autocapitalize', 'off');
  const eye = button('pw-eye', 'Показать', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    eye.textContent = show ? 'Скрыть' : 'Показать';
    input.focus();
  });
  eye.setAttribute('aria-controls', id);
  row.append(input, eye);
  wrap.append(l, row);
  return { wrap, input };
}

function footer(extra?: HTMLElement): HTMLElement {
  const note = el('p', 'auth-note');
  if (extra) note.append(extra, ' · ');
  note.append(button('linkish', 'Выйти из аккаунта', () => { void sb.auth.signOut(); }));
  return note;
}

/** Первый запуск или сброс: придумать пароль шифрования. */
export function mountKeySetup(root: HTMLElement, userId: string, onDone: () => void, resetOld = false): void {
  const body = shell(
    root,
    resetOld ? 'Новый пароль шифрования' : 'Пароль шифрования',
    resetOld
      ? 'Создадим новый ключ шифрования. Зашифрованные сообщения, отправленные вам до сброса, прочитать не получится; новые будут видны как обычно.'
      : 'Личные чаты и группы в СКАМ защищены сквозным шифрованием: ключи хранятся только на ваших устройствах. Придумайте пароль — он понадобится, чтобы читать переписку при входе на новом устройстве.',
  );
  const form = el('form', 'auth-form');
  form.noValidate = true;
  const p1 = passwordField('keyPw1', 'Пароль шифрования', 'new-password');
  const p2 = passwordField('keyPw2', 'Повторите пароль', 'new-password');
  const hint = el('p', 'hint', `Не короче ${MIN_PASSWORD} символов. Это не пароль от почты: сервер его не знает и восстановить не сможет — запишите его в надёжное место.`);
  const err = el('p', 'err');
  err.setAttribute('role', 'alert');
  const submit = el('button', 'btn primary', resetOld ? 'Сбросить и включить шифрование' : 'Включить шифрование');
  submit.type = 'submit';
  form.append(p1.wrap, p2.wrap, hint, err, submit);
  const note = footer();
  body.replaceChildren(form, note);
  p1.input.focus();
  form.addEventListener('input', () => { err.textContent = ''; });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const a = p1.input.value;
    const b = p2.input.value;
    if (a.length < MIN_PASSWORD) { err.textContent = `Пароль должен быть не короче ${MIN_PASSWORD} символов.`; p1.input.focus(); return; }
    if (a !== b) { err.textContent = 'Пароли не совпадают.'; p2.input.focus(); return; }
    submit.disabled = true;
    submit.textContent = 'Создаём ключи…';
    try {
      await e2e.createIdentity(userId, a, resetOld);
      onDone();
    } catch (e) {
      if (e instanceof e2e.KeyExistsError) {
        // Ключ уже создали на другом устройстве — значит, нужен тот пароль.
        mountKeyUnlock(root, userId, onDone, 'Шифрование уже включено на другом устройстве. Введите пароль, который задали там.');
        return;
      }
      err.textContent = (e as Error)?.message?.includes('Failed to fetch') ? 'Нет связи с сервером.' : 'Не получилось создать ключи. Попробуйте ещё раз.';
      submit.disabled = false;
      submit.textContent = resetOld ? 'Сбросить и включить шифрование' : 'Включить шифрование';
    }
  });
}

/** Новое устройство: ввести пароль шифрования, чтобы расшифровать ключ. */
export function mountKeyUnlock(root: HTMLElement, userId: string, onDone: () => void, lead?: string): void {
  const body = shell(
    root,
    'Введите пароль шифрования',
    lead ?? 'Вы вошли на новом устройстве. Чтобы прочитать зашифрованную переписку, введите пароль шифрования, который задали раньше.',
  );
  const form = el('form', 'auth-form');
  form.noValidate = true;
  const p = passwordField('keyPw', 'Пароль шифрования', 'current-password');
  const err = el('p', 'err');
  err.setAttribute('role', 'alert');
  const submit = el('button', 'btn primary', 'Продолжить');
  submit.type = 'submit';
  form.append(p.wrap, err, submit);
  const forgot = button('linkish', 'Забыли пароль?', () => showReset());
  body.replaceChildren(form, footer(forgot));
  p.input.focus();
  form.addEventListener('input', () => { err.textContent = ''; });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!p.input.value) { err.textContent = 'Введите пароль.'; return; }
    submit.disabled = true;
    submit.textContent = 'Проверяем…';
    try {
      await e2e.unlock(userId, p.input.value);
      onDone();
    } catch (e) {
      err.textContent = e instanceof e2e.WrongPasswordError
        ? 'Неверный пароль шифрования.'
        : (e as Error)?.message?.includes('Failed to fetch') ? 'Нет связи с сервером.' : (e as Error)?.message || 'Не получилось. Попробуйте ещё раз.';
      submit.disabled = false;
      submit.textContent = 'Продолжить';
      p.input.select();
    }
  });

  function showReset(): void {
    const box = el('div', 'auth-sent');
    box.append(
      el('p', null, 'Пароль шифрования нельзя восстановить: его не знаем даже мы.'),
      el('p', null, 'Можно сбросить ключ и задать новый пароль. Тогда зашифрованные сообщения, отправленные вам до сброса, прочитать больше не получится — ни здесь, ни на других устройствах, а собеседники увидят, что ваш ключ изменился. Старые сообщения, отправленные до включения шифрования, останутся видны.'),
    );
    const actions = el('div', 'dlg-actions');
    actions.append(
      button('btn ghost', 'Назад', () => mountKeyUnlock(root, userId, onDone, lead)),
      button('btn danger', 'Сбросить ключ', () => mountKeySetup(root, userId, onDone, true)),
    );
    box.append(actions);
    body.replaceChildren(box, footer());
  }
}

/** Браузер без WebCrypto (или страница открыта не по HTTPS). */
export function mountNoCrypto(root: HTMLElement): void {
  const body = shell(
    root,
    'Шифрование недоступно',
    'Этот браузер не умеет шифровать или страница открыта без HTTPS. Откройте СКАМ по адресу https://… в свежей версии Chrome, Safari, Firefox или Edge.',
  );
  body.replaceChildren(footer());
}
