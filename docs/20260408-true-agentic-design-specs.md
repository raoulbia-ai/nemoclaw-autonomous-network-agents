True Agentic Decision Making — Design Spec

  The system must let agents act when conditions warrant, not when a clock says it's their turn. Two complementary mechanisms achieve this; both are required.

  Mechanism 1 — Event-driven wake-up cascade

  Agents must be able to wake each other out-of-cycle.

  When an agent detects something urgent (a critical fault, a rapidly degrading metric, an external trigger), it should be able to mark a message on the shared
  bulletin board with a structured priority: "urgent" flag and a wakeTarget field naming the agent that needs to respond. A separate watcher continuously observes
  the bulletin board and, on detection of an urgent message, advances the target agent's next-run time so the cron scheduler fires it on its next internal tick.

  Required properties of the cascade:

  - Latency target: under two minutes from urgent message to woken agent's first action.
  - Per-agent debounce: the same target should not be woken more than once within a short cooldown window, to prevent storms.
  - Already-running suppression: if the target is currently in a session, the wake-up is recorded but not duplicated.
  - Marker file with cause: when an agent is woken out-of-cycle, it must be able to read why — the source message, the originating agent, the timestamp. Without
  this it cannot distinguish an urgent wake from a normal scheduled run and will execute the wrong playbook branch.
  - Lives inside the sandbox: the watcher is one of the long-lived processes the network depends on. It should not introduce a host-side dependency.

  The cron schedule remains as the baseline heartbeat. The cascade short-circuits it for events that cannot wait.

  Mechanism 2 — Dynamic pacing inside the cycle

  Even with the cascade in place, agents will still under-act if their playbooks contain wall-clock gates. Every "act if X minutes have passed since the last
  action" rule in any playbook should be challenged.

  For each such rule, ask: what is the real technical constraint behind the timer? If the answer is "nothing technical, the timer just looks tidy" — the rule is
  wrong and must be replaced.

  The replacement has three parts:

  A. Hard prerequisites — concrete, agent-checkable

  These reflect actual system limits that would cause real damage if violated. Each prerequisite must be expressible as a fact the agent can verify by inspecting
  the system at decision time — a status field, a file's existence, a lock, a queue state, the result of an API call. Not a clock.

  The agent skips the action if any hard prerequisite fails. The decision is deterministic given the inputs.

  B. Soft considerations — judgement, not enforcement

  These are guidance the agent reasons about: priorities, trade-offs, ORACLE's advisory, the current alarm picture. The agent weighs them and decides. They are not
   gates — failing a soft consideration is a hint to reconsider, not a block.

  C. Explicit permission to be aggressive

  Agents trained on chat data will under-rotate by default. They will skip actions even when conditions allow them, because their training pulls toward "wait, ask,
   defer."

  The playbook must contain explicit permission language. Something to the effect of: "There is no penalty for acting on consecutive cycles when conditions are
  favourable, and no penalty for skipping several cycles when they aren't. Faster is allowed when faster is safe."

  Without this, the prerequisites and considerations alone produce passive behaviour.

  D. Auditable decisions

  When an agent skips an action, it must briefly state why in its final reply. One short sentence is enough — "skipping growth this cycle: rebuild-status pending."
   Without this, every skip looks identical and you cannot tell whether the agent's judgement matches your intent.

  Supporting infrastructure

  The hard prerequisites need ground truth to check against. Wherever the agent is making a decision based on system state, that state must be exposed via a
  canonical endpoint or file the agent can read at decision time.

  This implies:

  - Status endpoints over status guesses: if the agent needs to know whether a previous operation completed, expose that explicitly. Don't make the agent infer it
  from timestamps or side effects.
  - Source-of-truth, not derived data: if multiple files could answer the same question, the agent should query the authoritative source. Derived files (caches,
  summaries, downstream artifacts) lag and produce subtle bugs.
  - {present: false} over 404: distinguish "no information yet" from "information missing." A new sandbox has no rebuild history; the agent should be able to tell
  that apart from "the rebuild file is corrupt."

  What "true agentic" means in practice

  The combination of cascade + dynamic pacing + explicit permission + ground-truth endpoints produces a system where:

  - Agents wake each other on real events, not just on schedule
  - Each agent decides its own cadence within its cycle, based on facts about the system
  - The default is to act when safe, not to wait
  - Every skip is auditable
  - The cron schedule is a floor (agents can't run less often than scheduled) but not a ceiling (agents can run more often when justified by events or by their own
   judgement)

  The cron schedule still exists. It is the heartbeat that guarantees liveness — no agent ever goes silent for too long, because the next scheduled tick always
  comes. But it is no longer the primary signal driving when work happens. Events and judgement are.

  Anti-patterns to refuse

  When implementing this, refuse the following shapes even if they look convenient:

  - Wall-clock timers in playbooks ("act if N minutes since last action"). Replace with a real technical constraint or remove entirely.
  - Implicit gates ("the agent will probably skip if X"). Make the gate explicit and auditable, or remove it.
  - Polite hedging in playbook prose ("you may want to consider possibly running the action"). Use direct language. Agents take prose literally.
  - Silent skips. Every skip must be justified in the final reply.
  - Agent-as-supervisor patterns ("the agent checks if the network is up and starts it if not"). Process supervision is not an LLM job. Use the runtime's startup
  hooks for that and keep the agent focused on analysis and decision-making.
  - Derived data as ground truth. If you can read it from the source, do.

  Memory the implementation should preserve

  When the implementation lands, save these as durable feedback:

  1. Wall-clock timers in agent playbooks are a code smell. They are almost always proxies for technical constraints the playbook author had not yet identified.
  Replace the proxy with the real constraint.
  2. Dynamic pacing requires explicit permission. Without "faster is allowed when faster is safe," prerequisites + soft considerations alone produce passive
  behaviour.
  3. Every agent decision must be auditable in the agent's own words. Without a one-line justification, the difference between "agent judged correctly" and "agent
  froze" is invisible.
  4. Process supervision belongs to the runtime, not to agent playbooks. Conflating the two makes the playbook brittle and the supervision unreliable.