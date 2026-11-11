import { dispatchDepthFor } from "./dispatch-budget.ts"
import { resolveDispatchGroupID } from "./dispatch-group.ts"
import { parseDirectMessageChannel } from "./message-channel.ts"
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
 * Every candidate is validated against the workspace and agent that made the
 * call. A turn from another workspace, another agent, or a home direct
 * conversation can never anchor workspace work.
 *
 * The anchor supplies the parent, dispatch group, and depth. Group and command
 * ceilings still come from the dispatch ledger at admission; the anchor never
 * mints a second work model or a fresh group when an owned turn exists.
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
  /** Recipients already contacted during this native turn; empty otherwise. */
  contacted: readonly Id[]
}

export type ActiveTurnAnchorInput = {
  /** The workspace that made the call. */
  workspaceID: Id
  /** The agent that made the call. */
  agentID: Id
  runTask?: Subtask
  nativeTurn?: Subtask
  fallbackTask?: Subtask
  subtasks: Record<Id, Subtask>
}

/**
 * True when the task belongs to the workspace and is assigned to the agent.
 * A workspace direct conversation uses `dm:<agentID>:<workspaceID>` as its
 * channel, so it belongs to that workspace even though its id is not the
 * group channel; a home direct turn has no workspace and never matches.
 */
export function anchorTaskBelongs(task: Subtask, workspaceID: Id, agentID: Id): boolean {
  if (task.assigneeID !== agentID) return false
  if (task.workspaceID === workspaceID) return true
  const direct = parseDirectMessageChannel(task.conversationID ?? task.workspaceID)
  return direct?.workspaceID === workspaceID
}

export function resolveActiveTurnAnchor(input: ActiveTurnAnchorInput): ActiveTurnAnchor | undefined {
  const eligible = (task: Subtask | undefined): task is Subtask =>
    task !== undefined && anchorTaskBelongs(task, input.workspaceID, input.agentID)
  const runTask = eligible(input.runTask) ? input.runTask : undefined
  const nativeTurn = eligible(input.nativeTurn) ? input.nativeTurn : undefined
  const fallbackTask = eligible(input.fallbackTask) ? input.fallbackTask : undefined
  const resolved =
    (runTask && { source: "run" as const, task: runTask })
    ?? (nativeTurn && { source: "native" as const, task: nativeTurn })
    ?? (fallbackTask && { source: "fallback" as const, task: fallbackTask })
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
    contacted: source === "native" ? nativeContacted(task.native) : [],
  }
}
