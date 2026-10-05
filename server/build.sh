#!/bin/sh
# Builds SKAM from GitHub main: site, email templates, functions
set -e
cd /opt/skam-test
if [ -d src/.git ]; then
  git -C src fetch -q
  git -C src reset -q --hard origin/main
else
  git clone https://github.com/Artuxay/SKAM src
fi
ENVF=/opt/supabase-project/.env
KEY=$(grep '^SUPABASE_PUBLISHABLE_KEY=' $ENVF | cut -d= -f2-)
[ -n "$KEY" ] || { echo 'No SUPABASE_PUBLISHABLE_KEY in .env'; exit 1; }
SHA=$(git -C src rev-parse HEAD)
docker run --rm -v /opt/skam-test/src:/app -w /app \
  -e VITE_SUPABASE_URL=https://api.skam-messenger.ru \
  -e VITE_SUPABASE_PUBLISHABLE_KEY="$KEY" -e GITHUB_SHA="$SHA" \
  node:22 sh -c 'npm ci --no-audit --no-fund && npm run build'
mkdir -p site
find site -mindepth 1 -delete
cp -a src/dist/. site/
mkdir -p site/email
cp src/supabase/templates/*.html site/email/
F=/opt/supabase-project/volumes/functions
for fn in support oauth-login; do
  rm -rf "$F/$fn.new"
  cp -a "src/supabase/functions/$fn" "$F/$fn.new"
  rm -rf "$F/$fn"
  mv "$F/$fn.new" "$F/$fn"
done
docker restart supabase-edge-functions > /dev/null
echo "Build done: $(echo "$SHA" | cut -c1-7)"
