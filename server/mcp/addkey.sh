#!/bin/sh
# Adds the Claude MCP key: it may only run bridge.sh, nothing else
set -e
AK=/root/.ssh/authorized_keys
printf 'Paste the line from skam_mcp.pub: '
read -r K
case "$K" in
  'ssh-ed25519 '*) ;;
  *) echo 'This is not an ed25519 public key'; exit 1 ;;
esac
[ -z "$(tail -c1 $AK)" ] || echo >> $AK
echo "restrict,command=\"/opt/skam-mcp/bridge.sh\" $K" >> $AK
echo 'Key added:'
grep -c 'skam-mcp/bridge.sh' $AK
