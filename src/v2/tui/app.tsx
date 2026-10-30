import { Show, createMemo, createSignal, onMount } from "solid-js"
import { usePlugin } from "@opencode/plugin/tui"
import { execFileSync } from "node:child_process"
import { homedir } from "node:os"
import type { Agent, Approval, ModelOption, SkillOption, Snapshot, SnapshotState, Workspace } from "../types.ts"
import { ApprovalList, HelpView, MessageList, SettingsView, TaskBoard, WorkspaceRail, type SettingsTab } from "./components.tsx"
import { missingSkills, resultForTask, workspaceLabel } from "./format.ts"
import { palette } from "./theme.ts"

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

export function EnsembleV2App() {
  const context = usePlugin()
  const colors = palette(context.theme as any)
  const [snapshot, setSnapshot] = createSignal<Snapshot | null>(null)
  const [activeWorkspaceID, setActiveWorkspaceID] = createSignal<string | null>(null)
  const [selectedAgentID, setSelectedAgentID] = createSignal<string | null>(null)
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
  const [workspaceFilter, setWorkspaceFilter] = createSignal("")

  const state = createMemo<SnapshotState | null>(() => snapshot()?.state ?? null)
  const models = createMemo<ModelOption[]>(() => snapshot()?.models ?? [])
  const skills = createMemo<SkillOption[]>(() => snapshot()?.skills ?? [])
  const workspaces = createMemo(() => Object.values(state()?.workspaces ?? {}).filter((workspace) => !workspace.archived).sort((a, b) => b.lastActiveAt - a.lastActiveAt))
  const workspaceGroups = createMemo(() => {
    const query = workspaceFilter().toLowerCase()
    const filtered = workspaces().filter((workspace) => !query || workspace.name.toLowerCase().includes(query) || workspace.directory.toLowerCase().includes(query))
    const groups = new Map<string, Workspace[]>()
    for (const workspace of filtered) {
      const list = groups.get(workspace.directory) ?? []
      list.push(workspace)
      groups.set(workspace.directory, list)
    }
    return [...groups.entries()]
      .map(([directory, list]) => ({ directory, workspaces: list.sort((a, b) => b.lastActiveAt - a.lastActiveAt) }))
      .sort((a, b) => Math.max(...b.workspaces.map((workspace) => workspace.lastActiveAt)) - Math.max(...a.workspaces.map((workspace) => workspace.lastActiveAt)))
  })
  const activeWorkspace = createMemo(() => {
    const id = activeWorkspaceID()
    return id ? state()?.workspaces[id] : undefined
  })
  const activeMessages = createMemo(() => {
    const workspace = activeWorkspace()
    return workspace ? (state()?.messages[workspace.id] ?? []).slice(-14) : []
  })
  const activeTasks = createMemo(() => {
    const workspace = activeWorkspace()
    return workspace ? Object.values(state()?.subtasks ?? {}).filter((task) => task.workspaceID === workspace.id).sort((a, b) => a.createdAt - b.createdAt) : []
  })
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
  const selectedMissingSkills = createMemo(() => {
    const agent = draft() ?? selectedAgent()
    return agent ? missingSkills(agent, skills()) : []
  })

  const isOurRoute = () => {
    const route = context.ui.router.current()
    return route.type === "plugin" && route.name === "ensemble"
  }
  const isModal = () => modal() || helpOpen() || approvalsOpen() || Boolean(settingsAgentID())

  const refresh = async () => {
    try {
      const next = await callRpc(context, "snapshot", { directory: directoryOf(context) })
      setSnapshot(next)
      const available = Object.values(next.state.workspaces ?? {}).filter((workspace) => !workspace.archived) as Workspace[]
      const current = activeWorkspaceID()
      const preferred = current && next.state.workspaces[current] && !next.state.workspaces[current].archived ? current : next.state.ui?.activeWorkspaceID
      if (preferred && next.state.workspaces[preferred] && !next.state.workspaces[preferred].archived) {
        if (!current) {
          setActiveWorkspaceID(preferred)
          void invoke(context, "workspace.activate", { id: preferred }).catch(() => undefined)
        }
      } else {
        setActiveWorkspaceID(available.sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.id ?? null)
      }
      const count = activeTasks().filter((task) => task.state === "working").length
      setStatus(`${available.length} workspaces · ${count} working${workspaceFilter() ? ` · filter: ${workspaceFilter()}` : ""}`)
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
    setSelectedAgentID(null)
    setWorkspaceFilter("")
    await run("Activate workspace", async () => { await invoke(context, "workspace.activate", { id: workspaceID }) })
  }

  const pickDirectory = async (): Promise<string | undefined> => {
    const home = homedir()
    const known = new Map(workspaces().map((workspace) => [workspace.directory, workspace.lastActiveAt]))
    let dirs: string[] = []
    try {
      const output = execFileSync("fd", ["--type", "d", "--hidden", "--exclude", ".git", "--exclude", "node_modules", "--max-depth", "3", ".", home], { encoding: "utf8", timeout: 5000 })
      dirs = output.split("\n").filter(Boolean).slice(0, 500)
    } catch {
      dirs = [home]
    }
    dirs.sort((a, b) => (known.get(b) ?? -1) - (known.get(a) ?? -1))
    const recent = dirs.filter((directory) => known.has(directory))
    const selected = await modalWrap(() =>
      context.ui.dialog.select({
        title: "Workspace directory",
        options: [
          { title: `Use current directory · ${directoryOf(context)}`, value: directoryOf(context), category: "Quick" },
          { title: "Type a path…", value: "__manual__", category: "Quick" },
          ...recent.map((directory) => ({ title: workspaceLabel(directory), value: directory, category: "Recent" })),
          ...dirs.filter((directory) => !known.has(directory)).map((directory) => ({ title: workspaceLabel(directory), value: directory, category: "Directories" })),
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
    const raw = (await modalWrap(() => context.ui.dialog.prompt({ title: "Members", description: `Comma-separated names. Available: ${memberNames}`, value: agents.slice(0, 2).map((agent) => agent.name).join(", ") }))) ?? ""
    const members = raw.split(",").map((part) => part.trim()).filter(Boolean).map((part) => agents.find((agent) => agent.name.toLowerCase() === part.toLowerCase() || agent.id === part)?.id).filter((id): id is string => Boolean(id))
    if (members.length === 0) throw new Error("No matching members.")
    const leaderID = await modalWrap(() => context.ui.dialog.select({ title: "Workspace leader", options: members.map((memberID) => ({ title: state()?.agents[memberID]?.name ?? memberID, value: memberID })) }))
    if (!leaderID) return
    await run("Create workspace", async () => {
      const created = await invoke(context, "workspace.create", { name, directory, memberIDs: members, leaderID, synthesis: true })
      setActiveWorkspaceID(created.id)
      await invoke(context, "workspace.activate", { id: created.id })
    })
  }

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
    await run("Send message", async () => { await invoke(context, "message.send", { workspaceID: workspace.id, text: text.trim() }) })
  }

  const compose = async () => {
    const workspace = activeWorkspace()
    if (!workspace) {
      context.ui.toast.show({ title: "Ensemble", message: "Create a workspace first.", variant: "warning" })
      return
    }
    const members = activeAgents().map((agent) => `@${agent.name}`).join(", ")
    const text = await modalWrap(() => context.ui.dialog.prompt({
      title: `Message #${workspace.name}`,
      description: `Mention ${members}; no mention goes to the leader.`,
      placeholder: "Ask the team…",
    }))
    if (text?.trim()) await send(text)
  }

  const mention = async () => {
    const workspace = activeWorkspace()
    if (!workspace) return
    const target = await modalWrap(() => context.ui.dialog.select({
      title: "Mention an agent",
      options: activeAgents().map((agent) => ({ title: `${agent.name}${workspace.leaderID === agent.id ? " · leader" : ""}`, value: agent.id })),
    }))
    if (!target) return
    const agent = state()?.agents[String(target)]
    if (!agent) return
    const text = await modalWrap(() => context.ui.dialog.prompt({ title: `Message ${agent.name}`, placeholder: "Ask for a specific outcome…" }))
    if (text?.trim()) await send(`@${agent.name} ${text.trim()}`)
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

  const reassignSelected = async () => {
    const task = selectedTask()
    if (!task) return
    const target = await modalWrap(() => context.ui.dialog.select({
      title: "Reassign subtask",
      options: activeAgents().map((agent) => ({ title: `${agent.name}${task.assigneeID === agent.id ? " · current" : ""}`, value: agent.id })),
    }))
    if (!target) return
    await run("Reassign subtask", async () => { await invoke(context, "task.reassign", { id: task.id, assigneeID: target }) })
  }

  const openResult = async () => {
    const task = selectedTask()
    if (!task) return
    const result = resultForTask(state(), task)
    if (!result) {
      context.ui.toast.show({ title: "Ensemble", message: "This subtask has no result yet.", variant: "warning" })
      return
    }
    await modalWrap(() => context.ui.dialog.alert({ title: task.title, message: result.text }))
  }

  const retrySelected = async () => {
    const task = selectedTask()
    if (task) await run("Retry subtask", async () => { await invoke(context, "task.retry", { id: task.id }) })
  }

  const restartSelected = async () => {
    const task = selectedTask()
    if (task) await run("Restart subtask", async () => { await invoke(context, "task.restart", { id: task.id }) })
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
    const resume = approval.kind === "interrupted"
    const answer = approval.kind === "ask_person"
    const value = await modalWrap(() => context.ui.dialog.select({
      title: approval.title,
      options: resume
        ? [{ title: "Resume work", value: "approve" }, { title: "Discard", value: "reject" }]
        : answer
          ? [{ title: "Answer", value: "approve" }, { title: "Reject", value: "reject" }]
          : [{ title: "Approve", value: "approve" }, { title: "Reject", value: "reject" }],
    }))
    if (!value) return
    let resolution: string | undefined
    if (value === "approve" && answer) {
      resolution = (await modalWrap(() => context.ui.dialog.prompt({ title: "Your answer", placeholder: "What should the agent do?" })))?.trim()
      if (!resolution) return
    }
    await run("Resolve approval", async () => { await invoke(context, "approval.resolve", { id: approval.id, approve: value === "approve", resolution }) })
  }

  const moveTask = (delta: number) => {
    const length = activeTasks().length
    if (length === 0) return
    setTaskCursor((cursor) => Math.max(0, Math.min(length - 1, cursor + delta)))
  }

  const moveSkill = (delta: number) => setSkillCursor((cursor) => Math.max(0, Math.min(Math.max(0, filteredSkills().length - 1), cursor + delta)))

  const moveCursor = (delta: number) => {
    if (approvalsOpen()) {
      setApprovalCursor((cursor) => Math.max(0, Math.min(Math.max(0, pendingApprovals().length - 1), cursor + delta)))
    } else if (settingsAgentID() && settingsTab() === "memories") {
      setMemoryCursor((cursor) => Math.max(0, Math.min(Math.max(0, agentMemories().length - 1), cursor + delta)))
    } else if (settingsAgentID() && settingsTab() === "skillbox") {
      moveSkill(delta)
    } else {
      moveTask(delta)
    }
  }

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

  const searchWorkspaces = async () => {
    const query = await modalWrap(() => context.ui.dialog.prompt({ title: "Search workspaces", value: workspaceFilter(), placeholder: "name or directory" }))
    if (query !== undefined) setWorkspaceFilter(query.trim())
  }

  const replacementLeader = async (agent: Agent): Promise<string | undefined> => {
    const led = Object.values(state()?.workspaces ?? {}).filter((workspace) => !workspace.archived && workspace.leaderID === agent.id)
    if (led.length === 0) return undefined
    const candidates = led
      .map((workspace) => workspace.memberIDs.filter((memberID) => memberID !== agent.id))
      .reduce((shared, members) => shared.filter((memberID) => members.includes(memberID)))
    if (candidates.length === 0) throw new Error("No common member can replace this leader. Add a member to every workspace first.")
    return await modalWrap(() => context.ui.dialog.select({
      title: `Replacement leader for ${led.map((workspace) => `#${workspace.name}`).join(", ")}`,
      options: candidates.map((memberID) => ({ title: state()?.agents[memberID]?.name ?? memberID, value: memberID })),
    })) as string | undefined
  }

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
    const confirmed = await modalWrap(() => context.ui.dialog.confirm({ title: `Delete #${workspace.name}?`, message: "This removes the workspace, messages, subtasks, and approvals." }))
    if (!confirmed) return
    const deleteNativeSessions = await modalWrap(() => context.ui.dialog.confirm({ title: "Delete native sessions too?", message: "No keeps the OpenCode sessions for inspection. Yes removes them permanently." }))
    await run("Delete workspace", async () => { await invoke(context, "workspace.delete", { id: workspace.id, deleteNativeSessions: Boolean(deleteNativeSessions) }); setActiveWorkspaceID(null) })
  }

  const archiveSelectedAgent = async () => {
    const agent = selectedAgent()
    if (!agent) return
    const replacementLeaderID = await replacementLeader(agent)
    const confirmed = await modalWrap(() => context.ui.dialog.confirm({ title: `Archive ${agent.name}?`, message: replacementLeaderID ? "The agent stops receiving work and the selected member leads its workspaces." : "The agent stops receiving work. History is preserved." }))
    if (!confirmed) return
    await run("Archive agent", async () => {
      await invoke(context, "agent.archive", { id: agent.id, replacementLeaderID })
      setSelectedAgentID(null)
    })
  }

  const deleteSelectedAgent = async () => {
    const agent = selectedAgent()
    if (!agent) return
    const replacementLeaderID = await replacementLeader(agent)
    const confirmed = await modalWrap(() => context.ui.dialog.confirm({ title: `Delete ${agent.name}?`, message: "This removes the agent profile and memory." }))
    if (!confirmed) return
    const deleteNativeSessions = await modalWrap(() => context.ui.dialog.confirm({ title: "Delete native sessions too?", message: "No keeps the OpenCode sessions for inspection. Yes removes them permanently." }))
    await run("Delete agent", async () => {
      await invoke(context, "agent.delete", { id: agent.id, replacementLeaderID, deleteNativeSessions: Boolean(deleteNativeSessions) })
      setSelectedAgentID(null)
    })
  }

  const showError = (error: any) => {
    context.ui.toast.show({ title: "Ensemble", message: error?.message ?? String(error), variant: "error" })
  }

  onMount(() => {
    void refresh()
    const stopData = context.data.listen(({ details }: any) => {
      if (typeof details?.type === "string" && details.type.startsWith("rpc.ensemble.v2.")) void refresh()
    })
    const keyInput = context.renderer.keyInput
    const onKey = (event: any) => {
      if (!leaderMode()) return
      const name = String(event?.name ?? "")
      const sequence = String(event?.sequence ?? "")
      if (name === "escape" || name === "q" || name === "?" || sequence === "?") return
      event?.preventDefault?.()
      event?.stopPropagation?.()
      setLeaderMode(false)
      context.ui.toast.show({ title: "Leader", message: `Unknown shortcut: ${sequence || name}`, variant: "warning" })
    }
    keyInput.on("keypress", onKey)
    context.keymap.layer(() => ({
      mode: "global",
      priority: 120,
      enabled: () => isOurRoute() && !isModal() && leaderMode(),
      commands: [
        { id: "ensemble.v2.help", title: "Ensemble: Shortcut help", bind: "?", run: () => { setLeaderMode(false); setHelpOpen(true) } },
        { id: "ensemble.v2.leave", title: "Ensemble: Leave", bind: "q", run: () => { setLeaderMode(false); context.ui.router.navigate({ type: "home" }) } },
        { id: "ensemble.v2.cancel", title: "Ensemble: Cancel leader", bind: "escape", run: () => setLeaderMode(false) },
      ],
      bindings: ["ensemble.v2.help", "ensemble.v2.leave", "ensemble.v2.cancel"],
    }))
    context.keymap.layer(() => ({
      mode: "global",
      priority: 100,
      enabled: () => isOurRoute() && !isModal() && !leaderMode(),
      commands: [
        { id: "ensemble.v2.leader", title: "Ensemble: Leader key", bind: "~", run: () => setLeaderMode(true) },
        { id: "ensemble.v2.compose", title: "Ensemble: Compose message", bind: "i", run: () => void compose().catch(showError) },
        { id: "ensemble.v2.mention", title: "Ensemble: Mention an agent", bind: "m", run: () => void mention().catch(showError) },
        { id: "ensemble.v2.search", title: "Ensemble: Search workspaces", bind: "/", run: () => void searchWorkspaces().catch(showError) },
        { id: "ensemble.v2.workspace.next", title: "Ensemble: Next workspace", bind: "w", run: () => cycleWorkspace(1) },
        { id: "ensemble.v2.workspace.prev", title: "Ensemble: Previous workspace", bind: "W", run: () => cycleWorkspace(-1) },
        { id: "ensemble.v2.agent.next", title: "Ensemble: Next agent", bind: "z", run: () => cycleAgent(1) },
        { id: "ensemble.v2.agent.prev", title: "Ensemble: Previous agent", bind: "Z", run: () => cycleAgent(-1) },
        { id: "ensemble.v2.new.workspace", title: "Ensemble: New workspace", bind: "n", run: () => void createWorkspace().catch(showError) },
        { id: "ensemble.v2.new.agent", title: "Ensemble: New agent", bind: "a", run: () => void createAgent().catch(showError) },
        { id: "ensemble.v2.settings", title: "Ensemble: Agent settings", bind: "s", run: () => openSettings() },
        { id: "ensemble.v2.native", title: "Ensemble: Open native session", bind: "o", run: () => openNative() },
        { id: "ensemble.v2.delegate", title: "Ensemble: Delegate subtask", bind: "d", run: () => void delegateSelected().catch(showError) },
        { id: "ensemble.v2.reassign", title: "Ensemble: Reassign subtask", bind: "t", run: () => void reassignSelected().catch(showError) },
        { id: "ensemble.v2.result", title: "Ensemble: Open subtask result", bind: "enter", run: () => void openResult().catch(showError) },
        { id: "ensemble.v2.retry", title: "Ensemble: Retry subtask", bind: "r", run: () => void retrySelected().catch(showError) },
        { id: "ensemble.v2.restart", title: "Ensemble: Restart subtask", bind: "R", run: () => void restartSelected().catch(showError) },
        { id: "ensemble.v2.cancel.task", title: "Ensemble: Cancel subtask", bind: "x", run: () => void cancelSelected().catch(showError) },
        { id: "ensemble.v2.approvals", title: "Ensemble: Approvals", bind: "v", run: () => { setApprovalCursor(0); setApprovalsOpen(true) } },
        { id: "ensemble.v2.workspace.archive", title: "Ensemble: Archive workspace", bind: "ctrl+w", run: () => void archiveWorkspace().catch(showError) },
        { id: "ensemble.v2.workspace.delete", title: "Ensemble: Delete workspace", bind: "ctrl+shift+w", run: () => void deleteWorkspace().catch(showError) },
        { id: "ensemble.v2.agent.archive", title: "Ensemble: Archive agent", bind: "ctrl+a", run: () => void archiveSelectedAgent().catch(showError) },
        { id: "ensemble.v2.agent.delete", title: "Ensemble: Delete agent", bind: "ctrl+shift+a", run: () => void deleteSelectedAgent().catch(showError) },
        { id: "ensemble.v2.task.up", title: "Ensemble: Up", bind: "up", run: () => moveTask(-1) },
        { id: "ensemble.v2.task.down", title: "Ensemble: Down", bind: "down", run: () => moveTask(1) },
        { id: "ensemble.v2.back", title: "Ensemble: Back", bind: "escape", run: () => {
          if (workspaceFilter()) { setWorkspaceFilter(""); return }
          context.ui.router.navigate({ type: "home" })
        } },
      ],
      bindings: [
        "ensemble.v2.leader", "ensemble.v2.compose", "ensemble.v2.mention", "ensemble.v2.search",
        "ensemble.v2.workspace.next", "ensemble.v2.workspace.prev", "ensemble.v2.agent.next", "ensemble.v2.agent.prev",
        "ensemble.v2.new.workspace", "ensemble.v2.new.agent", "ensemble.v2.settings", "ensemble.v2.native",
        "ensemble.v2.delegate", "ensemble.v2.reassign", "ensemble.v2.result", "ensemble.v2.retry", "ensemble.v2.restart",
        "ensemble.v2.cancel.task", "ensemble.v2.approvals",
        "ensemble.v2.workspace.archive", "ensemble.v2.workspace.delete", "ensemble.v2.agent.archive", "ensemble.v2.agent.delete",
        "ensemble.v2.task.up", "ensemble.v2.task.down", "ensemble.v2.back",
      ],
    }))
    context.keymap.layer(() => ({
      mode: "global",
      priority: 110,
      enabled: () => isOurRoute() && !modal() && Boolean(settingsAgentID()) && !leaderMode(),
      commands: [
        { id: "ensemble.v2.tab", title: "Ensemble: Settings tab", bind: "tab", run: () => {
          const tabs: SettingsTab[] = ["general", "models", "memories", "skillbox"]
          setSettingsTab(tabs[(tabs.indexOf(settingsTab()) + 1) % tabs.length])
        } },
        { id: "ensemble.v2.edit", title: "Ensemble: Edit settings", bind: "e", run: () => void editField().catch(showError) },
        { id: "ensemble.v2.backup.add", title: "Ensemble: Add backup model", bind: "b", enabled: () => settingsTab() === "models", run: () => void addBackup().catch(showError) },
        { id: "ensemble.v2.backup.up", title: "Ensemble: Move backup up", bind: "ctrl+up", enabled: () => settingsTab() === "models", run: () => reorderBackup("up") },
        { id: "ensemble.v2.backup.down", title: "Ensemble: Move backup down", bind: "ctrl+down", enabled: () => settingsTab() === "models", run: () => reorderBackup("down") },
        { id: "ensemble.v2.save", title: "Ensemble: Save settings", bind: "ctrl+s", run: () => void saveSettings().catch(showError) },
        { id: "ensemble.v2.skill", title: "Ensemble: Toggle skill", bind: "space", enabled: () => settingsTab() === "skillbox", run: () => toggleSkill() },
        { id: "ensemble.v2.filter", title: "Ensemble: Filter skills", bind: "ctrl+f", enabled: () => settingsTab() === "skillbox", run: async () => { const query = await modalWrap(() => context.ui.dialog.prompt({ title: "Filter skills", value: skillFilter() })); if (query !== undefined) { setSkillFilter(query); setSkillCursor(0) } } },
        { id: "ensemble.v2.memory.delete", title: "Ensemble: Delete memory", bind: "ctrl+d", enabled: () => settingsTab() === "memories", run: () => void deleteMemory().catch(showError) },
        { id: "ensemble.v2.memory.promote", title: "Ensemble: Promote memory", bind: "ctrl+p", enabled: () => settingsTab() === "memories", run: () => void promoteMemory().catch(showError) },
        { id: "ensemble.v2.settings.up", title: "Ensemble: Up", bind: "up", run: () => moveCursor(-1) },
        { id: "ensemble.v2.settings.down", title: "Ensemble: Down", bind: "down", run: () => moveCursor(1) },
        { id: "ensemble.v2.settings.back", title: "Ensemble: Close settings", bind: "escape", run: () => void closeSettings() },
      ],
      bindings: [
        "ensemble.v2.tab", "ensemble.v2.edit", "ensemble.v2.backup.add", "ensemble.v2.backup.up", "ensemble.v2.backup.down",
        "ensemble.v2.save", "ensemble.v2.skill", "ensemble.v2.filter", "ensemble.v2.memory.delete", "ensemble.v2.memory.promote",
        "ensemble.v2.settings.up", "ensemble.v2.settings.down", "ensemble.v2.settings.back",
      ],
    }))
    context.keymap.layer(() => ({
      mode: "global",
      priority: 110,
      enabled: () => isOurRoute() && !modal() && approvalsOpen() && !leaderMode(),
      commands: [
        { id: "ensemble.v2.approval.up", title: "Ensemble: Previous approval", bind: "up", run: () => setApprovalCursor((cursor) => Math.max(0, cursor - 1)) },
        { id: "ensemble.v2.approval.down", title: "Ensemble: Next approval", bind: "down", run: () => setApprovalCursor((cursor) => Math.min(Math.max(0, pendingApprovals().length - 1), cursor + 1)) },
        { id: "ensemble.v2.resolve", title: "Ensemble: Resolve approval", bind: "enter", run: () => { const approval = selectedApproval(); if (approval) void resolveApproval(approval).catch(showError) } },
        { id: "ensemble.v2.approvals.back", title: "Ensemble: Close approvals", bind: "escape", run: () => setApprovalsOpen(false) },
      ],
      bindings: ["ensemble.v2.approval.up", "ensemble.v2.approval.down", "ensemble.v2.resolve", "ensemble.v2.approvals.back"],
    }))
    context.keymap.layer(() => ({
      mode: "global",
      priority: 110,
      enabled: () => isOurRoute() && !modal() && helpOpen() && !leaderMode(),
      commands: [
        { id: "ensemble.v2.help.back", title: "Ensemble: Close help", bind: "escape", run: () => setHelpOpen(false) },
      ],
      bindings: ["ensemble.v2.help.back"],
    }))
    return () => {
      keyInput.off("keypress", onKey)
      stopData()
    }
  })

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={colors.bg}>
      <box height={2} flexDirection="column">
        <text fg={colors.accent}>ENSEMBLE{activeWorkspace() ? ` · #${activeWorkspace()!.name}` : ""} {activeWorkspace() ? `· ${workspaceLabel(activeWorkspace()!.directory)}` : ""}</text>
        <text fg={leaderMode() ? colors.warn : busy() ? colors.warn : colors.muted}>{leaderMode() ? "LEADER · ? help · q leave · esc cancel" : status()}</text>
      </box>
      <box flexDirection="row" flexGrow={1}>
        <WorkspaceRail
          colors={colors}
          groups={workspaceGroups()}
          activeWorkspaceID={activeWorkspaceID()}
          filter={workspaceFilter()}
          state={state()}
          agents={activeAgents()}
          selectedAgentID={selectedAgentID()}
          pendingApprovals={pendingApprovals().length}
          workspaceCount={workspaces().length}
          skillCatalog={skills()}
        />
        <box flexGrow={1} border borderStyle="single" borderColor={colors.border} backgroundColor={colors.bg} flexDirection="column" padding={1}>
          <Show when={settingsAgentID()} fallback={
            <Show when={helpOpen()} fallback={
              <Show when={approvalsOpen()} fallback={
                <MessageList colors={colors} messages={activeMessages()} state={state()} workspace={activeWorkspace()} />
              }>
                <ApprovalList colors={colors} approvals={pendingApprovals()} cursor={approvalCursor()} state={state()} onResolve={resolveApproval} />
              </Show>
            }>
              <HelpView colors={colors} />
            </Show>
          }>
            <SettingsView
              colors={colors}
              agent={draft()}
              tab={settingsTab()}
              dirty={dirty()}
              memories={agentMemories()}
              memoryCursor={memoryCursor()}
              skills={filteredSkills()}
              skillCursor={skillCursor()}
              skillFilter={skillFilter()}
              skillCatalog={skills()}
            />
          </Show>
        </box>
        <TaskBoard colors={colors} tasks={activeTasks()} state={state()} cursor={taskCursor()} activeCount={activeCount()} />
      </box>
      <box height={3} flexDirection="column">
        <text fg={colors.muted}>i compose · m mention · @Name to address · / search workspaces</text>
        <text fg={colors.muted}>n workspace · w switch · z agent · a new agent · s settings · v approvals · ~ leader</text>
        <text fg={selectedMissingSkills().length > 0 ? colors.bad : colors.faint}>{selectedMissingSkills().length > 0 ? `! missing skills: ${selectedMissingSkills().join(", ")}` : "Esc back"}</text>
      </box>
    </box>
  )
}
