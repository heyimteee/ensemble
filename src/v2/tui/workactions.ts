import { deriveWorkStatus, isTerminalWorkStatus, type DerivedWorkStatus } from "../queue.ts"
import type { Subtask } from "../types.ts"

/**
 * Ticket #173: one action policy for the focused Work card. The statusline
 * advertises exactly this set and the handlers re-check it, so an action can
 * neither appear on a card that cannot run it nor fire from a stale cursor.
 *
 * `Enter` is advertised only when the card carries a durable result; a card
 * without one has nothing to open. Retry and restart reach the history rows
 * they can recover; replied work stays read-only.
 */
export type WorkActionID =
  | "work.open"
  | "work.delegate"
  | "work.reassign"
  | "work.retry"
  | "work.restart"
  | "work.cancel"
  | "work.native"

export const WORK_CARD_ACTIONS: readonly WorkActionID[] = [
  "work.open",
  "work.delegate",
  "work.reassign",
  "work.retry",
  "work.restart",
  "work.cancel",
  "work.native",
]

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
