-- СКАМ — аккаунты как в Telegram и приватность.
-- • Профиль: имя и фамилия (name теперь вычисляется из них), @username, «был(а) в сети».
-- • Профиль и статус видят только те, с кем есть общий групповой или личный чат
--   (подписка на канал «Новости СКАМ» не считается). Найти человека можно по точному @username.
-- • Подписчиков канала видит только автор канала.
-- • Общий presence-канал «online» больше не используется: каждый видит только свой статус
--   и статус собеседников.
-- Скрипт идемпотентный.

-- ---------------------------------------------------------------------------
-- 1. Поля профиля
-- ---------------------------------------------------------------------------

alter table public.profiles add column if not exists first_name   text;
alter table public.profiles add column if not exists last_name    text;
alter table public.profiles add column if not exists username     text;
alter table public.profiles add column if not exists last_seen_at timestamptz;
alter table public.profiles add column if not exists online_until timestamptz;

-- Старое поле name → first_name, затем name становится вычисляемым.
do $$
begin
  if exists (
    select 1 from pg_attribute
    where attrelid = 'public.profiles'::regclass and attname = 'name' and not attisdropped and attgenerated = ''
  ) then
    update public.profiles set first_name = nullif(left(btrim(name), 40), '') where first_name is null and name is not null;
    alter table public.profiles drop column name;
  end if;
  if not exists (
    select 1 from pg_attribute
    where attrelid = 'public.profiles'::regclass and attname = 'name' and not attisdropped
  ) then
    alter table public.profiles add column name text
      generated always as (nullif(btrim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), '')) stored;
  end if;
end $$;

alter table public.profiles drop constraint if exists profiles_first_name_check;
alter table public.profiles add constraint profiles_first_name_check
  check (first_name is null or char_length(btrim(first_name)) between 1 and 40);
alter table public.profiles drop constraint if exists profiles_last_name_check;
alter table public.profiles add constraint profiles_last_name_check
  check (last_name is null or char_length(btrim(last_name)) between 1 and 40);
-- @username как в Telegram: 5–32 символа, латиница, цифры и _, начинается с буквы; хранится в нижнем регистре.
alter table public.profiles drop constraint if exists profiles_username_check;
alter table public.profiles add constraint profiles_username_check
  check (username is null or (
    username ~ '^[a-z][a-z0-9_]{4,31}$'
    and username not in ('skam', 'skambot', 'admin', 'administrator', 'support', 'moderator', 'root', 'system', 'news')
  ));
create unique index if not exists profiles_username_key on public.profiles (username);

-- ---------------------------------------------------------------------------
-- 2. Кто кого видит
-- ---------------------------------------------------------------------------

-- Есть ли у меня с человеком общий групповой или личный чат (или это я сам).
create or replace function private.shares_chat(p_user uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_user = (select auth.uid()) or exists (
    select 1
    from public.chat_members a
    join public.chat_members b on b.chat_id = a.chat_id and b.user_id = p_user
    join public.chats c on c.id = a.chat_id and c.kind in ('group', 'direct')
    where a.user_id = (select auth.uid())
  );
$$;

create or replace function private.is_channel(p_chat uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.chats where id = p_chat and kind = 'channel');
$$;

-- Моя роль в чате (null, если я не участник).
create or replace function private.my_role(p_chat uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select role from public.chat_members where chat_id = p_chat and user_id = (select auth.uid());
$$;

revoke execute on function private.shares_chat(uuid), private.is_channel(uuid), private.my_role(uuid) from public, anon;
grant execute on function private.shares_chat(uuid), private.is_channel(uuid), private.my_role(uuid) to authenticated;

drop policy if exists "profiles: read" on public.profiles;
create policy "profiles: read" on public.profiles
  for select to authenticated using (private.shares_chat(id));

-- В канале каждый видит только себя и авторов; весь список подписчиков — только авторам.
drop policy if exists "members: read" on public.chat_members;
create policy "members: read" on public.chat_members
  for select to authenticated using (
    private.is_chat_member(chat_id)
    and (
      not private.is_channel(chat_id)
      or user_id = (select auth.uid())
      or role = 'owner'
      or private.my_role(chat_id) = 'owner'
    )
  );

-- Права на колонки профиля: имя, фамилия, username и аватар меняет сам человек;
-- «в сети» — только через ping(), чтобы время нельзя было подделать.
revoke update on public.profiles from authenticated;
grant update (first_name, last_name, username, avatar_path) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- 3. RPC
-- ---------------------------------------------------------------------------

-- Пульс присутствия: true — «в сети» ещё 75 секунд, false — вышел прямо сейчас.
create or replace function public.ping(p_online boolean default true)
returns void
language sql security definer set search_path = ''
as $$
  update public.profiles
  set last_seen_at = now(),
      online_until = case when p_online then now() + interval '75 seconds' else now() end
  where id = (select auth.uid());
$$;

-- Найти человека по точному @username (как поиск в Telegram).
create or replace function public.find_user(p_username text)
returns table (id uuid, name text, username text, avatar_path text, color text)
language sql stable security definer set search_path = ''
as $$
  select p.id, p.name, p.username, p.avatar_path, p.color
  from public.profiles p
  where (select auth.uid()) is not null
    and p.username = lower(ltrim(btrim(p_username), '@'))
    and p.first_name is not null;
$$;

-- Свободен ли @username.
create or replace function public.username_available(p_username text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select (select auth.uid()) is not null
    and lower(p_username) ~ '^[a-z][a-z0-9_]{4,31}$'
    and lower(p_username) not in ('skam', 'skambot', 'admin', 'administrator', 'support', 'moderator', 'root', 'system', 'news')
    and not exists (
      select 1 from public.profiles
      where username = lower(p_username) and id <> (select auth.uid())
    );
$$;

revoke execute on function public.ping(boolean), public.find_user(text), public.username_available(text) from public, anon;
grant execute on function public.ping(boolean), public.find_user(text), public.username_available(text) to authenticated;

-- Новый пользователь: имя берём из метаданных, если оно пришло при регистрации.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  palette text[] := array['#F25A1E', '#B5400C', '#8FB224', '#D98A00', '#3A7CA5', '#7B4FA0', '#C2185B', '#00897B', '#5C6BC0', '#6E685E'];
  fn text := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'first_name', new.raw_user_meta_data ->> 'name', '')), '');
  ln text := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'last_name', '')), '');
begin
  insert into public.profiles (id, first_name, last_name, color)
  values (new.id, left(fn, 40), left(ln, 40), palette[1 + floor(random() * array_length(palette, 1))::int])
  on conflict (id) do nothing;

  insert into public.chat_members (chat_id, user_id)
  select c.id, new.id from public.chats c where c.is_default
  on conflict do nothing;

  perform private.ensure_bot_chat(new.id);
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Realtime: только каналы чатов (общий «online» убран)
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists "skam: realtime read" on realtime.messages';
    execute 'drop policy if exists "skam: realtime write" on realtime.messages';
    execute $p$
      create policy "skam: realtime read" on realtime.messages
        for select to authenticated
        using (exists (
          select 1 from public.chat_members m
          where m.user_id = (select auth.uid())
            and 'chat:' || m.chat_id::text = (select realtime.topic())
        ))
    $p$;
    execute $p$
      create policy "skam: realtime write" on realtime.messages
        for insert to authenticated
        with check (exists (
          select 1 from public.chat_members m
          where m.user_id = (select auth.uid())
            and 'chat:' || m.chat_id::text = (select realtime.topic())
        ))
    $p$;
  end if;
end $$;

notify pgrst, 'reload schema';
