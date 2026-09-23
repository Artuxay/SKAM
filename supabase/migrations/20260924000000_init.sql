-- СКАМ — начальная схема базы.
-- Профили, чаты, участники, сообщения, реакции, непрочитанные,
-- RLS-политики, RPC-функции, Realtime и хранилище аватарок.
--
-- Применение: Supabase Dashboard → SQL Editor → вставить файл целиком → Run
-- (или `supabase db push`, если проект привязан через CLI).

-- ---------------------------------------------------------------------------
-- Таблицы
-- ---------------------------------------------------------------------------

create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  name        text check (name is null or char_length(btrim(name)) between 1 and 40),
  avatar_path text check (avatar_path is null or (char_length(avatar_path) <= 200 and avatar_path like id::text || '/%')),
  color       text not null default '#F25A1E' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.profiles is 'Публичный профиль пользователя: имя, аватарка, цвет буквенного аватара.';

create table public.chats (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null default 'group' check (kind in ('group', 'direct')),
  name        text check (name is null or char_length(btrim(name)) between 1 and 40),
  emoji       text not null default '💬' check (char_length(emoji) between 1 and 8),
  created_by  uuid references public.profiles (id) on delete set null,
  invite_code text unique default substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
  direct_key  text unique,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  constraint chats_kind_shape check (
    (kind = 'group'  and name is not null and direct_key is null)
    or (kind = 'direct' and direct_key is not null and invite_code is null and not is_default)
  )
);
comment on table public.chats is 'Групповые и личные чаты.';
comment on column public.chats.is_default is 'Общий чат: в него автоматически попадает каждый новый пользователь.';

create table public.chat_members (
  chat_id      uuid not null references public.chats (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  role         text not null default 'member' check (role in ('owner', 'member')),
  joined_at    timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  primary key (chat_id, user_id)
);
create index chat_members_user_idx on public.chat_members (user_id);

create table public.messages (
  id         uuid primary key default gen_random_uuid(),
  chat_id    uuid not null references public.chats (id) on delete cascade,
  user_id    uuid default auth.uid() references public.profiles (id) on delete set null,
  kind       text not null default 'text' check (kind in ('text', 'system')),
  body       text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint messages_body_shape check (
    (deleted_at is null and char_length(btrim(body)) between 1 and 4000)
    or (deleted_at is not null and body = '')
  )
);
create index messages_chat_created_idx on public.messages (chat_id, created_at desc, id desc);

create table public.reactions (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  emoji      text not null check (emoji in ('like', 'lol', 'fire', 'wow', 'clown')),
  chat_id    uuid not null references public.chats (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);
create index reactions_chat_idx on public.reactions (chat_id);

-- ---------------------------------------------------------------------------
-- Служебные функции и триггеры
-- ---------------------------------------------------------------------------

-- Участник ли текущий пользователь чата. SECURITY DEFINER — чтобы политики
-- на chat_members не вызывали сами себя рекурсивно.
create function public.is_chat_member(p_chat uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.chat_members
    where chat_id = p_chat and user_id = (select auth.uid())
  );
$$;

create function public.touch_updated_at()
returns trigger language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- Реакция хранит chat_id сообщения: так проще RLS и фильтры Realtime.
create function public.reactions_fill_chat()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  select m.chat_id into new.chat_id from public.messages m where m.id = new.message_id;
  new.user_id := (select auth.uid());
  new.created_at := now();
  return new;
end;
$$;

create trigger reactions_fill before insert on public.reactions
  for each row execute function public.reactions_fill_chat();

-- Новый пользователь → профиль + членство в общих чатах.
create function public.handle_new_user()
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

  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.profiles     enable row level security;
alter table public.chats        enable row level security;
alter table public.chat_members enable row level security;
alter table public.messages     enable row level security;
alter table public.reactions    enable row level security;

-- Профили видят все вошедшие; менять можно только свой.
create policy "profiles: read" on public.profiles
  for select to authenticated using (true);
create policy "profiles: update own" on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Чаты видят только участники; переименовать/удалить группу может владелец.
create policy "chats: members read" on public.chats
  for select to authenticated using (public.is_chat_member(id));
create policy "chats: owner update" on public.chats
  for update to authenticated
  using (kind = 'group' and exists (
    select 1 from public.chat_members m
    where m.chat_id = chats.id and m.user_id = (select auth.uid()) and m.role = 'owner'))
  with check (kind = 'group');
create policy "chats: owner delete" on public.chats
  for delete to authenticated
  using (not is_default and exists (
    select 1 from public.chat_members m
    where m.chat_id = chats.id and m.user_id = (select auth.uid()) and m.role = 'owner'));

-- Состав чата видят его участники; выйти из чата может каждый сам.
create policy "members: read" on public.chat_members
  for select to authenticated using (public.is_chat_member(chat_id));
create policy "members: leave" on public.chat_members
  for delete to authenticated using (user_id = (select auth.uid()));

-- Сообщения: читают и пишут участники; автор — всегда текущий пользователь.
create policy "messages: members read" on public.messages
  for select to authenticated using (public.is_chat_member(chat_id));
create policy "messages: members write" on public.messages
  for insert to authenticated
  with check (user_id = (select auth.uid()) and kind = 'text' and deleted_at is null
              and public.is_chat_member(chat_id));

-- Реакции: участники чата, только от своего имени и не на удалённые сообщения.
create policy "reactions: members read" on public.reactions
  for select to authenticated using (public.is_chat_member(chat_id));
create policy "reactions: add own" on public.reactions
  for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_chat_member(chat_id)
              and exists (select 1 from public.messages m where m.id = message_id and m.deleted_at is null));
create policy "reactions: remove own" on public.reactions
  for delete to authenticated using (user_id = (select auth.uid()));

-- Права на уровне колонок: клиент не может подделать автора, время или статус.
revoke all on public.profiles, public.chats, public.chat_members, public.messages, public.reactions from anon, authenticated;
grant select on public.profiles, public.chats, public.chat_members, public.messages, public.reactions to authenticated;
grant update (name, avatar_path) on public.profiles to authenticated;
grant update (name, emoji) on public.chats to authenticated;
grant delete on public.chats to authenticated;
grant delete on public.chat_members to authenticated;
grant insert (id, chat_id, body) on public.messages to authenticated;
grant insert (message_id, emoji) on public.reactions to authenticated;
grant delete on public.reactions to authenticated;

-- ---------------------------------------------------------------------------
-- RPC
-- ---------------------------------------------------------------------------

-- Создать групповой чат (создатель становится владельцем).
create function public.create_chat(p_name text, p_emoji text default '💬')
returns public.chats
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  c public.chats;
begin
  if me is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  insert into public.chats (kind, name, emoji, created_by)
  values ('group', left(btrim(p_name), 40), coalesce(nullif(btrim(p_emoji), ''), '💬'), me)
  returning * into c;
  insert into public.chat_members (chat_id, user_id, role) values (c.id, me, 'owner');
  return c;
end;
$$;

-- Что за чат скрывается за приглашением (для экрана «Вступить?»).
create function public.chat_by_invite(p_code text)
returns table (id uuid, name text, emoji text, member_count int, is_member boolean)
language sql stable security definer set search_path = ''
as $$
  select c.id, c.name, c.emoji,
         (select count(*) from public.chat_members m where m.chat_id = c.id)::int,
         exists (select 1 from public.chat_members m where m.chat_id = c.id and m.user_id = (select auth.uid()))
  from public.chats c
  where c.kind = 'group' and c.invite_code = p_code and (select auth.uid()) is not null;
$$;

-- Вступить в чат по коду приглашения. Возвращает id чата.
create function public.join_chat(p_code text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  cid uuid;
begin
  if me is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select id into cid from public.chats where kind = 'group' and invite_code = p_code;
  if cid is null then raise exception 'invite not found' using errcode = 'P0002'; end if;
  insert into public.chat_members (chat_id, user_id) values (cid, me) on conflict do nothing;
  return cid;
end;
$$;

-- Новый код приглашения (старая ссылка перестанет работать). Только владелец.
create function public.reset_invite(p_chat uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare code text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
begin
  update public.chats c set invite_code = code
  where c.id = p_chat and c.kind = 'group' and exists (
    select 1 from public.chat_members m
    where m.chat_id = c.id and m.user_id = (select auth.uid()) and m.role = 'owner');
  if not found then raise exception 'forbidden' using errcode = '42501'; end if;
  return code;
end;
$$;

-- Личный чат с пользователем: найти или создать. Возвращает id чата.
create function public.open_direct(p_user uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  k text;
  cid uuid;
begin
  if me is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_user is null or p_user = me then raise exception 'bad user' using errcode = '22023'; end if;
  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  k := least(me, p_user)::text || ':' || greatest(me, p_user)::text;
  insert into public.chats (kind, direct_key, invite_code, created_by)
  values ('direct', k, null, me)
  on conflict (direct_key) do nothing;
  select id into cid from public.chats where direct_key = k;
  insert into public.chat_members (chat_id, user_id)
  values (cid, me), (cid, p_user)
  on conflict do nothing;
  return cid;
end;
$$;

-- Удалить своё сообщение (остаётся плашка «Сообщение удалено»).
create function public.delete_message(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.messages
  set deleted_at = now(), body = ''
  where id = p_id and user_id = (select auth.uid()) and deleted_at is null;
  if not found then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.reactions where message_id = p_id;
end;
$$;

-- Отметить чат прочитанным до момента p_at (но не позже «сейчас»).
create function public.mark_read(p_chat uuid, p_at timestamptz default now())
returns void
language sql security definer set search_path = ''
as $$
  update public.chat_members
  set last_read_at = greatest(last_read_at, least(coalesce(p_at, now()), now()))
  where chat_id = p_chat and user_id = (select auth.uid());
$$;

-- Выйти из чата. Пустая группа удаляется.
create function public.leave_chat(p_chat uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.chat_members where chat_id = p_chat and user_id = (select auth.uid());
  delete from public.chats c
  where c.id = p_chat and not c.is_default
    and not exists (select 1 from public.chat_members m where m.chat_id = c.id);
end;
$$;

-- Список моих чатов для боковой панели: последнее сообщение и счётчик непрочитанных.
create function public.my_chats()
returns table (
  id uuid, kind text, name text, emoji text, invite_code text, is_default boolean,
  created_at timestamptz, role text, last_read_at timestamptz,
  member_count int, peer_id uuid, unread int,
  last_id uuid, last_body text, last_user_id uuid, last_kind text,
  last_at timestamptz, last_deleted boolean
)
language sql stable security definer set search_path = ''
as $$
  select c.id, c.kind, c.name, c.emoji, c.invite_code, c.is_default,
         c.created_at, cm.role, cm.last_read_at,
         (select count(*) from public.chat_members x where x.chat_id = c.id)::int,
         case when c.kind = 'direct' then
           (select x.user_id from public.chat_members x where x.chat_id = c.id and x.user_id <> cm.user_id limit 1)
         end,
         (select count(*) from public.messages m
           where m.chat_id = c.id and m.created_at > cm.last_read_at
             and m.user_id is distinct from cm.user_id and m.deleted_at is null)::int,
         lm.id, left(lm.body, 200), lm.user_id, lm.kind, lm.created_at, lm.deleted_at is not null
  from public.chat_members cm
  join public.chats c on c.id = cm.chat_id
  left join lateral (
    select m.id, m.body, m.user_id, m.kind, m.created_at, m.deleted_at
    from public.messages m where m.chat_id = c.id
    order by m.created_at desc, m.id desc limit 1
  ) lm on true
  where cm.user_id = (select auth.uid())
  order by coalesce(lm.created_at, c.created_at) desc;
$$;

revoke execute on function
  public.is_chat_member(uuid), public.create_chat(text, text), public.chat_by_invite(text),
  public.join_chat(text), public.reset_invite(uuid), public.open_direct(uuid),
  public.delete_message(uuid), public.mark_read(uuid, timestamptz), public.leave_chat(uuid),
  public.my_chats()
from public, anon;
grant execute on function
  public.is_chat_member(uuid), public.create_chat(text, text), public.chat_by_invite(text),
  public.join_chat(text), public.reset_invite(uuid), public.open_direct(uuid),
  public.delete_message(uuid), public.mark_read(uuid, timestamptz), public.leave_chat(uuid),
  public.my_chats()
to authenticated;
revoke execute on function public.handle_new_user(), public.reactions_fill_chat(), public.touch_updated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Общий чат и приветствие
-- ---------------------------------------------------------------------------

insert into public.chats (id, kind, name, emoji, is_default, invite_code)
values ('00000000-0000-0000-0000-000000000001', 'group', 'Общий', '💬', true, null);

insert into public.messages (chat_id, user_id, kind, body, created_at)
values ('00000000-0000-0000-0000-000000000001', null, 'system',
        'Добро пожаловать в СКАМ! Это не развод — это мессенджер. Пишите, ставьте реакции и заводите свои чаты.',
        now() - interval '1 second');

-- Пользователи, которые успели зарегистрироваться до миграции.
insert into public.profiles (id)
select u.id from auth.users u on conflict do nothing;
insert into public.chat_members (chat_id, user_id)
select '00000000-0000-0000-0000-000000000001', p.id from public.profiles p
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime
      add table public.messages, public.reactions, public.chat_members, public.chats, public.profiles;
  end if;
end $$;

-- Приватные каналы Realtime (presence и «печатает…»):
--   chat:<uuid> — только участники чата; online — все вошедшие.
do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute $p$
      create policy "skam: realtime read" on realtime.messages
        for select to authenticated
        using (
          (select realtime.topic()) = 'online'
          or exists (
            select 1 from public.chat_members m
            where m.user_id = (select auth.uid())
              and 'chat:' || m.chat_id::text = (select realtime.topic())
          )
        )
    $p$;
    execute $p$
      create policy "skam: realtime write" on realtime.messages
        for insert to authenticated
        with check (
          (select realtime.topic()) = 'online'
          or exists (
            select 1 from public.chat_members m
            where m.user_id = (select auth.uid())
              and 'chat:' || m.chat_id::text = (select realtime.topic())
          )
        )
    $p$;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Хранилище аватарок: публичное чтение, запись — только в свою папку <uid>/
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "skam avatars: read own" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "skam avatars: upload own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "skam avatars: update own" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "skam avatars: delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
