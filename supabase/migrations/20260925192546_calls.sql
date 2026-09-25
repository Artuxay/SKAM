-- СКАМ — звонки, как в Discord: голос, видео и демонстрация экрана в личных чатах и группах.
--
-- Звук и видео идут напрямую между участниками (WebRTC, шифрование DTLS-SRTP) — через сервер
-- СКАМ они не проходят. Сервер только помогает участникам найти друг друга:
--   • calls          — звонок в чате (в чате одновременно идёт не больше одного звонка);
--   • call_members   — кто в звонке, кто отклонил, микрофон/звук/камера/экран, пульс seen_at;
--   • call_signals   — служебные сообщения WebRTC (offer/answer/ICE) от участника участнику.
--                      Клиент шифрует их ключом чата, поэтому сервер не может ни прочитать их,
--                      ни подменить отпечатки DTLS (то есть незаметно встать посередине).
--   • messages.kind 'call' — запись о звонке в ленте чата («Входящий звонок · 5 мин»).
-- Звонить можно только в личных чатах и группах (не в канал и не боту). В звонке до 8 человек:
-- соединения идут «каждый с каждым», больше без медиасервера не потянуть.
--
-- Скрипт идемпотентный.

-- ---------------------------------------------------------------------------
-- 1. Таблицы
-- ---------------------------------------------------------------------------

create table if not exists public.calls (
  id          uuid primary key default gen_random_uuid(),
  chat_id     uuid not null references public.chats (id) on delete cascade,
  started_by  uuid references public.profiles (id) on delete set null,
  video       boolean not null default false,
  created_at  timestamptz not null default now(),
  rung_at     timestamptz not null default now(),
  answered_at timestamptz,
  ended_at    timestamptz,
  status      text not null default 'active'
              check (status in ('active', 'ended', 'missed', 'declined', 'cancelled')),
  constraint calls_status_shape check ((status = 'active') = (ended_at is null))
);
comment on table public.calls is 'Звонки. status: active — идёт; ended — был разговор; missed — не ответили; declined — отклонили; cancelled — позвонивший сбросил до ответа.';
create unique index if not exists calls_one_active_idx on public.calls (chat_id) where ended_at is null;
create index if not exists calls_chat_idx on public.calls (chat_id, created_at desc);
create index if not exists calls_started_by_idx on public.calls (started_by);

create table if not exists public.call_members (
  call_id   uuid not null references public.calls (id) on delete cascade,
  user_id   uuid not null references public.profiles (id) on delete cascade,
  chat_id   uuid not null references public.chats (id) on delete cascade,
  state     text not null check (state in ('in', 'left', 'declined')),
  device    uuid,
  joined_at timestamptz,
  left_at   timestamptz,
  seen_at   timestamptz not null default now(),
  muted     boolean not null default false,
  deafened  boolean not null default false,
  camera    boolean not null default false,
  screen    boolean not null default false,
  primary key (call_id, user_id)
);
comment on column public.call_members.device is 'Вкладка, с которой человек в звонке: зашёл с другого устройства — старое отключается.';
comment on column public.call_members.seen_at is 'Пульс: клиент в звонке обновляет его раз в 12 секунд. Нет пульса 40 секунд — участник выбыл.';
create index if not exists call_members_user_idx on public.call_members (user_id);
create index if not exists call_members_chat_idx on public.call_members (chat_id);

create table if not exists public.call_signals (
  id         bigint generated always as identity primary key,
  call_id    uuid not null references public.calls (id) on delete cascade,
  from_user  uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  to_user    uuid not null references public.profiles (id) on delete cascade,
  payload    text not null check (char_length(payload) between 2 and 32768),
  created_at timestamptz not null default now()
);
comment on table public.call_signals is 'Служебные сообщения WebRTC между участниками звонка (зашифрованы ключом чата). Получатель удаляет их, прочитав; остальное удаляется, когда звонок заканчивается.';
create index if not exists call_signals_to_idx on public.call_signals (to_user, id);
create index if not exists call_signals_call_idx on public.call_signals (call_id);
create index if not exists call_signals_from_idx on public.call_signals (from_user);

-- Запись о звонке в ленте.
alter table public.messages add column if not exists call_id uuid references public.calls (id) on delete set null;
create index if not exists messages_call_idx on public.messages (call_id) where call_id is not null;
comment on column public.messages.call_id is 'Звонок, о котором эта запись (kind = call).';

alter table public.messages drop constraint if exists messages_kind_check;
alter table public.messages add constraint messages_kind_check
  check (kind in ('text', 'system', 'sticker', 'voice', 'video_note', 'e2e', 'media', 'call'));

alter table public.messages drop constraint if exists messages_body_shape;
alter table public.messages add constraint messages_body_shape check (
  (deleted_at is not null and body = '')
  or (deleted_at is null and kind in ('text', 'system') and char_length(btrim(body)) between 1 and 4000)
  or (deleted_at is null and kind in ('sticker', 'voice', 'video_note') and char_length(body) <= 16)
  or (deleted_at is null and kind in ('e2e', 'call') and body = '')
  or (deleted_at is null and kind = 'media' and char_length(body) <= 4000)
);

alter table public.messages drop constraint if exists messages_media_shape;
alter table public.messages add constraint messages_media_shape check (
  deleted_at is not null
  or (kind in ('text', 'system', 'e2e', 'media', 'call')
      and sticker is null and media_path is null and media_mime is null and duration_ms is null and waveform is null)
  or (kind = 'sticker'
      and sticker ~ '^[a-z0-9_]{1,32}/[a-z0-9_]{1,32}$'
      and media_path is null and media_mime is null and duration_ms is null and waveform is null)
  or (kind in ('voice', 'video_note')
      and sticker is null
      and media_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(webm|ogg|m4a|mp4)$'
      and duration_ms between 300 and (case when kind = 'video_note' then 61000 else 600000 end)
      and (waveform is null or cardinality(waveform) <= 100)
      and ((kind = 'voice' and media_mime in ('audio/webm', 'audio/ogg', 'audio/mp4'))
        or (kind = 'video_note' and media_mime in ('video/webm', 'video/mp4'))))
);

alter table public.messages drop constraint if exists messages_call_shape;
alter table public.messages add constraint messages_call_shape check (
  (kind = 'call' and (call_id is not null or deleted_at is not null))
  or (kind <> 'call' and call_id is null)
);

-- ---------------------------------------------------------------------------
-- 2. Служебные функции
-- ---------------------------------------------------------------------------

-- Завершить звонок: всех участников — вон, служебные сообщения — удалить.
create or replace function private.call_finish(p_call uuid, p_status text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.calls set ended_at = now(), status = p_status where id = p_call and ended_at is null;
  update public.call_members set state = 'left', left_at = coalesce(left_at, now())
  where call_id = p_call and state = 'in';
  delete from public.call_signals where call_id = p_call;
end;
$$;

-- Навести порядок: выбывших (нет пульса 40 секунд) — вон; никого не осталось — звонок окончен;
-- в личном чате никто не ответил за 50 секунд — «пропущенный».
create or replace function private.call_tidy(p_call uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  c record;
  v_in int;
begin
  select id, chat_id, answered_at, rung_at, ended_at into c from public.calls where id = p_call;
  if c.id is null or c.ended_at is not null then return; end if;
  update public.call_members set state = 'left', left_at = now()
  where call_id = p_call and state = 'in' and seen_at < now() - interval '40 seconds';
  select count(*) into v_in from public.call_members where call_id = p_call and state = 'in';
  if v_in = 0 then
    perform private.call_finish(p_call, case when c.answered_at is not null then 'ended' else 'cancelled' end);
  elsif c.answered_at is null and c.rung_at < now() - interval '50 seconds'
        and exists (select 1 from public.chats where id = c.chat_id and kind = 'direct') then
    perform private.call_finish(p_call, 'missed');
  end if;
end;
$$;

-- Выйти из всех звонков, кроме указанного (в звонке можно быть только в одном).
create or replace function private.call_leave_others(p_user uuid, p_keep uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare r record;
begin
  for r in
    update public.call_members set state = 'left', left_at = now()
    where user_id = p_user and state = 'in' and call_id is distinct from p_keep
    returning call_id
  loop
    delete from public.call_signals where call_id = r.call_id and (to_user = p_user or from_user = p_user);
    perform private.call_tidy(r.call_id);
  end loop;
end;
$$;

-- Отправитель и получатель служебного сообщения оба сейчас в этом звонке.
create or replace function private.call_peer_ok(p_call uuid, p_to uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_to is distinct from (select auth.uid())
    and exists (select 1 from public.call_members
                where call_id = p_call and user_id = (select auth.uid()) and state = 'in')
    and exists (select 1 from public.call_members
                where call_id = p_call and user_id = p_to and state = 'in');
$$;

-- Вышел из чата — вышел и из его звонка.
create or replace function private.call_member_left()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare r record;
begin
  for r in
    update public.call_members set state = 'left', left_at = now()
    where chat_id = old.chat_id and user_id = old.user_id and state = 'in'
    returning call_id
  loop
    delete from public.call_signals where call_id = r.call_id and (to_user = old.user_id or from_user = old.user_id);
    perform private.call_tidy(r.call_id);
  end loop;
  return null;
end;
$$;
drop trigger if exists chat_members_call_left on public.chat_members;
create trigger chat_members_call_left after delete on public.chat_members
  for each row execute function private.call_member_left();

-- ---------------------------------------------------------------------------
-- 3. Функции для клиента
-- ---------------------------------------------------------------------------

-- Войти в звонок. Возвращает, кто в нём уже есть: им новичок отправит предложение соединиться.
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

-- Позвонить: начать звонок в чате или присоединиться, если он уже идёт.
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

-- Выйти из звонка (с этого устройства).
create or replace function public.call_leave(p_call uuid, p_device uuid default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_me uuid := (select auth.uid());
begin
  update public.call_members m set state = 'left', left_at = now()
  where m.call_id = p_call and m.user_id = v_me and m.state = 'in'
    and (p_device is null or m.device is not distinct from p_device);
  if found then
    delete from public.call_signals s where s.call_id = p_call and (s.to_user = v_me or s.from_user = v_me);
  end if;
  perform private.call_tidy(p_call);
end;
$$;

-- Отклонить входящий. В личном чате это сразу завершает звонок («Звонок отклонён»).
create or replace function public.call_decline(p_call uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  c record;
begin
  select k.id, k.chat_id, k.answered_at, k.ended_at, ch.kind into c
  from public.calls k join public.chats ch on ch.id = k.chat_id
  where k.id = p_call;
  if c.id is null or not private.is_member_of(c.chat_id, v_me) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if c.ended_at is not null then return; end if;
  insert into public.call_members as m (call_id, user_id, chat_id, state)
  values (p_call, v_me, c.chat_id, 'declined')
  on conflict (call_id, user_id) do update set state = 'declined' where m.state <> 'in';
  if c.kind = 'direct' and c.answered_at is null then
    perform private.call_finish(p_call, 'declined');
  end if;
end;
$$;

-- Пульс раз в 12 секунд и состояние: микрофон, звук, камера, экран.
-- Ответ: ok; ended — звонок закончился; replaced — вы вошли в звонок с другого устройства; gone — вас в нём нет.
create or replace function public.call_ping(
  p_call uuid, p_device uuid default null,
  p_muted boolean default false, p_deafened boolean default false,
  p_camera boolean default false, p_screen boolean default false
)
returns text
language plpgsql security definer set search_path = ''
as $$
declare v_me uuid := (select auth.uid());
begin
  update public.call_members m
  set seen_at = now(), muted = coalesce(p_muted, false), deafened = coalesce(p_deafened, false),
      camera = coalesce(p_camera, false), screen = coalesce(p_screen, false)
  where m.call_id = p_call and m.user_id = v_me and m.state = 'in' and m.device is not distinct from p_device;
  if not found then
    if (select k.ended_at from public.calls k where k.id = p_call) is not null then return 'ended'; end if;
    if exists (select 1 from public.call_members m where m.call_id = p_call and m.user_id = v_me and m.state = 'in') then
      return 'replaced';
    end if;
    return 'gone';
  end if;
  perform private.call_tidy(p_call);
  if (select k.ended_at from public.calls k where k.id = p_call) is not null then return 'ended'; end if;
  return 'ok';
end;
$$;

-- Позвонить ещё раз тем, кто не ответил (в группе) — снова зазвонит у всех, кого нет в звонке.
create or replace function public.call_ring(p_call uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_me uuid := (select auth.uid());
begin
  if not exists (select 1 from public.call_members m where m.call_id = p_call and m.user_id = v_me and m.state = 'in') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.calls k set rung_at = now() where k.id = p_call and k.ended_at is null;
  update public.call_members m set state = 'left' where m.call_id = p_call and m.state = 'declined';
end;
$$;

-- Идущие звонки в моих чатах (заодно убирает выбывших). ringing — звонит ли он мне сейчас.
create or replace function public.my_calls()
returns table (
  id uuid, chat_id uuid, started_by uuid, video boolean, created_at timestamptz, rung_at timestamptz,
  answered_at timestamptz, ringing boolean, server_now timestamptz, members jsonb
)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_me uuid := (select auth.uid());
  r record;
begin
  for r in
    select k.id from public.calls k
    join public.chat_members cm on cm.chat_id = k.chat_id and cm.user_id = v_me
    where k.ended_at is null
  loop
    perform private.call_tidy(r.id);
  end loop;
  return query
    select k.id, k.chat_id, k.started_by, k.video, k.created_at, k.rung_at, k.answered_at,
           (k.rung_at > now() - interval '45 seconds'
             and not exists (select 1 from public.call_members x
                             where x.call_id = k.id and x.user_id = v_me and x.state in ('in', 'declined'))),
           now(),
           coalesce((select jsonb_agg(jsonb_build_object(
                       'user_id', m.user_id, 'state', m.state, 'device', m.device, 'joined_at', m.joined_at,
                       'muted', m.muted, 'deafened', m.deafened, 'camera', m.camera, 'screen', m.screen)
                       order by m.joined_at)
                     from public.call_members m where m.call_id = k.id), '[]'::jsonb)
    from public.calls k
    join public.chat_members cm on cm.chat_id = k.chat_id and cm.user_id = v_me
    where k.ended_at is null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Доступ
-- ---------------------------------------------------------------------------

alter table public.calls        enable row level security;
alter table public.call_members enable row level security;
alter table public.call_signals enable row level security;

drop policy if exists "calls: members read" on public.calls;
create policy "calls: members read" on public.calls
  for select to authenticated using (private.is_chat_member(chat_id));

drop policy if exists "call members: members read" on public.call_members;
create policy "call members: members read" on public.call_members
  for select to authenticated using (private.is_chat_member(chat_id));

drop policy if exists "call signals: read mine" on public.call_signals;
create policy "call signals: read mine" on public.call_signals
  for select to authenticated using (to_user = (select auth.uid()));

drop policy if exists "call signals: delete mine" on public.call_signals;
create policy "call signals: delete mine" on public.call_signals
  for delete to authenticated using (to_user = (select auth.uid()));

drop policy if exists "call signals: send to peer" on public.call_signals;
create policy "call signals: send to peer" on public.call_signals
  for insert to authenticated
  with check (from_user = (select auth.uid()) and private.call_peer_ok(call_id, to_user));

revoke all on public.calls, public.call_members, public.call_signals from anon, authenticated;
grant select on public.calls, public.call_members to authenticated;
grant select, delete on public.call_signals to authenticated;
grant insert (call_id, to_user, payload) on public.call_signals to authenticated;

revoke all on function
  private.call_finish(uuid, text), private.call_tidy(uuid), private.call_leave_others(uuid, uuid),
  private.call_member_left()
from public, anon, authenticated;
revoke all on function private.call_peer_ok(uuid, uuid) from public, anon;
grant execute on function private.call_peer_ok(uuid, uuid) to authenticated;

revoke execute on function
  public.call_join(uuid, uuid), public.call_start(uuid, boolean, uuid), public.call_leave(uuid, uuid),
  public.call_decline(uuid), public.call_ping(uuid, uuid, boolean, boolean, boolean, boolean),
  public.call_ring(uuid), public.my_calls()
from public, anon;
grant execute on function
  public.call_join(uuid, uuid), public.call_start(uuid, boolean, uuid), public.call_leave(uuid, uuid),
  public.call_decline(uuid), public.call_ping(uuid, uuid, boolean, boolean, boolean, boolean),
  public.call_ring(uuid), public.my_calls()
to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Список чатов: для записи о звонке отдаём его итог («Пропущенный звонок»)
-- ---------------------------------------------------------------------------

drop function if exists public.my_chats();
create function public.my_chats()
returns table (
  id uuid, kind text, name text, emoji text, invite_code text, is_default boolean,
  created_at timestamptz, role text, last_read_at timestamptz,
  member_count int, peer_id uuid, unread int,
  last_id uuid, last_body text, last_user_id uuid, last_kind text,
  last_at timestamptz, last_deleted boolean,
  last_enc text, last_key_id uuid, last_files jsonb, last_call jsonb
)
language sql stable security definer set search_path = ''
as $$
  select c.id, c.kind, c.name, c.emoji, c.invite_code, c.is_default,
         c.created_at, cm.role, cm.last_read_at,
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
            from public.calls k where k.id = lm.call_id)
  from public.chat_members cm
  join public.chats c on c.id = cm.chat_id
  left join lateral (
    select m.id, m.body, m.user_id, m.kind, m.created_at, m.deleted_at, m.enc, m.key_id, m.files, m.call_id
    from public.messages m where m.chat_id = c.id
    order by m.created_at desc, m.id desc limit 1
  ) lm on true
  where cm.user_id = (select auth.uid())
  order by coalesce(lm.created_at, c.created_at) desc;
$$;
revoke execute on function public.my_chats() from public, anon;
grant execute on function public.my_chats() to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Realtime: звонки, участники и служебные сообщения (каждому — только свои, по RLS)
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['calls', 'call_members', 'call_signals'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Бот рассказывает про звонки, ответы и пересылку
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
    reply := 'Голубь Свободы одобряет 🕊️';
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
    reply := E'Я умею немного, но честно:\n• «привет» — поздороваюсь;\n• «помощь» — это сообщение;\n• «стикеры» — расскажу про Голубя свободы;\n• «шифрование» — расскажу, как защищена переписка;\n• «звонки» — расскажу про звонки;\n• «это развод?» — объясню, почему нет.\n\nА ещё подскажу по СКАМ:\n• «Новый чат» — написать человеку по имени или @username или создать группу;\n• стикеры — кнопка со смайликом у поля ввода; наберите эмодзи — подходящие стикеры появятся сами;\n• голосовое — удерживайте микрофон справа от поля ввода и отпустите, чтобы отправить; уведите палец влево — отмена, вверх — запись без рук;\n• кружочек — коротко нажмите на микрофон, он станет камерой, дальше так же: удерживайте;\n• скрепка 📎 слева от поля ввода — фото, видео и файлы до 50 МБ (можно просто перетащить или вставить из буфера);\n• реакции — наведите на сообщение или коснитесь его (на телефоне — долгое нажатие);\n• ответить — стрелка ↩ над сообщением или правый клик → «Ответить» (на телефоне — смахните сообщение влево);\n• переслать — стрелка ↪ или «Выбрать» несколько сообщений и «Переслать»;\n• звонки — трубка 📞 и камера 📹 в шапке личного чата или группы: голос, видео и демонстрация экрана, как в Discord;\n• имя, @username, фото, тема и пароль шифрования — в профиле внизу слева.';
  elsif t ~ '(стикер|голуб|sticker)' then
    reply := E'🕊️ Голубь свободы — маскот СКАМ и наш официальный набор из 16 стикеров: «Привет!», «Да», «Нет», «Ха-ха-ха», «Люблю», «Что?!», «Жду», «Спокойной ночи», «Грусть», «Бесишь!», «Хм…», «Свобода!», «Не развод», «Спасибо», «Доброе утро» и «OK».\n\nНажмите на смайлик у поля ввода или просто наберите 👋, 😂 или 🤔 — подходящий голубь появится сам. Пришлите мне любой — оценю!';
  elsif t ~ '(голосов|кружоч|кружк|видеосообщ|микрофон)' then
    reply := E'🎤 Голосовое: удерживайте микрофон справа от поля ввода, говорите и отпустите — сообщение уйдёт. Передумали — уведите палец влево. Долго говорить — потяните вверх, запись закрепится.\n\n⚪ Кружочек: коротко нажмите на микрофон — он станет камерой. Дальше так же: удерживайте, до минуты.\n\nСлушают и смотрят только участники чата.';
  elsif t ~ '(звон|созвон|видеозв|трубк|демонстрац|call)' then
    reply := E'📞 Звонки в СКАМ — как в Discord: в личном чате или группе нажмите трубку (голос) или камеру (видео) в шапке чата. У собеседников зазвонит, а в группе к идущему звонку можно присоединиться в любой момент — до 8 человек.\n\nВ звонке можно выключить микрофон, выключить звук, включить камеру и показать экран (на компьютере). Звонок не мешает переписке: уйдите в другой чат — внизу слева останется панель «Голосовая связь подключена».\n\n🔒 Звук и видео идут напрямую между участниками и зашифрованы; служебные данные соединения шифруются ключом чата, так что сервер не может подслушать.';
  elsif t ~ '(шифр|безопас|e2e|encrypt|ключ)' then
    reply := E'🔒 Личные чаты и группы в СКАМ защищены сквозным шифрованием: сообщения, фото, видео, файлы, стикеры, голосовые и кружочки шифруются прямо на вашем устройстве и расшифровываются только у собеседников. На сервере лежит лишь шифротекст — прочитать его не можем даже мы.\n\nЗвонки идут напрямую между участниками и тоже зашифрованы.\n\nКлюч хранится на ваших устройствах, а на новом устройстве восстанавливается паролем шифрования.\n\nКанал новостей и этот чат со мной не шифруются — как каналы и боты в Telegram.';
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
revoke all on function private.bot_reply() from public, anon, authenticated;

drop trigger if exists messages_bot_reply on public.messages;
create trigger messages_bot_reply after insert on public.messages
  for each row when (new.kind in ('text', 'sticker', 'voice', 'video_note', 'media') and new.user_id is not null)
  execute function private.bot_reply();

notify pgrst, 'reload schema';
