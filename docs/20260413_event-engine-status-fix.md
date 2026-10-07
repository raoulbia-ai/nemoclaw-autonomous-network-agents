# Event Engine & Agent Status Fix — 2026-04-13

## Problem

After the infrastructure fix earlier today (cluster bounce, gateway restart, cron re-seed), the system showed two issues:

1. **Event engine not running** — faults would not spawn or resolve, leaving agents idle
2. **`agent-status.sh` false negative** — network server reported as "NOT responding" even though it was healthy (returning 401/200 correctly)

## Root Causes

### Event engine missing from post-onboard wire-up

The re-onboard wire-up script (`.local/re-onboard.sh`) starts the network server but **did not start the event engine**. The event engine (`/sandbox/network/ireland/event-engine.js`) is a separate process responsible for:
- Spawning new fault events on a tick schedule
- Resolving existing events when their `resolveAt` time passes
- Updating `state.json` with active/resolved event counts

Without it, the network state had 0 active events and 0 total events (fresh `state.json` after pod restart), and no new events would ever appear — agents had nothing to act on.

### `openshell sandbox exec` cannot reach localhost:8090

`agent-status.sh` used `openshell sandbox exec` to `curl` the network server's fault API inside the sandbox pod. However, `openshell sandbox exec` runs commands in a way that cannot reach `localhost:8090` inside the pod (network namespace isolation — curl returns exit code 7 "Failed to connect"). The server IS running and healthy when accessed via `kubectl exec` directly.

## Fixes

### 1. Started event engine (live fix)

```bash
sg docker -c "docker exec openshell-cluster-nemoclaw kubectl exec -n openshell my-assistant -c agent -- \
  sh -c 'cd /sandbox/network/ireland && nohup node event-engine.js > /tmp/event-engine.log 2>&1 &'"
```

### 2. Added event engine to re-onboard wire-up script (`.local/re-onboard.sh`)

Added an idempotent event-engine start block right after the network server start:

```sh
# 1b. Event engine (spawns/resolves faults — must start alongside the network server)
if pgrep -f "event-engine.js" >/dev/null 2>&1; then
  echo "event engine already running"
else
  cd /sandbox/network/ireland && nohup node event-engine.js > /tmp/event-engine.log 2>&1 &
  echo "event engine started (pid $!)"
fi
```

**Note:** `.local/` is gitignored — this fix lives on disk only, not in git. This is intentional (local operator tooling).

### 3. Fixed `agent-status.sh` network server detection

Changed the faults API check to use kubectl-via-docker as primary (same pattern as `read_in_sandbox`), with `openshell sandbox exec` as fallback:

```bash
FAULTS_OUT=$(sg docker -c "docker exec openshell-cluster-nemoclaw kubectl exec -n openshell $SANDBOX -c agent -- \
  curl -sf -H 'Authorization: Bearer test' http://127.0.0.1:8090/data-management/v1/faults/active" 2>/dev/null)
if [[ -n "$FAULTS_OUT" ]]; then
  echo "$FAULTS_OUT" > "$TMPDIR/faults-api.json"
else
  # fallback: openshell sandbox exec
  ...
fi
```

### 4. Added remediation hint for event engine check in `agent-status.sh`

The event engine NOT running message now includes the exact fix command:

```
⚠️  Event engine NOT running (faults won't spawn/resolve). Fix: sg docker -c 'docker exec ...'
```

## Verification

After fixes, `agent-status.sh` reports all green:

```
┌─ Infrastructure ──────────────────────────────────────────────
  ✅ Network server responding (port 8090)
  ✅ Network server running (PID 152)
  ✅ Event engine running (PID 2519)

┌─ Assessment ──────────────────────────────────────────────────
  Severity: OK
  • System healthy — agents cycling, fault load manageable
  • Growth: wave 15
```

## Files Changed

| File | Change | In Git? |
|------|--------|---------|
| `scripts/agent-status.sh` | kubectl-via-docker for faults API, event engine remediation hint | ✅ Yes |
| `.local/re-onboard.sh` | Added event engine start to wire-up | ❌ Gitignored (intentional) |

## Cross-References

