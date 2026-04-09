#!/usr/bin/env bash
# Snapshot agent decisions and state from the sandbox to local disk.
# Run before shutting down to preserve ephemeral agent data.
# Overwrites previous snapshot each time.
#
# Usage: ./scripts/snapshot-artifacts.sh
set -uo pipefail

GATEWAY="${OPENSHELL_GATEWAY:-nemoclaw}"
SANDBOX="${LLM_SANDBOX:-my-assistant}"
SNAPSHOT_DIR="${SNAPSHOT_DIR:-artifacts/snapshots}"

rm -rf "$SNAPSHOT_DIR"
mkdir -p "$SNAPSHOT_DIR"

echo "Snapshotting agent state to $SNAPSHOT_DIR ..."

WS=/sandbox/.openclaw-data/workspace

openshell sandbox download "$SANDBOX" "$WS/artifacts/agent-comms.jsonl" "$SNAPSHOT_DIR/" -g "$GATEWAY" 2>/dev/null || true
openshell sandbox download "$SANDBOX" "$WS/artifacts/signals.json" "$SNAPSHOT_DIR/" -g "$GATEWAY" 2>/dev/null || true
openshell sandbox download "$SANDBOX" "$WS/artifacts/heartbeat-log.jsonl" "$SNAPSHOT_DIR/" -g "$GATEWAY" 2>/dev/null || true
openshell sandbox download "$SANDBOX" "$WS/MEMORY.md" "$SNAPSHOT_DIR/" -g "$GATEWAY" 2>/dev/null || true
openshell sandbox download "$SANDBOX" /sandbox/.openclaw/cron/jobs.json "$SNAPSHOT_DIR/" -g "$GATEWAY" 2>/dev/null || true

echo "Done: $(find "$SNAPSHOT_DIR" -type f | wc -l) files, $(du -sh "$SNAPSHOT_DIR" | cut -f1)"
