#!/bin/sh
# Rebuilds SKAM when GitHub main gets a new commit (cron, every 5 min)
exec 9>/opt/skam-test/.lock
flock -n 9 || exit 0
cd /opt/skam-test
NEW=$(git ls-remote https://github.com/Artuxay/SKAM refs/heads/main \
  | cut -f1)
[ -n "$NEW" ] || exit 0
[ "$NEW" = "$(cat .built 2>/dev/null)" ] && exit 0
[ "$NEW" = "$(cat .failed 2>/dev/null)" ] && exit 0
echo "$(date '+%F %T') build $NEW" >> deploy.log
if sh build.sh >> deploy.log 2>&1; then
  echo "$NEW" > .built
  echo "$(date '+%F %T') ok" >> deploy.log
else
  echo "$NEW" > .failed
  echo "$(date '+%F %T') FAILED" >> deploy.log
fi
