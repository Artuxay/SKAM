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
| `/opt/supabase-project/volumes/functions/` | Edge Functions `support` и `oauth-login` (их раскладывает `build.sh`) |
| `/opt/skam-test/` | сборка сайта: `src/` — клон репозитория, `site/` — готовый сайт, `deploy.log` |
| `/opt/skam-backup/` | резервные копии за 14 дней, `backup.log` |
| `/opt/skam-migrate/` | переезд из облака: дампы, `managed.sql`, `copy-files.mjs`, `cutover.sh` |
| `/opt/skam-mcp/` | мост MCP для Claude |
| `/opt/skam-stories/` | уборка исчезнувших историй: `cleanup.sh` (копия `stories-cleanup.sh`), `cleanup.log`; cron `/etc/cron.d/skam-stories` |

## Скрипты в этой папке

- [`build.sh`](build.sh) — собирает сайт из `main` в Docker (`node:22`) с `VITE_SUPABASE_URL=https://api.skam-messenger.ru` и ключом из `.env`, кладёт шаблоны писем в `site/email/` (их забирает Auth) и функции в `volumes/functions/`, перезапускает функции. Неудачная сборка старый сайт не трогает.
- [`autodeploy.sh`](autodeploy.sh) — cron раз в 5 минут (`/etc/cron.d/skam-deploy`): если в `main` новый коммит, запускает `build.sh`. Упавшая сборка повторно не запускается, пока не появится следующий коммит. Журнал — `/opt/skam-test/deploy.log`.
- [`backup.sh`](backup.sh) — cron каждую ночь в 03:30 по Москве (`/etc/cron.d/skam-backup`): `pg_dump -Fc` всей базы и роли (`pg_dumpall --globals-only`) от `supabase_admin`, архив файлов Storage, `.env`, наш compose и Caddyfile. Проверяет, что дамп читается. Хранит 14 дней. Копии лежат на том же сервере — копию вне сервера стоит добавить отдельно.
- [`smtp.sh`](smtp.sh) — спрашивает логин и пароль почтового сервиса и записывает `SMTP_*` в `.env` (логин — число из поля Login, пароль — Pass (API-key)).
- [`managed.sql`](managed.sql) — триггер `on_auth_user_created` и 18 политик Storage и Realtime (с 0.3.1 — и три политики бакета историй `stories`). `supabase db dump` их не переносит, потому что схемы `auth`, `storage`, `realtime` служебные, а у `postgres` на self-hosted нет прав создавать политики на `storage.objects`. Запускается от `supabase_admin`, можно повторять.
- [`apply-managed.sh`](apply-managed.sh) — применяет `managed.sql` от `supabase_admin` и ставит уборку историй (cron каждые 15 минут). Запуск после выкладки: `sh /opt/skam-test/src/server/apply-managed.sh`.
- [`stories-cleanup.sh`](stories-cleanup.sh) — уборка историй: `private.stories_gc()` удаляет истории старше суток (кроме закреплённых в профиле) и переносит пути их файлов в `private.story_trash`, а скрипт стирает эти файлы через API Storage сервисным ключом из `.env` (`SERVICE_ROLE_KEY`). Журнал — `/opt/skam-stories/cleanup.log` (пишет только когда что-то убрал).
- [`copy-files.mjs`](copy-files.mjs) — копирует файлы Storage из облака на сервер через API (`x-upsert`).
- [`cutover.sh`](cutover.sh) — переезд «в один заход»: сверяет версию Auth с облаком, снимает дамп, откладывает текущую базу сервера в `volumes/db/data.before-<время>`, поднимает чистую, заливает, переносит файлы и сравнивает числа. При любой ошибке сам возвращает прежнюю базу.
- [`mcp/`](mcp/) — доступ Claude к базе: отдельный SSH-ключ, которому `authorized_keys` разрешает только запуск `bridge.sh`; мост поднимает `mcp-remote` к встроенному MCP-серверу Studio внутри сети Docker. Снаружи маршрут `/mcp` закрыт.

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
