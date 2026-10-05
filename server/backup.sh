#!/bin/sh
# Daily SKAM backup: database, storage files, server settings
set -e
umask 077
B=/opt/skam-backup
D=$B/$(date +%Y-%m-%d)
mkdir -p "$D"
cd /opt/supabase-project
PGPW=$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)
docker exec -e PGPASSWORD="$PGPW" supabase-db \
  pg_dumpall -h 127.0.0.1 -U supabase_admin --globals-only \
  > "$D/globals.sql"
docker exec -e PGPASSWORD="$PGPW" supabase-db \
  pg_dump -h 127.0.0.1 -U supabase_admin -Fc -d postgres > "$D/db.dump"
docker exec -i supabase-db pg_restore --list < "$D/db.dump" \
  | grep -c ' TABLE DATA ' > "$D/tables.txt"
tar czf "$D/storage.tgz" -C volumes storage
cp .env docker-compose.skam.yml volumes/proxy/caddy/Caddyfile "$D/"
find "$B" -mindepth 1 -maxdepth 1 -type d -name '20*' -mtime +13 \
  -exec rm -rf {} +
echo "$(date '+%F %T') ok $(du -sh "$D" | cut -f1)" \
  "tables=$(cat "$D/tables.txt")" >> "$B/backup.log"
