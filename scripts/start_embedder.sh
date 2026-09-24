#!/usr/bin/env bash
# scripts/start_embedder.sh: Persistent CLAP 512D Embedder Daemon
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PYTHON_BIN="python3"
if [ -f "$PROJECT_ROOT/bin/python/python" ]; then
  PYTHON_BIN="$PROJECT_ROOT/bin/python/python"
fi

echo "========================================="
echo " Starting CLAP 512D Embedder Daemon..."
echo " URL: http://127.0.0.1:8790"
echo "========================================="

exec "$PYTHON_BIN" "$PROJECT_ROOT/extensions/fetcher/scripts/embedder.py" --server --port 8790
