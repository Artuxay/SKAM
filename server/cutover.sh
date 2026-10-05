#!/bin/bash
# SKAM cutover: a fresh copy of the cloud database and files on this server.
# The current server database is not deleted: it is moved to
# volumes/db/data.before-<time> and comes back automatically on any error.
set -euo pipefail
umask 077
P=/opt/supabase-project
M=/opt/skam-migrate
CLOUD=https://fsqbxvufqhghiwwzplpn.supabase.co
CLOUD_PUB=sb_publishable_2eHigjlaIAEiwjrgkL2xzg__mEZYBxW
T=$(date +%Y%m%d-%H%M)
W=$M/final-$T
WIPED=0

rollback() {
  [ "$WIPED" = 1 ] || exit 1
  echo '!! Error: returning the previous server database'
  cd "$P"
  sh run.sh stop || true
  rm -rf volumes/db/data volumes/storage
  mv "volumes/db/data.before-$T" volumes/db/data
  mv "volumes/storage.before-$T" volumes/storage
  sh run.sh start
  echo '!! Rolled back. Nothing changed on the server. Send the error above.'
  exit 1
}
trap rollback ERR

echo '== 1/7 Versions'
CV=$(curl -fsS "$CLOUD/auth/v1/health" -H "apikey: $CLOUD_PUB" \
  | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
SV=$(docker inspect supabase-auth --format '{{.Config.Image}}' \
  | sed 's/.*://')
echo "cloud auth $CV, server auth $SV"
if [ "$CV" != "$SV" ]; then
  echo "Auth versions differ: set image supabase/gotrue:$CV first"
  exit 1
fi

echo '== 2/7 Cloud access'
read -r -p 'Session pooler: ' POOL
case "$POOL" in
  *'[YOUR-PASSWORD]'*) ;;
  *) echo 'No [YOUR-PASSWORD] in the string'; exit 1 ;;
esac
read -r -s -p 'Cloud DB password: ' PW; echo
read -r -s -p 'Cloud secret key: ' CLOUD_KEY; echo
[ -n "$PW" ] && [ -n "$CLOUD_KEY" ] || { echo 'Empty password'; exit 1; }
DBURL=$(printf '%s' "$POOL" | sed "s|\[YOUR-PASSWORD\]|$PW|")

echo '== 3/7 Dump from the cloud'
mkdir -p "$W"
cd "$W"
supabase db dump --db-url "$DBURL" -f roles.sql --role-only
supabase db dump --db-url "$DBURL" -f schema.sql
supabase db dump --db-url "$DBURL" -f data.sql --use-copy --data-only
ls -la

echo '== 4/7 Fresh database on the server'
cd "$P"
cp "$M/managed.sql" "$W/"
sh run.sh stop
mv volumes/db/data "volumes/db/data.before-$T"
mv volumes/storage "volumes/storage.before-$T"
WIPED=1
mkdir -p volumes/storage
sh run.sh start
PGPW=$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)
admin() {
  docker exec -i -e PGPASSWORD="$PGPW" supabase-db \
    psql -h 127.0.0.1 -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q
}
admin <<'SQL'
grant all on all tables in schema storage to postgres;
grant all on all sequences in schema storage to postgres;
SQL

echo '== 5/7 Restore'
{ grep -v 'ON PARAMETER' "$W/roles.sql"
  cat "$W/schema.sql"
  echo 'SET session_replication_role = replica;'
  cat "$W/data.sql"; } | docker exec -i supabase-db \
  psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 --single-transaction \
  > /dev/null
admin < "$W/managed.sql"
sh run.sh restart rest

echo '== 6/7 Files'
cd "$M"
docker exec -i supabase-db psql -U postgres -q -v ON_ERROR_STOP=1 <<'SQL'
create table if not exists private.objects_owner_backup as
  select bucket_id, name, owner, owner_id, created_at, user_metadata
    from storage.objects;
SQL
docker exec -i supabase-db psql -U postgres -tA -q -v ON_ERROR_STOP=1 \
  > objects.json <<'SQL'
select coalesce(json_agg(json_build_object(
  'b', bucket_id, 'n', name,
  't', metadata->>'mimetype', 'c', metadata->>'cacheControl')), '[]')
from storage.objects;
SQL
LOCAL_KEY=$(grep '^SERVICE_ROLE_KEY=' "$P/.env" | cut -d= -f2-)
docker run --rm --network host -v "$M":/w -w /w \
  -e CLOUD_KEY="$CLOUD_KEY" -e LOCAL_KEY="$LOCAL_KEY" \
  node:22 node copy-files.mjs || echo '!! Some files were not copied'
docker exec -i supabase-db psql -U postgres -q -v ON_ERROR_STOP=1 <<'SQL'
update storage.objects o
   set owner = b.owner, owner_id = b.owner_id,
       created_at = b.created_at, user_metadata = b.user_metadata
  from private.objects_owner_backup b
 where o.bucket_id = b.bucket_id and o.name = b.name;
drop table private.objects_owner_backup;
SQL
trap - ERR

echo '== 7/7 Check: cloud vs server'
Q="select (select count(*) from auth.users) users,
 (select count(*) from public.messages) messages,
 (select count(*) from storage.objects) files,
 (select max(created_at) from public.messages) last_message"
echo cloud:
docker exec supabase-db psql "$DBURL" -c "$Q"
echo server:
docker exec supabase-db psql -U postgres -c "$Q"
unset PW DBURL CLOUD_KEY
echo "Done. Old server data: volumes/db/data.before-$T"
