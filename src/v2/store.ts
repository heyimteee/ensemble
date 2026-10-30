import { createInitialState, DEFAULT_SETTINGS } from "./defaults.ts"
import type {
  Agent,
  Approval,
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

export class V2Store {
  private readonly ctx: Ctx
  private state: SnapshotState
  private readonly onChange?: (state: SnapshotState) => void

  constructor(ctx: Ctx, onChange?: (state: SnapshotState) => void) {
    this.ctx = ctx
    this.state = createInitialState()
    this.onChange = onChange
  }

  async load(): Promise<void> {
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
    for (const subtask of Object.values(this.state.subtasks)) {
      if (subtask.state === "working") {
        subtask.state = "pending"
        subtask.interrupted = true
        subtask.activeRunID = undefined
        subtask.error = "Ensemble restarted while this subtask was working."
      }
    }
    if (this.state.ui.activeWorkspaceID && !this.state.workspaces[this.state.ui.activeWorkspaceID]) {
      this.state.ui.activeWorkspaceID = undefined
    }
  }

  snapshot(): SnapshotState {
    return structuredClone(this.state)
  }

  settings(): Settings {
    return structuredClone(this.state.settings)
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
    const memoryIDs = Object.values(this.state.memories).filter((memory) => memory.workspaceID === workspaceID).map((memory) => memory.id)
    const approvalIDs = Object.values(this.state.approvals).filter((approval) => approval.workspaceID === workspaceID).map((approval) => approval.id)
    const dmQueueIDs = Object.values(this.state.dmQueue).filter((entry) => entry.workspaceID === workspaceID).map((entry) => entry.id)
    delete this.state.messages[workspaceID]
    for (const id of subtaskIDs) delete this.state.subtasks[id]
    for (const [key, binding] of Object.entries(this.state.bindings)) if (binding.workspaceID === workspaceID) delete this.state.bindings[key]
    for (const id of memoryIDs) delete this.state.memories[id]
    for (const id of approvalIDs) delete this.state.approvals[id]
    for (const id of dmQueueIDs) delete this.state.dmQueue[id]
    await this.removePrefix(`v2/message/${workspaceID}/`)
    await this.removePrefix(`v2/binding/${workspaceID}/`)
    for (const id of subtaskIDs) await this.ctx.storage.remove(`v2/subtask/${id}`)
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
    if (parts[1] === "memory" && parts[2]) delete this.state.memories[parts[2]]
    if (parts[1] === "approval" && parts[2]) delete this.state.approvals[parts[2]]
    if (parts[1] === "binding" && parts[2] && parts[3]) delete this.state.bindings[`${parts[2]}:${parts[3]}`]
    if (parts[1] === "dmqueue" && parts[2]) delete this.state.dmQueue[parts[2]]
    if (parts[1] === "message" && parts[2]) {
      const sequence = parts[3]
      this.state.messages[parts[2]] = (this.state.messages[parts[2]] ?? []).filter((message) => String(message.seq).padStart(8, "0") !== sequence)
      if (this.state.messages[parts[2]].length === 0) delete this.state.messages[parts[2]]
    }
  }

  async reset(): Promise<void> {
    for (const prefix of ["v2/agent/", "v2/workspace/", "v2/message/", "v2/subtask/", "v2/binding/", "v2/memory/", "v2/approval/", "v2/dmqueue/"]) {
      await this.removePrefix(prefix)
    }
    await this.ctx.storage.remove("v2/meta")
    this.state = createInitialState()
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
    this.onChange?.(this.snapshot())
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
