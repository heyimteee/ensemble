import { stableHash } from "./queue.ts"
import type { DispatchRefusal } from "./dispatch-budget.ts"
import type { DispatchGroup, Id, Subtask } from "./types.ts"

/**
 * Ticket #250: explicit terminal continuation. A terminal turn (synthesis,
 * completion review, or batch review) can start the next ticket with
 * `ensemble_dispatch`. The next ticket is a new command root with a fresh
 * command group and budget; its assignments are ordinary delegation work.
 *
 * This module owns the durable identity and the batch preflight only. The
 * store's dispatch ledger remains the one budget authority and the service's
 * admission path remains the one place a hop is spent. Pure: no store, clock,
 * host, or environment reads.
 */

export type DispatchAssignmentInput = {
  assignee: string
  title: string
  instruction: string
  constraints?: string
  expected?: string
  mode?: "research" | "edit"
  maxHops: number
}

export type DispatchCommandKeyInput = {
  workspaceID: Id
  /** The terminal turn that asked for the next ticket. */
  originTaskID: Id
  title: string
  instruction: string
  assignments: readonly DispatchAssignmentInput[]
}

export type DispatchCommandKey = {
  /** Durable prefix shared by the root and its assignments. */
  prefix: string
  /** Hash of the command text and assignment set. */
  setHash: string
  rootKey: string
  assignmentKeys: string[]
}

/** The one durable queue-key namespace for a terminal continuation command. */
export const DISPATCH_COMMAND_QUEUE_PREFIX = "ensemble-dispatch"

/** Scope prefix shared by a command root and its assignment batch. */
export function dispatchCommandPrefix(workspaceID: Id, originTaskID: Id): string {
  return `${DISPATCH_COMMAND_QUEUE_PREFIX}:${workspaceID}:${originTaskID}:`
}

/** Root queue key for one terminal turn and assignment set. */
export function dispatchCommandRootKey(prefix: string, setHash: string): string {
  return `${prefix}${setHash}:root`
}

/** Assignment queue key for one position in the batch. */
export function dispatchCommandAssignmentKey(prefix: string, setHash: string, index: number): string {
  return `${prefix}${setHash}:assign:${index}`
}

/** True when the key belongs to the continuation-command namespace. */
export function isDispatchCommandQueueKey(queueKey: string | undefined): boolean {
  return typeof queueKey === "string" && queueKey.startsWith(`${DISPATCH_COMMAND_QUEUE_PREFIX}:`)
}

/** True when the key is a command root, derived from the durable queue key. */
export function isDispatchCommandRootKey(queueKey: string | undefined): boolean {
  return typeof queueKey === "string" && isDispatchCommandQueueKey(queueKey) && queueKey.endsWith(":root")
}

/** True when the row is a continuation command root container. */
export function isDispatchCommandRoot(task: Pick<Subtask, "queueKey">): boolean {
  return isDispatchCommandRootKey(task.queueKey)
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim()
}

/**
 * Stable dispatch identity: the terminal task id scopes the command and the
 * assignment set makes a retry exact. The key is durable, so the terminal
 * notice can look up whether this turn started work without reading prompt
 * text or conversation content.
 */
export function dispatchCommandKey(input: DispatchCommandKeyInput): DispatchCommandKey {
  const assignments = input.assignments.map((assignment) => ({
    assignee: normalizeText(assignment.assignee),
    title: normalizeText(assignment.title),
    instruction: normalizeText(assignment.instruction),
    constraints: normalizeText(assignment.constraints),
    expected: normalizeText(assignment.expected),
    mode: assignment.mode ?? "research",
    maxHops: assignment.maxHops,
  }))
  const setHash = stableHash(JSON.stringify({
    title: normalizeText(input.title),
    instruction: normalizeText(input.instruction),
    assignments,
  }))
  const prefix = dispatchCommandPrefix(input.workspaceID, input.originTaskID)
  return {
    prefix,
    setHash,
    rootKey: dispatchCommandRootKey(prefix, setHash),
    assignmentKeys: assignments.map((_, index) => dispatchCommandAssignmentKey(prefix, setHash, index)),
  }
}

type QueueKeyed = Pick<Subtask, "queueKey">

/**
 * True when this terminal turn already started a command root. The durable
 * queue key is the lookup; the final text is never inspected. A missing root
 * (for example an assignment row left by a partial write) does not count.
 */
export function dispatchCommandStartedForTurn(
  subtasks: Readonly<Record<Id, QueueKeyed | undefined>>,
  workspaceID: Id,
  originTaskID: Id,
): boolean {
  const prefix = dispatchCommandPrefix(workspaceID, originTaskID)
  return Object.values(subtasks).some(
    (task) => typeof task?.queueKey === "string" && task.queueKey.startsWith(prefix) && isDispatchCommandRootKey(task.queueKey),
  )
}

/**
 * A command root is written just before its assignment batch. A maintenance
 * pass can run inside that window and see a waiting parent with no children;
 * this durable key check keeps the root waiting for the batch instead of
 * closing it. The grace bound is the queue delivery window, so a crash before
 * the batch is written cannot leave the root waiting forever.
 */
export function pendingDispatchCommandRoot(
  task: Pick<Subtask, "queueKey" | "createdAt">,
  at: number,
  graceMs: number,
): boolean {
  return isDispatchCommandRootKey(task.queueKey) &&
    at - task.createdAt < graceMs
}

export type DispatchCommandPreflightInput = {
  assignmentCount: number
  /** Prospective new command root group, before any row is written. */
  group: DispatchGroup
  /** Per-run assignment cap (`settings.maxDelegations`). */
  maxDelegations: number
  /** Depth every assignment would occupy under the new root. */
  nextDepth: number
}

/**
 * Batch preflight before the new command root exists. The user's command
 * ceiling is the outer bound and is checked first so its refusal can tell the
 * leader to ask for a new command; then the group segment, depth, and the
 * per-run assignment cap. The store still repeats the per-hop admission
 * atomically, so this is copy and no-work ordering, not a second ledger.
 */
export function preflightDispatchCommand(input: DispatchCommandPreflightInput): DispatchRefusal | undefined {
  const count = Math.max(0, Math.trunc(input.assignmentCount))
  const commandMax = input.group.commandMaxHops
  if (commandMax !== undefined && count > commandMax) return { layer: "command", used: count, max: commandMax }
  if (count > input.group.maxHops) return { layer: "group", used: count, max: input.group.maxHops }
  if (input.nextDepth > input.group.depthMax) return { layer: "depth", used: input.nextDepth, max: input.group.depthMax }
  if (count > input.maxDelegations) return { layer: "fanout", used: count, max: input.maxDelegations }
  return undefined
}

/** One suffix for every batch-too-large refusal; the layer supplies the numbers. */
const REDUCE_OR_SPLIT = "reduce the batch or split it across commands"

/** Refusal copy for a whole command batch, never for a single hop. */
export function dispatchCommandRefusalText(refusal: DispatchRefusal): string {
  switch (refusal.layer) {
    case "command":
      // The command ceiling here is the prospective new command's own cap, so
      // asking the user for a fresh command would not help: the batch itself
      // is too large for any command at this setting.
      return `the new command is limited to ${refusal.max} hops and the batch has ${refusal.used} assignments; ${REDUCE_OR_SPLIT}.`
    case "group":
      return `the new command group is limited to ${refusal.max} hops and the batch has ${refusal.used} assignments; ${REDUCE_OR_SPLIT}.`
    case "depth":
      return `the dispatch depth limit is ${refusal.max} (next depth ${refusal.used}); ${REDUCE_OR_SPLIT}.`
    case "fanout":
      return `the assignment limit is ${refusal.max} per command and the batch has ${refusal.used}; ${REDUCE_OR_SPLIT}.`
    case "task":
      return `the task budget is exhausted (${refusal.used}/${refusal.max}); ${REDUCE_OR_SPLIT}.`
    case "closed":
      return "the command is closed; ask the user to start a new command."
  }
}
