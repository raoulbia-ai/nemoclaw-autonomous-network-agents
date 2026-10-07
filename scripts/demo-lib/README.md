# Demo Library

Helpers and fault templates for the autonomous-agent demo recording.

## One-command usage

```bash
./scripts/demo-record.sh
```

This runs the full workflow:
1. Prep environment (tunnel check, fault cleanup, cron kick)
2. Start asciinema recording
3. Run the demo (4 phases: status → history → inject → monitor)
4. Stop recording when ARCHITECT responds
5. Print replay instructions

Default output: `~/demo-YYYYMMDD-HHMM.cast`

## Structure

```
demo-lib/
├── README.md              (this file)
├── sandbox.sh             K_EXEC, K_CP_IN — sandbox exec helpers (sourced)
├── ui.sh                  section, pause, format_comms — UI helpers (sourced)
├── prep.sh                Pre-demo environment setup (executable)
└── faults/
    ├── inject.py          Runs IN sandbox: appends a fault to network state
    ├── clear.py           Runs IN sandbox: removes faults by id prefix
    └── *.json             Fault templates (data only, no code)
```

Two entry points live in `scripts/`:
- `demo-record.sh` — user-facing wrapper (prep + record + replay info)
- `demo-fault-injection.sh` — the recorded demo script (4 phases)

## Design principles

- **Data/code split.** Fault payloads are JSON templates, not embedded Python
  strings. Add a new scenario by dropping a `.json` file in `faults/`.
- **No nested quote escaping.** Python scripts are copied into the sandbox and
  executed there, instead of being eval'd through 3 layers of shell quoting.
- **Single entry point.** `./scripts/demo-record.sh` does everything.
- **Fail-fast prep.** If the tunnel is down, prep exits and tells you what to
  do on WSL, before wasting a recording.
- **Configurable via env vars** — no editing scripts to tweak behavior.

## Adding a new fault scenario

Create a new JSON file in `faults/` with this shape:

```json
{
  "id": "evt-DEMO-<scenario>",
  "type": "equipment_fault | backhaul_fault | interference | maintenance",
  "durationHours": 2,
  "ghostAlarm": true,
  "alarmId": "ALM-DEMO-<scenario>",
  "affectedCells": [
    "urn:3gpp:dn:SubNetwork=Ireland,MeContext=<site>,ManagedElement=1,GNBDUFunction=1,NRCellDU=<n>"
  ]
}
```

Then run with:

```bash
FAULT=scripts/demo-lib/faults/my-scenario.json ./scripts/demo-record.sh
```

## Env var reference

| Variable | Default | Purpose |
|----------|---------|---------|
| `FAULT` | `demo-lib/faults/multi-zone-equipment.json` | Fault template to inject |
| `MONITOR_ITERS` | `20` | Phase 4 polling iterations |
| `MONITOR_INTERVAL` | `30` | Seconds between polls |
| `CLUSTER` | `openshell-cluster-nemoclaw` | k8s cluster container name |
| `POD` | `my-assistant` | sandbox pod name |
| `NS` | `openshell` | k8s namespace |

## Replay a recording

```bash
asciinema play ~/demo-*.cast            # normal speed
asciinema play -s 2 ~/demo-*.cast       # 2x speed (recommended for demos)
asciinema play -i 1 ~/demo-*.cast       # cap idle time at 1s (trims waits)
```

## Troubleshooting

**Prep fails with "Tunnel not responding":**
Bounce the tunnel from WSL (not the VM):
```bash
~/bin/tunnel-llm-to-vm.sh kill
~/bin/tunnel-llm-to-vm.sh
```

**Phase 4 times out (no ARCHITECT response):**
ARCHITECT runs every 30min. If it errored or the tunnel flaked mid-run,
you may need to wait for the next tick or manually kick it:
```bash
sg docker -c "docker exec openshell-cluster-nemoclaw kubectl exec -n openshell my-assistant -c agent -- sh -c 'HOME=/sandbox openclaw cron run architect-001'"
```

**Want to try without recording first:**
```bash
./scripts/demo-lib/prep.sh
./scripts/demo-fault-injection.sh
```
