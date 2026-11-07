import { createInitialState, DEFAULT_SETTINGS } from "./defaults.ts"
import { resolveDispatchGroupID } from "./dispatch-group.ts"
import { parseWorkKind, workKey } from "./queue.ts"
import type {
  Agent,
  Approval,
  ChatMessage,
  InitJob,
  Memory,
  Message,
  SessionBinding,
  DmQueueEntry,
  Settings,
  SnapshotState,
  Subtask,
  Workspace,
} from "./types.ts"

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
  /**
   * Live streaming rows indexed by `workspaceID + NUL + messageID`. Maintenance
   * settles only these rows instead of scanning every message in every
   * workspace. Kept in sync by `saveMessage`/`appendMessage` and the storage
   * merge; cleared on load/reset/prune.
   */
  private readonly streaming = new Set<string>()

  private static streamingKey(workspaceID: string, messageID: string): string {
    return `${workspaceID}\u0000${messageID}`
  }

  private trackStreaming(message: Message): void {
    const key = V2Store.streamingKey(message.workspaceID, message.id)
    if (message.streaming) this.streaming.add(key)
    else this.streaming.delete(key)
  }

  constructor(ctx: Ctx, onChange?: (version: number) => void) {
    this.ctx = ctx
    this.state = createInitialState()
    this.onChange = onChange
  }

  async load(): Promise<void> {
    this.state = createInitialState()
    this.streaming.clear()
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
    }
    for (const list of Object.values(this.state.messages)) {
      list.sort((a, b) => a.seq - b.seq)
      for (const message of list) {
        if (!message.streaming) continue
        message.streaming = false
        message.interrupted = true
        if (!message.text) message.text = "Reply interrupted before completion."
      }
    }
    for (const { value } of await this.scanAll("v2/subtask/")) {
      const subtask = value as Subtask
      if (subtask?.id) this.state.subtasks[subtask.id] = subtask
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
      if (subtask.state === "working") {
        // Restart recovery: re-queue interruptible work without duplicating
        // it and without minting an approval. Attempts and the idempotency
        // key are kept so the retried work resumes its budget instead of
        // starting a second copy. Rows that still carry an approvalID keep
        // waiting on that real pending decision; everything else retries.
        subtask.state = "pending"
        subtask.interrupted = false
        subtask.activeRunID = undefined
        subtask.claimedBy = undefined
        subtask.leaseUntil = undefined
        subtask.error = "Ensemble restarted while this subtask was working."
      }
    }
    // Legacy rows (persisted before ticket #135) carry no dispatch group.
    // Resolve one from the root ancestor so in-flight work keeps a coherent
    // group; the row becomes durable on its next save.
    this.backfillDispatchGroups()
    if (this.state.ui.activeWorkspaceID && !this.state.workspaces[this.state.ui.activeWorkspaceID]) {
      this.state.ui.activeWorkspaceID = undefined
    }
  }

  async saveDmMessage(workspaceKey: string, agentID: string, message: ChatMessage): Promise<void> {
    const key = bindingKey(workspaceKey, agentID)
    const list = (this.state.dmTranscripts[key] ??= [])
    const index = list.findIndex((item) => item.id === message.id)
    if (index >= 0) list[index] = { ...message }
    else list.push({ ...message })
    list.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    await this.ctx.storage.set(`v2/dm/${workspaceKey}/${agentID}/${message.id}`, { ...message, bindingKey: key })
    await this.bump()
  }

  async removeDmMessage(workspaceKey: string, agentID: string, id: string): Promise<void> {
    const key = bindingKey(workspaceKey, agentID)
    const list = this.state.dmTranscripts[key]
    if (list) {
      const index = list.findIndex((item) => item.id === id)
      if (index >= 0) list.splice(index, 1)
      if (list.length === 0) delete this.state.dmTranscripts[key]
    }
    await this.ctx.storage.remove(`v2/dm/${workspaceKey}/${agentID}/${id}`)
    await this.bump()
  }

  async moveDmTranscript(fromWorkspaceKey: string, agentID: string, toWorkspaceKey: string): Promise<void> {
    const fromKey = bindingKey(fromWorkspaceKey, agentID)
    const toKey = bindingKey(toWorkspaceKey, agentID)
    if (fromKey === toKey) return
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
      await this.saveDmMessage(toWorkspaceKey, agentID, { ...message, queued: false })
    }
    // Phase 2 runs only after every new key is durable.
    delete this.state.dmTranscripts[fromKey]
    await this.removePrefix(`v2/dm/${fromWorkspaceKey}/${agentID}/`)
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
    for (const { key } of await this.scanAll("v2/dm/")) {
      const parts = key.split("/")
      if (parts[3] === agentID) await this.ctx.storage.remove(key)
    }
    for (const key of Object.keys(this.state.dmTranscripts)) {
      if (key.endsWith(`:${agentID}`)) delete this.state.dmTranscripts[key]
    }
    await this.bump()
  }

  async sync(): Promise<boolean> {
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
    // store is unsupported: `SharedEnsemble` keeps one service per process
    // and `sync()` exists to converge cross-location views of that service.
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
    this.state.settings = { ...this.state.settings, ...patch }
    await this.bump()
    return this.settings()
  }

  async saveAgent(agent: Agent): Promise<void> {
    this.state.agents[agent.id] = agent
    await this.ctx.storage.set(`v2/agent/${agent.id}`, agent)
    await this.bump()
  }

  async removeAgent(id: string): Promise<void> {
    delete this.state.agents[id]
    await this.ctx.storage.remove(`v2/agent/${id}`)
    await this.bump()
  }

  async saveWorkspace(workspace: Workspace): Promise<void> {
    this.state.workspaces[workspace.id] = workspace
    await this.ctx.storage.set(`v2/workspace/${workspace.id}`, workspace)
    await this.bump()
  }

  async removeWorkspace(id: string): Promise<void> {
    delete this.state.workspaces[id]
    await this.ctx.storage.remove(`v2/workspace/${id}`)
    await this.bump()
  }

  async appendMessage(
    workspaceID: string,
    input: Omit<Message, "workspaceID" | "seq">,
  ): Promise<Message> {
    const workspace = this.state.workspaces[workspaceID]
    if (!workspace) throw Object.assign(new Error("Workspace not found."), { code: "not_found" })
    const message: Message = { ...input, workspaceID, seq: workspace.nextSeq++ }
    const list = (this.state.messages[workspaceID] ??= [])
    list.push(message)
    list.sort((a, b) => a.seq - b.seq)
    this.trackStreaming(message)
    await this.ctx.storage.set(`v2/message/${workspaceID}/${String(message.seq).padStart(8, "0")}`, message)
    await this.ctx.storage.set(`v2/workspace/${workspaceID}`, workspace)
    await this.bump()
    return message
  }

  async saveUi(ui: SnapshotState["ui"]): Promise<void> {
    this.state.ui = { ...ui }
    await this.bump()
  }

  async saveSubtask(subtask: Subtask): Promise<void> {
    this.state.subtasks[subtask.id] = subtask
    await this.ctx.storage.set(`v2/subtask/${subtask.id}`, subtask)
    await this.bump()
  }

  async saveInitJob(job: InitJob): Promise<void> {
    this.state.initJobs[job.id] = job
    await this.ctx.storage.set(`v2/init/${job.id}`, job)
    await this.bump()
  }

  async removeInitJob(id: string): Promise<void> {
    delete this.state.initJobs[id]
    await this.ctx.storage.remove(`v2/init/${id}`)
    await this.bump()
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
    delete this.state.subtasks[id]
    await this.ctx.storage.remove(`v2/subtask/${id}`)
    await this.bump()
  }

  async saveBinding(binding: SessionBinding): Promise<void> {
    const key = bindingKey(binding.workspaceID, binding.agentID)
    this.state.bindings[key] = binding
    await this.ctx.storage.set(`v2/binding/${binding.workspaceID}/${binding.agentID}`, binding)
    await this.bump()
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
    this.state.memories[memory.id] = memory
    await this.ctx.storage.set(`v2/memory/${memory.id}`, memory)
    await this.bump()
  }

  async saveDmQueueEntry(entry: DmQueueEntry): Promise<void> {
    this.state.dmQueue[entry.id] = entry
    await this.ctx.storage.set(`v2/dmqueue/${entry.id}`, entry)
    await this.bump()
  }

  async removeDmQueueEntry(id: string): Promise<void> {
    delete this.state.dmQueue[id]
    await this.ctx.storage.remove(`v2/dmqueue/${id}`)
    await this.bump()
  }

  async saveMessage(message: Message): Promise<void> {
    const list = (this.state.messages[message.workspaceID] ??= [])
    const index = list.findIndex((item) => item.id === message.id)
    if (index >= 0) list[index] = message
    else list.push(message)
    list.sort((a, b) => a.seq - b.seq)
    this.trackStreaming(message)
    await this.ctx.storage.set(`v2/message/${message.workspaceID}/${String(message.seq).padStart(8, "0")}`, message)
    await this.bump()
  }

  async saveApproval(approval: Approval): Promise<void> {
    this.state.approvals[approval.id] = approval
    await this.ctx.storage.set(`v2/approval/${approval.id}`, approval)
    await this.bump()
  }

  async removeBinding(workspaceID: string, agentID: string): Promise<void> {
    delete this.state.bindings[bindingKey(workspaceID, agentID)]
    await this.ctx.storage.remove(`v2/binding/${workspaceID}/${agentID}`)
    await this.bump()
  }

  async pruneWorkspace(workspaceID: string): Promise<void> {
    const subtaskIDs = Object.values(this.state.subtasks).filter((subtask) => subtask.workspaceID === workspaceID).map((subtask) => subtask.id)
    const initJobIDs = Object.values(this.state.initJobs).filter((job) => job.workspaceID === workspaceID).map((job) => job.id)
    const memoryIDs = Object.values(this.state.memories).filter((memory) => memory.workspaceID === workspaceID).map((memory) => memory.id)
    const approvalIDs = Object.values(this.state.approvals).filter((approval) => approval.workspaceID === workspaceID).map((approval) => approval.id)
    const dmQueueIDs = Object.values(this.state.dmQueue).filter((entry) => entry.workspaceID === workspaceID).map((entry) => entry.id)
    delete this.state.messages[workspaceID]
    for (const key of [...this.streaming]) {
      if (key.startsWith(`${workspaceID}\u0000`)) this.streaming.delete(key)
    }
    for (const id of subtaskIDs) delete this.state.subtasks[id]
    for (const id of initJobIDs) delete this.state.initJobs[id]
    for (const [key, binding] of Object.entries(this.state.bindings)) if (binding.workspaceID === workspaceID) delete this.state.bindings[key]
    for (const id of memoryIDs) delete this.state.memories[id]
    for (const id of approvalIDs) delete this.state.approvals[id]
    for (const id of dmQueueIDs) delete this.state.dmQueue[id]
    for (const key of Object.keys(this.state.dmTranscripts)) {
      if (key === workspaceID || key.startsWith(`${workspaceID}:`)) delete this.state.dmTranscripts[key]
    }
    await this.removePrefix(`v2/message/${workspaceID}/`)
    await this.removePrefix(`v2/binding/${workspaceID}/`)
    await this.removePrefix(`v2/dm/${workspaceID}/`)
    for (const id of subtaskIDs) await this.ctx.storage.remove(`v2/subtask/${id}`)
    for (const id of initJobIDs) await this.ctx.storage.remove(`v2/init/${id}`)
    for (const id of memoryIDs) await this.ctx.storage.remove(`v2/memory/${id}`)
    for (const id of approvalIDs) await this.ctx.storage.remove(`v2/approval/${id}`)
    for (const id of dmQueueIDs) await this.ctx.storage.remove(`v2/dmqueue/${id}`)
    await this.removeWorkspace(workspaceID)
  }

  async removePrefix(prefix: string): Promise<void> {
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
      for (const message of removed) this.streaming.delete(V2Store.streamingKey(parts[2], message.id))
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

  async reset(): Promise<void> {
    for (const prefix of ["v2/agent/", "v2/workspace/", "v2/message/", "v2/subtask/", "v2/init/", "v2/binding/", "v2/memory/", "v2/approval/", "v2/dmqueue/", "v2/dm/"]) {
      await this.removePrefix(prefix)
    }
    await this.ctx.storage.remove("v2/meta")
    this.state = createInitialState()
    this.streaming.clear()
    await this.bump()
  }

  async bump(): Promise<void> {
    this.state.version++
    this.state.updatedAt = Date.now()
    await this.ctx.storage.set("v2/meta", {
      version: this.state.version,
      updatedAt: this.state.updatedAt,
      settings: this.state.settings,
      ui: this.state.ui,
    })
    this.onChange?.(this.state.version)
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
