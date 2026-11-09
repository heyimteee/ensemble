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
  | { action: "correct"; reason: string; remainingIDs?: Id[] }
  | { action: "warn"; reason: string }

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
 * Ticket #194 introduces the seam with the current behaviour only: every
 * managed turn is accepted. The decision union is already shaped for the
 * contracts that build on it, so later tickets add the wait, correction, and
 * warning rules here instead of growing parallel checks in the service.
 */
export function decideTurnFinalization(_facts: TurnFinalizationFacts): TurnFinalizationDecision {
  return { action: "accept" }
}
