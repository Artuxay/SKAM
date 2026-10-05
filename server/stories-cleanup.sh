#!/bin/sh
# Removes expired stories (cron every 15 minutes, installed by apply-managed.sh):
# private.stories_gc() deletes stories older than 24 hours (except pinned ones)
# and moves their file paths to private.story_trash; files are deleted here via the Storage API.
set -e
cd /opt/supabase-project
KEY=$(grep '^SERVICE_ROLE_KEY=' .env | cut -d= -f2-)
[ -n "$KEY" ] || { echo "$(date '+%F %T') no SERVICE_ROLE_KEY in .env"; exit 1; }
API=https://api.skam-messenger.ru/storage/v1/object/stories
q() {
  docker exec -i supabase-db psql -U postgres -d postgres -tA -q -v ON_ERROR_STOP=1 -c "$1"
}
N=$(q 'select private.stories_gc(1000)')
D=0
for P in $(q 'select path from private.story_trash order by at limit 2000'); do
  # Paths are <uuid>/<uuid>.<ext> or <uuid>/<uuid>_t.jpg: nothing else is touched.
  case "$P" in *[!0-9a-z/._-]*|*..*) continue ;; esac
  C=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$API/$P" \
    -H "Authorization: Bearer $KEY" -H "apikey: $KEY")
  case "$C" in
    200|400|404)
      q "delete from private.story_trash where path = '$P'" > /dev/null
      D=$((D + 1)) ;;
  esac
done
if [ "$N" != 0 ] || [ "$D" != 0 ]; then
  echo "$(date '+%F %T') stories=$N files=$D"
fi
