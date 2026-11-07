import { deriveWorkStatus, isTerminalWorkStatus } from "../queue.ts"
import { resolveDispatchGroupID } from "../dispatch-group.ts"
import type { Subtask } from "../types.ts"
import {
  WORK_BASE_ROWS,
  WORK_BLOCK_CHROME_ROWS,
  WORK_CARD_GAP_COLS,
  WORK_CARD_GAP_ROWS,
  WORK_CARD_MIN_WIDTH,
  WORK_CARD_ROWS,
  WORK_TRANSCRIPT_RESERVE,
  isNeedsYouTask,
} from "./workrows.ts"
import { WORK_GROUP_HOLD_MS } from "./work-constants.ts"

/**
 * Ticket #136: dispatch-group Work lifecycle and layout.
 *
 * A dispatch group is the set of Subtasks caused by one dispatch action
 * (ticket #135). The Work pane renders one group per command instead of a
 * mixture of active cards and per-task recent cards. Every member remains
 * visible while any member is non-terminal or needs the user; a fully
 * terminal group clears as one unit after a shared 1.2 s hold derived from
 * its latest terminal timestamp. A needs-you member never starts that hold.
 *
 * All helpers here are pure over tasks, the subtask record (for legacy group
 * resolution), and the caller's clock. Layout is newest-group-first while
 * rendering stays chronological, so a large old batch cannot hide a new
 * command when height is constrained.
 */

/** Two card groups fit one card row each; older groups become compact group rows. */
export const WORK_MAX_CARD_GROUPS = 2

/** The honest finish time for a terminal task, or undefined when none was recorded. */
export function workFinishedAt(task: Subtask): number | undefined {
  return task.finishedAt ?? task.repliedAt ?? task.stoppedAt
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

export type WorkGroupSectionMode = "cards" | "rows" | "summary"

export type WorkGroupSection = {
  groupID: string
  /** Null for a single visible group; group labels appear only when there are several. */
  label: string | null
  mode: WorkGroupSectionMode
  /** Tasks represented individually on this render (cards or compact rows). */
  tasks: Subtask[]
  /** Tasks this group owns that are not represented individually here. */
  overflow: number
  /** Rows this section consumes, including its label and overflow line. */
  height: number
}

export type WorkGroupLayout = {
  mode: "cards" | "compact"
  /** Card columns in the grid. Zero in compact mode. */
  columns: number
  /** Outer card width, including border and padding. Zero in compact mode. */
  cardWidth: number
  /** Content width available to title/detail/tide after border, accent, and padding. */
  cardContentWidth: number
  /** Chronological sections; capacity was allocated newest-group first. */
  sections: WorkGroupSection[]
  /** Visible non-terminal tasks in display order: the only cursor/action targets. */
  selectableTasks: Subtask[]
  /** Number of selectable tasks (visible, non-terminal, not overflow). */
  limit: number
  /** Tasks hidden from individually shown groups. */
  overflow: number
  /** Older groups omitted entirely by the height budget. */
  hiddenGroups: number
  /** Rows the Work block consumes, including its header. */
  height: number
}

function gridColumns(contentWidth: number): number {
  const fit = Math.floor(
    (Math.max(0, Math.floor(contentWidth)) + WORK_CARD_GAP_COLS) /
      (WORK_CARD_MIN_WIDTH + WORK_CARD_GAP_COLS),
  )
  return Math.max(1, Math.min(3, fit))
}

function compactTaskLimit(terminalHeight: number): number {
  return terminalHeight >= 27 ? 2 : 1
}

function selectable(sections: ReadonlyArray<Pick<WorkGroupSection, "mode" | "tasks">>, now: number): Subtask[] {
  return sections.flatMap((section) =>
    section.mode === "summary"
      ? []
      : section.tasks.filter((task) => !isTerminalWorkStatus(deriveWorkStatus(task, now))),
  )
}

function emptyLayout(): WorkGroupLayout {
  return {
    mode: "compact",
    columns: 0,
    cardWidth: 0,
    cardContentWidth: 0,
    sections: [],
    selectableTasks: [],
    limit: 0,
    overflow: 0,
    hiddenGroups: 0,
    height: 1,
  }
}

function cardSection(
  group: WorkGroup,
  ordinal: number,
  columns: number,
  showLabel: boolean,
): WorkGroupSection {
  const tasks = group.tasks.slice(0, columns)
  const overflow = group.tasks.length - tasks.length
  return {
    groupID: group.id,
    label: showLabel ? workGroupLabel(group, ordinal) : null,
    mode: "cards",
    tasks,
    overflow,
    height: (showLabel ? 1 : 0) + WORK_CARD_ROWS + (overflow > 0 ? 1 : 0),
  }
}

function summarySection(group: WorkGroup, ordinal: number): WorkGroupSection {
  return {
    groupID: group.id,
    label: workGroupLabel(group, ordinal),
    mode: "summary",
    tasks: [],
    overflow: 0,
    height: 1,
  }
}

function compactRowsSection(group: WorkGroup, ordinal: number, rows: number, showLabel: boolean): WorkGroupSection {
  const tasks = group.tasks.slice(0, rows)
  const overflow = group.tasks.length - tasks.length
  return {
    groupID: group.id,
    label: showLabel ? workGroupLabel(group, ordinal) : null,
    mode: "rows",
    tasks,
    overflow: group.complete ? 0 : overflow,
    height: (showLabel ? 1 : 0) + tasks.length,
  }
}

/**
 * Compact fallback. Complete hold groups summarize by count and never spend
 * task rows; the newest incomplete groups receive the available task rows
 * first, while older groups keep a labeled summary row when the budget allows.
 * Sections stay chronological, so the newest work still sits nearest the
 * composer.
 */
function compactLayout(
  groups: WorkGroup[],
  contentWidth: number,
  terminalHeight: number,
  now: number,
): WorkGroupLayout {
  if (groups.length === 0) return emptyLayout()
  const multi = groups.length > 1
  const available = Math.max(0, terminalHeight - WORK_BASE_ROWS)
  const contentBudget = Math.max(0, available - WORK_TRANSCRIPT_RESERVE - 1)
  const taskBudget = compactTaskLimit(terminalHeight)
  const chosen = new Map<number, number>()
  let remaining = contentBudget
  let remainingTasks = taskBudget
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index]
    const labelCost = multi ? 1 : 0
    let rows = 0
    if (!group.complete && remainingTasks > 0) rows = Math.min(remainingTasks, group.tasks.length)
    let cost = labelCost + rows
    if (cost > remaining) {
      rows = Math.max(0, remaining - labelCost)
      cost = labelCost + rows
    }
    if (cost > remaining) break
    if (labelCost === 0 && rows === 0) break
    chosen.set(index, rows)
    remaining -= cost
    remainingTasks -= rows
  }
  const sections: WorkGroupSection[] = []
  for (let index = 0; index < groups.length; index++) {
    if (!chosen.has(index)) continue
    const group = groups[index]
    const rows = chosen.get(index) ?? 0
    sections.push(
      rows > 0
        ? compactRowsSection(group, index + 1, rows, multi)
        : summarySection(group, index + 1),
    )
  }
  const visible = selectable(sections, now)
  return {
    mode: "compact",
    columns: 0,
    cardWidth: 0,
    cardContentWidth: Math.max(12, Math.floor(contentWidth) - 5),
    sections,
    selectableTasks: visible,
    limit: visible.length,
    overflow: sections.reduce((total, section) => total + section.overflow, 0),
    hiddenGroups: multi ? groups.length - chosen.size : 0,
    height: 1 + sections.reduce((total, section) => total + section.height, 0),
  }
}

/**
 * Card layout. At most two groups receive one card row each (newest first);
 * remaining budget goes to compact summary rows, also newest first. If even
 * the newest card row cannot fit, the pane falls back to compact rows.
 * Sections render chronologically regardless of where capacity was spent.
 */
export function workGroupLayout(
  groups: WorkGroup[],
  contentWidth: number,
  terminalHeight: number,
  now: number = Date.now(),
): WorkGroupLayout {
  if (groups.length === 0) return emptyLayout()
  const width = Math.max(0, Math.floor(contentWidth))
  const columns = gridColumns(width)
  if (columns < 2) return compactLayout(groups, contentWidth, terminalHeight, now)

  const multi = groups.length > 1
  const budget = Math.max(0, terminalHeight - WORK_BASE_ROWS - WORK_TRANSCRIPT_RESERVE)
  const cardCost = (index: number) =>
    (multi ? 1 : 0) + WORK_CARD_ROWS + (groups[index].tasks.length > columns ? 1 : 0)
  const newestFirst = [...groups.keys()].reverse()

  for (let count = Math.min(WORK_MAX_CARD_GROUPS, groups.length); count >= 1; count--) {
    const cardIndices = newestFirst.slice(0, count)
    const fixed = WORK_BLOCK_CHROME_ROWS +
      cardIndices.reduce((total, index) => total + cardCost(index), 0) +
      Math.max(0, count - 1) * WORK_CARD_GAP_ROWS
    if (fixed > budget) continue
    const summaryIndices = new Set<number>()
    let remaining = budget - fixed
    for (const index of newestFirst.slice(count)) {
      if (remaining <= 0) break
      summaryIndices.add(index)
      remaining--
    }
    const cardSet = new Set(cardIndices)
    const sections: WorkGroupSection[] = []
    for (let index = 0; index < groups.length; index++) {
      if (cardSet.has(index)) sections.push(cardSection(groups[index], index + 1, columns, multi))
      else if (summaryIndices.has(index)) sections.push(summarySection(groups[index], index + 1))
    }
    const cardCount = cardIndices.length
    const height =
      WORK_BLOCK_CHROME_ROWS +
      sections.reduce((total, section) => total + section.height, 0) +
      Math.max(0, cardCount - 1) * WORK_CARD_GAP_ROWS
    const selectableTasks = selectable(sections, now)
    const cardWidth = Math.floor((width - WORK_CARD_GAP_COLS * (columns - 1)) / columns)
    return {
      mode: "cards",
      columns,
      cardWidth,
      cardContentWidth: Math.max(12, cardWidth - 5),
      sections,
      selectableTasks,
      limit: selectableTasks.length,
      overflow: sections.reduce((total, section) => total + section.overflow, 0),
      hiddenGroups: groups.length - cardIndices.length - summaryIndices.size,
      height,
    }
  }
  return compactLayout(groups, contentWidth, terminalHeight, now)
}
