import { deriveWorkStatus, isTerminalWorkStatus, type DerivedWorkStatus } from "../queue.ts"
import type { Subtask } from "../types.ts"
import { effectiveTick, queuedFrame, thinkingFrame, toolFrame, waitingFrame, workingFrame } from "./motion.ts"
import { askingLine, short } from "./format.ts"
import { chromeJoin, chromeSeparator } from "./separators.ts"
import {
  flatTideLevels,
  flatTideStrip,
  tideColumns,
  tideLevels,
  tideStrip,
  tideTickForCard,
  type TideFreezeState,
  type TideVariant,
} from "./tide.ts"
import { RECENT_WORK_TTL_MS } from "./work-constants.ts"

export { RECENT_WORK_TTL_MS }

/**
 * Inline work-row and Work-card mapping for the group chat surface (ticket
 * #56, slice A ticket #64, slice C ticket #59, card layout ticket #115,
 * recent cards ticket #117). The right-hand task board is gone; the WORK block
 * carries active subtasks plus recently finished cards for the workspace with
 * their assigned agent and derived lifecycle state. Terminal outcomes remain
 * the durable transcript record (see terminalAnnouncement); the card copy is
 * display-only and disappears after the recent window. Attribution lines
 * (`→ Assigned to $AgentName: <title>` events, `Asking $AgentName…` live
 * variants, `Answer from $AgentName` relay headers) are defined in format.ts
 * and wired through activityDetailForTask below and the transcript render in
 * app.tsx.
 */

/** Shared transcript window: both the DM and group surfaces keep the most
 * recent N rows. One documented bound so neither surface can drift and grow
 * scrolling cost; raising it re-verifies overlay centering and wrap width. */
export const TRANSCRIPT_WINDOW = 40

const GLYPHS: Record<DerivedWorkStatus, string> = {
  pending: "▫",
  working: "⠋",
  retrying: "⠋",
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

/** One inline row: `{glyph} {title} │ {agent} │ {status}`. Pure. */
export function workRowText(
  task: Subtask,
  agentLabel: string,
  now: number,
  opts: { pending?: PendingWorkAction | null; needsYou?: boolean } = {},
): string {
  const status = deriveWorkStatus(task, now)
  const segment = opts.pending ? pendingWorkLabel(opts.pending) : status
  const row = chromeJoin([`${workGlyph(status)} ${short(task.title || "(untitled)", 60)}`, agentLabel, segment])
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
 * and friends) render `◆` + `│ needs you │ v to resolve`, visually distinct
 * from plain pending `▫`. Derived from existing interruption/approval state
 * only — no new coordination semantics. Pure.
 */
export const NEEDS_YOU_MARK = "◆"

export function needsYouSuffix(): string {
  return ` ${chromeSeparator()} needs you ${chromeSeparator()} v to resolve`
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
 * retrying rows cycle the ten-frame Braille set; pending rows alternate the
 * calmer `▫`/`▪` waiting frames; terminal rows are static (they never render
 * in the block — see `orderedWorkItems` — but the helper stays total). Under
 * reduced motion the tick collapses to frame 0, so pending still reads `▫`
 * and working still reads `⠋`. Pure.
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
 * `asking` variant use the Braille working set; `thinking` (streaming text
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

/** True while the surface has active (non-terminal) work — the work cursor and its actions mount exactly then. */
export function hasActiveWork(tasks: Subtask[], now: number): boolean {
  return tasks.some((task) => !isTerminalWorkStatus(deriveWorkStatus(task, now)))
}

/**
 * Ticket #117: finished cards settle in the Work pane for the shared
 * eight-second recent window, then disappear. The transcript announcement
 * remains the durable record, so the card copy is allowed to be ephemeral.
 * Only a real terminal timestamp counts: legacy rows without one invent no
 * recency. `RECENT_WORK_TTL_MS` lives in work-constants.ts because the tide
 * assignment retention uses the same canonical window.
 */

/** The honest finish time for a terminal task, or undefined when none was recorded. */
export function workFinishedAt(task: Subtask): number | undefined {
  return task.finishedAt ?? task.repliedAt ?? task.stoppedAt
}

/** True while a terminal task is inside the eight-second recent-card window. */
export function isRecentWork(task: Subtask, now: number): boolean {
  if (!isTerminalWorkStatus(deriveWorkStatus(task, now))) return false
  const finished = workFinishedAt(task)
  if (finished === undefined) return false
  return now < finished + RECENT_WORK_TTL_MS
}

/** Recently finished tasks, oldest terminal first, so cards settle in finish order. */
export function recentWorkItems(tasks: Subtask[], now: number): Subtask[] {
  return tasks
    .filter((task) => isRecentWork(task, now))
    .sort((a, b) => (workFinishedAt(a) ?? 0) - (workFinishedAt(b) ?? 0) || a.createdAt - b.createdAt)
}

/** True while the Work pane still has a recent card to show after active work ends. */
export function hasRecentWork(tasks: Subtask[], now: number): boolean {
  return tasks.some((task) => isRecentWork(task, now))
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

/** Review verb for a completion delivery under review. */
export function reviewingLine(): string {
  return "reviewing…"
}

/** Review verb for a consolidated batch review turn. */
export function reviewingCompletionsLine(): string {
  return "reviewing completions…"
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

/** One live activity line: `{frame} {agent} │ {verb}`. The frame animates via the shared working frames. Pure. */
export function activityLine(agentLabel: string, verb: string, frame: string): string {
  return chromeJoin([`${frame} ${agentLabel}`, verb])
}

/** Max visible activity lines; the rest collapse into a `+N more` overflow line. */
export const MAX_VISIBLE_ACTIVITY = 3

export type ActivityEntry = { key: string; label: string; agentID?: string; taskID?: string; createdAt: number; verb: string; kind: ActivityVerbKind }

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
  // Ticket #74: completion/batch-review work is review work, never generic
  // activity. A live batch turn reads `reviewing completions…` (not a
  // self-`Waiting for $Leader…` when waiter and reviewer are the same
  // agent); a completion delivery reads `reviewing…`. Pending hops are
  // queued under the leader's key, so these verbs only display while live.
  if (task.handoff?.batch === true) {
    return { verb: reviewingCompletionsLine(), kind: "working" }
  }
  if (task.handoff?.completion === true) {
    return { verb: reviewingLine(), kind: "working" }
  }
  const liveChildren = ctx.children.filter(
    (child) => child.parentID === task.id && !isTerminalWorkStatus(deriveWorkStatus(child, ctx.now)),
  )
  if (task.awaitingChildren || liveChildren.length > 0) {
    const firstAssignee = liveChildren.map((child) => child.assigneeID).find((id) => id !== undefined)
    const name = firstAssignee ? ctx.agentNameFor(firstAssignee) : undefined
    if (name && firstAssignee !== task.assigneeID) return { verb: waitingForLine(name), kind: "waiting" }
    // Ticket #74: never self-wait (`Waiting for $Leader…` when the waiter
    // is the leader). Same-assignee children mean the turn is still active,
    // so read honest `working…` instead of naming oneself.
    if (name) return { verb: workingLine(), kind: "working" }
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

/** True while a streaming/transcript live row has seen no delta or finalize
 * for the staleness bound — a leaked row that must never wedge the
 * activity line. The clock is the last write (heartbeat), not creation, so
 * long live streams stay visible while fresh and orphaned rows expire
 * promptly. Pure. */
export function isActivityStale(entry: { createdAt: number; updatedAt?: number }, now: number): boolean {
  return now - (entry.updatedAt ?? entry.createdAt) > ACTIVITY_STALE_AFTER_MS
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
 * Split active agents into live (working/retrying/waiting) and queued-only
 * (pending with no wait), oldest first, deduplicated. Terminal work
 * contributes to neither — it is announced, not listed. User-blocked pending
 * work (approval-gated, interrupted, native-blocked) is waiting, not parked,
 * so it joins live with the waiting-for-you verb; genuinely queued work
 * stays queued. Stale claims (lapsed leases) contribute to neither either:
 * a stuck line is hidden from the activity
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
    const needsYou = isNeedsYouTask(task, pendingApprovalIDs, nativeBlockedIDs)
    const detail = activityStateForTask(task, {
      now,
      pendingApprovalIDs,
      nativeBlockedIDs,
      children,
      agentNameFor,
    })
    const entry: ActivityEntry = { key: keyFor(task), label, agentID: task.assigneeID, taskID: task.id, createdAt: task.createdAt, verb: detail.verb, kind: detail.kind }
    // User-blocked work is waiting, not parked: approval-gated,
    // interrupted, and native-blocked tasks read the waiting-for-you verb
    // in live even while their derived queue status is still pending.
    // Genuinely queued work (pending with no wait) stays queued.
    const bucket = status === "pending" && !needsYou ? queuedByKey : liveByKey
    const previous = bucket.get(entry.key)
    if (!previous || entry.createdAt < previous.createdAt) bucket.set(entry.key, entry)
  }
  for (const key of liveByKey.keys()) queuedByKey.delete(key)
  const byAge = (a: ActivityEntry, b: ActivityEntry) => a.createdAt - b.createdAt
  return { live: [...liveByKey.values()].sort(byAge), queued: [...queuedByKey.values()].sort(byAge) }
}

/**
 * Ticket #115 follow-up: a visible Work card already carries the task's
 * honest detail, so the matching task-backed activity line must not render a
 * second time. Streaming-only rows are added later and have no taskID, so
 * they are never suppressed here; queued tasks without a card keep their
 * queued line. Pure.
 */
export function suppressCardedActivity(
  groups: { live: ActivityEntry[]; queued: ActivityEntry[] },
  cardTaskIDs: ReadonlySet<string>,
): { live: ActivityEntry[]; queued: ActivityEntry[] } {
  if (cardTaskIDs.size === 0) return groups
  const keep = (entry: ActivityEntry) => entry.taskID === undefined || !cardTaskIDs.has(entry.taskID)
  return { live: groups.live.filter(keep), queued: groups.queued.filter(keep) }
}

/**
 * Ticket #117: the Work header names both live and recently finished work.
 * The block stays mounted while either count is non-zero, so a pane holding
 * only recent cards still tells the user nothing is running.
 */
export function workSummaryCounts(activeCount: number, recentCount: number): string {
  const active = Math.max(0, Math.floor(activeCount))
  const recent = Math.max(0, Math.floor(recentCount))
  if (active === 0 && recent === 0) return chromeJoin(["WORK", "none yet"])
  return `WORK ${active} active · ${recent} recent`
}

/**
 * Ticket #115: the Work pane's card model. One card carries the agent, the
 * animated Braille state glyph, the state word, a truncated title, an honest
 * detail line, and the full-width one-row tide strip. This is a pure mapping
 * over one active subtask; ordering and active-only filtering stay in
 * `workCardsForTasks`.
 */
export type WorkCard = {
  id: string
  agent: string
  glyph: string
  state: string
  title: string
  detail: string
  status: DerivedWorkStatus
  needsYou: boolean
  /** Ticket #117: a recently finished card that is display-only, never a cursor target. */
  recent: boolean
  /** Stable tide motion for this subtask's active lifetime. */
  tideVariant: TideVariant
  /** Rendered one-row strip: one glyph plus one blank per tide column. */
  tide: string
  /** One sampled level per tide column, used for per-cell theme colors. */
  tideLevels: readonly number[]
}

export type WorkCardOptions = {
  now: number
  /** Braille chrome clock tick (4 fps). */
  tick: number
  /** Work-card tide clock tick (10 fps); defaults to `tick`. */
  tideTick?: number
  /** Card content width in terminal cells. */
  width: number
  env?: NodeJS.ProcessEnv
  pendingApprovalIDs?: ReadonlySet<string>
  nativeBlockedSubtaskIDs?: ReadonlySet<string>
  pendingFor?: (task: Subtask) => PendingWorkAction | null | undefined
  detailFor?: (task: Subtask) => string | undefined
  /** Fixed variant override; assignment callers should use `variantFor`. */
  variant?: TideVariant
  /** Stable per-subtask assignment, resolved once on first sight. */
  variantFor?: (task: Subtask) => TideVariant
  /** Freeze frames for cards that started waiting on the user. */
  freezeState?: TideFreezeState
  /** Recent cards share this mapping but are display-only and never needs-you. */
  recent?: boolean
}

/**
 * The card detail line stays honest: in-flight actions win, user-blocked work
 * says so, parked work is queued (never a fake live verb), and working work
 * uses the caller's activity verb when one exists. Pure.
 */
export function workCardDetail(
  status: DerivedWorkStatus,
  opts: { pending?: PendingWorkAction | null; needsYou?: boolean; activity?: string } = {},
): string {
  if (opts.pending) return pendingWorkLabel(opts.pending)
  if (opts.needsYou) return waitingForYouLine()
  switch (status) {
    case "pending":
      return "queued"
    case "retrying":
      return retryingLine()
    case "working":
      return opts.activity?.trim() || workingLine()
    default:
      return workStatusLabel(status)
  }
}

const NO_TASK_IDS: ReadonlySet<string> = new Set<string>()

export function workCardForTask(task: Subtask, agentLabel: string, options: WorkCardOptions): WorkCard {
  const status = deriveWorkStatus(task, options.now)
  const recent = options.recent ?? false
  // A recent card is display-only: the terminal state owns the glyph and
  // detail, and an old interruption/approval must not revive needs-you.
  const needsYou = recent
    ? false
    : isNeedsYouTask(
        task,
        options.pendingApprovalIDs ?? NO_TASK_IDS,
        options.nativeBlockedSubtaskIDs ?? NO_TASK_IDS,
      )
  const pending = recent ? null : options.pendingFor?.(task) ?? null
  const width = Math.max(16, Math.floor(options.width))
  const textWidth = Math.max(8, width - 2)
  const variant = options.variantFor?.(task) ?? options.variant ?? "current"
  const tideTick = tideTickForCard(
    status,
    needsYou,
    options.tideTick ?? options.tick,
    options.env,
    options.freezeState ? { state: options.freezeState, id: task.id, now: options.now } : undefined,
  )
  const settled = isTerminalWorkStatus(status)
  return {
    id: task.id,
    agent: short(agentLabel, Math.max(8, width - 16)),
    glyph: needsYou ? NEEDS_YOU_MARK : workRowFrame(status, options.tick, options.env),
    state: needsYou ? "needs you" : workStatusLabel(status),
    title: short(task.title || "(untitled)", textWidth),
    detail: short(workCardDetail(status, { pending, needsYou, activity: options.detailFor?.(task) }), textWidth),
    status,
    needsYou,
    recent,
    tideVariant: variant,
    tide: settled ? flatTideStrip(width) : tideStrip(variant, width, tideTick, options.env),
    tideLevels: settled ? flatTideLevels(tideColumns(width)) : tideLevels(variant, tideColumns(width), tideTick, options.env),
  }
}

/** Active cards in the existing work-row order (working first, oldest first). */
export function workCardsForTasks(
  tasks: Subtask[],
  agentLabelFor: (task: Subtask) => string,
  options: WorkCardOptions,
): WorkCard[] {
  return orderedWorkItems(tasks, options.now).map((task) => workCardForTask(task, agentLabelFor(task), options))
}

/**
 * Ticket #117: recently finished cards. They keep the fixed terminal glyph and
 * state word, carry a flat settled strip, and are display-only — the work
 * cursor and every work action are built from `workCardsForTasks`, never from
 * this set. Oldest finish first, matching the transcript announcement order.
 */
export function recentWorkCardsForTasks(
  tasks: Subtask[],
  agentLabelFor: (task: Subtask) => string,
  options: WorkCardOptions,
): WorkCard[] {
  return recentWorkItems(tasks, options.now).map((task) =>
    workCardForTask(task, agentLabelFor(task), { ...options, recent: true }),
  )
}

/** One card row: header, title, detail, tide, plus the rounded border. */
export const WORK_CARD_ROWS = 6
export const WORK_CARD_GAP_ROWS = 1
/** Section header plus the key-hint row in card mode. */
export const WORK_BLOCK_CHROME_ROWS = 2
/**
 * Rows outside the Work block in the default 120×40 composition: outer
 * padding, header, gaps, statusline, chat border/padding, surface title,
 * composer, and composer hint. Used to reserve transcript space when choosing
 * the card count.
 */
export const WORK_BASE_ROWS = 13
/** Minimum transcript rows kept above the Work block. */
export const WORK_TRANSCRIPT_RESERVE = 4

export type WorkCardLayout = {
  mode: "cards" | "compact"
  /** Visible card/row count. */
  limit: number
  overflow: number
  /** Rows the Work block consumes, including header, gaps, and overflow. */
  rows: number
}

function cardBlockRows(cards: number, overflow: number): number {
  return (
    cards * WORK_CARD_ROWS +
    Math.max(0, cards - 1) * WORK_CARD_GAP_ROWS +
    WORK_BLOCK_CHROME_ROWS +
    (overflow > 0 ? 1 : 0)
  )
}

function compactLimit(terminalHeight: number): number {
  return terminalHeight >= 27 ? 2 : 1
}

/**
 * Pick the card count that fits the terminal height while reserving transcript
 * rows. Tall terminals show three cards, medium two, short one, and below the
 * minimum card height the Work pane falls back to compact one-line rows (with
 * no inline hint row). Ticket #117: active and recent cards share the same
 * height budget; callers render active cards first, so overflow never pushes
 * live work out of the visible slots first. Pure.
 */
export function workCardLayout(terminalHeight: number, activeCount: number, recentCount = 0): WorkCardLayout {
  const total = Math.max(0, Math.floor(activeCount)) + Math.max(0, Math.floor(recentCount))
  if (total === 0) return { mode: "compact", limit: 0, overflow: 0, rows: 0 }
  const available = Math.max(0, terminalHeight - WORK_BASE_ROWS)
  for (const count of [3, 2, 1] as const) {
    if (total < count) continue
    const overflow = total - count
    const rows = cardBlockRows(count, overflow)
    if (rows + WORK_TRANSCRIPT_RESERVE <= available) {
      return { mode: "cards", limit: count, overflow, rows }
    }
  }
  const limit = Math.min(total, compactLimit(terminalHeight))
  return { mode: "compact", limit, overflow: total - limit, rows: 1 + limit }
}

/**
 * Ticket #115/#117: the work cursor and every work action target only the
 * visible prefix. Active work is ordered before recent cards, so the first
 * `limit` rows are the visible active cards; overflow and recent cards stay
 * display-only. No action can reach an off-screen task.
 */
export function visibleWorkTasks<T>(ordered: readonly T[], layout: WorkCardLayout): T[] {
  return ordered.slice(0, Math.max(0, Math.floor(layout.limit)))
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

/**
 * Merge task-less streaming transcript rows into the live activity list
 * (ticket #74). A fresh streaming row with no task-backed entry for its
 * agent reads honest `working…` — never the generic `checking the details…`
 * — and only while a live run or recent delta exists. Stale orphans
 * (no heartbeat within the bound) and agents already covered by a
 * task-backed entry contribute nothing, so finished turns leave no ghost
 * line behind. Pure.
 */
export function mergeStreamingActivity(
  live: ActivityEntry[],
  lines: Array<{ agentID?: string; author: string; createdAt: number; updatedAt?: number }>,
  now: number,
): ActivityEntry[] {
  const merged = [...live]
  for (const line of lines) {
    // Leaked streaming rows never wedge the activity line: a live row with
    // no heartbeat inside the bound is stuck, not live.
    if (isActivityStale(line, now)) continue
    const key = line.agentID ?? `author:${line.author}`
    if (merged.some((entry) => entry.key === key)) continue
    merged.push({
      key,
      label: line.author,
      agentID: line.agentID,
      createdAt: line.createdAt,
      verb: workingLine(),
      kind: "working",
    })
  }
  return merged
}
