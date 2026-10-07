#!/usr/bin/env bash
# demo-record.sh — One-command demo recording workflow.
#
# Does the full dance:
#   1. Prep the environment (check tunnel, clear test faults, kick crons)
#   2. Remove any old cast file with the same name
#   3. Start asciinema recording
#   4. Run the demo-fault-injection.sh inside the recording
#   5. Stop recording when the demo completes
#   6. Print replay instructions
#
# Usage:
#   ./scripts/demo-record.sh [cast-file]
#
# Default cast file: ~/demo-YYYYMMDD-HHMM.cast

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB="$SCRIPT_DIR/demo-lib"

# shellcheck source=./demo-lib/ui.sh
. "$LIB/ui.sh"

CAST_FILE="${1:-$HOME/demo-$(date +%Y%m%d-%H%M).cast}"
TITLE="NKA Autonomous Fault Response"

# Dependency checks
command -v asciinema >/dev/null 2>&1 || {
  echo "asciinema not installed. Install with: sudo apt-get install asciinema" >&2
  exit 1
}

# Step 1: Prep (exits non-zero if tunnel down)
if ! bash "$LIB/prep.sh"; then
  echo ""
  echo "Prep failed. Fix the tunnel and retry."
  exit 1
fi

# Step 2: Remove existing cast file if present
if [ -f "$CAST_FILE" ]; then
  section "Removing existing cast file"
  echo "  $CAST_FILE"
  rm -f "$CAST_FILE"
fi

# Step 3–5: Record the demo
section "Starting recording → $CAST_FILE"
echo "  Recording begins now. Demo script runs inside asciinema."
echo "  Will stop automatically when demo completes."
echo ""

asciinema rec --title "$TITLE" --command "$SCRIPT_DIR/demo-fault-injection.sh" "$CAST_FILE"

# Step 6: Replay instructions
section "Recording complete"
echo "  File: $CAST_FILE"
echo "  Size: $(du -h "$CAST_FILE" | cut -f1)"
echo ""
echo "  Replay options:"
echo "    asciinema play $CAST_FILE          # normal speed"
echo "    asciinema play -s 2 $CAST_FILE     # 2x speed"
echo "    asciinema play -i 1 $CAST_FILE     # cap idle time at 1s"
echo ""
echo "  Upload (optional, creates public link):"
echo "    asciinema upload $CAST_FILE"
