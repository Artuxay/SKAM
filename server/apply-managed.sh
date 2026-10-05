#!/bin/sh
# Applies managed.sql (trigger and policies in auth, storage, realtime) as supabase_admin
# and installs the stories cleanup (cron every 15 minutes). Safe to run again.
#   sh /opt/skam-test/src/server/apply-managed.sh
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
cd /opt/supabase-project
PGPW=$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)
docker exec -i -e PGPASSWORD="$PGPW" supabase-db \
  psql -h 127.0.0.1 -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q \
  < "$HERE/managed.sql"
echo "Policies (storage + realtime): $(docker exec -i supabase-db \
  psql -U postgres -d postgres -tA -c \
  "select count(*) from pg_policies where schemaname in ('storage', 'realtime')")"
mkdir -p /opt/skam-stories
cp "$HERE/stories-cleanup.sh" /opt/skam-stories/cleanup.sh
chmod 700 /opt/skam-stories/cleanup.sh
echo '*/15 * * * * root /bin/sh /opt/skam-stories/cleanup.sh >> /opt/skam-stories/cleanup.log 2>&1' \
  > /etc/cron.d/skam-stories
chmod 644 /etc/cron.d/skam-stories
sh /opt/skam-stories/cleanup.sh
echo 'Stories cleanup: /etc/cron.d/skam-stories, log /opt/skam-stories/cleanup.log'
