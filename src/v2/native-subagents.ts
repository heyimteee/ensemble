import { stableHash } from "./queue.ts"
import type { LateNativeFollowUp, NativeSubagentState } from "./types.ts"

/** Longest display instruction head kept in a durable subagent record. */
export const NATIVE_SUBAGENT_INSTRUCTION_LIMIT = 120
/** In-memory index bound; the durable store remains the record authority. */
export const NATIVE_SUBAGENT_ACTIVE_LIMIT = 128
/** Pending tool instructions kept per parent session until a child appears. */
export const NATIVE_SUBAGENT_PENDING_LIMIT = 8
/**
 * Ticket #199: durable late-follow-up markers kept per parent task. The scan
 * boundary advances with the newest marker, so older evicted ids can never be
 * reconciled again.
 */
export const NATIVE_LATE_FOLLOW_UP_LIMIT = 8
/**
 * Ticket #188: the bounded parent barrier. The host can finalize a parent turn
 * while a background subagent still runs; the run holds its lease and waits for
 * the child's terminal event, but never longer than this bound when an event is
 * missing. Five minutes matches the queue's existing delivery visibility
 * horizon and is far longer than a normal child turn.
 */
export const NATIVE_SUBAGENT_BARRIER_MS = 5 * 60_000
/**
 * Ticket #197: the bounded wait for the host's post-child wake-up turn. The
 * child barrier above holds until the child is terminal; this separate grace
 * bounds how long the parent may then wait for its next idle before reading the
 * post-child answer. It is deliberately shorter than the child barrier: a
 * missing wake-up must not extend the parent's claim by another five minutes.
 */
export const NATIVE_SUBAGENT_WAKEUP_GRACE_MS = 60_000
/**
 * Ticket #197: a parent `task`/`subagent` tool call can be observed before the
 * host creates the child session. Bound that discovery window so an
 * event-delayed `session.created` cannot escape the barrier, without holding
 * unrelated work when no subagent was dispatched.
 */
export const NATIVE_SUBAGENT_DISCOVERY_GRACE_MS = 2_000

const SUBAGENT_TOOL_NAMES = new Set(["task", "subagent"])
const INSTRUCTION_FIELDS = ["description", "instruction", "prompt", "message", "title", "command", "text"] as const
const CHILD_ID_FIELDS = ["childSessionID", "childSessionId", "child_session_id", "sessionID", "session_id"] as const

/**
 * Normalize a user-visible instruction head: one line, collapsed whitespace,
 * bounded by code points so a long prompt can never break a Work card or a
 * durable record. Returns an empty string when nothing usable was supplied.
 */
export function boundNativeSubagentInstruction(value: unknown, limit = NATIVE_SUBAGENT_INSTRUCTION_LIMIT): string {
  if (typeof value !== "string") return ""
  const line = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim()
  if (!line) return ""
  const characters = [...line]
  if (characters.length <= limit) return line
  return `${characters.slice(0, Math.max(1, limit - 1)).join("")}…`
}

/**
 * Capture the parent's subagent tool instruction. Host task/subagent inputs
 * differ, so a short display field wins over a full prompt; unknown shapes
 * stay empty and the caller falls back to the child's title or agent.
 */
export function nativeSubagentInstructionFromInput(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return ""
  const value = input as Record<string, unknown>
  for (const field of INSTRUCTION_FIELDS) {
    const bounded = boundNativeSubagentInstruction(value[field])
    if (bounded) return bounded
  }
  return ""
}

/** Exact parent tool names that dispatch native subagent work. */
export function nativeSubagentToolName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined
  const normalized = name.trim().toLowerCase()
  return SUBAGENT_TOOL_NAMES.has(normalized) ? normalized : undefined
}

/** A child session id supplied by a tool input, when the host includes one. */
export function nativeSubagentChildID(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  const value = input as Record<string, unknown>
  for (const field of CHILD_ID_FIELDS) {
    const candidate = value[field]
    if (typeof candidate === "string" && candidate.length > 0) return candidate
  }
  return undefined
}

/** Honest fallback when no parent tool input could be matched. */
export function nativeSubagentFallbackInstruction(input: { title?: unknown; agent?: unknown }): string {
  return boundNativeSubagentInstruction(input.title)
    || boundNativeSubagentInstruction(input.agent)
    || "subagent"
}

/**
 * First terminal state wins so a late idle cannot overwrite a failure and a
 * cancelled record never resurrects. Only live records may be explicitly
 * reopened by a new execution.
 */
export function nativeSubagentNextState(current: NativeSubagentState, next: NativeSubagentState): NativeSubagentState {
  if (next === "working") return current === "cancelled" ? current : "working"
  if (current === "working") return next
  return current
}

/** Keep an insertion-ordered map bounded, refreshing the key's position. */
export function rememberBoundedMapEntry<T>(
  map: Map<string, T>,
  key: string,
  value: T,
  limit = NATIVE_SUBAGENT_ACTIVE_LIMIT,
): void {
  map.delete(key)
  map.set(key, value)
  const bounded = Math.max(1, limit)
  while (map.size > bounded) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

/** Keep the service's active child index insertion-ordered and bounded. */
export function rememberNativeSubagentActive(
  active: Map<string, number>,
  childSessionID: string,
  startedAt: number,
  limit = NATIVE_SUBAGENT_ACTIVE_LIMIT,
): void {
  rememberBoundedMapEntry(active, childSessionID, startedAt, limit)
}

/** The native message that keys one late follow-up marker. Pure. */
export function lateNativeFollowUpMessageID(marker: Pick<LateNativeFollowUp, "messageIDs">): string | undefined {
  return marker.messageIDs[marker.messageIDs.length - 1]
}

/** One late native assistant answer that may enter the group transcript. */
export type NativeLateMessage = {
  /** Host assistant message id, or a deterministic content identity. */
  messageID: string
  /** Host message creation time in milliseconds. */
  createdAt: number
  /** Assistant text parts from this message, joined and trimmed. */
  text: string
}

function nativeMessageCreatedAt(message: any): number {
  const created = message?.time?.created
  if (typeof created === "number" && Number.isFinite(created)) return created
  if (created instanceof Date) return created.getTime()
  if (typeof created === "string") {
    const parsed = Date.parse(created)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/** Host message identity when the host supplies one. */
export function nativeAssistantMessageID(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined
  const value = message as Record<string, any>
  const candidate = value.id ?? value.messageID ?? value.info?.id
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined
}

/**
 * Ticket #199: assistant text that arrived after a native child and its parent
 * task finished. Only assistant text parts count; user text, reasoning, tools,
 * and blank messages are never mirrored. Identity is the host message id so a
 * repeated idle or restart dedupes; a host without ids gets a deterministic
 * content identity. Pure.
 */
export function nativeLateFollowUps(
  messages: readonly unknown[],
  after: number,
  reconciled: ReadonlySet<string> = new Set(),
): NativeLateMessage[] {
  const late: NativeLateMessage[] = []
  for (const message of messages) {
    if (!message || typeof message !== "object") continue
    const value = message as Record<string, any>
    if (value.type !== "assistant" || !Array.isArray(value.content)) continue
    const createdAt = nativeMessageCreatedAt(value)
    if (!(createdAt > after)) continue
    const text = value.content
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("\n")
      .trim()
    if (!text) continue
    const messageID = nativeAssistantMessageID(value) ?? stableHash(`${createdAt}\0${text}`)
    if (reconciled.has(messageID)) continue
    late.push({ messageID, createdAt, text })
  }
  return late
}
