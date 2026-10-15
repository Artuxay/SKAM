-- СКАМ 0.4.2 (дополнение) — нейросеть бота не теряет вопросы.
--
-- На своём сервере Edge Functions живут не дольше минуты (workerTimeoutMs в main/index.ts
-- self-hosted Supabase): если модель отвечает долго, функцию останавливают посреди ответа и
-- задание остаётся «working». Поэтому:
--   • pg_cron каждые 15 секунд будит функцию, если в очереди есть вопросы или зависшие задания
--     (private.bot_ai_kick); зависшим считается задание, начатое больше 65 секунд назад;
--   • bot_ai_claim отдаёт зависшее задание ещё раз (всего две попытки), а чат считает занятым
--     только 65 секунд.
-- Модели по умолчанию — сначала быстрые (lite отвечает за 2–6 секунд, полноценные Flash под
-- нагрузкой — 20–90 секунд).

create extension if not exists pg_cron;

alter table private.bot_ai_settings
  alter column models set default array['gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-3.5-flash'];

-- Разбудить функцию, если есть работа. Вызывает pg_cron; можно и руками: select private.bot_ai_kick();
create or replace function private.bot_ai_kick()
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  url text := (select s.hook_url from private.bot_ai_settings s where s.id);
begin
  if url is null or not exists (
    select 1 from private.bot_ai_jobs j
     where j.created_at > now() - interval '10 minutes'
       and (j.status = 'queued'
            or (j.status = 'working' and j.started_at < now() - interval '65 seconds' and j.attempts < 2))
  ) then
    return false;
  end if;
  perform net.http_post(
    url := url,
    body := '{"kick": true}'::jsonb,
    headers := '{"Content-Type": "application/json"}'::jsonb,
    timeout_milliseconds := 60000);
  return true;
end;
$$;

create or replace function public.bot_ai_claim()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  j private.bot_ai_jobs;
  latest private.bot_ai_jobs;
  m public.messages;
  s private.bot_ai_settings;
  since timestamptz;
  nm text;
  h jsonb;
begin
  update private.bot_ai_jobs set status = 'failed', error = 'stale', finished_at = now()
   where status in ('queued', 'working') and created_at < now() - interval '10 minutes';
  update private.bot_ai_jobs set status = 'failed', error = coalesce(error, 'timeout'), finished_at = now()
   where status = 'working' and attempts >= 2 and started_at < now() - interval '65 seconds';
  delete from private.bot_ai_jobs where created_at < now() - interval '30 days';

  select q.* into j from private.bot_ai_jobs q
   where (q.status = 'queued' or (q.status = 'working' and q.started_at < now() - interval '65 seconds' and q.attempts < 2))
     and not exists (select 1 from private.bot_ai_jobs w
                      where w.chat_id = q.chat_id and w.status = 'working' and w.message_id <> q.message_id
                        and w.started_at >= now() - interval '65 seconds')
   order by q.created_at
   limit 1
   for update skip locked;
  if not found then
    return null;
  end if;

  select q.* into latest from private.bot_ai_jobs q
   where q.chat_id = j.chat_id and q.status = 'queued' and q.created_at >= j.created_at
   order by q.created_at desc
   limit 1;
  if found and latest.message_id <> j.message_id then
    update private.bot_ai_jobs q set status = 'merged', finished_at = now()
     where q.chat_id = j.chat_id and q.message_id <> latest.message_id and q.created_at <= latest.created_at
       and (q.status = 'queued' or q.message_id = j.message_id);
    j := latest;
  end if;

  update private.bot_ai_jobs set status = 'working', started_at = now(), attempts = attempts + 1
   where message_id = j.message_id;

  select * into s from private.bot_ai_settings where id;
  select * into m from public.messages where id = j.message_id;
  if m.id is null or m.deleted_at is not null then
    update private.bot_ai_jobs set status = 'failed', error = 'deleted', finished_at = now() where message_id = j.message_id;
    return jsonb_build_object('job', j.message_id, 'skip', true);
  end if;
  if not exists (select 1 from private.bot_ai_chats c where c.chat_id = j.chat_id and c.agreed_at is not null) then
    update private.bot_ai_jobs set status = 'failed', error = 'disabled', finished_at = now() where message_id = j.message_id;
    return jsonb_build_object('job', j.message_id, 'skip', true);
  end if;
  if not private.bot_ai_on(j.user_id) then
    return jsonb_build_object('job', j.message_id, 'off', true);
  end if;

  select c.since into since from private.bot_ai_chats c where c.chat_id = j.chat_id;
  select p.first_name into nm from public.profiles p where p.id = j.user_id;
  select coalesce(jsonb_agg(jsonb_build_object('role', x.role, 'kind', x.kind, 'text', x.body, 'files', x.files, 'at', x.created_at)
                            order by x.created_at), '[]'::jsonb)
    into h
    from (
      select case when mm.user_id is null then 'assistant' else 'user' end as role,
             mm.kind, left(mm.body, 4000) as body, mm.created_at,
             (select jsonb_agg(f ->> 'kind') from jsonb_array_elements(coalesce(mm.files, '[]'::jsonb)) f) as files
        from public.messages mm
       where mm.chat_id = j.chat_id and mm.deleted_at is null
         and mm.created_at <= m.created_at
         and mm.created_at > coalesce(since, '-infinity'::timestamptz)
         and mm.kind in ('text', 'system', 'sticker', 'voice', 'video_note', 'media', 'poll')
       order by mm.created_at desc
       limit s.history
    ) x;

  return jsonb_build_object(
    'job', j.message_id,
    'chat', j.chat_id,
    'name', nm,
    'today', to_char(now() at time zone 'Europe/Moscow', 'YYYY-MM-DD HH24:MI'),
    'history', h,
    'settings', jsonb_build_object(
      'label', s.provider_label, 'base_url', s.base_url, 'relay_url', s.relay_url, 'api_key', s.api_key,
      'models', to_jsonb(s.models), 'reasoning', s.reasoning, 'temperature', s.temperature));
end;
$$;

revoke all on function private.bot_ai_kick() from public, anon, authenticated, service_role;
revoke all on function public.bot_ai_claim() from public, anon, authenticated;
grant execute on function public.bot_ai_claim() to service_role;

-- Будильник: каждые 15 секунд (если работы нет — ничего не делает).
select cron.unschedule(jobid) from cron.job where jobname = 'skam-bot-ai-kick';
select cron.schedule('skam-bot-ai-kick', '15 seconds', 'select private.bot_ai_kick()');
