# Сервер СКАМ

С версии 0.3.0 (до новой нумерации — 1.5.0) СКАМ работает на своём сервере в России: VDS Selectel в Москве (4 vCPU, 8 ГБ, 80 ГБ NVMe, Ubuntu 24.04). На нём self-hosted Supabase в Docker (Postgres 17, Auth, Storage, Realtime, Edge Functions, Studio) за Caddy с сертификатами Let's Encrypt.

| Адрес | Что там |
| --- | --- |
| `https://skam-messenger.ru` | сайт (сборка из `main`) |
| `https://www.skam-messenger.ru` | перенаправление на основной адрес |
| `https://api.skam-messenger.ru` | API Supabase; корень — Studio (за паролем) |
| `https://test.skam-messenger.ru` | та же сборка, не индексируется поисковиками |
| `https://artuxay.github.io/SKAM/` | старый адрес: GitHub Pages перенаправляет на новый (`pages-redirect/`) |

Домен — REG.RU (записи A `@`, `www`, `api`, `test` → IP сервера). Почта — почтовый сервис Selectel: TXT-ключ владения, DKIM `selcloud._domainkey`, DMARC `_dmarc`, SPF `include:spf.mail.selcloud.ru`.

## Где что лежит на сервере

| Путь | Что это |
| --- | --- |
| `/opt/supabase-project` | Supabase (установщик `setup.sh`, self-hosted v0.8.2); управление — `sh run.sh start\|stop\|restart <сервис>\|recreate <сервис>\|secrets` |
| `/opt/supabase-project/.env` | ключи, пароли, адреса, SMTP — **только на сервере** |
| `/opt/supabase-project/docker-compose.skam.yml` | наши настройки поверх Supabase: копия — [`docker-compose.skam.yml`](docker-compose.skam.yml) |
| `/opt/supabase-project/volumes/proxy/caddy/Caddyfile` | Caddy; наши блоки — [`caddy/skam.caddy`](caddy/skam.caddy) |
| `/opt/supabase-project/volumes/functions/` | Edge Functions `support`, `oauth-login` и `bot-ai` (их раскладывает `build.sh`; `main` — маршрутизатор самого Supabase) |
| `/opt/skam-test/` | сборка сайта: `src/` — клон репозитория, `site/` — готовый сайт, `deploy.log` |
| `/opt/skam-backup/` | резервные копии за 14 дней, `backup.log` |
| `/opt/skam-migrate/` | переезд из облака: дампы, `managed.sql`, `copy-files.mjs`, `cutover.sh` |
| `/opt/skam-mcp/` | мост MCP для Claude |
| `/opt/skam-stories/` | уборка исчезнувших историй: `cleanup.sh` (копия `stories-cleanup.sh`), `cleanup.log`; cron `/etc/cron.d/skam-stories` |

## Скрипты в этой папке

- [`build.sh`](build.sh) — собирает сайт из `main` в Docker (`node:22`) с `VITE_SUPABASE_URL=https://api.skam-messenger.ru` и ключом из `.env`, кладёт шаблоны писем в `site/email/` (их забирает Auth) и все функции из `supabase/functions/` в `volumes/functions/` (с 0.4.2 — все папки, а не список), перезапускает функции. Неудачная сборка старый сайт не трогает.
- [`autodeploy.sh`](autodeploy.sh) — cron раз в 5 минут (`/etc/cron.d/skam-deploy`): если в `main` новый коммит, запускает `build.sh`. Упавшая сборка повторно не запускается, пока не появится следующий коммит. Журнал — `/opt/skam-test/deploy.log`.
- [`backup.sh`](backup.sh) — cron каждую ночь в 03:30 по Москве (`/etc/cron.d/skam-backup`): `pg_dump -Fc` всей базы и роли (`pg_dumpall --globals-only`) от `supabase_admin`, архив файлов Storage, `.env`, наш compose и Caddyfile. Проверяет, что дамп читается. Хранит 14 дней. Копии лежат на том же сервере — копию вне сервера стоит добавить отдельно.
- [`smtp.sh`](smtp.sh) — спрашивает логин и пароль почтового сервиса и записывает `SMTP_*` в `.env` (логин — число из поля Login, пароль — Pass (API-key)).
- [`oauth.sh`](oauth.sh) — с 0.4.1: вход через Яндекс ID и VK ID. Спрашивает ClientID и Client secret приложения Яндекса и ID приложения VK ID (Enter — оставить прежнее, «-» — стереть), пишет `YANDEX_CLIENT_ID`, `YANDEX_CLIENT_SECRET`, `VK_CLIENT_ID` в `.env` (копия `.env.bak-oauth-<время>`), добавляет их в `functions.environment` нашего `docker-compose.skam.yml`, пересоздаёт функции и показывает, какие кнопки входа теперь видит сайт. Запуск: `sh /opt/skam-test/src/server/oauth.sh`.
- [`managed.sql`](managed.sql) — триггер `on_auth_user_created` и 18 политик Storage и Realtime (с 0.3.1 — и три политики бакета историй `stories`). `supabase db dump` их не переносит, потому что схемы `auth`, `storage`, `realtime` служебные, а у `postgres` на self-hosted нет прав создавать политики на `storage.objects`. Запускается от `supabase_admin`, можно повторять.
- [`apply-managed.sh`](apply-managed.sh) — применяет `managed.sql` от `supabase_admin`, ставит уборку историй (cron каждые 15 минут), с 0.4.2 обновляет `/opt/skam-test/build.sh` (у сервера своя копия) и сразу раскладывает все функции, затем вызывает `apply-caddy.sh`. Запуск после выкладки: `sh /opt/skam-test/src/server/apply-managed.sh`.
- [`filesize.sh`](filesize.sh) — с 0.5.0: самый большой файл, который примет хранилище (`FILE_SIZE_LIMIT` сервиса `storage` в нашем `docker-compose.skam.yml`, по умолчанию 2 ГБ; копия `docker-compose.skam.yml.bak-filesize-<время>`), пересоздаёт `storage` и показывает новый потолок и свободное место на диске. Кому сколько можно — решает база: 50 МБ всем, свой предел или без предела — строка в `private.upload_limits`. Запуск: `sh /opt/skam-test/src/server/filesize.sh` (или с числом гигабайт: `… filesize.sh 1`).
- [`gemini-relay.gs`](gemini-relay.gs) — с 0.4.2: посредник для Gemini на Google Apps Script (Google не пускает в Gemini API из России). Как поставить — в начале файла и в разделе «Нейросеть бота».
- [`apply-caddy.sh`](apply-caddy.sh) — с 0.4.0: адреса статей `skam-messenger.ru/a/<адрес>` (и на `test.`) отдают страницу `a/index.html` без кэша. Добавляет три строки `@skamArticle` после `root * /srv/skam-test` в `volumes/proxy/caddy/Caddyfile`, проверяет новую конфигурацию внутри работающего Caddy (`caddy adapt`), сохраняет копию `Caddyfile.bak-<дата>`, пишет файл на место (тот же inode — он смонтирован в контейнер) и делает `caddy reload` без простоя. Повторный запуск ничего не меняет.
- [`stories-cleanup.sh`](stories-cleanup.sh) — уборка историй: `private.stories_gc()` удаляет истории старше суток (кроме закреплённых в профиле) и переносит пути их файлов в `private.story_trash`, а скрипт стирает эти файлы через API Storage сервисным ключом из `.env` (`SERVICE_ROLE_KEY`). Журнал — `/opt/skam-stories/cleanup.log` (пишет только когда что-то убрал).
- [`copy-files.mjs`](copy-files.mjs) — копирует файлы Storage из облака на сервер через API (`x-upsert`).
- [`cutover.sh`](cutover.sh) — переезд «в один заход»: сверяет версию Auth с облаком, снимает дамп, откладывает текущую базу сервера в `volumes/db/data.before-<время>`, поднимает чистую, заливает, переносит файлы и сравнивает числа. При любой ошибке сам возвращает прежнюю базу.
- [`mcp/`](mcp/) — доступ Claude к базе: отдельный SSH-ключ, которому `authorized_keys` разрешает только запуск `bridge.sh`; мост поднимает `mcp-remote` к встроенному MCP-серверу Studio внутри сети Docker. Снаружи маршрут `/mcp` закрыт.

## Нейросеть бота (с 0.4.2)

Бот СКАМ отвечает нейросетью: сообщение боту → триггер `private.bot_reply` ставит задание в `private.bot_ai_jobs` и через `pg_net` будит функцию `bot-ai` по адресу внутри сети Docker (`http://kong:8000/functions/v1/bot-ai`) → функция берёт задание (`public.bot_ai_claim`), спрашивает модель и пишет ответ (`public.bot_ai_finish`). Стикеры, файлы, голосовые, «/start» и «помощь» — по-прежнему готовые ответы.

Модель — любая с API как у OpenAI (`<base_url>chat/completions`, `Authorization: Bearer <ключ>`), по умолчанию Google Gemini (бесплатный ключ — aistudio.google.com). **Google не пускает в Gemini API из России** (`User location is not supported`), поэтому запросы идут через посредника на Google Apps Script — [`gemini-relay.gs`](gemini-relay.gs). Другой провайдер без ограничений по стране — `relay_url = null`.

Все настройки — одна строка `private.bot_ai_settings` (только `postgres`; ключа в репозитории нет):

```sql
select mode, provider_label, models, relay_url is not null as relay, user_daily, global_daily from private.bot_ai_settings;
update private.bot_ai_settings set mode = 'on' where id;       -- 'on' — всем, 'test' — владельцам СКАМ и testers, 'off' — выключить
update private.bot_ai_settings set api_key = '<ключ>', relay_url = 'https://script.google.com/macros/s/<…>/exec' where id;
update private.bot_ai_settings set models = array['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-flash-lite-latest'] where id;  -- по очереди: занята — следующая
update private.bot_ai_settings set user_daily = 40, global_daily = 1000 where id;   -- ответов в день на человека и на весь СКАМ (по Москве)
```

Что происходит:

```sql
select status, count(*) from private.bot_ai_jobs where created_at > now() - interval '1 day' group by 1;
select created_at, status, model, tokens, error from private.bot_ai_jobs order by created_at desc limit 20;
```

```sh
docker logs supabase-edge-functions --since 30m 2>&1 | grep bot-ai
```

Задания хранятся 30 дней (для лимитов), текст сообщений в них не копируется. Экземпляр функции на этом сервере живёт не дольше минуты (`workerTimeoutMs` в `volumes/functions/main/index.ts`), поэтому функция берёт задание, только пока успевает, а **pg_cron** (`cron.job` `skam-bot-ai-kick`, каждые 15 секунд) вызывает `private.bot_ai_kick()` — он будит функцию, если есть вопросы в очереди или задание оборвалось (через 65 секунд оно пробуется ещё раз, всего две попытки). Застрявшие дольше 10 минут помечаются `failed` (`stale`). Журнал будильника: `select * from cron.job_run_details order by start_time desc limit 5;`.

## Статистика для админки (с 0.5.3)

Страница `https://skam-messenger.ru/admin/` (только владельцам СКАМ) берёт числа из базы. Кто заходил за день, задним числом не посчитать (`private.presence` хранит только последний заход), поэтому **pg_cron** (`cron.job` `skam-stats-snapshot`, каждые 10 минут) вызывает `private.stats_snapshot()` и пишет снимок текущего дня по Москве в `private.stats_daily`. Ряд «Заходили» на графике копится с 23 октября 2026.

```sql
select day, data, taken_at from private.stats_daily order by day desc limit 7;
select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'skam-stats-snapshot') order by start_time desc limit 5;
```

## Модели расшифровки голосовых (с 0.5.1)

Голосовые превращаются в текст прямо в браузере (Whisper), а файлы модели браузер берёт у нас — из публичного бакета **`models`**: `https://api.skam-messenger.ru/storage/v1/object/public/models/<модель>/…`. Hugging Face из России не открывается, поэтому модели лежат на своём сервере. Звук и текст на сервер не приходят.

Сейчас залиты `whisper-base` (≈ 77 МБ, «Быстрая», по умолчанию) и `whisper-small` (≈ 250 МБ, «Точная») — вместе ≈ 331 МБ в Storage (и в каждой резервной копии файлов). Хранилище принимает файлы до 50 МБ, поэтому большие файлы порезаны на части по 40 МБ (`.part0`, `.part1`…); размеры и SHA-256 каждой части — в `<модель>/manifest.json`, приложение сверяет их при скачивании. `manifest.json` заливается последним — пока его нет, приложение модель не трогает.

Залить заново или добавить модель — [`scripts/whisper-models.mjs`](../scripts/whisper-models.mjs) (Node 20+):

```sh
# 1) на компьютере с доступом к huggingface.co (не из России — например, через VPN)
node scripts/whisper-models.mjs prepare ./models-out whisper-base whisper-small
# 2) залить сервисным ключом (на сервере: grep SERVICE_ROLE_KEY /opt/supabase-project/.env)
node scripts/whisper-models.mjs upload ./models-out https://api.skam-messenger.ru <ключ service_role>
```

`SKAM_UPSERT=0` — не перезаписывать уже залитые файлы. Новая модель появится в «Расшифровке голосовых», только если добавить её в `STT_MODELS` в `src/app/stt.ts`. Удалить модели с сервера: Studio → Storage → `models` (у тех, кто уже скачал, она останется в кэше браузера).

## Как переносилась база (и как повторить)

1. Версия Auth на сервере должна совпадать с облаком (`/auth/v1/health`): иначе в облачной базе окажутся таблицы, которых нет на сервере. Образ задаётся в `docker-compose.skam.yml`.
2. `supabase db dump --db-url <Session pooler>`: `--role-only`, схема, `--use-copy --data-only`.
3. От `supabase_admin`: `grant all on all tables/sequences in schema storage to postgres` — в self-hosted у `postgres` нет прав на часть таблиц Storage.
4. Заливка одной транзакцией от `postgres`: `roles.sql` без строк `ON PARAMETER` (служебный грант платформы), `schema.sql`, `SET session_replication_role = replica`, `data.sql`.
5. `managed.sql` от `supabase_admin`, `sh run.sh restart rest`.
6. Файлы — `copy-files.mjs`, после него возвращаются владельцы файлов (загрузка сервисным ключом их обнуляет).

Всё это делает `cutover.sh`.

## Обычные действия

```sh
cd /opt/supabase-project
sh run.sh ps                                    # состояние сервисов
docker logs supabase-auth --since 10m           # вход и письма
docker logs supabase-edge-functions --since 10m # функции
tail /opt/skam-test/deploy.log                  # автообновление сайта
tail /opt/skam-backup/backup.log                # резервные копии
tail /opt/skam-stories/cleanup.log              # уборка историй
sh /opt/skam-test/build.sh                      # пересобрать сайт вручную
```

Восстановить базу из резервной копии (на пустую или испорченную базу того же сервера):

```sh
cd /opt/supabase-project
D=/opt/skam-backup/2026-10-05     # нужная дата
PGPW=$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)
docker exec -i -e PGPASSWORD="$PGPW" supabase-db pg_restore -h 127.0.0.1 \
  -U supabase_admin -d postgres --clean --if-exists < $D/db.dump
tar xzf $D/storage.tgz -C volumes
```

## Безопасность

- `.env` (ключи, пароли, SMTP) есть только на сервере; в репозитории — только публичный ключ сайта, и тот подставляет `build.sh`.
- Порты базы (5432, 6543) открыты только для `127.0.0.1`; снаружи — 22, 80, 443.
- Studio закрыта паролем (`DASHBOARD_PASSWORD`), MCP наружу не открыт.
- Вход на сервер — только по SSH-ключу.
