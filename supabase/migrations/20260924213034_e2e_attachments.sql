-- СКАМ — сквозное шифрование (E2E) личных чатов и групп + отправка файлов, фото и видео.
--
-- Шифруют и расшифровывают только браузеры участников (WebCrypto). Сервер хранит открытые
-- ключи, «завёрнутые» ключи чатов и шифротекст — прочитать переписку он не может.
-- Подробное описание схемы — в ШИФРОВАНИЕ.md.
--
-- • user_keys            — открытый ключ личности пользователя (ECDH P-256). Видят собеседники.
-- • private.key_backups  — закрытый ключ, зашифрованный паролем шифрования (PBKDF2 → AES-GCM).
--                          Отдаётся только владельцу через my_key_backup(); пароля сервер не знает.
-- • chat_keys            — ключи чатов (AES-256-GCM). Новый ключ появляется, когда кто-то вышел
--                          из чата, поэтому у чата их может быть несколько.
-- • chat_key_shares      — ключ чата, завёрнутый для конкретного участника (ECDH + HKDF + AES-GCM).
-- • messages.kind 'e2e'  — зашифрованное сообщение: enc = шифротекст, key_id = ключ чата.
--                          Текст, подпись и вложения (вместе с ключами файлов) — внутри шифротекста.
-- • messages.kind 'media'— вложения там, где E2E нет (канал новостей и бот): files = список вложений.
-- • Файлы лежат в приватном бакете media всегда зашифрованными, у каждого файла свой ключ.
--
-- Старые сообщения остаются как есть; клиенты прошлой версии продолжают работать.
-- Скрипт идемпотентный.

-- ---------------------------------------------------------------------------
-- 1. Ключи
-- ---------------------------------------------------------------------------

create table if not exists public.user_keys (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  public_key text not null check (public_key ~ '^[A-Za-z0-9+/]{86,88}={0,2}$'),
  reset_at   timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.user_keys is
  'Открытый ключ шифрования пользователя (ECDH P-256, raw, base64). Закрытый ключ есть только на его устройствах и в копии, зашифрованной паролем.';
comment on column public.user_keys.reset_at is
  'Когда ключ сбрасывали («забыл пароль»). Ключи чатов, созданные до сброса, автоматически не раздаются.';

create table if not exists private.key_backups (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  backup     text not null check (char_length(backup) between 40 and 2000),
  salt       text not null check (char_length(salt) between 16 and 64),
  iterations int  not null check (iterations between 100000 and 10000000),
  updated_at timestamptz not null default now()
);
comment on table private.key_backups is
  'Закрытый ключ шифрования, зашифрованный паролем шифрования пользователя (PBKDF2-SHA256 → AES-256-GCM).';
alter table private.key_backups enable row level security;
revoke all on private.key_backups from public, anon, authenticated;

create table if not exists public.chat_keys (
  id         uuid primary key,
  chat_id    uuid not null references public.chats (id) on delete cascade,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
comment on table public.chat_keys is 'Ключи чатов. Сам ключ здесь не хранится — только в chat_key_shares, завёрнутый для каждого участника.';
create index if not exists chat_keys_chat_idx on public.chat_keys (chat_id, created_at desc);
create index if not exists chat_keys_created_by_idx on public.chat_keys (created_by);

create table if not exists public.chat_key_shares (
  key_id     uuid not null references public.chat_keys (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  sender_id  uuid not null default auth.uid(),
  chat_id    uuid not null references public.chats (id) on delete cascade,
  sender_pub text not null check (sender_pub ~ '^[A-Za-z0-9+/]{86,88}={0,2}$'),
  wrapped    text not null check (char_length(wrapped) between 40 and 200),
  created_at timestamptz not null default now(),
  primary key (key_id, user_id, sender_id)
);
comment on table public.chat_key_shares is
  'Ключ чата, завёрнутый для участника user_id: AES-GCM ключом из ECDH(ключ отправителя, ключ получателя) + HKDF.';
create index if not exists chat_key_shares_user_idx on public.chat_key_shares (user_id, chat_id);
create index if not exists chat_key_shares_chat_idx on public.chat_key_shares (chat_id);

-- Автор и время ставит сервер: от них зависит, какой ключ «последний» и кому раздавать историю.
create or replace function private.chat_keys_fill()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  new.created_by := (select auth.uid());
  new.created_at := clock_timestamp();
  return new;
end;
$$;
drop trigger if exists chat_keys_fill on public.chat_keys;
create trigger chat_keys_fill before insert on public.chat_keys
  for each row execute function private.chat_keys_fill();

create or replace function private.chat_key_shares_fill()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  select k.chat_id into new.chat_id from public.chat_keys k where k.id = new.key_id;
  new.sender_id := (select auth.uid());
  new.created_at := now();
  return new;
end;
$$;
drop trigger if exists chat_key_shares_fill on public.chat_key_shares;
create trigger chat_key_shares_fill before insert on public.chat_key_shares
  for each row execute function private.chat_key_shares_fill();

-- Я участник личного чата или группы (только там есть E2E).
create or replace function private.is_e2e_member(p_chat uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.chat_members m
    join public.chats c on c.id = m.chat_id
    where m.chat_id = p_chat and m.user_id = (select auth.uid()) and c.kind in ('group', 'direct')
  );
$$;

-- Человек — участник чата.
create or replace function private.is_member_of(p_chat uuid, p_user uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.chat_members where chat_id = p_chat and user_id = p_user);
$$;

-- Ключ принадлежит этому чату, а чат — личный или группа.
create or replace function private.key_in_chat(p_key uuid, p_chat uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.chat_keys k join public.chats c on c.id = k.chat_id
    where k.id = p_key and k.chat_id = p_chat and c.kind in ('group', 'direct')
  );
$$;

alter table public.user_keys       enable row level security;
alter table public.chat_keys       enable row level security;
alter table public.chat_key_shares enable row level security;

-- Открытый ключ видят те, с кем есть общий личный чат или группа (и сам владелец).
drop policy if exists "user_keys: read" on public.user_keys;
create policy "user_keys: read" on public.user_keys
  for select to authenticated using (private.shares_chat(user_id));

drop policy if exists "chat_keys: members read" on public.chat_keys;
create policy "chat_keys: members read" on public.chat_keys
  for select to authenticated using (private.is_chat_member(chat_id));
drop policy if exists "chat_keys: members create" on public.chat_keys;
create policy "chat_keys: members create" on public.chat_keys
  for insert to authenticated
  with check (created_by = (select auth.uid()) and private.is_e2e_member(chat_id));

-- Свои доли видит получатель; кто какой ключ получил — участники чата (нужно для смены ключа).
-- Сам завёрнутый ключ прочитать может только получатель.
drop policy if exists "key shares: read" on public.chat_key_shares;
create policy "key shares: read" on public.chat_key_shares
  for select to authenticated
  using (user_id = (select auth.uid()) or private.is_chat_member(chat_id));
drop policy if exists "key shares: give" on public.chat_key_shares;
create policy "key shares: give" on public.chat_key_shares
  for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and private.is_e2e_member(chat_id)
    and private.is_member_of(chat_id, user_id)
    and sender_pub = (select k.public_key from public.user_keys k where k.user_id = (select auth.uid()))
  );

revoke all on public.user_keys, public.chat_keys, public.chat_key_shares from anon, authenticated;
grant select on public.user_keys, public.chat_keys, public.chat_key_shares to authenticated;
grant insert (id, chat_id) on public.chat_keys to authenticated;
grant insert (key_id, user_id, sender_pub, wrapped) on public.chat_key_shares to authenticated;

-- ---------------------------------------------------------------------------
-- 2. RPC для ключей
-- ---------------------------------------------------------------------------

-- Создать ключ личности (первый раз) или заменить его («забыл пароль» → p_reset = true).
-- При сбросе доли ключей чатов, завёрнутые для старого ключа, удаляются: они уже бесполезны.
create or replace function public.set_identity_key(
  p_public text, p_backup text, p_salt text, p_iterations int, p_reset boolean default false)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  had boolean := false;
begin
  if me is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select true into had from public.user_keys where user_id = me;
  had := coalesce(had, false);
  if had and not coalesce(p_reset, false) then
    raise exception 'Ключ шифрования уже создан' using errcode = '23505';
  end if;
  insert into public.user_keys (user_id, public_key, reset_at)
  values (me, p_public, case when had then now() end)
  on conflict (user_id) do update
    set public_key = excluded.public_key, reset_at = now(), updated_at = now();
  insert into private.key_backups (user_id, backup, salt, iterations)
  values (me, p_backup, p_salt, p_iterations)
  on conflict (user_id) do update
    set backup = excluded.backup, salt = excluded.salt, iterations = excluded.iterations, updated_at = now();
  if had then
    delete from public.chat_key_shares where user_id = me;
  end if;
end;
$$;

-- Моя зашифрованная паролем копия закрытого ключа (для входа на новом устройстве).
create or replace function public.my_key_backup()
returns table (public_key text, backup text, salt text, iterations int)
language sql stable security definer set search_path = ''
as $$
  select k.public_key, b.backup, b.salt, b.iterations
  from public.user_keys k
  join private.key_backups b on b.user_id = k.user_id
  where k.user_id = (select auth.uid());
$$;

-- Сменить пароль шифрования: тот же ключ, новая зашифрованная копия.
create or replace function public.update_key_backup(p_backup text, p_salt text, p_iterations int)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update private.key_backups
  set backup = p_backup, salt = p_salt, iterations = p_iterations, updated_at = now()
  where user_id = (select auth.uid());
  if not found then raise exception 'no key' using errcode = 'P0002'; end if;
end;
$$;

-- Кому из участников моих чатов не хватает ключей, которые есть у меня.
-- Клиент заворачивает эти ключи для них — так новый участник группы получает историю,
-- а человек, включивший шифрование позже собеседника, — сообщения, отправленные до этого.
-- После сброса ключа («забыл пароль») старые ключи автоматически не раздаются: только
-- созданные после сброса и те, что появились в чатах, куда человек вступил уже потом.
create or replace function public.e2e_pending(p_limit int default 300)
returns table (chat_id uuid, key_id uuid, user_id uuid, public_key text)
language sql stable security definer set search_path = ''
as $$
  select distinct k.chat_id, k.id, m.user_id, uk.public_key
  from public.chat_key_shares mine
  join public.chat_keys k on k.id = mine.key_id
  join public.chats c on c.id = k.chat_id and c.kind in ('group', 'direct')
  join public.chat_members self on self.chat_id = k.chat_id and self.user_id = mine.user_id
  join public.chat_members m on m.chat_id = k.chat_id and m.user_id <> mine.user_id
  join public.user_keys uk on uk.user_id = m.user_id
  where mine.user_id = (select auth.uid())
    and not exists (
      select 1 from public.chat_key_shares s where s.key_id = k.id and s.user_id = m.user_id
    )
    and (uk.reset_at is null or k.created_at > uk.reset_at or m.joined_at > k.created_at)
  limit greatest(1, least(coalesce(p_limit, 300), 1000));
$$;

-- ---------------------------------------------------------------------------
-- 3. Сообщения: зашифрованные ('e2e') и с вложениями без E2E ('media')
-- ---------------------------------------------------------------------------

alter table public.messages add column if not exists enc    text;
alter table public.messages add column if not exists key_id uuid references public.chat_keys (id) on delete cascade;
alter table public.messages add column if not exists files  jsonb;
create index if not exists messages_key_idx on public.messages (key_id);
comment on column public.messages.enc is 'Шифротекст (base64: IV 12 байт + AES-256-GCM) сообщения вида e2e.';
comment on column public.messages.files is 'Вложения сообщения вида media (чаты без E2E): путь, размер, ключ файла.';

-- Вложения: 1–10 штук, файлы лежат в media/<чат>/<автор>/<uuid>.bin.
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
    if (f ->> 'size')::numeric not between 1 and 52428800 then return false; end if;
    if char_length(coalesce(f ->> 'name', '')) not between 1 and 255 then return false; end if;
    if char_length(coalesce(f ->> 'mime', '')) > 255 then return false; end if;
    if f ? 'thumb' and coalesce(f -> 'thumb' ->> 'path', '') !~ path_re then return false; end if;
  end loop;
  return true;
end;
$$;

-- Все файлы вложения загружены автором в папку этого чата.
create or replace function private.files_owned(p jsonb, p_chat uuid)
returns boolean
language sql stable set search_path = ''
as $$
  select not exists (
    select 1 from jsonb_array_elements(p) f
    where split_part(f ->> 'path', '/', 1) <> p_chat::text
       or split_part(f ->> 'path', '/', 2) <> (select auth.uid())::text
       or (f ? 'thumb' and (
            split_part(f -> 'thumb' ->> 'path', '/', 1) <> p_chat::text
         or split_part(f -> 'thumb' ->> 'path', '/', 2) <> (select auth.uid())::text))
  );
$$;

alter table public.messages drop constraint if exists messages_kind_check;
alter table public.messages add constraint messages_kind_check
  check (kind in ('text', 'system', 'sticker', 'voice', 'video_note', 'e2e', 'media'));

alter table public.messages drop constraint if exists messages_body_shape;
alter table public.messages add constraint messages_body_shape check (
  (deleted_at is not null and body = '')
  or (deleted_at is null and kind in ('text', 'system') and char_length(btrim(body)) between 1 and 4000)
  or (deleted_at is null and kind in ('sticker', 'voice', 'video_note') and char_length(body) <= 16)
  or (deleted_at is null and kind = 'e2e' and body = '')
  or (deleted_at is null and kind = 'media' and char_length(body) <= 4000)
);

alter table public.messages drop constraint if exists messages_media_shape;
alter table public.messages add constraint messages_media_shape check (
  deleted_at is not null
  or (kind in ('text', 'system', 'e2e', 'media')
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

alter table public.messages drop constraint if exists messages_e2e_shape;
alter table public.messages add constraint messages_e2e_shape check (
  (deleted_at is not null and enc is null and key_id is null and files is null)
  or (deleted_at is null and kind = 'e2e'
      and key_id is not null and files is null and char_length(enc) between 24 and 65536)
  or (deleted_at is null and kind = 'media'
      and enc is null and key_id is null and private.files_shape_ok(files))
  or (deleted_at is null and kind not in ('e2e', 'media')
      and enc is null and key_id is null and files is null)
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
    and private.can_post(chat_id)
    and private.is_registered()
  );

grant insert (id, chat_id, body, kind, sticker, media_path, media_mime, duration_ms, waveform, enc, key_id, files)
  on public.messages to authenticated;

-- Удаление: вместе с текстом стираем шифротекст и список вложений.
-- Сами файлы удаляет из хранилища клиент автора (прямое удаление из storage.objects запрещено).
create or replace function public.delete_message(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.messages
  set deleted_at = now(), body = '', sticker = null, media_path = null, media_mime = null,
      duration_ms = null, waveform = null, enc = null, key_id = null, files = null
  where id = p_id and user_id = (select auth.uid()) and deleted_at is null;
  if not found then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.reactions where message_id = p_id;
end;
$$;

-- Список чатов: для превью зашифрованного последнего сообщения отдаём шифротекст —
-- клиент расшифрует его сам.
drop function if exists public.my_chats();
create function public.my_chats()
returns table (
  id uuid, kind text, name text, emoji text, invite_code text, is_default boolean,
  created_at timestamptz, role text, last_read_at timestamptz,
  member_count int, peer_id uuid, unread int,
  last_id uuid, last_body text, last_user_id uuid, last_kind text,
  last_at timestamptz, last_deleted boolean,
  last_enc text, last_key_id uuid, last_files jsonb
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
         lm.enc, lm.key_id, lm.files
  from public.chat_members cm
  join public.chats c on c.id = cm.chat_id
  left join lateral (
    select m.id, m.body, m.user_id, m.kind, m.created_at, m.deleted_at, m.enc, m.key_id, m.files
    from public.messages m where m.chat_id = c.id
    order by m.created_at desc, m.id desc limit 1
  ) lm on true
  where cm.user_id = (select auth.uid())
  order by coalesce(lm.created_at, c.created_at) desc;
$$;

-- ---------------------------------------------------------------------------
-- 4. Бот: отвечает и на вложения, рассказывает про шифрование
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
    reply := E'Я умею немного, но честно:\n• «привет» — поздороваюсь;\n• «помощь» — это сообщение;\n• «шифрование» — расскажу, как защищена переписка;\n• «это развод?» — объясню, почему нет.\n\nА ещё подскажу по СКАМ:\n• «Новый чат» — написать человеку по @username или создать группу;\n• скрепка 📎 слева от поля ввода — фото, видео и файлы до 50 МБ (можно просто перетащить или вставить из буфера);\n• реакции — наведите на сообщение или коснитесь его;\n• имя, @username, фото, тема и ключ шифрования — в профиле внизу слева.';
  elsif t ~ '(шифр|безопас|e2e|encrypt|ключ)' then
    reply := E'🔒 Личные чаты и группы в СКАМ защищены сквозным шифрованием: сообщения, фото, видео и файлы шифруются прямо на вашем устройстве и расшифровываются только у собеседников. На сервере лежит лишь шифротекст — прочитать его не можем даже мы.\n\nКлюч хранится на ваших устройствах, а на новом устройстве восстанавливается паролем шифрования. Сверить ключ с собеседником можно в его профиле: эмодзи должны совпасть.\n\nКанал новостей и этот чат со мной не шифруются — как каналы и боты в Telegram.';
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

-- ---------------------------------------------------------------------------
-- 5. Хранилище: зашифрованные файлы до 50 МБ (предел бесплатного тарифа Supabase)
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 52428800,
        array['audio/webm', 'audio/ogg', 'audio/mp4', 'video/webm', 'video/mp4', 'application/octet-stream'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 6. Права на функции и Realtime
-- ---------------------------------------------------------------------------

revoke all on function private.chat_keys_fill(), private.chat_key_shares_fill() from public, anon, authenticated;
-- files_shape_ok вызывается из ограничения таблицы, поэтому её должен уметь выполнять тот, кто вставляет строку.
revoke all on function
  private.is_e2e_member(uuid), private.is_member_of(uuid, uuid), private.key_in_chat(uuid, uuid),
  private.files_owned(jsonb, uuid), private.files_shape_ok(jsonb)
from public, anon;
grant execute on function
  private.is_e2e_member(uuid), private.is_member_of(uuid, uuid), private.key_in_chat(uuid, uuid),
  private.files_owned(jsonb, uuid), private.files_shape_ok(jsonb)
to authenticated;

revoke execute on function
  public.set_identity_key(text, text, text, int, boolean), public.my_key_backup(),
  public.update_key_backup(text, text, int), public.e2e_pending(int), public.my_chats(),
  public.delete_message(uuid)
from public, anon;
grant execute on function
  public.set_identity_key(text, text, text, int, boolean), public.my_key_backup(),
  public.update_key_backup(text, text, int), public.e2e_pending(int), public.my_chats(),
  public.delete_message(uuid)
to authenticated;

do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['user_keys', 'chat_key_shares'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

notify pgrst, 'reload schema';
