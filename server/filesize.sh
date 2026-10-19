#!/bin/sh
# Largest file Storage accepts (FILE_SIZE_LIMIT, the ceiling for every bucket).
# Who may upload how much is decided in the database: 50 MB by default, a personal limit
# (or none) in private.upload_limits - see supabase/migrations/20261020120000_upload_limits.sql.
# Files are encrypted in the browser in one piece, so more than ~2 GB will not work anyway.
#   sh /opt/skam-test/src/server/filesize.sh      # 2 GB
#   sh /opt/skam-test/src/server/filesize.sh 1    # whole GB, 1..50
# Safe to run again.
set -e
GB=${1:-2}
case "$GB" in ''|*[!0-9]*) echo 'Size must be a whole number of GB, for example 2'; exit 1 ;; esac
if [ "$GB" -lt 1 ] || [ "$GB" -gt 50 ]; then echo 'Size must be from 1 to 50 GB'; exit 1; fi
BYTES=$((GB * 1024 * 1024 * 1024))
cd /opt/supabase-project

F=docker-compose.skam.yml
BAK="$F.bak-filesize-$(date +%Y%m%d-%H%M%S)"
cp -p "$F" "$BAK"
if grep -q 'FILE_SIZE_LIMIT:' "$F"; then
  sed "s/^\( *FILE_SIZE_LIMIT:\).*/\1 \"$BYTES\"/" "$F" > "$F.tmp"
elif grep -q '^  storage:' "$F"; then
  rm -f "$BAK"
  echo "$F already has a storage section: add FILE_SIZE_LIMIT: \"$BYTES\" to storage.environment by hand"
  exit 1
else
  { cat "$F"; [ -z "$(tail -c 1 "$F")" ] || echo; printf '  storage:\n    environment:\n      FILE_SIZE_LIMIT: "%s"\n' "$BYTES"; } > "$F.tmp"
fi
cat "$F.tmp" > "$F"
rm -f "$F.tmp"
if ! sh run.sh config > /dev/null 2>&1; then
  cat "$BAK" > "$F"
  echo "docker compose did not accept the new $F - restored the old one ($BAK)"
  exit 1
fi
echo "$F: storage FILE_SIZE_LIMIT = $BYTES ($GB GB), backup $BAK"

sh run.sh recreate storage
i=0
while [ $i -lt 30 ]; do
  MAX=$(curl -s -o /dev/null -D - -X OPTIONS -H 'Tus-Resumable: 1.0.0' \
    https://api.skam-messenger.ru/storage/v1/upload/resumable | tr -d '\r' | awk -F': ' 'tolower($1) == "tus-max-size" { print $2 }')
  [ -n "$MAX" ] && break
  i=$((i + 1)); sleep 2
done
echo "Storage now accepts files up to: ${MAX:-unknown} bytes (expected $BYTES)"
df -h / | awk 'NR == 2 { print "Disk: " $4 " free of " $2 }'
