-- СКАМ 1.6.0: «Заблокировать», «Без звука» и «Общие группы».
--
-- • Блокировка — как в Telegram: в личном чате с заблокированным (в обе стороны) нельзя писать и звонить,
--   он не видит ваши истории (и вы — его). Группы и каналы не затрагиваются.
-- • «Без звука» — свой для каждого: на время или навсегда. Хранится на сервере, чтобы было одинаково на всех устройствах;
--   отдельная таблица, а не chat_members, — строки участников видят другие.
-- • «Общие группы» — группы, где есть и я, и этот человек.

create table if not exists public.user_blocks (
  blocker_id uuid not null references auth.users (id) on delete cascade,
  blocked_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists user_blocks_blocked_idx on public.user_blocks (blocked_id);
alter table public.user_blocks enable row level security;
revoke all on table public.user_blocks from anon, authenticated;

create table if not exists public.chat_mutes (
  user_id uuid not null references auth.users (id) on delete cascade,
  chat_id uuid not null references public.chats (id) on delete cascade,
  -- null — навсегда
  until   timestamptz,
  primary key (user_id, chat_id)
);
alter table public.chat_mutes enable row level security;
revoke all on table public.chat_mutes from anon, authenticated;

-- Есть ли блокировка между двумя людьми (в любую сторону).
create or replace function private.blocked_pair(p_a uuid, p_b uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.user_blocks k
    where (k.blocker_id = p_a and k.blocked_id = p_b) or (k.blocker_id = p_b and k.blocked_id = p_a)
  );
$$;

-- Личный чат, в котором один заблокировал другого.
create or replace function private.direct_blocked(p_chat uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.chats c
    join public.chat_members a on a.chat_id = c.id
    join public.chat_members b on b.chat_id = c.id and b.user_id <> a.user_id
    join public.user_blocks k on k.blocker_id = a.user_id and k.blocked_id = b.user_id
    where c.id = p_chat and c.kind = 'direct'
  );
$$;
revoke execute on function private.blocked_pair(uuid, uuid), private.direct_blocked(uuid) from public, anon;
grant execute on function private.blocked_pair(uuid, uuid), private.direct_blocked(uuid) to authenticated;

-- Писать в чат: как раньше, плюс не в личный чат с блокировкой. Это же правило проверяет загрузку вложений.
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
  ) and not private.direct_blocked(p_chat);
$$;

-- Истории: не видны, если между людьми блокировка.
create or replace function private.story_visible(p_author uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_author = (select auth.uid())
      or (private.has_direct(p_author, (select auth.uid())) and not private.blocked_pair(p_author, (select auth.uid())));
$$;

create or replace function public.story_feed()
returns table (
  author_id uuid, name text, avatar_path text, color text, verified boolean,
  stories jsonb, unseen int, last_at timestamptz
)
language sql stable security definer set search_path = ''
as $$
  with me as (select (select auth.uid()) as id),
  people as (
    select b.user_id as id
    from public.chat_members a
    join public.chats c on c.id = a.chat_id and c.kind = 'direct'
    join public.chat_members b on b.chat_id = c.id and b.user_id <> a.user_id
    where a.user_id = (select id from me)
      and not private.blocked_pair(b.user_id, (select id from me))
    union
    select id from me
  ),
  live as (
    select s from public.stories s
    where s.author_id in (select id from people) and s.expires_at > now()
  ),
  items as (
    select (l.s).author_id as author_id, private.story_json(l.s, (select id from me)) as j, (l.s).created_at as created_at
    from live l
  )
  select r.author_id, p.name, p.avatar_path, p.color, coalesce(p.verified, false),
    jsonb_agg(r.j order by r.created_at),
    (count(*) filter (where not (r.j ->> 'seen')::boolean))::int,
    max(r.created_at)
  from items r
  left join public.profiles p on p.id = r.author_id
  group by r.author_id, p.name, p.avatar_path, p.color, p.verified
  order by (r.author_id = (select id from me)) desc,
    (count(*) filter (where not (r.j ->> 'seen')::boolean) > 0) desc,
    max(r.created_at) desc;
$$;

-- Звонки: в личном чате с блокировкой — нельзя.
create or replace function public.call_start(p_chat uuid, p_video boolean default false, p_device uuid default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_kind text;
  v_call uuid;
begin
  perform private.require_registered();
  select c.kind into v_kind from public.chats c
  where c.id = p_chat and private.is_member_of(c.id, v_me);
  if v_kind is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_kind not in ('direct', 'group') then
    raise exception 'Звонить можно в личных чатах и группах' using errcode = '22023';
  end if;
  if v_kind = 'direct' and private.direct_blocked(p_chat) then
    raise exception 'Позвонить нельзя: один из вас заблокировал другого' using errcode = '42501';
  end if;
  -- Двое звонят друг другу одновременно — окажутся в одном звонке.
  perform pg_advisory_xact_lock(hashtext('skam-call:' || p_chat::text));
  select c.id into v_call from public.calls c where c.chat_id = p_chat and c.ended_at is null;
  if v_call is not null then
    perform private.call_tidy(v_call);
    select c.id into v_call from public.calls c where c.chat_id = p_chat and c.ended_at is null;
  end if;
  if v_call is not null then
    perform public.call_join(v_call, p_device);
    return v_call;
  end if;
  if (select count(*) from public.chat_members m where m.chat_id = p_chat) < 2 then
    raise exception 'В чате пока некому звонить' using errcode = '22023';
  end if;
  if (select count(*) from public.calls c where c.started_by = v_me and c.created_at > now() - interval '1 minute') >= 6 then
    raise exception 'Слишком много звонков подряд — подождите минуту' using errcode = '22023';
  end if;
  perform private.call_leave_others(v_me, null);
  insert into public.calls (chat_id, started_by, video) values (p_chat, v_me, coalesce(p_video, false))
  returning id into v_call;
  insert into public.call_members (call_id, user_id, chat_id, state, device, joined_at, seen_at, camera)
  values (v_call, v_me, p_chat, 'in', p_device, now(), now(), coalesce(p_video, false));
  insert into public.messages (chat_id, user_id, kind, body, call_id)
  values (p_chat, v_me, 'call', '', v_call);
  return v_call;
end;
$$;

create or replace function public.call_join(p_call uuid, p_device uuid default null)
returns table (user_id uuid, joined_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_me uuid := (select auth.uid());
  v_chat uuid;
  v_started uuid;
  v_n int;
begin
  perform private.require_registered();
  select c.chat_id, c.started_by into v_chat, v_started from public.calls c where c.id = p_call for update;
  if v_chat is null or not private.is_member_of(v_chat, v_me) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if private.direct_blocked(v_chat) then
    raise exception 'Позвонить нельзя: один из вас заблокировал другого' using errcode = '42501';
  end if;
  perform private.call_tidy(p_call);
  if (select c.ended_at from public.calls c where c.id = p_call) is not null then
    raise exception 'Звонок уже закончился' using errcode = '22023';
  end if;
  select count(*) into v_n from public.call_members m
  where m.call_id = p_call and m.state = 'in' and m.user_id <> v_me;
  if v_n >= 8 then
    raise exception 'В звонке уже 8 человек — больше пока нельзя' using errcode = '22023';
  end if;
  perform private.call_leave_others(v_me, p_call);
  insert into public.call_members as m (call_id, user_id, chat_id, state, device, joined_at, left_at, seen_at)
  values (p_call, v_me, v_chat, 'in', p_device, now(), null, now())
  on conflict on constraint call_members_pkey do update
    set state = 'in', device = excluded.device, joined_at = now(), left_at = null, seen_at = now(),
        muted = false, deafened = false, camera = false, screen = false;
  if v_started is distinct from v_me then
    update public.calls c set answered_at = now() where c.id = p_call and c.answered_at is null;
  end if;
  -- Старые служебные сообщения прошлого подключения больше не нужны.
  delete from public.call_signals s where s.call_id = p_call and (s.to_user = v_me or s.from_user = v_me);
  return query
    select m.user_id, m.joined_at from public.call_members m
    where m.call_id = p_call and m.state = 'in' and m.user_id <> v_me;
end;
$$;

-- Заблокировать или разблокировать человека.
create or replace function public.block_user(p_user uuid, p_on boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
begin
  perform private.require_registered();
  if p_user is null or p_user = me or not exists (select 1 from auth.users where id = p_user) then
    raise exception 'bad user' using errcode = '22023';
  end if;
  if coalesce(p_on, false) then
    if (select count(*) from public.user_blocks where blocker_id = me) >= 1000 then
      raise exception 'Заблокировать можно не больше 1000 человек.' using errcode = 'P0001';
    end if;
    insert into public.user_blocks (blocker_id, blocked_id) values (me, p_user) on conflict do nothing;
  else
    delete from public.user_blocks where blocker_id = me and blocked_id = p_user;
  end if;
end;
$$;

-- Кого я заблокировал (свежие сверху) — с тем, как человек выглядит.
create or replace function public.my_blocks()
returns table (user_id uuid, name text, username text, avatar_path text, color text, verified boolean, created_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select k.blocked_id, p.name, p.username, p.avatar_path, p.color, coalesce(p.verified, false), k.created_at
  from public.user_blocks k
  left join public.profiles p on p.id = k.blocked_id
  where k.blocker_id = (select auth.uid())
  order by k.created_at desc;
$$;

-- «Без звука»: p_on = false — включить звук; p_until = null — навсегда.
create or replace function public.mute_chat(p_chat uuid, p_on boolean, p_until timestamptz default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
begin
  if not private.is_member_of(p_chat, me) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not coalesce(p_on, false) or (p_until is not null and p_until <= now()) then
    delete from public.chat_mutes where user_id = me and chat_id = p_chat;
    return;
  end if;
  insert into public.chat_mutes (user_id, chat_id, until) values (me, p_chat, p_until)
  on conflict (user_id, chat_id) do update set until = excluded.until;
end;
$$;

-- Мои чаты без звука (только те, где я ещё участник, и с неистёкшим сроком).
create or replace function public.my_mutes()
returns table (chat_id uuid, until timestamptz)
language sql stable security definer set search_path = ''
as $$
  select m.chat_id, m.until
  from public.chat_mutes m
  where m.user_id = (select auth.uid())
    and (m.until is null or m.until > now())
    and exists (select 1 from public.chat_members x where x.chat_id = m.chat_id and x.user_id = m.user_id);
$$;

-- Общие группы с человеком.
create or replace function public.common_groups(p_user uuid)
returns table (id uuid, name text, emoji text, avatar_path text, member_count int)
language sql stable security definer set search_path = ''
as $$
  select c.id, c.name, c.emoji, c.avatar_path,
    (select count(*) from public.chat_members x where x.chat_id = c.id)::int
  from public.chats c
  where c.kind = 'group'
    and p_user is distinct from (select auth.uid())
    and exists (select 1 from public.chat_members a where a.chat_id = c.id and a.user_id = (select auth.uid()))
    and exists (select 1 from public.chat_members b where b.chat_id = c.id and b.user_id = p_user)
  order by c.name
  limit 100;
$$;

revoke execute on function public.block_user(uuid, boolean), public.my_blocks(), public.mute_chat(uuid, boolean, timestamptz),
  public.my_mutes(), public.common_groups(uuid) from public, anon;
grant execute on function public.block_user(uuid, boolean), public.my_blocks(), public.mute_chat(uuid, boolean, timestamptz),
  public.my_mutes(), public.common_groups(uuid) to authenticated;
