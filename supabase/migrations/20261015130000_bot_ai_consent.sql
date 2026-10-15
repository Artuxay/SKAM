-- СКАМ 0.4.2 (дополнение к 20261015120000_bot_ai) — нейросеть бота только с согласия человека.
--
-- Сообщения нейросети уходят в Google (США), а на бесплатном тарифе Google может использовать их
-- для улучшения моделей. Поэтому нейросеть в чате с ботом включает сам человек:
--   • пока не включил — бот отвечает как раньше (готовые ответы), а на вопрос, которого он не понял,
--     предлагает нейросеть и честно пишет, куда уйдут сообщения; «да» / «включить нейросеть» — включить
--     (и сразу ответить на тот вопрос), «выключить нейросеть» — выключить;
--   • то же — переключателем в карточке бота (public.bot_ai_agree).
-- Согласие — private.bot_ai_chats.agreed_at; без него задания не ставятся, а уже стоящие не обрабатываются.

alter table private.bot_ai_chats add column if not exists agreed_at timestamptz;
comment on table private.bot_ai_chats is
  'Чат с ботом: since — «новый диалог» (раньше — не учитывать), agreed_at — человек включил нейросеть, noticed_at — когда бот предложил её последний раз.';

-- Команды: reset | help | start | enable | disable | yes | null (текст уже в нижнем регистре, без пробелов по краям).
create or replace function private.bot_ai_command(p_text text)
returns text
language sql immutable set search_path = ''
as $$
  select case
    when p_text ~ '^(/new|/reset|новый диалог|новый разговор|начать заново|начн[её]м заново|забудь вс[её]|сброс)[.!]*$' then 'reset'
    when p_text ~ '^(/help|помощь|помоги|help|команды|что (ты )?умеешь)[.!?]*$' then 'help'
    when p_text ~ '^/start$' then 'start'
    when p_text ~ '^(/ai|/ai_on|включи(ть)? нейросеть|включи(ть)? ии)[.!]*$' then 'enable'
    when p_text ~ '^(/ai_off|выключи(ть)? нейросеть|отключи(ть)? нейросеть|выключи(ть)? ии|отключи(ть)? ии)[.!]*$' then 'disable'
    when p_text ~ '^(да|ага|угу|давай|включай|согласен|согласна|конечно|ок|окей|ok|yes)[.!)]*$' then 'yes'
  end
$$;

-- Поставить задание нейросети: null — поставлено, иначе — текст ответа (дневной лимит).
create or replace function private.bot_ai_enqueue(p_msg public.messages)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  s private.bot_ai_settings;
  used int;
  total int;
begin
  select * into s from private.bot_ai_settings where id;
  select count(*) filter (where j.user_id = p_msg.user_id), count(*)
    into used, total
    from private.bot_ai_jobs j
   where j.created_at >= private.bot_ai_day_start() and j.status not in ('failed', 'merged');
  if used >= s.user_daily then
    return format('😴 Сегодня я ответил вам уже %s раз — это дневной лимит нейросети. Продолжим завтра! А по СКАМ подскажу и сейчас: напишите «помощь».', s.user_daily);
  end if;
  if total >= s.global_daily then
    return '😴 Нейросеть на сегодня устала: закончился дневной лимит бесплатного тарифа. Попробуйте завтра! А по СКАМ подскажу и сейчас: напишите «помощь».';
  end if;
  insert into private.bot_ai_jobs (message_id, chat_id, user_id)
  values (p_msg.id, p_msg.chat_id, p_msg.user_id)
  on conflict (message_id) do nothing;
  -- Будим функцию; запрос уйдёт после фиксации транзакции. Не вышло — подберёт следующий вызов.
  begin
    perform net.http_post(
      url := s.hook_url,
      body := jsonb_build_object('job', p_msg.id),
      headers := '{"Content-Type": "application/json"}'::jsonb,
      timeout_milliseconds := 60000);
  exception when others then
    null;
  end;
  return null;
end;
$$;

-- Предложение включить нейросеть (и честно — куда уйдут сообщения).
create or replace function private.bot_ai_offer(p_label text)
returns text
language sql immutable set search_path = ''
as $$
  select format(E'🧠 На такие вопросы я могу отвечать с помощью нейросети %s — как ChatGPT, прямо здесь.\n\n⚠️ Сначала важное: этот чат не зашифрован, и то, что вы будете мне писать, уйдёт в Google (США). На бесплатном тарифе Google может использовать это для улучшения своих моделей. Не пишите мне пароли, номера карт, адреса и другое личное. Нейросеть может ошибаться — важное проверяйте.\n\nВключить? Напишите «да» — и я отвечу на ваш вопрос. Выключить можно в любой момент: «выключить нейросеть».', p_label)
$$;

drop function if exists private.bot_ai_help(public.messages);

-- «помощь»: с нейросетью — что она умеет; без неё — прежняя помощь и как её включить.
create or replace function private.bot_ai_help(p_msg public.messages, p_agreed boolean)
returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  s private.bot_ai_settings;
  canned text := private.bot_canned(p_msg);
  i int := position('А ещё подскажу по СКАМ:' in canned);
begin
  select * into s from private.bot_ai_settings where id;
  if not p_agreed then
    return format(E'🧠 Новое: я умею отвечать с помощью нейросети %s — на любые вопросы, не только про СКАМ. Включить — напишите «включить нейросеть».\n\n', s.provider_label) || canned;
  end if;
  return format(E'🧠 Я бот СКАМ, и со мной работает нейросеть %s. Спрашивайте что угодно: объясню, переведу, придумаю, посчитаю, помогу с учёбой и кодом. И, конечно, подскажу всё про СКАМ.\n\n• «новый диалог» — забыть прошлую переписку и начать заново;\n• «выключить нейросеть» — отвечать как раньше, готовыми подсказками;\n• «помощь» — это сообщение;\n• до %s ответов нейросети в день.\n\n⚠️ Этот чат не зашифрован, а сообщения для нейросети уходят в Google — не пишите мне пароли, номера карт и другое личное. Нейросеть может ошибаться: важное проверяйте.',
                s.provider_label, s.user_daily)
    || case when i > 0 then E'\n\n' || replace(substring(canned from i), 'А ещё подскажу по СКАМ:', 'Коротко о СКАМ:') else '' end;
end;
$$;

-- Включить / выключить нейросеть в чате с ботом; включение сразу ставит в работу последний вопрос
-- (до 15 минут назад, если на него ещё не отвечали). Возвращает текст ответа бота.
create or replace function private.bot_ai_switch(p_chat uuid, p_user uuid, p_on boolean, p_before timestamptz)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  label text := (select s.provider_label from private.bot_ai_settings s where s.id);
  was boolean := exists (select 1 from private.bot_ai_chats c where c.chat_id = p_chat and c.agreed_at is not null);
  q public.messages;
begin
  if not p_on then
    update private.bot_ai_chats set agreed_at = null where chat_id = p_chat;
    return case when was
      then 'Нейросеть выключена: отвечаю как раньше, готовыми подсказками по СКАМ. Включить снова — «включить нейросеть».'
      else 'Нейросеть и так выключена 🙂 Включить — «включить нейросеть».' end;
  end if;
  if was then
    return '✅ Нейросеть уже включена — спрашивайте что угодно.';
  end if;
  insert into private.bot_ai_chats (chat_id, agreed_at, noticed_at) values (p_chat, now(), now())
  on conflict (chat_id) do update set agreed_at = now();
  select m.* into q from public.messages m
   where m.chat_id = p_chat and m.user_id = p_user and m.kind = 'text' and m.deleted_at is null
     and m.created_at < p_before and m.created_at > now() - interval '15 minutes'
   order by m.created_at desc
   limit 1;
  if q.id is not null and private.bot_ai_command(lower(btrim(q.body))) is null
     and lower(btrim(q.body)) !~ '^https?://(www\.|test\.)?skam-messenger\.ru/a/[a-z0-9-]+/?$'
     and not exists (select 1 from private.bot_ai_jobs j where j.message_id = q.id)
     and private.bot_ai_enqueue(q) is null then
    return format(E'✅ Нейросеть %s включена. Отвечаю на ваш вопрос…\n\nПомните: то, что вы мне пишете, уходит в Google — личное не пишите. «новый диалог» — начать разговор заново, «выключить нейросеть» — отвечать как раньше.', label);
  end if;
  return format(E'✅ Нейросеть %s включена — спрашивайте что угодно.\n\nПомните: то, что вы мне пишете, уходит в Google (США), и на бесплатном тарифе Google может использовать это для улучшения своих моделей — личное не пишите. «новый диалог» — начать разговор заново, «выключить нейросеть» — отвечать как раньше.', label);
end;
$$;

create or replace function private.bot_reply()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  t text := lower(btrim(new.body));
  cmd text;
  agreed boolean;
  offered boolean;
  reply text;
begin
  if not exists (select 1 from public.chats where id = new.chat_id and kind = 'bot') then
    return null;
  end if;
  if new.kind = 'text' then
    cmd := private.bot_ai_command(t);
  end if;

  if new.kind <> 'text' or cmd = 'start' or not private.bot_ai_on(new.user_id)
     or t ~ '^https?://(www\.|test\.)?skam-messenger\.ru/a/[a-z0-9-]+/?$' then
    reply := private.bot_canned(new);
  else
    agreed := exists (select 1 from private.bot_ai_chats c where c.chat_id = new.chat_id and c.agreed_at is not null);
    -- «да» включает нейросеть, только если бот только что её предложил (и предупредил про Google).
    offered := exists (select 1 from private.bot_ai_chats c where c.chat_id = new.chat_id and c.noticed_at > now() - interval '1 hour');
    if cmd = 'help' then
      reply := private.bot_ai_help(new, agreed);
    elsif cmd = 'enable' or (cmd = 'yes' and not agreed and offered) then
      reply := private.bot_ai_switch(new.chat_id, new.user_id, true, new.created_at);
    elsif cmd = 'disable' then
      reply := private.bot_ai_switch(new.chat_id, new.user_id, false, new.created_at);
    elsif not agreed then
      -- Без согласия — как раньше; вопрос, которого готовые ответы не понимают, — повод предложить нейросеть.
      reply := private.bot_canned(new);
      if cmd = 'reset' or reply like 'Я пока простой бот%' then
        reply := private.bot_ai_offer((select s.provider_label from private.bot_ai_settings s where s.id));
        insert into private.bot_ai_chats (chat_id, noticed_at) values (new.chat_id, now())
        on conflict (chat_id) do update set noticed_at = now();
      end if;
    elsif cmd = 'reset' then
      update private.bot_ai_chats set since = new.created_at where chat_id = new.chat_id;
      reply := '🧹 Начали новый диалог: прошлую переписку я больше не учитываю. О чём поговорим?';
    else
      reply := private.bot_ai_enqueue(new);
      if reply is null then
        return null;
      end if;
    end if;
  end if;

  insert into public.messages (chat_id, user_id, kind, body, created_at)
  values (new.chat_id, null, 'system', reply, clock_timestamp());
  return null;
end;
$$;

-- Задание человека, который успел выключить нейросеть, не обрабатываем.
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
  delete from private.bot_ai_jobs where created_at < now() - interval '30 days';

  select q.* into j from private.bot_ai_jobs q
   where (q.status = 'queued' or (q.status = 'working' and q.started_at < now() - interval '2 minutes' and q.attempts < 2))
     and not exists (select 1 from private.bot_ai_jobs w
                      where w.chat_id = q.chat_id and w.status = 'working' and w.message_id <> q.message_id
                        and w.started_at >= now() - interval '2 minutes')
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

-- { enabled, agreed, label, limit, used, pending }: enabled — нейросеть доступна, agreed — включена в моём чате с ботом.
create or replace function public.bot_ai_status()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'enabled', private.bot_ai_on(auth.uid()),
    'agreed', exists (select 1 from private.bot_ai_chats c join public.chats ch on ch.id = c.chat_id
                       where ch.direct_key = 'bot:' || auth.uid()::text and ch.kind = 'bot' and c.agreed_at is not null),
    'label', s.provider_label,
    'limit', s.user_daily,
    'used', (select count(*) from private.bot_ai_jobs j
              where j.user_id = auth.uid() and j.created_at >= private.bot_ai_day_start()
                and j.status not in ('failed', 'merged')),
    'pending', exists (select 1 from private.bot_ai_jobs j
                        where j.user_id = auth.uid() and j.status in ('queued', 'working')
                          and j.created_at > now() - interval '2 minutes'))
  from private.bot_ai_settings s
  where s.id and auth.uid() is not null
$$;

-- Переключатель «Нейросеть» в карточке бота: ответ бота появляется в чате, как на команду.
create or replace function public.bot_ai_agree(p_on boolean)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  cid uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_on and not private.bot_ai_on(auth.uid()) then
    raise exception 'bot ai is off' using errcode = 'P0001', hint = 'off';
  end if;
  select c.id into cid from public.chats c where c.direct_key = 'bot:' || auth.uid()::text and c.kind = 'bot';
  if cid is null then
    return false;
  end if;
  insert into public.messages (chat_id, user_id, kind, body, created_at)
  values (cid, null, 'system', private.bot_ai_switch(cid, auth.uid(), p_on, now()), clock_timestamp());
  return p_on;
end;
$$;

revoke all on function private.bot_ai_command(text) from public, anon, authenticated, service_role;
revoke all on function private.bot_ai_enqueue(public.messages) from public, anon, authenticated, service_role;
revoke all on function private.bot_ai_offer(text) from public, anon, authenticated, service_role;
revoke all on function private.bot_ai_help(public.messages, boolean) from public, anon, authenticated, service_role;
revoke all on function private.bot_ai_switch(uuid, uuid, boolean, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.bot_reply() from public, anon, authenticated, service_role;
revoke all on function public.bot_ai_claim() from public, anon, authenticated;
revoke all on function public.bot_ai_status() from public, anon;
revoke all on function public.bot_ai_agree(boolean) from public, anon;

grant execute on function public.bot_ai_claim() to service_role;
grant execute on function public.bot_ai_status() to authenticated;
grant execute on function public.bot_ai_agree(boolean) to authenticated;
