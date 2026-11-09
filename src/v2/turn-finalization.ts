import type { HandoffDecision, Id, NativeSubagentState, WorkKind } from "./types.ts"

/**
 * Ticket #194: the one pure turn-finalization policy.
 *
 * A managed turn reaches a terminal write in `runTask` after the agent has
 * answered. This module answers whether that turn may finalize, must wait for
 * a native child, must receive one bounded correction turn, or must finalize
 * with a visible warning. Later tickets (#197/#198/#200) extend the same seam;
 * the service remains the orchestrator and performs every side effect.
 *
 * Pure: no I/O, no clock reads, no host or TUI dependency. The caller gathers
 * durable facts and passes `now`-independent projections only.
 */

export type TurnFinalizationDecision =
  | { action: "accept" }
  | { action: "wait"; reason: string }
  | { action: "correct"; reason: string; remainingIDs?: Id[]; unbackedMemberIDs?: Id[] }
  | { action: "warn"; reason: string; remainingIDs?: Id[]; unbackedMemberIDs?: Id[] }

/** Durable task and work-kind projection for one finishing turn. */
export type TurnTaskFacts = {
  taskID: Id
  /** `delegation`, `handoff`, or `turn`; legacy rows normalize to delegation. */
  workKind: WorkKind
  /** This hop delivers a finished turn to the workspace leader. */
  completion: boolean
  /** This turn is a consolidated batch review. */
  batch: boolean
  /** The finisher owns the workspace; leader turns may end normally. */
  leader: boolean
  /** The run already handed off explicitly, satisfying the completion contract. */
  explicitHandoff: boolean
  /**
   * Ticket #198: this batch has already spent its one correction turn.
   * Durable so a restart cannot grant a second correction.
   */
  batchCorrectionSent: boolean
  /**
   * Ticket #200: this turn has already spent its one unbacked-mention
   * correction turn. Durable so a retry or restart cannot loop the
   * correction.
   */
  mentionCorrectionSent: boolean
}

/** One native child session mapped to the finishing task. */
export type TurnNativeChildFacts = {
  childSessionID: Id
  parentTaskID?: Id
  state: NativeSubagentState
  startedAt: number
  finishedAt?: number
}

/** One item consolidated into a batch review, with its current disposition. */
export type TurnBatchItemFacts = {
  id: Id
  decided?: HandoffDecision
}

/** The final assistant text and the workspace members it names. */
export type TurnFinalTextFacts = {
  text: string
  mentionedMemberIDs: Id[]
}

/** One work row created by the finishing run. */
export type TurnCreatedWorkFacts = {
  workID: Id
  workKind: WorkKind
  assigneeID?: Id
}

/** Everything the finalization policy may read. */
export type TurnFinalizationFacts = {
  task: TurnTaskFacts
  nativeChildren: TurnNativeChildFacts[]
  batchItems: TurnBatchItemFacts[]
  finalText: TurnFinalTextFacts
  createdWork: TurnCreatedWorkFacts[]
}

/**
 * Decide one managed turn's finalization.
 *
 * Ticket #194 introduced the seam; #198 adds the batch-review contract and
 * #200 adds unbacked member mentions. A batch review with any undecided item
 * gets one correction turn. If that correction still leaves items undecided,
 * the turn warns instead of finalizing as a successful reply, so the batch can
 * stay open for the user. A mentioned member with no work created by this run
 * gets one correction turn to create the work or remove the mention; if the
 * mention is still unbacked, the turn finalizes with a visible warning. The
 * decision is pure: the service performs the correction prompt and the durable
 * write.
 */
export function decideTurnFinalization(facts: TurnFinalizationFacts): TurnFinalizationDecision {
  if (facts.task.batch) {
    const remainingIDs = facts.batchItems
      .filter((item) => item.decided === undefined)
      .map((item) => item.id)
    if (remainingIDs.length > 0) {
      return facts.task.batchCorrectionSent
        ? { action: "warn", reason: "review-incomplete", remainingIDs }
        : { action: "correct", reason: "review-incomplete", remainingIDs }
    }
  }
  // Ticket #200: a mentioned member is backed only by work this run created
  // for them. The policy owns the backing rule; callers pass the members and
  // the created work, never a precomputed backed/unbacked split.
  const unbackedMemberIDs = facts.finalText.mentionedMemberIDs
    .filter((memberID) => !facts.createdWork.some((work) => work.assigneeID === memberID))
  if (unbackedMemberIDs.length > 0) {
    return facts.task.mentionCorrectionSent
      ? { action: "warn", reason: "mention-unbacked", unbackedMemberIDs }
      : { action: "correct", reason: "mention-unbacked", unbackedMemberIDs }
  }
  return { action: "accept" }
}
