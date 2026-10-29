export type Id = string

export type ModelSelection = {
  providerID: string
  modelID: string
  variant?: string
}

export type ModelOption = {
  providerID: string
  modelID: string
  name: string
  variants: string[]
}

export type SkillOption = {
  id: string
  name: string
  description?: string
}

export type MemoryOrigin = "automatic" | "manual"
export type MemoryScope = "project" | "global" | "channel"

export type MemoryHistoryEntry = {
  at: number
  action: "created" | "edited" | "deleted" | "promoted"
  by: "user" | "agent"
  note?: string
}

export type MemoryEntry = {
  id: Id
  agentID?: Id
  channelID?: Id
  scope: MemoryScope
  projectDirectory?: string
  text: string
  origin: MemoryOrigin
  source: string
  createdAt: number
  updatedAt: number
  deletedAt?: number
  history: MemoryHistoryEntry[]
}

export type AgentProfile = {
  id: Id
  name: string
  instructions: string
  mainModel: ModelSelection
  backupModels: ModelSelection[]
  skillbox: string[]
  archived: boolean
  pendingSettings: boolean
  version: number
  createdAt: number
  updatedAt: number
}

export type ChannelMessage = {
  id: Id
  channelID: Id
  sender:
    | { type: "user" }
    | { type: "agent"; agentID: Id; nameSnapshot: string }
  text: string
  mentions: Id[]
  createdAt: number
  handoffID?: Id
}

export type Channel = {
  id: Id
  name: string
  projectDirectory: string
  memberIDs: Id[]
  leaderID: Id
  messages: ChannelMessage[]
  archived: boolean
  paused: boolean
  chainIDs: Id[]
  createdAt: number
  updatedAt: number
}

export type TaskChain = {
  id: Id
  channelID?: Id
  conversationID: Id
  deliveries: number
  limit: number
  status: "active" | "waiting" | "stopped" | "completed"
  createdAt: number
  updatedAt: number
}

export type HandoffStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "waiting_approval"
  | "cancelled"

export type Handoff = {
  id: Id
  channelID: Id
  chainID: Id
  fromAgentID: Id
  toAgentID: Id
  fromNameSnapshot?: string
  toNameSnapshot?: string
  request: string
  reply?: string
  status: HandoffStatus
  workID?: Id
  createdAt: number
  updatedAt: number
}

export type ApprovalKind =
  | "outside_roster"
  | "cross_project"
  | "promote_memory"
  | "chain_limit"
  | "resume_interrupted"
  | "roster_change"

export type Approval = {
  id: Id
  kind: ApprovalKind
  title: string
  detail: string
  channelID?: Id
  agentID?: Id
  workID?: Id
  handoffID?: Id
  memoryID?: Id
  payload?: Record<string, unknown>
  status: "pending" | "approved" | "rejected"
  createdAt: number
  resolvedAt?: number
  resolution?: string
}

export type WorkStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"

export type WorkItem = {
  id: Id
  kind: "direct" | "channel"
  agentID: Id
  channelID?: Id
  conversationID: Id
  sessionID?: Id
  prompt: string
  mode: "research" | "edit"
  status: WorkStatus
  queueOrder: number
  chainID?: Id
  handoffID?: Id
  checkoutKey?: string
  resultText?: string
  error?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
}

export type ConversationMessage = {
  id: Id
  role: "user" | "agent" | "system"
  text: string
  createdAt: number
  workID?: Id
  sessionID?: Id
  agentNameSnapshot?: string
  toolSummary?: string[]
}

export type Conversation = {
  id: Id
  kind: "direct" | "channel"
  agentID: Id
  channelID?: Id
  projectDirectory: string
  agentVersion: number
  sessionIDs: Id[]
  activeSessionID?: Id
  messages: ConversationMessage[]
  createdAt: number
  updatedAt: number
}

export type Settings = {
  maxConcurrentTurns: number
  chainLimit: number
  modelFallback: boolean
}

export type EnsembleState = {
  schemaVersion: 1
  version: number
  updatedAt: number
  agents: Record<Id, AgentProfile>
  channels: Record<Id, Channel>
  conversations: Record<Id, Conversation>
  work: Record<Id, WorkItem>
  handoffs: Record<Id, Handoff>
  approvals: Record<Id, Approval>
  memories: Record<Id, MemoryEntry>
  chains: Record<Id, TaskChain>
  settings: Settings
}

export type Snapshot = {
  state: EnsembleState
  models: ModelOption[]
  skills: SkillOption[]
  directory: string
}
