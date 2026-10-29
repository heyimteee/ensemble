import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import { usePlugin } from "@opencode/plugin/tui"
import type { AgentProfile, Approval, Channel, EnsembleState, MemoryEntry, ModelOption, SkillOption, Snapshot, WorkItem } from "../core/types.ts"

type Section = "agents" | "channels" | "approvals" | "work"
type SettingsTab = "general" | "models" | "memories" | "skillbox"

const color = {
  accent: "#8be9fd",
  muted: "#8a8f98",
  good: "#50fa7b",
  warn: "#f1fa8c",
  bad: "#ff5555",
  text: "#f8f8f2",
}

function currentDirectory(context: any): string {
  return context.location?.directory ?? context.data.location.default().directory
}

async function callRpc(context: any, method: string, input: any): Promise<any> {
  const response = await context.client.rpc.call({
    rpcID: "ensemble",
    method,
    location: { directory: currentDirectory(context) },
    input,
  })
  return response?.output ?? response
}

async function invoke(context: any, action: string, payload: any = {}): Promise<any> {
  const directory = currentDirectory(context)
  const response = await callRpc(context, "invoke", { directory, action, payload })
  if (!response?.ok) throw new Error(response?.error?.message ?? "Ensemble request failed.")
  return response.result
}

function projectName(directory: string): string {
  return directory.split("/").filter(Boolean).pop() ?? directory
}

function short(text: string, width = 48): string {
  const single = text.replaceAll("\n", " ")
  return single.length > width ? `${single.slice(0, width - 1)}…` : single
}

export function EnsembleApp() {
  const context = usePlugin()
  const [snapshot, setSnapshot] = createSignal<Snapshot | null>(null)
  const [section, setSection] = createSignal<Section>("agents")
  const [selected, setSelected] = createSignal(0)
  const [selectedAgentID, setSelectedAgentID] = createSignal<string | null>(null)
  const [selectedChannelID, setSelectedChannelID] = createSignal<string | null>(null)
  const [settingsAgentID, setSettingsAgentID] = createSignal<string | null>(null)
  const [settingsTab, setSettingsTab] = createSignal<SettingsTab>("general")
  const [fieldIndex, setFieldIndex] = createSignal(0)
  const [memoryIndex, setMemoryIndex] = createSignal(0)
  const [skillIndex, setSkillIndex] = createSignal(0)
  const [skillFilter, setSkillFilter] = createSignal("")
  const [draft, setDraft] = createSignal<AgentProfile | null>(null)
  const [dirty, setDirty] = createSignal(false)
  const [status, setStatus] = createSignal("Loading Ensemble…")
  const [busy, setBusy] = createSignal(false)
  const [modal, setModal] = createSignal(false)

  const state = createMemo<EnsembleState | null>(() => snapshot()?.state ?? null)
  const models = createMemo<ModelOption[]>(() => snapshot()?.models ?? [])
  const skills = createMemo<SkillOption[]>(() => snapshot()?.skills ?? [])
  const filteredSkills = createMemo(() => {
    const query = skillFilter().toLowerCase()
    return skills().filter((skill) => !query || skill.id.toLowerCase().includes(query) || skill.name.toLowerCase().includes(query))
  })
  const agents = createMemo(() => Object.values(state()?.agents ?? {}).filter((agent) => !agent.archived))
  const channels = createMemo(() => Object.values(state()?.channels ?? {}).filter((channel) => !channel.archived))
  const approvals = createMemo(() => Object.values(state()?.approvals ?? {}).filter((approval) => approval.status === "pending"))
  const selectedAgent = createMemo(() => {
    const id = selectedAgentID()
    return id ? state()?.agents[id] : undefined
  })
  const selectedChannel = createMemo(() => {
    const id = selectedChannelID()
    return id ? state()?.channels[id] : undefined
  })
  const settingsAgent = createMemo(() => {
    const id = settingsAgentID()
    return id ? state()?.agents[id] : undefined
  })
  const activeWork = createMemo(() => Object.values(state()?.work ?? {}).filter((work) => work.status === "running" || work.status === "queued" || work.status === "waiting_approval"))
  const workItems = createMemo(() => Object.values(state()?.work ?? {}).sort((a, b) => a.queueOrder - b.queueOrder || a.createdAt - b.createdAt).filter((work) => work.status !== "completed" && work.status !== "cancelled"))
  const agentMemories = createMemo(() => {
    const agent = settingsAgent()
    if (!agent) return []
    return Object.values(state()?.memories ?? {}).filter((memory) => !memory.deletedAt && memory.agentID === agent.id)
  })
  const channelMemories = createMemo(() => {
    const channel = selectedChannel()
    if (!channel) return []
    return Object.values(state()?.memories ?? {}).filter((memory) => !memory.deletedAt && memory.channelID === channel.id)
  })

  const list = createMemo(() => {
    if (section() === "agents") return agents().map((agent) => agent.id)
    if (section() === "channels") return channels().map((channel) => channel.id)
    if (section() === "work") return workItems().map((work) => work.id)
    return approvals().map((approval) => approval.id)
  })

  const sectionTitle = createMemo(() => {
    if (section() === "agents") return "Agents"
    if (section() === "channels") return "Channels"
    if (section() === "work") return "Work"
    return "Approvals"
  })

  const missingSkills = createMemo(() => {
    const agent = draft()
    if (!agent) return []
    return agent.skillbox.filter((id) => !skills().some((skill) => skill.id === id))
  })

  const selectedModel = createMemo(() => {
    const agent = draft()
    if (!agent) return undefined
    return models().find((model) => model.providerID === agent.mainModel.providerID && model.modelID === agent.mainModel.modelID)
  })

  const refresh = async () => {
    try {
      const next = await callRpc(context, "snapshot", { directory: currentDirectory(context) })
      setSnapshot(next)
      setStatus(`Ready · ${Object.keys(next.state.agents).length} agents · ${Object.keys(next.state.channels).length} channels`)
    } catch (error: any) {
      setStatus(`Ensemble unavailable: ${error?.message ?? error}`)
    }
  }

  const showError = (error: any) => {
    context.ui.toast.show({ title: "Ensemble", message: error?.message ?? String(error), variant: "error" })
  }

  const uiDialog = {
    prompt: async (options: any) => {
      setModal(true)
      try { return await context.ui.dialog.prompt(options) } finally { setModal(false) }
    },
    confirm: async (options: any) => {
      setModal(true)
      try { return await context.ui.dialog.confirm(options) } finally { setModal(false) }
    },
    select: async (options: any) => {
      setModal(true)
      try { return await context.ui.dialog.select(options) } finally { setModal(false) }
    },
  }

  const run = async (label: string, action: () => Promise<void>) => {
    if (busy()) return
    setBusy(true)
    try {
      await action()
      await refresh()
    } catch (error: any) {
      setStatus(`${label}: ${error?.message ?? error}`)
      context.ui.toast.show({ title: "Ensemble", message: error?.message ?? String(error), variant: "error" })
    } finally {
      setBusy(false)
    }
  }

  const selectSection = (next: Section) => {
    setSection(next)
    setSelected(0)
    setSelectedAgentID(null)
    setSelectedChannelID(null)
    setSettingsAgentID(null)
  }

  const openSettings = (agent?: AgentProfile) => {
    const target = agent ?? selectedAgent()
    if (!target) return
    setSettingsAgentID(target.id)
    setSettingsTab("general")
    setFieldIndex(0)
    setMemoryIndex(0)
    setSkillIndex(0)
    setDraft(structuredClone(target))
    setDirty(false)
  }

  const closeSettings = async () => {
    if (dirty()) {
      const discard = await uiDialog.confirm({
        title: "Discard changes?",
        message: "This agent has unsaved settings changes.",
        label: { confirm: "Discard", cancel: "Keep editing" },
      })
      if (!discard) return
    }
    setSettingsAgentID(null)
    setDraft(null)
    setDirty(false)
  }

  const saveSettings = async () => {
    const agent = draft()
    if (!agent) return
    if (!agent.name.trim()) {
      context.ui.toast.show({ title: "Invalid name", message: "Agent name cannot be empty.", variant: "error" })
      return
    }
    const model = models().find((item) => item.providerID === agent.mainModel.providerID && item.modelID === agent.mainModel.modelID)
    if (!model) {
      context.ui.toast.show({ title: "Invalid model", message: "Choose an available model.", variant: "error" })
      return
    }
    if (agent.mainModel.variant && !model.variants.includes(agent.mainModel.variant)) {
      context.ui.toast.show({ title: "Invalid reasoning", message: "That reasoning variant is not supported.", variant: "error" })
      return
    }
    await run("Save settings", async () => {
      await invoke(context, "agent.update", {
        id: agent.id,
        name: agent.name,
        instructions: agent.instructions,
        mainModel: agent.mainModel,
        backupModels: agent.backupModels,
        skillbox: agent.skillbox,
      })
      setDirty(false)
      setSettingsAgentID(null)
      setDraft(null)
      context.ui.toast.show({ title: "Ensemble", message: "Agent settings saved for subsequent work.", variant: "success" })
    })
  }

  const promptAgentName = async () => {
    const name = await uiDialog.prompt({ title: "New agent", description: "A name for this teammate", placeholder: "Nova" })
    return name?.trim()
  }

  const chooseModel = async (current?: ModelOption, title = "Choose a model") => {
    if (models().length === 0) throw new Error("No models are available in this project.")
    const value = await uiDialog.select({
      title,
      current: current ? `${current.providerID}/${current.modelID}` : undefined,
      options: models().map((model) => ({ title: `${model.name} · ${model.providerID}/${model.modelID}`, value: `${model.providerID}/${model.modelID}` })),
    })
    if (!value) return undefined
    return models().find((model) => `${model.providerID}/${model.modelID}` === value)
  }

  const chooseVariant = async (model: ModelOption, current?: string) => {
    if (model.variants.length === 0) return undefined
    const value = await uiDialog.select({
      title: "Reasoning effort",
      current,
      options: model.variants.map((variant) => ({ title: variant, value: variant })),
    })
    return value
  }

  const selectedWork = () => workItems()[selected()]

  const cancelSelectedWork = async () => {
    const work = selectedWork()
    if (!work) return
    await run("Cancel work", async () => { await invoke(context, "queue.cancel", { workID: work.id }) })
  }

  const steerSelectedWork = async () => {
    const work = selectedWork()
    if (!work) return
    await run("Steer work", async () => { await invoke(context, "queue.steer", { workID: work.id }) })
  }

  const retrySelectedWork = async () => {
    const work = selectedWork()
    if (!work) return
    await run("Retry work", async () => { await invoke(context, "work.retry", { workID: work.id }) })
  }

  const updateTeamSettings = async () => {
    const stateValue = state()
    if (!stateValue) return
    const turns = await uiDialog.prompt({ title: "Team-wide active turns", description: "Default 3", value: String(stateValue.settings.maxConcurrentTurns) })
    if (turns === undefined) return
    const limit = await uiDialog.prompt({ title: "Agent-to-agent chain limit", description: "Default 10 deliveries", value: String(stateValue.settings.chainLimit) })
    if (limit === undefined) return
    await run("Update team settings", async () => {
      await invoke(context, "settings.update", { maxConcurrentTurns: Number(turns), chainLimit: Number(limit) })
    })
  }

  const reorderSelectedWork = async (direction: "up" | "down") => {
    const work = selectedWork()
    if (!work) return
    await run("Reorder work", async () => { await invoke(context, "queue.reorder", { workID: work.id, direction }) })
  }

  const createAgent = async () => {
    const name = await promptAgentName()
    if (!name) return
    const nativeAgents = context.data.location.agent.list(context.location) ?? []
    const source = await uiDialog.select({
      title: "Start from",
      options: [
        { title: "Blank profile", value: "" },
        ...nativeAgents.map((item: any) => ({ title: `Copy ${item.name}`, value: item.id, description: "Independent profile" })),
      ],
    })
    if (source === undefined) return
    if (source) {
      await run("Create agent", async () => {
        const created = await invoke(context, "agent.create", {
          name,
          fromAgentID: source,
          backupModels: [],
          skillbox: [],
        })
        setSelectedAgentID(created.id)
      })
      return
    }
    const instructions = (await uiDialog.prompt({ title: "Instructions", description: "The agent's role and working style", placeholder: "You are a focused coding teammate." })) ?? ""
    const model = await chooseModel(undefined, "Main model")
    if (!model) return
    const variant = await chooseVariant(model)
    await run("Create agent", async () => {
      const created = await invoke(context, "agent.create", {
        name,
        instructions,
        mainModel: { providerID: model.providerID, modelID: model.modelID, variant },
        backupModels: [],
        skillbox: [],
      })
      setSelectedAgentID(created.id)
    })
  }

  const createChannel = async () => {
    const name = (await uiDialog.prompt({ title: "New channel", description: "A project room", placeholder: "website" }))?.trim()
    if (!name) return
    if (agents().length === 0) throw new Error("Create an agent first.")
    const agentNames = agents().map((agent) => agent.name).join(", ")
    const raw = await uiDialog.prompt({ title: "Members", description: `Comma-separated names. Available: ${agentNames}`, placeholder: agents().map((agent) => agent.name).slice(0, 2).join(", ") })
    if (!raw) return
    const members = raw.split(",").map((part) => part.trim()).filter(Boolean)
      .map((part) => agents().find((agent) => agent.name.toLowerCase() === part.toLowerCase() || agent.id === part)?.id)
      .filter((id): id is string => Boolean(id))
    if (members.length === 0) throw new Error("No matching members.")
    const leaderName = await uiDialog.select({
      title: "Channel leader",
      options: members.map((id) => ({ title: agents().find((agent) => agent.id === id)?.name ?? id, value: id })),
    })
    if (!leaderName) return
    await run("Create channel", async () => {
      const created = await invoke(context, "channel.create", { name, directory: currentDirectory(context), memberIDs: members, leaderID: leaderName })
      setSelectedChannelID(created.id)
      setSection("channels")
    })
  }

  const editSettingsField = async () => {
    const agent = draft()
    if (!agent) return
    if (settingsTab() === "general") {
      if (fieldIndex() === 0) {
        const name = await uiDialog.prompt({ title: "Agent name", value: agent.name })
        if (name?.trim()) { setDraft({ ...agent, name: name.trim() }); setDirty(true) }
      } else {
        const instructions = await uiDialog.prompt({ title: "Instructions", value: agent.instructions })
        if (instructions !== undefined) { setDraft({ ...agent, instructions }); setDirty(true) }
      }
    }
    if (settingsTab() === "models") {
      if (fieldIndex() === 0) {
        const model = await chooseModel(selectedModel(), "Main model")
        if (model) {
          const variant = await chooseVariant(model, agent.mainModel.variant)
          setDraft({ ...agent, mainModel: { providerID: model.providerID, modelID: model.modelID, variant } })
          setDirty(true)
        }
      } else {
        const model = await chooseModel(undefined, "Backup model")
        if (model) {
          const variant = await chooseVariant(model)
          setDraft({ ...agent, backupModels: [...agent.backupModels, { providerID: model.providerID, modelID: model.modelID, variant }] })
          setDirty(true)
        }
      }
    }
    if (settingsTab() === "memories" && fieldIndex() === 0) {
      const text = await uiDialog.prompt({ title: "Add memory", description: "Saved for this agent in this project", placeholder: "The team uses pnpm." })
      if (text?.trim()) {
        await run("Add memory", async () => {
          await invoke(context, "memory.add", { agentID: agent.id, directory: currentDirectory(context), text: text.trim(), scope: "project" })
        })
      }
    }
    if (settingsTab() === "skillbox") {
      toggleSkill()
    }
  }

  const toggleSkill = () => {
    const agent = draft()
    if (!agent) return
    const skill = filteredSkills()[skillIndex()]
    if (!skill) return
    const has = agent.skillbox.includes(skill.id)
    setDraft({ ...agent, skillbox: has ? agent.skillbox.filter((id) => id !== skill.id) : [...agent.skillbox, skill.id] })
    setDirty(true)
  }

  const removeBackup = () => {
    const agent = draft()
    if (!agent || agent.backupModels.length === 0) return
    setDraft({ ...agent, backupModels: agent.backupModels.slice(0, -1) })
    setDirty(true)
  }

  const editMemory = async () => {
    const agent = draft()
    const memory = agentMemories()[memoryIndex()]
    if (!agent || !memory) return
    const text = await uiDialog.prompt({ title: "Edit memory", value: memory.text })
    if (text?.trim()) await run("Edit memory", async () => { await invoke(context, "memory.update", { id: memory.id, text: text.trim() }) })
  }

  const deleteMemory = async () => {
    const memory = agentMemories()[memoryIndex()]
    if (!memory) return
    const confirmed = await uiDialog.confirm({ title: "Delete memory?", message: "It is excluded from future retrieval. Existing transcripts are not erased." })
    if (confirmed) await run("Delete memory", async () => { await invoke(context, "memory.delete", { id: memory.id }) })
  }

  const promoteMemory = async () => {
    const memory = agentMemories()[memoryIndex()]
    if (!memory) return
    await run("Promote memory", async () => { await invoke(context, "memory.promote", { id: memory.id }) })
  }

  const sendMessage = async () => {
    if (section() === "channels") {
      const channel = selectedChannel()
      if (!channel) return
      const memberOptions = channel.memberIDs.map((id) => ({ title: state()?.agents[id]?.name ?? id, value: id }))
      const mention = await uiDialog.select({
        title: "Mention (optional)",
        options: [{ title: "No mention · leader answers", value: "" }, ...memberOptions],
      })
      if (mention === undefined) return
      const text = await uiDialog.prompt({ title: `Message #${channel.name}`, description: "Type additional !mentions if you need more than one recipient." })
      if (!text?.trim()) return
      const edit = await uiDialog.confirm({ title: "Editing work?", message: "Mark this as editing work so Ensemble serializes writes to this checkout.", label: { confirm: "Edit", cancel: "Research" } })
      const agentName = mention ? state()?.agents[mention]?.name : undefined
      const composed = agentName ? `!${agentName} ${text.trim()}` : text.trim()
      await run("Send message", async () => { await invoke(context, "channel.send", { channelID: channel.id, text: composed, mode: edit ? "edit" : "research" }) })
      return
    }
    const agent = selectedAgent()
    if (!agent) return
    const text = await uiDialog.prompt({ title: `Message ${agent.name}`, description: "Private direct conversation" })
    if (!text?.trim()) return
    await run("Send message", async () => { await invoke(context, "direct.send", { agentID: agent.id, directory: currentDirectory(context), text: text.trim() }) })
  }

  const openNativeSession = () => {
    if (section() === "channels") {
      const channel = selectedChannel()
      if (!channel) return
      const conversation = Object.values(state()?.conversations ?? {}).find((item) => item.channelID === channel.id && item.activeSessionID)
      if (conversation?.activeSessionID) context.ui.router.navigate({ type: "session", sessionID: conversation.activeSessionID })
      else context.ui.toast.show({ title: "Ensemble", message: "No native session yet. Send a message first.", variant: "warning" })
      return
    }
    const conversation = Object.values(state()?.conversations ?? {}).find((item) => item.agentID === selectedAgent()?.id && item.activeSessionID)
    if (conversation?.activeSessionID) context.ui.router.navigate({ type: "session", sessionID: conversation.activeSessionID })
    else context.ui.toast.show({ title: "Ensemble", message: "No native session yet. Send a message first.", variant: "warning" })
  }

  const freshConversation = async () => {
    const agent = selectedAgent()
    if (!agent) return
    await run("Fresh conversation", async () => {
      await invoke(context, "direct.fresh", { agentID: agent.id, directory: currentDirectory(context) })
      context.ui.toast.show({ title: "Ensemble", message: "Started a fresh conversation. Older transcripts are preserved.", variant: "success" })
    })
  }

  const addChannelMemory = async () => {
    const channel = selectedChannel()
    if (!channel) return
    const text = await uiDialog.prompt({ title: `Shared memory for #${channel.name}`, description: "Visible to every channel member and recorded with manual provenance." })
    if (!text?.trim()) return
    await run("Add channel memory", async () => { await invoke(context, "memory.add", { channelID: channel.id, text: text.trim(), scope: "channel", source: "user" }) })
  }

  const setLeader = async () => {
    const channel = selectedChannel()
    if (!channel) return
    const value = await uiDialog.select({
      title: "Channel leader",
      current: channel.leaderID,
      options: channel.memberIDs.map((id) => ({ title: state()?.agents[id]?.name ?? id, value: id })),
    })
    if (value) await run("Set leader", async () => { await invoke(context, "channel.update", { id: channel.id, leaderID: value }) })
  }

  const editMembers = async () => {
    const channel = selectedChannel()
    if (!channel) return
    const raw = await uiDialog.prompt({
      title: "Channel members",
      description: "Comma-separated names. The leader must remain a member.",
      value: channel.memberIDs.map((id) => state()?.agents[id]?.name ?? id).join(", "),
    })
    if (!raw) return
    const ids = raw.split(",").map((part) => part.trim()).filter(Boolean)
      .map((part) => agents().find((agent) => agent.name.toLowerCase() === part.toLowerCase() || agent.id === part)?.id)
      .filter((id): id is string => Boolean(id))
    await run("Update members", async () => { await invoke(context, "channel.update", { id: channel.id, memberIDs: ids }) })
  }

  const togglePause = async () => {
    const channel = selectedChannel()
    if (!channel) return
    await run(channel.paused ? "Resume channel" : "Pause channel", async () => {
      await invoke(context, channel.paused ? "work.resume" : "work.stop", { channelID: channel.id })
    })
  }

  const resolveApproval = async (approval: Approval) => {
    const value = await uiDialog.select({
      title: approval.title,
      options: [
        { title: "Approve", value: "approve" },
        { title: "Reject", value: "reject" },
      ],
    })
    if (!value) return
    await run("Resolve approval", async () => {
      await invoke(context, "approval.resolve", { id: approval.id, approve: value === "approve" })
    })
  }

  const archiveSelected = async () => {
    if (section() === "agents") {
      const agent = selectedAgent()
      if (!agent) return
      const confirmed = await uiDialog.confirm({ title: `Archive ${agent.name}?`, message: "The agent stops receiving work. History is preserved.", label: { confirm: "Archive", cancel: "Cancel" } })
      if (!confirmed) return
      try {
        await invoke(context, "agent.archive", { id: agent.id })
        setSelectedAgentID(null)
        await refresh()
      } catch (error: any) {
        if (String(error?.message ?? error).includes("replacement leader")) {
          const replacement = await uiDialog.select({
            title: "Replacement leader",
            options: Object.values(state()?.channels ?? {})
              .filter((channel) => !channel.archived && channel.leaderID === agent.id)
              .flatMap((channel) => channel.memberIDs.filter((id) => id !== agent.id))
              .filter((id, index, all) => all.indexOf(id) === index)
              .map((id) => ({ title: state()?.agents[id]?.name ?? id, value: id })),
          })
          if (replacement) {
            await invoke(context, "agent.archive", { id: agent.id, replacementLeaderID: replacement })
            setSelectedAgentID(null)
            await refresh()
          }
        } else {
          showError(error)
        }
      }
    }
    if (section() === "channels") {
      const channel = selectedChannel()
      if (!channel) return
      const confirmed = await uiDialog.confirm({ title: `Archive #${channel.name}?`, message: "The channel stops receiving work. History is preserved.", label: { confirm: "Archive", cancel: "Cancel" } })
      if (confirmed) await run("Archive channel", async () => { await invoke(context, "channel.archive", { id: channel.id }); setSelectedChannelID(null) })
    }
  }

  const deleteSelected = async () => {
    if (section() === "agents") {
      const agent = selectedAgent()
      if (!agent) return
      const confirmed = await uiDialog.confirm({
        title: `Permanently delete ${agent.name}?`,
        message: "This removes the agent profile, memory, and conversations from Ensemble. Existing native transcripts are kept unless you choose otherwise below.",
        label: { confirm: "Continue", cancel: "Cancel" },
      })
      if (!confirmed) return
      const native = await uiDialog.confirm({ title: "Delete native sessions too?", message: "Native session deletion is separate from Ensemble data and removes inspectable transcripts.", label: { confirm: "Delete sessions", cancel: "Keep sessions" } })
      setBusy(true)
      try {
        await invoke(context, "agent.delete", { id: agent.id, deleteNativeSessions: native })
        setSelectedAgentID(null)
        await refresh()
      } catch (error: any) {
        if (error?.message?.includes("replacement leader") || String(error).includes("replacement")) {
          const replacement = await uiDialog.select({
            title: "Replacement leader",
            options: Object.values(state()?.channels ?? {})
              .filter((channel) => !channel.archived && channel.leaderID === agent.id)
              .flatMap((channel) => channel.memberIDs.filter((id) => id !== agent.id))
              .filter((id, index, all) => all.indexOf(id) === index)
              .map((id) => ({ title: state()?.agents[id]?.name ?? id, value: id })),
          })
          if (replacement) {
            try {
              await invoke(context, "agent.delete", { id: agent.id, replacementLeaderID: replacement, deleteNativeSessions: native })
              setSelectedAgentID(null)
              await refresh()
            } catch (second: any) {
              showError(second)
            }
          }
        } else {
          showError(error)
        }
      } finally {
        setBusy(false)
      }
      return
    }
    if (section() === "channels") {
      const channel = selectedChannel()
      if (!channel) return
      const confirmed = await uiDialog.confirm({ title: `Permanently delete #${channel.name}?`, message: "This removes the channel, messages, handoffs, and channel memory. Native sessions are kept unless you choose otherwise.", label: { confirm: "Continue", cancel: "Cancel" } })
      if (!confirmed) return
      const native = await uiDialog.confirm({ title: "Delete native sessions too?", message: "Native session deletion is separate from Ensemble data and removes inspectable transcripts.", label: { confirm: "Delete sessions", cancel: "Keep sessions" } })
      await run("Delete channel", async () => {
        await invoke(context, "channel.delete", { id: channel.id, deleteNativeSessions: native })
        setSelectedChannelID(null)
      })
    }
  }

  const move = (delta: number) => {
    if (settingsAgentID()) {
      if (settingsTab() === "skillbox") {
        setSkillIndex((index) => Math.max(0, Math.min(Math.max(0, filteredSkills().length - 1), index + delta)))
        return
      }
      if (settingsTab() === "memories") {
        setMemoryIndex((index) => Math.max(0, Math.min(agentMemories().length - 1, index + delta)))
        return
      }
      setFieldIndex((index) => Math.max(0, Math.min(settingsTab() === "models" ? agentBackupCount() : 1, index + delta)))
      return
    }
    const length = list().length
    if (length === 0) return
    setSelected((index) => Math.max(0, Math.min(length - 1, index + delta)))
  }

  const agentBackupCount = () => (draft()?.backupModels.length ?? 0) + 1

  const openSelected = async () => {
    if (section() === "agents") {
      const agent = agents()[selected()]
      if (agent) setSelectedAgentID(agent.id)
    }
    if (section() === "channels") {
      const channel = channels()[selected()]
      if (channel) setSelectedChannelID(channel.id)
    }
    if (section() === "approvals") {
      const approval = approvals()[selected()]
      if (approval) await resolveApproval(approval)
    }
  }

  onMount(() => {
    void refresh()
    const stop = context.data.listen(({ details }: any) => {
      if (typeof details?.type === "string" && details.type.startsWith("rpc.ensemble.")) void refresh()
    })
    context.keymap.layer(() => ({
      mode: "global",
      priority: 100,
      enabled: () => !modal(),
      commands: [
        { id: "ensemble.section.agents", title: "Ensemble: Agents", bind: "g", run: () => selectSection("agents") },
        { id: "ensemble.section.channels", title: "Ensemble: Channels", bind: "h", run: () => selectSection("channels") },
        { id: "ensemble.section.approvals", title: "Ensemble: Approvals", bind: "v", run: () => selectSection("approvals") },
        { id: "ensemble.section.work", title: "Ensemble: Work", bind: "w", run: () => selectSection("work") },
        { id: "ensemble.up", title: "Ensemble: Up", bind: "up", run: () => move(-1) },
        { id: "ensemble.down", title: "Ensemble: Down", bind: "down", run: () => move(1) },
        { id: "ensemble.open", title: "Ensemble: Open", bind: "enter", run: () => void openSelected() },
        { id: "ensemble.new", title: "Ensemble: New agent", bind: "n", run: () => void createAgent().catch(showError) },
        { id: "ensemble.channel", title: "Ensemble: New channel", bind: "c", run: () => void createChannel().catch(showError) },
        { id: "ensemble.settings", title: "Ensemble: Settings", bind: "s", run: () => openSettings() },
        { id: "ensemble.send", title: "Ensemble: Send", bind: "i", run: () => void sendMessage() },
        { id: "ensemble.native", title: "Ensemble: Open native session", bind: "o", run: () => openNativeSession() },
        { id: "ensemble.fresh", title: "Ensemble: Fresh conversation", bind: "f", run: () => void freshConversation() },
        { id: "ensemble.leader", title: "Ensemble: Set leader", bind: "l", run: () => void setLeader() },
        { id: "ensemble.members", title: "Ensemble: Edit members", bind: "m", run: () => void editMembers() },
        { id: "ensemble.pause", title: "Ensemble: Pause or resume", bind: "p", run: () => void togglePause() },
        { id: "ensemble.archive", title: "Ensemble: Archive", bind: "d", run: () => void archiveSelected() },
        { id: "ensemble.delete", title: "Ensemble: Permanently delete", bind: "delete", run: () => void deleteSelected() },
        { id: "ensemble.channel.memory", title: "Ensemble: Add channel memory", bind: "ctrl+m", run: () => void addChannelMemory() },
        { id: "ensemble.work.cancel", title: "Ensemble: Cancel work", bind: "x", run: () => void cancelSelectedWork() },
        { id: "ensemble.work.retry", title: "Ensemble: Retry work", bind: "r", run: () => void retrySelectedWork() },
        { id: "ensemble.team.settings", title: "Ensemble: Team settings", bind: "ctrl+,", run: () => void updateTeamSettings() },
        { id: "ensemble.work.steer", title: "Ensemble: Steer work", bind: "t", run: () => void steerSelectedWork() },
        { id: "ensemble.work.up", title: "Ensemble: Reorder work up", bind: "[", run: () => void reorderSelectedWork("up") },
        { id: "ensemble.work.down", title: "Ensemble: Reorder work down", bind: "]", run: () => void reorderSelectedWork("down") },
        { id: "ensemble.edit", title: "Ensemble: Edit field", bind: "e", run: () => void editSettingsField() },
        { id: "ensemble.space", title: "Ensemble: Toggle skill", bind: "space", run: () => toggleSkill() },
        { id: "ensemble.backup", title: "Ensemble: Remove backup model", bind: "b", run: () => removeBackup() },
        { id: "ensemble.memory.edit", title: "Ensemble: Edit memory", bind: "ctrl+e", run: () => void editMemory() },
        { id: "ensemble.memory.delete", title: "Ensemble: Delete memory", bind: "ctrl+d", run: () => void deleteMemory() },
        { id: "ensemble.memory.promote", title: "Ensemble: Promote memory", bind: "ctrl+p", run: () => void promoteMemory() },
        { id: "ensemble.filter", title: "Ensemble: Filter skills", bind: "ctrl+f", run: async () => {
          const query = await uiDialog.prompt({ title: "Filter skills", value: skillFilter(), placeholder: "tdd" })
          if (query !== undefined) { setSkillFilter(query); setSkillIndex(0) }
        } },
        { id: "ensemble.save", title: "Ensemble: Save settings", bind: "ctrl+s", run: () => void saveSettings() },
        { id: "ensemble.tab", title: "Ensemble: Settings tab", bind: "tab", run: () => {
          if (!settingsAgentID()) return
          const tabs: SettingsTab[] = ["general", "models", "memories", "skillbox"]
          const index = tabs.indexOf(settingsTab())
          setSettingsTab(tabs[(index + 1) % tabs.length])
          setFieldIndex(0)
        } },
        { id: "ensemble.escape", title: "Ensemble: Back", bind: "escape", run: () => {
          if (settingsAgentID()) { void closeSettings(); return }
          if (selectedAgentID()) { setSelectedAgentID(null); return }
          if (selectedChannelID()) { setSelectedChannelID(null); return }
          context.ui.router.navigate({ type: "home" })
        } },
      ],
      bindings: [
        "ensemble.section.agents", "ensemble.section.channels", "ensemble.section.approvals", "ensemble.section.work",
        "ensemble.up", "ensemble.down", "ensemble.open", "ensemble.new", "ensemble.channel",
        "ensemble.settings", "ensemble.send", "ensemble.native", "ensemble.fresh", "ensemble.leader",
        "ensemble.members", "ensemble.pause", "ensemble.archive", "ensemble.delete", "ensemble.channel.memory", "ensemble.work.cancel", "ensemble.work.retry", "ensemble.team.settings", "ensemble.work.steer", "ensemble.work.up", "ensemble.work.down", "ensemble.edit", "ensemble.space",
        "ensemble.backup", "ensemble.memory.edit", "ensemble.memory.delete", "ensemble.memory.promote",
        "ensemble.filter", "ensemble.save", "ensemble.tab", "ensemble.escape",
      ],
    }))
    return stop
  })

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box height={2} flexDirection="column">
        <text fg={color.accent}>ENSEMBLE · {currentDirectory(context)}</text>
        <text fg={busy() ? color.warn : color.muted}>{status()}</text>
      </box>
      <box flexDirection="row" flexGrow={1}>
        <box width={32} border borderStyle="single" borderColor={color.muted} flexDirection="column" padding={1}>
          <text fg={section() === "agents" ? color.accent : color.text}>Agents</text>
          <For each={agents()}>{(agent, index) => (
            <text fg={section() === "agents" && selected() === index() ? color.good : color.text}>
              {selectedAgentID() === agent.id ? "› " : "  "}{agent.name}
            </text>
          )}</For>
          <text> </text>
          <text fg={section() === "channels" ? color.accent : color.text}>Channels</text>
          <For each={channels()}>{(channel, index) => (
            <>
              <Show when={index() === 0 || channels()[index() - 1]?.projectDirectory !== channel.projectDirectory}>
                <text fg={color.muted}>  {projectName(channel.projectDirectory)}</text>
              </Show>
              <text fg={section() === "channels" && selected() === index() ? color.good : color.text}>
                {selectedChannelID() === channel.id ? "› " : "  "}#{channel.name} · {state()?.agents[channel.leaderID]?.name ?? "?"}
              </text>
            </>
          )}</For>
          <text> </text>
          <text fg={section() === "approvals" ? color.accent : color.text}>Approvals {approvals().length > 0 ? `(${approvals().length})` : ""}</text>
          <For each={approvals()}>{(approval, index) => (
            <text fg={section() === "approvals" && selected() === index() ? color.warn : color.text}>  {short(approval.title, 25)}</text>
          )}</For>
          <text> </text>
          <text fg={section() === "work" ? color.accent : color.text}>Work {workItems().length > 0 ? `(${workItems().length})` : ""}</text>
          <For each={workItems()}>{(work, index) => (
            <text fg={section() === "work" && selected() === index() ? color.good : color.text}>  {work.status} · {state()?.agents[work.agentID]?.name ?? "?"}</text>
          )}</For>
          <text> </text>
          <text fg={color.muted}>Active work: {activeWork().length}</text>
        </box>
        <box flexGrow={1} border borderStyle="single" borderColor={color.muted} flexDirection="column" padding={1}>
          <Show when={settingsAgentID()} fallback={
            <Show when={section() === "channels" && selectedChannel()} fallback={
              <Show when={section() === "agents" && selectedAgent()} fallback={
                <Show when={section() === "work"} fallback={
                  <Show when={section() === "approvals"} fallback={<HomeView />}>
                    <ApprovalView approvals={approvals()} selected={selected()} />
                  </Show>
                }>
                  <WorkView items={workItems()} selected={selected()} state={state()} />
                </Show>
              }>
                <DirectView agent={selectedAgent()!} state={state()} models={models()} />
              </Show>
            }>
              <ChannelView channel={selectedChannel()!} state={state()} memories={channelMemories()} />
            </Show>
          }>
            <SettingsView
              agent={draft()}
              tab={settingsTab()}
              fieldIndex={fieldIndex()}
              memoryIndex={memoryIndex()}
              skillIndex={skillIndex()}
              memories={agentMemories()}
              skills={filteredSkills()}
              missingSkills={missingSkills()}
              skillFilter={skillFilter()}
              modelsCount={models().length}
            />
          </Show>
        </box>
      </box>
      <box height={1}>
        <text fg={color.muted}>{settingsAgentID() ? "Tab switches settings tabs · ↑/↓ · e edit · ctrl+s save · esc back" : "g Agents · h Channels · v Approvals · w Work · ↑/↓ · enter · n new · s settings · i send · o native · d archive · Del delete"}</text>
      </box>
    </box>
  )

  function HomeView() {
    return (
      <box flexDirection="column">
        <text fg={color.accent}>Your persistent agent team</text>
        <text> </text>
        <text>Create a named teammate with n, then message it with i.</text>
        <text>Create a project channel with c. Messages without a mention go to its leader.</text>
        <text>Use !Agent to address one or more members explicitly.</text>
        <text> </text>
        <text fg={color.muted}>Ordinary OpenCode sessions remain available in their normal tabs.</text>
      </box>
    )
  }

  function DirectView(props: { agent: AgentProfile; state: EnsembleState | null; models: ModelOption[] }) {
    const conversation = createMemo(() => Object.values(props.state?.conversations ?? {}).filter((item) => item.agentID === props.agent.id).sort((a, b) => b.updatedAt - a.updatedAt)[0])
    const memoryCount = createMemo(() => Object.values(props.state?.memories ?? {}).filter((memory) => memory.agentID === props.agent.id && !memory.deletedAt).length)
    return (
      <box flexDirection="column">
        <text fg={color.accent}>{props.agent.name}</text>
        <text fg={color.muted}>{short(props.agent.instructions || "No instructions yet", 100)}</text>
        <text fg={color.muted}>Model: {props.agent.mainModel.providerID}/{props.agent.mainModel.modelID}{props.agent.mainModel.variant ? `#${props.agent.mainModel.variant}` : ""} · Memories: {memoryCount()} · Skills: {props.agent.skillbox.length}</text>
        <text> </text>
        <text fg={color.accent}>Direct conversation</text>
        <Show when={conversation()} fallback={<text fg={color.muted}>No messages yet. Press i to talk privately.</text>}>
          <For each={conversation()!.messages.slice(-12)}>{(message) => (
            <text fg={message.role === "user" ? color.good : message.role === "system" ? color.warn : color.text}>
              {message.role === "user" ? "You" : message.role === "system" ? "•" : message.agentNameSnapshot ?? props.agent.name}: {short(message.text, 100)}
            </text>
          )}</For>
        </Show>
        <text> </text>
        <text fg={color.muted}>i send · o open native session · f fresh conversation · s settings</text>
      </box>
    )
  }

  function ChannelView(props: { channel: Channel; state: EnsembleState | null; memories: MemoryEntry[] }) {
    const conversation = createMemo(() => Object.values(props.state?.conversations ?? {}).filter((item) => item.channelID === props.channel.id && item.activeSessionID)[0])
    const handoffs = createMemo(() => Object.values(props.state?.handoffs ?? {}).filter((item) => item.channelID === props.channel.id))
    return (
      <box flexDirection="column">
        <text fg={color.accent}>#{props.channel.name} {props.channel.paused ? "· PAUSED" : ""}</text>
        <text fg={color.muted}>Leader: {props.state?.agents[props.channel.leaderID]?.name ?? "?"} · Members: {props.channel.memberIDs.map((id) => props.state?.agents[id]?.name ?? id).join(", ")}</text>
        <text fg={color.muted}>Project: {props.channel.projectDirectory}</text>
        <text> </text>
        <For each={props.channel.messages.slice(-14)}>{(message) => (
          <text fg={message.sender.type === "user" ? color.good : color.text}>
            {message.sender.type === "user" ? "You" : message.sender.nameSnapshot}: {short(message.text, 100)}
          </text>
        )}</For>
        <text> </text>
        <text fg={color.accent}>Shared memory ({props.memories.length})</text>
        <For each={props.memories.slice(-4)}>{(memory) => <text fg={color.muted}>• {short(memory.text, 100)}</text>}</For>
        <text fg={color.accent}>Handoffs ({handoffs().length})</text>
        <For each={handoffs().slice(-4)}>{(handoff) => (
          <text fg={handoff.status === "completed" ? color.good : handoff.status === "waiting_approval" ? color.warn : color.muted}>
            {props.state?.agents[handoff.fromAgentID]?.name ?? "?"} → {props.state?.agents[handoff.toAgentID]?.name ?? "?"}: {short(handoff.request, 70)} [{handoff.status}]
          </text>
        )}</For>
        <text> </text>
        <text fg={color.muted}>i send · l leader · m members · p pause/resume · ctrl+m shared memory · o native session</text>
        <Show when={conversation()}><text fg={color.muted}>Native session: {conversation()!.activeSessionID}</text></Show>
      </box>
    )
  }

  function ApprovalView(props: { approvals: Approval[]; selected: number }) {
    const approval = createMemo(() => props.approvals[props.selected])
    return (
      <box flexDirection="column">
        <text fg={color.accent}>Approvals inbox</text>
        <Show when={approval()} fallback={<text fg={color.muted}>Nothing waits for you.</text>}>
          <text fg={color.warn}>{approval()!.title}</text>
          <text>{approval()!.detail}</text>
          <text fg={color.muted}>Kind: {approval()!.kind} · Channel: {approval()!.channelID ?? "direct"}</text>
          <text fg={color.muted}>Enter to approve or reject. Reopening Ensemble never approves anything automatically.</text>
        </Show>
      </box>
    )
  }

  function WorkView(props: { items: WorkItem[]; selected: number; state: EnsembleState | null }) {
    const work = createMemo(() => props.items[props.selected])
    return (
      <box flexDirection="column">
        <text fg={color.accent}>Work and queues</text>
        <text fg={color.muted}>Turns: {props.state?.settings.maxConcurrentTurns ?? 3} · Chain limit: {props.state?.settings.chainLimit ?? 10} · ctrl+, to change</text>
        <Show when={work()} fallback={<text fg={color.muted}>No active or queued work.</text>}>
          <text fg={work()!.status === "running" ? color.good : work()!.status === "waiting_approval" ? color.warn : color.text}>
            {work()!.status.toUpperCase()} · {props.state?.agents[work()!.agentID]?.name ?? work()!.agentID}
          </text>
          <text>Mode: {work()!.mode} · Channel: {work()!.channelID ? `#${props.state?.channels[work()!.channelID]?.name ?? work()!.channelID}` : "direct"}</text>
          <text>Checkout: {work()!.checkoutKey ?? "none"}</text>
          <text>Request: {short(work()!.prompt, 110)}</text>
          <Show when={work()!.error}><text fg={color.bad}>{work()!.error}</text></Show>
          <text> </text>
          <text fg={color.muted}>x cancel · r retry · t steer to front · [ / ] reorder · queued work waits for capacity or a checkout lock</text>
        </Show>
      </box>
    )
  }

  function SettingsView(props: { agent: AgentProfile | null; tab: SettingsTab; fieldIndex: number; memoryIndex: number; skillIndex: number; memories: MemoryEntry[]; skills: SkillOption[]; missingSkills: string[]; skillFilter: string; modelsCount: number }) {
    return (
      <Show when={props.agent} fallback={<text fg={color.muted}>Select an agent first.</text>}>
        <box flexDirection="column">
          <text fg={color.accent}>{props.agent!.name} · settings {dirty() ? "· UNSAVED" : ""}</text>
          <text fg={color.muted}>Tabs: General · Models · Memories · Skillbox (Tab to cycle)</text>
          <text> </text>
          <Show when={props.tab === "general"}>
            <text fg={props.fieldIndex === 0 ? color.good : color.text}>Name: {props.agent!.name}</text>
            <text fg={props.fieldIndex === 1 ? color.good : color.text}>Instructions: {short(props.agent!.instructions || "(empty)", 100)}</text>
            <text fg={color.muted}>e edits the highlighted field. ctrl+s saves for subsequent work.</text>
          </Show>
          <Show when={props.tab === "models"}>
            <text fg={props.fieldIndex === 0 ? color.good : color.text}>Main: {props.agent!.mainModel.providerID}/{props.agent!.mainModel.modelID}{props.agent!.mainModel.variant ? `#${props.agent!.mainModel.variant}` : ""}</text>
            <For each={props.agent!.backupModels}>{(model, index) => <text fg={props.fieldIndex === index() + 1 ? color.good : color.muted}>Backup {index() + 1}: {model.providerID}/{model.modelID}{model.variant ? `#${model.variant}` : ""}</text>}</For>
            <text fg={props.fieldIndex === props.agent!.backupModels.length + 1 ? color.good : color.text}>Add backup model</text>
            <text fg={color.muted}>e selects. b removes the last backup. Unsupported variants are rejected.</text>
          </Show>
          <Show when={props.tab === "memories"}>
            <For each={props.memories}>{(memory, index) => (
              <text fg={props.memoryIndex === index() ? color.good : color.text}>
                [{memory.origin === "automatic" ? "learned" : "manual"}/{memory.scope}] {short(memory.text, 90)}
              </text>
            )}</For>
            <Show when={props.memories.length === 0}><text fg={color.muted}>No saved memories.</text></Show>
            <text fg={color.muted}>e add · ctrl+e edit · ctrl+d delete · ctrl+p promote with approval</text>
          </Show>
          <Show when={props.tab === "skillbox"}>
            <text fg={color.muted}>Filter: {props.skillFilter || "(none)"} · ctrl+f to search</text>
            <For each={props.missingSkills}>{(id) => <text fg={color.bad}>[!] missing skill: {id}</text>}</For>
            <For each={props.skills.slice(0, 40)}>{(skill, index) => (
              <text fg={props.skillIndex === index() ? color.good : color.text}>
                {props.agent!.skillbox.includes(skill.id) ? "[x]" : "[ ]"} {skill.name} ({skill.id}){skill.description ? ` · ${short(skill.description, 35)}` : ""}
              </text>
            )}</For>
            <Show when={props.skills.length === 0}><text fg={color.muted}>No skills available in this project.</text></Show>
            <text fg={color.muted}>space toggles assignment. Empty means no optional skills. Native instructions and permissions stay in force.</text>
          </Show>
          <text> </text>
          <text fg={color.muted}>ctrl+s save · esc cancel {dirty() ? "· changes are pending and apply to new work" : ""}</text>
        </box>
      </Show>
    )
  }
}
