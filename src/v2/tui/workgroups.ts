import { dispatchBudgetLabel, dispatchGroupContinued } from "../dispatch-budget.ts"
import { deriveWorkStatus, isTerminalWorkStatus } from "../queue.ts"
import type { Subtask } from "../types.ts"
import {
  WORK_BASE_ROWS,
  WORK_BLOCK_CHROME_ROWS,
  WORK_CARD_GAP_COLS,
  WORK_CARD_GAP_ROWS,
  WORK_CARD_MIN_WIDTH,
  WORK_CARD_ROWS,
  WORK_TRANSCRIPT_RESERVE,
} from "./workrows.ts"
import { type WorkGroup } from "../work-groups.ts"

/**
 * Ticket #136: dispatch-group Work layout. Group membership, visibility, and
 * the shared completion hold are shared domain logic in `../work-groups.ts`
 * (also used by the #141 server-side Work projection); this module owns only
 * the card/compact layout over the visible groups.
 *
 * Layout is newest-group-first while rendering stays chronological, so a
 * large old batch cannot hide a new command when height is constrained.
 */

export {
  nextWorkInvalidation,
  orderedGroupTasks,
  workFinishedAt,
  workGroupCounts,
  workGroupsForTasks,
} from "../work-groups.ts"
export type { WorkGroup, WorkGroupOptions } from "../work-groups.ts"

/** The Work header names groups, active work, terminal work, and controlled stops. */
export function workSummaryCounts(groupCount: number, activeCount: number, doneCount: number, exhaustedCount = 0): string {
  const groups = Math.max(0, Math.floor(groupCount))
  const active = Math.max(0, Math.floor(activeCount))
  const done = Math.max(0, Math.floor(doneCount))
  const exhausted = Math.max(0, Math.floor(exhaustedCount))
  if (groups === 0 && active === 0 && done === 0) return "WORK │ none yet"
  const base = `WORK ${groups} ${groups === 1 ? "group" : "groups"} · ${active} active · ${done} done`
  return exhausted > 0 ? `${base} · ${exhausted} exhausted` : base
}

/**
 * A subtle label shown only when more than one group is visible. Ticket #160
 * adds the ledger budget; ticket #162 adds continuation lineage and the
 * exhausted/continued controlled-stop words. The renderer truncates the line,
 * and the status counts stay after it so a narrow width still names the
 * group's work.
 */
export function workGroupLabel(
  group: Pick<WorkGroup, "active" | "done" | "budget" | "continuationIndex" | "parentContinuationIndex" | "exhausted" | "closeReason">,
  ordinal: number,
): string {
  const parts = [`GROUP ${Math.max(1, Math.floor(ordinal))}`]
  const continuation = group.continuationIndex ?? 0
  if (continuation > 0) {
    parts.push(`CONT ${continuation}`)
    if (group.parentContinuationIndex !== undefined) {
      parts.push(`from ${group.parentContinuationIndex === 0 ? "root" : `CONT ${group.parentContinuationIndex}`}`)
    }
  }
  if (group.exhausted) parts.push("EXHAUSTED")
  if (dispatchGroupContinued(group)) parts.push("CONTINUED")
  if (group.budget) parts.push(dispatchBudgetLabel(group.budget, "full"))
  parts.push(`${group.active} active`, `${group.done} done`)
  return parts.join(" · ")
}

/** Two card groups fit one card row each; older groups become compact group rows. */
export const WORK_MAX_CARD_GROUPS = 2

export type WorkGroupSectionMode = "cards" | "rows" | "summary"

export type WorkGroupSection = {
  groupID: string
  /** Null for a single visible group; group labels appear only when there are several. */
  label: string | null
  /** Ticket #162: controlled-stop sections use the warning tone, not error. */
  tone: "faint" | "warn"
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

function sectionTone(group: WorkGroup): "faint" | "warn" {
  return group.exhausted || group.state === "closed" ? "warn" : "faint"
}

/** A lineage or controlled-stop group always names itself, even when alone. */
function showGroupLabel(group: WorkGroup, multi: boolean): boolean {
  return multi || (group.continuationIndex ?? 0) > 0 || group.exhausted === true || dispatchGroupContinued(group)
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
    tone: sectionTone(group),
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
    tone: sectionTone(group),
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
    tone: sectionTone(group),
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
    const labelCost = showGroupLabel(group, multi) ? 1 : 0
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
        ? compactRowsSection(group, index + 1, rows, showGroupLabel(group, multi))
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
      if (cardSet.has(index)) sections.push(cardSection(groups[index], index + 1, columns, showGroupLabel(groups[index], multi)))
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
