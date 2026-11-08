import { createInitialState, DEFAULT_SETTINGS } from "./defaults.ts"
import { continuationDispatchLedger, dispatchAdmissionRefusal, dispatchBudgetState, dispatchChildDepth, dispatchFanOutCount, dispatchGroupExhausted, dispatchRefusalReasonCode, reconcileLegacyDispatchGroup, reconcileLegacyTaskBudgets, validateContinuation, type ContinuationRefusal, type DispatchRefusal, type DispatchRefusalReason } from "./dispatch-budget.ts"
import { resolveDispatchGroupID } from "./dispatch-group.ts"
import { parseWorkKind, workKey } from "./queue.ts"
import type {
  Agent,
  Approval,
  ChangeEntry,
  ChangesSince,
  ChatMessage,
  DispatchGroup,
  EntityChange,
  FeedResetReason,
  Id,
  InitJob,
  Memory,
  Message,
  PatchBatch,
  ScopeName,
  ScopeVersions,
  SessionBinding,
  DmQueueEntry,
  Settings,
  SnapshotState,
  Subtask,
  WorkKind,
  Workspace,
} from "./types.ts"

/** Canonical live-stream row identity: one key per workspace/message pair. */
export function streamKey(workspaceID: string, messageID: string): string {
  return `${workspaceID}\u0000${messageID}`
}

type Ctx = any

/** Counters for the explicit full-state snapshot boundary (ticket #131). */
export type CloneStats = {
  enabled: boolean
  count: number
  totalMs: number
  maxMs: number
  lastMs: number
}

const CLONE_DEBUG_ENV = "ENSEMBLE_DEBUG_CLONES"
const NO_CLONE_STATS = { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 }
/** Ticket #138: bounded in-memory change ring for `changes.since`. */
export const CHANGE_RING_LIMIT = 256
/** Ticket #160: legacy group writes per reconciliation pass. */
export const RECONCILE_GROUPS_PER_PASS = 128

export type StoreChangeOptions = {
  /** Boot identity. A different epoch always resets client cursors. */
  epoch?: number
  /** Ring capacity; older cursors receive a reset. */
  ringLimit?: number
  /** Called with one batched set of full-entity changes after persistence. */
  onPatch?: (batch: PatchBatch) => void
  /**
   * Optional domain-event observer for operational logging (ticket #145).
   * Called synchronously after a durable write succeeds. Implementations must
   * be cheap and must never throw; the store guards the call anyway.
   */
  observer?: StoreObserver
}

/**
 * Lifecycle events observed at the store choke points. Keeping this here
 * means retries, approvals, reaping, and cancellation all produce the same
 * transition events without hand-placed log calls at every service branch.
 */
export type StoreObserver = {
  subtask?: (next: Subtask, previous: Subtask | undefined) => void
  subtaskRemoved?: (previous: Subtask) => void
  /** Dispatch-group lifecycle (ticket #160); IDs, counts, and limits only. */
  dispatchGroup?: (next: DispatchGroup, previous: DispatchGroup | undefined) => void
  messageAppended?: (message: Message) => void
  messageSaved?: (next: Message, previous: Message | undefined) => void
  messageRemoved?: (previous: Message) => void
  approval?: (next: Approval, previous: Approval | undefined) => void
  initJob?: (next: InitJob, previous: InitJob | undefined) => void
}
let fullCloneStats = { ...NO_CLONE_STATS }

/** Full-clone metrics are opt-in so ordinary runs pay no timing cost. */
export function cloneDebugEnabled(): boolean {
  const value = process.env[CLONE_DEBUG_ENV]
  return value === "1" || value?.toLowerCase() === "true"
}

export function cloneStats(): CloneStats {
  return { enabled: cloneDebugEnabled(), ...fullCloneStats }
}

export function resetCloneStats(): void {
  fullCloneStats = { ...NO_CLONE_STATS }
}

function cloneState<T>(value: T): T {
  if (!cloneDebugEnabled()) return structuredClone(value)
  const started = performance.now()
  try {
    return structuredClone(value)
  } finally {
    const elapsed = performance.now() - started
    fullCloneStats.count++
    fullCloneStats.totalMs += elapsed
    fullCloneStats.lastMs = elapsed
    if (elapsed > fullCloneStats.maxMs) fullCloneStats.maxMs = elapsed
  }
}

export class V2Store {
  private readonly ctx: Ctx
  private state: SnapshotState
  private readonly onChange?: (version: number) => void
  private readonly epochValue: number
  private readonly ringLimit: number
  private readonly onPatch?: (batch: PatchBatch) => void
  private readonly observer?: StoreObserver
  /**
   * Ticket #138: every mutation is serialized through one write queue so the
   * persisted entity, meta version, and change record cannot interleave with
   * another mutation. `writeTail` always settles (never rejects) so one failed
   * write cannot strand the queue.
   */
  private writeTail: Promise<void> = Promise.resolve()
  /** Recent change entries, oldest first, bounded by `ringLimit`. */
  private changeRing: ChangeEntry[] = []
  /**
   * Ticket #141: latest coordination version that changed each scoped-read
   * scope. A gap uses this to name only the scopes that moved after the
   * client cursor, so recovery never reloads unchanged shell/Work/transcript.
   * On load every scope starts at the loaded version (conservative: a client
   * from before the load cannot prove any scope unchanged).
   */
  private scopeVersionMap: ScopeVersions = { shell: 0, work: 0, transcript: 0 }
  /** Entries not yet published as a batched `patches` event. */
  private pendingChanges: ChangeEntry[] = []
  private publishScheduled = false
  /** Last version included in a published batch. */
  private lastPublishedVersion = 0
  /**
   * Live streaming rows indexed by `workspaceID + NUL + messageID`. Maintenance
   * settles only these rows instead of scanning every message in every
   * workspace. Kept in sync by `saveMessage`/`appendMessage`, the load scan,
   * the storage merge, and removal; cleared on reset/prune.
   */
  private readonly streaming = new Set<string>()
  /**
   * Legacy groups synthesized in memory but not yet written. Reconciliation
   * persists them (and grants live task budgets) on the serialized queue, so
   * `load` and `sync` never write from a read path.
   */
  private readonly pendingReconciliations = new Set<Id>()

  private trackStreaming(message: Message): void {
    const key = streamKey(message.workspaceID, message.id)
    if (message.streaming) this.streaming.add(key)
    else this.streaming.delete(key)
  }

  constructor(ctx: Ctx, onChange?: (version: number) => void, options: StoreChangeOptions = {}) {
    this.ctx = ctx
    this.state = createInitialState()
    this.onChange = onChange
    this.epochValue = options.epoch ?? 0
    this.ringLimit = Math.max(1, options.ringLimit ?? CHANGE_RING_LIMIT)
    this.onPatch = options.onPatch
    this.observer = options.observer
  }

  /** Observers are best-effort; a logging bug must never fail a write. */
  private notify(event: () => void): void {
    try {
      event()
    } catch {}
  }

  async load(): Promise<void> {
    this.state = createInitialState()
    this.streaming.clear()
    this.pendingReconciliations.clear()
    const meta = await this.ctx.storage.get("v2/meta").catch(() => undefined)
    if (meta && typeof meta === "object") {
      this.state.version = Number(meta.version ?? 0)
      this.state.updatedAt = Number(meta.updatedAt ?? Date.now())
      this.state.settings = { ...DEFAULT_SETTINGS, ...(meta.settings ?? {}) }
      this.state.ui = typeof meta.ui === "object" && meta.ui ? { ...meta.ui } : {}
    }
    for (const { value } of await this.scanAll("v2/agent/")) {
      const agent = value as Agent
      if (agent?.id) this.state.agents[agent.id] = agent
    }
    for (const { value } of await this.scanAll("v2/workspace/")) {
      const workspace = value as Workspace
      if (workspace?.id) this.state.workspaces[workspace.id] = workspace
    }
    for (const { value } of await this.scanAll("v2/message/")) {
      const message = value as Message
      if (!message?.workspaceID) continue
      const list = (this.state.messages[message.workspaceID] ??= [])
      list.push(message)
      // Ticket #148: live rows survive load. The service settles terminal,
      // expired, or stale rows from this index after load; load never decides
      // that a stream is dead on its own.
      this.trackStreaming(message)
    }
    for (const list of Object.values(this.state.messages)) {
      list.sort((a, b) => a.seq - b.seq)
    }
    for (const { value } of await this.scanAll("v2/subtask/")) {
      const subtask = value as Subtask
      if (subtask?.id) this.state.subtasks[subtask.id] = subtask
    }
    for (const { value } of await this.scanAll("v2/dispatchgroup/")) {
      const group = value as DispatchGroup
      if (group?.id) this.state.dispatchGroups[group.id] = group
    }
    for (const { value } of await this.scanAll("v2/init/")) {
      const job = value as InitJob
      if (job?.id) this.state.initJobs[job.id] = job
    }
    for (const { value } of await this.scanAll("v2/binding/")) {
      const binding = value as SessionBinding
      if (binding?.workspaceID && binding?.agentID) this.state.bindings[bindingKey(binding.workspaceID, binding.agentID)] = binding
    }
    for (const { value } of await this.scanAll("v2/memory/")) {
      const memory = value as Memory
      if (memory?.id) this.state.memories[memory.id] = memory
    }
    for (const { value } of await this.scanAll("v2/approval/")) {
      const approval = value as Approval
      if (approval?.id) this.state.approvals[approval.id] = approval
    }
    for (const { value } of await this.scanAll("v2/dmqueue/")) {
      const entry = value as DmQueueEntry
      if (entry?.id) this.state.dmQueue[entry.id] = entry
    }
    await this.mergeDmScan()
    for (const subtask of Object.values(this.state.subtasks)) {
      // Backfill the idempotency key for pre-v5.3 rows so resubmitted work
      // still dedupes. In-memory only; it persists on the next save.
      // Unknown legacy kinds coerce to delegation (the pre-union default).
      const kind = parseWorkKind(subtask.workKind) ?? "delegation"
      subtask.workKind = kind
      if (!subtask.queueKey && subtask.assigneeID) {
        subtask.queueKey = workKey({
          actor: subtask.creatorAgentID ?? subtask.creatorType,
          workspaceID: subtask.workspaceID,
          kind,
          parentID: subtask.parentID,
          assigneeID: subtask.assigneeID,
          title: subtask.title,
          instruction: subtask.instruction,
          constraints: subtask.constraints,
          expected: subtask.expected,
        })
      }
      // Ticket #148: working rows are left exactly as stored. Load must never
      // recover them: another service location may still own the claim and a
      // live lease. Recovery belongs to the lease-aware reaper and the
      // no-claim/waiting-work repair pass; rewriting here caused duplicate
      // execution and attempt exhaustion.
    }
    // Legacy rows (persisted before ticket #135) carry no dispatch group.
    // Resolve one from the root ancestor so in-flight work keeps a coherent
    // group; the row becomes durable on its next save.
    this.backfillDispatchGroups()
    // Ticket #160: every referenced group resolves a ledger record. Legacy
    // trees synthesize one in memory here; the service persists and logs the
    // reconciliation on the serialized queue before pumping.
    this.synthesizeLegacyDispatchGroups()
    if (this.state.ui.activeWorkspaceID && !this.state.workspaces[this.state.ui.activeWorkspaceID]) {
      this.state.ui.activeWorkspaceID = undefined
    }
    // A loaded store has no replayable history before its persisted version;
    // clients at that version can resume from the next patch.
    this.changeRing = []
    this.pendingChanges = []
    this.lastPublishedVersion = this.state.version
    this.scopeVersionMap = { shell: this.state.version, work: this.state.version, transcript: this.state.version }
  }

  async saveDmMessage(workspaceKey: string, agentID: string, message: ChatMessage): Promise<void> {
    await this.write(() => this.saveDmMessageNow(workspaceKey, agentID, message))
  }

  private async saveDmMessageNow(workspaceKey: string, agentID: string, message: ChatMessage): Promise<void> {
    const key = bindingKey(workspaceKey, agentID)
    const list = (this.state.dmTranscripts[key] ??= [])
    const index = list.findIndex((item) => item.id === message.id)
    if (index >= 0) list[index] = { ...message }
    else list.push({ ...message })
    list.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    await this.ctx.storage.set(`v2/dm/${workspaceKey}/${agentID}/${message.id}`, { ...message, bindingKey: key })
    await this.commit([])
  }

  async removeDmMessage(workspaceKey: string, agentID: string, id: string): Promise<void> {
    await this.write(async () => {
      const key = bindingKey(workspaceKey, agentID)
      const list = this.state.dmTranscripts[key]
      if (list) {
        const index = list.findIndex((item) => item.id === id)
        if (index >= 0) list.splice(index, 1)
        if (list.length === 0) delete this.state.dmTranscripts[key]
      }
      await this.ctx.storage.remove(`v2/dm/${workspaceKey}/${agentID}/${id}`)
      await this.commit([])
    })
  }

  async moveDmTranscript(fromWorkspaceKey: string, agentID: string, toWorkspaceKey: string): Promise<void> {
    const fromKey = bindingKey(fromWorkspaceKey, agentID)
    const toKey = bindingKey(toWorkspaceKey, agentID)
    if (fromKey === toKey) return
    await this.write(async () => {
      // Authoritative source is storage: union the stored from-prefix rows with
      // any in-memory lines so a retry after an interruption converges instead
      // of losing messages. Phase 1 writes every new key; phase 2 deletes old
      // keys. A crash between phases leaves both copies; retrying the move
      // overwrites the new keys by id and then deletes the old keys, so the
      // worst case is a transient duplicate across bindings, never loss.
      const seen = new Map<string, ChatMessage>()
      for (const { value } of await this.scanAll(`v2/dm/${fromWorkspaceKey}/${agentID}/`)) {
        const stored = value as ChatMessage & { bindingKey?: string }
        if (stored?.id) {
          const { bindingKey: _dropped, ...rest } = stored
          seen.set(stored.id, rest as ChatMessage)
        }
      }
      for (const message of this.state.dmTranscripts[fromKey] ?? []) {
        if (message?.id && !seen.has(message.id)) seen.set(message.id, { ...message })
      }
      for (const message of seen.values()) {
        await this.saveDmMessageNow(toWorkspaceKey, agentID, { ...message, queued: false })
      }
      // Phase 2 runs only after every new key is durable.
      delete this.state.dmTranscripts[fromKey]
      await this.removePrefixNow(`v2/dm/${fromWorkspaceKey}/${agentID}/`)
    })
  }

  /** Highest stored DM `createdAt` across all transcripts (0 when empty). */
  dmMaxCreatedAt(): number {
    let max = 0
    for (const list of Object.values(this.state.dmTranscripts)) {
      for (const message of list) {
        if (typeof message?.createdAt === "number" && message.createdAt > max) max = message.createdAt
      }
    }
    return max
  }

  /**
   * Shared `v2/dm/` scan → dedupe-by-id → deterministic-sort ingest used by
   * both the initial load and sync paths so they cannot drift apart.
   */
  private async mergeDmScan(): Promise<void> {
    const known = new Set<string>()
    for (const [binding, list] of Object.entries(this.state.dmTranscripts)) {
      for (const message of list) known.add(`${binding}\u0000${message.id}`)
    }
    for (const { value } of await this.scanAll("v2/dm/")) {
      const message = value as ChatMessage & { bindingKey: string }
      if (!message?.id || !message?.bindingKey) continue
      const key = `${message.bindingKey}\u0000${message.id}`
      if (known.has(key)) continue
      known.add(key)
      const list = (this.state.dmTranscripts[message.bindingKey] ??= [])
      const { bindingKey: _dropped, ...rest } = message
      list.push(rest)
    }
    for (const list of Object.values(this.state.dmTranscripts)) {
      list.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    }
  }

  async pruneDmForAgent(agentID: string): Promise<void> {
    await this.write(async () => {
      for (const { key } of await this.scanAll("v2/dm/")) {
        const parts = key.split("/")
        if (parts[3] === agentID) await this.ctx.storage.remove(key)
      }
      for (const key of Object.keys(this.state.dmTranscripts)) {
        if (key.endsWith(`:${agentID}`)) delete this.state.dmTranscripts[key]
      }
      await this.commit([])
    })
  }

  async sync(): Promise<boolean> {
    // Consistency boundary for readers (ticket #138): sync hydrates local
    // state, so it runs on the same queue as writes. A concurrent mutation can
    // neither be mistaken for a foreign version nor be overwritten by an older
    // stored version when the scan resumes.
    return this.write(() => this.syncNow())
  }

  private async syncNow(): Promise<boolean> {
    // Bindings are the one collection that must be refreshed even when the
    // global storage version is unchanged. Tool calls resolve the calling
    // session through this map, and a local write can advance the version
    // without having refreshed another process's binding.
    await this.refreshBindings()
    const meta = await this.ctx.storage.get("v2/meta").catch(() => undefined)
    const version = Number((meta as any)?.version ?? 0)
    if (version <= this.state.version) return false
    for (const { value } of await this.scanAll("v2/agent/")) {
      const agent = value as Agent
      if (agent?.id) this.state.agents[agent.id] = agent
    }
    for (const { value } of await this.scanAll("v2/workspace/")) {
      const workspace = value as Workspace
      if (!workspace?.id) continue
      const current = this.state.workspaces[workspace.id]
      if (!current) {
        this.state.workspaces[workspace.id] = workspace
        continue
      }
      current.name = workspace.name
      current.directory = workspace.directory
      current.leaderID = workspace.leaderID
      current.memberIDs = [...workspace.memberIDs]
      current.synthesis = workspace.synthesis
      current.archived = workspace.archived
      current.paused = workspace.paused
      current.configVersion = workspace.configVersion
      // Another location may have appended messages; never move nextSeq
      // backwards or sequence keys would collide.
      current.nextSeq = Math.max(current.nextSeq, workspace.nextSeq)
      current.lastActiveAt = Math.max(current.lastActiveAt, workspace.lastActiveAt)
    }
    // Coordination state: a second location/service view must see the same
    // queue. Subtasks, messages, approvals, memories, and the DM queue merge
    // by id; deletions do not propagate (matches agent/binding behavior).
    //
    // Single-process claim boundary: claim ownership (`claimedBy`,
    // `leaseUntil`, `activeRunID`) is process-local — the owning process
    // drives the bound native session and renews the lease by heartbeat.
    // `sync()` therefore never overwrites a locally held claim with a
    // storage row's claim fields: another process (or a stale row) cannot
    // steal this process's claim through a merge. When this process holds no
    // claim, the storage row's claim fields are adopted so a foreign live
    // claim stays visible and this instance will not double-claim it while
    // its lease is fresh — always re-check ownership before running (see
    // `claimWon` in queue.ts). Two processes actively pumping against one
    // store is unsupported: `sharedEnsemble()` keeps one service per host
    // realm and `sync()` exists to converge cross-location views of it.
    // Runs stay instance-owned: they track live native sessions, which only
    // the owning process can drive.
    for (const { value } of await this.scanAll("v2/subtask/")) {
      const subtask = value as Subtask
      if (!subtask?.id) continue
      const current = this.state.subtasks[subtask.id]
      if (!current) {
        this.state.subtasks[subtask.id] = subtask
        continue
      }
      if (current.claimedBy !== undefined) {
        const { claimedBy: _claimed, leaseUntil: _lease, activeRunID: _run, ...rest } = subtask
        Object.assign(current, rest)
        continue
      }
      this.state.subtasks[subtask.id] = subtask
    }
    this.backfillDispatchGroups()
    for (const { value } of await this.scanAll("v2/dispatchgroup/")) {
      const group = value as DispatchGroup
      if (!group?.id) continue
      // A locally synthesized legacy group is not durable yet; a storage row
      // always wins once it exists.
      if (this.pendingReconciliations.has(group.id)) continue
      this.state.dispatchGroups[group.id] = group
    }
    this.synthesizeLegacyDispatchGroups()
    for (const { value } of await this.scanAll("v2/init/")) {
      const job = value as InitJob
      if (!job?.id) continue
      const current = this.state.initJobs[job.id]
      // Local running jobs own their session; a staler storage view must not
      // overwrite them mid-run. Finished jobs adopt the stored state.
      if (current?.state === "running" && job.state === "running") continue
      this.state.initJobs[job.id] = job
    }
    const knownMessages = new Map<string, Set<string>>()
    for (const [workspaceID, list] of Object.entries(this.state.messages)) {
      const ids = new Set<string>()
      for (const message of list) ids.add(message.id)
      knownMessages.set(workspaceID, ids)
    }
    for (const { value } of await this.scanAll("v2/message/")) {
      const message = value as Message
      if (!message?.workspaceID || !message?.id) continue
      let ids = knownMessages.get(message.workspaceID)
      if (!ids) {
        ids = new Set<string>()
        knownMessages.set(message.workspaceID, ids)
      }
      // Merge by id in one pass: the stored scan is linear and the local id
      // index turns the duplicate check into O(1) instead of a list scan per
      // foreign row (the old merge was quadratic at 10k messages).
      if (ids.has(message.id)) continue
      ids.add(message.id)
      const list = (this.state.messages[message.workspaceID] ??= [])
      list.push(message)
      this.trackStreaming(message)
    }
    for (const list of Object.values(this.state.messages)) {
      list.sort((a, b) => a.seq - b.seq)
    }
    for (const { value } of await this.scanAll("v2/approval/")) {
      const approval = value as Approval
      if (approval?.id) this.state.approvals[approval.id] = approval
    }
    for (const { value } of await this.scanAll("v2/memory/")) {
      const memory = value as Memory
      if (memory?.id) this.state.memories[memory.id] = memory
    }
    for (const { value } of await this.scanAll("v2/dmqueue/")) {
      const entry = value as DmQueueEntry
      if (entry?.id) this.state.dmQueue[entry.id] = entry
    }
    for (const { value } of await this.scanAll("v2/binding/")) {
      const binding = value as SessionBinding
      if (binding?.workspaceID && binding?.agentID) this.state.bindings[bindingKey(binding.workspaceID, binding.agentID)] = binding
    }
    await this.mergeDmScan()
    this.state.version = version
    this.state.updatedAt = Number((meta as any)?.updatedAt ?? this.state.updatedAt)
    // A foreign version cannot be attributed to one scope from the merge
    // alone; every scope is conservatively stale at this version.
    this.scopeVersionMap = { shell: version, work: version, transcript: version }
    return true
  }

  /**
   * The one explicit full-state clone boundary. Service reads use the
   * targeted accessors below or `read()`; tests may also detach state here.
   */
  snapshot(): SnapshotState {
    return cloneState(this.state)
  }

  /** Live read-only view for broad read passes (never mutate or persist it). */
  read(): SnapshotState {
    return this.state
  }

  version(): number {
    return this.state.version
  }

  /** Latest version that changed each scoped-read scope (ticket #141). */
  scopeVersions(): ScopeVersions {
    return { ...this.scopeVersionMap }
  }

  /** Cheap heartbeat read: no full-state clone. */
  revisionInfo(): { version: number; workspaceDirectories: string[] } {
    return {
      version: this.state.version,
      workspaceDirectories: Object.values(this.state.workspaces)
        .filter((workspace) => !workspace.archived)
        .map((workspace) => workspace.directory),
    }
  }

  /** Storage version only, used to detect foreign writes without hydrating. */
  async storedVersion(): Promise<number> {
    const meta = await this.ctx.storage.get("v2/meta").catch(() => undefined)
    return Number((meta as any)?.version ?? 0)
  }

  settings(): Settings {
    return structuredClone(this.state.settings)
  }

  agents(): Agent[] {
    return Object.values(this.state.agents)
  }

  agent(agentID: string): Agent | undefined {
    return this.state.agents[agentID]
  }

  workspaces(): Workspace[] {
    return Object.values(this.state.workspaces)
  }

  workspace(workspaceID: string): Workspace | undefined {
    return this.state.workspaces[workspaceID]
  }

  subtasks(): Subtask[] {
    return Object.values(this.state.subtasks)
  }

  subtask(subtaskID: string): Subtask | undefined {
    return this.state.subtasks[subtaskID]
  }

  dispatchGroups(): DispatchGroup[] {
    return Object.values(this.state.dispatchGroups)
  }

  dispatchGroup(groupID: string): DispatchGroup | undefined {
    return this.state.dispatchGroups[groupID]
  }

  messages(workspaceID: string): readonly Message[] {
    return this.state.messages[workspaceID] ?? []
  }

  message(workspaceID: string, messageID: string): Message | undefined {
    return (this.state.messages[workspaceID] ?? []).find((message) => message.id === messageID)
  }

  allMessages(): ReadonlyArray<readonly Message[]> {
    return Object.values(this.state.messages)
  }

  /**
   * Active streaming rows only, as maintenance input. This index is updated on
   * every save/merge/remove, so terminal-stream settling never scans the
   * transcript.
   */
  streamingMessages(): Array<{ workspaceID: string; messageID: string }> {
    return [...this.streaming].map((key) => {
      const separator = key.indexOf("\u0000")
      return { workspaceID: key.slice(0, separator), messageID: key.slice(separator + 1) }
    })
  }

  /** True while one row is still the live stream (ticket #139 finality guard). */
  isStreaming(workspaceID: string, messageID: string): boolean {
    return this.streaming.has(streamKey(workspaceID, messageID))
  }

  approvals(): Approval[] {
    return Object.values(this.state.approvals)
  }

  approval(approvalID: string): Approval | undefined {
    return this.state.approvals[approvalID]
  }

  initJobs(): InitJob[] {
    return Object.values(this.state.initJobs)
  }

  initJob(jobID: string): InitJob | undefined {
    return this.state.initJobs[jobID]
  }

  memories(): Memory[] {
    return Object.values(this.state.memories)
  }

  memory(memoryID: string): Memory | undefined {
    return this.state.memories[memoryID]
  }

  dmQueue(): DmQueueEntry[] {
    return Object.values(this.state.dmQueue)
  }

  dmQueueEntry(entryID: string): DmQueueEntry | undefined {
    return this.state.dmQueue[entryID]
  }

  dmTranscript(workspaceKey: string, agentID: string): readonly ChatMessage[] {
    return this.state.dmTranscripts[bindingKey(workspaceKey, agentID)] ?? []
  }

  bindings(): SessionBinding[] {
    return Object.values(this.state.bindings)
  }

  bindingForSession(sessionID: string): SessionBinding | undefined {
    return Object.values(this.state.bindings).find(
      (item) => item.sessionID === sessionID || (item.history ?? []).includes(sessionID),
    )
  }

  ui(): SnapshotState["ui"] {
    return this.state.ui
  }

  /**
   * Targeted mutable copies for read-modify-save paths. Only the entity is
   * cloned; the rest of the state stays shared and untouched until the save.
   */
  cloneAgent(agentID: string): Agent | undefined {
    const agent = this.state.agents[agentID]
    return agent ? structuredClone(agent) : undefined
  }

  cloneWorkspace(workspaceID: string): Workspace | undefined {
    const workspace = this.state.workspaces[workspaceID]
    return workspace ? structuredClone(workspace) : undefined
  }

  cloneSubtask(subtaskID: string): Subtask | undefined {
    const subtask = this.state.subtasks[subtaskID]
    return subtask ? structuredClone(subtask) : undefined
  }

  cloneApproval(approvalID: string): Approval | undefined {
    const approval = this.state.approvals[approvalID]
    return approval ? structuredClone(approval) : undefined
  }

  cloneInitJob(jobID: string): InitJob | undefined {
    const job = this.state.initJobs[jobID]
    return job ? structuredClone(job) : undefined
  }

  cloneMemory(memoryID: string): Memory | undefined {
    const memory = this.state.memories[memoryID]
    return memory ? structuredClone(memory) : undefined
  }

  cloneMessage(workspaceID: string, messageID: string): Message | undefined {
    const message = this.message(workspaceID, messageID)
    return message ? structuredClone(message) : undefined
  }

  cloneDmQueueEntry(entryID: string): DmQueueEntry | undefined {
    const entry = this.state.dmQueue[entryID]
    return entry ? structuredClone(entry) : undefined
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    return this.write(async () => {
      this.state.settings = { ...this.state.settings, ...patch }
      await this.commit([{ entity: "settings", op: "upsert", settings: structuredClone(this.state.settings) }])
      return this.settings()
    })
  }

  async saveAgent(agent: Agent): Promise<void> {
    await this.write(async () => {
      this.state.agents[agent.id] = agent
      await this.ctx.storage.set(`v2/agent/${agent.id}`, agent)
      await this.commit([{ entity: "agent", op: "upsert", agent: structuredClone(agent) }])
    })
  }

  async removeAgent(id: string): Promise<void> {
    await this.write(async () => {
      delete this.state.agents[id]
      await this.ctx.storage.remove(`v2/agent/${id}`)
      await this.commit([{ entity: "agent", op: "remove", id }])
    })
  }

  async saveWorkspace(workspace: Workspace): Promise<void> {
    await this.write(async () => {
      this.state.workspaces[workspace.id] = workspace
      await this.ctx.storage.set(`v2/workspace/${workspace.id}`, workspace)
      await this.commit([{ entity: "workspace", op: "upsert", workspace: structuredClone(workspace) }])
    })
  }

  async removeWorkspace(id: string): Promise<void> {
    await this.write(() => this.removeWorkspaceNow(id))
  }

  private async removeWorkspaceNow(id: string): Promise<void> {
    delete this.state.workspaces[id]
    await this.ctx.storage.remove(`v2/workspace/${id}`)
    await this.commit([{ entity: "workspace", op: "remove", id }])
  }

  async appendMessage(
    workspaceID: string,
    input: Omit<Message, "workspaceID" | "seq">,
  ): Promise<Message> {
    return this.write(async () => {
      const workspace = this.state.workspaces[workspaceID]
      if (!workspace) throw Object.assign(new Error("Workspace not found."), { code: "not_found" })
      const message: Message = { ...input, workspaceID, seq: workspace.nextSeq++ }
      const list = (this.state.messages[workspaceID] ??= [])
      list.push(message)
      list.sort((a, b) => a.seq - b.seq)
      this.trackStreaming(message)
      await this.ctx.storage.set(`v2/message/${workspaceID}/${String(message.seq).padStart(8, "0")}`, message)
      await this.ctx.storage.set(`v2/workspace/${workspaceID}`, workspace)
      await this.commit([{ entity: "message", op: "upsert", message: structuredClone(message) }])
      this.notify(() => this.observer?.messageAppended?.(message))
      return message
    })
  }

  async saveUi(ui: SnapshotState["ui"]): Promise<void> {
    await this.write(async () => {
      this.state.ui = { ...ui }
      await this.commit([{ entity: "ui", op: "upsert", ui: structuredClone(this.state.ui) }])
    })
  }

  async saveSubtask(subtask: Subtask): Promise<void> {
    await this.write(async () => {
      const previous = this.state.subtasks[subtask.id]
      this.state.subtasks[subtask.id] = subtask
      await this.ctx.storage.set(`v2/subtask/${subtask.id}`, subtask)
      await this.commit([{ entity: "subtask", op: "upsert", task: structuredClone(subtask) }])
      this.notify(() => this.observer?.subtask?.(subtask, previous))
    })
  }

  async saveDispatchGroup(group: DispatchGroup): Promise<void> {
    await this.write(async () => {
      const previous = this.state.dispatchGroups[group.id]
      this.state.dispatchGroups[group.id] = group
      this.pendingReconciliations.delete(group.id)
      await this.ctx.storage.set(`v2/dispatchgroup/${group.id}`, group)
      await this.commit([{ entity: "dispatchGroup", op: "upsert", group: structuredClone(group) }])
      this.notify(() => this.observer?.dispatchGroup?.(group, previous))
    })
  }

  async removeDispatchGroup(id: string): Promise<void> {
    await this.write(async () => {
      const previous = this.state.dispatchGroups[id]
      delete this.state.dispatchGroups[id]
      this.pendingReconciliations.delete(id)
      await this.ctx.storage.remove(`v2/dispatchgroup/${id}`)
      await this.commit([{ entity: "dispatchGroup", op: "remove", id }])
      if (previous) this.notify(() => this.observer?.dispatchGroup?.({ ...previous, closedAt: previous.closedAt ?? Date.now() }, previous))
    })
  }

  /**
   * Ticket #160/#161 dispatch admission seam. One serialized mutation creates
   * the work item and spends its group and command hop. Duplicate task ids and
   * duplicate queue keys are idempotent and never consume twice; a crash can
   * leave at worst an unspent hop with its work item, never a spent hop
   * without work.
   *
   * `enforce` is the #161 policy switch. #160 admits without refusing so the
   * ledger can be observed before enforcement lands; #161 passes true and
   * receives a typed refusal naming the exhausted layer.
   */
  async admitDispatchedSubtask(
    subtask: Subtask,
    options: { enforce?: boolean; maxPerRun?: number; perRunKind?: WorkKind } = {},
  ): Promise<{
    admitted: boolean
    task: Subtask
    group?: DispatchGroup
    previousGroup?: DispatchGroup
    root?: DispatchGroup
    previousRoot?: DispatchGroup
    exhaustedBefore?: boolean
    exhaustedAfter?: boolean
    consumed: boolean
    /** True when an existing row with the same queue key was returned. */
    deduped?: boolean
    reason?: DispatchRefusalReason
    refusal?: DispatchRefusal
  }> {
    return this.write(async () => {
      const existing = this.state.subtasks[subtask.id]
      if (existing) {
        return {
          admitted: true,
          task: existing,
          group: existing.dispatchGroupID ? this.state.dispatchGroups[existing.dispatchGroupID] : undefined,
          consumed: false,
        }
      }
      // Queue-key idempotency belongs to the serialized admission, not to the
      // caller's pre-check: two concurrent identical dispatches both pass the
      // read-side lookup, then exactly one may create work and spend a hop.
      const duplicate = subtask.queueKey
        ? Object.values(this.state.subtasks).find(
            (task) => task.workspaceID === subtask.workspaceID && task.queueKey === subtask.queueKey,
          )
        : undefined
      if (duplicate) {
        return {
          admitted: true,
          task: duplicate,
          group: duplicate.dispatchGroupID ? this.state.dispatchGroups[duplicate.dispatchGroupID] : undefined,
          consumed: false,
          deduped: true,
        }
      }
      const parent = subtask.parentID ? this.state.subtasks[subtask.parentID] : undefined
      const groupID = subtask.dispatchGroupID
      const depth = dispatchChildDepth(parent, groupID, this.state.subtasks)
      subtask.dispatchDepth = depth
      const group = groupID ? this.state.dispatchGroups[groupID] : undefined
      if (!group) {
        this.state.subtasks[subtask.id] = subtask
        await this.ctx.storage.set(`v2/subtask/${subtask.id}`, subtask)
        await this.commit([{ entity: "subtask", op: "upsert", task: structuredClone(subtask) }])
        this.notify(() => this.observer?.subtask?.(subtask, undefined))
        return { admitted: true, task: subtask, consumed: false }
      }
      const root = group.id === group.rootID ? group : this.state.dispatchGroups[group.rootID]
      const exhaustedBefore = dispatchGroupExhausted(group, this.state.dispatchGroups)
      if (options.enforce) {
        const budget = dispatchBudgetState({
          group,
          groups: this.state.dispatchGroups,
          task: parent,
          subtasks: this.state.subtasks,
          nextDepth: depth,
        })
        const fanOutUsed = parent ? dispatchFanOutCount(parent.id, this.state.subtasks, options.perRunKind) : 0
        const refusal = dispatchAdmissionRefusal({ state: budget, maxPerRun: options.maxPerRun, fanOutUsed })
        if (refusal) {
          return {
            admitted: false,
            task: subtask,
            group,
            previousGroup: group,
            root,
            previousRoot: root,
            consumed: false,
            reason: dispatchRefusalReasonCode(refusal),
            refusal,
          }
        }
      }
      const nextGroup: DispatchGroup = { ...group, usedHops: group.usedHops + 1 }
      if (root === group) nextGroup.commandUsedHops = (group.commandUsedHops ?? 0) + 1
      const nextRoot = root === group
        ? nextGroup
        : root && root.commandUsedHops !== undefined
          ? { ...root, commandUsedHops: root.commandUsedHops + 1 }
          : root
      this.state.dispatchGroups[nextGroup.id] = nextGroup
      if (nextRoot && nextRoot.id !== nextGroup.id) this.state.dispatchGroups[nextRoot.id] = nextRoot
      this.state.subtasks[subtask.id] = subtask
      // Work item first: a crash between these writes under-counts the hop
      // rather than spending budget with no queued work.
      await this.ctx.storage.set(`v2/subtask/${subtask.id}`, subtask)
      await this.ctx.storage.set(`v2/dispatchgroup/${nextGroup.id}`, nextGroup)
      if (nextRoot && nextRoot.id !== nextGroup.id) await this.ctx.storage.set(`v2/dispatchgroup/${nextRoot.id}`, nextRoot)
      const changes: EntityChange[] = [
        { entity: "subtask", op: "upsert", task: structuredClone(subtask) },
        { entity: "dispatchGroup", op: "upsert", group: structuredClone(nextGroup) },
        ...(nextRoot && nextRoot.id !== nextGroup.id
          ? [{ entity: "dispatchGroup" as const, op: "upsert" as const, group: structuredClone(nextRoot) }]
          : []),
      ]
      await this.commit(changes)
      this.notify(() => this.observer?.subtask?.(subtask, undefined))
      this.notify(() => this.observer?.dispatchGroup?.(nextGroup, group))
      if (nextRoot && nextRoot.id !== nextGroup.id) this.notify(() => this.observer?.dispatchGroup?.(nextRoot, root))
      return {
        admitted: true,
        task: subtask,
        group: nextGroup,
        previousGroup: group,
        root: nextRoot,
        previousRoot: root,
        exhaustedBefore,
        exhaustedAfter: dispatchGroupExhausted(nextGroup, this.state.dispatchGroups),
        consumed: true,
      }
    })
  }

  /**
   * Ticket #162 continuation creation. One serialized mutation validates the
   * referenced exhausted group, increments the root continuation count, seals
   * the parent as continued, and persists the linked segment. Creation spends
   * no hop and never creates work; the first delegation spends its own hop
   * through `admitDispatchedSubtask`.
   */
  async createContinuationDispatchGroup(input: {
    id: Id
    workspaceID: Id
    parentID: Id
    maxHops: number
    now?: number
  }): Promise<
    | { ok: true; group: DispatchGroup; root: DispatchGroup; parent: DispatchGroup }
    | { ok: false; refusal: ContinuationRefusal }
  > {
    return this.write(async () => {
      const existing = this.state.dispatchGroups[input.id]
      const parent = this.state.dispatchGroups[input.parentID]
      if (existing && parent) {
        const root = this.state.dispatchGroups[existing.rootID]
        return { ok: true, group: existing, root: root ?? existing, parent }
      }
      const validation = validateContinuation({
        continuationOf: input.parentID,
        groupMaxHops: input.maxHops,
        groups: this.state.dispatchGroups,
        workspaceID: input.workspaceID,
        isLeader: true,
      })
      if (!validation.ok) return { ok: false, refusal: validation.refusal }
      const ledger = continuationDispatchLedger({
        id: input.id,
        root: validation.root,
        parent: validation.parent,
        maxHops: validation.maxHops,
        ...(input.now !== undefined ? { now: input.now } : {}),
      })
      this.state.dispatchGroups[ledger.group.id] = ledger.group
      this.state.dispatchGroups[ledger.root.id] = ledger.root
      if (ledger.parent.id !== ledger.root.id) this.state.dispatchGroups[ledger.parent.id] = ledger.parent
      await this.ctx.storage.set(`v2/dispatchgroup/${ledger.group.id}`, ledger.group)
      await this.ctx.storage.set(`v2/dispatchgroup/${ledger.root.id}`, ledger.root)
      if (ledger.parent.id !== ledger.root.id) await this.ctx.storage.set(`v2/dispatchgroup/${ledger.parent.id}`, ledger.parent)
      const changes: EntityChange[] = [
        { entity: "dispatchGroup", op: "upsert", group: structuredClone(ledger.group) },
        { entity: "dispatchGroup", op: "upsert", group: structuredClone(ledger.root) },
        ...(ledger.parent.id !== ledger.root.id
          ? [{ entity: "dispatchGroup" as const, op: "upsert" as const, group: structuredClone(ledger.parent) }]
          : []),
      ]
      await this.commit(changes)
      this.notify(() => this.observer?.dispatchGroup?.(ledger.group, undefined))
      this.notify(() => this.observer?.dispatchGroup?.(ledger.root, validation.parent.id === validation.root.id ? validation.parent : validation.root))
      if (ledger.parent.id !== ledger.root.id) this.notify(() => this.observer?.dispatchGroup?.(ledger.parent, validation.parent))
      return {
        ok: true,
        group: ledger.group,
        root: ledger.root,
        parent: ledger.parent,
      }
    })
  }

  /**
   * Persist and log legacy group reconciliation. Idempotent: only groups
   * synthesized since the last pass are written, in one version. Live tasks
   * receive the remaining group budget as their task budget (#161 enforces).
   */
  async reconcileDispatchGroups(): Promise<Id[]> {
    return this.write(async () => {
      const ids = [...this.pendingReconciliations]
      if (ids.length === 0) return []
      // A large upgrade can surface thousands of one-command groups. Writes
      // are bounded per pass so reconciliation never blocks pump work; groups
      // with consumed hops go first because they carry budget truth.
      const ordered = [
        ...ids.filter((id) => (this.state.dispatchGroups[id]?.usedHops ?? 0) > 0),
        ...ids.filter((id) => (this.state.dispatchGroups[id]?.usedHops ?? 0) === 0),
      ]
      const batch = ordered.slice(0, RECONCILE_GROUPS_PER_PASS)
      // Index once: a large pre-ledger history must not make reconciliation
      // quadratic in groups × tasks.
      const byGroup = new Map<Id, Subtask[]>()
      for (const task of Object.values(this.state.subtasks)) {
        const id = task.dispatchGroupID
        if (!id) continue
        const bucket = byGroup.get(id)
        if (bucket) bucket.push(task)
        else byGroup.set(id, [task])
      }
      const changedGroups: DispatchGroup[] = []
      const changes: EntityChange[] = []
      for (const id of batch) {
        const group = this.state.dispatchGroups[id]
        if (!group) continue
        // Only live rows that still lack a budget are filled; a stored budget
        // (including zero) is deliberate and is never overwritten. Mutate the
        // existing row in place so a concurrent foreign field update is not
        // replaced by a stale clone.
        for (const grant of reconcileLegacyTaskBudgets(group, byGroup.get(id) ?? [])) {
          const task = this.state.subtasks[grant.id]
          if (!task) continue
          task.taskMaxHops = grant.taskMaxHops
          await this.ctx.storage.set(`v2/subtask/${task.id}`, task)
          changes.push({ entity: "subtask", op: "upsert", task: structuredClone(task) })
        }
        await this.ctx.storage.set(`v2/dispatchgroup/${id}`, group)
        changes.push({ entity: "dispatchGroup", op: "upsert", group: structuredClone(group) })
        changedGroups.push(group)
      }
      for (const id of batch) this.pendingReconciliations.delete(id)
      if (changes.length === 0) return []
      await this.commit(changes)
      for (const group of changedGroups) this.notify(() => this.observer?.dispatchGroup?.(group, undefined))
      return changedGroups.map((group) => group.id)
    })
  }

  async saveInitJob(job: InitJob): Promise<void> {
    await this.write(async () => {
      const previous = this.state.initJobs[job.id]
      this.state.initJobs[job.id] = job
      await this.ctx.storage.set(`v2/init/${job.id}`, job)
      await this.commit([{ entity: "initJob", op: "upsert", job: structuredClone(job) }])
      this.notify(() => this.observer?.initJob?.(job, previous))
    })
  }

  async removeInitJob(id: string): Promise<void> {
    await this.write(async () => {
      const previous = this.state.initJobs[id]
      delete this.state.initJobs[id]
      await this.ctx.storage.remove(`v2/init/${id}`)
      await this.commit([{ entity: "initJob", op: "remove", id }])
      if (previous) this.notify(() => this.observer?.initJob?.({ ...previous }, previous))
    })
  }

  /**
   * Direct storage re-read of one subtask row, bypassing the in-memory
   * snapshot. Used for claim fencing: after persisting a claim, the runner
   * verifies the stored row still names its run before starting work, so a
   * racing writer cannot be double-claimed silently.
   */
  async readSubtask(id: string): Promise<Subtask | undefined> {
    const stored = await this.ctx.storage.get(`v2/subtask/${id}`).catch(() => undefined)
    return (stored as Subtask | undefined)?.id ? (stored as Subtask) : undefined
  }

  async removeSubtask(id: string): Promise<void> {
    await this.write(async () => {
      const previous = this.state.subtasks[id]
      delete this.state.subtasks[id]
      await this.ctx.storage.remove(`v2/subtask/${id}`)
      await this.commit([{ entity: "subtask", op: "remove", id }])
      if (previous) this.notify(() => this.observer?.subtaskRemoved?.(previous))
    })
  }

  async saveBinding(binding: SessionBinding): Promise<void> {
    await this.write(async () => {
      const key = bindingKey(binding.workspaceID, binding.agentID)
      this.state.bindings[key] = binding
      await this.ctx.storage.set(`v2/binding/${binding.workspaceID}/${binding.agentID}`, binding)
      await this.commit([{ entity: "binding", op: "upsert", binding: structuredClone(binding) }])
    })
  }

  binding(workspaceID: string, agentID: string): SessionBinding | undefined {
    return this.state.bindings[bindingKey(workspaceID, agentID)]
  }

  /** Refresh only the binding map; safe when the global version is unchanged. */
  async refreshBindings(): Promise<void> {
    for (const { value } of await this.scanAll("v2/binding/")) {
      const binding = value as SessionBinding
      if (binding?.workspaceID && binding?.agentID) this.state.bindings[bindingKey(binding.workspaceID, binding.agentID)] = binding
    }
  }

  async saveMemory(memory: Memory): Promise<void> {
    await this.write(async () => {
      this.state.memories[memory.id] = memory
      await this.ctx.storage.set(`v2/memory/${memory.id}`, memory)
      await this.commit([{ entity: "memory", op: "upsert", memory: structuredClone(memory) }])
    })
  }

  async saveDmQueueEntry(entry: DmQueueEntry): Promise<void> {
    await this.write(async () => {
      this.state.dmQueue[entry.id] = entry
      await this.ctx.storage.set(`v2/dmqueue/${entry.id}`, entry)
      await this.commit([])
    })
  }

  async removeDmQueueEntry(id: string): Promise<void> {
    await this.write(async () => {
      delete this.state.dmQueue[id]
      await this.ctx.storage.remove(`v2/dmqueue/${id}`)
      await this.commit([])
    })
  }

  async saveMessage(message: Message): Promise<void> {
    await this.write(async () => {
      const list = (this.state.messages[message.workspaceID] ??= [])
      const index = list.findIndex((item) => item.id === message.id)
      const previous = index >= 0 ? list[index] : undefined
      if (index >= 0) list[index] = message
      else list.push(message)
      list.sort((a, b) => a.seq - b.seq)
      this.trackStreaming(message)
      await this.ctx.storage.set(`v2/message/${message.workspaceID}/${String(message.seq).padStart(8, "0")}`, message)
      await this.commit([{ entity: "message", op: "upsert", message: structuredClone(message) }])
      this.notify(() => this.observer?.messageSaved?.(message, previous))
    })
  }

  /**
   * Persist live streaming text for crash recovery without a coordination
   * version, change-ring entry, or published patch (ticket #139). The durable
   * finalization still goes through `saveMessage`, so a crash loses at most
   * the text after the last checkpoint and never the exact final row.
   */
  async checkpointMessage(message: Message): Promise<void> {
    await this.write(async () => {
      const list = (this.state.messages[message.workspaceID] ??= [])
      const index = list.findIndex((item) => item.id === message.id)
      if (index >= 0) list[index] = message
      else list.push(message)
      list.sort((a, b) => a.seq - b.seq)
      this.trackStreaming(message)
      await this.ctx.storage.set(
        `v2/message/${message.workspaceID}/${String(message.seq).padStart(8, "0")}`,
        structuredClone(message),
      )
    })
  }

  async saveApproval(approval: Approval): Promise<void> {
    await this.write(async () => {
      const previous = this.state.approvals[approval.id]
      this.state.approvals[approval.id] = approval
      await this.ctx.storage.set(`v2/approval/${approval.id}`, approval)
      await this.commit([{ entity: "approval", op: "upsert", approval: structuredClone(approval) }])
      this.notify(() => this.observer?.approval?.(approval, previous))
    })
  }

  async removeBinding(workspaceID: string, agentID: string): Promise<void> {
    await this.write(async () => {
      delete this.state.bindings[bindingKey(workspaceID, agentID)]
      await this.ctx.storage.remove(`v2/binding/${workspaceID}/${agentID}`)
      await this.commit([{ entity: "binding", op: "remove", workspaceID, agentID }])
    })
  }

  async pruneWorkspace(workspaceID: string): Promise<void> {
    await this.write(async () => {
      const messages = [...(this.state.messages[workspaceID] ?? [])]
      const subtaskIDs = Object.values(this.state.subtasks).filter((subtask) => subtask.workspaceID === workspaceID).map((subtask) => subtask.id)
      const dispatchGroupIDs = Object.values(this.state.dispatchGroups).filter((group) => group.workspaceID === workspaceID).map((group) => group.id)
      const initJobIDs = Object.values(this.state.initJobs).filter((job) => job.workspaceID === workspaceID).map((job) => job.id)
      const memoryIDs = Object.values(this.state.memories).filter((memory) => memory.workspaceID === workspaceID).map((memory) => memory.id)
      const approvalIDs = Object.values(this.state.approvals).filter((approval) => approval.workspaceID === workspaceID).map((approval) => approval.id)
      const dmQueueIDs = Object.values(this.state.dmQueue).filter((entry) => entry.workspaceID === workspaceID).map((entry) => entry.id)
      const bindingAgentIDs = Object.values(this.state.bindings).filter((binding) => binding.workspaceID === workspaceID).map((binding) => binding.agentID)
      const dmTranscriptKeys = Object.keys(this.state.dmTranscripts).filter((key) => key === workspaceID || key.startsWith(`${workspaceID}:`))
      delete this.state.messages[workspaceID]
      for (const key of [...this.streaming]) {
        if (key.startsWith(`${workspaceID}\u0000`)) this.streaming.delete(key)
      }
      for (const id of subtaskIDs) delete this.state.subtasks[id]
      for (const id of dispatchGroupIDs) delete this.state.dispatchGroups[id]
      for (const id of initJobIDs) delete this.state.initJobs[id]
      for (const [key, binding] of Object.entries(this.state.bindings)) if (binding.workspaceID === workspaceID) delete this.state.bindings[key]
      for (const id of memoryIDs) delete this.state.memories[id]
      for (const id of approvalIDs) delete this.state.approvals[id]
      for (const id of dmQueueIDs) delete this.state.dmQueue[id]
      for (const key of dmTranscriptKeys) delete this.state.dmTranscripts[key]
      await this.removePrefixNow(`v2/message/${workspaceID}/`)
      await this.removePrefixNow(`v2/binding/${workspaceID}/`)
      await this.removePrefixNow(`v2/dm/${workspaceID}/`)
      for (const id of subtaskIDs) await this.ctx.storage.remove(`v2/subtask/${id}`)
      for (const id of dispatchGroupIDs) await this.ctx.storage.remove(`v2/dispatchgroup/${id}`)
      for (const id of initJobIDs) await this.ctx.storage.remove(`v2/init/${id}`)
      for (const id of memoryIDs) await this.ctx.storage.remove(`v2/memory/${id}`)
      for (const id of approvalIDs) await this.ctx.storage.remove(`v2/approval/${id}`)
      for (const id of dmQueueIDs) await this.ctx.storage.remove(`v2/dmqueue/${id}`)
      delete this.state.workspaces[workspaceID]
      await this.ctx.storage.remove(`v2/workspace/${workspaceID}`)
      // Messages remove through the feed. DM queue/transcript rows are still
      // outside it, so their removal keeps the protocol-3 snapshot fallback.
      await this.commit(
        [
          { entity: "workspace" as const, op: "remove" as const, id: workspaceID },
          ...messages.map((message) => ({ entity: "message" as const, op: "remove" as const, workspaceID, id: message.id })),
          ...subtaskIDs.map((id) => ({ entity: "subtask" as const, op: "remove" as const, id })),
          ...dispatchGroupIDs.map((id) => ({ entity: "dispatchGroup" as const, op: "remove" as const, id })),
          ...initJobIDs.map((id) => ({ entity: "initJob" as const, op: "remove" as const, id })),
          ...memoryIDs.map((id) => ({ entity: "memory" as const, op: "remove" as const, id })),
          ...approvalIDs.map((id) => ({ entity: "approval" as const, op: "remove" as const, id })),
          ...bindingAgentIDs.map((agentID) => ({ entity: "binding" as const, op: "remove" as const, workspaceID, agentID })),
        ],
        dmQueueIDs.length > 0 || dmTranscriptKeys.length > 0,
      )
    })
  }

  async removePrefix(prefix: string): Promise<void> {
    await this.write(() => this.removePrefixNow(prefix))
  }

  private async removePrefixNow(prefix: string): Promise<void> {
    for (const { key } of await this.scanAll(prefix)) {
      await this.ctx.storage.remove(key)
      this.removeFromMemory(key)
    }
  }

  private removeFromMemory(key: string): void {
    const parts = key.split("/")
    if (parts[0] !== "v2") return
    if (parts[1] === "agent" && parts[2]) delete this.state.agents[parts[2]]
    if (parts[1] === "workspace" && parts[2]) delete this.state.workspaces[parts[2]]
    if (parts[1] === "subtask" && parts[2]) delete this.state.subtasks[parts[2]]
    if (parts[1] === "dispatchgroup" && parts[2]) delete this.state.dispatchGroups[parts[2]]
    if (parts[1] === "init" && parts[2]) delete this.state.initJobs[parts[2]]
    if (parts[1] === "memory" && parts[2]) delete this.state.memories[parts[2]]
    if (parts[1] === "approval" && parts[2]) delete this.state.approvals[parts[2]]
    if (parts[1] === "binding" && parts[2] && parts[3]) delete this.state.bindings[`${parts[2]}:${parts[3]}`]
    if (parts[1] === "dmqueue" && parts[2]) delete this.state.dmQueue[parts[2]]
    if (parts[1] === "dm" && parts[2] && parts[3] && parts[4]) {
      const key = `${parts[2]}:${parts[3]}`
      this.state.dmTranscripts[key] = (this.state.dmTranscripts[key] ?? []).filter((message) => message.id !== parts[4])
      if (this.state.dmTranscripts[key].length === 0) delete this.state.dmTranscripts[key]
    }
    if (parts[1] === "message" && parts[2]) {
      const sequence = parts[3]
      const removed = (this.state.messages[parts[2]] ?? []).filter((message) => String(message.seq).padStart(8, "0") === sequence)
      for (const message of removed) this.streaming.delete(streamKey(parts[2], message.id))
      this.state.messages[parts[2]] = (this.state.messages[parts[2]] ?? []).filter((message) => String(message.seq).padStart(8, "0") !== sequence)
      if (this.state.messages[parts[2]].length === 0) delete this.state.messages[parts[2]]
    }
  }

  /**
   * Legacy dispatch-group derivation (ticket #135). One deterministic pass
   * over the loaded rows: stored groups win, children inherit the nearest
   * stored ancestor, and a fully legacy tree derives its group from the root.
   * In-memory only; a derived id persists with the row's next save.
   */
  private backfillDispatchGroups(): void {
    for (const subtask of Object.values(this.state.subtasks)) {
      if (subtask.dispatchGroupID) continue
      subtask.dispatchGroupID = resolveDispatchGroupID(subtask, this.state.subtasks)
    }
  }

  /**
   * Ticket #160: synthesize a ledger record for every referenced group that
   * has none. Stored groups win, so this only runs for pre-ledger trees and
   * for foreign rows merged by `sync`. The pass is in-memory; reconciliation
   * writes and logs on the serialized queue via `reconcileDispatchGroups`.
   */
  private synthesizeLegacyDispatchGroups(): void {
    const byGroup = new Map<Id, Subtask[]>()
    for (const task of Object.values(this.state.subtasks)) {
      const id = task.dispatchGroupID ?? resolveDispatchGroupID(task, this.state.subtasks)
      if (!id) continue
      const bucket = byGroup.get(id)
      if (bucket) bucket.push(task)
      else byGroup.set(id, [task])
    }
    for (const [id, tasks] of byGroup) {
      if (this.state.dispatchGroups[id]) continue
      const workspaceID = tasks[0]?.workspaceID
      if (!workspaceID) continue
      this.state.dispatchGroups[id] = reconcileLegacyDispatchGroup({
        id,
        workspaceID,
        tasks,
        allTasks: this.state.subtasks,
        settings: this.state.settings,
      })
      this.pendingReconciliations.add(id)
    }
  }

  /** True while a synthesized legacy group still needs a durable write. */
  pendingReconciliationCount(): number {
    return this.pendingReconciliations.size
  }

  async reset(): Promise<void> {
    await this.write(async () => {
      const previousPublished = this.lastPublishedVersion
      for (const prefix of ["v2/agent/", "v2/workspace/", "v2/message/", "v2/subtask/", "v2/dispatchgroup/", "v2/init/", "v2/binding/", "v2/memory/", "v2/approval/", "v2/dmqueue/", "v2/dm/"]) {
        await this.removePrefixNow(prefix)
      }
      await this.ctx.storage.remove("v2/meta")
      this.state = createInitialState()
      this.streaming.clear()
      this.pendingReconciliations.clear()
      await this.commit([])
      // A reset destroys prior entity state, so the ring cannot describe the
      // difference. Keep only the new version and publish an explicit reset.
      this.changeRing = []
      this.pendingChanges = []
      this.lastPublishedVersion = this.state.version
      this.scopeVersionMap = { shell: this.state.version, work: this.state.version, transcript: this.state.version }
      this.onPatch?.({
        epoch: this.epochValue,
        from: previousPublished,
        version: this.state.version,
        entries: [],
        reset: true,
      })
    })
  }

  async bump(): Promise<void> {
    await this.write(() => this.commit([]))
  }

  /** Boot epoch that versions every patch and `changes.since` reset. */
  epoch(): number {
    return this.epochValue
  }

  /** Last version fully published as a batch (never a mid-write version). */
  publishedVersion(): number {
    return this.lastPublishedVersion
  }

  /** Resolve after every queued mutation has persisted. */
  async settled(): Promise<void> {
    await this.writeTail
  }

  /**
   * Cursor recovery for the revision heartbeat. A cursor outside the ring, an
   * unknown epoch, a cursor ahead of the store, or a gapped ring all reset to
   * the snapshot path; a fresh cursor gets contiguous full-entity entries.
   * Ticket #150: every reset names its reason so `feed.reset` is attributable.
   */
  changesSince(epoch: number, version: number): ChangesSince {
    const current = this.state.version
    const reset = (reason: FeedResetReason): ChangesSince => ({ epoch: this.epochValue, version: current, reset: true, reason, entries: [] as ChangeEntry[] })
    if (!Number.isFinite(epoch) || !Number.isFinite(version) || version < 0) return reset("invalid-cursor")
    if (epoch !== this.epochValue) return reset("epoch")
    if (version > current) return reset("future-version")
    if (version === current) return { epoch: this.epochValue, version: current, reset: false, entries: [] }
    const entries = this.changeRing.filter((entry) => entry.version > version)
    if (entries.length === 0 || entries[0]!.version !== version + 1) return reset("ring-gap")
    for (let index = 1; index < entries.length; index++) {
      if (entries[index]!.version !== entries[index - 1]!.version + 1) return reset("ring-gap")
    }
    return { epoch: this.epochValue, version: current, reset: false, entries: structuredClone(entries) }
  }

  /** Publish queued changes now (used to put a task patch ahead of pump work). */
  publishPending(): void {
    if (!this.onPatch || this.pendingChanges.length === 0) return
    const entries = this.pendingChanges
    this.pendingChanges = []
    const version = entries.at(-1)!.version
    let reset = false
    let expected = this.lastPublishedVersion + 1
    for (const entry of entries) {
      if (entry.version !== expected) {
        reset = true
        break
      }
      expected++
    }
    const batch: PatchBatch = reset
      ? { epoch: this.epochValue, from: this.lastPublishedVersion, version, entries: [], reset: true }
      : { epoch: this.epochValue, from: this.lastPublishedVersion, version, entries }
    this.lastPublishedVersion = version
    this.onPatch(batch)
  }

  private write<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writeTail.then(work, work)
    this.writeTail = run.then(() => undefined, () => undefined)
    return run
  }

  private async commit(changes: EntityChange[], nonEntity = changes.length === 0): Promise<number> {
    this.state.version++
    this.state.updatedAt = Date.now()
    const version = this.state.version
    await this.ctx.storage.set("v2/meta", {
      version,
      updatedAt: this.state.updatedAt,
      settings: this.state.settings,
      ui: this.state.ui,
    })
    // Protocol-2 clients only understand subtask changes. Any other entity
    // change sets `other` so they take the snapshot fallback, while protocol-3
    // clients read the full `entities` array and stay incremental.
    this.recordScopeVersions(changes, nonEntity, version)
    const legacy = changes.filter((change) => change.entity === "subtask")
    const shellChanged = legacy.length !== changes.length
    this.appendChange({
      version,
      changes: legacy,
      ...(shellChanged ? { entities: changes } : {}),
      ...(nonEntity || shellChanged ? { other: true } : {}),
      ...(nonEntity ? { nonEntity: true } : {}),
    })
    this.onChange?.(version)
    return version
  }

  /**
   * Attribute one committed version to the scoped reads it invalidates.
   * Non-entity changes (DM retention) cannot be scoped from the change set,
   * so they conservatively move every scope.
   */
  private recordScopeVersions(changes: EntityChange[], nonEntity: boolean, version: number): void {
    if (nonEntity) {
      this.scopeVersionMap = { shell: version, work: version, transcript: version }
      return
    }
    for (const change of changes) {
      // Dispatch groups are part of the Work read model (ticket #160): a Work
      // resync carries them with the visible tasks.
      const scope: ScopeName = change.entity === "subtask" || change.entity === "dispatchGroup"
        ? "work"
        : change.entity === "message"
          ? "transcript"
          : "shell"
      this.scopeVersionMap[scope] = version
    }
  }

  private appendChange(entry: ChangeEntry): void {
    this.changeRing.push(entry)
    if (this.changeRing.length > this.ringLimit) {
      this.changeRing.splice(0, this.changeRing.length - this.ringLimit)
    }
    this.pendingChanges.push(entry)
    this.schedulePublish()
  }

  private schedulePublish(): void {
    if (!this.onPatch || this.publishScheduled) return
    this.publishScheduled = true
    queueMicrotask(() => {
      this.publishScheduled = false
      this.publishPending()
    })
  }

  private async scanAll(prefix: string): Promise<Array<{ key: string; value: unknown }>> {
    const entries: Array<{ key: string; value: unknown }> = []
    let cursor: string | undefined
    do {
      const page = await this.ctx.storage.scan({ prefix, ...(cursor ? { after: cursor } : {}), limit: 500 })
      entries.push(...(page.entries ?? []))
      cursor = page.next
    } while (cursor)
    return entries
  }
}

export function bindingKey(workspaceID: string, agentID: string): string {
  return `${workspaceID}:${agentID}`
}
