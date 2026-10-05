#!/bin/bash
# Writes Selectel SMTP settings into .env and restarts auth
set -e
umask 077
cd /opt/supabase-project
read -r -p 'Selectel SMTP login: ' U
read -r -s -p 'Selectel SMTP password: ' P; echo
[ -n "$U" ] && [ -n "$P" ] || { echo 'Empty login or password'; exit 1; }
case "$U$P" in *"'"*) echo 'Quote in login/password'; exit 1 ;; esac
cp -p .env .env.bak-smtp
grep -v -E '^SMTP_(ADMIN_EMAIL|HOST|PORT|USER|PASS)=' .env.bak-smtp > .env.tmp
cat >> .env.tmp <<VARS
SMTP_ADMIN_EMAIL=noreply@skam-messenger.ru
SMTP_HOST=smtp.mail.selcloud.ru
SMTP_PORT=1126
SMTP_USER='$U'
SMTP_PASS='$P'
VARS
cat .env.tmp > .env
rm -f .env.tmp
sh run.sh recreate auth
docker exec supabase-auth env | grep -E '^GOTRUE_SMTP_(HOST|PORT|ADMIN_EMAIL)='
