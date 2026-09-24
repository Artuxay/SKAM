// «Создание аккаунта» — как в Telegram после первого кода: фото, имя, фамилия и @username.
// @username обязателен. Тем, кто зарегистрировался раньше без него, экран показывается один раз
// с заполненными именем и фото — остаётся выбрать @username (есть готовые свободные варианты).
import { avatarUrl, sb } from '../lib/supabase';
import { $, APP_ICON_HERO, button, el, html, toast } from '../lib/dom';
import { S, USERNAME_RE, normUsername, removeAvatar, updateMyProfile, uploadAvatar, usernameAvailable, usernameRequired } from './store';

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** «Артур Гайнатуллин» → artur, gaynatullin: только латиница, цифры и _. */
function latin(v: string): string {
  return [...v.trim().toLowerCase()].map((c) => TRANSLIT[c] ?? c).join('')
    .replace(/[^a-z0-9]+/g, '_').replace(/^[^a-z]+/, '').replace(/_+$/, '');
}

/** Варианты @username из имени и фамилии (ещё не проверенные на занятость). */
function candidates(first: string, last: string): string[] {
  const f = latin(first).replace(/_/g, '');
  const l = latin(last).replace(/_/g, '');
  if (!f) return [];
  const n = () => String(10 + Math.floor(Math.random() * 90));
  const list = [
    l && `${f}_${l}`, l && `${f}${l}`, l && `${f}_${l[0]}`, l && `${l}_${f}`,
    `${f}_${n()}`, `${f}${n()}${n()}`, `${f}_skam`, `the_${f}`,
  ].filter((x): x is string => !!x).map((x) => x.slice(0, 32));
  return [...new Set(list)].filter((x) => USERNAME_RE.test(x));
}

export function mountRegister(root: HTMLElement, onDone: () => void, opts: { existing?: boolean } = {}): void {
  const existing = !!opts.existing;
  root.replaceChildren(html(`
    <main class="auth">
      <div class="auth-card">
        ${APP_ICON_HERO}
        <h1></h1>
        <p class="lead"></p>
        <div id="regBody"></div>
      </div>
    </main>`));
  root.querySelector('h1')!.textContent = existing ? 'Выберите имя пользователя' : 'Создание аккаунта';
  root.querySelector('.lead')!.textContent = existing
    ? 'Теперь у каждого в СКАМ есть @username — по нему вас находят друзья. Без него писать сообщения нельзя.'
    : 'Так вас увидят собеседники в СКАМ.';
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
  // Аккаунтам-исключениям (profiles.username_optional) @username необязателен.
  const unRequired = usernameRequired();
  const un = field('regUser', unRequired ? 'Имя пользователя' : 'Имя пользователя (необязательно)', { maxLength: 33, autocomplete: 'username', required: unRequired, placeholder: '@username', value: S.me?.username ? `@${S.me.username}` : '' });
  un.i.setAttribute('aria-describedby', 'regUserHint');
  un.i.spellcheck = false;
  un.i.autocapitalize = 'off';
  const first = fn.i;
  const UN_HINT = unRequired
    ? 'Обязательно. По нему вас найдут. Латиница, цифры и _, от 5 символов.'
    : 'По нему вас смогут найти. Латиница, цифры и _, от 5 символов.';
  const unHint = el('p', 'hint', UN_HINT);
  unHint.id = 'regUserHint';
  unHint.setAttribute('aria-live', 'polite');
  const sugg = el('div', 'un-sugg');
  sugg.hidden = true;
  const err = el('p', 'err');
  err.setAttribute('role', 'alert');
  const submit = el('button', 'btn primary', existing ? 'Продолжить' : 'Создать аккаунт');
  submit.type = 'submit';

  form.append(avWrap, fn.l, fn.i, ln.l, ln.i, un.l, un.i, unHint, sugg, err, submit);
  const out = button('linkish', 'Войти в другой аккаунт', () => { void sb.auth.signOut(); });
  const note = el('p', 'auth-note');
  note.append(out);
  body.replaceChildren(form, note);
  paintAvatar();
  first.addEventListener('input', paintAvatar);
  form.addEventListener('input', () => { err.textContent = ''; });
  (existing ? un.i : first).focus();

  // Проверка @username на лету
  let checkSeq = 0;
  let unOk = false;
  let unTimer: number | undefined;
  function checkUsername(): void {
    clearTimeout(unTimer);
    const v = normUsername(un.i.value);
    unHint.classList.remove('ok', 'bad');
    if (!v) { unOk = false; unHint.textContent = UN_HINT; return; }
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
      // Занято — подскажем свободные варианты.
      if (!free) void suggest(true);
    }, 350);
  }
  un.i.addEventListener('input', () => { checkUsername(); void suggest(); });

  // Свободные варианты из имени и фамилии — одним нажатием.
  let suggSeq = 0;
  let suggTimer: number | undefined;
  /** force — показать, даже если поле уже заполнено (например, введённое занято). */
  async function suggest(force = false): Promise<void> {
    clearTimeout(suggTimer);
    const seq = ++suggSeq;
    if (!force && normUsername(un.i.value)) { sugg.hidden = true; return; }
    const list = candidates(first.value, ln.i.value);
    if (!list.length) { sugg.hidden = true; return; }
    suggTimer = window.setTimeout(async () => {
      const checked = await Promise.all(list.slice(0, 8).map(async (c) => ((await usernameAvailable(c).catch(() => false)) ? c : null)));
      if (seq !== suggSeq) return;
      const free = checked.filter((c): c is string => !!c).slice(0, 3);
      if (!free.length) { sugg.hidden = true; return; }
      sugg.replaceChildren(el('span', 'un-sugg-l', 'Свободны:'), ...free.map((c) => {
        const b = button('un-chip', `@${c}`, () => {
          un.i.value = `@${c}`;
          checkUsername();
          sugg.hidden = true;
          un.i.focus();
        });
        b.setAttribute('aria-label', `Взять @${c}`);
        return b;
      }));
      sugg.hidden = false;
    }, 400);
  }
  first.addEventListener('input', () => void suggest());
  ln.i.addEventListener('input', () => void suggest());
  if (un.i.value) checkUsername();
  void suggest();

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const firstName = first.value.trim();
    const lastName = ln.i.value.trim();
    const username = normUsername(un.i.value);
    if (!firstName) { err.textContent = 'Введите имя.'; first.focus(); return; }
    if (!username && unRequired) { err.textContent = 'Придумайте имя пользователя — без него в СКАМ нельзя писать.'; un.i.focus(); return; }
    if (username && !USERNAME_RE.test(username)) { err.textContent = 'Имя пользователя: латиница, цифры и _, от 5 до 32 символов, первая — буква.'; un.i.focus(); return; }
    submit.disabled = true;
    submit.textContent = existing ? 'Сохраняем…' : 'Создаём…';
    // Проверка на лету могла не успеть — спросим ещё раз.
    if (username && !unOk) {
      unOk = await usernameAvailable(username).catch(() => false);
      if (!unOk) {
        err.textContent = `@${username} уже занято. Выберите другое.`;
        submit.disabled = false;
        submit.textContent = existing ? 'Продолжить' : 'Создать аккаунт';
        un.i.focus();
        void suggest(true);
        return;
      }
    }
    try {
      await updateMyProfile({ first_name: firstName, last_name: lastName || null, username: username || null });
      onDone();
    } catch (e) {
      const code = (e as { code?: string }).code;
      err.textContent = code === '23505' ? 'Это имя пользователя уже занято.' : 'Не получилось сохранить. Попробуйте ещё раз.';
      submit.disabled = false;
      submit.textContent = existing ? 'Продолжить' : 'Создать аккаунт';
    }
  });
}
