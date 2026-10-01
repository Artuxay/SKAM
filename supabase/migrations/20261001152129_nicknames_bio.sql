-- СКАМ 1.2.0: свои ники для людей и «О себе» в профиле.
--
-- Ник — имя, которое вы дали человеку (как «имя контакта» в Telegram). Его видите только вы:
-- таблица закрыта, читать и менять свои ники можно только через функции ниже.
-- Хранится на сервере, поэтому одинаковый на всех ваших устройствах.
--
-- «О себе» — короткий рассказ о себе в профиле, до 140 символов. Его видят все.

-- ---------------------------------------------------------------------------
-- 1. Ники
-- ---------------------------------------------------------------------------

create table if not exists public.user_nicknames (
  owner_id   uuid not null references public.profiles (id) on delete cascade,
  target_id  uuid not null references public.profiles (id) on delete cascade,
  -- Одна строка без лишних пробелов и управляющих символов.
  nickname   text not null check (
    char_length(nickname) between 1 and 64
    and nickname = btrim(nickname)
    and nickname !~ '[[:cntrl:]]'
  ),
  updated_at timestamptz not null default now(),
  primary key (owner_id, target_id),
  check (owner_id <> target_id)
);
create index if not exists user_nicknames_target_idx on public.user_nicknames (target_id);
comment on table public.user_nicknames is 'Свои ники для людей (видит только owner_id). Доступ — через RPC.';

alter table public.user_nicknames enable row level security;
revoke all on public.user_nicknames from anon, authenticated;

-- Мои ники и то, как эти люди выглядят (как в search_users): имя, @username, фото, цвет, галочка.
-- Нужно, чтобы показать ник и карточку человека даже без общего чата.
create or replace function public.my_nicknames()
returns table (user_id uuid, nickname text, name text, username text, avatar_path text, color text, verified boolean)
language sql stable security definer set search_path = ''
as $$
  select n.target_id, n.nickname, p.name, p.username, p.avatar_path, p.color, p.verified
  from public.user_nicknames n
  join public.profiles p on p.id = n.target_id
  where n.owner_id = (select auth.uid())
  order by n.updated_at desc, n.target_id;
$$;

-- Дать ник, изменить или убрать (пусто или null — убрать). Возвращает сохранённый ник или null.
create or replace function public.set_nickname(p_user uuid, p_nickname text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  v  text;
begin
  if me is null then
    raise exception 'Нужно войти' using errcode = '42501';
  end if;
  if p_user is null or p_user = me then
    raise exception 'Себе ник дать нельзя' using errcode = '22023';
  end if;
  -- Управляющие символы и переносы — в пробел, лишние пробелы — убрать.
  v := btrim(regexp_replace(regexp_replace(coalesce(p_nickname, ''), '[[:cntrl:]]', ' ', 'g'), '\s+', ' ', 'g'));
  if v = '' then
    delete from public.user_nicknames where owner_id = me and target_id = p_user;
    return null;
  end if;
  if char_length(v) > 64 then
    raise exception 'Ник длиннее 64 символов' using errcode = '22001';
  end if;
  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'Такого пользователя нет' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.user_nicknames where owner_id = me and target_id = p_user)
     and (select count(*) from public.user_nicknames where owner_id = me) >= 1000 then
    raise exception 'Можно дать не больше 1000 ников' using errcode = '54000';
  end if;
  insert into public.user_nicknames (owner_id, target_id, nickname)
  values (me, p_user, v)
  on conflict (owner_id, target_id) do update set nickname = excluded.nickname, updated_at = now();
  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. «О себе»
-- ---------------------------------------------------------------------------

alter table public.profiles add column if not exists bio text;
alter table public.profiles drop constraint if exists profiles_bio_check;
alter table public.profiles add constraint profiles_bio_check check (
  bio is null or (
    char_length(bio) between 1 and 140
    and bio = btrim(bio, E' \n\t')
    -- Без управляющих символов, кроме переноса строки; не больше 5 строк.
    and bio !~ '[\x01-\x09\x0b-\x1f\x7f]'
    and cardinality(string_to_array(bio, E'\n')) <= 5
  )
);
comment on column public.profiles.bio is '«О себе»: до 140 символов, до 5 строк. Видят все.';

grant select (bio) on public.profiles to authenticated;
grant update (bio) on public.profiles to authenticated;

-- Пустое «О себе» — null; переносы \r\n — \n. Остальные проверки прежние.
create or replace function private.profiles_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.username is not null and new.username is null and not new.username_optional then
    raise exception 'Имя пользователя обязательно' using errcode = '23514';
  end if;
  if old.first_name is not null and new.first_name is null then
    raise exception 'Имя обязательно' using errcode = '23514';
  end if;
  if new.bio is distinct from old.bio then
    new.bio := nullif(btrim(replace(replace(new.bio, E'\r\n', E'\n'), E'\r', E'\n'), E' \n\t'), '');
  end if;
  return new;
end;
$$;

-- «О себе» любого человека. Профиль целиком виден только тем, с кем есть общий чат,
-- а «О себе» — всем (как имя и @username в поиске).
create or replace function public.user_bio(p_user uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select p.bio from public.profiles p
  where p.id = p_user and (select auth.uid()) is not null;
$$;

-- ---------------------------------------------------------------------------
-- 3. Права на функции
-- ---------------------------------------------------------------------------

do $$
declare f text;
begin
  foreach f in array array[
    'public.my_nicknames()',
    'public.set_nickname(uuid, text)',
    'public.user_bio(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
