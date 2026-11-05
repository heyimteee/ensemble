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
import { SYSTEM_AGENT_NAME } from "../system-agent.ts"
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
 *
 * Chrome accounting (ticket #72): rounded bubbles carry `padding={1}` on
 * all four sides (2 horizontal cells) plus a full `border` (2 horizontal
 * cells) — 4 cells of horizontal chrome for both agent and user bubbles.
 * `bubbleContentWidth(w, BUBBLE_CHROME)` therefore equals the native
 * content width behind `width="100%"`, so the JS fallback pre-wrap and
 * the native `<markdown>` wrap agree by construction.
 */
export const BUBBLE_CHROME = 4
export function bubbleContentWidth(chatWidth: number, chrome = BUBBLE_CHROME): number {
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
 * Ticket #77 (root cause): system-authored lines that carry a real agentID
 * still resolve to that agent's color — only generic system (no agent)
 * stays muted, so "Handed to $Clark" / "Answer from $Clark" names are
 * never grey.
 */
export function unifiedAuthorColor(
  line: { agentID?: string; author: string; role: "user" | "agent" | "system" },
  agents: Record<string, Agent | undefined>,
  roster: Agent[],
  colors: { accent: any; muted: any; good: any; info?: any },
  categorical: readonly any[],
): any {
  if (line.role === "user") return colors.good
  if (line.author === SYSTEM_AGENT_NAME) return colors.info ?? colors.accent
  const byID = line.agentID ? agents[line.agentID] : undefined
  const index = line.agentID
    ? roster.findIndex((item) => item.id === line.agentID)
    : roster.findIndex((item) => item.name === line.author)
  const agent = byID ?? (index >= 0 ? roster[index] : undefined)
  if (agent) return agentColor(agent, colors.accent, Math.max(0, index), categorical)
  if (line.role === "system") return colors.muted
  return agentColor(agent, colors.accent, Math.max(0, index), categorical)
}

  // Ticket #77 handoff ordering: completions sort by causal position,
  // not finishedAt lexical ties. A completion's `at` is the finishing
  // task's finish time; the transcript sorts by (at, message-then-completion)
  // is insufficient — instead we make mergeTranscriptRows sort completions
  // after messages with the same timestamp via a sequence tie-breaker.
  // The service ensures hop.createdAt < recipient answer.createdAt, so
  // ordering by createdAt emerges naturally once finishedAt is not used.
export type InlineCompletion = { id: string; text: string; at: number }

export function completionEntry(
  task: Subtask,
  agentLabel: string,
  now: number,
): InlineCompletion | undefined {
  const text = terminalAnnouncement(task, agentLabel, now)
  if (text === undefined) return undefined
  // Ticket #77 handoff ordering: completions sort by causal position,
  // not finishedAt lexical ties. A completion's `at` is the finishing
  // task's finish time; the transcript sorts by (at, message-then-completion)
  // is insufficient — instead we make mergeTranscriptRows sort completions
  // after messages with the same timestamp via a sequence tie-breaker.
  // The service ensures hop.createdAt < recipient answer.createdAt, so
  // ordering by createdAt emerges naturally once finishedAt is not used.
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
export type MergedRow<T> = { id: string; at: number; message?: T; completion?: InlineCompletion; kind?: "message" | "completion" }

/**
 * Merge conversation lines with inline completions into one time-ordered
 * transcript window (ticket #67): completions render at their finish
 * position, not in a trailing feed. Ties break deterministically:
 * messages win over completions at the same timestamp, then by row ID,
 * so an answer can never precede its own handoff ack. Rows beyond the
 * shared window fall off the front; message and completion IDs live in
 * disjoint namespaces (`done:` prefix), so one outcome can never collide
 * with or duplicate a message row. Pure.
 */
export function mergeTranscriptRows<T extends { id: string; createdAt: number }>(
  messages: T[],
  completions: InlineCompletion[],
  window: number = TRANSCRIPT_WINDOW,
): MergedRow<T>[] {
  const rows: MergedRow<T>[] = [
    ...messages.map((message) => ({ id: message.id, at: message.createdAt, message, kind: "message" as const })),
    ...completions.map((completion) => ({ id: completion.id, at: completion.at, completion, kind: "completion" as const })),
  ]
  rows.sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at
    if (a.kind !== b.kind) return a.kind === "message" ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  const seen = new Set<string>()
  const deduped = rows.filter((row) => {
    if (seen.has(row.id)) return false
    seen.add(row.id)
    return true
  })
  return deduped.slice(-window)
}

/**
 * Referentially stabilize merged transcript wrappers across snapshot polls
 * (ticket #72): `mergeTranscriptRows` allocates fresh wrapper objects per
 * poll, so Solid's `<For each={mergedRows()}>` remounts every row ~4x/s
 * even when idle — tearing down native `<markdown>` renderables mid-layout
 * (the glitch). This folds a fresh merge onto the previous array, reusing
 * the previous wrapper when the inner `message` ref is identical and the
 * completion payload (`text`/`at`) plus sort key (`at`) are unchanged.
 * New/changed rows get fresh wrappers and mount normally; completion
 * ordering and the live/finalized partition are untouched (sort/dedupe
 * still happen upstream in `mergeTranscriptRows`). Pure.
 */
export function stabilizeMergedRows<T extends { id: string; createdAt: number }>(
  previous: MergedRow<T>[],
  next: MergedRow<T>[],
): MergedRow<T>[] {
  const prevByID = new Map(previous.map((row) => [row.id, row]))
  return next.map((row) => {
    const prev = prevByID.get(row.id)
    if (!prev) return row
    if (prev.at !== row.at) return row
    if (prev.message !== row.message) return row
    const a = prev.completion
    const b = row.completion
    if (a === b) return prev
    if (!a || !b) return row
    if (a.text !== b.text || a.at !== b.at) return row
    return prev
  })
}
