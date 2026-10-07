#!/usr/bin/env python3
"""Clear faults matching an id prefix from the sandbox network state.

Runs INSIDE the sandbox.

Usage (inside sandbox):
  python3 clear.py <id-prefix>    e.g. python3 clear.py evt-DEMO

Also clears matching entries from fault-fatigue.json.
"""

import json
import sys

STATE_FILE = "/sandbox/network/ireland/state.json"
FATIGUE_FILE = "/sandbox/.openclaw-data/workspace/artifacts/fault-fatigue.json"

if len(sys.argv) != 2:
    print("Usage: clear.py <id-prefix>", file=sys.stderr)
    sys.exit(1)

prefix = sys.argv[1]

# Clear from network state
with open(STATE_FILE) as f:
    state = json.load(f)
before = len(state.get("events", []))
state["events"] = [e for e in state.get("events", []) if not e["id"].startswith(prefix)]
removed_events = before - len(state["events"])
with open(STATE_FILE, "w") as f:
    json.dump(state, f, indent=2)

# Clear from fault-fatigue
removed_fatigue = 0
try:
    with open(FATIGUE_FILE) as f:
        fatigue = json.load(f)
    for k in list(fatigue.keys()):
        if k.startswith(prefix):
            del fatigue[k]
            removed_fatigue += 1
    with open(FATIGUE_FILE, "w") as f:
        json.dump(fatigue, f, indent=2)
except FileNotFoundError:
    pass

print(f"  Cleared {removed_events} event(s) and {removed_fatigue} fatigue entry(ies) matching '{prefix}'")
