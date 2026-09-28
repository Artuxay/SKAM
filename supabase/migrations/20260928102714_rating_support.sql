-- СКАМ — «Оценить СКАМ» и «Поддержка».
--
-- Оценка: у каждого одна оценка от 1 до 5 звёзд, её можно менять. Все видят среднюю,
-- число оценок и распределение по звёздам; чужие оценки по отдельности не видны никому.
--
-- Поддержка: обращение пишется в support_requests через support_submit() (от имени человека,
-- с лимитами), а письмо на ящик СКАМ отправляет Edge Function `support` (supabase/functions/support):
-- она забирает обращение через support_claim() и отмечает результат через support_mark().
-- Если письмо не ушло (например, ещё не задан пароль SMTP), обращение не теряется — функция
-- дошлёт его при следующем обращении, до 5 попыток в течение недели.
--
-- Скрипт идемпотентный.

-- ---------------------------------------------------------------------------
-- Оценка
-- ---------------------------------------------------------------------------

create table if not exists public.app_ratings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  stars smallint not null check (stars between 1 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.app_ratings is 'Оценка мессенджера: одна на пользователя, 1–5 звёзд, можно менять. Читается и пишется только через app_rating() и rate_app().';

alter table public.app_ratings enable row level security;
revoke all on public.app_ratings from anon, authenticated;

-- Сводка: средняя, число оценок, распределение [1★, 2★, 3★, 4★, 5★] и моя оценка.
create or replace function public.app_rating()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'avg', coalesce(round(avg(r.stars)::numeric, 2), 0),
    'count', count(*),
    'dist', jsonb_build_array(
      count(*) filter (where r.stars = 1),
      count(*) filter (where r.stars = 2),
      count(*) filter (where r.stars = 3),
      count(*) filter (where r.stars = 4),
      count(*) filter (where r.stars = 5)
    ),
    'mine', (select m.stars from public.app_ratings m where m.user_id = (select auth.uid()))
  )
  from public.app_ratings r;
$$;

create or replace function public.rate_app(p_stars integer)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'Войдите в аккаунт' using errcode = '42501';
  end if;
  perform private.require_registered();
  if p_stars is null or p_stars not between 1 and 5 then
    raise exception 'Оценка — от 1 до 5 звёзд' using errcode = '22023';
  end if;
  insert into public.app_ratings as a (user_id, stars)
  values (v_uid, p_stars)
  on conflict (user_id) do update
    set stars = excluded.stars, updated_at = now()
    where a.stars is distinct from excluded.stars;
  return public.app_rating();
end;
$$;

revoke all on function public.app_rating(), public.rate_app(integer) from public, anon;
grant execute on function public.app_rating(), public.rate_app(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Поддержка
-- ---------------------------------------------------------------------------

create table if not exists public.support_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  email text,
  name text,
  username text,
  topic text not null check (topic in ('bug', 'question', 'idea', 'other')),
  body text not null check (char_length(body) between 1 and 4000),
  meta jsonb check (meta is null or (jsonb_typeof(meta) = 'object' and octet_length(meta::text) <= 2048)),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  mailed_at timestamptz,
  attempts smallint not null default 0,
  last_error text
);
comment on table public.support_requests is 'Обращения в поддержку. Пишутся через support_submit(), письмо на ящик СКАМ отправляет Edge Function support. Клиентам таблица не видна.';
comment on column public.support_requests.meta is 'Данные об устройстве, если человек разрешил их приложить: браузер, система, экран, язык, версия.';

create index if not exists support_requests_user_idx on public.support_requests (user_id, created_at desc);
create index if not exists support_requests_pending_idx on public.support_requests (created_at) where mailed_at is null;

alter table public.support_requests enable row level security;
revoke all on public.support_requests from anon, authenticated;

-- Новое обращение от имени вошедшего человека. Лимиты: 3 за 10 минут и 10 за сутки на человека,
-- 200 в час на всех (чтобы ящик СКАМ не посчитали спамером).
create or replace function public.support_submit(p_topic text, p_body text, p_meta jsonb default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_body text := btrim(coalesce(p_body, ''), E' \t\r\n');
  v_meta jsonb := p_meta;
  v_prof public.profiles;
  r public.support_requests;
begin
  if v_uid is null then
    raise exception 'Войдите в аккаунт' using errcode = '42501';
  end if;
  perform private.require_registered();

  if p_topic is null or p_topic not in ('bug', 'question', 'idea', 'other') then
    raise exception 'Выберите тему обращения' using errcode = '22023';
  end if;
  if char_length(v_body) < 5 then
    raise exception 'Опишите подробнее — хотя бы пару слов' using errcode = '22023';
  end if;
  if char_length(v_body) > 4000 then
    raise exception 'Слишком длинно: не больше 4000 символов' using errcode = '22023';
  end if;
  if v_meta is not null and (jsonb_typeof(v_meta) <> 'object' or octet_length(v_meta::text) > 2048) then
    v_meta := null;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('skam:support:' || v_uid::text, 0));
  if (select count(*) from public.support_requests
      where user_id = v_uid and created_at > now() - interval '10 minutes') >= 3
    or (select count(*) from public.support_requests
      where user_id = v_uid and created_at > now() - interval '1 day') >= 10
  then
    raise exception 'Слишком много обращений подряд. Подождите немного — мы уже читаем предыдущие.'
      using errcode = '54000';
  end if;
  if (select count(*) from public.support_requests where created_at > now() - interval '1 hour') >= 200 then
    raise exception 'Поддержка сейчас перегружена. Попробуйте через час.' using errcode = '54000';
  end if;

  select * into v_prof from public.profiles where id = v_uid;
  insert into public.support_requests (user_id, email, name, username, topic, body, meta)
  values (
    v_uid,
    (select u.email from auth.users u where u.id = v_uid),
    nullif(btrim(concat_ws(' ', v_prof.first_name, v_prof.last_name)), ''),
    v_prof.username,
    p_topic,
    v_body,
    v_meta
  )
  returning * into r;

  return jsonb_build_object(
    'id', r.id,
    'no', upper(left(replace(r.id::text, '-', ''), 8)),
    'email', r.email
  );
end;
$$;

revoke all on function public.support_submit(text, text, jsonb) from public, anon;
grant execute on function public.support_submit(text, text, jsonb) to authenticated;

-- Только для Edge Function (service_role): забрать обращения, которые пора отправить письмом.
-- p_id — конкретное обращение (только что созданное); без него — до p_limit неотправленных за неделю.
-- Забранное помечается claimed_at, чтобы два запуска функции не отправили одно письмо дважды.
create or replace function public.support_claim(p_id uuid default null, p_limit integer default 5)
returns setof public.support_requests
language sql security definer set search_path = ''
as $$
  update public.support_requests s
  set claimed_at = now(), attempts = s.attempts + 1
  where s.id in (
    select q.id from public.support_requests q
    where q.mailed_at is null
      and q.attempts < 5
      and q.created_at > now() - interval '7 days'
      and (q.claimed_at is null or q.claimed_at < now() - interval '2 minutes')
      and (p_id is null or q.id = p_id)
    order by q.created_at
    limit greatest(1, least(coalesce(p_limit, 5), 20))
    for update skip locked
  )
  returning s.*;
$$;

-- Только для Edge Function: письмо ушло (p_error = null) или не ушло (текст ошибки).
create or replace function public.support_mark(p_id uuid, p_error text default null)
returns void
language sql security definer set search_path = ''
as $$
  update public.support_requests
  set mailed_at = case when p_error is null then now() else mailed_at end,
      last_error = case when p_error is null then null else left(p_error, 500) end,
      claimed_at = case when p_error is null then claimed_at else null end
  where id = p_id;
$$;

revoke all on function public.support_claim(uuid, integer), public.support_mark(uuid, text) from public, anon, authenticated;
grant execute on function public.support_claim(uuid, integer), public.support_mark(uuid, text) to service_role;
