# Brief

Three autonomous agents (SENTINEL, ORACLE, ARCHITECT) operate a simulated
Irish 5G network. The simulation, the agents, and all state run inside a
single OpenShell sandbox. The host runs nothing except the `openshell` CLI.

## What's in here

- `network/` — mock 3GPP-shaped Irish 5G network. Pure node stdlib, zero npm
  dependencies. Runs as two processes: `server.js` (HTTP API on
  127.0.0.1:8090) and `ireland/event-engine.js` (simulation tick loop).
  State lives in `network/ireland/state.json`.
- `agents/nka/scripts/` — the scripts the three agents call from their
  playbooks. The most important is `remediate-all.js`, which drains the
  active fault queue from network ground truth (the agent never types IDs).
- `agents/shared/tools/` — helpers shared across agents (bulletin board
  posting, delta detection, self-assessment, run-state updates).
- `nemoclaw-blueprint/` — sandbox build config: `blueprint.yaml` (sandbox
  + agent definitions), `policy.yaml` (filesystem + network egress),
  `cron-seed/jobs.json` (the three cron schedules), `playbooks/` (the
  agent playbooks injected at session start).
- `artifacts/` — runtime state. Mostly gitignored. The agents read and
  write here every cycle.

## Run it

```sh
openshell gateway start -g nemoclaw
nemoclaw onboard           # builds the sandbox from this blueprint
openshell sandbox connect nka-telco
```

Inside the sandbox, the network server and event engine start automatically
during onboarding. The cron jobs fire on their own schedules:

- SENTINEL every 5 minutes
- ORACLE every 15 minutes
- ARCHITECT every 30 minutes

To stop:

```sh
openshell gateway stop -g nemoclaw      # preserves state
openshell gateway destroy -g nemoclaw   # destroys state
```

## How the agents talk

There is no direct inter-agent RPC. They coordinate via two append-only
files in `artifacts/`:

- `agent-comms.jsonl` — bulletin board. Each agent writes its handoffs and
  advisories here, others read them.
- `state.json` — growth bookkeeping (wave count, last growth timestamp).
  Only `log-growth.js` writes to it.

For urgent remediation, an agent can post a message with
`priority: "urgent"` and `wakeTarget: "<AGENT>"`. A sandbox-internal
watcher picks it up and patches the target's `nextRunAtMs` so the next
gateway tick fires it immediately.

## How the agents act on the network

Three endpoints, all under the `/data-management/v1/` prefix on the
network server (which the agents reach on loopback at 127.0.0.1:8090):

- `GET /data-management/v1/faults/active` — canonical structured fault list
- `GET /data-management/v1/remediate/cell?cellId=NRCellDU-N&action=...`
- `GET /data-management/v1/remediate/backhaul?siteId=...`

Yes, the remediate operations are GETs that mutate state. That's a wart
inherited from a workaround in the predecessor repo (the OpenClaw
agent-session egress filter only allow-listed GETs under `/data-management/v1/`).
In the sandbox-only architecture the workaround is no longer load-bearing,
but the GET shape is kept for now to avoid touching the agent call sites.

## History

This repo is the clean rebuild of
`../openclaw-autonomous-telco-agents/`. That older repo accumulated ~10
architectural classes of bug as host/sandbox bridging tax. Today's
`docs/20260407_complexity_and_reuse_assessment.md` and
`docs/20260407_stack_fit_assessment.md` (in the OLD repo) explain the
rationale for the rebuild. The old repo stays as the archive — it is
not deleted.
