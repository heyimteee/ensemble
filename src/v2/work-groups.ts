import { deriveWorkStatus, isTerminalWorkStatus } from "./queue.ts"
import { resolveDispatchGroupID } from "./dispatch-group.ts"
import type { Subtask } from "./types.ts"

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
  if (task.interrupted) return true
  if (task.approvalID && pendingApprovalIDs.has(task.approvalID)) return true
  if (nativeBlockedSubtaskIDs.has(task.id)) return true
  return false
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
  /** Latest terminal timestamp across members, the shared hold origin. */
  latestTerminalAt?: number
  /** Oldest member creation time; the group's chronological position. */
  createdAt: number
}

export type WorkGroupOptions = {
  now: number
  pendingApprovalIDs?: ReadonlySet<string>
  nativeBlockedSubtaskIDs?: ReadonlySet<string>
  holdMs?: number
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

/** Group visibility needs-you: terminal work counts only while a decision is still pending. */
function memberNeedsYou(
  task: Subtask,
  status: ReturnType<typeof deriveWorkStatus>,
  pendingApprovalIDs: ReadonlySet<string>,
  nativeBlockedSubtaskIDs: ReadonlySet<string>,
): boolean {
  if (isTerminalWorkStatus(status)) {
    return terminalNeedsYou(task, pendingApprovalIDs, nativeBlockedSubtaskIDs)
  }
  return isNeedsYouTask(task, pendingApprovalIDs, nativeBlockedSubtaskIDs)
}

/** Active members first (working/retrying, then queued), terminal members by finish time. */
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
      if (isTerminalWorkStatus(status)) {
        done++
        const finished = workFinishedAt(task)
        if (finished !== undefined && (latestTerminalAt === undefined || finished > latestTerminalAt)) latestTerminalAt = finished
      } else {
        active++
      }
      if (memberNeedsYou(task, status, pendingApprovalIDs, nativeBlockedSubtaskIDs)) needsYou = true
    }
    const complete = active === 0 && !needsYou
    const holding =
      complete &&
      latestTerminalAt !== undefined &&
      now < latestTerminalAt + Math.max(0, holdMs)
    if (active === 0 && !needsYou && !holding) continue
    groups.push({
      id,
      tasks: ordered,
      active,
      done,
      needsYou,
      complete,
      latestTerminalAt,
      createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    })
  }
  return groups.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

/**
 * Ticket #142: the earliest wall-clock instant at which derived Work data can
 * change without a durable update. The app schedules one timer for it instead
 * of letting the animation clocks rebuild static cards. A task deadline wins
 * at `deadlineAt`; a working lease stops at `leaseUntil`; a complete group
 * closes after its shared hold. Pure.
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
    if (isTerminalWorkStatus(deriveWorkStatus(task, now))) continue
    if (task.deadlineAt !== undefined) consider(task.deadlineAt)
    if (task.claimedBy && task.leaseUntil !== undefined) consider(task.leaseUntil)
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

/** The Work header names groups, active work, and terminal work; "recent" is gone. */
export function workSummaryCounts(groupCount: number, activeCount: number, doneCount: number): string {
  const groups = Math.max(0, Math.floor(groupCount))
  const active = Math.max(0, Math.floor(activeCount))
  const done = Math.max(0, Math.floor(doneCount))
  if (groups === 0 && active === 0 && done === 0) return "WORK │ none yet"
  return `WORK ${groups} ${groups === 1 ? "group" : "groups"} · ${active} active · ${done} done`
}

/** A subtle label shown only when more than one group is visible. */
export function workGroupLabel(group: Pick<WorkGroup, "active" | "done">, ordinal: number): string {
  return `GROUP ${Math.max(1, Math.floor(ordinal))} · ${group.active} active · ${group.done} done`
}
