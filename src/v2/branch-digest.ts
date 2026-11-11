import { deriveWorkStatus, isTerminalWorkStatus } from "./queue.ts"
import type { Agent, Id, Message, Subtask } from "./types.ts"

/**
 * Ticket #246: the root synthesis context is a bounded branch digest, not the
 * direct children of an intermediate leader task. Each terminal leaf
 * contributes its worker path and final result; a relay therefore reports the
 * leaf answer, never an intermediate parent's own reply.
 *
 * Completion hops are review deliveries, not work branches. They never appear
 * in the digest.
 */
export type BranchOutcome = "succeeded" | "failed" | "cancelled" | "stalled" | "pending"

export type BranchResult = {
  /** Terminal leaf task id. */
  taskID: Id
  /** Agent ids from the command root down to the leaf. */
  path: Id[]
  outcome: BranchOutcome
  /** Final result text, failure copy, or status marker. */
  result: string
}

export type BranchDigestOptions = {
  maxBranches?: number
  maxResultChars?: number
}

const DEFAULT_MAX_BRANCHES = 20
const DEFAULT_MAX_RESULT_CHARS = 600

/**
 * Ticket #251 review: the digest uses the canonical lifecycle, not a local
 * state/outcome/stoppedAt guess. `stalled` stays distinct from `failed`; the
 * queue owns that boundary (a native error is failed, an exhausted delivery is
 * stalled). Non-terminal statuses collapse to pending in the digest.
 */
function branchOutcome(task: Subtask, at: number): BranchOutcome {
  const status = deriveWorkStatus(task, at)
  if (status === "stalled") return "stalled"
  if (!isTerminalWorkStatus(status)) return "pending"
  if (status === "replied") return "succeeded"
  if (status === "failed") return "failed"
  return "cancelled"
}

function branchResult(task: Subtask, messages: ReadonlyMap<Id, Message>, at: number): string {
  const outcome = branchOutcome(task, at)
  if (outcome === "succeeded") {
    const text = task.resultMessageID ? messages.get(task.resultMessageID)?.text?.trim() : undefined
    return text || "(no reply)"
  }
  if (outcome === "failed") return task.error ? `(failed) ${task.error}` : "(failed)"
  if (outcome === "stalled") return task.error ? `(stalled) ${task.error}` : "(stalled)"
  if (outcome === "cancelled") return task.error ? `(cancelled) ${task.error}` : "(cancelled)"
  return "(pending)"
}

/**
 * Ticket #251: a parent settles only when its whole non-completion subtree is
 * terminal. A direct child can be replied while a peer turn it just routed is
 * still pending, so checking direct children alone starts the root synthesis
 * early. Pure; completion hops are review deliveries, never branches.
 */
export function pendingDescendantResolver(input: {
  subtasks: Readonly<Record<Id, Subtask>>
  isTerminal: (task: Subtask) => boolean
}): (parentID: Id) => boolean {
  const childrenByParent = new Map<Id, Subtask[]>()
  for (const task of Object.values(input.subtasks)) {
    if (!task.parentID || task.handoff?.completion === true) continue
    const list = childrenByParent.get(task.parentID) ?? []
    list.push(task)
    childrenByParent.set(task.parentID, list)
  }
  const memo = new Map<Id, boolean>()
  const visiting = new Set<Id>()
  const pending = (parentID: Id): boolean => {
    const cached = memo.get(parentID)
    if (cached !== undefined) return cached
    if (visiting.has(parentID)) return false
    visiting.add(parentID)
    let result = false
    for (const child of childrenByParent.get(parentID) ?? []) {
      if (!input.isTerminal(child) || pending(child.id)) {
        result = true
        break
      }
    }
    visiting.delete(parentID)
    memo.set(parentID, result)
    return result
  }
  return pending
}

/** Convenience wrapper for one parent; the resolver is memoized per call. */
export function hasPendingDescendant(input: {
  parentID: Id
  subtasks: Readonly<Record<Id, Subtask>>
  isTerminal: (task: Subtask) => boolean
}): boolean {
  return pendingDescendantResolver(input)(input.parentID)
}

/**
 * Walk every non-completion branch from the command root to its terminal
 * leaves. Children are ordered by creation time and id so the digest is
 * deterministic. Pure.
 */
export function collectBranchResults(input: {
  rootID: Id
  subtasks: Readonly<Record<Id, Subtask>>
  messages: readonly Message[]
  /**
   * Canonical lifecycle clock. Defaults to 0 because only terminal rows shape
   * the digest; a live lease still collapses to pending either way. Callers
   * that already have a clock pass it for exactness.
   */
  now?: number
}): BranchResult[] {
  const at = input.now ?? 0
  const byID = new Map<Id, Subtask>(Object.entries(input.subtasks))
  const messages = new Map(input.messages.map((message) => [message.id, message]))
  const childrenByParent = new Map<Id, Subtask[]>()
  for (const task of byID.values()) {
    if (!task.parentID) continue
    if (task.handoff?.completion === true) continue
    const list = childrenByParent.get(task.parentID) ?? []
    list.push(task)
    childrenByParent.set(task.parentID, list)
  }
  for (const list of childrenByParent.values()) {
    list.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  }
  const branches: BranchResult[] = []
  const walk = (parentID: Id, path: Id[], seen: ReadonlySet<Id>): void => {
    for (const child of childrenByParent.get(parentID) ?? []) {
      if (seen.has(child.id)) continue
      const nextPath = child.assigneeID ? [...path, child.assigneeID] : path
      const nextSeen = new Set(seen).add(child.id)
      const grandchildren = (childrenByParent.get(child.id) ?? []).filter((item) => !nextSeen.has(item.id))
      if (grandchildren.length > 0) {
        walk(child.id, nextPath, nextSeen)
        continue
      }
      branches.push({
        taskID: child.id,
        path: nextPath,
        outcome: branchOutcome(child, at),
        result: branchResult(child, messages, at),
      })
    }
  }
  const root = byID.get(input.rootID)
  if (root) walk(input.rootID, root.assigneeID ? [root.assigneeID] : [], new Set([input.rootID]))
  return branches
}

function boundedResult(result: string, maxResultChars: number): string {
  const text = result.replace(/\s+/g, " ").trim()
  if (text.length <= maxResultChars) return text
  return `${text.slice(0, Math.max(0, maxResultChars)).trimEnd()}…`
}

/** Format the bounded digest block body for the root synthesis context. */
export function formatBranchDigest(
  branches: readonly BranchResult[],
  agents: Readonly<Record<Id, Agent>>,
  options: BranchDigestOptions = {},
): string {
  if (branches.length === 0) return ""
  const maxBranches = Math.max(0, Math.floor(options.maxBranches ?? DEFAULT_MAX_BRANCHES))
  const maxResultChars = Math.max(0, Math.floor(options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS))
  const shown = branches.slice(0, maxBranches)
  const lines = shown.map((branch) => {
    const path = branch.path.map((agentID) => `$${agents[agentID]?.name ?? agentID}`).join(" → ")
    return `- ${path}: ${boundedResult(branch.result, maxResultChars)}`
  })
  const omitted = branches.length - shown.length
  if (omitted > 0) lines.push(`- (+${omitted} more branches)`)
  return lines.join("\n")
}
