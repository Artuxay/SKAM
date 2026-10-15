#!/bin/sh
# Applies managed.sql (trigger and policies in auth, storage, realtime) as supabase_admin,
# installs the stories cleanup (cron every 15 minutes) and article links /a/<slug> in Caddy,
# updates /opt/skam-test/build.sh and deploys all Edge Functions (0.4.2: bot-ai).
# Safe to run again.
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
# 0.4.2: build.sh deploys every function from supabase/functions (bot-ai is new);
# the server keeps its own copy of build.sh, so update it and deploy the functions right now.
if ! cmp -s "$HERE/build.sh" /opt/skam-test/build.sh; then
  cp -p /opt/skam-test/build.sh "/opt/skam-test/build.sh.bak-$(date +%Y%m%d-%H%M%S)"
  cat "$HERE/build.sh" > /opt/skam-test/build.sh
  echo 'build.sh updated: deploys all functions from supabase/functions'
fi
F=/opt/supabase-project/volumes/functions
for d in "$HERE"/../supabase/functions/*/; do
  fn=$(basename "$d")
  case "$fn" in main|_*) continue ;; esac
  rm -rf "$F/$fn.new"
  cp -a "$d" "$F/$fn.new"
  rm -rf "$F/$fn"
  mv "$F/$fn.new" "$F/$fn"
done
docker restart supabase-edge-functions > /dev/null
sleep 5
echo "Functions: $(ls "$F" | tr '\n' ' ')"
echo "bot-ai: $(curl -s https://api.skam-messenger.ru/functions/v1/bot-ai)"

sh "$HERE/apply-caddy.sh"
