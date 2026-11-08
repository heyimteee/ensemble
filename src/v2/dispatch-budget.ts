import type { DispatchGroup, Id, Settings, Subtask } from "./types.ts"

/**
 * Dispatch hop budget arithmetic (ticket #160).
 *
 * Four independent numbers, each with one owner:
 * - command: the user's ceiling for one user command, across every group.
 * - group: the hops allowed inside one dispatch group (root or continuation).
 * - task: the direct dispatches a recipient may make (#161 enforces it).
 * - depth: the longest ancestor chain inside one group.
 *
 * This module owns the tiers, validation, ledger factories, derived budget
 * state, hop accounting, and legacy reconciliation. It is pure: the store
 * persists the records and the service decides when to consult the numbers.
 */

export const DISPATCH_GROUP_TIERS = [8, 16, 24] as const
export const DISPATCH_COMMAND_TIERS = [8, 16, 24, 32, 40, 48] as const
export const DISPATCH_DEPTH_MIN = 1
export const DISPATCH_DEPTH_MAX = 16
export const DISPATCH_CONTINUATIONS_MIN = 0
export const DISPATCH_CONTINUATIONS_MAX = 5
/** Smallest continuation group; the product default and the validation floor. */
export const DISPATCH_MIN_GROUP_HOPS = 8

export type DispatchLimits = {
  groupMaxHops: number
  commandMaxHops: number
  depth: number
  continuations: number
}

export type DispatchLimitField = keyof DispatchLimits

export type DispatchLimitsValidation =
  | { ok: true; limits: DispatchLimits; settings: Pick<Settings, "dispatchGroupMaxHops" | "dispatchCommandMaxHops" | "dispatchDepth" | "dispatchContinuations"> }
  | { ok: false; errors: string[] }

type LimitSettings = Pick<
  Settings,
  "dispatchGroupMaxHops" | "dispatchCommandMaxHops" | "dispatchDepth" | "dispatchContinuations"
>

function integer(value: unknown, fallback: number): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback
}

/** Read the four limit values from settings, tolerating older persisted rows. */
export function dispatchLimits(settings: Partial<LimitSettings> | undefined): DispatchLimits {
  return {
    groupMaxHops: integer(settings?.dispatchGroupMaxHops, 8),
    commandMaxHops: integer(settings?.dispatchCommandMaxHops, 24),
    depth: integer(settings?.dispatchDepth, 8),
    continuations: integer(settings?.dispatchContinuations, 2),
  }
}

/** Settings patch for one validated limit set. */
export function dispatchLimitSettings(limits: DispatchLimits): LimitSettings {
  return {
    dispatchGroupMaxHops: limits.groupMaxHops,
    dispatchCommandMaxHops: limits.commandMaxHops,
    dispatchDepth: limits.depth,
    dispatchContinuations: limits.continuations,
  }
}

function sameValues(allowed: readonly number[], value: number): boolean {
  return allowed.includes(value)
}

/**
 * Validate the four limits together. The two hard rules are the user's
 * ceilings: command hops must cover the root group, and the configured
 * continuation count must fit at the smallest allowed continuation size.
 */
export function validateDispatchLimits(input: Partial<DispatchLimits>): DispatchLimitsValidation {
  const limits: DispatchLimits = {
    groupMaxHops: integer(input.groupMaxHops, NaN),
    commandMaxHops: integer(input.commandMaxHops, NaN),
    depth: integer(input.depth, NaN),
    continuations: integer(input.continuations, NaN),
  }
  const errors: string[] = []
  if (!Number.isFinite(limits.groupMaxHops)) errors.push("Group hops is required.")
  else if (!sameValues(DISPATCH_GROUP_TIERS, limits.groupMaxHops)) {
    errors.push(`Group hops must be one of ${DISPATCH_GROUP_TIERS.join(", ")}.`)
  }
  if (!Number.isFinite(limits.commandMaxHops)) errors.push("Command hops is required.")
  else if (!sameValues(DISPATCH_COMMAND_TIERS, limits.commandMaxHops)) {
    errors.push(`Command hops must be one of ${DISPATCH_COMMAND_TIERS.join(", ")}.`)
  }
  if (!Number.isFinite(limits.depth)) errors.push("Depth is required.")
  else if (limits.depth < DISPATCH_DEPTH_MIN || limits.depth > DISPATCH_DEPTH_MAX) {
    errors.push(`Depth must be between ${DISPATCH_DEPTH_MIN} and ${DISPATCH_DEPTH_MAX}.`)
  }
  if (!Number.isFinite(limits.continuations)) errors.push("Continuations is required.")
  else if (limits.continuations < DISPATCH_CONTINUATIONS_MIN || limits.continuations > DISPATCH_CONTINUATIONS_MAX) {
    errors.push(`Continuations must be between ${DISPATCH_CONTINUATIONS_MIN} and ${DISPATCH_CONTINUATIONS_MAX}.`)
  }
  if (errors.length > 0) return { ok: false, errors }
  if (limits.commandMaxHops < limits.groupMaxHops) {
    errors.push(`Command hops (${limits.commandMaxHops}) must be at least group hops (${limits.groupMaxHops}).`)
  }
  const needed = limits.groupMaxHops + DISPATCH_MIN_GROUP_HOPS * limits.continuations
  if (needed > limits.commandMaxHops) {
    errors.push(
      `${limits.continuations} continuation${limits.continuations === 1 ? "" : "s"} need at least ${needed} command hops with ${DISPATCH_MIN_GROUP_HOPS}-hop groups; raise command hops or lower continuations.`,
    )
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, limits, settings: dispatchLimitSettings(limits) }
}

/** Move one limit by `delta` within its allowed set (numbers clamp, tiers cycle). */
export function stepDispatchLimit(field: DispatchLimitField, current: number, delta: number): number {
  switch (field) {
    case "groupMaxHops":
      return stepTier(DISPATCH_GROUP_TIERS, current, delta)
    case "commandMaxHops":
      return stepTier(DISPATCH_COMMAND_TIERS, current, delta)
    case "depth":
      return clamp(current + Math.sign(delta), DISPATCH_DEPTH_MIN, DISPATCH_DEPTH_MAX)
    case "continuations":
      return clamp(current + Math.sign(delta), DISPATCH_CONTINUATIONS_MIN, DISPATCH_CONTINUATIONS_MAX)
  }
}

function stepTier(tiers: readonly number[], current: number, delta: number): number {
  const index = tiers.indexOf(current)
  if (index < 0) return tiers[Math.max(0, Math.min(tiers.length - 1, delta < 0 ? tiers.length - 1 : 0))]!
  const next = clamp(index + Math.sign(delta), 0, tiers.length - 1)
  return tiers[next]!
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)))
}

/** Root group for one user command; captures the current setting values. */
export function newRootDispatchGroup(input: {
  id: Id
  workspaceID: Id
  settings: Partial<LimitSettings> | undefined
  now?: number
}): DispatchGroup {
  const limits = dispatchLimits(input.settings)
  return {
    id: input.id,
    workspaceID: input.workspaceID,
    rootID: input.id,
    continuationIndex: 0,
    maxHops: limits.groupMaxHops,
    usedHops: 0,
    depthMax: limits.depth,
    commandMaxHops: limits.commandMaxHops,
    commandUsedHops: 0,
    maxContinuations: limits.continuations,
    continuationsUsed: 0,
    createdAt: input.now ?? Date.now(),
  }
}

/**
 * Continuation group factory (ticket #162 consumes it). The root command
 * ledger keeps the command counters; the continuation carries only its own
 * segment and resets depth for that segment.
 */
export function newContinuationDispatchGroup(input: {
  id: Id
  root: DispatchGroup
  parentID: Id
  maxHops: number
  now?: number
}): DispatchGroup {
  return {
    id: input.id,
    workspaceID: input.root.workspaceID,
    rootID: input.root.rootID,
    parentID: input.parentID,
    continuationIndex: (input.root.continuationsUsed ?? 0) + 1,
    maxHops: Math.max(1, Math.trunc(input.maxHops)),
    usedHops: 0,
    depthMax: input.root.depthMax,
    createdAt: input.now ?? Date.now(),
  }
}

export type DispatchGroupState = "active" | "exhausted" | "closed"

/** Derived state: never stored separately from the counters. */
export function dispatchGroupState(group: DispatchGroup): DispatchGroupState {
  if (group.closedAt !== undefined) return "closed"
  if (group.usedHops >= group.maxHops) return "exhausted"
  if (isRootGroup(group) && group.commandUsedHops !== undefined && group.commandMaxHops !== undefined && group.commandUsedHops >= group.commandMaxHops) {
    return "exhausted"
  }
  return "active"
}

export function isRootGroup(group: DispatchGroup): boolean {
  return group.id === group.rootID
}

export function dispatchGroupRemaining(group: DispatchGroup): number {
  return Math.max(0, group.maxHops - group.usedHops)
}

/** Remaining command hops for a group, resolving its root; undefined without a ledger root. */
export function dispatchCommandRemaining(group: DispatchGroup | undefined, groups: Record<Id, DispatchGroup>): number | undefined {
  if (!group) return undefined
  const root = isRootGroup(group) ? group : groups[group.rootID]
  if (!root || root.commandMaxHops === undefined || root.commandUsedHops === undefined) return undefined
  return Math.max(0, root.commandMaxHops - root.commandUsedHops)
}

export type DispatchBudgetSummary = {
  usedHops: number
  maxHops: number
  commandRemaining?: number
  commandMaxHops?: number
}

/** Compact display forms; the UI picks the richest one that fits. */
export function dispatchBudgetLabel(summary: DispatchBudgetSummary, style: "full" | "medium" | "short"): string {
  const hops = `${summary.usedHops}/${summary.maxHops}`
  if (style === "short" || summary.commandRemaining === undefined) return hops
  if (style === "medium") return `${hops} · ${summary.commandRemaining} left`
  return `hops ${hops} · cmd ${summary.commandRemaining} left`
}

export function dispatchBudgetSummary(group: DispatchGroup, groups: Record<Id, DispatchGroup>): DispatchBudgetSummary {
  const commandRemaining = dispatchCommandRemaining(group, groups)
  const root = isRootGroup(group) ? group : groups[group.rootID]
  return {
    usedHops: group.usedHops,
    maxHops: group.maxHops,
    ...(commandRemaining !== undefined ? { commandRemaining } : {}),
    ...(root?.commandMaxHops !== undefined ? { commandMaxHops: root.commandMaxHops } : {}),
  }
}

/**
 * True when creating this work item spends one hop: an agent-created
 * delegation or explicit handoff. User command recipients, peer turns,
 * completion handoffs, batch review, synthesis, retries, restarts, and
 * recovery never consume.
 */
export function dispatchesHop(task: Pick<Subtask, "creatorType" | "workKind" | "handoff">): boolean {
  if (task.creatorType !== "agent") return false
  if (task.workKind !== "delegation" && task.workKind !== "handoff") return false
  if (task.handoff?.completion === true) return false
  if (task.handoff?.batch === true) return false
  return true
}

/** Existing non-completion delegation and handoff count for one group. */
export function dispatchHopCount(tasks: readonly Pick<Subtask, "creatorType" | "workKind" | "handoff">[]): number {
  return tasks.reduce((count, task) => count + (dispatchesHop(task) ? 1 : 0), 0)
}

function observedDepth(task: Subtask, byID: Record<Id, Subtask>): number {
  let depth = 0
  let current = task
  const seen = new Set<Id>([task.id])
  while (current.parentID) {
    const parent = byID[current.parentID]
    if (!parent || seen.has(parent.id)) break
    seen.add(parent.id)
    depth++
    current = parent
  }
  return depth
}

/**
 * Synthesize one ledger record for a pre-ledger group. Used hops are the
 * existing non-completion delegation/handoff count; maximums are raised to
 * at least observed usage so an upgrade can never retroactively refuse work
 * that was already admitted.
 */
export function reconcileLegacyDispatchGroup(input: {
  id: Id
  workspaceID: Id
  tasks: readonly Subtask[]
  allTasks: Record<Id, Subtask>
  settings: Partial<LimitSettings> | undefined
  now?: number
}): DispatchGroup {
  const limits = dispatchLimits(input.settings)
  const usedHops = dispatchHopCount(input.tasks)
  const observed = input.tasks.reduce((deepest, task) => Math.max(deepest, observedDepth(task, input.allTasks)), 0)
  const createdAt = input.tasks.reduce(
    (earliest, task) => (Number.isFinite(task.createdAt) && task.createdAt < earliest ? task.createdAt : earliest),
    input.now ?? Date.now(),
  )
  return {
    id: input.id,
    workspaceID: input.workspaceID,
    rootID: input.id,
    continuationIndex: 0,
    maxHops: Math.max(limits.groupMaxHops, usedHops),
    usedHops,
    depthMax: Math.max(limits.depth, observed, 1),
    commandMaxHops: Math.max(limits.commandMaxHops, usedHops),
    commandUsedHops: usedHops,
    maxContinuations: limits.continuations,
    continuationsUsed: 0,
    createdAt,
    reconciled: true,
  }
}

/**
 * Legacy live work receives the group's remaining budget as its task budget
 * so #161 can enforce a truthful local bound without inventing a refusal for
 * work already in flight.
 */
export function reconcileLegacyTaskBudgets(group: DispatchGroup, tasks: readonly Subtask[]): Subtask[] {
  const remaining = dispatchGroupRemaining(group)
  return tasks
    .filter((task) => task.state !== "replied" && task.taskMaxHops === undefined)
    .map((task) => ({ ...task, taskMaxHops: remaining }))
}
