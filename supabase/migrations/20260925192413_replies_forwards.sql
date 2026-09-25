-- СКАМ — «Ответить» и «Переслать», как в Telegram.
--
-- • В личных чатах и группах (сквозное шифрование) ответ и пометка «Переслано от …» лежат
--   внутри шифротекста: сервер не знает, на какое сообщение вы ответили и откуда переслали.
-- • В канале новостей и в чате с ботом (без E2E) — в колонках reply_to и fwd.
-- • Пересланные файлы копируются в папку чата-получателя тем же зашифрованным файлом
--   (ключ файла переезжает внутри нового сообщения), поэтому политики хранилища не меняются.
--
-- Скрипт идемпотентный.

alter table public.messages add column if not exists reply_to uuid references public.messages (id) on delete set null;
alter table public.messages add column if not exists fwd jsonb;
create index if not exists messages_reply_to_idx on public.messages (reply_to) where reply_to is not null;
comment on column public.messages.reply_to is 'Ответ на сообщение этого же чата (только в чатах без E2E; в зашифрованных — внутри enc).';
comment on column public.messages.fwd is 'Пересланное сообщение: {"name": автор, "from": uuid автора, "kind": user|channel|bot, "at": время оригинала}. Только в чатах без E2E.';

-- «Переслано от …»: имя до 128 символов, необязательные id автора и время оригинала.
create or replace function private.fwd_shape_ok(p jsonb)
returns boolean
language sql immutable set search_path = ''
as $$
  select p is null or (
    jsonb_typeof(p) = 'object'
    and octet_length(p::text) <= 1024
    and char_length(coalesce(p ->> 'name', '')) between 1 and 128
    and (not p ? 'from' or coalesce(p ->> 'from', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    and (not p ? 'at' or coalesce(p ->> 'at', '') ~ '^\d{4}-\d{2}-\d{2}T[0-9:.]+(Z|[+-]\d{2}(:?\d{2})?)?$')
    and coalesce(p ->> 'kind', 'user') in ('user', 'channel', 'bot')
  );
$$;

-- Сообщение, на которое отвечают, из этого же чата.
create or replace function private.msg_in_chat(p_msg uuid, p_chat uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.messages where id = p_msg and chat_id = p_chat);
$$;

revoke all on function private.fwd_shape_ok(jsonb), private.msg_in_chat(uuid, uuid) from public, anon;
grant execute on function private.fwd_shape_ok(jsonb), private.msg_in_chat(uuid, uuid) to authenticated;

-- Ответ и пересылка — у обычных открытых сообщений; у зашифрованных они внутри шифротекста,
-- у удалённых стираются вместе с содержимым.
alter table public.messages drop constraint if exists messages_reply_fwd_shape;
alter table public.messages add constraint messages_reply_fwd_shape check (
  (reply_to is null and fwd is null)
  or (deleted_at is null and kind in ('text', 'sticker', 'voice', 'video_note', 'media') and private.fwd_shape_ok(fwd))
);

drop policy if exists "messages: members write" on public.messages;
create policy "messages: members write" on public.messages
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and deleted_at is null
    and kind in ('text', 'sticker', 'voice', 'video_note', 'e2e', 'media')
    and (media_path is null or (
      split_part(media_path, '/', 1) = chat_id::text
      and split_part(media_path, '/', 2) = (select auth.uid())::text
    ))
    and (kind <> 'media' or private.files_owned(files, chat_id))
    and (kind <> 'e2e' or private.key_in_chat(key_id, chat_id))
    and (reply_to is null or private.msg_in_chat(reply_to, chat_id))
    and private.can_post(chat_id)
    and private.is_registered()
  );

grant insert (id, chat_id, body, kind, sticker, media_path, media_mime, duration_ms, waveform, enc, key_id, files, reply_to, fwd)
  on public.messages to authenticated;

-- Удаление: вместе с содержимым стираем и ответ, и пометку о пересылке.
create or replace function public.delete_message(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.messages
  set deleted_at = now(), body = '', sticker = null, media_path = null, media_mime = null,
      duration_ms = null, waveform = null, enc = null, key_id = null, files = null,
      reply_to = null, fwd = null
  where id = p_id and user_id = (select auth.uid()) and deleted_at is null;
  if not found then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.reactions where message_id = p_id;
end;
$$;
revoke execute on function public.delete_message(uuid) from public, anon;
grant execute on function public.delete_message(uuid) to authenticated;

notify pgrst, 'reload schema';
