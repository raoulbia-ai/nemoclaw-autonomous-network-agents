#!/usr/bin/env bash
# Snapshot agent decisions and state from the sandbox to local disk.
# Run before shutting down to preserve ephemeral agent data.
# Overwrites previous snapshot each time.
#
# Uses `openshell sandbox download` (gRPC API) so it works without
# direct Docker socket access.
#
# Usage: ./scripts/snapshot-artifacts.sh
set -uo pipefail

GATEWAY="${OPENSHELL_GATEWAY:-nemoclaw}"
SANDBOX="${LLM_SANDBOX:-my-assistant}"
SNAPSHOT_DIR="${SNAPSHOT_DIR:-artifacts/snapshots}"

WS=/sandbox/.openclaw-data/workspace

rm -rf "$SNAPSHOT_DIR"
mkdir -p "$SNAPSHOT_DIR"

echo "Snapshotting agent state to $SNAPSHOT_DIR ..."

# --- Core artifacts (always snapshot) ---
FILES=(
  # Agent coordination
  "$WS/artifacts/agent-comms.jsonl"
  "$WS/artifacts/state.json"
  "$WS/artifacts/fault-fatigue.json"

  # Network signals & alarms
  "$WS/artifacts/signals.json"
  "$WS/artifacts/alarms.json"

  # Agent logs
  "$WS/artifacts/heartbeat-log.jsonl"
  "$WS/artifacts/remediation-log.jsonl"
  "$WS/artifacts/agentic-log.jsonl"
  "$WS/artifacts/agent-runs.jsonl"
  "$WS/artifacts/event-history.jsonl"

  # Network state
  "$WS/artifacts/rebuild-status.json"
  "$WS/artifacts/city-params.json"
  "$WS/artifacts/external-context.json"
  "$WS/artifacts/performance.json"
  "$WS/artifacts/topology.json"

  # Agent memory & reports
  "$WS/MEMORY.md"
  "$WS/artifacts/network-atlas.md"
  "$WS/artifacts/memory.json"
  "$WS/artifacts/accumulated-zones.json"

  # Cron state (for recovery after reboot)
  /sandbox/.openclaw-data/cron/jobs.json
)

for f in "${FILES[@]}"; do
  openshell sandbox download "$SANDBOX" "$f" "$SNAPSHOT_DIR/" -g "$GATEWAY" 2>/dev/null || true
done

# --- Atlas history (directory) ---
mkdir -p "$SNAPSHOT_DIR/atlas-history"
openshell sandbox download "$SANDBOX" "$WS/artifacts/atlas-history/" "$SNAPSHOT_DIR/atlas-history/" -g "$GATEWAY" 2>/dev/null || true

# --- Network state file (inside network/ireland/) ---
mkdir -p "$SNAPSHOT_DIR/network"
openshell sandbox download "$SANDBOX" "$WS/network/ireland/state.json" "$SNAPSHOT_DIR/network/" -g "$GATEWAY" 2>/dev/null || true

COUNT=$(find "$SNAPSHOT_DIR" -type f | wc -l)
SIZE=$(du -sh "$SNAPSHOT_DIR" | cut -f1)
echo "Done: $COUNT files, $SIZE"

# --- Verify key files exist ---
MISSING=0
for check in agent-comms.jsonl state.json signals.json; do
  if [ ! -f "$SNAPSHOT_DIR/$check" ]; then
    echo "  WARNING: $check missing from snapshot" >&2
    MISSING=$((MISSING + 1))
  fi
done

if [ "$MISSING" -gt 0 ]; then
  echo "  ($MISSING key file(s) missing — sandbox may be down or path wrong)" >&2
else
  echo "  All key files present ✓"
fi
