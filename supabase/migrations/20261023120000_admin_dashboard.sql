-- СКАМ 0.5.3: страница владельцев https://skam-messenger.ru/admin/ — статистика и обращения в поддержку.
--
-- Статистика
--   • Считаются только настоящие люди: профили без тестовых аккаунтов (почта @skam.test и служебные
--     selftest-адреса входа через Яндекс/VK) — private.stats_people().
--   • «Сейчас» (private.stats_now) и ряды по дням (admin_stats) считаются прямо из таблиц: регистрации,
--     сообщения, кто писал, звонки. Сообщения — в личных чатах, группах и каналах (с комментариями),
--     без служебных и записей звонков; чаты с ботом и «Избранное» не считаются.
--   • Кто заходил, задним числом не восстановить: в private.presence хранится только последний заход.
--     Поэтому pg_cron каждые 10 минут пишет снимок текущего дня (по Москве) в private.stats_daily —
--     ряд «Заходили» копится с момента применения этой миграции.
--   • Только количества: тексты сообщений (и так зашифрованные в личных чатах и группах) не читаются.
--
-- Обращения в поддержку
--   • support_requests: status (new — новое, work — в работе, done — готово), note — заметка команды,
--     handled_at / handled_by — кто и когда последним менял статус.
--   • admin_support(...) — список с фильтром по статусу; admin_support_set(...) — статус и заметка.
--
-- Всё доступно только владельцам СКАМ (private.app_owners), остальным — ошибка 42501.

-- ---------------------------------------------------------------------------
-- 0. Статус обращений (раньше функций: SQL-функции ниже проверяются при создании)
-- ---------------------------------------------------------------------------

alter table public.support_requests
  add column if not exists status text not null default 'new' check (status in ('new', 'work', 'done')),
  add column if not exists note text check (note is null or char_length(note) <= 2000),
  add column if not exists handled_at timestamptz,
  add column if not exists handled_by uuid references auth.users (id) on delete set null;
comment on column public.support_requests.status is 'new — новое, work — в работе, done — готово. Меняют владельцы СКАМ на странице /admin/.';
comment on column public.support_requests.note is 'Заметка команды СКАМ (человеку не видна).';

create index if not exists support_requests_status_idx on public.support_requests (status, created_at desc);

-- ---------------------------------------------------------------------------
-- 1. Кого считаем
-- ---------------------------------------------------------------------------

create or replace function private.stats_people()
returns table (id uuid, created_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select p.id, p.created_at
  from public.profiles p
  join auth.users u on u.id = p.id
  where coalesce(u.email, '') not like '%@skam.test'
    and coalesce(u.email, '') not like '%selftest%@oauth.skam.invalid';
$$;
comment on function private.stats_people() is
  'Настоящие люди для статистики: профили без тестовых аккаунтов (@skam.test, selftest-адреса входа).';

-- ---------------------------------------------------------------------------
-- 2. Сводка «сейчас»
-- ---------------------------------------------------------------------------

create or replace function private.stats_now()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with
  people as (select id, created_at from private.stats_people()),
  b as (
    select (((now() at time zone 'Europe/Moscow')::date)::timestamp at time zone 'Europe/Moscow') as d0
  ),
  seen as (
    select pr.user_id, greatest(pr.last_seen_at, pr.online_until) as at
    from private.presence pr
    where pr.user_id in (select id from people)
  ),
  msgs as (
    select m.user_id, m.chat_id, c.kind as ck, m.created_at
    from public.messages m
    join public.chats c on c.id = m.chat_id
    where m.created_at > now() - interval '30 days'
      and c.kind in ('direct', 'group', 'channel')
      and m.kind not in ('system', 'call')
      and m.user_id in (select id from people)
  ),
  partnered as (
    select distinct a.user_id
    from public.chat_members a
    join public.chats c on c.id = a.chat_id and c.kind in ('direct', 'group')
    join public.chat_members b on b.chat_id = a.chat_id and b.user_id <> a.user_id
    where b.user_id in (select id from people)
  ),
  calls7 as (
    select c.* from public.calls c where c.created_at > now() - interval '7 days'
  ),
  sup as (
    select
      count(*) filter (where s.status = 'new') as n_new,
      count(*) filter (where s.status = 'work') as n_work,
      count(*) filter (where s.status = 'done') as n_done,
      count(*) filter (where s.mailed_at is null) as n_unmailed
    from public.support_requests s
  ),
  rates as (
    select r.stars from public.app_ratings r where r.user_id in (select id from people)
  )
  select jsonb_build_object(
    'users', (select count(*) from people),
    'test_accounts', (select count(*) from public.profiles) - (select count(*) from people),
    'new_1d', (select count(*) from people, b where people.created_at >= b.d0),
    'new_7d', (select count(*) from people where created_at > now() - interval '7 days'),
    'new_30d', (select count(*) from people where created_at > now() - interval '30 days'),
    'seen_1d', (select count(*) from seen, b where seen.at >= b.d0),
    'seen_7d', (select count(*) from seen where at > now() - interval '7 days'),
    'seen_30d', (select count(*) from seen where at > now() - interval '30 days'),
    'writers_1d', (select count(distinct user_id) from msgs, b where msgs.created_at >= b.d0),
    'writers_7d', (select count(distinct user_id) from msgs where created_at > now() - interval '7 days'),
    'writers_30d', (select count(distinct user_id) from msgs),
    'messages_1d', (select count(*) from msgs, b where msgs.created_at >= b.d0),
    'messages_7d', (select count(*) from msgs where created_at > now() - interval '7 days'),
    'chats_active_7d', (
      select count(distinct chat_id) from msgs
      where ck in ('direct', 'group') and created_at > now() - interval '7 days'
    ),
    'groups_alive_7d', (
      select count(*) from (
        select chat_id from msgs
        where ck = 'group' and created_at > now() - interval '7 days'
        group by chat_id having count(distinct user_id) >= 3
      ) g
    ),
    'lonely', (select count(*) from people where id not in (select user_id from partnered)),
    'calls_7d', (select count(*) from calls7),
    'calls_answered_7d', (select count(*) from calls7 where answered_at is not null),
    'call_minutes_7d', (
      select coalesce(round(sum(extract(epoch from (ended_at - answered_at))) / 60), 0)
      from calls7 where answered_at is not null and ended_at is not null and ended_at > answered_at
    ),
    -- Новички за 30 дней (кроме зарегистрированных меньше суток назад): написали кому-то в первые сутки.
    'activation', (
      select jsonb_build_object('total', count(*), 'done', count(*) filter (where exists (
        select 1 from public.messages m
        join public.chats c on c.id = m.chat_id
        where m.user_id = p.id
          and c.kind in ('direct', 'group', 'channel')
          and m.kind not in ('system', 'call')
          and m.created_at < p.created_at + interval '1 day'
      )))
      from people p
      where p.created_at > now() - interval '30 days' and p.created_at <= now() - interval '1 day'
    ),
    -- Зарегистрировались 7–37 дней назад: вернулись (заходили или писали) спустя неделю после регистрации.
    'week_return', (
      select jsonb_build_object('total', count(*), 'done', count(*) filter (where
        exists (select 1 from seen s where s.user_id = p.id and s.at >= p.created_at + interval '7 days')
        or exists (
          select 1 from public.messages m
          where m.user_id = p.id and m.kind not in ('system', 'call')
            and m.created_at >= p.created_at + interval '7 days'
        )
      ))
      from people p
      where p.created_at > now() - interval '37 days' and p.created_at <= now() - interval '7 days'
    ),
    'ratings', jsonb_build_object(
      'count', (select count(*) from rates),
      'avg', (select round(avg(stars)::numeric, 2) from rates),
      'dist', (
        select jsonb_agg(coalesce(x.n, 0) order by s.s)
        from generate_series(1, 5) as s (s)
        left join (select stars, count(*) as n from rates group by stars) x on x.stars = s.s
      )
    ),
    'support', (
      select jsonb_build_object('new', n_new, 'work', n_work, 'done', n_done, 'unmailed', n_unmailed) from sup
    ),
    'content', jsonb_build_object(
      'channels', (select count(*) from public.chats where kind = 'channel'),
      'public_channels', (select count(*) from public.chats where kind = 'channel' and username is not null),
      'groups', (select count(*) from public.chats where kind = 'group'),
      'stories_7d', (select count(*) from public.stories where created_at > now() - interval '7 days'),
      'articles', (select count(*) from public.articles where hidden_at is null),
      'polls_30d', (select count(*) from public.polls where created_at > now() - interval '30 days')
    )
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. Снимки по дням (для ряда «Заходили»)
-- ---------------------------------------------------------------------------

create table if not exists private.stats_daily (
  day date primary key,
  data jsonb not null,
  taken_at timestamptz not null default now()
);
comment on table private.stats_daily is
  'Снимок статистики за день по Москве: то, что нельзя посчитать задним числом (кто заходил). Пишет pg_cron (skam-stats-snapshot).';
revoke all on table private.stats_daily from public, anon, authenticated;

create or replace function private.stats_snapshot()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v jsonb := private.stats_now();
begin
  insert into private.stats_daily (day, data, taken_at)
  values (
    (now() at time zone 'Europe/Moscow')::date,
    jsonb_build_object(
      'users', v -> 'users',
      'seen_1d', v -> 'seen_1d',
      'seen_7d', v -> 'seen_7d',
      'seen_30d', v -> 'seen_30d',
      'writers_1d', v -> 'writers_1d',
      'writers_7d', v -> 'writers_7d',
      'groups_alive_7d', v -> 'groups_alive_7d',
      'lonely', v -> 'lonely'
    ),
    now()
  )
  on conflict (day) do update set data = excluded.data, taken_at = excluded.taken_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Статистика для страницы владельцев
-- ---------------------------------------------------------------------------

create or replace function public.admin_stats(p_days integer default 90)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_days integer := least(greatest(coalesce(p_days, 90), 7), 366);
  v_today date := (now() at time zone 'Europe/Moscow')::date;
  v_from date := v_today - (v_days - 1);
  v_from_ts timestamptz := (v_from::timestamp at time zone 'Europe/Moscow');
begin
  if not private.is_app_owner() then
    raise exception 'Только для владельцев СКАМ' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'at', now(),
    'today', v_today,
    'days', v_days,
    'tz', 'Europe/Moscow',
    'snapshots_since', (select min(day) from private.stats_daily),
    'now', private.stats_now(),
    'daily', (
      with
      people as (select id, created_at from private.stats_people()),
      days as (
        select d::date as day from generate_series(v_from::timestamp, v_today::timestamp, interval '1 day') as g (d)
      ),
      reg as (
        select (created_at at time zone 'Europe/Moscow')::date as day, count(*) as n
        from people where created_at >= v_from_ts group by 1
      ),
      msg as (
        select (m.created_at at time zone 'Europe/Moscow')::date as day, count(*) as n, count(distinct m.user_id) as w
        from public.messages m
        join public.chats c on c.id = m.chat_id
        where m.created_at >= v_from_ts
          and c.kind in ('direct', 'group', 'channel')
          and m.kind not in ('system', 'call')
          and m.user_id in (select id from people)
        group by 1
      ),
      cl as (
        select (created_at at time zone 'Europe/Moscow')::date as day, count(*) as n
        from public.calls where created_at >= v_from_ts group by 1
      )
      select jsonb_agg(jsonb_build_object(
        'day', d.day,
        'new_users', coalesce(reg.n, 0),
        'messages', coalesce(msg.n, 0),
        'writers', coalesce(msg.w, 0),
        'calls', coalesce(cl.n, 0),
        'seen', (sd.data ->> 'seen_1d')::integer
      ) order by d.day)
      from days d
      left join reg on reg.day = d.day
      left join msg on msg.day = d.day
      left join cl on cl.day = d.day
      left join private.stats_daily sd on sd.day = d.day
    ),
    -- Публичные каналы (у них есть @адрес — их и так видят все): самые большие.
    'top_channels', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.members desc, t.posts_7d desc)
      from (
        select c.name, c.username, c.verified,
          (select count(*) from public.chat_members cm where cm.chat_id = c.id) as members,
          (select count(*) from public.messages m
            where m.chat_id = c.id and m.thread_id is null and m.kind not in ('system', 'call')
              and m.created_at > now() - interval '7 days') as posts_7d,
          (select count(*) from public.messages m
            where m.chat_id = c.id and m.thread_id is not null and m.kind not in ('system', 'call')
              and m.created_at > now() - interval '7 days') as comments_7d
        from public.chats c
        where c.kind = 'channel' and c.username is not null
        order by members desc
        limit 6
      ) t
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Обращения в поддержку
-- ---------------------------------------------------------------------------

create or replace function public.admin_support(
  p_status text default null,
  p_limit integer default 50,
  p_before timestamptz default null
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_app_owner() then
    raise exception 'Только для владельцев СКАМ' using errcode = '42501';
  end if;
  if p_status is not null and p_status not in ('new', 'work', 'done') then
    raise exception 'Неизвестный статус' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'counts', (
      select jsonb_build_object(
        'new', count(*) filter (where status = 'new'),
        'work', count(*) filter (where status = 'work'),
        'done', count(*) filter (where status = 'done'),
        'all', count(*),
        'unmailed', count(*) filter (where mailed_at is null)
      )
      from public.support_requests
    ),
    'items', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at desc)
      from (
        select
          r.id,
          upper(left(replace(r.id::text, '-', ''), 8)) as no,
          r.created_at, r.topic, r.body, r.email, r.name, r.username, r.user_id, r.meta,
          r.mailed_at, r.attempts, r.last_error,
          r.status, r.note, r.handled_at,
          hp.name as handled_by_name,
          p.name as profile_name, p.username as profile_username,
          (select count(*) from public.support_requests q where q.user_id = r.user_id) as user_total
        from public.support_requests r
        left join public.profiles p on p.id = r.user_id
        left join public.profiles hp on hp.id = r.handled_by
        where (p_status is null or r.status = p_status)
          and (p_before is null or r.created_at < p_before)
        order by r.created_at desc
        limit least(greatest(coalesce(p_limit, 50), 1), 200)
      ) x
    ), '[]'::jsonb)
  );
end;
$$;

-- Статус и/или заметка. null — не менять; пустая заметка — стереть.
create or replace function public.admin_support_set(
  p_id uuid,
  p_status text default null,
  p_note text default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  r public.support_requests;
begin
  if not private.is_app_owner() then
    raise exception 'Только для владельцев СКАМ' using errcode = '42501';
  end if;
  if p_status is not null and p_status not in ('new', 'work', 'done') then
    raise exception 'Неизвестный статус' using errcode = '22023';
  end if;
  if p_note is not null and char_length(btrim(p_note)) > 2000 then
    raise exception 'Заметка длиннее 2000 символов' using errcode = '22023';
  end if;

  update public.support_requests s
  set status = coalesce(p_status, s.status),
      note = case when p_note is null then s.note else nullif(btrim(p_note), '') end,
      handled_at = case when p_status is not null and p_status is distinct from s.status then now() else s.handled_at end,
      handled_by = case when p_status is not null and p_status is distinct from s.status then (select auth.uid()) else s.handled_by end
  where s.id = p_id
  returning * into r;

  if r.id is null then
    raise exception 'Обращение не найдено' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'id', r.id,
    'status', r.status,
    'note', r.note,
    'handled_at', r.handled_at,
    'handled_by_name', (select name from public.profiles where id = r.handled_by)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Права и расписание
-- ---------------------------------------------------------------------------

revoke all on function private.stats_people(), private.stats_now(), private.stats_snapshot()
  from public, anon, authenticated;

revoke all on function public.admin_stats(integer) from public, anon;
revoke all on function public.admin_support(text, integer, timestamptz) from public, anon;
revoke all on function public.admin_support_set(uuid, text, text) from public, anon;
grant execute on function public.admin_stats(integer) to authenticated;
grant execute on function public.admin_support(text, integer, timestamptz) to authenticated;
grant execute on function public.admin_support_set(uuid, text, text) to authenticated;

create extension if not exists pg_cron;
select cron.unschedule(jobid) from cron.job where jobname = 'skam-stats-snapshot';
select cron.schedule('skam-stats-snapshot', '*/10 * * * *', 'select private.stats_snapshot()');

-- Первый снимок — сразу.
select private.stats_snapshot();
