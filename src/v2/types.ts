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

export type InitJobState = "running" | "succeeded" | "failed" | "interrupted" | "cancelled"

/**
 * One honest init stage (ticket #118). `running` covers the opaque native
 * `/init` call: it never carries a fabricated percentage or within-stage
 * progress. `reporting` is entered by every terminal path before its explicit
 * report settles.
 */
export type InitPhase = "starting" | "running" | "writing" | "reporting"

/**
 * Durable workspace init job (ticket #100). Not a Subtask: it never enters
 * the work queue. It owns the System Agent transcript row and the temporary
 * native session that runs native `/init`.
 */
export type InitJob = {
  id: Id
  workspaceID: Id
  messageID: Id
  sessionID?: Id
  state: InitJobState
  /**
   * Stages entered in order, including the current one. This is the single
   * stored source; the current stage is always `phases.at(-1)`. Jobs persisted
   * before ticket #118 stored one `phase` field instead, read only through
   * `initJobPhase` as a migration fallback.
   */
  phases?: InitPhase[]
  /** AGENTS.md captured before the run; null means the file did not exist. */
  previousAgentsMD: string | null
  error?: string
  report?: string
  startedAt: number
  finishedAt?: number
}

export type MessageKind = "text" | "task" | "approval" | "system"

export type Message = {
  id: Id
  workspaceID: Id
  seq: number
  author: "user" | "agent" | "system"
  agentID?: Id
  /**
   * Final displayed author (and therefore its transcript color) for
   * non-roster identities such as the System Agent. Roster authors resolve by
   * agentID; the transcript carries one attribution source, never both.
   */
  displayAuthor?: string
  text: string
  kind: MessageKind
  taskID?: Id
  streaming?: boolean
  interrupted?: boolean
  createdAt: number
  /** Last wall-clock write (delta or finalize). Drives stream staleness so
    * long live streams stay visible while fresh and orphaned rows expire. */
  updatedAt?: number
  /** Correlation ID linking handoff ask/ack/relay/notice legs. */
  correlationID?: string
}

/**
 * Ephemeral live text for one streaming transcript row (ticket #139). It is
 * coalesced by the service, never enters the change ring, and never bumps the
 * coordination version. The durable message upsert replaces it on
 * finalization, so a missed event costs only smoothness, never correctness.
 */
export type MessageStream = {
  epoch: number
  workspaceID: Id
  id: Id
  text: string
  updatedAt: number
}

export type SubtaskState = "pending" | "working" | "replied"
export type SubtaskOutcome = "succeeded" | "failed" | "pending"
export type SubtaskStage = "initial" | "synthesis"

/** Unit of work on the durable coordination queue. Never a free-form string. */
export type WorkKind = "delegation" | "handoff" | "turn"

export type HandoffInfo = {
  /** Stable correlation ID carried from ask through relay/notice legs. */
  correlationID: string
  /** Agent that asked for the handoff. */
  senderID: string
  /** Agent that must do the work (real routing, never cosmetic). */
  recipientID: string
  /** Chain depth of this hop (asking depth + 1), bounded by maxDepth. */
  depth: number
  /** Id of the asking run's subtask, if the ask came from inside a run. */
  parentID?: string
  /** Tool input path of the handoff file, relative to the workspace. */
  path?: string
  /** Agent that produced the relayed answer, set when the hop replies. */
  answeredByID?: string
  /**
   * Ticket #71: this hop carries a finished turn (mandatory completion
   * handoff). Completion hops never auto-handoff again — they are terminal
   * deliveries, so chains cannot duplicate work.
   */
  completion?: boolean
  /**
   * Ordered holder chain for loop guards (agent ids, oldest first). The
   * next hop appends its sender before routing.
   */
  chain?: string[]
  /**
   * Ticket #71: this hop consolidates pending completions into one review
   * turn. Item ids live in `itemIDs`; the batch closes only via the review
   * tool once every item is acted on or dismissed.
   */
  batch?: boolean
  /** Item ids consolidated into a batch review. Present only on batch tasks. */
  itemIDs?: string[]
  /** Batch review this completion is grouped into. Present only on items. */
  batchedIn?: string
  /** Per-item disposition set by the review tool. Present only on decided items. */
  decided?: HandoffDecision
}

export type TurnInfo = {
  /** Stable correlation ID carried from the ask through the answer. */
  correlationID: string
  /** Who asked: a user message or an agent group-chat post. */
  askerKind: "user" | "agent"
  /** Agent that asked, when the ask came from inside a run or an agent post. */
  askerID?: string
  /** Agent that produced the answer, set when the turn replies. */
  answeredByID?: string
};

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
  /**
   * Durable dispatch-group identity (ticket #135): the set of Subtasks caused
   * by one dispatch action. One user command mints one group; every descendant
   * handoff, delegation, peer turn, synthesis, completion hop,
   * approval-created task, and group-scoped completion batch inherits it.
   * Legacy rows omit it and resolve a deterministic group from their root
   * ancestor; retry, restart, reassign, and cancel never change it.
   */
  dispatchGroupID?: Id
  /**
   * Durable coordination queue fields (v5.3, ticket #54). The subtask row is
   * the work item: no parallel table, one source of truth. `error` doubles
   * as the last error and `repliedAt` mirrors `finishedAt` for older
   * readers; `deriveWorkStatus` in queue.ts is the canonical lifecycle
   * derivation and never trusts `state` alone.
   */
  /** Unit of work: "delegation" (default), "handoff", or "turn". */
  workKind?: WorkKind
  /** Idempotency key: resubmitting the same work executes once, not twice. */
  queueKey?: string
  /** Run currently holding the lease, if any. */
  claimedBy?: string
  /** Wall-clock expiry of the current claim; expiry re-queues the work. */
  leaseUntil?: number
  /** Wall-clock deadline for the work item; expiry fails it with reason. */
  deadlineAt?: number
  /** Earliest wall-clock time the work may be claimed again after a retry. */
  retryAfter?: number
  /** When the work reached a terminal state. */
  finishedAt?: number
  /** When the work was stopped/cancelled. */
  stoppedAt?: number
  /** Typed handoff record (ticket #55). Present only on workKind "handoff". */
  handoff?: HandoffInfo
  /** Peer-turn record (ticket #57). Present only on workKind "turn". */
  turn?: TurnInfo
  /**
   * General-skill leader triage (ticket #103): the turn must read and either
   * use or delegate the listed skills. This is the single triage source of
   * truth: a non-empty grant identifies a leader triage task. The host session
   * receives a one-run native skill grant for exactly these ids, restored
   * after the turn.
   */
  skillGrants?: string[]
}

export type HandoffDecision = "delegated" | "started" | "ended" | "dismissed"

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
  | "native"

/** Where an approval came from: the host permission system or an Ensemble product decision. */
export type ApprovalSource = "native" | "agent" | "workspace" | "memory"

export type Approval = {
  id: Id
  workspaceID?: Id
  subtaskID?: Id
  agentID?: Id
  kind: ApprovalKind
  /** Origin layer; older rows omit it and derive from kind. New rows always set it. */
  source?: ApprovalSource
  title: string
  detail: string
  payload?: Record<string, unknown>
  status: "pending" | "approved" | "rejected"
  createdAt: number
  resolvedAt?: number
  resolution?: string
}

/**
 * Resolve the origin layer for an approval. Native permission mirrors are
 * the only rows that gate a live native session; every other kind is an
 * Ensemble product decision that gates only its dependent work.
 * Cross-project sharing is a workspace decision (it moves knowledge across
 * projects), never a memory promotion; the kind mapping wins over legacy
 * stored sources so old rows render correctly too.
 */
export function approvalSource(approval: Approval): ApprovalSource {
  if (approval.kind === "cross_project") return "workspace"
  if (approval.kind === "promote_memory") return "memory"
  if (approval.source) return approval.source
  if (approval.kind === "native") return "native"
  if (approval.kind === "ask_person") return "agent"
  if (approval.kind === "outside_roster") return "workspace"
  if (approval.kind === "interrupted") return "workspace"
  return "memory"
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
  /** Sender of a direct agent-to-agent message (envelope addressing). */
  fromID?: Id
  /** Correlation ID carried through queue/relay legs (envelope correlation). */
  correlationID?: string
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
  queued?: boolean
  /** Correlation ID of a direct agent-to-agent envelope, when present. */
  correlationID?: string
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

/** Server-derived rail counts (ticket #141); never computed by client scans. */
export type WorkspaceCounts = {
  unread: number
  busy: number
}

/** Scoped-read scopes (ticket #141). */
export type ScopeName = "shell" | "work" | "transcript"

export type ScopeVersions = Record<ScopeName, number>

/** One paginated transcript window, derived from durable messages. */
export type TranscriptWindow = {
  workspaceID?: Id
  messages: Message[]
  oldestSeq?: number
  newestSeq?: number
  hasMoreOlder: boolean
  limit: number
}

/** Recorded Tier 3 gate decision. */
export type Tier3Gate = {
  enabled: boolean
  reason: "small-history" | "history" | "payload" | "latency"
  messageCount: number
  taskCount: number
  snapshotBytes?: number
  snapshotMs?: number
}

/** One scoped gap resync: only the requested durable scopes are returned. */
export type ScopedResync = {
  epoch: number
  version: number
  scopeVersions: ScopeVersions
  shell?: SnapshotState
  work?: Record<Id, Subtask>
  transcript?: TranscriptWindow
  counts: Record<Id, WorkspaceCounts>
  gate?: Tier3Gate
  /** Catalog/config metadata that travels beside the scoped payload. */
  meta?: FeedMeta
}

export type Snapshot = {
  state: {
    version: number
    updatedAt: number
    agents: Record<Id, Agent>
    workspaces: Record<Id, Workspace>
    messages: Record<Id, Message[]>
    subtasks: Record<Id, Subtask>
    initJobs: Record<Id, InitJob>
    bindings: Record<string, SessionBinding>
    memories: Record<Id, Memory>
    approvals: Record<Id, Approval>
    settings: Settings
    dmQueue: Record<Id, DmQueueEntry>
    dmTranscripts: Record<string, ChatMessage[]>
    ui: {
      activeWorkspaceID?: Id
      activeAgentID?: Id
      history?: Record<string, {
        surface: "workspace" | "agent"
        workspaceID?: Id
        agentID?: Id
        taskID?: Id
        column?: "rail" | "chat"
      }>
    }
    runs: Record<Id, Run>
  }
  models: ModelOption[]
  skills: SkillOption[]
  directory: string
  configError?: string
  modelsError?: string
  /**
   * Versioned-feed metadata reserved for the fine-grained client store.
   * Legacy snapshots omit these; the TUI keeps each in its own signal so a
   * catalog or config refresh never replaces entity state.
   */
  catalogRevision?: number
  configRevision?: number
  protocol?: number
  epoch?: number
  /**
   * Ticket #141 scoped bootstrap metadata. `scoped` means the state carries
   * shell entities, the visible Work projection, and one transcript window
   * rather than the full history. A full snapshot omits it.
   */
  scoped?: boolean
  window?: Omit<TranscriptWindow, "messages">
  counts?: Record<Id, WorkspaceCounts>
  gate?: Tier3Gate
}

/** Cheap heartbeat response: coordination version plus metadata revisions. */
export type Revision = {
  version: number
  catalogRevision: number
  configRevision: number
  protocol: number
  epoch: number
  /** Ticket #141: server-derived counts; absent on older servers. */
  counts?: Record<Id, WorkspaceCounts>
  scopeVersions?: ScopeVersions
  /** Ticket #141: the current gate decision, so a growing workspace can switch paths. */
  gate?: Tier3Gate
}

/**
 * One durable entity change in the versioned feed (tickets #138/#140/#139).
 * Durable changes are full-entity upserts/removes, so duplicate delivery is
 * harmless and a client never needs field-level patch semantics. Message
 * upserts carry the durable row (including a final exact text); ephemeral
 * live text travels on a separate version-neutral event.
 */
export type EntityChange =
  | { entity: "subtask"; op: "upsert"; task: Subtask }
  | { entity: "subtask"; op: "remove"; id: Id }
  | { entity: "message"; op: "upsert"; message: Message }
  | { entity: "message"; op: "remove"; workspaceID: Id; id: Id }
  | { entity: "agent"; op: "upsert"; agent: Agent }
  | { entity: "agent"; op: "remove"; id: Id }
  | { entity: "workspace"; op: "upsert"; workspace: Workspace }
  | { entity: "workspace"; op: "remove"; id: Id }
  | { entity: "approval"; op: "upsert"; approval: Approval }
  | { entity: "approval"; op: "remove"; id: Id }
  | { entity: "binding"; op: "upsert"; binding: SessionBinding }
  | { entity: "binding"; op: "remove"; workspaceID: Id; agentID: Id }
  | { entity: "memory"; op: "upsert"; memory: Memory }
  | { entity: "memory"; op: "remove"; id: Id }
  | { entity: "initJob"; op: "upsert"; job: InitJob }
  | { entity: "initJob"; op: "remove"; id: Id }
  | { entity: "settings"; op: "upsert"; settings: Settings }
  | { entity: "ui"; op: "upsert"; ui: SnapshotState["ui"] }

/**
 * Catalog/config metadata carried beside the durable feed but not versioned
 * into the change ring: a catalog refresh or config error must be visible
 * without bumping the coordination version or replacing entity state.
 */
export type FeedMeta = {
  catalogRevision?: number
  models?: ModelOption[]
  skills?: SkillOption[]
  modelsError?: string
  directory?: string
  configRevision?: number
  configError?: string
}

/**
 * One store mutation at one coordination version. `changes` is the legacy
 * (#138) subtask-only view used by protocol-2 clients. `entities` carries the
 * full shell/message change set for protocol-3 clients; it is present only
 * when the version changed an entity outside the legacy view. `other` keeps
 * the #138 meaning (a protocol-2 client must fall back to a snapshot);
 * `nonEntity` marks a version that changed state the current feed cannot
 * patch (DM retention), so even protocol-3 clients resync.
 */
export type ChangeEntry = {
  version: number
  changes: EntityChange[]
  entities?: EntityChange[]
  other?: boolean
  nonEntity?: boolean
}

/**
 * One batched `patches` event. `entries` are contiguous versions after
 * `from`; `version` is the last entry. `reset` asks the client for a snapshot
 * when the ring could not describe the gap (overflow or a feed reset). An
 * equal-version batch with `entries: []` and `meta` is a metadata revision.
 */
export type PatchBatch = {
  epoch: number
  from: number
  version: number
  entries: ChangeEntry[]
  reset?: boolean
  meta?: FeedMeta
  /** Ticket #141 server-derived counts carried beside the batch. */
  counts?: Record<Id, WorkspaceCounts>
  scopeVersions?: ScopeVersions
}

/** Ticket #150: a cursor reset always names why it could not be served. */
export type FeedResetReason = "invalid-cursor" | "epoch" | "future-version" | "ring-gap"

/** Cursor response for the revision-heartbeat gap recovery path. */
export type ChangesSince = {
  epoch: number
  version: number
  reset: boolean
  /** Ticket #150: why a reset was required; absent when the cursor is valid. */
  reason?: FeedResetReason
  entries: ChangeEntry[]
  meta?: FeedMeta
  /** Ticket #141: identifies the minimal scoped resync after a reset. */
  scopeVersions?: ScopeVersions
  counts?: Record<Id, WorkspaceCounts>
}

export type SnapshotState = Snapshot["state"]
