// «Создание аккаунта» — как в Telegram после первого кода: фото, имя, фамилия и @username.
import { avatarUrl, sb } from '../lib/supabase';
import { $, APP_ICON_HERO, button, el, html, toast } from '../lib/dom';
import { S, USERNAME_RE, normUsername, removeAvatar, updateMyProfile, uploadAvatar, usernameAvailable } from './store';

export function mountRegister(root: HTMLElement, onDone: () => void): void {
  root.replaceChildren(html(`
    <main class="auth">
      <div class="auth-card">
        ${APP_ICON_HERO}
        <h1>Создание аккаунта</h1>
        <p class="lead">Так вас увидят собеседники в СКАМ.</p>
        <div id="regBody"></div>
      </div>
    </main>`));
  const hero = root.querySelector('.appicon.hero') as SVGElement | null;
  if (hero) hero.style.width = '72px';

  const body = $('regBody');
  const form = el('form', 'auth-form');
  form.noValidate = true;

  // Фото
  const avWrap = el('div', 'reg-avatar');
  const avBtn = el('button', 'reg-av');
  avBtn.type = 'button';
  avBtn.setAttribute('aria-label', 'Выбрать фото профиля');
  const file = el('input');
  Object.assign(file, { type: 'file', accept: 'image/*', hidden: true });
  const avHint = el('span', 'hint', 'Добавить фото');
  avWrap.append(avBtn, avHint, file);

  function paintAvatar(): void {
    const url = avatarUrl(S.me?.avatar_path);
    avBtn.replaceChildren();
    avBtn.style.background = url ? 'transparent' : S.me?.color ?? '';
    if (url) {
      const img = el('img');
      img.src = url;
      img.alt = '';
      avBtn.append(img);
      avHint.textContent = 'Сменить фото';
    } else {
      const letter = (first.value || '').trim().charAt(0).toUpperCase();
      avBtn.append(letter ? document.createTextNode(letter) : html('<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>'));
      avHint.textContent = 'Добавить фото';
    }
  }
  avBtn.addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    avHint.textContent = 'Загружаем…';
    try {
      if (S.me?.avatar_path) await removeAvatar();
      await uploadAvatar(f);
    } catch {
      toast('Не получилось загрузить фото.');
    }
    paintAvatar();
  });

  // Поля
  const field = (id: string, label: string, attrs: Partial<HTMLInputElement>) => {
    const l = el('label', 'fld', label);
    l.htmlFor = id;
    const i = el('input', 'txt');
    Object.assign(i, { id, ...attrs });
    return { l, i };
  };
  const fn = field('regFirst', 'Имя', { maxLength: 40, autocomplete: 'given-name', required: true, value: S.me?.first_name ?? '' });
  const ln = field('regLast', 'Фамилия (необязательно)', { maxLength: 40, autocomplete: 'family-name', value: S.me?.last_name ?? '' });
  const un = field('regUser', 'Имя пользователя (необязательно)', { maxLength: 33, autocomplete: 'username', placeholder: '@username', value: S.me?.username ? `@${S.me.username}` : '' });
  const first = fn.i;
  const unHint = el('p', 'hint', 'По нему вас смогут найти. Латиница, цифры и _, от 5 символов.');
  const err = el('p', 'err');
  err.setAttribute('role', 'alert');
  const submit = el('button', 'btn primary', 'Создать аккаунт');
  submit.type = 'submit';

  form.append(avWrap, fn.l, fn.i, ln.l, ln.i, un.l, un.i, unHint, err, submit);
  const out = button('linkish', 'Войти в другой аккаунт', () => { void sb.auth.signOut(); });
  const note = el('p', 'auth-note');
  note.append(out);
  body.replaceChildren(form, note);
  paintAvatar();
  first.addEventListener('input', paintAvatar);
  form.addEventListener('input', () => { err.textContent = ''; });
  first.focus();

  // Проверка @username на лету
  let checkSeq = 0;
  let unOk = true;
  let unTimer: number | undefined;
  un.i.addEventListener('input', () => {
    clearTimeout(unTimer);
    const v = normUsername(un.i.value);
    unHint.classList.remove('ok', 'bad');
    if (!v) { unOk = true; unHint.textContent = 'По нему вас смогут найти. Латиница, цифры и _, от 5 символов.'; return; }
    if (!USERNAME_RE.test(v)) {
      unOk = false;
      unHint.textContent = /^[0-9_]/.test(v) ? 'Должно начинаться с латинской буквы.' : 'Только латиница, цифры и _, от 5 до 32 символов.';
      unHint.classList.add('bad');
      return;
    }
    unOk = false;
    unHint.textContent = 'Проверяем…';
    const seq = ++checkSeq;
    unTimer = window.setTimeout(async () => {
      const free = await usernameAvailable(v).catch(() => false);
      if (seq !== checkSeq) return;
      unOk = free;
      unHint.textContent = free ? `@${v} свободно` : `@${v} уже занято`;
      unHint.classList.add(free ? 'ok' : 'bad');
    }, 350);
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const firstName = first.value.trim();
    const lastName = ln.i.value.trim();
    const username = normUsername(un.i.value);
    if (!firstName) { err.textContent = 'Введите имя.'; first.focus(); return; }
    if (username && (!USERNAME_RE.test(username) || !unOk)) { err.textContent = 'Выберите другое имя пользователя или оставьте поле пустым.'; un.i.focus(); return; }
    submit.disabled = true;
    submit.textContent = 'Создаём…';
    try {
      await updateMyProfile({ first_name: firstName, last_name: lastName || null, username: username || null });
      onDone();
    } catch (e) {
      const code = (e as { code?: string }).code;
      err.textContent = code === '23505' ? 'Это имя пользователя уже занято.' : 'Не получилось сохранить. Попробуйте ещё раз.';
      submit.disabled = false;
      submit.textContent = 'Создать аккаунт';
    }
  });
}
