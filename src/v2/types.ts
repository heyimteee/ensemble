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

/** Native turn lifecycle (ADR 0010, tickets #215/#216/#217). */
export type NativeTurnPhase =
  | "queued"
  | "working"
  | "retrying"
  | "replied"
  | "failed"
  | "cancelled"
  | "interrupted"

/**
 * One observed native host event, identity-only. Ticket #222 uses this
 * timeline for the "Why this card?" detail. It never carries conversation
 * content or file paths.
 */
export type NativeTurnEvent = {
  type: string
  at: number
  phase?: NativeTurnPhase
  delivery?: string
  messageID?: Id
}

/**
 * Host identity and phase for one native turn (ticket #215). `inboxID` is the
 * user message id; `assistantMessageIDs` are the host text message ids. A
 * retry reuses the same assistant id, so these arrays are append-only.
 */
export type NativeTurnInfo = {
  sessionID: Id
  inboxID?: Id
  assistantMessageIDs: Id[]
  phase: NativeTurnPhase
  startedAt?: number
  settledAt?: number
  resultMessageID?: Id
  errorCode?: string
  /** Ticket #222: bounded, identity-only host event timeline. */
  events?: NativeTurnEvent[]
}

/**
 * Metadata for one attachment (ticket #223). The durable row and the snapshot
 * carry display facts only: no bytes, no store path, and no source path. The
 * service resolves the stored file by conversation id at prompt time.
 */
export type MessageAttachment = {
  id: Id
  /** Original basename shown in the chip; never a filesystem path. */
  name: string
  mime: string
  size: number
  kind: "file" | "image"
}

export type Message = {
  id: Id
  workspaceID: Id
  /**
   * Conversation channel (ticket #212). Group rows omit it and use
   * `workspaceID`; direct rows carry `dm:<agentID>[:<workspaceID>]` so the
   * same durable row, patch, window, retention, and client bound serve both
   * conversation kinds without overloading the workspace id.
   */
  channel?: Id
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
  /**
   * A transient retry/failure notice that an explicit success supersedes
   * (ticket #170). The recovery path removes only these structured notices, so
   * a stale `Retrying…` or false failure line cannot outlive the real answer.
   * Free-form copy is never inspected.
   */
  notice?: "retry" | "failure"
  /**
   * Attachment metadata for one row (ticket #223). Files live in the bounded
   * conversation store; the transcript and snapshot never carry bytes or
   * absolute paths.
   */
  attachments?: MessageAttachment[]
  createdAt: number
  /** Last wall-clock write (delta or finalize). Drives stream staleness so
    * long live streams stay visible while fresh and orphaned rows expire. */
  updatedAt?: number
  /** Correlation ID linking handoff ask/ack/relay/notice legs. */
  correlationID?: string
  /**
   * Native host identity for an ingested row (ticket #215). The turn link is
   * also carried by `taskID`; these ids make duplicate and reconciliation
   * checks exact without reading text.
   */
  native?: {
    sessionID?: Id
    inboxID?: Id
    assistantMessageID?: Id
    turnID?: Id
  }
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

/**
 * Ticket #182: lifecycle of one native OpenCode subagent child session.
 *
 * A NativeSubagentRun is not a Subtask: it never enters the coordination
 * queue, consumes no hop budget, and has no retry/cancel action. It is a
 * compact durable projection of host child sessions, keyed by the child
 * session id so duplicate host events cannot create parallel records.
 */
export type NativeSubagentState = "working" | "replied" | "failed" | "cancelled"
export type NativeSubagentSource = "session-created" | "idle-background" | "tool-call"

export type NativeSubagentRun = {
  childSessionID: Id
  /** Resolved Ensemble-bound parent session; direct parent when no binding matched. */
  parentSessionID: Id
  parentTaskID?: Id
  dispatchGroupID?: Id
  workspaceID?: Id
  parentAgentID?: Id
  parentAgent?: string
  /**
   * Display-only instruction head. Durable records may carry it; logs and
   * diagnostics must not. Bounded to one line by the tracker.
   */
  instruction: string
  state: NativeSubagentState
  startedAt: number
  finishedAt?: number
  source: NativeSubagentSource
}

/**
 * Structured terminal cause for a work item (ticket #168). `native` is a real
 * execution or model error. `delivery`, `lease`, and `attempts` are queue
 * causes: they derive `stalled`, never `failed`. Only rows that can no longer
 * run carry this field; user copy is never inspected to classify a cause.
 */
export type WorkFailureKind = "native" | "delivery" | "lease" | "attempts"

export type WorkFailure = {
  kind: WorkFailureKind
  /** Structured failure-sink reason code, e.g. "deadline-exceeded". */
  reason?: string
}

/** Unit of work on the durable coordination queue. Never a free-form string. */
export type WorkKind = "delegation" | "handoff" | "turn"

export type HandoffInfo = {
  /** Stable correlation ID carried from ask through relay/notice legs. */
  correlationID: string
  /** Agent that asked for the handoff. */
  senderID: string
  /** Agent that must do the work (real routing, never cosmetic). */
  recipientID: string
  /** Chain depth of this hop (asking depth + 1), bounded by the group's depthMax. */
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
  /**
   * Attachment metadata copied from the originating user message (ticket
   * #223). The prompt payload resolves each id against the conversation
   * store; the durable row never carries bytes or paths.
   */
  attachments?: MessageAttachment[]
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
   * The ticket #160 ledger (`DispatchGroup`) carries this id's caps and
   * counters. Legacy rows omit it and resolve a deterministic group from
   * their root ancestor; retry, restart, reassign, and cancel never change it.
   */
  dispatchGroupID?: Id
  /**
   * Unified dispatch depth within the group (ticket #160 ledger seam). The
   * dispatch tools populate it when #161 makes task budgets required; legacy
   * rows derive depth from the parent chain.
   */
  dispatchDepth?: number
  /**
   * Direct dispatches the recipient may make (ticket #160 ledger seam).
   * Zero is valid and means a one-shot ask; #161 enforces the value.
   */
  taskMaxHops?: number
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
  /**
   * Queue delivery timestamp for visibility and operator diagnostics. It is
   * never a retirement authority (ticket #168): a claimed run is governed by
   * `leaseUntil`, and pending work stays queued however old it is.
   */
  deadlineAt?: number
  /** Earliest wall-clock time the work may be claimed again after a retry. */
  retryAfter?: number
  /**
   * Structured terminal cause. Absent on live/queued rows and on legacy
   * terminal rows that never recorded one; those stay `failed` so a genuine
   * native error is never masked.
   */
  failure?: WorkFailure
  /** When the work reached a terminal state. */
  finishedAt?: number
  /** When the work was stopped/cancelled. */
  stoppedAt?: number
  /** Typed handoff record (ticket #55). Present only on workKind "handoff". */
  handoff?: HandoffInfo
  /** Peer-turn record (ticket #57). Present only on workKind "turn". */
  turn?: TurnInfo
  /**
   * Native-first turn provenance (ADR 0010, tickets #215/#216). Native turns
   * are adopted `workKind: "turn"` rows: they have no lease, claim, or
   * attempts, and the queue pump/reaper skip them. `conversationID` is the
   * durable conversation channel (the workspace id for a group, or
   * `dm:<agentID>[:<workspaceID>]` for a direct conversation) and doubles as
   * the task's `workspaceID` so one Work projection serves group and direct.
   */
  origin?: "native"
  adopted?: boolean
  conversationID?: Id
  native?: NativeTurnInfo
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

/**
 * The three conversations an agent can bind a native session to (ADR 0009):
 * the workspace group chat, a workspace direct conversation, and the agent's
 * home direct conversation.
 */
export type BindingKind = "workspace" | "direct" | "home"

/** Native-first migration mode (ADR 0011). */
export type NativeFirstMode = "off" | "shadow" | "on"

/**
 * One agent's binding conversation. The agent is part of the identity because
 * a workspace group has one native session per member agent; the workspace is
 * the shared channel. Older rows omit `kind` and resolve from `workspaceID`.
 */
export type BindingConversation =
  | { kind: "workspace"; workspaceID: Id; agentID: Id }
  | { kind: "direct"; workspaceID: Id; agentID: Id }
  | { kind: "home"; agentID: Id }

export type SessionBinding = {
  workspaceID: Id
  agentID: Id
  sessionID: Id
  history?: Id[]
  kind?: BindingKind
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
  /** Attachment metadata carried with a queued direct send (ticket #223). */
  attachments?: MessageAttachment[]
  status: "queued" | "sent" | "failed"
  createdAt: number
  /** Sender of a direct agent-to-agent message (envelope addressing). */
  fromID?: Id
  /** Correlation ID carried through queue/relay legs (envelope correlation). */
  correlationID?: string
}

/**
 * Durable dispatch-budget ledger for one dispatch group (ticket #160).
 *
 * A root group is the command ledger: it owns the command maximum, command
 * usage, continuation allowance, and continuation usage. Continuation groups
 * reference the root and carry group-local hops plus depth. Budget state
 * (`active`, `exhausted`, `closed`) is derived from these counters and the
 * group's tasks by `dispatchGroupState`, never stored separately.
 */
/** Why a dispatch group closed. A reason code, never task content. */
export type DispatchCloseReason = "continued"

export type DispatchGroup = {
  id: Id
  workspaceID: Id
  /** The root command-ledger group id. A root group names itself. */
  rootID: Id
  /** Continuation parent group; absent on a root group. */
  parentID?: Id
  /** 0 for the root group, then 1..N for continuations in creation order. */
  continuationIndex: number
  /** Hops allowed in this group. */
  maxHops: number
  /** Hops consumed in this group. */
  usedHops: number
  /** Longest allowed ancestor chain within this group. */
  depthMax: number
  /** Root only: total hops allowed for the whole command. */
  commandMaxHops?: number
  /** Root only: hops consumed across every group of the command. */
  commandUsedHops?: number
  /** Root only: continuation groups this command may open. */
  maxContinuations?: number
  /** Root only: continuation groups opened so far. */
  continuationsUsed?: number
  createdAt: number
  closedAt?: number
  /** Why the group closed; a typed reason code, never task content. */
  closeReason?: DispatchCloseReason
  /** Synthesized from pre-ledger rows during upgrade reconciliation. */
  reconciled?: boolean
}

export type Settings = {
  maxActiveRuns: number
  maxDelegations: number
  /** Deprecated: readable for persisted settings, ignored for enforcement. Use dispatchDepth. */
  maxDepth: number
  synthesis: boolean
  /**
   * Native-first migration mode (ADR 0011): `off` keeps today's explicit
   * path, `shadow` compares without changing the visible path, and `on`
   * enables native-first behavior as each surface cuts over.
   */
  nativeFirst?: NativeFirstMode
  /**
   * Native mention-routing kill switch (ADR 0011). Routing runs only under
   * `nativeFirst: "on"`; `false` keeps native messages posting, turns `$Name`
   * into a reference, and appends a visible refusal instead of creating work.
   * User/operator-owned; agents cannot write settings.
   */
  nativeMentionRouting?: boolean
  /** Dispatch budget tiers (ticket #160); captured by each new root group. */
  dispatchGroupMaxHops: number
  dispatchCommandMaxHops: number
  dispatchDepth: number
  dispatchContinuations: number
}

export type ChatMessage = {
  id: string
  role: "user" | "assistant" | "system"
  author: string
  text: string
  /** Attachment metadata for a durable direct row (ticket #223). */
  attachments?: MessageAttachment[]
  createdAt: number
  queued?: boolean
  /** Correlation ID of a direct agent-to-agent envelope, when present. */
  correlationID?: string
}

/**
 * Ticket #214: which native context a direct chat is bound to. `kind` names
 * the binding conversation; `context` is the file-access scope. `sharedSession`
 * marks the pre-cutover rollback, where direct chat is served by the group
 * session instead of its own.
 */
export type ChatConversationContext = {
  kind: BindingKind
  workspaceID?: Id
  workspaceName?: string
  context: "workspace" | "home"
  sessionID: Id
  sharedSession: boolean
  /**
   * Ticket #215: when set, the direct transcript is durable and lives on this
   * channel. The TUI reads the same message rows and patches as a group chat;
   * there is no native-text poll or live overlay on this path.
   */
  channel?: Id
  durable?: boolean
}

export type ChatContext = {
  agentID: Id
  workspaceID?: Id
  sessionID: Id
  directory: string
  busy: boolean
  messages: ChatMessage[]
  queued: number
  conversation: ChatConversationContext
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
  /** Dispatch groups for the projected Work scope (ticket #160). */
  dispatchGroups?: Record<Id, DispatchGroup>
  transcript?: TranscriptWindow
  counts: Record<Id, WorkspaceCounts>
  gate?: Tier3Gate
  /** Catalog/config metadata that travels beside the scoped payload. */
  meta?: FeedMeta
}

/**
 * Ticket #222: one server-paged Work history read for one conversation.
 * Terminal rows only, inside the durable 24 h retention. `next` is an opaque
 * cursor from the last row on this page; absent when the page is the end.
 */
export type WorkHistoryPage = {
  conversationID: Id
  tasks: Record<Id, Subtask>
  groups: Record<Id, DispatchGroup>
  hasMore: boolean
  next?: string
  limit: number
}

export type Snapshot = {
  state: {
    version: number
    updatedAt: number
    agents: Record<Id, Agent>
    workspaces: Record<Id, Workspace>
    messages: Record<Id, Message[]>
    subtasks: Record<Id, Subtask>
    dispatchGroups: Record<Id, DispatchGroup>
    initJobs: Record<Id, InitJob>
    nativeSubagents: Record<Id, NativeSubagentRun>
    bindings: Record<string, SessionBinding>
    memories: Record<Id, Memory>
    approvals: Record<Id, Approval>
    settings: Settings
    dmQueue: Record<Id, DmQueueEntry>
    dmTranscripts: Record<string, ChatMessage[]>
    ui: {
      activeWorkspaceID?: Id
      activeAgentID?: Id
      /**
       * Ticket #171: workspace group ids whose agent rows are collapsed in the
       * rail. Durable so the rail reopens the way the user left it.
       */
      collapsedRailGroups?: Id[]
      /**
       * Ticket #184: dispatch group ids hidden from the Work HISTORY view.
       * Durable view state only; the terminal rows remain for 24h retention.
       */
      dismissedHistoryGroups?: Id[]
      /**
       * Ticket #183: durable left/right pane visibility. Missing means both
       * columns are open; the TUI writes the switches through `ui.save`.
       */
      paneVisibility?: {
        left?: boolean
        right?: boolean
      }
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
  | { entity: "dispatchGroup"; op: "upsert"; group: DispatchGroup }
  | { entity: "dispatchGroup"; op: "remove"; id: Id }
  | { entity: "message"; op: "upsert"; message: Message }
  | { entity: "message"; op: "remove"; workspaceID: Id; channel?: Id; id: Id }
  | { entity: "agent"; op: "upsert"; agent: Agent }
  | { entity: "agent"; op: "remove"; id: Id }
  | { entity: "workspace"; op: "upsert"; workspace: Workspace }
  | { entity: "workspace"; op: "remove"; id: Id }
  | { entity: "approval"; op: "upsert"; approval: Approval }
  | { entity: "approval"; op: "remove"; id: Id }
  | { entity: "binding"; op: "upsert"; binding: SessionBinding }
  | { entity: "binding"; op: "remove"; workspaceID: Id; agentID: Id; kind?: BindingKind }
  | { entity: "memory"; op: "upsert"; memory: Memory }
  | { entity: "memory"; op: "remove"; id: Id }
  | { entity: "initJob"; op: "upsert"; job: InitJob }
  | { entity: "initJob"; op: "remove"; id: Id }
  | { entity: "nativeSubagent"; op: "upsert"; run: NativeSubagentRun }
  | { entity: "nativeSubagent"; op: "remove"; id: Id }
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
type ChangesSinceResult = {
  epoch: number
  version: number
  entries: ChangeEntry[]
  meta?: FeedMeta
  /** Ticket #141: identifies the minimal scoped resync after a reset. */
  scopeVersions?: ScopeVersions
  counts?: Record<Id, WorkspaceCounts>
}

/** Ticket #150: a reset always carries why the cursor could not be served. */
export type ChangesSince =
  | (ChangesSinceResult & { reset: false; reason?: undefined })
  | (ChangesSinceResult & { reset: true; reason: FeedResetReason })

export type SnapshotState = Snapshot["state"]
