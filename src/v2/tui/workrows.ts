import { deriveWorkStatus, isTerminalWorkStatus, type DerivedWorkStatus } from "../queue.ts"
import type { Subtask } from "../types.ts"
import { effectiveTick, queuedFrame, toolFrame, waitingFrame, workingFrame } from "./motion.ts"
import { short } from "./format.ts"

/**
 * Inline work-row mapping for the group chat surface (ticket #56, slice A
 * ticket #64). The right-hand task board is gone; the WORK block carries only
 * active subtasks for the workspace with their assigned agent and derived
 * lifecycle state. Terminal outcomes never render here — they are announced
 * once as transcript system lines (see terminalAnnouncement). Plain
 * attribution only — the `Assigned to $Agent` / `Asking $Agent…` / `Answer
 * from $Agent` copy belongs to the v5.4 ticket and must not be introduced
 * here.
 */

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
export function workRowText(task: Subtask, agentLabel: string, now: number): string {
  const status = deriveWorkStatus(task, now)
  return `${workGlyph(status)} ${short(task.title || "(untitled)", 60)} · ${agentLabel} · ${status}`
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
 * alternates the calm waiting frames; `checking`/`wrapping` and the default
 * use the working spinner. Queued-behind-live lines never call this — they
 * render the static `queuedFrame()`. Under reduced motion every kind pins to
 * its frame 0. Pure.
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
    case "checking":
    case "wrapping":
      return workingFrame(frame)
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

/** Per-agent live activity verbs (brief §3.2). Unknown activity uses the default; never invent tool names. */
export const ACTIVITY_DEFAULT_VERB = "checking the details…"

export type ActivityVerbKind = "checking" | "reading" | "searching" | "running" | "writing" | "waiting" | "wrapping"

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
  }
}

/** One live activity line: `{frame} {agent} · {verb}`. The frame animates via the shared working frames. Pure. */
export function activityLine(agentLabel: string, verb: string, frame: string): string {
  return `${frame} ${agentLabel} · ${verb}`
}

/** Max visible activity lines; the rest collapse into a `+N more` overflow line. */
export const MAX_VISIBLE_ACTIVITY = 3

export type ActivityEntry = { key: string; label: string; createdAt: number }

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
 * to neither — it is announced, not listed. Pure.
 */
export function splitActivityGroups(
  tasks: Subtask[],
  keyFor: (task: Subtask) => string,
  labelFor: (task: Subtask) => string,
  now: number,
): { live: ActivityEntry[]; queued: ActivityEntry[] } {
  const liveByKey = new Map<string, ActivityEntry>()
  const queuedByKey = new Map<string, ActivityEntry>()
  for (const task of tasks) {
    const status = deriveWorkStatus(task, now)
    if (isTerminalWorkStatus(status)) continue
    const entry: ActivityEntry = { key: keyFor(task), label: labelFor(task), createdAt: task.createdAt }
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
