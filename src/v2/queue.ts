import { createHash } from "node:crypto"
import type { Subtask } from "./types.ts"

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
 *   `DEFAULT_DELIVERY_DEADLINE_MS`). Delegation uses the same 5-minute
 *   deadline: a delegated subtask that cannot finish in 5 minutes of claimed
 *   work is failed with its reason preserved rather than retried forever.
 * - OpenBot reaps with `REAP_OLDER_THAN_MS = 24h` for idempotency retention.
 *   Ensemble keeps finished rows for the same 24h (`FINISHED_RETENTION_MS`)
 *   before retention-bounded cleanup; the idempotency key stays valid for the
 *   row's lifetime.
 * - OpenBot sweeps on a 2s poll plus Postgres `LISTEN`. Ensemble is a
 *   single-process service, so there is no cross-replica sweep: stale leases
 *   are reaped on every schedule pass and on snapshot/diagnostic reads (the
 *   TUI polls every 250ms, which bounds reap latency without a new timer).
 */

export const MAX_ATTEMPTS = 5
export const LEASE_MS = 60_000
export const HEARTBEAT_MS = 20_000
export const DEADLINE_MS = 5 * 60_000
export const FINISHED_RETENTION_MS = 24 * 60 * 60_000

export type DerivedWorkStatus = "pending" | "working" | "retrying" | "replied" | "failed" | "cancelled"

export function isTerminalWorkStatus(status: DerivedWorkStatus): boolean {
  return status === "replied" || status === "failed" || status === "cancelled"
}

function stoppedReason(error: string | undefined): boolean {
  if (!error) return false
  return /cancel|discard|archiv|delet|paused/i.test(error)
}

/**
 * The single canonical derivation of a work item's visible lifecycle.
 * Persisted `state`/`outcome` are write-through caches for older readers;
 * this function is the source of truth. Pure: no I/O, no clock reads —
 * the caller passes `now`.
 */
export function deriveWorkStatus(task: Subtask, now: number): DerivedWorkStatus {
  if (task.state === "replied") {
    if (task.stoppedAt !== undefined || stoppedReason(task.error)) return "cancelled"
    return task.outcome === "succeeded" ? "replied" : "failed"
  }
  if (task.attempts >= MAX_ATTEMPTS) return "failed"
  if (task.deadlineAt !== undefined && now >= task.deadlineAt) return "failed"
  if (task.claimedBy && task.leaseUntil !== undefined && task.leaseUntil > now) return "working"
  if (task.attempts > 0 || task.error) return "retrying"
  return "pending"
}

function hashPart(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32)
}

/**
 * Idempotency key for a unit of delegated work. Same workspace, same kind,
 * same parent, same assignee, same typed instruction → same key, so a
 * resubmitted delegation executes once, not twice.
 */
export function workKey(input: {
  workspaceID: string
  kind: string
  parentID?: string
  assigneeID: string
  title: string
  instruction: string
  constraints?: string
  expected?: string
}): string {
  const body = hashPart(
    [input.assigneeID, input.title, input.instruction, input.constraints ?? "", input.expected ?? ""].join("\0"),
  )
  return `work:${input.workspaceID}:${input.kind}:${input.parentID ?? "root"}:${body}`
}
