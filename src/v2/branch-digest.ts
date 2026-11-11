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
export type BranchOutcome = "succeeded" | "failed" | "cancelled" | "pending"

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

function branchOutcome(task: Subtask): BranchOutcome {
  if (task.stoppedAt !== undefined) return "cancelled"
  if (task.state === "replied" && task.outcome === "succeeded") return "succeeded"
  if (task.state === "replied" && task.outcome === "failed") return "failed"
  return "pending"
}

function branchResult(task: Subtask, messages: ReadonlyMap<Id, Message>): string {
  const outcome = branchOutcome(task)
  if (outcome === "succeeded") {
    const text = task.resultMessageID ? messages.get(task.resultMessageID)?.text?.trim() : undefined
    return text || "(no reply)"
  }
  if (outcome === "failed") return task.error ? `(failed) ${task.error}` : "(failed)"
  if (outcome === "cancelled") return task.error ? `(cancelled) ${task.error}` : "(cancelled)"
  return "(pending)"
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
}): BranchResult[] {
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
        outcome: branchOutcome(child),
        result: branchResult(child, messages),
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
