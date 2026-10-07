#!/usr/bin/env bash
# scripts/demo-lib/prep.sh — Pre-demo environment preparation.
#
# Ensures the environment is ready for a clean demo recording:
#   1. Tunnel is live (POST probe succeeds)
#   2. Stale demo/test faults cleared
#   3. All 3 crons kicked (in case they're in error backoff)
#
# Exits 0 if ready, non-zero if tunnel is down (caller should abort).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./sandbox.sh
. "$SCRIPT_DIR/sandbox.sh"
# shellcheck source=./ui.sh
. "$SCRIPT_DIR/ui.sh"

check_tunnel() {
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -X POST http://localhost:7997/v1/chat/completions \
    -H 'Content-Type: application/json' \
    -d '{"model":"openai/gpt-oss-20b","messages":[{"role":"user","content":"ping"}],"max_tokens":3}' \
    2>/dev/null || echo "000")
  if [ "$code" = "200" ]; then
    echo "  ✓ Tunnel live"
    return 0
  else
    echo "  ✗ Tunnel not responding (got $code). Bounce it on WSL before recording:"
    echo "      ~/bin/tunnel-llm-to-vm.sh kill && ~/bin/tunnel-llm-to-vm.sh"
    return 1
  fi
}

clear_test_faults() {
  K_CP_IN "$SCRIPT_DIR/faults/clear.py" /tmp/clear.py
  K_EXEC "python3 /tmp/clear.py evt-DEMO"
  K_EXEC "python3 /tmp/clear.py evt-TEST"
}

kick_cron() {
  local job="$1"
  local result
  result=$(K_EXEC "sh -c 'HOME=/sandbox openclaw cron run $job 2>/dev/null'" | tr -d '\n')
  if echo "$result" | grep -q '"enqueued":true'; then
    echo "  ✓ $job enqueued"
  else
    echo "  ⚠ $job may not have enqueued: $result"
  fi
}

section "Pre-demo preparation"

echo "Checking tunnel..."
check_tunnel || exit 1

echo "Clearing stale demo/test faults..."
clear_test_faults

echo "Kicking crons to clear any error backoff..."
kick_cron sentinel-001
kick_cron oracle-001

echo ""
echo "  Ready. Start recording with:"
echo "    asciinema rec --title \"NKA Autonomous Fault Response\" ~/demo-\$(date +%Y%m%d-%H%M).cast"
echo "    ./scripts/demo-fault-injection.sh"
echo "    exit"
