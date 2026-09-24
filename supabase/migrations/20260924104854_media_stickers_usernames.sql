-- СКАМ — обязательный @username, стикеры, голосовые и кружочки.

create or replace function private.is_registered()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and first_name is not null and username is not null
  );
$$;

create or replace function private.require_registered()
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not private.is_registered() then
    raise exception 'Сначала завершите регистрацию: укажите имя и имя пользователя' using errcode = '42501';
  end if;
end;
$$;

create or replace function private.profiles_guard()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if old.username is not null and new.username is null then
    raise exception 'Имя пользователя обязательно' using errcode = '23514';
  end if;
  if old.first_name is not null and new.first_name is null then
    raise exception 'Имя обязательно' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update on public.profiles
  for each row execute function private.profiles_guard();

revoke all on function private.is_registered(), private.require_registered(), private.profiles_guard() from public, anon;
grant execute on function private.is_registered(), private.require_registered() to authenticated;

create or replace function public.create_chat(p_name text, p_emoji text default '💬')
returns public.chats
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  c public.chats;
begin
  perform private.require_registered();
  insert into public.chats (kind, name, emoji, created_by)
  values ('group', left(btrim(p_name), 40), coalesce(nullif(btrim(p_emoji), ''), '💬'), me)
  returning * into c;
  insert into public.chat_members (chat_id, user_id, role) values (c.id, me, 'owner');
  return c;
end;
$$;

create or replace function public.join_chat(p_code text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  cid uuid;
begin
  perform private.require_registered();
  select id into cid from public.chats where kind = 'group' and invite_code = p_code;
  if cid is null then raise exception 'invite not found' using errcode = 'P0002'; end if;
  insert into public.chat_members (chat_id, user_id) values (cid, me) on conflict do nothing;
  return cid;
end;
$$;

create or replace function public.open_direct(p_user uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  k text;
  cid uuid;
begin
  perform private.require_registered();
  if p_user is null or p_user = me then raise exception 'bad user' using errcode = '22023'; end if;
  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  k := least(me, p_user)::text || ':' || greatest(me, p_user)::text;
  insert into public.chats (kind, direct_key, invite_code, created_by)
  values ('direct', k, null, me)
  on conflict (direct_key) do nothing;
  select id into cid from public.chats where direct_key = k;
  insert into public.chat_members (chat_id, user_id)
  values (cid, me), (cid, p_user)
  on conflict do nothing;
  return cid;
end;
$$;

alter table public.messages add column if not exists sticker     text;
alter table public.messages add column if not exists media_path  text;
alter table public.messages add column if not exists media_mime  text;
alter table public.messages add column if not exists duration_ms int;
alter table public.messages add column if not exists waveform    smallint[];

alter table public.messages drop constraint if exists messages_kind_check;
alter table public.messages add constraint messages_kind_check
  check (kind in ('text', 'system', 'sticker', 'voice', 'video_note'));

alter table public.messages drop constraint if exists messages_body_shape;
alter table public.messages add constraint messages_body_shape check (
  (deleted_at is not null and body = '')
  or (deleted_at is null and kind in ('text', 'system') and char_length(btrim(body)) between 1 and 4000)
  or (deleted_at is null and kind in ('sticker', 'voice', 'video_note') and char_length(body) <= 16)
);

alter table public.messages drop constraint if exists messages_media_shape;
alter table public.messages add constraint messages_media_shape check (
  deleted_at is not null
  or (kind in ('text', 'system')
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

drop policy if exists "messages: members write" on public.messages;
create policy "messages: members write" on public.messages
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and deleted_at is null
    and kind in ('text', 'sticker', 'voice', 'video_note')
    and (media_path is null or (
      split_part(media_path, '/', 1) = chat_id::text
      and split_part(media_path, '/', 2) = (select auth.uid())::text
    ))
    and private.can_post(chat_id)
    and private.is_registered()
  );

grant insert (id, chat_id, body, kind, sticker, media_path, media_mime, duration_ms, waveform)
  on public.messages to authenticated;

create or replace function public.delete_message(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.messages
  set deleted_at = now(), body = '', sticker = null, media_path = null, media_mime = null,
      duration_ms = null, waveform = null
  where id = p_id and user_id = (select auth.uid()) and deleted_at is null;
  if not found then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.reactions where message_id = p_id;
end;
$$;

create or replace function private.path_chat(p_name text)
returns uuid
language plpgsql immutable set search_path = ''
as $$
begin
  return split_part(p_name, '/', 1)::uuid;
exception when others then
  return null;
end;
$$;
revoke all on function private.path_chat(text) from public, anon;
grant execute on function private.path_chat(text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 20971520,
        array['audio/webm', 'audio/ogg', 'audio/mp4', 'video/webm', 'video/mp4'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "media: members read" on storage.objects;
create policy "media: members read" on storage.objects
  for select to authenticated
  using (bucket_id = 'media' and private.is_chat_member(private.path_chat(name)));

drop policy if exists "media: upload own" on storage.objects;
create policy "media: upload own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'media'
    and split_part(name, '/', 2) = (select auth.uid())::text
    and private.can_post(private.path_chat(name))
    and private.is_registered()
  );

drop policy if exists "media: delete own" on storage.objects;
create policy "media: delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'media' and split_part(name, '/', 2) = (select auth.uid())::text);

create or replace function private.bot_reply()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  t text := lower(btrim(new.body));
  nm text;
  reply text;
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
  elsif t ~ '^(/start|привет|прив|здравствуй|здрасте|здорово|добр(ый|ое|ого)|хай|хелло|салют|hi|hello|hey)' then
    reply := 'Привет, ' || coalesce(nm, 'друг') || '! 👋 Рад видеть. Напишите «помощь» — расскажу, что умею.';
  elsif t ~ '(помощь|помоги|help|команд|умеешь)' then
    reply := E'Я умею немного, но честно:\n• «привет» — поздороваюсь;\n• «помощь» — это сообщение;\n• «это развод?» — объясню, почему нет.\n\nА ещё подскажу по СКАМ:\n• «Новый чат» — написать человеку по @username или создать группу;\n• стикеры — кнопка со смайликом слева от поля ввода;\n• голосовое — удерживайте микрофон; нажмите на него коротко — переключится на кружочек;\n• реакции — наведите на сообщение или коснитесь его;\n• имя, @username, фото и тема — в профиле внизу слева.';
  elsif t ~ '(развод|скам|мошен|scam|обман)' then
    reply := 'СКАМ — не развод, а мессенджер. Честно-честно 🤞 Чужие чаты никто не видит: доступ к каждому сообщению проверяет база.';
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
  for each row when (new.kind in ('text', 'sticker', 'voice', 'video_note') and new.user_id is not null)
  execute function private.bot_reply();

notify pgrst, 'reload schema';
