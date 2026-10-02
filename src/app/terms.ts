// «Правила СКАМ»: тем, кто зарегистрировался до появления документов или принял старую редакцию,
// один раз показываем Пользовательское соглашение и Политику конфиденциальности с кнопкой «Принимаю».
// Новые пользователи ставят галочку прямо на экране «Создание аккаунта» (register.ts).
import { sb } from '../lib/supabase';
import { $, APP_ICON_HERO, button, el, html } from '../lib/dom';
import { acceptTerms, privacyLink, termsLink } from '../lib/legal';

/** updated — человек уже принимал прошлую редакцию: «Мы обновили…» вместо «Мы опубликовали…». */
export function mountTerms(root: HTMLElement, updated: boolean, onDone: () => void): void {
  root.replaceChildren(html(`
    <main class="auth">
      <div class="auth-card">
        ${APP_ICON_HERO}
        <span class="wordmark">СКАМ</span>
        <h1 id="termsTitle"></h1>
        <p class="lead" id="termsLead"></p>
        <div id="termsBody"></div>
      </div>
    </main>`));
  $('termsTitle').textContent = updated ? 'Мы обновили правила' : 'Правила СКАМ';
  $('termsLead').textContent = updated
    ? 'Пользовательское соглашение и Политика конфиденциальности изменились. Чтобы продолжить, примите новую редакцию.'
    : 'Мы опубликовали Пользовательское соглашение и Политику конфиденциальности. Чтобы продолжить пользоваться СКАМ, примите их.';

  const docs = el('ul', 'terms-docs');
  for (const a of [termsLink(), privacyLink()]) {
    const li = el('li');
    li.append(a);
    docs.append(li);
  }
  const text = el('p', 'terms-text');
  text.append('Нажимая «Принимаю», вы принимаете ', termsLink('Пользовательское соглашение'), ' и подтверждаете, что ознакомились с ', privacyLink('Политикой конфиденциальности'), '.');
  const err = el('p', 'err');
  err.setAttribute('role', 'alert');
  const ok = button('btn primary', 'Принимаю', async () => {
    ok.disabled = true;
    ok.textContent = 'Сохраняем…';
    err.textContent = '';
    try {
      await acceptTerms();
      onDone();
    } catch {
      err.textContent = 'Не получилось сохранить. Проверьте интернет и попробуйте ещё раз.';
      ok.disabled = false;
      ok.textContent = 'Принимаю';
    }
  });
  ok.id = 'termsAccept';
  const out = button('linkish', 'Не принимаю — выйти из аккаунта', () => { void sb.auth.signOut(); });
  const note = el('p', 'auth-note');
  note.append(out);
  const form = el('div', 'auth-form');
  form.append(docs, text, err, ok);
  $('termsBody').replaceChildren(form, note);
  ok.focus();
}
