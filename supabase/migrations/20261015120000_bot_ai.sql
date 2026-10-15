-- СКАМ 0.4.2 — бот СКАМ отвечает нейросетью (Google Gemini или любая модель с API как у OpenAI).
--
-- Как работает:
--   1. Человек пишет боту текст → триггер messages_bot_reply (private.bot_reply) ставит задание
--      в очередь private.bot_ai_jobs и через pg_net будит Edge Function bot-ai (адрес внутри сети
--      Docker, settings.hook_url).
--   2. Функция забирает задание (public.bot_ai_claim — только service_role): историю чата с ботом
--      после последнего «новый диалог» и настройки модели; спрашивает модель (напрямую или через
--      посредника settings.relay_url — Google не пускает в Gemini API из России) и пишет ответ
--      (public.bot_ai_finish) обычным сообщением бота.
--   3. Стикеры, голосовые, кружочки, файлы, опросы, голая ссылка на статью, «/start» и «помощь» —
--      по-прежнему готовые ответы (private.bot_canned — прежний текст без изменений).
-- Режимы (settings.mode): off — как раньше, только готовые ответы; test — нейросеть только у
-- владельцев СКАМ и settings.testers; on — у всех. Нет ключа — как off.
-- Лимиты: settings.user_daily ответов в день на человека и settings.global_daily на весь СКАМ
-- (день — по Москве). Первое сообщение нейросети — предупреждение, что текст уходит в Google.
-- Ключ API лежит только в private.bot_ai_settings (в репозитории его нет): задаётся SQL-ом на сервере.
--
-- Скрипт идемпотентный. На своём сервере новые объекты получают права по умолчанию (anon и
-- authenticated — всё), поэтому в конце явные revoke/grant.

-- ---------------------------------------------------------------------------
-- Таблицы
-- ---------------------------------------------------------------------------

create table if not exists private.bot_ai_settings (
  id           boolean primary key default true check (id),
  mode         text not null default 'off' check (mode in ('off', 'test', 'on')),
  testers      uuid[] not null default '{}',
  provider_label text not null default 'Google Gemini' check (char_length(provider_label) between 1 and 40),
  base_url     text not null default 'https://generativelanguage.googleapis.com/v1beta/openai/',
  relay_url    text,
  api_key      text,
  models       text[] not null default array['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-flash-lite-latest'],
  reasoning    text default 'low' check (reasoning in ('none', 'minimal', 'low', 'medium', 'high')),
  temperature  numeric(3, 2) check (temperature between 0 and 2),
  history      int not null default 24 check (history between 1 and 100),
  user_daily   int not null default 40 check (user_daily between 0 and 100000),
  global_daily int not null default 1000 check (global_daily between 0 and 1000000),
  hook_url     text not null default 'http://kong:8000/functions/v1/bot-ai',
  updated_at   timestamptz not null default now()
);
comment on table private.bot_ai_settings is
  'Нейросеть бота СКАМ (0.4.2): режим, модель, ключ API, посредник, лимиты. Одна строка.';
insert into private.bot_ai_settings default values on conflict (id) do nothing;
alter table private.bot_ai_settings enable row level security;
revoke all on private.bot_ai_settings from public, anon, authenticated, service_role;

create table if not exists private.bot_ai_jobs (
  message_id  uuid primary key references public.messages (id) on delete cascade,
  chat_id     uuid not null references public.chats (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default clock_timestamp(),
  status      text not null default 'queued' check (status in ('queued', 'working', 'done', 'failed', 'merged')),
  attempts    int not null default 0,
  started_at  timestamptz,
  finished_at timestamptz,
  model       text,
  tokens      int,
  error       text
);
comment on table private.bot_ai_jobs is
  'Очередь ответов нейросети бота: одно задание на сообщение человека. Хранится 30 дней (для лимитов).';
create index if not exists bot_ai_jobs_queue on private.bot_ai_jobs (created_at) where status in ('queued', 'working');
create index if not exists bot_ai_jobs_user on private.bot_ai_jobs (user_id, created_at);
create index if not exists bot_ai_jobs_day on private.bot_ai_jobs (created_at);
alter table private.bot_ai_jobs enable row level security;
revoke all on private.bot_ai_jobs from public, anon, authenticated, service_role;

create table if not exists private.bot_ai_chats (
  chat_id    uuid primary key references public.chats (id) on delete cascade,
  since      timestamptz,
  noticed_at timestamptz
);
comment on table private.bot_ai_chats is
  'Чат с ботом: since — «новый диалог» (раньше — не учитывать), noticed_at — когда показали предупреждение о Google.';
alter table private.bot_ai_chats enable row level security;
revoke all on private.bot_ai_chats from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Готовые ответы — прежний текст бота (0.4.1) без изменений, вынесен из bot_reply
-- ---------------------------------------------------------------------------

create or replace function private.bot_canned(p_msg public.messages)
returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  t text := lower(btrim(p_msg.body));
  nm text;
  reply text;
  n int;
begin
  select first_name into nm from public.profiles where id = p_msg.user_id;

  if p_msg.kind = 'sticker' then
    reply := case when p_msg.sticker like 'dove/%' then 'Голубь Свободы одобряет 🕊️'
                  else 'Классный стикер! 🎨 Свои наборы — в панели стикеров, кнопка «+».' end;
  elsif p_msg.kind = 'voice' then
    reply := 'Голосовое получил! Но слушать я пока не умею — я же бот 🙈 Напишите текстом, отвечу.';
  elsif p_msg.kind = 'video_note' then
    reply := 'Кружочек получил — выглядите свободно! 🕊️ Смотреть видео я пока не умею, но друзьям понравится.';
  elsif p_msg.kind = 'poll' then
    reply := E'📊 Опрос получил! Голосовать я не умею — я же бот 🙈\n\nОтправьте его в группу или канал: там за него проголосуют. Открытый опрос покажет, кто за что, анонимный — только числа, а викторина — правильный ответ после голоса.';
  elsif p_msg.kind = 'media' then
    n := coalesce(jsonb_array_length(p_msg.files), 0);
    if n > 0 and not exists (select 1 from jsonb_array_elements(p_msg.files) f where f ->> 'kind' <> 'photo') then
      reply := case when n = 1 then 'Классное фото! 📸' else 'Классные фото! 📸' end
        || ' Смотреть картинки я пока не умею, но друзьям точно понравится. Отправляйте им — в личных чатах и группах файлы защищены сквозным шифрованием 🔒';
    elsif n > 0 and not exists (select 1 from jsonb_array_elements(p_msg.files) f where f ->> 'kind' <> 'video') then
      reply := 'Видео получил 🎬 Смотреть я пока не умею, а вот друзьям — самое то. В личных чатах и группах оно будет зашифровано 🔒';
    else
      reply := 'Файл получил 📎 Я бот и открыть его не могу, но в личных чатах и группах СКАМ файлы до 50 МБ передаются зашифрованными 🔒';
    end if;
  elsif t ~ 'skam-messenger\.ru/a/[a-z0-9-]+' then
    reply := E'📰 Статья! Открыл мгновенный просмотр — читается как в Telegraph. Отправьте её друзьям: в чате она будет карточкой с заголовком и обложкой, а по ссылке её прочитают даже без СКАМ.';
  elsif t ~ '^(/start|привет|прив|здравствуй|здрасте|здорово|добр(ый|ое|ого)|хай|хелло|салют|hi|hello|hey)' then
    reply := 'Привет, ' || coalesce(nm, 'друг') || '! 👋 Рад видеть. Напишите «помощь» — расскажу, что умею.';
  elsif t ~ '(помощь|помоги|help|команд|умеешь)' then
    reply := E'Я умею немного, но честно:\n• «привет» — поздороваюсь;\n• «помощь» — это сообщение;\n• «стикеры» — расскажу про Голубя свободы и свои наборы;\n• «эмодзи» — расскажу про свои эмодзи, реакции и супер-реакции;\n• «избранное» — расскажу, как сохранять сообщения;\n• «галочка» — расскажу, что значит официальная галочка;\n• «шифрование» — расскажу, как защищена переписка;\n• «звонки» — расскажу про звонки;\n• «статьи» — расскажу, как написать статью, как в Telegraph;\n• «опросы» — расскажу про опросы и викторины;\n• «время захода» — расскажу, как скрыть, когда вы в сети;\n• «личный канал» — расскажу, как показать свой канал в профиле;\n• «яндекс» или «vk» — расскажу про вход через Яндекс ID и VK ID;\n• «это развод?» — объясню, почему нет.\n\nА ещё подскажу по СКАМ:\n• «Новый чат» — написать человеку по имени или @username, создать группу или канал;\n• стикеры и эмодзи — кнопка со смайликом у поля ввода; наберите эмодзи — подходящие стикеры появятся сами; свои наборы — кнопка «+» в панели;\n• голосовое — удерживайте микрофон справа от поля ввода и отпустите, чтобы отправить; уведите палец влево — отмена, вверх — запись без рук;\n• кружочек — коротко нажмите на микрофон, он станет камерой, дальше так же: удерживайте;\n• скрепка 📎 слева от поля ввода — фото, видео, гифки и файлы до 50 МБ (можно просто перетащить или вставить из буфера), а ещё опрос и статья;\n• реакции — наведите на сообщение или коснитесь его (на телефоне — долгое нажатие), «+» — все реакции и свои эмодзи;\n• ответить — стрелка ↩ над сообщением или правый клик → «Ответить» (на телефоне — смахните сообщение влево);\n• переслать — стрелка ↪ или «Выбрать» несколько сообщений и «Переслать»;\n• сохранить — правый клик → «В избранное»: всё сохранённое лежит в чате «Избранное»;\n• звонки — трубка 📞 и камера 📹 в шапке личного чата или группы: голос, видео и демонстрация экрана, как в Discord;\n• имя, @username, фото, тема, личный канал, время захода и пароль шифрования — в профиле внизу слева.';
  elsif t ~ '(время захода|в сети|онлайн|online|last seen|был[аи]? в сети|конфиденц|приватн|невидимк)' then
    reply := E'👁 Время захода: «Мой профиль» → «Конфиденциальность» → «Время захода». Можно показывать всем, только контактам или никому.\n\nКому не показываете — тот увидит примерно: «был(а) недавно», «на этой неделе», «в этом месяце» или «давно». «В сети» тоже скрыто.\n\nКак в Telegram, это взаимно: если вы скрываете своё время от человека, его время вы тоже не увидите. Скрываем на сервере — точное время не уходит в чужое приложение вообще.\n\nКонтакты — те, с кем вы сами начали личный чат или кому писали, и те, кому вы дали ник.';
  elsif t ~ '(личн(ый|ого|ым) канал|канал в профил|мой канал|свой канал)' then
    reply := E'📣 Личный канал: «Мой профиль» → «Личный канал» — и выберите свой публичный канал (вы владелец, у канала есть @адрес).\n\nКанал появится в вашем профиле, как в Telegram: название, число подписчиков и последний пост. Любой, кто откроет ваш профиль, сможет перейти в канал и подписаться.';
  elsif t ~ '(яндекс|yandex|вконтакт|vk id|\mvk\M|\mвк\M|войти через|вход через|способ(ы)? входа)' then
    reply := E'🔑 Войти в СКАМ можно по почте (код в письме), а ещё через Яндекс ID и VK ID — кнопки на экране входа.\n\nУже есть аккаунт? «Мой профиль» → «Конфиденциальность» → «Способы входа» → «Привязать». Потом входите кнопкой Яндекса или VK прямо в этот аккаунт — пароль шифрования всё равно понадобится на новом устройстве.\n\nИностранных входов (Google, GitHub и т. п.) нет: российским сайтам их использовать нельзя.';
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

  return reply;
end;
$$;

-- ---------------------------------------------------------------------------
-- Нейросеть: включена ли, команды, тексты
-- ---------------------------------------------------------------------------

-- Начало суток по Москве — для дневных лимитов.
create or replace function private.bot_ai_day_start()
returns timestamptz
language sql stable set search_path = ''
as $$
  select date_trunc('day', now() at time zone 'Europe/Moscow') at time zone 'Europe/Moscow'
$$;

-- Отвечает ли этому человеку нейросеть: режим on — всем, test — владельцам СКАМ и testers; без ключа — никому.
create or replace function private.bot_ai_on(p_user uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select coalesce(s.api_key, '') <> ''
       and (s.mode = 'on'
            or (s.mode = 'test' and (p_user = any (s.testers)
                                     or exists (select 1 from private.app_owners o where o.user_id = p_user))))
    from private.bot_ai_settings s
    where s.id
  ), false)
$$;

-- Команды бота (текст уже в нижнем регистре и без пробелов по краям): reset | help | start | null.
create or replace function private.bot_ai_command(p_text text)
returns text
language sql immutable set search_path = ''
as $$
  select case
    when p_text ~ '^(/new|/reset|новый диалог|новый разговор|начать заново|начн[её]м заново|забудь вс[её]|сброс)[.!]*$' then 'reset'
    when p_text ~ '^(/help|помощь|помоги|help|команды|что (ты )?умеешь)[.!?]*$' then 'help'
    when p_text ~ '^/start$' then 'start'
  end
$$;

-- «помощь», когда отвечает нейросеть: что она умеет + прежние подсказки по СКАМ.
create or replace function private.bot_ai_help(p_msg public.messages)
returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  s private.bot_ai_settings;
  canned text := private.bot_canned(p_msg);
  i int := position('А ещё подскажу по СКАМ:' in canned);
begin
  select * into s from private.bot_ai_settings where id;
  return format(E'🧠 Я бот СКАМ, и со мной работает нейросеть %s. Спрашивайте что угодно: объясню, переведу, придумаю, посчитаю, помогу с учёбой и кодом. И, конечно, подскажу всё про СКАМ.\n\n• «новый диалог» — забыть прошлую переписку и начать заново;\n• «помощь» — это сообщение;\n• до %s ответов нейросети в день.\n\n⚠️ Этот чат не зашифрован, а сообщения для нейросети уходят в Google — не пишите мне пароли, номера карт и другое личное. Нейросеть может ошибаться: важное проверяйте.',
                s.provider_label, s.user_daily)
    || case when i > 0 then E'\n\n' || replace(substring(canned from i), 'А ещё подскажу по СКАМ:', 'Коротко о СКАМ:') else '' end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Ответ бота (триггер messages_bot_reply — прежний, меняется только функция)
-- ---------------------------------------------------------------------------

create or replace function private.bot_reply()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  t text := lower(btrim(new.body));
  cmd text;
  s private.bot_ai_settings;
  used int;
  total int;
  noticed timestamptz;
  reply text;
begin
  if not exists (select 1 from public.chats where id = new.chat_id and kind = 'bot') then
    return null;
  end if;
  if new.kind = 'text' then
    cmd := private.bot_ai_command(t);
  end if;

  if new.kind <> 'text' or cmd = 'start' or not private.bot_ai_on(new.user_id)
     or t ~ '^https?://(www\.|test\.)?skam-messenger\.ru/a/[a-z0-9-]+/?$' then
    reply := private.bot_canned(new);
  elsif cmd = 'help' then
    reply := private.bot_ai_help(new);
  elsif cmd = 'reset' then
    insert into private.bot_ai_chats (chat_id, since) values (new.chat_id, new.created_at)
    on conflict (chat_id) do update set since = excluded.since;
    reply := '🧹 Начали новый диалог: прошлую переписку я больше не учитываю. О чём поговорим?';
  else
    select * into s from private.bot_ai_settings where id;
    select count(*) filter (where j.user_id = new.user_id), count(*)
      into used, total
      from private.bot_ai_jobs j
     where j.created_at >= private.bot_ai_day_start() and j.status not in ('failed', 'merged');
    if used >= s.user_daily then
      reply := format('😴 Сегодня я ответил вам уже %s раз — это дневной лимит нейросети. Продолжим завтра! А по СКАМ подскажу и сейчас: напишите «помощь».', s.user_daily);
    elsif total >= s.global_daily then
      reply := '😴 Нейросеть на сегодня устала: закончился дневной лимит бесплатного тарифа. Попробуйте завтра! А по СКАМ подскажу и сейчас: напишите «помощь».';
    else
      insert into private.bot_ai_chats (chat_id) values (new.chat_id) on conflict (chat_id) do nothing;
      select c.noticed_at into noticed from private.bot_ai_chats c where c.chat_id = new.chat_id for update;
      if noticed is null then
        update private.bot_ai_chats set noticed_at = now() where chat_id = new.chat_id;
        insert into public.messages (chat_id, user_id, kind, body, created_at)
        values (new.chat_id, null, 'system',
          format(E'🧠 Теперь я отвечаю с помощью нейросети %s — спрашивайте что угодно, не только про СКАМ.\n\n⚠️ Важно: этот чат со мной не зашифрован, а то, что вы мне пишете, уходит в Google (США). На бесплатном тарифе Google может использовать это для улучшения своих моделей. Не пишите мне пароли, номера карт, адреса и другое личное. Нейросеть может ошибаться — важное проверяйте.\n\n«новый диалог» — начать разговор заново, «помощь» — что я умею.', s.provider_label),
          clock_timestamp());
      end if;
      insert into private.bot_ai_jobs (message_id, chat_id, user_id)
      values (new.id, new.chat_id, new.user_id)
      on conflict (message_id) do nothing;
      -- Будим функцию; запрос уйдёт после фиксации транзакции. Не вышло — подберёт следующий вызов.
      begin
        perform net.http_post(
          url := s.hook_url,
          body := jsonb_build_object('job', new.id),
          headers := '{"Content-Type": "application/json"}'::jsonb,
          timeout_milliseconds := 60000);
      exception when others then
        null;
      end;
      return null;
    end if;
  end if;

  insert into public.messages (chat_id, user_id, kind, body, created_at)
  values (new.chat_id, null, 'system', reply, clock_timestamp());
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Для функции bot-ai (только service_role)
-- ---------------------------------------------------------------------------

-- Взять следующее задание: { job, chat, name, today, history: [{role, kind, text, files, at}], settings } или null.
-- Несколько сообщений подряд — один ответ на последнее; пока бот отвечает в чате, новое задание ждёт.
create or replace function public.bot_ai_claim()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  j private.bot_ai_jobs;
  latest private.bot_ai_jobs;
  m public.messages;
  s private.bot_ai_settings;
  since timestamptz;
  nm text;
  h jsonb;
begin
  update private.bot_ai_jobs set status = 'failed', error = 'stale', finished_at = now()
   where status in ('queued', 'working') and created_at < now() - interval '10 minutes';
  delete from private.bot_ai_jobs where created_at < now() - interval '30 days';

  select q.* into j from private.bot_ai_jobs q
   where (q.status = 'queued' or (q.status = 'working' and q.started_at < now() - interval '2 minutes' and q.attempts < 2))
     and not exists (select 1 from private.bot_ai_jobs w
                      where w.chat_id = q.chat_id and w.status = 'working' and w.message_id <> q.message_id
                        and w.started_at >= now() - interval '2 minutes')
   order by q.created_at
   limit 1
   for update skip locked;
  if not found then
    return null;
  end if;

  select q.* into latest from private.bot_ai_jobs q
   where q.chat_id = j.chat_id and q.status = 'queued' and q.created_at >= j.created_at
   order by q.created_at desc
   limit 1;
  if found and latest.message_id <> j.message_id then
    update private.bot_ai_jobs q set status = 'merged', finished_at = now()
     where q.chat_id = j.chat_id and q.message_id <> latest.message_id and q.created_at <= latest.created_at
       and (q.status = 'queued' or q.message_id = j.message_id);
    j := latest;
  end if;

  update private.bot_ai_jobs set status = 'working', started_at = now(), attempts = attempts + 1
   where message_id = j.message_id;

  select * into s from private.bot_ai_settings where id;
  select * into m from public.messages where id = j.message_id;
  if m.id is null or m.deleted_at is not null then
    update private.bot_ai_jobs set status = 'failed', error = 'deleted', finished_at = now() where message_id = j.message_id;
    return jsonb_build_object('job', j.message_id, 'skip', true);
  end if;
  if not private.bot_ai_on(j.user_id) then
    return jsonb_build_object('job', j.message_id, 'off', true);
  end if;

  select c.since into since from private.bot_ai_chats c where c.chat_id = j.chat_id;
  select p.first_name into nm from public.profiles p where p.id = j.user_id;
  select coalesce(jsonb_agg(jsonb_build_object('role', x.role, 'kind', x.kind, 'text', x.body, 'files', x.files, 'at', x.created_at)
                            order by x.created_at), '[]'::jsonb)
    into h
    from (
      select case when mm.user_id is null then 'assistant' else 'user' end as role,
             mm.kind, left(mm.body, 4000) as body, mm.created_at,
             (select jsonb_agg(f ->> 'kind') from jsonb_array_elements(coalesce(mm.files, '[]'::jsonb)) f) as files
        from public.messages mm
       where mm.chat_id = j.chat_id and mm.deleted_at is null
         and mm.created_at <= m.created_at
         and mm.created_at > coalesce(since, '-infinity'::timestamptz)
         and mm.kind in ('text', 'system', 'sticker', 'voice', 'video_note', 'media', 'poll')
       order by mm.created_at desc
       limit s.history
    ) x;

  return jsonb_build_object(
    'job', j.message_id,
    'chat', j.chat_id,
    'name', nm,
    'today', to_char(now() at time zone 'Europe/Moscow', 'YYYY-MM-DD HH24:MI'),
    'history', h,
    'settings', jsonb_build_object(
      'label', s.provider_label, 'base_url', s.base_url, 'relay_url', s.relay_url, 'api_key', s.api_key,
      'models', to_jsonb(s.models), 'reasoning', s.reasoning, 'temperature', s.temperature));
end;
$$;

-- Записать ответ: до 5 сообщений бота по 4000 символов. Повторный вызов ничего не делает.
create or replace function public.bot_ai_finish(p_job uuid, p_parts text[], p_status text,
  p_model text default null, p_error text default null, p_tokens int default null)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  j private.bot_ai_jobs;
  part text;
  n int := 0;
begin
  select * into j from private.bot_ai_jobs where message_id = p_job for update;
  if not found or j.status <> 'working' then
    return 0;
  end if;
  update private.bot_ai_jobs
     set status = case when p_status = 'done' then 'done' else 'failed' end,
         finished_at = now(), model = left(p_model, 100), error = left(p_error, 500), tokens = p_tokens
   where message_id = p_job;
  if not exists (select 1 from public.chats where id = j.chat_id and kind = 'bot') then
    return 0;
  end if;
  foreach part in array coalesce(p_parts, '{}'::text[]) loop
    part := left(btrim(part), 4000);
    continue when part is null or part = '';
    insert into public.messages (chat_id, user_id, kind, body, created_at)
    values (j.chat_id, null, 'system', part, clock_timestamp());
    n := n + 1;
    exit when n >= 5;
  end loop;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Для приложения
-- ---------------------------------------------------------------------------

-- { enabled, label, limit, used, pending } — для шапки чата с ботом и карточки «О боте».
create or replace function public.bot_ai_status()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'enabled', private.bot_ai_on(auth.uid()),
    'label', s.provider_label,
    'limit', s.user_daily,
    'used', (select count(*) from private.bot_ai_jobs j
              where j.user_id = auth.uid() and j.created_at >= private.bot_ai_day_start()
                and j.status not in ('failed', 'merged')),
    'pending', exists (select 1 from private.bot_ai_jobs j
                        where j.user_id = auth.uid() and j.status in ('queued', 'working')
                          and j.created_at > now() - interval '2 minutes'))
  from private.bot_ai_settings s
  where s.id and auth.uid() is not null
$$;

-- «Новый диалог» из карточки бота: нейросеть забывает прошлую переписку.
create or replace function public.bot_ai_reset()
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  cid uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select c.id into cid from public.chats c where c.direct_key = 'bot:' || auth.uid()::text and c.kind = 'bot';
  if cid is null then
    return false;
  end if;
  insert into private.bot_ai_chats (chat_id, since) values (cid, now())
  on conflict (chat_id) do update set since = excluded.since;
  insert into public.messages (chat_id, user_id, kind, body, created_at)
  values (cid, null, 'system', '🧹 Начали новый диалог: прошлую переписку я больше не учитываю. О чём поговорим?', clock_timestamp());
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Права
-- ---------------------------------------------------------------------------

revoke all on function private.bot_canned(public.messages) from public, anon, authenticated, service_role;
revoke all on function private.bot_ai_day_start() from public, anon, authenticated, service_role;
revoke all on function private.bot_ai_on(uuid) from public, anon, authenticated, service_role;
revoke all on function private.bot_ai_command(text) from public, anon, authenticated, service_role;
revoke all on function private.bot_ai_help(public.messages) from public, anon, authenticated, service_role;
revoke all on function private.bot_reply() from public, anon, authenticated, service_role;
revoke all on function public.bot_ai_claim() from public, anon, authenticated;
revoke all on function public.bot_ai_finish(uuid, text[], text, text, text, int) from public, anon, authenticated;
revoke all on function public.bot_ai_status() from public, anon;
revoke all on function public.bot_ai_reset() from public, anon;

grant execute on function public.bot_ai_claim() to service_role;
grant execute on function public.bot_ai_finish(uuid, text[], text, text, text, int) to service_role;
grant execute on function public.bot_ai_status() to authenticated;
grant execute on function public.bot_ai_reset() to authenticated;
