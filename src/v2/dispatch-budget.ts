import { resolveDispatchGroupID } from "./dispatch-group.ts"
import type { DispatchGroup, Id, Settings, Subtask, WorkKind } from "./types.ts"

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
/** Smallest allowed continuation group; the validation floor and default. */
export const DISPATCH_MIN_GROUP_HOPS = DISPATCH_GROUP_TIERS[0]

export type DispatchLimits = {
  groupMaxHops: number
  commandMaxHops: number
  depth: number
  continuations: number
}

/**
 * The one product default set (ADR 0004). Settings defaults, limit fallbacks,
 * tool descriptions, and tests consume this instead of repeating literals.
 */
export const DISPATCH_LIMIT_DEFAULTS: DispatchLimits = Object.freeze({
  groupMaxHops: 8,
  commandMaxHops: 24,
  depth: 8,
  continuations: 2,
})

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
    groupMaxHops: integer(settings?.dispatchGroupMaxHops, DISPATCH_LIMIT_DEFAULTS.groupMaxHops),
    commandMaxHops: integer(settings?.dispatchCommandMaxHops, DISPATCH_LIMIT_DEFAULTS.commandMaxHops),
    depth: integer(settings?.dispatchDepth, DISPATCH_LIMIT_DEFAULTS.depth),
    continuations: integer(settings?.dispatchContinuations, DISPATCH_LIMIT_DEFAULTS.continuations),
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
  /** Creation order within the command; defaults from the root counters. */
  continuationIndex?: number
  now?: number
}): DispatchGroup {
  return {
    id: input.id,
    workspaceID: input.root.workspaceID,
    rootID: input.root.rootID,
    parentID: input.parentID,
    continuationIndex: input.continuationIndex ?? (input.root.continuationsUsed ?? 0) + 1,
    maxHops: Math.max(1, Math.trunc(input.maxHops)),
    usedHops: 0,
    depthMax: input.root.depthMax,
    createdAt: input.now ?? Date.now(),
  }
}

export type DispatchGroupState = "active" | "exhausted" | "closed"

/**
 * True when no further hop can be admitted from this group: its own hops are
 * spent or the root command ledger has no hops left. Closing a continued
 * parent does not erase this truth, so the Work header can still say
 * EXHAUSTED after a continuation exists.
 */
export function dispatchGroupExhausted(group: DispatchGroup, groups?: Record<Id, DispatchGroup>): boolean {
  if (group.usedHops >= group.maxHops) return true
  const root = isRootGroup(group) ? group : groups?.[group.rootID]
  return root?.commandUsedHops !== undefined &&
    root.commandMaxHops !== undefined &&
    root.commandUsedHops >= root.commandMaxHops
}

/** Derived state: never stored separately from the counters. */
export function dispatchGroupState(group: DispatchGroup, groups?: Record<Id, DispatchGroup>): DispatchGroupState {
  if (group.closedAt !== undefined) return "closed"
  if (dispatchGroupExhausted(group, groups)) return "exhausted"
  return "active"
}

export function isRootGroup(group: DispatchGroup): boolean {
  return group.id === group.rootID
}

export function dispatchGroupRemaining(group: DispatchGroup): number {
  return Math.max(0, group.maxHops - group.usedHops)
}

/** Remaining command hops from a resolved root, or undefined without a ledger root. */
export function dispatchCommandRemainingFromRoot(root: DispatchGroup | undefined): number | undefined {
  if (!root || root.commandMaxHops === undefined || root.commandUsedHops === undefined) return undefined
  return Math.max(0, root.commandMaxHops - root.commandUsedHops)
}

/** Remaining command hops for a group, resolving its root; undefined without a ledger root. */
export function dispatchCommandRemaining(group: DispatchGroup | undefined, groups: Record<Id, DispatchGroup>): number | undefined {
  if (!group) return undefined
  return dispatchCommandRemainingFromRoot(isRootGroup(group) ? group : groups[group.rootID])
}

/** Derived continuation allowance: the single owner of the can-continue rule. */
export type DispatchContinuationCapacity = {
  commandRemaining?: number
  continuationsLeft: number
  canContinue: boolean
}

export function dispatchContinuationCapacity(root: DispatchGroup | undefined): DispatchContinuationCapacity {
  const commandRemaining = dispatchCommandRemainingFromRoot(root)
  const continuationsLeft = Math.max(0, (root?.maxContinuations ?? 0) - (root?.continuationsUsed ?? 0))
  return {
    ...(commandRemaining !== undefined ? { commandRemaining } : {}),
    continuationsLeft,
    canContinue: commandRemaining !== undefined && commandRemaining >= DISPATCH_MIN_GROUP_HOPS && continuationsLeft > 0,
  }
}

/** True when a group was sealed because a continuation took over its work. */
export function dispatchGroupContinued(group: Pick<DispatchGroup, "closeReason">): boolean {
  return group.closeReason === "continued"
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
 * Compact aggregate for diagnostics, the doctor, and log triage (#163).
 * Counts and caps only; never task content. Derived state uses the same
 * `dispatchGroupState` truth the Work header reads.
 */
export type DispatchLedgerSummary = {
  groups: number
  roots: number
  continuations: number
  activeGroups: number
  exhaustedGroups: number
  closedGroups: number
  /** Groups whose own group hops are fully spent, closed or not. */
  groupsAtLimit: number
  usedHops: number
  maxHops: number
  commandUsedHops: number
  commandMaxHops: number
  continuationsUsed: number
  maxContinuations: number
}

export function dispatchLedgerSummary(groups: Record<Id, DispatchGroup>): DispatchLedgerSummary {
  const summary: DispatchLedgerSummary = {
    groups: 0,
    roots: 0,
    continuations: 0,
    activeGroups: 0,
    exhaustedGroups: 0,
    closedGroups: 0,
    groupsAtLimit: 0,
    usedHops: 0,
    maxHops: 0,
    commandUsedHops: 0,
    commandMaxHops: 0,
    continuationsUsed: 0,
    maxContinuations: 0,
  }
  for (const group of Object.values(groups)) {
    summary.groups++
    summary.usedHops += group.usedHops
    summary.maxHops += group.maxHops
    if (group.usedHops >= group.maxHops) summary.groupsAtLimit++
    if (isRootGroup(group)) {
      summary.roots++
      summary.commandUsedHops += group.commandUsedHops ?? 0
      summary.commandMaxHops += group.commandMaxHops ?? 0
      summary.continuationsUsed += group.continuationsUsed ?? 0
      summary.maxContinuations += group.maxContinuations ?? 0
    } else {
      summary.continuations++
    }
    const state = dispatchGroupState(group, groups)
    if (state === "active") summary.activeGroups++
    else if (state === "exhausted") summary.exhaustedGroups++
    else summary.closedGroups++
  }
  return summary
}

/* ------------------------------------------------------------------------- *
 * Ticket #162: exhaustion and continuation groups.
 *
 * A continuation is a new segment of the same command: it references its
 * parent and root, captures a leader-chosen group tier, resets depth for the
 * segment, and leaves the root command ledger authoritative. Only the leader
 * may open one, only after the referenced group is exhausted, and only while
 * the command cap, continuation count, and command remaining all fit.
 *
 * Closed groups: opening a continuation seals its parent with
 * `closeReason: "continued"`. A closed group admits no new dispatch hop and
 * cannot be continued again; exempt completion, batch, synthesis, retry, and
 * recovery rows still save directly. Exhausted counters stay visible for the
 * Work header.
 * ------------------------------------------------------------------------- */

export type ContinuationRefusalReason =
  | "not-leader"
  | "unknown-group"
  | "invalid-group-budget"
  | "command-exhausted"
  | "command-insufficient"
  | "group-active"
  | "group-closed"
  | "group-superseded"
  | "continuations-exhausted"

export type ContinuationRefusal = {
  reason: ContinuationRefusalReason
  groupID?: Id
  rootID?: Id
  used?: number
  max?: number
  remaining?: number
  requested?: number
  continuationsUsed?: number
  maxContinuations?: number
}

export type ContinuationValidation =
  | { ok: true; root: DispatchGroup; parent: DispatchGroup; maxHops: number }
  | { ok: false; refusal: ContinuationRefusal }

function validGroupTier(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined
  return DISPATCH_GROUP_TIERS.includes(value as (typeof DISPATCH_GROUP_TIERS)[number]) ? value : undefined
}

/**
 * Ordered verdict for opening one continuation group. The caller must pass the
 * referenced group id and the required leader-chosen group tier. The order is
 * leadership, group identity, tier, command ceiling, group stop, closure, then
 * the continuation count so copy always names the first blocking layer.
 */
export function validateContinuation(input: {
  continuationOf: unknown
  groupMaxHops: unknown
  groups: Record<Id, DispatchGroup>
  workspaceID: Id
  isLeader: boolean
}): ContinuationValidation {
  if (!input.isLeader) return { ok: false, refusal: { reason: "not-leader" } }
  const id = typeof input.continuationOf === "string" ? input.continuationOf.trim() : ""
  const parent = id ? input.groups[id] : undefined
  if (!id || !parent || parent.workspaceID !== input.workspaceID) {
    return { ok: false, refusal: { reason: "unknown-group", groupID: id || undefined } }
  }
  const root = isRootGroup(parent) ? parent : input.groups[parent.rootID]
  if (!root || root.workspaceID !== input.workspaceID) {
    return { ok: false, refusal: { reason: "unknown-group", groupID: parent.id, rootID: parent.rootID } }
  }
  const requested = validGroupTier(input.groupMaxHops)
  if (requested === undefined) {
    return {
      ok: false,
      refusal: {
        reason: "invalid-group-budget",
        groupID: parent.id,
        rootID: root.id,
        ...(typeof input.groupMaxHops === "number" ? { requested: input.groupMaxHops } : {}),
      },
    }
  }
  const commandMax = root.commandMaxHops
  const commandUsed = root.commandUsedHops
  if (commandMax === undefined || commandUsed === undefined || commandUsed >= commandMax) {
    return {
      ok: false,
      refusal: {
        reason: "command-exhausted",
        groupID: parent.id,
        rootID: root.id,
        used: commandUsed,
        max: commandMax,
      },
    }
  }
  const remaining = Math.max(0, commandMax - commandUsed)
  if (requested > remaining) {
    return {
      ok: false,
      refusal: { reason: "command-insufficient", groupID: parent.id, rootID: root.id, remaining, requested },
    }
  }
  if (parent.usedHops < parent.maxHops) {
    return {
      ok: false,
      refusal: {
        reason: "group-active",
        groupID: parent.id,
        rootID: root.id,
        used: parent.usedHops,
        max: parent.maxHops,
        remaining: Math.max(0, parent.maxHops - parent.usedHops),
      },
    }
  }
  if (parent.closedAt !== undefined) {
    return {
      ok: false,
      refusal: { reason: "group-closed", groupID: parent.id, rootID: root.id, used: parent.usedHops, max: parent.maxHops },
    }
  }
  if (parent.continuationIndex !== (root.continuationsUsed ?? 0)) {
    return {
      ok: false,
      refusal: { reason: "group-superseded", groupID: parent.id, rootID: root.id },
    }
  }
  const continuationsUsed = root.continuationsUsed ?? 0
  const maxContinuations = root.maxContinuations ?? 0
  if (continuationsUsed >= maxContinuations) {
    return {
      ok: false,
      refusal: {
        reason: "continuations-exhausted",
        groupID: parent.id,
        rootID: root.id,
        continuationsUsed,
        maxContinuations,
      },
    }
  }
  return { ok: true, root, parent, maxHops: requested }
}

/**
 * One serialized continuation mutation: increment the root continuation
 * count, seal the exhausted parent as continued, and mint the linked segment.
 * Command counters and depth caps stay on the root; the segment starts empty.
 */
export function continuationDispatchLedger(input: {
  id: Id
  root: DispatchGroup
  parent: DispatchGroup
  maxHops: number
  now?: number
}): { root: DispatchGroup; parent: DispatchGroup; group: DispatchGroup } {
  const at = input.now ?? Date.now()
  const continuationIndex = (input.root.continuationsUsed ?? 0) + 1
  const seal = { closedAt: at, closeReason: "continued" as const }
  const root: DispatchGroup = {
    ...input.root,
    continuationsUsed: continuationIndex,
    ...(input.parent.id === input.root.id ? seal : {}),
  }
  const parent: DispatchGroup = input.parent.id === input.root.id
    ? root
    : { ...input.parent, ...seal }
  const group = newContinuationDispatchGroup({
    id: input.id,
    root,
    parentID: input.parent.id,
    maxHops: input.maxHops,
    continuationIndex,
    now: at,
  })
  return { root, parent, group }
}

/** Newest active continuation for one command, if any. Pure. */
export function activeContinuationGroup(rootID: Id, groups: Record<Id, DispatchGroup>): DispatchGroup | undefined {
  let best: DispatchGroup | undefined
  for (const group of Object.values(groups)) {
    if (group.id === rootID || group.rootID !== rootID) continue
    if (dispatchGroupState(group, groups) !== "active") continue
    if (!best || group.continuationIndex > best.continuationIndex) best = group
  }
  return best
}

/**
 * Delegate target for one command: keep an active group, otherwise route to
 * the newest active continuation. An exhausted command with no continuation
 * returns the same group so the ordinary budget refusal names the stop.
 */
export function dispatchTargetGroup(group: DispatchGroup, groups: Record<Id, DispatchGroup>): DispatchGroup {
  if (dispatchGroupState(group, groups) === "active") return group
  return activeContinuationGroup(group.rootID, groups) ?? group
}

/**
 * Depth within one group segment. A parent outside the child's group starts a
 * fresh segment at 0; a same-group parent increments the stored depth.
 */
export function dispatchChildDepth(parent: Subtask | undefined, groupID: Id | undefined, subtasks: Record<Id, Subtask>): number {
  if (!parent) return 0
  const parentGroup = parent.dispatchGroupID ?? resolveDispatchGroupID(parent, subtasks)
  if (groupID && parentGroup && parentGroup !== groupID) return 0
  return dispatchDepthFor(parent, subtasks) + 1
}

/** Continuation refusal copy: names the blocking layer and the next action. */
export function continuationRefusalText(refusal: ContinuationRefusal): string {
  switch (refusal.reason) {
    case "not-leader":
      return "only the workspace leader can open a continuation group; return your result to the leader in the group chat."
    case "unknown-group":
      return "that dispatch group is not part of this workspace; check the group id and retry."
    case "invalid-group-budget":
      return refusal.requested === undefined
        ? `groupMaxHops is required with continuationOf; choose one of ${DISPATCH_GROUP_TIERS.join(", ")} hops.`
        : `groupMaxHops must be one of ${DISPATCH_GROUP_TIERS.join(", ")} hops.`
    case "command-exhausted":
      return `the command budget is exhausted (${refusal.used ?? "?"}/${refusal.max ?? "?"} hops); ask the user to start a new command for a fresh budget.`
    case "command-insufficient":
      return `the command budget has ${refusal.remaining ?? "no"} hops left, less than the requested ${refusal.requested}-hop group; ask the user to start a new command for a fresh budget.`
    case "group-active":
      return `the dispatch group still has ${refusal.remaining} of ${refusal.max} hops; dispatch into it instead of opening a continuation.`
    case "group-closed":
      return "that dispatch group is already closed; continue the newest active group or ask the user to start a new command."
    case "group-superseded":
      return "that dispatch group was already continued; continue the newest group, or ask the user to start a new command."
    case "continuations-exhausted":
      return `the continuation limit is reached (${refusal.continuationsUsed}/${refusal.maxContinuations}); ask the user to start a new command for a fresh budget.`
  }
}

/**
 * Minimum work-item shape needed to decide whether a row spends a hop. Kept
 * structural so diagnostics and the doctor can count ledger evidence without
 * constructing a full Subtask.
 */
export type DispatchHopWorkItem = {
  creatorType: "user" | "agent"
  workKind?: WorkKind
  handoff?: { completion?: boolean; batch?: boolean }
}

/**
 * True when creating this work item spends one hop: an agent-created
 * delegation or explicit handoff. User command recipients, peer turns,
 * completion handoffs, batch review, synthesis, retries, restarts, and
 * recovery never consume.
 */
export function dispatchesHop(task: DispatchHopWorkItem): boolean {
  if (task.creatorType !== "agent") return false
  if (task.workKind !== "delegation" && task.workKind !== "handoff") return false
  if (task.handoff?.completion === true) return false
  if (task.handoff?.batch === true) return false
  return true
}

/** Existing non-completion delegation and handoff count for one group. */
export function dispatchHopCount(tasks: readonly DispatchHopWorkItem[]): number {
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
 * work already in flight. Only rows that still lack a budget are filled; a
 * stored budget (including zero) is never overwritten.
 */
export function reconcileLegacyTaskBudgets(group: DispatchGroup, tasks: readonly Subtask[]): Subtask[] {
  const remaining = dispatchGroupRemaining(group)
  return tasks
    .filter((task) => task.state !== "replied" && task.taskMaxHops === undefined)
    .map((task) => ({ ...task, taskMaxHops: remaining }))
}

/* ------------------------------------------------------------------------- *
 * Ticket #161: required task budgets and hop enforcement.
 *
 * The service asks for a task budget on every delegation and handoff, stores
 * it as `taskMaxHops` on the created work item, and checks the four layers in
 * one order everywhere: task availability, group, depth, command, then the
 * per-run fan-out guard. `dispatchAdmissionRefusal` is the single ordered
 * verdict used by both the service preflight and the store's atomic admission,
 * so copy and enforcement cannot drift.
 * ------------------------------------------------------------------------- */

export type TaskBudgetValidation =
  | { ok: true; maxHops: number }
  | { ok: false; reason: string }

/**
 * Validate the required `maxHops` argument. Zero is a deliberate one-shot ask
 * (the recipient may answer and complete, but may not create new work); a
 * missing or malformed value is a validation error that teaches both. The
 * subject names the calling tool (or review item) in the error copy.
 */
export function validateTaskMaxHops(subject: string, value: unknown): TaskBudgetValidation {
  if (value === undefined || value === null) {
    return {
      ok: false,
      reason: `${subject} requires maxHops: the number of direct dispatches the recipient may make. Use maxHops: 0 for a one-shot ask (the recipient may answer but cannot create new work).`,
    }
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return {
      ok: false,
      reason: `${subject} maxHops must be a non-negative integer. Use maxHops: 0 for a one-shot ask (the recipient may answer but cannot create new work).`,
    }
  }
  return { ok: true, maxHops: value }
}

/** Unified dispatch depth: a stored value wins, legacy rows derive the parent chain. */
export function dispatchDepthFor(task: Subtask | undefined, byID: Record<Id, Subtask>): number {
  if (!task) return 0
  if (typeof task.dispatchDepth === "number" && Number.isFinite(task.dispatchDepth)) {
    return Math.max(0, Math.trunc(task.dispatchDepth))
  }
  return observedDepth(task, byID)
}

/** Direct dispatches already spent from one work item's task budget. */
export function dispatchTaskHopCount(taskID: Id, subtasks: Record<Id, Subtask>): number {
  let count = 0
  for (const task of Object.values(subtasks)) {
    if (task.parentID === taskID && dispatchesHop(task)) count++
  }
  return count
}

/** Direct child work items for the per-run fan-out guard. */
export function dispatchFanOutCount(parentID: Id, subtasks: Record<Id, Subtask>, workKind?: Subtask["workKind"]): number {
  let count = 0
  for (const task of Object.values(subtasks)) {
    if (task.parentID !== parentID) continue
    if (workKind && task.workKind !== workKind) continue
    count++
  }
  return count
}

export const DISPATCH_REFUSAL_LAYERS = ["task", "group", "closed", "depth", "command", "fanout"] as const

export type DispatchRefusalLayer = (typeof DISPATCH_REFUSAL_LAYERS)[number]

export type DispatchRefusalReason =
  | "task-exhausted"
  | "group-exhausted"
  | "group-closed"
  | "depth-exhausted"
  | "command-exhausted"
  | "fanout-exhausted"

export type DispatchRefusal = {
  layer: DispatchRefusalLayer
  used: number
  max: number
}

/** Narrow untrusted structured evidence (failure records) to a refusal layer. */
export function isDispatchRefusalLayer(value: unknown): value is DispatchRefusalLayer {
  return typeof value === "string" && (DISPATCH_REFUSAL_LAYERS as readonly string[]).includes(value)
}

/** The one mapping from a structured refusal to its stable log reason code. */
export function dispatchRefusalReasonCode(refusal: DispatchRefusal): DispatchRefusalReason {
  return refusal.layer === "closed" ? "group-closed" : `${refusal.layer}-exhausted`
}

export type DispatchBudgetState = {
  groupID: Id
  rootID: Id
  parentID?: Id
  continuationIndex: number
  groupUsed: number
  groupMax: number
  groupRemaining: number
  /** A continued parent is sealed; it admits no further work. */
  closed: boolean
  commandUsed?: number
  commandMax?: number
  commandRemaining?: number
  taskMax?: number
  taskUsed: number
  taskRemaining?: number
  /** Depth of the work item being admitted. */
  depth: number
  depthMax: number
}

/** Derive every budget layer for one prospective dispatch. */
export function dispatchBudgetState(input: {
  group: DispatchGroup
  groups: Record<Id, DispatchGroup>
  task?: Subtask
  subtasks: Record<Id, Subtask>
  nextDepth?: number
}): DispatchBudgetState {
  const { group } = input
  const root = isRootGroup(group) ? group : input.groups[group.rootID]
  const taskUsed = input.task ? dispatchTaskHopCount(input.task.id, input.subtasks) : 0
  const taskMax = input.task?.taskMaxHops
  const commandUsed = root?.commandUsedHops
  const commandMax = root?.commandMaxHops
  return {
    groupID: group.id,
    rootID: group.rootID,
    ...(group.parentID !== undefined ? { parentID: group.parentID } : {}),
    continuationIndex: group.continuationIndex,
    groupUsed: group.usedHops,
    groupMax: group.maxHops,
    groupRemaining: dispatchGroupRemaining(group),
    closed: group.closedAt !== undefined,
    ...(commandUsed !== undefined ? { commandUsed } : {}),
    ...(commandMax !== undefined ? { commandMax } : {}),
    ...(commandUsed !== undefined && commandMax !== undefined ? { commandRemaining: Math.max(0, commandMax - commandUsed) } : {}),
    ...(taskMax !== undefined ? { taskMax } : {}),
    taskUsed,
    ...(taskMax !== undefined ? { taskRemaining: Math.max(0, taskMax - taskUsed) } : {}),
    depth: input.nextDepth ?? (input.task ? dispatchDepthFor(input.task, input.subtasks) : 0),
    depthMax: group.depthMax,
  }
}

/**
 * Ordered verdict for one prospective dispatch. The order is contractual: a
 * work item at its task limit reports task budget even when the group and
 * command are also exhausted.
 */
export function dispatchAdmissionRefusal(input: {
  state: DispatchBudgetState
  maxPerRun?: number
  fanOutUsed?: number
}): DispatchRefusal | undefined {
  const { state } = input
  if (state.taskMax !== undefined && state.taskUsed >= state.taskMax) {
    return { layer: "task", used: state.taskUsed, max: state.taskMax }
  }
  if (state.closed) {
    return { layer: "closed", used: state.groupUsed, max: state.groupMax }
  }
  if (state.groupUsed >= state.groupMax) {
    return { layer: "group", used: state.groupUsed, max: state.groupMax }
  }
  if (state.depth > state.depthMax) {
    return { layer: "depth", used: state.depth, max: state.depthMax }
  }
  if (state.commandUsed !== undefined && state.commandMax !== undefined && state.commandUsed >= state.commandMax) {
    return { layer: "command", used: state.commandUsed, max: state.commandMax }
  }
  if (input.maxPerRun !== undefined && (input.fanOutUsed ?? 0) >= input.maxPerRun) {
    return { layer: "fanout", used: input.fanOutUsed ?? 0, max: input.maxPerRun }
  }
  return undefined
}

/** Refusal copy names the exhausted layer and the next action, never content. */
export function dispatchRefusalText(kind: "delegation" | "handoff", refusal: DispatchRefusal): string {
  const noun = kind === "handoff" ? "handoff" : "delegation"
  switch (refusal.layer) {
    case "task":
      return `your task budget is exhausted (${refusal.used}/${refusal.max} direct dispatches); Return your result to the leader in the group chat.`
    case "group":
      return `the dispatch group is exhausted (${refusal.used}/${refusal.max} hops); Return your result to the leader in the group chat. The leader can continue this command in a new group while the command budget allows.`
    case "closed":
      return "the dispatch group is closed; Return your result to the leader in the group chat. The leader can continue the newest group in this command."
    case "depth":
      return `the dispatch depth limit is ${refusal.max} (next depth ${refusal.used}); Return your result to the leader in the group chat.`
    case "command":
      return `the command budget is exhausted (${refusal.used}/${refusal.max} hops); Ask the user to start a new command.`
    case "fanout":
      return `the ${noun} limit is ${refusal.max} per run; Return your result to the leader in the group chat.`
  }
}

/** Compact successful-result line: what the sender has left after the hop. */
export function dispatchBudgetLine(state: DispatchBudgetState): string {
  const task = state.taskMax === undefined || state.taskRemaining === undefined
    ? "task unlimited"
    : `task ${state.taskRemaining} of ${state.taskMax} dispatches`
  const group = `group ${state.groupRemaining} of ${state.groupMax} hops`
  const command = state.commandRemaining === undefined || state.commandMax === undefined
    ? "command not tracked"
    : `command ${state.commandRemaining} of ${state.commandMax} hops`
  return `Remaining — ${task}, ${group}, ${command}, depth ${state.depth} of ${state.depthMax}. You cannot raise these ceilings.`
}

/** Structured turn-context block. IDs and counts only; never task content. */
export function dispatchBudgetContext(state: DispatchBudgetState, task?: Pick<Subtask, "id">): string {
  const taskID = task ? ` task_id="${task.id}"` : ""
  return [
    `<ensemble_dispatch_budget group="${state.groupID}" root="${state.rootID}" parent="${state.parentID ?? ""}" continuation="${state.continuationIndex}"${taskID} group_used="${state.groupUsed}" group_max="${state.groupMax}" group_remaining="${state.groupRemaining}" command_used="${state.commandUsed ?? ""}" command_max="${state.commandMax ?? ""}" command_remaining="${state.commandRemaining ?? ""}" task_used="${state.taskUsed}" task_max="${state.taskMax ?? ""}" task_remaining="${state.taskRemaining ?? ""}" depth="${state.depth}" depth_max="${state.depthMax}">`,
    `Dispatch budget — group ${state.groupUsed}/${state.groupMax} (${state.groupRemaining} left), command ${state.commandUsed ?? "?"}/${state.commandMax ?? "?"}${state.commandRemaining !== undefined ? ` (${state.commandRemaining} left)` : ""}, task ${state.taskMax !== undefined ? `${state.taskUsed}/${state.taskMax} (${state.taskRemaining} left)` : `${state.taskUsed} used (unlimited)`}, depth ${state.depth}/${state.depthMax}.`,
    "Every ensemble_delegate and ensemble_handoff call requires maxHops: the number of direct dispatches the recipient may make. Use maxHops: 0 for a one-shot ask. Completion handoffs, batch review, synthesis, group-chat peer turns, retries, restarts, recovery, and idempotent replays do not consume hops; cancellation does not refund them. You cannot raise these ceilings; when a budget is exhausted, return your result to the leader. The workspace leader may open a linked continuation group with ensemble_delegate's continuationOf plus a required groupMaxHops tier; when the command or continuation cap is reached, ask the user to start a new command.",
    "</ensemble_dispatch_budget>",
  ].join("\n")
}
