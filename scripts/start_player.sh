#!/usr/bin/env bash
# scripts/start_player.sh: Launch Go core player
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

export MUSIK_ROOT="$PROJECT_ROOT"
export MUSIK_LIBRARY="$PROJECT_ROOT/dynamic"
export MUSIK_DB_PATH="$PROJECT_ROOT/data/db/musik.db"
export MUSIK_PLAYER_ADDR="127.0.0.1:8786"
export MUSIK_AUTH_DISABLED="1"
export MUSIK_WORKER_AUTOSTART="0"
export PATH="$PROJECT_ROOT/bin:$PATH"

mkdir -p "$PROJECT_ROOT/dynamic" "$PROJECT_ROOT/data/db"

if [ -f "$PROJECT_ROOT/bin/musik-player" ]; then
  PLAYER_BIN="$PROJECT_ROOT/bin/musik-player"
else
  PLAYER_BIN="musik-player"
fi

echo "[musik-player] Starting on http://127.0.0.1:8786..."
exec "$PLAYER_BIN"
