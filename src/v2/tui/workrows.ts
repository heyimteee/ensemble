import { deriveWorkStatus, isTerminalWorkStatus, type DerivedWorkStatus } from "../queue.ts"
import type { Subtask } from "../types.ts"
import { effectiveTick, queuedFrame, thinkingFrame, toolFrame, waitingFrame, workingFrame } from "./motion.ts"
import { askingLine, short } from "./format.ts"

/**
 * Inline work-row mapping for the group chat surface (ticket #56, slice A
 * ticket #64, slice C ticket #59). The right-hand task board is gone; the
 * WORK block carries only active subtasks for the workspace with their
 * assigned agent and derived lifecycle state. Terminal outcomes never render
 * here — they are announced once as transcript system lines (see
 * terminalAnnouncement). Attribution lines (`→ Assigned to $AgentName: <title>`
 * events, `Asking $AgentName…` live variants, `Answer from $AgentName` relay
 * headers) are defined in format.ts and wired through activityDetailForTask
 * below and the transcript render in app.tsx.
 */

/** Shared transcript window: both the DM and group surfaces keep the most
 * recent N rows. One documented bound so neither surface can drift and grow
 * scrolling cost; raising it re-verifies overlay centering and wrap width. */
export const TRANSCRIPT_WINDOW = 40

const GLYPHS: Record<DerivedWorkStatus, string> = {
  pending: "○",
  working: "◐",
  retrying: "◐",
  replied: "●",
  failed: "✕",
  cancelled: "⊘",
}

export function workGlyph(status: DerivedWorkStatus): string {
  return GLYPHS[status]
}

export function workStatusLabel(status: DerivedWorkStatus): string {
  return status
}

/** One inline row: `{glyph} {title} · {agent} · {status}`. Pure. */
export function workRowText(
  task: Subtask,
  agentLabel: string,
  now: number,
  opts: { pending?: PendingWorkAction | null; needsYou?: boolean } = {},
): string {
  const status = deriveWorkStatus(task, now)
  const segment = opts.pending ? pendingWorkLabel(opts.pending) : status
  const row = `${workGlyph(status)} ${short(task.title || "(untitled)", 60)} · ${agentLabel} · ${segment}`
  if (!opts.needsYou) return row
  return `${NEEDS_YOU_MARK} ${row}${needsYouSuffix()}`
}

/**
 * In-flight work-action labels (brief §2.8/`Stopping…` pattern, ticket
 * acceptance row 19): while a Stop/Cancel (or analogous retry/restart) RPC
 * is in flight the row shows the interim label instead of the derived
 * status, until the terminal state arrives. Callers clear the pending action
 * in a finally so no row can stick on the interim label. Pure.
 */
export type PendingWorkAction = "stop" | "cancel" | "retry" | "restart"

export function pendingWorkLabel(action: PendingWorkAction): string {
  switch (action) {
    case "stop":
      return "Stopping…"
    case "cancel":
      return "Cancelling…"
    case "retry":
      return "Retrying…"
    case "restart":
      return "Restarting…"
  }
}

/**
 * Distinct attention marker for work blocked on the user (brief §2.2/`needs
 * you` amber override): interrupted runs and approval-gated work (ask_person
 * and friends) render `◆` + `· needs you · v to resolve`, visually distinct
 * from plain pending `○`. Derived from existing interruption/approval state
 * only — no new coordination semantics. Pure.
 */
export const NEEDS_YOU_MARK = "◆"

export function needsYouSuffix(): string {
  return " · needs you · v to resolve"
}

/** True while the task waits on the user: interrupted, gated on a still-pending approval, or blocked by a native permission mirror. */
export function isNeedsYouTask(task: Subtask, pendingApprovalIDs: ReadonlySet<string>, nativeBlockedSubtaskIDs: ReadonlySet<string> = new Set()): boolean {
  if (task.interrupted) return true
  if (task.approvalID && pendingApprovalIDs.has(task.approvalID)) return true
  if (nativeBlockedSubtaskIDs.has(task.id)) return true
  return false
}

/**
 * Animated liveness suffix for a WORK row at a tick (brief §4). Working and
 * retrying rows cycle the working spinner; pending rows alternate the calmer
 * waiting frames; terminal rows are static (they never render in the block —
 * see `orderedWorkItems` — but the helper stays total). Under reduced motion
 * the tick collapses to frame 0, so pending still reads `○` and working
 * still reads `◐`. Pure.
 */
export function workRowFrame(status: DerivedWorkStatus, tick: number, env: NodeJS.ProcessEnv = process.env): string {
  const frame = effectiveTick(tick, env)
  switch (status) {
    case "working":
    case "retrying":
      return workingFrame(frame)
    case "pending":
      return waitingFrame(frame)
    default:
      return workGlyph(status)
  }
}

/**
 * Frame for an activity verb kind at a tick (brief §4). Tool-kind verbs
 * (reading/searching/running/writing) nudge the tool chevron; `waiting`
 * alternates the calm waiting frames; `checking`/`wrapping` and the peer-turn
 * `asking` variant use the working spinner; `thinking` (streaming text
 * arriving, OpenBot's gap-filler) uses the textual shimmer cells.
 * Queued-behind-live lines never call this — they render the static
 * `queuedFrame()`. Under reduced motion every kind pins to its frame 0.
 * Pure.
 */
export function activityFrameForKind(kind: ActivityVerbKind, tick: number, env: NodeJS.ProcessEnv = process.env): string {
  const frame = effectiveTick(tick, env)
  switch (kind) {
    case "reading":
    case "searching":
    case "running":
    case "writing":
      return toolFrame(frame)
    case "waiting":
      return waitingFrame(frame)
    case "thinking":
      return thinkingFrame(frame)
    case "asking":
    case "checking":
    case "wrapping":
    case "working":
      return workingFrame(frame)
    case "retrying":
      return waitingFrame(frame)
  }
}

/** Static mark for queued-behind-live activity lines. Never animated. */
export function queuedActivityFrame(): string {
  return queuedFrame()
}

/** Active work first: working/retrying, then pending, oldest first. Terminal rows never render here. */
export function orderedWorkItems(tasks: Subtask[], now: number): Subtask[] {
  const statusOf = (task: Subtask) => deriveWorkStatus(task, now)
  return tasks
    .filter((task) => !isTerminalWorkStatus(statusOf(task)))
    .sort((a, b) => {
      const rank = (task: Subtask) => (statusOf(task) === "pending" ? 1 : 0)
      return rank(a) - rank(b) || a.createdAt - b.createdAt
    })
}

/** True while the surface has active (non-terminal) work — the WORK block mounts exactly then. */
export function hasActiveWork(tasks: Subtask[], now: number): boolean {
  return tasks.some((task) => !isTerminalWorkStatus(deriveWorkStatus(task, now)))
}

/** One terminal outcome announced once as a transcript system line. Non-terminal work announces nothing. */
export function terminalAnnouncement(task: Subtask, agentLabel: string, now: number): string | undefined {
  const status = deriveWorkStatus(task, now)
  if (status === "replied") return `● ${agentLabel} finished: ${short(task.title || "(untitled)", 60)}`
  if (status === "failed") return `✕ ${agentLabel} failed: ${short(task.error || task.title || "(unknown reason)", 80)}`
  if (status === "cancelled") return `⊘ ${short(task.title || "(untitled)", 60)} cancelled`
  return undefined
}

/** Every terminal task contributes exactly one announcement, oldest-terminal first. Pure. */
export function terminalAnnouncements(
  tasks: Subtask[],
  agentLabelFor: (task: Subtask) => string,
  now: number,
): Array<{ id: string; text: string }> {
  return tasks
    .filter((task) => isTerminalWorkStatus(deriveWorkStatus(task, now)))
    .sort(
      (a, b) =>
        (a.finishedAt ?? a.repliedAt ?? a.createdAt) - (b.finishedAt ?? b.repliedAt ?? b.createdAt),
    )
    .flatMap((task) => {
      const text = terminalAnnouncement(task, agentLabelFor(task), now)
      return text === undefined ? [] : [{ id: task.id, text }]
    })
}

/** Per-agent live activity verbs (brief §3.2, ticket #70). The generic
 * default is reserved for genuinely unknown activity — never the universal
 * verb. Working reads `working…` (with detail when available), agent waits
 * read `Waiting for $Name…`, user waits read `waiting for you…`, backoff
 * reads `retrying…`; never invent tool names. */
export const ACTIVITY_DEFAULT_VERB = "checking the details…"

/** After this long without a heartbeat/lease, a live line is stuck, not live. */
export const ACTIVITY_STALE_AFTER_MS = 120_000

export type ActivityVerbKind = "checking" | "reading" | "searching" | "running" | "writing" | "waiting" | "wrapping" | "asking" | "thinking" | "working" | "retrying"

/** Visible wait for another agent. `$Name` grammar throughout, never `@`. */
export function waitingForLine(agentName: string): string {
  return `Waiting for $${agentName}…`
}

/** Visible wait for the user (approval-gated or native-blocked). */
export function waitingForYouLine(): string {
  return "waiting for you…"
}

/** Live work verb: detail when known, honest `working…` otherwise. */
export function workingLine(detail?: string): string {
  const target = detail?.trim()
  return target ? `working on ${target}…` : "working…"
}

/** Backoff verb: parked work never poses as live work. */
export function retryingLine(): string {
  return "retrying…"
}

/** Build a present-participle verb phrase. Detail-less tool verbs fall back to the default. */
export function activityVerb(kind: ActivityVerbKind, detail?: string): string {
  const target = detail?.trim()
  switch (kind) {
    case "checking":
      return ACTIVITY_DEFAULT_VERB
    case "reading":
      return target ? `reading ${target}…` : ACTIVITY_DEFAULT_VERB
    case "searching":
      return target ? `searching ${target}…` : ACTIVITY_DEFAULT_VERB
    case "running":
      return target ? `running ${target}…` : ACTIVITY_DEFAULT_VERB
    case "writing":
      return target ? `writing ${target}…` : ACTIVITY_DEFAULT_VERB
    case "waiting":
      return target ? `waiting on ${target}…` : ACTIVITY_DEFAULT_VERB
    case "wrapping":
      return "wrapping up…"
    case "asking":
      return target ? askingLine(target) : ACTIVITY_DEFAULT_VERB
    case "thinking":
      return ACTIVITY_DEFAULT_VERB
    case "working":
      return workingLine(detail)
    case "retrying":
      return retryingLine()
  }
}

/** One live activity line: `{frame} {agent} · {verb}`. The frame animates via the shared working frames. Pure. */
export function activityLine(agentLabel: string, verb: string, frame: string): string {
  return `${frame} ${agentLabel} · ${verb}`
}

/** Max visible activity lines; the rest collapse into a `+N more` overflow line. */
export const MAX_VISIBLE_ACTIVITY = 3

export type ActivityEntry = { key: string; label: string; agentID?: string; createdAt: number; verb: string; kind: ActivityVerbKind }

/**
 * Per-agent live display for one active task (slice C + ticket #70):
 * approval-gated and native-blocked work reads as waiting-for-user, a
 * parent awaiting children reads `Waiting for $Name…`, peer-turn and
 * handoff hops in flight keep the `Asking $Name…` variant, backoff reads
 * `retrying…`, live work reads `working…`, and the generic default is
 * reserved for genuinely unknown activity. Pure.
 *
 * `children` carries the task's non-terminal children (callers derive them
 * from the snapshot); `agentNameFor` resolves a child assignee to a display
 * name for the waiting line. Stale claims never reach here — see
 * `isActivityTaskStale` and the `splitActivityGroups` filter below.
 */
export type ActivityStateContext = {
  now: number
  pendingApprovalIDs: ReadonlySet<string>
  nativeBlockedIDs: ReadonlySet<string>
  children: Subtask[]
  agentNameFor: (agentID?: string) => string
}

export function activityStateForTask(
  task: Subtask,
  ctx: ActivityStateContext,
): { verb: string; kind: ActivityVerbKind } {
  if (isNeedsYouTask(task, ctx.pendingApprovalIDs, ctx.nativeBlockedIDs)) {
    return { verb: waitingForYouLine(), kind: "waiting" }
  }
  const liveChildren = ctx.children.filter(
    (child) => child.parentID === task.id && !isTerminalWorkStatus(deriveWorkStatus(child, ctx.now)),
  )
  if (task.awaitingChildren || liveChildren.length > 0) {
    const firstAssignee = liveChildren.map((child) => child.assigneeID).find((id) => id !== undefined)
    const name = firstAssignee ? ctx.agentNameFor(firstAssignee) : undefined
    if (name) return { verb: waitingForLine(name), kind: "waiting" }
    return { verb: ACTIVITY_DEFAULT_VERB, kind: "checking" }
  }
  if (deriveWorkStatus(task, ctx.now) === "retrying") return { verb: retryingLine(), kind: "retrying" }
  if (task.workKind === "turn" || task.workKind === "handoff") {
    return { verb: askingLine(ctx.agentNameFor(task.assigneeID)), kind: "asking" }
  }
  if (deriveWorkStatus(task, ctx.now) === "working") return { verb: workingLine(), kind: "working" }
  return { verb: ACTIVITY_DEFAULT_VERB, kind: "checking" }
}

/**
 * Per-agent live display for one active task (slice C): peer-turn and
 * handoff work in flight renders the `Asking $Name…` variant; all other
 * live work keeps the default checking verb. Pure.
 *
 * Kept for existing callers; new code prefers `activityStateForTask`,
 * which threads approval/native-blocked sets and child waits so blocked
 * work never poses as live work.
 */
export function activityDetailForTask(task: Subtask, label: string): { verb: string; kind: ActivityVerbKind } {
  if (task.workKind === "turn" || task.workKind === "handoff") return { verb: askingLine(label), kind: "asking" }
  return { verb: ACTIVITY_DEFAULT_VERB, kind: "checking" }
}

/** True while a task-backed activity claim has lapsed: claimed but the
 * lease expired (the heartbeat owns live claims), so the line is stuck,
 * not live. Unclaimed pending work is queued, never stale. Pure. */
export function isActivityTaskStale(task: Subtask, now: number): boolean {
  const status = deriveWorkStatus(task, now)
  if (status !== "working" && status !== "retrying") return false
  if (!task.claimedBy) return false
  return task.leaseUntil === undefined || task.leaseUntil <= now
}

/** True while a streaming/transcript live row is older than the staleness
 * bound with no finalize — a leaked row that must never wedge the
 * activity line. Pure. */
export function isActivityStale(entry: { createdAt: number }, now: number): boolean {
  return now - entry.createdAt > ACTIVITY_STALE_AFTER_MS
}

/**
 * Oldest-live agents first, deduplicated by key, capped with an overflow
 * count. Pure.
 */
export function selectActivityAgents(
  entries: ActivityEntry[],
  limit: number = MAX_VISIBLE_ACTIVITY,
): { shown: string[]; overflow: number } {
  const seen = new Map<string, ActivityEntry>()
  for (const entry of entries) {
    const previous = seen.get(entry.key)
    if (!previous || entry.createdAt < previous.createdAt) seen.set(entry.key, entry)
  }
  const ordered = [...seen.values()].sort((a, b) => a.createdAt - b.createdAt)
  return { shown: ordered.slice(0, limit).map((entry) => entry.label), overflow: Math.max(0, ordered.length - limit) }
}

/**
 * Split active agents into live (working/retrying) and queued-only (pending
 * with no live work), oldest first, deduplicated. Terminal work contributes
 * to neither — it is announced, not listed. Stale claims (lapsed leases)
 * contribute to neither either: a stuck line is hidden from the activity
 * surface instead of hanging forever; the WORK block still lists the row
 * with its derived status, so nothing silently drops. Pure.
 *
 * `opts` threads the ticket #68 native-blocked set plus the pending
 * approval set so blocked work derives as waiting-for-user, and an
 * assignee-name resolver so parents awaiting children name who they wait
 * on. Callers without that context keep the legacy checking behavior.
 */
export function splitActivityGroups(
  tasks: Subtask[],
  keyFor: (task: Subtask) => string,
  labelFor: (task: Subtask) => string,
  now: number,
  opts: {
    pendingApprovalIDs?: ReadonlySet<string>
    nativeBlockedIDs?: ReadonlySet<string>
    agentNameFor?: (agentID?: string) => string
  } = {},
): { live: ActivityEntry[]; queued: ActivityEntry[] } {
  const pendingApprovalIDs = opts.pendingApprovalIDs ?? new Set<string>()
  const nativeBlockedIDs = opts.nativeBlockedIDs ?? new Set<string>()
  const agentNameFor = opts.agentNameFor ?? ((agentID?: string) => {
    const found = tasks.find((task) => task.assigneeID === agentID)
    return found ? labelFor(found) : "Unknown agent"
  })
  const liveByKey = new Map<string, ActivityEntry>()
  const queuedByKey = new Map<string, ActivityEntry>()
  for (const task of tasks) {
    const status = deriveWorkStatus(task, now)
    if (isTerminalWorkStatus(status)) continue
    if (isActivityTaskStale(task, now)) continue
    const label = labelFor(task)
    const children = tasks.filter((child) => child.parentID === task.id)
    const detail = activityStateForTask(task, {
      now,
      pendingApprovalIDs,
      nativeBlockedIDs,
      children,
      agentNameFor,
    })
    const entry: ActivityEntry = { key: keyFor(task), label, agentID: task.assigneeID, createdAt: task.createdAt, verb: detail.verb, kind: detail.kind }
    const bucket = status === "pending" ? queuedByKey : liveByKey
    const previous = bucket.get(entry.key)
    if (!previous || entry.createdAt < previous.createdAt) bucket.set(entry.key, entry)
  }
  for (const key of liveByKey.keys()) queuedByKey.delete(key)
  const byAge = (a: ActivityEntry, b: ActivityEntry) => a.createdAt - b.createdAt
  return { live: [...liveByKey.values()].sort(byAge), queued: [...queuedByKey.values()].sort(byAge) }
}
/** Counts line for the active-work section; omits zero buckets and terminal states. */
export function workSummary(tasks: Subtask[], now: number): string {
  const active = tasks.filter((task) => !isTerminalWorkStatus(deriveWorkStatus(task, now)))
  if (active.length === 0) return "WORK · none yet"
  const counts = new Map<DerivedWorkStatus, number>()
  for (const task of active) {
    const status = deriveWorkStatus(task, now)
    counts.set(status, (counts.get(status) ?? 0) + 1)
  }
  const order: DerivedWorkStatus[] = ["working", "retrying", "pending"]
  const parts = order
    .filter((status) => (counts.get(status) ?? 0) > 0)
    .map((status) => `${counts.get(status)} ${status}`)
  return `WORK · ${parts.join(" · ")}`
}

/**
 * Partition transcript lines into finalized and live (streaming) rows.
 * One id renders in exactly one partition, so concurrent live items each
 * keep their own row while active and fold into the transcript in place on
 * finalize — no duplicates, no stale lines. Order is preserved within each
 * partition. Pure.
 */
export function splitLiveFinalized<T extends { id: string; streaming?: boolean }>(
  lines: T[],
): { finalized: T[]; live: T[] } {
  const finalized: T[] = []
  const live: T[] = []
  for (const line of lines) {
    if (line.streaming) live.push(line)
    else finalized.push(line)
  }
  return { finalized, live }
}
