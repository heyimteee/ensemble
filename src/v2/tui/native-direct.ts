import { deriveWorkStatus, isTerminalWorkStatus, type DerivedWorkStatus } from "../queue.ts"
import { isNativeTurn } from "../native-turn.ts"
import type { ChatConversationContext, Id, Message, Subtask } from "../types.ts"
import type { ChatLine } from "./components.tsx"
import { workCardStateWord } from "./workrows.ts"

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
    .map((message) => ({
      id: message.id,
      author: message.author === "user" ? "You" : message.author === "system" ? "System" : message.displayAuthor ?? agentName,
      role: message.author === "user" ? "user" as const : message.author === "system" ? "system" as const : "agent" as const,
      agentID: message.agentID,
      text: message.text,
      kind: message.kind,
      ...(message.attachments && message.attachments.length > 0 ? { attachments: message.attachments } : {}),
      ...(message.streaming ? { streaming: true } : {}),
      ...(message.interrupted ? { interrupted: true } : {}),
      ...(message.correlationID ? { correlationID: message.correlationID } : {}),
      ...(message.taskID ? { taskID: message.taskID } : {}),
      createdAt: message.createdAt,
    }))
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
 * The direct conversation's compact Work card. Active turns win over finished
 * ones; otherwise the newest retained terminal turn remains visible. Only
 * native turns belonging to this channel are eligible.
 */
export function directNativeWorkRow(
  tasks: readonly Subtask[],
  channel: Id | undefined,
  now: number,
): DirectWorkRow | undefined {
  if (!channel) return undefined
  const rows = tasks.filter((task) => isNativeTurn(task) && (task.conversationID ?? task.workspaceID) === channel)
  if (rows.length === 0) return undefined
  const active = rows
    .filter((task) => !isTerminalWorkStatus(deriveWorkStatus(task, now)))
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
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
    state: workCardStateWord(status, needsYou),
    title: task.title || "Native turn",
    needsYou,
  }
}
