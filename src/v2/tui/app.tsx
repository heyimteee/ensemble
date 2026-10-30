import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import { usePlugin } from "@opencode/plugin/tui"
import { execFileSync } from "node:child_process"
import { homedir } from "node:os"
import type { Agent, Approval, Memory, Message, ModelOption, SkillOption, Snapshot, SnapshotState, Subtask, Workspace } from "../types.ts"

type SettingsTab = "general" | "models" | "memories" | "skillbox"

const color = {
  accent: "#8be9fd",
  muted: "#8a8f98",
  good: "#50fa7b",
  warn: "#f1fa8c",
  bad: "#ff5555",
  text: "#f8f8f2",
  leader: "#bd93f9",
}

function directoryOf(context: any): string {
  return context.location?.directory ?? context.data.location.default().directory
}

async function callRpc(context: any, method: string, input: any): Promise<any> {
  const response = await context.client.rpc.call({
    rpcID: "ensemble.v2",
    method,
    location: { directory: directoryOf(context) },
    input,
  })
  return response?.output ?? response
}

async function invoke(context: any, action: string, payload: any = {}): Promise<any> {
  const response = await callRpc(context, "invoke", { directory: directoryOf(context), action, payload })
  if (!response?.ok) throw new Error(response?.error?.message ?? "Ensemble request failed.")
  return response.result
}

function short(value: string, width = 60): string {
  const single = value.replaceAll("\n", " ")
  return single.length > width ? `${single.slice(0, width - 1)}…` : single
}

function agentName(state: SnapshotState | null, agentID?: string): string {
  if (!agentID) return "Unassigned"
  return state?.agents[agentID]?.name ?? "Unknown agent"
}

function workspaceOf(state: SnapshotState | null, workspaceID: string | null): Workspace | undefined {
  return workspaceID ? state?.workspaces[workspaceID] : undefined
}

export function EnsembleV2App() {
  const context = usePlugin()
  const [snapshot, setSnapshot] = createSignal<Snapshot | null>(null)
  const [activeWorkspaceID, setActiveWorkspaceID] = createSignal<string | null>(null)
  const [selectedAgentID, setSelectedAgentID] = createSignal<string | null>(null)
  const [selectedTaskID, setSelectedTaskID] = createSignal<string | null>(null)
  const [settingsAgentID, setSettingsAgentID] = createSignal<string | null>(null)
  const [settingsTab, setSettingsTab] = createSignal<SettingsTab>("general")
  const [draft, setDraft] = createSignal<Agent | null>(null)
  const [dirty, setDirty] = createSignal(false)
  const [leaderMode, setLeaderMode] = createSignal(false)
  const [helpOpen, setHelpOpen] = createSignal(false)
  const [approvalsOpen, setApprovalsOpen] = createSignal(false)
  const [status, setStatus] = createSignal("Loading workspace…")
  const [busy, setBusy] = createSignal(false)
  const [modal, setModal] = createSignal(false)
  const [taskCursor, setTaskCursor] = createSignal(0)
  const [approvalCursor, setApprovalCursor] = createSignal(0)
  const [memoryCursor, setMemoryCursor] = createSignal(0)
  const [skillCursor, setSkillCursor] = createSignal(0)
  const [skillFilter, setSkillFilter] = createSignal("")

  const state = createMemo<SnapshotState | null>(() => snapshot()?.state ?? null)
  const models = createMemo<ModelOption[]>(() => snapshot()?.models ?? [])
  const skills = createMemo<SkillOption[]>(() => snapshot()?.skills ?? [])
  const workspaces = createMemo(() => Object.values(state()?.workspaces ?? {}).filter((workspace) => !workspace.archived).sort((a, b) => b.lastActiveAt - a.lastActiveAt))
  const activeWorkspace = createMemo(() => workspaceOf(state(), activeWorkspaceID()))
  const activeMessages = createMemo(() => {
    const workspace = activeWorkspace()
    return workspace ? (state()?.messages[workspace.id] ?? []).slice(-30) : []
  })
  const activeTasks = createMemo(() => {
    const workspace = activeWorkspace()
    return workspace ? Object.values(state()?.subtasks ?? {}).filter((task) => task.workspaceID === workspace.id).sort((a, b) => a.createdAt - b.createdAt) : []
  })
  const pendingTasks = createMemo(() => activeTasks().filter((task) => task.state === "pending"))
  const workingTasks = createMemo(() => activeTasks().filter((task) => task.state === "working"))
  const repliedTasks = createMemo(() => activeTasks().filter((task) => task.state === "replied"))
  const selectedTask = createMemo(() => activeTasks()[taskCursor()])
  const activeAgents = createMemo(() => {
    const workspace = activeWorkspace()
    return workspace ? workspace.memberIDs.map((memberID) => state()?.agents[memberID]).filter((agent): agent is Agent => Boolean(agent)) : []
  })
  const selectedAgent = createMemo(() => {
    const id = selectedAgentID()
    return id ? state()?.agents[id] : undefined
  })
  const settingsAgent = createMemo(() => {
    const id = settingsAgentID()
    return id ? state()?.agents[id] : undefined
  })
  const agentMemories = createMemo(() => {
    const agent = settingsAgent()
    if (!agent) return []
    return Object.values(state()?.memories ?? {}).filter((memory) => !memory.deletedAt && memory.agentID === agent.id)
  })
  const filteredSkills = createMemo(() => {
    const query = skillFilter().toLowerCase()
    return skills().filter((skill) => !query || skill.id.toLowerCase().includes(query) || skill.name.toLowerCase().includes(query))
  })
  const pendingApprovals = createMemo(() => Object.values(state()?.approvals ?? {}).filter((approval) => approval.status === "pending"))
  const selectedApproval = createMemo(() => pendingApprovals()[approvalCursor()])
  const activeCount = createMemo(() => activeTasks().filter((task) => task.state === "working").length)

  const isOurRoute = () => {
    const route = context.ui.router.current()
    return route.type === "plugin" && route.name === "ensemble"
  }
  const isModal = () => modal() || helpOpen() || approvalsOpen() || Boolean(settingsAgentID())
  const selectedWorkId = () => selectedTask()?.assigneeID

  const refresh = async () => {
    try {
      const next = await callRpc(context, "snapshot", { directory: directoryOf(context) })
      setSnapshot(next)
      const available = Object.values(next.state.workspaces ?? {}).filter((workspace) => !workspace.archived)
      if (!activeWorkspaceID() && available.length > 0) setActiveWorkspaceID(available.sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0].id)
      if (activeWorkspaceID() && !next.state.workspaces[activeWorkspaceID()!]) setActiveWorkspaceID(available[0]?.id ?? null)
      setStatus(`${available.length} workspaces · ${activeCount()} working`)
    } catch (error: any) {
      setStatus(`Ensemble unavailable: ${error?.message ?? error}`)
    }
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

  const modalWrap = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const previous = leaderMode()
    setLeaderMode(false)
    setModal(true)
    try {
      return await fn()
    } finally {
      setModal(false)
      setLeaderMode(previous)
    }
  }

  const chooseWorkspace = async (workspaceID: string) => {
    setActiveWorkspaceID(workspaceID)
    setTaskCursor(0)
    setSelectedTaskID(null)
    setSelectedAgentID(null)
    await run("Activate workspace", async () => { await invoke(context, "workspace.activate", { id: workspaceID }) })
  }

  const pickDirectory = async (): Promise<string | undefined> => {
    const home = homedir()
    let dirs: string[] = []
    try {
      const output = execFileSync("fd", ["--type", "d", "--hidden", "--exclude", ".git", "--exclude", "node_modules", "--max-depth", "3", ".", home], { encoding: "utf8", timeout: 5000 })
      dirs = output.split("\n").filter(Boolean).slice(0, 500)
    } catch {
      dirs = [home]
    }
    const selected = await modalWrap(() =>
      context.ui.dialog.select({
        title: "Workspace directory",
        options: [
          { title: `Use current directory · ${directoryOf(context)}`, value: directoryOf(context), category: "Quick" },
          { title: "Type a path…", value: "__manual__", category: "Quick" },
          ...dirs.map((directory) => ({ title: directory.replace(home, "~"), value: directory, category: "Directories" })),
        ],
        search: (query, options) => {
          const needle = query.toLowerCase()
          return options.filter((option) => option.title.toLowerCase().includes(needle))
        },
      }),
    )
    if (!selected) return undefined
    if (selected !== "__manual__") return String(selected)
    return (await modalWrap(() => context.ui.dialog.prompt({ title: "Directory path", placeholder: "~/dev/project" })))?.trim()
  }

  const createWorkspace = async () => {
    const directory = await pickDirectory()
    if (!directory) return
    const name = (await modalWrap(() => context.ui.dialog.prompt({ title: "Workspace name", placeholder: "website" })))?.trim()
    if (!name) return
    const agents = Object.values(state()?.agents ?? {}).filter((agent) => !agent.archived)
    if (agents.length === 0) throw new Error("Create an agent first with a.")
    const memberNames = agents.map((agent) => agent.name).join(", ")
    const raw = (await modalWrap(() => context.ui.dialog.prompt({ title: "Members", description: `Comma-separated names. Available: ${memberNames}`, value: membersDefault(agents) }))) ?? ""
    const members = raw.split(",").map((part) => part.trim()).filter(Boolean).map((part) => agents.find((agent) => agent.name.toLowerCase() === part.toLowerCase() || agent.id === part)?.id).filter((id): id is string => Boolean(id))
    if (members.length === 0) throw new Error("No matching members.")
    const leaderID = await modalWrap(() => context.ui.dialog.select({ title: "Workspace leader", options: members.map((memberID) => ({ title: agentName(state(), memberID), value: memberID })) }))
    if (!leaderID) return
    await run("Create workspace", async () => {
      const created = await invoke(context, "workspace.create", { name, directory, memberIDs: members, leaderID, synthesis: true })
      setActiveWorkspaceID(created.id)
      await invoke(context, "workspace.activate", { id: created.id })
    })
  }

  const membersDefault = (agents: Agent[]) => agents.slice(0, 2).map((agent) => agent.name).join(", ")

  const createAgent = async () => {
    const name = (await modalWrap(() => context.ui.dialog.prompt({ title: "New agent", placeholder: "Nova" })))?.trim()
    if (!name) return
    const title = (await modalWrap(() => context.ui.dialog.prompt({ title: "Title", placeholder: "Engineering" }))) ?? ""
    const role = (await modalWrap(() => context.ui.dialog.prompt({ title: "Role", placeholder: "You are a focused coding teammate." }))) ?? ""
    const model = await chooseModel()
    if (!model) return
    const variant = await chooseVariant(model)
    await run("Create agent", async () => {
      const agent = await invoke(context, "agent.create", { name, title, role, mainModel: { providerID: model.providerID, modelID: model.modelID, variant }, backupModels: [], skillbox: [], color: "cyan" })
      setSelectedAgentID(agent.id)
    })
  }

  const chooseModel = async (current?: ModelOption): Promise<ModelOption | undefined> => {
    if (models().length === 0) throw new Error("No models are available.")
    const value = await modalWrap(() =>
      context.ui.dialog.select({
        title: "Model",
        current: current ? `${current.providerID}/${current.modelID}` : undefined,
        options: models().map((model) => ({ title: `${model.name} · ${model.providerID}/${model.modelID}`, value: `${model.providerID}/${model.modelID}` })),
        search: (query, options) => options.filter((option) => option.title.toLowerCase().includes(query.toLowerCase())),
      }),
    )
    return value ? models().find((model) => `${model.providerID}/${model.modelID}` === value) : undefined
  }

  const chooseVariant = async (model: ModelOption, current?: string) => {
    if (model.variants.length === 0) return undefined
    return (await modalWrap(() => context.ui.dialog.select({ title: "Reasoning effort", current, options: model.variants.map((variant) => ({ title: variant, value: variant })) }))) ?? undefined
  }

  const send = async (text: string) => {
    const workspace = activeWorkspace()
    if (!workspace || !text.trim()) return
    await invoke(context, "message.send", { workspaceID: workspace.id, text: text.trim() })
    await refresh()
  }

  const compose = async () => {
    const workspace = activeWorkspace()
    if (!workspace) {
      context.ui.toast.show({ title: "Ensemble", message: "Create a workspace first.", variant: "warning" })
      return
    }
    const text = await modalWrap(() => context.ui.dialog.prompt({
      title: `Message #${workspace.name}`,
      description: "Use @Name to address an agent; no mention goes to the leader.",
      placeholder: "Ask the team…",
    }))
    if (text?.trim()) await send(text)
  }

  const delegateSelected = async () => {
    const task = selectedTask()
    const workspace = activeWorkspace()
    if (!task || !workspace) return
    const target = await modalWrap(() =>
      context.ui.dialog.select({
        title: "Delegate subtask",
        options: activeAgents().map((agent) => ({ title: `${agent.name}${workspace.leaderID === agent.id ? " · leader" : ""}`, value: agent.id })),
      }),
    )
    if (!target) return
    const title = (await modalWrap(() => context.ui.dialog.prompt({ title: "Subtask title", value: task.title })))?.trim()
    if (!title) return
    const instruction = (await modalWrap(() => context.ui.dialog.prompt({ title: "Instruction", value: task.instruction })))?.trim()
    if (!instruction) return
    const constraints = (await modalWrap(() => context.ui.dialog.prompt({ title: "Constraints (optional)" }))) ?? undefined
    const expected = (await modalWrap(() => context.ui.dialog.prompt({ title: "Expected answer (optional)" }))) ?? undefined
    await run("Delegate subtask", async () => {
      await invoke(context, "task.delegate", { workspaceID: workspace.id, parentID: task.id, assigneeID: target, title, instruction, constraints, expected, mode: task.mode })
    })
  }

  const retrySelected = async () => {
    const task = selectedTask()
    if (task) await run("Retry subtask", async () => { await invoke(context, "task.retry", { id: task.id }) })
  }

  const cancelSelected = async () => {
    const task = selectedTask()
    if (task) await run("Cancel subtask", async () => { await invoke(context, "task.cancel", { id: task.id }) })
  }

  const openNative = () => {
    const workspace = activeWorkspace()
    const agentID = selectedTask()?.assigneeID ?? selectedAgentID() ?? workspace?.leaderID
    if (!workspace || !agentID) return
    const binding = state()?.bindings[`${workspace.id}:${agentID}`]
    if (!binding) {
      context.ui.toast.show({ title: "Ensemble", message: "No native session yet. Send a message first.", variant: "warning" })
      return
    }
    context.ui.router.navigate({ type: "session", sessionID: binding.sessionID })
  }

  const openSettings = (agent?: Agent) => {
    const target = agent ?? selectedAgent() ?? activeAgents()[0]
    if (!target) return
    setSettingsAgentID(target.id)
    setSettingsTab("general")
    setDraft(structuredClone(target))
    setDirty(false)
  }

  const closeSettings = async () => {
    if (dirty()) {
      const discard = await modalWrap(() => context.ui.dialog.confirm({ title: "Discard changes?", message: "This agent has unsaved settings changes." }))
      if (!discard) return
    }
    setSettingsAgentID(null)
    setDraft(null)
    setDirty(false)
  }

  const saveSettings = async () => {
    const agent = draft()
    if (!agent) return
    if (!agent.name.trim()) throw new Error("Agent name is required.")
    await run("Save settings", async () => {
      await invoke(context, "agent.update", { id: agent.id, name: agent.name, title: agent.title, role: agent.role, mainModel: agent.mainModel, backupModels: agent.backupModels, skillbox: agent.skillbox, color: agent.color })
      setDirty(false)
      setSettingsAgentID(null)
      setDraft(null)
    })
  }

  const addBackup = async () => {
    const agent = draft()
    if (!agent) return
    const model = await chooseModel()
    if (!model) return
    const variant = await chooseVariant(model)
    setDraft({ ...agent, backupModels: [...agent.backupModels, { providerID: model.providerID, modelID: model.modelID, variant }] })
    setDirty(true)
  }

  const reorderBackup = (direction: "up" | "down") => {
    const agent = draft()
    if (!agent || agent.backupModels.length < 2) return
    const models = [...agent.backupModels]
    const last = models.pop()!
    models.splice(direction === "up" ? Math.max(0, models.length - 1) : models.length, 0, last)
    setDraft({ ...agent, backupModels: models })
    setDirty(true)
  }

  const editField = async () => {
    const agent = draft()
    if (!agent) return
    if (settingsTab() === "general") {
      const field = (await modalWrap(() => context.ui.dialog.select({ title: "Edit field", options: [{ title: "Name", value: "name" }, { title: "Title", value: "title" }, { title: "Role", value: "role" }, { title: "Color", value: "color" }] }))) as string | undefined
      if (!field) return
      const value = await modalWrap(() => context.ui.dialog.prompt({ title: field, value: agent[field as "name" | "title" | "role" | "color"] }))
      if (value !== undefined) {
        setDraft({ ...agent, [field]: value } as Agent)
        setDirty(true)
      }
    } else if (settingsTab() === "models") {
      const model = await chooseModel()
      if (!model) return
      const variant = await chooseVariant(model)
      setDraft({ ...agent, mainModel: { providerID: model.providerID, modelID: model.modelID, variant } })
      setDirty(true)
    } else if (settingsTab() === "memories") {
      const text = await modalWrap(() => context.ui.dialog.prompt({ title: "Add memory", placeholder: "The team uses pnpm." }))
      if (text?.trim()) await run("Add memory", async () => { await invoke(context, "memory.add", { agentID: agent.id, workspaceID: activeWorkspace()?.id, scope: "project", text: text.trim(), source: "user" }) })
    } else if (settingsTab() === "skillbox") {
      toggleSkill()
    }
  }

  const toggleSkill = () => {
    const agent = draft()
    const skill = filteredSkills()[skillCursor()]
    if (!agent || !skill) return
    const has = agent.skillbox.includes(skill.id)
    setDraft({ ...agent, skillbox: has ? agent.skillbox.filter((id) => id !== skill.id) : [...agent.skillbox, skill.id] })
    setDirty(true)
  }

  const deleteMemory = async () => {
    const memory = agentMemories()[memoryCursor()]
    if (memory) await run("Delete memory", async () => { await invoke(context, "memory.delete", { id: memory.id }) })
  }

  const promoteMemory = async () => {
    const memory = agentMemories()[memoryCursor()]
    if (memory) await run("Promote memory", async () => { await invoke(context, "memory.promote", { id: memory.id }) })
  }

  const resolveApproval = async (approval: Approval) => {
    const value = await modalWrap(() => context.ui.dialog.select({ title: approval.title, options: [{ title: "Approve", value: "approve" }, { title: "Reject", value: "reject" }] }))
    if (!value) return
    await run("Resolve approval", async () => { await invoke(context, "approval.resolve", { id: approval.id, approve: value === "approve" }) })
  }

  const moveTask = (delta: number) => {
    const length = activeTasks().length
    if (length === 0) return
    setTaskCursor((cursor) => Math.max(0, Math.min(length - 1, cursor + delta)))
  }

  const moveSkill = (delta: number) => setSkillCursor((cursor) => Math.max(0, Math.min(Math.max(0, filteredSkills().length - 1), cursor + delta)))

  const cycleWorkspace = (delta: number) => {
    const list = workspaces()
    if (list.length === 0) return
    const index = Math.max(0, list.findIndex((workspace) => workspace.id === activeWorkspaceID()))
    const next = list[(index + delta + list.length) % list.length]
    void chooseWorkspace(next.id)
  }

  const cycleAgent = (delta: number) => {
    const list = activeAgents()
    if (list.length === 0) return
    const index = Math.max(0, list.findIndex((agent) => agent.id === selectedAgentID()))
    setSelectedAgentID(list[(index + delta + list.length) % list.length].id)
  }

  onMount(() => {
    void refresh()
    const stop = context.data.listen(({ details }: any) => {
      if (typeof details?.type === "string" && details.type.startsWith("rpc.ensemble.v2.")) void refresh()
    })
    context.keymap.layer(() => ({
      mode: "global",
      priority: 100,
      enabled: () => isOurRoute() && !modal(),
      commands: [
        { id: "ensemble.v2.leader", title: "Ensemble: Leader key", bind: "~", run: () => {
          if (isModal()) return false
          setLeaderMode(true)
        } },
        { id: "ensemble.v2.help", title: "Ensemble: Shortcut help", bind: "?", enabled: () => leaderMode(), run: () => { setLeaderMode(false); setHelpOpen(true) } },
        { id: "ensemble.v2.leave", title: "Ensemble: Leave", bind: "q", enabled: () => leaderMode(), run: () => { setLeaderMode(false); context.ui.router.navigate({ type: "home" }) } },
        { id: "ensemble.v2.cancel", title: "Ensemble: Cancel leader", bind: "escape", enabled: () => leaderMode(), run: () => setLeaderMode(false) },
        { id: "ensemble.v2.compose", title: "Ensemble: Compose message", bind: "i", run: () => void compose().catch(showError) },
        { id: "ensemble.v2.workspace.next", title: "Ensemble: Next workspace", bind: "w", run: () => cycleWorkspace(1) },
        { id: "ensemble.v2.workspace.prev", title: "Ensemble: Previous workspace", bind: "W", run: () => cycleWorkspace(-1) },
        { id: "ensemble.v2.agent.next", title: "Ensemble: Next agent", bind: "z", run: () => cycleAgent(1) },
        { id: "ensemble.v2.new.workspace", title: "Ensemble: New workspace", bind: "n", run: () => void createWorkspace().catch(showError) },
        { id: "ensemble.v2.new.agent", title: "Ensemble: New agent", bind: "a", run: () => void createAgent().catch(showError) },
        { id: "ensemble.v2.settings", title: "Ensemble: Agent settings", bind: "s", run: () => openSettings() },
        { id: "ensemble.v2.native", title: "Ensemble: Open native session", bind: "o", run: () => openNative() },
        { id: "ensemble.v2.delegate", title: "Ensemble: Delegate subtask", bind: "d", run: () => void delegateSelected().catch(showError) },
        { id: "ensemble.v2.retry", title: "Ensemble: Retry subtask", bind: "r", run: () => void retrySelected() },
        { id: "ensemble.v2.cancel.task", title: "Ensemble: Cancel subtask", bind: "x", run: () => void cancelSelected() },
        { id: "ensemble.v2.approvals", title: "Ensemble: Approvals", bind: "v", run: () => { setApprovalCursor(0); setApprovalsOpen(true) } },
        { id: "ensemble.v2.workspace.archive", title: "Ensemble: Archive workspace", bind: "ctrl+w", run: () => void archiveWorkspace().catch(showError) },
        { id: "ensemble.v2.workspace.delete", title: "Ensemble: Delete workspace", bind: "ctrl+shift+w", run: () => void deleteWorkspace().catch(showError) },
        { id: "ensemble.v2.agent.archive", title: "Ensemble: Archive agent", bind: "ctrl+a", run: () => void archiveSelectedAgent().catch(showError) },
        { id: "ensemble.v2.agent.delete", title: "Ensemble: Delete agent", bind: "ctrl+shift+a", run: () => void deleteSelectedAgent().catch(showError) },
        { id: "ensemble.v2.up", title: "Ensemble: Up", bind: "up", run: () => { if (approvalsOpen()) setApprovalCursor((cursor) => Math.max(0, cursor - 1)); else moveTask(-1) } },
        { id: "ensemble.v2.down", title: "Ensemble: Down", bind: "down", run: () => { if (approvalsOpen()) setApprovalCursor((cursor) => Math.min(Math.max(0, pendingApprovals().length - 1), cursor + 1)); else moveTask(1) } },
        { id: "ensemble.v2.resolve", title: "Ensemble: Resolve approval", bind: "enter", enabled: () => approvalsOpen(), run: () => { const approval = selectedApproval(); if (approval) void resolveApproval(approval).catch(showError) } },
        { id: "ensemble.v2.tab", title: "Ensemble: Settings tab", bind: "tab", enabled: () => Boolean(settingsAgentID()), run: () => {
          const tabs: SettingsTab[] = ["general", "models", "memories", "skillbox"]
          setSettingsTab(tabs[(tabs.indexOf(settingsTab()) + 1) % tabs.length])
        } },
        { id: "ensemble.v2.edit", title: "Ensemble: Edit settings", bind: "e", enabled: () => Boolean(settingsAgentID()), run: () => void editField().catch(showError) },
        { id: "ensemble.v2.backup.add", title: "Ensemble: Add backup model", bind: "b", enabled: () => Boolean(settingsAgentID()) && settingsTab() === "models", run: () => void addBackup().catch(showError) },
        { id: "ensemble.v2.backup.up", title: "Ensemble: Move backup up", bind: "ctrl+up", enabled: () => Boolean(settingsAgentID()) && settingsTab() === "models", run: () => reorderBackup("up") },
        { id: "ensemble.v2.backup.down", title: "Ensemble: Move backup down", bind: "ctrl+down", enabled: () => Boolean(settingsAgentID()) && settingsTab() === "models", run: () => reorderBackup("down") },
        { id: "ensemble.v2.save", title: "Ensemble: Save settings", bind: "ctrl+s", enabled: () => Boolean(settingsAgentID()), run: () => void saveSettings().catch(showError) },
        { id: "ensemble.v2.skill", title: "Ensemble: Toggle skill", bind: "space", enabled: () => Boolean(settingsAgentID()) && settingsTab() === "skillbox", run: () => toggleSkill() },
        { id: "ensemble.v2.filter", title: "Ensemble: Filter skills", bind: "ctrl+f", enabled: () => Boolean(settingsAgentID()) && settingsTab() === "skillbox", run: async () => { const query = await modalWrap(() => context.ui.dialog.prompt({ title: "Filter skills", value: skillFilter() })); if (query !== undefined) { setSkillFilter(query); setSkillCursor(0) } } },
        { id: "ensemble.v2.memory.delete", title: "Ensemble: Delete memory", bind: "ctrl+d", enabled: () => Boolean(settingsAgentID()) && settingsTab() === "memories", run: () => void deleteMemory() },
        { id: "ensemble.v2.memory.promote", title: "Ensemble: Promote memory", bind: "ctrl+p", enabled: () => Boolean(settingsAgentID()) && settingsTab() === "memories", run: () => void promoteMemory() },
        { id: "ensemble.v2.back", title: "Ensemble: Back", bind: "escape", enabled: () => !leaderMode(), run: () => {
          if (helpOpen()) { setHelpOpen(false); return }
          if (approvalsOpen()) { setApprovalsOpen(false); return }
          if (settingsAgentID()) { void closeSettings(); return }
          context.ui.router.navigate({ type: "home" })
        } },
      ],
      bindings: [
        "ensemble.v2.leader", "ensemble.v2.help", "ensemble.v2.leave", "ensemble.v2.cancel",
        "ensemble.v2.compose", "ensemble.v2.workspace.next", "ensemble.v2.workspace.prev", "ensemble.v2.agent.next", "ensemble.v2.new.workspace", "ensemble.v2.new.agent", "ensemble.v2.settings", "ensemble.v2.native",
        "ensemble.v2.delegate", "ensemble.v2.retry", "ensemble.v2.cancel.task", "ensemble.v2.approvals", "ensemble.v2.resolve", "ensemble.v2.workspace.archive", "ensemble.v2.workspace.delete", "ensemble.v2.agent.archive", "ensemble.v2.agent.delete",
        "ensemble.v2.up", "ensemble.v2.down", "ensemble.v2.tab", "ensemble.v2.edit", "ensemble.v2.backup.add", "ensemble.v2.backup.up", "ensemble.v2.backup.down", "ensemble.v2.save",
        "ensemble.v2.skill", "ensemble.v2.filter", "ensemble.v2.memory.delete", "ensemble.v2.memory.promote", "ensemble.v2.back",
      ],
    }))
    return stop
  })

  const archiveWorkspace = async () => {
    const workspace = activeWorkspace()
    if (!workspace) return
    const confirmed = await modalWrap(() => context.ui.dialog.confirm({ title: `Archive #${workspace.name}?`, message: "The workspace stops receiving work. History is preserved." }))
    if (!confirmed) return
    await run("Archive workspace", async () => { await invoke(context, "workspace.archive", { id: workspace.id }); setActiveWorkspaceID(null) })
  }

  const deleteWorkspace = async () => {
    const workspace = activeWorkspace()
    if (!workspace) return
    const confirmed = await modalWrap(() => context.ui.dialog.confirm({ title: `Delete #${workspace.name}?`, message: "This removes the workspace, messages, subtasks, and approvals. Native sessions remain unless deleted separately." }))
    if (!confirmed) return
    await run("Delete workspace", async () => { await invoke(context, "workspace.delete", { id: workspace.id }); setActiveWorkspaceID(null) })
  }

  const archiveSelectedAgent = async () => {
    const agent = selectedAgent()
    if (!agent) return
    const confirmed = await modalWrap(() => context.ui.dialog.confirm({ title: `Archive ${agent.name}?`, message: "The agent stops receiving work. History is preserved." }))
    if (!confirmed) return
    try {
      await invoke(context, "agent.archive", { id: agent.id })
      setSelectedAgentID(null)
      await refresh()
    } catch (error: any) { showError(error) }
  }

  const deleteSelectedAgent = async () => {
    const agent = selectedAgent()
    if (!agent) return
    const confirmed = await modalWrap(() => context.ui.dialog.confirm({ title: `Delete ${agent.name}?`, message: "This removes the agent profile and memory. Native sessions remain unless deleted separately." }))
    if (!confirmed) return
    try {
      await invoke(context, "agent.delete", { id: agent.id })
      setSelectedAgentID(null)
      await refresh()
    } catch (error: any) { showError(error) }
  }

  const showError = (error: any) => {
    context.ui.toast.show({ title: "Ensemble", message: error?.message ?? String(error), variant: "error" })
  }

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box height={2} flexDirection="column">
        <text fg={color.accent}>ENSEMBLE{activeWorkspace() ? ` · #${activeWorkspace()!.name}` : ""} {activeWorkspace() ? `· ${activeWorkspace()!.directory}` : ""}</text>
        <text fg={leaderMode() ? color.warn : busy() ? color.warn : color.muted}>{leaderMode() ? "LEADER · ? help · q leave · esc cancel" : status()}</text>
      </box>
      <box flexDirection="row" flexGrow={1}>
        <box width={30} border borderStyle="single" borderColor={color.muted} flexDirection="column" padding={1}>
          <text fg={color.accent}>WORKSPACES</text>
          <For each={workspaces()}>{(workspace) => (
            <text fg={workspace.id === activeWorkspaceID() ? color.good : color.text}>
              {workspace.id === activeWorkspaceID() ? "› " : "  "}#{workspace.name}
            </text>
          )}</For>
          <Show when={workspaces().length === 0}><text fg={color.muted}>No workspaces. Press n.</text></Show>
          <text> </text>
          <text fg={color.accent}>AGENTS</text>
          <For each={activeAgents()}>{(agent) => {
            const working = () => activeTasks().some((task) => task.assigneeID === agent.id && task.state === "working")
            return <text fg={working() ? color.warn : selectedAgentID() === agent.id ? color.good : color.text}>
              {working() ? "◐ " : "  "}{agent.name}{activeWorkspace()?.leaderID === agent.id ? " · leader" : ""}{agent.pendingSettings ? " · pending" : ""}
            </text>
          }}</For>
          <text> </text>
          <text fg={color.accent}>APPROVALS {pendingApprovals().length > 0 ? `(${pendingApprovals().length})` : ""}</text>
          <text fg={color.muted}>v opens inbox</text>
        </box>
        <box flexGrow={1} border borderStyle="single" borderColor={color.muted} flexDirection="column" padding={1}>
          <Show when={settingsAgentID()} fallback={
            <Show when={helpOpen()} fallback={
              <Show when={approvalsOpen()} fallback={
                <>
                  <For each={activeMessages()}>{(message) => <MessageLine message={message} state={state()} workspace={activeWorkspace()} />}</For>
                  <Show when={activeMessages().length === 0}>
                    <text fg={color.muted}>{activeWorkspace() ? "Say something to your team." : "Create a workspace with n."}</text>
                  </Show>
                </>
              }>
                <ApprovalList approvals={pendingApprovals()} cursor={approvalCursor()} state={state()} onResolve={resolveApproval} />
              </Show>
            }>
              <HelpView />
            </Show>
          }>
            <SettingsView
              agent={draft()}
              tab={settingsTab()}
              memories={agentMemories()}
              memoryCursor={memoryCursor()}
              skills={filteredSkills()}
              skillCursor={skillCursor()}
              skillFilter={skillFilter()}
            />
          </Show>
        </box>
        <box width={38} border borderStyle="single" borderColor={color.muted} flexDirection="column" padding={1}>
          <text fg={color.accent}>SUBTASKS {activeCount() > 0 ? `· ${activeCount()} working` : ""}</text>
          <TaskGroup title="PENDING" tasks={pendingTasks()} state={state()} cursor={taskCursor()} offset={0} />
          <TaskGroup title="WORKING" tasks={workingTasks()} state={state()} cursor={taskCursor()} offset={pendingTasks().length} />
          <TaskGroup title="REPLIED" tasks={repliedTasks()} state={state()} cursor={taskCursor()} offset={pendingTasks().length + workingTasks().length} />
          <text> </text>
          <text fg={color.muted}>d delegate · r retry · x cancel · o native</text>
        </box>
      </box>
      <box height={2} flexDirection="column">
        <text fg={color.muted}>i to compose a message · @Name to address · /skill for a skill</text>
        <text fg={color.muted}>n workspace · w switch · z agent · a new agent · s settings · v approvals · ~ leader</text>
      </box>
    </box>
  )

  function MessageLine(props: { message: Message; state: SnapshotState | null; workspace?: Workspace }) {
    const name = props.message.author === "user" ? "You" : props.message.author === "system" ? "Ensemble" : agentName(props.state, props.message.agentID)
    const isLeader = props.message.agentID === props.workspace?.leaderID
    return (
      <box flexDirection="column" paddingY={0}>
        <text fg={props.message.author === "user" ? color.good : props.message.author === "system" ? color.muted : isLeader ? color.leader : color.accent}>
          {name}{isLeader ? " · leader" : ""} {props.message.kind === "task" ? "· task" : ""}
        </text>
        <text fg={props.message.author === "system" ? color.muted : color.text}>{short(props.message.text, 100)}</text>
      </box>
    )
  }

  function TaskGroup(props: { title: string; tasks: Subtask[]; state: SnapshotState | null; cursor: number; offset: number }) {
    return (
      <>
        <text fg={color.muted}>{props.title} ({props.tasks.length})</text>
        <For each={props.tasks}>{(task, index) => (
          <text fg={props.cursor === props.offset + index() ? color.good : task.state === "working" ? color.warn : task.state === "replied" ? color.text : color.muted}>
            {props.cursor === props.offset + index() ? "› " : "  "}{task.state === "working" ? "◐ " : task.state === "replied" ? "● " : "○ "}{short(task.title, 28)} · {agentName(props.state, task.assigneeID)}
          </text>
        )}</For>
      </>
    )
  }

  function ApprovalList(props: { approvals: Approval[]; cursor: number; state: SnapshotState | null; onResolve: (approval: Approval) => Promise<void> }) {
    return (
      <box flexDirection="column">
        <text fg={color.accent}>Approvals inbox</text>
        <Show when={props.approvals.length === 0}><text fg={color.muted}>Nothing waits for you.</text></Show>
        <For each={props.approvals}>{(approval, index) => (
          <box flexDirection="column">
            <text fg={props.cursor === index() ? color.good : color.warn}>{props.cursor === index() ? "› " : "  "}{approval.title}</text>
            <text fg={color.muted}>{short(approval.detail, 100)}</text>
          </box>
        )}</For>
        <text fg={color.muted}>↑/↓ select · Enter approve or reject · esc close</text>
      </box>
    )
  }

  function HelpView() {
    const entries = [
      ["~", "Leader key"], ["~ ?", "This help"], ["~ q", "Leave Ensemble"], ["n", "New workspace"], ["a", "New agent"],
      ["s", "Agent settings"], ["v", "Approvals"], ["o", "Open native session"], ["d", "Delegate subtask"],
      ["r", "Retry subtask"], ["x", "Cancel subtask"], ["Tab", "Settings tabs"], ["e", "Edit setting"], ["Ctrl+S", "Save settings"],
      ["Space", "Toggle skill"], ["Ctrl+F", "Filter skills"], ["Esc", "Back or cancel"],
    ]
    return (
      <box flexDirection="column">
        <text fg={color.accent}>Keyboard shortcuts</text>
        <For each={entries}>{(entry) => <text fg={color.text}>{entry[0].padEnd(10)} {entry[1]}</text>}</For>
        <text fg={color.muted}>~ is disabled while typing in the composer.</text>
      </box>
    )
  }

  function SettingsView(props: { agent: Agent | null; tab: SettingsTab; memories: Memory[]; memoryCursor: number; skills: SkillOption[]; skillCursor: number; skillFilter: string }) {
    return (
      <Show when={props.agent} fallback={<text fg={color.muted}>Select an agent and press s.</text>}>
        <box flexDirection="column">
          <text fg={color.accent}>{props.agent!.name} · settings {dirty() ? "· UNSAVED" : ""}{props.agent!.pendingSettings ? " · pending next task" : ""}</text>
          <text fg={color.muted}>General · Models · Memories · Skillbox (Tab)</text>
          <Show when={props.tab === "general"}>
            <text>Name: {props.agent!.name}</text>
            <text>Title: {props.agent!.title}</text>
            <text>Role: {short(props.agent!.role || "(empty)", 100)}</text>
            <text fg={color.muted}>e edits a field · Ctrl+S saves</text>
          </Show>
          <Show when={props.tab === "models"}>
            <text>Main: {props.agent!.mainModel.providerID}/{props.agent!.mainModel.modelID}{props.agent!.mainModel.variant ? `#${props.agent!.mainModel.variant}` : ""}</text>
            <For each={props.agent!.backupModels}>{(model, index) => <text fg={color.muted}>Backup {index() + 1}: {model.providerID}/{model.modelID}</text>}</For>
            <text fg={color.muted}>e main model · b add backup · ctrl+↑/↓ reorder last</text>
          </Show>
          <Show when={props.tab === "memories"}>
            <For each={props.memories}>{(memory, index) => (
              <text fg={props.memoryCursor === index() ? color.good : color.text}>[{memory.origin}/{memory.scope}] {short(memory.text, 80)} · {memory.source}</text>
            )}</For>
            <Show when={props.memories.length === 0}><text fg={color.muted}>No memories.</text></Show>
            <text fg={color.muted}>e add · Ctrl+D delete · Ctrl+P promote</text>
          </Show>
          <Show when={props.tab === "skillbox"}>
            <text fg={color.muted}>Filter: {props.skillFilter || "(none)"} · Ctrl+F</text>
            <For each={props.skills.slice(0, 40)}>{(skill, index) => (
              <text fg={props.skillCursor === index() ? color.good : color.text}>{props.agent!.skillbox.includes(skill.id) ? "[x]" : "[ ]"} {skill.name} ({skill.id})</text>
            )}</For>
            <text fg={color.muted}>Space toggles · empty means no optional skills</text>
          </Show>
          <text fg={color.muted}>Ctrl+S save · Esc cancel</text>
        </box>
      </Show>
    )
  }
}
