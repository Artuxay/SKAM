-- СКАМ 0.5.0: свой предел размера файла для отдельных людей.
--
-- Обычный предел — 50 МБ на файл. Владелец СКАМ может задать человеку другой предел или снять его
-- совсем: строка в private.upload_limits (max_bytes = null — без предела приложения). Кому снят предел,
-- в миграцию не пишем (репозиторий публичный) — строки добавляются SQL-ом на сервере:
--   insert into private.upload_limits (user_id, max_bytes)
--   select id, null from public.profiles where username = '<ник>'
--   on conflict (user_id) do update set max_bytes = excluded.max_bytes, set_at = now();
--
-- Потолок для всех задаёт сервер хранилища — FILE_SIZE_LIMIT (server/filesize.sh, 2 ГБ): файл шифруется
-- в браузере одним куском, больше браузер всё равно не потянет.
--
-- Как держится предел 50 МБ для остальных, если у бакета media предела больше нет: хранилище перед приёмом
-- файла проверяет политику INSERT с metadata = {mimetype, contentLength}, где contentLength — заявленный
-- размер запроса (Content-Length). Политика «media: upload own» (server/managed.sql) вызывает
-- private.media_size_ok(metadata). Запрос без размера (chunked, TUS с отложенной длиной) — только тем,
-- у кого предел снят.

create table if not exists private.upload_limits (
  user_id uuid primary key references auth.users (id) on delete cascade,
  max_bytes bigint check (max_bytes is null or max_bytes > 0),
  set_at timestamptz not null default now()
);
comment on table private.upload_limits is
  'Свой предел размера файла. Нет строки — 50 МБ; max_bytes null — без предела приложения (остаётся FILE_SIZE_LIMIT хранилища).';
revoke all on table private.upload_limits from public, anon, authenticated;

-- Предел для человека в байтах; null — без предела.
create or replace function private.upload_limit(p_user uuid)
returns bigint
language sql stable security definer set search_path = ''
as $$
  select case when l.user_id is null then 52428800::bigint else l.max_bytes end
  from (select p_user as id) u
  left join private.upload_limits l on l.user_id = u.id;
$$;

-- Можно ли мне загрузить в media запрос такого размера. 64 КБ запаса — на обёртку multipart
-- (supabase-js отправляет Blob через FormData, Content-Length чуть больше самого файла).
create or replace function private.media_size_ok(p_meta jsonb)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  lim bigint := private.upload_limit((select auth.uid()));
  n text := p_meta ->> 'contentLength';
begin
  if lim is null then return true; end if;
  if n is null or n !~ '^[0-9]{1,15}$' then return false; end if;
  return n::bigint <= lim + 65536;
end;
$$;

-- Мой предел (для приложения): null — без предела.
create or replace function public.my_upload_limit()
returns bigint
language sql stable security definer set search_path = ''
as $$
  select private.upload_limit((select auth.uid()));
$$;

revoke all on function private.upload_limit(uuid) from public, anon, authenticated;
revoke all on function private.media_size_ok(jsonb) from public, anon;
grant execute on function private.media_size_ok(jsonb) to authenticated;
revoke all on function public.my_upload_limit() from public, anon;
grant execute on function public.my_upload_limit() to authenticated;

-- Бакет media: предел теперь в политике, у бакета — только потолок сервера.
update storage.buckets set file_size_limit = null where id = 'media';

-- Вложения сообщений вида media (каналы): размер больше не ограничен 50 МБ — настоящий размер файла
-- держит хранилище, здесь только здравый смысл (до 1 ТБ).
create or replace function private.files_shape_ok(p jsonb)
returns boolean
language plpgsql immutable set search_path = ''
as $$
declare
  f jsonb;
  path_re constant text := '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.bin$';
begin
  if p is null or jsonb_typeof(p) <> 'array' then return false; end if;
  if jsonb_array_length(p) not between 1 and 10 or octet_length(p::text) > 32768 then return false; end if;
  for f in select value from jsonb_array_elements(p) loop
    if jsonb_typeof(f) <> 'object' then return false; end if;
    if coalesce(f ->> 'kind', '') not in ('photo', 'video', 'file') then return false; end if;
    if coalesce(f ->> 'path', '') !~ path_re then return false; end if;
    if coalesce(f ->> 'key', '') !~ '^[A-Za-z0-9+/]{43}=$' then return false; end if;
    if jsonb_typeof(f -> 'size') is distinct from 'number' then return false; end if;
    if (f ->> 'size')::numeric not between 1 and 1099511627776 then return false; end if;
    if char_length(coalesce(f ->> 'name', '')) not between 1 and 255 then return false; end if;
    if char_length(coalesce(f ->> 'mime', '')) > 255 then return false; end if;
    if f ? 'thumb' and coalesce(f -> 'thumb' ->> 'path', '') !~ path_re then return false; end if;
  end loop;
  return true;
end;
$$;
