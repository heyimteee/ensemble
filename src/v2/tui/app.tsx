import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { SyntaxStyle } from "@opentui/core"
import { usePlugin, type Plugin } from "@opencode/plugin/tui"
import { execFileSync } from "node:child_process"
import { relative } from "node:path"
import { homedir } from "node:os"
import type { Agent, Approval, ChatContext, ChatMessage, ModelOption, SkillOption, Snapshot, SnapshotState, Subtask, Workspace } from "../types.ts"
import { ApprovalList, HelpView, PickerOverlay, Rail, SettingsView, TaskBoard, type ChatLine, type PickerItem, type RailItem, type SettingsTab } from "./components.tsx"
import { composerHeight as computeComposerHeight, composerTrigger, parseSlashCommand } from "./composer.ts"
import { agentColor, fuzzyMatch, missingSkills, renderMarkdownLines, resultForTask, transcriptRole, workspaceGroupLabel, workspaceLabel } from "./format.ts"
import { palette } from "./theme.ts"
import { pickerWindow, toggleSelected } from "./picker.ts"
import { markdownStyles } from "./syntax.ts"
import { platformBind, platformLabel } from "./platform.ts"
import { wizardFilterText, wizardModelEmptyHint, wizardModelKeyFor, wizardModelOptions, wizardNavHint, overlayGeometry, sameWizardOptions, WIZARD_NAV_BINDINGS } from "./wizard.ts"
import { readGitState, type GitState } from "./git.ts"
import { normalizeAgentMentions } from "../routing.ts"

type Surface = { kind: "agent"; agentID: string; workspaceID?: string } | { kind: "workspace"; workspaceID: string }
type FocusArea = "rail" | "chat" | "tasks"
type PickerState = {
  mode: "members" | "leader" | "workspace"
  title: string
  candidates: Array<{ id: string; label: string }>
  selected: Set<string>
  cursor: number
  query: string
  resolve: (value: string[] | undefined) => void
}

type TextPromptState = {
  title: string
  description: string
  value: string
  placeholder: string
  resolve: (value: string | undefined) => void
}

type WizardOption = { id: string; label: string; detail?: string }
type WizardStepKind = "pick" | "multi" | "text" | "choice"
type WizardStep = {
  key: string
  title: string
  description: string
  kind: WizardStepKind
  placeholder?: string
  options?: WizardOption[]
}
type WizardDraft = {
  directory: string
  name: string
  memberIDs: string[]
  leaderID: string
  synthesis: boolean
  title: string
  role: string
  modelKey: string
  variant: string
}
type WizardState = {
  flow: "workspace" | "agent"
  title: string
  draft: WizardDraft
  steps: WizardStep[]
  index: number
  query: string
  cursor: number
  error?: string
  customDirectory?: boolean
  directoryOptions: WizardOption[]
  modelOptions: WizardOption[]
  resolve: (value: WizardDraft | undefined) => void
  edit?: Workspace
}

type Completion = {
  kind: "agent" | "file" | "command"
  query: string
  start: number
  cursor: number
  items: Array<{ title: string; value: string }>
}

function directoryOf(context: any): string {
  return context.location?.directory ?? context.data.location.default().directory
}

async function callRpc<T = any>(context: any, method: string, input: any): Promise<T> {
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
  type KeymapLayerFactory = Parameters<Plugin.Context["keymap"]["layer"]>[0]
  const platformLayer = (factory: KeymapLayerFactory) => context.keymap.layer(() => {
    const value = factory()
    return { ...value, commands: value.commands?.map((command) => typeof command.bind === "string" ? { ...command, bind: platformBind(command.bind) } : command) }
  })
  const syntaxStyle = (() => {
    try {
      return SyntaxStyle.fromStyles(markdownStyles(context.theme), (context.renderer as any).nativeScene)
    } catch (error) {
      console.error("ensemble: markdown styling unavailable", error)
      try { context.ui.toast.show({ title: "Ensemble", message: "Rich Markdown styling unavailable; using plain text.", variant: "warning" }) } catch {}
      return undefined
    }
  })()
  onCleanup(() => { try { syntaxStyle?.destroy?.() } catch {} })
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
  const [gitState, setGitState] = createSignal<GitState | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [modal, setModal] = createSignal(false)
  const [approvalCursor, setApprovalCursor] = createSignal(0)
  const [memoryCursor, setMemoryCursor] = createSignal(0)
  const [skillCursor, setSkillCursor] = createSignal(0)
  const [skillFilter, setSkillFilter] = createSignal("")
  const [backupCursor, setBackupCursor] = createSignal(0)
  const [workspaceFilter, setWorkspaceFilter] = createSignal("")
  const [composerActive, setComposerActive] = createSignal(false)
  const [composerDraft, setComposerDraft] = createSignal("")
  const [completion, setCompletion] = createSignal<Completion | null>(null)
  const [picker, setPicker] = createSignal<PickerState | null>(null)
  const [textPrompt, setTextPrompt] = createSignal<TextPromptState | null>(null)
  const [wizard, setWizard] = createSignal<WizardState | null>(null)
  const [liveDm, setLiveDm] = createSignal<{ sessionID: string; text: string } | null>(null)
  const [atBottom, setAtBottom] = createSignal(true)
  let composerRef: any
  let textPromptRef: any
  let wizardRef: any
  let transcriptScrollRef: any
  let helpScrollRef: any
  const lineCache = new Map<string, ChatLine>()
  let refreshSeq = 0
  let chatSeq = 0
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
  const surfaceAgent = createMemo(() => { const value = surface(); return value?.kind === "agent" ? state()?.agents[value.agentID] : undefined })
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
    return workspace ? (state()?.messages[workspace.id] ?? []).slice(-40) : []
  })
  const stableLines = (lines: ChatLine[]): ChatLine[] => {
    const seen = new Set<string>()
    const next = lines.map((line) => {
      seen.add(line.id)
      const previous = lineCache.get(line.id)
      if (previous
        && previous.author === line.author
        && previous.role === line.role
        && previous.text === line.text
        && previous.kind === line.kind
        && previous.streaming === line.streaming
        && previous.interrupted === line.interrupted
        && previous.agentID === line.agentID) return previous
      const value = { ...line }
      lineCache.set(line.id, value)
      return value
    })
    for (const id of lineCache.keys()) if (!seen.has(id)) lineCache.delete(id)
    return next
  }
  const chatLines = createMemo<ChatLine[]>(() => {
    if (surface()?.kind === "agent") {
      const messages: ChatLine[] = (chatContext()?.messages ?? []).slice(-40).map((message: ChatMessage) => ({
        id: message.id,
        author: message.author,
        role: transcriptRole(message.role),
        text: message.role === "assistant" ? normalizeAgentMentions(message.text, activeAgents()).text : message.text,
        agentID: surfaceAgent()?.id,
        createdAt: message.createdAt,
      }))
      const live = liveDm()
      if (live && chatContext()?.sessionID === live.sessionID) {
        messages.push({ id: "live", author: surfaceAgent()?.name ?? "Agent", role: "agent" as const, text: live.text, agentID: surfaceAgent()?.id, createdAt: Date.now(), streaming: true })
      }
      return stableLines(messages)
    }
    return stableLines(groupMessages().map((message) => ({
      id: message.id,
      author: message.author === "user" ? "You" : message.author === "system" ? "Ensemble" : state()?.agents[message.agentID ?? ""]?.name ?? "Unknown agent",
      role: message.author === "user" ? "user" as const : message.author === "system" ? "system" as const : "agent" as const,
      agentID: message.agentID,
      text: message.author === "agent" ? normalizeAgentMentions(message.text, activeAgents()).text : message.text,
      kind: message.kind,
      streaming: message.streaming,
      interrupted: message.interrupted,
      createdAt: message.createdAt,
    })))
  })
  const finalizedLines = createMemo(() => chatLines().filter((message) => !message.streaming))
  const liveLine = createMemo(() => chatLines().find((message) => message.streaming))
  const liveLines = createMemo(() => {
    const live = liveLine()
    if (!live) return []
    return renderMarkdownLines(live.text || "…", Math.max(16, messageWidth())).slice(-5)
  })
  const chatAuthorColor = (line: ChatLine) => {
    if (line.role === "user") return colors.good
    if (line.role === "system") return colors.muted
    const agent = line.agentID ? state()?.agents[line.agentID] : undefined
    const index = rosterAgents().findIndex((item) => item.id === line.agentID)
    return agentColor(agent, colors.accent as string, Math.max(0, index), colors.categorical)
  }
  const emptyChat = () => surface()?.kind === "agent"
    ? `Direct chat with ${surfaceAgent()?.name ?? "agent"}\n\nSend a direct message. It goes to this agent's native OpenCode session.`
    : "Group chat\n\nSay something to your team. $Name mentions an agent; @path references a file."
  const syncTranscriptScroll = () => {
    const box = transcriptScrollRef
    if (!box) { setAtBottom(true); return }
    const height = Number(box.height ?? messageHeight())
    const max = Math.max(0, Number(box.scrollHeight ?? 0) - height)
    setAtBottom(Number(box.scrollTop ?? 0) >= max - 1)
  }
  const jumpToBottom = () => {
    const box = transcriptScrollRef
    if (box) box.scrollTop = Number(box.scrollHeight ?? 0)
    setAtBottom(true)
  }

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
  const [renderSize, setRenderSize] = createSignal({ width: context.renderer.width ?? 120, height: context.renderer.height ?? 40 })
  onMount(() => {
    const update = () => setRenderSize({ width: context.renderer.width ?? 120, height: context.renderer.height ?? 40 })
    context.renderer.on("resize", update)
    onCleanup(() => context.renderer.off("resize", update))
  })
  const viewWidth = () => Math.max(60, renderSize().width - 2)
  const railWidth = () => Math.max(26, Math.min(34, Math.floor(viewWidth() * 0.26)))
  const taskWidth = () => Math.max(28, Math.min(38, Math.floor(viewWidth() * 0.3)))
  const messageWidth = () => Math.max(20, viewWidth() - railWidth() - taskWidth() - 10)
  const viewHeight = () => renderSize().height
  const messageHeight = () => Math.max(6, viewHeight() - 14)
  const pickerGeometry = () => overlayGeometry(viewWidth(), viewHeight(), 16)
  const promptGeometry = () => overlayGeometry(viewWidth(), viewHeight(), 14)
  const wizardHeight = 20
  const wizardGeometry = () => overlayGeometry(viewWidth(), viewHeight(), wizardHeight)

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
    const seq = ++chatSeq
    try {
      const next = await invoke(context, "chat.context", { agentID: value.agentID, workspaceID: value.workspaceID })
      if (seq !== chatSeq) return
      const current = surface()
      if (current?.kind !== "agent" || current.agentID !== value.agentID || current.workspaceID !== value.workspaceID) return
      setChatContext(next)
    } catch (error: any) {
      if (seq !== chatSeq) return
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

  let lastGitAt = 0
  const refreshGit = () => {
    if (Date.now() - lastGitAt < 2000) return
    lastGitAt = Date.now()
    const directory = activeWorkspace()?.directory ?? directoryOf(context)
    setGitState(readGitState(directory))
  }

  const refresh = async () => {
    const seq = ++refreshSeq
    try {
      const next = await callRpc<Snapshot>(context, "snapshot", { directory: directoryOf(context) })
      if (seq !== refreshSeq) return
      setSnapshot(next)
      syncTranscriptScroll()
      try { (context.renderer as any)?.requestRender?.() } catch {}
      if (next.configError && next.configError !== lastConfigError) {
        lastConfigError = next.configError
        context.ui.toast.show({ title: "Ensemble config", message: next.configError, variant: "warning" })
      }
      if (!next.configError) lastConfigError = ""
      const directory = directoryOf(context)
      const workspace = Object.values(next.state.workspaces ?? {}).find((item) => !item.archived && item.directory === directory)
      const history = next.state.ui?.history?.[directory]
      const historyWorkspace = history?.workspaceID && next.state.workspaces[history.workspaceID] && !next.state.workspaces[history.workspaceID].archived ? history.workspaceID : undefined
      const currentWorkspace = workspaceID()
      if (workspace) {
        if (!currentWorkspace || !next.state.workspaces[currentWorkspace] || next.state.workspaces[currentWorkspace].archived) setWorkspaceID(historyWorkspace ?? workspace.id)
        if (!surface()) {
          const targetWorkspace = historyWorkspace ?? workspace.id
          if (history?.surface === "agent" && history.agentID && next.state.agents[history.agentID]) {
            const member = next.state.workspaces[targetWorkspace]?.memberIDs.includes(history.agentID)
            setSurface({ kind: "agent", agentID: history.agentID, workspaceID: member ? targetWorkspace : undefined })
          } else {
            setSurface({ kind: "workspace", workspaceID: targetWorkspace })
          }
        }
        if (!restored()) {
          setRestored(true)
          if (history?.column) setFocusArea(history.column)
          const taskID = history?.taskID ?? uiState.taskID
          if (taskID) {
            const index = orderedTasks().findIndex((task) => task.id === taskID)
            if (index >= 0) setTaskCursor(index)
          }
        }
      } else {
        if (!currentWorkspace || !next.state.workspaces[currentWorkspace] || next.state.workspaces[currentWorkspace].archived) setWorkspaceID(null)
        if (!surface()) setSurface(null)
      }
      if (surface()?.kind === "agent") await refreshChat()
      refreshGit()
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
    setLiveDm(null)
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

  const createWorkspace = async () => {
    const draft = await openWizard("workspace")
    if (!draft) return
    let created: Workspace | undefined
    await run("Create workspace", async () => {
      const workspace: Workspace = await invoke(context, "workspace.create", { name: draft.name.trim(), directory: draft.directory.trim(), memberIDs: draft.memberIDs, leaderID: draft.leaderID, synthesis: draft.synthesis })
      created = workspace
      setWorkspaceID(workspace.id)
      setSurface({ kind: "workspace", workspaceID: workspace.id })
      setFocusArea("chat")
      await invoke(context, "workspace.activate", { id: workspace.id })
    })
    if (created) {
      await offerMoveHome(created, draft.memberIDs)
      await refresh()
    }
  }

  const createAgent = async () => {
    const draft = await openWizard("agent")
    if (!draft) return
    const model = models().find((item) => `${item.providerID}/${item.modelID}` === draft.modelKey)
    if (!model) { showError(new Error("Choose a main model.")); return }
    await run("Create agent", async () => {
      const agent = await invoke(context, "agent.create", {
        name: draft.name.trim(),
        title: draft.title.replace(/\s+/g, " ").trim(),
        role: draft.role.trim(),
        mainModel: { providerID: model.providerID, modelID: model.modelID, ...(draft.variant && draft.variant !== "none" ? { variant: draft.variant } : {}) },
        backupModels: [],
        skillbox: [],
        color: "cyan",
      })
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
    const draft = await openWizard("workspace", workspace)
    if (!draft) return
    await run("Update workspace", async () => {
      await invoke(context, "workspace.update", { id: workspace.id, memberIDs: draft.memberIDs, leaderID: draft.leaderID, synthesis: draft.synthesis })
      await offerMoveHome(workspace, draft.memberIDs.filter((id) => !workspace.memberIDs.includes(id)))
    })
  }

  const send = async (text: string, recipientIDs?: string[]) => {
    const value = text.trim()
    if (!value) return
    const current = surface()
    if (!current) { context.ui.toast.show({ title: "Ensemble", message: "Open an agent or workspace first.", variant: "warning" }); return }
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
  const composerHeight = () => computeComposerHeight(composerDraft(), Math.max(12, messageWidth() - 6))
  const setComposerValue = (value: string) => {
    if (composerRef) {
      composerRef.setText?.(value)
      composerRef.cursorOffset = value.length
      composerRef.height = computeComposerHeight(value, Math.max(12, messageWidth() - 6))
    }
    setComposerDraft(value)
  }
  const handleNativeEvent = (event: any) => {
    const data = event?.data ?? event
    const session = String(data?.sessionID ?? "")
    const delta = String(data?.delta ?? "")
    if (event?.type === "session.text.delta" && session && delta) {
      if (chatContext()?.sessionID === session && surface()?.kind === "agent") {
        setLiveDm((current) => current?.sessionID === session ? { sessionID: session, text: current.text + delta } : { sessionID: session, text: delta })
      }
    }
    if ((event?.type === "session.idle" || event?.type === "session.execution.succeeded" || event?.type === "session.execution.failed" || event?.type === "session.execution.interrupted") && session) {
      if (chatContext()?.sessionID === session) { setLiveDm(null); void refreshChat() }
      void refresh()
    }
  }

  const startCompose = () => {
    if (!surface()) { context.ui.toast.show({ title: "Ensemble", message: "Open an agent or workspace first.", variant: "warning" }); return }
    setComposerActive(true); focusComposer()
  }
  const clearComposer = () => { setComposerValue(""); composerRef?.blur?.(); setComposerActive(false) }

  const agentItems = () => activeAgents().map((agent) => ({ title: `${agent.name}${activeWorkspace()?.leaderID === agent.id ? " · leader" : ""}`, value: agent.name }))

  const fileItems = () => {
    const workspace = activeWorkspace()
    if (!workspace) return []
    try {
      const output = execFileSync("fd", ["--type", "f", "--hidden", "--exclude", ".git", "--exclude", ".ensemble", "--exclude", "node_modules", "--max-depth", "4", ".", workspace.directory], { encoding: "utf8", timeout: 5000 })
      return output.split("\n").filter(Boolean).slice(0, 500).map((file) => relative(workspace.directory, file)).map((file) => ({ title: file, value: file }))
    } catch {
      return []
    }
  }

  const openCompletion = (kind: Completion["kind"], value: string, start: number) => {
    const source = kind === "agent" ? agentItems() : kind === "file" ? fileItems() : slashCommands.map(([command, description]) => ({ title: `/${command} · ${description}`, value: command }))
    setCompletion({ kind, query: value.slice(start + 1).toLowerCase(), start, cursor: 0, items: source })
  }

  const filterCompletion = (state: Completion, query: string) => {
    const source = state.kind === "agent" ? agentItems() : state.kind === "file" ? fileItems() : slashCommands.map(([command, description]) => ({ title: `/${command} · ${description}`, value: command }))
    const items = source.filter((item) => fuzzyMatch(query, item.title))
    return { ...state, query, cursor: Math.min(state.cursor, Math.max(0, items.length - 1)), items }
  }

  const closeCompletion = () => setCompletion(null)

  const selectCompletion = async () => {
    const state = completion()
    if (!state || !composerRef) return
    const item = state.items[state.cursor]
    if (!item) return
    if (state.kind === "command") {
      closeCompletion()
      await runSlashCommand(`/${item.value}`)
      return
    }
    const value = String(composerRef?.plainText ?? "")
    const token = state.kind === "agent" ? `$${item.value} ` : `@${item.value} `
    setComposerValue(`${value.slice(0, state.start)}${token}`)
    closeCompletion()
    setComposerActive(true)
    focusComposer()
  }

  const mention = () => {
    const value = String(composerRef?.plainText ?? "")
    const base = value && !value.endsWith(" ") ? `${value} ` : value
    setComposerValue(`${base}$`)
    setComposerActive(true)
    focusComposer()
    openCompletion("agent", `${base}$`, base.length)
  }

  const slashCommands = [
    ["workspace", "switch workspace"], ["agent", "mention an agent"], ["settings", "agent settings"], ["approvals", "approval inbox"],
    ["pause", "pause workspace"], ["resume", "resume workspace"], ["init", "initialize Ensemble in this workspace"], ["help", "shortcut help"],
    ["native", "open native session"], ["delegate", "delegate selected subtask"], ["retry", "retry selected subtask"], ["restart", "restart selected subtask"],
    ["cancel", "cancel selected subtask"], ["reset-ensemble", "delete all Ensemble data"], ["leave", "leave Ensemble"],
  ] as const

  const pickWorkspace = async () => {
    const selected = await openPicker("workspace", { selected: workspaceID() ? [workspaceID()!] : [] })
    const workspace = selected?.[0] ? state()?.workspaces[selected[0]] : undefined
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
      case "agent": mention(); return
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

  const handleComposerInput = (value: string) => {
    const current = completion()
    if (current) {
      const trigger = current.kind === "agent" ? "$" : current.kind === "file" ? "@" : "/"
      if (value[current.start] !== trigger) { closeCompletion(); return }
      setCompletion(filterCompletion(current, value.slice(current.start + 1).toLowerCase()))
      return
    }
    const trigger = composerTrigger(value)
    if (!trigger) return
    const start = trigger === "command" ? 0 : value.length - 1
    openCompletion(trigger, value, start)
  }

  const moveCompletion = (delta: number) => {
    setCompletion((current) => current ? { ...current, cursor: Math.max(0, Math.min(Math.max(0, current.items.length - 1), current.cursor + delta)) } : current)
  }

  const submitComposer = async (value: string) => {
    const text = value.trim()
    if (!text) return
    if (completion()) { await selectCompletion(); return }
    if (text === "/") { openCompletion("command", "/", 0); return }
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
      void refresh().then(() => syncTranscriptScroll()).catch(() => undefined)
    }, 250)
    const stopData = context.data.listen(({ details }: any) => {
      const type = typeof details?.type === "string" ? details.type : ""
      if (type === "session.text.delta" || type === "session.idle" || type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.execution.interrupted") handleNativeEvent(details)
      if (type.startsWith("rpc.ensemble.v2.")) void refresh()
    })
    const keyInput = context.renderer.keyInput
    const onKey = (event: any) => {
      if (picker()) { handlePickerKey(event); return }
      if (wizard()) { handleWizardKey(event); return }
      if (textPrompt()) {
        const name = String(event?.name ?? "")
        if (name === "escape") {
          event?.preventDefault?.(); event?.stopPropagation?.()
          finishTextPrompt(undefined)
          return
        }
        if (name === "return" || name === "enter" || name === "kpenter") {
          if (event?.shift) return
          event?.preventDefault?.(); event?.stopPropagation?.()
          finishTextPrompt(String(textPromptRef?.plainText ?? ""))
          return
        }
        return
      }
      if (!leaderMode()) return
      const name = String(event?.name ?? ""); const sequence = String(event?.sequence ?? "")
      if (name === "escape" || name === "q" || name === "?" || sequence === "?") return
      event?.preventDefault?.(); event?.stopPropagation?.()
      setLeaderMode(false)
      context.ui.toast.show({ title: "Leader", message: `Unknown shortcut: ${sequence || name}`, variant: "warning" })
    }
    keyInput.on("keypress", onKey)
    platformLayer(() => ({
      mode: "global", priority: 120,
      enabled: () => isOurRoute() && !isModal() && leaderMode(),
      commands: [
        { id: "ensemble.v2.help", title: "Ensemble: Shortcut help", bind: "?", run: () => { setLeaderMode(false); setHelpOpen(true) } },
        { id: "ensemble.v2.leave", title: "Ensemble: Leave", bind: "q", run: () => { setLeaderMode(false); context.ui.router.navigate({ type: "home" }) } },
        { id: "ensemble.v2.cancel", title: "Ensemble: Cancel leader", bind: "escape", run: () => setLeaderMode(false) },
      ],
      bindings: ["ensemble.v2.help", "ensemble.v2.leave", "ensemble.v2.cancel"],
    }))
    platformLayer(() => ({
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
        { id: "ensemble.v2.scroll.up", title: "Ensemble: Scroll transcript up", bind: "pageup", run: (_input, event) => { event?.preventDefault?.(); event?.stopPropagation?.(); transcriptScrollRef?.scrollBy?.(-messageHeight()) } },
        { id: "ensemble.v2.scroll.down", title: "Ensemble: Scroll transcript down", bind: "pagedown", run: (_input, event) => { event?.preventDefault?.(); event?.stopPropagation?.(); transcriptScrollRef?.scrollBy?.(messageHeight()) } },
        { id: "ensemble.v2.scroll.bottom", title: "Ensemble: Scroll transcript to bottom", bind: "end", enabled: () => !composerActive(), run: (_input, event) => { event?.preventDefault?.(); event?.stopPropagation?.(); jumpToBottom() } },
        { id: "ensemble.v2.init", title: "Ensemble: Init workspace", bind: "shift+i", run: () => void initEnsemble().catch(showError) },
        { id: "ensemble.v2.init.alt", title: "Ensemble: Init workspace (alternate)", bind: "ctrl+g", run: () => void initEnsemble().catch(showError) },
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
      bindings: ["ensemble.v2.leader", "ensemble.v2.left", "ensemble.v2.right", "ensemble.v2.down", "ensemble.v2.up", "ensemble.v2.enter", "ensemble.v2.compose", "ensemble.v2.new.agent", "ensemble.v2.new.workspace", "ensemble.v2.workspace.edit", "ensemble.v2.settings", "ensemble.v2.approvals", "ensemble.v2.search", "ensemble.v2.scroll.up", "ensemble.v2.scroll.down", "ensemble.v2.scroll.bottom", "ensemble.v2.init", "ensemble.v2.init.alt", "ensemble.v2.pause", "ensemble.v2.native", "ensemble.v2.delegate", "ensemble.v2.reassign", "ensemble.v2.retry", "ensemble.v2.restart", "ensemble.v2.cancel.task", "ensemble.v2.workspace.next", "ensemble.v2.workspace.prev", "ensemble.v2.agent.next", "ensemble.v2.agent.prev", "ensemble.v2.workspace.archive", "ensemble.v2.workspace.delete", "ensemble.v2.agent.archive", "ensemble.v2.agent.delete", "ensemble.v2.reset", "ensemble.v2.back"],
    }))
    platformLayer(() => ({
      mode: "global", priority: 130,
      enabled: () => isOurRoute() && composerActive() && !modal(),
      commands: [{ id: "ensemble.v2.composer.cancel", title: "Ensemble: Cancel composer", bind: "escape", run: (_input, event) => { event?.preventDefault?.(); event?.stopPropagation?.(); clearComposer() } }],
      bindings: ["ensemble.v2.composer.cancel"],
    }))
    platformLayer(() => ({
      mode: "global", priority: 140,
      enabled: () => isOurRoute() && composerActive() && completion() !== null && !modal(),
      commands: [
        { id: "ensemble.v2.completion.up", title: "Ensemble: Previous completion", bind: "up", run: () => moveCompletion(-1) },
        { id: "ensemble.v2.completion.down", title: "Ensemble: Next completion", bind: "down", run: () => moveCompletion(1) },
        { id: "ensemble.v2.completion.select", title: "Ensemble: Select completion", bind: "enter", run: () => { void selectCompletion().catch(showError) } },
        { id: "ensemble.v2.completion.cancel", title: "Ensemble: Close completion", bind: "escape", run: () => closeCompletion() },
      ],
      bindings: ["ensemble.v2.completion.up", "ensemble.v2.completion.down", "ensemble.v2.completion.select", "ensemble.v2.completion.cancel"],
    }))
    // The wizard layer is deliberately NOT wrapped in platformLayer: Cmd chords
    // are never delivered by stock macOS terminals, so its navigation uses raw
    // Ctrl+letter binds that are true on every platform.
    context.keymap.layer(() => ({
      mode: "global", priority: 160,
      enabled: () => isOurRoute() && wizard() !== null && !leaderMode(),
      commands: [
        { id: "ensemble.v2.wizard.prev", title: "Ensemble: Previous wizard step", bind: WIZARD_NAV_BINDINGS.back, run: (_input, event) => { event?.preventDefault?.(); event?.stopPropagation?.(); wizardPrev() } },
        { id: "ensemble.v2.wizard.next", title: "Ensemble: Next wizard step", bind: WIZARD_NAV_BINDINGS.next, run: (_input, event) => { event?.preventDefault?.(); event?.stopPropagation?.(); wizardNext() } },
        { id: "ensemble.v2.wizard.cancel", title: "Ensemble: Cancel wizard", bind: "escape", run: (_input, event) => { event?.preventDefault?.(); event?.stopPropagation?.(); wizardCancel() } },
      ],
      bindings: ["ensemble.v2.wizard.prev", "ensemble.v2.wizard.next", "ensemble.v2.wizard.cancel"],
    }))
    platformLayer(() => ({
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
    platformLayer(() => ({
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
    platformLayer(() => ({
      mode: "global", priority: 110,
      enabled: () => isOurRoute() && !modal() && helpOpen() && !leaderMode(),
      commands: [
        { id: "ensemble.v2.help.up", title: "Ensemble: Help page up", bind: "pageup", run: (_input, event) => { event?.preventDefault?.(); event?.stopPropagation?.(); helpScrollRef?.scrollBy?.(-10) } },
        { id: "ensemble.v2.help.down", title: "Ensemble: Help page down", bind: "pagedown", run: (_input, event) => { event?.preventDefault?.(); event?.stopPropagation?.(); helpScrollRef?.scrollBy?.(10) } },
        { id: "ensemble.v2.help.back", title: "Ensemble: Close help", bind: "escape", run: () => setHelpOpen(false) },
      ],
      bindings: ["ensemble.v2.help.up", "ensemble.v2.help.down", "ensemble.v2.help.back"],
    }))
    return () => { clearInterval(timer); keyInput.off("keypress", onKey); stopData() }
  })

  const showError = (error: any) => context.ui.toast.show({ title: "Ensemble", message: error?.message ?? String(error), variant: "error" })

  const pickerItems = createMemo<PickerItem[]>(() => {
    const state = picker()
    if (!state) return []
    return state.candidates
      .filter((item) => !state.query || fuzzyMatch(state.query, item.label))
      .map((item) => ({ id: item.id, label: item.label, selected: state.selected.has(item.id) }))
  })

  const finishPicker = (value: string[] | undefined) => {
    const state = picker()
    if (!state) return
    setPicker(null)
    setModal(false)
    state.resolve(value)
  }

  const openPicker = (mode: PickerState["mode"], options: { selected?: string[]; candidates?: string[] } = {}): Promise<string[] | undefined> => new Promise((resolve) => {
    const candidates = mode === "workspace"
      ? workspaces().map((workspace) => ({ id: workspace.id, label: `#${workspace.name} · ${workspaceLabel(workspace.directory)}` }))
      : mode === "leader"
        ? (options.candidates ?? []).map((id) => rosterAgents().find((agent) => agent.id === id)).filter((agent): agent is Agent => Boolean(agent)).map((agent) => ({ id: agent.id, label: agent.name }))
        : rosterAgents().map((agent) => ({ id: agent.id, label: agent.name }))
    const state: PickerState = {
      mode,
      title: mode === "members" ? "Workspace members" : mode === "leader" ? "Workspace leader" : "Switch workspace",
      candidates,
      selected: new Set(options.selected ?? []),
      cursor: 0,
      query: "",
      resolve,
    }
    setModal(true)
    setPicker(state)
  })

  const handlePickerKey = (event: any) => {
    const state = picker()
    if (!state) return
    const name = String(event?.name ?? "")
    const sequence = String(event?.sequence ?? "")
    event?.preventDefault?.()
    event?.stopPropagation?.()
    if (name === "escape") { finishPicker(undefined); return }
    if (name === "up") { setPicker({ ...state, cursor: Math.max(0, state.cursor - 1) }); return }
    if (name === "down") { setPicker({ ...state, cursor: Math.min(Math.max(0, pickerItems().length - 1), state.cursor + 1) }); return }
    if (name === "backspace") { setPicker({ ...state, query: state.query.slice(0, -1), cursor: 0 }); return }
    if ((name === "space" || sequence === " ") && state.mode === "members") {
      const item = pickerItems()[state.cursor]
      if (item) setPicker({ ...state, selected: toggleSelected(state.selected, item.id) })
      return
    }
    if (name === "enter" || name === "return" || name === "kpenter" || sequence === "\r" || sequence === "\n") {
      if (state.mode === "members") {
        if (state.selected.size === 0) { context.ui.toast.show({ title: "Ensemble", message: "Choose at least one member.", variant: "warning" }); return }
        finishPicker([...state.selected])
      } else {
        const item = pickerItems()[state.cursor]
        if (item) finishPicker([item.id])
      }
      return
    }
    if (sequence.length === 1 && sequence >= " " && !event?.ctrl && !event?.meta && !event?.super) {
      setPicker({ ...state, query: `${state.query}${sequence}`, cursor: 0 })
    }
  }

  const finishTextPrompt = (value: string | undefined) => {
    const state = textPrompt()
    if (!state) return
    setTextPrompt(null)
    setModal(false)
    state.resolve(value)
  }

  const openTextPrompt = (title: string, options: { description?: string; value?: string; placeholder?: string } = {}): Promise<string | undefined> => new Promise((resolve) => {
    setModal(true)
    setTextPrompt({
      title,
      description: options.description ?? "Enter submits · Shift+Enter adds a line",
      value: options.value ?? "",
      placeholder: options.placeholder ?? "",
      resolve,
    })
  })

  const directoryChoices = (): WizardOption[] => {
    const current = directoryOf(context)
    const known = workspaces().map((workspace) => workspace.directory)
    let dirs: string[] = []
    try {
      const output = execFileSync("fd", ["--type", "d", "--hidden", "--exclude", ".git", "--exclude", "node_modules", "--max-depth", "3", ".", homedir()], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })
      dirs = output.split("\n").filter(Boolean).slice(0, 500)
    } catch { dirs = [homedir()] }
    dirs.sort((a, b) => (known.includes(b) ? 1 : 0) - (known.includes(a) ? 1 : 0))
    const unique = [...new Set([current, ...known, ...dirs])]
    return [
      ...unique.map((directory) => ({
        id: directory,
        label: directory === current ? `Use current directory · ${workspaceLabel(directory)}` : workspaceLabel(directory),
        detail: known.includes(directory) ? "recent" : undefined,
      })),
      { id: "__manual__", label: "Type a path…" },
    ]
  }

  const makeWizardSteps = (state: WizardState): WizardStep[] => {
    const draft = state.draft
    if (state.flow === "workspace") {
      const members = draft.memberIDs.map((id) => rosterAgents().find((agent) => agent.id === id)).filter((agent): agent is Agent => Boolean(agent))
      const memberStep: WizardStep = { key: "members", title: "Workspace members", description: "Space toggles a member. Enter continues.", kind: "multi", options: rosterAgents().map((agent) => ({ id: agent.id, label: agent.name, detail: agent.title || undefined })) }
      const leaderStep: WizardStep = { key: "leader", title: "Workspace leader", description: "Only members selected in the previous step are listed.", kind: "pick", options: members.map((agent) => ({ id: agent.id, label: agent.name })) }
      const synthesisStep: WizardStep = { key: "synthesis", title: "Leader synthesis", description: "Combine child replies into one final answer?", kind: "choice", options: [{ id: "yes", label: "Yes — let the leader synthesize" }, { id: "no", label: "No — keep replies separate" }] }
      if (state.edit) return [memberStep, leaderStep, synthesisStep]
      return [
        { key: "directory", title: "Workspace directory", description: "Choose a project directory. Type to filter; choose Type a path for anything else.", kind: "pick", options: state.directoryOptions },
        { key: "name", title: "Workspace name", description: "Shown in the rail and the chat header.", kind: "text", placeholder: "website" },
        memberStep,
        leaderStep,
        synthesisStep,
      ]
    }
    const model = models().find((item) => `${item.providerID}/${item.modelID}` === draft.modelKey)
    const steps: WizardStep[] = [
      { key: "name", title: "Agent name", description: "Names are unique. Text wraps; Enter continues.", kind: "text", placeholder: "Nova" },
      { key: "title", title: "Agent title", description: "A short role label, such as Engineering.", kind: "text", placeholder: "Engineering" },
      { key: "role", title: "Agent role", description: "Describe how this agent works and what it owns.", kind: "text", placeholder: "You are a focused coding teammate." },
      { key: "model", title: "Main model", description: "Used for this agent's native sessions.", kind: "pick", options: state.modelOptions },
    ]
    if (model && model.variants.length > 0) {
      steps.push({ key: "variant", title: "Reasoning effort", description: "Optional model variant for this agent.", kind: "pick", options: model.variants.map((variant) => ({ id: variant, label: variant })) })
    }
    return steps
  }

  const rebuildWizard = (state: WizardState): WizardState => {
    const next = { ...state, draft: { ...state.draft } }
    next.steps = makeWizardSteps(next)
    next.index = Math.max(0, Math.min(next.index, next.steps.length - 1))
    const length = next.steps[next.index]?.options?.length ?? 1
    next.cursor = Math.max(0, Math.min(next.cursor, Math.max(0, length - 1)))
    return next
  }

  // The model catalog can be cold or refresh late; keep the open wizard's model
  // options in step with the latest snapshot instead of freezing them at open.
  createEffect(() => {
    const options = wizardModelOptions(models())
    const state = wizard()
    if (!state || state.flow !== "agent") return
    const step = state.steps.find((item) => item.key === "model")
    if (!step || sameWizardOptions(step.options ?? [], options)) return
    const draft = { ...state.draft }
    const key = wizardModelKeyFor(draft.modelKey, options)
    if (key !== draft.modelKey) {
      draft.modelKey = key
      const model = models().find((item) => `${item.providerID}/${item.modelID}` === key)
      draft.variant = model?.variants[0] ?? "none"
    }
    setWizard(rebuildWizard({ ...state, draft, modelOptions: options }))
  })

  const patchWizard = (mutate: (state: WizardState) => WizardState): WizardState | undefined => {
    const current = wizard()
    if (!current) return undefined
    const next = rebuildWizard(mutate({ ...current, draft: { ...current.draft } }))
    setWizard(next)
    return next
  }

  const wizardStep = (): WizardStep | undefined => {
    const state = wizard()
    if (!state) return undefined
    if (state.customDirectory) return { key: "directoryPath", title: "Workspace directory", description: "Type or paste a directory path. Enter continues.", kind: "text", placeholder: "~/dev/project" }
    return state.steps[state.index]
  }

  const wizardStepKey = () => {
    const state = wizard()
    const step = wizardStep()
    return state && step ? `${state.index}:${step.key}:${state.customDirectory ? "custom" : "list"}` : ""
  }

  const wizardItems = (): WizardOption[] => {
    const state = wizard()
    const step = wizardStep()
    if (!state || !step?.options) return []
    const query = state.query
    return step.options.filter((option) => option.id === "__manual__" || !query || fuzzyMatch(query, option.label))
  }

  const wizardCursor = () => {
    const state = wizard()
    const length = wizardItems().length
    return state ? Math.max(0, Math.min(state.cursor, Math.max(0, length - 1))) : 0
  }

  const wizardSelected = (step: WizardStep, id: string) => {
    const state = wizard()
    if (!state) return false
    switch (step.key) {
      case "directory": return state.draft.directory === id
      case "members": return state.draft.memberIDs.includes(id)
      case "leader": return state.draft.leaderID === id
      case "synthesis": return String(state.draft.synthesis) === id
      case "model": return state.draft.modelKey === id
      case "variant": return state.draft.variant === id
      default: return false
    }
  }

  const wizardTextValue = () => {
    const state = wizard()
    const step = wizardStep()
    if (!state || !step) return ""
    if (step.key === "directoryPath") return state.draft.directory
    return String((state.draft as any)[step.key] ?? "")
  }

  const wizardFinal = (state: WizardState) => !state.customDirectory && state.index >= state.steps.length - 1

  const validateWizard = (state: WizardState): string | undefined => {
    const draft = state.draft
    if (state.flow === "workspace") {
      if (!draft.directory.trim()) return "Choose a workspace directory."
      if (!draft.name.trim()) return "Workspace name is required."
      if (draft.memberIDs.length === 0) return "Choose at least one member."
      if (!draft.leaderID || !draft.memberIDs.includes(draft.leaderID)) return "Choose a leader from the selected members."
      return undefined
    }
    if (!draft.name.trim()) return "Agent name is required."
    if (!draft.role.trim()) return "Agent role is required."
    if (!draft.modelKey) return "Choose a main model."
    if (rosterAgents().some((agent) => agent.name.toLowerCase() === draft.name.trim().toLowerCase())) return "An agent with that name already exists."
    const model = models().find((item) => `${item.providerID}/${item.modelID}` === draft.modelKey)
    if (model && model.variants.length > 0 && !model.variants.includes(draft.variant)) return "Choose a reasoning effort."
    return undefined
  }

  const wizardInvalidIndex = (state: WizardState): number => {
    const draft = state.draft
    let key = ""
    if (state.flow === "workspace") {
      if (!draft.directory.trim()) key = "directory"
      else if (!draft.name.trim()) key = "name"
      else if (draft.memberIDs.length === 0) key = "members"
      else if (!draft.leaderID || !draft.memberIDs.includes(draft.leaderID)) key = "leader"
    } else {
      const model = models().find((item) => `${item.providerID}/${item.modelID}` === draft.modelKey)
      if (!draft.name.trim()) key = "name"
      else if (!draft.role.trim()) key = "role"
      else if (!draft.modelKey) key = "model"
      else if (model && model.variants.length > 0 && !model.variants.includes(draft.variant)) key = "variant"
    }
    const index = state.steps.findIndex((step) => step.key === key)
    return index >= 0 ? index : 0
  }

  const completeWizard = (state: WizardState, value: WizardDraft | undefined) => {
    setWizard(null)
    setModal(false)
    state.resolve(value)
  }

  const submitWizard = (state: WizardState) => {
    const error = validateWizard(state)
    if (error) {
      setWizard({ ...state, index: wizardInvalidIndex(state), error, query: "", cursor: 0 })
      return
    }
    completeWizard(state, state.draft)
  }

  const saveWizardText = (): WizardState | undefined => {
    const state = wizard()
    const step = wizardStep()
    if (!state || !step || step.kind !== "text") return state ?? undefined
    const value = String(wizardRef?.plainText ?? "")
    return patchWizard((next) => {
      if (step.key === "directoryPath") {
        next.draft.directory = value.trim()
        next.customDirectory = false
      } else {
        ;(next.draft as any)[step.key] = value
      }
      next.error = undefined
      return next
    })
  }

  const advanceWizard = (state: WizardState | undefined) => {
    if (!state) return
    if (wizardFinal(state)) { submitWizard(state); return }
    setWizard({ ...state, index: state.index + 1, query: "", cursor: 0, error: undefined, steps: makeWizardSteps(state) })
  }

  const wizardNext = () => {
    const state = wizard()
    if (!state) return
    const step = wizardStep()
    if (step?.kind === "text") {
      const saved = saveWizardText()
      if (!saved) return
      if (wizardFinal(saved)) submitWizard(saved)
      else advanceWizard(saved)
      return
    }
    if (wizardFinal(state)) submitWizard(state)
    else advanceWizard(state)
  }

  const wizardPrev = () => {
    const state = wizard()
    if (!state) return
    if (state.customDirectory) {
      setWizard({ ...state, customDirectory: false, query: "", cursor: 0, error: undefined })
      return
    }
    const step = wizardStep()
    const saved = step?.kind === "text" ? saveWizardText() : state
    const next = saved ?? state
    if (next.index <= 0) return
    setWizard({ ...next, index: next.index - 1, query: "", cursor: 0, error: undefined, steps: makeWizardSteps(next) })
  }

  const wizardMove = (delta: number) => {
    const state = wizard()
    if (!state) return
    const length = wizardItems().length
    setWizard({ ...state, cursor: Math.max(0, Math.min(Math.max(0, length - 1), wizardCursor() + delta)) })
  }

  const wizardToggle = () => {
    const state = wizard()
    const step = wizardStep()
    const item = wizardItems()[wizardCursor()]
    if (!state || !step || !item || step.kind !== "multi") return
    patchWizard((next) => {
      const selected = new Set(next.draft.memberIDs)
      if (selected.has(item.id)) selected.delete(item.id)
      else selected.add(item.id)
      next.draft.memberIDs = [...selected]
      if (!next.draft.memberIDs.includes(next.draft.leaderID)) next.draft.leaderID = next.draft.memberIDs[0] ?? ""
      next.error = undefined
      return next
    })
  }

  const wizardSelect = () => {
    const state = wizard()
    const step = wizardStep()
    const item = wizardItems()[wizardCursor()]
    if (!state || !step || !item) return
    if (step.key === "directory" && item.id === "__manual__") {
      setWizard({ ...state, customDirectory: true, query: "", cursor: 0, error: undefined })
      return
    }
    const next = patchWizard((candidate) => {
      switch (step.key) {
        case "directory": candidate.draft.directory = item.id; break
        case "leader": candidate.draft.leaderID = item.id; break
        case "synthesis": candidate.draft.synthesis = item.id === "yes"; break
        case "model": {
          candidate.draft.modelKey = item.id
          const model = models().find((value) => `${value.providerID}/${value.modelID}` === item.id)
          candidate.draft.variant = model?.variants[0] ?? "none"
          break
        }
        case "variant": candidate.draft.variant = item.id; break
      }
      candidate.error = undefined
      return candidate
    })
    if (!next) return
    if (wizardFinal(next)) submitWizard(next)
    else advanceWizard(next)
  }

  const wizardCancel = () => {
    const state = wizard()
    if (state) completeWizard(state, undefined)
  }

  const handleWizardKey = (event: any) => {
    const state = wizard()
    const step = wizardStep()
    if (!state || !step) return
    const name = String(event?.name ?? "")
    const sequence = String(event?.sequence ?? "")
    if (step.kind === "text") return
    if (name === "up") { event?.preventDefault?.(); wizardMove(-1); return }
    if (name === "down") { event?.preventDefault?.(); wizardMove(1); return }
    if (name === "backspace") { event?.preventDefault?.(); setWizard({ ...state, query: state.query.slice(0, -1), cursor: 0 }); return }
    if ((name === "space" || sequence === " ") && step.kind === "multi") { event?.preventDefault?.(); wizardToggle(); return }
    if (name === "return" || name === "enter" || name === "kpenter" || sequence === "\r" || sequence === "\n") { event?.preventDefault?.(); wizardSelect(); return }
    const filterText = wizardFilterText(event)
    if (filterText) {
      event?.preventDefault?.()
      setWizard({ ...state, query: `${state.query}${filterText}`, cursor: 0 })
    }
  }

  const openWizard = (flow: "workspace" | "agent", edit?: Workspace): Promise<WizardDraft | undefined> => new Promise((resolve) => {
    const first = rosterAgents()[0]
    const model = models()[0]
    const draft: WizardDraft = flow === "workspace"
      ? edit
        ? { directory: edit.directory, name: edit.name, memberIDs: [...edit.memberIDs], leaderID: edit.leaderID, synthesis: edit.synthesis, title: "", role: "", modelKey: "", variant: "" }
        : { directory: directoryOf(context), name: "", memberIDs: first ? [first.id] : [], leaderID: first?.id ?? "", synthesis: true, title: "", role: "", modelKey: "", variant: "" }
      : { directory: "", name: "", memberIDs: [], leaderID: "", synthesis: true, title: "", role: "", modelKey: model ? `${model.providerID}/${model.modelID}` : "", variant: model?.variants[0] ?? "none" }
    const state: WizardState = {
      flow,
      title: edit ? `Edit workspace · #${edit.name}` : flow === "workspace" ? "New workspace" : "New agent",
      draft,
      steps: [],
      index: 0,
      query: "",
      cursor: 0,
      directoryOptions: flow === "workspace" ? directoryChoices() : [],
      modelOptions: wizardModelOptions(models()),
      resolve,
      edit,
    }
    state.steps = makeWizardSteps(state)
    setModal(true)
    setTextPrompt(null)
    setPicker(null)
    setWizard(state)
  })

  const completionWindow = (state: NonNullable<ReturnType<typeof completion>>) => {
    const max = 6
    const start = Math.max(0, Math.min(state.cursor - Math.floor(max / 2), Math.max(0, state.items.length - max)))
    return { start, items: state.items.slice(start, start + max) }
  }

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
    <box flexDirection="column" width="100%" height="100%" backgroundColor={colors.bg} padding={1} gap={1}>
      <box height={3} flexDirection="row" border={["bottom"]} borderColor={colors.border} backgroundColor={colors.bg} paddingLeft={1} paddingRight={1} opacity={picker() || textPrompt() || wizard() ? 0.35 : 1}>
        <box flexDirection="column" flexGrow={1}>
          <text fg={colors.accent} bg={colors.bg} width="100%" truncate>ENSEMBLE{activeWorkspace() ? ` · #${activeWorkspace()!.name}${activeWorkspace()!.paused ? " · paused" : ""} · ${workspaceLabel(activeWorkspace()!.directory)}` : " · no workspace"}</text>
          <text fg={leaderMode() ? colors.warn : busy() ? colors.warn : colors.muted} bg={colors.bg} width="100%" truncate>{leaderMode() ? "LEADER · ? help · q leave · esc cancel" : `${status()}`}</text>
        </box>
        <Show when={gitState()}>
          <box flexDirection="row" flexShrink={0} alignItems="center">
            <text fg={colors.muted} bg={colors.bg}>git:(</text>
            <text fg={colors.text} bg={colors.bg}>{gitState()!.branch}</text>
            <Show when={gitState()!.dirty}><text fg={colors.warn} bg={colors.bg}>*</text></Show>
            <text fg={colors.muted} bg={colors.bg}>)</text>
            <Show when={gitState()!.ahead > 0}><text fg={colors.good} bg={colors.bg}> ↑{gitState()!.ahead}</text></Show>
            <Show when={gitState()!.behind > 0}><text fg={colors.bad} bg={colors.bg}> ↓{gitState()!.behind}</text></Show>
          </box>
        </Show>
      </box>
        <box flexDirection="row" flexGrow={1} gap={1} opacity={picker() || textPrompt() || wizard() ? 0.35 : 1}>
          <Rail colors={colors} items={railItems()} cursor={railCursor()} focus={focusArea() === "rail"} activeWorkspaceID={workspaceID()} state={state()} pendingApprovals={pendingApprovals().length} width={railWidth()} filter={workspaceFilter()} />
          <box flexGrow={1} minHeight={0} overflow="hidden" position="relative" border borderStyle="single" borderColor={focusArea() === "chat" ? colors.focus : colors.border} backgroundColor={colors.bg} flexDirection="column" padding={1}>
            <text fg={focusArea() === "chat" ? colors.focus : colors.muted} bg={colors.bg} width="100%" flexShrink={0} truncate>{surfaceTitle()}</text>
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
                      <Show when={finalizedLines().length > 0 || liveLine()} fallback={
                        <box flexDirection="column" padding={1} flexGrow={1}>
                          <text fg={colors.accent} bg={colors.bg} width="100%" truncate>{surface()?.kind === "agent" ? `Direct chat with ${surfaceAgent()?.name ?? "agent"}` : "Group chat"}</text>
                          <text fg={colors.muted} bg={colors.bg} width="100%" wrapMode="word">{surface()?.kind === "agent" ? "Send a direct message. It goes to this agent's native OpenCode session." : "Say something to your team. $Name mentions an agent; @path references a file."}</text>
                        </box>
                      }>
                        <box flexGrow={1} minHeight={0} flexDirection="column" width="100%" overflow="hidden">
                          <scrollbox ref={(value: any) => { transcriptScrollRef = value; if (value) queueMicrotask(() => syncTranscriptScroll()) }} flexGrow={1} minHeight={0} stickyScroll stickyStart="bottom" viewportCulling={false} width="100%">
                              <box flexDirection="column" width="100%" paddingRight={1}>
                                <For each={finalizedLines()}>{(message) => (
                                  <box flexDirection="column" marginTop={1} paddingLeft={1} paddingRight={1}>
                                    <text fg={chatAuthorColor(message)} bg={colors.bg} width="100%" truncate>{message.author}{message.kind === "task" ? " · task" : ""}{message.kind === "approval" ? " · approval · v to resolve" : ""}{message.interrupted ? " · interrupted" : ""}</text>
                                    <Show when={message.role === "agent" && syntaxStyle} fallback={
                                      <text fg={message.role === "system" ? colors.muted : colors.text} bg={colors.bg} width="100%" wrapMode="word">{renderMarkdownLines(message.text || "", Math.max(16, messageWidth())).join("\n")}</text>
                                    }>
                                      {(style) => <markdown content={message.text || " "} syntaxStyle={style()} width="100%" fg={colors.text} bg={colors.bg} conceal tableOptions={{ widthMode: "content" }} />}
                                    </Show>
                                  </box>
                                )}</For>
                              </box>
                          </scrollbox>
                          <Show when={liveLine()}>
                            <box flexShrink={0} border borderStyle="single" borderColor={colors.border} backgroundColor={colors.panel} paddingLeft={1} paddingRight={1} flexDirection="column">
                              <text fg={chatAuthorColor(liveLine()!)} bg={colors.panel} width="100%" truncate>{liveLine()!.author} · streaming…</text>
                              <text fg={colors.text} bg={colors.panel} width="100%" wrapMode="word">{liveLines().join("\n") || "…"}</text>
                            </box>
                          </Show>
                          <Show when={!atBottom()}>
                            <box position="absolute" bottom={1} right={1} zIndex={40} border borderStyle="single" borderColor={colors.focus} backgroundColor={colors.panel} paddingLeft={1} paddingRight={1} onMouseDown={() => jumpToBottom()}>
                              <text fg={colors.focus} bg={colors.panel}>↓ bottom · end</text>
                            </box>
                          </Show>
                        </box>
                      </Show>
                      <Show when={completion()}>
                        <box border borderStyle="single" borderColor={colors.leader} backgroundColor={colors.bg} flexDirection="column" height={9} minHeight={9} flexShrink={0}>
                          <text fg={colors.leader} bg={colors.bg} width="100%" truncate>{(() => {
                            const state = completion()
                            if (!state) return ""
                            const title = state.kind === "agent" ? "$ agents" : state.kind === "file" ? "@ files" : "/ commands"
                            return `${title}${state.query ? ` · ${state.query}` : ""}`
                          })()}</text>
                          <For each={[0, 1, 2, 3, 4, 5]}>{(slot) => (
                            <text fg={colors.text} bg={colors.bg} width="100%" truncate>{(() => {
                              const state = completion()
                              if (!state) return ""
                              const window = completionWindow(state)
                              const item = window.items[slot]
                              if (!item) return ""
                              return `${window.start + slot === state.cursor ? "› " : "  "}${item.title}`
                            })()}</text>
                          )}</For>
                        </box>
                      </Show>
                      <box flexShrink={0} border borderStyle="single" borderColor={composerActive() ? colors.focus : colors.border} backgroundColor={colors.bg} paddingLeft={1} paddingRight={1}>
                        <textarea ref={(value: any) => { composerRef = value }} initialValue={composerDraft()} placeholder="Message…  $agent · @file · /command" width="100%" height={composerHeight()} backgroundColor={colors.bg} textColor={colors.text} onContentChange={() => { const value = String(composerRef?.plainText ?? ""); setComposerDraft(value); if (composerRef) composerRef.height = computeComposerHeight(value, Math.max(12, messageWidth() - 6)); handleComposerInput(value) }} onSubmit={() => { void submitComposer(String(composerRef?.plainText ?? "")).catch(showError) }} keyBindings={[{ name: "return", action: "submit" }, { name: "return", shift: true, action: "newline" }, { name: "kpenter", action: "submit" }, { name: "kpenter", shift: true, action: "newline" }]} />
                      </box>
                      <text fg={composerActive() ? colors.warn : colors.muted} bg={colors.bg} width="100%" truncate>{completion() ? "↑/↓ select · enter insert · esc close" : composerActive() ? "COMPOSER · enter send · esc cancel" : "i compose · $ agent · @ file · / command"}</text>
                    </>
                  </Show>
                }>
                  <ApprovalList colors={colors} approvals={pendingApprovals()} cursor={approvalCursor()} state={state()} onResolve={resolveApproval} />
                </Show>
              }>
                <HelpView colors={colors} scrollRef={(value: any) => { helpScrollRef = value }} />
              </Show>
            }>
              <SettingsView colors={colors} agent={draft()} tab={settingsTab()} dirty={dirty()} memories={agentMemories()} memoryCursor={memoryCursor()} backupCursor={backupCursor()} skills={filteredSkills()} skillCursor={skillCursor()} skillFilter={skillFilter()} skillCatalog={skills()} />
            </Show>
          </box>
          <TaskBoard colors={colors} tasks={orderedTasks()} state={state()} cursor={taskCursor()} activeCount={activeCount()} focus={focusArea() === "tasks"} width={taskWidth()} />
        </box>
      <Show when={picker()?.mode} keyed>
        <>
          <box position="absolute" top={pickerGeometry().top} left={pickerGeometry().left} width={pickerGeometry().width} height={16} zIndex={100} backgroundColor={colors.panel} flexDirection="column">
            <box position="absolute" top={0} left={0} width="100%" height="100%" zIndex={110}>
              <PickerOverlay colors={colors} title={() => picker()!.title} query={() => picker()!.query} items={() => pickerItems()} cursor={() => picker()!.cursor} multiple={() => picker()!.mode === "members"} />
            </box>
          </box>
        </>
      </Show>
      <Show when={textPrompt()} keyed>
        <>
          <box position="absolute" top={promptGeometry().top} left={promptGeometry().left} width={promptGeometry().width} zIndex={100} height={14} border borderStyle="double" borderColor={colors.focus} backgroundColor={colors.panel} padding={1} flexDirection="column">
            <box position="absolute" top={0} left={0} width="100%" height="100%" padding={1} flexDirection="column" zIndex={110}>
            <text fg={colors.focus} bg={colors.panel} width="100%" truncate>{textPrompt()!.title}</text>
            <text fg={colors.muted} bg={colors.panel} width="100%" wrapMode="word">{textPrompt()!.description}</text>
            <box height={7} minHeight={7} flexShrink={0} border borderStyle="single" borderColor={colors.focus} backgroundColor={colors.panel} paddingLeft={1} paddingRight={1}>
              <textarea ref={(value: any) => { textPromptRef = value; queueMicrotask(() => value?.focus?.()) }} initialValue={textPrompt()!.value} placeholder={textPrompt()!.placeholder} width="100%" height={5} backgroundColor={colors.panel} textColor={colors.text} onSubmit={() => finishTextPrompt(String(textPromptRef?.plainText ?? ""))} keyBindings={[{ name: "return", action: "submit" }, { name: "return", shift: true, action: "newline" }, { name: "kpenter", action: "submit" }, { name: "kpenter", shift: true, action: "newline" }]} />
            </box>
            <text fg={colors.faint} bg={colors.panel} width="100%" truncate>enter submit · shift+enter newline · esc cancel</text>
            </box>
          </box>
        </>
      </Show>
      <Show when={wizard()}>
        <box position="absolute" top={wizardGeometry().top} left={wizardGeometry().left} width={wizardGeometry().width} height={wizardHeight} zIndex={100} border borderStyle="double" borderColor={colors.focus} backgroundColor={colors.panel} padding={1} flexDirection="column">
          <text fg={colors.focus} bg={colors.panel} width="100%" truncate>{wizard()!.title} · step {wizard()!.index + 1} / {wizard()!.steps.length}</text>
          <text fg={colors.text} bg={colors.panel} width="100%" truncate>{wizardStep()?.title ?? ""}</text>
          <text fg={colors.muted} bg={colors.panel} width="100%" wrapMode="word">{wizardStep()?.description ?? ""}</text>
          <Show when={wizardStep()?.kind === "text"} fallback={
            <box flexDirection="column" height={9}>
              <text fg={colors.faint} bg={colors.panel} width="100%" truncate>search: {wizard()!.query || "type to filter"} · {wizardItems().length} options</text>
              <Show when={(wizardStep()?.options?.length ?? 0) === 0 && wizardStep()?.key === "model"} fallback={
                <For each={[0, 1, 2, 3, 4, 5, 6, 7]}>{(slot) => (
                  <text fg={colors.text} bg={colors.panel} width="100%" truncate>{(() => {
                    const state = wizard()
                    const step = wizardStep()
                    const items = wizardItems()
                    if (!state || !step) return ""
                    const offset = pickerWindow(wizardCursor(), items.length, 8).start
                    const item = items[offset + slot]
                    if (!item) return ""
                    const marker = step.kind === "multi" ? (state.draft.memberIDs.includes(item.id) ? "[x] " : "[ ] ") : (wizardSelected(step, item.id) ? "(•) " : "( ) ")
                    return `${offset + slot === wizardCursor() ? "›" : " "} ${marker}${item.label}${item.detail ? ` · ${item.detail}` : ""}`
                  })()}</text>
                )}</For>
              }>
                <text fg={colors.warn} bg={colors.panel} width="100%" wrapMode="word">{wizardModelEmptyHint(snapshot()?.modelsError)}</text>
              </Show>
            </box>
          }>
            <Show when={wizardStepKey()} keyed>
              <box height={7} minHeight={7} flexShrink={0} border borderStyle="single" borderColor={colors.focus} backgroundColor={colors.panel} paddingLeft={1} paddingRight={1}>
                <textarea ref={(value: any) => { wizardRef = value; queueMicrotask(() => value?.focus?.()) }} initialValue={wizardTextValue()} placeholder={wizardStep()?.placeholder ?? ""} width="100%" height={5} backgroundColor={colors.panel} textColor={colors.text} onSubmit={() => wizardNext()} keyBindings={[{ name: "return", action: "submit" }, { name: "return", shift: true, action: "newline" }, { name: "kpenter", action: "submit" }, { name: "kpenter", shift: true, action: "newline" }]} />
              </box>
            </Show>
          </Show>
          <Show when={wizard()?.error}><text fg={colors.bad} bg={colors.panel} width="100%" truncate>{wizard()!.error}</text></Show>
          <box width="100%" flexDirection="row" justifyContent="center" flexShrink={0}>
            <text fg={colors.faint} bg={colors.panel} truncate>{wizardNavHint(Boolean(wizard() && wizardFinal(wizard()!)))}</text>
          </box>
        </box>
      </Show>
      <box height={3} flexDirection="column" border={["top"]} borderColor={colors.border} backgroundColor={colors.bg} opacity={picker() || textPrompt() || wizard() ? 0.35 : 1}>
        <text fg={colors.muted} bg={colors.bg} width="100%" truncate>h/l columns · j/k select · enter open · i compose · a agent · n workspace · g members · I init · v approvals</text>
        <text fg={selectedMissingSkills().length > 0 ? colors.bad : colors.faint} bg={colors.bg} width="100%" truncate>{selectedMissingSkills().length > 0 ? `! missing skills: ${selectedMissingSkills().join(", ")}` : "~ leader · / search · p pause · s settings · o native"}</text>
      </box>
    </box>
  )
}
