-- СКАМ 1.6.0: истории, как в Telegram.
--
-- • Историю видят люди, с которыми у автора есть личный чат (и сам автор).
-- • Фото, видео до 60 секунд или текст на градиентном фоне; живёт 24 часа.
-- • Историю можно закрепить в профиле — тогда она не исчезает, пока её не открепят.
-- • Ответ на историю — только сердечко; автор видит, кто смотрел и кому понравилось.
-- • Файлы — в приватном бакете stories (<автор>/<id>.<ext> и превью <автор>/<id>_t.jpg).
--   Политики Storage создаёт server/managed.sql от supabase_admin (у postgres на сервере нет прав на storage.objects).
-- • Исчезнувшие истории удаляет cron на сервере: private.stories_gc() переносит пути файлов в private.story_trash,
--   server/stories-cleanup.sh удаляет файлы через API Storage.

create table if not exists public.stories (
  id          uuid primary key,
  author_id   uuid not null references auth.users (id) on delete cascade,
  kind        text not null check (kind in ('photo', 'video', 'text')),
  media_path  text,
  thumb_path  text,
  media_mime  text,
  w           int check (w is null or w between 1 and 10000),
  h           int check (h is null or h between 1 and 10000),
  duration_ms int check (duration_ms is null or duration_ms between 0 and 61000),
  body        text check (body is null or char_length(body) between 1 and 700),
  bg          smallint check (bg is null or bg between 0 and 7),
  pinned      boolean not null default false,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '24 hours',
  constraint stories_shape check (
    (kind = 'text' and media_path is null and thumb_path is null and media_mime is null and body is not null and bg is not null)
    or (kind in ('photo', 'video') and media_path is not null and thumb_path is not null and media_mime is not null)
  ),
  constraint stories_video_dur check (kind <> 'video' or duration_ms is not null)
);
create index if not exists stories_author_idx on public.stories (author_id, created_at desc);
create index if not exists stories_expire_idx on public.stories (expires_at) where not pinned;
create unique index if not exists stories_media_idx on public.stories (media_path) where media_path is not null;
create unique index if not exists stories_thumb_idx on public.stories (thumb_path) where thumb_path is not null;

create table if not exists public.story_views (
  story_id  uuid not null references public.stories (id) on delete cascade,
  viewer_id uuid not null references auth.users (id) on delete cascade,
  viewed_at timestamptz not null default now(),
  liked     boolean not null default false,
  primary key (story_id, viewer_id)
);
create index if not exists story_views_viewer_idx on public.story_views (viewer_id);

-- Только через функции ниже: прямой доступ к таблицам закрыт.
alter table public.stories enable row level security;
alter table public.story_views enable row level security;
revoke all on table public.stories, public.story_views from anon, authenticated;

-- Файлы исчезнувших историй, которые ещё предстоит удалить из Storage (это делает cron на сервере).
create table if not exists private.story_trash (
  path text primary key,
  at   timestamptz not null default now()
);
revoke all on table private.story_trash from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Кто что видит
-- ---------------------------------------------------------------------------

-- Есть ли у двух людей личный чат (оба в нём состоят).
create or replace function private.has_direct(p_a uuid, p_b uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_a is not null and p_b is not null and p_a <> p_b and exists (
    select 1 from public.chats c
    where c.direct_key = least(p_a, p_b)::text || ':' || greatest(p_a, p_b)::text
      and c.kind = 'direct'
      and exists (select 1 from public.chat_members m where m.chat_id = c.id and m.user_id = p_a)
      and exists (select 1 from public.chat_members m where m.chat_id = c.id and m.user_id = p_b)
  );
$$;

-- Вижу ли я истории этого человека: свои — всегда, чужие — если есть личный чат.
create or replace function private.story_visible(p_author uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_author = (select auth.uid()) or private.has_direct(p_author, (select auth.uid()));
$$;

-- Файл истории можно скачать: история жива (не прошли сутки или закреплена) и видна мне.
create or replace function private.story_file_visible(p_name text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.stories s
    where (s.media_path = p_name or s.thumb_path = p_name)
      and (s.pinned or s.expires_at > now())
      and private.story_visible(s.author_id)
  );
$$;

-- Загрузить файл истории: только в свою папку, имя <id>.<ext> или <id>_t.jpg, не больше 120 файлов в папке.
create or replace function private.story_upload_ok(p_name text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_registered()
     and p_name ~ ('^' || (select auth.uid())::text
                   || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.(jpg|webp|mp4|webm|mov)|_t\.jpg)$')
     and (select count(*) from storage.objects o
           where o.bucket_id = 'stories' and o.name like (select auth.uid())::text || '/%') < 120;
$$;

revoke execute on function private.has_direct(uuid, uuid), private.story_visible(uuid),
  private.story_file_visible(text), private.story_upload_ok(text) from public, anon;
grant execute on function private.has_direct(uuid, uuid), private.story_visible(uuid),
  private.story_file_visible(text), private.story_upload_ok(text) to authenticated;

-- Бакет: приватный, до 50 МБ, только фото и видео.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('stories', 'stories', false, 52428800, array['image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- Чтение
-- ---------------------------------------------------------------------------

-- Одна история в JSON (просмотры и сердечки — только автору).
create or replace function private.story_json(s public.stories, p_me uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', s.id, 'author_id', s.author_id, 'kind', s.kind,
    'media_path', s.media_path, 'thumb_path', s.thumb_path, 'media_mime', s.media_mime,
    'w', s.w, 'h', s.h, 'duration_ms', s.duration_ms, 'body', s.body, 'bg', s.bg,
    'pinned', s.pinned, 'created_at', s.created_at, 'expires_at', s.expires_at,
    'seen', s.author_id = p_me or exists (select 1 from public.story_views v where v.story_id = s.id and v.viewer_id = p_me),
    'liked', exists (select 1 from public.story_views v where v.story_id = s.id and v.viewer_id = p_me and v.liked),
    'views', case when s.author_id = p_me then (select count(*) from public.story_views v where v.story_id = s.id) end,
    'likes', case when s.author_id = p_me then (select count(*) from public.story_views v where v.story_id = s.id and v.liked) end
  );
$$;
revoke execute on function private.story_json(public.stories, uuid) from public, anon, authenticated;

-- Лента историй над списком чатов: я и люди, с кем есть личный чат, у кого есть живые (до суток) истории.
-- Сначала мои, потом с непросмотренными, потом остальные — свежие выше.
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

-- Истории человека для профиля: живые и закреплённые, свежие первыми. Не видно — пустой список.
create or replace function public.user_stories(p_user uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when not private.story_visible(p_user) then '[]'::jsonb else coalesce((
    select jsonb_agg(private.story_json(s, (select auth.uid())) order by s.pinned desc, s.created_at desc)
    from public.stories s
    where s.author_id = p_user and (s.pinned or s.expires_at > now())
  ), '[]'::jsonb) end;
$$;

-- Кто смотрел мою историю: сначала с сердечком, потом свежие.
create or replace function public.story_viewers(p_story uuid)
returns table (user_id uuid, name text, avatar_path text, color text, verified boolean, viewed_at timestamptz, liked boolean)
language sql stable security definer set search_path = ''
as $$
  select v.viewer_id, p.name, p.avatar_path, p.color, coalesce(p.verified, false), v.viewed_at, v.liked
  from public.story_views v
  join public.stories s on s.id = v.story_id and s.author_id = (select auth.uid())
  left join public.profiles p on p.id = v.viewer_id
  where v.story_id = p_story
  order by v.liked desc, v.viewed_at desc
  limit 500;
$$;

-- ---------------------------------------------------------------------------
-- Изменение
-- ---------------------------------------------------------------------------

-- Выложить историю. Файлы (для фото и видео) уже загружены в stories/<я>/<id>.<ext> и <id>_t.jpg.
create or replace function public.create_story(
  p_id uuid, p_kind text, p_media_path text, p_thumb_path text, p_media_mime text,
  p_w int, p_h int, p_duration_ms int, p_body text, p_bg smallint
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  b text;
begin
  perform private.require_registered();
  if p_id is null then raise exception 'bad story id' using errcode = '22023'; end if;
  if (select count(*) from public.stories where author_id = me and created_at > now() - interval '24 hours') >= 30 then
    raise exception 'Можно выложить не больше 30 историй за сутки.' using errcode = 'P0001';
  end if;
  -- Текст: без управляющих символов (кроме перевода строки), \r\n → \n, пробелы по краям убираем.
  b := nullif(btrim(regexp_replace(replace(coalesce(p_body, ''), E'\r\n', E'\n'), E'[\\x01-\\x09\\x0B-\\x1F\\x7F]', '', 'g')), '');

  if p_kind = 'text' then
    if b is null then raise exception 'Напишите текст истории.' using errcode = '22023'; end if;
    if char_length(b) > 700 then raise exception 'Текст истории — до 700 символов.' using errcode = '22023'; end if;
    insert into public.stories (id, author_id, kind, body, bg)
    values (p_id, me, 'text', b, greatest(0, least(7, coalesce(p_bg, 0))));
    return p_id;
  end if;

  if p_kind not in ('photo', 'video') then raise exception 'bad story kind' using errcode = '22023'; end if;
  if b is not null and char_length(b) > 200 then raise exception 'Подпись к истории — до 200 символов.' using errcode = '22023'; end if;
  if p_media_path is null or p_thumb_path is null
     or p_media_path !~ ('^' || me::text || '/' || p_id::text || '\.(jpg|webp|mp4|webm|mov)$')
     or p_thumb_path <> me::text || '/' || p_id::text || '_t.jpg' then
    raise exception 'bad story path' using errcode = '22023';
  end if;
  if (p_kind = 'photo' and p_media_mime not in ('image/jpeg', 'image/webp'))
     or (p_kind = 'video' and p_media_mime not in ('video/mp4', 'video/webm', 'video/quicktime')) then
    raise exception 'bad story mime' using errcode = '22023';
  end if;
  if p_kind = 'video' and (p_duration_ms is null or p_duration_ms > 61000) then
    raise exception 'Видео в истории — до 60 секунд.' using errcode = '22023';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'stories' and o.name = p_media_path and o.owner_id = me::text)
     or not exists (select 1 from storage.objects o where o.bucket_id = 'stories' and o.name = p_thumb_path and o.owner_id = me::text) then
    raise exception 'Файл истории не загрузился. Попробуйте ещё раз.' using errcode = 'P0002';
  end if;
  insert into public.stories (id, author_id, kind, media_path, thumb_path, media_mime, w, h, duration_ms, body)
  values (p_id, me, p_kind, p_media_path, p_thumb_path, p_media_mime,
          case when p_w between 1 and 10000 then p_w end, case when p_h between 1 and 10000 then p_h end,
          case when p_kind = 'video' then greatest(0, p_duration_ms) end, b);
  return p_id;
end;
$$;

-- Отметить, что я посмотрел историю (свою не отмечаем).
create or replace function public.view_story(p_story uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  a uuid;
begin
  select s.author_id into a from public.stories s where s.id = p_story and (s.pinned or s.expires_at > now());
  if a is null or a = me or not private.story_visible(a) then return; end if;
  insert into public.story_views (story_id, viewer_id) values (p_story, me) on conflict do nothing;
end;
$$;

-- Сердечко истории (поставить или снять).
create or replace function public.like_story(p_story uuid, p_on boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  a uuid;
begin
  select s.author_id into a from public.stories s where s.id = p_story and (s.pinned or s.expires_at > now());
  if a is null or not private.story_visible(a) then raise exception 'История уже исчезла.' using errcode = 'P0002'; end if;
  if a = me then raise exception 'Своей истории сердечко не ставят.' using errcode = '22023'; end if;
  insert into public.story_views (story_id, viewer_id, liked) values (p_story, me, coalesce(p_on, false))
  on conflict (story_id, viewer_id) do update set liked = excluded.liked;
end;
$$;

-- Закрепить в профиле (или открепить). Закрепить можно живую историю, всего не больше 50.
create or replace function public.pin_story(p_story uuid, p_on boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  s public.stories;
begin
  select * into s from public.stories where id = p_story and author_id = me;
  if s.id is null then raise exception 'История не найдена.' using errcode = 'P0002'; end if;
  if coalesce(p_on, false) then
    if not s.pinned and s.expires_at <= now() then raise exception 'История уже исчезла.' using errcode = 'P0002'; end if;
    if not s.pinned and (select count(*) from public.stories where author_id = me and pinned) >= 50 then
      raise exception 'В профиле можно закрепить не больше 50 историй.' using errcode = 'P0001';
    end if;
  end if;
  update public.stories set pinned = coalesce(p_on, false) where id = p_story;
end;
$$;

-- Удалить свою историю. Файлы удалит сам клиент, а не успеет — cron на сервере (через story_trash).
create or replace function public.delete_story(p_story uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  s public.stories;
begin
  delete from public.stories where id = p_story and author_id = me returning * into s;
  if s.id is null then raise exception 'История не найдена.' using errcode = 'P0002'; end if;
  insert into private.story_trash (path)
  select p from unnest(array[s.media_path, s.thumb_path]) p where p is not null
  on conflict do nothing;
end;
$$;

-- Уборка (вызывает только cron на сервере от postgres): исчезнувшие незакреплённые истории удаляются,
-- их файлы попадают в story_trash; возвращает, сколько историй убрали.
create or replace function private.stories_gc(p_limit int default 500)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  n int;
begin
  with dead as (
    delete from public.stories s
    where s.id in (
      select id from public.stories where not pinned and expires_at < now() order by expires_at limit greatest(1, p_limit)
    )
    returning s.media_path, s.thumb_path
  ), files as (
    insert into private.story_trash (path)
    select p from dead, unnest(array[dead.media_path, dead.thumb_path]) p where p is not null
    on conflict do nothing
    returning 1
  )
  select count(*) into n from dead;
  return n;
end;
$$;
revoke execute on function private.stories_gc(int) from public, anon, authenticated;

revoke execute on function public.story_feed(), public.user_stories(uuid), public.story_viewers(uuid),
  public.create_story(uuid, text, text, text, text, int, int, int, text, smallint), public.view_story(uuid),
  public.like_story(uuid, boolean), public.pin_story(uuid, boolean), public.delete_story(uuid) from public, anon;
grant execute on function public.story_feed(), public.user_stories(uuid), public.story_viewers(uuid),
  public.create_story(uuid, text, text, text, text, int, int, int, text, smallint), public.view_story(uuid),
  public.like_story(uuid, boolean), public.pin_story(uuid, boolean), public.delete_story(uuid) to authenticated;
