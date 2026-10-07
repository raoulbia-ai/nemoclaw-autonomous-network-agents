#!/usr/bin/env python3
"""Inject a fault into the sandbox network state.

Runs INSIDE the sandbox. Reads a JSON fault template from stdin, appends
it to /sandbox/network/ireland/state.json with proper timestamps.

Usage (inside sandbox):
  echo '<fault-json>' | python3 inject.py

Fault template must have: id, type, affectedCells (array of URNs).
Optional: ghostAlarm, alarmId, durationHours (default 2).
"""

import json
import sys
import datetime

STATE_FILE = "/sandbox/network/ireland/state.json"

template = json.load(sys.stdin)

now = datetime.datetime.utcnow()
duration_hours = template.pop("durationHours", 2)
resolve = now + datetime.timedelta(hours=duration_hours)

event = {
    "id": template["id"],
    "type": template["type"],
    "startedAt": now.isoformat() + "Z",
    "resolveAt": resolve.isoformat() + "Z",
    "resolved": False,
    "affectedCells": template["affectedCells"],
    "ghostAlarm": template.get("ghostAlarm", False),
    "alarmId": template.get("alarmId"),
    "rerouted": False,
}

if event["ghostAlarm"]:
    event["ghostAlarmExpiresAt"] = (now + datetime.timedelta(hours=1)).isoformat() + "Z"

with open(STATE_FILE) as f:
    state = json.load(f)

state.setdefault("events", []).append(event)

with open(STATE_FILE, "w") as f:
    json.dump(state, f, indent=2)

print(f"  Injected: {event['id']} — {len(event['affectedCells'])} cells"
      f"{', ghost alarm active' if event['ghostAlarm'] else ''}")
