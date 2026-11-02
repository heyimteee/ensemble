/**
 * Ticket #67 bubble + inline-completion seam.
 *
 * Pure layout/grammar helpers behind the group-chat transcript redesign:
 * agent messages render left-aligned in filled bubbles carrying the agent's
 * categorical accent edge, user messages render right-aligned, and long
 * content wraps inside a bounded width (~72% of the chat column). System,
 * task, approval, assignment, and completion lines stay full-width and
 * unbubbled. One author-color source serves the transcript, activity lines,
 * and relays so each agent reads as the same color everywhere.
 *
 * Terminal outcomes persist as muted inline completion rows ordered with the
 * conversation (same 40-row window): callers accumulate them once per task
 * via `accumulateCompletions` and merge them into the transcript via
 * `mergeTranscriptRows`. Nothing regenerates per poll; one line per outcome.
 * No rendering here — callers wire these into the Solid tree.
 */

import type { Agent, Subtask } from "../types.ts"
import { agentColor } from "./format.ts"
import { terminalAnnouncement, TRANSCRIPT_WINDOW } from "./workrows.ts"

/** Bounded bubble width: ~72% of the chat column (ticket #67). */
export const BUBBLE_WIDTH_RATIO = 0.72

/** Pixel/cell width of a bubble for a chat column width. Never degenerate. */
export function bubbleWidth(chatWidth: number): number {
  return Math.max(20, Math.floor(chatWidth * BUBBLE_WIDTH_RATIO))
}

/**
 * Wrappable text width inside a bubble: the bounded width minus chrome
 * (side padding plus the agent accent edge). Callers pass the same chat
 * width they use for full-width rows; the default chrome covers both
 * bubble variants.
 */
export function bubbleContentWidth(chatWidth: number, chrome = 4): number {
  return Math.max(16, bubbleWidth(chatWidth) - chrome)
}

/** Which side a transcript line renders on. System lines stay full-width. */
export type BubbleSide = "left" | "right" | "full"

/** Agent messages left, user messages right, everything else full-width. */
export function bubbleSide(role: "user" | "agent" | "system"): BubbleSide {
  if (role === "agent") return "left"
  if (role === "user") return "right"
  return "full"
}

/** True for conversation lines (agent/user); system lines never bubble. */
export function isBubbledRole(role: "user" | "agent" | "system"): boolean {
  return role !== "system"
}

/**
 * The two parties of a relayed answer: the agent that answered and the
 * party asked. `asker` is null when the asker is the user (`askerIsUser`)
 * or when legacy data names nobody.
 */
export type RelayParties = { answerer: string; asker: string | null; askerIsUser: boolean }

/**
 * Resolve relay parties for a turn/handoff subtask. Pure: names come from
 * the caller-supplied lookup so this stays testable without a snapshot.
 */
export function relayPartiesForTask(
  task: Subtask,
  agentName: (id?: string) => string,
): RelayParties | undefined {
  if (task.workKind !== "turn" && task.workKind !== "handoff") return undefined
  const answererID = task.turn?.answeredByID ?? task.handoff?.answeredByID ?? task.assigneeID
  const answerer = agentName(answererID)
  if (task.workKind === "turn") {
    if (task.turn?.askerKind === "user" && !task.turn.askerID) {
      return { answerer, asker: null, askerIsUser: true }
    }
    const askerID = task.turn?.askerID
    if (!askerID) return { answerer, asker: null, askerIsUser: task.turn?.askerKind === "user" }
    return { answerer, asker: agentName(askerID), askerIsUser: false }
  }
  const senderID = task.handoff?.senderID
  if (!senderID) return { answerer, asker: null, askerIsUser: false }
  return { answerer, asker: agentName(senderID), askerIsUser: false }
}

/**
 * Unified bubble header (ticket #67): the author for plain turns, and for
 * relayed answers both the answerer and the asker. Mention grammar
 * throughout: `$Name` for agents, `you` for the user asker.
 */
export function relayHeader(parties: RelayParties): string {
  const asker = parties.askerIsUser || !parties.asker ? "you" : `$${parties.asker}`
  return `Answer from $${parties.answerer} · for ${asker}`
}

/** Head of a bubble header: relay grammar when relayed, else the author. */
export function bubbleHead(author: string, relay?: RelayParties): string {
  return relay ? relayHeader(relay) : author
}

/**
 * One author-color source for the transcript, activity lines, and relays
 * (ticket #67). Agents resolve by ID first with a roster-name fallback so
 * transcript rows (which carry IDs) and activity labels (which carry names)
 * can never disagree; the user reads green and system lines read muted.
 */
export function unifiedAuthorColor(
  line: { agentID?: string; author: string; role: "user" | "agent" | "system" },
  agents: Record<string, Agent | undefined>,
  roster: Agent[],
  colors: { accent: any; muted: any; good: any },
  categorical: readonly any[],
): any {
  if (line.role === "user") return colors.good
  if (line.role === "system") return colors.muted
  const byID = line.agentID ? agents[line.agentID] : undefined
  const index = line.agentID
    ? roster.findIndex((item) => item.id === line.agentID)
    : roster.findIndex((item) => item.name === line.author)
  const agent = byID ?? (index >= 0 ? roster[index] : undefined)
  return agentColor(agent, colors.accent, Math.max(0, index), categorical)
}

/** One terminal outcome as a muted inline transcript row. Non-terminal work maps to nothing. */
export type InlineCompletion = { id: string; text: string; at: number }

export function completionEntry(
  task: Subtask,
  agentLabel: string,
  now: number,
): InlineCompletion | undefined {
  const text = terminalAnnouncement(task, agentLabel, now)
  if (text === undefined) return undefined
  return {
    id: `done:${task.id}`,
    text,
    at: task.finishedAt ?? task.repliedAt ?? task.createdAt,
  }
}

/**
 * Persistent completion accumulator (ticket #67): fold newly-terminal tasks
 * in once keyed by task ID; never regenerate, never duplicate. Returns the
 * previous map untouched when nothing new finished, so callers can skip
 * downstream updates by reference. Pure.
 */
export function accumulateCompletions(
  previous: Map<string, InlineCompletion>,
  tasks: Subtask[],
  agentLabelFor: (task: Subtask) => string,
  now: number,
): Map<string, InlineCompletion> {
  let next: Map<string, InlineCompletion> | undefined
  for (const task of tasks) {
    if (previous.has(task.id) || next?.has(task.id)) continue
    const entry = completionEntry(task, agentLabelFor(task), now)
    if (!entry) continue
    if (!next) next = new Map(previous)
    next.set(task.id, entry)
  }
  return next ?? previous
}

/** One row of the merged transcript: either a conversation line or a completion. Exactly one side is set. */
export type MergedRow<T> = { id: string; at: number; message?: T; completion?: InlineCompletion }

/**
 * Merge conversation lines with inline completions into one time-ordered
 * transcript window (ticket #67): completions render at their finish
 * position, not in a trailing feed. Ties break by row ID so the order is
 * deterministic; rows beyond the shared window fall off the front; message
 * and completion IDs live in disjoint namespaces (`done:` prefix), so one
 * outcome can never collide with or duplicate a message row. Pure.
 */
export function mergeTranscriptRows<T extends { id: string; createdAt: number }>(
  messages: T[],
  completions: InlineCompletion[],
  window: number = TRANSCRIPT_WINDOW,
): MergedRow<T>[] {
  const rows: MergedRow<T>[] = [
    ...messages.map((message) => ({ id: message.id, at: message.createdAt, message })),
    ...completions.map((completion) => ({ id: completion.id, at: completion.at, completion })),
  ]
  rows.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const seen = new Set<string>()
  const deduped = rows.filter((row) => {
    if (seen.has(row.id)) return false
    seen.add(row.id)
    return true
  })
  return deduped.slice(-window)
}
