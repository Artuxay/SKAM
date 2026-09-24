-- СКАМ — сквозное шифрование и в чате с ботом.
--
-- В чате с ботом теперь шифруется всё, кроме текста: фото, видео, файлы, стикеры, голосовые
-- и кружочки (kind = 'e2e', ключ есть только у самого человека). Текст остаётся открытым,
-- потому что бот читает его, чтобы отвечать. На зашифрованное бот отвечает общей фразой.
-- Канал новостей открыт всем пользователям, поэтому его посты по-прежнему не шифруются.

-- Ключи чатов можно заводить и в чате с ботом.
create or replace function private.is_e2e_member(p_chat uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.chat_members m
    join public.chats c on c.id = m.chat_id
    where m.chat_id = p_chat and m.user_id = (select auth.uid()) and c.kind in ('group', 'direct', 'bot')
  );
$$;

create or replace function private.key_in_chat(p_key uuid, p_chat uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.chat_keys k join public.chats c on c.id = k.chat_id
    where k.id = p_key and k.chat_id = p_chat and c.kind in ('group', 'direct', 'bot')
  );
$$;

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

  if new.kind = 'e2e' then
    reply := 'Получил 🔒 Это зашифровано сквозным шифрованием — открыть не могу даже я, ключ есть только у вас. Команды («помощь», «стикеры», «шифрование») пишите обычным текстом — его я читаю, чтобы отвечать.';
  elsif new.kind = 'sticker' then
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
    reply := E'Я умею немного, но честно:\n• «привет» — поздороваюсь;\n• «помощь» — это сообщение;\n• «стикеры» — расскажу про Голубя свободы;\n• «шифрование» — расскажу, как защищена переписка;\n• «это развод?» — объясню, почему нет.\n\nА ещё подскажу по СКАМ:\n• «Новый чат» — написать человеку по имени или @username или создать группу;\n• стикеры — кнопка со смайликом у поля ввода; наберите эмодзи — подходящие стикеры появятся сами;\n• голосовое — удерживайте микрофон справа от поля ввода и отпустите, чтобы отправить; уведите палец влево — отмена, вверх — запись без рук;\n• кружочек — коротко нажмите на микрофон, он станет камерой, дальше так же: удерживайте;\n• скрепка 📎 слева от поля ввода — фото, видео и файлы до 50 МБ (можно просто перетащить или вставить из буфера);\n• реакции — наведите на сообщение или коснитесь его (на телефоне — долгое нажатие);\n• имя, @username, фото, тема и пароль шифрования — в профиле внизу слева.';
  elsif t ~ '(стикер|голуб|sticker)' then
    reply := E'🕊️ Голубь свободы — маскот СКАМ и наш официальный набор из 16 стикеров: «Привет!», «Да», «Нет», «Ха-ха-ха», «Люблю», «Что?!», «Жду», «Спокойной ночи», «Грусть», «Бесишь!», «Хм…», «Свобода!», «Не развод», «Спасибо», «Доброе утро» и «OK».\n\nНажмите на смайлик у поля ввода или просто наберите 👋, 😂 или 🤔 — подходящий голубь появится сам. Пришлите мне любой — оценю!';
  elsif t ~ '(голосов|кружоч|кружк|видеосообщ|микрофон)' then
    reply := E'🎤 Голосовое: удерживайте микрофон справа от поля ввода, говорите и отпустите — сообщение уйдёт. Передумали — уведите палец влево. Долго говорить — потяните вверх, запись закрепится.\n\n⚪ Кружочек: коротко нажмите на микрофон — он станет камерой. Дальше так же: удерживайте, до минуты.\n\nСлушают и смотрят только участники чата.';
  elsif t ~ '(шифр|безопас|e2e|encrypt|ключ)' then
    reply := E'🔒 Личные чаты и группы в СКАМ защищены сквозным шифрованием: сообщения, фото, видео, файлы, стикеры, голосовые и кружочки шифруются прямо на вашем устройстве и расшифровываются только у собеседников. На сервере лежит лишь шифротекст — прочитать его не можем даже мы.\n\nКлюч хранится на ваших устройствах, а на новом устройстве восстанавливается паролем шифрования.\n\nЗдесь, в чате со мной, фото, видео, файлы, стикеры, голосовые и кружочки тоже шифруются, а текст я читаю — иначе не смогу ответить. Канал новостей открыт всем, поэтому он не шифруется — как каналы в Telegram.';
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
  for each row when (new.kind in ('text', 'sticker', 'voice', 'video_note', 'media', 'e2e') and new.user_id is not null)
  execute function private.bot_reply();

notify pgrst, 'reload schema';
