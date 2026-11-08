import { isFallbackReply, REPLY_INTERRUPTED } from "./execution.ts"
import type { DerivedWorkStatus } from "./queue.ts"
import type { Message, WorkFailureKind } from "./types.ts"

/**
 * Stream settlement rules (ticket #169).
 *
 * `Reply interrupted.` is a verdict about the stream, not about the queue.
 * Interruption is reserved for a genuine host interruption, an empty or
 * internal-fallback stream, or a real native execution failure. Delivery,
 * lease, retry, and stall states preserve a substantive reply exactly as it
 * was produced: those states say nothing about whether the answer is real.
 */

/** A reply that is real content: non-empty and not one of the internal fallbacks. */
export function isSubstantiveReply(text: string | undefined | null): text is string {
  return typeof text === "string" && text.trim().length > 0 && !isFallbackReply(text)
}

/** The text a settled row carries. An empty stream cannot render blank. */
export function settlementText(text: string): string {
  return text.trim().length > 0 ? text : REPLY_INTERRUPTED
}

/**
 * Whether a settled stream row must read as interrupted.
 *
 * Only structured native failure evidence may interrupt a substantive reply.
 * A legacy terminal failure without that evidence (ticket #168 keeps it
 * `failed` conservatively) still preserves the real answer: the task card
 * stays failed, but the transcript is never rewritten to a false
 * interruption. Queue causes (`delivery`, `lease`, `attempts`) derive
 * `stalled` and never interrupt.
 */
export function shouldInterruptSettledReply(input: {
  text: string
  status: DerivedWorkStatus
  failureKind?: WorkFailureKind
  stopped?: boolean
}): boolean {
  if (!isSubstantiveReply(input.text)) return true
  if (input.stopped) return true
  if (input.status === "needs_you") return true
  if (input.failureKind === "native") return true
  return false
}

export type LateSuccessPlan =
  | { action: "repair"; messageID: string; text: string }
  | { action: "reuse"; messageID: string; text: string }
  | { action: "create"; text: string }
  | { action: "none"; reason: "no-substantive-text" }

function taskTextRows(messages: readonly Message[], taskID: string): Message[] {
  return messages.filter(
    (message) => message.taskID === taskID && message.author === "agent" && message.kind === "text",
  )
}

function isPlaceholderRow(message: Message): boolean {
  return message.streaming === true || message.interrupted === true || !isSubstantiveReply(message.text)
}

/**
 * Plan the transcript half of a late-success repair (ticket #169). Pure: it
 * reads only the task's agent text rows and the late text.
 *
 * - A streaming row is the natural target when the late result carries text;
 *   it was the live answer. With no new text, only a settled placeholder is
 *   repaired, and a live partial is left for normal settlement.
 * - Otherwise the newest settled placeholder (interrupted, empty, or an
 *   internal fallback) is repaired in place, so the placeholder never
 *   survives as a false failure line.
 * - The final text is the late substantive text, or the newest settled
 *   substantive answer already recorded for the task. A late result may carry
 *   no new text while the real answer was already persisted. A still-streaming
 *   partial is never treated as a recorded answer.
 * - A substantive row is never overwritten and never demoted to a
 *   placeholder; with no target it is reused as the result.
 * - With no target and no substantive text the plan does nothing: an empty
 *   late result never turns a placeholder into success.
 */
export function planLateSuccessRepair(input: {
  messages: readonly Message[]
  taskID: string
  lateText?: string
}): LateSuccessPlan {
  const rows = taskTextRows(input.messages, input.taskID)
  const late = isSubstantiveReply(input.lateText) ? input.lateText.trim() : undefined
  // Only a settled substantive row is an already-recorded answer. A still
  // streaming row is this attempt's partial text, never proof of success on
  // its own: an empty native result must not promote it (ticket #169/#149).
  const substantive = rows
    .filter((message) => message.streaming !== true && isSubstantiveReply(message.text))
    .sort((a, b) => b.seq - a.seq)
  const streaming = rows.filter((message) => message.streaming === true).sort((a, b) => b.seq - a.seq)[0]
  const settledPlaceholder = rows
    .filter((message) => message.streaming !== true && isPlaceholderRow(message))
    .sort((a, b) => b.seq - a.seq)[0]
  // With no new text, only a settled placeholder is repaired with the answer
  // that was already recorded. A live partial is never overwritten.
  const target = late ? streaming ?? settledPlaceholder : settledPlaceholder
  const finalText = late ?? substantive[0]?.text
  if (target && finalText) return { action: "repair", messageID: target.id, text: finalText }
  if (substantive[0]) return { action: "reuse", messageID: substantive[0].id, text: substantive[0].text }
  if (late) return { action: "create", text: late }
  return { action: "none", reason: "no-substantive-text" }
}
