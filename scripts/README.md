# scripts/

Host-side utility scripts for operating the Ireland Network Agents sandbox.
Nothing here runs inside the sandbox — these are operator tools.

| Script | Purpose |
|--------|---------|
| `agent-status.sh` | Health check and activity assessment for running agents |
| `snapshot-artifacts.sh` | Save agent state from the sandbox to local disk before shutdown |
| `onboard.sh` | (Re)onboard the sandbox with automatic snapshot restore |

---

## agent-status.sh

Check whether the agents are running, what they're doing, and whether anything needs attention.

```bash
./scripts/agent-status.sh                # full report
./scripts/agent-status.sh --json         # machine-readable JSON
./scripts/agent-status.sh --quiet        # only problems (exit 1 if unhealthy)
./scripts/agent-status.sh --sandbox foo  # target a different sandbox name
```

The report has five sections:

| Section | What it checks |
|---------|---------------|
| Infrastructure | Network server responding + running, event engine running |
| Cron Jobs | All three agents (SENTINEL/ORACLE/ARCHITECT) present, enabled, schedule |
| Network State | Tick count, active faults with detail (type, affected cells, ghost alarms, reroutes), fault fatigue |
| Agent Activity | Bulletin board comms count and recent messages, growth waves, MEMORY.md freshness |
| Assessment | Severity (OK / WARNING / CRITICAL), what agents are currently doing, overall system state |

**`--json` output** includes: `cron`, `network` (tick count, active events by type), `growth`, `fatigue`, `rebuild`, `faults_endpoint`, `server_healthy`.

**`--quiet`** exits 0 if everything is healthy, 1 if any problems were found. Useful for cron monitoring or CI.

---

## snapshot-artifacts.sh

Agent state (comms, signals, fatigue, etc.) is ephemeral — lost on pod restart. Run this before shutting down to preserve a local copy:

```bash
./scripts/snapshot-artifacts.sh
```

Writes to `artifacts/snapshots/` in the project root. Overwrites any previous snapshot.

The snapshot is **automatically restored** on the next `onboard.sh` run — see below.

---

## onboard.sh

(Re)onboard the Ireland Network Agents sandbox with automatic snapshot restore.

```bash
./scripts/onboard.sh                          # restore snapshot if available
./scripts/onboard.sh --no-restore              # start completely fresh
SNAPSHOT_DIR=/path/to/snap ./scripts/onboard.sh  # custom snapshot location
```

**Snapshot restore** (default on): after `nemoclaw onboard --recreate-sandbox` creates a fresh sandbox, step 3.5 uploads the snapshot files back into the pod before wire-up. This preserves:

| What | Why it matters |
|------|---------------|
| `state.json`, `accumulated-zones.json` | Growth progress (wave count, cells built) |
| `fault-fatigue.json` | Remeditation state (avoids re-looping known-bad faults) |
| `agent-comms.jsonl` | Agent communication history |
| `MEMORY.md`, `network-atlas.md` | Agent long-term memory |
| `cron/jobs.json` | Agent-adjusted pacing (not reset to baseline) |
| `network/ireland/state.json` | Live network simulation state |

If no snapshot exists, the script falls back to baseline stubs (fresh start). Use `--no-restore` to explicitly skip restore even when a snapshot is present.

The typical workflow is:

```bash
# Before shutdown / re-onboard:
./scripts/snapshot-artifacts.sh

# After:
./scripts/onboard.sh     # snapshot is auto-restored
```

---

