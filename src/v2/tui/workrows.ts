import { deriveWorkStatus, isTerminalWorkStatus, type DerivedWorkStatus } from "../queue.ts"
import type { Subtask } from "../types.ts"
import { short } from "./format.ts"

/**
 * Inline work-row mapping for the group chat surface (ticket #56). The
 * right-hand task board is gone; each subtask renders here with its assigned
 * agent and derived lifecycle state. Plain attribution only — the `Assigned
 * to $Agent` / `Asking $Agent…` / `Answer from $Agent` copy belongs to the
 * v5.4 ticket and must not be introduced here.
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

/** Active work first (working/retrying, then pending, oldest first), then the most recent terminal rows, capped. */
export function orderedWorkItems(tasks: Subtask[], now: number, terminalLimit = 10): Subtask[] {
  const statusOf = (task: Subtask) => deriveWorkStatus(task, now)
  const active = tasks
    .filter((task) => !isTerminalWorkStatus(statusOf(task)))
    .sort((a, b) => {
      const rank = (task: Subtask) => (statusOf(task) === "pending" ? 1 : 0)
      return rank(a) - rank(b) || a.createdAt - b.createdAt
    })
  const terminal = tasks
    .filter((task) => isTerminalWorkStatus(statusOf(task)))
    .sort((a, b) => (b.finishedAt ?? b.repliedAt ?? b.createdAt) - (a.finishedAt ?? a.repliedAt ?? a.createdAt))
    .slice(0, Math.max(0, terminalLimit))
  return [...active, ...terminal]
}

/** Counts line for the inline work section; omits zero buckets. */
export function workSummary(tasks: Subtask[], now: number): string {  if (tasks.length === 0) return "WORK · none yet"
  const counts = new Map<DerivedWorkStatus, number>()
  for (const task of tasks) {
    const status = deriveWorkStatus(task, now)
    counts.set(status, (counts.get(status) ?? 0) + 1)
  }
  const order: DerivedWorkStatus[] = ["working", "retrying", "pending", "replied", "failed", "cancelled"]
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
