# Fault Fatigue — Breaking the Remediation Amplification Loop

**Date**: 2026-04-10
**Problem**: When remediation fails or partially succeeds, agents enter an amplification loop — SENTINEL posts URGENT every 5 min, ORACLE escalates, ARCHITECT re-attempts the same remediation, repeat for hours.

## Root cause

The agents had no mechanism to recognise that a fault is **unresolvable by automated means**. Each agent acted correctly in isolation, but nobody told them to **stop**, **escalate differently**, or **back off**. The system amplified a single unresolvable event into a sustained operational distraction.

## Design: Fault Fatigue Lifecycle

```
active → fatigued → stuck → recheck → (stuck | resolved)
```

### States

| State | Meaning | Agent behaviour |
|-------|---------|-----------------|
| **active** | Normal remediation in progress | SENTINEL: URGENT if threshold met. ORACLE: URGENT advisory. ARCHITECT: run remediate-all.js. |
| **fatigued** | 3+ failed attempts. Stop retrying. | SENTINEL: NORMAL only, no pace tightening. ORACLE: NORMAL advisory, change "REMEDIATE" → "ESCALATE". ARCHITECT: skip remediation. |
| **stuck** | Escalation posted. Fault is visible to operators. Periodic recheck timer set. | SENTINEL: NORMAL, note stuck status. ORACLE: NORMAL, "MONITOR" language. ARCHITECT: skip remediation. All agents: post escalation meta message. |
| **recheck** | Recheck timer expired. New evidence may exist. One retry allowed. | ORACLE: may recommend "RECHECK" in advisory. ARCHITECT: one retry of remediate-all.js. If success → resolved. If fail → back to stuck with new timer. |
| **resolved** | Fault cleared (remediation succeeded or fault resolved naturally). | Fatigue entry removed. Normal monitoring resumes. |

### What each state gives you

1. **active → fatigued**: Stops the amplification loop. The system acknowledges that automated remediation isn't working and stops making it worse.

2. **fatigued → stuck**: Creates a **stuck-fault ticket** — a structured, auditable record posted to the bulletin board that says "this fault needs something the system doesn't have." This is the escalation path. The fault is visible in:
   - `artifacts/fault-fatigue.json` (machine-readable state)
   - ORACLE's atlas report (Stuck Faults section)
   - Agent comms (meta messages with "STUCK FAULT ESCALATION")

3. **stuck → recheck**: The system doesn't give up — it sets a periodic recheck timer (default 1 hour). When the timer expires, the fault transitions to recheck state, and ARCHITECT gets one more attempt. This handles the case where the underlying condition has changed (e.g., the network healed itself, a new tool became available).

4. **recheck → stuck | resolved**: If the retry works, the fault is resolved and the fatigue entry is cleared. If it fails, the fault goes back to stuck with a new recheck timer. The system keeps trying, but at a controlled pace, not in a panic.

### The key framing

> **stop retrying, preserve visibility, escalate differently**

Not "give up and ignore it." The fault remains visible in every atlas report, every SENTINEL handoff, and the stuck-fault dashboard. But the system stops amplifying it into an emergency and instead treats it as a known, tracked, periodically rechecked issue.

### Components

| Component | Role |
|-----------|------|
| `agents/shared/tools/fault-fatigue.js` | Lifecycle state machine. CLI: `record`, `check`, `escalate`, `acknowledge`, `recheck-due`, `recheck-clear`, `clear`, `status`. Persists to `artifacts/fault-fatigue.json`. |
| `agents/nka/scripts/remediate-all.js` | Records fatigue after each remediation cycle. Reports lifecycle transitions. |
| `agents/nka/scripts/read-cycle-inputs.js` | Includes `fatigue` data (fatigued/stuck/recheck lists) in all three agents' cycle inputs. |
| `network/server.js` | Clears fatigue for an event when remediation succeeds. |
| `network/ireland/event-engine.js` | Clears fatigue for events that resolve naturally. Transitions stuck→recheck when timer expires. |
| Playbooks | Fatigue-aware escalation and recheck rules per agent. |

### Fatigue clearing

Fatigue is cleared when:
1. The network server successfully remediates the fault (any state → removed)
2. The event engine resolves the fault naturally via time expiry (any state → removed)
3. A recheck retry succeeds (recheck → removed)
4. Manually: `node fault-fatigue.js clear <eventId>`

### Config

- `FATIGUE_THRESHOLD` (env var, default 3): number of failed attempts before fatigue
- `RECHECK_INTERVAL_HOURS` (env var, default 1): how long to wait between recheck attempts

### Why this is different from v1

The original fatigue design only contained the loop — it stopped the agents from thrashing but didn't give them a next state. The fault sat there, fatigued, and nobody did anything different about it.

The lifecycle design adds:
- **Explicit escalation** — a stuck-fault "ticket" posted to the bulletin board
- **Visibility** — stuck faults appear in ORACLE's atlas report
- **Periodic recheck** — the system doesn't give up, it retries on a schedule
- **New-evidence gating** — recheck is triggered by timer, but ORACLE decides whether the signals actually warrant a retry
- **Resolution path** — if the underlying condition changes, the system will catch it on the next recheck

### Existing self-assessment tool

`self-assess.js` already detects stuck remediation loops and repetitive output, but the playbooks never instructed agents to run it. The fatigue mechanism is structural — it works regardless of whether the LLM decides to self-assess. The two mechanisms are complementary: fatigue prevents the loop, self-assessment can catch edge cases.

### The Kerry scenario — replayed with fatigue

12:10 — SENTINEL detects 6 cross-zone hits and 7 alarms. Posts URGENT handoff. Tightens ORACLE to 2 min.
12:12 — ORACLE posts URGENT advisory. Tightens ARCHITECT to 2 min.
12:14 — ARCHITECT runs remediate-all.js. Backhaul rerouted but fault persists. Fatigue records: evt-XXXX, attempt 1.
12:16 — ARCHITECT runs remediate-all.js. Already rerouted, no effect. Fatigue records: evt-XXXX, attempt 2.
12:18 — ARCHITECT runs remediate-all.js. No effect. Fatigue records: evt-XXXX, attempt 3. → **FATIGUED**.
12:18 — SENTINEL sees fatigued fault. Posts NORMAL handoff (not URGENT). Escalates fault to **stuck**. Posts "STUCK FAULT ESCALATION: evt-XXXX (backhaul_fault) — automated remediation failed after 3 attempts." De-escalates ORACLE pace to 15 min.
12:20 — ORACLE sees stuck fault. Posts NORMAL advisory: "MONITOR: evt-XXXX — stuck fault under periodic recheck." De-escalates ARCHITECT to 30 min. Adds stuck fault to atlas report.
12:25 — SENTINEL cycle. Fault still present but stuck. Posts NORMAL handoff mentioning stuck status. No pace changes.
... system operates normally, growth continues in unaffected counties ...
13:18 — Event engine tick. Recheck timer expires. Fault transitions stuck → **recheck**.
13:20 — SENTINEL cycle. Sees recheck fault. Notes in handoff: "evt-XXXX recheck in progress."
13:22 — ORACLE cycle. Sees recheck fault. If signals show change, recommends RECHECK in advisory.
13:24 — ARCHITECT cycle. Runs remediate-all.js (one retry). If fault resolved → fatigue cleared, normal monitoring resumes. If still stuck → back to stuck, new recheck timer at 14:24.

**The system contained the loop in 8 minutes, escalated the fault, preserved visibility, and set up a controlled retry — all without human involvement.**
