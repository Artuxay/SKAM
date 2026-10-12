#!/bin/sh
# Article links https://skam-messenger.ru/a/<slug> (0.4.0): Caddy serves /a/index.html for any /a/... path
# (without cache, like index.html). Adds three lines after "root * /srv/skam-test" in our site blocks,
# checks the new config inside the running Caddy and reloads it without downtime. Safe to run again.
#   sh /opt/skam-test/src/server/apply-caddy.sh
set -e
cd /opt/supabase-project
F=volumes/proxy/caddy/Caddyfile
if grep -q 'rewrite @skamArticle' "$F"; then
  echo 'Caddy: article links /a/ are already set up'
  exit 0
fi
C=$(docker ps --format '{{.Names}}' | grep -i caddy | head -n 1)
[ -n "$C" ] || { echo 'Caddy container not found, nothing changed'; exit 1; }
awk '
  { print }
  /^[[:space:]]*root \* \/srv\/skam-test[[:space:]]*$/ {
    print "    @skamArticle path /a/*"
    print "    rewrite @skamArticle /a/index.html"
    print "    header @skamArticle Cache-Control \"no-cache\""
  }
' "$F" > "$F.new"
if ! grep -q 'rewrite @skamArticle' "$F.new"; then
  rm -f "$F.new"
  echo 'Caddy: line "root * /srv/skam-test" not found, nothing changed'
  exit 1
fi
docker cp "$F.new" "$C:/tmp/Caddyfile.skam"
if ! docker exec "$C" caddy adapt --config /tmp/Caddyfile.skam --adapter caddyfile > /dev/null; then
  rm -f "$F.new"
  echo 'Caddy: new config is invalid, nothing changed'
  exit 1
fi
cp "$F" "$F.bak-$(date +%Y%m%d-%H%M%S)"
# Write in place: the file is bind-mounted into the container (a new inode would not be seen there).
cat "$F.new" > "$F"
rm -f "$F.new"
if ! docker exec "$C" caddy reload --config /tmp/Caddyfile.skam --adapter caddyfile; then
  echo 'Caddy: reload failed, restarting the container'
  sh run.sh restart caddy
fi
sleep 2
echo "Caddy: article links /a/ set up (https://skam-messenger.ru/a/ -> $(curl -s -o /dev/null -w '%{http_code}' https://skam-messenger.ru/a/test-link || echo '?'))"
