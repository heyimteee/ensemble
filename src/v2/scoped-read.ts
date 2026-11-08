import { FINISHED_RETENTION_MS, deriveWorkStatus, isTerminalWorkStatus } from "./queue.ts"
import { approvalResolutionAt, workGroupsForTasks } from "./work-groups.ts"
import type { Id, Message, ScopeName, ScopeVersions, SnapshotState, Subtask, Tier3Gate, TranscriptWindow, WorkspaceCounts } from "./types.ts"

/**
 * Ticket #141 Tier 3 scoped reads.
 *
 * All scoped reads are derived from durable state: the Work projection, the
 * transcript window, unread/busy counts, and per-scope change versions are
 * pure functions over the server's durable store. None of them is a new
 * source of truth, and the full snapshot remains the recovery path.
 *
 * The Tier 3 gate keeps small workspaces on the existing snapshot path. The
 * scoped layer engages only when durable history, a measured bootstrap
 * payload, or a measured snapshot latency makes the full state costly.
 */

/** Engage scoped bootstrap/projection at this many durable transcript rows. */
export const TIER3_MESSAGE_THRESHOLD = 1_000
/** Engage at this many retained subtask rows, including long-retained terminal rows. */
export const TIER3_TASK_THRESHOLD = 500
/** Engage when the last measured full snapshot payload reached this size. */
export const TIER3_SNAPSHOT_BYTES = 512 * 1024
/** Engage when the last measured full snapshot build reached this latency. */
export const TIER3_SNAPSHOT_MS = 120

/** One bootstrap/refresh page of the active transcript. */
export const TRANSCRIPT_WINDOW = 40
/** Largest page a client may request for one transcript window. */
export const TRANSCRIPT_WINDOW_MAX = 200

/** Hard client-side transcript bound per workspace (ticket #141). */
export const CLIENT_MESSAGE_LIMIT = 240

export type Tier3GateInput = {
  messageCount: number
  taskCount: number
  snapshotBytes?: number
  snapshotMs?: number
}

/**
 * The recorded Tier 3 gate. History size is the primary signal; payload and
 * latency measurements upgrade a borderline workspace once a full snapshot
 * has actually been measured. A disabled gate means the caller keeps the
 * existing snapshot path.
 */
export function tier3Gate(input: Tier3GateInput): Tier3Gate {
  const messageCount = Math.max(0, Math.floor(input.messageCount))
  const taskCount = Math.max(0, Math.floor(input.taskCount))
  const gate: Tier3Gate = {
    enabled: false,
    reason: "small-history",
    messageCount,
    taskCount,
    ...(input.snapshotBytes !== undefined ? { snapshotBytes: Math.max(0, input.snapshotBytes) } : {}),
    ...(input.snapshotMs !== undefined ? { snapshotMs: Math.max(0, input.snapshotMs) } : {}),
  }
  if (messageCount >= TIER3_MESSAGE_THRESHOLD || taskCount >= TIER3_TASK_THRESHOLD) {
    return { ...gate, enabled: true, reason: "history" }
  }
  if (input.snapshotBytes !== undefined && input.snapshotBytes >= TIER3_SNAPSHOT_BYTES) {
    return { ...gate, enabled: true, reason: "payload" }
  }
  if (input.snapshotMs !== undefined && input.snapshotMs >= TIER3_SNAPSHOT_MS) {
    return { ...gate, enabled: true, reason: "latency" }
  }
  return gate
}

export function pendingApprovalIDs(state: SnapshotState): Set<Id> {
  return new Set(
    Object.values(state.approvals)
      .filter((approval) => approval.status === "pending")
      .map((approval) => approval.id),
  )
}

/** Native permission mirrors block their linked subtask without setting approvalID. */
export function nativeBlockedSubtaskIDs(state: SnapshotState): Set<Id> {
  return new Set(
    Object.values(state.approvals)
      .filter((approval) => approval.kind === "native" && approval.status === "pending" && approval.subtaskID)
      .map((approval) => approval.subtaskID!),
  )
}

/**
 * The Work projection: only tasks in a visible dispatch group (active,
 * needs-you, or inside the shared completion hold). Long-retained terminal
 * rows that are not visible are omitted, so a 24 h task history does not ride
 * along with every bootstrap or scoped Work resync.
 */
export function projectVisibleWork(state: SnapshotState, now: number = Date.now(), holdMs?: number): Record<Id, Subtask> {
  const tasks = Object.values(state.subtasks)
  const groups = workGroupsForTasks(tasks, state.subtasks, {
    now,
    ...(holdMs !== undefined ? { holdMs } : {}),
    pendingApprovalIDs: pendingApprovalIDs(state),
    nativeBlockedSubtaskIDs: nativeBlockedSubtaskIDs(state),
    resolvedAtForTask: approvalResolutionAt(state.approvals),
  })
  const projected: Record<Id, Subtask> = {}
  for (const group of groups) {
    for (const task of group.tasks) projected[task.id] = task
  }
  return projected
}

function retainedFinished(task: Subtask, now: number): boolean {
  if (!isTerminalWorkStatus(deriveWorkStatus(task, now))) return false
  // The durable queue already retains finished rows for 24 h; an unknown
  // finish time is retained like the durable cleanup retains it.
  const finished = task.finishedAt ?? task.repliedAt ?? task.stoppedAt
  return finished === undefined || now - finished < FINISHED_RETENTION_MS
}

/**
 * Ticket #172: merge a bounded Work projection with finished rows the client
 * already knows, keeping the same 24 h retention as the durable store. The
 * HISTORY view needs those rows, but the scoped payload must stay bounded, so
 * retention lives on the client side of the same policy.
 */
export function mergeRetainedWork(
  projected: Record<Id, Subtask>,
  previous: Record<Id, Subtask>,
  now: number = Date.now(),
): Record<Id, Subtask> {
  const merged = { ...projected }
  for (const task of Object.values(previous)) {
    if (merged[task.id] !== undefined) continue
    if (retainedFinished(task, now)) merged[task.id] = task
  }
  return merged
}

/** Visible dispatch work plus retained finished rows for the Work HISTORY view. */
export function projectRetainedWork(
  state: SnapshotState,
  now: number = Date.now(),
  holdMs?: number,
): Record<Id, Subtask> {
  return mergeRetainedWork(projectVisibleWork(state, now, holdMs), state.subtasks, now)
}

/** Server-derived unread and busy counts; the client never scans all rows. */
export function workspaceCounts(state: SnapshotState): Record<Id, WorkspaceCounts> {
  const counts: Record<Id, WorkspaceCounts> = {}
  for (const workspace of Object.values(state.workspaces)) {
    const messages = state.messages[workspace.id] ?? []
    counts[workspace.id] = {
      unread: messages.filter((message) => message.createdAt > workspace.lastActiveAt && message.author !== "user").length,
      busy: 0,
    }
  }
  for (const task of Object.values(state.subtasks)) {
    const entry = counts[task.workspaceID]
    if (entry && task.state === "working") entry.busy++
  }
  return counts
}

/**
 * One transcript page ending before `beforeSeq` (exclusive), or the newest
 * page when omitted. `hasMoreOlder` is truthful for the durable list: the
 * next page exists when the page did not start at the first row.
 */
export function transcriptWindow(
  messages: readonly Message[],
  options: { beforeSeq?: number; limit?: number } = {},
): TranscriptWindow {
  const limit = Math.max(1, Math.min(TRANSCRIPT_WINDOW_MAX, Math.floor(options.limit ?? TRANSCRIPT_WINDOW)))
  const ordered = [...messages].sort((a, b) => a.seq - b.seq)
  const eligible = options.beforeSeq === undefined
    ? ordered
    : ordered.filter((message) => message.seq < options.beforeSeq!)
  const page = eligible.slice(-limit)
  const firstIndex = eligible.length - page.length
  return {
    messages: page,
    ...(page.length > 0 ? { oldestSeq: page[0]!.seq, newestSeq: page[page.length - 1]!.seq } : {}),
    hasMoreOlder: firstIndex > 0,
    limit,
  }
}

/**
 * Per-scope change versions let gap recovery name only the scopes whose
 * durable state moved after the client cursor. An absent map or cursor is
 * conservative: every scope resyncs.
 */
export function scopesToResync(cursorVersion: number | undefined, scopeVersions: ScopeVersions | undefined): ScopeName[] {
  const all: ScopeName[] = ["shell", "work", "transcript"]
  if (!scopeVersions || cursorVersion === undefined) return all
  return all.filter((scope) => Number(scopeVersions[scope] ?? 0) > cursorVersion)
}

/** A bounded client transcript keeps the newest rows unless a caller is paging older. */
export function trimMessages(messages: readonly Message[], limit: number, keep: "newest" | "oldest" = "newest"): Message[] {
  const bounded = Math.max(1, Math.floor(limit))
  if (messages.length <= bounded) return messages as Message[]
  return (keep === "oldest" ? messages.slice(0, bounded) : messages.slice(-bounded)) as Message[]
}
