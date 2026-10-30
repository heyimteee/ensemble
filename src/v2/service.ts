import { randomUUID } from "node:crypto"
import { canonicalDirectory } from "./paths.ts"
import { Catalog } from "./catalog.ts"
import { anyToolCall, assistantResult, availabilityFailure, contextForTask, promptForTask, skillPermissions } from "./execution.ts"
import { unknownMentions, visibleRecipients } from "./routing.ts"
import { V2Store, bindingKey } from "./store.ts"
import type {
  Agent,
  Approval,
  Memory,
  MemoryScope,
  Message,
  ModelRef,
  Settings,
  Snapshot,
  Run,
  SnapshotState,
  Subtask,
  Workspace,
} from "./types.ts"

type Ctx = any
type Json = Record<string, any>

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`
}

function now(): number {
  return Date.now()
}

function unwrap<T>(value: any): T {
  return (value && typeof value === "object" && "data" in value ? value.data : value) as T
}

function listData(value: any): any[] {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.data)) return value.data
  return []
}

function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function sameModel(a: ModelRef, b: ModelRef): boolean {
  return a.providerID === b.providerID && a.modelID === b.modelID && (a.variant ?? "") === (b.variant ?? "")
}

function sameModels(a: ModelRef[], b: ModelRef[]): boolean {
  return a.length === b.length && a.every((model, index) => sameModel(model, b[index]))
}

export class EnsembleV2Service {
  readonly ctx: Ctx
  private store!: V2Store
  private registration: any
  private retryRegistration: any
  private stopped = false
  private pumping = false
  private readonly running = new Set<Promise<void>>()
  private readonly runBySession = new Map<string, string>()
  private readonly activeRuns = new Map<string, Run>()
  private readonly catalog: Catalog
  private catalogAbort: AbortController | undefined

  constructor(ctx: Ctx) {
    this.ctx = ctx
    this.catalog = new Catalog(ctx, () => {
      if (this.registration) void this.registration.events.emit("changed", { version: this.store.snapshot().version }).catch(() => undefined)
    })
  }

  async start(): Promise<() => Promise<void>> {
    this.store = new V2Store(this.ctx, (state) => {
      if (this.registration) void this.registration.events.emit("changed", { version: state.version }).catch(() => undefined)
    })
    await this.store.load()
    await this.ensureInterruptedApprovals()
    this.retryRegistration = await this.ctx.session.hook("retry", (event: any) => {
      if (!this.profileForSession(event.sessionID)) return
      if (availabilityFailure(event.error)) event.decision = { retry: false }
    })
    await this.installTools()
    await this.migrateV1()
    void this.catalog.refresh()
    this.catalogAbort = new AbortController()
    void (async () => {
      try {
        for await (const event of this.ctx.event.subscribe({ types: ["skill.updated", "model.updated", "provider.updated"], signal: this.catalogAbort!.signal })) {
          if (event.type) void this.catalog.refresh()
        }
      } catch {}
    })()
    this.pump()
    return async () => {
      this.stopped = true
      this.catalogAbort?.abort()
      await this.retryRegistration?.dispose?.().catch(() => undefined)
      await Promise.allSettled([...this.running])
    }
  }

  handlers(): {
    snapshot: (input: { directory: string }) => Promise<Snapshot>
    invoke: (input: { directory: string; action: string; payload?: Json }) => Promise<{ ok: boolean; result?: any; error?: { code: string; message: string } }>
  } {
    return {
      snapshot: ({ directory }) => this.snapshot(directory),
      invoke: ({ directory, action, payload }) => this.invoke(directory, action, payload ?? {}),
    }
  }

  attach(registration: any): void {
    this.registration = registration
  }

  private async migrateV1(): Promise<void> {
    const old = await this.ctx.storage.get("ensemble.state").catch(() => undefined)
    if (!old || typeof old !== "object" || !old.agents) return
    for (const legacy of Object.values(old.agents as Record<string, any>)) {
      if (!legacy?.id || !legacy?.name) continue
      if (this.store.snapshot().agents[legacy.id]) continue
      const model = legacy.mainModel ?? { providerID: "opencode", modelID: "unknown" }
      const agent: Agent = {
        id: legacy.id,
        name: legacy.name,
        title: "",
        role: String(legacy.instructions ?? ""),
        mainModel: { providerID: model.providerID, modelID: model.modelID ?? model.id ?? "unknown", variant: model.variant },
        backupModels: Array.isArray(legacy.backupModels) ? legacy.backupModels : [],
        skillbox: Array.isArray(legacy.skillbox) ? legacy.skillbox : [],
        color: "cyan",
        archived: Boolean(legacy.archived),
        pendingSettings: false,
        version: Number(legacy.version ?? 1),
        createdAt: Number(legacy.createdAt ?? now()),
        updatedAt: now(),
      }
      await this.store.saveAgent(agent)
    }
  }

  private async ensureInterruptedApprovals(): Promise<void> {
    const state = this.store.snapshot()
    for (const subtask of Object.values(state.subtasks)) {
      if (!subtask.interrupted || subtask.state !== "pending" || subtask.approvalID) continue
      await this.ensureInterruptedApproval(subtask)
    }
  }

  private async ensureInterruptedApproval(subtask: Subtask): Promise<void> {
    if (subtask.approvalID) return
    const state = this.store.snapshot()
    const existing = Object.values(state.approvals).find((approval) => approval.status === "pending" && approval.kind === "interrupted" && approval.subtaskID === subtask.id)
    if (existing) {
      subtask.approvalID = existing.id
      await this.store.saveSubtask(subtask)
      return
    }
    const approval: Approval = {
      id: id("approval"),
      workspaceID: subtask.workspaceID,
      subtaskID: subtask.id,
      agentID: subtask.assigneeID,
      kind: "interrupted",
      title: `Resume interrupted work: ${subtask.title}`,
      detail: subtask.error ?? "The run stopped before it could reply.",
      payload: { subtaskID: subtask.id },
      status: "pending",
      createdAt: now(),
    }
    await this.store.saveApproval(approval)
    subtask.approvalID = approval.id
    await this.store.saveSubtask(subtask)
    const workspace = state.workspaces[subtask.workspaceID]
    if (workspace) await this.appendMessage(workspace, { author: "system", text: `Interrupted work needs a decision: ${subtask.title}`, kind: "approval", taskID: subtask.id })
  }

  private async snapshot(directory: string): Promise<Snapshot> {
    if (Date.now() - this.catalog.lastRefreshedAt > 10_000) void this.catalog.refresh()
    const state = this.store.snapshot()
    state.runs = Object.fromEntries(this.activeRuns)
    return {
      state: jsonSafe(state),
      models: this.catalog.modelOptions,
      skills: this.catalog.skillOptions,
      directory,
    }
  }

  private async invoke(directory: string, action: string, payload: Json): Promise<{ ok: boolean; result?: any; error?: { code: string; message: string } }> {
    try {
      const result = await this.dispatch(directory, action, payload)
      this.pump()
      return { ok: true, result: jsonSafe(result) }
    } catch (error: any) {
      return { ok: false, error: { code: error?.code ?? "error", message: error?.message ?? String(error) } }
    }
  }

  private async dispatch(directory: string, action: string, payload: Json): Promise<any> {
    switch (action) {
      case "agent.create": return this.createAgent(directory, payload)
      case "agent.update": return this.updateAgent(directory, payload)
      case "agent.archive": return this.archiveAgent(payload.id, payload.replacementLeaderID)
      case "agent.delete": return this.deleteAgent(payload.id, payload.replacementLeaderID, Boolean(payload.deleteNativeSessions))
      case "workspace.create": return this.createWorkspace(directory, payload)
      case "workspace.update": return this.updateWorkspace(payload)
      case "workspace.activate": return this.activateWorkspace(payload.id)
      case "workspace.pause": return this.pauseWorkspace(payload.id, true)
      case "workspace.resume": return this.pauseWorkspace(payload.id, false)
      case "workspace.archive": return this.archiveWorkspace(payload.id)
      case "workspace.delete": return this.deleteWorkspace(payload.id, Boolean(payload.deleteNativeSessions))
      case "message.send": return this.sendMessage(directory, payload)
      case "task.delegate": return this.delegateFromUser(payload)
      case "task.retry": return this.retryTask(payload.id)
      case "task.restart": return this.restartTask(payload.id)
      case "task.cancel": return this.cancelTask(payload.id)
      case "task.reassign": return this.reassignTask(payload.id, payload.assigneeID)
      case "approval.resolve": return this.resolveApproval(payload)
      case "memory.add": return this.addMemory(directory, payload)
      case "memory.update": return this.updateMemory(payload)
      case "memory.delete": return this.deleteMemory(payload)
      case "memory.promote": return this.promoteMemory(payload)
      case "settings.update": return this.updateSettings(payload)
      default: throw Object.assign(new Error(`Unknown Ensemble v2 action: ${action}`), { code: "unknown_action" })
    }
  }

  private async createAgent(directory: string, payload: Json): Promise<Agent> {
    const models = await this.catalog.ensureModels()
    const mainModel = payload.mainModel ?? (models[0] ? { providerID: models[0].providerID, modelID: models[0].modelID, variant: models[0].variants[0] } : undefined)
    if (!mainModel) throw Object.assign(new Error("No model is available."), { code: "no_model" })
    this.catalog.validate(mainModel)
    const backupModels = Array.isArray(payload.backupModels) ? payload.backupModels : []
    for (const model of backupModels) this.catalog.validate(model)
    const name = String(payload.name ?? "").trim()
    if (!name) throw Object.assign(new Error("Agent name is required."), { code: "invalid_name" })
    const at = now()
    const agent: Agent = {
      id: id("agent"),
      name,
      title: String(payload.title ?? ""),
      role: String(payload.role ?? payload.instructions ?? ""),
      mainModel,
      backupModels,
      skillbox: Array.isArray(payload.skillbox) ? [...new Set(payload.skillbox.map(String))] : [],
      color: String(payload.color ?? "cyan"),
      archived: false,
      pendingSettings: false,
      version: 1,
      createdAt: at,
      updatedAt: at,
    }
    await this.store.saveAgent(agent)
    return agent
  }

  private async updateAgent(directory: string, payload: Json): Promise<Agent> {
    const models = await this.catalog.ensureModels()
    const state = this.store.snapshot()
    const agent = state.agents[payload.id]
    if (!agent) throw Object.assign(new Error("Agent not found."), { code: "not_found" })
    let behavioral = false
    if (payload.name !== undefined) agent.name = String(payload.name).trim() || agent.name
    if (payload.title !== undefined) agent.title = String(payload.title)
    if (payload.role !== undefined && String(payload.role) !== agent.role) { agent.role = String(payload.role); behavioral = true }
    if (payload.color !== undefined) agent.color = String(payload.color)
    if (payload.mainModel !== undefined) {
      this.catalog.validate(payload.mainModel)
      if (!sameModel(agent.mainModel, payload.mainModel)) behavioral = true
      agent.mainModel = payload.mainModel
    }
    if (payload.backupModels !== undefined) {
      for (const model of payload.backupModels) this.catalog.validate(model)
      if (!sameModels(agent.backupModels, payload.backupModels)) behavioral = true
      agent.backupModels = payload.backupModels
    }
    if (payload.skillbox !== undefined) {
      const next = [...new Set(payload.skillbox.map(String))]
      if (next.length !== agent.skillbox.length || next.some((skill) => !agent.skillbox.includes(skill))) behavioral = true
      agent.skillbox = next
    }
    if (behavioral) {
      agent.version++
      agent.pendingSettings = true
    }
    agent.updatedAt = now()
    await this.store.saveAgent(agent)
    return agent
  }

  private async archiveAgent(agentID: string, replacementLeaderID?: string): Promise<any> {
    const state = this.store.snapshot()
    const agent = state.agents[agentID]
    if (!agent) throw Object.assign(new Error("Agent not found."), { code: "not_found" })
    const led = Object.values(state.workspaces).filter((workspace) => !workspace.archived && workspace.leaderID === agentID)
    if (led.length > 0 && !replacementLeaderID) throw Object.assign(new Error("Choose a replacement leader before archiving this agent."), { code: "leader_replacement_required" })
    if (replacementLeaderID) {
      for (const workspace of led) {
        if (!workspace.memberIDs.includes(replacementLeaderID)) throw Object.assign(new Error("The replacement leader must be a member."), { code: "leader_replacement_required" })
        workspace.leaderID = replacementLeaderID
        await this.store.saveWorkspace(workspace)
      }
    }
    for (const run of this.activeRuns.values()) {
      if (run.agentID === agentID) await this.ctx.session.interrupt({ sessionID: run.sessionID, resume: false }).catch(() => undefined)
    }
    agent.archived = true
    agent.version++
    agent.updatedAt = now()
    await this.store.saveAgent(agent)
    for (const workspace of Object.values(state.workspaces)) {
      if (workspace.memberIDs.includes(agentID)) {
        workspace.memberIDs = workspace.memberIDs.filter((member) => member !== agentID)
        await this.store.saveWorkspace(workspace)
      }
    }
    await this.cancelAgentSubtasks(agentID, "Agent archived.")
    return { ok: true }
  }

  private async deleteAgent(agentID: string, replacementLeaderID?: string, deleteNativeSessions = false): Promise<any> {
    const state = this.store.snapshot()
    const agent = state.agents[agentID]
    if (!agent) throw Object.assign(new Error("Agent not found."), { code: "not_found" })
    const led = Object.values(state.workspaces).filter((workspace) => !workspace.archived && workspace.leaderID === agentID)
    if (led.length > 0 && !replacementLeaderID) throw Object.assign(new Error("Choose a replacement leader before deleting this agent."), { code: "leader_replacement_required" })
    if (replacementLeaderID) {
      for (const workspace of led) {
        if (!workspace.memberIDs.includes(replacementLeaderID)) throw Object.assign(new Error("The replacement leader must be a member."), { code: "leader_replacement_required" })
        workspace.leaderID = replacementLeaderID
        await this.store.saveWorkspace(workspace)
      }
    }
    for (const run of this.activeRuns.values()) {
      if (run.agentID === agentID) await this.ctx.session.interrupt({ sessionID: run.sessionID, resume: false }).catch(() => undefined)
    }
    await this.cancelAgentSubtasks(agentID, "Agent deleted.")
    for (const workspace of Object.values(state.workspaces)) {
      if (workspace.memberIDs.includes(agentID)) {
        workspace.memberIDs = workspace.memberIDs.filter((member) => member !== agentID)
        await this.store.saveWorkspace(workspace)
      }
      const binding = this.store.binding(workspace.id, agentID)
      if (binding) {
        if (deleteNativeSessions) await this.ctx.session.remove({ sessionID: binding.sessionID }).catch(() => undefined)
        await this.store.removeBinding(workspace.id, agentID)
      }
    }
    for (const memory of Object.values(state.memories)) {
      if (memory.agentID === agentID) {
        memory.deletedAt = now()
        await this.store.saveMemory(memory)
      }
    }
    await this.store.removeAgent(agentID)
    return { ok: true }
  }

  private async createWorkspace(directory: string, payload: Json): Promise<Workspace> {
    const canonical = canonicalDirectory(String(payload.directory ?? directory))
    const state = this.store.snapshot()
    const existing = Object.values(state.workspaces).find((workspace) => !workspace.archived && workspace.directory === canonical)
    if (existing) throw Object.assign(new Error(`A workspace already exists for this directory: ${existing.name}`), { code: "workspace_exists" })
    const name = String(payload.name ?? "").trim()
    if (!name) throw Object.assign(new Error("Workspace name is required."), { code: "invalid_name" })
    const memberIDs = Array.isArray(payload.memberIDs) ? [...new Set(payload.memberIDs.map(String))] : []
    const leaderID = String(payload.leaderID ?? "")
    if (memberIDs.length === 0) throw Object.assign(new Error("Choose at least one member."), { code: "invalid_members" })
    if (!memberIDs.includes(leaderID)) throw Object.assign(new Error("The leader must be a member."), { code: "invalid_leader" })
    for (const memberID of memberIDs) {
      const agent = state.agents[memberID]
      if (!agent || agent.archived) throw Object.assign(new Error("A selected agent is unavailable."), { code: "invalid_members" })
    }
    const at = now()
    const workspace: Workspace = {
      id: id("workspace"),
      name,
      directory: canonical,
      leaderID,
      memberIDs,
      synthesis: payload.synthesis !== false,
      archived: false,
      paused: false,
      nextSeq: 1,
      createdAt: at,
      lastActiveAt: at,
    }
    await this.store.saveWorkspace(workspace)
    return workspace
  }

  private async updateWorkspace(payload: Json): Promise<Workspace> {
    const state = this.store.snapshot()
    const workspace = state.workspaces[payload.id]
    if (!workspace) throw Object.assign(new Error("Workspace not found."), { code: "not_found" })
    if (payload.name !== undefined) workspace.name = String(payload.name).trim() || workspace.name
    if (payload.memberIDs !== undefined) {
      const members = [...new Set(payload.memberIDs.map(String))]
      if (members.length === 0) throw Object.assign(new Error("Choose at least one member."), { code: "invalid_members" })
      workspace.memberIDs = members
    }
    if (payload.leaderID !== undefined) workspace.leaderID = String(payload.leaderID)
    if (!workspace.memberIDs.includes(workspace.leaderID)) throw Object.assign(new Error("The leader must be a member."), { code: "invalid_leader" })
    if (payload.synthesis !== undefined) workspace.synthesis = Boolean(payload.synthesis)
    workspace.lastActiveAt = now()
    await this.store.saveWorkspace(workspace)
    return workspace
  }

  private async activateWorkspace(workspaceID: string): Promise<any> {
    const state = this.store.snapshot()
    const workspace = state.workspaces[workspaceID]
    if (!workspace) throw Object.assign(new Error("Workspace not found."), { code: "not_found" })
    workspace.lastActiveAt = now()
    await this.store.saveWorkspace(workspace)
    await this.store.saveUi({ ...state.ui, activeWorkspaceID: workspaceID })
    return { ok: true }
  }

  private async pauseWorkspace(workspaceID: string, paused: boolean): Promise<Workspace> {
    const state = this.store.snapshot()
    const workspace = state.workspaces[workspaceID]
    if (!workspace) throw Object.assign(new Error("Workspace not found."), { code: "not_found" })
    workspace.paused = paused
    workspace.lastActiveAt = now()
    await this.store.saveWorkspace(workspace)
    return workspace
  }

  private async archiveWorkspace(workspaceID: string): Promise<any> {
    const state = this.store.snapshot()
    const workspace = state.workspaces[workspaceID]
    if (!workspace) throw Object.assign(new Error("Workspace not found."), { code: "not_found" })
    workspace.archived = true
    workspace.lastActiveAt = now()
    await this.store.saveWorkspace(workspace)
    if (state.ui.activeWorkspaceID === workspaceID) await this.store.saveUi({ ...state.ui, activeWorkspaceID: undefined })
    await this.cancelWorkspaceSubtasks(workspaceID, "Workspace archived.")
    return { ok: true }
  }

  private async deleteWorkspace(workspaceID: string, deleteNativeSessions = false): Promise<any> {
    const state = this.store.snapshot()
    const workspace = state.workspaces[workspaceID]
    if (!workspace) throw Object.assign(new Error("Workspace not found."), { code: "not_found" })
    await this.cancelWorkspaceSubtasks(workspaceID, "Workspace deleted.")
    for (const run of this.activeRuns.values()) {
      if (run.workspaceID === workspaceID) await this.ctx.session.interrupt({ sessionID: run.sessionID, resume: false }).catch(() => undefined)
    }
    if (deleteNativeSessions) {
      for (const binding of Object.values(state.bindings)) {
        if (binding.workspaceID === workspaceID) await this.ctx.session.remove({ sessionID: binding.sessionID }).catch(() => undefined)
      }
    }
    if (state.ui.activeWorkspaceID === workspaceID) await this.store.saveUi({ ...state.ui, activeWorkspaceID: undefined })
    await this.store.pruneWorkspace(workspaceID)
    return { ok: true }
  }

  private async cancelSubtasks(matches: (subtask: Subtask) => boolean, reason: string): Promise<void> {
    const state = this.store.snapshot()
    for (const subtask of Object.values(state.subtasks)) {
      if (!matches(subtask)) continue
      if (subtask.state !== "pending" && subtask.state !== "working") continue
      subtask.state = "replied"
      subtask.outcome = "failed"
      subtask.error = reason
      subtask.activeRunID = undefined
      subtask.approvalID = undefined
      subtask.repliedAt = now()
      await this.store.saveSubtask(subtask)
    }
  }

  private async cancelAgentSubtasks(agentID: string, reason: string): Promise<void> {
    await this.cancelSubtasks((subtask) => subtask.assigneeID === agentID, reason)
    const state = this.store.snapshot()
    for (const approval of Object.values(state.approvals)) {
      if (approval.agentID === agentID && approval.status === "pending") {
        approval.status = "rejected"
        approval.resolution = reason
        await this.store.saveApproval(approval)
      }
    }
  }

  private async cancelWorkspaceSubtasks(workspaceID: string, reason: string): Promise<void> {
    await this.cancelSubtasks((subtask) => subtask.workspaceID === workspaceID, reason)
    const state = this.store.snapshot()
    for (const approval of Object.values(state.approvals)) {
      if (approval.workspaceID === workspaceID && approval.status === "pending") {
        approval.status = "rejected"
        approval.resolution = reason
        await this.store.saveApproval(approval)
      }
    }
  }

  private async sendMessage(directory: string, payload: Json): Promise<any> {
    const state = this.store.snapshot()
    const workspace = state.workspaces[payload.workspaceID]
    if (!workspace || workspace.archived) throw Object.assign(new Error("Workspace not found."), { code: "not_found" })
    if (workspace.paused) throw Object.assign(new Error("This workspace is paused. Resume it before sending work."), { code: "workspace_paused" })
    const text = String(payload.text ?? "").trim()
    if (!text) throw Object.assign(new Error("Message is empty."), { code: "empty" })
    const unknown = unknownMentions(text, workspace, state.agents)
    if (unknown.length > 0) {
      const available = workspace.memberIDs.map((memberID) => state.agents[memberID]?.name).filter(Boolean).join(", ")
      throw Object.assign(new Error(`Unknown workspace member${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Members: ${available}`), { code: "unknown_member" })
    }
    const recipientIDs = Array.isArray(payload.recipientIDs) ? payload.recipientIDs.map(String).filter((agentID: string) => workspace.memberIDs.includes(agentID) && state.agents[agentID] && !state.agents[agentID].archived) : []
    const recipients = recipientIDs.length > 0 ? [...new Set(recipientIDs)] : visibleRecipients(text, workspace, state.agents)
    await this.appendMessage(workspace, { author: "user", text, kind: "text" })
    for (const agentID of recipients) {
      await this.createSubtask({
        workspace,
        assigneeID: agentID,
        creatorType: "user",
        title: text.slice(0, 80),
        instruction: text,
        mode: payload.mode === "edit" ? "edit" : "research",
      })
    }
    const current = this.store.snapshot().workspaces[workspace.id]
    if (current) {
      current.lastActiveAt = now()
      await this.store.saveWorkspace(current)
    }
    return { recipients }
  }

  private async createSubtask(input: {
    workspace: Workspace
    parentID?: string
    assigneeID: string
    creatorType: "user" | "agent"
    creatorAgentID?: string
    title: string
    instruction: string
    constraints?: string
    expected?: string
    mode?: "research" | "edit"
    stage?: "initial" | "synthesis"
  }): Promise<Subtask> {
    const at = now()
    const subtask: Subtask = {
      id: id("task"),
      workspaceID: input.workspace.id,
      parentID: input.parentID,
      creatorType: input.creatorType,
      creatorAgentID: input.creatorAgentID,
      assigneeID: input.assigneeID,
      title: input.title,
      instruction: input.instruction,
      constraints: input.constraints,
      expected: input.expected,
      mode: input.mode ?? "research",
      state: "pending",
      stage: input.stage ?? "initial",
      outcome: "pending",
      interrupted: false,
      awaitingChildren: false,
      attempts: 0,
      createdAt: at,
    }
    await this.store.saveSubtask(subtask)
    await this.appendMessage(input.workspace, {
      author: "system",
      text: `→ ${this.agentName(subtask.assigneeID)}: ${subtask.title}`,
      kind: "task",
      taskID: subtask.id,
    })
    return subtask
  }

  private async appendMessage(workspace: Workspace, input: { author: Message["author"]; agentID?: string; text: string; kind: Message["kind"]; taskID?: string }): Promise<Message> {
    return this.store.appendMessage(workspace.id, {
      id: id("msg"),
      author: input.author,
      agentID: input.agentID,
      text: input.text,
      kind: input.kind,
      taskID: input.taskID,
      createdAt: now(),
    })
  }

  private delegationDepth(state: SnapshotState, subtaskID: string): number {
    let depth = 0
    let current = state.subtasks[subtaskID]
    while (current?.parentID && depth < 100) {
      depth++
      current = state.subtasks[current.parentID]
    }
    return depth
  }

  private agentName(agentID: string | undefined): string {
    if (!agentID) return "Unassigned"
    return this.store.snapshot().agents[agentID]?.name ?? "Unknown agent"
  }

  private async delegateFromUser(payload: Json): Promise<Subtask> {
    const state = this.store.snapshot()
    const workspace = state.workspaces[payload.workspaceID]
    if (!workspace) throw Object.assign(new Error("Workspace not found."), { code: "not_found" })
    if (workspace.paused) throw Object.assign(new Error("This workspace is paused. Resume it before delegating work."), { code: "workspace_paused" })
    if (!workspace.memberIDs.includes(payload.assigneeID)) throw Object.assign(new Error("That agent is not a workspace member."), { code: "not_member" })
    const parent = payload.parentID ? state.subtasks[payload.parentID] : undefined
    if (parent && parent.workspaceID !== workspace.id) throw Object.assign(new Error("The parent subtask belongs to another workspace."), { code: "invalid_parent" })
    if (parent && this.delegationDepth(state, parent.id) >= state.settings.maxDepth) throw Object.assign(new Error(`The delegation depth limit is ${state.settings.maxDepth}.`), { code: "delegation_depth" })
    const subtask = await this.createSubtask({
      workspace,
      parentID: parent?.id,
      assigneeID: payload.assigneeID,
      creatorType: "user",
      title: String(payload.title ?? "Delegated task"),
      instruction: String(payload.instruction ?? ""),
      constraints: payload.constraints,
      expected: payload.expected,
      mode: payload.mode === "edit" ? "edit" : "research",
    })
    return subtask
  }

  private async stopSubtaskRun(subtask: Subtask): Promise<void> {
    const runID = subtask.activeRunID ?? [...this.activeRuns.values()].find((run) => run.subtaskID === subtask.id)?.id
    if (!runID) {
      subtask.activeRunID = undefined
      return
    }
    const run = this.activeRuns.get(runID)
    if (run) {
      await this.ctx.session.interrupt({ sessionID: run.sessionID, resume: false }).catch(() => undefined)
      this.activeRuns.delete(runID)
      this.runBySession.delete(run.sessionID)
    }
    subtask.activeRunID = undefined
  }

  private async claimForRetry(subtask: Subtask): Promise<void> {
    await this.stopSubtaskRun(subtask)
    const approvals = this.store.snapshot().approvals
    for (const approval of Object.values(approvals)) {
      if (approval.status !== "pending" || approval.kind !== "interrupted" || approval.subtaskID !== subtask.id) continue
      approval.status = "rejected"
      approval.resolution = "Subtask retried by the user."
      approval.resolvedAt = now()
      await this.store.saveApproval(approval)
    }
    subtask.state = "pending"
    subtask.outcome = "pending"
    subtask.error = undefined
    subtask.interrupted = false
    subtask.approvalID = undefined
    subtask.activeRunID = undefined
    subtask.repliedAt = undefined
    await this.store.saveSubtask(subtask)
  }

  private async retryTask(subtaskID: string): Promise<Subtask> {
    const state = this.store.snapshot()
    const subtask = state.subtasks[subtaskID]
    if (!subtask) throw Object.assign(new Error("Subtask not found."), { code: "not_found" })
    await this.claimForRetry(subtask)
    return subtask
  }

  private async restartTask(subtaskID: string): Promise<Subtask> {
    const state = this.store.snapshot()
    const subtask = state.subtasks[subtaskID]
    if (!subtask) throw Object.assign(new Error("Subtask not found."), { code: "not_found" })
    await this.claimForRetry(subtask)
    const workspace = state.workspaces[subtask.workspaceID]
    if (workspace) await this.appendMessage(workspace, { author: "system", text: `Restarting work: ${subtask.title}`, kind: "system", taskID: subtask.id })
    return subtask
  }

  private async cancelTask(subtaskID: string): Promise<Subtask> {
    const state = this.store.snapshot()
    const subtask = state.subtasks[subtaskID]
    if (!subtask) throw Object.assign(new Error("Subtask not found."), { code: "not_found" })
    await this.stopSubtaskRun(subtask)
    subtask.state = "replied"
    subtask.outcome = "failed"
    subtask.error = "Cancelled by user."
    subtask.activeRunID = undefined
    subtask.approvalID = undefined
    subtask.repliedAt = now()
    await this.store.saveSubtask(subtask)
    return subtask
  }

  private async reassignTask(subtaskID: string, assigneeID: string): Promise<Subtask> {
    const state = this.store.snapshot()
    const subtask = state.subtasks[subtaskID]
    const workspace = subtask ? state.workspaces[subtask.workspaceID] : undefined
    if (!subtask || !workspace) throw Object.assign(new Error("Subtask not found."), { code: "not_found" })
    if (!workspace.memberIDs.includes(assigneeID)) throw Object.assign(new Error("That agent is not a workspace member."), { code: "not_member" })
    await this.stopSubtaskRun(subtask)
    subtask.assigneeID = assigneeID
    subtask.state = "pending"
    subtask.outcome = "pending"
    subtask.error = undefined
    subtask.interrupted = false
    subtask.approvalID = undefined
    subtask.activeRunID = undefined
    subtask.repliedAt = undefined
    await this.store.saveSubtask(subtask)
    return subtask
  }

  private async resolveApproval(payload: Json): Promise<Approval> {
    const state = this.store.snapshot()
    const approval = state.approvals[payload.id]
    if (!approval) throw Object.assign(new Error("Approval not found."), { code: "not_found" })
    const requested = payload.approve ? "approved" : "rejected"
    if (approval.status !== "pending") {
      if (approval.status === requested) return approval
      throw Object.assign(new Error("Approval was already resolved differently."), { code: "already_resolved" })
    }
    approval.status = requested
    approval.resolvedAt = now()
    approval.resolution = payload.resolution
    await this.store.saveApproval(approval)
    if (!payload.approve) {
      if (approval.kind === "interrupted" && approval.subtaskID) {
        const subtask = state.subtasks[approval.subtaskID]
        if (subtask) {
          subtask.state = "replied"
          subtask.outcome = "failed"
          subtask.error = "Interrupted work discarded by the user."
          subtask.interrupted = false
          subtask.approvalID = undefined
          subtask.repliedAt = now()
          await this.store.saveSubtask(subtask)
        }
      }
      if (approval.kind === "ask_person" && approval.subtaskID) {
        const subtask = state.subtasks[approval.subtaskID]
        if (subtask) {
          subtask.state = "replied"
          subtask.outcome = "failed"
          subtask.error = "User rejected the request."
          subtask.approvalID = undefined
          subtask.repliedAt = now()
          await this.store.saveSubtask(subtask)
        }
      }
      return approval
    }
    if (approval.kind === "interrupted" && approval.subtaskID) {
      const subtask = state.subtasks[approval.subtaskID]
      if (subtask) await this.claimForRetry(subtask)
    }
    if (approval.kind === "ask_person" && approval.subtaskID) {
      const subtask = state.subtasks[approval.subtaskID]
      if (subtask) {
        subtask.state = "pending"
        subtask.outcome = "pending"
        subtask.approvalID = undefined
        subtask.instruction += `\n\nUser answer: ${approval.resolution ?? "Approved."}`
        await this.store.saveSubtask(subtask)
      }
    }
    if (approval.kind === "outside_roster" && approval.payload) {
      const workspace = approval.workspaceID ? state.workspaces[approval.workspaceID] : undefined
      if (workspace) {
        await this.createSubtask({
          workspace,
          assigneeID: String(approval.payload.assigneeID ?? ""),
          creatorType: "agent",
          creatorAgentID: approval.agentID,
          title: String(approval.payload.title ?? "Outside-roster task"),
          instruction: String(approval.payload.instruction ?? approval.detail),
          constraints: approval.payload.constraints ? String(approval.payload.constraints) : undefined,
          expected: approval.payload.expected ? String(approval.payload.expected) : undefined,
          mode: approval.payload.mode === "edit" ? "edit" : "research",
        })
      }
    }
    if (approval.kind === "promote_memory" && approval.payload?.memoryID) {
      const memory = state.memories[String(approval.payload.memoryID)]
      if (memory) {
        memory.scope = "global"
        memory.updatedAt = now()
        memory.history.push({ at: now(), action: "promoted", by: "user" })
        await this.store.saveMemory(memory)
      }
    }
    if (approval.kind === "cross_project" && approval.payload?.text) {
      const memory: Memory = {
        id: id("mem"),
        agentID: approval.agentID,
        workspaceID: approval.workspaceID,
        scope: "global",
        text: String(approval.payload.text),
        origin: "manual",
        source: `approved-share:${approval.agentID ?? "agent"}`,
        createdAt: now(),
        updatedAt: now(),
        history: [{ at: now(), action: "shared", by: "user" }],
      }
      await this.store.saveMemory(memory)
    }
    return approval
  }

  private async addMemory(directory: string, payload: Json): Promise<Memory> {
    const text = String(payload.text ?? "").trim()
    if (!text) throw Object.assign(new Error("Memory text is required."), { code: "empty" })
    const scope = (payload.scope ?? "project") as MemoryScope
    const at = now()
    const memory: Memory = {
      id: id("mem"),
      agentID: payload.agentID,
      workspaceID: payload.workspaceID,
      scope,
      text,
      origin: "manual",
      source: String(payload.source ?? "user"),
      createdAt: at,
      updatedAt: at,
      history: [{ at, action: "created", by: "user" }],
    }
    await this.store.saveMemory(memory)
    return memory
  }

  private async updateMemory(payload: Json): Promise<Memory> {
    const state = this.store.snapshot()
    const memory = state.memories[payload.id]
    if (!memory || memory.deletedAt) throw Object.assign(new Error("Memory not found."), { code: "not_found" })
    memory.text = String(payload.text ?? memory.text).trim()
    memory.updatedAt = now()
    memory.history.push({ at: now(), action: "edited", by: "user" })
    await this.store.saveMemory(memory)
    return memory
  }

  private async deleteMemory(payload: Json): Promise<any> {
    const state = this.store.snapshot()
    const memory = state.memories[payload.id]
    if (!memory || memory.deletedAt) throw Object.assign(new Error("Memory not found."), { code: "not_found" })
    memory.deletedAt = now()
    memory.updatedAt = now()
    memory.history.push({ at: now(), action: "deleted", by: "user" })
    await this.store.saveMemory(memory)
    return { deleted: true, note: "Existing native transcripts are not erased." }
  }

  private async promoteMemory(payload: Json): Promise<any> {
    const state = this.store.snapshot()
    const memory = state.memories[payload.id]
    if (!memory || memory.deletedAt) throw Object.assign(new Error("Memory not found."), { code: "not_found" })
    if (memory.scope === "global") return { alreadyGlobal: true }
    const approval: Approval = {
      id: id("approval"),
      workspaceID: memory.workspaceID,
      agentID: memory.agentID,
      kind: "promote_memory",
      title: `Promote memory for ${this.agentName(memory.agentID)}`,
      detail: memory.text,
      payload: { memoryID: memory.id },
      status: "pending",
      createdAt: now(),
    }
    await this.store.saveApproval(approval)
    return approval
  }

  private async updateSettings(payload: Json): Promise<Settings> {
    const patch: Partial<Settings> = {}
    if (payload.maxActiveRuns !== undefined) patch.maxActiveRuns = Math.max(1, Number(payload.maxActiveRuns))
    if (payload.maxDelegations !== undefined) patch.maxDelegations = Math.max(1, Number(payload.maxDelegations))
    if (payload.maxDepth !== undefined) patch.maxDepth = Math.max(1, Number(payload.maxDepth))
    if (payload.synthesis !== undefined) patch.synthesis = Boolean(payload.synthesis)
    return this.store.updateSettings(patch)
  }

  private async installTools(): Promise<void> {
    await this.ctx.tool.transform((editor: any) => {
      editor.namespace({ name: "ensemble", description: "Ensemble workspace collaboration." })
      editor.add({
        name: "delegate",
        options: { namespace: "ensemble", codemode: false },
        description: "Delegate a typed subtask to another workspace member and record it on the board.",
        input: {
          type: "object",
          properties: {
            assignee: { type: "string" },
            title: { type: "string" },
            instruction: { type: "string" },
            constraints: { type: "string" },
            expected: { type: "string" },
            mode: { type: "string", enum: ["research", "edit"] },
          },
          required: ["assignee", "title", "instruction"],
          additionalProperties: false,
        },
        execute: async (input: Json, context: any) => this.toolDelegate(input, context),
      })
      editor.add({
        name: "ask_person",
        options: { namespace: "ensemble", codemode: false },
        description: "Ask the user for a judgment call and pause this subtask until they answer.",
        input: { type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false },
        execute: async (input: Json, context: any) => this.toolAsk(input, context),
      })
      editor.add({
        name: "remember",
        options: { namespace: "ensemble", codemode: false },
        description: "Save durable project, workspace, or cross-project knowledge. Cross-project knowledge needs approval.",
        input: {
          type: "object",
          properties: { text: { type: "string" }, scope: { type: "string", enum: ["project", "workspace", "global"] } },
          required: ["text", "scope"],
          additionalProperties: false,
        },
        execute: async (input: Json, context: any) => this.toolRemember(input, context),
      })
      editor.add({
        name: "share",
        options: { namespace: "ensemble", codemode: false },
        description: "Request authorization before cross-project or private-transcript disclosure.",
        input: {
          type: "object",
          properties: { text: { type: "string" }, scope: { type: "string", enum: ["cross_project", "private_transcript"] } },
          required: ["text", "scope"],
          additionalProperties: false,
        },
        execute: async (input: Json, context: any) => this.toolShare(input, context),
      })
    })
  }

  private async toolDelegate(input: Json, context: any): Promise<{ content: string }> {
    const state = this.store.snapshot()
    const run = this.runForSession(state, context.sessionID)
    if (!run) return { content: "This run is not an Ensemble subtask." }
    const subtask = state.subtasks[run.subtaskID]
    const workspace = subtask ? state.workspaces[subtask.workspaceID] : undefined
    if (!subtask || !workspace) return { content: "The workspace for this subtask is missing." }
    if (workspace.paused) return { content: "This workspace is paused." }
    if (workspace.leaderID !== run.agentID) return { content: "Only the workspace leader can delegate subtasks." }
    const target = Object.values(state.agents).find((agent) => agent.name.toLowerCase() === String(input.assignee).toLowerCase() || agent.id === input.assignee)
    if (!target || target.archived) return { content: "That agent is unavailable." }
    if (this.delegationDepth(state, subtask.id) >= state.settings.maxDepth) return { content: `The delegation depth limit is ${state.settings.maxDepth}.` }
    const children = Object.values(state.subtasks).filter((item) => item.parentID === subtask.id)
    if (children.length >= state.settings.maxDelegations) return { content: `The delegation limit is ${state.settings.maxDelegations}.` }
    if (!workspace.memberIDs.includes(target.id)) {
      const approval: Approval = {
        id: id("approval"),
        workspaceID: workspace.id,
        subtaskID: subtask.id,
        agentID: run.agentID,
        kind: "outside_roster",
        title: `${this.agentName(run.agentID)} wants to contact ${target.name}`,
        detail: String(input.instruction),
        payload: { assigneeID: target.id, title: input.title, instruction: input.instruction, constraints: input.constraints, expected: input.expected, mode: input.mode },
        status: "pending",
        createdAt: now(),
      }
      await this.store.saveApproval(approval)
      await this.appendMessage(workspace, { author: "system", text: `Approval needed: contact ${target.name}`, kind: "approval", taskID: subtask.id })
      return { content: `Approval required before contacting ${target.name}.` }
    }
    await this.createSubtask({
      workspace,
      parentID: subtask.id,
      assigneeID: target.id,
      creatorType: "agent",
      creatorAgentID: run.agentID,
      title: String(input.title),
      instruction: String(input.instruction),
      constraints: input.constraints ? String(input.constraints) : undefined,
      expected: input.expected ? String(input.expected) : undefined,
      mode: input.mode === "edit" ? "edit" : "research",
    })
    return { content: `Delegated to ${target.name}. The reply will arrive in the group chat.` }
  }

  private async toolAsk(input: Json, context: any): Promise<{ content: string }> {
    const state = this.store.snapshot()
    const run = this.runForSession(state, context.sessionID)
    if (!run) return { content: "This run is not an Ensemble subtask." }
    const subtask = state.subtasks[run.subtaskID]
    if (!subtask) return { content: "The subtask is missing." }
    const approval: Approval = {
      id: id("approval"),
      workspaceID: subtask.workspaceID,
      subtaskID: subtask.id,
      agentID: run.agentID,
      kind: "ask_person",
      title: `${this.agentName(run.agentID)} needs your input`,
      detail: String(input.question),
      status: "pending",
      createdAt: now(),
    }
    await this.store.saveApproval(approval)
    subtask.approvalID = approval.id
    await this.store.saveSubtask(subtask)
    const workspace = state.workspaces[subtask.workspaceID]
    if (workspace) await this.appendMessage(workspace, { author: "system", text: `Approval needed: ${input.question}`, kind: "approval", taskID: subtask.id })
    return { content: "Waiting for the user's answer in the approval inbox." }
  }

  private async toolRemember(input: Json, context: any): Promise<{ content: string }> {
    const state = this.store.snapshot()
    const run = this.runForSession(state, context.sessionID)
    if (!run) return { content: "This run is not an Ensemble subtask." }
    const subtask = state.subtasks[run.subtaskID]
    if (!subtask) return { content: "The subtask is missing." }
    const workspace = state.workspaces[subtask.workspaceID]
    if (!workspace) return { content: "The workspace is missing." }
    const scope = input.scope as MemoryScope
    const text = String(input.text ?? "").trim()
    if (!text) return { content: "Memory text is empty." }
    const at = now()
    const effectiveScope: MemoryScope = scope === "global" ? "project" : scope
    const memory: Memory = {
      id: id("mem"),
      agentID: run.agentID,
      workspaceID: workspace.id,
      scope: effectiveScope,
      text,
      origin: "automatic",
      source: `agent:${run.agentID}`,
      createdAt: at,
      updatedAt: at,
      history: [{ at, action: "created", by: "agent" }],
    }
    await this.store.saveMemory(memory)
    if (scope === "global") {
      const approval: Approval = {
        id: id("approval"),
        workspaceID: workspace.id,
        agentID: run.agentID,
        kind: "promote_memory",
        title: `Promote learned knowledge for ${this.agentName(run.agentID)}`,
        detail: text,
        payload: { memoryID: memory.id },
        status: "pending",
        createdAt: now(),
      }
      await this.store.saveApproval(approval)
      return { content: `Cross-project memory needs approval: ${approval.id}` }
    }
    return { content: `Saved ${effectiveScope} memory.` }
  }

  private async toolShare(input: Json, context: any): Promise<{ content: string }> {
    const state = this.store.snapshot()
    const run = this.runForSession(state, context.sessionID)
    if (!run) return { content: "This run is not an Ensemble subtask." }
    const approval: Approval = {
      id: id("approval"),
      workspaceID: state.subtasks[run.subtaskID]?.workspaceID,
      subtaskID: run.subtaskID,
      agentID: run.agentID,
      kind: "cross_project",
      title: input.scope === "private_transcript" ? "Share private transcript content" : "Share knowledge across projects",
      detail: String(input.text),
      payload: { text: input.text, scope: input.scope },
      status: "pending",
      createdAt: now(),
    }
    await this.store.saveApproval(approval)
    const workspace = approval.workspaceID ? state.workspaces[approval.workspaceID] : undefined
    if (workspace) await this.appendMessage(workspace, { author: "system", text: `Approval needed: ${approval.title}`, kind: "approval", taskID: approval.subtaskID })
    return { content: `Sharing needs user authorization: ${approval.id}` }
  }

  private runForSession(_state: SnapshotState, sessionID: string): { subtaskID: string; agentID: string; workspaceID: string } | undefined {
    const runID = this.runBySession.get(sessionID)
    if (!runID) return undefined
    const run = this.activeRuns.get(runID)
    return run ? { subtaskID: run.subtaskID, agentID: run.agentID, workspaceID: run.workspaceID } : undefined
  }

  private profileForSession(sessionID: string): string | undefined {
    return this.runForSession(this.store.snapshot(), sessionID)?.agentID
  }

  private pump(): void {
    if (this.stopped || this.pumping) return
    this.pumping = true
    void (async () => {
      try {
        const state = this.store.snapshot()
        const running = [...this.activeRuns.values()].filter((run) => run.status === "running")
        let slots = state.settings.maxActiveRuns - running.length
        if (slots <= 0) return
        const busyAgents = new Set(running.map((run) => bindingKey(run.workspaceID, run.agentID)))
        const busyEditDirs = new Set(
          running
            .map((run) => state.subtasks[run.subtaskID])
            .filter((task) => task?.mode === "edit")
            .map((task) => state.workspaces[task!.workspaceID]?.directory)
            .filter(Boolean) as string[],
        )
        const pending = Object.values(state.subtasks)
          .filter((task) => task.state === "pending" && task.assigneeID && !task.approvalID && !task.interrupted && !task.activeRunID)
          .sort((a, b) => a.createdAt - b.createdAt)
        for (const task of pending) {
          if (slots <= 0) break
          const workspace = state.workspaces[task.workspaceID]
          const agent = task.assigneeID ? state.agents[task.assigneeID] : undefined
          if (!workspace || workspace.archived || workspace.paused || !agent || agent.archived) continue
          if (busyAgents.has(bindingKey(task.workspaceID, task.assigneeID!))) continue
          if (task.mode === "edit" && busyEditDirs.has(workspace.directory)) continue
          busyAgents.add(bindingKey(task.workspaceID, task.assigneeID!))
          if (task.mode === "edit") busyEditDirs.add(workspace.directory)
          slots--
          const promise = this.runTask(task.id).finally(() => {
            this.running.delete(promise)
            this.pump()
          })
          this.running.add(promise)
        }
      } finally {
        this.pumping = false
      }
    })()
  }

  private async runTask(taskID: string): Promise<void> {
    const state = this.store.snapshot()
    const task = state.subtasks[taskID]
    if (!task || task.state !== "pending" || !task.assigneeID || task.interrupted || task.activeRunID) return
    const workspace = state.workspaces[task.workspaceID]
    const agent = state.agents[task.assigneeID]
    if (!workspace || !agent) return
    const runID = id("run")
    task.state = "working"
    task.outcome = "pending"
    task.attempts++
    task.startedAt = now()
    task.interrupted = false
    task.activeRunID = runID
    await this.store.saveSubtask(task)
    const binding = await this.ensureBinding(workspace, agent)
    if (!binding) {
      await this.failTask(task, "Could not create a native session.")
      return
    }
    const run: Run = { id: runID, subtaskID: task.id, workspaceID: task.workspaceID, agentID: task.assigneeID, sessionID: binding.sessionID, status: "running", startedAt: now() }
    this.activeRuns.set(runID, run)
    this.runBySession.set(binding.sessionID, runID)
    await this.store.saveAgent(agent)
    try {
      await this.ctx.session.instructions.entry.put({
        sessionID: binding.sessionID,
        key: "ensemble.v2.context",
        value: contextForTask(state, task, workspace, agent),
      }).catch(() => undefined)
      const models = [agent.mainModel, ...agent.backupModels]
      let result: { text: string; tools: string[]; failure?: any } | undefined
      for (let index = 0; index < models.length; index++) {
        const model = models[index]
        if (index > 0) await this.appendMessage(workspace, { author: "system", text: `Model unavailable; switched to ${model.providerID}/${model.modelID}${model.variant ? `#${model.variant}` : ""}.`, kind: "system", taskID: task.id })
        await this.ctx.session.switchModel({ sessionID: binding.sessionID, model: { providerID: model.providerID, id: model.modelID, ...(model.variant ? { variant: model.variant } : {}) } }).catch(() => undefined)
        const startedAt = now()
        await this.ctx.session.prompt({ sessionID: binding.sessionID, text: promptForTask(task), delivery: "steer" })
        await this.ctx.session.wait({ sessionID: binding.sessionID }).catch(() => undefined)
        const messages = listData(await this.ctx.session.context({ sessionID: binding.sessionID }))
        result = assistantResult(messages, startedAt)
        if (!result.failure) break
        if (!availabilityFailure(result.failure) || anyToolCall(messages, startedAt) || index === models.length - 1) break
      }
      const current = this.store.snapshot()
      const currentTask = current.subtasks[task.id]
      if (!currentTask || currentTask.activeRunID !== runID) return
      if (result?.failure) {
        const uncertain = result.tools.length > 0
        currentTask.state = "pending"
        currentTask.interrupted = true
        currentTask.activeRunID = undefined
        currentTask.error = uncertain ? "A tool outcome is uncertain. Review the native session before retrying." : result.failure.message ?? "All models failed."
        await this.store.saveSubtask(currentTask)
        await this.ensureInterruptedApproval(currentTask)
        return
      }
      const text = result?.text || "Work completed."
      if (currentTask.approvalID) {
        await this.appendMessage(workspace, { author: "agent", agentID: agent.id, text, kind: "text", taskID: currentTask.id })
        currentTask.activeRunID = undefined
        await this.store.saveSubtask(currentTask)
        return
      }
      const children = Object.values(current.subtasks).filter((item) => item.parentID === currentTask.id)
      currentTask.activeRunID = undefined
      if (children.length > 0 && currentTask.stage === "initial") {
        currentTask.awaitingChildren = true
        currentTask.state = "working"
        await this.store.saveSubtask(currentTask)
        await this.appendMessage(workspace, { author: "agent", agentID: agent.id, text, kind: "text", taskID: currentTask.id })
        await this.maybeSynthesize(currentTask.id)
        return
      }
      currentTask.state = "replied"
      currentTask.outcome = "succeeded"
      currentTask.runSummary = result?.tools.length ? `${result.tools.length} tool call${result.tools.length === 1 ? "" : "s"}` : "no tool calls"
      currentTask.repliedAt = now()
      await this.store.saveSubtask(currentTask)
      const message = await this.appendMessage(workspace, { author: "agent", agentID: agent.id, text, kind: "text", taskID: currentTask.id })
      currentTask.resultMessageID = message.id
      await this.store.saveSubtask(currentTask)
      if (currentTask.parentID) await this.maybeSynthesize(currentTask.parentID)
    } catch (error: any) {
      const current = this.store.snapshot()
      const currentTask = current.subtasks[task.id]
      if (currentTask?.activeRunID === runID) await this.failTask(currentTask, error?.message ?? String(error))
    } finally {
      run.status = "completed"
      this.activeRuns.delete(runID)
      this.runBySession.delete(binding.sessionID)
    }
  }

  private async ensureBinding(workspace: Workspace, agent: Agent): Promise<{ sessionID: string } | undefined> {
    const existing = this.store.binding(workspace.id, agent.id)
    if (existing && existing.agentVersion === agent.version) return { sessionID: existing.sessionID }
    const created = unwrap<any>(await this.ctx.session.create({
      title: `${agent.name} · ${workspace.name}`,
      agent: "build",
      model: { providerID: agent.mainModel.providerID, id: agent.mainModel.modelID, ...(agent.mainModel.variant ? { variant: agent.mainModel.variant } : {}) },
      permissions: skillPermissions(agent.skillbox),
      location: { directory: workspace.directory },
    }))
    if (!created?.id) return undefined
    const binding = { workspaceID: workspace.id, agentID: agent.id, sessionID: created.id, agentVersion: agent.version, updatedAt: now() }
    await this.store.saveBinding(binding)
    const current = this.store.snapshot().agents[agent.id]
    if (current?.pendingSettings) {
      current.pendingSettings = false
      await this.store.saveAgent(current)
    }
    return { sessionID: created.id }
  }

  private async failTask(task: Subtask, error: string): Promise<void> {
    task.state = "replied"
    task.outcome = "failed"
    task.error = error
    task.activeRunID = undefined
    task.repliedAt = now()
    await this.store.saveSubtask(task)
    const workspace = this.store.snapshot().workspaces[task.workspaceID]
    if (workspace) await this.appendMessage(workspace, { author: "system", text: `Subtask failed: ${error}`, kind: "system", taskID: task.id })
    if (task.parentID) await this.maybeSynthesize(task.parentID)
  }

  private async maybeSynthesize(parentID: string): Promise<void> {
    const state = this.store.snapshot()
    const parent = state.subtasks[parentID]
    if (!parent || parent.stage === "synthesis" || parent.state === "replied") return
    const children = Object.values(state.subtasks).filter((item) => item.parentID === parentID)
    if (children.length === 0 || children.some((child) => child.state !== "replied")) return
    const workspace = state.workspaces[parent.workspaceID]
    if (!workspace) return
    if (workspace.synthesis) {
      parent.state = "pending"
      parent.stage = "synthesis"
      parent.awaitingChildren = false
      parent.outcome = "pending"
      parent.assigneeID = workspace.leaderID
      await this.store.saveSubtask(parent)
    } else {
      parent.state = "replied"
      parent.outcome = "succeeded"
      parent.repliedAt = now()
      await this.store.saveSubtask(parent)
      await this.appendMessage(workspace, { author: "system", text: "Delegated subtasks completed.", kind: "system", taskID: parent.id })
    }
  }
}
