# ADR 0005: Work status taxonomy and delivery/lease separation

- **Status:** Accepted
- **Date:** 2026-11-08
- **Tickets:** #165 (parent), #168
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

6. **Legacy terminal rows are reconciled from structured evidence.**
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
- **Card persistence is a follow-up.** This decision makes `stalled`
  non-terminal; #170 owns non-terminal mounting, history, and doctor rules.

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
| Incident replay deferred to stream/late-success repair | #169 |
