-- СКАМ 0.4.0: статьи (как Telegraph) и опросы в чатах.
--
-- Статьи. Пишет только зарегистрированный пользователь, читает кто угодно по ссылке
-- https://skam-messenger.ru/a/<slug> (в том числе без входа). Содержимое — массив узлов в формате Telegraph:
-- строка или {tag, attrs?, children?}; теги и атрибуты проверяются на сервере, картинки — только свои,
-- из публичного бакета articles. Имя файла картинки случайное (<uuid>.<webp|jpg|png|gif>) и не выдаёт автора:
-- кому принадлежит файл, знает только закрытая таблица private.article_images. Политики бакета —
-- в server/managed.sql (их ставит supabase_admin: sh /opt/skam-test/src/server/apply-managed.sh).
--
-- Опросы. Как в Telegram: анонимные или открытые, один или несколько ответов, викторина с правильным ответом
-- и пояснением (видны после ответа), закрыть опрос. В чатах со сквозным шифрованием вопрос и варианты лежат
-- внутри шифротекста сообщения — сервер знает только число вариантов и номера голосов. Пояснение викторины
-- там тоже зашифровано ключом чата и отдаётся только тем, кто уже ответил.

-- ===========================================================================
-- Статьи
-- ===========================================================================

create table if not exists public.articles (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  author_id uuid not null references public.profiles (id) on delete cascade,
  title text not null,
  author_name text,
  author_url text,
  content jsonb not null default '[]'::jsonb,
  description text not null default '',
  cover text,
  views integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  hidden_at timestamptz,
  constraint articles_slug_shape check (slug ~ '^[A-Za-z0-9][A-Za-z0-9-]{1,118}[A-Za-z0-9]$'),
  constraint articles_title_len check (char_length(btrim(title)) between 1 and 256),
  constraint articles_author_len check (author_name is null or char_length(author_name) between 1 and 128),
  constraint articles_url_shape check (author_url is null
    or (char_length(author_url) <= 512 and author_url ~ '^(https?://\S+|@[A-Za-z][A-Za-z0-9_]{4,31})$')),
  constraint articles_content_shape check (jsonb_typeof(content) = 'array' and octet_length(content::text) <= 131072),
  constraint articles_desc_len check (char_length(description) <= 300),
  constraint articles_cover_shape check (cover is null or cover ~ '^[0-9a-f-]{36}\.(webp|jpg|png|gif)$')
);
create unique index if not exists articles_slug_key on public.articles (lower(slug));
create index if not exists articles_author_idx on public.articles (author_id, created_at desc);
alter table public.articles enable row level security;
-- Таблица закрыта: читать и писать — только через функции ниже.
revoke all on public.articles from public, anon, authenticated;

-- Картинки статей: публичный бакет (читают все, кто открыл статью), загрузка — только в выданное место.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('articles', 'articles', true, 5242880, array['image/webp', 'image/jpeg', 'image/png', 'image/gif'])
on conflict (id) do nothing;

-- Чья картинка: путь в бакете articles → автор. Закрыта (никому, кроме функций).
create table if not exists private.article_images (
  path text primary key,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint article_images_path_shape check (path ~ '^[0-9a-f-]{36}\.(webp|jpg|png|gif)$')
);
create index if not exists article_images_owner_idx on private.article_images (owner_id, created_at desc);
revoke all on private.article_images from public, anon, authenticated;

/** Место для новой картинки статьи: случайное имя файла, записанное за мной (не больше 100 в сутки). */
create or replace function public.article_image_slot(p_ext text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_path text;
begin
  perform private.require_registered();
  if p_ext is null or p_ext not in ('webp', 'jpg', 'png', 'gif') then
    raise exception 'Картинка — WebP, JPEG, PNG или GIF' using errcode = '22023';
  end if;
  if (select count(*) from private.article_images where owner_id = v_me and created_at > now() - interval '1 day') >= 100 then
    raise exception 'Не больше 100 картинок для статей в сутки' using errcode = '54000';
  end if;
  v_path := gen_random_uuid()::text || '.' || p_ext;
  insert into private.article_images (path, owner_id) values (v_path, v_me);
  return v_path;
end;
$$;

/** Для политик бакета articles: эта картинка — моя (загрузить в выданное место, удалить свою). */
create or replace function private.article_image_mine(p_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from private.article_images where path = p_path and owner_id = (select auth.uid()));
$$;

-- Адрес статьи как в Telegraph: заголовок латиницей + месяц-день, при совпадении -2, -3…
create or replace function private.article_slug_base(p_title text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  ru text[] := array['щ','ж','ё','х','ц','ч','ш','ю','я','ї','є','а','б','в','г','ґ','д','е','з','и','і','й','к','л','м','н','о','п','р','с','т','у','ф','ъ','ы','ь','э'];
  en text[] := array['shch','zh','yo','kh','ts','ch','sh','yu','ya','yi','ye','a','b','v','g','g','d','e','z','i','i','y','k','l','m','n','o','p','r','s','t','u','f','','y','','e'];
  s text := coalesce(p_title, '');
  i int;
begin
  for i in 1 .. array_length(ru, 1) loop
    s := replace(s, ru[i], en[i]);
    s := replace(s, upper(ru[i]), initcap(en[i]));
  end loop;
  s := regexp_replace(s, '[^A-Za-z0-9]+', '-', 'g');
  s := btrim(left(btrim(s, '-'), 80), '-');
  if s = '' then s := 'Statya'; end if;
  return s;
end;
$$;

/**
 * Проверить содержимое статьи и собрать из него описание (первые ~200 символов текста) и обложку (первая картинка).
 * n — сколько узлов уже просмотрено (защита от огромных документов).
 */
create or replace function private.article_walk(
  p_nodes jsonb, p_author uuid, p_depth int,
  inout n int, inout txt text, inout cover text)
language plpgsql
stable
set search_path = ''
as $$
declare
  x jsonb;
  tag text;
  attrs jsonb;
  kids jsonb;
  k text;
  s text;
begin
  if p_depth > 12 then
    raise exception 'Слишком глубокая вложенность в статье' using errcode = '22023';
  end if;
  if jsonb_typeof(p_nodes) is distinct from 'array' then
    raise exception 'bad article content' using errcode = '22023';
  end if;
  for x in select value from jsonb_array_elements(p_nodes) loop
    n := n + 1;
    if n > 20000 then
      raise exception 'Статья слишком длинная' using errcode = '22001';
    end if;
    if jsonb_typeof(x) = 'string' then
      s := x #>> '{}';
      if char_length(s) > 20000 then
        raise exception 'Статья слишком длинная' using errcode = '22001';
      end if;
      if char_length(txt) < 400 then txt := txt || s; end if;
      continue;
    end if;
    if jsonb_typeof(x) <> 'object' then
      raise exception 'bad article node' using errcode = '22023';
    end if;
    tag := x ->> 'tag';
    if tag is null or tag not in ('p', 'h3', 'h4', 'blockquote', 'aside', 'ul', 'ol', 'li', 'pre', 'code',
                                  'b', 'i', 'u', 's', 'a', 'br', 'hr', 'figure', 'img', 'figcaption') then
      raise exception 'bad article tag' using errcode = '22023';
    end if;
    for k in select jsonb_object_keys(x) loop
      if k not in ('tag', 'attrs', 'children') then
        raise exception 'bad article node' using errcode = '22023';
      end if;
    end loop;
    attrs := x -> 'attrs';
    if attrs is not null and jsonb_typeof(attrs) <> 'null' then
      if jsonb_typeof(attrs) <> 'object' then
        raise exception 'bad article attrs' using errcode = '22023';
      end if;
      for k in select jsonb_object_keys(attrs) loop
        if not ((tag = 'a' and k = 'href') or (tag = 'img' and k = 'src')) then
          raise exception 'bad article attrs' using errcode = '22023';
        end if;
      end loop;
      if tag = 'a' and attrs ? 'href'
         and not (jsonb_typeof(attrs -> 'href') = 'string'
                  and (attrs ->> 'href') ~ '^(https?://|mailto:)\S+$' and char_length(attrs ->> 'href') <= 2048) then
        raise exception 'Ссылки в статье должны начинаться с https:// или http://' using errcode = '22023';
      end if;
      if tag = 'img' then
        if not (jsonb_typeof(attrs -> 'src') = 'string'
                and exists (select 1 from private.article_images i where i.path = attrs ->> 'src' and i.owner_id = p_author)) then
          raise exception 'В статье могут быть только свои загруженные картинки' using errcode = '22023';
        end if;
        cover := coalesce(cover, attrs ->> 'src');
      end if;
    end if;
    if tag = 'img' and (attrs is null or not attrs ? 'src') then
      raise exception 'bad article image' using errcode = '22023';
    end if;
    kids := x -> 'children';
    if kids is not null and jsonb_typeof(kids) <> 'null' then
      if tag in ('br', 'hr', 'img') then
        raise exception 'bad article node' using errcode = '22023';
      end if;
      select w.n, w.txt, w.cover into n, txt, cover
      from private.article_walk(kids, p_author, p_depth + 1, n, txt, cover) w;
    end if;
    if tag in ('p', 'h3', 'h4', 'blockquote', 'aside', 'li', 'pre', 'figcaption', 'br') and right(txt, 1) <> ' ' then
      txt := txt || ' ';
    end if;
  end loop;
end;
$$;

/** Сохранить статью: p_id null — новая (адрес выдаётся один раз и потом не меняется), иначе — правка своей. */
create or replace function public.article_save(
  p_id uuid, p_title text, p_author_name text, p_author_url text, p_content jsonb)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_title text := btrim(regexp_replace(coalesce(p_title, ''), '\s+', ' ', 'g'));
  v_name text := nullif(btrim(regexp_replace(coalesce(p_author_name, ''), '\s+', ' ', 'g')), '');
  v_url text := nullif(btrim(coalesce(p_author_url, '')), '');
  v_content jsonb := coalesce(p_content, '[]'::jsonb);
  w record;
  v_desc text;
  v_base text;
  v_slug text;
  v_try int := 0;
  v_k int;
  a public.articles;
begin
  perform private.require_registered();
  if v_title = '' then
    raise exception 'Добавьте заголовок' using errcode = '22023';
  end if;
  if char_length(v_title) > 256 then
    raise exception 'Заголовок длиннее 256 символов' using errcode = '22001';
  end if;
  if char_length(v_name) > 128 then
    raise exception 'Имя автора длиннее 128 символов' using errcode = '22001';
  end if;
  if v_url is not null and v_url ~ '^@?[A-Za-z][A-Za-z0-9_]{4,31}$' then
    v_url := '@' || ltrim(v_url, '@');
  end if;
  if v_url is not null and not (char_length(v_url) <= 512 and v_url ~ '^(https?://\S+|@[A-Za-z][A-Za-z0-9_]{4,31})$') then
    raise exception 'Ссылка автора — адрес https://… или @username' using errcode = '22023';
  end if;
  if jsonb_typeof(v_content) <> 'array' then
    raise exception 'bad article content' using errcode = '22023';
  end if;
  if octet_length(v_content::text) > 131072 then
    raise exception 'Статья слишком длинная' using errcode = '22001';
  end if;
  select * into w from private.article_walk(v_content, v_me, 0, 0, '', null);
  v_desc := left(btrim(regexp_replace(w.txt, '\s+', ' ', 'g')), 200);
  if v_desc = '' and w.cover is null then
    raise exception 'Статья пустая — напишите хоть что-нибудь' using errcode = '22023';
  end if;

  if p_id is null then
    -- Не больше 1000 статей на человека и 50 новых за сутки.
    if (select count(*) from public.articles where author_id = v_me) >= 1000 then
      raise exception 'Достигнут предел — 1000 статей' using errcode = '54000';
    end if;
    if (select count(*) from public.articles where author_id = v_me and created_at > now() - interval '1 day') >= 50 then
      raise exception 'Не больше 50 новых статей в сутки' using errcode = '54000';
    end if;
    v_base := private.article_slug_base(v_title) || '-' || to_char(now() at time zone 'Europe/Moscow', 'MM-DD');
    loop
      v_try := v_try + 1;
      v_slug := v_base;
      v_k := 1;
      while exists (select 1 from public.articles where lower(slug) = lower(v_slug)) loop
        v_k := v_k + 1;
        v_slug := v_base || '-' || v_k;
      end loop;
      begin
        insert into public.articles (slug, author_id, title, author_name, author_url, content, description, cover)
        values (v_slug, v_me, v_title, v_name, v_url, v_content, v_desc, w.cover)
        returning * into a;
        exit;
      exception when unique_violation then
        -- Тот же адрес только что занял кто-то другой — подбираем заново.
        if v_try >= 5 then raise; end if;
      end;
    end loop;
  else
    select * into a from public.articles where id = p_id for update;
    if a.id is null or a.author_id <> v_me then
      raise exception 'Статья не найдена' using errcode = 'P0002';
    end if;
    update public.articles
    set title = v_title, author_name = v_name, author_url = v_url, content = v_content,
        description = v_desc, cover = w.cover, updated_at = now()
    where id = p_id
    returning * into a;
  end if;
  return json_build_object('id', a.id, 'slug', a.slug);
end;
$$;

/** Статья по адресу — для страницы статьи и мгновенного просмотра (можно и без входа). Скрытая — только автору и команде. */
create or replace function public.article_get(p_slug text)
returns json
language sql
stable
security definer
set search_path = ''
as $$
  select json_build_object(
    'id', a.id, 'slug', a.slug, 'title', a.title, 'author_name', a.author_name, 'author_url', a.author_url,
    'content', a.content, 'description', a.description, 'cover', a.cover, 'views', a.views,
    'created_at', a.created_at, 'updated_at', a.updated_at,
    'mine', a.author_id = (select auth.uid()),
    'hidden', a.hidden_at is not null,
    'moderator', private.is_app_owner())
  from public.articles a
  where lower(a.slug) = lower(left(coalesce(p_slug, ''), 160))
    and (a.hidden_at is null or a.author_id = (select auth.uid()) or private.is_app_owner())
  limit 1;
$$;

/** +1 просмотр (сама страница зовёт один раз за сеанс; свои просмотры автор не накручивает). */
create or replace function public.article_view(p_slug text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.articles set views = views + 1
  where lower(slug) = lower(left(coalesce(p_slug, ''), 160)) and hidden_at is null
    and author_id is distinct from (select auth.uid());
$$;

/** Карточки статей для ссылок в чатах (до 50 за раз). */
create or replace function public.article_cards(p_slugs text[])
returns table (slug text, title text, description text, cover text, author_name text, views integer, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select a.slug, a.title, a.description, a.cover, a.author_name, a.views, a.created_at
  from public.articles a
  where lower(a.slug) in (select lower(s) from unnest((coalesce(p_slugs, '{}'::text[]))[1:50]) s)
    and (a.hidden_at is null or a.author_id = (select auth.uid()));
$$;

/** Мои статьи — новые сверху. */
create or replace function public.my_articles(p_limit integer default 50, p_offset integer default 0)
returns table (id uuid, slug text, title text, description text, cover text, views integer,
               created_at timestamptz, updated_at timestamptz, hidden boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.slug, a.title, a.description, a.cover, a.views, a.created_at, a.updated_at, a.hidden_at is not null
  from public.articles a
  where a.author_id = (select auth.uid())
  order by a.created_at desc, a.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
$$;

/** Удалить свою статью. Возвращает пути её картинок — приложение удалит файлы из хранилища. */
create or replace function public.article_delete(p_id uuid)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.articles;
begin
  delete from public.articles where id = p_id and author_id = (select auth.uid()) returning * into a;
  if a.id is null then
    raise exception 'Статья не найдена' using errcode = 'P0002';
  end if;
  return array(select distinct m[1] from regexp_matches(a.content::text,
    '"src": ?"([0-9a-f-]{36}\.(?:webp|jpg|png|gif))"', 'g') m);
end;
$$;

/** Модерация: команда СКАМ скрывает статью (по жалобе) или возвращает её. Автор свою скрытую видит с пометкой. */
create or replace function public.article_hide(p_id uuid, p_on boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_app_owner() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.articles set hidden_at = case when p_on then coalesce(hidden_at, now()) end where id = p_id;
  if not found then
    raise exception 'Статья не найдена' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function private.article_slug_base(text) from public, anon, authenticated;
revoke all on function private.article_walk(jsonb, uuid, int, int, text, text) from public, anon, authenticated;
revoke all on function public.article_image_slot(text) from public, anon, authenticated;
revoke all on function private.article_image_mine(text) from public, anon;
grant execute on function public.article_image_slot(text) to authenticated;
-- Политики хранилища вызываются от имени пользователя — ему нужно право на функцию проверки.
grant execute on function private.article_image_mine(text) to authenticated;
revoke all on function public.article_save(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.article_get(text) from public, anon, authenticated;
revoke all on function public.article_view(text) from public, anon, authenticated;
revoke all on function public.article_cards(text[]) from public, anon, authenticated;
revoke all on function public.my_articles(integer, integer) from public, anon, authenticated;
revoke all on function public.article_delete(uuid) from public, anon, authenticated;
revoke all on function public.article_hide(uuid, boolean) from public, anon, authenticated;
grant execute on function public.article_get(text) to anon, authenticated;
grant execute on function public.article_view(text) to anon, authenticated;
grant execute on function public.article_save(uuid, text, text, text, jsonb) to authenticated;
grant execute on function public.article_cards(text[]) to authenticated;
grant execute on function public.my_articles(integer, integer) to authenticated;
grant execute on function public.article_delete(uuid) to authenticated;
grant execute on function public.article_hide(uuid, boolean) to authenticated;

-- ===========================================================================
-- Опросы
-- ===========================================================================

-- Новый вид сообщения 'poll' — опрос в чатах без сквозного шифрования (канал, бот): вопрос в body.
-- В личных чатах, группах и «Избранном» опрос — обычное зашифрованное сообщение (kind = 'e2e').
alter table public.messages drop constraint if exists messages_kind_check;
alter table public.messages add constraint messages_kind_check
  check (kind in ('text', 'system', 'sticker', 'voice', 'video_note', 'e2e', 'media', 'call', 'poll'));

alter table public.messages drop constraint if exists messages_body_shape;
alter table public.messages add constraint messages_body_shape check (
  (deleted_at is not null and body = '')
  or (deleted_at is null and kind in ('text', 'system') and char_length(btrim(body)) between 1 and 4000)
  or (deleted_at is null and kind in ('sticker', 'voice', 'video_note') and char_length(body) <= 16)
  or (deleted_at is null and kind in ('e2e', 'call') and body = '')
  or (deleted_at is null and kind = 'media' and char_length(body) <= 4000)
  or (deleted_at is null and kind = 'poll' and char_length(btrim(body)) between 1 and 255)
);

alter table public.messages drop constraint if exists messages_media_shape;
alter table public.messages add constraint messages_media_shape check (
  deleted_at is not null
  or (kind in ('text', 'system', 'e2e', 'media', 'call', 'poll')
      and sticker is null and media_path is null and media_mime is null and duration_ms is null and waveform is null)
  or (kind = 'sticker' and sticker ~ '^[a-z0-9_]{1,32}/[a-z0-9_]{1,32}$'
      and media_path is null and media_mime is null and duration_ms is null and waveform is null)
  or (kind in ('voice', 'video_note') and sticker is null
      and media_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(webm|ogg|m4a|mp4)$'
      and duration_ms between 300 and case when kind = 'video_note' then 61000 else 600000 end
      and (waveform is null or cardinality(waveform) <= 100)
      and ((kind = 'voice' and media_mime in ('audio/webm', 'audio/ogg', 'audio/mp4'))
           or (kind = 'video_note' and media_mime in ('video/webm', 'video/mp4'))))
);

create table if not exists public.polls (
  message_id uuid primary key references public.messages (id) on delete cascade,
  chat_id uuid not null references public.chats (id) on delete cascade,
  author_id uuid references public.profiles (id) on delete set null,
  -- Тексты вариантов — только в чатах без сквозного шифрования; в зашифрованных они внутри сообщения.
  options text[],
  n smallint not null,
  multiple boolean not null default false,
  anonymous boolean not null default true,
  quiz boolean not null default false,
  counts integer[] not null,
  voters integer not null default 0,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint polls_n check (n between 2 and 12),
  constraint polls_options_shape check (options is null or cardinality(options) = n),
  constraint polls_counts_shape check (cardinality(counts) = n),
  constraint polls_quiz_single check (not (quiz and multiple))
);
create index if not exists polls_chat_idx on public.polls (chat_id);
alter table public.polls enable row level security;
revoke all on public.polls from public, anon, authenticated;
-- Читать строку опроса (числа голосов) могут участники чата — это нужно для живого обновления (Realtime).
grant select on public.polls to authenticated;
create policy "polls: members read" on public.polls for select to authenticated
  using (private.is_chat_member(chat_id));

-- Правильный ответ и пояснение викторины — отдельно: отдаются только тем, кто уже ответил (или когда опрос закрыт).
create table if not exists private.poll_answers (
  message_id uuid primary key references public.polls (message_id) on delete cascade,
  correct smallint not null,
  solution text
);

-- Кто за что голосовал. Закрыта: в анонимном опросе её не видит никто, в открытом — участники через poll_voters.
create table if not exists private.poll_votes (
  message_id uuid not null references public.polls (message_id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  option smallint not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, option)
);
create index if not exists poll_votes_user_idx on private.poll_votes (user_id);
create index if not exists poll_votes_recent_idx on private.poll_votes (message_id, created_at desc);
revoke all on private.poll_answers, private.poll_votes from public, anon, authenticated;

-- Изменения опросов (числа голосов, закрытие) — в Realtime, как сообщения и реакции.
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'polls') then
    alter publication supabase_realtime add table public.polls;
  end if;
end $$;

/** Кто может закрыть опрос: автор, а в группе или канале — администратор с правом удалять или изменять сообщения. */
create or replace function private.poll_can_close(p public.polls)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p.closed_at is null and (
    p.author_id = (select auth.uid())
    or private.has_right(p.chat_id, 'delete')
    or private.has_right(p.chat_id, 'edit'));
$$;

/** Состояние опроса для того, кто спрашивает: числа, свой голос, ответ викторины (после голосования), последние голосовавшие. */
create or replace function private.poll_json(p public.polls)
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_mine smallint[];
  v_open boolean;
  a private.poll_answers;
begin
  select coalesce(array_agg(v.option order by v.option), '{}') into v_mine
  from private.poll_votes v where v.message_id = p.message_id and v.user_id = v_me;
  v_open := cardinality(v_mine) > 0 or p.closed_at is not null;
  if p.quiz and v_open then
    select * into a from private.poll_answers where message_id = p.message_id;
  end if;
  return json_build_object(
    'id', p.message_id, 'chat_id', p.chat_id, 'n', p.n, 'options', p.options,
    'multiple', p.multiple, 'anonymous', p.anonymous, 'quiz', p.quiz,
    'counts', p.counts, 'voters', p.voters, 'closed', p.closed_at is not null,
    'mine', v_mine,
    'correct', a.correct, 'solution', a.solution,
    'recent', case when not p.anonymous then (
      select coalesce(json_agg(s.user_id order by s.t desc), '[]')
      from (select v.user_id, max(v.created_at) as t from private.poll_votes v
            where v.message_id = p.message_id group by v.user_id order by 2 desc limit 3) s) end,
    'can_close', private.poll_can_close(p),
    'can_vote', p.closed_at is null and private.is_chat_member(p.chat_id));
end;
$$;

/** Пересчитать числа голосов опроса. */
create or replace function private.poll_recount(p_message uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.polls p
  set counts = (select array_agg(coalesce(c.k, 0)::int order by i.i)
                from generate_series(0, p.n - 1) i(i)
                left join (select v.option, count(*) as k from private.poll_votes v
                           where v.message_id = p_message group by v.option) c on c.option = i.i),
      voters = (select count(distinct v.user_id) from private.poll_votes v where v.message_id = p_message),
      updated_at = now()
  where p.message_id = p_message;
$$;

/**
 * Отправить опрос. В зашифрованном чате (личный, группа, «Избранное») — p_enc/p_key_id (вопрос и варианты внутри)
 * и p_count; в канале и чате с ботом — p_question и p_options открытым текстом. Возвращает строку сообщения.
 */
create or replace function public.send_poll(
  p_id uuid, p_chat uuid, p_question text, p_options text[], p_enc text, p_key_id uuid, p_count integer,
  p_multiple boolean, p_anonymous boolean, p_quiz boolean, p_correct integer, p_solution text)
returns setof public.messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_kind text;
  v_e2e boolean;
  v_q text;
  v_opts text[];
  v_n int;
  v_multi boolean := coalesce(p_multiple, false);
  v_anon boolean := coalesce(p_anonymous, true);
  v_quiz boolean := coalesce(p_quiz, false);
  v_sol text := nullif(btrim(coalesce(p_solution, '')), '');
  m public.messages;
begin
  perform private.require_registered();
  select c.kind into v_kind from public.chats c where c.id = p_chat;
  if v_kind is null or not private.can_post(p_chat) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_id is not null then
    select * into m from public.messages where id = p_id;
    if m.id is not null then
      -- Повторная отправка того же опроса (связь оборвалась после записи) — отдаём уже записанное.
      if m.user_id = v_me and m.chat_id = p_chat and exists (select 1 from public.polls where message_id = p_id) then
        return next m;
        return;
      end if;
      raise exception 'duplicate message id' using errcode = '23505';
    end if;
  end if;
  v_e2e := v_kind in ('group', 'direct', 'saved');
  if v_kind = 'channel' then v_anon := true; end if; -- в каналах опросы всегда анонимные, как в Telegram
  if v_quiz then v_multi := false; end if;
  if v_e2e then
    if p_enc is null or p_key_id is null or char_length(p_enc) not between 24 and 65536
       or not private.key_in_chat(p_key_id, p_chat) then
      raise exception 'bad encrypted poll' using errcode = '22023';
    end if;
    v_n := p_count;
  else
    v_q := btrim(regexp_replace(coalesce(p_question, ''), '[\r\n\t]+', ' ', 'g'));
    if char_length(v_q) not between 1 and 255 then
      raise exception 'Вопрос — от 1 до 255 символов' using errcode = '22023';
    end if;
    select array_agg(btrim(regexp_replace(o, '\s+', ' ', 'g')) order by ord) into v_opts
    from unnest(p_options) with ordinality t(o, ord);
    if exists (select 1 from unnest(v_opts) o where o is null or char_length(o) not between 1 and 100) then
      raise exception 'Каждый вариант — от 1 до 100 символов' using errcode = '22023';
    end if;
    v_n := cardinality(v_opts);
  end if;
  if v_n is null or v_n not between 2 and 12 then
    raise exception 'В опросе от 2 до 12 вариантов' using errcode = '22023';
  end if;
  if v_quiz and (p_correct is null or p_correct not between 0 and v_n - 1) then
    raise exception 'Отметьте правильный ответ' using errcode = '22023';
  end if;
  if v_sol is not null and (not v_quiz or char_length(v_sol) > case when v_e2e then 4000 else 200 end) then
    raise exception 'Пояснение — только у викторины, до 200 символов' using errcode = '22023';
  end if;

  insert into public.messages (id, chat_id, user_id, kind, body, enc, key_id)
  values (coalesce(p_id, gen_random_uuid()), p_chat, v_me,
          case when v_e2e then 'e2e' else 'poll' end,
          case when v_e2e then '' else v_q end,
          case when v_e2e then p_enc end,
          case when v_e2e then p_key_id end)
  returning * into m;
  insert into public.polls (message_id, chat_id, author_id, options, n, multiple, anonymous, quiz, counts)
  values (m.id, p_chat, v_me, v_opts, v_n, v_multi, v_anon, v_quiz, array_fill(0, array[v_n]));
  if v_quiz then
    insert into private.poll_answers (message_id, correct, solution) values (m.id, p_correct, v_sol);
  end if;
  return next m;
end;
$$;

/** Проголосовать (p_options — номера вариантов с 0). Пустой массив — отменить голос (кроме викторины). */
create or replace function public.poll_vote(p_message uuid, p_options integer[])
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  p public.polls;
  v_opts int[];
  v_had boolean;
begin
  perform private.require_registered();
  select * into p from public.polls where message_id = p_message for update;
  if p.message_id is null or not private.is_chat_member(p.chat_id)
     or exists (select 1 from public.messages m where m.id = p_message and m.deleted_at is not null) then
    raise exception 'Опрос не найден' using errcode = 'P0002';
  end if;
  if p.closed_at is not null then
    raise exception 'Опрос уже завершён' using errcode = '55000';
  end if;
  v_opts := array(select distinct x from unnest(coalesce(p_options, '{}'::int[])) x where x is not null order by x);
  if exists (select 1 from unnest(v_opts) x where x < 0 or x >= p.n) then
    raise exception 'Нет такого варианта' using errcode = '22023';
  end if;
  if cardinality(v_opts) > 1 and not p.multiple then
    raise exception 'Здесь можно выбрать только один вариант' using errcode = '22023';
  end if;
  v_had := exists (select 1 from private.poll_votes v where v.message_id = p_message and v.user_id = v_me);
  if p.quiz and v_had then
    raise exception 'Ответ в викторине изменить нельзя' using errcode = '55000';
  end if;
  if p.quiz and cardinality(v_opts) = 0 then
    raise exception 'Выберите ответ' using errcode = '22023';
  end if;
  delete from private.poll_votes where message_id = p_message and user_id = v_me;
  insert into private.poll_votes (message_id, user_id, option)
  select p_message, v_me, x from unnest(v_opts) x;
  perform private.poll_recount(p_message);
  -- Голос в опросе — та же активность в группе или канале, что и реакция (для супер-реакций).
  if cardinality(v_opts) > 0 then
    perform private.note_activity(v_me, p.chat_id, false, true);
  end if;
  select * into p from public.polls where message_id = p_message;
  return private.poll_json(p);
end;
$$;

/** Завершить опрос: голосовать больше нельзя, у викторины всем видно правильный ответ. */
create or replace function public.poll_close(p_message uuid)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.polls;
begin
  select * into p from public.polls where message_id = p_message for update;
  if p.message_id is null or not private.is_chat_member(p.chat_id) then
    raise exception 'Опрос не найден' using errcode = 'P0002';
  end if;
  if p.closed_at is not null then
    return private.poll_json(p);
  end if;
  if not private.poll_can_close(p) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.polls set closed_at = now(), updated_at = now() where message_id = p_message returning * into p;
  return private.poll_json(p);
end;
$$;

/** Опросы по id сообщений (до 200): участникам чата и читателям публичного канала. */
create or replace function public.poll_state(p_ids uuid[])
returns setof json
language sql
stable
security definer
set search_path = ''
as $$
  select private.poll_json(p)
  from public.polls p
  where p.message_id = any ((coalesce(p_ids, '{}'::uuid[]))[1:200])
    and (private.is_chat_member(p.chat_id) or private.is_public_channel(p.chat_id));
$$;

/** Кто голосовал в открытом опросе: id людей и номер варианта (новые сверху). */
create or replace function public.poll_voters(p_message uuid, p_option integer default null,
  p_limit integer default 100, p_offset integer default 0)
returns table (user_id uuid, option smallint, voted_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  p public.polls;
begin
  select * into p from public.polls where message_id = p_message;
  if p.message_id is null or not private.is_chat_member(p.chat_id) then
    raise exception 'Опрос не найден' using errcode = 'P0002';
  end if;
  if p.anonymous then
    raise exception 'Это анонимный опрос' using errcode = '42501';
  end if;
  return query
    select v.user_id, v.option, v.created_at
    from private.poll_votes v
    where v.message_id = p_message and (p_option is null or v.option = p_option)
    order by v.created_at desc, v.user_id
    limit least(greatest(coalesce(p_limit, 100), 1), 500) offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

-- Удалили сообщение с опросом — удаляем и опрос с голосами.
create or replace function private.messages_poll_gone()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.polls where message_id = new.id;
  return null;
end;
$$;
create or replace trigger messages_poll_gone after update of deleted_at on public.messages
  for each row when (new.deleted_at is not null and old.deleted_at is null)
  execute function private.messages_poll_gone();

revoke all on function private.poll_can_close(public.polls) from public, anon, authenticated;
revoke all on function private.poll_json(public.polls) from public, anon, authenticated;
revoke all on function private.poll_recount(uuid) from public, anon, authenticated;
revoke all on function private.messages_poll_gone() from public, anon, authenticated;
revoke all on function public.send_poll(uuid, uuid, text, text[], text, uuid, integer, boolean, boolean, boolean, integer, text)
  from public, anon, authenticated;
revoke all on function public.poll_vote(uuid, integer[]) from public, anon, authenticated;
revoke all on function public.poll_close(uuid) from public, anon, authenticated;
revoke all on function public.poll_state(uuid[]) from public, anon, authenticated;
revoke all on function public.poll_voters(uuid, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.send_poll(uuid, uuid, text, text[], text, uuid, integer, boolean, boolean, boolean, integer, text)
  to authenticated;
grant execute on function public.poll_vote(uuid, integer[]) to authenticated;
grant execute on function public.poll_close(uuid) to authenticated;
grant execute on function public.poll_state(uuid[]) to authenticated;
grant execute on function public.poll_voters(uuid, integer, integer, integer) to authenticated;

-- ===========================================================================
-- Бот: рассказывает про статьи и опросы, отвечает на опрос и на ссылку на статью
-- ===========================================================================

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
    reply := E'Я умею немного, но честно:\n• «привет» — поздороваюсь;\n• «помощь» — это сообщение;\n• «стикеры» — расскажу про Голубя свободы и свои наборы;\n• «эмодзи» — расскажу про свои эмодзи, реакции и супер-реакции;\n• «избранное» — расскажу, как сохранять сообщения;\n• «галочка» — расскажу, что значит официальная галочка;\n• «шифрование» — расскажу, как защищена переписка;\n• «звонки» — расскажу про звонки;\n• «статьи» — расскажу, как написать статью, как в Telegraph;\n• «опросы» — расскажу про опросы и викторины;\n• «это развод?» — объясню, почему нет.\n\nА ещё подскажу по СКАМ:\n• «Новый чат» — написать человеку по имени или @username, создать группу или канал;\n• стикеры и эмодзи — кнопка со смайликом у поля ввода; наберите эмодзи — подходящие стикеры появятся сами; свои наборы — кнопка «+» в панели;\n• голосовое — удерживайте микрофон справа от поля ввода и отпустите, чтобы отправить; уведите палец влево — отмена, вверх — запись без рук;\n• кружочек — коротко нажмите на микрофон, он станет камерой, дальше так же: удерживайте;\n• скрепка 📎 слева от поля ввода — фото, видео, гифки и файлы до 50 МБ (можно просто перетащить или вставить из буфера), а ещё опрос и статья;\n• реакции — наведите на сообщение или коснитесь его (на телефоне — долгое нажатие), «+» — все реакции и свои эмодзи;\n• ответить — стрелка ↩ над сообщением или правый клик → «Ответить» (на телефоне — смахните сообщение влево);\n• переслать — стрелка ↪ или «Выбрать» несколько сообщений и «Переслать»;\n• сохранить — правый клик → «В избранное»: всё сохранённое лежит в чате «Избранное»;\n• звонки — трубка 📞 и камера 📹 в шапке личного чата или группы: голос, видео и демонстрация экрана, как в Discord;\n• имя, @username, фото, тема и пароль шифрования — в профиле внизу слева.';
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

create or replace trigger messages_bot_reply after insert on public.messages
  for each row when (new.kind in ('text', 'sticker', 'voice', 'video_note', 'media', 'poll') and new.user_id is not null)
  execute function private.bot_reply();
revoke all on function private.bot_reply() from public, anon, authenticated;

notify pgrst, 'reload schema';
