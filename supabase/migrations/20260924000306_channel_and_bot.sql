-- СКАМ — канал «Новости СКАМ» и бот «СКАМ».
-- • Общий чат становится каналом новостей: читать и ставить реакции могут все,
--   писать — только авторы канала (chat_members.role = 'owner').
-- • Приветствие переезжает в личный чат с ботом СКАМ: он есть у каждого пользователя
--   и отвечает на простые фразы («привет», «помощь»…).
-- Скрипт идемпотентный.

-- ---------------------------------------------------------------------------
-- 1. Новые виды чатов: channel и bot
-- ---------------------------------------------------------------------------

alter table public.chats drop constraint if exists chats_kind_check;
alter table public.chats add constraint chats_kind_check
  check (kind in ('group', 'direct', 'channel', 'bot'));

alter table public.chats drop constraint if exists chats_kind_shape;
alter table public.chats add constraint chats_kind_shape check (
  (kind in ('group', 'channel') and name is not null and direct_key is null)
  or (kind = 'direct' and direct_key is not null and invite_code is null and not is_default)
  or (kind = 'bot' and name is not null and direct_key is not null and invite_code is null and not is_default)
);

-- ---------------------------------------------------------------------------
-- 2. Кто может писать: в канал — только авторы
-- ---------------------------------------------------------------------------

create or replace function private.can_post(p_chat uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.chat_members m
    join public.chats c on c.id = m.chat_id
    where m.chat_id = p_chat
      and m.user_id = (select auth.uid())
      and (c.kind <> 'channel' or m.role = 'owner')
  );
$$;
revoke execute on function private.can_post(uuid) from public, anon;
grant execute on function private.can_post(uuid) to authenticated;

drop policy if exists "messages: members write" on public.messages;
create policy "messages: members write" on public.messages
  for insert to authenticated
  with check (user_id = (select auth.uid()) and kind = 'text' and deleted_at is null
              and private.can_post(chat_id));

-- Выйти можно только из групп и личных чатов (через RPC); канал новостей и бот остаются.
drop policy if exists "members: leave" on public.chat_members;
revoke delete on public.chat_members from authenticated;

create or replace function public.leave_chat(p_chat uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.chats
    where id = p_chat and kind in ('group', 'direct') and not is_default
  ) then
    raise exception 'cannot leave this chat' using errcode = '42501';
  end if;
  delete from public.chat_members where chat_id = p_chat and user_id = (select auth.uid());
  delete from public.chats c
  where c.id = p_chat
    and not exists (select 1 from public.chat_members m where m.chat_id = c.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Канал «Новости СКАМ» (бывший общий чат)
-- ---------------------------------------------------------------------------

update public.chats
set kind = 'channel', name = 'Новости СКАМ', emoji = '📣'
where id = '00000000-0000-0000-0000-000000000001';

delete from public.messages
where chat_id = '00000000-0000-0000-0000-000000000001'
  and kind = 'system' and body like 'Добро пожаловать в СКАМ!%';

insert into public.messages (chat_id, user_id, kind, body, created_at)
select '00000000-0000-0000-0000-000000000001', null, 'system', v.body, now() + v.shift
from (values
  ('📣 Это канал новостей СКАМ. Здесь будут обновления, новые функции и важные объявления. Писать сюда могут только авторы канала, а реакции ставить — все.', interval '0'),
  ('🚀 Вышла веб-версия СКАМ: групповые и личные чаты, приглашения по ссылке, реакции, «печатает…» и кто в сети. А ещё СКАМ можно установить на телефон прямо из браузера.', interval '1 millisecond')
) as v(body, shift)
where not exists (
  select 1 from public.messages
  where chat_id = '00000000-0000-0000-0000-000000000001' and kind = 'system' and body like '📣 Это канал новостей СКАМ%'
);

-- ---------------------------------------------------------------------------
-- 4. Бот СКАМ: личный чат у каждого пользователя
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
     'Привет! 👋 Я бот СКАМ. Добро пожаловать — это не развод, а мессенджер.',
     clock_timestamp()),
    (cid, null, 'system',
     E'Что здесь можно делать:\n• «Новый чат» — завести группу и позвать друзей по ссылке;\n• нажмите на имя или аватар участника — и напишите ему лично;\n• наведите на сообщение (на телефоне — коснитесь) — появятся реакции;\n• новости и обновления — в канале «Новости СКАМ».\n\nНапишите мне «привет» или «помощь» 🙂',
     clock_timestamp() + interval '1 millisecond');
  return cid;
end;
$$;
revoke all on function private.ensure_bot_chat(uuid) from public, anon, authenticated;

-- Ответы бота на простые фразы.
create or replace function private.bot_reply()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  t text := lower(btrim(new.body));
  nm text;
  reply text;
begin
  if not exists (select 1 from public.chats where id = new.chat_id and kind = 'bot') then
    return null;
  end if;
  select name into nm from public.profiles where id = new.user_id;

  if t ~ '^(/start|привет|прив|здравствуй|здрасте|здорово|добр(ый|ое|ого)|хай|хелло|салют|hi|hello|hey)' then
    reply := 'Привет, ' || coalesce(nm, 'друг') || '! 👋 Рад видеть. Напишите «помощь» — расскажу, что умею.';
  elsif t ~ '(помощь|помоги|help|команд|умеешь)' then
    reply := E'Я умею немного, но честно:\n• «привет» — поздороваюсь;\n• «помощь» — это сообщение;\n• «это развод?» — объясню, почему нет.\n\nА ещё подскажу по СКАМ:\n• «Новый чат» — создать группу; ссылка-приглашение — в меню чата (нажмите на его название);\n• написать лично — нажмите на имя или аватар участника;\n• реакции — наведите на сообщение или коснитесь его;\n• имя, фото и тема — в профиле внизу слева.';
  elsif t ~ '(развод|скам|мошен|scam|обман)' then
    reply := 'СКАМ — не развод, а мессенджер. Честно-честно 🤞 Чужие чаты никто не видит: доступ к каждому сообщению проверяет база.';
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
revoke all on function private.bot_reply() from public, anon, authenticated;

drop trigger if exists messages_bot_reply on public.messages;
create trigger messages_bot_reply after insert on public.messages
  for each row when (new.kind = 'text')
  execute function private.bot_reply();

-- Новый пользователь: профиль, подписка на канал и чат с ботом.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  palette text[] := array['#F25A1E', '#B5400C', '#8FB224', '#D98A00', '#3A7CA5', '#7B4FA0', '#C2185B', '#00897B', '#5C6BC0', '#6E685E'];
  nm text := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'name', '')), '');
begin
  insert into public.profiles (id, name, color)
  values (new.id, left(nm, 40), palette[1 + floor(random() * array_length(palette, 1))::int])
  on conflict (id) do nothing;

  insert into public.chat_members (chat_id, user_id)
  select c.id, new.id from public.chats c where c.is_default
  on conflict do nothing;

  perform private.ensure_bot_chat(new.id);
  return new;
end;
$$;

-- Тем, кто уже зарегистрирован, тоже заводим бота.
do $$ begin perform private.ensure_bot_chat(p.id) from public.profiles p; end $$;

notify pgrst, 'reload schema';
