import { deriveWorkStatus, isTerminalWorkStatus, workStatusWord, type DerivedWorkStatus } from "../queue.ts"
import { isNativeTurn } from "../native-turn.ts"
import { chatLineFromMessage } from "../message-channel.ts"
import type { ChatConversationContext, Id, Message, Subtask } from "../types.ts"
import type { ChatLine } from "./components.tsx"

/**
 * Ticket #215: the direct surface reads the same durable message channel and
 * Work rows as a group conversation. These pure projections keep the TUI from
 * inventing a second transcript or a second Work model.
 */

/** The durable channel a native-first direct conversation owns. */
export function nativeDirectChannel(conversation: ChatConversationContext | undefined): Id | undefined {
  if (!conversation?.durable) return undefined
  return conversation.channel
}

/** Durable channel rows for the direct transcript, in sequence order. */
export function nativeDirectChatLines(
  messages: readonly Message[],
  agentName: string,
  limit: number,
): ChatLine[] {
  return messages
    .filter((message) => Boolean(message?.text?.trim()) || (message?.attachments?.length ?? 0) > 0)
    .slice(-Math.max(1, Math.floor(limit)))
    .map((message) => {
      // One author/role/attachment projection serves the direct chat-context
      // reader and the durable transcript; only durable-only fields are added.
      const line = chatLineFromMessage(message, agentName)
      return {
        ...line,
        role: line.role === "assistant" ? "agent" as const : line.role,
        agentID: message.agentID,
        kind: message.kind,
        ...(message.streaming ? { streaming: true } : {}),
        ...(message.interrupted ? { interrupted: true } : {}),
        ...(message.taskID ? { taskID: message.taskID } : {}),
      }
    })
}

export type DirectWorkRow = {
  id: Id
  status: DerivedWorkStatus
  /** Canonical uppercase Work vocabulary, e.g. WORKING or REPLIED. */
  state: string
  title: string
  needsYou: boolean
}

/**
 * The direct conversation's compact Work card. Working, retrying, or
 * needs-you turn wins over a queued follow-up; among equal priorities the
 * newest turn wins. Otherwise the newest retained terminal turn remains
 * visible. Only native turns belonging to this channel are eligible.
 */
export function directNativeWorkRow(
  tasks: readonly Subtask[],
  channel: Id | undefined,
  now: number,
): DirectWorkRow | undefined {
  if (!channel) return undefined
  const rows = tasks.filter((task) => isNativeTurn(task) && (task.conversationID ?? task.workspaceID) === channel)
  if (rows.length === 0) return undefined
  const activeRank = (task: Subtask): number => {
    const status = deriveWorkStatus(task, now)
    if (status === "needs_you") return 0
    if (status === "pending") return 2
    return 1
  }
  const active = rows
    .filter((task) => !isTerminalWorkStatus(deriveWorkStatus(task, now)))
    .sort((a, b) => activeRank(a) - activeRank(b) || b.createdAt - a.createdAt || a.id.localeCompare(b.id))
  const terminal = rows
    .filter((task) => isTerminalWorkStatus(deriveWorkStatus(task, now)))
    .sort((a, b) => (b.finishedAt ?? b.repliedAt ?? 0) - (a.finishedAt ?? a.repliedAt ?? 0) || a.id.localeCompare(b.id))
  const task = active[0] ?? terminal[0]
  if (!task) return undefined
  const status = deriveWorkStatus(task, now)
  const needsYou = status === "needs_you"
  return {
    id: task.id,
    status,
    state: workStatusWord(status, needsYou),
    title: task.title || "Native turn",
    needsYou,
  }
}
