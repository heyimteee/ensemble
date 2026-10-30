import { Show, createEffect, createMemo, createSignal, onMount } from "solid-js"
import { usePlugin } from "@opencode/plugin/tui"
import { execFileSync } from "node:child_process"
import { relative } from "node:path"
import { homedir } from "node:os"
import type { Agent, Approval, ChatContext, ChatMessage, ModelOption, SkillOption, Snapshot, SnapshotState, Subtask, Workspace } from "../types.ts"
import { ApprovalList, HelpView, Rail, SettingsView, TaskBoard, Transcript, type ChatLine, type RailItem, type SettingsTab } from "./components.tsx"
import { composerTrigger, insertAgentMention, insertFileReference, parseSlashCommand } from "./composer.ts"
import { fuzzyMatch, missingSkills, resultForTask, workspaceGroupLabel, workspaceLabel } from "./format.ts"
import { palette } from "./theme.ts"

type Surface = { kind: "agent"; agentID: string; workspaceID?: string } | { kind: "workspace"; workspaceID: string }
type FocusArea = "rail" | "chat" | "tasks"

function directoryOf(context: any): string {
  return context.location?.directory ?? context.data.location.default().directory
}

async function callRpc(context: any, method: string, input: any): Promise<any> {
  const response = await context.client.rpc.call({ rpcID: "ensemble.v2", method, location: { directory: directoryOf(context) }, input })
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
  const [workspaceID, setWorkspaceID] = createSignal<string | null>(null)
  const [surface, setSurface] = createSignal<Surface | null>(null)
  const [focusArea, setFocusArea] = createSignal<FocusArea>("rail")
  const [railCursor, setRailCursor] = createSignal(0)
  const [taskCursor, setTaskCursor] = createSignal(0)
  const [chatContext, setChatContext] = createSignal<ChatContext | null>(null)
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
  const [approvalCursor, setApprovalCursor] = createSignal(0)
  const [memoryCursor, setMemoryCursor] = createSignal(0)
  const [skillCursor, setSkillCursor] = createSignal(0)
  const [skillFilter, setSkillFilter] = createSignal("")
  const [backupCursor, setBackupCursor] = createSignal(0)
  const [workspaceFilter, setWorkspaceFilter] = createSignal("")
  const [composerActive, setComposerActive] = createSignal(false)
  const [completionOpen, setCompletionOpen] = createSignal(false)
  const [transcriptOffset, setTranscriptOffset] = createSignal(0)
  let composerRef: any
  const [restored, setRestored] = createSignal(false)
  let lastSavedHistory = ""
  let lastConfigError = ""
  const [uiState, setUiState] = context.storage.store("ensemble.v2.ui", { initial: { workspaceID: null as string | null, taskID: null as string | null, transcriptOffset: 0 } })

  const state = createMemo<SnapshotState | null>(() => snapshot()?.state ?? null)
  const models = createMemo<ModelOption[]>(() => snapshot()?.models ?? [])
  const skills = createMemo<SkillOption[]>(() => snapshot()?.skills ?? [])
  const rosterAgents = createMemo(() => Object.values(state()?.agents ?? {}).filter((agent) => !agent.archived).sort((a, b) => a.name.localeCompare(b.name)))
  const workspaces = createMemo(() => Object.values(state()?.workspaces ?? {}).filter((workspace) => !workspace.archived).sort((a, b) => b.lastActiveAt - a.lastActiveAt))
  const activeWorkspace = createMemo(() => workspaceID() ? state()?.workspaces[workspaceID()!] : undefined)
  const activeAgents = createMemo(() => {
    const workspace = activeWorkspace()
    return workspace ? workspace.memberIDs.map((id) => state()?.agents[id]).filter((agent): agent is Agent => Boolean(agent)) : rosterAgents()
  })
  const surfaceAgent = createMemo(() => surface()?.kind === "agent" ? state()?.agents[surface()!.agentID] : undefined)
  const selectedAgent = createMemo(() => surface()?.kind === "agent" ? surfaceAgent() : undefined)
  const activeTasks = createMemo(() => {
    const workspace = activeWorkspace()
    return workspace ? Object.values(state()?.subtasks ?? {}).filter((task) => task.workspaceID === workspace.id) : []
  })
  const orderedTasks = createMemo(() => {
    const tasks = activeTasks()
    return [
      ...tasks.filter((task) => task.state === "pending").sort((a, b) => a.createdAt - b.createdAt),
      ...tasks.filter((task) => task.state === "working").sort((a, b) => a.createdAt - b.createdAt),
      ...tasks.filter((task) => task.state === "replied").sort((a, b) => a.createdAt - b.createdAt),
    ]
  })
  const selectedTask = createMemo(() => orderedTasks()[taskCursor()])
  const activeCount = createMemo(() => activeTasks().filter((task) => task.state === "working").length)
  const pendingApprovals = createMemo(() => Object.values(state()?.approvals ?? {}).filter((approval) => approval.status === "pending"))
  const selectedApproval = createMemo(() => pendingApprovals()[approvalCursor()])
  const railItems = createMemo<RailItem[]>(() => {
    const query = workspaceFilter().toLowerCase()
    const agentItems: RailItem[] = rosterAgents().filter((agent) => !query || agent.name.toLowerCase().includes(query)).map((agent) => ({
      kind: "agent" as const,
      id: agent.id,
      title: agent.name,
      detail: activeWorkspace() && !activeWorkspace()!.memberIDs.includes(agent.id) ? "guest" : "",
    }))
    const workspaceItems: RailItem[] = workspaces().filter((workspace) => !query || workspace.name.toLowerCase().includes(query) || workspace.directory.toLowerCase().includes(query)).map((workspace) => ({
      kind: "workspace" as const,
      id: workspace.id,
      title: workspace.name,
      group: workspaceGroupLabel(workspace.directory),
    }))
    return [...agentItems, ...workspaceItems]
  })
  const groupMessages = createMemo(() => {
    const workspace = activeWorkspace()
    return workspace ? (state()?.messages[workspace.id] ?? []).slice(Math.max(0, (state()?.messages[workspace.id]?.length ?? 0) - transcriptOffset() - 200)) : []
  })
  const chatLines = createMemo<ChatLine[]>(() => {
    if (surface()?.kind === "agent") return (chatContext()?.messages ?? []).map((message: ChatMessage) => ({
      id: message.id,
      author: message.author,
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
    }))
    return groupMessages().map((message) => ({
      id: message.id,
      author: message.author === "user" ? "You" : message.author === "system" ? "Ensemble" : state()?.agents[message.agentID ?? ""]?.name ?? "Unknown agent",
      role: message.author === "user" ? "user" as const : message.author === "system" ? "system" as const : "agent" as const,
      text: message.text,
      kind: message.kind,
      streaming: message.streaming,
      interrupted: message.interrupted,
      createdAt: message.createdAt,
    }))
  })
  const settingsAgent = createMemo(() => settingsAgentID() ? state()?.agents[settingsAgentID()!] : undefined)
  const agentMemories = createMemo(() => {
    const agent = settingsAgent()
    if (!agent) return []
    return Object.values(state()?.memories ?? {}).filter((memory) => !memory.deletedAt && memory.agentID === agent.id)
  })
  const filteredSkills = createMemo(() => {
    const query = skillFilter().toLowerCase()
    return skills().filter((skill) => !query || skill.id.toLowerCase().includes(query) || skill.name.toLowerCase().includes(query))
  })
  const selectedMissingSkills = createMemo(() => {
    const agent = draft() ?? selectedAgent()
    return agent ? missingSkills(agent, skills()) : []
  })
  const viewWidth = () => context.renderer.width ?? 120
  const railWidth = () => Math.max(26, Math.min(34, Math.floor(viewWidth() * 0.26)))
  const taskWidth = () => Math.max(28, Math.min(38, Math.floor(viewWidth() * 0.3)))
  const messageWidth = () => Math.max(20, viewWidth() - railWidth() - taskWidth() - 8)

  const isOurRoute = () => {
    const route = context.ui.router.current()
    return route.type === "plugin" && route.name === "ensemble"
  }
  const isModal = () => modal() || helpOpen() || approvalsOpen() || Boolean(settingsAgentID())
  const isBusy = () => busy() || chatContext()?.busy === true

  const modalWrap = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const previous = leaderMode()
    setLeaderMode(false)
    setModal(true)
    try { return await fn() } finally { setModal(false); setLeaderMode(previous) }
  }

  const run = async (label: string, action: () => Promise<void>) => {
    if (busy()) return
    setBusy(true)
    try { await action(); await refresh() } catch (error: any) {
      setStatus(`${label}: ${error?.message ?? error}`)
      context.ui.toast.show({ title: "Ensemble", message: error?.message ?? String(error), variant: "error" })
    } finally { setBusy(false) }
  }

  const refreshChat = async () => {
    const value = surface()
    if (value?.kind !== "agent") { setChatContext(null); return }
    try {
      const next = await callRpc(context, "chat.context", { agentID: value.agentID, workspaceID: value.workspaceID })
      setChatContext(next)
    } catch (error: any) {
      setChatContext(null)
      setStatus(`Chat unavailable: ${error?.message ?? error}`)
    }
  }

  const persistHistory = async (value: Surface | null) => {
    const directory = directoryOf(context)
    const next = value ? {
      surface: value.kind,
      workspaceID: value.kind === "workspace" ? value.workspaceID : value.workspaceID,
      agentID: value.kind === "agent" ? value.agentID : undefined,
      taskID: selectedTask()?.id,
      column: focusArea(),
    } : { surface: "workspace" as const, workspaceID: undefined, agentID: undefined, taskID: undefined, column: focusArea() }
    const history = { ...(state()?.ui.history ?? {}), [directory]: next }
    const serialized = JSON.stringify({ history, workspaceID: workspaceID() })
    if (serialized === lastSavedHistory) return
    lastSavedHistory = serialized
    await invoke(context, "ui.save", { history, activeWorkspaceID: workspaceID() }).catch(() => undefined)
  }

  const refresh = async () => {
    try {
      const next = await callRpc(context, "snapshot", { directory: directoryOf(context) })
      setSnapshot(next)
      if (next.configError && next.configError !== lastConfigError) {
        lastConfigError = next.configError
        context.ui.toast.show({ title: "Ensemble config", message: next.configError, variant: "warning" })
      }
      if (!next.configError) lastConfigError = ""
      const directory = directoryOf(context)
      const workspace = Object.values(next.state.workspaces ?? {}).find((item) => !item.archived && item.directory === directory) as Workspace | undefined
      const history = next.state.ui?.history?.[directory]
      const currentWorkspace = workspaceID()
      if (workspace) {
        if (!currentWorkspace || !next.state.workspaces[currentWorkspace] || next.state.workspaces[currentWorkspace].archived) setWorkspaceID(workspace.id)
        if (!surface()) {
          if (history?.surface === "agent" && history.agentID && next.state.agents[history.agentID]) {
            setSurface({ kind: "agent", agentID: history.agentID, workspaceID: workspace.memberIDs.includes(history.agentID) ? workspace.id : undefined })
          } else {
            setSurface({ kind: "workspace", workspaceID: workspace.id })
          }
        }
        if (!restored()) {
          setRestored(true)
          const taskID = history?.taskID ?? uiState.taskID
          if (taskID) {
            const index = orderedTasks().findIndex((task) => task.id === taskID)
            if (index >= 0) setTaskCursor(index)
          }
          setTranscriptOffset(Math.max(0, Number(uiState.transcriptOffset ?? 0)))
        }
      } else {
        if (!currentWorkspace || !next.state.workspaces[currentWorkspace] || next.state.workspaces[currentWorkspace].archived) setWorkspaceID(null)
        if (!surface()) setSurface(null)
      }
      if (surface()?.kind === "agent") await refreshChat()
      const current = surface()
      if (current?.kind === "workspace" && !next.state.workspaces[current.workspaceID]) setSurface(null)
      if (current?.kind === "agent" && !next.state.agents[current.agentID]) setSurface(null)
      setStatus(`${workspaces().length} workspaces · ${rosterAgents().length} agents · ${activeCount()} working`)
    } catch (error: any) {
      setStatus(`Ensemble unavailable: ${error?.message ?? error}`)
    }
  }

  const openAgent = (agent: Agent) => {
    const workspace = activeWorkspace()
    const workspaceID = workspace?.memberIDs.includes(agent.id) ? workspace.id : undefined
    setSurface({ kind: "agent", agentID: agent.id, workspaceID })
    setFocusArea("chat")
    setChatContext(null)
    void refreshChat()
  }

  const openWorkspace = async (workspace: Workspace) => {
    setWorkspaceID(workspace.id)
    setSurface({ kind: "workspace", workspaceID: workspace.id })
    setFocusArea("chat")
    setTaskCursor(0)
    await run("Activate workspace", async () => { await invoke(context, "workspace.activate", { id: workspace.id }) })
  }

  const enterRail = async () => {
    const item = railItems()[railCursor()]
    if (!item) return
    if (item.kind === "agent") {
      const agent = state()?.agents[item.id]
      if (agent) openAgent(agent)
    } else {
      const workspace = state()?.workspaces[item.id]
      if (workspace) await openWorkspace(workspace)
    }
  }

  const focusLeft = () => setFocusArea((area) => area === "tasks" ? "chat" : area === "chat" ? "rail" : "rail")
  const focusRight = () => setFocusArea((area) => area === "rail" ? "chat" : area === "chat" ? "tasks" : "tasks")
  const moveRail = (delta: number) => {
    const length = railItems().length
    if (length === 0) return
    setRailCursor((cursor) => Math.max(0, Math.min(length - 1, cursor + delta)))
  }
  const moveTask = (delta: number) => {
    const length = orderedTasks().length
    if (length === 0) return
    setTaskCursor((cursor) => Math.max(0, Math.min(length - 1, cursor + delta)))
  }

  const chooseModel = async (current?: ModelOption): Promise<ModelOption | undefined> => {
    if (models().length === 0) throw new Error("No models are available.")
    const value = await modalWrap(() => context.ui.dialog.select({
      title: "Model",
      current: current ? `${current.providerID}/${current.modelID}` : undefined,
      options: models().map((model) => ({ title: `${model.name} · ${model.providerID}/${model.modelID}`, value: `${model.providerID}/${model.modelID}` })),
      search: (query, options) => options.filter((option) => fuzzyMatch(query, option.title)),
    }))
    return value ? models().find((model) => `${model.providerID}/${model.modelID}` === value) : undefined
  }

  const chooseVariant = async (model: ModelOption, current?: string) => {
    if (model.variants.length === 0) return undefined
    return (await modalWrap(() => context.ui.dialog.select({ title: "Reasoning effort", current, options: model.variants.map((variant) => ({ title: variant, value: variant })) }))) ?? undefined
  }

  const pickMembers = async (initial: string[]): Promise<string[] | undefined> => {
    let selected = new Set(initial)
    while (true) {
      const options = rosterAgents().map((agent) => ({ title: `${selected.has(agent.id) ? "[x]" : "[ ]"} ${agent.name}`, value: agent.id }))
      options.push({ title: "Done", value: "__done__" })
      const choice = await modalWrap(() => context.ui.dialog.select({
        title: `Members (${selected.size} selected)`,
        description: "Select agents, then choose Done.",
        options,
        search: (query, options) => options.filter((option) => fuzzyMatch(query, option.title)),
      }))
      if (!choice) return undefined
      if (choice === "__done__") {
        if (selected.size === 0) { context.ui.toast.show({ title: "Ensemble", message: "Choose at least one member.", variant: "warning" }); continue }
        return [...selected]
      }
      if (selected.has(String(choice))) selected.delete(String(choice))
      else selected.add(String(choice))
    }
  }

  const pickDirectory = async (): Promise<string | undefined> => {
    const home = homedir()
    const known = new Map(workspaces().map((workspace) => [workspace.directory, workspace.lastActiveAt]))
    let dirs: string[] = []
    try {
      const output = execFileSync("fd", ["--type", "d", "--hidden", "--exclude", ".git", "--exclude", "node_modules", "--max-depth", "3", ".", home], { encoding: "utf8", timeout: 5000 })
      dirs = output.split("\n").filter(Boolean).slice(0, 500)
    } catch { dirs = [home] }
    dirs.sort((a, b) => (known.get(b) ?? -1) - (known.get(a) ?? -1))
    const selected = await modalWrap(() => context.ui.dialog.select({
      title: "Workspace directory",
      options: [
        { title: `Use current directory · ${directoryOf(context)}`, value: directoryOf(context), category: "Quick" },
        { title: "Type a path…", value: "__manual__", category: "Quick" },
        ...dirs.map((directory) => ({ title: workspaceLabel(directory), value: directory, category: known.has(directory) ? "Recent" : "Directories" })),
      ],
      search: (query, options) => options.filter((option) => fuzzyMatch(query, option.title)),
    }))
    if (!selected) return undefined
    if (selected !== "__manual__") return String(selected)
    return (await modalWrap(() => context.ui.dialog.prompt({ title: "Directory path", placeholder: "~/dev/project" })))?.trim()
  }

  const createWorkspace = async () => {
    const directory = await pickDirectory()
    if (!directory) return
    const name = (await modalWrap(() => context.ui.dialog.prompt({ title: "Workspace name", placeholder: "website" })))?.trim()
    if (!name) return
    const members = await pickMembers(rosterAgents().slice(0, 1).map((agent) => agent.id))
    if (!members) return
    const leaderID = await modalWrap(() => context.ui.dialog.select({
      title: "Workspace leader",
      options: members.map((memberID) => ({ title: state()?.agents[memberID]?.name ?? memberID, value: memberID })),
    }))
    if (!leaderID) return
    const synthesis = await modalWrap(() => context.ui.dialog.confirm({ title: "Automatic leader synthesis?", message: "When subtasks complete, the leader combines their replies." }))
    if (synthesis === undefined) return
    let created: Workspace | undefined
    await run("Create workspace", async () => {
      created = await invoke(context, "workspace.create", { name, directory, memberIDs: members, leaderID, synthesis })
      setWorkspaceID(created.id)
      setSurface({ kind: "workspace", workspaceID: created.id })
      setFocusArea("chat")
      await invoke(context, "workspace.activate", { id: created.id })
    })
    if (created) {
      await offerMoveHome(created, members)
      await refresh()
    }
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
      context.ui.toast.show({ title: "Ensemble", message: `${agent.name} created. Opening a direct chat.`, variant: "success" })
      openAgent(agent)
    })
  }

  const offerMoveHome = async (workspace: Workspace, members: string[]) => {
    for (const agentID of members) {
      const binding = Object.values(state()?.bindings ?? {}).find((item) => item.agentID === agentID && item.kind === "home")
      if (!binding) continue
      const move = await modalWrap(() => context.ui.dialog.confirm({ title: `Move ${state()?.agents[agentID]?.name} into #${workspace.name}?`, message: "This moves the homeless direct-chat session into the workspace." }))
      if (move) await invoke(context, "agent.moveHome", { agentID, workspaceID: workspace.id })
    }
  }

  const editWorkspace = async () => {
    const workspace = activeWorkspace()
    if (!workspace) return
    const members = await pickMembers(workspace.memberIDs)
    if (!members) return
    const leaderID = await modalWrap(() => context.ui.dialog.select({
      title: "Workspace leader",
      options: members.map((memberID) => ({ title: state()?.agents[memberID]?.name ?? memberID, value: memberID })),
      current: workspace.leaderID,
    }))
    if (!leaderID) return
    await run("Update workspace", async () => {
      await invoke(context, "workspace.update", { id: workspace.id, memberIDs: members, leaderID })
      await offerMoveHome(workspace, members.filter((id) => !workspace.memberIDs.includes(id)))
    })
  }

  const send = async (text: string, recipientIDs?: string[]) => {
    const value = text.trim()
    if (!value) return
    const current = surface()
    if (!current) { context.ui.toast.show({ title: "Ensemble", message: "Open an agent or workspace first.", variant: "warning" }); return }
    setTranscriptOffset(0)
    await run("Send message", async () => {
      if (current.kind === "agent") {
        await invoke(context, "chat.send", { agentID: current.agentID, workspaceID: current.workspaceID, text: value })
        await refreshChat()
      } else {
        await invoke(context, "message.send", { workspaceID: current.workspaceID, text: value, recipientIDs })
      }
    })
  }

  const focusComposer = () => queueMicrotask(() => composerRef?.focus?.())
  const startCompose = () => {
    if (!surface()) { context.ui.toast.show({ title: "Ensemble", message: "Open an agent or workspace first.", variant: "warning" }); return }
    setComposerActive(true); focusComposer()
  }
  const insertComposer = (value: string) => { if (composerRef) composerRef.value = value; setComposerActive(true); focusComposer() }
  const clearComposer = () => { if (composerRef) composerRef.value = ""; composerRef?.blur?.(); setComposerActive(false) }

  const pickAgentMention = async () => {
    const chosen = await modalWrap(() => context.ui.dialog.select({
      title: "Mention an agent",
      options: activeAgents().map((agent) => ({ title: `${agent.name}${activeWorkspace()?.leaderID === agent.id ? " · leader" : ""}`, value: agent.id })),
      search: (query, options) => options.filter((option) => fuzzyMatch(query, option.title)),
    }))
    if (!chosen) return
    const agent = state()?.agents[String(chosen)]
    if (agent) insertComposer(insertAgentMention(composerRef?.value ?? "", agent.name))
  }

  const pickFileReference = async (current: string) => {
    const workspace = activeWorkspace()
    if (!workspace) return
    let files: string[] = []
    try {
      const output = execFileSync("fd", ["--type", "f", "--hidden", "--exclude", ".git", "--exclude", ".ensemble", "--exclude", "node_modules", "--max-depth", "4", ".", workspace.directory], { encoding: "utf8", timeout: 5000 })
      files = output.split("\n").filter(Boolean).slice(0, 500).map((file) => relative(workspace.directory, file))
    } catch { files = [] }
    if (files.length === 0) { context.ui.toast.show({ title: "Ensemble", message: "No files found to reference.", variant: "warning" }); return }
    const selected = await modalWrap(() => context.ui.dialog.select({
      title: "Reference a file",
      options: files.map((file) => ({ title: file, value: file })),
      search: (query, options) => options.filter((option) => fuzzyMatch(query, option.title)),
    }))
    if (selected) insertComposer(insertFileReference(current, String(selected)))
  }

  const slashCommands = [
    ["workspace", "switch workspace"], ["agent", "mention an agent"], ["settings", "agent settings"], ["approvals", "approval inbox"],
    ["pause", "pause workspace"], ["resume", "resume workspace"], ["init", "initialize Ensemble in this workspace"], ["help", "shortcut help"],
    ["native", "open native session"], ["delegate", "delegate selected subtask"], ["retry", "retry selected subtask"], ["restart", "restart selected subtask"],
    ["cancel", "cancel selected subtask"], ["reset-ensemble", "delete all Ensemble data"], ["leave", "leave Ensemble"],
  ] as const

  const pickWorkspace = async () => {
    const target = await modalWrap(() => context.ui.dialog.select({
      title: "Switch workspace",
      options: workspaces().map((workspace) => ({ title: `#${workspace.name} · ${workspaceLabel(workspace.directory)}`, value: workspace.id })),
      search: (query, options) => options.filter((option) => fuzzyMatch(query, option.title)),
    }))
    const workspace = target ? state()?.workspaces[String(target)] : undefined
    if (workspace) await openWorkspace(workspace)
  }

  const initEnsemble = async () => {
    const workspace = activeWorkspace()
    if (!workspace) { context.ui.toast.show({ title: "Ensemble", message: "Open a workspace first.", variant: "warning" }); return }
    await run("Initialize Ensemble", async () => {
      await invoke(context, "workspace.init", { id: workspace.id })
      context.ui.toast.show({ title: "Ensemble", message: `AGENTS.md initialized in ${workspaceLabel(workspace.directory)}.`, variant: "success" })
    })
  }

  const resetEnsemble = async () => {
    const answer = await modalWrap(() => context.ui.dialog.prompt({ title: "Reset Ensemble", description: "This deletes all Ensemble data and bound native sessions. Type RESET.", placeholder: "RESET" }))
    if (answer !== "RESET") return
    const handoffs = await modalWrap(() => context.ui.dialog.confirm({ title: "Delete handoff files too?", message: "No preserves .ensemble/handoffs. Yes removes them." }))
    await run("Reset Ensemble", async () => {
      await invoke(context, "ensemble.reset", { confirmation: "RESET", deleteHandoffs: Boolean(handoffs) })
      setSurface(null)
      setWorkspaceID(null)
      setChatContext(null)
      setSnapshot(null)
      await refresh()
    })
  }

  const runSlashCommand = async (input: string): Promise<void> => {
    const parsed = parseSlashCommand(input)
    const command = parsed?.command ?? ""
    clearComposer()
    switch (command) {
      case "workspace": await pickWorkspace(); return
      case "agent": await pickAgentMention(); return
      case "settings": openSettings(); return
      case "approvals": setApprovalsOpen(true); return
      case "pause": await togglePause(true); return
      case "resume": await togglePause(false); return
      case "init": await initEnsemble(); return
      case "help": setHelpOpen(true); return
      case "native": openNative(); return
      case "delegate": await delegateSelected(); return
      case "retry": await retrySelected(); return
      case "restart": await restartSelected(); return
      case "cancel": await cancelSelected(); return
      case "reset-ensemble": await resetEnsemble(); return
      case "leave": context.ui.router.navigate({ type: "home" }); return
      default: context.ui.toast.show({ title: "Ensemble", message: `Unknown command: /${command}`, variant: "warning" })
    }
  }

  const pickSlashCommand = async () => {
    const selected = await modalWrap(() => context.ui.dialog.select({
      title: "Ensemble command",
      options: slashCommands.map(([value, description]) => ({ title: `/${value} · ${description}`, value })),
      search: (query, options) => options.filter((option) => fuzzyMatch(query, option.title)),
    }))
    if (selected) await runSlashCommand(`/${String(selected)}`)
  }

  const handleComposerInput = async (value: string) => {
    if (completionOpen()) return
    const trigger = composerTrigger(value)
    if (!trigger) return
    setCompletionOpen(true)
    try {
      if (trigger === "command") await pickSlashCommand()
      if (trigger === "agent") await pickAgentMention()
      if (trigger === "file") await pickFileReference(value)
    } finally { setCompletionOpen(false) }
  }

  const submitComposer = async (value: string) => {
    const text = value.trim()
    if (!text) return
    if (text === "/") { await pickSlashCommand(); return }
    if (parseSlashCommand(text)) { await runSlashCommand(text); return }
    await send(text)
    clearComposer()
  }

  const togglePause = async (paused?: boolean) => {
    const workspace = activeWorkspace()
    if (!workspace) return
    const next = paused ?? !workspace.paused
    await run(next ? "Pause workspace" : "Resume workspace", async () => {
      await invoke(context, next ? "workspace.pause" : "workspace.resume", { id: workspace.id })
    })
  }

  const delegateSelected = async () => {
    const task = selectedTask(); const workspace = activeWorkspace()
    if (!task || !workspace) return
    const target = await modalWrap(() => context.ui.dialog.select({ title: "Delegate subtask", options: activeAgents().map((agent) => ({ title: agent.name, value: agent.id })) }))
    if (!target) return
    const title = (await modalWrap(() => context.ui.dialog.prompt({ title: "Subtask title", value: task.title })))?.trim()
    if (!title) return
    const instruction = (await modalWrap(() => context.ui.dialog.prompt({ title: "Instruction", value: task.instruction })))?.trim()
    if (!instruction) return
    await run("Delegate subtask", async () => { await invoke(context, "task.delegate", { workspaceID: workspace.id, parentID: task.id, assigneeID: target, title, instruction, mode: task.mode }) })
  }

  const reassignSelected = async () => {
    const task = selectedTask(); if (!task) return
    const target = await modalWrap(() => context.ui.dialog.select({ title: "Reassign subtask", options: activeAgents().map((agent) => ({ title: agent.name, value: agent.id })) }))
    if (target) await run("Reassign subtask", async () => { await invoke(context, "task.reassign", { id: task.id, assigneeID: target }) })
  }

  const openResult = async () => {
    const task = selectedTask(); if (!task) return
    const result = resultForTask(state(), task)
    if (!result) { context.ui.toast.show({ title: "Ensemble", message: "No result yet.", variant: "warning" }); return }
    await modalWrap(() => context.ui.dialog.alert({ title: task.title, message: result.text }))
  }

  const retrySelected = async () => { const task = selectedTask(); if (task) await run("Retry subtask", async () => { await invoke(context, "task.retry", { id: task.id }) }) }
  const restartSelected = async () => { const task = selectedTask(); if (task) await run("Restart subtask", async () => { await invoke(context, "task.restart", { id: task.id }) }) }
  const cancelSelected = async () => { const task = selectedTask(); if (task) await run("Cancel subtask", async () => { await invoke(context, "task.cancel", { id: task.id }) }) }

  const openNative = () => {
    const workspace = activeWorkspace()
    if (surface()?.kind === "agent") {
      const sessionID = chatContext()?.sessionID
      if (sessionID) { context.ui.router.navigate({ type: "session", sessionID }); return }
    }
    const agentID = selectedTask()?.assigneeID ?? workspace?.leaderID
    if (!workspace || !agentID) return
    const binding = state()?.bindings[`${workspace.id}:${agentID}`]
    if (binding) context.ui.router.navigate({ type: "session", sessionID: binding.sessionID })
  }

  const openSettings = () => {
    const target = selectedAgent() ?? rosterAgents()[0]
    if (!target) return
    setSettingsAgentID(target.id); setSettingsTab("general"); setDraft(structuredClone(target)); setDirty(false)
  }

  const closeSettings = async () => {
    if (dirty()) {
      const discard = await modalWrap(() => context.ui.dialog.confirm({ title: "Discard changes?", message: "This agent has unsaved settings." }))
      if (!discard) return
    }
    setSettingsAgentID(null); setDraft(null); setDirty(false)
  }

  const saveSettings = async () => {
    const agent = draft(); if (!agent) return
    if (!agent.name.trim()) throw new Error("Agent name is required.")
    await run("Save settings", async () => {
      await invoke(context, "agent.update", { id: agent.id, name: agent.name, title: agent.title, role: agent.role, mainModel: agent.mainModel, backupModels: agent.backupModels, skillbox: agent.skillbox, color: agent.color })
      setDirty(false); setSettingsAgentID(null); setDraft(null)
    })
  }

  const addBackup = async () => {
    const agent = draft(); if (!agent) return
    const model = await chooseModel(); if (!model) return
    const variant = await chooseVariant(model)
    setDraft({ ...agent, backupModels: [...agent.backupModels, { providerID: model.providerID, modelID: model.modelID, variant }] })
    setBackupCursor(agent.backupModels.length); setDirty(true)
  }

  const reorderBackup = (direction: "up" | "down") => {
    const agent = draft(); if (!agent || agent.backupModels.length < 2) return
    const index = Math.max(0, Math.min(agent.backupModels.length - 1, backupCursor()))
    const target = direction === "up" ? Math.max(0, index - 1) : Math.min(agent.backupModels.length - 1, index + 1)
    if (target === index) return
    const models = [...agent.backupModels]; const [model] = models.splice(index, 1); models.splice(target, 0, model)
    setDraft({ ...agent, backupModels: models }); setBackupCursor(target); setDirty(true)
  }

  const removeBackup = () => {
    const agent = draft(); if (!agent || agent.backupModels.length === 0) return
    const index = Math.max(0, Math.min(agent.backupModels.length - 1, backupCursor()))
    setDraft({ ...agent, backupModels: agent.backupModels.filter((_, i) => i !== index) }); setBackupCursor(Math.max(0, index - 1)); setDirty(true)
  }

  const editField = async () => {
    const agent = draft(); if (!agent) return
    if (settingsTab() === "general") {
      const field = (await modalWrap(() => context.ui.dialog.select({ title: "Edit field", options: [{ title: "Name", value: "name" }, { title: "Title", value: "title" }, { title: "Role", value: "role" }, { title: "Color", value: "color" }] }))) as string | undefined
      if (!field) return
      const value = await modalWrap(() => context.ui.dialog.prompt({ title: field, value: agent[field as "name" | "title" | "role" | "color"] }))
      if (value !== undefined) { setDraft({ ...agent, [field]: value } as Agent); setDirty(true) }
    } else if (settingsTab() === "models") {
      const model = await chooseModel(); if (!model) return
      const variant = await chooseVariant(model)
      setDraft({ ...agent, mainModel: { providerID: model.providerID, modelID: model.modelID, variant } }); setDirty(true)
    } else if (settingsTab() === "memories") {
      const text = await modalWrap(() => context.ui.dialog.prompt({ title: "Add memory", placeholder: "The team uses pnpm." }))
      if (text?.trim()) await run("Add memory", async () => { await invoke(context, "memory.add", { agentID: agent.id, workspaceID: activeWorkspace()?.id, scope: "project", text: text.trim(), source: "user" }) })
    } else if (settingsTab() === "skillbox") toggleSkill()
  }

  const toggleSkill = () => {
    const agent = draft(); const skill = filteredSkills()[skillCursor()]
    if (!agent || !skill) return
    const has = agent.skillbox.includes(skill.id)
    setDraft({ ...agent, skillbox: has ? agent.skillbox.filter((id) => id !== skill.id) : [...agent.skillbox, skill.id] }); setDirty(true)
  }

  const deleteMemory = async () => { const memory = agentMemories()[memoryCursor()]; if (memory) await run("Delete memory", async () => { await invoke(context, "memory.delete", { id: memory.id }) }) }
  const promoteMemory = async () => { const memory = agentMemories()[memoryCursor()]; if (memory) await run("Promote memory", async () => { await invoke(context, "memory.promote", { id: memory.id }) }) }

  const resolveApproval = async (approval: Approval) => {
    const options = approval.kind === "interrupted" ? [{ title: "Resume work", value: "approve" }, { title: "Discard", value: "reject" }] : approval.kind === "ask_person" ? [{ title: "Answer", value: "approve" }, { title: "Reject", value: "reject" }] : [{ title: "Approve", value: "approve" }, { title: "Reject", value: "reject" }]
    const value = await modalWrap(() => context.ui.dialog.select({ title: approval.title, options }))
    if (!value) return
    let resolution: string | undefined
    if (value === "approve" && approval.kind === "ask_person") {
      resolution = (await modalWrap(() => context.ui.dialog.prompt({ title: "Your answer", placeholder: "What should the agent do?" })))?.trim()
      if (!resolution) return
    }
    await run("Resolve approval", async () => { await invoke(context, "approval.resolve", { id: approval.id, approve: value === "approve", resolution }) })
  }

  const cycleWorkspace = (delta: number) => {
    const list = workspaces(); if (list.length === 0) return
    const index = Math.max(0, list.findIndex((workspace) => workspace.id === workspaceID()))
    void openWorkspace(list[(index + delta + list.length) % list.length])
  }
  const cycleAgent = (delta: number) => {
    const list = rosterAgents(); if (list.length === 0) return
    const index = Math.max(0, list.findIndex((agent) => agent.id === surfaceAgent()?.id))
    openAgent(list[(index + delta + list.length) % list.length])
  }
  const searchWorkspaces = async () => {
    const query = await modalWrap(() => context.ui.dialog.prompt({ title: "Search workspaces", value: workspaceFilter(), placeholder: "name or directory" }))
    if (query !== undefined) { setWorkspaceFilter(query.trim()); setRailCursor(0) }
  }

  const archiveWorkspace = async () => {
    const workspace = activeWorkspace(); if (!workspace) return
    if (!(await modalWrap(() => context.ui.dialog.confirm({ title: `Archive #${workspace.name}?`, message: "History is preserved." })))) return
    await run("Archive workspace", async () => { await invoke(context, "workspace.archive", { id: workspace.id }); setSurface(null); setWorkspaceID(null) })
  }
  const deleteWorkspace = async () => {
    const workspace = activeWorkspace(); if (!workspace) return
    if (!(await modalWrap(() => context.ui.dialog.confirm({ title: `Delete #${workspace.name}?`, message: "Removes workspace data." })))) return
    const deleteNativeSessions = await modalWrap(() => context.ui.dialog.confirm({ title: "Delete native sessions too?", message: "No preserves them for inspection." }))
    await run("Delete workspace", async () => { await invoke(context, "workspace.delete", { id: workspace.id, deleteNativeSessions: Boolean(deleteNativeSessions) }); setSurface(null); setWorkspaceID(null) })
  }
  const archiveSelectedAgent = async () => {
    const agent = selectedAgent(); if (!agent) return
    const workspace = activeWorkspace()
    if (!(await modalWrap(() => context.ui.dialog.confirm({ title: `Archive ${agent.name}?`, message: "History is preserved." })))) return
    await run("Archive agent", async () => { await invoke(context, "agent.archive", { id: agent.id }); setSurface(null) })
  }
  const deleteSelectedAgent = async () => {
    const agent = selectedAgent(); if (!agent) return
    if (!(await modalWrap(() => context.ui.dialog.confirm({ title: `Delete ${agent.name}?`, message: "Removes the agent profile and memory." })))) return
    const deleteNativeSessions = await modalWrap(() => context.ui.dialog.confirm({ title: "Delete native sessions too?", message: "No preserves them for inspection." }))
    await run("Delete agent", async () => { await invoke(context, "agent.delete", { id: agent.id, deleteNativeSessions: Boolean(deleteNativeSessions) }); setSurface(null) })
  }

  const moveCursor = (delta: number) => {
    if (focusArea() === "tasks") moveTask(delta)
    else if (focusArea() === "rail") moveRail(delta)
  }

  const moveSettingsCursor = (delta: number) => {
    if (settingsTab() === "memories") setMemoryCursor((cursor) => Math.max(0, Math.min(Math.max(0, agentMemories().length - 1), cursor + delta)))
    else if (settingsTab() === "models") setBackupCursor((cursor) => Math.max(0, Math.min(Math.max(0, (draft()?.backupModels.length ?? 1) - 1), cursor + delta)))
    else if (settingsTab() === "skillbox") setSkillCursor((cursor) => Math.max(0, Math.min(Math.max(0, filteredSkills().length - 1), cursor + delta)))
  }

  createEffect(() => {
    if (!restored()) return
    void persistHistory(surface())
  })

  onMount(() => {
    void refresh()
    const timer = setInterval(() => {
      if (surface()?.kind === "agent") void refreshChat()
      void refresh()
    }, 1500)
    const stopData = context.data.listen(({ details }: any) => {
      if (typeof details?.type === "string" && details.type.startsWith("rpc.ensemble.v2.")) void refresh()
    })
    const keyInput = context.renderer.keyInput
    const onKey = (event: any) => {
      if (!leaderMode()) return
      const name = String(event?.name ?? ""); const sequence = String(event?.sequence ?? "")
      if (name === "escape" || name === "q" || name === "?" || sequence === "?") return
      event?.preventDefault?.(); event?.stopPropagation?.()
      setLeaderMode(false)
      context.ui.toast.show({ title: "Leader", message: `Unknown shortcut: ${sequence || name}`, variant: "warning" })
    }
    keyInput.on("keypress", onKey)
    context.keymap.layer(() => ({
      mode: "global", priority: 120,
      enabled: () => isOurRoute() && !isModal() && leaderMode(),
      commands: [
        { id: "ensemble.v2.help", title: "Ensemble: Shortcut help", bind: "?", run: () => { setLeaderMode(false); setHelpOpen(true) } },
        { id: "ensemble.v2.leave", title: "Ensemble: Leave", bind: "q", run: () => { setLeaderMode(false); context.ui.router.navigate({ type: "home" }) } },
        { id: "ensemble.v2.cancel", title: "Ensemble: Cancel leader", bind: "escape", run: () => setLeaderMode(false) },
      ],
      bindings: ["ensemble.v2.help", "ensemble.v2.leave", "ensemble.v2.cancel"],
    }))
    context.keymap.layer(() => ({
      mode: "global", priority: 100,
      enabled: () => isOurRoute() && !isModal() && !leaderMode() && !composerActive(),
      commands: [
        { id: "ensemble.v2.leader", title: "Ensemble: Leader key", bind: "~", run: () => setLeaderMode(true) },
        { id: "ensemble.v2.left", title: "Ensemble: Column left", bind: "h", run: () => focusLeft() },
        { id: "ensemble.v2.right", title: "Ensemble: Column right", bind: "l", run: () => focusRight() },
        { id: "ensemble.v2.down", title: "Ensemble: Down", bind: "j", run: () => moveCursor(1) },
        { id: "ensemble.v2.up", title: "Ensemble: Up", bind: "k", run: () => moveCursor(-1) },
        { id: "ensemble.v2.enter", title: "Ensemble: Open chat", bind: "enter", run: () => { if (focusArea() === "rail") void enterRail().catch(showError); else if (focusArea() === "tasks") void openResult().catch(showError) } },
        { id: "ensemble.v2.compose", title: "Ensemble: Compose", bind: "i", run: () => startCompose() },
        { id: "ensemble.v2.new.agent", title: "Ensemble: New agent", bind: "a", run: () => void createAgent().catch(showError) },
        { id: "ensemble.v2.new.workspace", title: "Ensemble: New workspace", bind: "n", run: () => void createWorkspace().catch(showError) },
        { id: "ensemble.v2.workspace.edit", title: "Ensemble: Edit workspace", bind: "g", run: () => void editWorkspace().catch(showError) },
        { id: "ensemble.v2.settings", title: "Ensemble: Agent settings", bind: "s", run: () => openSettings() },
        { id: "ensemble.v2.approvals", title: "Ensemble: Approvals", bind: "v", run: () => { setApprovalCursor(0); setApprovalsOpen(true) } },
        { id: "ensemble.v2.search", title: "Ensemble: Search", bind: "/", run: () => void searchWorkspaces().catch(showError) },
        { id: "ensemble.v2.init", title: "Ensemble: Init workspace", bind: "ctrl+g", run: () => void initEnsemble().catch(showError) },
        { id: "ensemble.v2.pause", title: "Ensemble: Pause workspace", bind: "p", run: () => void togglePause().catch(showError) },
        { id: "ensemble.v2.native", title: "Ensemble: Native session", bind: "o", run: () => openNative() },
        { id: "ensemble.v2.delegate", title: "Ensemble: Delegate", bind: "d", run: () => void delegateSelected().catch(showError) },
        { id: "ensemble.v2.reassign", title: "Ensemble: Reassign", bind: "t", run: () => void reassignSelected().catch(showError) },
        { id: "ensemble.v2.retry", title: "Ensemble: Retry", bind: "r", run: () => void retrySelected().catch(showError) },
        { id: "ensemble.v2.restart", title: "Ensemble: Restart", bind: "shift+r", run: () => void restartSelected().catch(showError) },
        { id: "ensemble.v2.cancel.task", title: "Ensemble: Cancel subtask", bind: "x", run: () => void cancelSelected().catch(showError) },
        { id: "ensemble.v2.workspace.next", title: "Ensemble: Next workspace", bind: "w", run: () => cycleWorkspace(1) },
        { id: "ensemble.v2.workspace.prev", title: "Ensemble: Previous workspace", bind: "shift+w", run: () => cycleWorkspace(-1) },
        { id: "ensemble.v2.agent.next", title: "Ensemble: Next agent", bind: "z", run: () => cycleAgent(1) },
        { id: "ensemble.v2.agent.prev", title: "Ensemble: Previous agent", bind: "shift+z", run: () => cycleAgent(-1) },
        { id: "ensemble.v2.workspace.archive", title: "Ensemble: Archive workspace", bind: "ctrl+w", run: () => void archiveWorkspace().catch(showError) },
        { id: "ensemble.v2.workspace.delete", title: "Ensemble: Delete workspace", bind: "ctrl+shift+w", run: () => void deleteWorkspace().catch(showError) },
        { id: "ensemble.v2.agent.archive", title: "Ensemble: Archive agent", bind: "ctrl+a", run: () => void archiveSelectedAgent().catch(showError) },
        { id: "ensemble.v2.agent.delete", title: "Ensemble: Delete agent", bind: "ctrl+shift+a", run: () => void deleteSelectedAgent().catch(showError) },
        { id: "ensemble.v2.reset", title: "Ensemble: Reset", bind: "ctrl+shift+delete", run: () => void resetEnsemble().catch(showError) },
        { id: "ensemble.v2.back", title: "Ensemble: Back", bind: "escape", run: () => { if (workspaceFilter()) { setWorkspaceFilter(""); return } context.ui.router.navigate({ type: "home" }) } },
      ],
      bindings: ["ensemble.v2.leader", "ensemble.v2.left", "ensemble.v2.right", "ensemble.v2.down", "ensemble.v2.up", "ensemble.v2.enter", "ensemble.v2.compose", "ensemble.v2.new.agent", "ensemble.v2.new.workspace", "ensemble.v2.workspace.edit", "ensemble.v2.settings", "ensemble.v2.approvals", "ensemble.v2.search", "ensemble.v2.init", "ensemble.v2.pause", "ensemble.v2.native", "ensemble.v2.delegate", "ensemble.v2.reassign", "ensemble.v2.retry", "ensemble.v2.restart", "ensemble.v2.cancel.task", "ensemble.v2.workspace.next", "ensemble.v2.workspace.prev", "ensemble.v2.agent.next", "ensemble.v2.agent.prev", "ensemble.v2.workspace.archive", "ensemble.v2.workspace.delete", "ensemble.v2.agent.archive", "ensemble.v2.agent.delete", "ensemble.v2.reset", "ensemble.v2.back"],
    }))
    context.keymap.layer(() => ({
      mode: "global", priority: 130,
      enabled: () => isOurRoute() && composerActive() && !modal(),
      commands: [{ id: "ensemble.v2.composer.cancel", title: "Ensemble: Cancel composer", bind: "escape", run: () => clearComposer() }],
      bindings: ["ensemble.v2.composer.cancel"],
    }))
    context.keymap.layer(() => ({
      mode: "global", priority: 110,
      enabled: () => isOurRoute() && !modal() && Boolean(settingsAgentID()) && !leaderMode(),
      commands: [
        { id: "ensemble.v2.tab", title: "Ensemble: Settings tab", bind: "tab", run: () => { const tabs: SettingsTab[] = ["general", "models", "memories", "skillbox"]; setSettingsTab(tabs[(tabs.indexOf(settingsTab()) + 1) % tabs.length]) } },
        { id: "ensemble.v2.edit", title: "Ensemble: Edit", bind: "e", run: () => void editField().catch(showError) },
        { id: "ensemble.v2.backup.add", title: "Ensemble: Add backup", bind: "b", enabled: () => settingsTab() === "models", run: () => void addBackup().catch(showError) },
        { id: "ensemble.v2.backup.up", title: "Ensemble: Move backup up", bind: "ctrl+up", enabled: () => settingsTab() === "models", run: () => reorderBackup("up") },
        { id: "ensemble.v2.backup.down", title: "Ensemble: Move backup down", bind: "ctrl+down", enabled: () => settingsTab() === "models", run: () => reorderBackup("down") },
        { id: "ensemble.v2.backup.remove", title: "Ensemble: Remove backup", bind: "backspace", enabled: () => settingsTab() === "models", run: () => removeBackup() },
        { id: "ensemble.v2.save", title: "Ensemble: Save", bind: "ctrl+s", run: () => void saveSettings().catch(showError) },
        { id: "ensemble.v2.skill", title: "Ensemble: Toggle skill", bind: "space", enabled: () => settingsTab() === "skillbox", run: () => toggleSkill() },
        { id: "ensemble.v2.filter", title: "Ensemble: Filter skills", bind: "ctrl+f", enabled: () => settingsTab() === "skillbox", run: async () => { const query = await modalWrap(() => context.ui.dialog.prompt({ title: "Filter skills", value: skillFilter() })); if (query !== undefined) { setSkillFilter(query); setSkillCursor(0) } } },
        { id: "ensemble.v2.memory.delete", title: "Ensemble: Delete memory", bind: "ctrl+d", enabled: () => settingsTab() === "memories", run: () => void deleteMemory().catch(showError) },
        { id: "ensemble.v2.memory.promote", title: "Ensemble: Promote memory", bind: "ctrl+p", enabled: () => settingsTab() === "memories", run: () => void promoteMemory().catch(showError) },
        { id: "ensemble.v2.settings.up", title: "Ensemble: Up", bind: "up", run: () => moveSettingsCursor(-1) },
        { id: "ensemble.v2.settings.down", title: "Ensemble: Down", bind: "down", run: () => moveSettingsCursor(1) },
        { id: "ensemble.v2.settings.back", title: "Ensemble: Close settings", bind: "escape", run: () => void closeSettings() },
      ],
      bindings: ["ensemble.v2.tab", "ensemble.v2.edit", "ensemble.v2.backup.add", "ensemble.v2.backup.up", "ensemble.v2.backup.down", "ensemble.v2.backup.remove", "ensemble.v2.save", "ensemble.v2.skill", "ensemble.v2.filter", "ensemble.v2.memory.delete", "ensemble.v2.memory.promote", "ensemble.v2.settings.up", "ensemble.v2.settings.down", "ensemble.v2.settings.back"],
    }))
    context.keymap.layer(() => ({
      mode: "global", priority: 110,
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
      mode: "global", priority: 110,
      enabled: () => isOurRoute() && !modal() && helpOpen() && !leaderMode(),
      commands: [{ id: "ensemble.v2.help.back", title: "Ensemble: Close help", bind: "escape", run: () => setHelpOpen(false) }],
      bindings: ["ensemble.v2.help.back"],
    }))
    return () => { clearInterval(timer); keyInput.off("keypress", onKey); stopData() }
  })

  const showError = (error: any) => context.ui.toast.show({ title: "Ensemble", message: error?.message ?? String(error), variant: "error" })

  const surfaceTitle = () => {
    const current = surface()
    if (!current) return "No chat open"
    if (current.kind === "agent") {
      const workspace = current.workspaceID ? state()?.workspaces[current.workspaceID] : undefined
      return `${surfaceAgent()?.name ?? "Agent"} · direct${workspace ? ` · #${workspace.name}` : " · homeless"}`
    }
    const workspace = state()?.workspaces[current.workspaceID]
    return workspace ? `#${workspace.name} · ${workspaceLabel(workspace.directory)}` : "Workspace"
  }

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={colors.bg}>
      <box height={2} flexDirection="column">
        <text fg={colors.accent} bg={colors.bg} width="100%" truncate>ENSEMBLE{activeWorkspace() ? ` · #${activeWorkspace()!.name}${activeWorkspace()!.paused ? " · paused" : ""} · ${workspaceLabel(activeWorkspace()!.directory)}` : " · no workspace"}</text>
        <text fg={leaderMode() ? colors.warn : busy() ? colors.warn : colors.muted} bg={colors.bg} width="100%" truncate>{leaderMode() ? "LEADER · ? help · q leave · esc cancel" : status()}</text>
      </box>
      <box flexDirection="row" flexGrow={1}>
        <Rail colors={colors} items={railItems()} cursor={railCursor()} focus={focusArea() === "rail"} activeWorkspaceID={workspaceID()} state={state()} pendingApprovals={pendingApprovals().length} width={railWidth()} filter={workspaceFilter()} />
        <box flexGrow={1} border borderStyle="single" borderColor={colors.border} backgroundColor={colors.bg} flexDirection="column" padding={1}>
          <text fg={focusArea() === "chat" ? colors.good : colors.accent} bg={colors.bg} width="100%" truncate>{surfaceTitle()}</text>
          <Show when={settingsAgentID()} fallback={
            <Show when={helpOpen()} fallback={
              <Show when={approvalsOpen()} fallback={
                <Show when={surface()} fallback={
                  <box flexDirection="column" padding={1} flexGrow={1}>
                    <text fg={colors.accent} bg={colors.bg} width="100%" truncate>No currently opened session</text>
                    <text fg={colors.muted} bg={colors.bg} width="100%" wrapMode="word">Select an agent for a direct chat or a workspace for the group chat. Use j/k then Enter.</text>
                  </box>
                }>
                  <>
                    <Transcript colors={colors} messages={chatLines()} width={messageWidth()} emptyTitle={surface()?.kind === "agent" ? `Direct chat with ${surfaceAgent()?.name ?? "agent"}` : "Group chat"} emptyBody={surface()?.kind === "agent" ? "Send a direct message. It goes to this agent's native OpenCode session." : "Say something to your team. $Name mentions an agent; @path references a file."} busy={isBusy()} queued={chatContext()?.queued ?? 0} />
                    <input ref={(value: any) => { composerRef = value }} placeholder="Message…  $agent · @file · /command" onInput={(value: string) => { void handleComposerInput(value).catch(showError) }} onSubmit={(value: string) => { void submitComposer(value).catch(showError) }} />
                    <text fg={composerActive() ? colors.warn : colors.muted} bg={colors.bg} width="100%" truncate>{composerActive() ? "COMPOSER · enter send · esc cancel" : "i compose · $ agent · @ file · / command"}</text>
                  </>
                </Show>
              }>
                <ApprovalList colors={colors} approvals={pendingApprovals()} cursor={approvalCursor()} state={state()} onResolve={resolveApproval} />
              </Show>
            }>
              <HelpView colors={colors} />
            </Show>
          }>
            <SettingsView colors={colors} agent={draft()} tab={settingsTab()} dirty={dirty()} memories={agentMemories()} memoryCursor={memoryCursor()} backupCursor={backupCursor()} skills={filteredSkills()} skillCursor={skillCursor()} skillFilter={skillFilter()} skillCatalog={skills()} />
          </Show>
        </box>
        <TaskBoard colors={colors} tasks={orderedTasks()} state={state()} cursor={taskCursor()} activeCount={activeCount()} focus={focusArea() === "tasks"} width={taskWidth()} />
      </box>
      <box height={2} flexDirection="column">
        <text fg={colors.muted} bg={colors.bg} width="100%" truncate>h/l columns · j/k select · enter open · i compose · a agent · n workspace · g members · I init · v approvals</text>
        <text fg={selectedMissingSkills().length > 0 ? colors.bad : colors.faint} bg={colors.bg} width="100%" truncate>{selectedMissingSkills().length > 0 ? `! missing skills: ${selectedMissingSkills().join(", ")}` : "~ leader · / search · p pause · s settings · o native"}</text>
      </box>
    </box>
  )
}
