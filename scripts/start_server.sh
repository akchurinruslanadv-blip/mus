#!/usr/bin/env bash
# scripts/start_server.sh: Start Deno Sidecar Gateway
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DENO_BIN="deno"
if [ -f "$PROJECT_ROOT/bin/deno" ]; then
  DENO_BIN="$PROJECT_ROOT/bin/deno"
fi

echo "========================================="
echo " Starting modular musik-fetcher Sidecar..."
echo " URL: http://0.0.0.0:8787"
echo "========================================="

exec "$DENO_BIN" run --allow-net --allow-read --allow-write --allow-run --allow-env --allow-ffi "$PROJECT_ROOT/extensions/fetcher/src/server.ts"
