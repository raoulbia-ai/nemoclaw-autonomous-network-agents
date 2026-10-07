#!/usr/bin/env bash
# demo-fault-injection.sh — Scripted demo for live presentations.
#
# Records the autonomous agent response chain to an injected fault.
# Intended to run inside an asciinema session. Use scripts/demo-record.sh
# for the full workflow (prep + record + replay instructions).
#
# Four phases:
#   1. Show current system state via agent-status.sh
#   2. Show recent agent comms
#   3. Inject a configurable fault (default: multi-zone equipment fault)
#   4. Monitor agent response until ARCHITECT acts (or timeout)
#
# Usage:
#   ./scripts/demo-fault-injection.sh                                     # default fault
#   FAULT=scripts/demo-lib/faults/multi-zone-equipment.json ./scripts/... # custom fault
#
# Env:
#   FAULT           Path to fault JSON template (default: multi-zone-equipment.json)
#   MONITOR_ITERS   Polling iterations (default: 20)
#   MONITOR_INTERVAL  Seconds between polls (default: 30)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB="$SCRIPT_DIR/demo-lib"

# shellcheck source=./demo-lib/sandbox.sh
. "$LIB/sandbox.sh"
# shellcheck source=./demo-lib/ui.sh
. "$LIB/ui.sh"

FAULT="${FAULT:-$LIB/faults/multi-zone-equipment.json}"
MONITOR_ITERS="${MONITOR_ITERS:-20}"
MONITOR_INTERVAL="${MONITOR_INTERVAL:-30}"

[ -f "$FAULT" ] || { echo "Fault file not found: $FAULT" >&2; exit 1; }

# ── Phase 1: Current system state ────────────────────────────────────
section "PHASE 1: Current System Status"
bash "$PROJECT_DIR/scripts/agent-status.sh"
pause 5

# ── Phase 2: Recent agent activity ───────────────────────────────────
section "PHASE 2: Recent Agent Communication (last 10 messages)"
K_EXEC "sh -c 'tail -10 /sandbox/.openclaw-data/workspace/artifacts/agent-comms.jsonl'" | format_comms
pause 3

# ── Phase 3: Inject fault ────────────────────────────────────────────
section "PHASE 3: Injecting Fault"
echo "  Template: $(basename "$FAULT")"
python3 -c "import json; d=json.load(open('$FAULT')); print(f'  Type: {d[\"type\"]}, {len(d[\"affectedCells\"])} cells, ghost_alarm={d.get(\"ghostAlarm\",False)}')"
echo "  Expected: SENTINEL detects → tightens pace → ORACLE flags → ARCHITECT avoids area"
echo ""

# Copy fault template + inject script into sandbox, then pipe the
# template through inject.py inside the sandbox.
K_CP_IN "$FAULT" /tmp/demo-fault.json
K_CP_IN "$LIB/faults/inject.py" /tmp/demo-inject.py
K_EXEC "sh -c 'cat /tmp/demo-fault.json | python3 /tmp/demo-inject.py'"

echo ""
echo "  Fault injected. Monitoring autonomous agent response..."
echo "  Watch for: SENTINEL detect → pace tighten → ORACLE advise → ARCHITECT grow elsewhere"
echo ""

# ── Phase 4: Monitor response ────────────────────────────────────────
section "PHASE 4: Monitoring Autonomous Response"

COMMS_FILE="/sandbox/.openclaw-data/workspace/artifacts/agent-comms.jsonl"
BASELINE=$(K_EXEC "sh -c 'wc -l < $COMMS_FILE'" | tr -d ' ')

architect_responded() {
  local new_lines="$1"
  K_EXEC "sh -c 'tail -$new_lines $COMMS_FILE'" | grep -q '"from":"ARCHITECT"'
}

current_sentinel_pace() {
  K_EXEC "python3 -c 'import json; d=json.load(open(\"/sandbox/.openclaw-data/cron/jobs.json\")); j=[x for x in d[\"jobs\"] if x[\"name\"]==\"sentinel\"][0]; print(j[\"schedule\"][\"expr\"])'"
}

for i in $(seq 1 "$MONITOR_ITERS"); do
  current=$(K_EXEC "sh -c 'wc -l < $COMMS_FILE'" | tr -d ' ')
  if [ "$current" -gt "$BASELINE" ]; then
    new=$((current - BASELINE))
    echo "  [$i] +${new} new messages since injection:"
    K_EXEC "sh -c 'tail -$new $COMMS_FILE'" | format_comms
    echo "    SENTINEL pace: $(current_sentinel_pace)"
    echo ""

    if architect_responded "$new"; then
      section "COMPLETE: Full autonomous response chain observed"
      echo "  Fault injected → SENTINEL detected → ORACLE advised → ARCHITECT acted"
      echo ""
      bash "$PROJECT_DIR/scripts/agent-status.sh"
      exit 0
    fi
  else
    echo "  [$i] Waiting for agent response... (checking every ${MONITOR_INTERVAL}s)"
  fi
  sleep "$MONITOR_INTERVAL"
done

section "TIMEOUT: Agents still processing"
echo "  Run ./scripts/agent-status.sh to check current state"
