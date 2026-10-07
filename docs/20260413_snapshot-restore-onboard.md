# Snapshot Restore on Re-Onboard

**Date:** 2026-04-13
**Scope:** `scripts/onboard.sh`, `.local/re-onboard.sh`, `scripts/snapshot-artifacts.sh`

## Problem

`nemoclaw onboard --recreate-sandbox` wipes the pod. All ephemeral agent state — growth
progress, fault-fatigue lifecycle, agent memory, cron pacing, network simulation state —
is lost. The wire-up step then seeds empty stubs, so agents start from zero every time.

`snapshot-artifacts.sh` could save state to local disk, but nothing restored it.

## Fix

Snapshot restore is now **the default** in both onboarding scripts. After the sandbox
recreate and before wire-up, a new Step 3.5 uploads the snapshot files back into the pod.

### What gets restored

| File | Why it matters |
|------|---------------|
| `state.json` | Growth wave count, total cells, growth target |
| `accumulated-zones.json` | Zones added by ARCHITECT across growth waves |
| `fault-fatigue.json` | Remediation lifecycle state (avoids re-looping known-bad faults) |
| `agent-comms.jsonl` | Agent bulletin-board history |
| `MEMORY.md` | Agent long-term memory |
| `network-atlas.md` | Cell topology reference built by agents |
| `signals.json`, `alarms.json` | Current network signal/alarm state |
| `city-params.json`, `topology.json` | Growth planning data |
| `cron/jobs.json` | Agent-adjusted pacing (not reset to baseline 5/15/60 min) |
| `network/ireland/state.json` | Live network simulation state (cells, alarms, PM counters) |
| `atlas-history/` | Historical topology snapshots |

### What happens when no snapshot exists

The scripts fall through gracefully. Wire-up seeds baseline stubs exactly as before:
- `state.json` → `{"growth_target":8000,"growth_wave_count":0}`
- `signals.json` → `[]`
- `rebuild-status.json` → `{"status":"ok","cells":266,"hash":"seed"}`
- `cron/jobs.json` → baseline from `nemoclaw-blueprint/cron-seed/jobs.json`

### CLI

```bash
# Default: restore snapshot if available
./scripts/onboard.sh
./.local/re-onboard.sh

# Start completely fresh (ignore existing snapshot)
./scripts/onboard.sh --no-restore
./.local/re-onboard.sh --no-restore

# Custom snapshot location
SNAPSHOT_DIR=/path/to/snap ./scripts/onboard.sh
```

### Typical workflow

```bash
# 1. Before shutdown or re-onboard:
./scripts/snapshot-artifacts.sh

# 2. Re-onboard (snapshot is auto-restored):
./.local/re-onboard.sh

# Agents pick up where they left off — same growth wave, same fault state, same cron pacing.
```

### Implementation details

- **Step ordering**: restore runs between `nemoclaw onboard` (Step 3) and wire-up (Step 4),
  so files are in place before the network server and gateway start.
- **Cron seeding**: snapshot's `jobs.json` is preferred over the baseline seed. If the
  snapshot has agent-adjusted intervals (e.g. SENTINEL at 2 min during a fault cascade),
  those are preserved. Baseline seed is only used when no snapshot exists.
- **Wire-up stubs**: the `[ -f ... ] ||` guards already skip stub creation when a file
  exists. The wire-up now also logs when it skips ("restored from snapshot, keeping").
- **`--no-restore`**: explicitly skips Step 3.5 even when a snapshot is present.
  Useful when the snapshot is corrupt or you want a truly clean start.
- **Missing `jobs.json`**: `snapshot-artifacts.sh` downloads cron state via
  `openshell sandbox download`, which may fail silently if the gateway is down.
  If `jobs.json` is absent from the snapshot, the onboard script falls back to
  the baseline `cron-seed/jobs.json`. This is fine — agent pacing resets to
  default but agents will re-adjust on their next tick.

### Files changed

| File | Change |
|------|--------|
| `scripts/onboard.sh` | Added `SNAPSHOT_DIR`, `RESTORE_SNAPSHOT`, `--no-restore`, Step 3.5 restore logic, cron-restore-prefer-snapshot, wire-up logging |
| `.local/re-onboard.sh` | Same restore logic adapted for tunnel-mode quoting (`sg docker -c`, different `K_EXEC`/`K_CP_IN`) |
| `scripts/README.md` | Documented `onboard.sh`, `--no-restore`, snapshot-restore workflow; fixed snapshot dir name |
