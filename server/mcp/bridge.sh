#!/bin/sh
# stdio <-> Supabase Studio MCP inside the docker network (for Claude)
NET=$(docker inspect supabase-studio \
  --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' \
  | cut -d' ' -f1)
exec docker run --rm -i --network "$NET" -v skam-mcp-npm:/root/.npm \
  node:22-alpine npx -y mcp-remote@0.14.3 http://studio:3000/api/mcp \
  --allow-http --transport http-only
