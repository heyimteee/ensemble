export type Id = string

export type ModelRef = {
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
export type MemoryScope = "project" | "global" | "workspace"

export type MemoryHistory = {
  at: number
  action: "created" | "edited" | "deleted" | "promoted" | "shared"
  by: "user" | "agent"
  note?: string
}

export type Memory = {
  id: Id
  agentID?: Id
  workspaceID?: Id
  scope: MemoryScope
  text: string
  origin: MemoryOrigin
  source: string
  createdAt: number
  updatedAt: number
  deletedAt?: number
  history: MemoryHistory[]
}

export type Agent = {
  id: Id
  name: string
  title: string
  role: string
  mainModel: ModelRef
  backupModels: ModelRef[]
  skillbox: string[]
  color: string
  archived: boolean
  pendingSettings: boolean
  homeSessionID?: Id
  homeDirectory?: string
  version: number
  createdAt: number
  updatedAt: number
}

export type Workspace = {
  id: Id
  name: string
  directory: string
  leaderID: Id
  memberIDs: Id[]
  synthesis: boolean
  archived: boolean
  paused: boolean
  configVersion?: number
  nextSeq: number
  createdAt: number
  lastActiveAt: number
}

export type MessageKind = "text" | "task" | "approval" | "system"

export type Message = {
  id: Id
  workspaceID: Id
  seq: number
  author: "user" | "agent" | "system"
  agentID?: Id
  text: string
  kind: MessageKind
  taskID?: Id
  streaming?: boolean
  interrupted?: boolean
  createdAt: number
}

export type SubtaskState = "pending" | "working" | "replied"
export type SubtaskOutcome = "succeeded" | "failed" | "pending"
export type SubtaskStage = "initial" | "synthesis"

export type Subtask = {
  id: Id
  workspaceID: Id
  parentID?: Id
  creatorType: "user" | "agent"
  creatorAgentID?: Id
  assigneeID?: Id
  title: string
  instruction: string
  constraints?: string
  expected?: string
  mode: "research" | "edit"
  state: SubtaskState
  stage: SubtaskStage
  outcome: SubtaskOutcome
  interrupted: boolean
  approvalID?: Id
  activeRunID?: Id
  awaitingChildren: boolean
  resultMessageID?: Id
  runSummary?: string
  error?: string
  attempts: number
  createdAt: number
  startedAt?: number
  repliedAt?: number
}

export type SessionBinding = {
  workspaceID: Id
  agentID: Id
  sessionID: Id
  history?: Id[]
  kind?: "workspace" | "home"
  directory?: string
  agentVersion: number
  updatedAt: number
}

export type ApprovalKind =
  | "ask_person"
  | "outside_roster"
  | "promote_memory"
  | "cross_project"
  | "interrupted"

export type Approval = {
  id: Id
  workspaceID?: Id
  subtaskID?: Id
  agentID?: Id
  kind: ApprovalKind
  title: string
  detail: string
  payload?: Record<string, unknown>
  status: "pending" | "approved" | "rejected"
  createdAt: number
  resolvedAt?: number
  resolution?: string
}

export type Run = {
  id: Id
  subtaskID: Id
  workspaceID: Id
  agentID: Id
  sessionID: Id
  status: "running" | "completed" | "failed" | "paused"
  error?: string
  startedAt: number
  finishedAt?: number
}

export type DmQueueEntry = {
  id: Id
  agentID: Id
  workspaceID?: Id
  directory: string
  text: string
  status: "queued" | "sent" | "failed"
  createdAt: number
}

export type Settings = {
  maxActiveRuns: number
  maxDelegations: number
  maxDepth: number
  synthesis: boolean
}

export type ChatMessage = {
  id: string
  role: "user" | "assistant" | "system"
  author: string
  text: string
  createdAt: number
}

export type ChatContext = {
  agentID: Id
  workspaceID?: Id
  sessionID: Id
  directory: string
  busy: boolean
  messages: ChatMessage[]
  queued: number
}

export type Snapshot = {
  state: {
    version: number
    updatedAt: number
    agents: Record<Id, Agent>
    workspaces: Record<Id, Workspace>
    messages: Record<Id, Message[]>
    subtasks: Record<Id, Subtask>
    bindings: Record<string, SessionBinding>
    memories: Record<Id, Memory>
    approvals: Record<Id, Approval>
    settings: Settings
    dmQueue: Record<Id, DmQueueEntry>
    ui: {
      activeWorkspaceID?: Id
      activeAgentID?: Id
      history?: Record<string, {
        surface: "workspace" | "agent"
        workspaceID?: Id
        agentID?: Id
        taskID?: Id
        column?: "rail" | "chat" | "tasks"
      }>
    }
    runs: Record<Id, Run>
  }
  models: ModelOption[]
  skills: SkillOption[]
  directory: string
  configError?: string
}

export type SnapshotState = Snapshot["state"]
