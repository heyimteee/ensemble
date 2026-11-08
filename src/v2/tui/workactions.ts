import { deriveWorkStatus, isTerminalWorkStatus, type DerivedWorkStatus } from "../queue.ts"
import type { Subtask } from "../types.ts"
import type { PendingWorkAction } from "./workrows.ts"

/**
 * Ticket #173: one action policy for the focused Work card. The statusline
 * advertises exactly this set and the handlers re-check it, so an action can
 * neither appear on a card that cannot run it nor fire from a stale cursor.
 *
 * `Enter` is advertised only when the card carries a durable result; a card
 * without one has nothing to open. Retry and restart reach the history rows
 * they can recover; replied work stays read-only.
 */
export const WORK_CARD_ACTIONS = [
  "work.open",
  "work.delegate",
  "work.reassign",
  "work.retry",
  "work.restart",
  "work.cancel",
  "work.native",
] as const

/** The canonical Work action ids; the type is derived from this one list. */
export type WorkActionID = (typeof WORK_CARD_ACTIONS)[number]

const WORK_ACTION_SET: ReadonlySet<string> = new Set(WORK_CARD_ACTIONS)

export function isWorkActionID(id: string): id is WorkActionID {
  return WORK_ACTION_SET.has(id)
}

function retryable(status: DerivedWorkStatus): boolean {
  return status === "retrying" || status === "stalled" || status === "failed" || status === "cancelled"
}

function restartable(status: DerivedWorkStatus): boolean {
  return status !== "replied"
}

/** Every action the focused card can run right now. */
export function workTaskActions(task: Subtask | undefined, now: number): ReadonlySet<WorkActionID> {
  const actions = new Set<WorkActionID>()
  if (!task) return actions
  const status = deriveWorkStatus(task, now)
  const terminal = isTerminalWorkStatus(status)
  // Enter opens a durable result only; a card without one has nothing to open.
  if (task.resultMessageID !== undefined) actions.add("work.open")
  if (!terminal) {
    actions.add("work.delegate")
    actions.add("work.reassign")
    actions.add("work.cancel")
  }
  if (retryable(status)) actions.add("work.retry")
  if (restartable(status)) actions.add("work.restart")
  if (task.assigneeID !== undefined) actions.add("work.native")
  return actions
}

/**
 * The durable lifecycle fields a pending action changes. A pending label is
 * cleared by the update that carries the action's outcome, not by the RPC
 * return: compare the row before dispatch with the row after the terminal
 * snapshot lands. Content fields never participate.
 */
export type WorkPendingAction = {
  id: string
  action: PendingWorkAction
  before: string
}

export function workLifecycleSignature(task: Subtask): string {
  return [
    task.state,
    task.outcome,
    task.attempts,
    task.retryAfter,
    task.stoppedAt,
    task.finishedAt,
    task.claimedBy,
    task.activeRunID,
    task.failure?.kind,
    task.failure?.reason,
  ].join("|")
}

/** True when the durable row moved past the state the action was dispatched from, or disappeared. */
export function pendingWorkSettled(pending: Pick<WorkPendingAction, "before">, task: Subtask | undefined): boolean {
  return task === undefined || workLifecycleSignature(task) !== pending.before
}
