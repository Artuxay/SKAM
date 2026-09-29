-- СКАМ 1.0: официальные галочки и неофициальные стикеры.
--
-- 1. Владельцы СКАМ (private.app_owners) — только они выдают и снимают официальные галочки
--    людям и каналам (public.set_verified). Список владельцев заполняется вручную, вне миграций:
--      insert into private.app_owners (user_id) values ('<uuid пользователя>');
-- 2. Галочки: profiles.verified и chats.verified (только у каналов). У чата с ботом СКАМ галочка всегда.
--    Изменить их напрямую нельзя: UPDATE на profiles разрешён только по имени, фамилии, @username и фото.
-- 3. Неофициальные стикеры: любой создаёт свои наборы из картинок (у каждого стикера — эмодзи),
--    делится ссылкой ?stickers=<id>, другие добавляют набор себе. Картинки — в публичном бакете stickers
--    (<набор>/<стикер>), список файлов закрыт. Официальный набор «Голубь свободы» по-прежнему в приложении.

-- ---------------------------------------------------------------------------
-- 1. Владельцы СКАМ
-- ---------------------------------------------------------------------------

create table if not exists private.app_owners (
  user_id  uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);
comment on table private.app_owners is
  'Владельцы СКАМ: выдают и снимают официальные галочки, могут удалить любой набор стикеров. Заполняется вручную.';
revoke all on private.app_owners from public, anon, authenticated;

create or replace function private.is_app_owner()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from private.app_owners where user_id = (select auth.uid()));
$$;

-- Клиенту: показывать ли кнопки «Выдать галочку».
create or replace function public.am_app_owner()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_app_owner();
$$;

-- ---------------------------------------------------------------------------
-- 2. Официальные галочки
-- ---------------------------------------------------------------------------

alter table public.profiles add column if not exists verified boolean not null default false;
comment on column public.profiles.verified is 'Официальная галочка. Выдаёт только владелец СКАМ (public.set_verified).';
alter table public.chats add column if not exists verified boolean not null default false;
comment on column public.chats.verified is 'Официальная галочка канала. Выдаёт только владелец СКАМ (public.set_verified).';
alter table public.chats drop constraint if exists chats_verified_channel;
alter table public.chats add constraint chats_verified_channel check (not verified or kind = 'channel');

-- Читать можно (select * в клиенте), менять — нет: UPDATE на profiles выдан только по отдельным колонкам.
grant select (verified) on public.profiles to authenticated;
grant select (verified) on public.chats to authenticated;

create table if not exists private.verify_log (
  id          bigint generated always as identity primary key,
  target_kind text not null check (target_kind in ('user', 'channel')),
  target_id   uuid not null,
  verified    boolean not null,
  by_user     uuid,
  created_at  timestamptz not null default now()
);
revoke all on private.verify_log from public, anon, authenticated;

create or replace function public.set_verified(p_kind text, p_id uuid, p_on boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_app_owner() then
    raise exception 'Официальные галочки выдаёт только владелец СКАМ' using errcode = '42501';
  end if;
  if p_kind = 'user' then
    update public.profiles set verified = coalesce(p_on, false) where id = p_id;
  elsif p_kind = 'channel' then
    update public.chats set verified = coalesce(p_on, false) where id = p_id and kind = 'channel';
  else
    raise exception 'Галочку можно выдать только пользователю или каналу' using errcode = '22023';
  end if;
  if not found then
    raise exception 'Не найдено' using errcode = 'P0002';
  end if;
  insert into private.verify_log (target_kind, target_id, verified, by_user)
  values (p_kind, p_id, coalesce(p_on, false), (select auth.uid()));
end;
$$;

-- Официальный канал новостей — с галочкой с самого начала.
update public.chats set verified = true where id = '00000000-0000-0000-0000-000000000001' and kind = 'channel';

-- Поиск людей: + verified; человек с галочкой — выше тёзок.
drop function if exists public.search_users(text, integer);
create or replace function public.search_users(p_query text, p_limit integer default 20)
returns table (id uuid, name text, username text, avatar_path text, color text, is_contact boolean, verified boolean)
language sql stable security definer set search_path = ''
as $$
  with q as (
    -- «@» в начале — искать только по @username.
    select left(n, 1) = '@' as at,
           btrim(regexp_replace(ltrim(n, '@'), '\s+', ' ', 'g')) as s
    from (select private.search_norm(p_query) as n) x
  ),
  t as (
    select q.at, q.s, string_to_array(q.s, ' ') as toks
    from q
    where (select auth.uid()) is not null
      and char_length(q.s) between 2 and 64
  ),
  contacts as (
    -- Люди, с которыми у меня есть общий групповой или личный чат.
    select distinct b.user_id
    from public.chat_members a
    join public.chat_members b on b.chat_id = a.chat_id
    join public.chats c on c.id = a.chat_id and c.kind in ('group', 'direct')
    where a.user_id = (select auth.uid())
  ),
  cand as (
    select p.id, p.name, p.username, p.avatar_path, p.color, p.verified,
           private.search_norm(p.name) as nm,
           private.search_norm(coalesce(p.last_name || ' ', '') || p.first_name) as rev,
           -- Слова профиля: по пробелам и по дефисам («Анна-Мария» найдётся и по «мар»), плюс @username.
           regexp_split_to_array(private.search_norm(p.name), '\s+')
             || regexp_split_to_array(private.search_norm(p.name), '[\s-]+')
             || p.username as words
    from public.profiles p
    where p.first_name is not null
  ),
  hit as (
    select cand.id, cand.name, cand.username, cand.avatar_path, cand.color, cand.verified, cand.nm, cand.rev, t.s
    from cand, t
    where (t.at and starts_with(cand.username, t.s))
       or (not t.at and (
             starts_with(cand.nm, t.s)
             or starts_with(cand.rev, t.s)
             or starts_with(cand.username, t.s)
             or (select bool_and(exists (
                   select 1 from unnest(cand.words) w where starts_with(w, tok)
                 )) from unnest(t.toks) tok)
          ))
  )
  select h.id, h.name, h.username, h.avatar_path, h.color,
         (h.id <> (select auth.uid()) and h.id in (select user_id from contacts)) as is_contact,
         h.verified
  from hit h
  order by
    coalesce(h.username = h.s, false) desc,
    h.verified desc,
    (h.id <> (select auth.uid()) and h.id in (select user_id from contacts)) desc,
    case
      when starts_with(h.nm, h.s) or starts_with(h.rev, h.s) then 0
      when starts_with(h.username, h.s) then 1
      else 2
    end,
    (h.id = (select auth.uid())),
    h.nm,
    h.id
  limit least(greatest(coalesce(p_limit, 20), 1), 20);
$$;

-- Участники: + verified.
drop function if exists public.chat_member_list(uuid, text, boolean, integer, integer);
create or replace function public.chat_member_list(
  p_chat uuid, p_query text default null, p_admins boolean default false,
  p_limit integer default 50, p_offset integer default 0
)
returns table (user_id uuid, role text, rights text[], promoted_by uuid, joined_at timestamptz,
               name text, username text, avatar_path text, color text,
               last_seen_at timestamptz, online_until timestamptz, verified boolean)
language sql stable security definer set search_path = ''
as $$
  with q as (
    select nullif(btrim(regexp_replace(ltrim(private.search_norm(p_query), '@'), '\s+', ' ', 'g')), '') as s
  )
  select m.user_id, m.role, m.rights, m.promoted_by, m.joined_at,
         p.name, p.username, p.avatar_path, p.color, p.last_seen_at, p.online_until, p.verified
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

-- Знакомые: + verified.
drop function if exists public.my_contacts(uuid, integer);
create or replace function public.my_contacts(p_chat uuid default null, p_limit integer default 300)
returns table (id uuid, name text, username text, avatar_path text, color text,
               last_seen_at timestamptz, online_until timestamptz, in_chat boolean, verified boolean)
language sql stable security definer set search_path = ''
as $$
  select p.id, p.name, p.username, p.avatar_path, p.color, p.last_seen_at, p.online_until,
         (p_chat is not null and private.is_chat_member(p_chat)
          and exists (select 1 from public.chat_members x where x.chat_id = p_chat and x.user_id = p.id)),
         p.verified
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

-- Карточки групп и каналов: + verified.
drop function if exists public.chat_by_invite(text);
create or replace function public.chat_by_invite(p_code text)
returns table (id uuid, kind text, name text, emoji text, avatar_path text, description text,
               username text, member_count integer, is_member boolean, verified boolean)
language sql stable security definer set search_path = ''
as $$
  select c.id, c.kind, c.name, c.emoji, c.avatar_path, c.description, c.username,
         (select count(*) from public.chat_members m where m.chat_id = c.id)::int,
         exists (select 1 from public.chat_members m where m.chat_id = c.id and m.user_id = (select auth.uid())),
         c.verified
  from public.chats c
  where c.kind in ('group', 'channel') and c.invite_code = p_code and (select auth.uid()) is not null;
$$;

drop function if exists public.chat_by_username(text);
create or replace function public.chat_by_username(p_username text)
returns table (id uuid, kind text, name text, emoji text, avatar_path text, description text,
               username text, member_count integer, is_member boolean, verified boolean)
language sql stable security definer set search_path = ''
as $$
  select c.id, c.kind, c.name, c.emoji, c.avatar_path, c.description, c.username,
         (select count(*) from public.chat_members m where m.chat_id = c.id)::int,
         exists (select 1 from public.chat_members m where m.chat_id = c.id and m.user_id = (select auth.uid())),
         c.verified
  from public.chats c
  where (select auth.uid()) is not null
    and c.kind = 'channel'
    and c.username = lower(ltrim(btrim(coalesce(p_username, '')), '@'));
$$;

-- Поиск публичных каналов: + verified; канал с галочкой — выше похожих.
drop function if exists public.search_chats(text, integer);
create or replace function public.search_chats(p_query text, p_limit integer default 10)
returns table (id uuid, kind text, name text, emoji text, avatar_path text, description text,
               username text, member_count integer, is_member boolean, verified boolean)
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
         exists (select 1 from public.chat_members m where m.chat_id = h.id and m.user_id = (select auth.uid())),
         h.verified
  from hit h, q
  order by (h.username = q.s) desc, h.verified desc, h.n desc, h.name, h.id
  limit least(greatest(coalesce(p_limit, 10), 1), 20);
$$;

-- Список чатов: + verified (у чата с ботом СКАМ — всегда).
drop function if exists public.my_chats();
create or replace function public.my_chats()
returns table (id uuid, kind text, name text, emoji text, invite_code text, is_default boolean,
               created_at timestamptz, role text, last_read_at timestamptz, member_count integer,
               peer_id uuid, unread integer, last_id uuid, last_body text, last_user_id uuid,
               last_kind text, last_at timestamptz, last_deleted boolean, last_enc text,
               last_key_id uuid, last_files jsonb, last_call jsonb,
               description text, username text, avatar_path text, sign_messages boolean, rights text[],
               verified boolean)
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
         c.description, c.username, c.avatar_path, c.sign_messages, r.rights,
         c.verified or c.kind = 'bot'
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
-- 3. Неофициальные стикеры
-- ---------------------------------------------------------------------------

create table if not exists public.sticker_packs (
  id         text primary key check (id ~ '^u[0-9a-f]{11}$'),
  owner_id   uuid not null references public.profiles (id) on delete cascade,
  title      text not null check (char_length(title) between 1 and 64 and title = btrim(title)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sticker_packs_owner_idx on public.sticker_packs (owner_id);
comment on table public.sticker_packs is 'Неофициальные наборы стикеров. Картинки: storage stickers/<id>/<стикер>. Доступ — через RPC.';

create table if not exists public.stickers (
  pack_id    text not null references public.sticker_packs (id) on delete cascade,
  id         text not null check (id ~ '^[a-z0-9]{10}$'),
  -- Эмодзи стикера: уходит в messages.body и в подсказки при наборе. Букв и пробелов быть не должно.
  emoji      text not null check (char_length(emoji) between 1 and 16 and emoji !~ '[A-Za-zА-Яа-яЁё<>[:space:]]'),
  position   integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (pack_id, id)
);

create table if not exists public.user_sticker_packs (
  user_id  uuid not null references public.profiles (id) on delete cascade,
  pack_id  text not null references public.sticker_packs (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (user_id, pack_id)
);
create index if not exists user_sticker_packs_pack_idx on public.user_sticker_packs (pack_id);

-- Таблицы закрыты: всё через функции ниже (наборы нельзя перебрать списком — только по ссылке).
alter table public.sticker_packs enable row level security;
alter table public.stickers enable row level security;
alter table public.user_sticker_packs enable row level security;
revoke all on public.sticker_packs, public.stickers, public.user_sticker_packs from anon, authenticated;

create or replace function private.owns_sticker_pack(p_pack text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.sticker_packs where id = p_pack and owner_id = (select auth.uid()));
$$;

-- Загрузка картинки стикера: только в свой набор, по шаблону имени и не больше 130 файлов в наборе.
create or replace function private.sticker_upload_ok(p_name text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_name ~ '^u[0-9a-f]{11}/[a-z0-9]{10}$'
     and private.owns_sticker_pack(split_part(p_name, '/', 1))
     and private.is_registered()
     and (select count(*) from storage.objects o
           where o.bucket_id = 'stickers' and o.name like split_part(p_name, '/', 1) || '/%') < 130;
$$;

-- Бакет публичный: картинку видит любой, у кого есть ссылка (как стикеры Telegram), список — только владелец.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('stickers', 'stickers', true, 524288, array['image/webp', 'image/png'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "skam stickers: upload" on storage.objects;
create policy "skam stickers: upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'stickers' and private.sticker_upload_ok(name));
drop policy if exists "skam stickers: read own" on storage.objects;
create policy "skam stickers: read own" on storage.objects for select to authenticated
  using (bucket_id = 'stickers' and (private.owns_sticker_pack(split_part(name, '/', 1)) or private.is_app_owner()));
drop policy if exists "skam stickers: delete own" on storage.objects;
create policy "skam stickers: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'stickers' and (private.owns_sticker_pack(split_part(name, '/', 1)) or private.is_app_owner()));

-- Набор целиком: название, мой ли, добавлен ли у меня, стикеры по порядку.
create or replace function private.sticker_pack_json(p_pack text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id,
    'title', p.title,
    'mine', p.owner_id = (select auth.uid()),
    'added', exists (select 1 from public.user_sticker_packs u where u.pack_id = p.id and u.user_id = (select auth.uid())),
    'stickers', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'emoji', s.emoji) order by s.position, s.created_at, s.id)
      from public.stickers s where s.pack_id = p.id
    ), '[]'::jsonb)
  )
  from public.sticker_packs p
  where p.id = p_pack;
$$;

create or replace function public.sticker_pack(p_pack text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select private.sticker_pack_json(p_pack) where (select auth.uid()) is not null;
$$;

-- Мои наборы (созданные и добавленные) — в порядке добавления.
create or replace function public.my_sticker_packs()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(private.sticker_pack_json(u.pack_id) order by u.added_at, u.pack_id), '[]'::jsonb)
  from public.user_sticker_packs u
  where u.user_id = (select auth.uid());
$$;

create or replace function public.create_sticker_pack(p_title text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_title text := btrim(regexp_replace(coalesce(p_title, ''), '\s+', ' ', 'g'));
  v_id text;
begin
  perform private.require_registered();
  if char_length(v_title) not between 1 and 64 then
    raise exception 'Название набора — от 1 до 64 символов' using errcode = '22023';
  end if;
  if (select count(*) from public.sticker_packs where owner_id = v_me) >= 50 then
    raise exception 'Можно создать не больше 50 наборов стикеров' using errcode = '54000';
  end if;
  if (select count(*) from public.sticker_packs where owner_id = v_me and created_at > now() - interval '1 day') >= 10 then
    raise exception 'За сутки можно создать не больше 10 наборов — попробуйте завтра' using errcode = '54000';
  end if;
  loop
    v_id := 'u' || substr(md5(gen_random_uuid()::text), 1, 11);
    exit when not exists (select 1 from public.sticker_packs where id = v_id);
  end loop;
  insert into public.sticker_packs (id, owner_id, title) values (v_id, v_me, v_title);
  insert into public.user_sticker_packs (user_id, pack_id) values (v_me, v_id);
  return v_id;
end;
$$;

create or replace function public.rename_sticker_pack(p_pack text, p_title text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_title text := btrim(regexp_replace(coalesce(p_title, ''), '\s+', ' ', 'g'));
begin
  if not private.owns_sticker_pack(p_pack) then
    raise exception 'Это не ваш набор' using errcode = '42501';
  end if;
  if char_length(v_title) not between 1 and 64 then
    raise exception 'Название набора — от 1 до 64 символов' using errcode = '22023';
  end if;
  update public.sticker_packs set title = v_title, updated_at = now() where id = p_pack;
end;
$$;

-- Стикер добавляется после загрузки картинки: stickers/<набор>/<стикер>.
create or replace function public.add_sticker(p_pack text, p_id text, p_emoji text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_emoji text := btrim(coalesce(p_emoji, ''));
begin
  if not private.owns_sticker_pack(p_pack) then
    raise exception 'Это не ваш набор' using errcode = '42501';
  end if;
  if coalesce(p_id, '') !~ '^[a-z0-9]{10}$' then
    raise exception 'Неверный стикер' using errcode = '22023';
  end if;
  if char_length(v_emoji) not between 1 and 16 or v_emoji ~ '[A-Za-zА-Яа-яЁё<>[:space:]]' then
    raise exception 'Выберите эмодзи для стикера' using errcode = '22023';
  end if;
  if (select count(*) from public.stickers where pack_id = p_pack) >= 120 then
    raise exception 'В наборе может быть не больше 120 стикеров' using errcode = '54000';
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'stickers' and name = p_pack || '/' || p_id) then
    raise exception 'Картинка стикера не загрузилась — попробуйте ещё раз' using errcode = 'P0001';
  end if;
  insert into public.stickers (pack_id, id, emoji, position)
  values (p_pack, p_id, v_emoji,
          coalesce((select max(position) + 1 from public.stickers where pack_id = p_pack), 0))
  on conflict (pack_id, id) do update set emoji = excluded.emoji;
  update public.sticker_packs set updated_at = now() where id = p_pack;
end;
$$;

create or replace function public.set_sticker_emoji(p_pack text, p_id text, p_emoji text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_emoji text := btrim(coalesce(p_emoji, ''));
begin
  if not private.owns_sticker_pack(p_pack) then
    raise exception 'Это не ваш набор' using errcode = '42501';
  end if;
  if char_length(v_emoji) not between 1 and 16 or v_emoji ~ '[A-Za-zА-Яа-яЁё<>[:space:]]' then
    raise exception 'Выберите эмодзи для стикера' using errcode = '22023';
  end if;
  update public.stickers set emoji = v_emoji where pack_id = p_pack and id = p_id;
  if not found then
    raise exception 'Стикер не найден' using errcode = 'P0002';
  end if;
  update public.sticker_packs set updated_at = now() where id = p_pack;
end;
$$;

-- Убрать стикер из набора (картинку клиент удаляет следом — её удаляет владелец набора).
create or replace function public.remove_sticker(p_pack text, p_id text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.owns_sticker_pack(p_pack) then
    raise exception 'Это не ваш набор' using errcode = '42501';
  end if;
  delete from public.stickers where pack_id = p_pack and id = p_id;
  update public.sticker_packs set updated_at = now() where id = p_pack;
end;
$$;

-- Удалить набор: автору — свой, владельцу СКАМ — любой (модерация). Картинки клиент удаляет до вызова.
create or replace function public.delete_sticker_pack(p_pack text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not (private.owns_sticker_pack(p_pack) or private.is_app_owner()) then
    raise exception 'Удалить набор может только его автор' using errcode = '42501';
  end if;
  delete from public.sticker_packs where id = p_pack;
  if not found then
    raise exception 'Набор не найден' using errcode = 'P0002';
  end if;
end;
$$;

-- Добавить чужой набор к себе / убрать его.
create or replace function public.add_sticker_pack(p_pack text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
begin
  if v_me is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not exists (select 1 from public.sticker_packs where id = p_pack) then
    raise exception 'Набор не найден' using errcode = 'P0002';
  end if;
  if (select count(*) from public.user_sticker_packs where user_id = v_me) >= 200 then
    raise exception 'Можно добавить не больше 200 наборов — уберите ненужные' using errcode = '54000';
  end if;
  insert into public.user_sticker_packs (user_id, pack_id) values (v_me, p_pack)
  on conflict do nothing;
end;
$$;

create or replace function public.remove_sticker_pack(p_pack text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if private.owns_sticker_pack(p_pack) then
    raise exception 'Свой набор можно только удалить' using errcode = '22023';
  end if;
  delete from public.user_sticker_packs where user_id = (select auth.uid()) and pack_id = p_pack;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Бот: про свои стикеры и галочки
-- ---------------------------------------------------------------------------

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
                  else 'Классный стикер! 🎨 Свои наборы — в панели стикеров, кнопка «＋».' end;
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
    reply := E'Я умею немного, но честно:\n• «привет» — поздороваюсь;\n• «помощь» — это сообщение;\n• «стикеры» — расскажу про Голубя свободы и свои наборы;\n• «галочка» — расскажу, что значит официальная галочка;\n• «шифрование» — расскажу, как защищена переписка;\n• «звонки» — расскажу про звонки;\n• «это развод?» — объясню, почему нет.\n\nА ещё подскажу по СКАМ:\n• «Новый чат» — написать человеку по имени или @username, создать группу или канал;\n• стикеры — кнопка со смайликом у поля ввода; наберите эмодзи — подходящие стикеры появятся сами; свои наборы — кнопка «＋» в панели стикеров;\n• голосовое — удерживайте микрофон справа от поля ввода и отпустите, чтобы отправить; уведите палец влево — отмена, вверх — запись без рук;\n• кружочек — коротко нажмите на микрофон, он станет камерой, дальше так же: удерживайте;\n• скрепка 📎 слева от поля ввода — фото, видео и файлы до 50 МБ (можно просто перетащить или вставить из буфера);\n• реакции — наведите на сообщение или коснитесь его (на телефоне — долгое нажатие);\n• ответить — стрелка ↩ над сообщением или правый клик → «Ответить» (на телефоне — смахните сообщение влево);\n• переслать — стрелка ↪ или «Выбрать» несколько сообщений и «Переслать»;\n• звонки — трубка 📞 и камера 📹 в шапке личного чата или группы: голос, видео и демонстрация экрана, как в Discord;\n• имя, @username, фото, тема и пароль шифрования — в профиле внизу слева.';
  elsif t ~ '(галочк|официальн|верифик|verified)' then
    reply := E'✅ Официальная галочка рядом с именем значит, что это настоящий аккаунт или канал, а не подделка. Её выдаёт только команда СКАМ — купить или поставить самому нельзя.\n\nНапример, галочка есть у канала «Новости СКАМ» и у меня 🙂 Если кто-то пишет от имени известного человека без галочки — будьте осторожны.';
  elsif t ~ '(стикер|голуб|sticker)' then
    reply := E'🕊️ Голубь свободы — маскот СКАМ и наш официальный набор из 16 стикеров: «Привет!», «Да», «Нет», «Ха-ха-ха», «Люблю», «Что?!», «Жду», «Спокойной ночи», «Грусть», «Бесишь!», «Хм…», «Свобода!», «Не развод», «Спасибо», «Доброе утро» и «OK».\n\n🎨 Свои стикеры: в панели стикеров нажмите «＋» → «Создать набор», добавьте картинки и к каждой — эмодзи. Ссылкой на набор можно поделиться, а чужой стикер в чате — нажать и добавить весь набор к себе.\n\nНажмите на смайлик у поля ввода или просто наберите 👋, 😂 или 🤔 — подходящий стикер появится сам. Пришлите мне любой — оценю!';
  elsif t ~ '(голосов|кружоч|кружк|видеосообщ|микрофон)' then
    reply := E'🎤 Голосовое: удерживайте микрофон справа от поля ввода, говорите и отпустите — сообщение уйдёт. Передумали — уведите палец влево. Долго говорить — потяните вверх, запись закрепится.\n\n⚪ Кружочек: коротко нажмите на микрофон — он станет камерой. Дальше так же: удерживайте, до минуты.\n\nСлушают и смотрят только участники чата.';
  elsif t ~ '(звон|созвон|видеозв|трубк|демонстрац|call)' then
    reply := E'📞 Звонки в СКАМ — как в Discord: в личном чате или группе нажмите трубку (голос) или камеру (видео) в шапке чата. У собеседников зазвонит, а в группе к идущему звонку можно присоединиться в любой момент — до 8 человек.\n\nВ звонке можно выключить микрофон, выключить звук, включить камеру и показать экран (на компьютере). Звонок не мешает переписке: уйдите в другой чат — внизу слева останется панель «Голосовая связь подключена».\n\n🔒 Звук и видео идут напрямую между участниками и зашифрованы; служебные данные соединения шифруются ключом чата, так что сервер не может подслушать.';
  elsif t ~ '(шифр|безопас|e2e|encrypt|ключ)' then
    reply := E'🔒 Личные чаты и группы в СКАМ защищены сквозным шифрованием: сообщения, фото, видео, файлы, стикеры, голосовые и кружочки шифруются прямо на вашем устройстве и расшифровываются только у собеседников. На сервере лежит лишь шифротекст — прочитать его не можем даже мы.\n\nЗвонки идут напрямую между участниками и тоже зашифрованы.\n\nКлюч хранится на ваших устройствах, а на новом устройстве восстанавливается паролем шифрования.\n\nКаналы и этот чат со мной не шифруются — как каналы и боты в Telegram.';
  elsif t ~ '(развод|скам|мошен|scam|обман)' then
    reply := 'СКАМ — не развод, а мессенджер. Честно-честно 🤞 Личные чаты и группы защищены сквозным шифрованием: их не прочитает никто, кроме участников, — даже сервер.';
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
-- 5. Доступ к функциям
-- ---------------------------------------------------------------------------

do $$
declare f text;
begin
  foreach f in array array[
    'public.am_app_owner()',
    'public.set_verified(text, uuid, boolean)',
    'public.search_users(text, integer)',
    'public.chat_member_list(uuid, text, boolean, integer, integer)',
    'public.my_contacts(uuid, integer)',
    'public.chat_by_invite(text)',
    'public.chat_by_username(text)',
    'public.search_chats(text, integer)',
    'public.my_chats()',
    'public.sticker_pack(text)',
    'public.my_sticker_packs()',
    'public.create_sticker_pack(text)',
    'public.rename_sticker_pack(text, text)',
    'public.add_sticker(text, text, text)',
    'public.set_sticker_emoji(text, text, text)',
    'public.remove_sticker(text, text)',
    'public.delete_sticker_pack(text)',
    'public.add_sticker_pack(text)',
    'public.remove_sticker_pack(text)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

-- Внутренние: только для политик и функций выше.
revoke all on function private.sticker_pack_json(text) from public, anon, authenticated;
-- Эти три вызываются в политиках хранилища от имени authenticated.
revoke all on function private.is_app_owner() from public, anon;
revoke all on function private.owns_sticker_pack(text) from public, anon;
revoke all on function private.sticker_upload_ok(text) from public, anon;
grant execute on function private.is_app_owner() to authenticated, service_role;
grant execute on function private.owns_sticker_pack(text) to authenticated, service_role;
grant execute on function private.sticker_upload_ok(text) to authenticated, service_role;

notify pgrst, 'reload schema';
