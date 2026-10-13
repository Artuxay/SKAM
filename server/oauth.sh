#!/bin/sh
# Sign-in with Yandex ID and VK ID: asks for the app keys, writes them into .env,
# adds them to the functions service in docker-compose.skam.yml (if missing)
# and recreates the functions container. Enter on a question keeps the current value.
# Safe to run again (e.g. to change a key).
#   sh /opt/skam-test/src/server/oauth.sh
set -e
umask 077
HERE=$(cd "$(dirname "$0")" && pwd)
cd /opt/supabase-project

cur() { grep "^$1=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- | sed "s/^'//; s/'\$//"; }
mask() { [ -n "$1" ] && printf '%s' "set, ends with ...$(printf '%s' "$1" | tail -c 4)" || printf 'not set'; }
bad() { case "$1" in *"'"*|*'"'*|*' '*|*'\'*|*'$'*) return 0 ;; esac; return 1; }

YID=$(cur YANDEX_CLIENT_ID); YSEC=$(cur YANDEX_CLIENT_SECRET); VID=$(cur VK_CLIENT_ID)
echo "Yandex ClientID: $(mask "$YID")"
echo "Yandex Client secret: $(mask "$YSEC")"
echo "VK ID app ID: $(mask "$VID")"
echo 'Enter keeps the current value, a single "-" clears it.'
printf 'Yandex ClientID: '; read -r A
printf 'Yandex Client secret (hidden): '; stty -echo 2>/dev/null || true; read -r B; stty echo 2>/dev/null || true; echo
printf 'VK ID app ID (digits): '; read -r C
[ "$A" = "-" ] && YID='' || { [ -n "$A" ] && YID=$A; }
[ "$B" = "-" ] && YSEC='' || { [ -n "$B" ] && YSEC=$B; }
[ "$C" = "-" ] && VID='' || { [ -n "$C" ] && VID=$C; }
for v in "$YID" "$YSEC" "$VID"; do
  if bad "$v"; then echo 'Keys must not contain quotes, spaces, \ or $'; exit 1; fi
done
case "$VID" in ''|*[!0-9]*) [ -z "$VID" ] || { echo 'VK app ID must be digits only'; exit 1; } ;; esac
if [ -n "$YID" ] && [ -z "$YSEC" ]; then echo 'Yandex needs both ClientID and Client secret'; exit 1; fi

# .env
cp -p .env ".env.bak-oauth-$(date +%Y%m%d-%H%M%S)"
grep -v -E '^(YANDEX_CLIENT_ID|YANDEX_CLIENT_SECRET|VK_CLIENT_ID)=' .env > .env.tmp || true
{
  echo "YANDEX_CLIENT_ID='$YID'"
  echo "YANDEX_CLIENT_SECRET='$YSEC'"
  echo "VK_CLIENT_ID='$VID'"
} >> .env.tmp
cat .env.tmp > .env
rm -f .env.tmp

# docker-compose.skam.yml: pass the keys to the functions container
F=docker-compose.skam.yml
if ! grep -q 'YANDEX_CLIENT_ID' "$F"; then
  cp -p "$F" "$F.bak-oauth-$(date +%Y%m%d-%H%M%S)"
  if [ "$(md5sum < "$F" | cut -c1-32)" = '8c8bcb28ab4a406fbe06a9be47dd6f2d' ] && [ -f "$HERE/docker-compose.skam.yml" ]; then
    cat "$HERE/docker-compose.skam.yml" > "$F"
  else
    awk '{ print } /OAUTH_REDIRECT_URLS:/ { f = 1; next } f && /skam-messenger\.ru/ {
      print "      YANDEX_CLIENT_ID: ${YANDEX_CLIENT_ID:-}"
      print "      YANDEX_CLIENT_SECRET: ${YANDEX_CLIENT_SECRET:-}"
      print "      VK_CLIENT_ID: ${VK_CLIENT_ID:-}"
      f = 0 }' "$F" > "$F.tmp"
    grep -q 'VK_CLIENT_ID' "$F.tmp" || { rm -f "$F.tmp"; echo "Could not add keys to $F: add YANDEX_CLIENT_ID, YANDEX_CLIENT_SECRET, VK_CLIENT_ID to functions.environment by hand"; exit 1; }
    cat "$F.tmp" > "$F"
    rm -f "$F.tmp"
  fi
  echo "$F: keys added to functions"
fi

sh run.sh recreate functions
sleep 4
echo "Functions container sees: YANDEX_CLIENT_ID=$(docker exec supabase-edge-functions sh -c 'test -n "$YANDEX_CLIENT_ID" && echo set || echo empty'), VK_CLIENT_ID=$(docker exec supabase-edge-functions sh -c 'test -n "$VK_CLIENT_ID" && echo set || echo empty')"
echo "Login buttons: $(curl -s https://api.skam-messenger.ru/functions/v1/oauth-login)"
echo 'Redirect URI in both apps: https://skam-messenger.ru/ (and https://test.skam-messenger.ru/)'
