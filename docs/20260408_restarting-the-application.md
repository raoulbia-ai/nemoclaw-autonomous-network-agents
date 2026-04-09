# Restarting the Application

## What "the application" actually is

There is no single process. The system is a stack of layers:

```
Layer 4: Agent cron jobs (SENTINEL, ORACLE, ARCHITECT)
         ↑ scheduled by
Layer 3: OpenClaw gateway (Node.js, PID inside sandbox)
         ↑ runs inside
Layer 2: Sandbox pod (my-assistant, k3s namespace openshell)
         ↑ runs inside
Layer 1: k3s cluster container (openshell-cluster-nemoclaw, Docker)
         ↑ runs on
Layer 0: Host machine (WSL2 Linux)
```

Each layer can restart independently. What survives depends on which layer restarts.

## What survives each restart type

### Gateway restart
Kills and restarts Layer 3 (OpenClaw gateway). Everything else stays.

| Survives | Lost |
|----------|------|
| All agent artifacts | In-flight agent session (if one was running) |
| MEMORY.md | |
| Network server | |
| Symlinks, seed files | |
| Dynamic cron pacing (if cron store intact) | |

### Sandbox pod restart (`kubectl delete pod`)
Restarts Layers 2-4. The pod is recreated from the Docker image.

| Survives (baked in image) | Lost (ephemeral) |
|---------------------------|-------------------|
| Agent scripts, playbooks | All artifacts (topology, signals, MEMORY.md updates) |
| Network server code | Session transcripts |
| CA certs | Cron run history |
| Seed files (state.json, rebuild-status.json) | agent-comms.jsonl content |
| Combined CA bundle (recreated at boot) | Dynamic cron pacing |
| Symlinks (recreated at boot) | Network atlas history |

### Docker container restart (`docker restart openshell-cluster-nemoclaw`)
Restarts Layers 1-4. Same as pod restart — the sandbox is ephemeral.

### Host reboot
Restarts everything. Docker container must be started manually.

## After-reboot recovery

```bash
# 1. Start the k3s cluster container
docker start openshell-cluster-nemoclaw
sleep 15
```

No file uploads needed — everything is in the image.

## What "baked into the image" means

The `patch-nemoclaw.sh` script modifies the Docker image at build time.
These files are permanent — they survive any restart:

| Image path | Content |
|------------|---------|
| `/sandbox/agents/` | Agent scripts (collect.sh, remediate-all.js, set-cron-pace.js, etc.) |
| `/sandbox/network/` | Mock 5G server + Ireland data + CA certs |
| `/sandbox/playbooks/` | SENTINEL-FAST.md, ORACLE.md, ARCHITECT.md, MEMORY.md.template, SOUL.md |
| `/sandbox/brief.md` | Project brief |

## What `ina_startup()` recreates at every boot

The patched `nemoclaw-start.sh` runs before the gateway starts:

1. Copies playbooks from `/sandbox/playbooks/` → workspace
2. Creates `artifacts/` dir with seed files:
   - `state.json` → `{"growth_target":8000,"growth_wave_count":0}`
   - `signals.json` → `[]`
   - `agent-comms.jsonl` → empty
3. Creates `/sandbox/artifacts/rebuild-status.json` (ARCHITECT growth gate)
4. Symlinks `/sandbox/agents` and `/sandbox/network` into workspace
5. Creates combined CA bundle (OpenShell proxy CA + custom certs)
6. Starts network server

## What is NOT preserved and must be snapshotted

Run `./scripts/snapshot-artifacts.sh` before shutting down to save:
- Agent-written artifacts (topology, performance, signals, alarms, atlas)
- MEMORY.md (agent-updated shared state)
- Session transcripts (agent reasoning chains)
- Cron run history
- agent-comms.jsonl (inter-agent messages, pace changes)

These are saved to `artifacts/snapshots/` on the host (overwritten each run).

## When to rebuild the image

You need to re-run `patch-nemoclaw.sh` + `nemoclaw onboard` when:
- Agent scripts change (anything in `agents/`)
- Playbooks change (SENTINEL-FAST.md, ORACLE.md, ARCHITECT.md)
- Network server changes (server.js, data-ireland.js)
- New tools are added (e.g. set-cron-pace.js)

For quick iteration, use `openshell sandbox upload` to push files into the
live sandbox without rebuilding. But these uploads are lost on restart —
they must be baked into the image for permanence.
