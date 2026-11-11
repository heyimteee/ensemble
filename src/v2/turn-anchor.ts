import { dispatchDepthFor } from "./dispatch-budget.ts"
import { resolveDispatchGroupID } from "./dispatch-group.ts"
import { nativeContacted } from "./native-turn.ts"
import type { Id, Subtask } from "./types.ts"

/**
 * Ticket #236: one active-turn anchor.
 *
 * Native-first tool calls belong to the turn that made them. This module owns
 * the resolution order and the ownership facts every tool needs:
 *
 * 1. a live managed run wins (its task is already the parent of the call);
 * 2. otherwise the session's open native turn owns the call;
 * 3. only when neither exists does the legacy newest-open-sender-task fallback
 *    apply, so an ordinary handoff still keeps the sender's turn open.
 *
 * The anchor supplies the parent, dispatch group, depth, and the granted task
 * budget. Group and command ceilings still come from the dispatch ledger at
 * admission; the anchor never mints a second work model or a fresh group when
 * an owned turn exists.
 */
export type TurnAnchorSource = "run" | "native" | "fallback"

export type ActiveTurnAnchor = {
  source: TurnAnchorSource
  /** The task every call from this session joins. */
  task: Subtask
  /** Parent for work the call creates; always the anchor task. */
  parentID: Id
  /** The anchor's dispatch group, resolved through the group rules. */
  dispatchGroupID?: Id
  /** The anchor task's own depth; a child dispatch sits one level below. */
  depth: number
  /** Direct dispatches the anchor task may still make, when one was granted. */
  taskMaxHops?: number
  /** Recipients already contacted during this native turn; empty otherwise. */
  contacted: readonly Id[]
}

export function resolveActiveTurnAnchor(input: {
  runTask?: Subtask
  nativeTurn?: Subtask
  fallbackTask?: Subtask
  subtasks: Record<Id, Subtask>
}): ActiveTurnAnchor | undefined {
  const resolved =
    (input.runTask && { source: "run" as const, task: input.runTask })
    ?? (input.nativeTurn && { source: "native" as const, task: input.nativeTurn })
    ?? (input.fallbackTask && { source: "fallback" as const, task: input.fallbackTask })
  if (!resolved) return undefined
  const { source, task } = resolved
  return {
    source,
    task,
    parentID: task.id,
    // A legacy row with no group keeps that absence; the tool decides whether a
    // fresh root group is legitimate (a new dispatch, not a re-parent).
    dispatchGroupID: resolveDispatchGroupID(task, input.subtasks) ?? task.dispatchGroupID,
    depth: dispatchDepthFor(task, input.subtasks),
    ...(typeof task.taskMaxHops === "number" ? { taskMaxHops: task.taskMaxHops } : {}),
    contacted: source === "native" ? nativeContacted(task.native) : [],
  }
}
