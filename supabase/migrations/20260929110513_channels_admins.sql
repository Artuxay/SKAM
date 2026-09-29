-- СКАМ — каналы и группы как в Telegram.
-- • Любой может создать канал: публичный (ссылка ?c=имя, находится в поиске, посты видны до подписки)
--   или частный (только по ссылке-приглашению).
-- • Администраторы с правами (как в Telegram), передача прав владельца, чёрный список.
-- • Фото и описание у групп и каналов; подписи авторов и редактирование постов в каналах.
-- • Добавить в группу или канал напрямую можно только «знакомых» — тех, с кем есть общий личный чат
--   или группа. Остальных — по ссылке.
--
-- Шифрование групп не меняется. Состав участников меняет только сервер (как и раньше при выходе),
-- а новый ключ после удаления участника создаёт тот, кто первым напишет в группу: перед каждой
-- отправкой клиент сверяет состав. Новые участники получают ключи истории обычной раздачей.
-- Скрипт идемпотентный.

-- ---------------------------------------------------------------------------
-- 1. Колонки и таблицы
-- ---------------------------------------------------------------------------

alter table public.chats
  add column if not exists description text,
  add column if not exists username text,
  add column if not exists avatar_path text,
  add column if not exists sign_messages boolean not null default false;

alter table public.chats drop constraint if exists chats_description_check;
alter table public.chats add constraint chats_description_check
  check (description is null or char_length(description) <= 255);

-- Публичная ссылка — только у каналов. Служебные имена свободны только у канала новостей.
alter table public.chats drop constraint if exists chats_username_check;
alter table public.chats add constraint chats_username_check check (
  username is null or (
    kind = 'channel'
    and username ~ '^[a-z][a-z0-9_]{4,31}$'
    and (is_default or username <> all (array['skam', 'skambot', 'admin', 'administrator', 'support', 'moderator', 'root', 'system', 'news']))
  )
);
create unique index if not exists chats_username_key on public.chats (username) where username is not null;

alter table public.chats drop constraint if exists chats_avatar_check;
alter table public.chats add constraint chats_avatar_check check (
  avatar_path is null or (
    kind in ('group', 'channel')
    and char_length(avatar_path) <= 200
    and avatar_path like 'chat/' || id::text || '/%'
    and avatar_path !~ '\.\.'
  )
);

-- Роли: владелец, администратор (с набором прав), участник/подписчик.
alter table public.chat_members
  add column if not exists rights text[],
  add column if not exists promoted_by uuid references public.profiles (id) on delete set null;

alter table public.chat_members drop constraint if exists chat_members_role_check;
alter table public.chat_members add constraint chat_members_role_check
  check (role in ('owner', 'admin', 'member'));

alter table public.chat_members drop constraint if exists chat_members_rights_shape;
alter table public.chat_members add constraint chat_members_rights_shape check (
  (role = 'admin') = (rights is not null)
  and (rights is null or (cardinality(rights) <= 7
       and rights <@ array['info', 'post', 'edit', 'delete', 'invite', 'ban', 'admins']))
  and (role = 'admin' or promoted_by is null)
);
create index if not exists chat_members_promoted_idx on public.chat_members (promoted_by) where promoted_by is not null;

-- Чёрный список: удалённого из группы или канала не пустит обратно ни ссылка, ни поиск.
create table if not exists public.chat_bans (
  chat_id uuid not null references public.chats (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  banned_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (chat_id, user_id)
);
alter table public.chat_bans enable row level security;
revoke all on public.chat_bans from anon, authenticated;
create index if not exists chat_bans_user_idx on public.chat_bans (user_id);
create index if not exists chat_bans_banned_by_idx on public.chat_bans (banned_by) where banned_by is not null;

-- Посты: «изменено» и подпись автора (снимок имени — подписчики не видят профили админов).
alter table public.messages
  add column if not exists edited_at timestamptz,
  add column if not exists signature text;
alter table public.messages drop constraint if exists messages_signature_check;
alter table public.messages add constraint messages_signature_check
  check (signature is null or char_length(signature) <= 128);

-- Ссылку-приглашение отдаёт только my_chats (подписчикам канала — не отдаёт), поэтому
-- таблицу chats читаем по колонкам — без invite_code. Realtime тоже присылает только их.
revoke select on public.chats from authenticated;
grant select (id, kind, name, emoji, created_by, direct_key, is_default, created_at,
              description, username, avatar_path, sign_messages) on public.chats to authenticated;

-- Название, значок и удаление — только через функции с проверкой прав.
drop policy if exists "chats: owner update" on public.chats;
drop policy if exists "chats: owner delete" on public.chats;
revoke update on public.chats from authenticated;
revoke update (name, emoji) on public.chats from authenticated;
revoke delete on public.chats from authenticated;

-- ---------------------------------------------------------------------------
-- 2. Права
-- ---------------------------------------------------------------------------

-- Какие права бывают в канале и в группе (как в Telegram).
create or replace function private.chat_rights_all(p_kind text)
returns text[]
language sql immutable set search_path = ''
as $$
  select case p_kind
    when 'channel' then array['info', 'post', 'edit', 'delete', 'invite', 'ban', 'admins']
    when 'group' then array['info', 'delete', 'invite', 'ban', 'admins']
    else array[]::text[]
  end;
$$;

-- Права человека в чате: у владельца — все, у админа — выданные, у остальных — никаких (null — не участник).
create or replace function private.rights_of(p_chat uuid, p_user uuid)
returns text[]
language sql stable security definer set search_path = ''
as $$
  select case m.role
    when 'owner' then private.chat_rights_all(c.kind)
    when 'admin' then array(select r from unnest(private.chat_rights_all(c.kind)) r where r = any (m.rights))
    else array[]::text[]
  end
  from public.chat_members m
  join public.chats c on c.id = m.chat_id
  where m.chat_id = p_chat and m.user_id = p_user;
$$;

create or replace function private.has_right(p_chat uuid, p_right text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(p_right = any (private.rights_of(p_chat, (select auth.uid()))), false);
$$;

-- Могу ли я менять права этого человека или удалить его: не себя, не владельца;
-- чужих админов — только владелец (как в Telegram: админ управляет теми, кого назначил сам).
create or replace function private.can_touch(p_chat uuid, p_target uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.chat_members me
    join public.chat_members t on t.chat_id = me.chat_id and t.user_id = p_target
    where me.chat_id = p_chat and me.user_id = (select auth.uid())
      and t.user_id <> me.user_id
      and t.role <> 'owner'
      and (me.role = 'owner' or t.role = 'member' or t.promoted_by = me.user_id)
  );
$$;

create or replace function private.is_public_channel(p_chat uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.chats where id = p_chat and kind = 'channel' and username is not null);
$$;

create or replace function private.is_banned(p_chat uuid, p_user uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.chat_bans where chat_id = p_chat and user_id = p_user);
$$;

create or replace function private.try_uuid(p text)
returns uuid
language plpgsql immutable set search_path = ''
as $$
begin
  return p::uuid;
exception when others then
  return null;
end;
$$;

-- Писать в канал — владельцу и админам с правом «Публикация сообщений».
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
      and (c.kind <> 'channel' or m.role = 'owner' or (m.role = 'admin' and 'post' = any (m.rights)))
  );
$$;

revoke all on function private.chat_rights_all(text) from public, anon;
revoke all on function private.rights_of(uuid, uuid) from public, anon, authenticated;
revoke all on function private.can_touch(uuid, uuid) from public, anon, authenticated;
revoke all on function private.is_banned(uuid, uuid) from public, anon, authenticated;
revoke all on function private.has_right(uuid, text) from public, anon;
revoke all on function private.is_public_channel(uuid) from public, anon;
revoke all on function private.try_uuid(text) from public, anon;
revoke all on function private.can_post(uuid) from public, anon;
grant execute on function private.has_right(uuid, text) to authenticated;
grant execute on function private.is_public_channel(uuid) to authenticated;
grant execute on function private.try_uuid(text) to authenticated;
grant execute on function private.can_post(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Кто кого видит
-- ---------------------------------------------------------------------------

-- В канале подписчик видит себя и администраторов, администраторы — всех.
drop policy if exists "members: read" on public.chat_members;
create policy "members: read" on public.chat_members
  for select to authenticated
  using (
    private.is_chat_member(chat_id)
    and (
      not private.is_channel(chat_id)
      or user_id = (select auth.uid())
      or role in ('owner', 'admin')
      or private.my_role(chat_id) in ('owner', 'admin')
    )
  );

-- Файлы публичного канала видны и до подписки (посты открыты всем, как в Telegram).
drop policy if exists "media: members read" on storage.objects;
create policy "media: members read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'media'
    and (private.is_chat_member(private.path_chat(name)) or private.is_public_channel(private.path_chat(name)))
  );

-- Фото групп и каналов: avatars/chat/<id чата>/<файл>. Корзина публичная (как у фото профиля),
-- загрузить и удалить может тот, у кого есть право «Изменение профиля».
drop policy if exists "skam chat avatars: read" on storage.objects;
create policy "skam chat avatars: read" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = 'chat'
         and private.is_chat_member(private.try_uuid((storage.foldername(name))[2])));
drop policy if exists "skam chat avatars: upload" on storage.objects;
create policy "skam chat avatars: upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = 'chat'
              and private.has_right(private.try_uuid((storage.foldername(name))[2]), 'info'));
drop policy if exists "skam chat avatars: delete" on storage.objects;
create policy "skam chat avatars: delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = 'chat'
         and private.has_right(private.try_uuid((storage.foldername(name))[2]), 'info'));

-- ---------------------------------------------------------------------------
-- 4. Имена: @username людей и публичных каналов не пересекаются
-- ---------------------------------------------------------------------------

create or replace function private.chat_username_ok(p_chat uuid, p_username text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_username ~ '^[a-z][a-z0-9_]{4,31}$'
    and (
      p_username <> all (array['skam', 'skambot', 'admin', 'administrator', 'support', 'moderator', 'root', 'system', 'news'])
      or exists (select 1 from public.chats where id = p_chat and is_default)
    )
    and not exists (select 1 from public.profiles where username = p_username)
    and not exists (select 1 from public.chats where username = p_username and id is distinct from p_chat);
$$;
revoke all on function private.chat_username_ok(uuid, text) from public, anon, authenticated;

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
    )
    and not exists (select 1 from public.chats where username = lower(p_username));
$$;

create or replace function public.chat_username_available(p_chat uuid, p_username text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select (select auth.uid()) is not null
    and private.chat_username_ok(p_chat, lower(ltrim(btrim(coalesce(p_username, '')), '@')));
$$;

create or replace function private.profiles_username_free()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.username is not null
     and (tg_op = 'INSERT' or new.username is distinct from old.username)
     and exists (select 1 from public.chats where username = new.username) then
    raise exception 'Это имя пользователя уже занято' using errcode = '23505';
  end if;
  return new;
end;
$$;
revoke all on function private.profiles_username_free() from public, anon, authenticated;

drop trigger if exists profiles_username_free on public.profiles;
create trigger profiles_username_free before insert or update of username on public.profiles
  for each row execute function private.profiles_username_free();

-- ---------------------------------------------------------------------------
-- 5. Создание, профиль, ссылка, фото
-- ---------------------------------------------------------------------------

drop function if exists public.create_chat(text, text);
create or replace function public.create_chat(
  p_name text, p_emoji text default null, p_kind text default 'group', p_description text default null
)
returns public.chats
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  k text := coalesce(p_kind, 'group');
  c public.chats;
begin
  perform private.require_registered();
  if k not in ('group', 'channel') then
    raise exception 'bad kind' using errcode = '22023';
  end if;
  -- Защита от спама: не больше 20 новых групп и каналов в сутки.
  if (select count(*) from public.chats
      where created_by = me and kind in ('group', 'channel') and created_at > now() - interval '1 day') >= 20 then
    raise exception 'Слишком много новых чатов за сутки. Попробуйте завтра.' using errcode = '54000';
  end if;
  insert into public.chats (kind, name, emoji, created_by, description)
  values (k, left(btrim(p_name), 40),
          coalesce(nullif(btrim(p_emoji), ''), case when k = 'channel' then '📢' else '💬' end),
          me, nullif(left(btrim(coalesce(p_description, '')), 255), ''))
  returning * into c;
  insert into public.chat_members (chat_id, user_id, role) values (c.id, me, 'owner');
  return c;
end;
$$;

-- null — не менять; пустое описание — убрать.
create or replace function public.update_chat(
  p_chat uuid, p_name text default null, p_emoji text default null,
  p_description text default null, p_sign boolean default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare k text;
begin
  perform private.require_registered();
  select kind into k from public.chats where id = p_chat;
  if k is null or not private.has_right(p_chat, 'info') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_sign is not null and k <> 'channel' then
    raise exception 'signatures are for channels' using errcode = '22023';
  end if;
  update public.chats set
    name = coalesce(nullif(left(btrim(coalesce(p_name, '')), 40), ''), name),
    emoji = coalesce(nullif(btrim(coalesce(p_emoji, '')), ''), emoji),
    description = case when p_description is null then description
                       else nullif(left(btrim(p_description), 255), '') end,
    sign_messages = coalesce(p_sign, sign_messages)
  where id = p_chat;
end;
$$;

-- Фото группы или канала. Возвращает старый путь — клиент удалит файл.
create or replace function public.set_chat_avatar(p_chat uuid, p_path text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare old text;
begin
  perform private.require_registered();
  if not private.has_right(p_chat, 'info') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_path is not null and (p_path not like 'chat/' || p_chat::text || '/%' or char_length(p_path) > 200 or p_path ~ '\.\.') then
    raise exception 'bad path' using errcode = '22023';
  end if;
  select avatar_path into old from public.chats where id = p_chat;
  update public.chats set avatar_path = p_path where id = p_chat;
  return old;
end;
$$;

-- Публичный канал — с именем (?c=имя), частный — без (только ссылка-приглашение).
create or replace function public.set_chat_username(p_chat uuid, p_username text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare u text := nullif(lower(ltrim(btrim(coalesce(p_username, '')), '@')), '');
begin
  perform private.require_registered();
  if not private.is_channel(p_chat) or not private.has_right(p_chat, 'info') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if u is not null and not private.chat_username_ok(p_chat, u) then
    raise exception 'Это имя уже занято или не подходит' using errcode = '23505';
  end if;
  update public.chats set username = u where id = p_chat;
end;
$$;

create or replace function public.reset_invite(p_chat uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare code text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
begin
  if not private.has_right(p_chat, 'invite') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.chats set invite_code = code where id = p_chat and kind in ('group', 'channel');
  if not found then raise exception 'forbidden' using errcode = '42501'; end if;
  return code;
end;
$$;

create or replace function public.delete_chat(p_chat uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_registered();
  if private.my_role(p_chat) is distinct from 'owner'
     or not exists (select 1 from public.chats where id = p_chat and kind in ('group', 'channel') and not is_default) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.chats where id = p_chat;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Участники: добавить знакомых, удалить, чёрный список, выйти, вступить
-- ---------------------------------------------------------------------------

-- В группу добавить знакомого может любой участник (как в Telegram по умолчанию),
-- в канал — админ с правом «Добавление подписчиков». Незнакомых — только по ссылке.
create or replace function public.add_chat_members(p_chat uuid, p_users uuid[])
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  c public.chats;
  n integer;
begin
  perform private.require_registered();
  select * into c from public.chats where id = p_chat;
  if c.id is null or c.kind not in ('group', 'channel') or c.is_default
     or not private.is_chat_member(p_chat)
     or (c.kind = 'channel' and not private.has_right(p_chat, 'invite')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_users), 0) = 0 then return 0; end if;
  if cardinality(p_users) > 200 then
    raise exception 'Не больше 200 человек за раз' using errcode = '54000';
  end if;
  -- Кто может блокировать, тот своим добавлением и разблокирует (как в Telegram).
  if private.has_right(p_chat, 'ban') then
    delete from public.chat_bans b
    where b.chat_id = p_chat and b.user_id = any (p_users) and private.shares_chat(b.user_id);
  end if;
  insert into public.chat_members (chat_id, user_id)
  select p_chat, p.id
  from public.profiles p
  where p.id = any (p_users)
    and p.id <> me
    and p.first_name is not null
    and private.shares_chat(p.id)
    and not private.is_banned(p_chat, p.id)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Удалить из группы или канала. p_ban — ещё и в чёрный список (по умолчанию, как в Telegram).
create or replace function public.remove_chat_member(p_chat uuid, p_user uuid, p_ban boolean default true)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_registered();
  if exists (select 1 from public.chats where id = p_chat and is_default)
     or not private.has_right(p_chat, 'ban')
     or not private.can_touch(p_chat, p_user) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.chat_members where chat_id = p_chat and user_id = p_user;
  if coalesce(p_ban, true) then
    insert into public.chat_bans (chat_id, user_id, banned_by)
    values (p_chat, p_user, (select auth.uid()))
    on conflict (chat_id, user_id) do update set banned_by = excluded.banned_by, created_at = now();
  end if;
end;
$$;

create or replace function public.unban_chat_member(p_chat uuid, p_user uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_registered();
  if not private.has_right(p_chat, 'ban') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.chat_bans where chat_id = p_chat and user_id = p_user;
end;
$$;

create or replace function public.chat_banned(p_chat uuid)
returns table (user_id uuid, name text, username text, avatar_path text, color text,
               banned_by uuid, banned_by_name text, created_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select b.user_id, p.name, p.username, p.avatar_path, p.color, b.banned_by, bp.name, b.created_at
  from public.chat_bans b
  join public.profiles p on p.id = b.user_id
  left join public.profiles bp on bp.id = b.banned_by
  where b.chat_id = p_chat and private.has_right(p_chat, 'ban')
  order by b.created_at desc
  limit 500;
$$;

-- Выйти. Канал новостей покинуть нельзя. Единственный владелец канала сначала передаёт права
-- (или удаляет канал); из группы владелец выходит, права переходят старшему админу или участнику.
create or replace function public.leave_chat(p_chat uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  k text;
  was text;
  heir uuid;
begin
  select kind into k from public.chats
  where id = p_chat and kind in ('group', 'direct', 'channel') and not is_default;
  if k is null then
    raise exception 'cannot leave this chat' using errcode = '42501';
  end if;
  if k = 'channel' and private.my_role(p_chat) = 'owner'
     and not exists (select 1 from public.chat_members where chat_id = p_chat and role = 'owner' and user_id <> me)
     and exists (select 1 from public.chat_members where chat_id = p_chat and user_id <> me) then
    raise exception 'Сначала передайте права владельца или удалите канал' using errcode = '42501';
  end if;
  delete from public.chat_members where chat_id = p_chat and user_id = me returning role into was;
  if was = 'owner' and not exists (select 1 from public.chat_members where chat_id = p_chat and role = 'owner') then
    select user_id into heir from public.chat_members
    where chat_id = p_chat
    order by (role = 'admin') desc, joined_at, user_id
    limit 1;
    if heir is not null then
      update public.chat_members set role = 'owner', rights = null, promoted_by = null
      where chat_id = p_chat and user_id = heir;
    end if;
  end if;
  delete from public.chats c
  where c.id = p_chat
    and not exists (select 1 from public.chat_members m where m.chat_id = c.id);
end;
$$;

create or replace function public.join_chat(p_code text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  cid uuid;
begin
  perform private.require_registered();
  select id into cid from public.chats where kind in ('group', 'channel') and invite_code = p_code;
  if cid is null then raise exception 'invite not found' using errcode = 'P0002'; end if;
  if private.is_banned(cid, me) and not private.is_chat_member(cid) then
    raise exception 'Администратор удалил вас из этого чата' using errcode = '42501';
  end if;
  insert into public.chat_members (chat_id, user_id) values (cid, me) on conflict do nothing;
  return cid;
end;
$$;

-- Подписаться на публичный канал (из поиска или по ссылке ?c=имя).
create or replace function public.join_channel(p_chat uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare me uuid := (select auth.uid());
begin
  perform private.require_registered();
  if not private.is_public_channel(p_chat) then
    raise exception 'channel not found' using errcode = 'P0002';
  end if;
  if private.is_banned(p_chat, me) and not private.is_chat_member(p_chat) then
    raise exception 'Администратор удалил вас из этого канала' using errcode = '42501';
  end if;
  insert into public.chat_members (chat_id, user_id) values (p_chat, me) on conflict do nothing;
  return p_chat;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Администраторы
-- ---------------------------------------------------------------------------

-- Назначить админом или изменить права. Выдать можно только те права, что есть у тебя.
create or replace function public.set_chat_admin(p_chat uuid, p_user uuid, p_rights text[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  k text;
  mine text[];
  r text[];
begin
  perform private.require_registered();
  select kind into k from public.chats where id = p_chat;
  mine := coalesce(private.rights_of(p_chat, me), array[]::text[]);
  if k is null or not ('admins' = any (mine)) or not private.can_touch(p_chat, p_user) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not (coalesce(p_rights, array[]::text[]) <@ private.chat_rights_all(k)) then
    raise exception 'bad rights' using errcode = '22023';
  end if;
  if not (coalesce(p_rights, array[]::text[]) <@ mine) then
    raise exception 'Нельзя выдать право, которого нет у вас' using errcode = '42501';
  end if;
  r := array(select x from unnest(private.chat_rights_all(k)) x where x = any (coalesce(p_rights, array[]::text[])));
  update public.chat_members set role = 'admin', rights = r, promoted_by = me
  where chat_id = p_chat and user_id = p_user;
end;
$$;

create or replace function public.remove_chat_admin(p_chat uuid, p_user uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_registered();
  if not private.has_right(p_chat, 'admins') or not private.can_touch(p_chat, p_user) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.chat_members set role = 'member', rights = null, promoted_by = null
  where chat_id = p_chat and user_id = p_user and role = 'admin';
end;
$$;

-- Передать права владельца администратору. Бывший владелец остаётся админом со всеми правами.
create or replace function public.transfer_chat_owner(p_chat uuid, p_user uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  k text;
begin
  perform private.require_registered();
  select kind into k from public.chats where id = p_chat and kind in ('group', 'channel');
  if k is null or private.my_role(p_chat) is distinct from 'owner' or p_user = me
     or not exists (select 1 from public.chat_members where chat_id = p_chat and user_id = p_user and role = 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.chat_members set role = 'owner', rights = null, promoted_by = null
  where chat_id = p_chat and user_id = p_user;
  update public.chat_members set role = 'admin', rights = private.chat_rights_all(k), promoted_by = p_user
  where chat_id = p_chat and user_id = me;
end;
$$;

-- Список участников с профилями: в группе — всем участникам, в канале — только администраторам.
create or replace function public.chat_member_list(
  p_chat uuid, p_query text default null, p_admins boolean default false,
  p_limit integer default 50, p_offset integer default 0
)
returns table (user_id uuid, role text, rights text[], promoted_by uuid, joined_at timestamptz,
               name text, username text, avatar_path text, color text,
               last_seen_at timestamptz, online_until timestamptz)
language sql stable security definer set search_path = ''
as $$
  with q as (
    select nullif(btrim(regexp_replace(ltrim(private.search_norm(p_query), '@'), '\s+', ' ', 'g')), '') as s
  )
  select m.user_id, m.role, m.rights, m.promoted_by, m.joined_at,
         p.name, p.username, p.avatar_path, p.color, p.last_seen_at, p.online_until
  from public.chat_members m
  join public.chats c on c.id = m.chat_id
  join public.profiles p on p.id = m.user_id
  cross join q
  where m.chat_id = p_chat
    and c.kind in ('group', 'channel')
    and private.is_chat_member(p_chat)
    and (c.kind = 'group' or private.my_role(p_chat) in ('owner', 'admin'))
    and (not coalesce(p_admins, false) or m.role in ('owner', 'admin'))
    and (q.s is null
         or starts_with(private.search_norm(p.name), q.s)
         or starts_with(coalesce(p.username, ''), q.s)
         or exists (select 1 from regexp_split_to_table(private.search_norm(p.name), '[\s-]+') w where starts_with(w, q.s)))
  order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, m.joined_at desc, m.user_id
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- Знакомые для «Добавить участников»: с кем есть общий личный чат или группа.
create or replace function public.my_contacts(p_chat uuid default null, p_limit integer default 300)
returns table (id uuid, name text, username text, avatar_path text, color text,
               last_seen_at timestamptz, online_until timestamptz, in_chat boolean)
language sql stable security definer set search_path = ''
as $$
  select p.id, p.name, p.username, p.avatar_path, p.color, p.last_seen_at, p.online_until,
         (p_chat is not null and private.is_chat_member(p_chat)
          and exists (select 1 from public.chat_members x where x.chat_id = p_chat and x.user_id = p.id))
  from public.profiles p
  where p.id in (
      select b.user_id
      from public.chat_members a
      join public.chat_members b on b.chat_id = a.chat_id
      join public.chats c on c.id = a.chat_id and c.kind in ('group', 'direct')
      where a.user_id = (select auth.uid()) and b.user_id <> a.user_id
    )
    and p.first_name is not null
  order by greatest(p.online_until, p.last_seen_at) desc nulls last, p.name
  limit least(greatest(coalesce(p_limit, 300), 1), 1000);
$$;

-- ---------------------------------------------------------------------------
-- 8. Публичные каналы: карточка по имени, поиск, лента до подписки
-- ---------------------------------------------------------------------------

drop function if exists public.chat_by_invite(text);
create or replace function public.chat_by_invite(p_code text)
returns table (id uuid, kind text, name text, emoji text, avatar_path text, description text,
               username text, member_count integer, is_member boolean)
language sql stable security definer set search_path = ''
as $$
  select c.id, c.kind, c.name, c.emoji, c.avatar_path, c.description, c.username,
         (select count(*) from public.chat_members m where m.chat_id = c.id)::int,
         exists (select 1 from public.chat_members m where m.chat_id = c.id and m.user_id = (select auth.uid()))
  from public.chats c
  where c.kind in ('group', 'channel') and c.invite_code = p_code and (select auth.uid()) is not null;
$$;

create or replace function public.chat_by_username(p_username text)
returns table (id uuid, kind text, name text, emoji text, avatar_path text, description text,
               username text, member_count integer, is_member boolean)
language sql stable security definer set search_path = ''
as $$
  select c.id, c.kind, c.name, c.emoji, c.avatar_path, c.description, c.username,
         (select count(*) from public.chat_members m where m.chat_id = c.id)::int,
         exists (select 1 from public.chat_members m where m.chat_id = c.id and m.user_id = (select auth.uid()))
  from public.chats c
  where (select auth.uid()) is not null
    and c.kind = 'channel'
    and c.username = lower(ltrim(btrim(coalesce(p_username, '')), '@'));
$$;

-- Поиск публичных каналов по названию и @имени. Частные каналы в поиске не видны.
create or replace function public.search_chats(p_query text, p_limit integer default 10)
returns table (id uuid, kind text, name text, emoji text, avatar_path text, description text,
               username text, member_count integer, is_member boolean)
language sql stable security definer set search_path = ''
as $$
  with q as (
    select btrim(regexp_replace(ltrim(private.search_norm(p_query), '@'), '\s+', ' ', 'g')) as s
  ),
  hit as (
    select c.*, (select count(*) from public.chat_members m where m.chat_id = c.id)::int as n
    from public.chats c, q
    where (select auth.uid()) is not null
      and char_length(q.s) between 2 and 64
      and c.kind = 'channel' and c.username is not null
      and (starts_with(c.username, q.s)
           or starts_with(private.search_norm(c.name), q.s)
           or exists (select 1 from regexp_split_to_table(private.search_norm(c.name), '[\s-]+') w where starts_with(w, q.s)))
  )
  select h.id, h.kind, h.name, h.emoji, h.avatar_path, h.description, h.username, h.n,
         exists (select 1 from public.chat_members m where m.chat_id = h.id and m.user_id = (select auth.uid()))
  from hit h, q
  order by (h.username = q.s) desc, h.n desc, h.name, h.id
  limit least(greatest(coalesce(p_limit, 10), 1), 20);
$$;

-- Лента канала: публичного — любому, остальных — подписчикам. Реакции — числами.
-- Автора поста видят только подписчики (как в Telegram, посты идут от имени канала).
create or replace function public.channel_feed(
  p_chat uuid, p_before timestamptz default null, p_before_id uuid default null, p_limit integer default 50
)
returns table (id uuid, chat_id uuid, user_id uuid, kind text, body text, created_at timestamptz,
               deleted_at timestamptz, sticker text, media_path text, media_mime text, duration_ms integer,
               waveform smallint[], enc text, key_id uuid, files jsonb, reply_to uuid, fwd jsonb, call_id uuid,
               edited_at timestamptz, signature text, reacts jsonb)
language sql stable security definer set search_path = ''
as $$
  select m.id, m.chat_id,
         case when private.is_chat_member(p_chat) then m.user_id end,
         m.kind, m.body, m.created_at, m.deleted_at, m.sticker, m.media_path, m.media_mime, m.duration_ms,
         m.waveform, m.enc, m.key_id, m.files, m.reply_to, m.fwd, m.call_id, m.edited_at, m.signature,
         (select jsonb_object_agg(x.emoji, x.n)
            from (select r.emoji, count(*) as n from public.reactions r where r.message_id = m.id group by r.emoji) x)
  from public.messages m
  where m.chat_id = p_chat
    and private.is_channel(p_chat)
    and (private.is_public_channel(p_chat) or private.is_chat_member(p_chat))
    and (p_before is null or m.created_at < p_before
         or (m.created_at = p_before and p_before_id is not null and m.id < p_before_id))
  order by m.created_at desc, m.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;

-- ---------------------------------------------------------------------------
-- 9. Посты: подпись, редактирование, удаление админами
-- ---------------------------------------------------------------------------

create or replace function private.messages_stamp()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.edited_at := null;
  new.signature := null;
  if new.user_id is not null and new.kind <> 'system'
     and exists (select 1 from public.chats c where c.id = new.chat_id and c.kind = 'channel' and c.sign_messages) then
    select left(p.name, 128) into new.signature from public.profiles p where p.id = new.user_id;
  end if;
  return new;
end;
$$;
revoke all on function private.messages_stamp() from public, anon, authenticated;

drop trigger if exists messages_stamp on public.messages;
create trigger messages_stamp before insert on public.messages
  for each row execute function private.messages_stamp();

-- Изменить пост канала: автор (пока может публиковать) или админ с правом «Изменение чужих публикаций».
-- В личных чатах и группах сообщения зашифрованы — их здесь не меняем.
create or replace function public.edit_message(p_id uuid, p_body text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  m public.messages;
  b text := coalesce(p_body, '');
begin
  perform private.require_registered();
  select * into m from public.messages where id = p_id;
  if m.id is null or m.deleted_at is not null or m.kind not in ('text', 'media')
     or not private.is_channel(m.chat_id)
     or not ((m.user_id = (select auth.uid()) and private.can_post(m.chat_id))
             or private.has_right(m.chat_id, 'edit')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if char_length(b) > 4000 then
    raise exception 'too long' using errcode = '22001';
  end if;
  if m.kind = 'text' and char_length(btrim(b)) = 0 then
    raise exception 'empty' using errcode = '22023';
  end if;
  if b = m.body then return; end if;
  update public.messages set body = b, edited_at = now() where id = p_id;
end;
$$;

-- Удалить: своё — всегда; чужое в группе или канале — админ с правом удаления.
create or replace function public.delete_message(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare m public.messages;
begin
  select * into m from public.messages where id = p_id and deleted_at is null;
  if m.id is null or not (
       m.user_id = (select auth.uid())
       or (m.kind <> 'call'
           and exists (select 1 from public.chats c where c.id = m.chat_id and c.kind in ('group', 'channel'))
           and private.has_right(m.chat_id, 'delete'))
     ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.messages
  set deleted_at = now(), body = '', sticker = null, media_path = null, media_mime = null,
      duration_ms = null, waveform = null, enc = null, key_id = null, files = null,
      reply_to = null, fwd = null
  where id = p_id;
  delete from public.reactions where message_id = p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Список чатов: мои права, описание, ссылка, фото
-- ---------------------------------------------------------------------------

drop function if exists public.my_chats();
create or replace function public.my_chats()
returns table (id uuid, kind text, name text, emoji text, invite_code text, is_default boolean,
               created_at timestamptz, role text, last_read_at timestamptz, member_count integer,
               peer_id uuid, unread integer, last_id uuid, last_body text, last_user_id uuid,
               last_kind text, last_at timestamptz, last_deleted boolean, last_enc text,
               last_key_id uuid, last_files jsonb, last_call jsonb,
               description text, username text, avatar_path text, sign_messages boolean, rights text[])
language sql stable security definer set search_path = ''
as $$
  select c.id, c.kind, c.name, c.emoji,
         -- Ссылку-приглашение канала видят только админы с правом приглашать.
         case when c.kind = 'channel' and not ('invite' = any (r.rights)) then null else c.invite_code end,
         c.is_default, c.created_at, cm.role, cm.last_read_at,
         (select count(*) from public.chat_members x where x.chat_id = c.id)::int,
         case when c.kind = 'direct' then
           (select x.user_id from public.chat_members x where x.chat_id = c.id and x.user_id <> cm.user_id limit 1)
         end,
         (select count(*) from public.messages m
           where m.chat_id = c.id and m.created_at > cm.last_read_at
             and m.user_id is distinct from cm.user_id and m.deleted_at is null)::int,
         lm.id, left(lm.body, 200), lm.user_id, lm.kind, lm.created_at, lm.deleted_at is not null,
         lm.enc, lm.key_id, lm.files,
         (select jsonb_build_object('status', k.status, 'video', k.video,
                                    'dur', extract(epoch from (k.ended_at - k.answered_at))::int)
            from public.calls k where k.id = lm.call_id),
         c.description, c.username, c.avatar_path, c.sign_messages, r.rights
  from public.chat_members cm
  join public.chats c on c.id = cm.chat_id
  cross join lateral (
    select case cm.role
      when 'owner' then private.chat_rights_all(c.kind)
      when 'admin' then array(select x from unnest(private.chat_rights_all(c.kind)) x where x = any (cm.rights))
      else array[]::text[]
    end as rights
  ) r
  left join lateral (
    select m.id, m.body, m.user_id, m.kind, m.created_at, m.deleted_at, m.enc, m.key_id, m.files, m.call_id
    from public.messages m where m.chat_id = c.id
    order by m.created_at desc, m.id desc limit 1
  ) lm on true
  where cm.user_id = (select auth.uid())
  order by coalesce(lm.created_at, c.created_at) desc;
$$;

-- ---------------------------------------------------------------------------
-- 11. Доступ к функциям
-- ---------------------------------------------------------------------------

do $$
declare f text;
begin
  foreach f in array array[
    'public.create_chat(text, text, text, text)',
    'public.update_chat(uuid, text, text, text, boolean)',
    'public.set_chat_avatar(uuid, text)',
    'public.set_chat_username(uuid, text)',
    'public.chat_username_available(uuid, text)',
    'public.username_available(text)',
    'public.reset_invite(uuid)',
    'public.delete_chat(uuid)',
    'public.add_chat_members(uuid, uuid[])',
    'public.remove_chat_member(uuid, uuid, boolean)',
    'public.unban_chat_member(uuid, uuid)',
    'public.chat_banned(uuid)',
    'public.leave_chat(uuid)',
    'public.join_chat(text)',
    'public.join_channel(uuid)',
    'public.set_chat_admin(uuid, uuid, text[])',
    'public.remove_chat_admin(uuid, uuid)',
    'public.transfer_chat_owner(uuid, uuid)',
    'public.chat_member_list(uuid, text, boolean, integer, integer)',
    'public.my_contacts(uuid, integer)',
    'public.chat_by_invite(text)',
    'public.chat_by_username(text)',
    'public.search_chats(text, integer)',
    'public.channel_feed(uuid, timestamptz, uuid, integer)',
    'public.edit_message(uuid, text)',
    'public.delete_message(uuid)',
    'public.my_chats()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
