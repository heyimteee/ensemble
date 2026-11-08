import { deriveWorkStatus, isTerminalWorkStatus } from "../queue.ts"
import { allWorkGroupsForTasks, workFinishedAt, type WorkGroup, type WorkGroupOptions } from "../work-groups.ts"
import type { Subtask } from "../types.ts"
import { WORK_CARD_GAP_COLS, WORK_CARD_HORIZONTAL_CHROME, WORK_CARD_MIN_WIDTH, WORK_CARD_ROWS, workCardContentWidth } from "./workrows.ts"
import { workGroupLabel } from "./workgroups.ts"

/**
 * Ticket #172: one responsive shell model for the three-pane workspace.
 *
 * The rail keeps its ticket #171 width; the chat takes the remainder; the
 * Work pane gets a readable share on the right. Below 96 terminal columns the
 * Work pane becomes a right drawer that overlays the chat, so the chat never
 * becomes unusably narrow. Every consumer (transcript width, Work layout,
 * hit-testing, and the size tests) reads these numbers from one pure function.
 */

export type ShellPaneMode = "three" | "compact" | "drawer"

/** Gap between panes in the root row, in terminal cells. */
export const SHELL_PANE_GAP = 1

/** Root horizontal padding: one cell on each side. */
export const SHELL_VIEW_INSET = 2

/** Work outer border (2) plus its left/right padding (2). */
export const WORK_PANE_HORIZONTAL_CHROME = 4

/**
 * Work pane rows outside the scrollable body: root padding and gaps, the app
 * header, the statusline, the pane border, the pane header, and the pager.
 */
export const WORK_PANE_BODY_CHROME_ROWS = 14

export type ShellPaneWidths = {
  mode: ShellPaneMode
  /** Full terminal width. */
  terminalWidth: number
  /** Width inside the root's horizontal padding. */
  viewWidth: number
  gap: number
  railWidth: number
  chatWidth: number
  /** Drawer width when `mode === "drawer"`; the right pane width otherwise. */
  workWidth: number
  /** Work outer chrome consumed by the border and horizontal padding. */
  workChrome: number
  /** Work content width inside its border and padding. */
  workContentWidth: number
  /** Conservative transcript text width while the Work pane shares the row. */
  chatContentWidth: number
  /** Transcript text width when Work is absent (a DM or the closed drawer). */
  chatOnlyContentWidth: number
}

function clamp(minimum: number, maximum: number, value: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

/**
 * Ticket #172 breakpoints:
 * - >= 118 columns: three stable panes (`three`).
 * - 96..117 columns: three panes with compact Work (`compact`).
 * - < 96 columns: Work is a toggleable right drawer (`drawer`).
 */
export function workspacePaneWidths(terminalWidth: number): ShellPaneWidths {
  const terminal = Math.max(60, Math.floor(terminalWidth))
  const viewWidth = terminal - SHELL_VIEW_INSET
  const railWidth = clamp(26, 34, Math.floor(viewWidth * 0.26))
  const mode: ShellPaneMode = terminal >= 118 ? "three" : terminal >= 96 ? "compact" : "drawer"
  const workChrome = WORK_PANE_HORIZONTAL_CHROME
  if (mode === "drawer") {
    const chatWidth = viewWidth - railWidth - SHELL_PANE_GAP
    const workWidth = clamp(30, 48, Math.floor(viewWidth * 0.6))
    return {
      mode,
      terminalWidth: terminal,
      viewWidth,
      gap: SHELL_PANE_GAP,
      railWidth,
      chatWidth,
      workWidth,
      workChrome,
      workContentWidth: Math.max(WORK_CARD_MIN_WIDTH - WORK_CARD_HORIZONTAL_CHROME, workWidth - workChrome),
      chatContentWidth: Math.max(20, chatWidth - 9),
      chatOnlyContentWidth: Math.max(20, chatWidth - 9),
    }
  }
  const chatOnlyWidth = viewWidth - railWidth - SHELL_PANE_GAP
  const ratio = terminal >= 140 ? 0.4 : 0.38
  let workWidth = clamp(30, 78, Math.floor(viewWidth * ratio))
  let chatWidth = viewWidth - railWidth - workWidth - SHELL_PANE_GAP * 2
  // The chat is the shell's primary surface: shrink the Work pane before the
  // transcript drops below a readable 30-cell column.
  if (chatWidth < 30) {
    workWidth = Math.max(28, workWidth - (30 - chatWidth))
    chatWidth = viewWidth - railWidth - workWidth - SHELL_PANE_GAP * 2
  }
  return {
    mode,
    terminalWidth: terminal,
    viewWidth,
    gap: SHELL_PANE_GAP,
    railWidth,
    chatWidth,
    workWidth,
    workChrome,
    workContentWidth: Math.max(WORK_CARD_MIN_WIDTH - WORK_CARD_HORIZONTAL_CHROME, workWidth - workChrome),
    chatContentWidth: Math.max(20, chatWidth - 9),
    chatOnlyContentWidth: Math.max(20, chatOnlyWidth - 9),
  }
}

/** The Work pane body height after the shell and pane chrome. */
export function workPaneBodyHeight(terminalHeight: number): number {
  return Math.max(2, Math.floor(terminalHeight) - WORK_PANE_BODY_CHROME_ROWS)
}

/**
 * Card columns for a Work content width. One column falls back to compact
 * rows; the cap matches the existing Work grid.
 */
export function workPaneColumns(contentWidth: number): number {
  const width = Math.max(0, Math.floor(contentWidth))
  return Math.max(1, Math.min(3, Math.floor((width + WORK_CARD_GAP_COLS) / (WORK_CARD_MIN_WIDTH + WORK_CARD_GAP_COLS))))
}

/**
 * Ticket #172: the Work pane's two views.
 *
 * ACTIVE keeps only groups with non-terminal work and removes every terminal
 * card, including terminal members of an otherwise active group. HISTORY keeps
 * groups whose members are all terminal, newest latest-finish first, with the
 * tasks in chronological order. Partitioning by any non-terminal member means a
 * group can never appear in both views.
 */
export type WorkView = "active" | "history"

export type WorkViewGroups = {
  active: WorkGroup[]
  history: WorkGroup[]
}

function latestFinish(group: WorkGroup): number {
  // HISTORY orders by finish time, newest first. An approval resolution may
  // be later than the task's finish, so it is only the fallback.
  let latest: number | undefined
  for (const task of group.tasks) {
    const finished = workFinishedAt(task)
    if (finished !== undefined && (latest === undefined || finished > latest)) latest = finished
  }
  return latest ?? group.latestTerminalAt ?? group.createdAt
}

function chronological(left: Subtask, right: Subtask): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id)
}

export function workViewGroups(
  tasks: Subtask[],
  subtasks: Record<string, Subtask>,
  options: WorkGroupOptions,
): WorkViewGroups {
  const now = options.now
  const active: WorkGroup[] = []
  const history: WorkGroup[] = []
  for (const group of allWorkGroupsForTasks(tasks, subtasks, options)) {
    if (group.active > 0) {
      active.push({
        ...group,
        tasks: group.tasks.filter((task) => !isTerminalWorkStatus(deriveWorkStatus(task, now))),
      })
    } else {
      history.push({ ...group, tasks: [...group.tasks].sort(chronological) })
    }
  }
  active.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  history.sort(
    (left, right) =>
      latestFinish(right) - latestFinish(left) ||
      right.createdAt - left.createdAt ||
      left.id.localeCompare(right.id),
  )
  return { active, history }
}

/**
 * Ticket #172: one paginated Work page section. Cards and compact rows keep
 * their ticket #137 design; pagination only decides which slice of a group is
 * visible and whether the group header repeats with `cont.`.
 */
export type WorkPaneSection = {
  groupID: string
  /** Full header on a group's first section of a page; null when the previous section on the page owns it. */
  label: string | null
  tone: "faint" | "warn"
  mode: "cards" | "rows"
  tasks: Subtask[]
  /** Rows the section consumes, including its label but excluding `gapBefore`. */
  height: number
  /** The group began on an earlier page. */
  continued: boolean
  /** One separation row between groups in card mode. */
  gapBefore: boolean
}

export type WorkPanePage = {
  /** 1-based page number. */
  number: number
  sections: WorkPaneSection[]
  /** Every task on this page, in reading order. */
  tasks: Subtask[]
  /** Rows consumed including inter-group gaps. */
  height: number
}

export type WorkPaneLayout = {
  mode: "cards" | "compact"
  /** Card columns; zero in compact mode. */
  columns: number
  /** Outer card width including border and padding; zero in compact mode. */
  cardWidth: number
  /** Card content width after border, accent, and padding. */
  cardContentWidth: number
  pages: WorkPanePage[]
  /** Every task across all pages, in reading order. */
  tasks: Subtask[]
  limit: number
}

function sectionTone(group: WorkGroup, now: number): "faint" | "warn" {
  if (group.exhausted || group.state === "closed") return "warn"
  return group.tasks.some((task) => deriveWorkStatus(task, now) === "stalled") ? "warn" : "faint"
}

type SectionAtom = {
  groupID: string
  fullLabel: string
  tone: "faint" | "warn"
  mode: "cards" | "rows"
  tasks: Subtask[]
  /** Rows for the card row or compact rows, without a label. */
  bodyHeight: number
  /** First section of a group after another group; cards use one blank row. */
  gapBefore: boolean
}

function emptyLayout(): WorkPaneLayout {
  return {
    mode: "compact",
    columns: 0,
    cardWidth: 0,
    cardContentWidth: Math.max(12, 0),
    pages: [{ number: 1, sections: [], tasks: [], height: 0 }],
    tasks: [],
    limit: 0,
  }
}

/**
 * Lay every group into whole-row pages sized by the Work pane body. A group
 * that crosses a page boundary repeats its full header with a `cont.` suffix;
 * a group that simply starts on a new page keeps its normal header.
 */
export function paginateWorkGroups(
  groups: WorkGroup[],
  contentWidth: number,
  bodyHeight: number,
  now: number = Date.now(),
): WorkPaneLayout {
  const width = Math.max(0, Math.floor(contentWidth))
  const body = Math.max(2, Math.floor(bodyHeight))
  if (groups.length === 0) return emptyLayout()
  const fitColumns = workPaneColumns(width)
  const cards = fitColumns >= 2 && body >= WORK_CARD_ROWS + 2
  const columns = cards ? fitColumns : 0
  const cardWidth = cards ? Math.floor((width - WORK_CARD_GAP_COLS * (columns - 1)) / columns) : 0
  const cardContentWidth = cards ? workCardContentWidth(cardWidth) : Math.max(12, width)
  const atoms: SectionAtom[] = []
  groups.forEach((group, index) => {
    const fullLabel = workGroupLabel(group, index + 1)
    const tone = sectionTone(group, now)
    if (cards) {
      for (let offset = 0; offset < group.tasks.length; offset += columns) {
        atoms.push({
          groupID: group.id,
          fullLabel,
          tone,
          mode: "cards",
          tasks: group.tasks.slice(offset, offset + columns),
          bodyHeight: WORK_CARD_ROWS,
          gapBefore: index > 0 && offset === 0,
        })
      }
      return
    }
    for (const task of group.tasks) {
      atoms.push({
        groupID: group.id,
        fullLabel,
        tone,
        mode: "rows",
        tasks: [task],
        bodyHeight: 1,
        // Compact rows already have a header line between groups; no blank.
        gapBefore: false,
      })
    }
  })

  const pages: WorkPanePage[] = []
  let sections: WorkPaneSection[] = []
  let pageHeight = 0
  let pageTasks: Subtask[] = []
  const started = new Set<string>()
  const flush = () => {
    pages.push({ number: pages.length + 1, sections, tasks: pageTasks, height: pageHeight })
    sections = []
    pageTasks = []
    pageHeight = 0
  }
  for (const atom of atoms) {
    let groupStarted = started.has(atom.groupID)
    let header = !sections.some((section) => section.groupID === atom.groupID)
    let gap = atom.gapBefore && sections.length > 0 ? 1 : 0
    let cost = atom.bodyHeight + (header ? 1 : 0) + gap
    if (pageHeight + cost > body && sections.length > 0) {
      // Flush and place the atom at the top of a fresh page. A group that began
      // earlier repeats its header with `cont.`; a fresh group keeps its
      // normal header because the user has not seen it yet.
      flush()
      groupStarted = started.has(atom.groupID)
      header = true
      gap = 0
      cost = atom.bodyHeight + 1
    }
    // A single whole row can never exceed the body in card mode (gated) or
    // compact mode, so a fresh page always fits it.
    sections.push({
      groupID: atom.groupID,
      label: header ? (groupStarted ? `${atom.fullLabel} · cont.` : atom.fullLabel) : null,
      tone: atom.tone,
      mode: atom.mode,
      tasks: atom.tasks,
      height: atom.bodyHeight + (header ? 1 : 0),
      continued: header && groupStarted,
      gapBefore: gap === 1,
    })
    pageHeight += cost
    pageTasks.push(...atom.tasks)
    if (header) started.add(atom.groupID)
  }
  flush()
  return {
    mode: cards ? "cards" : "compact",
    columns,
    cardWidth,
    cardContentWidth,
    pages,
    tasks: pages.flatMap((page) => page.tasks),
    limit: pages.reduce((total, page) => total + page.tasks.length, 0),
  }
}

export type WorkFocusSettlement = {
  index: number
  id: string | undefined
}

/**
 * Ticket #172: task identity owns focus. A view switch or a layout update
 * keeps the same task when it is still visible; otherwise the caller picks
 * either the first card (filter switch) or the nearest index (a focused card
 * finished and the pane should not jump to the top).
 */
export function settleWorkFocus(
  tasks: ReadonlyArray<Pick<Subtask, "id">>,
  previousID: string | undefined,
  previousIndex: number,
  fallback: "first" | "nearest" = "nearest",
): WorkFocusSettlement {
  if (tasks.length === 0) return { index: 0, id: undefined }
  if (previousID !== undefined) {
    const index = tasks.findIndex((task) => task.id === previousID)
    if (index >= 0) return { index, id: previousID }
  }
  const index = fallback === "first"
    ? 0
    : Math.max(0, Math.min(tasks.length - 1, Math.floor(previousIndex)))
  return { index, id: tasks[index]?.id }
}

/** The 1-based page containing a task, or undefined when it is not visible. */
export function workTaskPage(layout: Pick<WorkPaneLayout, "pages">, taskID: string): number | undefined {
  const page = layout.pages.find((candidate) => candidate.tasks.some((task) => task.id === taskID))
  return page?.number
}

/** Ticket #172: the pane header before truncation. */
export function workPaneHeader(
  view: WorkView,
  groupCount: number,
  activeCount: number,
  doneCount: number,
  page: number,
  pageCount: number,
): string {
  const groups = Math.max(0, Math.floor(groupCount))
  const active = Math.max(0, Math.floor(activeCount))
  const done = Math.max(0, Math.floor(doneCount))
  const current = Math.max(1, Math.floor(page))
  const pages = Math.max(1, Math.floor(pageCount))
  const summary = groups === 0
    ? "none yet"
    : `${groups} ${groups === 1 ? "group" : "groups"} · ${active} active · ${done} done`
  return `WORK ${view.toUpperCase()} │ ${summary} │ page ${Math.min(current, pages)}/${pages}`
}
