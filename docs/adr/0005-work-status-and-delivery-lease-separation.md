# ADR 0005: Work status taxonomy and delivery/lease separation

- **Status:** Accepted
- **Date:** 2026-11-08
- **Tickets:** #165 (parent), #168, #170
- **Supersedes:** none
- **Related:** ADR 0003, `src/v2/queue.ts`, `src/v2/service.ts`

## Context

The live service log showed queued work failing at a five-minute delivery
deadline, claimed work being retired while its heartbeat was still live,
completion handoffs failing after their reply already existed, and exhausted
retries reported as native failures. Users could not distinguish a queue
problem from a broken agent.

Before this decision, `deriveWorkStatus` checked the delivery deadline before
a live lease, treated any prior attempt as `retrying`, and the reaper retired
pending, unclaimed work solely because its queue timestamp had passed.
`failed` meant deadline, exhaustion, and native error alike.

## Decision

1. **One canonical status union.**
   `pending | working | waiting | retrying | needs_you | replied | failed |
   stalled | cancelled`.
   `deriveWorkStatus` in `queue.ts` is the only derivation used by the service
   and TUI. Precedence is: terminal -> live lease/active run -> needs-you ->
   awaiting children -> scheduled retry -> stalled exhaustion -> queued
   pending. A live lease always wins over an old timestamp or attempt count.

2. **`failed` is native-only.**
   Only a real execution or model error records `failure.kind: "native"` and
   derives `failed`. Delivery, lease, and attempt exhaustion record a
   structured non-native cause and derive `stalled`.

3. **Queue delivery is not execution failure.**
   The five-minute window remains on the row for visibility and operator
   diagnostics, but it never retires work. Pending, unclaimed work stays
   queued with its honest age. A claimed run is governed by its 60-second
   heartbeat lease and may run as long as the lease stays live. A lost lease
   is requeued until `MAX_ATTEMPTS`; completion handoffs are deliveries, not
   timed executions, and are exempt from the old execution deadline.

4. **`retrying` requires a scheduled retry.**
   `retryAfter` (including a due retry waiting for a claim) or a lost claim
   within budget reads `retrying`. Awaiting children reads `waiting`. An
   interruption or pending approval reads `needs_you`.

5. **`stalled` is mounted but inactive.**
   No run starts for stalled work. It is not a terminal card status: the card
   stays visible until retry, cancel, or explicit dismissal (#170 builds on
   this boundary). Only `replied`, `failed`, and `cancelled` end the active
   lifecycle for group completion.

6. **Explicit recovery opens a fresh attempt budget (#170).**
   An explicit retry, restart, or approved resume resets `attempts` to zero
   and clears the structured failure before requeueing, so a stalled row can
   run again. Automatic retries never pass through that path and remain
   bounded by `MAX_ATTEMPTS`. The requeue emits `task.retry.requested` with
   the previous derived state and a structured reason code; it never logs the
   task title, instruction, or error copy.

7. **Lifecycle logs follow the structured cause (#170).**
   A terminal row with a non-native `failure.kind` emits `task.stalled` with
   the kind, reason code, attempts, and lease evidence. `task.failed` remains
   native-only; a legacy terminal failure without structured evidence stays
   conservatively `failed`. `task.recovered` is emitted for a late success or
   a normal success after retrying/stalling. `retry.scheduled` carries a
   reason code and failure class, not user-visible error copy.

8. **A real answer supersedes transient notices (#170).**
   Retry and handoff/turn failure system rows carry a structured `notice`
   marker. When the work succeeds — including a late-success repair — those
   notices are removed by marker, while the agent's answer and unrelated
   system history are preserved. The transcript never keeps a false
   `Retrying…` or failure line above a succeeded card.

9. **Empty and tool-only turns are honest native failures (#170).**
   A successful host turn that produced only tools and no text is treated as
   the existing `empty-reply` native failure: it retries inside the budget,
   then ends `failed` with `The agent produced no answer.` The transcript is
   not rewritten to the generic `Reply interrupted.` placeholder, because the
   stream was not interrupted. `Reply interrupted.` remains reserved for a
   genuinely empty stream, a host/structural interruption, or a native
   failure.

10. **Legacy terminal rows are reconciled from structured evidence.**
    Rows written before `failure` existed are classified from the failure
    sink's class and reason code. Deadline and lease reasons become `stalled`;
    native and unknown causes remain `failed`. Copy is never matched. Each
    one-time change emits `task.reconciled` with the from/to state and reason.

## Consequences

### Accepted trade-offs

- **A stalled task needs a user action.** It never auto-retries after the
  attempt budget, which keeps loop risk and duplicate side effects bounded.
- **Legacy rows without failure evidence stay failed.** Missing evidence is
  conservative; the migration never guesses from visible error text.
- **The status union is wider than the persisted state.** `Subtask.state`
  remains `pending | working | replied` for storage compatibility; the
  canonical lifecycle is always derived separately.
- **Completed groups clear; history is a separate pane decision.** Non-terminal
  cards never start the shared hold. A complete group still clears after the
  normal hold; retaining it in a history list is the right Work pane's concern
  (#172).
- **A stalled card requires an explicit action.** There is no auto-retry after
  the budget; retry, restart, cancel, or dismissal is a user decision.

### Follow-up rules

- Do not retire pending work for age alone.
- Do not derive `failed` from a delivery or lease cause.
- Do not show `retrying` without a scheduled retry or lost claim.
- Keep migration classification on structured fields; never substring-match
  user-visible error copy.

## Validation

| Behavior | Test |
|---|---|
| Pure status table (lease, deadline, retry, waiting, needs-you, native, stall) | `src/v2/queue.test.ts` |
| Queue wait past the window, live lease past deadline, lost lease, exhausted attempts, native error, completion handoff, waiting, cancellation, legacy reconciliation | `src/v2/service.test.ts` (`ticket168`) |
| TUI labels, glyphs, tones, and mounted stalled cards | `src/v2/tui/workrows.test.ts` |
| Non-terminal group persistence, stalled retry/cancel transitions, stalled section tone, no completion timer | `src/v2/tui/workgroups.test.ts` (`ticket170`) |
| Explicit retry/restart of an exhausted row, recovery notice supersede, tool-only empty turn, lifecycle and recovery logs, diagnostic recovery rows | `src/v2/service.test.ts` (`ticket170`) |
| A fake run past the old delivery deadline completes while its lease is live | `src/v2/service.test.ts` (`ticket170`) |
| `task.stalled` vs `task.failed` projection from structured causes | `src/v2/log-events.test.ts` (`ticket170`) |
| Overdue pending work, expired leases, contradictory terminal rows, timeout-as-failed rows, recovery consistency | `src/v2/doctor.test.ts` (`ticket170`) |
| Work fields and recoveries across the diagnostic/CLI boundary | `src/v2/doctor-cli.test.ts` (`ticket170`) |
| Failure record class, reason, and structured work cause | `src/v2/failure-record.test.ts` (`ticket170`) |
| Incident replay of deadline, existing reply, late success, and placeholder repair | `src/v2/stream-settlement.test.ts`, `src/v2/service.test.ts` (`ticket169`) |
