-- СКАМ 0.3.6: «Избранное» и расшифровка «Свободный Конфиденциальный Автономный Мессенджер».
--
-- • «Избранное» — личный чат с самим собой (kind = 'saved', один на человека, direct_key = 'saved:<id>').
--   Туда можно писать заметки и сохранять любые сообщения из других чатов (это пересылка с «Переслано от …»).
--   Чат со сквозным шифрованием, как личные чаты и группы: ключ чата завёрнут только для самого человека
--   (а значит, доступен на всех его устройствах после пароля шифрования). Сервер видит лишь шифротекст.
--   Создаётся при первом обращении (open_saved) — приложение зовёт его само. Выйти из него или удалить нельзя.
-- • Бот: ответ на «это развод?» и приветствие — с расшифровкой СКАМ; новые ответы «избранное» и «эмодзи».

-- ---------------------------------------------------------------------------
-- 1. Вид чата 'saved'
-- ---------------------------------------------------------------------------

alter table public.chats drop constraint if exists chats_kind_check;
alter table public.chats add constraint chats_kind_check
  check (kind in ('group', 'direct', 'channel', 'bot', 'saved'));

alter table public.chats drop constraint if exists chats_kind_shape;
alter table public.chats add constraint chats_kind_shape check (
  (kind in ('group', 'channel') and name is not null and direct_key is null)
  or (kind = 'direct' and direct_key is not null and invite_code is null and not is_default)
  or (kind = 'bot' and name is not null and direct_key is not null and invite_code is null and not is_default)
  or (kind = 'saved' and name is null and direct_key is not null and invite_code is null and not is_default)
);

-- Сквозное шифрование: личные чаты, группы и «Избранное».
create or replace function private.is_e2e_member(p_chat uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.chat_members m
    join public.chats c on c.id = m.chat_id
    where m.chat_id = p_chat and m.user_id = (select auth.uid()) and c.kind in ('group', 'direct', 'saved')
  );
$$;

create or replace function private.key_in_chat(p_key uuid, p_chat uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.chat_keys k join public.chats c on c.id = k.chat_id
    where k.id = p_key and k.chat_id = p_chat and c.kind in ('group', 'direct', 'saved')
  );
$$;

create or replace function public.e2e_pending(p_limit integer default 300)
returns table (chat_id uuid, key_id uuid, user_id uuid, public_key text)
language sql stable security definer set search_path = ''
as $$
  select distinct k.chat_id, k.id, m.user_id, uk.public_key
  from public.chat_key_shares mine
  join public.chat_keys k on k.id = mine.key_id
  join public.chats c on c.id = k.chat_id and c.kind in ('group', 'direct', 'saved')
  join public.chat_members self on self.chat_id = k.chat_id and self.user_id = mine.user_id
  join public.chat_members m on m.chat_id = k.chat_id and m.user_id <> mine.user_id
  join public.user_keys uk on uk.user_id = m.user_id
  where mine.user_id = (select auth.uid())
    and not exists (
      select 1 from public.chat_key_shares s where s.key_id = k.id and s.user_id = m.user_id
    )
    and (uk.reset_at is null or k.created_at > uk.reset_at or m.joined_at > k.created_at)
  limit greatest(1, least(coalesce(p_limit, 300), 1000));
$$;

-- Моё «Избранное»: найти или создать. Возвращает id чата.
create or replace function public.open_saved()
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  k text;
  cid uuid;
begin
  perform private.require_registered();
  k := 'saved:' || v_me::text;
  select id into cid from public.chats where direct_key = k;
  if cid is null then
    insert into public.chats (kind, name, emoji, direct_key, invite_code, created_by)
    values ('saved', null, '🔖', k, null, v_me)
    on conflict (direct_key) do nothing
    returning id into cid;
    if cid is null then
      select id into cid from public.chats where direct_key = k;
    end if;
  end if;
  insert into public.chat_members (chat_id, user_id) values (cid, v_me) on conflict do nothing;
  return cid;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Бот: расшифровка СКАМ, «избранное», «эмодзи»
-- ---------------------------------------------------------------------------

create or replace function private.ensure_bot_chat(p_user uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  k text := 'bot:' || p_user::text;
  cid uuid;
begin
  insert into public.chats (kind, name, emoji, direct_key, invite_code)
  values ('bot', 'СКАМ', '🤖', k, null)
  on conflict (direct_key) do nothing
  returning id into cid;

  if cid is null then
    select id into cid from public.chats where direct_key = k;
    insert into public.chat_members (chat_id, user_id) values (cid, p_user) on conflict do nothing;
    return cid;
  end if;

  -- Приветствие показываем непрочитанным, чтобы новичок его заметил.
  insert into public.chat_members (chat_id, user_id, last_read_at) values (cid, p_user, '-infinity');
  insert into public.messages (chat_id, user_id, kind, body, created_at) values
    (cid, null, 'system',
     'Привет! 👋 Я бот СКАМ. Добро пожаловать в Свободный Конфиденциальный Автономный Мессенджер — это не развод, а мессенджер.',
     clock_timestamp()),
    (cid, null, 'system',
     E'Что здесь можно делать:\n• «Новый чат» — завести группу и позвать друзей по ссылке;\n• нажмите на имя или аватар участника — и напишите ему лично;\n• наведите на сообщение (на телефоне — коснитесь) — появятся реакции и «В избранное»;\n• заметки и сохранённые сообщения — в чате «Избранное»;\n• новости и обновления — в канале «Новости СКАМ».\n\nНапишите мне «привет» или «помощь» 🙂',
     clock_timestamp() + interval '1 millisecond');
  return cid;
end;
$$;

create or replace function private.bot_reply()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  t text := lower(btrim(new.body));
  nm text;
  reply text;
  n int;
begin
  if not exists (select 1 from public.chats where id = new.chat_id and kind = 'bot') then
    return null;
  end if;
  select first_name into nm from public.profiles where id = new.user_id;

  if new.kind = 'sticker' then
    reply := case when new.sticker like 'dove/%' then 'Голубь Свободы одобряет 🕊️'
                  else 'Классный стикер! 🎨 Свои наборы — в панели стикеров, кнопка «+».' end;
  elsif new.kind = 'voice' then
    reply := 'Голосовое получил! Но слушать я пока не умею — я же бот 🙈 Напишите текстом, отвечу.';
  elsif new.kind = 'video_note' then
    reply := 'Кружочек получил — выглядите свободно! 🕊️ Смотреть видео я пока не умею, но друзьям понравится.';
  elsif new.kind = 'media' then
    n := coalesce(jsonb_array_length(new.files), 0);
    if n > 0 and not exists (select 1 from jsonb_array_elements(new.files) f where f ->> 'kind' <> 'photo') then
      reply := case when n = 1 then 'Классное фото! 📸' else 'Классные фото! 📸' end
        || ' Смотреть картинки я пока не умею, но друзьям точно понравится. Отправляйте им — в личных чатах и группах файлы защищены сквозным шифрованием 🔒';
    elsif n > 0 and not exists (select 1 from jsonb_array_elements(new.files) f where f ->> 'kind' <> 'video') then
      reply := 'Видео получил 🎬 Смотреть я пока не умею, а вот друзьям — самое то. В личных чатах и группах оно будет зашифровано 🔒';
    else
      reply := 'Файл получил 📎 Я бот и открыть его не могу, но в личных чатах и группах СКАМ файлы до 50 МБ передаются зашифрованными 🔒';
    end if;
  elsif t ~ '^(/start|привет|прив|здравствуй|здрасте|здорово|добр(ый|ое|ого)|хай|хелло|салют|hi|hello|hey)' then
    reply := 'Привет, ' || coalesce(nm, 'друг') || '! 👋 Рад видеть. Напишите «помощь» — расскажу, что умею.';
  elsif t ~ '(помощь|помоги|help|команд|умеешь)' then
    reply := E'Я умею немного, но честно:\n• «привет» — поздороваюсь;\n• «помощь» — это сообщение;\n• «стикеры» — расскажу про Голубя свободы и свои наборы;\n• «эмодзи» — расскажу про свои эмодзи, реакции и супер-реакции;\n• «избранное» — расскажу, как сохранять сообщения;\n• «галочка» — расскажу, что значит официальная галочка;\n• «шифрование» — расскажу, как защищена переписка;\n• «звонки» — расскажу про звонки;\n• «это развод?» — объясню, почему нет.\n\nА ещё подскажу по СКАМ:\n• «Новый чат» — написать человеку по имени или @username, создать группу или канал;\n• стикеры и эмодзи — кнопка со смайликом у поля ввода; наберите эмодзи — подходящие стикеры появятся сами; свои наборы — кнопка «+» в панели;\n• голосовое — удерживайте микрофон справа от поля ввода и отпустите, чтобы отправить; уведите палец влево — отмена, вверх — запись без рук;\n• кружочек — коротко нажмите на микрофон, он станет камерой, дальше так же: удерживайте;\n• скрепка 📎 слева от поля ввода — фото, видео, гифки и файлы до 50 МБ (можно просто перетащить или вставить из буфера);\n• реакции — наведите на сообщение или коснитесь его (на телефоне — долгое нажатие), «+» — все реакции и свои эмодзи;\n• ответить — стрелка ↩ над сообщением или правый клик → «Ответить» (на телефоне — смахните сообщение влево);\n• переслать — стрелка ↪ или «Выбрать» несколько сообщений и «Переслать»;\n• сохранить — правый клик → «В избранное»: всё сохранённое лежит в чате «Избранное»;\n• звонки — трубка 📞 и камера 📹 в шапке личного чата или группы: голос, видео и демонстрация экрана, как в Discord;\n• имя, @username, фото, тема и пароль шифрования — в профиле внизу слева.';
  elsif t ~ '(избранн|сохран|закладк|заметк)' then
    reply := E'🔖 «Избранное» — ваш личный чат с самим собой. Пишите туда заметки, ссылки и списки, кидайте файлы.\n\nЛюбое сообщение из любого чата можно сохранить: правый клик (на телефоне — долгое нажатие) → «В избранное». Сохранённое придёт туда с подписью «Переслано от …», даже если оригинал потом удалят.\n\n🔒 «Избранное» защищено сквозным шифрованием, как личные чаты: его видите только вы — на всех своих устройствах.';
  elsif t ~ '(эмодзи|смайл|emoji|реакц)' then
    reply := E'😀 Свои эмодзи: смайлик у поля ввода → вкладка «Эмодзи» → «+» → «Создать набор». Картинка и название, например :кот: — и эмодзи можно вставлять в сообщения и ставить реакцией.\n\nРеакций на одно сообщение — до трёх. «+» рядом с быстрыми реакциями открывает все, в том числе ваши эмодзи.\n\n⭐ Супер-реакция выделена цветом. Она открывается тем, кто давно и постоянно в группе или канале: открывает его, пишет, ставит реакции.';
  elsif t ~ '(галочк|официальн|верифик|verified)' then
    reply := E'✅ Официальная галочка рядом с именем значит, что это настоящий аккаунт или канал, а не подделка. Её выдаёт только команда СКАМ — купить или поставить самому нельзя.\n\nНапример, галочка есть у канала «Новости СКАМ» и у меня 🙂 Если кто-то пишет от имени известного человека без галочки — будьте осторожны.';
  elsif t ~ '(стикер|голуб|sticker)' then
    reply := E'🕊️ Голубь свободы — маскот СКАМ и наш официальный набор из 16 стикеров: «Привет!», «Да», «Нет», «Ха-ха-ха», «Люблю», «Что?!», «Жду», «Спокойной ночи», «Грусть», «Бесишь!», «Хм…», «Свобода!», «Не развод», «Спасибо», «Доброе утро» и «OK».\n\n🎨 Свои стикеры: в панели стикеров нажмите «+» → «Создать набор», добавьте картинки и к каждой — эмодзи. Ссылкой на набор можно поделиться, а чужой стикер в чате — нажать и добавить весь набор к себе.\n\nНажмите на смайлик у поля ввода или просто наберите 👋, 😂 или 🤔 — подходящий стикер появится сам. Пришлите мне любой — оценю!';
  elsif t ~ '(голосов|кружоч|кружк|видеосообщ|микрофон)' then
    reply := E'🎤 Голосовое: удерживайте микрофон справа от поля ввода, говорите и отпустите — сообщение уйдёт. Передумали — уведите палец влево. Долго говорить — потяните вверх, запись закрепится.\n\n⚪ Кружочек: коротко нажмите на микрофон — он станет камерой. Дальше так же: удерживайте, до минуты.\n\nСлушают и смотрят только участники чата.';
  elsif t ~ '(звон|созвон|видеозв|трубк|демонстрац|call)' then
    reply := E'📞 Звонки в СКАМ — как в Discord: в личном чате или группе нажмите трубку (голос) или камеру (видео) в шапке чата. У собеседников зазвонит, а в группе к идущему звонку можно присоединиться в любой момент — до 8 человек.\n\nВ звонке можно выключить микрофон, выключить звук, включить камеру и показать экран (на компьютере). Звонок не мешает переписке: уйдите в другой чат — внизу слева останется панель «Голосовая связь подключена».\n\n🔒 Звук и видео идут напрямую между участниками и зашифрованы; служебные данные соединения шифруются ключом чата, так что сервер не может подслушать.';
  elsif t ~ '(шифр|безопас|e2e|encrypt|ключ)' then
    reply := E'🔒 Личные чаты, группы и «Избранное» в СКАМ защищены сквозным шифрованием: сообщения, фото, видео, файлы, стикеры, голосовые и кружочки шифруются прямо на вашем устройстве и расшифровываются только у собеседников. На сервере лежит лишь шифротекст — прочитать его не можем даже мы.\n\nЗвонки идут напрямую между участниками и тоже зашифрованы.\n\nКлюч хранится на ваших устройствах, а на новом устройстве восстанавливается паролем шифрования.\n\nКаналы и этот чат со мной не шифруются — как каналы и боты в Telegram.';
  elsif t ~ '(развод|скам|мошен|scam|обман|расшифров|аббревиат)' then
    reply := E'СКАМ — это Свободный Конфиденциальный Автономный Мессенджер, а не развод. Честно-честно 🤞\n\n• Свободный — пишите кому хотите, без рекламы и слежки;\n• Конфиденциальный — личные чаты, группы и «Избранное» защищены сквозным шифрованием: их не прочитает никто, кроме участников, — даже сервер;\n• Автономный — свой сервер в России, без чужих облаков.';
  elsif t ~ '(спасибо|спс|благодар)' then
    reply := 'Всегда пожалуйста! 🧡';
  elsif t ~ '(пока|до свидания|бывай)' then
    reply := 'До встречи! Я всегда здесь 👋';
  else
    reply := 'Я пока простой бот и понимаю немного 🙂 Напишите «помощь» — расскажу, что умею. А болтать веселее с людьми: создайте чат и позовите друзей.';
  end if;

  insert into public.messages (chat_id, user_id, kind, body, created_at)
  values (new.chat_id, null, 'system', reply, clock_timestamp());
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Доступ к функциям
-- ---------------------------------------------------------------------------

revoke all on function public.open_saved() from public, anon;
grant execute on function public.open_saved() to authenticated, service_role;
revoke all on function public.e2e_pending(integer) from public, anon;
grant execute on function public.e2e_pending(integer) to authenticated, service_role;
revoke all on function private.is_e2e_member(uuid) from public, anon;
grant execute on function private.is_e2e_member(uuid) to authenticated;
revoke all on function private.key_in_chat(uuid, uuid) from public, anon;
grant execute on function private.key_in_chat(uuid, uuid) to authenticated;
revoke all on function private.ensure_bot_chat(uuid) from public, anon, authenticated;
revoke all on function private.bot_reply() from public, anon, authenticated;

notify pgrst, 'reload schema';
