import { createHash } from "node:crypto"
import type { Subtask, WorkKind } from "./types.ts"

/**
 * Durable coordination queue mechanics, adapted from OpenBot's `work/queue.ts`
 * and `handoff-runner.ts` to Ensemble's subtask-as-work-item model.
 *
 * Adaptation notes (why these differ from OpenBot, if at all):
 * - OpenBot has no subtask table; its durable unit is a generic `work_items`
 *   row and state is derived from `(finished_at, claimed_by, lease_until,
 *   attempts, run_at)`. Ensemble already persists a subtask row per unit of
 *   work, so the queue fields live on the subtask itself instead of a
 *   parallel table. One source of truth; no join, no drift.
 * - `MAX_ATTEMPTS = 5`, `LEASE_MS = 60s`, `HEARTBEAT_MS = ~20s`, and
 *   `DEADLINE_MS = 5min` are taken unchanged from OpenBot
 *   (`DEFAULT_MAX_ATTEMPTS`, `leaseMs`, `RENEW_EVERY_MS`,
 *   `DEFAULT_DELIVERY_DEADLINE_MS`). Ticket #168 keeps the window only as a
 *   delivery timestamp: queue wait never fails work, and a claimed run may
 *   exceed it while its heartbeat lease stays live.
 * - OpenBot reaps with `REAP_OLDER_THAN_MS = 24h` for idempotency retention.
 *   Ensemble keeps finished rows for the same 24h (`FINISHED_RETENTION_MS`)
 *   before retention-bounded cleanup. Duplicate suppression honors the row
 *   lifetime: resubmitting the same run-scoped work while its row exists
 *   (live or terminal) returns the existing item instead of executing twice.
 *   Root user work is scoped by its dispatch group (ticket #135), so an
 *   identical user command is a new dispatch rather than a suppressed retry;
 *   intentional re-asks stay explicit via `task.retry`/`task.restart`.
 * - Relay and failure-notice legs are messages keyed by the hop correlation,
 *   not work rows: control legs never enter the queue and never consume the
 *   asking run's fan-out budget.
 * - OpenBot sweeps on a 2s poll plus Postgres `LISTEN`. Ensemble is a
 *   single-process service, so there is no cross-replica sweep: stale leases
 *   are reaped on every schedule pass and on snapshot/diagnostic reads (the
 *   TUI polls every 250ms, which bounds reap latency without a new timer).
 */

export const MAX_ATTEMPTS = 5
export const LEASE_MS = 60_000
export const HEARTBEAT_MS = 20_000
/**
 * Queue delivery window kept for visibility and operator diagnostics. It is
 * not an execution guillotine (ticket #168): pending work never fails because
 * it waited, and claimed work is governed by its heartbeat lease.
 */
export const DEADLINE_MS = 5 * 60_000
export const FINISHED_RETENTION_MS = 24 * 60 * 60_000

export type DerivedWorkStatus =
  | "pending"
  | "working"
  | "waiting"
  | "retrying"
  | "needs_you"
  | "replied"
  | "failed"
  | "stalled"
  | "cancelled"

/**
 * Statuses that end the active lifecycle. `stalled` is deliberately not
 * terminal: no run will start, but the card stays mounted until the user
 * retries, cancels, or dismisses it (ticket #170 builds on this boundary).
 */
export function isTerminalWorkStatus(status: DerivedWorkStatus): boolean {
  return status === "replied" || status === "failed" || status === "cancelled"
}

/**
 * The single canonical derivation of a work item's visible lifecycle.
 * Persisted `state`/`outcome` are write-through caches for older readers;
 * this function is the source of truth. Pure: no I/O, no clock reads —
 * the caller passes `now`.
 *
 * Precedence (ticket #168): terminal -> live lease/active run -> needs-you ->
 * awaiting children -> scheduled retry -> stalled exhaustion -> queued
 * pending. A live lease always wins over an old deadline or attempt count.
 *
 * `failed` is reserved for a structured native execution failure. Rows with a
 * structured delivery/lease/attempt cause derive `stalled`. Legacy terminal
 * failures without a structured cause stay `failed` so the migration can never
 * mask a genuine native error. Cancellation is structural: only `stoppedAt`
 * reads cancelled; free-form error text is never substring-matched.
 */
export function deriveWorkStatus(task: Subtask, now: number): DerivedWorkStatus {
  if (task.state === "replied") {
    if (task.stoppedAt !== undefined) return "cancelled"
    if (task.outcome === "succeeded") return "replied"
    if (task.failure === undefined) return "failed"
    return task.failure.kind === "native" ? "failed" : "stalled"
  }
  const liveLease = task.claimedBy !== undefined && task.leaseUntil !== undefined && task.leaseUntil > now
  const activeRun = task.activeRunID !== undefined
    && task.claimedBy === task.activeRunID
    && (task.leaseUntil === undefined || task.leaseUntil > now)
  if (liveLease || activeRun) return "working"
  if (task.interrupted || task.approvalID !== undefined) return "needs_you"
  if (task.awaitingChildren) return "waiting"
  const lostLease = task.claimedBy !== undefined && task.attempts > 0 && task.attempts < MAX_ATTEMPTS
  // A retry time that has arrived is still a scheduled retry until the pump
  // claims the row; only clearing `retryAfter` ends the backoff.
  const scheduledRetry = task.retryAfter !== undefined
  if (lostLease || scheduledRetry) return "retrying"
  // Exhausted delivery/lease retries have no native error to call their own.
  if (task.attempts >= MAX_ATTEMPTS) return "stalled"
  return "pending"
}

/** Stable short hash for idempotency-key segments. Never interpolate raw ids. */
export function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32)
}

/** Boundary validation for the domain union. Unknown values are rejected. */
export function parseWorkKind(value: unknown): WorkKind | undefined {
  if (value === "delegation" || value === "handoff" || value === "turn") return value
  return undefined
}

/**
 * Hashed run prefix for idempotency keys. The asking run's subtask id scopes
 * the key, but only as a hash — raw parent ids never appear in stored keys.
 * A root (user-level) ask hashes its own constant prefix; when the root ask
 * belongs to a dispatch group (ticket #135), that group scopes the prefix too,
 * so a repeated identical user command forms a new group and a new task.
 * Run-scoped work stays anchored by its parent alone, so duplicate tool calls
 * in one run still dedupe.
 */
export function runPrefixHash(parentID?: string, dispatchGroupID?: string): string {
  const scope = parentID ?? "root"
  const group = parentID === undefined && dispatchGroupID ? `:${dispatchGroupID}` : ""
  return stableHash(`run:${scope}${group}`)
}

function canonicalField(value: string | undefined): string {
  return (value ?? "").trim()
}

/**
 * Idempotency key for a unit of delegated/turn work. Segments, in order:
 * actor scope (creator agent id, or "user"), workspace scope, work kind, the
 * hashed run prefix (never the raw parent id), the addressed recipient, and
 * a hash of the canonical task/constraints/expected/instruction body.
 * Resubmitting the same work (same key, row still retained) executes once,
 * not twice, for live and terminal rows alike. Root user work also hashes its
 * dispatch group, so a new command never collides with retained work from an
 * earlier command while same-run tool retries keep deduping.
 */
export function workKey(input: {
  actor: string
  workspaceID: string
  kind: WorkKind
  parentID?: string
  dispatchGroupID?: string
  assigneeID: string
  title: string
  instruction: string
  constraints?: string
  expected?: string
}): string {
  const run = runPrefixHash(input.parentID, input.dispatchGroupID)
  const body = stableHash(
    [input.assigneeID, canonicalField(input.title), canonicalField(input.instruction), canonicalField(input.constraints), canonicalField(input.expected)].join("\0"),
  )
  return `work:${input.workspaceID}:${input.kind}:${input.actor}:${run}:${input.assigneeID}:${body}`
}

/**
 * Correlation id for the relay/failure-notice legs of one unit of work.
 * Derived from the work key (outside the fan-out prefix), so control legs
 * trace back to the hop without consuming the run's budget.
 */
export function correlationIDForKey(kind: "handoff" | "turn", key: string): string {
  return `${kind}_${stableHash(`correlation:${key}`)}`
}

/**
 * Claim-fencing verdict for a freshly persisted claim. The claimant wins only
 * when the stored row still names its run: another writer overwrote the claim
 * (or the row is gone), so this run must stand down instead of double-running
 * the work. Pure: the caller performs the storage re-read.
 */
export function claimWon(stored: Subtask | undefined, runID: string): boolean {
  return stored?.claimedBy === runID
}
