import { Plugin } from "@opencode/plugin"
import { EnsembleRpc } from "../rpc.ts"
import { createInitialState, DEFAULT_SETTINGS, EnsembleStore } from "../core/store.ts"
import { newId, now } from "../core/ids.ts"
import { routeChannelMessage, resolveCheckoutKey, validateChannel, validateModelSelection, type ModelOption } from "../core/routing.ts"
import { visibleMemories, memoryContext, createMemoryEntry } from "../core/memory.ts"
import { selectRunnable, nextQueueOrder } from "../core/scheduler.ts"
import { createApproval, resolveApproval } from "../core/approvals.ts"
import { archiveAgent, archiveChannel, deleteAgent, deleteChannel } from "../core/lifecycle.ts"
import type {
  AgentProfile,
  Approval,
  Channel,
  Conversation,
  EnsembleState,
  MemoryScope,
  ModelSelection,
  SkillOption,
  Snapshot,
  WorkItem,
} from "../core/types.ts"

type Ctx = any
type Json = Record<string, any>

const STATE_KEY = "ensemble.state"

function unwrap<T>(value: any): T {
  return (value && typeof value === "object" && "data" in value ? value.data : value) as T
}

function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function listData(value: any): any[] {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.data)) return value.data
  return []
}

function normalizeState(raw: any): EnsembleState {
  const initial = createInitialState()
  if (!raw || typeof raw !== "object" || raw.schemaVersion !== 1) return initial
  return {
    ...initial,
    ...raw,
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
    agents: raw.agents ?? {},
    channels: raw.channels ?? {},
    conversations: raw.conversations ?? {},
    work: raw.work ?? {},
    handoffs: raw.handoffs ?? {},
    approvals: raw.approvals ?? {},
    memories: raw.memories ?? {},
    chains: raw.chains ?? {},
  }
}

function sessionModelRef(model: ModelSelection): { providerID: string; id: string; variant?: string } {
  return { providerID: model.providerID, id: model.modelID, ...(model.variant ? { variant: model.variant } : {}) }
}

function sameModel(a: ModelSelection, b: ModelSelection): boolean {
  return a.providerID === b.providerID && a.modelID === b.modelID && (a.variant ?? "") === (b.variant ?? "")
}

function sameModels(a: ModelSelection[], b: ModelSelection[]): boolean {
  return a.length === b.length && a.every((model, index) => sameModel(model, b[index]))
}

function modelLabel(model: ModelSelection): string {
  return `${model.providerID}/${model.modelID}${model.variant ? `#${model.variant}` : ""}`
}

function skillPermissions(skillbox: string[]): Array<{ action: string; resource: string; effect: "allow" | "deny" }> {
  return [
    { action: "skill", resource: "*", effect: "deny" },
    ...skillbox.map((id) => ({ action: "skill" as const, resource: id, effect: "allow" as const })),
  ]
}

function senderName(state: EnsembleState, sender: any): string {
  if (sender?.type === "user") return "You"
  return state.agents[sender?.agentID]?.name ?? sender?.nameSnapshot ?? "Unknown agent"
}

function recentChannelContext(state: EnsembleState, channel: Channel, limit = 20): string {
  const messages = channel.messages.slice(-limit)
  if (messages.length === 0) return "No messages yet."
  return messages.map((message) => `${senderName(state, message.sender)}: ${message.text}`).join("\n")
}

function availabilityFailure(error: any): boolean {
  if (!error) return false
  const type = String(error.type ?? "")
  const message = String(error.message ?? "").toLowerCase()
  if (!type.startsWith("provider.")) return false
  return /rate|limit|quota|unavailable|overload|timeout|network|no-route|connection|model|outage|internal|server|500|502|503|504/.test(message) || type === "provider.no-route" || type === "provider.internal"
}

function anyToolCall(messages: any[], since: number): boolean {
  return messages.some(
    (message) =>
      message?.type === "assistant" &&
      message?.time?.created >= since &&
      Array.isArray(message.content) &&
      message.content.some((part: any) => part?.type === "tool"),
  )
}

function assistantResult(messages: any[], since: number): { text: string; tools: string[]; failure?: any } {
  const texts: string[] = []
  const tools: string[] = []
  let failure: any
  for (const message of messages) {
    if (!message || message.time?.created < since) continue
    if (message.type === "idle" && message.outcome === "failed") failure = message.error
    if (message.type !== "assistant" || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part?.type === "text" && part.text) texts.push(part.text)
      if (part?.type === "tool") tools.push(`${part.name}:${part.state?.status ?? "unknown"}`)
    }
  }
  return { text: texts.join("\n").trim(), tools, failure }
}

export class EnsembleServer {
  private readonly ctx: Ctx
  private store!: EnsembleStore
  private registration: any
  private retryRegistration: any
  private stopped = false
  private pumping = false
  private running = new Set<Promise<void>>()
  private catalogModels: ModelOption[] = []
  private catalogSkills: SkillOption[] = []
  private catalogLoading = false
  private lastCatalogAt = 0
  private catalogAbort: AbortController | undefined

  constructor(ctx: Ctx) {
    this.ctx = ctx
  }

  async start(): Promise<() => Promise<void>> {
    const raw = await this.ctx.storage.get(STATE_KEY).catch(() => undefined)
    this.store = new EnsembleStore({
      initial: normalizeState(raw),
      persist: (state) => this.ctx.storage.set(STATE_KEY, state),
      onChange: (state) => {
        if (this.registration) void this.registration.events.emit("changed", { version: state.version }).catch(() => undefined)
      },
    })
    await this.installTools()
    this.retryRegistration = await this.ctx.session.hook("retry", (event: any) => {
      if (!this.profileForSession(event.sessionID)) return
      if (availabilityFailure(event.error)) event.decision = { retry: false }
    })
    this.registration = await this.ctx.rpc.register(EnsembleRpc, {
      snapshot: async ({ directory }: { directory: string }) => this.snapshot(directory),
      invoke: async ({ directory, action, payload }: { directory: string; action: string; payload?: Json }) =>
        this.invoke(directory, action, payload ?? {}),
    })
    void this.refreshCatalog()
    this.catalogAbort = new AbortController()
    void (async () => {
      try {
        for await (const event of this.ctx.event.subscribe({ types: ["skill.updated", "model.updated", "provider.updated"], signal: this.catalogAbort!.signal })) {
          if (event.type) void this.refreshCatalog()
        }
      } catch {}
    })()
    await this.recover()
    this.pump()
    return async () => {
      this.stopped = true
      this.catalogAbort?.abort()
      await this.retryRegistration?.dispose?.().catch(() => undefined)
      await Promise.allSettled([...this.running])
    }
  }

  private async installTools(): Promise<void> {
    await this.ctx.tool.transform((editor: any) => {
      editor.namespace({ name: "ensemble", description: "Ensemble teammate collaboration and memory." })
      editor.add({
        name: "handoff",
        options: { namespace: "ensemble", codemode: false },
        description: "Delegate work to another member of the current Ensemble channel. The handoff is visible to the user.",
        input: {
          type: "object",
          properties: {
            channelID: { type: "string" },
            toAgentID: { type: "string" },
            message: { type: "string" },
            mode: { type: "string", enum: ["research", "edit"] },
          },
          required: ["channelID", "toAgentID", "message"],
          additionalProperties: false,
        },
        execute: async (input: Json, context: any) => {
          const profileID = this.profileForSession(context.sessionID)
          if (!profileID) return { content: "Ensemble tools are only available to Ensemble agents." }
          return { content: await this.toolHandoff(profileID, input, context) }
        },
      })
      editor.add({
        name: "remember",
        options: { namespace: "ensemble", codemode: false },
        description: "Save durable knowledge for this Ensemble agent or channel. Cross-project promotion requires user approval.",
        input: {
          type: "object",
          properties: {
            text: { type: "string" },
            scope: { type: "string", enum: ["project", "channel", "global"] },
            channelID: { type: "string" },
          },
          required: ["text", "scope"],
          additionalProperties: false,
        },
        execute: async (input: Json, context: any) => {
          const profileID = this.profileForSession(context.sessionID)
          if (!profileID) return { content: "Ensemble tools are only available to Ensemble agents." }
          return { content: await this.toolRemember(profileID, input, context) }
        },
      })
      editor.add({
        name: "share",
        description: "Request user authorization before sharing information across projects or outside a private direct conversation.",
        options: { namespace: "ensemble", codemode: false },
        input: {
          type: "object",
          properties: {
            text: { type: "string" },
            scope: { type: "string", enum: ["cross_project", "private_transcript"] },
          },
          required: ["text", "scope"],
          additionalProperties: false,
        },
        execute: async (input: Json, context: any) => {
          const profileID = this.profileForSession(context.sessionID)
          if (!profileID) return { content: "Ensemble tools are only available to Ensemble agents." }
          const approval = await this.store.mutate((state) =>
            createApproval(state, {
              kind: "cross_project",
              title: `Share ${input.scope === "private_transcript" ? "private transcript content" : "knowledge across projects"}`,
              detail: input.text,
              agentID: profileID,
              workID: this.workForSession(state, context.sessionID)?.id,
              payload: { text: input.text, scope: input.scope },
            }),
          )
          return { content: `Sharing needs user authorization: ${approval.id}` }
        },
      })
      editor.add({
        name: "propose",
        options: { namespace: "ensemble", codemode: false },
        description: "Ask the user to approve a roster, Skillbox, membership, or leadership change. Proposals never apply themselves.",
        input: {
          type: "object",
          properties: {
            title: { type: "string" },
            detail: { type: "string" },
            kind: { type: "string" },
            payload: { type: "object", additionalProperties: true },
          },
          required: ["title", "detail"],
          additionalProperties: false,
        },
        execute: async (input: Json, context: any) => {
          const profileID = this.profileForSession(context.sessionID)
          if (!profileID) return { content: "Ensemble tools are only available to Ensemble agents." }
          const approval = await this.store.mutate((state) => {
            const proposed: Record<string, unknown> = { ...(input.payload ?? {}) }
            if (proposed.agentID && proposed.baseVersion === undefined) {
              const target = state.agents[String(proposed.agentID)]
              if (target) proposed.baseVersion = target.version
            }
            return createApproval(state, {
              kind: "roster_change",
              title: input.title,
              detail: input.detail,
              agentID: profileID,
              workID: this.workForSession(state, context.sessionID)?.id,
              payload: input.kind ? { kind: input.kind, ...proposed } : undefined,
            })
          })
          return { content: `Proposal recorded for user approval: ${approval.id}` }
        },
      })
    })
  }

  private async refreshCatalog(): Promise<void> {
    if (this.catalogLoading) return
    this.catalogLoading = true
    const guard = setTimeout(() => { this.catalogLoading = false }, 10_000)
    try {
      const [modelsRaw, skillsRaw] = await Promise.all([
        this.ctx.model.list().catch(() => []),
        this.ctx.skill.list().catch(() => []),
      ])
      this.catalogModels = listData(modelsRaw).map((model: any) => ({
        providerID: model.providerID,
        modelID: model.id ?? model.modelID,
        name: model.name ?? model.id ?? model.modelID,
        variants: Array.isArray(model.variants) ? model.variants.map((variant: any) => (typeof variant === "string" ? variant : variant.id)).filter(Boolean) : [],
      }))
      this.catalogSkills = listData(skillsRaw).map((skill: any) => ({
        id: skill.id,
        name: skill.name ?? skill.id,
        description: skill.description,
      }))
      this.lastCatalogAt = Date.now()
      if (this.registration) void this.registration.events.emit("changed", { version: this.store.snapshot().version }).catch(() => undefined)
    } finally {
      clearTimeout(guard)
      this.catalogLoading = false
    }
  }

  private async snapshot(directory: string): Promise<Snapshot> {
    if (!this.catalogLoading && Date.now() - this.lastCatalogAt > 10_000) void this.refreshCatalog()
    return {
      state: jsonSafe(this.store.snapshot()),
      models: this.catalogModels,
      skills: this.catalogSkills,
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
      case "agent.create":
        return this.createAgent(directory, payload)
      case "agent.update":
        return this.updateAgent(directory, payload)
      case "agent.archive":
        return this.archiveAgent(payload.id, payload.replacementLeaderID)
      case "agent.delete":
        return this.removeAgent(payload.id, payload.replacementLeaderID, Boolean(payload.deleteNativeSessions))
      case "channel.create":
        return this.createChannel(directory, payload)
      case "channel.update":
        return this.updateChannel(payload)
      case "channel.archive":
        return this.archiveChannel(payload.id)
      case "channel.delete":
        return this.removeChannel(payload.id, Boolean(payload.deleteNativeSessions))
      case "channel.send":
        return this.sendChannelMessage(directory, payload)
      case "direct.send":
        return this.sendDirectMessage(directory, payload)
      case "direct.fresh":
        return this.freshConversation(directory, payload)
      case "memory.add":
        return this.addMemory(directory, payload)
      case "memory.update":
        return this.updateMemory(payload)
      case "memory.delete":
        return this.removeMemory(payload)
      case "memory.promote":
        return this.promoteMemory(payload)
      case "approval.resolve":
        return this.resolveApproval(payload)
      case "queue.reorder":
        return this.reorderQueue(payload)
      case "queue.cancel":
        return this.cancelWork(payload.workID)
      case "queue.steer":
        return this.steerWork(payload.workID)
      case "work.stop":
        return this.stopWork(payload)
      case "work.resume":
        return this.resumeWork(payload)
      case "work.retry":
        return this.retryWork(payload.workID)
      case "settings.update":
        return this.updateSettings(payload)
      default:
        throw Object.assign(new Error(`Unknown Ensemble action: ${action}`), { code: "unknown_action" })
    }
  }

  private async defaultModel(): Promise<ModelSelection> {
    const models = await this.modelOptions()
    const selected = models[0]
    if (!selected) throw Object.assign(new Error("No model is available in this project."), { code: "no_model" })
    const firstVariant = selected.variants?.[0]
    return {
      providerID: selected.providerID,
      modelID: selected.modelID,
      variant: typeof firstVariant === "string" ? firstVariant : firstVariant?.id,
    }
  }

  private async createAgent(directory: string, payload: Json): Promise<AgentProfile> {
    let source: any
    if (payload.fromAgentID) {
      source = unwrap<any>(await this.ctx.agent.get({ agentID: payload.fromAgentID }).catch(() => undefined))
    }
    const sourceModel = source?.model
      ? {
          providerID: source.model.providerID,
          modelID: source.model.modelID ?? source.model.id,
          variant: source.model.variant,
        }
      : undefined
    const mainModel = payload.mainModel ?? sourceModel ?? (await this.defaultModel())
    const models = await this.modelOptions()
    const invalid = validateModelSelection(mainModel, models)
    if (invalid) throw Object.assign(new Error(invalid), { code: "invalid_model" })
    const backupModels = Array.isArray(payload.backupModels) ? payload.backupModels : []
    for (const model of backupModels) {
      const invalidBackup = validateModelSelection(model, models)
      if (invalidBackup) throw Object.assign(new Error(invalidBackup), { code: "invalid_model" })
    }
    const name = String(payload.name ?? "").trim()
    if (!name) throw Object.assign(new Error("Agent name is required."), { code: "invalid_name" })
    return this.store.mutate((state) => {
      const at = now()
      const profile: AgentProfile = {
        id: newId("agent"),
        name,
        instructions: String(payload.instructions ?? source?.system ?? ""),
        mainModel,
        backupModels,
        skillbox: Array.isArray(payload.skillbox) ? payload.skillbox : [],
        archived: false,
        pendingSettings: false,
        version: 1,
        createdAt: at,
        updatedAt: at,
      }
      state.agents[profile.id] = profile
      return profile
    })
  }

  private async updateAgent(directory: string, payload: Json): Promise<AgentProfile> {
    const models = await this.modelOptions()
    return this.store.mutate((state) => {
      const profile = state.agents[payload.id]
      if (!profile) throw Object.assign(new Error("Agent not found."), { code: "not_found" })
      let behaviorChanged = false
      if (payload.name !== undefined) {
        const name = String(payload.name).trim()
        if (!name) throw Object.assign(new Error("Agent name is required."), { code: "invalid_name" })
        profile.name = name
      }
      if (payload.instructions !== undefined && String(payload.instructions) !== profile.instructions) {
        profile.instructions = String(payload.instructions)
        behaviorChanged = true
      }
      if (payload.mainModel !== undefined) {
        const invalid = validateModelSelection(payload.mainModel, models)
        if (invalid) throw Object.assign(new Error(invalid), { code: "invalid_model" })
        if (!sameModel(profile.mainModel, payload.mainModel)) behaviorChanged = true
        profile.mainModel = payload.mainModel
      }
      if (payload.backupModels !== undefined) {
        for (const model of payload.backupModels) {
          const invalid = validateModelSelection(model, models)
          if (invalid) throw Object.assign(new Error(invalid), { code: "invalid_model" })
        }
        if (!sameModels(profile.backupModels, payload.backupModels)) behaviorChanged = true
        profile.backupModels = payload.backupModels
      }
      if (payload.skillbox !== undefined) {
        const nextSkillbox = [...new Set(payload.skillbox.map(String))]
        if (nextSkillbox.length !== profile.skillbox.length || nextSkillbox.some((id) => !profile.skillbox.includes(id))) behaviorChanged = true
        profile.skillbox = nextSkillbox
      }
      if (behaviorChanged) {
        profile.version++
        profile.pendingSettings = true
      }
      profile.updatedAt = now()
      return profile
    })
  }

  private async modelOptions(): Promise<ModelOption[]> {
    if (this.catalogModels.length === 0) {
      await Promise.race([
        this.refreshCatalog(),
        new Promise<void>((resolve) => setTimeout(resolve, 1500)),
      ])
    }
    return this.catalogModels
  }

  private async archiveAgent(agentID: string, replacementLeaderID?: string) {
    const sessions = await this.store.mutate((state) => {
      const running = Object.values(state.work)
        .filter((work) => work.agentID === agentID && work.status === "running" && work.sessionID)
        .map((work) => work.sessionID!)
      const result = archiveAgent(state, agentID, replacementLeaderID)
      if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code })
      return running
    })
    for (const sessionID of sessions) await this.ctx.session.interrupt({ sessionID, resume: false }).catch(() => undefined)
    return { ok: true }
  }

  private async removeAgent(agentID: string, replacementLeaderID?: string, deleteNativeSessions = false) {
    const nativeIDs = await this.store.mutate((state) => {
      const conversations = Object.values(state.conversations).filter((conversation) => conversation.agentID === agentID)
      const running = Object.values(state.work)
        .filter((work) => work.agentID === agentID && work.status === "running" && work.sessionID)
        .map((work) => work.sessionID!)
      const result = deleteAgent(state, agentID, replacementLeaderID)
      if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code })
      return [...new Set([...conversations.flatMap((conversation) => conversation.sessionIDs), ...running])]
    })
    for (const sessionID of nativeIDs) await this.ctx.session.interrupt({ sessionID, resume: false }).catch(() => undefined)
    if (deleteNativeSessions) {
      for (const sessionID of nativeIDs) await this.ctx.session.remove({ sessionID }).catch(() => undefined)
    }
    return { ok: true, nativeSessionsDeleted: deleteNativeSessions ? nativeIDs.length : 0 }
  }

  private async createChannel(directory: string, payload: Json): Promise<Channel> {
    return this.store.mutate((state) => {
      const members = Array.isArray(payload.memberIDs) ? [...new Set(payload.memberIDs.map(String))] : []
      const candidate = {
        name: String(payload.name ?? "").trim(),
        memberIDs: members,
        leaderID: String(payload.leaderID ?? ""),
      }
      const invalid = validateChannel(candidate, state.agents)
      if (invalid) throw Object.assign(new Error(invalid), { code: "invalid_channel" })
      const at = now()
      const channel: Channel = {
        id: newId("channel"),
        name: candidate.name,
        projectDirectory: resolveCheckoutKey(directory),
        memberIDs: members,
        leaderID: candidate.leaderID,
        messages: [],
        archived: false,
        paused: false,
        chainIDs: [],
        createdAt: at,
        updatedAt: at,
      }
      state.channels[channel.id] = channel
      return channel
    })
  }

  private async updateChannel(payload: Json): Promise<Channel> {
    return this.store.mutate((state) => {
      const channel = state.channels[payload.id]
      if (!channel) throw Object.assign(new Error("Channel not found."), { code: "not_found" })
      const name = payload.name !== undefined ? String(payload.name).trim() : channel.name
      const memberIDs = payload.memberIDs !== undefined ? [...new Set(payload.memberIDs.map(String))] : channel.memberIDs
      const leaderID = payload.leaderID !== undefined ? String(payload.leaderID) : channel.leaderID
      const invalid = validateChannel({ name, memberIDs, leaderID }, state.agents)
      if (invalid) throw Object.assign(new Error(invalid), { code: "invalid_channel" })
      channel.name = name
      channel.memberIDs = memberIDs
      channel.leaderID = leaderID
      channel.updatedAt = now()
      return channel
    })
  }

  private async archiveChannel(channelID: string) {
    const sessions = await this.store.mutate((state) => {
      const running = Object.values(state.work)
        .filter((work) => work.channelID === channelID && work.status === "running" && work.sessionID)
        .map((work) => work.sessionID!)
      const result = archiveChannel(state, channelID)
      if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code })
      return running
    })
    for (const sessionID of sessions) await this.ctx.session.interrupt({ sessionID, resume: false }).catch(() => undefined)
    return { ok: true }
  }

  private async removeChannel(channelID: string, deleteNativeSessions = false) {
    const nativeIDs = await this.store.mutate((state) => {
      const conversations = Object.values(state.conversations).filter((conversation) => conversation.channelID === channelID)
      const running = Object.values(state.work)
        .filter((work) => work.channelID === channelID && work.status === "running" && work.sessionID)
        .map((work) => work.sessionID!)
      const result = deleteChannel(state, channelID)
      if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code })
      return [...new Set([...conversations.flatMap((conversation) => conversation.sessionIDs), ...running])]
    })
    for (const sessionID of nativeIDs) await this.ctx.session.interrupt({ sessionID, resume: false }).catch(() => undefined)
    if (deleteNativeSessions) {
      for (const sessionID of nativeIDs) await this.ctx.session.remove({ sessionID }).catch(() => undefined)
    }
    return { ok: true, nativeSessionsDeleted: deleteNativeSessions ? nativeIDs.length : 0 }
  }

  private async sendChannelMessage(directory: string, payload: Json): Promise<{ messageID: string; recipients: string[] }> {
    const result = await this.store.mutate((state) => {
      const channel = state.channels[payload.channelID]
      if (!channel) throw Object.assign(new Error("Channel not found."), { code: "not_found" })
      if (channel.archived) throw Object.assign(new Error("Channel is archived."), { code: "archived" })
      if (channel.paused) throw Object.assign(new Error("Channel is paused. Resume it first."), { code: "paused" })
      const text = String(payload.text ?? "").trim()
      if (!text) throw Object.assign(new Error("Message is empty."), { code: "empty" })
      const recipients = routeChannelMessage(text, channel, Object.values(state.agents))
        .filter((agentID) => state.agents[agentID] && !state.agents[agentID].archived)
      if (recipients.length === 0) throw Object.assign(new Error("Channel has no available leader."), { code: "no_recipient" })
      const chain = this.createChain(state, channel.id)
      const message = {
        id: newId("msg"),
        channelID: channel.id,
        sender: { type: "user" as const },
        text,
        mentions: recipients,
        createdAt: now(),
      }
      channel.messages.push(message)
      channel.updatedAt = now()
      for (const agentID of recipients) {
        this.enqueueWork(state, {
          kind: "channel",
          agentID,
          channelID: channel.id,
          directory: channel.projectDirectory,
          prompt: text,
          mode: payload.mode === "edit" ? "edit" : "research",
          chainID: chain.id,
        })
      }
      return { messageID: message.id, recipients }
    })
    return result
  }

  private async sendDirectMessage(directory: string, payload: Json): Promise<{ messageID: string; conversationID: string }> {
    const result = await this.store.mutate((state) => {
      const agent = state.agents[payload.agentID]
      if (!agent) throw Object.assign(new Error("Agent not found."), { code: "not_found" })
      if (agent.archived) throw Object.assign(new Error("Agent is archived."), { code: "archived" })
      const text = String(payload.text ?? "").trim()
      if (!text) throw Object.assign(new Error("Message is empty."), { code: "empty" })
      const conversation = this.getOrCreateConversation(state, agent, resolveCheckoutKey(directory))
      const message = {
        id: newId("msg"),
        role: "user" as const,
        text,
        createdAt: now(),
      }
      conversation.messages.push(message)
      conversation.updatedAt = now()
      this.enqueueWork(state, {
        kind: "direct",
        agentID: agent.id,
        conversationID: conversation.id,
        directory: conversation.projectDirectory,
        prompt: text,
        mode: payload.mode === "edit" ? "edit" : "research",
      })
      return { messageID: message.id, conversationID: conversation.id }
    })
    return result
  }

  private async freshConversation(directory: string, payload: Json): Promise<Conversation> {
    return this.store.mutate((state) => {
      const agent = state.agents[payload.agentID]
      if (!agent) throw Object.assign(new Error("Agent not found."), { code: "not_found" })
      const key = `direct:${agent.id}:${resolveCheckoutKey(directory)}:${newId("conv")}`
      const conversation = this.createConversation(state, key, "direct", agent, resolveCheckoutKey(directory))
      conversation.messages.push({ id: newId("msg"), role: "system", text: "Started a fresh conversation. Older transcripts are preserved in their native sessions.", createdAt: now() })
      return conversation
    })
  }

  private async addMemory(directory: string, payload: Json): Promise<any> {
    return this.store.mutate((state) => {
      const text = String(payload.text ?? "").trim()
      if (!text) throw Object.assign(new Error("Memory text is required."), { code: "empty" })
      const scope = (payload.scope ?? "project") as MemoryScope
      const agentID = payload.agentID
      const channelID = payload.channelID
      if (scope === "channel" && !channelID) throw Object.assign(new Error("Channel memory needs a channel."), { code: "invalid_scope" })
      if (scope !== "channel" && !agentID) throw Object.assign(new Error("Agent memory needs an agent."), { code: "invalid_scope" })
      const entry = createMemoryEntry({
        id: newId("mem"),
        text,
        scope,
        origin: "manual",
        source: payload.source ?? "user",
        agentID,
        channelID,
        projectDirectory: scope === "project" ? resolveCheckoutKey(directory) : undefined,
      })
      state.memories[entry.id] = entry
      return entry
    })
  }

  private async updateMemory(payload: Json): Promise<any> {
    return this.store.mutate((state) => {
      const entry = state.memories[payload.id]
      if (!entry || entry.deletedAt) throw Object.assign(new Error("Memory not found."), { code: "not_found" })
      entry.text = String(payload.text ?? entry.text).trim()
      entry.updatedAt = now()
      entry.history.push({ at: now(), action: "edited", by: "user" })
      return entry
    })
  }

  private async removeMemory(payload: Json): Promise<any> {
    return this.store.mutate((state) => {
      const entry = state.memories[payload.id]
      if (!entry || entry.deletedAt) throw Object.assign(new Error("Memory not found."), { code: "not_found" })
      entry.deletedAt = now()
      entry.updatedAt = now()
      entry.history.push({ at: now(), action: "deleted", by: "user" })
      return { deleted: true, note: "The memory is excluded from future retrieval. Existing transcripts are not erased." }
    })
  }

  private async promoteMemory(payload: Json): Promise<any> {
    return this.store.mutate((state) => {
      const entry = state.memories[payload.id]
      if (!entry || entry.deletedAt) throw Object.assign(new Error("Memory not found."), { code: "not_found" })
      if (entry.scope === "global") return { alreadyGlobal: true, memoryID: entry.id }
      return createApproval(state, {
        kind: "promote_memory",
        title: `Promote memory for ${state.agents[entry.agentID ?? ""]?.name ?? "agent"}`,
        detail: entry.text,
        agentID: entry.agentID,
        memoryID: entry.id,
      })
    })
  }

  private async toolHandoff(profileID: string, input: Json, context: any): Promise<string> {
    return this.store.mutate((state) => {
      const channel = state.channels[input.channelID]
      if (!channel) return "Channel not found."
      if (!channel.memberIDs.includes(profileID)) return "You are not a member of this channel."
      if (channel.paused || channel.archived) return "This channel is paused or archived."
      const target = state.agents[input.toAgentID]
      if (!target) return "Target agent not found."
      if (target.archived) return "Target agent is archived."
      const work = this.workForSession(state, context.sessionID)
      const chain = work?.chainID ? state.chains[work.chainID] : this.createChain(state, channel.id)
      const member = channel.memberIDs.includes(target.id)
      const at = now()
      const handoff = {
        id: newId("handoff"),
        channelID: channel.id,
        chainID: chain.id,
        fromAgentID: profileID,
        toAgentID: target.id,
        fromNameSnapshot: state.agents[profileID]?.name ?? "Agent",
        toNameSnapshot: target.name,
        request: String(input.message ?? "").trim(),
        status: "queued" as const,
        createdAt: at,
        updatedAt: at,
      }
      if (!member) {
        handoff.status = "waiting_approval"
        state.handoffs[handoff.id] = handoff
        const approval = createApproval(state, {
          kind: "outside_roster",
          title: `${state.agents[profileID]?.name ?? "Agent"} wants to contact ${target.name}`,
          detail: handoff.request,
          channelID: channel.id,
          agentID: profileID,
          handoffID: handoff.id,
          workID: work?.id,
        })
        return `Approval required before contacting ${target.name}: ${approval.id}`
      }
      if (chain.deliveries >= chain.limit) {
        handoff.status = "waiting_approval"
        state.handoffs[handoff.id] = handoff
        const approval = createApproval(state, {
          kind: "chain_limit",
          title: `Task chain reached its ${chain.limit}-delivery limit`,
          detail: `Continue with ${state.agents[profileID]?.name ?? "agent"} → ${target.name}?`,
          channelID: channel.id,
          agentID: profileID,
          handoffID: handoff.id,
          workID: work?.id,
        })
        return `Task chain paused at its limit: ${approval.id}`
      }
      chain.deliveries++
      chain.updatedAt = now()
      state.handoffs[handoff.id] = handoff
      const workItem = this.enqueueWork(state, {
        kind: "channel",
        agentID: target.id,
        channelID: channel.id,
        directory: channel.projectDirectory,
        prompt: handoff.request,
        mode: input.mode === "edit" ? "edit" : "research",
        chainID: chain.id,
        handoffID: handoff.id,
      })
      handoff.workID = workItem.id
      state.handoffs[handoff.id] = handoff
      channel.messages.push({
        id: newId("msg"),
        channelID: channel.id,
        sender: { type: "agent", agentID: profileID, nameSnapshot: state.agents[profileID]?.name ?? "Agent" },
        text: `→ ${target.name}: ${handoff.request}`,
        mentions: [target.id],
        createdAt: now(),
        handoffID: handoff.id,
      })
      channel.updatedAt = now()
      return `Handoff queued to ${target.name} (${handoff.id}).`
    })
  }

  private async toolRemember(profileID: string, input: Json, context: any): Promise<string> {
    return this.store.mutate((state) => {
      const text = String(input.text ?? "").trim()
      if (!text) return "Memory text is empty."
      const scope = input.scope as MemoryScope
      if (scope === "global") {
        const work = this.workForSession(state, context.sessionID)
        const directory = work?.channelID ? state.channels[work.channelID]?.projectDirectory : state.conversations[work?.conversationID ?? ""]?.projectDirectory
        const entry = createMemoryEntry({
          id: newId("mem"),
          text,
          scope: "project",
          origin: "automatic",
          source: `agent:${profileID}`,
          agentID: profileID,
          projectDirectory: directory ?? this.ctx.location.directory,
        })
        state.memories[entry.id] = entry
        const approval = createApproval(state, {
          kind: "promote_memory",
          title: `Promote learned knowledge for ${state.agents[profileID]?.name ?? "agent"}`,
          detail: text,
          agentID: profileID,
          memoryID: entry.id,
        })
        return `Cross-project memory needs approval: ${approval.id}`
      }
      if (scope === "channel") {
        const channelID = input.channelID
        const channel = state.channels[channelID]
        if (!channel || !channel.memberIDs.includes(profileID)) return "You are not a member of that channel."
        const entry = createMemoryEntry({
          id: newId("mem"),
          text,
          scope: "channel",
          origin: "automatic",
          source: `agent:${profileID}`,
          channelID,
        })
        state.memories[entry.id] = entry
        return `Saved channel memory ${entry.id}.`
      }
      const work = this.workForSession(state, context.sessionID)
      const directory = work?.channelID ? state.channels[work.channelID]?.projectDirectory : state.conversations[work?.conversationID ?? ""]?.projectDirectory
      const entry = createMemoryEntry({
        id: newId("mem"),
        text,
        scope: "project",
        origin: "automatic",
        source: `agent:${profileID}`,
        agentID: profileID,
        projectDirectory: directory ?? this.ctx.location.directory,
      })
      state.memories[entry.id] = entry
      return `Saved project memory ${entry.id}.`
    })
  }

  private async resolveApproval(payload: Json): Promise<any> {
    const outcome = await this.store.mutate((state) => {
      const approval = resolveApproval(state, payload.id, payload.approve ? "approved" : "rejected", payload.resolution)
      if (!approval) throw Object.assign(new Error("Approval not found or already resolved."), { code: "not_found" })
      if (approval.status === "approved") {
        if (approval.kind === "cross_project" && approval.payload) {
          const payload = approval.payload as any
          const entry = createMemoryEntry({
            id: newId("mem"),
            text: String(payload.text ?? ""),
            scope: "global",
            origin: "manual",
            source: `approved-share:${approval.agentID ?? "agent"}`,
            agentID: approval.agentID,
          })
          state.memories[entry.id] = entry
        }
        if (approval.kind === "promote_memory" && approval.memoryID) {
          const entry = state.memories[approval.memoryID]
          if (entry) {
            entry.scope = "global"
            entry.projectDirectory = undefined
            entry.updatedAt = now()
            entry.history.push({ at: now(), action: "promoted", by: "user" })
          }
        }
        if (approval.kind === "outside_roster" && approval.handoffID) {
          const handoff = state.handoffs[approval.handoffID]
          if (handoff) {
            const channel = state.channels[handoff.channelID]
            if (channel) {
              handoff.status = "queued"
              const work = this.enqueueWork(state, {
                kind: "channel",
                agentID: handoff.toAgentID,
                channelID: handoff.channelID,
                directory: channel.projectDirectory,
                prompt: handoff.request,
                mode: "research",
                chainID: handoff.chainID,
                handoffID: handoff.id,
              })
              handoff.workID = work.id
            }
          }
        }
        if (approval.kind === "chain_limit" && approval.handoffID) {
          const handoff = state.handoffs[approval.handoffID]
          if (handoff) {
            const chain = state.chains[handoff.chainID]
            if (chain) {
              chain.limit += state.settings.chainLimit
              chain.updatedAt = now()
              chain.deliveries++
              const channel = state.channels[handoff.channelID]
              if (channel) {
                handoff.status = "queued"
                const work = this.enqueueWork(state, {
                  kind: "channel",
                  agentID: handoff.toAgentID,
                  channelID: handoff.channelID,
                  directory: channel.projectDirectory,
                  prompt: handoff.request,
                  mode: "research",
                  chainID: chain.id,
                  handoffID: handoff.id,
                })
                handoff.workID = work.id
              }
            }
          }
        }
        if (approval.kind === "resume_interrupted" && approval.workID) {
          const work = state.work[approval.workID]
          if (work && work.status === "interrupted") work.status = "queued"
        }
        if (approval.kind === "roster_change" && approval.payload) {
          const parsed = approval.payload as any
          if (parsed.kind === "create_agent" || parsed.kind === "update_agent" || parsed.kind === "add_member" || parsed.kind === "set_leader") {
            if (parsed.baseVersion !== undefined && parsed.agentID && state.agents[parsed.agentID]?.version !== parsed.baseVersion) {
              approval.resolution = "stale proposal: the agent changed after this was requested"
              return approval
            }
            return { approval, apply: parsed }
          }
        }
      } else if (approval.kind === "outside_roster" && approval.handoffID) {
        const handoff = state.handoffs[approval.handoffID]
        if (handoff) handoff.status = "cancelled"
      } else if (approval.kind === "chain_limit" && approval.handoffID) {
        const handoff = state.handoffs[approval.handoffID]
        if (handoff) handoff.status = "cancelled"
      }
      return approval
    })
    if (outcome?.apply) {
      const parsed = outcome.apply
      await this.store.mutate((state) => {
        if (parsed.kind === "add_member") {
          const channel = state.channels[parsed.channelID]
          if (channel && !channel.memberIDs.includes(parsed.agentID)) channel.memberIDs.push(parsed.agentID)
        }
        if (parsed.kind === "set_leader") {
          const channel = state.channels[parsed.channelID]
          if (channel && channel.memberIDs.includes(parsed.agentID)) channel.leaderID = parsed.agentID
        }
        if (parsed.kind === "create_agent" && parsed.agent) {
          state.agents[parsed.agent.id] = { ...parsed.agent, id: newId("agent"), version: 1, createdAt: now(), updatedAt: now(), archived: false, pendingSettings: false }
        }
        if (parsed.kind === "update_agent" && parsed.agentID) {
          const agent = state.agents[parsed.agentID]
          if (agent) {
            const patch = parsed.patch ?? {}
            if (patch.name !== undefined) agent.name = String(patch.name)
            if (patch.instructions !== undefined) agent.instructions = String(patch.instructions)
            if (patch.mainModel !== undefined) agent.mainModel = patch.mainModel
            if (patch.skillbox !== undefined) agent.skillbox = [...new Set(patch.skillbox.map(String))]
            agent.version++
            agent.pendingSettings = true
            agent.updatedAt = now()
          }
        }
      })
      return { approved: true, applied: parsed.kind }
    }
    return outcome
  }

  private async reorderQueue(payload: Json): Promise<any> {
    return this.store.mutate((state) => {
      const order = nextQueueOrder(state, payload.workID, payload.direction === "up" ? "up" : "down")
      order.forEach((id, index) => {
        const item = state.work[id]
        if (item) item.queueOrder = index
      })
      return { order }
    })
  }

  private async cancelWork(workID: string): Promise<any> {
    const sessionID = await this.store.mutate((state) => {
      const work = state.work[workID]
      if (!work) throw Object.assign(new Error("Work not found."), { code: "not_found" })
      if (work.status === "running") work.status = "cancelled"
      else if (work.status === "queued") work.status = "cancelled"
      else throw Object.assign(new Error("This work cannot be cancelled."), { code: "invalid_status" })
      return work.sessionID
    })
    if (sessionID) await this.ctx.session.interrupt({ sessionID, resume: false }).catch(() => undefined)
    return { cancelled: true }
  }

  private async steerWork(workID: string): Promise<any> {
    return this.store.mutate((state) => {
      const work = state.work[workID]
      if (!work || work.status !== "queued") throw Object.assign(new Error("Only queued work can be steered."), { code: "invalid_status" })
      work.queueOrder = -1
      return { queued: true }
    })
  }

  private async stopWork(payload: Json): Promise<any> {
    const sessions = await this.store.mutate((state) => {
      const affected: string[] = []
      for (const work of Object.values(state.work)) {
        if (work.status !== "running" && work.status !== "queued") continue
        if (payload.channelID && work.channelID !== payload.channelID) continue
        if (payload.agentID && work.agentID !== payload.agentID) continue
        if (work.status === "running" && work.sessionID) affected.push(work.sessionID)
        work.status = "paused"
      }
      if (payload.channelID && state.channels[payload.channelID]) state.channels[payload.channelID].paused = true
      return affected
    })
    for (const sessionID of sessions) await this.ctx.session.interrupt({ sessionID, resume: false }).catch(() => undefined)
    return { paused: true }
  }

  private async resumeWork(payload: Json): Promise<any> {
    return this.store.mutate((state) => {
      if (payload.channelID && state.channels[payload.channelID]) state.channels[payload.channelID].paused = false
      for (const work of Object.values(state.work)) {
        if (work.status !== "paused") continue
        if (payload.channelID && work.channelID !== payload.channelID) continue
        if (payload.agentID && work.agentID !== payload.agentID) continue
        work.status = "queued"
      }
      return { resumed: true }
    })
  }

  private async retryWork(workID: string): Promise<any> {
    return this.store.mutate((state) => {
      const work = state.work[workID]
      if (!work || (work.status !== "failed" && work.status !== "interrupted" && !(work.status === "paused" && work.error))) {
        throw Object.assign(new Error("Only failed, interrupted, or paused work can be retried."), { code: "invalid_status" })
      }
      work.status = "queued"
      work.error = undefined
      return { queued: true }
    })
  }

  private async updateSettings(payload: Json): Promise<any> {
    return this.store.mutate((state) => {
      if (payload.maxConcurrentTurns !== undefined) state.settings.maxConcurrentTurns = Math.max(1, Number(payload.maxConcurrentTurns))
      if (payload.chainLimit !== undefined) state.settings.chainLimit = Math.max(1, Number(payload.chainLimit))
      if (payload.modelFallback !== undefined) state.settings.modelFallback = Boolean(payload.modelFallback)
      return state.settings
    })
  }

  private createChain(state: EnsembleState, channelID: string) {
    const chain = {
      id: newId("chain"),
      channelID,
      conversationID: channelID,
      deliveries: 0,
      limit: state.settings.chainLimit,
      status: "active" as const,
      createdAt: now(),
      updatedAt: now(),
    }
    state.chains[chain.id] = chain
    const channel = state.channels[channelID]
    if (channel) channel.chainIDs.push(chain.id)
    return chain
  }

  private getOrCreateConversation(state: EnsembleState, agent: AgentProfile, directory: string): Conversation {
    const existing = Object.values(state.conversations)
      .filter((conversation) => conversation.kind === "direct" && conversation.agentID === agent.id && conversation.projectDirectory === directory)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    return existing ?? this.createConversation(state, `direct:${agent.id}:${directory}:${newId("conv")}`, "direct", agent, directory)
  }

  private createConversation(state: EnsembleState, id: string, kind: "direct" | "channel", agent: AgentProfile, directory: string): Conversation {
    const conversation: Conversation = {
      id,
      kind,
      agentID: agent.id,
      projectDirectory: directory,
      agentVersion: agent.version,
      sessionIDs: [],
      messages: [],
      createdAt: now(),
      updatedAt: now(),
    }
    state.conversations[id] = conversation
    return conversation
  }

  private conversationForChannel(state: EnsembleState, channel: Channel, agent: AgentProfile): Conversation {
    const key = `channel:${channel.id}:${agent.id}`
    return state.conversations[key] ?? this.createConversation(state, key, "channel", agent, channel.projectDirectory)
  }

  private enqueueWork(
    state: EnsembleState,
    input: {
      kind: "direct" | "channel"
      agentID: string
      channelID?: string
      conversationID?: string
      directory: string
      prompt: string
      mode: "research" | "edit"
      chainID?: string
      handoffID?: string
    },
  ): WorkItem {
    const agent = state.agents[input.agentID]
    if (!agent) throw Object.assign(new Error("Agent not found."), { code: "not_found" })
    const conversation = input.conversationID
      ? state.conversations[input.conversationID]
      : input.channelID && state.channels[input.channelID]
        ? this.conversationForChannel(state, state.channels[input.channelID], agent)
        : this.getOrCreateConversation(state, agent, input.directory)
    const order = Math.max(0, ...Object.values(state.work).map((work) => work.queueOrder + 1))
    const work: WorkItem = {
      id: newId("work"),
      kind: input.kind,
      agentID: agent.id,
      channelID: input.channelID,
      conversationID: conversation.id,
      prompt: input.prompt,
      mode: input.mode,
      status: "queued",
      queueOrder: order,
      chainID: input.chainID,
      handoffID: input.handoffID,
      checkoutKey: resolveCheckoutKey(input.directory),
      createdAt: now(),
    }
    state.work[work.id] = work
    return work
  }

  private workForSession(state: EnsembleState, sessionID: string): WorkItem | undefined {
    return Object.values(state.work).find((work) => work.sessionID === sessionID)
  }

  private profileForSession(sessionID: string): string | undefined {
    const state = this.store.snapshot()
    const work = this.workForSession(state, sessionID)
    if (work) return work.agentID
    const conversation = Object.values(state.conversations).find((item) => item.activeSessionID === sessionID)
    return conversation?.agentID
  }

  private async recover(): Promise<void> {
    await this.store.mutate((state) => {
      for (const work of Object.values(state.work)) {
        if (work.status === "running") {
          work.status = "interrupted"
          work.error = "Ensemble restarted while this work was running."
          createApproval(state, {
            kind: "resume_interrupted",
            title: `Resume interrupted work for ${state.agents[work.agentID]?.name ?? "agent"}`,
            detail: "The server stopped while this work was running. Resume it explicitly, or retry it.",
            channelID: work.channelID,
            agentID: work.agentID,
            workID: work.id,
          })
        }
      }
    })
  }

  private pump(): void {
    if (this.stopped || this.pumping) return
    this.pumping = true
    void (async () => {
      try {
        const state = this.store.snapshot()
        for (const item of selectRunnable(state)) {
          await this.store.mutate((draft) => {
            const work = draft.work[item.id]
            if (work && work.status === "queued") {
              work.status = "running"
              work.startedAt = now()
            }
          })
          const promise = this.runWork(item.id).finally(() => {
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

  private async runWork(workID: string): Promise<void> {
    const state = this.store.snapshot()
    const work = state.work[workID]
    if (!work) return
    const agent = state.agents[work.agentID]
    const conversation = state.conversations[work.conversationID]
    if (!agent || !conversation) {
      await this.finishWork(workID, "failed", "Agent or conversation is missing.")
      return
    }
    try {
      const sessionID = await this.ensureSession(agent, conversation, work)
      if (!sessionID) throw new Error("Could not create a native session.")
      await this.ctx.session.instructions.entry.put({
        sessionID,
        key: "ensemble.context",
        value: this.contextForWork(state, work, agent, conversation),
      }).catch(() => undefined)
      const models: ModelSelection[] = [agent.mainModel, ...agent.backupModels]
      let result: { text: string; tools: string[]; failure?: any } | undefined
      for (let index = 0; index < models.length; index++) {
        const model = models[index]
        await this.ctx.session.switchModel({ sessionID, model: sessionModelRef(model) }).catch(() => undefined)
        const startedAt = now()
        await this.ctx.session.prompt({ sessionID, text: work.prompt, delivery: "steer" })
        await this.ctx.session.wait({ sessionID }).catch(() => undefined)
        const messages = listData(await this.ctx.session.context({ sessionID }))
        const outcome = assistantResult(messages, startedAt)
        result = outcome
        if (!outcome.failure) break
        if (!state.settings.modelFallback || !availabilityFailure(outcome.failure) || anyToolCall(messages, startedAt)) break
        if (index < models.length - 1) {
          await this.store.mutate((draft) => {
            const conv = draft.conversations[conversation.id]
            if (conv) {
              conv.activeSessionID = undefined
              conv.agentVersion = agent.version
              conv.messages.push({
                id: newId("msg"),
                role: "system",
                text: `Model ${modelLabel(model)} failed with ${outcome.failure?.message ?? "an availability error"}; switching to ${modelLabel(models[index + 1])}.`,
                createdAt: now(),
              })
            }
          })
          conversation.activeSessionID = undefined
          const nextSession = await this.ensureSession(agent, conversation, work)
          if (!nextSession) break
          work.sessionID = nextSession
          await this.ctx.session.instructions.entry.put({
            sessionID: nextSession,
            key: "ensemble.context",
            value: this.contextForWork(this.store.snapshot(), work, agent, conversation),
          }).catch(() => undefined)
        }
      }
      const current = this.store.snapshot()
      if (current.work[workID]?.status === "cancelled" || current.work[workID]?.status === "paused") return
      if (result?.failure) {
        const uncertain = result.tools.length > 0 || anyToolCall(listData(await this.ctx.session.context({ sessionID: work.sessionID ?? "" }).catch(() => [])), work.startedAt ?? 0)
        await this.finishWork(
          workID,
          uncertain ? "paused" : "failed",
          uncertain
            ? "Model recovery stopped because a tool outcome is uncertain. Review the transcript before retrying."
            : result.failure.message ?? "The model request failed.",
        )
        return
      }
      const text = result?.text || "Work completed."
      await this.store.mutate((draft) => {
        const workDraft = draft.work[workID]
        const conv = draft.conversations[work.conversationID]
        if (!workDraft || !conv) return
        workDraft.status = "completed"
        workDraft.finishedAt = now()
        workDraft.resultText = text
        conv.messages.push({
          id: newId("msg"),
          role: "agent",
          text,
          createdAt: now(),
          workID,
          sessionID: workDraft.sessionID,
          agentNameSnapshot: agent.name,
          toolSummary: result?.tools,
        })
        conv.updatedAt = now()
        if (workDraft.channelID) {
          const channel = draft.channels[workDraft.channelID]
          if (channel) {
            channel.messages.push({
              id: newId("msg"),
              channelID: channel.id,
              sender: { type: "agent", agentID: agent.id, nameSnapshot: agent.name },
              text,
              mentions: [],
              createdAt: now(),
            })
            channel.updatedAt = now()
          }
        }
        if (workDraft.handoffID) {
          const handoff = draft.handoffs[workDraft.handoffID]
          if (handoff) {
            handoff.status = "completed"
            handoff.reply = text
            handoff.updatedAt = now()
            const requester = Object.values(draft.conversations).find(
              (item) => item.channelID === workDraft.channelID && item.agentID === handoff.fromAgentID,
            )
            requester?.messages.push({
              id: newId("msg"),
              role: "system",
              text: `Handoff ${handoff.id} reply from ${agent.name}: ${text}`,
              createdAt: now(),
              workID,
            })
          }
        }
      })
    } catch (error: any) {
      await this.finishWork(workID, "failed", error?.message ?? String(error))
    }
  }

  private async ensureSession(agent: AgentProfile, conversation: Conversation, work: WorkItem): Promise<string | undefined> {
    if (conversation.activeSessionID && conversation.agentVersion === agent.version) return conversation.activeSessionID
    const created = unwrap<any>(
      await this.ctx.session.create({
        title: `${agent.name} · ${conversation.kind === "channel" ? conversation.channelID : "Direct"}`,
        agent: "build",
        model: sessionModelRef(agent.mainModel),
        permissions: skillPermissions(agent.skillbox),
        location: { directory: conversation.projectDirectory },
      }),
    )
    if (!created?.id) return undefined
    await this.store.mutate((draft) => {
      const conv = draft.conversations[conversation.id]
      if (!conv) return
      conv.sessionIDs.push(created.id)
      conv.activeSessionID = created.id
      conv.agentVersion = agent.version
      const profile = draft.agents[agent.id]
      if (profile) profile.pendingSettings = false
      const workDraft = draft.work[work.id]
      if (workDraft) workDraft.sessionID = created.id
    })
    conversation.activeSessionID = created.id
    conversation.agentVersion = agent.version
    return created.id
  }

  private contextForWork(state: EnsembleState, work: WorkItem, agent: AgentProfile, conversation: Conversation): string {
    const memories = visibleMemories(state, {
      agentID: agent.id,
      channelID: work.channelID,
      projectDirectory: conversation.projectDirectory,
    })
    const parts = [`<ensemble_persona name="${agent.name}">\n${agent.instructions}\n</ensemble_persona>`, memoryContext(memories)]
    if (work.channelID) {
      const channel = state.channels[work.channelID]
      if (channel) {
        parts.push(
          [
            `<ensemble_channel name="${channel.name}" directory="${channel.projectDirectory}">`,
            `Leader: ${state.agents[channel.leaderID]?.name ?? channel.leaderID}`,
            `Members: ${channel.memberIDs.map((id) => state.agents[id]?.name ?? id).join(", ")}`,
            "Recent messages:",
            recentChannelContext(state, channel),
            "</ensemble_channel>",
          ].join("\n"),
        )
      }
    } else {
      parts.push("<ensemble_private>This is a private direct conversation. Do not share its contents with channels unless the user explicitly authorizes it.</ensemble_private>")
    }
    return parts.filter(Boolean).join("\n\n")
  }

  private async finishWork(workID: string, status: "failed" | "paused", error: string): Promise<void> {
    await this.store.mutate((draft) => {
      const work = draft.work[workID]
      if (!work) return
      if (work.status === "cancelled" || (work.status === "paused" && status === "failed")) return
      work.status = status
      work.error = error
      work.finishedAt = now()
      if (work.handoffID) {
        const handoff = draft.handoffs[work.handoffID]
        if (handoff) {
          handoff.status = "failed"
          handoff.reply = error
          handoff.updatedAt = now()
        }
      }
    })
  }
}

export default Plugin.define({
  id: "ensemble.server",
  async setup(ctx) {
    const server = new EnsembleServer(ctx)
    return server.start()
  },
})
