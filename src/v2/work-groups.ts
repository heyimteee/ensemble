import { deriveWorkStatus, isTerminalWorkStatus, workNeedsYou } from "./queue.ts"
import { dispatchBudgetSummary, dispatchGroupExhausted, dispatchGroupState, type DispatchBudgetSummary, type DispatchGroupState } from "./dispatch-budget.ts"
import { resolveDispatchGroupID } from "./dispatch-group.ts"
import type { Approval, DispatchCloseReason, DispatchGroup, Id, NativeSubagentRun, Subtask } from "./types.ts"

/**
 * Ticket #136 dispatch-group Work lifecycle, shared by the TUI pane #141's
 * server-side Work projection.
 *
 * A dispatch group is the set of Subtasks caused by one dispatch action
 * (ticket #135). Every member remains visible while any member is
 * non-terminal or needs the user; a fully terminal group clears as one unit
 * after a shared 1.2 s hold derived from its latest terminal timestamp. A
 * needs-you member never starts that hold.
 *
 * All helpers are pure over tasks, the subtask record (for legacy group
 * resolution), and the caller's clock. Layout stays in the TUI.
 */

/** A complete dispatch group stays mounted for this long after its latest terminal task. */
export const WORK_GROUP_HOLD_MS = 1_200

/** The honest finish time for a terminal task, or undefined when none was recorded. */
export function workFinishedAt(task: Subtask): number | undefined {
  return task.finishedAt ?? task.repliedAt ?? task.stoppedAt
}

export function isNeedsYouTask(
  task: Subtask,
  pendingApprovalIDs: ReadonlySet<string>,
  nativeBlockedSubtaskIDs: ReadonlySet<string> = new Set(),
): boolean {
  return workNeedsYou(task, pendingApprovalIDs, nativeBlockedSubtaskIDs)
}

export type WorkGroup = {
  id: string
  /** Display order: active members first, then terminal members in finish order. */
  tasks: Subtask[]
  /** Non-terminal member count. */
  active: number
  /** Terminal member count. */
  done: number
  /** A member still waits on the user, which overrides the completion hold. */
  needsYou: boolean
  /** Every member is terminal and none needs the user. */
  complete: boolean
  /** Latest terminal or approval-resolution timestamp, the shared hold origin. */
  latestTerminalAt?: number
  /** Oldest member creation time; the group's chronological position. */
  createdAt: number
  /** Ticket #160: used/max hops plus command remaining, when a ledger exists. */
  budget?: DispatchBudgetSummary
  /** Ticket #162: root command group for continuation lineage. */
  rootID?: string
  /** Ticket #162: parent group of a continuation segment. */
  parentID?: string
  /** Ticket #162: 0 for a root group, 1..N for continuations. */
  continuationIndex?: number
  /** Ticket #162: continuation index of the parent, for the Work lineage label. */
  parentContinuationIndex?: number
  /** Ticket #162: derived active/exhausted/closed state. */
  state?: DispatchGroupState
  /** Ticket #162: hop counters spent, even when the group has since closed. */
  exhausted?: boolean
  /** Ticket #162: controlled-stop reason. */
  closeReason?: DispatchCloseReason
  /**
   * Ticket #187: native subagent child sessions rendered as Work cards under
   * this parent dispatch group. They are never Subtasks and never enter the
   * queue; the group's active/done counts include them.
   */
  native?: NativeSubagentRun[]
}

export type WorkGroupOptions = {
  now: number
  pendingApprovalIDs?: ReadonlySet<string>
  nativeBlockedSubtaskIDs?: ReadonlySet<string>
  holdMs?: number
  /** Latest approval resolution time for a member, so the hold starts after the last decision. */
  resolvedAtForTask?: (task: Subtask) => number | undefined
  /** Ticket #160: the dispatch ledger keyed by group id. */
  dispatchGroups?: Record<Id, DispatchGroup>
}

const NO_IDS: ReadonlySet<string> = new Set<string>()

function terminalNeedsYou(
  task: Subtask,
  pendingApprovalIDs: ReadonlySet<string>,
  nativeBlockedSubtaskIDs: ReadonlySet<string>,
): boolean {
  if (task.approvalID && pendingApprovalIDs.has(task.approvalID)) return true
  return nativeBlockedSubtaskIDs.has(task.id)
}

/** One needs-you rule for live and terminal work: a pending decision outranks terminal state. */
export function taskNeedsYou(
  task: Subtask,
  terminal: boolean,
  pendingApprovalIDs: ReadonlySet<string>,
  nativeBlockedSubtaskIDs: ReadonlySet<string> = NO_IDS,
): boolean {
  if (terminal) return terminalNeedsYou(task, pendingApprovalIDs, nativeBlockedSubtaskIDs)
  return isNeedsYouTask(task, pendingApprovalIDs, nativeBlockedSubtaskIDs)
}

/**
 * The latest resolution time linked to each task, from a direct approval or a
 * native permission mirror. A resolved decision starts a fresh completion hold
 * instead of letting a long-blocked task clear the instant it resolves.
 */
export function approvalResolutionAt(
  approvals: Record<Id, Approval>,
): (task: Subtask) => number | undefined {
  const byApproval = new Map<Id, number>()
  const bySubtask = new Map<Id, number>()
  for (const approval of Object.values(approvals)) {
    if (approval.resolvedAt === undefined) continue
    byApproval.set(approval.id, approval.resolvedAt)
    if (approval.subtaskID) {
      const previous = bySubtask.get(approval.subtaskID)
      if (previous === undefined || approval.resolvedAt > previous) bySubtask.set(approval.subtaskID, approval.resolvedAt)
    }
  }
  return (task) => {
    const direct = task.approvalID ? byApproval.get(task.approvalID) : undefined
    const native = bySubtask.get(task.id)
    if (direct === undefined) return native
    if (native === undefined) return direct
    return Math.max(direct, native)
  }
}

/** Active members first (working/retrying/waiting/needs-you/stalled, then queued), terminal members by finish time. */
export function orderedGroupTasks(tasks: Subtask[], now: number): Subtask[] {
  const statusOf = (task: Subtask) => deriveWorkStatus(task, now)
  const active = tasks
    .filter((task) => !isTerminalWorkStatus(statusOf(task)))
    .sort((a, b) => {
      const rank = (task: Subtask) => (statusOf(task) === "pending" ? 1 : 0)
      return rank(a) - rank(b) || a.createdAt - b.createdAt || a.id.localeCompare(b.id)
    })
  const terminal = tasks
    .filter((task) => isTerminalWorkStatus(statusOf(task)))
    .sort(
      (a, b) =>
        (workFinishedAt(a) ?? 0) - (workFinishedAt(b) ?? 0) || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
    )
  return [...active, ...terminal]
}

/**
 * Visible dispatch groups, oldest command first. A group stays while any
 * member is non-terminal, any member needs the user, or its complete hold has
 * not elapsed. Legacy rows resolve through their root ancestor, so in-flight
 * work survives the upgrade without a stored group id.
 */
export function workGroupsForTasks(
  tasks: Subtask[],
  subtasks: Record<string, Subtask>,
  options: WorkGroupOptions,
): WorkGroup[] {
  return collectWorkGroups(tasks, subtasks, options, false)
}

/**
 * Ticket #172: every dispatch group, including terminal groups whose completion
 * hold has elapsed. The Work pane keeps finished groups in HISTORY instead of
 * discarding them; visibility filtering belongs to the view, not the grouping.
 */
export function allWorkGroupsForTasks(
  tasks: Subtask[],
  subtasks: Record<string, Subtask>,
  options: WorkGroupOptions,
): WorkGroup[] {
  return collectWorkGroups(tasks, subtasks, options, true)
}

function collectWorkGroups(
  tasks: Subtask[],
  subtasks: Record<string, Subtask>,
  options: WorkGroupOptions,
  includeComplete: boolean,
): WorkGroup[] {
  const now = options.now
  const pendingApprovalIDs = options.pendingApprovalIDs ?? NO_IDS
  const nativeBlockedSubtaskIDs = options.nativeBlockedSubtaskIDs ?? NO_IDS
  const holdMs = options.holdMs ?? WORK_GROUP_HOLD_MS
  const byGroup = new Map<string, Subtask[]>()
  for (const task of tasks) {
    const id = resolveDispatchGroupID(task, subtasks)
    if (!id) continue
    const bucket = byGroup.get(id)
    if (bucket) bucket.push(task)
    else byGroup.set(id, [task])
  }
  const groups: WorkGroup[] = []
  for (const [id, members] of byGroup) {
    const ordered = orderedGroupTasks(members, now)
    let active = 0
    let done = 0
    let needsYou = false
    let latestTerminalAt: number | undefined
    let createdAt = Number.POSITIVE_INFINITY
    for (const task of ordered) {
      createdAt = Math.min(createdAt, task.createdAt)
      const status = deriveWorkStatus(task, now)
      const terminal = isTerminalWorkStatus(status)
      if (terminal) {
        done++
        const finished = workFinishedAt(task)
        const resolved = options.resolvedAtForTask?.(task)
        const origin = finished === undefined
          ? resolved
          : resolved !== undefined && resolved > finished ? resolved : finished
        if (origin !== undefined && (latestTerminalAt === undefined || origin > latestTerminalAt)) latestTerminalAt = origin
      } else {
        active++
      }
      if (taskNeedsYou(task, terminal, pendingApprovalIDs, nativeBlockedSubtaskIDs)) needsYou = true
    }
    const complete = active === 0 && !needsYou
    const holding =
      complete &&
      latestTerminalAt !== undefined &&
      now < latestTerminalAt + Math.max(0, holdMs)
    if (!includeComplete && active === 0 && !needsYou && !holding) continue
    const ledger = options.dispatchGroups?.[id]
    const parentLedger = ledger?.parentID ? options.dispatchGroups?.[ledger.parentID] : undefined
    groups.push({
      id,
      tasks: ordered,
      active,
      done,
      needsYou,
      complete,
      latestTerminalAt,
      createdAt: Number.isFinite(createdAt) ? createdAt : 0,
      ...(ledger && options.dispatchGroups
        ? {
            budget: dispatchBudgetSummary(ledger, options.dispatchGroups),
            rootID: ledger.rootID,
            parentID: ledger.parentID,
            continuationIndex: ledger.continuationIndex,
            ...(parentLedger ? { parentContinuationIndex: parentLedger.continuationIndex } : {}),
            state: dispatchGroupState(ledger, options.dispatchGroups),
            exhausted: dispatchGroupExhausted(ledger, options.dispatchGroups),
            closeReason: ledger.closeReason,
          }
        : {}),
    })
  }
  return groups.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

/**
 * Ticket #142: the earliest wall-clock instant at which derived Work data can
 * change without a durable update. The app schedules one timer for it instead
 * of letting the animation clocks rebuild static cards. A task deadline wins
 * at `deadlineAt`; a working lease stops at `leaseUntil`; a delivery hold
 * wakes once at `deliveryHoldUntil`; a complete group closes after its shared
 * hold. Pure.
 */
export function nextWorkInvalidation(
  tasks: ReadonlyArray<Subtask>,
  groups: ReadonlyArray<Pick<WorkGroup, "complete" | "latestTerminalAt">>,
  now: number,
  holdMs: number = WORK_GROUP_HOLD_MS,
): number | undefined {
  let next: number | undefined
  const consider = (time: number) => {
    if (!Number.isFinite(time) || time <= now) return
    if (next === undefined || time < next) next = time
  }
  for (const task of tasks) {
    const status = deriveWorkStatus(task, now)
    if (isTerminalWorkStatus(status)) continue
    if (task.deadlineAt !== undefined) consider(task.deadlineAt)
    if (task.claimedBy && task.leaseUntil !== undefined) consider(task.leaseUntil)
    // A retry countdown changes every second even when no durable update
    // arrives. Schedule the next second boundary, or the retry instant when it
    // comes first; a due retry refreshes until the scheduler claims it.
    if (task.retryAfter !== undefined) {
      consider(status === "retrying"
        ? (task.retryAfter > now ? Math.min(task.retryAfter, now + 1_000) : now + 1_000)
        : task.retryAfter)
    }
    // A delivery hold shows no countdown; one wake-up at its claim time is
    // enough (ticket #193). Never schedule per-card polling for it.
    if (task.deliveryHoldUntil !== undefined) consider(task.deliveryHoldUntil)
  }
  for (const group of groups) {
    if (!group.complete || group.latestTerminalAt === undefined) continue
    consider(group.latestTerminalAt + Math.max(0, holdMs))
  }
  return next
}

export function workGroupCounts(groups: ReadonlyArray<Pick<WorkGroup, "active" | "done">>): {
  groups: number
  active: number
  done: number
} {
  return {
    groups: groups.length,
    active: groups.reduce((total, group) => total + group.active, 0),
    done: groups.reduce((total, group) => total + group.done, 0),
  }
}
