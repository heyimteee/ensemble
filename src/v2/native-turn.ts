import { nativeInboxAttachments } from "./attachments.ts"
import { isNativeTurn, stableHash } from "./queue.ts"
import type { Id, MessageAttachment, NativeTurnEvent, NativeTurnInfo, NativeTurnPhase } from "./types.ts"

export { isNativeTurn }

/**
 * Ticket #215: pure identity and text helpers for native turn ingestion.
 *
 * A native turn is identified by the host inbox id (which is also the user
 * message id), never by time. The durable ids below are deterministic so a
 * duplicate or replayed host event resolves to the same turn and rows.
 */

/**
 * Prompt metadata marking a service-originated prompt. The host preserves
 * prompt metadata on `session.inbox.enqueued`, so ingestion can skip mirroring
 * the user text while the service still owns the execution.
 */
export const NATIVE_INTERNAL_PROMPT_METADATA = "ensemble.internal"

/**
 * Prompt metadata marking a turn that must not create any Ensemble row.
 * Identity/onboarding/system prompts use this; a user-facing composer prompt
 * uses only the internal marker because its user row already exists.
 */
export const NATIVE_SKIP_TURN_METADATA = "ensemble.mirror"

/** The durable user row a service prompt already wrote for this conversation. */
export const NATIVE_MESSAGE_ID_METADATA = "ensemble.messageID"

/** The host event families native turn ingestion consumes (ADR 0010). */
export const NATIVE_INGEST_EVENT_TYPES = [
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.delivery.changed",
  "session.inbox.cancelled",
  "session.text.started",
  "session.text.delta",
  "session.text.ended",
  "session.retry.scheduled",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
] as const

export function isNativeIngestEvent(type: string): boolean {
  return (NATIVE_INGEST_EVENT_TYPES as readonly string[]).includes(type)
}

export function nativeEventType(event: any): string {
  return String(event?.type ?? "")
}

export function nativeEventData(event: any): any {
  return event?.data ?? event
}

export function nativeEventSessionID(event: any): Id | undefined {
  const sessionID = String(nativeEventData(event)?.sessionID ?? "").trim()
  return sessionID || undefined
}

/** The host event's own timestamp when present; display order only. */
export function nativeEventAt(event: any, fallback: number): number {
  const data = nativeEventData(event)
  for (const value of [event?.created, event?.at, data?.created, data?.at, data?.time?.created]) {
    const at = Number(value)
    if (Number.isFinite(at) && at > 0) return at
  }
  return fallback
}

export function nativePromptIsInternal(payload: any): boolean {
  const metadata = payload?.metadata
  return metadata?.[NATIVE_INTERNAL_PROMPT_METADATA] === true
    || metadata?.[NATIVE_INTERNAL_PROMPT_METADATA] === "true"
}

export function nativePromptSkipsTurn(payload: any): boolean {
  const metadata = payload?.metadata
  return metadata?.[NATIVE_SKIP_TURN_METADATA] === false
    || metadata?.[NATIVE_SKIP_TURN_METADATA] === "false"
}

export function nativeTurnID(sessionID: Id, inboxID: Id): Id {
  return `task_native_${stableHash(`native-turn:${sessionID}\0${inboxID}`)}`
}

export function nativeTurnGroupID(turnID: Id): Id {
  return `group_native_${stableHash(`native-group:${turnID}`)}`
}

export function nativeUserMessageID(inboxID: Id): Id {
  return `msg_native_${stableHash(`native-user:${inboxID}`)}`
}

/** One durable agent row per native turn; retry reuses the same row. */
export function nativeAssistantMessageID(turnID: Id): Id {
  return `msg_native_${stableHash(`native-assistant:${turnID}`)}`
}

/** A compact, content-free Work title head. */
export function nativeTurnTitle(text: string, max = 80): string {
  const head = String(text ?? "").replace(/\s+/g, " ").trim()
  if (!head) return "Native turn"
  return head.length > max ? `${head.slice(0, Math.max(1, max - 1))}…` : head
}

/** Text parts accumulated per assistant message id and ordinal. */
export type NativeTextPartState = {
  started: number[]
  deltas: Record<number, string>
  ended: Record<number, string>
}

export type NativeTextState = Record<Id, NativeTextPartState>

function ordinals(part: NativeTextPartState): number[] {
  const seen = new Set<number>()
  for (const value of [...part.started, ...Object.keys(part.deltas).map(Number), ...Object.keys(part.ended).map(Number)]) {
    if (Number.isInteger(value) && value >= 0) seen.add(value)
  }
  return [...seen].sort((a, b) => a - b)
}

/**
 * Display text for a streaming turn. Ended parts are authoritative for their
 * ordinal; an unended ordinal falls back to its accumulated deltas. The same
 * join is used by the durable final when every started part has ended, so the
 * live row and the finalized row cannot drift by construction.
 */
export function nativeTextForParts(state: NativeTextState): string {
  const messages: string[] = []
  for (const part of Object.values(state)) {
    const pieces: string[] = []
    for (const ordinal of ordinals(part)) {
      const text = part.ended[ordinal] ?? part.deltas[ordinal] ?? ""
      if (text) pieces.push(text)
    }
    if (pieces.length > 0) messages.push(pieces.join("\n"))
  }
  return messages.join("\n")
}

/**
 * Authoritative final text for a turn: only ended parts, and only when every
 * started part has ended. `complete: false` tells the caller to reconcile from
 * the native transcript instead of guessing.
 */
export function nativeFinalText(state: NativeTextState): { text: string; complete: boolean } {
  let complete = true
  const messages: string[] = []
  for (const part of Object.values(state)) {
    const pieces: string[] = []
    for (const ordinal of ordinals(part)) {
      const ended = part.ended[ordinal]
      if (ended === undefined) {
        if (part.started.includes(ordinal) || part.deltas[ordinal] !== undefined) complete = false
        continue
      }
      if (ended) pieces.push(ended)
    }
    if (pieces.length > 0) messages.push(pieces.join("\n"))
  }
  return { text: messages.join("\n"), complete }
}

/** Text parts from one native context assistant message, in content order. */
export function nativeContextMessageText(message: any): string {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
    .trim()
}

/** Exact text parts for comparison: same join, no trimming. */
export function nativeContextMessageTextExact(message: any): string {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
}

/**
 * Ticket #230: exact identity-only answer for shadow comparison. It uses the
 * same selection as the watchdog but preserves the host text byte-for-byte so
 * the digest comparison is meaningful.
 */
export function nativeContextAnswerExact(
  messages: readonly any[],
  input: { inboxID?: Id; assistantMessageIDs?: readonly Id[] } = {},
): string | undefined {
  if (!Array.isArray(messages)) return undefined
  const assistantIDs = new Set((input.assistantMessageIDs ?? []).map(String))
  if (assistantIDs.size > 0) {
    const matched = messages.find((message) => message?.type === "assistant" && assistantIDs.has(String(message.id)))
    const text = nativeContextMessageTextExact(matched)
    if (text.length > 0) return text
  }
  if (input.inboxID) {
    const userIndex = messages.findIndex((message) => message?.type === "user" && String(message.id) === String(input.inboxID))
    if (userIndex >= 0) {
      for (const message of messages.slice(userIndex + 1)) {
        if (message?.type === "assistant") {
          const text = nativeContextMessageTextExact(message)
          if (text.length > 0) return text
        }
      }
    }
  }
  return undefined
}

/**
 * Recover one turn's answer from a native `session.context` read. Identity
 * wins: a recorded assistant message id, then the assistant message after the
 * inbox user message. This variant never falls back to an unrelated assistant
 * row, so a watchdog cannot attribute an older answer to the wrong turn.
 */
export function nativeContextTurnAnswer(
  messages: readonly any[],
  input: { inboxID?: Id; assistantMessageIDs?: readonly Id[] } = {},
): string | undefined {
  if (!Array.isArray(messages)) return undefined
  const assistantIDs = new Set((input.assistantMessageIDs ?? []).map(String))
  if (assistantIDs.size > 0) {
    const matched = messages.find((message) => message?.type === "assistant" && assistantIDs.has(String(message.id)))
    const text = nativeContextMessageText(matched)
    if (text) return text
  }
  if (input.inboxID) {
    const userIndex = messages.findIndex((message) => message?.type === "user" && String(message.id) === String(input.inboxID))
    if (userIndex >= 0) {
      for (const message of messages.slice(userIndex + 1)) {
        if (message?.type === "assistant") {
          const text = nativeContextMessageText(message)
          if (text) return text
        }
      }
    }
  }
  return undefined
}

/**
 * Ticket #218: one turn discovered in a native `session.context` read. The
 * grouping is identity-based: a user or synthetic message opens the turn, the
 * assistant messages after it belong to that turn, and an idle marker confirms
 * the host settled it. Context ids are allocation-ordered, so the transcript
 * array order is the only order used here.
 */
export type NativeContextTurn = {
  inboxID: Id
  itemType: "user" | "synthetic"
  /** Prompt text joined from text parts; empty for an attachment-only prompt. */
  text: string
  /** Host prompt files mapped to content-free transcript chips. */
  attachments: MessageAttachment[]
  metadata?: Record<string, unknown>
  createdAt?: number
  assistantMessageIDs: Id[]
  /** Joined assistant text for this turn; empty when no text part exists. */
  assistantText: string
  hasAssistant: boolean
  /** An idle marker follows this turn in the native transcript. */
  settled: boolean
}

export function nativeContextTurnGroups(messages: readonly any[]): NativeContextTurn[] {
  const turns: NativeContextTurn[] = []
  const seen = new Set<string>()
  let current: NativeContextTurn | undefined
  for (const message of messages) {
    const type = String(message?.type ?? "")
    if (type === "user" || type === "synthetic") {
      const inboxID = String(message?.id ?? "").trim()
      if (!inboxID || seen.has(inboxID)) {
        current = undefined
        continue
      }
      seen.add(inboxID)
      const createdAt = Number(message?.time?.created)
      const metadata = message?.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
        ? message.metadata as Record<string, unknown>
        : undefined
      current = {
        inboxID,
        itemType: type,
        text: nativeContextMessageText(message),
        attachments: nativeInboxAttachments(message?.files, inboxID),
        ...(metadata ? { metadata } : {}),
        ...(Number.isFinite(createdAt) && createdAt > 0 ? { createdAt } : {}),
        assistantMessageIDs: [],
        assistantText: "",
        hasAssistant: false,
        settled: false,
      }
      turns.push(current)
      continue
    }
    if (!current) continue
    if (type === "assistant") {
      current.hasAssistant = true
      const assistantID = String(message?.id ?? "").trim()
      if (assistantID && !current.assistantMessageIDs.includes(assistantID)) current.assistantMessageIDs.push(assistantID)
      const text = nativeContextMessageText(message)
      if (text) current.assistantText = current.assistantText ? `${current.assistantText}\n${text}` : text
    } else if (type === "idle") {
      current.settled = true
    }
  }
  return turns
}

/**
 * Ticket #217: reconciliation evidence that one inbox's execution reached a
 * terminal point without an answer. The host writes a `idle` marker after a
 * settled turn even when the idle event was not delivered. The marker must come
 * after this turn's own user row; a missing marker means the turn may still be
 * running and must not be guessed into an interruption.
 */
export function nativeContextTurnSettled(messages: readonly any[], inboxID: Id | undefined): boolean {
  if (!Array.isArray(messages) || !inboxID) return false
  const userIndex = messages.findIndex((message) => message?.type === "user" && String(message.id) === String(inboxID))
  if (userIndex < 0) return false
  return messages.slice(userIndex + 1).some((message) => message?.type === "idle")
}

/**
 * Recover one turn's answer from a native `session.context` read. Identity
 * wins: a recorded assistant message id, then the assistant message after the
 * inbox user message, then the last assistant message in the transcript.
 * Context order is the host's chronological order; ids are never sorted.
 */
export function nativeContextAnswer(
  messages: readonly any[],
  input: { inboxID?: Id; assistantMessageIDs?: readonly Id[] } = {},
): string | undefined {
  if (!Array.isArray(messages)) return undefined
  const identified = nativeContextTurnAnswer(messages, input)
  if (identified !== undefined) return identified
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.type !== "assistant") continue
    const text = nativeContextMessageText(message)
    if (text) return text
  }
  return undefined
}

/**
 * Ticket #236: recipients this native turn already contacted. A turn created
 * before the ledger existed has no field and reads as empty, so replay and
 * restart never invent contacts.
 */
export function nativeContacted(native: NativeTurnInfo | undefined): readonly Id[] {
  const contacts = native?.contacted
  if (!Array.isArray(contacts)) return []
  return contacts.filter((recipientID): recipientID is Id => typeof recipientID === "string" && recipientID.length > 0)
}

/** True when the turn already contacted the recipient. */
export function nativeContactedRecipient(native: NativeTurnInfo | undefined, recipientID: Id): boolean {
  return nativeContacted(native).includes(recipientID)
}

/**
 * Add one recipient to a turn's durable contact ledger. Returns the same value
 * when already present so the caller can skip the write.
 */
export function withNativeContact(
  native: NativeTurnInfo,
  recipientID: Id,
): { native: NativeTurnInfo; added: boolean } {
  const contacted = nativeContacted(native)
  if (contacted.includes(recipientID)) return { native, added: false }
  return { native: { ...native, contacted: [...contacted, recipientID] }, added: true }
}

/** Ticket #222: keep the identity-only timeline bounded. */
export const NATIVE_TURN_EVENT_LIMIT = 32

/**
 * Append one host event to a turn's metadata timeline. Consecutive duplicates
 * (a replayed delivery or text event) collapse; the timeline is bounded and
 * never carries text or file content.
 */
export function appendNativeTurnEvent(native: NativeTurnInfo, event: NativeTurnEvent): void {
  const events = native.events ?? []
  const previous = events.at(-1)
  if (
    previous
    && previous.type === event.type
    && previous.phase === event.phase
    && previous.delivery === event.delivery
    && previous.messageID === event.messageID
  ) {
    native.events = events
    return
  }
  native.events = [...events, event].slice(-NATIVE_TURN_EVENT_LIMIT)
}

/**
 * Ticket #217: a user interrupt is a cancellation, not a lost-work
 * interruption. Shutdown, inactivity, superseded, and unknown reasons preserve
 * partial work and ask the user. The host's reason vocabulary is finite, but an
 * unknown value is treated conservatively as an interruption.
 */
export function nativeInterruptionSettlement(reason: unknown): "cancelled" | "interrupted" {
  return String(reason ?? "") === "user" ? "cancelled" : "interrupted"
}

/**
 * Native phases that still expect host events. `interrupted` is a settled
 * needs-you state; a user interrupt settles `cancelled` instead (ticket #217).
 */
export function nativePhaseOpen(phase: NativeTurnPhase | undefined): boolean {
  return phase === "queued" || phase === "working" || phase === "retrying"
}
