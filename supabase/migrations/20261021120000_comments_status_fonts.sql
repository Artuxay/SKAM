-- СКАМ 0.5.1: комментарии к постам каналов, эмодзи-статус у имени, шрифты в статьях,
-- бакет моделей распознавания речи (расшифровка голосовых идёт на устройстве).
--
-- Комментарии — как в Telegram с группой обсуждения, только без отдельной группы: комментарий — обычное
-- сообщение канала с thread_id = id поста. Писать могут подписчики, если владелец или админ с правом «info»
-- включил комментарии (chats.comments, по умолчанию выключены). Лента канала, список чатов, непрочитанные
-- и последний пост личного канала комментарии не учитывают. Комментарии видят подписчики, а у публичного
-- канала — все (через comment_feed, как channel_feed). Авторы комментариев видны всем, кто видит обсуждение:
-- имя, @username, фото и эмодзи-статус — через private.profile_card (профиль целиком по-прежнему только
-- при общем чате).
--
-- Эмодзи-статус — эмодзи у имени, как в Telegram: обычное или своё (c:набор/эмодзи), на срок или навсегда.
-- Хранится в профиле, видят все, кто видит имя. Ставится только через set_emoji_status.
--
-- Шрифты статей: шрифт всей статьи (articles.font) и шрифт фрагмента — узел {tag: 'span', attrs: {font}}.

-- ===========================================================================
-- Эмодзи-статус
-- ===========================================================================

alter table public.profiles
  add column if not exists emoji_status text,
  add column if not exists emoji_status_until timestamptz;
alter table public.profiles drop constraint if exists profiles_emoji_status_shape;
alter table public.profiles add constraint profiles_emoji_status_shape check (
  (emoji_status is null and emoji_status_until is null)
  or emoji_status ~ '^c:u[0-9a-f]{11}/[a-z0-9]{10}$'
  or (char_length(emoji_status) between 1 and 16
      and emoji_status !~ '[A-Za-zА-Яа-яЁё[:space:]<>:/\\"''`]')
);
comment on column public.profiles.emoji_status is
  'Эмодзи у имени (0.5.1): обычное эмодзи или c:набор/эмодзи. Ставится через set_emoji_status.';
comment on column public.profiles.emoji_status_until is 'До какого момента показывать статус; null — навсегда.';

-- В Realtime профиль уходит с явным списком колонок (с 0.4.1, без времени захода) — добавляем статус.
alter publication supabase_realtime drop table public.profiles;
alter publication supabase_realtime add table public.profiles
  (id, avatar_path, color, created_at, updated_at, first_name, last_name, username, username_optional, verified, bio,
   emoji_status, emoji_status_until);

/** Поставить (или снять — p_emoji null) свой эмодзи-статус. p_until null — навсегда. */
create or replace function public.set_emoji_status(p_emoji text, p_until timestamptz default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v text := nullif(btrim(coalesce(p_emoji, '')), '');
  v_ref text;
begin
  perform private.require_registered();
  if v is null then
    update public.profiles set emoji_status = null, emoji_status_until = null where id = (select auth.uid());
    return;
  end if;
  if v like 'c:%' then
    v_ref := substr(v, 3);
    if not exists (
      select 1 from public.stickers s join public.sticker_packs p on p.id = s.pack_id
      where p.kind = 'emoji' and s.pack_id = split_part(v_ref, '/', 1) and s.id = split_part(v_ref, '/', 2)
    ) then
      raise exception 'Этого эмодзи больше нет — его удалил автор набора' using errcode = 'P0002';
    end if;
  end if;
  if p_until is not null and (p_until <= now() or p_until > now() + interval '400 days') then
    raise exception 'Срок статуса — от минуты до года' using errcode = '22023';
  end if;
  update public.profiles set emoji_status = v, emoji_status_until = p_until where id = (select auth.uid());
end;
$$;

/** Карточка человека для тех, кто видит его имя без общего чата (авторы комментариев): без «О себе» и времени. */
create or replace function private.profile_card(p public.profiles)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id, 'name', p.name, 'username', p.username, 'avatar_path', p.avatar_path, 'color', p.color,
    'verified', p.verified,
    'emoji_status', case when p.emoji_status_until is null or p.emoji_status_until > now() then p.emoji_status end,
    'emoji_status_until', case when p.emoji_status_until > now() then p.emoji_status_until end);
$$;

/** Карточки людей по id (до 200): имя, @username, фото, галочка и эмодзи-статус — то же, что видно в поиске. */
create or replace function public.profile_cards(p_ids uuid[])
returns table (id uuid, name text, username text, avatar_path text, color text, verified boolean,
               emoji_status text, emoji_status_until timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.name, p.username, p.avatar_path, p.color, p.verified,
         case when p.emoji_status_until is null or p.emoji_status_until > now() then p.emoji_status end,
         case when p.emoji_status_until > now() then p.emoji_status_until end
  from public.profiles p
  where p.id = any ((coalesce(p_ids, '{}'::uuid[]))[1:200])
    and p.first_name is not null
    and (select auth.uid()) is not null;
$$;

-- ===========================================================================
-- Комментарии
-- ===========================================================================

alter table public.chats add column if not exists comments boolean not null default false;
comment on column public.chats.comments is 'Комментарии к постам канала включены (0.5.1). Включает владелец или админ с правом info.';
grant select (comments) on public.chats to authenticated;

alter table public.messages add column if not exists thread_id uuid references public.messages (id) on delete cascade;
comment on column public.messages.thread_id is 'Комментарий к посту канала: id поста (0.5.1). У постов и обычных сообщений — null.';
grant insert (thread_id) on public.messages to authenticated;
alter table public.messages drop constraint if exists messages_thread_shape;
alter table public.messages add constraint messages_thread_shape check (
  thread_id is null or (thread_id <> id and kind in ('text', 'sticker', 'voice', 'video_note', 'media'))
);
create index if not exists messages_thread_idx on public.messages (thread_id, created_at, id) where thread_id is not null;

/** Можно ли мне прокомментировать этот пост: канал с включёнными комментариями, я подписчик, пост живой. */
create or replace function private.can_comment(p_chat uuid, p_post uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.chats c
    join public.chat_members m on m.chat_id = c.id and m.user_id = (select auth.uid())
    join public.messages p on p.id = p_post and p.chat_id = c.id
    where c.id = p_chat and c.kind = 'channel' and c.comments
      and p.thread_id is null and p.deleted_at is null and p.kind not in ('system', 'call')
  );
$$;

/** Можно ли мне писать комментарии в этом канале вообще (для загрузки файлов комментария в хранилище). */
create or replace function private.comments_open(p_chat uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.chats c
    join public.chat_members m on m.chat_id = c.id and m.user_id = (select auth.uid())
    where c.id = p_chat and c.kind = 'channel' and c.comments
  );
$$;

/** Ответ — на сообщение того же чата и той же ветки: на пост — только из ленты, на комментарий — только из его обсуждения. */
create or replace function private.reply_ok(p_reply uuid, p_chat uuid, p_thread uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.messages r
    where r.id = p_reply and r.chat_id = p_chat
      and (case when p_thread is null then r.thread_id is null else r.thread_id = p_thread end)
  );
$$;

revoke all on function private.can_comment(uuid, uuid) from public, anon;
revoke all on function private.comments_open(uuid) from public, anon;
revoke all on function private.reply_ok(uuid, uuid, uuid) from public, anon;
-- Политики выполняются от имени пользователя — ему нужно право вызывать функции проверки.
grant execute on function private.can_comment(uuid, uuid) to authenticated;
grant execute on function private.comments_open(uuid) to authenticated;
grant execute on function private.reply_ok(uuid, uuid, uuid) to authenticated;

drop policy if exists "messages: members write" on public.messages;
create policy "messages: members write" on public.messages for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and deleted_at is null
    and kind = any (array['text', 'sticker', 'voice', 'video_note', 'e2e', 'media'])
    and (media_path is null
         or (split_part(media_path, '/', 1) = chat_id::text and split_part(media_path, '/', 2) = (select auth.uid())::text))
    and (kind <> 'media' or private.files_owned(files, chat_id))
    and (kind <> 'e2e' or private.key_in_chat(key_id, chat_id))
    and (reply_to is null or private.reply_ok(reply_to, chat_id, thread_id))
    and (case when thread_id is null then private.can_post(chat_id) else private.can_comment(chat_id, thread_id) end)
    and private.is_registered()
  );

-- Файлы комментариев (фото, голосовые, кружочки) — в тот же бакет media, путь канал/я/… (копия — server/managed.sql).
drop policy if exists "media: upload own" on storage.objects;
create policy "media: upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and split_part(name, '/', 2) = (select auth.uid())::text
              and (private.can_post(private.path_chat(name)) or private.comments_open(private.path_chat(name)))
              and private.is_registered()
              and private.media_size_ok(metadata));

-- Подпись автора в канале — только у постов, у комментариев автор и так виден.
create or replace function private.messages_stamp()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.edited_at := null;
  new.signature := null;
  if new.user_id is not null and new.kind <> 'system' and new.thread_id is null
     and exists (select 1 from public.chats c where c.id = new.chat_id and c.kind = 'channel' and c.sign_messages) then
    select left(p.name, 128) into new.signature from public.profiles p where p.id = new.user_id;
  end if;
  return new;
end;
$$;

/** Включить или выключить комментарии в канале (владелец или админ с правом «Изменение профиля канала»). */
create or replace function public.set_chat_comments(p_chat uuid, p_on boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_registered();
  if not exists (select 1 from public.chats where id = p_chat and kind = 'channel')
     or not private.has_right(p_chat, 'info') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.chats set comments = coalesce(p_on, false) where id = p_chat;
end;
$$;

/**
 * Комментарии под постами: включены ли, могу ли я писать, сколько комментариев у каждого поста,
 * когда последний и кто трое последних (с карточками). До 200 постов за раз.
 */
create or replace function public.comment_stats(p_chat uuid, p_ids uuid[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with ok as (
    select c.comments as on_, private.is_chat_member(p_chat) as member
    from public.chats c
    where c.id = p_chat and c.kind = 'channel'
      and (select auth.uid()) is not null
      and (private.is_chat_member(p_chat) or private.is_public_channel(p_chat))
  ),
  posts as (
    select p.id from public.messages p, ok
    where ok.on_ and p.chat_id = p_chat and p.thread_id is null
      and p.id = any ((coalesce(p_ids, '{}'::uuid[]))[1:200])
  ),
  st as (
    select x.thread_id as id, count(*)::int as n, max(x.created_at) as last
    from public.messages x
    join posts on posts.id = x.thread_id
    where x.deleted_at is null
    group by x.thread_id
  ),
  who as (
    select t.thread_id, t.user_id, t.at,
           row_number() over (partition by t.thread_id order by t.at desc, t.user_id) as rn
    from (
      select x.thread_id, x.user_id, max(x.created_at) as at
      from public.messages x
      join posts on posts.id = x.thread_id
      where x.deleted_at is null and x.user_id is not null
      group by x.thread_id, x.user_id
    ) t
  ),
  rc as (
    select thread_id as id, array_agg(user_id order by at desc, user_id) as uids
    from who where rn <= 3 group by thread_id
  )
  select jsonb_build_object(
    'on', coalesce((select on_ from ok), false),
    'can', coalesce((select on_ and member from ok), false),
    'posts', coalesce((
      select jsonb_object_agg(st.id, jsonb_build_object('n', st.n, 'last', st.last, 'recent', coalesce(to_jsonb(rc.uids), '[]'::jsonb)))
      from st left join rc on rc.id = st.id), '{}'::jsonb),
    'people', coalesce((
      select jsonb_object_agg(p.id, private.profile_card(p))
      from public.profiles p
      where p.id in (select unnest(uids) from rc)), '{}'::jsonb)
  );
$$;

/**
 * Обсуждение поста (новые сначала, страницами): сообщения, реакции числами (для тех, кто не подписан)
 * и карточка автора. Подписчикам и, у публичного канала, всем — пока комментарии включены.
 */
create or replace function public.comment_feed(p_post uuid, p_before timestamptz default null, p_before_id uuid default null,
  p_limit integer default 50)
returns table (id uuid, chat_id uuid, user_id uuid, kind text, body text, created_at timestamptz, deleted_at timestamptz,
               sticker text, media_path text, media_mime text, duration_ms integer, waveform smallint[], enc text, key_id uuid,
               files jsonb, reply_to uuid, fwd jsonb, call_id uuid, edited_at timestamptz, signature text, thread_id uuid,
               reacts jsonb, author jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select m.id, m.chat_id, m.user_id, m.kind, m.body, m.created_at, m.deleted_at, m.sticker, m.media_path, m.media_mime,
         m.duration_ms, m.waveform, m.enc, m.key_id, m.files, m.reply_to, m.fwd, m.call_id, m.edited_at, m.signature,
         m.thread_id,
         (select jsonb_object_agg(x.k, x.n)
            from (select r.emoji || case when r.super then '*' else '' end as k, count(*) as n
                  from public.reactions r where r.message_id = m.id group by 1) x),
         (select private.profile_card(p) from public.profiles p where p.id = m.user_id)
  from public.messages post
  join public.chats c on c.id = post.chat_id and c.kind = 'channel' and c.comments
  join public.messages m on m.thread_id = post.id
  where post.id = p_post
    and post.thread_id is null
    and (select auth.uid()) is not null
    and (private.is_chat_member(c.id) or private.is_public_channel(c.id))
    and (p_before is null or m.created_at < p_before
         or (m.created_at = p_before and p_before_id is not null and m.id < p_before_id))
  order by m.created_at desc, m.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;

/** Изменить пост канала — или свой комментарий, пока комментарии открыты. */
create or replace function public.edit_message(p_id uuid, p_body text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.messages;
  b text := coalesce(p_body, '');
begin
  perform private.require_registered();
  select * into m from public.messages where id = p_id;
  if m.id is null or m.deleted_at is not null or m.kind not in ('text', 'media')
     or not private.is_channel(m.chat_id)
     or not (case when m.thread_id is null
                  then (m.user_id = (select auth.uid()) and private.can_post(m.chat_id))
                       or private.has_right(m.chat_id, 'edit')
                  else m.user_id = (select auth.uid()) and private.can_comment(m.chat_id, m.thread_id) end) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if char_length(b) > 4000 then
    raise exception 'too long' using errcode = '22001';
  end if;
  if m.kind = 'text' and char_length(btrim(b)) = 0 then
    raise exception 'empty' using errcode = '22023';
  end if;
  if b = m.body then return; end if;
  update public.messages set body = b, edited_at = now() where id = p_id;
end;
$$;

-- Лента канала до подписки — без комментариев.
create or replace function public.channel_feed(p_chat uuid, p_before timestamptz default null, p_before_id uuid default null,
  p_limit integer default 50)
returns table (id uuid, chat_id uuid, user_id uuid, kind text, body text, created_at timestamptz, deleted_at timestamptz,
               sticker text, media_path text, media_mime text, duration_ms integer, waveform smallint[], enc text, key_id uuid,
               files jsonb, reply_to uuid, fwd jsonb, call_id uuid, edited_at timestamptz, signature text, reacts jsonb)
language sql
stable
security definer
set search_path = ''
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
    and m.thread_id is null
    and private.is_channel(p_chat)
    and (private.is_public_channel(p_chat) or private.is_chat_member(p_chat))
    and (p_before is null or m.created_at < p_before
         or (m.created_at = p_before and p_before_id is not null and m.id < p_before_id))
  order by m.created_at desc, m.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;

-- Последний пост личного канала в профиле — не комментарий.
create or replace function public.personal_channel(p_user uuid)
returns table (id uuid, name text, username text, avatar_path text, verified boolean, member_count integer, is_member boolean,
               post_id uuid, post_kind text, post_body text, post_at timestamptz, post_media_mime text, post_files jsonb,
               post_sticker text)
language sql
stable
security definer
set search_path = ''
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
    where m.chat_id = c.id and m.thread_id is null and m.deleted_at is null and m.kind <> 'system'
    order by m.created_at desc, m.id desc
    limit 1
  ) lm on true
  where pc.user_id = p_user
    and (select auth.uid()) is not null
    and not private.blocked_pair((select auth.uid()), p_user);
$$;

-- Список чатов: последнее сообщение и непрочитанные — без комментариев; новая колонка comments.
drop function if exists public.my_chats();
create function public.my_chats()
returns table (id uuid, kind text, name text, emoji text, invite_code text, is_default boolean, created_at timestamptz,
               role text, last_read_at timestamptz, member_count integer, peer_id uuid, unread integer, last_id uuid,
               last_body text, last_user_id uuid, last_kind text, last_at timestamptz, last_deleted boolean, last_enc text,
               last_key_id uuid, last_files jsonb, last_call jsonb, description text, username text, avatar_path text,
               sign_messages boolean, rights text[], verified boolean, comments boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.kind, c.name, c.emoji,
         -- Ссылку-приглашение канала видят только админы с правом приглашать.
         case when c.kind = 'channel' and not ('invite' = any (r.rights)) then null else c.invite_code end,
         c.is_default, c.created_at, cm.role, cm.last_read_at,
         (select count(*) from public.chat_members x where x.chat_id = c.id)::int,
         case when c.kind = 'direct' then
           (select x.user_id from public.chat_members x where x.chat_id = c.id and x.user_id <> cm.user_id limit 1)
         end,
         (select count(*) from public.messages m
           where m.chat_id = c.id and m.thread_id is null and m.created_at > cm.last_read_at
             and m.user_id is distinct from cm.user_id and m.deleted_at is null)::int,
         lm.id, left(lm.body, 200), lm.user_id, lm.kind, lm.created_at, lm.deleted_at is not null,
         lm.enc, lm.key_id, lm.files,
         (select jsonb_build_object('status', k.status, 'video', k.video,
                                    'dur', extract(epoch from (k.ended_at - k.answered_at))::int)
            from public.calls k where k.id = lm.call_id),
         c.description, c.username, c.avatar_path, c.sign_messages, r.rights,
         c.verified or c.kind = 'bot',
         c.comments
  from public.chat_members cm
  join public.chats c on c.id = cm.chat_id
  cross join lateral (
    select case cm.role
      when 'owner' then private.chat_rights_all(c.kind)
      when 'admin' then array(select x from unnest(private.chat_rights_all(c.kind)) x where x = any (cm.rights))
      else array[]::text[]
    end as rights
  ) r
  left join lateral (
    select m.id, m.body, m.user_id, m.kind, m.created_at, m.deleted_at, m.enc, m.key_id, m.files, m.call_id
    from public.messages m where m.chat_id = c.id and m.thread_id is null
    order by m.created_at desc, m.id desc limit 1
  ) lm on true
  where cm.user_id = (select auth.uid())
  order by coalesce(lm.created_at, c.created_at) desc;
$$;

-- ===========================================================================
-- Шрифты в статьях
-- ===========================================================================

alter table public.articles add column if not exists font text;
alter table public.articles drop constraint if exists articles_font_check;
alter table public.articles add constraint articles_font_check
  check (font is null or font in ('serif', 'sans', 'mono', 'hand', 'wide'));
comment on column public.articles.font is 'Шрифт всей статьи (0.5.1): serif | sans | mono | hand | wide; null — как раньше (с засечками).';

/**
 * Проверить содержимое статьи и собрать из него описание (первые ~200 символов текста) и обложку (первая картинка).
 * n — сколько узлов уже просмотрено (защита от огромных документов).
 * С 0.5.1 — ещё узел span с attrs.font: шрифт фрагмента.
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
                                  'b', 'i', 'u', 's', 'a', 'br', 'hr', 'figure', 'img', 'figcaption', 'span') then
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
        if not ((tag = 'a' and k = 'href') or (tag = 'img' and k = 'src') or (tag = 'span' and k = 'font')) then
          raise exception 'bad article attrs' using errcode = '22023';
        end if;
      end loop;
      if tag = 'a' and attrs ? 'href'
         and not (jsonb_typeof(attrs -> 'href') = 'string'
                  and (attrs ->> 'href') ~ '^(https?://|mailto:)\S+$' and char_length(attrs ->> 'href') <= 2048) then
        raise exception 'Ссылки в статье должны начинаться с https:// или http://' using errcode = '22023';
      end if;
      if tag = 'span' and attrs ? 'font'
         and not (jsonb_typeof(attrs -> 'font') = 'string' and (attrs ->> 'font') in ('serif', 'sans', 'mono', 'hand', 'wide')) then
        raise exception 'Неизвестный шрифт в статье' using errcode = '22023';
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

-- Новый параметр p_font: старую функцию убираем, иначе вызов с пятью параметрами станет неоднозначным.
-- Старые приложения (без p_font) попадают в новую функцию — шрифт тогда «как раньше» (null).
drop function if exists public.article_save(uuid, text, text, text, jsonb);
create or replace function public.article_save(
  p_id uuid, p_title text, p_author_name text, p_author_url text, p_content jsonb, p_font text default null)
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
  v_font text := case when p_font in ('sans', 'mono', 'hand', 'wide') then p_font end;
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
        insert into public.articles (slug, author_id, title, author_name, author_url, content, description, cover, font)
        values (v_slug, v_me, v_title, v_name, v_url, v_content, v_desc, w.cover, v_font)
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
        description = v_desc, cover = w.cover, font = v_font, updated_at = now()
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
    'created_at', a.created_at, 'updated_at', a.updated_at, 'font', a.font,
    'mine', a.author_id = (select auth.uid()),
    'hidden', a.hidden_at is not null,
    'moderator', private.is_app_owner())
  from public.articles a
  where lower(a.slug) = lower(left(coalesce(p_slug, ''), 160))
    and (a.hidden_at is null or a.author_id = (select auth.uid()) or private.is_app_owner())
  limit 1;
$$;

-- ===========================================================================
-- Модели распознавания речи (Whisper, ONNX) — публичный бакет, читают все, пишет только сервер.
-- Голос распознаётся в браузере: в бакете лежат только файлы модели, аудио и текст на сервер не уходят.
-- Файлы больше 40 МБ разрезаны на части (.part0, .part1…), список — models/<модель>/manifest.json.
-- ===========================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('models', 'models', true, null, null)
on conflict (id) do nothing;

-- ===========================================================================
-- Бот: новые ответы (правка текста функции на месте — остальное в ней не меняется)
-- ===========================================================================

do $bot$
declare
  d text := pg_get_functiondef('private.bot_canned(public.messages)'::regprocedure);
  before text := d;
begin
  if position('(коммент|обсужден)' in d) > 0 then
    return; -- уже обновлён
  end if;
  d := replace(d,
    $a$'Голосовое получил! Но слушать я пока не умею — я же бот 🙈 Напишите текстом, отвечу.'$a$,
    $b$'Голосовое получил! Слушать я не умею — я же бот 🙈 Но его можно прочитать: кнопка «Aa» у голосового превратит его в текст прямо на вашем устройстве. А мне лучше напишите — отвечу.'$b$);
  d := replace(d,
    $a$• «опросы» — расскажу про опросы и викторины;\n$a$,
    $b$• «опросы» — расскажу про опросы и викторины;\n• «комментарии» — расскажу про комментарии в каналах;\n• «статус» — расскажу про эмодзи-статус у имени;\n• «шрифты» — расскажу про шрифты в статьях;\n• «расшифровка голосовых» — расскажу, как превратить голосовое в текст;\n$b$);
  d := replace(d,
    $a$  elsif t ~ '(время захода|$a$,
    $b$  elsif t ~ '(коммент|обсужден)' then
    reply := E'💬 Комментарии в каналах — как в Telegram: под постом кнопка «Комментарии», за ней обсуждение с ответами, реакциями, стикерами, фото и голосовыми.\n\nПо умолчанию они выключены: владелец или админ канала включает их в «О канале» → переключатель «Комментарии». Писать могут подписчики, читать — все, кто видит канал. Свой комментарий можно изменить или удалить, а админ с правом удаления убирает любые.';
  elsif t ~ '(эмодзи[- ]?статус|статус)' then
    reply := E'✨ Эмодзи-статус — эмодзи рядом с вашим именем, как в Telegram. «Мой профиль» → «Эмодзи-статус» (или нажмите на эмодзи у своего имени): выберите обычное или своё эмодзи и срок — час, 2 часа, 8 часов, 2 дня или навсегда.\n\nСтатус видят все, кто видит ваше имя: в чатах, группах, комментариях и в профиле.';
  elsif t ~ '(шрифт|font)' then
    reply := E'🔤 Шрифты в статьях. Шрифт всей статьи — кнопка «Aa» в редакторе: с засечками, без засечек, моноширинный, рукописный или широкий. Шрифт кусочка текста — выделите его и нажмите «Aa» в панели над выделением.\n\nА читатель может подстроить шрифт и размер под себя: кнопка «Aa» вверху статьи — это запомнится на его устройстве.';
  elsif t ~ '(расшифр\S* голос|голосов\S* в текст|текст\S* голосов|транскри|распозна)' then
    reply := E'📝 Расшифровка голосовых: нажмите «Aa» рядом с голосовым или кружочком — появится текст.\n\nРаспознаёт нейросеть Whisper прямо на вашем устройстве: голос никуда не уходит, сквозное шифрование не нарушается. В первый раз скачается модель (около 80 МБ с нашего сервера), дальше она работает с устройства. Язык и точность — «Мой профиль» → «Расшифровка голосовых».';
  elsif t ~ '(время захода|$b$);
  if d = before or position('(коммент|обсужден)' in d) = 0 or position('«комментарии»' in d) = 0 then
    raise exception 'bot_canned: текст функции не совпал — обновите ответы вручную';
  end if;
  execute d;
end
$bot$;

-- ===========================================================================
-- Права
-- ===========================================================================

revoke all on function public.set_emoji_status(text, timestamptz) from public, anon, authenticated;
revoke all on function private.profile_card(public.profiles) from public, anon, authenticated;
revoke all on function public.profile_cards(uuid[]) from public, anon, authenticated;
revoke all on function public.set_chat_comments(uuid, boolean) from public, anon, authenticated;
revoke all on function public.comment_stats(uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.comment_feed(uuid, timestamptz, uuid, integer) from public, anon, authenticated;
revoke all on function public.my_chats() from public, anon, authenticated;
revoke all on function public.article_save(uuid, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.set_emoji_status(text, timestamptz) to authenticated;
grant execute on function public.profile_cards(uuid[]) to authenticated;
grant execute on function public.set_chat_comments(uuid, boolean) to authenticated;
grant execute on function public.comment_stats(uuid, uuid[]) to authenticated;
grant execute on function public.comment_feed(uuid, timestamptz, uuid, integer) to authenticated;
grant execute on function public.my_chats() to authenticated, service_role;
grant execute on function public.article_save(uuid, text, text, text, jsonb, text) to authenticated;
