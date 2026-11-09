import { deriveWorkStatus, isTerminalWorkStatus } from "../queue.ts"
import { resolveDispatchGroupID } from "../dispatch-group.ts"
import { allWorkGroupsForTasks, workFinishedAt, type WorkGroup, type WorkGroupOptions } from "../work-groups.ts"
import type { NativeSubagentRun, Subtask } from "../types.ts"
import type { PaneSideVisibility } from "./panefocus.ts"
import { ageLabel } from "./format.ts"
import { WORK_CARD_GAP_COLS, WORK_CARD_HORIZONTAL_CHROME, WORK_CARD_MIN_WIDTH, WORK_CARD_ROWS, workCardContentWidth } from "./workrows.ts"
import { workGroupLabel, workHistoryFinishedAt, workHistoryRollupLabel } from "./workgroups.ts"

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
 * Chat outer chrome: border (2), pane padding (2), transcript right padding
 * (1), and one message row's left/right padding (2). The transcript text
 * width is the pane width after this chrome; no extra scrollbar reserve.
 */
export const CHAT_CONTENT_CHROME = 7

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
  /** Transcript text width after the chat border/padding chrome while Work shares the row. */
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
 *
 * Ticket #183: the two durable column switches feed this one function. A
 * closed column claims no width, so the chat reclaims it; the drawer itself
 * still overlays the chat at narrow widths.
 */
export function workspacePaneWidths(
  terminalWidth: number,
  visibility: Partial<PaneSideVisibility> = {},
): ShellPaneWidths {
  const terminal = Math.max(60, Math.floor(terminalWidth))
  const viewWidth = terminal - SHELL_VIEW_INSET
  const left = visibility.left !== false
  const right = visibility.right !== false
  const railWidth = left ? clamp(26, 34, Math.floor(viewWidth * 0.26)) : 0
  const mode: ShellPaneMode = terminal >= 118 ? "three" : terminal >= 96 ? "compact" : "drawer"
  const workChrome = WORK_PANE_HORIZONTAL_CHROME
  const chatOnlyWidth = viewWidth - railWidth - (left ? SHELL_PANE_GAP : 0)
  if (mode === "drawer") {
    const chatWidth = chatOnlyWidth
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
      chatContentWidth: Math.max(20, chatWidth - CHAT_CONTENT_CHROME),
      chatOnlyContentWidth: Math.max(20, chatOnlyWidth - CHAT_CONTENT_CHROME),
    }
  }
  if (!right) {
    return {
      mode,
      terminalWidth: terminal,
      viewWidth,
      gap: SHELL_PANE_GAP,
      railWidth,
      chatWidth: chatOnlyWidth,
      workWidth: 0,
      workChrome,
      workContentWidth: 0,
      chatContentWidth: Math.max(20, chatOnlyWidth - CHAT_CONTENT_CHROME),
      chatOnlyContentWidth: Math.max(20, chatOnlyWidth - CHAT_CONTENT_CHROME),
    }
  }
  const ratio = terminal >= 140 ? 0.4 : 0.38
  let workWidth = clamp(30, 78, Math.floor(viewWidth * ratio))
  let chatWidth = viewWidth - railWidth - workWidth - SHELL_PANE_GAP - (left ? SHELL_PANE_GAP : 0)
  // The chat is the shell's primary surface: shrink the Work pane before the
  // transcript drops below a readable 30-cell column.
  if (chatWidth < 30) {
    workWidth = Math.max(28, workWidth - (30 - chatWidth))
    chatWidth = viewWidth - railWidth - workWidth - SHELL_PANE_GAP - (left ? SHELL_PANE_GAP : 0)
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
    chatContentWidth: Math.max(20, chatWidth - CHAT_CONTENT_CHROME),
    chatOnlyContentWidth: Math.max(20, chatOnlyWidth - CHAT_CONTENT_CHROME),
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
 * Ticket #184: the Work pane's two views partition tasks, not groups.
 *
 * ACTIVE keeps every non-terminal task; HISTORY keeps every terminal task,
 * even when its group still has live work. A group can therefore appear in
 * both views with disjoint cards. HISTORY groups order by their latest terminal
 * finish, newest first, and cards inside a group order by finish, newest first.
 */
export type WorkView = "active" | "history"

export type WorkViewGroups = {
  active: WorkGroup[]
  history: WorkGroup[]
}

/**
 * Ticket #187: one renderable Work item. A card row may mix task cards and
 * native subagent cards without promoting the child run to a Subtask.
 */
export type WorkPaneItem =
  | { kind: "task"; task: Subtask }
  | { kind: "native"; run: NativeSubagentRun }

const taskPaneItems = new WeakMap<Subtask, WorkPaneItem>()
const nativePaneItems = new WeakMap<NativeSubagentRun, WorkPaneItem>()

function taskPaneItem(task: Subtask): WorkPaneItem {
  let item = taskPaneItems.get(task)
  if (!item) {
    item = { kind: "task", task }
    taskPaneItems.set(task, item)
  }
  return item
}

function nativePaneItem(run: NativeSubagentRun): WorkPaneItem {
  let item = nativePaneItems.get(run)
  if (!item) {
    item = { kind: "native", run }
    nativePaneItems.set(run, item)
  }
  return item
}

function groupItems(group: WorkGroup): WorkPaneItem[] {
  return [
    ...group.tasks.map(taskPaneItem),
    ...(group.native ?? []).map(nativePaneItem),
  ]
}

function newestFinish(left: Subtask, right: Subtask): number {
  return (workFinishedAt(right) ?? 0) - (workFinishedAt(left) ?? 0) || right.createdAt - left.createdAt || left.id.localeCompare(right.id)
}

/**
 * Ticket #187: map each native child session to its parent's dispatch group.
 * The parent task is the authority when it still exists (so legacy groups and
 * continuation lineage resolve exactly like the parent card); the record's
 * stored group id is the fallback. Child session ids dedupe the input.
 */
function nativeRunsByGroup(
  tasks: readonly Subtask[],
  subtasks: Record<string, Subtask>,
  runs: readonly NativeSubagentRun[],
): Map<string, NativeSubagentRun[]> {
  const taskByID = new Map<string, Subtask>()
  for (const task of tasks) taskByID.set(task.id, task)
  const byGroup = new Map<string, Map<string, NativeSubagentRun>>()
  for (const run of runs) {
    // The durable record is authoritative; the workspace projection is the
    // fallback for callers that pass tasks without their full record.
    const parent = run.parentTaskID
      ? subtasks[run.parentTaskID] ?? taskByID.get(run.parentTaskID)
      : undefined
    const groupID = (parent ? resolveDispatchGroupID(parent, subtasks) : undefined) ?? run.dispatchGroupID
    if (!groupID) continue
    let bucket = byGroup.get(groupID)
    if (!bucket) {
      bucket = new Map()
      byGroup.set(groupID, bucket)
    }
    bucket.set(run.childSessionID, run)
  }
  return new Map([...byGroup].map(([id, bucket]) => [
    id,
    [...bucket.values()].sort(
      (left, right) => left.startedAt - right.startedAt || left.childSessionID.localeCompare(right.childSessionID),
    ),
  ]))
}

function newestNativeFinish(left: NativeSubagentRun, right: NativeSubagentRun): number {
  return (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt)
    || right.startedAt - left.startedAt
    || left.childSessionID.localeCompare(right.childSessionID)
}

function historyItemFinish(item: WorkPaneItem): number {
  return item.kind === "task"
    ? workFinishedAt(item.task) ?? item.task.createdAt
    : item.run.finishedAt ?? item.run.startedAt
}

function historyItemCreatedAt(item: WorkPaneItem): number {
  return item.kind === "task" ? item.task.createdAt : item.run.startedAt
}

function historyItemID(item: WorkPaneItem): string {
  return item.kind === "task" ? item.task.id : item.run.childSessionID
}

/**
 * Ticket #184/#187: HISTORY cards order by finish, newest first, across both
 * card kinds. The start time and id keep the order stable on equal finishes;
 * ACTIVE keeps the task-then-native order `groupItems` produces.
 */
function newestHistoryItems(items: readonly WorkPaneItem[]): WorkPaneItem[] {
  return [...items].sort(
    (left, right) =>
      historyItemFinish(right) - historyItemFinish(left) ||
      historyItemCreatedAt(right) - historyItemCreatedAt(left) ||
      historyItemID(left).localeCompare(historyItemID(right)),
  )
}

export function workViewGroups(
  tasks: Subtask[],
  subtasks: Record<string, Subtask>,
  options: WorkGroupOptions,
  nativeRuns: readonly NativeSubagentRun[] = [],
): WorkViewGroups {
  const now = options.now
  const active: WorkGroup[] = []
  const history: WorkGroup[] = []
  const nativeByGroup = nativeRunsByGroup(tasks, subtasks, nativeRuns)
  for (const group of allWorkGroupsForTasks(tasks, subtasks, options)) {
    const runs = nativeByGroup.get(group.id) ?? []
    const liveNative = runs.filter((run) => run.state === "working")
    const doneNative = runs.filter((run) => run.state !== "working").sort(newestNativeFinish)
    const live = group.tasks.filter((task) => !isTerminalWorkStatus(deriveWorkStatus(task, now)))
    const finished = group.tasks.filter((task) => isTerminalWorkStatus(deriveWorkStatus(task, now)))
    const totalActive = group.active + liveNative.length
    const totalDone = group.done + doneNative.length
    // Native work is work: a group with a live child is not complete even when
    // every task has terminalized. This also keeps the expiry timer honest.
    const complete = totalActive === 0 && !group.needsYou
    if (live.length > 0 || liveNative.length > 0) {
      active.push({ ...group, tasks: live, native: liveNative, active: totalActive, done: totalDone, complete })
    }
    if (finished.length > 0 || doneNative.length > 0) {
      const latestNative = doneNative.reduce<number | undefined>(
        (latest, run) => {
          const finishedAt = run.finishedAt ?? run.startedAt
          return latest === undefined || finishedAt > latest ? finishedAt : latest
        },
        undefined,
      )
      history.push({
        ...group,
        tasks: [...finished].sort(newestFinish),
        native: doneNative,
        // The history subset owns only its finished cards; `active` stays the
        // group's live count so the rollup can say "active count when relevant".
        done: finished.length + doneNative.length,
        active: totalActive,
        complete,
        ...(latestNative !== undefined &&
        (group.latestTerminalAt === undefined || latestNative > group.latestTerminalAt)
          ? { latestTerminalAt: latestNative }
          : {}),
      })
    }
  }
  active.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  history.sort(
    (left, right) =>
      workHistoryFinishedAt(right) - workHistoryFinishedAt(left) ||
      right.createdAt - left.createdAt ||
      left.id.localeCompare(right.id),
  )
  return { active, history }
}

/**
 * Ticket #184: sticky history presentation state.
 *
 * `expanded` is the resolved sticky render state for every seen group: a new
 * group at the top starts expanded, a group that was already seen keeps the
 * row it rendered last time, and a former auto-expanded newest rolls up when a
 * newer group arrives. `manual` is only the explicit user override; an entry
 * there always wins. `done` is the terminal-card count last rendered, so a
 * finish in a collapsed group increments the count and sets `fresh` without
 * moving the page or opening the group. `fresh` stays until the group is
 * expanded or dismissed.
 */
export type HistoryViewState = {
  expanded: Record<string, boolean>
  done: Record<string, number>
  fresh: Record<string, boolean>
  /** Explicit user expansion choices; they outrank the newest-first default. */
  manual: Record<string, boolean>
}

export function emptyHistoryViewState(): HistoryViewState {
  return { expanded: {}, done: {}, fresh: {}, manual: {} }
}

function sameHistoryView(left: HistoryViewState, right: HistoryViewState): boolean {
  const keys = Object.keys(left.expanded)
  if (keys.length !== Object.keys(right.expanded).length) return false
  if (keys.some((key) => left.manual[key] !== right.manual[key])) return false
  return keys.every(
    (key) =>
      left.expanded[key] === right.expanded[key] &&
      left.done[key] === right.done[key] &&
      left.fresh[key] === right.fresh[key],
  )
}

/** Reconcile one history snapshot; an unchanged result keeps the previous object. */
export function reconcileHistoryView(
  groups: readonly WorkGroup[],
  previous: HistoryViewState,
): HistoryViewState {
  const expanded: Record<string, boolean> = {}
  const done: Record<string, number> = {}
  const fresh: Record<string, boolean> = {}
  const manual: Record<string, boolean> = {}
  groups.forEach((group, index) => {
    const priorExpanded = previous.manual[group.id]
    const wasSeen = previous.expanded[group.id] !== undefined
    // A seen group keeps the row it rendered last time, even when a later
    // finish promotes it to index 0. Only a never-seen newest group expands;
    // manual choices always win. An auto-expanded newest therefore rolls up
    // when a newer group arrives.
    const isExpanded = priorExpanded ?? (wasSeen && previous.expanded[group.id] === false ? false : index === 0)
    const priorDone = previous.done[group.id]
    expanded[group.id] = isExpanded
    done[group.id] = group.done
    if (priorExpanded !== undefined) manual[group.id] = priorExpanded
    fresh[group.id] = isExpanded
      ? false
      : Boolean(previous.fresh[group.id] || (priorDone !== undefined && group.done > priorDone))
  })
  const next = { expanded, done, fresh, manual }
  return sameHistoryView(previous, next) ? previous : next
}

/** Enter on a history group row toggles only that group; expanding clears its marker. */
export function toggleHistoryView(state: HistoryViewState, groupID: string): HistoryViewState {
  const expanded = !(state.expanded[groupID] ?? false)
  return {
    expanded: { ...state.expanded, [groupID]: expanded },
    done: state.done,
    fresh: { ...state.fresh, [groupID]: expanded ? false : (state.fresh[groupID] ?? false) },
    manual: { ...state.manual, [groupID]: expanded },
  }
}

/** The pagination input for HISTORY: group data plus its rolled-up/expanded row state. */
export type WorkPaneGroup = WorkGroup & {
  /** Ticket #184: render a focusable history header row before any cards. */
  history?: boolean
  /** The group contributes one rolled-up row and no cards. */
  collapsed?: boolean
  /** A finish arrived while the group was rolled up. */
  fresh?: boolean
}

/** Visible history groups in newest-first order with their row state applied. */
export function historyPaneGroups(
  groups: readonly WorkGroup[],
  state: HistoryViewState,
  dismissed: ReadonlySet<string> = new Set<string>(),
): WorkPaneGroup[] {
  return groups
    .filter((group) => !dismissed.has(group.id))
    .map((group, index) => ({
      ...group,
      history: true as const,
      collapsed: !(state.expanded[group.id] ?? index === 0),
      fresh: state.fresh[group.id] === true,
    }))
}

/** Ticket #184: a history header row is a focus target distinct from task cards. */
export const WORK_HISTORY_FOCUS_PREFIX = "history:"

export function historyGroupFocusID(groupID: string): string {
  return `${WORK_HISTORY_FOCUS_PREFIX}${groupID}`
}

export function historyGroupIDFromFocus(focusID: string | undefined): string | undefined {
  if (focusID === undefined || !focusID.startsWith(WORK_HISTORY_FOCUS_PREFIX)) return undefined
  return focusID.slice(WORK_HISTORY_FOCUS_PREFIX.length)
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
  mode: "cards" | "rows" | "rollup"
  tasks: Subtask[]
  /** Ticket #187: native subagent cards in this section, in render order after its tasks. */
  native?: NativeSubagentRun[]
  /** Ticket #187: the section's tasks and native cards in exact render order. */
  items?: WorkPaneItem[]
  /** Ticket #184: the rolled-up history header row. */
  rollup?: WorkHistoryRollup
  /** Rows the section consumes, including its label but excluding `gapBefore`. */
  height: number
  /** The group began on an earlier page. */
  continued: boolean
  /** One separation row between groups in card mode. */
  gapBefore: boolean
}

/** Ticket #184: one rolled-up history group row. */
export type WorkHistoryRollup = {
  groupID: string
  ordinal: number
  done: number
  active: number
  collapsed: boolean
  fresh: boolean
  age: string
  label: string
}

export type WorkPanePage = {
  /** 1-based page number. */
  number: number
  sections: WorkPaneSection[]
  /** Every task on this page, in reading order. */
  tasks: Subtask[]
  /** Ticket #187: every native subagent card on this page, in reading order. */
  native?: NativeSubagentRun[]
  /** Ticket #187: every card on this page, in reading order. */
  items?: WorkPaneItem[]
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
  /** Ticket #187: every native subagent card across all pages, in reading order. */
  native: NativeSubagentRun[]
  /** Ticket #187: every card across all pages, in reading order. */
  items: WorkPaneItem[]
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
  mode: "cards" | "rows" | "rollup"
  items: WorkPaneItem[]
  rollup?: WorkHistoryRollup
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
    pages: [{ number: 1, sections: [], tasks: [], native: [], items: [], height: 0 }],
    tasks: [],
    native: [],
    items: [],
    limit: 0,
  }
}

/**
 * Lay every group into whole-row pages sized by the Work pane body. A group
 * that crosses a page boundary repeats its full header with a `cont.` suffix;
 * a group that simply starts on a new page keeps its normal header.
 */
export function paginateWorkGroups(
  groups: ReadonlyArray<WorkPaneGroup>,
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
    if (group.history) {
      const finishedAt = workHistoryFinishedAt(group)
      const age = ageLabel(finishedAt, now)
      atoms.push({
        groupID: group.id,
        fullLabel,
        tone,
        mode: "rollup",
        items: [],
        bodyHeight: 1,
        gapBefore: index > 0 && cards,
        rollup: {
          groupID: group.id,
          ordinal: index + 1,
          done: group.done,
          active: group.active,
          collapsed: group.collapsed === true,
          fresh: group.fresh === true,
          age,
          label: workHistoryRollupLabel(group, index + 1, age),
        },
      })
      if (group.collapsed === true) return
    }
    const items = group.history ? newestHistoryItems(groupItems(group)) : groupItems(group)
    if (cards) {
      for (let offset = 0; offset < items.length; offset += columns) {
        atoms.push({
          groupID: group.id,
          fullLabel,
          tone,
          mode: "cards",
          items: items.slice(offset, offset + columns),
          bodyHeight: WORK_CARD_ROWS,
          // A history group's focusable header already owns the separation row.
          gapBefore: !group.history && index > 0 && offset === 0,
        })
      }
      return
    }
    for (const item of items) {
      atoms.push({
        groupID: group.id,
        fullLabel,
        tone,
        mode: "rows",
        items: [item],
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
  let pageNative: NativeSubagentRun[] = []
  let pageItems: WorkPaneItem[] = []
  const started = new Set<string>()
  const flush = () => {
    pages.push({
      number: pages.length + 1,
      sections,
      tasks: pageTasks,
      native: pageNative,
      items: pageItems,
      height: pageHeight,
    })
    sections = []
    pageTasks = []
    pageNative = []
    pageItems = []
    pageHeight = 0
  }
  for (const atom of atoms) {
    const rollup = atom.mode === "rollup"
    let groupStarted = started.has(atom.groupID)
    let header = !rollup && !sections.some((section) => section.groupID === atom.groupID)
    let gap = atom.gapBefore && sections.length > 0 ? 1 : 0
    let cost = atom.bodyHeight + (header ? 1 : 0) + gap
    if (pageHeight + cost > body && sections.length > 0) {
      // Flush and place the atom at the top of a fresh page. A group that began
      // earlier repeats its header with `cont.`; a fresh group keeps its
      // normal header because the user has not seen it yet.
      flush()
      groupStarted = started.has(atom.groupID)
      header = !rollup
      gap = 0
      cost = atom.bodyHeight + (header ? 1 : 0)
    }
    // A single whole row can never exceed the body in card mode (gated) or
    // compact mode, so a fresh page always fits it.
    const tasks = atom.items.flatMap((item) => item.kind === "task" ? [item.task] : [])
    const native = atom.items.flatMap((item) => item.kind === "native" ? [item.run] : [])
    sections.push({
      groupID: atom.groupID,
      label: header ? (groupStarted ? `${atom.fullLabel} · cont.` : atom.fullLabel) : null,
      tone: atom.tone,
      mode: atom.mode,
      tasks,
      native,
      items: atom.items,
      ...(atom.rollup ? { rollup: atom.rollup } : {}),
      height: atom.bodyHeight + (header ? 1 : 0),
      continued: header && groupStarted,
      gapBefore: gap === 1,
    })
    pageHeight += cost
    pageTasks.push(...tasks)
    pageNative.push(...native)
    pageItems.push(...atom.items)
    if (header || rollup) started.add(atom.groupID)
  }
  flush()
  return {
    mode: cards ? "cards" : "compact",
    columns,
    cardWidth,
    cardContentWidth,
    pages,
    tasks: pages.flatMap((page) => page.tasks),
    native: pages.flatMap((page) => page.native ?? []),
    items: pages.flatMap((page) => page.items ?? []),
    limit: pages.reduce((total, page) => total + (page.items ?? page.tasks).length, 0),
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
