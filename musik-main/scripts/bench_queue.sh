#!/usr/bin/env bash
# Micro-bench: queue BuildOpts on current DB (small library OK).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MUSIK_ROOT="$ROOT"
export MUSIK_DB_PATH="${MUSIK_DB_PATH:-$ROOT/data/db/musik.db}"
export MUSIK_PASSWORD="${MUSIK_PASSWORD:-bench}"
export MUSIK_API_TOKEN="${MUSIK_API_TOKEN:-bench-token}"
export MUSIK_AUTH_DISABLED=0
export MUSIK_WORKER_AUTOSTART=0
# Force shortlist path even on small libs to validate pool code:
export MUSIK_CANDIDATE_POOL_AT="${MUSIK_CANDIDATE_POOL_AT:-50}"

cd "$ROOT"
go -C player test ./internal/queue/ ./internal/index/ -count=1
go -C player build -o /tmp/musik-bench-player ./cmd/musik-player

# Time radio/recommendation paths via API if player already up; else print hint
if curl -sf -H "Authorization: Bearer $MUSIK_API_TOKEN" http://127.0.0.1:8787/api/health >/dev/null 2>&1; then
  REQUESTS="${MUSIK_BENCH_REQUESTS:-20}"
  echo "bench radio/start × $REQUESTS sequential (pool_at=$MUSIK_CANDIDATE_POOL_AT)"
  START=$(date +%s%3N)
  for _ in $(seq 1 "$REQUESTS"); do
    curl -sf -X POST -H "Authorization: Bearer $MUSIK_API_TOKEN" \
      -H 'Content-Type: application/json' -d '{}' \
      http://127.0.0.1:8787/api/radio/start >/dev/null
  done
  END=$(date +%s%3N)
  echo "ok $REQUESTS radio/start in $((END-START)) ms (avg $(( (END-START)/REQUESTS )) ms)"

  echo "bench radio/start × $REQUESTS with 8 concurrent clients"
  START=$(date +%s%3N)
  seq 1 "$REQUESTS" | xargs -P 8 -I{} curl -sf -X POST \
    -H "Authorization: Bearer $MUSIK_API_TOKEN" \
    -H 'Content-Type: application/json' -d '{}' \
    http://127.0.0.1:8787/api/radio/start >/dev/null
  END=$(date +%s%3N)
  echo "ok concurrent radio/start in $((END-START)) ms"

  TRACK_ID=$(curl -sf -H "Authorization: Bearer $MUSIK_API_TOKEN" \
    http://127.0.0.1:8787/api/library | \
    python -c 'import json,sys; rows=json.load(sys.stdin); print(rows[0]["id"] if rows else "")')
  if [[ -n "$TRACK_ID" ]]; then
    for PATH_AND_LABEL in \
      "api/recommend/seed?type=track&track_id=$TRACK_ID recommend/seed" \
      "api/similar/$TRACK_ID similar"; do
      read -r API_PATH LABEL <<<"$PATH_AND_LABEL"
      START=$(date +%s%3N)
      for _ in $(seq 1 "$REQUESTS"); do
        curl -sf -H "Authorization: Bearer $MUSIK_API_TOKEN" \
          "http://127.0.0.1:8787/$API_PATH" >/dev/null
      done
      END=$(date +%s%3N)
      echo "ok $LABEL × $REQUESTS in $((END-START)) ms (avg $(( (END-START)/REQUESTS )) ms)"
    done
  fi

  curl -sf -H "Authorization: Bearer $MUSIK_API_TOKEN" \
    http://127.0.0.1:8787/api/metrics/recommendations
  echo
else
  echo "player not up — unit tests only. Start player then re-run for radio latency."
fi
