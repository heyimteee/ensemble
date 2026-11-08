# ADR 0004: Layered dispatch budgets, continuation groups, and one durable ledger

- **Status:** Accepted
- **Date:** 2026-11-08
- **Tickets:** parent spec #159 and children #160–#164 in `heyimteee/ensemble`
- **Supersedes:** none
- **Related:** [ADR 0003](0003-single-service-and-safe-recovery.md), [runtime guide](../agents/opencode-tui-runtime.md), [implementation notes](../implementation.md)

## Context

A dispatch chain used to stop after one handoff hop. The cap lived in
`HANDOFF_MAX_DEPTH = 1`, separate from the five-level delegation depth, and was
not visible to the user or the agent. A natural relay — a five-scene story
passed back and forth between two teammates — could not be expressed. Raising
the constant alone would remove the only guard against runaway loops,
unbounded model spend, and unpredictable latency.

The same gap existed for visibility and control. Work, chat, settings, logs,
diagnostics, and the doctor could not say how many dispatches a command had
used or had left. A refusal named no layer, an agent could not tell whether it
should dispatch, return to its leader, or stop, and an operator could not
distinguish a controlled budget stop from a task failure.

The host-realm work in ADR 0003 made this tractable: one Ensemble service owns
one store for all OpenCode locations in a realm. A budget ledger can therefore
be authoritative without cross-process coordination.

## Decision

### 1. Four layers, each with one owner

| Layer | Bounds | Owner | Default | Allowed |
|---|---|---|---|---|
| Command | Every hop caused by one user command, across all groups | User/workspace settings | 24 | 8, 16, 24, 32, 40, 48 |
| Group | Hops inside one dispatch group (root or continuation) | User for the root; leader for a continuation | 8 | 8, 16, 24 |
| Task | Direct dispatches the recipient of a delegation or handoff may make | Dispatching agent, per work item | Required argument | Any integer ≥ 0 |
| Depth | Longest ancestor chain inside one group segment | User | 8 | 1–16 |

The defaults produce three 8-hop groups: one root and up to two
continuations, matching the 24-hop command default. A continuation group is
sized by its leader from the 8-hop tiers and must fit the command remaining.
Settings changes apply to **new commands only**: a root group captures the
four values when it is created, and a live group keeps them even after an
edit. The command ledger remains authoritative for the whole lineage.

The TUI exposes the four user values in a workspace-level **Limits** panel
(`:limits` or the leader menu). The service validates the same set again on
`settings.update`; the panel is a teaching surface, not the only guard. The
panel rejects command hops below group hops and a continuation count that
cannot fit the smallest allowed 8-hop groups.

### 2. What consumes a hop

- A user command and its initial recipients consume nothing.
- An agent-created delegation or explicit handoff consumes one hop.
- Opening a continuation consumes nothing; its first delegation or handoff
  consumes one.
- Completion handoffs, batch review, synthesis, group-chat peer turns,
  retries, restarts, recovery, and idempotent replays do not consume.
- Cancellation does not refund.

The task budget counts **direct dispatches**, not a reserved subtree. A sender
with one remaining dispatch may grant a larger task budget; the group and
command budgets remain the hard subtree cap. A missing `maxHops` is a
validation error. Zero is valid and is the deliberate one-shot ask: the
recipient may answer and complete, but may not create new work.

A task budget belongs only to agent delegation and handoff work. User-command
recipients, group-chat peer turns, completion handoffs, batch review,
synthesis, retries, restarts, and recovery rows carry none; the service never
silently grants them the group remaining.

### 3. Continuation policy

A continuation is a new segment of the same command, not a new command.

- Only the workspace leader may open one.
- The referenced group must be exhausted (its own hops or the command are
  spent), not merely idle.
- The leader must name a `groupMaxHops` tier (8, 16, or 24) that fits the
  command remaining.
- The command must still have hops, and the continuation count must be below
  its captured maximum (default 2).
- Creating the continuation seals the referenced group with
  `closeReason: "continued"`; a closed group admits no new hop and cannot be
  continued again.
- The new group references its parent and root, starts at depth 0 for its
  segment, and leaves command counters and the depth ceiling on the root.
- Opening a continuation is a new segment, not another dispatch from the
  leader's current task budget. A leader that spent every direct delegate may
  still open one; the group, command, continuation-count, and fan-out caps
  still apply.
- Later leader dispatches join the newest active continuation automatically;
  naming an active continuation as `continuationOf` is refused while it still
  has hops. Pass `continuationOf` only for an exhausted group.

The command cap is the anti-laundering rule. A continuation cannot create a
fresh command budget, and the continuation count prevents an endless sequence
of new groups. When either limit is reached, the refusal tells the agent to
ask the user to start a new command.

### 4. One atomic durable ledger

Each group is a full durable entity: group identity, workspace, root, parent,
continuation index, group maximum and used hops, depth maximum, root-only
command maximum/used/continuations, creation time, close time, reason, and a
legacy-reconciliation marker. Budget state (`active`, `exhausted`, `closed`)
is derived from counters and closure, never stored separately.

- Creating a consuming work item and incrementing the group and command hops
  is one serialized store mutation. A crash cannot leave a consumed hop
  without the work item.
- Duplicate and idempotent submissions return the existing work item and do
  not consume again. Deduplication covers both the task id and the queue key,
  and the queue-key check runs inside the serialized admission so two
  concurrent identical dispatches produce one work item and one hop.
- Retry, restart, and recovery re-use the row and do not consume again.
- Two concurrent dispatches at one remaining hop admit exactly one.
- The single service from ADR 0003 owns the ledger. Multi-process budget
  coordination remains unsupported.

### 5. Trust boundaries

- **Agents** decide the task budget for the next step. They cannot raise a
  command, group, depth, or continuation ceiling; no tool path accepts those
  values outside the leader's validated continuation parameters.
- **Leaders** decide how to segment exhausted work within the user's command
  budget. Leadership does not grant a larger budget.
- **Users** own the ceilings. A mid-flight settings edit cannot rewrite the
  rules of work already running.
- **Operators** see counts, reason codes, and lineage without task content.

The tool result shows task, group, command, and depth remaining. A refusal
names the exhausted layer and the next action: return to the leader, continue
in a new group, or ask the user for a new command. Every turn context carries
the same structured block.

### 6. Closed-group exemptions

Closing a group stops new dispatches; it does not invalidate work that is
already owed. Completion handoffs, batch review, synthesis, peer turns,
retries, restarts, and recovery rows may still save directly into a closed
group. They never consume hops, and the doctor counts them only when they are
ordinary agent delegation/handoff rows. An active continuation with no work
and no spent hops is a ledger inconsistency the doctor reports.

### 7. Migration policy

The required task budget is enforced immediately. A missing value is a clear
validation error that teaches the new argument, not a silent default.

Pre-ledger groups are synthesized on first access:

- Used hops equal the existing non-completion delegation and handoff count.
- Group and command maximums are at least the observed usage, so an upgrade
  never retroactively refuses work that was already admitted.
- Observed depth raises the depth maximum when needed.
- Live rows that still lack a task budget receive the group's remaining
  budget; a stored budget (including zero) is never overwritten.
- Reconciliation is persisted on the serialized maintenance queue in bounded
  batches and logged as `dispatch.group.reconciled`.

The team-contract block is bumped and stale workspace blocks are rewritten to
the current contract on config reconciliation. Reconciliation reads
`.ensemble/init.json` and the existing `AGENTS.md` block marker, preserves
project-owned content, writes the current block and metadata, and never
downgrades a newer version. Because this is a developer preview, no
compatibility flag is required; the contract version is the migration marker.

`settings.maxDepth` is **deprecated and ignored for enforcement**. Unified
depth comes from `dispatchDepth` (settings, then the group capture). The field
remains readable so older persisted settings do not fail validation; removing
it is a future settings cleanup, not a behavior change.

### 8. Operational semantics

- **Logs.** A `dispatch` category records group creation, continuation,
  exhaustion, closure, reconciliation, hop consumption, refusal, and invalid
  settings. Fields are IDs, counts, tiers, reason codes, and timings only. Task
  titles, instructions, handoff paths, file content, and conversation text are
  never recorded.
- **Log summary.** `npm run logs:summary` reports dispatch groups, hops,
  exhausted/continued/refused/closed counts, and recent exhaustion/refusal
  warnings. `--group <id>` includes that group's continuation lineage (rows
  whose `dispatchGroupID` is the group or whose `rootID` is the group).
- **Diagnostics.** `diagnostic` returns the compact ledger summary **and the
  full dispatch-group entities**, so support can inspect lineage and caps
  without mutating state.
- **Doctor.** The doctor checks: no group over its cap, no command overrun, a
  group counter never below its visible counted work (the unsafe direction;
  a higher counter after terminal retention is allowed), command counters
  equal the sum of their groups, every continuation has a parent and reaches
  its root, and no active continuation is empty.
- **Failure truth.** A budget stop is a controlled stop with
  `FailureClass "budget"` and reason code `budget-exhausted`, not a generic
  task failure. Only structured refusal evidence (`code`/`type` plus the
  `DispatchRefusalLayer`) classifies a budget stop; user-facing refusal copy is
  never matched as a second vocabulary. The Work pane renders exhaustion as a
  warning stop, distinct from FAILED.

## Rejected alternatives

- **Let agents raise their own ceilings.** Rejected: a runaway agent could
  erase the only bound on model spend and latency, and the user would lose the
  final say. It also makes refusals unteachable because the refusing layer is
  the one that can be edited.
- **One global depth constant instead of layered budgets.** Rejected: a single
  number cannot express local fan-out, team-wide work, the user's total, and
  ancestor depth at once. It either blocks legitimate relays or fails to bound
  total work. Relays need a task budget that is smaller than the group, which
  in turn is smaller than the command.
- **Raise the one-hop cap to a larger constant.** Rejected: it trades a clear
  refusal for an opaque loop and has no continuation story. It also leaves
  settings, Work, logs, and the doctor blind.
- **Unlimited continuations.** Rejected: continuation laundering would turn
  the command cap into a suggestion. A bounded continuation count plus the
  command ledger keeps the user's total real.
- **Per-workspace overrides or multi-process coordination in v1.** Deferred:
  the global settings model and one service per realm are sufficient for the
  supported deployment. Multi-process budgeting would need an election or a
  shared transactional store, which ADR 0003 deliberately does not provide.
- **A silent default task budget.** Rejected: it hides which agent chose the
  local bound and makes a zero-hop ask indistinguishable from a forgotten
  argument.

## Consequences

### Accepted trade-offs

- **One service owns the ledger.** This inherits ADR 0003's boundary: a
  second process can read the store but is not a supported budget writer.
- **Caps are captured at group creation.** A user cannot rescue a live command
  by editing settings; they can start a new command. This is deliberate.
- **The command ledger is root-only.** Continuations are cheaper to inspect but
  every command-wide number requires resolving the root.
- **Legacy reconciliation changes rows.** Live pre-ledger tasks receive the
  group's remaining task budget. That is a real mutation, bounded to rows that
  still lack a budget.
- **Compact Work rows yield the title first.** At 80×24 the name, budget, and
  status survive while a long task title ellipsizes. The budget is product
  data; the full title remains in the chat and the native session.
- **A budget stop is not a failure.** It does not increment `task.failed`, but
  it can leave work uncompleted until the user starts a new command. The
  refusal copy names that outcome.

### Follow-up rules

- Do not add an agent-writable path to command, group, depth, or continuation
  ceilings.
- Do not open a continuation from a group with remaining hops.
- Do not consume a hop for completion, batch, synthesis, peer-turn, retry,
  restart, recovery, or idempotent replay.
- Do not store derived budget state; derive it from counters and closure.
- Keep dispatch log fields free of task content.
- Keep the doctor's counter check one-directional: a counter below visible
  counted work is unsafe; a higher counter after retention is allowed.
- Re-run the budget live scenarios and the multi-location harness on host
  loading changes.

## Validation

The delivery evidence is in
[2026-11-08-dispatch-budgets](../verification/2026-11-08-dispatch-budgets.md):

- Five hops inside one group, nine hops across a continuation, and an 8-hop
  command-cap stop in the isolated fake-provider host.
- 22 total hops, 22 distinct consumed work items, one `dispatch.hop.consumed`
  row per hop, and no duplicate consumption.
- The existing 100-request multi-location path stays at 100/100 requests,
  137/137 tasks, one service, zero failures, and the existing gap threshold.
- Size matrix at 80×24, 100×30, 120×40, 160×50, and `NO_COLOR=1` with budget
  labels.
- Doctor and log-summary evidence, plus `npm run verify`.

## References

- Parent specification #159 and tickets #160–#164
- [Runtime guide](../agents/opencode-tui-runtime.md#dispatch-budgets-and-the-ledger)
- [Implementation notes](../implementation.md#dispatch-budgets)
- [Glossary](../../GLOSSARY.md)
- `src/v2/dispatch-budget.ts`, `src/v2/store.ts`, `src/v2/service.ts`,
  `src/v2/log-events.ts`, `src/v2/doctor.ts`, `src/v2/tui/limits.ts`
- [ADR 0003: one service per host realm](0003-single-service-and-safe-recovery.md)
