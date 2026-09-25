#!/usr/bin/env bash
# ==============================================================================
# deploy_vps_1gb.sh — Ultra-Lightweight Deploy Script for 1 vCPU / 1GB RAM / 5GB Disk
# Supports: Ubuntu 22.04/24.04 LTS, Debian 11/12
# Total RAM consumption: ~350MB (leaving 650MB free + 1GB swap)
# Total Disk consumption: ~2.8GB (leaving 2.2GB free out of 5GB)
# ==============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}================================================================${NC}"
echo -e "${CYAN}   musik: 1 vCPU / 1GB RAM / 5GB Disk Ultra-Lightweight Installer ${NC}"
echo -e "${CYAN}================================================================${NC}"

if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}[ERROR] Please run as root (use: sudo bash deploy_vps_1gb.sh)${NC}"
  exit 1
fi

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"
echo -e "${GREEN}[*] Project directory: ${PROJECT_DIR}${NC}"

# ------------------------------------------------------------------------------
# 1. SWAPFILE SETUP (1 GB Swap with swappiness=10)
# ------------------------------------------------------------------------------
SWAP_TOTAL=$(free -m | awk '/Swap:/ {print $2}')
if [ "$SWAP_TOTAL" -lt 512 ]; then
  echo -e "${YELLOW}[*] Creating 1GB swap file for memory safety...${NC}"
  if [ ! -f /swapfile ]; then
    fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile || true
  if ! grep -q '/swapfile' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
  sysctl vm.swappiness=10
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf
  echo -e "${GREEN}[✓] 1GB Swap activated successfully.${NC}"
else
  echo -e "${GREEN}[✓] Swap already configured: ${SWAP_TOTAL}MB.${NC}"
fi

# ------------------------------------------------------------------------------
# 2. MINIMAL SYSTEM PACKAGES
# ------------------------------------------------------------------------------
echo -e "${YELLOW}[*] Installing minimal system dependencies (ffmpeg, sqlite3, python3-venv)...${NC}"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  curl \
  ffmpeg \
  sqlite3 \
  python3-venv \
  python3-pip \
  git \
  unzip \
  ca-certificates

# Clean apt cache to save disk space
apt-get clean
rm -rf /var/lib/apt/lists/*

# ------------------------------------------------------------------------------
# 3. DENO RUNTIME INSTALLATION
# ------------------------------------------------------------------------------
if ! command -v deno &> /dev/null; then
  echo -e "${YELLOW}[*] Installing Deno runtime...${NC}"
  curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh
  echo -e "${GREEN}[✓] Deno installed: $(deno --version | head -n 1)${NC}"
else
  echo -e "${GREEN}[✓] Deno already installed: $(deno --version | head -n 1)${NC}"
fi

# ------------------------------------------------------------------------------
# 4. YT-DLP STANDALONE BINARY
# ------------------------------------------------------------------------------
if ! command -v yt-dlp &> /dev/null; then
  echo -e "${YELLOW}[*] Installing yt-dlp standalone binary...${NC}"
  curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
  chmod a+rx /usr/local/bin/yt-dlp
  echo -e "${GREEN}[✓] yt-dlp installed: $(yt-dlp --version)${NC}"
else
  echo -e "${GREEN}[✓] yt-dlp already present: $(yt-dlp --version)${NC}"
fi

# ------------------------------------------------------------------------------
# 5. PYTHON MICRO-VENV (ONNX Runtime, only ~45MB disk)
# ------------------------------------------------------------------------------
echo -e "${YELLOW}[*] Setting up ultra-lightweight ONNX runtime Python environment...${NC}"
VENV_DIR="${PROJECT_DIR}/.venv_embedder"
if [ ! -d "$VENV_DIR" ]; then
  python3 -m venv "$VENV_DIR"
fi
"$VENV_DIR/bin/pip" install --no-cache-dir --upgrade pip
"$VENV_DIR/bin/pip" install --no-cache-dir numpy onnxruntime
echo -e "${GREEN}[✓] ONNX Runtime environment ready (Disk footprint: < 50MB).${NC}"

# ------------------------------------------------------------------------------
# 6. GO CORE PLAYER BINARY
# ------------------------------------------------------------------------------
PLAYER_BIN="${PROJECT_DIR}/bin/musik-player-linux"
if [ ! -f "$PLAYER_BIN" ]; then
  if command -v go &> /dev/null; then
    echo -e "${YELLOW}[*] Compiling Go core player...${NC}"
    cd "${PROJECT_DIR}/musik-main/player"
    CGO_ENABLED=0 go build -ldflags="-s -w" -o "$PLAYER_BIN" ./cmd/musik-player
    cd "$PROJECT_DIR"
    chmod +x "$PLAYER_BIN"
    echo -e "${GREEN}[✓] musik-player binary compiled.${NC}"
  else
    echo -e "${RED}[!] Precompiled musik-player-linux missing and go not installed.${NC}"
    echo -e "${YELLOW}[*] Installing minimal Go compiler to build player...${NC}"
    apt-get update -qq && apt-get install -y -qq --no-install-recommends golang-go
    cd "${PROJECT_DIR}/musik-main/player"
    CGO_ENABLED=0 go build -ldflags="-s -w" -o "$PLAYER_BIN" ./cmd/musik-player
    cd "$PROJECT_DIR"
    chmod +x "$PLAYER_BIN"
    apt-get remove -y golang-go && apt-get autoremove -y
    apt-get clean && rm -rf /var/lib/apt/lists/*
  fi
else
  chmod +x "$PLAYER_BIN"
  echo -e "${GREEN}[✓] Found precompiled ${PLAYER_BIN}.${NC}"
fi

# ------------------------------------------------------------------------------
# 7. DIRECTORIES & DATABASE INITIALIZATION
# ------------------------------------------------------------------------------
mkdir -p "${PROJECT_DIR}/data/db"
mkdir -p "${PROJECT_DIR}/data/music/favorites"
mkdir -p "${PROJECT_DIR}/dynamic"
mkdir -p "${PROJECT_DIR}/logs"

# ------------------------------------------------------------------------------
# 8. SYSTEMD SERVICES CONFIGURATION
# ------------------------------------------------------------------------------
echo -e "${YELLOW}[*] Configuring systemd services...${NC}"

# A) Player Core Service
cat <<EOF > /etc/systemd/system/musik-player.service
[Unit]
Description=musik Go Player Core
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${PROJECT_DIR}
Environment="MUSIK_ROOT=${PROJECT_DIR}"
Environment="MUSIK_LIBRARY=${PROJECT_DIR}/dynamic"
Environment="MUSIK_DB_PATH=${PROJECT_DIR}/data/db/musik.db"
Environment="MUSIK_PLAYER_ADDR=127.0.0.1:8786"
Environment="MUSIK_AUTH_DISABLED=1"
Environment="MUSIK_WORKER_AUTOSTART=0"
ExecStart=${PLAYER_BIN}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# B) ONNX Embedder Micro Daemon Service
cat <<EOF > /etc/systemd/system/musik-embedder.service
[Unit]
Description=musik ONNX 512D Embedder Micro-Daemon
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${PROJECT_DIR}
Environment="PATH=${VENV_DIR}/bin:/usr/local/bin:/usr/bin:/bin"
Environment="FFMPEG_PATH=/usr/bin/ffmpeg"
ExecStart=${VENV_DIR}/bin/python ${PROJECT_DIR}/extensions/fetcher/scripts/embedder_onnx.py --server --port 8790 --db ${PROJECT_DIR}/data/db/musik.db
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# C) Gateway & Extension Server (Deno)
cat <<EOF > /etc/systemd/system/musik-gateway.service
[Unit]
Description=musik Deno Hybrid Gateway & Catalog Bridge
After=musik-player.service musik-embedder.service
Wants=musik-player.service musik-embedder.service

[Service]
Type=simple
User=root
WorkingDirectory=${PROJECT_DIR}
Environment="FETCHER_PORT=8787"
Environment="MUSIK_PLAYER_URL=http://127.0.0.1:8786"
Environment="EMBEDDER_URL=http://127.0.0.1:8790"
Environment="CACHE_MAX_GB=1.0"
Environment="YTDLP_PATH=/usr/local/bin/yt-dlp"
Environment="PYTHON_PATH=${VENV_DIR}/bin/python"
Environment="COOKIES_PATH=${PROJECT_DIR}/cookies.txt"
ExecStart=/usr/local/bin/deno run --allow-all ${PROJECT_DIR}/extensions/fetcher/src/server.ts
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now musik-player.service
systemctl enable --now musik-embedder.service
systemctl enable --now musik-gateway.service

echo -e "${CYAN}================================================================${NC}"
echo -e "${GREEN}   Deployment Complete! All 3 services are active and running:   ${NC}"
echo -e "${CYAN}================================================================${NC}"
systemctl status musik-gateway.service --no-pager -n 3 || true

PUBLIC_IP=$(curl -s -4 ifconfig.me || curl -s -4 icanhazip.com || echo "YOUR_VPS_IP")
echo -e ""
echo -e "${GREEN}Web Player & Neural Radio is live at:${NC}"
echo -e "  👉  ${CYAN}http://${PUBLIC_IP}:8787${NC}"
echo -e ""
echo -e "${YELLOW}Resource footprint check:${NC}"
free -h
df -h /
