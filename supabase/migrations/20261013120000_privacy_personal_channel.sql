-- СКАМ 0.4.1 — «Время захода» как в Telegram, личный канал в профиле, привязка Яндекс ID и VK ID.
--
-- 1. Время захода и «в сети» (Все / Контакты / Никто).
--    Раньше last_seen_at и online_until лежали в public.profiles: их читал любой, с кем есть общий
--    чат, а Realtime рассылал каждое обновление пульса. Теперь они в закрытой private.presence,
--    а наружу выходят только через user_presence() — уже с учётом настроек обеих сторон:
--      • точное время и «в сети» — только если оба разрешают друг другу (взаимность как в Telegram);
--      • иначе — примерно: recently (до 3 дней), week (до 7), month (до 30), long (дольше);
--      • заблокированным (в обе стороны) — всегда long, «был(а) давно».
--    Контакты — люди, с которыми у вас личный чат, который начали вы или в котором вы писали,
--    и те, кому вы дали ник.
--    Колонки last_seen_at и online_until из profiles удаляются (сначала — из публикации Realtime);
--    старые клиенты получат вместо времени «был(а) недавно».
-- 2. Личный канал: свой публичный канал (вы — владелец) в профиле, его видят все с последним постом.
-- 3. Привязка Яндекс ID / VK ID к уже существующему аккаунту и отвязка (функция oauth-login, mode = link).
--
-- Скрипт идемпотентный. На своём сервере новые объекты получают права по умолчанию (anon и
-- authenticated — всё), поэтому в конце явные revoke/grant.

-- ---------------------------------------------------------------------------
-- 1. Время захода
-- ---------------------------------------------------------------------------

create table if not exists private.presence (
  user_id uuid primary key references auth.users (id) on delete cascade,
  last_seen_at timestamptz,
  online_until timestamptz
);
alter table private.presence enable row level security;
revoke all on private.presence from public, anon, authenticated;

create table if not exists private.privacy (
  user_id uuid primary key references auth.users (id) on delete cascade,
  last_seen text not null default 'everybody' check (last_seen in ('everybody', 'contacts', 'nobody')),
  updated_at timestamptz not null default now()
);
alter table private.privacy enable row level security;
revoke all on private.privacy from public, anon, authenticated;

-- Перенос времени из profiles (только пока колонки ещё есть).
do $m$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'profiles' and column_name = 'last_seen_at') then
    execute $q$
      insert into private.presence (user_id, last_seen_at, online_until)
      select p.id, p.last_seen_at, p.online_until
      from public.profiles p
      join auth.users u on u.id = p.id
      where p.last_seen_at is not null or p.online_until is not null
      on conflict (user_id) do update
        set last_seen_at = greatest(private.presence.last_seen_at, excluded.last_seen_at),
            online_until = greatest(private.presence.online_until, excluded.online_until)
    $q$;
  end if;
end
$m$;

-- Контакт ли p_other для p_owner: личный чат, который начал p_owner или где он писал, либо ник.
create or replace function private.seen_contact(p_owner uuid, p_other uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_owner is not null and p_other is not null and p_owner <> p_other and (
    exists (
      select 1 from public.chats c
      where c.kind = 'direct'
        and c.direct_key = least(p_owner, p_other)::text || ':' || greatest(p_owner, p_other)::text
        and (c.created_by = p_owner
             or exists (select 1 from public.messages m where m.chat_id = c.id and m.user_id = p_owner))
    )
    or exists (select 1 from public.user_nicknames n where n.owner_id = p_owner and n.target_id = p_other)
  );
$$;

-- Разрешает ли p_owner видеть своё время захода человеку p_viewer.
create or replace function private.seen_allowed(p_owner uuid, p_viewer uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case coalesce((select v.last_seen from private.privacy v where v.user_id = p_owner), 'everybody')
    when 'everybody' then true
    when 'contacts' then private.seen_contact(p_owner, p_viewer)
    else false
  end;
$$;

-- Примерное время: недавно / на этой неделе / в этом месяце / давно.
create or replace function private.seen_bucket(p_at timestamptz)
returns text
language sql stable set search_path = ''
as $$
  select case
    when p_at is null then 'long'
    when p_at > now() - interval '3 days' then 'recently'
    when p_at > now() - interval '7 days' then 'week'
    when p_at > now() - interval '30 days' then 'month'
    else 'long'
  end;
$$;

-- Что p_viewer видит о времени захода p_target. Точное время — или null и примерное seen.
create or replace function private.presence_view(p_viewer uuid, p_target uuid)
returns table (online_until timestamptz, last_seen_at timestamptz, seen text)
language sql stable security definer set search_path = ''
as $$
  with pr as (
    select x.last_seen_at, x.online_until from private.presence x where x.user_id = p_target
  ),
  v as (
    select case
      when p_viewer is null or p_target is null then 'hidden'
      when p_viewer = p_target then 'exact'
      when private.blocked_pair(p_viewer, p_target) then 'blocked'
      when private.seen_allowed(p_target, p_viewer) and private.seen_allowed(p_viewer, p_target) then 'exact'
      else 'hidden'
    end as mode
  )
  select case when v.mode = 'exact' then pr.online_until end,
         case when v.mode = 'exact' then pr.last_seen_at end,
         case
           when v.mode = 'exact' and pr.last_seen_at is not null then null
           when v.mode = 'blocked' then 'long'
           -- least() пропускает null, поэтому online_until без значения не должен давать now().
           else private.seen_bucket(greatest(pr.last_seen_at,
                                             case when pr.online_until is not null then least(pr.online_until, now()) end))
         end
  from v left join pr on true;
$$;

-- Время захода людей для клиента (до 500 за раз). Только существующие профили.
create or replace function public.user_presence(p_ids uuid[])
returns table (user_id uuid, online_until timestamptz, last_seen_at timestamptz, seen text)
language sql stable security definer set search_path = ''
as $$
  select p.id, v.online_until, v.last_seen_at, v.seen
  from (select distinct x as id from unnest((coalesce(p_ids, '{}'::uuid[]))[1:500]) x where x is not null) ids
  join public.profiles p on p.id = ids.id
  cross join lateral private.presence_view((select auth.uid()), p.id) v
  where (select auth.uid()) is not null;
$$;

-- Пульс «я в сети»: раз в 45 секунд, пока вкладка видна; при уходе — сразу «был(а)».
create or replace function public.ping(p_online boolean default true)
returns void
language sql security definer set search_path = ''
as $$
  insert into private.presence (user_id, last_seen_at, online_until)
  select (select auth.uid()), now(),
         case when coalesce(p_online, true) then now() + interval '75 seconds' else now() end
  where (select auth.uid()) is not null
  on conflict (user_id) do update
    set last_seen_at = excluded.last_seen_at, online_until = excluded.online_until;
$$;

-- Мои настройки конфиденциальности.
create or replace function public.my_privacy()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'last_seen', coalesce((select v.last_seen from private.privacy v where v.user_id = (select auth.uid())), 'everybody')
  )
  where (select auth.uid()) is not null;
$$;

create or replace function public.set_privacy(p_key text, p_value text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
begin
  if me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_key is distinct from 'last_seen' then
    raise exception 'unknown setting' using errcode = '22023';
  end if;
  if p_value is null or p_value not in ('everybody', 'contacts', 'nobody') then
    raise exception 'bad value' using errcode = '22023';
  end if;
  insert into private.privacy (user_id, last_seen, updated_at)
  values (me, p_value, now())
  on conflict (user_id) do update set last_seen = excluded.last_seen, updated_at = now();
  return public.my_privacy();
end;
$$;

-- Люди, с которыми у меня общий личный чат или группа: время захода — с учётом настроек.
-- Порядок — по видимому времени, затем по примерному (порядок не выдаёт скрытое время).
drop function if exists public.my_contacts(uuid, integer);
create function public.my_contacts(p_chat uuid default null, p_limit integer default 300)
returns table (id uuid, name text, username text, avatar_path text, color text,
               last_seen_at timestamptz, online_until timestamptz, seen text, in_chat boolean, verified boolean)
language sql stable security definer set search_path = ''
as $$
  select p.id, p.name, p.username, p.avatar_path, p.color, v.last_seen_at, v.online_until, v.seen,
         (p_chat is not null and private.is_chat_member(p_chat)
          and exists (select 1 from public.chat_members x where x.chat_id = p_chat and x.user_id = p.id)),
         p.verified
  from public.profiles p
  cross join lateral private.presence_view((select auth.uid()), p.id) v
  where p.id in (
      select b.user_id
      from public.chat_members a
      join public.chat_members b on b.chat_id = a.chat_id
      join public.chats c on c.id = a.chat_id and c.kind in ('group', 'direct')
      where a.user_id = (select auth.uid()) and b.user_id <> a.user_id
    )
    and p.first_name is not null
  order by greatest(v.online_until, v.last_seen_at) desc nulls last,
           case v.seen when 'recently' then 0 when 'week' then 1 when 'month' then 2 else 3 end,
           p.name
  limit least(greatest(coalesce(p_limit, 300), 1), 1000);
$$;

-- Участники группы / подписчики канала (для админов) — время захода тоже с учётом настроек.
drop function if exists public.chat_member_list(uuid, text, boolean, integer, integer);
create function public.chat_member_list(p_chat uuid, p_query text default null, p_admins boolean default false,
                                        p_limit integer default 50, p_offset integer default 0)
returns table (user_id uuid, role text, rights text[], promoted_by uuid, joined_at timestamptz,
               name text, username text, avatar_path text, color text,
               last_seen_at timestamptz, online_until timestamptz, seen text, verified boolean)
language sql stable security definer set search_path = ''
as $$
  with q as (
    select nullif(btrim(regexp_replace(ltrim(private.search_norm(p_query), '@'), '\s+', ' ', 'g')), '') as s
  )
  select m.user_id, m.role, m.rights, m.promoted_by, m.joined_at,
         p.name, p.username, p.avatar_path, p.color, v.last_seen_at, v.online_until, v.seen, p.verified
  from public.chat_members m
  join public.chats c on c.id = m.chat_id
  join public.profiles p on p.id = m.user_id
  cross join q
  cross join lateral private.presence_view((select auth.uid()), m.user_id) v
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

-- Убрать время из profiles: сначала из списка колонок публикации Realtime, потом сами колонки.
do $p$
declare
  cols text;
begin
  if exists (select 1 from pg_publication_tables t
             where t.pubname = 'supabase_realtime' and t.schemaname = 'public' and t.tablename = 'profiles'
               and t.attnames && array['last_seen_at', 'online_until']::name[]) then
    select string_agg(quote_ident(a.col), ', ' order by a.n) into cols
    from pg_publication_tables t, unnest(t.attnames) with ordinality as a(col, n)
    where t.pubname = 'supabase_realtime' and t.schemaname = 'public' and t.tablename = 'profiles'
      and a.col not in ('last_seen_at', 'online_until');
    execute 'alter publication supabase_realtime drop table public.profiles';
    execute format('alter publication supabase_realtime add table public.profiles (%s)', cols);
  end if;
end
$p$;

alter table public.profiles drop column if exists last_seen_at, drop column if exists online_until;

-- ---------------------------------------------------------------------------
-- 2. Личный канал в профиле
-- ---------------------------------------------------------------------------

create table if not exists private.personal_channels (
  user_id uuid primary key references auth.users (id) on delete cascade,
  chat_id uuid not null references public.chats (id) on delete cascade,
  updated_at timestamptz not null default now()
);
create index if not exists personal_channels_chat_idx on private.personal_channels (chat_id);
alter table private.personal_channels enable row level security;
revoke all on private.personal_channels from public, anon, authenticated;

-- Закрепить свой публичный канал в профиле (null — убрать).
create or replace function public.set_personal_channel(p_chat uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
begin
  perform private.require_registered();
  if p_chat is null then
    delete from private.personal_channels where user_id = me;
    return;
  end if;
  if not exists (
    select 1 from public.chats c
    join public.chat_members m on m.chat_id = c.id and m.user_id = me and m.role = 'owner'
    where c.id = p_chat and c.kind = 'channel'
  ) then
    raise exception 'not your channel' using errcode = '42501';
  end if;
  if not exists (select 1 from public.chats c where c.id = p_chat and c.username is not null) then
    raise exception 'channel is not public' using errcode = '22023';
  end if;
  insert into private.personal_channels (user_id, chat_id, updated_at)
  values (me, p_chat, now())
  on conflict (user_id) do update set chat_id = excluded.chat_id, updated_at = now();
end;
$$;

-- Личный канал человека с последним постом. Пусто, если канала нет, он стал частным,
-- человек больше не владелец или между вами блокировка.
create or replace function public.personal_channel(p_user uuid)
returns table (id uuid, name text, username text, avatar_path text, verified boolean, member_count integer,
               is_member boolean, post_id uuid, post_kind text, post_body text, post_at timestamptz,
               post_media_mime text, post_files jsonb, post_sticker text)
language sql stable security definer set search_path = ''
as $$
  select c.id, c.name, c.username, c.avatar_path, c.verified,
         (select count(*) from public.chat_members x where x.chat_id = c.id)::int,
         exists (select 1 from public.chat_members x where x.chat_id = c.id and x.user_id = (select auth.uid())),
         lm.id, lm.kind, left(lm.body, 400), lm.created_at, lm.media_mime, lm.files, lm.sticker
  from private.personal_channels pc
  join public.chats c on c.id = pc.chat_id and c.kind = 'channel' and c.username is not null
  join public.chat_members o on o.chat_id = c.id and o.user_id = pc.user_id and o.role = 'owner'
  left join lateral (
    select m.id, m.kind, m.body, m.created_at, m.media_mime, m.files, m.sticker
    from public.messages m
    where m.chat_id = c.id and m.deleted_at is null and m.kind <> 'system'
    order by m.created_at desc, m.id desc
    limit 1
  ) lm on true
  where pc.user_id = p_user
    and (select auth.uid()) is not null
    and not private.blocked_pair((select auth.uid()), p_user);
$$;

-- ---------------------------------------------------------------------------
-- 3. Привязка Яндекс ID и VK ID к своему аккаунту
-- ---------------------------------------------------------------------------

-- app_metadata.skam_oauth = список привязанных провайдеров (по нему «Вход: почта, Яндекс ID»).
create or replace function private.oauth_meta(p_user uuid)
returns void
language sql security definer set search_path = ''
as $$
  update auth.users u
  set raw_app_meta_data = case
    when l.list is null then coalesce(u.raw_app_meta_data, '{}'::jsonb) - 'skam_oauth'
    else coalesce(u.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('skam_oauth', l.list)
  end
  from (select jsonb_agg(distinct x.provider) as list from private.oauth_links x where x.user_id = p_user) l
  where u.id = p_user;
$$;

-- Привязать аккаунт провайдера к p_user (только service_role — функция oauth-login после обмена кода).
-- 'taken' — этот аккаунт провайдера уже входит в другой аккаунт СКАМ.
create or replace function public.oauth_attach(p_provider text, p_subject text, p_user uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  owner_id uuid;
begin
  if p_provider not in ('yandex', 'vk') or p_subject is null or p_user is null then
    raise exception 'bad request' using errcode = '22023';
  end if;
  select l.user_id into owner_id from private.oauth_links l
  where l.provider = p_provider and l.subject = p_subject
  for update;
  if owner_id is not null and owner_id <> p_user then
    return 'taken';
  end if;
  if owner_id is null then
    -- Один аккаунт каждого провайдера на аккаунт СКАМ: прежний того же провайдера заменяется.
    delete from private.oauth_links where provider = p_provider and user_id = p_user;
    insert into private.oauth_links (provider, subject, user_id) values (p_provider, p_subject, p_user);
  end if;
  perform private.oauth_meta(p_user);
  return 'ok';
end;
$$;

-- Мои привязки: какой провайдер, когда привязан, когда входили.
create or replace function public.my_oauth_links()
returns table (provider text, created_at timestamptz, last_login_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select l.provider, min(l.created_at), max(l.last_login_at)
  from private.oauth_links l
  where l.user_id = (select auth.uid())
  group by l.provider
  order by min(l.created_at);
$$;

-- Отвязать провайдера. Последний способ входа (нет настоящей почты и телефона) отвязать нельзя.
create or replace function public.oauth_unlink(p_provider text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  has_login boolean;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_provider is null or p_provider not in ('yandex', 'vk') then
    raise exception 'bad provider' using errcode = '22023';
  end if;
  select (u.email is not null and u.email not like '%@oauth.skam.invalid') or u.phone is not null
  into has_login
  from auth.users u where u.id = me;
  if not coalesce(has_login, false)
     and not exists (select 1 from private.oauth_links l where l.user_id = me and l.provider <> p_provider) then
    raise exception 'last sign-in method' using errcode = 'P0001', hint = 'last_method';
  end if;
  delete from private.oauth_links where user_id = me and provider = p_provider;
  perform private.oauth_meta(me);
end;
$$;

-- ---------------------------------------------------------------------------
-- Права
-- ---------------------------------------------------------------------------

revoke all on function private.seen_contact(uuid, uuid) from public, anon, authenticated;
revoke all on function private.seen_allowed(uuid, uuid) from public, anon, authenticated;
revoke all on function private.seen_bucket(timestamptz) from public, anon, authenticated;
revoke all on function private.presence_view(uuid, uuid) from public, anon, authenticated;
revoke all on function private.oauth_meta(uuid) from public, anon, authenticated;

revoke all on function public.user_presence(uuid[]) from public, anon;
revoke all on function public.ping(boolean) from public, anon;
revoke all on function public.my_privacy() from public, anon;
revoke all on function public.set_privacy(text, text) from public, anon;
revoke all on function public.my_contacts(uuid, integer) from public, anon;
revoke all on function public.chat_member_list(uuid, text, boolean, integer, integer) from public, anon;
revoke all on function public.set_personal_channel(uuid) from public, anon;
revoke all on function public.personal_channel(uuid) from public, anon;
revoke all on function public.my_oauth_links() from public, anon;
revoke all on function public.oauth_unlink(text) from public, anon;
revoke all on function public.oauth_attach(text, text, uuid) from public, anon, authenticated;

grant execute on function public.user_presence(uuid[]) to authenticated;
grant execute on function public.ping(boolean) to authenticated, service_role;
grant execute on function public.my_privacy() to authenticated;
grant execute on function public.set_privacy(text, text) to authenticated;
grant execute on function public.my_contacts(uuid, integer) to authenticated, service_role;
grant execute on function public.chat_member_list(uuid, text, boolean, integer, integer) to authenticated, service_role;
grant execute on function public.set_personal_channel(uuid) to authenticated;
grant execute on function public.personal_channel(uuid) to authenticated;
grant execute on function public.my_oauth_links() to authenticated;
grant execute on function public.oauth_unlink(text) to authenticated;
grant execute on function public.oauth_attach(text, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Бот: время захода, личный канал, вход через Яндекс ID и VK ID
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
                  else 'Классный стикер! 🎨 Свои наборы — в панели стикеров, кнопка «+».' end;
  elsif new.kind = 'voice' then
    reply := 'Голосовое получил! Но слушать я пока не умею — я же бот 🙈 Напишите текстом, отвечу.';
  elsif new.kind = 'video_note' then
    reply := 'Кружочек получил — выглядите свободно! 🕊️ Смотреть видео я пока не умею, но друзьям понравится.';
  elsif new.kind = 'poll' then
    reply := E'📊 Опрос получил! Голосовать я не умею — я же бот 🙈\n\nОтправьте его в группу или канал: там за него проголосуют. Открытый опрос покажет, кто за что, анонимный — только числа, а викторина — правильный ответ после голоса.';
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
  elsif t ~ 'skam-messenger\.ru/a/[a-z0-9-]+' then
    reply := E'📰 Статья! Открыл мгновенный просмотр — читается как в Telegraph. Отправьте её друзьям: в чате она будет карточкой с заголовком и обложкой, а по ссылке её прочитают даже без СКАМ.';
  elsif t ~ '^(/start|привет|прив|здравствуй|здрасте|здорово|добр(ый|ое|ого)|хай|хелло|салют|hi|hello|hey)' then
    reply := 'Привет, ' || coalesce(nm, 'друг') || '! 👋 Рад видеть. Напишите «помощь» — расскажу, что умею.';
  elsif t ~ '(помощь|помоги|help|команд|умеешь)' then
    reply := E'Я умею немного, но честно:\n• «привет» — поздороваюсь;\n• «помощь» — это сообщение;\n• «стикеры» — расскажу про Голубя свободы и свои наборы;\n• «эмодзи» — расскажу про свои эмодзи, реакции и супер-реакции;\n• «избранное» — расскажу, как сохранять сообщения;\n• «галочка» — расскажу, что значит официальная галочка;\n• «шифрование» — расскажу, как защищена переписка;\n• «звонки» — расскажу про звонки;\n• «статьи» — расскажу, как написать статью, как в Telegraph;\n• «опросы» — расскажу про опросы и викторины;\n• «время захода» — расскажу, как скрыть, когда вы в сети;\n• «личный канал» — расскажу, как показать свой канал в профиле;\n• «яндекс» или «vk» — расскажу про вход через Яндекс ID и VK ID;\n• «это развод?» — объясню, почему нет.\n\nА ещё подскажу по СКАМ:\n• «Новый чат» — написать человеку по имени или @username, создать группу или канал;\n• стикеры и эмодзи — кнопка со смайликом у поля ввода; наберите эмодзи — подходящие стикеры появятся сами; свои наборы — кнопка «+» в панели;\n• голосовое — удерживайте микрофон справа от поля ввода и отпустите, чтобы отправить; уведите палец влево — отмена, вверх — запись без рук;\n• кружочек — коротко нажмите на микрофон, он станет камерой, дальше так же: удерживайте;\n• скрепка 📎 слева от поля ввода — фото, видео, гифки и файлы до 50 МБ (можно просто перетащить или вставить из буфера), а ещё опрос и статья;\n• реакции — наведите на сообщение или коснитесь его (на телефоне — долгое нажатие), «+» — все реакции и свои эмодзи;\n• ответить — стрелка ↩ над сообщением или правый клик → «Ответить» (на телефоне — смахните сообщение влево);\n• переслать — стрелка ↪ или «Выбрать» несколько сообщений и «Переслать»;\n• сохранить — правый клик → «В избранное»: всё сохранённое лежит в чате «Избранное»;\n• звонки — трубка 📞 и камера 📹 в шапке личного чата или группы: голос, видео и демонстрация экрана, как в Discord;\n• имя, @username, фото, тема, личный канал, время захода и пароль шифрования — в профиле внизу слева.';
  elsif t ~ '(время захода|в сети|онлайн|online|last seen|был[аи]? в сети|конфиденц|приватн|невидимк)' then
    reply := E'👁 Время захода: «Мой профиль» → «Конфиденциальность» → «Время захода». Можно показывать всем, только контактам или никому.\n\nКому не показываете — тот увидит примерно: «был(а) недавно», «на этой неделе», «в этом месяце» или «давно». «В сети» тоже скрыто.\n\nКак в Telegram, это взаимно: если вы скрываете своё время от человека, его время вы тоже не увидите. Скрываем на сервере — точное время не уходит в чужое приложение вообще.\n\nКонтакты — те, с кем вы сами начали личный чат или кому писали, и те, кому вы дали ник.';
  elsif t ~ '(личн(ый|ого|ым) канал|канал в профил|мой канал|свой канал)' then
    reply := E'📣 Личный канал: «Мой профиль» → «Личный канал» — и выберите свой публичный канал (вы владелец, у канала есть @адрес).\n\nКанал появится в вашем профиле, как в Telegram: название, число подписчиков и последний пост. Любой, кто откроет ваш профиль, сможет перейти в канал и подписаться.';
  elsif t ~ '(яндекс|yandex|вконтакт|vk id|\mvk\M|\mвк\M|войти через|вход через|способ(ы)? входа)' then
    reply := E'🔑 Войти в СКАМ можно по почте (код в письме), а ещё через Яндекс ID и VK ID — кнопки на экране входа.\n\nУже есть аккаунт? «Мой профиль» → «Конфиденциальность» → «Способы входа» → «Привязать». Потом входите кнопкой Яндекса или VK прямо в этот аккаунт — пароль шифрования всё равно понадобится на новом устройстве.\n\nИностранных входов (Google, GitHub и т. п.) нет: российским сайтам их использовать нельзя.';
  elsif t ~ '(избранн|сохран|закладк|заметк)' then
    reply := E'🔖 «Избранное» — ваш личный чат с самим собой. Пишите туда заметки, ссылки и списки, кидайте файлы.\n\nЛюбое сообщение из любого чата можно сохранить: правый клик (на телефоне — долгое нажатие) → «В избранное». Сохранённое придёт туда с подписью «Переслано от …», даже если оригинал потом удалят.\n\n🔒 «Избранное» защищено сквозным шифрованием, как личные чаты: его видите только вы — на всех своих устройствах.';
  elsif t ~ '(эмодзи|смайл|emoji|реакц)' then
    reply := E'😀 Свои эмодзи: смайлик у поля ввода → вкладка «Эмодзи» → «+» → «Создать набор». Картинка и название, например :кот: — и эмодзи можно вставлять в сообщения и ставить реакцией.\n\nРеакций на одно сообщение — до трёх. «+» рядом с быстрыми реакциями открывает все, в том числе ваши эмодзи.\n\n⭐ Супер-реакция выделена цветом. Она открывается тем, кто давно и постоянно в группе или канале: открывает его, пишет, ставит реакции.';
  elsif t ~ '(галочк|официальн|верифик|verified)' then
    reply := E'✅ Официальная галочка рядом с именем значит, что это настоящий аккаунт или канал, а не подделка. Её выдаёт только команда СКАМ — купить или поставить самому нельзя.\n\nНапример, галочка есть у канала «Новости СКАМ» и у меня 🙂 Если кто-то пишет от имени известного человека без галочки — будьте осторожны.';
  elsif t ~ '(стикер|голуб|sticker)' then
    reply := E'🕊️ Голубь свободы — маскот СКАМ и наш официальный набор из 16 стикеров: «Привет!», «Да», «Нет», «Ха-ха-ха», «Люблю», «Что?!», «Жду», «Спокойной ночи», «Грусть», «Бесишь!», «Хм…», «Свобода!», «Не развод», «Спасибо», «Доброе утро» и «OK».\n\n🎨 Свои стикеры: в панели стикеров нажмите «+» → «Создать набор», добавьте картинки и к каждой — эмодзи. Ссылкой на набор можно поделиться, а чужой стикер в чате — нажать и добавить весь набор к себе.\n\nНажмите на смайлик у поля ввода или просто наберите 👋, 😂 или 🤔 — подходящий стикер появится сам. Пришлите мне любой — оценю!';
  elsif t ~ '(опрос|голосовани|викторин|poll)' then
    reply := E'📊 Опрос: скрепка 📎 у поля ввода → «Опрос». Вопрос и от 2 до 12 вариантов.\n\nНастройки, как в Telegram:\n• анонимное голосование — видно только числа (в каналах опросы всегда анонимные);\n• несколько ответов — можно отметить больше одного варианта;\n• викторина — один правильный ответ и пояснение, их видно после голоса, а ответ уже не изменить.\n\nОпрос в личном чате или группе зашифрован, как и всё остальное: сервер знает только номера вариантов, за которые голосуют. Автор может завершить опрос — меню сообщения → «Завершить опрос».';
  elsif t ~ '(стат(ья|ьи|ей|ью)|telegraph|телеграф|блог|instant view)' then
    reply := E'📰 Статьи в СКАМ — как Telegraph: заголовок, ваше имя и текст с подзаголовками, цитатами, списками, ссылками и картинками. Никакой вёрстки — пишете, как в блокноте.\n\nГде: скрепка 📎 у поля ввода → «Статья» или «Мой профиль» → «Мои статьи». После публикации у статьи будет ссылка вида skam-messenger.ru/a/… — её можно прикрепить в чат (карточка с заголовком и мгновенным просмотром) или отправить куда угодно: прочитать её можно и без СКАМ.\n\nСвою статью можно изменить или удалить в любой момент.';
  elsif t ~ '(голосов|кружоч|кружк|видеосообщ|микрофон)' then
    reply := E'🎤 Голосовое: удерживайте микрофон справа от поля ввода, говорите и отпустите — сообщение уйдёт. Передумали — уведите палец влево. Долго говорить — потяните вверх, запись закрепится.\n\n⚪ Кружочек: коротко нажмите на микрофон — он станет камерой. Дальше так же: удерживайте, до минуты.\n\nСлушают и смотрят только участники чата.';
  elsif t ~ '(звон|созвон|видеозв|трубк|демонстрац|call)' then
    reply := E'📞 Звонки в СКАМ — как в Discord: в личном чате или группе нажмите трубку (голос) или камеру (видео) в шапке чата. У собеседников зазвонит, а в группе к идущему звонку можно присоединиться в любой момент — до 8 человек.\n\nВ звонке можно выключить микрофон, выключить звук, включить камеру и показать экран (на компьютере). Звонок не мешает переписке: уйдите в другой чат — внизу слева останется панель «Голосовая связь подключена».\n\n🔒 Звук и видео идут напрямую между участниками и зашифрованы; служебные данные соединения шифруются ключом чата, так что сервер не может подслушать.';
  elsif t ~ '(шифр|безопас|e2e|encrypt|ключ)' then
    reply := E'🔒 Личные чаты, группы и «Избранное» в СКАМ защищены сквозным шифрованием: сообщения, фото, видео, файлы, стикеры, голосовые и кружочки шифруются прямо на вашем устройстве и расшифровываются только у собеседников. На сервере лежит лишь шифротекст — прочитать его не можем даже мы.\n\nЗвонки идут напрямую между участниками и тоже зашифрованы.\n\nКлюч хранится на ваших устройствах, а на новом устройстве восстанавливается паролем шифрования.\n\nКаналы и этот чат со мной не шифруются — как каналы и боты в Telegram.';
  elsif t ~ '(развод|скам|мошен|scam|обман|расшифров|аббревиат)' then
    reply := E'СКАМ — это Свободный Конфиденциальный Автономный Мессенджер, а не развод. Честно-честно 🤞\n\n• Свободный — пишите кому хотите, без рекламы и слежки;\n• Конфиденциальный — личные чаты, группы и «Избранное» защищены сквозным шифрованием: их не прочитает никто, кроме участников, — даже сервер;\n• Автономный — свой сервер в России, без чужих облаков.';
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

revoke all on function private.bot_reply() from public, anon, authenticated;
