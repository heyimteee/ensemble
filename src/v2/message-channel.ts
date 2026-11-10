import type { ChatMessage, Id, Message } from "./types.ts"

/**
 * Ticket #212: one durable message model for group and direct conversations.
 *
 * Group rows keep the existing workspace id as their channel. Direct rows use
 * a synthetic `dm:<agentID>[:<workspaceID>]` channel so a direct transcript can
 * use the same message entity, patch feed, transcript window, retention, and
 * client bound as a workspace group without pretending the channel is a real
 * workspace.
 */
export const DIRECT_CHANNEL_PREFIX = "dm:"

/** Environment switch for reading direct conversations from durable rows. */
export const DM_CHANNEL_READS_ENV = "ENSEMBLE_DM_CHANNEL_READS"

/**
 * `off` and `shadow` both keep the legacy direct read path; `shadow` is
 * reserved for the later ingestion compare step. `on` prefers the durable
 * channel rows with a compatibility projection over dual-written legacy lines.
 */
export type DmChannelReadMode = "off" | "shadow" | "on"

export function dmChannelReadMode(value: string | undefined = process.env[DM_CHANNEL_READS_ENV]): DmChannelReadMode {
  switch (String(value ?? "").trim().toLowerCase()) {
    case "on":
      return "on"
    case "shadow":
      return "shadow"
    default:
      return "off"
  }
}

export function directMessageChannel(agentID: Id, workspaceID?: Id): Id {
  return workspaceID ? `${DIRECT_CHANNEL_PREFIX}${agentID}:${workspaceID}` : `${DIRECT_CHANNEL_PREFIX}${agentID}`
}

/** Bridge the legacy `home`/workspace binding key onto the direct channel. */
export function directMessageChannelForBinding(workspaceKey: Id, agentID: Id): Id {
  return directMessageChannel(agentID, workspaceKey === "home" ? undefined : workspaceKey)
}

export function isDirectMessageChannel(channel: Id): boolean {
  return channel.startsWith(DIRECT_CHANNEL_PREFIX)
}

export type DirectMessageChannelParts = {
  agentID: Id
  workspaceID?: Id
}

/** Parse `dm:<agentID>[:<workspaceID>]`; undefined for a group channel. */
export function parseDirectMessageChannel(channel: Id): DirectMessageChannelParts | undefined {
  if (!isDirectMessageChannel(channel)) return undefined
  const rest = channel.slice(DIRECT_CHANNEL_PREFIX.length)
  const separator = rest.indexOf(":")
  if (separator < 0) return rest ? { agentID: rest } : undefined
  const agentID = rest.slice(0, separator)
  const workspaceID = rest.slice(separator + 1)
  if (!agentID) return undefined
  return workspaceID ? { agentID, workspaceID } : { agentID }
}

/** The map key for one durable message: an explicit channel, else its workspace. */
export function messageChannel(message: Pick<Message, "workspaceID" | "channel">): Id {
  return message.channel ?? message.workspaceID
}

export function chatLineFromMessage(message: Message, agentName: string): ChatMessage {
  const role = message.author === "user" ? "user" : message.author === "system" ? "system" : "assistant"
  return {
    id: message.id,
    role,
    author: message.author === "user" ? "You" : message.author === "system" ? "System" : message.displayAuthor ?? agentName,
    text: message.text,
    createdAt: message.createdAt,
    ...(message.attachments && message.attachments.length > 0 ? { attachments: message.attachments } : {}),
    ...(message.correlationID ? { correlationID: message.correlationID } : {}),
  }
}

/**
 * Compatibility projection for the legacy DM transcript store. Durable rows
 * win by id; legacy rows fill ids written before the channel existed, so a
 * flag rollback and an in-place upgrade both keep the transcript intact.
 */
export function projectDirectLines(durable: readonly ChatMessage[], legacy: readonly ChatMessage[]): ChatMessage[] {
  const byID = new Map<Id, ChatMessage>()
  for (const line of legacy) {
    if (!line?.text?.trim()) continue
    byID.set(line.id, { ...line })
  }
  for (const line of durable) {
    if (!line?.text?.trim()) continue
    byID.set(line.id, { ...line })
  }
  return [...byID.values()].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
    if (a.role !== b.role) return a.role === "user" ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}
