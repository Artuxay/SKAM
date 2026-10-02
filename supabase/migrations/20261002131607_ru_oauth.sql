-- СКАМ — вход через Яндекс ID и VK ID вместо GitHub и Discord.
--
-- С 7 июля 2026 года российским сайтам нельзя регистрировать и пускать людей через иностранные
-- сервисы входа, поэтому GitHub и Discord убраны, а вместо них — Яндекс ID и VK ID.
-- Вход идёт через Edge Function «oauth-login»: она обменивает код провайдера на профиль, находит
-- или создаёт аккаунт и выдаёт одноразовый токен, которым браузер входит (verifyOtp).
-- Здесь — только связка «аккаунт у провайдера → аккаунт СКАМ». Таблица и функции закрыты
-- от клиентов: пользоваться ими может только service_role (сама функция).
--
-- Если провайдер не дал почту (у VK так бывает), аккаунт получает служебный адрес
-- <провайдер>-<id>@oauth.skam.invalid — на него ничего не отправляется, в интерфейсе он не показывается.
--
-- Скрипт идемпотентный.

create table if not exists private.oauth_links (
  provider text not null check (provider in ('yandex', 'vk')),
  subject text not null check (char_length(subject) between 1 and 64),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_login_at timestamptz not null default now(),
  primary key (provider, subject)
);
create index if not exists oauth_links_user_idx on private.oauth_links (user_id);
alter table private.oauth_links enable row level security;
revoke all on private.oauth_links from public, anon, authenticated;

-- Чей это аккаунт у провайдера: сначала по прежней связке, затем по той же почте
-- (почту провайдер уже подтвердил). null — аккаунта ещё нет.
create or replace function public.oauth_resolve(p_provider text, p_subject text, p_email text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid;
  e text := lower(nullif(btrim(p_email), ''));
begin
  select l.user_id into uid from private.oauth_links l
  where l.provider = p_provider and l.subject = p_subject;
  if uid is not null then
    return uid;
  end if;
  if e is not null and e not like '%@oauth.skam.invalid' then
    select u.id into uid from auth.users u
    where lower(u.email) = e and u.deleted_at is null
    order by u.created_at
    limit 1;
  end if;
  return uid;
end;
$$;

-- Запомнить связку (или обновить время последнего входа).
create or replace function public.oauth_link(p_provider text, p_subject text, p_user uuid)
returns void
language sql security definer set search_path = ''
as $$
  insert into private.oauth_links (provider, subject, user_id)
  values (p_provider, p_subject, p_user)
  on conflict (provider, subject) do update set last_login_at = now();
$$;

revoke all on function public.oauth_resolve(text, text, text) from public, anon, authenticated;
revoke all on function public.oauth_link(text, text, uuid) from public, anon, authenticated;
grant execute on function public.oauth_resolve(text, text, text) to service_role;
grant execute on function public.oauth_link(text, text, uuid) to service_role;

-- Служебный адрес не годится для ответа поддержки — не сохраняем его в обращении.
create or replace function private.support_hide_service_email()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.email like '%@oauth.skam.invalid' then
    new.email := null;
  end if;
  return new;
end;
$$;

create or replace trigger support_hide_service_email
  before insert or update of email on public.support_requests
  for each row execute function private.support_hide_service_email();
