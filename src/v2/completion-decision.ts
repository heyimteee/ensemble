import type { CommandRootResolution } from "./command-root.ts"
import type { Id, Subtask } from "./types.ts"

/**
 * Ticket #237: one pure completion decision.
 *
 * A completion hop exists so the leader reviews work they did not ask for.
 * When the leader was the parent, the finished peer turn's asker, or the
 * finished handoff's sender, the parent turn's synthesis already carries the
 * child result. A second hop would only run a full leader turn to answer the
 * same result twice, so the decision skips it.
 *
 * Ticket #247: the immediate parent is not enough. A chain can hand the work
 * down several workers while the leader owns the command root or another
 * ancestor. That root/ancestor synthesis already delivers the result, so the
 * decision skips with `ancestor-is-leader` instead of waking the leader for
 * every leaf.
 *
 * The check is structural, never copy-based: parent assignment, turn asker,
 * handoff sender, and ancestor assignments are durable IDs.
 */
export type CompletionSkipReason = "parent-is-leader" | "asker-is-leader" | "sender-is-leader" | "ancestor-is-leader"

export type CompletionDecision =
  | { decision: "deliver" }
  | {
      decision: "skip"
      reason: CompletionSkipReason
      taskID: Id
      parentID?: Id
      /** Topmost task on the chain, present when the caller resolved it. */
      rootID?: Id
      /** Leader-owned ancestor, present for `ancestor-is-leader`. */
      ancestorID?: Id
      leaderID: Id
    }

export type CompletionTask = Pick<Subtask, "id" | "parentID" | "turn" | "handoff">

/**
 * Decide whether the finished task still needs its mandatory completion hop.
 * Specific provenance wins over the generic parent assignment: a handoff names
 * its sender, a peer turn names its asker, and a delegation inherits the
 * parent's assignee. The command root and its chain close the ancestor form.
 * Pure.
 */
export function completionDecision(input: {
  task: CompletionTask
  parent?: Pick<Subtask, "id" | "assigneeID">
  /** Root and ancestor path resolved by `resolveCommandRoot`. */
  commandRoot?: Pick<CommandRootResolution, "root" | "chain">
  leaderID: Id
}): CompletionDecision {
  const leaderID = input.leaderID
  if (!leaderID) return { decision: "deliver" }
  const skip = (reason: CompletionSkipReason, ancestorID?: Id): CompletionDecision => ({
    decision: "skip",
    reason,
    taskID: input.task.id,
    ...(input.task.parentID ? { parentID: input.task.parentID } : {}),
    ...(input.commandRoot ? { rootID: input.commandRoot.root.id } : {}),
    ...(ancestorID ? { ancestorID } : {}),
    leaderID,
  })
  if (input.task.handoff?.senderID === leaderID) return skip("sender-is-leader")
  if (input.task.turn?.askerID === leaderID) return skip("asker-is-leader")
  if (input.parent?.assigneeID === leaderID) return skip("parent-is-leader")
  if (input.commandRoot) {
    // Nearest first: report the closest leader-owned ancestor, root included.
    const owner = [...input.commandRoot.chain]
      .reverse()
      .find((item) => item.id !== input.task.id && item.assigneeID === leaderID)
    if (owner) return skip("ancestor-is-leader", owner.id)
  }
  return { decision: "deliver" }
}
