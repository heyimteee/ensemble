import { randomUUID } from "node:crypto"
import { stableHash } from "./queue.ts"
import type { Id, Subtask } from "./types.ts"

/**
 * Durable dispatch-group identity (ticket #135).
 *
 * A dispatch group is the set of Subtasks caused by one dispatch action: a
 * user command plus every descendant handoff, delegation, peer turn,
 * synthesis, completion hop, approval-created task, and group-scoped
 * completion batch it caused. The group id lives on the Subtask row itself;
 * there is no separate group table.
 *
 * Legacy rows have no stored id and resolve one deterministically from their
 * root ancestor, so in-flight work keeps a coherent group across the
 * upgrade. Pure except for `newDispatchGroupID`, whose randomness is confined
 * to minting a brand-new dispatch.
 */

export const DISPATCH_GROUP_PREFIX = "dispatch_"

/** Mint one group for one new dispatch action (a user command fan-out). */
export function newDispatchGroupID(): string {
  return `${DISPATCH_GROUP_PREFIX}${randomUUID().replaceAll("-", "").slice(0, 20)}`
}

/** Deterministic stable group for a legacy tree with no stored identity. */
export function legacyDispatchGroupID(rootID: Id): string {
  return `${DISPATCH_GROUP_PREFIX}legacy_${stableHash(`dispatch-root:${rootID}`)}`
}

function storedGroupID(task: Subtask | undefined): Id | undefined {
  const value = task?.dispatchGroupID
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Nearest stored group on this task or its ancestor chain. Cycle-safe;
 * missing parents end the walk. Returns undefined only when the whole chain
 * is legacy.
 */
export function dispatchGroupIDFor(task: Subtask | undefined, subtasks: Record<Id, Subtask>): Id | undefined {
  const seen = new Set<Id>()
  let current = task
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    const stored = storedGroupID(current)
    if (stored) return stored
    current = current.parentID ? subtasks[current.parentID] : undefined
  }
  return undefined
}

/** Walk to the root ancestor (cycle-safe, missing parents end the walk). */
function dispatchRootID(task: Subtask, subtasks: Record<Id, Subtask>): Id {
  const seen = new Set<Id>([task.id])
  let root = task
  while (root.parentID) {
    const parent = subtasks[root.parentID]
    if (!parent || seen.has(parent.id)) break
    seen.add(parent.id)
    root = parent
  }
  return root.id
}

/**
 * Resolution for read paths: the nearest stored group, else one deterministic
 * group derived from the root ancestor. Legacy siblings and descendants all
 * resolve to the same value without a write.
 */
export function resolveDispatchGroupID(task: Subtask | undefined, subtasks: Record<Id, Subtask>): Id | undefined {
  if (!task) return undefined
  return dispatchGroupIDFor(task, subtasks) ?? legacyDispatchGroupID(dispatchRootID(task, subtasks))
}

/**
 * Resolution for write paths: an explicit group wins, then the parent's
 * resolved group, then a freshly minted group. This is the single fallback
 * for handoffs, delegations, peer turns, synthesis, completion hops,
 * approval-created work, and batch follow-ups.
 */
export function inheritDispatchGroupID(input: {
  parent?: Subtask
  subtasks: Record<Id, Subtask>
  explicit?: string
  mint?: () => string
}): Id {
  const explicit = input.explicit?.trim()
  if (explicit) return explicit
  const inherited = resolveDispatchGroupID(input.parent, input.subtasks)
  if (inherited) return inherited
  return (input.mint ?? newDispatchGroupID)()
}
