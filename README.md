# Autonomous Network Agents

*Experimental: three AI agents autonomously operating a simulated Irish 5G network*

Three autonomous AI agents (SENTINEL, ORACLE, ARCHITECT) operating a
simulated Irish 5G network inside an OpenShell/NemoClaw sandbox.

Sandbox-only architecture: the host runs nothing except the `openshell` CLI.

## Agents

| Agent | Role | Default Interval |
|-------|------|-----------------|
| SENTINEL | Network observer — collects data, detects faults, hands off to ORACLE | 5 min |
| ORACLE | Analyst — synthesizes signals into advisories, guides ARCHITECT | 15 min |
| ARCHITECT | Planner — grows the network, remediates faults | 30 min |

Agents communicate via a shared bulletin board (`agent-comms.jsonl`) and
dynamically adjust each other's cron intervals based on network conditions.
An urgent fault cascade (SENTINEL → ORACLE → ARCHITECT) completes in ~4
minutes.

## Architecture

```
Host                              Sandbox (k3s pod)
─────────────────────────────     ──────────────────────────────
snapshot-artifacts.sh             OpenClaw gateway (Node.js)
  ↓ on-demand before shutdown       ↓ cron scheduler
                                    ↓ fires SENTINEL/ORACLE/ARCHITECT
                                    ↓ agents call LLM for reasoning
                                    ↓ agents exec scripts (collect, remediate, grow)
                                    ↓ agents adjust each other's cron intervals
                                  Network server (Node.js, port 8090)
                                    ↓ 266 Irish cells, 8 API routes
                                    ↓ simulates faults, alarms, performance
```

## Key Design Decisions

- **True agentic pacing**: no wall-clock timers in playbooks. Agents decide
  when to act based on hard prerequisites and soft considerations. Cron is
  a floor, not a ceiling. See `docs/20260408-true-agentic-design-specs.md`.
- **Dynamic cron**: agents tighten/restore each other's schedules via
  `set-cron-pace.js`. Every pace change is logged and auditable.
- **Fault fatigue lifecycle**: when remediation fails repeatedly, agents
  de-escalate instead of amplifying. The lifecycle (`active → fatigued →
  stuck → recheck → resolved`) stops the loop, preserves visibility, and
  periodically retries. See `docs/20260410_fault-fatigue-design.md`.
- **One writer per file**: `state.json` → only `log-growth.js`.
  `agent-comms.jsonl` → append-only via `post-comms.js`.
- **No npm deps in `network/`**: pure Node.js stdlib.
- **Sandbox-only**: all agent code baked into Docker image.

## Host Prerequisites

1. **Docker** — a running Docker daemon (or Docker Desktop). OpenShell runs
   sandboxes inside a k3s cluster container.
2. **[NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) CLI** — the sandbox runtime:
   `curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh`
3. **[NVIDIA NemoClaw](https://github.com/NVIDIA/NemoClaw)** — packages the agent runtime,
   LLM configuration, cron schedules and project files into a Docker image
   (4 vCPU, 8 GB RAM minimum): `curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash`.
   `patch-nemoclaw.sh` modifies the source in `~/.nemoclaw/source/` before onboarding.

## Project Setup

1. **An OpenAI-compatible LLM endpoint** — the agents need an inference
   endpoint exposing `/v1/chat/completions`. Standard OpenAI clients
   append `/v1/` to the base URL, so make sure your endpoint serves the
   API under that prefix. Tested shapes: OpenAI, Together, Groq,
   Anthropic via an OpenAI-compatible proxy, any local OpenAI-compatible
   server (Ollama, vLLM, LM Studio).

2. **CA certificates** (only if your LLM endpoint uses a private CA):
   place `*.crt` files in `nemoclaw-blueprint/project-files/network/certs/`.
   `patch-nemoclaw.sh` auto-detects them and bakes them into the image.
   Set `OPS_CONFIG_URL=<your-endpoint>` when running the patch script to
   point the sandbox at your provider.

3. **Copy `.env.example` to `.env`** and fill in your values.

## Quick Start

```bash
# 1. Patch nemoclaw source
cd nemoclaw-blueprint && bash patch-nemoclaw.sh && cd ..

# 2. Onboard
source .env
node ~/.nemoclaw/source/bin/nemoclaw.js onboard \
  --non-interactive --yes-i-accept-third-party-software
```

### Example: OpenAI

```bash
NEMOCLAW_ENDPOINT_URL=https://api.openai.com \
NEMOCLAW_MODEL=gpt-4o-mini \
COMPATIBLE_API_KEY=sk-... \
NEMOCLAW_PROVIDER=custom \
node ~/.nemoclaw/source/bin/nemoclaw.js onboard \
  --non-interactive --yes-i-accept-third-party-software
```

For a local endpoint (e.g. `http://127.0.0.1:8000`), also set
`NEMOCLAW_ALLOW_PRIVATE_ENDPOINT=1` to bypass nemoclaw's SSRF guard.

## Security model

The mock network under `network/ireland/` is the only data source the
agents see. If you ever point them at a real telemetry feed, web fetcher,
or external ticketing system, **indirect prompt injection becomes a live
risk** — see [`docs/20260409_prompt-injection-risk.md`](docs/20260409_prompt-injection-risk.md)
for the threat model and recommended mitigations.

## After Reboot

```bash
docker start openshell-cluster-nemoclaw
sleep 15
```

## Snapshot Before Shutdown

```bash
./scripts/snapshot-artifacts.sh
```

## Documentation

| Doc | Content |
|-----|---------|
| [`docs/20260408_restarting-the-application.md`](docs/20260408_restarting-the-application.md) | What survives each restart type |
| [`docs/20260408_dynamic-cron-pacing.md`](docs/20260408_dynamic-cron-pacing.md) | Agent-controlled schedule adjustment |
| [`docs/20260408-true-agentic-design-specs.md`](docs/20260408-true-agentic-design-specs.md) | Design principles for agentic behaviour |
| [`docs/20260409_prompt-injection-risk.md`](docs/20260409_prompt-injection-risk.md) | Threat model for autonomous agents |
| [`docs/20260410_fault-fatigue-design.md`](docs/20260410_fault-fatigue-design.md) | Stuck-fault escalation and remediation loop prevention |
| [`docs/20260413_snapshot-restore-onboard.md`](docs/20260413_snapshot-restore-onboard.md) | Snapshot, restore and onboarding flow |
| [`docs/20260413_event-engine-status-fix.md`](docs/20260413_event-engine-status-fix.md) | Event engine status fix |
| [`scripts/README.md`](scripts/README.md) | Operator scripts, demo and fault-injection tooling |
