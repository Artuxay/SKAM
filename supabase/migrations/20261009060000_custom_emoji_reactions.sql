-- СКАМ 0.3.5: свои эмодзи, реакции ими, не больше 3 реакций на сообщение и супер-реакции.
--
-- • Свои эмодзи — наборы, как у стикеров (те же таблицы, kind = 'emoji'). У каждого эмодзи — название
--   (:кот:), по нему эмодзи вставляется в текст. Картинки — в том же публичном бакете stickers: <набор>/<эмодзи>.
--   В тексте сообщения эмодзи хранится меткой <:название:набор/эмодзи> (внутри шифротекста — в личных чатах и группах).
-- • Реакции: обычные пять + любое своё эмодзи ('c:<набор>/<эмодзи>'). От одного человека на одно сообщение —
--   не больше трёх реакций (старые сверх лимита не трогаем — просто новые не добавить).
-- • Супер-реакция — для тех, кто давно и постоянно в группе или канале: читает, пишет, ставит реакции.
--   Очки за последние 30 дней: день, когда открывал чат, — 1, ставил реакции — ещё 1, писал — ещё 2.
--   Нужно 15 очков и не меньше 7 дней в чате. Три супер-реакции в день в каждом таком чате.
--   Супер-реакция — та же строка в reactions с super = true; выделяется цветом у всех.

-- ---------------------------------------------------------------------------
-- 1. Наборы эмодзи
-- ---------------------------------------------------------------------------

alter table public.sticker_packs add column if not exists kind text not null default 'sticker';
alter table public.stickers add column if not exists name text;
alter table public.stickers alter column emoji drop not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.sticker_packs'::regclass and conname = 'sticker_packs_kind_check') then
    alter table public.sticker_packs add constraint sticker_packs_kind_check check (kind in ('sticker', 'emoji'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.stickers'::regclass and conname = 'stickers_name_check') then
    alter table public.stickers add constraint stickers_name_check check (name is null or name ~ '^[a-z0-9_а-яё]{2,32}$');
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.stickers'::regclass and conname = 'stickers_label_check') then
    alter table public.stickers add constraint stickers_label_check check (emoji is not null or name is not null);
  end if;
end $$;

create unique index if not exists stickers_pack_name_idx on public.stickers (pack_id, name) where name is not null;
comment on column public.sticker_packs.kind is 'sticker — набор стикеров, emoji — набор своих эмодзи.';
comment on column public.stickers.name is 'Название своего эмодзи (:кот:) — только в наборах эмодзи.';

-- Набор целиком: у стикеров — эмодзи, у своих эмодзи — название.
create or replace function private.sticker_pack_json(p_pack text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id,
    'title', p.title,
    'kind', p.kind,
    'mine', p.owner_id = (select auth.uid()),
    'added', exists (select 1 from public.user_sticker_packs u where u.pack_id = p.id and u.user_id = (select auth.uid())),
    'stickers', coalesce((
      select jsonb_agg(
               case when p.kind = 'emoji' then jsonb_build_object('id', s.id, 'name', s.name)
                    else jsonb_build_object('id', s.id, 'emoji', s.emoji) end
               order by s.position, s.created_at, s.id)
      from public.stickers s where s.pack_id = p.id
    ), '[]'::jsonb)
  )
  from public.sticker_packs p
  where p.id = p_pack;
$$;

-- Мои наборы стикеров — без наборов эмодзи (старые версии приложения не знают про эмодзи).
create or replace function public.my_sticker_packs()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(private.sticker_pack_json(u.pack_id) order by u.added_at, u.pack_id), '[]'::jsonb)
  from public.user_sticker_packs u
  join public.sticker_packs p on p.id = u.pack_id and p.kind = 'sticker'
  where u.user_id = (select auth.uid());
$$;

create or replace function public.my_emoji_packs()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(private.sticker_pack_json(u.pack_id) order by u.added_at, u.pack_id), '[]'::jsonb)
  from public.user_sticker_packs u
  join public.sticker_packs p on p.id = u.pack_id and p.kind = 'emoji'
  where u.user_id = (select auth.uid());
$$;

create or replace function public.create_emoji_pack(p_title text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_title text := btrim(regexp_replace(coalesce(p_title, ''), '\s+', ' ', 'g'));
  v_id text;
begin
  perform private.require_registered();
  if char_length(v_title) not between 1 and 64 then
    raise exception 'Название набора — от 1 до 64 символов' using errcode = '22023';
  end if;
  if (select count(*) from public.sticker_packs where owner_id = v_me) >= 50 then
    raise exception 'Можно создать не больше 50 наборов стикеров и эмодзи' using errcode = '54000';
  end if;
  if (select count(*) from public.sticker_packs where owner_id = v_me and created_at > now() - interval '1 day') >= 10 then
    raise exception 'За сутки можно создать не больше 10 наборов — попробуйте завтра' using errcode = '54000';
  end if;
  loop
    v_id := 'u' || substr(md5(gen_random_uuid()::text), 1, 11);
    exit when not exists (select 1 from public.sticker_packs where id = v_id);
  end loop;
  insert into public.sticker_packs (id, owner_id, title, kind) values (v_id, v_me, v_title, 'emoji');
  insert into public.user_sticker_packs (user_id, pack_id) values (v_me, v_id);
  return v_id;
end;
$$;

-- Название эмодзи: без двоеточий и пробелов по краям, в нижнем регистре.
create or replace function private.emoji_name(p_name text)
returns text
language sql immutable set search_path = ''
as $$
  select lower(btrim(coalesce(p_name, ''), E' \t:'));
$$;

create or replace function private.check_emoji_name(p_pack text, p_id text, p_name text)
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if p_name !~ '^[a-z0-9_а-яё]{2,32}$' then
    raise exception 'Название эмодзи — от 2 до 32 символов: буквы, цифры и _' using errcode = '22023';
  end if;
  if exists (select 1 from public.stickers where pack_id = p_pack and name = p_name and id <> coalesce(p_id, '')) then
    raise exception 'В наборе уже есть эмодзи :%:', p_name using errcode = '23505';
  end if;
end;
$$;

create or replace function private.owns_pack_of_kind(p_pack text, p_kind text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.sticker_packs where id = p_pack and owner_id = (select auth.uid()) and kind = p_kind);
$$;

-- Эмодзи добавляется после загрузки картинки: stickers/<набор>/<эмодзи>.
create or replace function public.add_custom_emoji(p_pack text, p_id text, p_name text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_name text := private.emoji_name(p_name);
begin
  if not private.owns_pack_of_kind(p_pack, 'emoji') then
    raise exception 'Это не ваш набор эмодзи' using errcode = '42501';
  end if;
  if coalesce(p_id, '') !~ '^[a-z0-9]{10}$' then
    raise exception 'Неверное эмодзи' using errcode = '22023';
  end if;
  perform private.check_emoji_name(p_pack, p_id, v_name);
  if (select count(*) from public.stickers where pack_id = p_pack) >= 120 then
    raise exception 'В наборе может быть не больше 120 эмодзи' using errcode = '54000';
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'stickers' and name = p_pack || '/' || p_id) then
    raise exception 'Картинка эмодзи не загрузилась — попробуйте ещё раз' using errcode = 'P0001';
  end if;
  insert into public.stickers (pack_id, id, emoji, name, position)
  values (p_pack, p_id, null, v_name,
          coalesce((select max(position) + 1 from public.stickers where pack_id = p_pack), 0))
  on conflict (pack_id, id) do update set name = excluded.name;
  update public.sticker_packs set updated_at = now() where id = p_pack;
end;
$$;

create or replace function public.rename_custom_emoji(p_pack text, p_id text, p_name text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_name text := private.emoji_name(p_name);
begin
  if not private.owns_pack_of_kind(p_pack, 'emoji') then
    raise exception 'Это не ваш набор эмодзи' using errcode = '42501';
  end if;
  perform private.check_emoji_name(p_pack, p_id, v_name);
  update public.stickers set name = v_name where pack_id = p_pack and id = p_id;
  if not found then
    raise exception 'Эмодзи не найдено' using errcode = 'P0002';
  end if;
  update public.sticker_packs set updated_at = now() where id = p_pack;
end;
$$;

-- В набор стикеров — только стикеры (в набор эмодзи их добавляет add_custom_emoji).
create or replace function public.add_sticker(p_pack text, p_id text, p_emoji text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_emoji text := btrim(coalesce(p_emoji, ''));
begin
  if not private.owns_pack_of_kind(p_pack, 'sticker') then
    raise exception 'Это не ваш набор стикеров' using errcode = '42501';
  end if;
  if coalesce(p_id, '') !~ '^[a-z0-9]{10}$' then
    raise exception 'Неверный стикер' using errcode = '22023';
  end if;
  if char_length(v_emoji) not between 1 and 16 or v_emoji ~ '[A-Za-zА-Яа-яЁё<>[:space:]]' then
    raise exception 'Выберите эмодзи для стикера' using errcode = '22023';
  end if;
  if (select count(*) from public.stickers where pack_id = p_pack) >= 120 then
    raise exception 'В наборе может быть не больше 120 стикеров' using errcode = '54000';
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'stickers' and name = p_pack || '/' || p_id) then
    raise exception 'Картинка стикера не загрузилась — попробуйте ещё раз' using errcode = 'P0001';
  end if;
  insert into public.stickers (pack_id, id, emoji, position)
  values (p_pack, p_id, v_emoji,
          coalesce((select max(position) + 1 from public.stickers where pack_id = p_pack), 0))
  on conflict (pack_id, id) do update set emoji = excluded.emoji;
  update public.sticker_packs set updated_at = now() where id = p_pack;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Реакции: свои эмодзи, лимит 3, супер-реакции
-- ---------------------------------------------------------------------------

alter table public.reactions add column if not exists super boolean not null default false;
alter table public.reactions drop constraint if exists reactions_emoji_check;
alter table public.reactions add constraint reactions_emoji_check
  check (emoji in ('like', 'lol', 'fire', 'wow', 'clown') or emoji ~ '^c:u[0-9a-f]{11}/[a-z0-9]{10}$');
create index if not exists reactions_custom_idx on public.reactions (emoji) where emoji like 'c:%';
create index if not exists reactions_super_idx on public.reactions (user_id, chat_id, created_at) where super;
comment on column public.reactions.super is 'Супер-реакция (выделяется цветом). Ставится только через set_reaction.';

-- Проверка перед вставкой (после reactions_fill — триггеры идут по алфавиту):
-- своё эмодзи должно существовать и быть из набора эмодзи; от человека на сообщение — не больше 3 реакций.
create or replace function private.reactions_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_ref text;
  n int;
begin
  if new.emoji like 'c:%' then
    v_ref := substr(new.emoji, 3);
    if not exists (
      select 1 from public.stickers s join public.sticker_packs p on p.id = s.pack_id
      where p.kind = 'emoji' and s.pack_id = split_part(v_ref, '/', 1) and s.id = split_part(v_ref, '/', 2)
    ) then
      raise exception 'Этого эмодзи больше нет — его удалил автор набора' using errcode = 'P0002';
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('reactions:' || new.message_id::text || ':' || new.user_id::text, 0));
  select count(*) into n from public.reactions where message_id = new.message_id and user_id = new.user_id;
  if n >= 3 then
    raise exception 'На одно сообщение — не больше 3 реакций. Уберите одну из своих' using errcode = '54000';
  end if;
  return new;
end;
$$;

create or replace trigger reactions_guard before insert on public.reactions
  for each row execute function private.reactions_guard();

-- Удалили своё эмодзи (или весь набор) — его реакции пропадают.
create or replace function private.stickers_gone()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.reactions where emoji = 'c:' || old.pack_id || '/' || old.id;
  return null;
end;
$$;

create or replace trigger stickers_gone after delete on public.stickers
  for each row execute function private.stickers_gone();

-- ---------------------------------------------------------------------------
-- 3. Активность в группах и каналах
-- ---------------------------------------------------------------------------

create table if not exists private.chat_activity (
  user_id uuid not null references public.profiles (id) on delete cascade,
  chat_id uuid not null references public.chats (id) on delete cascade,
  day     date not null,
  seen    boolean not null default false,
  wrote   boolean not null default false,
  reacted boolean not null default false,
  primary key (user_id, chat_id, day)
);
create index if not exists chat_activity_chat_idx on private.chat_activity (chat_id);
alter table private.chat_activity enable row level security;
revoke all on table private.chat_activity from public, anon, authenticated;
comment on table private.chat_activity is 'Дни активности в группах и каналах (по Москве): для супер-реакций. Хранится ~45 дней.';

create or replace function private.msk_today()
returns date
language sql stable set search_path = ''
as $$
  select (now() at time zone 'Europe/Moscow')::date;
$$;

create or replace function private.note_activity(p_user uuid, p_chat uuid, p_wrote boolean, p_reacted boolean)
returns void
language sql security definer set search_path = ''
as $$
  insert into private.chat_activity (user_id, chat_id, day, seen, wrote, reacted)
  select p_user, p_chat, private.msk_today(), true, coalesce(p_wrote, false), coalesce(p_reacted, false)
  where p_user is not null
    and exists (select 1 from public.chats c where c.id = p_chat and c.kind in ('group', 'channel'))
  on conflict (user_id, chat_id, day) do update
    set seen = true,
        wrote = private.chat_activity.wrote or excluded.wrote,
        reacted = private.chat_activity.reacted or excluded.reacted
    where not (private.chat_activity.seen
               and (private.chat_activity.wrote or not excluded.wrote)
               and (private.chat_activity.reacted or not excluded.reacted));
$$;

create or replace function private.messages_activity()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.user_id is not null and new.kind not in ('system', 'call') then
    perform private.note_activity(new.user_id, new.chat_id, true, false);
  end if;
  return null;
end;
$$;

create or replace trigger messages_activity after insert on public.messages
  for each row execute function private.messages_activity();

create or replace function private.reactions_activity()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.note_activity(new.user_id, new.chat_id, false, true);
  return null;
end;
$$;

create or replace trigger reactions_activity after insert on public.reactions
  for each row execute function private.reactions_activity();

-- Открыл чат — день засчитан. Приложение зовёт это раз в день на чат (и mark_read — при прочтении).
create or replace function public.chat_visit(p_chat uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
begin
  if v_me is null or not private.is_chat_member(p_chat) then
    return;
  end if;
  perform private.note_activity(v_me, p_chat, false, false);
  delete from private.chat_activity where user_id = v_me and day < private.msk_today() - 45;
end;
$$;

create or replace function public.mark_read(p_chat uuid, p_at timestamptz default now())
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.chat_members
  set last_read_at = greatest(last_read_at, least(coalesce(p_at, now()), now()))
  where chat_id = p_chat and user_id = (select auth.uid());
  if found then
    perform private.note_activity((select auth.uid()), p_chat, false, false);
  end if;
end;
$$;

-- Можно ли мне супер-реакцию в этом чате и сколько осталось на сегодня.
create or replace function private.super_status(p_user uuid, p_chat uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  c_need  constant int := 15;  -- очков за 30 дней
  c_days  constant int := 7;   -- дней в чате
  c_daily constant int := 3;   -- супер-реакций в день в одном чате
  v_kind text;
  v_joined timestamptz;
  v_score int := 0;
  v_active int := 0;
  v_used int := 0;
  v_member_days int := 0;
  v_ok boolean;
begin
  select kind into v_kind from public.chats where id = p_chat;
  select joined_at into v_joined from public.chat_members where chat_id = p_chat and user_id = p_user;
  v_ok := v_kind in ('group', 'channel') and v_joined is not null;
  if v_ok then
    select coalesce(sum(a.seen::int + a.reacted::int + 2 * a.wrote::int), 0)::int, count(*)::int
      into v_score, v_active
    from private.chat_activity a
    where a.user_id = p_user and a.chat_id = p_chat and a.day > private.msk_today() - 30;
    select count(*)::int into v_used
    from public.reactions r
    where r.user_id = p_user and r.chat_id = p_chat and r.super
      and r.created_at >= (private.msk_today()::timestamp at time zone 'Europe/Moscow');
    v_member_days := floor(extract(epoch from now() - v_joined) / 86400)::int;
  end if;
  return jsonb_build_object(
    'available', coalesce(v_ok, false),
    'eligible', coalesce(v_ok, false) and v_score >= c_need and v_member_days >= c_days,
    'score', v_score, 'need', c_need,
    'member_days', v_member_days, 'need_days', c_days,
    'active_days', v_active,
    'per_day', c_daily, 'left', greatest(0, c_daily - v_used)
  );
end;
$$;

create or replace function public.super_reaction_status(p_chat uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select private.super_status((select auth.uid()), p_chat) where (select auth.uid()) is not null;
$$;

-- Поставить реакцию (обычную или супер). Если такая же уже стоит, но другого вида — меняется вид.
-- Убрать реакцию — как раньше, удалением своей строки из reactions.
create or replace function public.set_reaction(p_message uuid, p_emoji text, p_super boolean default false)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_super boolean := coalesce(p_super, false);
  v_chat uuid;
  v_cur boolean;
  v_had boolean;
  v_st jsonb;
begin
  if v_me is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select m.chat_id into v_chat from public.messages m where m.id = p_message and m.deleted_at is null;
  if v_chat is null or not private.is_chat_member(v_chat) then
    raise exception 'Сообщение не найдено' using errcode = 'P0002';
  end if;
  select r.super into v_cur from public.reactions r where r.message_id = p_message and r.user_id = v_me and r.emoji = p_emoji;
  v_had := found;
  if v_had and v_cur = v_super then
    return;
  end if;
  if v_super then
    v_st := private.super_status(v_me, v_chat);
    if not (v_st ->> 'available')::boolean then
      raise exception 'Супер-реакции есть только в группах и каналах' using errcode = '22023';
    end if;
    if not (v_st ->> 'eligible')::boolean then
      raise exception 'Супер-реакция откроется, когда вы побудете активным в этом чате' using errcode = '42501';
    end if;
    if (v_st ->> 'left')::int <= 0 then
      raise exception 'Супер-реакции в этом чате на сегодня закончились — завтра будут новые' using errcode = '54000';
    end if;
  end if;
  if v_had then
    delete from public.reactions where message_id = p_message and user_id = v_me and emoji = p_emoji;
  end if;
  insert into public.reactions (message_id, emoji, super) values (p_message, p_emoji, v_super);
end;
$$;

-- Лента канала до подписки: супер-реакции считаются отдельно, ключ со звёздочкой ('fire*').
create or replace function public.channel_feed(
  p_chat uuid, p_before timestamptz default null, p_before_id uuid default null, p_limit integer default 50
)
returns table (id uuid, chat_id uuid, user_id uuid, kind text, body text, created_at timestamptz,
               deleted_at timestamptz, sticker text, media_path text, media_mime text, duration_ms integer,
               waveform smallint[], enc text, key_id uuid, files jsonb, reply_to uuid, fwd jsonb, call_id uuid,
               edited_at timestamptz, signature text, reacts jsonb)
language sql stable security definer set search_path = ''
as $$
  select m.id, m.chat_id,
         case when private.is_chat_member(p_chat) then m.user_id end,
         m.kind, m.body, m.created_at, m.deleted_at, m.sticker, m.media_path, m.media_mime, m.duration_ms,
         m.waveform, m.enc, m.key_id, m.files, m.reply_to, m.fwd, m.call_id, m.edited_at, m.signature,
         (select jsonb_object_agg(x.k, x.n)
            from (select r.emoji || case when r.super then '*' else '' end as k, count(*) as n
                  from public.reactions r where r.message_id = m.id group by 1) x)
  from public.messages m
  where m.chat_id = p_chat
    and private.is_channel(p_chat)
    and (private.is_public_channel(p_chat) or private.is_chat_member(p_chat))
    and (p_before is null or m.created_at < p_before
         or (m.created_at = p_before and p_before_id is not null and m.id < p_before_id))
  order by m.created_at desc, m.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;

-- ---------------------------------------------------------------------------
-- 4. Активность за последний месяц — из того, что уже есть: сообщения и реакции
-- ---------------------------------------------------------------------------

insert into private.chat_activity (user_id, chat_id, day, seen, wrote, reacted)
select m.user_id, m.chat_id, (m.created_at at time zone 'Europe/Moscow')::date, true, true, false
from public.messages m
join public.chats c on c.id = m.chat_id and c.kind in ('group', 'channel')
join public.profiles p on p.id = m.user_id
where m.user_id is not null and m.kind not in ('system', 'call')
  and m.created_at > now() - interval '31 days'
group by 1, 2, 3
on conflict (user_id, chat_id, day) do update set wrote = true, seen = true;

insert into private.chat_activity (user_id, chat_id, day, seen, wrote, reacted)
select r.user_id, r.chat_id, (r.created_at at time zone 'Europe/Moscow')::date, true, false, true
from public.reactions r
join public.chats c on c.id = r.chat_id and c.kind in ('group', 'channel')
where r.created_at > now() - interval '31 days'
group by 1, 2, 3
on conflict (user_id, chat_id, day) do update set reacted = true, seen = true;

-- ---------------------------------------------------------------------------
-- 5. Доступ к функциям
-- ---------------------------------------------------------------------------

do $$
declare f text;
begin
  foreach f in array array[
    'public.my_sticker_packs()',
    'public.my_emoji_packs()',
    'public.create_emoji_pack(text)',
    'public.add_custom_emoji(text, text, text)',
    'public.rename_custom_emoji(text, text, text)',
    'public.add_sticker(text, text, text)',
    'public.chat_visit(uuid)',
    'public.mark_read(uuid, timestamptz)',
    'public.super_reaction_status(uuid)',
    'public.set_reaction(uuid, text, boolean)',
    'public.channel_feed(uuid, timestamptz, uuid, integer)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  foreach f in array array[
    'private.sticker_pack_json(text)',
    'private.emoji_name(text)',
    'private.check_emoji_name(text, text, text)',
    'private.owns_pack_of_kind(text, text)',
    'private.reactions_guard()',
    'private.stickers_gone()',
    'private.msk_today()',
    'private.note_activity(uuid, uuid, boolean, boolean)',
    'private.messages_activity()',
    'private.reactions_activity()',
    'private.super_status(uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
