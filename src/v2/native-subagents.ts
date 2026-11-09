import type { NativeSubagentState } from "./types.ts"

/** Longest display instruction head kept in a durable subagent record. */
export const NATIVE_SUBAGENT_INSTRUCTION_LIMIT = 120
/** In-memory index bound; the durable store remains the record authority. */
export const NATIVE_SUBAGENT_ACTIVE_LIMIT = 128
/** Pending tool instructions kept per parent session until a child appears. */
export const NATIVE_SUBAGENT_PENDING_LIMIT = 8

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

/** Keep the service's active child index insertion-ordered and bounded. */
export function rememberNativeSubagentActive(
  active: Map<string, number>,
  childSessionID: string,
  startedAt: number,
  limit = NATIVE_SUBAGENT_ACTIVE_LIMIT,
): void {
  active.delete(childSessionID)
  active.set(childSessionID, startedAt)
  const bounded = Math.max(1, limit)
  while (active.size > bounded) {
    const oldest = active.keys().next().value
    if (oldest === undefined) break
    active.delete(oldest)
  }
}
