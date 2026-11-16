import { LOG_MAX_BYTES, LOG_MAX_FILES, LOG_RETENTION_DAYS } from "./logging.ts"
import { isWorkspaceConversationChannel, parseDirectMessageChannel } from "./message-channel.ts"
import type { Agent, Message, Memory, SnapshotState, Subtask } from "./types.ts"

/**
 * Ticket #272: the user-facing export format. It is deliberately a projection,
 * not a storage dump: conversation content, Work text, and memories travel;
 * binding identities, directories, model configuration, settings, and
 * operational logs never do. `docs/privacy/data-and-retention.md` documents
 * the fields, the exclusions, and the retention policy.
 */
export const DATA_EXPORT_FORMAT = "ensemble.data-export"
export const DATA_EXPORT_VERSION = 1

export type ExportAttachment = {
  name: string
  mime: string
  size: number
  kind: "file" | "image"
}

export type ExportMessage = {
  id: string
  seq: number
  author: "user" | "agent" | "system"
  agentID?: string
  authorName?: string
  displayAuthor?: string
  kind: string
  text: string
  createdAt: number
  attachments?: ExportAttachment[]
}

export type ExportConversation = {
  channel: string
  kind: "group" | "direct"
  agentID?: string
  agentName?: string
  messages: ExportMessage[]
}

export type ExportWork = {
  id: string
  conversationID?: string
  assigneeID?: string
  assigneeName?: string
  title: string
  instruction: string
  constraints?: string
  expected?: string
  mode: string
  workKind?: string
  state: string
  outcome: string
  interrupted: boolean
  createdAt: number
  startedAt?: number
  finishedAt?: number
  repliedAt?: number
  failure?: { kind: string; reason?: string }
}

export type ExportMemory = {
  id: string
  scope: string
  text: string
  origin: string
  source: string
  createdAt: number
  updatedAt: number
  history: Array<{ at: number; action: string; by: string; note?: string }>
}

export type WorkspaceDataExport = {
  format: typeof DATA_EXPORT_FORMAT
  formatVersion: typeof DATA_EXPORT_VERSION
  generatedAt: string
  workspace: {
    id: string
    name: string
    leaderID: string
    synthesis: boolean
    paused: boolean
    members: Array<{ id: string; name: string; title: string; role: string; archived: boolean }>
  }
  conversations: ExportConversation[]
  work: ExportWork[]
  memories: ExportMemory[]
  /** Data classes this export deliberately does not carry. */
  excluded: string[]
  logs: {
    included: false
    retentionDays: number
    maxFiles: number
    maxBytes: number
  }
  counts: {
    conversations: number
    messages: number
    work: number
    memories: number
    attachments: number
  }
}

const EXCLUDED_DATA_CLASSES = [
  "bindings",
  "host-session-identifiers",
  "workspace-directory-paths",
  "model-configuration",
  "settings",
  "operational-logs",
  "agent-global-memories",
]

function exportMessage(message: Message, agents: Record<string, Agent>): ExportMessage {
  const agent = message.agentID ? agents[message.agentID] : undefined
  return {
    id: message.id,
    seq: message.seq,
    author: message.author,
    ...(message.agentID ? { agentID: message.agentID } : {}),
    ...(agent ? { authorName: agent.name } : {}),
    ...(message.displayAuthor ? { displayAuthor: message.displayAuthor } : {}),
    kind: message.kind,
    text: message.text,
    createdAt: message.createdAt,
    ...(message.attachments && message.attachments.length > 0
      ? {
          attachments: message.attachments.map((attachment) => ({
            name: attachment.name,
            mime: attachment.mime,
            size: attachment.size,
            kind: attachment.kind,
          })),
        }
      : {}),
  }
}

function exportWork(subtask: Subtask, agents: Record<string, Agent>): ExportWork {
  const assignee = subtask.assigneeID ? agents[subtask.assigneeID] : undefined
  return {
    id: subtask.id,
    ...(subtask.conversationID ? { conversationID: subtask.conversationID } : {}),
    ...(subtask.assigneeID ? { assigneeID: subtask.assigneeID } : {}),
    ...(assignee ? { assigneeName: assignee.name } : {}),
    title: subtask.title,
    instruction: subtask.instruction,
    ...(subtask.constraints ? { constraints: subtask.constraints } : {}),
    ...(subtask.expected ? { expected: subtask.expected } : {}),
    mode: subtask.mode,
    ...(subtask.workKind ? { workKind: subtask.workKind } : {}),
    state: subtask.state,
    outcome: subtask.outcome,
    interrupted: subtask.interrupted,
    createdAt: subtask.createdAt,
    ...(subtask.startedAt !== undefined ? { startedAt: subtask.startedAt } : {}),
    ...(subtask.finishedAt !== undefined ? { finishedAt: subtask.finishedAt } : {}),
    ...(subtask.repliedAt !== undefined ? { repliedAt: subtask.repliedAt } : {}),
    // Structured cause only: free-form error text can carry host details the
    // user did not choose to export.
    ...(subtask.failure
      ? { failure: { kind: subtask.failure.kind, ...(subtask.failure.reason ? { reason: subtask.failure.reason } : {}) } }
      : {}),
  }
}

function exportMemory(memory: Memory): ExportMemory {
  return {
    id: memory.id,
    scope: memory.scope,
    text: memory.text,
    origin: memory.origin,
    source: memory.source,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    history: memory.history.map((entry) => ({
      at: entry.at,
      action: entry.action,
      by: entry.by,
      ...(entry.note ? { note: entry.note } : {}),
    })),
  }
}

/**
 * Project one workspace's user data into the documented export shape. Returns
 * undefined when the workspace id is unknown. The projection reads only the
 * workspace's own conversations (group and direct channels for that workspace)
 * and workspace-attributed memories.
 */
export function workspaceDataExport(
  state: SnapshotState,
  workspaceID: string,
  options: { generatedAt?: number } = {},
): WorkspaceDataExport | undefined {
  const workspace = state.workspaces[workspaceID]
  if (!workspace) return undefined
  const agents = state.agents
  const channels = Object.keys(state.messages).filter((channel) => isWorkspaceConversationChannel(channel, workspaceID))
  const conversations: ExportConversation[] = channels
    .sort((a, b) => (a === workspaceID ? -1 : b === workspaceID ? 1 : a.localeCompare(b)))
    .map((channel) => {
      const direct = parseDirectMessageChannel(channel)
      const agent = direct ? agents[direct.agentID] : undefined
      const messages = [...(state.messages[channel] ?? [])]
        .sort((a, b) => a.seq - b.seq)
        .map((message) => exportMessage(message, agents))
      return {
        channel,
        kind: direct ? "direct" as const : "group" as const,
        ...(direct ? { agentID: direct.agentID } : {}),
        ...(agent ? { agentName: agent.name } : {}),
        messages,
      }
    })
  const work = Object.values(state.subtasks)
    .filter((subtask) => isWorkspaceConversationChannel(subtask.workspaceID, workspaceID)
      || (subtask.conversationID !== undefined && isWorkspaceConversationChannel(subtask.conversationID, workspaceID)))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((subtask) => exportWork(subtask, agents))
  const memories = Object.values(state.memories)
    .filter((memory) => !memory.deletedAt
      && memory.workspaceID !== undefined
      && isWorkspaceConversationChannel(memory.workspaceID, workspaceID))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map(exportMemory)
  const members = [workspace.leaderID, ...workspace.memberIDs]
    .filter((id, index, list) => list.indexOf(id) === index)
    .flatMap((id) => {
      const agent = agents[id]
      return agent
        ? [{ id, name: agent.name, title: agent.title, role: agent.role, archived: agent.archived }]
        : []
    })
  const messageCount = conversations.reduce((total, conversation) => total + conversation.messages.length, 0)
  const attachmentCount = conversations.reduce(
    (total, conversation) => total + conversation.messages.reduce(
      (inner, message) => inner + (message.attachments?.length ?? 0),
      0,
    ),
    0,
  )
  return {
    format: DATA_EXPORT_FORMAT,
    formatVersion: DATA_EXPORT_VERSION,
    generatedAt: new Date(options.generatedAt ?? Date.now()).toISOString(),
    workspace: {
      id: workspace.id,
      name: workspace.name,
      leaderID: workspace.leaderID,
      synthesis: workspace.synthesis,
      paused: workspace.paused,
      members,
    },
    conversations,
    work,
    memories,
    excluded: [...EXCLUDED_DATA_CLASSES],
    logs: {
      included: false,
      retentionDays: LOG_RETENTION_DAYS,
      maxFiles: LOG_MAX_FILES,
      maxBytes: LOG_MAX_BYTES,
    },
    counts: {
      conversations: conversations.length,
      messages: messageCount,
      work: work.length,
      memories: memories.length,
      attachments: attachmentCount,
    },
  }
}
