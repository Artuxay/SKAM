-- СКАМ 1.1.0: папки с чатами и закреплённые чаты — как в Telegram.
-- Хранятся на сервере, поэтому одинаковые на всех устройствах. Видит их только сам пользователь:
-- таблицы закрыты, всё через функции ниже.

-- ---------------------------------------------------------------------------
-- 1. Таблицы
-- ---------------------------------------------------------------------------

create table if not exists public.chat_folders (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 24 and title = btrim(title)),
  -- Значок папки — эмодзи; null — клиент подбирает значок по содержимому.
  emoji       text check (emoji is null or (char_length(emoji) between 1 and 16 and emoji !~ '[A-Za-zА-Яа-яЁё<>[:space:]]')),
  position    integer not null default 0,
  -- Целые типы чатов: личные, группы, каналы, боты.
  kinds       text[] not null default '{}' check (kinds <@ array['direct', 'group', 'channel', 'bot']::text[]),
  -- Выбранные и исключённые чаты.
  include_ids uuid[] not null default '{}' check (cardinality(include_ids) <= 200),
  exclude_ids uuid[] not null default '{}' check (cardinality(exclude_ids) <= 200),
  -- Закреплённые в папке, по порядку. Всегда входят в include_ids.
  pinned_ids  uuid[] not null default '{}' check (cardinality(pinned_ids) <= 10),
  -- «Исключить прочитанные».
  no_read     boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists chat_folders_user_idx on public.chat_folders (user_id, position);
comment on table public.chat_folders is 'Папки с чатами (как в Telegram). Только свои, доступ — через RPC.';

-- Закреплённые в общем списке «Все чаты». Отдельно от chat_members: там строки видят другие участники.
create table if not exists public.chat_pins (
  user_id  uuid not null references public.profiles (id) on delete cascade,
  chat_id  uuid not null references public.chats (id) on delete cascade,
  position integer not null,
  primary key (user_id, chat_id)
);
create index if not exists chat_pins_chat_idx on public.chat_pins (chat_id);
comment on table public.chat_pins is 'Закреплённые чаты в «Все чаты» (меньше position — выше). Доступ — через RPC.';

alter table public.chat_folders enable row level security;
alter table public.chat_pins enable row level security;
revoke all on public.chat_folders, public.chat_pins from anon, authenticated;

-- Вышел из чата (или чат удалён) — чат пропадает из закреплённых и из папок.
create or replace function private.chat_layout_cleanup()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.chat_pins where user_id = old.user_id and chat_id = old.chat_id;
  update public.chat_folders
     set include_ids = array_remove(include_ids, old.chat_id),
         exclude_ids = array_remove(exclude_ids, old.chat_id),
         pinned_ids  = array_remove(pinned_ids, old.chat_id)
   where user_id = old.user_id
     and (old.chat_id = any (include_ids) or old.chat_id = any (exclude_ids) or old.chat_id = any (pinned_ids));
  return null;
end;
$$;
drop trigger if exists chat_members_layout_cleanup on public.chat_members;
create trigger chat_members_layout_cleanup after delete on public.chat_members
  for each row execute function private.chat_layout_cleanup();

-- Только мои чаты из списка: без повторов, в исходном порядке.
create or replace function private.my_chat_ids(p_ids uuid[])
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(x.id order by x.ord), '{}')
  from (
    select distinct on (u.id) u.id, u.ord
    from unnest(coalesce(p_ids, '{}')) with ordinality u (id, ord)
    where u.id is not null
      and exists (select 1 from public.chat_members m where m.chat_id = u.id and m.user_id = (select auth.uid()))
    order by u.id, u.ord
  ) x;
$$;

-- ---------------------------------------------------------------------------
-- 2. Чтение: закреплённые и папки одним вызовом
-- ---------------------------------------------------------------------------

create or replace function public.my_chat_layout()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'pins', coalesce((
      select jsonb_agg(p.chat_id order by p.position, p.chat_id)
      from public.chat_pins p where p.user_id = (select auth.uid())
    ), '[]'::jsonb),
    'folders', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', f.id, 'title', f.title, 'emoji', f.emoji, 'kinds', to_jsonb(f.kinds),
               'include', to_jsonb(f.include_ids), 'exclude', to_jsonb(f.exclude_ids),
               'pinned', to_jsonb(f.pinned_ids), 'no_read', f.no_read)
             order by f.position, f.created_at, f.id)
      from public.chat_folders f where f.user_id = (select auth.uid())
    ), '[]'::jsonb)
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. Папки
-- ---------------------------------------------------------------------------

-- Создать (p_id = null) или изменить папку. Возвращает id папки.
create or replace function public.save_chat_folder(p_id uuid, p_title text, p_emoji text, p_kinds text[],
  p_include uuid[], p_exclude uuid[], p_no_read boolean)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_me    uuid := (select auth.uid());
  v_title text := btrim(coalesce(p_title, ''));
  v_emoji text := nullif(btrim(coalesce(p_emoji, '')), '');
  v_kinds text[];
  v_inc   uuid[];
  v_exc   uuid[];
  v_id    uuid;
begin
  if v_me is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if v_title = '' then
    raise exception 'Введите название папки' using errcode = '22023';
  end if;
  if char_length(v_title) > 24 then
    raise exception 'Название папки — не длиннее 24 символов' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct k order by k), '{}') into v_kinds
  from unnest(coalesce(p_kinds, '{}')) k where k in ('direct', 'group', 'channel', 'bot');
  v_inc := private.my_chat_ids(p_include);
  -- Чат не может быть и выбран, и исключён: выбранный важнее.
  v_exc := array(select x from unnest(private.my_chat_ids(p_exclude)) with ordinality u (x, o)
                 where not (x = any (v_inc)) order by o);
  if cardinality(v_kinds) = 0 and cardinality(v_inc) = 0 then
    raise exception 'Добавьте в папку хотя бы один чат или тип чатов' using errcode = '22023';
  end if;
  if cardinality(v_inc) > 200 then
    raise exception 'В папку можно выбрать не больше 200 чатов' using errcode = '54000';
  end if;
  if cardinality(v_exc) > 200 then
    raise exception 'Исключить можно не больше 200 чатов' using errcode = '54000';
  end if;

  if p_id is null then
    if (select count(*) from public.chat_folders where user_id = v_me) >= 20 then
      raise exception 'Можно создать не больше 20 папок' using errcode = '54000';
    end if;
    insert into public.chat_folders (user_id, title, emoji, position, kinds, include_ids, exclude_ids, no_read)
    values (v_me, v_title, v_emoji,
            coalesce((select max(position) + 1 from public.chat_folders where user_id = v_me), 0),
            v_kinds, v_inc, v_exc, coalesce(p_no_read, false))
    returning id into v_id;
  else
    update public.chat_folders f
       set title = v_title, emoji = v_emoji, kinds = v_kinds, include_ids = v_inc, exclude_ids = v_exc,
           -- Закреплённый остаётся, только если чат по-прежнему выбран в папке.
           pinned_ids = array(select x from unnest(f.pinned_ids) with ordinality u (x, o) where x = any (v_inc) order by o),
           no_read = coalesce(p_no_read, false), updated_at = now()
     where f.id = p_id and f.user_id = v_me
    returning f.id into v_id;
    if v_id is null then
      raise exception 'Папка не найдена' using errcode = 'P0002';
    end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_chat_folder(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  delete from public.chat_folders where id = p_id and user_id = (select auth.uid());
  if not found then
    raise exception 'Папка не найдена' using errcode = 'P0002';
  end if;
end;
$$;

-- Порядок папок: p_ids — все мои папки в нужном порядке.
create or replace function public.reorder_chat_folders(p_ids uuid[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
begin
  if v_me is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  -- Не названные в списке — в конец, в прежнем порядке.
  update public.chat_folders f set position = 1000 + f.position
   where f.user_id = v_me and not (f.id = any (coalesce(p_ids, '{}')));
  update public.chat_folders f set position = u.ord - 1
    from unnest(coalesce(p_ids, '{}')) with ordinality u (id, ord)
   where f.id = u.id and f.user_id = v_me;
end;
$$;

-- Добавить чат в папку или убрать из неё (меню чата в списке).
create or replace function public.folder_set_chat(p_folder uuid, p_chat uuid, p_in boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_me   uuid := (select auth.uid());
  v_kind text;
  v_f    public.chat_folders;
begin
  if v_me is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not exists (select 1 from public.chat_members where chat_id = p_chat and user_id = v_me) then
    raise exception 'Чат не найден' using errcode = 'P0002';
  end if;
  select * into v_f from public.chat_folders where id = p_folder and user_id = v_me for update;
  if not found then
    raise exception 'Папка не найдена' using errcode = 'P0002';
  end if;
  select kind into v_kind from public.chats where id = p_chat;
  if p_in then
    if not (p_chat = any (v_f.include_ids)) and cardinality(v_f.include_ids) >= 200 then
      raise exception 'В папку можно выбрать не больше 200 чатов' using errcode = '54000';
    end if;
    update public.chat_folders
       set include_ids = case when p_chat = any (include_ids) then include_ids else include_ids || p_chat end,
           exclude_ids = array_remove(exclude_ids, p_chat), updated_at = now()
     where id = p_folder;
  else
    -- Если чат попадает в папку по типу — исключаем его явно, как Telegram.
    if v_kind = any (v_f.kinds) and not (p_chat = any (v_f.exclude_ids)) and cardinality(v_f.exclude_ids) >= 200 then
      raise exception 'Исключить можно не больше 200 чатов' using errcode = '54000';
    end if;
    update public.chat_folders
       set include_ids = array_remove(include_ids, p_chat),
           pinned_ids  = array_remove(pinned_ids, p_chat),
           exclude_ids = case when v_kind = any (kinds) and not (p_chat = any (exclude_ids))
                              then exclude_ids || p_chat else exclude_ids end,
           updated_at  = now()
     where id = p_folder;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Закреплённые чаты: в «Все чаты» (p_folder = null) или в папке
-- ---------------------------------------------------------------------------

create or replace function public.pin_chat(p_chat uuid, p_on boolean, p_folder uuid default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_f  public.chat_folders;
begin
  if v_me is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_on and not exists (select 1 from public.chat_members where chat_id = p_chat and user_id = v_me) then
    raise exception 'Чат не найден' using errcode = 'P0002';
  end if;

  if p_folder is null then
    if not p_on then
      delete from public.chat_pins where user_id = v_me and chat_id = p_chat;
      return;
    end if;
    if exists (select 1 from public.chat_pins where user_id = v_me and chat_id = p_chat) then
      return;
    end if;
    if (select count(*) from public.chat_pins where user_id = v_me) >= 10 then
      raise exception 'Закрепить можно не больше 10 чатов — открепите ненужные' using errcode = '54000';
    end if;
    -- Новый закреплённый — самый верхний.
    insert into public.chat_pins (user_id, chat_id, position)
    values (v_me, p_chat, coalesce((select min(position) - 1 from public.chat_pins where user_id = v_me), 0));
    return;
  end if;

  select * into v_f from public.chat_folders where id = p_folder and user_id = v_me for update;
  if not found then
    raise exception 'Папка не найдена' using errcode = 'P0002';
  end if;
  if not p_on then
    update public.chat_folders set pinned_ids = array_remove(pinned_ids, p_chat), updated_at = now() where id = p_folder;
    return;
  end if;
  if p_chat = any (v_f.pinned_ids) then
    return;
  end if;
  if cardinality(v_f.pinned_ids) >= 10 then
    raise exception 'В папке можно закрепить не больше 10 чатов — открепите ненужные' using errcode = '54000';
  end if;
  if not (p_chat = any (v_f.include_ids)) and cardinality(v_f.include_ids) >= 200 then
    raise exception 'В папку можно выбрать не больше 200 чатов' using errcode = '54000';
  end if;
  -- Закреплённый в папке чат всегда в ней виден: он становится выбранным и перестаёт быть исключённым.
  update public.chat_folders
     set pinned_ids  = array_prepend(p_chat, pinned_ids),
         include_ids = case when p_chat = any (include_ids) then include_ids else include_ids || p_chat end,
         exclude_ids = array_remove(exclude_ids, p_chat),
         updated_at  = now()
   where id = p_folder;
end;
$$;

-- Новый порядок закреплённых (перетаскивание в списке).
create or replace function public.reorder_pinned_chats(p_ids uuid[], p_folder uuid default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
begin
  if v_me is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_folder is null then
    update public.chat_pins p set position = 1000 + p.position
     where p.user_id = v_me and not (p.chat_id = any (coalesce(p_ids, '{}')));
    update public.chat_pins p set position = u.ord
      from unnest(coalesce(p_ids, '{}')) with ordinality u (id, ord)
     where p.user_id = v_me and p.chat_id = u.id;
    return;
  end if;
  update public.chat_folders f
     set pinned_ids = array(
           select x from (
             select u.x, u.o from unnest(coalesce(p_ids, '{}')) with ordinality u (x, o) where u.x = any (f.pinned_ids)
             union all
             select v.x, 100000 + v.o from unnest(f.pinned_ids) with ordinality v (x, o) where not (v.x = any (coalesce(p_ids, '{}')))
           ) s group by x order by min(o)),
         updated_at = now()
   where f.id = p_folder and f.user_id = v_me;
  if not found then
    raise exception 'Папка не найдена' using errcode = 'P0002';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Права на функции
-- ---------------------------------------------------------------------------

do $$
declare f text;
begin
  foreach f in array array[
    'public.my_chat_layout()',
    'public.save_chat_folder(uuid, text, text, text[], uuid[], uuid[], boolean)',
    'public.delete_chat_folder(uuid)',
    'public.reorder_chat_folders(uuid[])',
    'public.folder_set_chat(uuid, uuid, boolean)',
    'public.pin_chat(uuid, boolean, uuid)',
    'public.reorder_pinned_chats(uuid[], uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

revoke all on function private.my_chat_ids(uuid[]) from public, anon, authenticated;
revoke all on function private.chat_layout_cleanup() from public, anon, authenticated;

notify pgrst, 'reload schema';
