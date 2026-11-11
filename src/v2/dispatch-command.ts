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

function canonical(value: string | undefined): string {
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
    assignee: canonical(assignment.assignee),
    title: canonical(assignment.title),
    instruction: canonical(assignment.instruction),
    constraints: canonical(assignment.constraints),
    expected: canonical(assignment.expected),
    mode: assignment.mode ?? "research",
    maxHops: assignment.maxHops,
  }))
  const setHash = stableHash(JSON.stringify({
    title: canonical(input.title),
    instruction: canonical(input.instruction),
    assignments,
  }))
  const prefix = `ensemble-dispatch:${input.workspaceID}:${input.originTaskID}:`
  return {
    prefix,
    setHash,
    rootKey: `${prefix}${setHash}:root`,
    assignmentKeys: assignments.map((_, index) => `${prefix}${setHash}:assign:${index}`),
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
  const prefix = `ensemble-dispatch:${workspaceID}:${originTaskID}:`
  return Object.values(subtasks).some(
    (task) => typeof task?.queueKey === "string" && task.queueKey.startsWith(prefix) && task.queueKey.endsWith(":root"),
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
  return typeof task.queueKey === "string" &&
    task.queueKey.startsWith("ensemble-dispatch:") &&
    task.queueKey.endsWith(":root") &&
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

/** Refusal copy for a whole command batch, never for a single hop. */
export function dispatchCommandRefusalText(refusal: DispatchRefusal): string {
  switch (refusal.layer) {
    case "command":
      return `the command budget is exhausted (${refusal.used}/${refusal.max} hops). Ask the user to start a new command for a fresh budget.`
    case "group":
      return `the new command group is limited to ${refusal.max} hops and the batch has ${refusal.used} assignments; reduce the batch.`
    case "depth":
      return `the dispatch depth limit is ${refusal.max} (next depth ${refusal.used}); reduce the batch.`
    case "fanout":
      return `the assignment limit is ${refusal.max} per command and the batch has ${refusal.used}; reduce the batch.`
    case "task":
      return `the task budget is exhausted (${refusal.used}/${refusal.max}); reduce the batch.`
    case "closed":
      return "the command is closed; ask the user to start a new command."
  }
}
