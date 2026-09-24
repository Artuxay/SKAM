-- СКАМ — исключения из обязательного @username.
--
-- У отдельных аккаунтов (например, служебного аккаунта автора канала) @username может не быть.
-- Флаг ставит только администратор через SQL: клиенту обновлять эту колонку не разрешено
-- (права на UPDATE в profiles выданы только на имя, фамилию, username и аватарку).
--
--   update public.profiles set username_optional = true
--   where id = (select id from auth.users where email = '…');

alter table public.profiles add column if not exists username_optional boolean not null default false;
comment on column public.profiles.username_optional is
  'Исключение: аккаунту можно жить без @username. Ставит администратор через SQL.';

-- Зарегистрирован: есть имя и @username (или для аккаунта сделано исключение).
create or replace function private.is_registered()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and first_name is not null
      and (username is not null or username_optional)
  );
$$;

-- @username нельзя стереть — кроме аккаунтов-исключений.
create or replace function private.profiles_guard()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if old.username is not null and new.username is null and not new.username_optional then
    raise exception 'Имя пользователя обязательно' using errcode = '23514';
  end if;
  if old.first_name is not null and new.first_name is null then
    raise exception 'Имя обязательно' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.is_registered(), private.profiles_guard() from public, anon;
grant execute on function private.is_registered() to authenticated;

notify pgrst, 'reload schema';
