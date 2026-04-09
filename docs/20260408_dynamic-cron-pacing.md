# Dynamic Cron Pacing — Implementation Plan

Date: 2026-04-08

## Problem

Agents run on fixed cron intervals (SENTINEL 5min, ORACLE 15min, ARCHITECT 30min).
When SENTINEL detects a critical fault, ORACLE won't see it for up to 15 minutes.
The true-agentic design spec requires under 2 minutes from urgent event to response.

## Rejected approaches

1. **Watcher process** — a daemon that tails agent-comms.jsonl and manipulates cron
   timers. Rejected: encodes decision logic in infrastructure instead of agents.
2. **Shorter fixed intervals** — run everything every 1-2 min. Rejected: wastes
   LLM tokens on idle cycles, doesn't scale.

## Chosen approach: agent-controlled dynamic pacing

Agents adjust each other's (and their own) cron intervals based on what they observe.
The cron schedule becomes a living parameter the agents shape, not a fixed clock.

### New artifact

`agents/shared/tools/set-cron-pace.js`

```
node set-cron-pace.js <agent> <intervalMinutes> <reason>
```

- Reads `/sandbox/.openclaw/cron/jobs.json`
- Updates target agent's `intervalMs` and `nextRunAtMs` (next tick = now + new interval)
- Logs the pace change to `agent-comms.jsonl` via post-comms.js for auditability
- Enforces floor (1 min) and ceiling (60 min) to prevent runaway or stalled schedules
- Prints confirmation: `"oracle pace set to 2min by SENTINEL: 3 cross-zone hits detected"`

### Playbook changes

**SENTINEL-FAST.md** — add after Step 4 (post handoff):

- If URGENT: tighten ORACLE to 2 min
  `node agents/shared/tools/set-cron-pace.js oracle 2 "<reason>"`
- If NORMAL for 3+ consecutive handoffs (no outliers, no alarms, no cross-zone):
  restore ORACLE to 15 min
  `node agents/shared/tools/set-cron-pace.js oracle 15 "stable for 3 cycles"`

**ORACLE.md** — add after Step 3 (post to agent comms):

- If URGENT advisory: tighten ARCHITECT to 2 min
  `node agents/shared/tools/set-cron-pace.js architect 2 "<reason>"`
- If stable (no remediation needed, no chronic cells): restore ARCHITECT to 30 min
  `node agents/shared/tools/set-cron-pace.js architect 30 "network stable"`
- You may tighten your own schedule to monitor a developing situation:
  `node agents/shared/tools/set-cron-pace.js oracle 5 "monitoring degradation trend"`

**ARCHITECT.md** — add after Step 5 (log growth) or Step 2 (remediation):

- After growth or remediation: tighten SENTINEL to 2 min for verification
  `node agents/shared/tools/set-cron-pace.js sentinel 2 "verifying growth wave landed"`
- SENTINEL will self-restore to 5 min once it confirms stability

### Default intervals (restored during calm)

| Agent | Default | Tightened |
|-------|---------|-----------|
| SENTINEL | 5 min | 1-2 min |
| ORACLE | 15 min | 2-5 min |
| ARCHITECT | 30 min | 2-5 min |

### Auditability

Every pace change is logged to agent-comms.jsonl:
```json
{"at":"...","from":"SENTINEL","type":"pace-change","target":"oracle",
 "intervalMin":2,"reason":"3 cross-zone hits detected"}
```

Agents can read pace-change history via read-cycle-inputs.js to understand
why their schedule was altered.

### What this achieves

- Urgent event → SENTINEL tightens ORACLE → ORACLE tightens ARCHITECT
- Full cascade in under 2+2 = 4 minutes worst case (SENTINEL fires, sets ORACLE
  to 2min, ORACLE fires, sets ARCHITECT to 2min)
- No watcher process, no host-side dependency
- Every pacing decision is made by an agent and logged with a reason
- Calm periods naturally restore to default intervals (less LLM cost)
- Cron schedule is a floor (agents can't go below 1 min) but not a ceiling

### Interaction with gateway restart

The gateway may restart periodically (e.g. for token refresh). The gateway
MAY empty the cron store on restart.

This should be handled by the restart process: check whether the cron store
still has jobs after restart. If yes (dynamic pacing preserved), leave them
alone. If empty, re-seed from the blueprint defaults.

Dynamic pace changes write to `/sandbox/.openclaw/cron/jobs.json`. The
gateway reads this file on each scheduler tick — no restart needed for
pace changes to take effect.

`set-cron-pace.js` does NOT require or trigger a gateway restart.
