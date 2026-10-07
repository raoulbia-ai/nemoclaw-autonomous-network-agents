#!/usr/bin/env bash
# ── NKA Agent Status Check ──────────────────────────────────────────────
# Reusable health check and activity assessment for Ireland Network Agents.
#
# Usage:
#   ./scripts/agent-status.sh              # full report
#   ./scripts/agent-status.sh --json       # machine-readable output
#   ./scripts/agent-status.sh --quiet      # only problems (exit 1 if unhealthy)
#
# Reads from the sandbox via openshell CLI — no host-side state needed.
# ────────────────────────────────────────────────────────────────────────

set -uo pipefail

SANDBOX="my-assistant"
JSON_MODE=false
QUIET_MODE=false

for arg in "$@"; do
  case "$arg" in
    --json)   JSON_MODE=true ;;
    --quiet)  QUIET_MODE=true ;;
    --sandbox=*) SANDBOX="${arg#--sandbox=}" ;;
    -h|--help) echo "Usage: $0 [--json|--quiet] [--sandbox=<name>]"; exit 0 ;;
  esac
done

# ── Helpers ─────────────────────────────────────────────────────────────

exec_in_sandbox() {
  openshell sandbox exec -n "$SANDBOX" -- sh -c "$1" 2>&1
}

strip_ansi() {
  sed 's/\x1b\[[0-9;]*[a-zA-Z]//g'
}

# Read a file from the sandbox. Uses kubectl-via-docker (runs as root)
# to avoid permission-denied on root-owned files like jobs.json (0600).
# Falls back to openshell sandbox exec if docker/kubectl unavailable.
read_in_sandbox() {
  local file="$1"
  local fallback="${2:-{}}"
  local out
  # Prefer kubectl-via-docker (runs as root inside the pod)
  out=$(sg docker -c "docker exec openshell-cluster-nemoclaw kubectl exec -n openshell $SANDBOX -- cat $file" 2>/dev/null) && echo "$out" && return
  # Fallback: openshell sandbox exec (may fail on root-owned 0600 files)
  out=$(openshell sandbox exec -n "$SANDBOX" -- cat "$file" 2>/dev/null)
  if [[ -n "$out" ]]; then
    echo "$out"
  else
    echo "$fallback"
  fi
}

# ── Pre-flight ──────────────────────────────────────────────────────────

if ! command -v openshell &>/dev/null; then
  echo "ERROR: openshell CLI not found" >&2; exit 1
fi

SANDBOX_PHASE=$(openshell sandbox list 2>&1 | strip_ansi | awk -v s="$SANDBOX" '$1==s{print $NF}')
if [[ -z "$SANDBOX_PHASE" ]]; then
  echo "ERROR: sandbox '$SANDBOX' not found" >&2; exit 1
fi
if [[ "$SANDBOX_PHASE" != "Ready" ]]; then
  echo "ERROR: sandbox '$SANDBOX' is $SANDBOX_PHASE, not Ready" >&2; exit 1
fi

# ── Data collection (temp files, no shell-variable JSON) ────────────────

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# File reads: use read_in_sandbox (kubectl-via-docker, root access)
read_in_sandbox /sandbox/.openclaw-data/cron/jobs.json '{}' > "$TMPDIR/cron.json"
read_in_sandbox /sandbox/network/ireland/state.json '{}' > "$TMPDIR/network-state.json"
read_in_sandbox /sandbox/.openclaw-data/workspace/artifacts/agent-comms.jsonl '' > "$TMPDIR/comms.jsonl" 2>/dev/null
read_in_sandbox /sandbox/.openclaw-data/workspace/artifacts/state.json '{}' > "$TMPDIR/growth.json"
read_in_sandbox /sandbox/.openclaw-data/workspace/artifacts/fault-fatigue.json '{}' > "$TMPDIR/fatigue.json"
read_in_sandbox /sandbox/.openclaw-data/workspace/artifacts/rebuild-status.json '{"status":"unknown"}' > "$TMPDIR/rebuild.json"

# Fallback to /sandbox/artifacts/ if primary path was empty
if [[ ! -s "$TMPDIR/comms.jsonl" ]]; then
  read_in_sandbox /sandbox/artifacts/agent-comms.jsonl '' > "$TMPDIR/comms.jsonl" 2>/dev/null
fi
if [[ "$(cat "$TMPDIR/fatigue.json")" == "{}" ]]; then
  out=$(read_in_sandbox /sandbox/artifacts/fault-fatigue.json '{}')
  [[ "$out" != "{}" ]] && echo "$out" > "$TMPDIR/fatigue.json"
fi

# HTTP endpoints: prefer kubectl-via-docker (openshell sandbox exec fails to reach localhost:8090
# due to network namespace isolation). Fall back to openshell sandbox exec.
FAULTS_OUT=$(sg docker -c "docker exec openshell-cluster-nemoclaw kubectl exec -n openshell $SANDBOX -c agent -- curl -sf -H 'Authorization: Bearer test' http://127.0.0.1:8090/data-management/v1/faults/active" 2>/dev/null)
if [[ -n "$FAULTS_OUT" ]]; then
  echo "$FAULTS_OUT" > "$TMPDIR/faults-api.json"
else
  exec_in_sandbox 'curl -sf -H "Authorization: Bearer test" http://127.0.0.1:8090/data-management/v1/faults/active 2>/dev/null || echo "{\"error\":\"unreachable\"}"' > "$TMPDIR/faults-api.json"
fi

# Cell inventory from the network API (3GPP topology endpoint)
CELLS_OUT=$(sg docker -c "docker exec openshell-cluster-nemoclaw kubectl exec -n openshell $SANDBOX -c agent -- curl -sf -H 'Authorization: Bearer test' http://127.0.0.1:8090/topology-inventory/v1/domains/RAN/entity-types/NRCellDU/entities" 2>/dev/null)
if [[ -n "$CELLS_OUT" ]]; then
  echo "$CELLS_OUT" > "$TMPDIR/cells-api.json"
else
  exec_in_sandbox 'curl -sf -H "Authorization: Bearer test" http://127.0.0.1:8090/topology-inventory/v1/domains/RAN/entity-types/NRCellDU/entities 2>/dev/null || echo "{\"error\":\"unreachable\"}"' > "$TMPDIR/cells-api.json"
fi

# Process listing: must use exec_in_sandbox
PROCESSES=$(exec_in_sandbox 'for p in /proc/[0-9]*/cmdline; do pid=$(echo $p | cut -d/ -f3); cmd=$(tr "\0" " " < $p 2>/dev/null); [ -n "$cmd" ] && echo "$pid $cmd"; done 2>/dev/null' | tr -d '\0')

# MEMORY.md
MEMORY_MD=$(read_in_sandbox /sandbox/.openclaw-data/workspace/MEMORY.md 'not found' 2>/dev/null)
if [[ "$MEMORY_MD" == "not found" ]]; then
  MEMORY_MD=$(exec_in_sandbox 'head -5 /sandbox/.openclaw-data/workspace/MEMORY.md 2>/dev/null || echo "not found"')
fi

COMMS_COUNT=$(wc -l < "$TMPDIR/comms.jsonl" | tr -d ' ')

# ── Write python helper scripts to TMPDIR (avoids quote-escaping hell) ─

cat > "$TMPDIR/json_report.py" << 'PYEOF'
import json, sys

tmpdir = sys.argv[1]
sandbox = sys.argv[2]
phase = sys.argv[3]

def load(name):
    try:
        with open(f"{tmpdir}/{name}") as f:
            return json.load(f)
    except Exception:
        return {}

cron = load("cron.json")
net = load("network-state.json")
growth = load("growth.json")
fatigue = load("fatigue.json")
health = load("faults-api.json")
rebuild = load("rebuild.json")

cells_api = load("cells-api.json")
cells_api_info = {}
if isinstance(cells_api, dict) and "totalCount" in cells_api:
    cells_api_info = {"count": cells_api["totalCount"], "items_returned": len(cells_api.get("items", []))}
elif isinstance(cells_api, list):
    cells_api_info = {"count": len(cells_api)}
elif isinstance(cells_api, dict) and "error" in cells_api:
    cells_api_info = {"error": True}
else:
    cells_api_info = {"count": cells_api.get("totalCount", cells_api.get("count", "?"))}

result = {
    "sandbox": sandbox,
    "phase": phase,
    "cron": {"jobs": len(cron.get("jobs", [])), "all_enabled": all(j.get("enabled", False) for j in cron.get("jobs", []))},
    "network": {
        "tick_count": net.get("tickCount", 0),
        "total_events": len(net.get("events", [])),
        "active_events": sum(1 for e in net.get("events", []) if not e.get("resolved", True)),
        "active_by_type": {},
    },
    "growth": growth,
    "cells_api": cells_api_info,
    "fatigue": {"count": len(fatigue), "events": list(fatigue.keys())},
    "rebuild": rebuild,
    "faults_endpoint": health.get("count", health.get("error", "?")),
    "server_healthy": "error" not in health,
}
for e in net.get("events", []):
    if not e.get("resolved", True):
        t = e.get("type", "unknown")
        result["network"]["active_by_type"][t] = result["network"]["active_by_type"].get(t, 0) + 1
print(json.dumps(result, indent=2))
PYEOF

cat > "$TMPDIR/cron_display.py" << 'PYEOF'
import json, sys

with open(sys.argv[1]) as f:
    d = json.load(f)
for j in d.get("jobs", []):
    enabled = "✅" if j.get("enabled") else "❌"
    name = j.get("name", j.get("id", "?"))
    schedule = j.get("schedule", {}).get("expr", j.get("schedule", {}).get("cron", "?"))
    model = j.get("payload", {}).get("model", "?")
    short_model = model.split("/")[-1] if "/" in str(model) else model
    print(f"  {enabled} {name:12s}  every {schedule:12s}  model={short_model}")
PYEOF

cat > "$TMPDIR/network_display.py" << 'PYEOF'
import json, re, sys

with open(sys.argv[1]) as f:
    d = json.load(f)
active = [e for e in d.get("events", []) if not e.get("resolved", True)]
if not active:
    print("  No active faults")
else:
    by_type = {}
    for e in active:
        t = e.get("type", "?")
        by_type.setdefault(t, []).append(e)
    for t, evts in sorted(by_type.items()):
        cells = set()
        for e in evts:
            for c in e.get("affectedCells", []):
                m = re.search(r"NRCellDU=(\d+)", c)
                cells.add(f"NRCellDU-{m.group(1)}" if m else c[:30])
        print(f"  🔴 {t:20s} ×{len(evts)}  cells={','.join(sorted(cells))}")
        for e in evts:
            ghost = " 👻ghost" if e.get("ghostAlarm") else ""
            reroute = " ↩rerouted" if e.get("rerouted") else ""
            alarm = f' alarm={e["alarmId"]}' if e.get("alarmId") else ""
            print(f'     {e["id"]}  since {e["startedAt"][:16]}{ghost}{reroute}{alarm}')
PYEOF

cat > "$TMPDIR/fatigue_display.py" << 'PYEOF'
import json, sys

with open(sys.argv[1]) as f:
    d = json.load(f)
for eid, info in d.items():
    state = info.get("state", "?")
    attempts = info.get("attempts", 0)
    print(f"  ⏳ Fatigued: {eid}  state={state}  attempts={attempts}")
PYEOF

cat > "$TMPDIR/comms_display.py" << 'PYEOF'
import json, sys

with open(sys.argv[1]) as f:
    lines = [l.strip() for l in f if l.strip()]
count = int(sys.argv[2]) if len(sys.argv) > 2 else len(lines)
for line in lines[-count:]:
    try:
        d = json.loads(line)
        fr = d.get("from", "?")
        tp = d.get("type", "?")
        msg = d.get("message", "")[:80]
        at = d.get("at", "?")[:19]
        print(f"    {at}  {fr:10s}  {tp:15s}  {msg}")
    except Exception:
        pass
PYEOF

cat > "$TMPDIR/assessment.py" << 'PYEOF'
import json, sys

tmpdir = sys.argv[1]
comms_count = int(sys.argv[2])

def load(name):
    try:
        with open(f"{tmpdir}/{name}") as f:
            return json.load(f)
    except Exception:
        return {}

cron = load("cron.json")
net = load("network-state.json")
growth = load("growth.json")
fatigue = load("fatigue.json")
health = load("faults-api.json")

server_ok = "count" in health
jobs = cron.get("jobs", [])
all_enabled = all(j.get("enabled", False) for j in jobs) if jobs else False
active = [e for e in net.get("events", []) if not e.get("resolved", True)]
active_types = {}
for e in active:
    t = e.get("type", "?")
    active_types.setdefault(t, []).append(e)
tick = net.get("tickCount", 0)
fatigued = len(fatigue)
waves = growth.get("growth_wave_count", 0)

notes = []
severity = "OK"

if not server_ok:
    notes.append("Network server DOWN — agents cannot collect data or remediate")
    severity = "CRITICAL"
elif not all_enabled:
    notes.append("Some cron jobs disabled — agents not running on schedule")
    severity = "WARNING"
else:
    # Detect stalled agents: if a job hasn't run in 3x its interval, something is wrong
    import datetime, re
    now_ms = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)
    for j in jobs:
        expr = j.get("schedule", {}).get("expr", "")
        m = re.search(r"\*/(\d+)", expr)
        interval_ms = int(m.group(1)) * 60000 if m else 900000  # default 15min
        last_run = j.get("state", {}).get("lastRunAtMs", 0)
        if last_run and (now_ms - last_run) > interval_ms * 3:
            name = j.get("name", j.get("id", "?"))
            last_dt = datetime.datetime.fromtimestamp(last_run / 1000, tz=datetime.timezone.utc)
            stale_min = (now_ms - last_run) / 60000
            notes.append(f"{name.upper()} stalled — last ran {last_dt:%H:%M} UTC ({stale_min:.0f}min ago, schedule is {expr})")
            severity = "WARNING" if severity == "OK" else severity
if comms_count <= 2:
    notes.append("No agent cycles completed yet — cron jobs exist but no output")
    severity = "WARNING" if severity == "OK" else severity
elif len(active) > 5:
    notes.append(f"High fault load: {len(active)} active faults — agents may be overwhelmed")
    severity = "WARNING"

if fatigued > 0:
    stuck = sum(1 for v in fatigue.values() if v.get("state") == "stuck")
    if stuck > 0:
        notes.append(f"{stuck} stuck fault(s) — automated remediation exhausted, needs operator attention")
        severity = "WARNING" if severity == "OK" else severity

if not notes:
    if comms_count > 10 and len(active) <= 3:
        notes.append("System healthy — agents cycling, fault load manageable")
    elif len(active) == 0:
        notes.append("System idle — no active faults, agents on standby")
    else:
        notes.append(f"System operating — {len(active)} active fault(s) being handled")

# What agents are doing
if comms_count <= 2:
    notes.append("Agents: NOT YET ACTIVE (no cycle output detected)")
elif len(active) == 0:
    notes.append("Agents: monitoring — no faults to act on")
else:
    agent_actions = []
    for t, evts in active_types.items():
        if t == "equipment_fault":
            agent_actions.append(f"REMEDIATING {len(evts)} equipment fault(s)")
        elif t == "backhaul_fault":
            agent_actions.append(f"REMEDIATING {len(evts)} backhaul fault(s)")
        elif t == "interference":
            agent_actions.append(f"OBSERVING {len(evts)} interference event(s)")
        elif t == "maintenance":
            agent_actions.append(f"TRACKING {len(evts)} maintenance window(s)")
    if agent_actions:
        notes.append("Agents: " + ", ".join(agent_actions))

notes.append(f"Event engine: tick {tick}, {len(active)} active / {len(net.get('events', []))} total events")
total_cells = growth.get('totalCells', '?')
notes.append(f"Growth: wave {waves}, {total_cells} cells")

print(f"  Severity: {severity}")
for n in notes:
    print(f"  • {n}")
PYEOF

# ── JSON output mode ────────────────────────────────────────────────────

if $JSON_MODE; then
  python3 "$TMPDIR/json_report.py" "$TMPDIR" "$SANDBOX" "$SANDBOX_PHASE" 2>/dev/null
  exit 0
fi

# ── Human-readable report ───────────────────────────────────────────────

PROBLEMS=0

report_problem() {
  PROBLEMS=$((PROBLEMS + 1))
  if $QUIET_MODE; then return; fi
  echo "  ⚠️  $1"
}

report_ok() {
  if $QUIET_MODE; then return; fi
  echo "  ✅ $1"
}

echo ""
if ! $QUIET_MODE; then
  echo "═══════════════════════════════════════════════════════════════"
  echo "  NKA Agent Status — $(date -u '+%Y-%m-%d %H:%M UTC')"
  echo "═══════════════════════════════════════════════════════════════"
  echo ""
fi

# ── Infrastructure ──────────────────────────────────────────────────────

if ! $QUIET_MODE; then echo "┌─ Infrastructure ──────────────────────────────────────────────"; fi

if python3 -c "import json,sys; d=json.load(open('$TMPDIR/faults-api.json')); sys.exit(0 if 'count' in d else 1)" 2>/dev/null; then
  report_ok "Network server responding (port 8090)"
else
  report_problem "Network server NOT responding"
fi

SERVER_PID=$(echo "$PROCESSES" | grep "server.js" | awk '{print $1}' | head -1 || true)
EVENT_PID=$(echo "$PROCESSES" | grep "event-engine" | awk '{print $1}' | head -1 || true)
if [[ -n "$SERVER_PID" ]]; then
  report_ok "Network server running (PID $SERVER_PID)"
else
  report_problem "Network server NOT running"
fi
if [[ -n "$EVENT_PID" ]]; then
  report_ok "Event engine running (PID $EVENT_PID)"
else
  report_problem "Event engine NOT running (faults won't spawn/resolve). Fix: sg docker -c 'docker exec openshell-cluster-nemoclaw kubectl exec -n openshell my-assistant -c agent -- sh -c \"cd /sandbox/network/ireland && nohup node event-engine.js > /tmp/event-engine.log 2>&1 &\"'"
fi

echo ""

# ── Cron Jobs ───────────────────────────────────────────────────────────

if ! $QUIET_MODE; then echo "┌─ Cron Jobs ───────────────────────────────────────────────────"; fi

JOBS_COUNT=$(python3 -c "import json; d=json.load(open('$TMPDIR/cron.json')); print(len(d.get('jobs',[])))" 2>/dev/null || echo "0")
ALL_ENABLED=$(python3 -c "import json; d=json.load(open('$TMPDIR/cron.json')); print(all(j.get('enabled',False) for j in d.get('jobs',[])))" 2>/dev/null || echo "False")

python3 "$TMPDIR/cron_display.py" "$TMPDIR/cron.json" 2>/dev/null

if [[ "$JOBS_COUNT" != "3" ]]; then
  report_problem "Expected 3 cron jobs, found $JOBS_COUNT"
fi
if [[ "$ALL_ENABLED" != "True" ]]; then
  report_problem "Not all cron jobs are enabled"
fi

echo ""

# ── Network State ───────────────────────────────────────────────────────

if ! $QUIET_MODE; then echo "┌─ Network State ───────────────────────────────────────────────"; fi

TICK_COUNT=$(python3 -c "import json; print(json.load(open('$TMPDIR/network-state.json')).get('tickCount',0))" 2>/dev/null || echo "?")
ACTIVE_COUNT=$(python3 -c "import json; d=json.load(open('$TMPDIR/network-state.json')); print(sum(1 for e in d.get('events',[]) if not e.get('resolved',True)))" 2>/dev/null || echo "?")
TOTAL_COUNT=$(python3 -c "import json; d=json.load(open('$TMPDIR/network-state.json')); print(len(d.get('events',[])))" 2>/dev/null || echo "?")

if ! $QUIET_MODE; then
  echo "  Ticks: $TICK_COUNT  |  Active faults: $ACTIVE_COUNT  |  Total events: $TOTAL_COUNT"
fi

python3 "$TMPDIR/network_display.py" "$TMPDIR/network-state.json" 2>/dev/null

FATIGUE_COUNT=$(python3 -c "import json; print(len(json.load(open('$TMPDIR/fatigue.json'))))" 2>/dev/null || echo "0")
if [[ "$FATIGUE_COUNT" != "0" ]]; then
  echo ""
  python3 "$TMPDIR/fatigue_display.py" "$TMPDIR/fatigue.json" 2>/dev/null
fi

echo ""

# ── Agent Activity ──────────────────────────────────────────────────────

if ! $QUIET_MODE; then echo "┌─ Agent Activity ──────────────────────────────────────────────"; fi

if [[ "$COMMS_COUNT" -le 2 ]]; then
  report_problem "Agent comms nearly empty ($COMMS_COUNT lines) — agents may not have completed a cycle"
  if ! $QUIET_MODE; then
    echo "  Last comms:"
    python3 "$TMPDIR/comms_display.py" "$TMPDIR/comms.jsonl" "$COMMS_COUNT" 2>/dev/null
  fi
else
  report_ok "Agent comms active ($COMMS_COUNT messages)"
  if ! $QUIET_MODE; then
    echo "  Recent messages (last 5):"
    python3 "$TMPDIR/comms_display.py" "$TMPDIR/comms.jsonl" 5 2>/dev/null
  fi
fi

GROWTH_WAVES=$(python3 -c "import json; print(json.load(open('$TMPDIR/growth.json')).get('growth_wave_count',0))" 2>/dev/null || echo "?")
GROWTH_TARGET=$(python3 -c "import json; print(json.load(open('$TMPDIR/growth.json')).get('growth_target','?'))" 2>/dev/null || echo "?")
GROWTH_TOTAL_CELLS=$(python3 -c "import json; print(json.load(open('$TMPDIR/growth.json')).get('totalCells','?'))" 2>/dev/null || echo "?")
GROWTH_LAST_AT=$(python3 -c "import json; print(json.load(open('$TMPDIR/growth.json')).get('last_growth_at','?'))" 2>/dev/null || echo "?")
API_CELL_COUNT=$(python3 -c "import json; d=json.load(open('$TMPDIR/cells-api.json')); print(d.get('totalCount', len(d.get('items',[])))) if isinstance(d, dict) else print(len(d))" 2>/dev/null || echo "?")
if ! $QUIET_MODE; then
  echo "  Growth: wave $GROWTH_WAVES / target $GROWTH_TARGET"
  echo "  Cells: $GROWTH_TOTAL_CELLS (state.json)  |  $API_CELL_COUNT (API /cells)"
  echo "  Last growth at: $GROWTH_LAST_AT"
fi

# MEMORY.md freshness: check last_atlas_at (set by ORACLE) as primary signal,
# fall back to "Last updated" header if last_atlas_at is absent.
MEMORY_ATLAS_AT=$(echo "$MEMORY_MD" | grep 'last_atlas_at' | head -1 | sed 's/.*last_atlas_at\*\*: *//' | sed 's/^ *//' | tr -d '\n')
MEMORY_UPDATED=$(echo "$MEMORY_MD" | grep -i 'last updated' | head -1 | sed 's/.*Last updated: *//' | tr -d ' ')
if [[ -n "$MEMORY_ATLAS_AT" && "$MEMORY_ATLAS_AT" != "null" ]]; then
  report_ok "MEMORY.md last_atlas_at: $MEMORY_ATLAS_AT"
elif [[ -n "$MEMORY_UPDATED" && "$MEMORY_UPDATED" != *"not yet"* && "$MEMORY_UPDATED" != *"(not"* ]]; then
  report_ok "MEMORY.md last updated: $MEMORY_UPDATED"
else
  report_problem "MEMORY.md not yet updated — ORACLE has not completed a cycle"
fi

echo ""

# ── Assessment ──────────────────────────────────────────────────────────

if ! $QUIET_MODE; then echo "┌─ Assessment ──────────────────────────────────────────────────"; fi

python3 "$TMPDIR/assessment.py" "$TMPDIR" "$COMMS_COUNT" 2>/dev/null

echo ""

# ── Summary ─────────────────────────────────────────────────────────────

if $QUIET_MODE; then
  if [[ "$PROBLEMS" -gt 0 ]]; then exit 1; fi
  exit 0
fi

echo "═══════════════════════════════════════════════════════════════"
if [[ "$PROBLEMS" -gt 0 ]]; then
  echo "  Issues found: $PROBLEMS"
else
  echo "  All checks passed ✅"
fi
echo "═══════════════════════════════════════════════════════════════"
echo ""
