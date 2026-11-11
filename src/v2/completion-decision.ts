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
 * The check is structural, never copy-based: parent assignment, turn asker,
 * and handoff sender are durable IDs.
 */
export type CompletionSkipReason = "parent-is-leader" | "asker-is-leader" | "sender-is-leader"

export type CompletionDecision =
  | { decision: "deliver" }
  | {
      decision: "skip"
      reason: CompletionSkipReason
      taskID: Id
      parentID?: Id
      leaderID: Id
    }

export type CompletionTask = Pick<Subtask, "id" | "parentID" | "turn" | "handoff">

/**
 * Decide whether the finished task still needs its mandatory completion hop.
 * Specific provenance wins over the generic parent assignment: a handoff names
 * its sender, a peer turn names its asker, and a delegation inherits the
 * parent's assignee. Pure.
 */
export function completionDecision(input: {
  task: CompletionTask
  parent?: Pick<Subtask, "id" | "assigneeID">
  leaderID: Id
}): CompletionDecision {
  const leaderID = input.leaderID
  if (!leaderID) return { decision: "deliver" }
  const skip = (reason: CompletionSkipReason): CompletionDecision => ({
    decision: "skip",
    reason,
    taskID: input.task.id,
    ...(input.task.parentID ? { parentID: input.task.parentID } : {}),
    leaderID,
  })
  if (input.task.handoff?.senderID === leaderID) return skip("sender-is-leader")
  if (input.task.turn?.askerID === leaderID) return skip("asker-is-leader")
  if (input.parent?.assigneeID === leaderID) return skip("parent-is-leader")
  return { decision: "deliver" }
}
