import { dispatchBudgetLabel, dispatchBudgetSummary } from "./dispatch-budget.ts"
import { resolveDispatchGroupID } from "./dispatch-group.ts"
import { FINISHED_RETENTION_MS, deriveWorkStatus, isNativeTurn, isTerminalWorkStatus, workStatusWord, type DerivedWorkStatus } from "./queue.ts"
import type { DispatchGroup, Id, NativeTurnEvent, Subtask } from "./types.ts"

/**
 * Ticket #222: server-paged Work history for one conversation.
 *
 * HISTORY is a read over the same durable Subtask rows the queue and the Work
 * projection already own. It is not a second Work store: a page names the
 * terminal rows inside the existing 24 h retention, newest finish first, and
 * the client merges them into the one Work map. A page is bounded, so a large
 * history never inflates the bootstrap or a Work resync.
 */

/** Default page size for bootstrap follow-up, scrolling, and tests. */
export const WORK_HISTORY_PAGE = 12
/** Largest page a client may request. */
export const WORK_HISTORY_PAGE_MAX = 50

/** The conversation a Work row belongs to (ADR 0009). */
export function workConversationID(task: Pick<Subtask, "conversationID" | "workspaceID">): Id {
  return task.conversationID ?? task.workspaceID
}

/** The honest history position: terminal finish time, or its creation fallback. */
export function workHistoryAt(task: Subtask): number {
  return task.finishedAt ?? task.repliedAt ?? task.stoppedAt ?? task.createdAt
}

function retainedTerminal(task: Subtask, now: number): boolean {
  if (!isTerminalWorkStatus(deriveWorkStatus(task, now))) return false
  const finished = task.finishedAt ?? task.repliedAt ?? task.stoppedAt
  return finished === undefined || now - finished < FINISHED_RETENTION_MS
}

type HistoryCursor = {
  finishedAt: number
  createdAt: number
  id: Id
}

function encodeCursor(task: Subtask): string {
  const cursor: HistoryCursor = {
    finishedAt: workHistoryAt(task),
    createdAt: task.createdAt,
    id: task.id,
  }
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
}

function decodeCursor(value: string | undefined): HistoryCursor | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<HistoryCursor>
    if (typeof parsed.finishedAt !== "number" || typeof parsed.createdAt !== "number" || typeof parsed.id !== "string") return undefined
    return { finishedAt: parsed.finishedAt, createdAt: parsed.createdAt, id: parsed.id }
  } catch {
    return undefined
  }
}

/** Newest finish first; creation then id keep equal finishes stable across pages. */
function compareHistory(left: Subtask, right: Subtask): number {
  return workHistoryAt(right) - workHistoryAt(left)
    || right.createdAt - left.createdAt
    || left.id.localeCompare(right.id)
}

function afterCursor(task: Subtask, cursor: HistoryCursor): boolean {
  const finished = workHistoryAt(task)
  if (finished !== cursor.finishedAt) return finished < cursor.finishedAt
  if (task.createdAt !== cursor.createdAt) return task.createdAt < cursor.createdAt
  return task.id > cursor.id
}

/** Normalize a requested page size into the bounded contract. */
export function workHistoryLimit(limit: number | undefined): number {
  const requested = Number.isFinite(limit) ? Math.floor(limit as number) : WORK_HISTORY_PAGE
  return Math.max(1, Math.min(WORK_HISTORY_PAGE_MAX, requested))
}

export type WorkHistorySelection = {
  tasks: Subtask[]
  hasMore: boolean
  next?: string
  limit: number
}

/**
 * One page of terminal Work for one conversation. `before` is the opaque
 * cursor returned by the previous page; an unknown cursor starts at the
 * newest row so a stale client heals instead of showing an empty page.
 */
export function selectWorkHistory(
  tasks: readonly Subtask[],
  input: { conversationID: Id; now: number; before?: string; limit?: number },
): WorkHistorySelection {
  const limit = workHistoryLimit(input.limit)
  const cursor = decodeCursor(input.before)
  const eligible = tasks
    .filter((task) => workConversationID(task) === input.conversationID && retainedTerminal(task, input.now))
    .sort(compareHistory)
  const remaining = cursor ? eligible.filter((task) => afterCursor(task, cursor)) : eligible
  const page = remaining.slice(0, limit)
  const hasMore = remaining.length > page.length
  return {
    tasks: page,
    hasMore,
    ...(hasMore && page.length > 0 ? { next: encodeCursor(page[page.length - 1]!) } : {}),
    limit,
  }
}

/** Dispatch ledger records for a page's rows, plus each continuation's root. */
export function workHistoryGroups(
  tasks: readonly Subtask[],
  all: Record<Id, DispatchGroup>,
): Record<Id, DispatchGroup> {
  const groups: Record<Id, DispatchGroup> = {}
  for (const task of tasks) {
    const groupID = task.dispatchGroupID
    const group = groupID ? all[groupID] : undefined
    if (!group) continue
    groups[group.id] = group
    const root = group.rootID !== group.id ? all[group.rootID] : undefined
    if (root) groups[root.id] = root
  }
  return groups
}

/**
 * "Why this card?" is a pure metadata view over durable rows: origin,
 * conversation, session, inbox, event timeline, routes, and budget. It never
 * reads message text, instructions, or paths.
 */
export type WorkDetailRow = { label: string; value: string }
export type WorkDetailSection = { title: string; rows: WorkDetailRow[] }

export type WorkDetail = {
  taskID: Id
  status: DerivedWorkStatus
  state: string
  sections: WorkDetailSection[]
}

function timeLabel(at: number | undefined): string | undefined {
  if (at === undefined || !Number.isFinite(at)) return undefined
  return new Date(at).toISOString()
}

function nativeEventValue(event: NativeTurnEvent): string {
  const parts: string[] = []
  if (event.phase) parts.push(`phase=${event.phase}`)
  if (event.delivery) parts.push(`delivery=${event.delivery}`)
  if (event.messageID) parts.push(`message=${event.messageID}`)
  const time = timeLabel(event.at)
  if (time) parts.push(time)
  return parts.join(" · ")
}

/**
 * Build the detail sections from the same durable task map the Work pane
 * reads. Child tasks in the turn's dispatch group are routes; a richer
 * mention record can be added later without changing this contract.
 */
export function workDetailFor(
  task: Subtask,
  input: {
    subtasks: Record<Id, Subtask>
    dispatchGroups?: Record<Id, DispatchGroup>
    now: number
  },
): WorkDetail {
  const status = deriveWorkStatus(task, input.now)
  const native = task.native
  const groups = input.dispatchGroups ?? {}
  const groupID = task.dispatchGroupID ?? resolveDispatchGroupID(task, input.subtasks)
  const group = groupID ? groups[groupID] : undefined
  const origin = isNativeTurn(task)
    ? `native · ${task.workKind ?? "turn"}${task.adopted ? " · adopted" : ""}`
    : task.workKind ?? "delegation"

  const identity: WorkDetailRow[] = [
    { label: "Origin", value: origin },
    { label: "Conversation", value: workConversationID(task) },
    { label: "Task", value: task.id },
    ...(groupID ? [{ label: "Group", value: groupID }] : []),
    ...(native?.sessionID ? [{ label: "Session", value: native.sessionID }] : []),
    ...(native?.inboxID ? [{ label: "Inbox", value: native.inboxID }] : []),
    ...(native?.assistantMessageIDs?.length
      ? [{ label: "Assistant", value: native.assistantMessageIDs.join(", ") }]
      : []),
    ...(native?.phase ? [{ label: "Phase", value: native.phase }] : []),
    ...(native?.resultMessageID ?? task.resultMessageID
      ? [{ label: "Result", value: native?.resultMessageID ?? task.resultMessageID! }]
      : []),
    ...(task.failure ? [{ label: "Failure", value: `${task.failure.kind} · ${task.failure.reason}` }] : []),
    ...(task.error ? [{ label: "Error", value: task.error }] : []),
    ...(timeLabel(task.createdAt) ? [{ label: "Created", value: timeLabel(task.createdAt)! }] : []),
    ...(timeLabel(task.finishedAt) ? [{ label: "Finished", value: timeLabel(task.finishedAt)! }] : []),
  ]

  const timeline = (native?.events ?? []).map((event, index) => ({
    label: `${index + 1}. ${event.type}`,
    value: nativeEventValue(event),
  }))
  if (timeline.length === 0) timeline.push({ label: "events", value: "none" })

  const routes = Object.values(input.subtasks)
    .filter((child) => child.id !== task.id && child.parentID === task.id)
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .map((child) => ({
      label: child.id,
      value: `${child.assigneeID ?? "unassigned"} · ${deriveWorkStatus(child, input.now)}`,
    }))
  if (routes.length === 0) routes.push({ label: "children", value: "none" })

  const budget = group
    ? [{
        label: group.id,
        value: `${dispatchBudgetLabel(dispatchBudgetSummary(group, groups), "full")} · depth ${group.depthMax}`,
      }]
    : []
  if (budget.length === 0) budget.push({ label: "group", value: "none" })

  return {
    taskID: task.id,
    status,
    state: workStatusWord(status),
    sections: [
      { title: "Identity", rows: identity },
      { title: "Event timeline", rows: timeline },
      { title: "Routes", rows: routes },
      { title: "Budget", rows: budget },
    ],
  }
}

/** One plain-text rendering for the existing result overlay; no content fields. */
export function workDetailText(detail: WorkDetail): string {
  const lines = [`State: ${detail.state}`, `Task: ${detail.taskID}`]
  for (const section of detail.sections) {
    lines.push("", section.title.toUpperCase())
    for (const row of section.rows) lines.push(`${row.label} │ ${row.value}`)
  }
  return lines.join("\n")
}
