#!/bin/sh
# Sends MCP initialize through the bridge and prints the answer
{
  printf '%s' '{"jsonrpc":"2.0","id":1,"method":"initialize",'
  printf '%s' '"params":{"protocolVersion":"2025-06-18","capabilities":{},'
  printf '%s\n' '"clientInfo":{"name":"skam-test","version":"1"}}}'
  sleep 25
} | timeout 90 /opt/skam-mcp/bridge.sh 2>/opt/skam-mcp/test.err \
  | head -c 500
echo
tail -3 /opt/skam-mcp/test.err
