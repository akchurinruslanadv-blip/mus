#!/usr/bin/env bash
# scripts/start_all.sh: Start complete musik streaming stack on Linux / macOS
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "================================================="
echo " [musik] Starting Complete Streaming Stack..."
echo " Public Web Player: http://0.0.0.0:8787"
echo " Internal Go Core:  http://127.0.0.1:8786"
echo " Embedder Daemon:   http://127.0.0.1:8790"
echo "================================================="

# Trap to kill all background subprocesses on exit
trap 'kill 0' EXIT

# 1. Start Go Core in background
"$SCRIPT_DIR/start_player.sh" &
CORE_PID=$!

# 2. Start CLAP Embedder Daemon in background
"$SCRIPT_DIR/start_embedder.sh" &
EMBEDDER_PID=$!

sleep 2

# 3. Start Sidecar Gateway (foreground)
"$SCRIPT_DIR/start_server.sh"
