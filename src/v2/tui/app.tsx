import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { SyntaxStyle } from "@opentui/core"
import { usePlugin, type Plugin } from "@opencode/plugin/tui"
import { execFileSync } from "node:child_process"
import { relative } from "node:path"
import { homedir } from "node:os"
import type { Agent, Approval, ChatContext, ChatMessage, ModelOption, SkillOption, Snapshot, SnapshotState, Subtask, Workspace } from "../types.ts"
import { ApprovalList, HelpView, PickerOverlay, Rail, SettingsView, type ChatLine, type PickerItem, type RailItem, type SettingsTab } from "./components.tsx"
import { composerHeight as computeComposerHeight, composerTrigger, parseSlashCommand } from "./composer.ts"
import { agentName, fuzzyMatch, headerQueuedSuffix, missingSkills, relayTaskForMessage, renderMarkdownLines, renderVerbatimLines, resultForTask, transcriptRole, workspaceGroupLabel, workspaceLabel } from "./format.ts"
import { filterMemories } from "./memories.ts"
import { palette } from "./theme.ts"
import { pickerWindow, stablePickerItems, toggleSelected } from "./picker.ts"
import { markdownStyles } from "./syntax.ts"
import { platformBind, platformLabel } from "./platform.ts"
import { overlayGeometry, sameWizardOptions, wizardEnterAction, wizardFilterText, wizardMemoryLines, wizardModelEmptyHint, wizardModelKeyFor, wizardModelOptions, wizardNavHint, WIZARD_NAV_BINDINGS } from "./wizard.ts"
import { EMPTY_MARK, shouldRunMotion } from "./motion.ts"
import {
  chromeOwnsFocus,
  confirmFooter,
  dmEmptyDetail,
  footerLine1,
  footerLine2,
  pickerEmptyLine,
  promptFooter,
  resolveChromeFocus,
  resultFooter,
} from "./chrome.ts"
import { SKILL_VISIBLE_LIMIT, skillPageForCursor } from "./skills.ts"
import { modelPickerLabel, sortModelsByProvider } from "./settings.ts"
import { confirmKeyAction, resultKeyAction, singleChoiceValue, filterEdit } from "./overlays.ts"
import { readGitState, type GitState } from "./git.ts"
import {
  initialInteractionState,
  interactionReducer,
  visibleMessage,
  type InteractionEvent,
  type InteractionMode,
  type InteractionOverlay,
  type InteractionResult,
  type InteractionState,
} from "./interaction.ts"
import { applySendResult, clearDraft, draftFor, draftKey, updateDraft, type DraftStore, type DraftSurface } from "./drafts.ts"
import { createClipboardPort, createEditorPort, createVimBuffer } from "./vim-opentui.ts"
import { createVimRegisterStore, normalizeVimKey, type VimBuffer } from "./vim.ts"
import { composerPosition, contextLabel, listPosition, statuslineRow1, statuslineRow2, type StatuslineSurface } from "./statusline.ts"
import { normalizeAgentMentions } from "../routing.ts"
import { deriveWorkStatus, isTerminalWorkStatus } from "../queue.ts"
import { shouldApplySnapshot } from "../snapshot-guard.ts"
import {
  ACTIVITY_DEFAULT_VERB,
  MAX_VISIBLE_ACTIVITY,
  TRANSCRIPT_WINDOW,
  activityFrameForKind,
  hasActiveWork,
  isNeedsYouTask,
  mergeStreamingActivity,
  orderedWorkItems,
  queuedActivityFrame,
  selectActivityAgents,
  splitActivityGroups,
  splitLiveFinalized,
  workRowFrame,
  workRowText,
  workSummary,
  type ActivityEntry,
  type ActivityVerbKind,
  type PendingWorkAction,
} from "./workrows.ts"
import {
  accumulateCompletions,
  BUBBLE_CHROME,
  bubbleContentWidth,
  bubbleHead,
  bubbleSide,
  isBubbledRole,
  mergeTranscriptRows,
  relayPartiesForTask,
  stabilizeMergedRows,
  unifiedAuthorColor,
  type InlineCompletion,
} from "./bubbles.ts"

type Surface = { kind: "agent"; agentID: string; workspaceID?: string } | { kind: "workspace"; workspaceID: string }
type FocusArea = "rail" | "chat"
type PickerState = {
  mode: "members" | "leader" | "workspace" | "choice"
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

type ConfirmState = {
  title: string
  message: string
  resolve: (value: boolean | undefined) => void
}

type ResultState = {
  title: string
  text: string
  resolve: () => void
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
  /** Optional new-agent memories, one per line (wizard step). */
  memories: string
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
  // v5.6 T1 interaction foundation: the pure reducer owns mode, focus,
  // overlay context, command input, pending chord, selection, and the
  // transient statusline message. Focus areas elsewhere in the app read
  // through the compatibility accessors below.
  const [interaction, setInteraction] = createSignal<InteractionState>(initialInteractionState())
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
  const [resolvingApprovalID, setResolvingApprovalID] = createSignal<string | null>(null)
  // Review fix (finding 2): the work row with an in-flight Stop/Cancel (or
  // retry/restart) action shows its interim label until the terminal state
  // arrives; cleared in a finally so it can never stick.
  const [pendingWork, setPendingWork] = createSignal<{ id: string; action: PendingWorkAction } | null>(null)
  const [memoryCursor, setMemoryCursor] = createSignal(0)
  const [memoryFilter, setMemoryFilter] = createSignal("")
  const [memoryFilterEditing, setMemoryFilterEditing] = createSignal(false)
  const [skillCursor, setSkillCursor] = createSignal(0)
  const [skillFilter, setSkillFilter] = createSignal("")
  const [backupCursor, setBackupCursor] = createSignal(0)
  const [workspaceFilter, setWorkspaceFilter] = createSignal("")
  const [composerDraft, setComposerDraft] = createSignal("")
  const [composerCursor, setComposerCursor] = createSignal(0)
  const [drafts, setDrafts] = createSignal<DraftStore>({})
  const [completion, setCompletion] = createSignal<Completion | null>(null)
  const [picker, setPicker] = createSignal<PickerState | null>(null)
  const [textPrompt, setTextPrompt] = createSignal<TextPromptState | null>(null)
  const [confirm, setConfirm] = createSignal<ConfirmState | null>(null)
  const [result, setResult] = createSignal<ResultState | null>(null)
  const [skillFilterEditing, setSkillFilterEditing] = createSignal(false)
  const [motionFrame, setMotionFrame] = createSignal(0)
  const [wizard, setWizard] = createSignal<WizardState | null>(null)
  const [liveDm, setLiveDm] = createSignal<{ sessionID: string; text: string } | null>(null)
  const [atBottom, setAtBottom] = createSignal(true)
  let composerRef: any
  // Ticket #77d: identifies the current composer session. A send that is
  // still in flight must not re-focus (or wipe) a composer the user already
  // left with Escape.
  let composerEpoch = 0
  let textPromptRef: any
  let wizardRef: any
  let resultScrollRef: any
  let transcriptScrollRef: any
  let helpScrollRef: any
  let messageTimer: ReturnType<typeof setTimeout> | undefined

  // Focus/mode compatibility accessors: existing call sites keep reading
  // `focusArea()` and `composerActive()` while the reducer owns the values.
  const focusArea = (): FocusArea => (interaction().focus === "rail" ? "rail" : "chat")
  const composerActive = () => interaction().focus === "composer"
  const interactionMode = (): InteractionMode => interaction().mode
  const setFocusArea = (area: FocusArea) => { dispatchInteraction({ type: "focus.set", focus: area }) }
  const applyInteraction = (result: InteractionResult) => {
    setInteraction(result.state)
    for (const intent of result.intents) {
      if (intent.type === "focus-editor") queueMicrotask(() => composerRef?.focus?.())
      else if (intent.type === "blur-editor") { try { composerRef?.blur?.() } catch {} }
    }
  }
  const dispatchInteraction = (event: InteractionEvent): InteractionResult => {
    const result = interactionReducer(interaction(), event)
    applyInteraction(result)
    return result
  }
  const setComposerActive = (active: boolean) => {
    if (active) { dispatchInteraction({ type: "insert.enter" }); return }
    try { composerRef?.blur?.() } catch {}
    if (composerActive()) dispatchInteraction({ type: "focus.set", focus: "chat" })
  }
  const notify = (text: string, tone: "info" | "success" | "error" = "info") => {
    const at = Date.now()
    setInteraction((state) => interactionReducer(state, { type: "message.show", text, tone, at }).state)
    if (messageTimer !== undefined) clearTimeout(messageTimer)
    messageTimer = setTimeout(() => {
      setInteraction((state) => interactionReducer(state, { type: "message.clear" }).state)
      messageTimer = undefined
    }, 3_000)
  }
  onCleanup(() => { if (messageTimer !== undefined) clearTimeout(messageTimer) })

  // v5.6 T7: Normal-mode Vim editing for the composer. One internal register
  // is shared by every text buffer; the system clipboard is primary and the
  // adapter writes/reads it asynchronously with the register as fallback.
  const vimRegister = createVimRegisterStore()
  let vimClipboard: ReturnType<typeof createClipboardPort> | null = null
  let composerVim: VimBuffer | null = null
  let composerVimRef: any
  const clipboardPort = () => {
    if (!vimClipboard) vimClipboard = createClipboardPort(context.renderer)
    return vimClipboard
  }
  const composerVimBuffer = (): VimBuffer | null => {
    if (!composerRef) return null
    if (composerVim && composerVimRef === composerRef) return composerVim
    composerVimRef = composerRef
    composerVim = createVimBuffer({
      editor: createEditorPort(composerRef),
      clipboard: clipboardPort(),
      register: vimRegister,
      onMessage: (message) => notify(message.text, message.tone),
    })
    return composerVim
  }
  const syncVimChord = (chord: string | null | undefined) => {
    if (chord) dispatchInteraction({ type: "chord.set", chord })
    else if (interaction().pendingChord) dispatchInteraction({ type: "chord.clear" })
  }
  onCleanup(() => {
    vimClipboard?.dispose()
    vimClipboard = null
    composerVim = null
  })

  const currentDraftSurface = (): DraftSurface | null => {
    const current = surface()
    if (!current) return null
    return current.kind === "agent"
      ? { kind: "agent", agentID: current.agentID }
      : { kind: "workspace", workspaceID: current.workspaceID }
  }
  const currentDraftKey = () => draftKey(currentDraftSurface())

  const interactionOverlay = (): InteractionOverlay => {
    if (wizard()) return "wizard"
    if (picker() || textPrompt() || confirm() || result()) return "dialog"
    if (helpOpen()) return "help"
    if (approvalsOpen()) return "approvals"
    if (settingsAgentID()) return "settings"
    return "none"
  }
  // Overlays are contexts, not modes: keep the reducer's overlay field in
  // step so the statusline, Esc precedence, and later key catalogs agree.
  createEffect(() => {
    const overlay = interactionOverlay()
    if (interaction().overlay === overlay) return
    setInteraction((state) => interactionReducer(state, { type: "overlay.set", overlay }).state)
  })

  const lineCache = new Map<string, ChatLine>()
  let refreshSeq = 0
  let chatSeq = 0
  // Highest snapshot store version applied so far. Out-of-order RPC
  // responses (250ms poll overlapping an event-triggered refresh) must not
  // repaint older state over newer: stale versions are dropped.
  let lastAppliedVersion: number | undefined = undefined
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
  // Inline work list (ticket #56): the right-hand task board is gone, so the
  // group chat surface carries every subtask for the active workspace with
  // its assigned agent and derived lifecycle state, including distinct
  // failed/cancelled terminal rows. Active work sorts first (oldest first);
  // terminal rows are capped to the most recent so history never crowds chat.
  const orderedTasks = createMemo(() => orderedWorkItems(activeTasks(), Date.now()))
  const selectedTask = createMemo(() => orderedTasks()[taskCursor()])
  const activeCount = createMemo(() => activeTasks().filter((task) => task.state === "working").length)
  const pendingApprovals = createMemo(() => Object.values(state()?.approvals ?? {}).filter((approval) => approval.status === "pending"))
  // Review fix (finding 3): needs-you derives from existing state only —
  // the set of still-pending approval ids, matched against each task's
  // approvalID (or its interrupted flag inside isNeedsYouTask).
  const pendingApprovalIDs = createMemo(() => new Set(pendingApprovals().map((approval) => approval.id)))
  // Native mirrors block their linked subtask's session without setting
  // approvalID, so the needs-you marker needs the subtask set too.
  const nativeBlockedSubtaskIDs = createMemo(() => new Set(pendingApprovals().filter((approval) => approval.kind === "native" && approval.subtaskID).map((approval) => approval.subtaskID!)))
  const selectedApproval = createMemo(() => pendingApprovals()[approvalCursor()])
  // Ticket #77b: each agent row names the workspace it belongs to (active
  // workspace first, else its most recent membership) and whether it leads
  // it; agents outside every workspace read `homeless`.
  const workspaceForAgent = (agentID: string) => {
    const active = activeWorkspace()
    if (active && active.memberIDs.includes(agentID)) return active
    return workspaces().find((workspace) => workspace.memberIDs.includes(agentID))
  }
  const railItems = createMemo<RailItem[]>(() => {
    const query = workspaceFilter().toLowerCase()
    const agentItems: RailItem[] = rosterAgents().filter((agent) => !query || agent.name.toLowerCase().includes(query)).map((agent) => {
      const workspace = workspaceForAgent(agent.id)
      return {
        kind: "agent" as const,
        id: agent.id,
        title: agent.name,
        description: agent.title,
        workspace: workspace ? `#${workspace.name}` : "homeless",
        leader: workspace?.leaderID === agent.id,
        detail: activeWorkspace() && !activeWorkspace()!.memberIDs.includes(agent.id) ? "guest" : "",
      }
    })
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
    return workspace ? (state()?.messages[workspace.id] ?? []).slice(-TRANSCRIPT_WINDOW) : []
  })
  // Review fix (finding 5): transcript rows memoize on primitives
  // (author/role/text/kind/streaming/interrupted/queued/correlationID/
  // agentID) — never object identity — so Solid reuses rows across snapshot
  // polls and streaming chunks do not re-animate mounted rows. Documented
  // limit: a text edit that keeps every compared primitive identical (only
  // possible for fields outside this list, e.g. createdAt) reuses the old
  // row; the compared set covers every rendered field, so this cannot hide a
  // visible change. The cache is pruned to the transcript window.
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
        && previous.queued === line.queued
        && previous.correlationID === line.correlationID
        && previous.agentID === line.agentID) return previous
      const value = { ...line }
      lineCache.set(line.id, value)
      return value
    })
    for (const id of lineCache.keys()) if (!seen.has(id)) lineCache.delete(id)
    return next
  }
  // Ticket #77: `queued` now comes from the service's queue-truth derivation
  // (the queue entry is authoritative; stale persisted flags no longer win),
  // so the UI renders exactly what the service reports.
  const chatLines = createMemo<ChatLine[]>(() => {
    if (surface()?.kind === "agent") {
      const messages: ChatLine[] = (chatContext()?.messages ?? []).slice(-TRANSCRIPT_WINDOW).map((message: ChatMessage) => ({
        id: message.id,
        author: message.author,
        role: transcriptRole(message.role),
        text: message.role === "assistant" ? normalizeAgentMentions(message.text, activeAgents()).text : message.text,
        agentID: surfaceAgent()?.id,
        queued: message.queued,
        correlationID: message.correlationID,
        createdAt: message.createdAt,
      }))
      const live = liveDm()
      if (live && chatContext()?.sessionID === live.sessionID) {
        messages.push({ id: "live", author: surfaceAgent()?.name ?? "Agent", role: "agent" as const, text: live.text, agentID: surfaceAgent()?.id, createdAt: Date.now(), streaming: true })
      }
      // Slice C: the relevant direct surface carries one assignment line per
      // active assignment for this agent, so fan-out stays traceable without
      // leaving the DM. Terminal work is announced in the group chat, never
      // repeated here; each active assignment renders exactly once.
      const agent = surfaceAgent()
      if (agent) {
        const now = Date.now()
        for (const task of activeTasks().filter((item) => item.assigneeID === agent.id && !isTerminalWorkStatus(deriveWorkStatus(item, now))).sort((a, b) => a.createdAt - b.createdAt)) {
          messages.push({
            id: `assign-${task.id}`,
            author: "Ensemble",
            role: "system" as const,
            text: `→ Assigned to $${agent.name}: ${task.title || "(untitled)"}`,
            kind: "system",
            correlationID: task.turn?.correlationID ?? task.handoff?.correlationID,
            createdAt: task.createdAt,
          })
        }
        messages.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      }
      return stableLines(messages.slice(-TRANSCRIPT_WINDOW))
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
      correlationID: message.correlationID,
      taskID: message.taskID,
      createdAt: message.createdAt,
    })))
  })
  const splitTranscript = createMemo(() => splitLiveFinalized(chatLines()))
  const finalizedLines = createMemo(() => splitTranscript().finalized)
  // Active-work surface: every streaming message renders its own live row
  // with per-item text, so concurrent work stays watchable. Finalization
  // flips streaming off, which moves that id from this list into the
  // finalized transcript — one id renders in exactly one place, so live
  // items fold into the transcript in place with no duplicates or stale
  // lines. The transcript scrollbox keeps a stable identity throughout.
  const liveMessages = createMemo(() => splitTranscript().live.filter((line) => {
    if (!line.taskID) return true
    const task = state()?.subtasks[line.taskID]
    return Boolean(task && !isTerminalWorkStatus(deriveWorkStatus(task, Date.now())))
  }))
  // Slice A (#64): the WORK block is ephemeral — it mounts only while active
  // (non-terminal) work exists. `orderedTasks` is already active-only, so the
  // block condition is non-emptiness on the workspace surface. Terminal
  // outcomes render once as transcript system lines, and per-agent activity
  // lines replace the raw streaming dump: no streamed body text anywhere.
  const showWorkBlock = createMemo(
    () => surface()?.kind === "workspace" && hasActiveWork(activeTasks(), Date.now()),
  )
  // Slice C stop affordance (brief §2.5): while active work runs on the group
  // surface a run is abortable, so the composer names `Ctrl+C stop`; the hint
  // and the binding stay hidden otherwise.
  const stoppable = () => surface()?.kind === "workspace" && (showWorkBlock() ?? false)
  // Ticket #67 muted inline completions: each terminal outcome persists once
  // as a transcript row at its finish position. The accumulator folds newly
  // terminal tasks in keyed by task ID and returns the same map reference
  // when nothing new finished, so completions never regenerate per poll and
  // one outcome can never render twice. Workspace-scoped: DM surfaces carry
  // no completion feed.
  const [completionMap, setCompletionMap] = createSignal(new Map<string, InlineCompletion>())
  createEffect(() => {
    if (surface()?.kind !== "workspace") {
      if (completionMap().size > 0) setCompletionMap(new Map())
      return
    }
    const snapshot = state()
    const tasks = activeTasks()
    const now = Date.now()
    const previous = completionMap()
    const next = accumulateCompletions(previous, tasks, (task) => agentName(snapshot, task.assigneeID), now)
    if (next !== previous) setCompletionMap(next)
  })
  // One time-ordered transcript window: conversation lines interleaved with
  // inline completions by (finish/created) time. The scrollbox keeps a stable
  // identity and the live/finalized partition stays intact upstream.
  // Ticket #72 idle-quiescence: merged wrappers are referentially stabilized
  // onto the previous array (same treatment as `stableLines` inner refs), so
  // Solid's `<For>` reconciles by stable reference and idle 250ms polls mount
  // nothing. New/changed rows still mount; ordering/partition untouched.
  let previousMergedRows: ReturnType<typeof mergeTranscriptRows<ChatLine>> = []
  const mergedRows = createMemo(() => {
    const fresh = mergeTranscriptRows(finalizedLines(), [...completionMap().values()], TRANSCRIPT_WINDOW)
    const stable = stabilizeMergedRows(previousMergedRows, fresh)
    previousMergedRows = stable
    return stable
  })
  const liveActivity = createMemo(() => {
    const taskLive: ActivityEntry[] = []
    let queued: string[] = []
    if (surface()?.kind === "workspace") {
      const groups = splitActivityGroups(
        activeTasks(),
        (task) => task.assigneeID ?? "unassigned",
        (task) => agentName(state(), task.assigneeID),
        Date.now(),
        {
          pendingApprovalIDs: pendingApprovalIDs(),
          nativeBlockedIDs: nativeBlockedSubtaskIDs(),
          agentNameFor: (agentID) => agentName(state(), agentID),
        },
      )
      taskLive.push(...groups.live)
      queued = groups.queued.map((entry) => entry.label)
    }
    // Ticket #74: task-less streaming rows never synthesize the generic
    // checking verb. A fresh live row reads honest `working…` while a run
    // or recent delta exists; stale orphans and task-backed agents add
    // nothing, so finished turns leave no ghost line behind.
    const live = mergeStreamingActivity(taskLive, liveMessages(), Date.now())
    const selected = selectActivityAgents(live, MAX_VISIBLE_ACTIVITY)
    const byLabel = new Map<string, ActivityEntry>()
    for (const entry of live) if (!byLabel.has(entry.label)) byLabel.set(entry.label, entry)
    const shown = selected.shown.map((label) => {
      const entry = byLabel.get(label)
      return { label, agentID: entry?.agentID, verb: entry?.verb ?? ACTIVITY_DEFAULT_VERB, kind: entry?.kind ?? ("checking" as ActivityVerbKind) }
    })
    // Ticket #77: queued work is real work and must be visible on its own,
    // not only when something else is live. This is why a just-handoff'd
    // recipient showed nothing until their answer — or a later live run —
    // appeared: the old gate rendered queued labels only alongside live
    // ones. Queued labels now always render, deduped against live and
    // capped at the same budget.
    const queuedShown = queued
      .filter((label) => !shown.some((entry) => entry.label === label))
      .slice(0, MAX_VISIBLE_ACTIVITY)
    return {
      shown,
      queued: queuedShown,
      overflow:
        selected.overflow + Math.max(0, queued.length - queuedShown.length),
    }
  })
  // Ticket #67 one author-color source: the transcript, activity lines, and
  // relays all resolve through unifiedAuthorColor (ID first, roster-name
  // fallback), so each agent reads as the same color everywhere.
  const authorColor = (input: { agentID?: string; author: string; role: "user" | "agent" | "system" }) =>
    unifiedAuthorColor(input, state()?.agents ?? {}, rosterAgents(), colors, colors.categorical)
  const hasChatContent = createMemo(
    () =>
      finalizedLines().length > 0 ||
      liveMessages().length > 0 ||
      completionMap().size > 0 ||
      (showWorkBlock() ?? false) ||
      liveActivity().shown.length > 0 ||
      liveActivity().queued.length > 0,
  )
  // Ticket #67 unified bubble header: every row keeps author attribution;
  // relayed answers head `Answer from $Answerer · for $Asker|you` via the #55
  // correlation link, naming both parties; system/queued/task/approval/
  // interrupted rows carry concise suffix flags. No per-message timestamps.
  const headerForLine = (line: ChatLine): string => {
    let head = line.author
    if (line.role === "agent" && line.correlationID) {
      const relay = relayTaskForMessage({ correlationID: line.correlationID, agentID: line.agentID }, activeTasks())
      if (relay) {
        const parties = relayPartiesForTask(relay, (id) => agentName(state(), id))
        if (parties) return bubbleHead(line.author, parties)
      }
    }
    let header = head
    // Queued group rows are impossible by construction (group Messages carry
    // no queued flag; only DM ChatMessages do), so the `[x remove]`
    // affordance renders on direct surfaces only — `x` on the group surface
    // keeps its cancel-task binding and never offers a dead remove.
    if (line.queued) header += headerQueuedSuffix(line, surface()?.kind === "agent" ? "agent" : "workspace")
    if (line.kind === "task") header += " · task"
    if (line.kind === "approval") header += " · approval · v to resolve"
    if (line.interrupted) header += " · interrupted"
    return header
  }
  const emptyChat = () => surface()?.kind === "agent"
    ? `Direct chat with ${surfaceAgent()?.name ?? "agent"}\n\nSend a direct message. It goes to this agent's native OpenCode session.`
    : "Group chat\n\nSay something to your team. $Name mentions an agent; @path references a file. i to compose."
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
    const query = skillFilter().trim().toLowerCase()
    return skills().filter((skill) => !query || skill.id.toLowerCase().includes(query) || skill.name.toLowerCase().includes(query) || (skill.description ?? "").toLowerCase().includes(query))
  })
  // Ticket #77 skill pagination: the page is derived from the cursor, so j/k
  // scrolls through every skill and the visible window always contains the
  // cursor. PgUp/PgDn jump by one page (cursor-anchored, ordinal preserved).
  const skillPage = () => skillPageForCursor(skillCursor())
  const moveSkillPage = (delta: number) => {
    const max = Math.max(0, filteredSkills().length - 1)
    setSkillCursor((cursor) => Math.max(0, Math.min(max, cursor + delta * SKILL_VISIBLE_LIMIT)))
  }
  const filteredMemories = createMemo(() => filterMemories(agentMemories(), memoryFilter()))
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
  // Two-column layout (ticket #56): the task board is gone and the chat
  // reclaims its width. Only the rail is subtracted now.
  const messageWidth = () => Math.max(20, viewWidth() - railWidth() - 10)
  const viewHeight = () => renderSize().height
  const messageHeight = () => Math.max(6, viewHeight() - 14)
  const pickerGeometry = () => overlayGeometry(viewWidth(), viewHeight(), 16)
  const promptGeometry = () => overlayGeometry(viewWidth(), viewHeight(), 14)
  const confirmGeometry = () => overlayGeometry(viewWidth(), viewHeight(), 10)
  const resultGeometry = () => overlayGeometry(viewWidth(), viewHeight(), 18)
  const wizardHeight = 20
  const wizardGeometry = () => overlayGeometry(viewWidth(), viewHeight(), wizardHeight)

  const isOurRoute = () => {
    const route = context.ui.router.current()
    return route.type === "plugin" && route.name === "ensemble"
  }
  const isModal = () => modal() || helpOpen() || approvalsOpen() || Boolean(settingsAgentID())
  const isBusy = () => busy() || chatContext()?.busy === true

  const overlayOpen = () => picker() !== null || textPrompt() !== null || wizard() !== null || confirm() !== null || result() !== null

  // Slice E single-focus model (brief §2.10): exactly one focus-colored border
  // renders at all times. Precedence is dialog, then composer, then the
  // column — `focusArea` stays the persisted rail/chat column while the
  // composer focus state derives from `composerActive`, so the two can never
  // drift apart. Help/settings/approvals render inside the chat surface and
  // inherit its border; only true overlays steal it.
  const chromeFocus = () => resolveChromeFocus({ focusArea: focusArea(), composerActive: composerActive(), overlayOpen: overlayOpen() })

  const run = async (label: string, action: () => Promise<void>): Promise<boolean> => {
    if (busy()) return false
    setBusy(true)
    try { await action(); await refresh(); return true } catch (error: any) {
      const message = error?.message ?? String(error)
      setStatus(`${label}: ${message}`)
      notify(`${label}: ${message}`, "error")
      context.ui.toast.show({ title: "Ensemble", message: error?.message ?? String(error), variant: "error" })
      return false
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
      if (!shouldApplySnapshot(lastAppliedVersion, next.state.version)) return
      lastAppliedVersion = next.state.version
      setSnapshot(next)
      // Ticket #77d: keep the composer focused across snapshot repaints. A
      // poll that lands between typing and Enter must not silently drop the
      // key because the textarea lost focus.
      if (composerActive() && interaction().mode === "insert") queueMicrotask(() => composerRef?.focus?.())
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
          // The task column is gone (ticket #56); a persisted "tasks" focus
          // from an older session lands on the chat surface, which now owns
          // the inline work rows.
          if (history?.column) setFocusArea(history.column === ("tasks" as string) ? "chat" : history.column)
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

  const focusLeft = () => setFocusArea("rail")
  const focusRight = () => setFocusArea("chat")
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

  const chooseModel = async (current?: Pick<ModelOption, "providerID" | "modelID">): Promise<ModelOption | undefined> => {
    if (models().length === 0) throw new Error("No models are available.")
    // Slice G model picker: providers group, rows read `name — provider/model
    // · N variants`, and the current selection keeps the (•) fill mark.
    const value = await openChoice(
      "Model",
      sortModelsByProvider(models()).map((model) => ({ title: modelPickerLabel(model), value: `${model.providerID}/${model.modelID}` })),
      current ? `${current.providerID}/${current.modelID}` : undefined,
    )
    return value ? models().find((model) => `${model.providerID}/${model.modelID}` === value) : undefined
  }

  const chooseVariant = async (model: ModelOption, current?: string) => {
    if (model.variants.length === 0) return undefined
    return (await openChoice("Reasoning effort", model.variants.map((variant) => ({ title: variant, value: variant })), current)) ?? undefined
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
      // Ticket #77c: optional wizard memories are saved per line after the
      // agent exists; empty lines are skipped and never block creation.
      const memories = wizardMemoryLines(draft.memories)
      for (const text of memories) {
        await invoke(context, "memory.add", { agentID: agent.id, scope: "project", text, source: "wizard" }).catch(() => undefined)
      }
      context.ui.toast.show({ title: "Ensemble", message: `${agent.name} created. Opening a direct chat.${memories.length > 0 ? ` Saved ${memories.length} ${memories.length === 1 ? "memory" : "memories"}.` : ""}`, variant: "success" })
      openAgent(agent)
    })
  }

  const offerMoveHome = async (workspace: Workspace, members: string[]) => {
    for (const agentID of members) {
      const binding = Object.values(state()?.bindings ?? {}).find((item) => item.agentID === agentID && item.kind === "home")
      if (!binding) continue
      const move = await openConfirm(`Move ${state()?.agents[agentID]?.name} into #${workspace.name}?`, "This moves the direct-chat session with no workspace into the workspace.")
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

  const send = async (text: string, recipientIDs?: string[]): Promise<boolean> => {
    const value = text.trim()
    if (!value) return false
    const current = surface()
    if (!current) { context.ui.toast.show({ title: "Ensemble", message: "Open an agent or workspace first.", variant: "warning" }); return false }
    return run("Send message", async () => {
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
    composerVim?.invalidate()
    if (composerRef) {
      composerRef.setText?.(value)
      composerRef.cursorOffset = value.length
      composerRef.height = computeComposerHeight(value, Math.max(12, messageWidth() - 6))
    }
    setComposerDraft(value)
    setComposerCursor(value.length)
    setDrafts((store) => updateDraft(store, currentDraftKey(), value))
  }
  // Per-surface draft restoration: switching a Workspace or Direct
  // conversation swaps the textarea to that surface's draft. Mode and focus
  // changes never trigger this path, so Normal/composer focus moves keep the
  // text in place.
  let lastDraftKey: string | null | undefined = undefined
  createEffect(() => {
    const key = currentDraftKey()
    if (key === lastDraftKey) return
    lastDraftKey = key
    composerVim?.invalidate()
    const value = draftFor(drafts(), key)
    setComposerDraft(value)
    setComposerCursor(value.length)
    setCompletion(null)
    if (composerRef) {
      composerRef.setText?.(value)
      composerRef.cursorOffset = value.length
      composerRef.height = computeComposerHeight(value, Math.max(12, messageWidth() - 6))
    }
  })
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
    composerEpoch++
    composerVim?.invalidate()
    dispatchInteraction({ type: "insert.enter" })
    focusComposer()
  }
  /** Esc/Ctrl+G leave the editor but keep its surface draft. */
  const leaveComposer = () => {
    composerEpoch++
    composerVim?.invalidate()
    syncVimChord(null)
    try { composerRef?.blur?.() } catch {}
    closeCompletion()
    dispatchInteraction({ type: "leave.editor" })
  }
  /** Slash commands consume their text, so only this path clears a draft. */
  const resetComposer = () => {
    composerEpoch++
    composerVim?.invalidate()
    syncVimChord(null)
    setDrafts((store) => clearDraft(store, currentDraftKey()))
    setComposerDraft("")
    setComposerCursor(0)
    if (composerRef) {
      composerRef.setText?.("")
      composerRef.cursorOffset = 0
      composerRef.height = computeComposerHeight("", Math.max(12, messageWidth() - 6))
    }
    try { composerRef?.blur?.() } catch {}
    dispatchInteraction({ type: "leave.editor" })
  }

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
    ["pause", "pause workspace"], ["resume", "resume workspace"], ["init", "initialize workspace files (initialisation, not routing)"], ["help", "shortcut help"],
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
    const answer = await openTextPrompt("Reset Ensemble", { description: "This deletes all Ensemble data and bound native sessions. Type RESET.", placeholder: "RESET" })
    if (answer !== "RESET") return
    const handoffs = await openConfirm("Delete handoff files too?", "No preserves .ensemble/handoffs. Yes removes them.")
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
    resetComposer()
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
    // v5.6 T1: Enter sends and keeps Insert focus. The draft is owned by the
    // surface, cleared only after a successful send; busy/failed sends keep
    // it. A send can outlive the composer session, and a newer draft typed
    // while it is in flight must never be wiped.
    const key = currentDraftKey()
    const epoch = composerEpoch
    const wasBusy = busy()
    const sent = await send(text)
    if (!sent) {
      if (wasBusy) notify("Busy — draft kept", "info")
      return
    }
    notify("Message sent", "success")
    const sameKey = currentDraftKey() === key
    const unchanged = sameKey && composerDraft() === value
    if (!sameKey || unchanged) setDrafts((store) => applySendResult(store, key, true))
    if (unchanged) {
      setComposerValue("")
      if (composerActive() && composerEpoch === epoch && interaction().mode === "insert") focusComposer()
    }
  }

  const handleComposerKey = (event: any): boolean => {
    const rawName = String(event?.name ?? "")
    const ctrl = Boolean(event?.ctrl) || rawName.startsWith("ctrl+")
    const name = rawName.startsWith("ctrl+") ? rawName.slice("ctrl+".length) : rawName
    if (name === "escape" && !ctrl) {
      event?.preventDefault?.(); event?.stopPropagation?.()
      if (completion()) closeCompletion()
      else {
        const wasInsert = interaction().mode === "insert"
        dispatchInteraction({ type: "escape" })
        const vim = composerVimBuffer()
        vim?.invalidate()
        if (wasInsert) {
          vim?.normalizeCursor()
          if (composerRef) setComposerCursor(Number(composerRef.cursorOffset ?? 0))
        }
        syncVimChord(null)
      }
      return true
    }
    if (ctrl && name === "g") {
      event?.preventDefault?.(); event?.stopPropagation?.()
      leaveComposer()
      return true
    }
    // Stop-running work stays on the shared keymap layer; do not swallow it.
    if (ctrl && name === "c") return false
    if (interaction().mode === "normal") {
      event?.preventDefault?.(); event?.stopPropagation?.()
      if (name === "return" || name === "enter" || name === "kpenter") {
        composerVim?.invalidate()
        syncVimChord(null)
        void submitComposer(String(composerRef?.plainText ?? "")).catch(showError)
        return true
      }
      // Normal mode owns the composer's keys: motions, operators, insert
      // entries, yank/paste, undo/redo. Unbound keys are swallowed so app
      // actions never fire while the composer holds focus.
      const vim = composerVimBuffer()
      const key = normalizeVimKey({ name, ctrl, shift: Boolean(event?.shift) })
      if (!vim || !key) return true
      void vim
        .press(key)
        .then((outcome) => {
          syncVimChord(outcome.pendingChord)
          if (outcome.mode === "insert") {
            dispatchInteraction({ type: "insert.enter" })
            focusComposer()
          }
          if (composerRef) setComposerCursor(Number(composerRef.cursorOffset ?? 0))
        })
        .catch(showError)
      return true
    }
    return false
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
    const target = await openChoice("Delegate subtask", activeAgents().map((agent) => ({ title: agent.name, value: agent.id })))
    if (!target) return
    const title = (await openTextPrompt("Subtask title", { value: task.title }))?.trim()
    if (!title) return
    const instruction = (await openTextPrompt("Instruction", { value: task.instruction }))?.trim()
    if (!instruction) return
    await run("Delegate subtask", async () => { await invoke(context, "task.delegate", { workspaceID: workspace.id, parentID: task.id, assigneeID: target, title, instruction, mode: task.mode }) })
  }

  const reassignSelected = async () => {
    const task = selectedTask(); if (!task) return
    const target = await openChoice("Reassign subtask", activeAgents().map((agent) => ({ title: agent.name, value: agent.id })))
    if (target) await run("Reassign subtask", async () => { await invoke(context, "task.reassign", { id: task.id, assigneeID: target }) })
  }

  const openResult = async () => {
    const task = selectedTask(); if (!task) return
    const result = resultForTask(state(), task)
    if (!result) { context.ui.toast.show({ title: "Ensemble", message: "No result yet.", variant: "warning" }); return }
    await openResultModal(task.title, result.text)
  }

  const retrySelected = async () => {
    const task = selectedTask(); if (!task) return
    setPendingWork({ id: task.id, action: "retry" })
    try { await run("Retry subtask", async () => { await invoke(context, "task.retry", { id: task.id }) }) }
    finally { setPendingWork((current) => (current?.id === task.id ? null : current)) }
  }
  const restartSelected = async () => {
    const task = selectedTask(); if (!task) return
    setPendingWork({ id: task.id, action: "restart" })
    try { await run("Restart subtask", async () => { await invoke(context, "task.restart", { id: task.id }) }) }
    finally { setPendingWork((current) => (current?.id === task.id ? null : current)) }
  }
  // Review fix (finding 2): the row shows `Stopping…`/`Cancelling…` (or the
  // retry/restart analogue) while its RPC is in flight, until the terminal
  // state arrives. The finally clears it on completion AND error, so no row
  // can stick on the interim label.
  const cancelSelected = async (action: PendingWorkAction = "cancel") => {
    const task = selectedTask(); if (!task) return
    setPendingWork({ id: task.id, action })
    try { await run(action === "stop" ? "Stop subtask" : "Cancel subtask", async () => { await invoke(context, "task.cancel", { id: task.id }) }) }
    finally { setPendingWork((current) => (current?.id === task.id ? null : current)) }
  }
  // Slice C: on a direct surface with parked user-owned input, `x` removes
  // the oldest queued line (the inline `[x remove]` affordance); everywhere
  // else `x` keeps cancelling the selected subtask.
  const removeQueuedDm = async () => {
    const value = surface()
    if (value?.kind !== "agent") return
    await run("Remove queued message", async () => {
      await invoke(context, "chat.removeQueued", { agentID: value.agentID, workspaceID: value.workspaceID })
      await refreshChat()
    })
  }

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
    // Ticket #77: fresh cursors/filters so the paginated skill list always
    // opens on a row that exists.
    setSkillCursor(0); setSkillFilter(""); setSkillFilterEditing(false)
    setMemoryCursor(0); setMemoryFilter(""); setMemoryFilterEditing(false)
    setBackupCursor(0)
  }

  const closeSettings = async () => {
    if (dirty()) {
      const discard = await openConfirm("Discard changes?", "This agent has unsaved settings.")
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
      const field = (await openChoice("Edit field", [{ title: "Name", value: "name" }, { title: "Title", value: "title" }, { title: "Role", value: "role" }, { title: "Color", value: "color" }])) as string | undefined
      if (!field) return
      const value = await openTextPrompt(field, { value: agent[field as "name" | "title" | "role" | "color"] })
      if (value !== undefined) { setDraft({ ...agent, [field]: value } as Agent); setDirty(true) }
    } else if (settingsTab() === "models") {
      // Slice G selection clarity: the picker opens on the current main
      // model, so the (•) fill mark names the active selection.
      const model = await chooseModel(agent.mainModel); if (!model) return
      const variant = await chooseVariant(model)
      setDraft({ ...agent, mainModel: { providerID: model.providerID, modelID: model.modelID, variant } }); setDirty(true)
    } else if (settingsTab() === "memories") {
      const memories = filteredMemories()
      if (memories.length === 0 && memoryFilter().trim() === "") {
        const text = await openTextPrompt("Add memory", { placeholder: "The team uses pnpm." })
        if (text?.trim()) await run("Add memory", async () => { await invoke(context, "memory.add", { agentID: agent.id, workspaceID: activeWorkspace()?.id, scope: "project", text: text.trim(), source: "user" }) })
      } else {
        await editMemory()
      }
    } else if (settingsTab() === "skillbox") toggleSkill()
  }

  const toggleSkill = () => {
    const agent = draft(); const skill = filteredSkills()[skillCursor()]
    if (!agent || !skill) return
    const has = agent.skillbox.includes(skill.id)
    setDraft({ ...agent, skillbox: has ? agent.skillbox.filter((id) => id !== skill.id) : [...agent.skillbox, skill.id] }); setDirty(true)
  }

  const deleteMemory = async () => { const memory = filteredMemories()[memoryCursor()]; if (memory) await run("Delete memory", async () => { await invoke(context, "memory.delete", { id: memory.id }) }) }
  const promoteMemory = async () => { const memory = filteredMemories()[memoryCursor()]; if (memory) await run("Promote memory", async () => { await invoke(context, "memory.promote", { id: memory.id }) }) }

  const addMemory = async () => {
    const agent = draft(); if (!agent) return
    const text = await openTextPrompt("Add memory", { placeholder: "The team uses pnpm." })
    if (text?.trim()) {
      await run("Add memory", async () => { await invoke(context, "memory.add", { agentID: agent.id, workspaceID: activeWorkspace()?.id, scope: "project", text: text.trim(), source: "user" }) })
      setMemoryCursor(Math.max(0, filteredMemories().length - 1))
    }
  }

  const editMemory = async () => {
    const memory = filteredMemories()[memoryCursor()]; if (!memory) return
    const text = await openTextPrompt("Edit memory", { value: memory.text })
    if (text === undefined) return
    if (text.trim() === "" || text === memory.text) return
    await run("Edit memory", async () => { await invoke(context, "memory.update", { id: memory.id, text: text.trim() }) })
  }

  const resolveApproval = async (approval: Approval) => {
    const options = approval.kind === "interrupted" ? [{ title: "Resume work", value: "approve" }, { title: "Discard", value: "reject" }] : approval.kind === "ask_person" ? [{ title: "Answer", value: "approve" }, { title: "Reject", value: "reject" }] : [{ title: "Approve", value: "approve" }, { title: "Reject", value: "reject" }]
    const value = await openChoice(approval.title, options)
    if (!value) return
    let resolution: string | undefined
    if (value === "approve" && approval.kind === "ask_person") {
      resolution = (await openTextPrompt("Your answer", { placeholder: "What should the agent do?" }))?.trim()
      if (!resolution) return
    }
    // Slice E: the acted-on row shows `Resolving…` while its resolve RPC is
    // in flight, then the inbox refreshes and the row leaves.
    setResolvingApprovalID(approval.id)
    try {
      await run("Resolve approval", async () => { await invoke(context, "approval.resolve", { id: approval.id, approve: value === "approve", resolution }) })
    } finally {
      setResolvingApprovalID((current) => (current === approval.id ? null : current))
    }
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
    // Workspace search stays inside Ensemble surfaces: the workspace picker
    // filters inline and opens the chosen workspace.
    await pickWorkspace()
  }

  const archiveWorkspace = async () => {
    const workspace = activeWorkspace(); if (!workspace) return
    if (!(await openConfirm(`Archive #${workspace.name}?`, "History is preserved."))) return
    await run("Archive workspace", async () => { await invoke(context, "workspace.archive", { id: workspace.id }); setSurface(null); setWorkspaceID(null) })
  }
  const deleteWorkspace = async () => {
    const workspace = activeWorkspace(); if (!workspace) return
    if (!(await openConfirm(`Delete #${workspace.name}?`, "Removes workspace data."))) return
    const deleteNativeSessions = await openConfirm("Delete native sessions too?", "No preserves them for inspection.")
    await run("Delete workspace", async () => { await invoke(context, "workspace.delete", { id: workspace.id, deleteNativeSessions: Boolean(deleteNativeSessions) }); setSurface(null); setWorkspaceID(null) })
  }
  const archiveSelectedAgent = async () => {
    const agent = selectedAgent(); if (!agent) return
    const workspace = activeWorkspace()
    if (!(await openConfirm(`Archive ${agent.name}?`, "History is preserved."))) return
    await run("Archive agent", async () => { await invoke(context, "agent.archive", { id: agent.id }); setSurface(null) })
  }
  const deleteSelectedAgent = async () => {
    const agent = selectedAgent(); if (!agent) return
    if (!(await openConfirm(`Delete ${agent.name}?`, "Removes the agent profile and memory."))) return
    const deleteNativeSessions = await openConfirm("Delete native sessions too?", "No preserves them for inspection.")
    await run("Delete agent", async () => { await invoke(context, "agent.delete", { id: agent.id, deleteNativeSessions: Boolean(deleteNativeSessions) }); setSurface(null) })
  }

  // Task actions stay keyboard-first from the inline work rows: with no task
  // column, j/k in the chat surface moves the work selection and the
  // d/t/enter/r/R/x/o bindings below act on the selected row.
  const moveCursor = (delta: number) => {
    if (focusArea() === "chat") moveTask(delta)
    else if (focusArea() === "rail") moveRail(delta)
  }

  const moveSettingsCursor = (delta: number) => {
    if (settingsTab() === "memories") setMemoryCursor((cursor) => Math.max(0, Math.min(Math.max(0, filteredMemories().length - 1), cursor + delta)))
    else if (settingsTab() === "models") setBackupCursor((cursor) => Math.max(0, Math.min(Math.max(0, (draft()?.backupModels.length ?? 1) - 1), cursor + delta)))
    else if (settingsTab() === "skillbox") setSkillCursor((cursor) => Math.max(0, Math.min(Math.max(0, filteredSkills().length - 1), cursor + delta)))
  }

  // Slice B motion gate: the 4 fps clock runs only while something is in
  // flight (busy, live streaming text, task-backed activity lines, or the
  // ephemeral WORK block) or composing — and never under reduced motion
  // (`ENSEMBLE_REDUCED_MOTION`/`NO_COLOR`), where every animated cell pins
  // to its frame-0 glyph. Idle screens hold tick 0 with no interval.
  const motionOn = () =>
    shouldRunMotion(
      {
        busy: isBusy(),
        live: liveMessages().length > 0 || (showWorkBlock() ?? false) || liveActivity().shown.length > 0,
        composerActive: composerActive(),
      },
      process.env,
    )

  // Transcript text never dims for entrance motion (ticket #77): color
  // dimming read as a wrong/muted author name while the Markdown body kept
  // full color, and the modulo motion tick could re-dim old rows. Attribution
  // and body colors are stable; only frames/glyphs animate.

  // Idle-quiescent frame clock (slice B): one 4 fps interval per
  // motion-active epoch. Snapshot polls re-run this effect ~4×/s, so the
  // interval is reconciled by boolean transition only — never cleared and
  // recreated while motion stays active. Cleanup clears it on
  // finalize/unmount/route-leave, and the still frame (tick 0) holds
  // whenever motion is off, including reduced motion.
  let clockTimer: ReturnType<typeof setInterval> | undefined;
  let clockRunning = false;
  const syncClock = () => {
    const want = isOurRoute() ? motionOn() : false
    if (want === clockRunning) return
    clockRunning = want
    if (clockTimer !== undefined) { clearInterval(clockTimer); clockTimer = undefined }
    if (want) {
      // Ticket #77: monotonic tick — never modulo-wrapped. Frame helpers do
      // their own modular cycle; wrapping here could make a new tick equal an
      // old mount tick and re-trigger stale state.
      clockTimer = setInterval(() => setMotionFrame((frame) => frame + 1), 250)
    } else {
      setMotionFrame(0)
    }
  };
  onCleanup(() => {
    if (clockTimer !== undefined) { clearInterval(clockTimer); clockTimer = undefined }
    clockRunning = false
  })
  createEffect(() => {
    syncClock()
  })

  createEffect(() => {
    if (!restored()) return
    void persistHistory(surface())
  })

  onMount(() => {
    void refresh()
    const timer = setInterval(() => {
      if (surface()?.kind === "agent") void refreshChat()
      void refresh().then(() => syncTranscriptScroll()).catch(() => undefined)
      // Reconcile the motion clock on the same proven tick: snapshot polls
      // are the heartbeat that effect reactivity alone cannot guarantee, so
      // the 4 fps interval starts the same cycle its epoch begins.
      syncClock()
    }, 250)
    const stopData = context.data.listen(({ details }: any) => {
      const type = typeof details?.type === "string" ? details.type : ""
      if (type === "session.text.delta" || type === "session.idle" || type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.execution.interrupted") handleNativeEvent(details)
      // Durable writes emit the `changed` event with the affected scope
      // (workspace, subtask, correlation, kind); the UI invalidates and
      // refreshes on it — no navigation required. An event that is not newer
      // than the applied snapshot is already visible, so it skips the fetch.
      // The 250ms poll below stays as a fallback.
      if (type === "rpc.ensemble.v2.changed") {
        const eventVersion = typeof details?.version === "number" ? details.version : typeof details?.data?.version === "number" ? details.data.version : undefined
        if (eventVersion !== undefined && lastAppliedVersion !== undefined && eventVersion <= lastAppliedVersion) return
        void refresh()
        return
      }
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
      if (confirm()) { handleConfirmKey(event); return }
      if (result()) { handleResultKey(event); return }
      if (skillFilterEditing()) { handleSkillFilterKey(event); return }
      if (memoryFilterEditing()) { handleMemoryFilterKey(event); return }
      // v5.6 T1: the composer owns its Esc ladder at the raw key layer — the
      // focused textarea consumes Escape before the keymap layer can.
      if (composerActive() && !isModal() && handleComposerKey(event)) return
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
      enabled: () => isOurRoute() && !isModal() && !leaderMode() && !composerActive() && wizard() === null && !skillFilterEditing() && !memoryFilterEditing(),
      commands: [
        { id: "ensemble.v2.leader", title: "Ensemble: Leader key", bind: "~", run: () => setLeaderMode(true) },
        { id: "ensemble.v2.left", title: "Ensemble: Column left", bind: "h", run: () => focusLeft() },
        { id: "ensemble.v2.right", title: "Ensemble: Column right", bind: "l", run: () => focusRight() },
        { id: "ensemble.v2.down", title: "Ensemble: Down", bind: "j", run: () => moveCursor(1) },
        { id: "ensemble.v2.up", title: "Ensemble: Up", bind: "k", run: () => moveCursor(-1) },
        { id: "ensemble.v2.enter", title: "Ensemble: Open chat / work result", bind: "enter", run: () => { if (focusArea() === "rail") void enterRail().catch(showError); else void openResult().catch(showError) } },
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
        { id: "ensemble.v2.init", title: "Ensemble: Init workspace files (initialisation, not routing)", bind: "shift+i", run: () => void initEnsemble().catch(showError) },
        { id: "ensemble.v2.init.alt", title: "Ensemble: Init workspace files, alternate binding (initialisation, not routing)", bind: "ctrl+g", run: () => void initEnsemble().catch(showError) },
        { id: "ensemble.v2.pause", title: "Ensemble: Pause workspace", bind: "p", run: () => void togglePause().catch(showError) },
        { id: "ensemble.v2.native", title: "Ensemble: Native session", bind: "o", run: () => openNative() },
        { id: "ensemble.v2.delegate", title: "Ensemble: Delegate", bind: "d", run: () => void delegateSelected().catch(showError) },
        { id: "ensemble.v2.reassign", title: "Ensemble: Reassign", bind: "t", run: () => void reassignSelected().catch(showError) },
        { id: "ensemble.v2.retry", title: "Ensemble: Retry", bind: "r", run: () => void retrySelected().catch(showError) },
        { id: "ensemble.v2.restart", title: "Ensemble: Restart", bind: "shift+r", run: () => void restartSelected().catch(showError) },
        { id: "ensemble.v2.cancel.task", title: "Ensemble: Cancel subtask", bind: "x", run: () => {
          if (surface()?.kind === "agent" && (chatContext()?.queued ?? 0) > 0) void removeQueuedDm().catch(showError)
          else void cancelSelected().catch(showError)
        } },
        { id: "ensemble.v2.workspace.next", title: "Ensemble: Next workspace", bind: "w", run: () => cycleWorkspace(1) },
        { id: "ensemble.v2.workspace.prev", title: "Ensemble: Previous workspace", bind: "shift+w", run: () => cycleWorkspace(-1) },
        { id: "ensemble.v2.agent.next", title: "Ensemble: Next agent", bind: "z", run: () => cycleAgent(1) },
        { id: "ensemble.v2.agent.prev", title: "Ensemble: Previous agent", bind: "shift+z", run: () => cycleAgent(-1) },
        { id: "ensemble.v2.workspace.archive", title: "Ensemble: Archive workspace", bind: "ctrl+w", run: () => void archiveWorkspace().catch(showError) },
        { id: "ensemble.v2.workspace.delete", title: "Ensemble: Delete workspace", bind: "ctrl+shift+w", run: () => void deleteWorkspace().catch(showError) },
        { id: "ensemble.v2.agent.archive", title: "Ensemble: Archive agent", bind: "ctrl+a", run: () => void archiveSelectedAgent().catch(showError) },
        { id: "ensemble.v2.agent.delete", title: "Ensemble: Delete agent", bind: "ctrl+shift+a", run: () => void deleteSelectedAgent().catch(showError) },
        { id: "ensemble.v2.reset", title: "Ensemble: Reset", bind: "ctrl+shift+delete", run: () => void resetEnsemble().catch(showError) },
        { id: "ensemble.v2.back", title: "Ensemble: Clear filter", bind: "escape", run: () => { if (workspaceFilter()) setWorkspaceFilter("") } },
      ],
      bindings: ["ensemble.v2.leader", "ensemble.v2.left", "ensemble.v2.right", "ensemble.v2.down", "ensemble.v2.up", "ensemble.v2.enter", "ensemble.v2.compose", "ensemble.v2.new.agent", "ensemble.v2.new.workspace", "ensemble.v2.workspace.edit", "ensemble.v2.settings", "ensemble.v2.approvals", "ensemble.v2.search", "ensemble.v2.scroll.up", "ensemble.v2.scroll.down", "ensemble.v2.scroll.bottom", "ensemble.v2.init", "ensemble.v2.init.alt", "ensemble.v2.pause", "ensemble.v2.native", "ensemble.v2.delegate", "ensemble.v2.reassign", "ensemble.v2.retry", "ensemble.v2.restart", "ensemble.v2.cancel.task", "ensemble.v2.workspace.next", "ensemble.v2.workspace.prev", "ensemble.v2.agent.next", "ensemble.v2.agent.prev", "ensemble.v2.workspace.archive", "ensemble.v2.workspace.delete", "ensemble.v2.agent.archive", "ensemble.v2.agent.delete", "ensemble.v2.reset", "ensemble.v2.back"],
    }))
    platformLayer(() => ({
      mode: "global", priority: 130,
      enabled: () => isOurRoute() && composerActive() && !isModal() && wizard() === null,
      commands: [
        { id: "ensemble.v2.composer.cancel", title: "Ensemble: Composer Esc ladder", bind: "escape", run: (_input, event) => { event?.preventDefault?.(); event?.stopPropagation?.(); if (completion()) closeCompletion(); else dispatchInteraction({ type: "escape" }) } },
        // Host Escape handling can swallow the key while a native run is
        // active; Ctrl+G is the reliable leave-composer chord.
        { id: "ensemble.v2.composer.leave", title: "Ensemble: Leave composer", bind: "ctrl+g", run: (_input, event) => { event?.preventDefault?.(); event?.stopPropagation?.(); leaveComposer() } },
        { id: "ensemble.v2.composer.stop", title: "Ensemble: Stop running work", bind: "ctrl+c", enabled: () => stoppable(), run: (_input, event) => { event?.preventDefault?.(); event?.stopPropagation?.(); void cancelSelected("stop").catch(showError) } },
      ],
      bindings: ["ensemble.v2.composer.cancel", "ensemble.v2.composer.leave", "ensemble.v2.composer.stop"],
    }))
    platformLayer(() => ({
      mode: "global", priority: 140,
      enabled: () => isOurRoute() && composerActive() && completion() !== null && !modal() && wizard() === null,
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
      enabled: () => isOurRoute() && !modal() && Boolean(settingsAgentID()) && !leaderMode() && wizard() === null && !skillFilterEditing() && !memoryFilterEditing(),
      commands: [
        { id: "ensemble.v2.tab", title: "Ensemble: Settings tab", bind: "tab", run: () => { const tabs: SettingsTab[] = ["general", "models", "memories", "skillbox"]; setSettingsTab(tabs[(tabs.indexOf(settingsTab()) + 1) % tabs.length]) } },
        { id: "ensemble.v2.edit", title: "Ensemble: Edit", bind: "e", run: () => void editField().catch(showError) },
        { id: "ensemble.v2.memory.new", title: "Ensemble: New memory", bind: "n", enabled: () => settingsTab() === "memories", run: () => void addMemory().catch(showError) },
        { id: "ensemble.v2.backup.add", title: "Ensemble: Add backup", bind: "b", enabled: () => settingsTab() === "models", run: () => void addBackup().catch(showError) },
        { id: "ensemble.v2.backup.up", title: "Ensemble: Move backup up", bind: "shift+up", enabled: () => settingsTab() === "models", run: () => reorderBackup("up") },
        { id: "ensemble.v2.backup.down", title: "Ensemble: Move backup down", bind: "shift+down", enabled: () => settingsTab() === "models", run: () => reorderBackup("down") },
        { id: "ensemble.v2.backup.remove", title: "Ensemble: Remove backup", bind: "backspace", enabled: () => settingsTab() === "models", run: () => removeBackup() },
        { id: "ensemble.v2.save", title: "Ensemble: Save", bind: "s", run: () => void saveSettings().catch(showError) },
        { id: "ensemble.v2.skill.prev", title: "Ensemble: Previous skill page", bind: "pageup", enabled: () => settingsTab() === "skillbox", run: () => moveSkillPage(-1) },
        { id: "ensemble.v2.skill.next", title: "Ensemble: Next skill page", bind: "pagedown", enabled: () => settingsTab() === "skillbox", run: () => moveSkillPage(1) },
        { id: "ensemble.v2.skill", title: "Ensemble: Toggle skill", bind: "space", enabled: () => settingsTab() === "skillbox", run: () => toggleSkill() },
        { id: "ensemble.v2.filter", title: "Ensemble: Filter skills", bind: "ctrl+f", enabled: () => settingsTab() === "skillbox", run: () => { setSkillFilterEditing(true); setSkillCursor(0) } },
        { id: "ensemble.v2.memory.filter", title: "Ensemble: Filter memories", bind: "ctrl+f", enabled: () => settingsTab() === "memories", run: () => { setMemoryFilterEditing(true); setMemoryCursor(0) } },
        { id: "ensemble.v2.memory.filter.slash", title: "Ensemble: Filter memories", bind: "/", enabled: () => settingsTab() === "memories", run: () => { setMemoryFilterEditing(true); setMemoryCursor(0) } },
        { id: "ensemble.v2.memory.delete", title: "Ensemble: Delete memory", bind: "ctrl+d", enabled: () => settingsTab() === "memories", run: () => void deleteMemory().catch(showError) },
        { id: "ensemble.v2.memory.promote", title: "Ensemble: Promote memory", bind: "ctrl+p", enabled: () => settingsTab() === "memories", run: () => void promoteMemory().catch(showError) },
        { id: "ensemble.v2.settings.up", title: "Ensemble: Up", bind: "up", run: () => moveSettingsCursor(-1) },
        { id: "ensemble.v2.settings.down", title: "Ensemble: Down", bind: "down", run: () => moveSettingsCursor(1) },
        { id: "ensemble.v2.settings.back", title: "Ensemble: Close settings", bind: "escape", run: () => void closeSettings() },
      ],
      bindings: ["ensemble.v2.tab", "ensemble.v2.edit", "ensemble.v2.memory.new", "ensemble.v2.backup.add", "ensemble.v2.backup.up", "ensemble.v2.backup.down", "ensemble.v2.backup.remove", "ensemble.v2.save", "ensemble.v2.skill.prev", "ensemble.v2.skill.next", "ensemble.v2.skill", "ensemble.v2.filter", "ensemble.v2.memory.filter", "ensemble.v2.memory.filter.slash", "ensemble.v2.memory.delete", "ensemble.v2.memory.promote", "ensemble.v2.settings.up", "ensemble.v2.settings.down", "ensemble.v2.settings.back"],
    }))
    platformLayer(() => ({
      mode: "global", priority: 110,
      enabled: () => isOurRoute() && !modal() && approvalsOpen() && !leaderMode() && wizard() === null,
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
      enabled: () => isOurRoute() && !modal() && helpOpen() && !leaderMode() && wizard() === null,
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

  // Review fix (finding 5): picker rows are value-compared, so the row
  // array keeps identity across snapshot polls unless a value changed.
  let pickerItemsPrev: PickerItem[] = []
  const pickerItems = createMemo<PickerItem[]>(() => {
    const state = picker()
    if (!state) return []
    const next = state.candidates
      .filter((item) => !state.query || fuzzyMatch(state.query, item.label))
      .map((item) => ({ id: item.id, label: item.label, selected: state.selected.has(item.id) }))
    const stable = stablePickerItems(pickerItemsPrev, next)
    pickerItemsPrev = stable as PickerItem[]
    return pickerItemsPrev
  })

  const finishPicker = (value: string[] | undefined) => {
    const state = picker()
    if (!state) return
    setPicker(null)
    setModal(false)
    state.resolve(value)
  }

  const openPicker = (mode: PickerState["mode"], options: { selected?: string[]; candidates?: string[] } = {}): Promise<string[] | undefined> => new Promise((resolve) => {
    // Overlays never steal Enter/focus while a wizard owns the keyboard.
    if (wizard()) { resolve(undefined); return }
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
        const item = singleChoiceValue(pickerItems(), state.cursor)
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
    if (wizard()) { resolve(undefined); return }
    setModal(true)
    setTextPrompt({
      title,
      description: options.description ?? "Enter submits · Shift+Enter adds a line",
      value: options.value ?? "",
      placeholder: options.placeholder ?? "",
      resolve,
    })
  })

  const openChoice = (title: string, options: Array<{ title: string; value: string }>, current?: string): Promise<string | undefined> => new Promise((resolve) => {
    if (wizard()) { resolve(undefined); return }
    const previous = leaderMode()
    setLeaderMode(false)
    setModal(true)
    setCompletion(null)
    setPicker({
      mode: "choice",
      title,
      candidates: options.map((option) => ({ id: option.value, label: option.title })),
      selected: new Set(current !== undefined ? [current] : []),
      cursor: Math.max(0, options.findIndex((option) => option.value === current)),
      query: "",
      resolve: (value) => { setLeaderMode(previous); resolve(value?.[0]) },
    })
  })

  const openConfirm = (title: string, message: string): Promise<boolean | undefined> => new Promise((resolve) => {
    if (wizard()) { resolve(undefined); return }
    const previous = leaderMode()
    setLeaderMode(false)
    setModal(true)
    setCompletion(null)
    setComposerActive(false)
    try { composerRef?.blur?.() } catch {}
    setConfirm({
      title,
      message,
      resolve: (value) => { setConfirm(null); setModal(false); setLeaderMode(previous); resolve(value) },
    })
  })

  const finishConfirm = (value: boolean | undefined) => {
    const state = confirm()
    if (!state) return
    state.resolve(value)
  }

  const handleConfirmKey = (event: any) => {
    const action = confirmKeyAction(String(event?.name ?? ""), String(event?.sequence ?? ""))
    event?.preventDefault?.()
    event?.stopPropagation?.()
    if (!action) return
    finishConfirm(action === "confirm")
  }

  const openResultModal = (title: string, text: string): Promise<void> => new Promise((resolve) => {
    if (wizard()) { resolve(); return }
    const previous = leaderMode()
    setLeaderMode(false)
    setModal(true)
    setCompletion(null)
    setComposerActive(false)
    try { composerRef?.blur?.() } catch {}
    setResult({
      title,
      text,
      resolve: () => { setResult(null); setModal(false); setLeaderMode(previous); resolve() },
    })
  })

  const finishResultModal = () => {
    const state = result()
    if (!state) return
    state.resolve()
  }

  const handleResultKey = (event: any) => {
    const action = resultKeyAction(String(event?.name ?? ""))
    event?.preventDefault?.()
    event?.stopPropagation?.()
    if (!action) return
    if (action === "dismiss") { finishResultModal(); return }
    const delta = action === "up" ? -3 : action === "down" ? 3 : action === "pageUp" ? -messageHeight() : messageHeight()
    try { resultScrollRef?.scrollBy?.(delta) } catch {}
  }

  const handleSkillFilterKey = (event: any) => {
    const next = filterEdit(skillFilter(), {
      name: String(event?.name ?? ""),
      sequence: String(event?.sequence ?? ""),
      ctrl: Boolean(event?.ctrl),
      meta: Boolean(event?.meta),
      super: Boolean(event?.super),
    })
    event?.preventDefault?.()
    event?.stopPropagation?.()
    setSkillFilter(next.query)
    setSkillCursor(0)
    if (next.done) setSkillFilterEditing(false)
  }

  const handleMemoryFilterKey = (event: any) => {
    const next = filterEdit(memoryFilter(), {
      name: String(event?.name ?? ""),
      sequence: String(event?.sequence ?? ""),
      ctrl: Boolean(event?.ctrl),
      meta: Boolean(event?.meta),
      super: Boolean(event?.super),
    })
    event?.preventDefault?.()
    event?.stopPropagation?.()
    setMemoryFilter(next.query)
    setMemoryCursor(0)
    if (next.done) setMemoryFilterEditing(false)
  }

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
      { key: "memories", title: "Agent memories (optional)", description: "One memory per line. Shift+Enter adds a line; Enter continues. Leave empty to skip.", kind: "text", placeholder: "The team uses pnpm.\nNever edit generated files." },
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
    if (name === "return" || name === "enter" || name === "kpenter" || sequence === "\r" || sequence === "\n") {
      const action = wizardEnterAction(step.kind, wizardFinal(state))
      if (action === "text") return
      event?.preventDefault?.()
      event?.stopPropagation?.()
      closeCompletion()
      if (wizardItems().length === 0) return
      if (action === "continue") { advanceWizard(state); return }
      wizardSelect()
      return
    }
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
        ? { directory: edit.directory, name: edit.name, memberIDs: [...edit.memberIDs], leaderID: edit.leaderID, synthesis: edit.synthesis, title: "", role: "", memories: "", modelKey: "", variant: "" }
        : { directory: directoryOf(context), name: "", memberIDs: first ? [first.id] : [], leaderID: first?.id ?? "", synthesis: true, title: "", role: "", memories: "", modelKey: "", variant: "" }
      : { directory: "", name: "", memberIDs: [], leaderID: "", synthesis: true, title: "", role: "", memories: "", modelKey: model ? `${model.providerID}/${model.modelID}` : "", variant: model?.variants[0] ?? "none" }
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
    // An open wizard owns the keyboard: close the composer completion popup,
    // blur the composer, and gate the competing key layers (each layer's
    // `enabled` additionally requires `wizard() === null`) so Enter can never
    // open the completion popup or another search surface while the wizard
    // is open.
    setModal(true)
    setTextPrompt(null)
    setPicker(null)
    setCompletion(null)
    setComposerActive(false)
    try { composerRef?.blur?.() } catch {}
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
      return `${surfaceAgent()?.name ?? "Agent"} · direct${workspace ? ` · #${workspace.name}` : " · no workspace"}`
    }
    const workspace = state()?.workspaces[current.workspaceID]
    if (!workspace) return "Workspace"
    const leader = state()?.agents[workspace.leaderID]?.name ?? workspace.leaderID
    return `#${workspace.name} · ${workspaceLabel(workspace.directory)} · leader ${leader}`
  }

  const statusSurface = (): StatuslineSurface => surface()?.kind ?? "none"
  const statusContext = () => contextLabel({ focus: interaction().focus, overlay: interaction().overlay, surface: statusSurface() })
  const statusPosition = () => {
    if (composerActive()) return composerPosition(composerDraft(), composerCursor())
    if (focusArea() === "rail") return listPosition(railCursor(), railItems().length)
    if (showWorkBlock() ?? false) return listPosition(taskCursor(), orderedTasks().length)
    return atBottom() ? "100%" : "scrolled"
  }
  const statusHints = () => {
    if (leaderMode()) return "? help · q leave · esc cancel"
    if (selectedMissingSkills().length > 0) {
      return footerLine2({ focus: chromeFocus(), hasWork: showWorkBlock() ?? false, missingSkills: selectedMissingSkills() })
    }
    if (interaction().overlay === "settings") return "esc close · tab tabs · e edit · s save"
    if (interaction().overlay === "approvals") return "enter resolve · esc close"
    if (interaction().overlay === "help") return "esc close"
    if (composerActive()) {
      return interaction().mode === "insert"
        ? footerLine1({ focus: "composer", hasWork: showWorkBlock() ?? false })
        : "i insert · h/j/k/l · x/d · yy/p · enter send · esc chat"
    }
    const hints = footerLine1({ focus: chromeFocus(), hasWork: showWorkBlock() ?? false })
    return interaction().overlay === "none" ? `${hints} · ~ leader` : hints
  }
  const statusMessage = () => visibleMessage(interaction(), Date.now())?.text ?? null

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={colors.bg} padding={1} gap={1}>
      <box height={3} flexDirection="row" border={["bottom"]} borderColor={colors.border} backgroundColor={colors.bg} paddingLeft={1} paddingRight={1} opacity={overlayOpen() ? 0.35 : 1}>
        <box flexDirection="column" flexGrow={1}>
          <text fg={colors.accent} bg={colors.bg} width="100%" truncate>ENSEMBLE{activeWorkspace() ? ` · #${activeWorkspace()!.name}${activeWorkspace()!.paused ? " · paused" : ""} · ${workspaceLabel(activeWorkspace()!.directory)}` : " · no workspace"}</text>
          <text fg={leaderMode() ? colors.warn : busy() ? colors.warn : colors.muted} bg={colors.bg} width="100%" truncate>{leaderMode() ? "LEADER · ? help · q leave · esc cancel" : `${isBusy() ? "BUSY · " : ""}${status()}`}</text>
        </box>
      </box>
        <box flexDirection="row" flexGrow={1} gap={1} opacity={overlayOpen() ? 0.35 : 1}>
          <Rail colors={colors} items={railItems()} cursor={railCursor()} focus={chromeOwnsFocus(chromeFocus(), "rail")} cursorVisible={chromeOwnsFocus(chromeFocus(), "rail")} activeWorkspaceID={workspaceID()} state={state()} pendingApprovals={pendingApprovals().length} width={railWidth()} filter={workspaceFilter()} />
          <box flexGrow={1} minHeight={0} overflow="hidden" position="relative" border borderStyle="single" borderColor={chromeOwnsFocus(chromeFocus(), "chat") ? colors.focus : colors.border} backgroundColor={colors.bg} flexDirection="column" padding={1}>
            <text fg={chromeFocus() === "chat" || chromeFocus() === "composer" ? colors.focus : colors.muted} bg={colors.bg} width="100%" flexShrink={0} truncate>{surfaceTitle()}</text>
            <Show when={settingsAgentID()} fallback={
              <Show when={helpOpen()} fallback={
                <Show when={approvalsOpen()} fallback={
                  <Show when={surface()} fallback={
                    <box flexDirection="column" padding={1} flexGrow={1}>
                      <text fg={colors.accent} bg={colors.bg} width="100%" truncate>No currently opened session</text>
                      <text fg={colors.muted} bg={colors.bg} width="100%" wrapMode="word">Select an agent for a direct chat or a workspace for the group chat. Use j/k then Enter.</text>
                      <text fg={colors.faint} bg={colors.bg} width="100%" truncate>{EMPTY_MARK}</text>
                    </box>
                  }>
                    <>
                      <Show when={hasChatContent()} fallback={
                        <box flexDirection="column" padding={1} flexGrow={1}>
                          <text fg={colors.accent} bg={colors.bg} width="100%" truncate>{surface()?.kind === "agent" ? `Direct chat with ${surfaceAgent()?.name ?? "agent"}` : "Group chat"}</text>
                          <text fg={colors.muted} bg={colors.bg} width="100%" wrapMode="word">{surface()?.kind === "agent" ? dmEmptyDetail() : "Say something to your team. $Name mentions an agent; @path references a file. i to compose."}</text>
                          <text fg={colors.faint} bg={colors.bg} width="100%" truncate>{EMPTY_MARK}</text>
                        </box>
                      }>
                        <box flexGrow={1} minHeight={0} flexDirection="column" width="100%" overflow="hidden">
                          <scrollbox ref={(value: any) => { transcriptScrollRef = value; if (value) queueMicrotask(() => syncTranscriptScroll()) }} flexGrow={1} minHeight={0} stickyScroll stickyStart="bottom" viewportCulling={false} width="100%">
                              <box flexDirection="column" width="100%" paddingRight={1}>
                                <For each={mergedRows()}>{(row) => {
                                  // Ticket #67 muted inline completions: one
                                  // full-width muted system line per terminal
                                  // outcome at its finish position — no
                                  // border, no trailing feed, no regeneration.
                                  if (row.completion) {
                                    return (
                                    <box flexDirection="column" marginTop={1} paddingLeft={1} paddingRight={1}>
                                      <text fg={colors.muted} bg={colors.bg} width="100%" wrapMode="word">{row.completion.text}</text>
                                    </box>
                                    )
                                  }
                                  const message = row.message!
                                  const side = bubbleSide(message.role)
                                  // System, task, approval, assignment, and
                                  // completion-adjacent lines stay full-width
                                  // and unbubbled, visually distinct from the
                                  // conversation.
                                  if (!isBubbledRole(message.role)) {
                                    return (
                                    <box flexDirection="column" marginTop={1} paddingLeft={1} paddingRight={1}>
                                      <text fg={message.queued ? colors.warn : authorColor({ agentID: message.agentID, author: message.author, role: message.role })} bg={colors.bg} width="100%" truncate>{headerForLine(message)}</text>
                                      <Show when={message.role === "agent" && syntaxStyle} fallback={
                                        <text fg={message.role === "system" || message.queued ? colors.muted : colors.text} bg={colors.bg} width="100%" wrapMode="word">{renderMarkdownLines(message.text || "", Math.max(16, messageWidth())).join("\n")}</text>
                                      }>
                                        {(style) => <markdown content={message.text || " "} syntaxStyle={style()} width="100%" fg={colors.text} bg={colors.bg} conceal tableOptions={{ widthMode: "content" }} />}
                                      </Show>
                                    </box>
                                    )
                                  }
                                  // Ticket #67 bubbles (ticket #72 chrome):
                                  // agent messages read left-aligned in filled
                                  // blocks carrying the agent's categorical
                                  // accent edge; user messages read
                                  // right-aligned with a quiet but visible
                                  // edge. Both bubbles are rounded with
                                  // padding on all four sides so content never
                                  // touches the border; Yoga auto-sizes height
                                  // from content + padding + border. Content
                                  // wraps at one shared width: the fallback
                                  // `<text>` pre-wrap and the native
                                  // `<markdown>` width both use `wrapWidth`
                                  // (= bounded width − BUBBLE_CHROME), so the
                                  // height is consistent when paths swap.
                                  const accent = authorColor({ agentID: message.agentID, author: message.author, role: message.role })
                                  const wrapWidth = bubbleContentWidth(messageWidth(), BUBBLE_CHROME)
                                  return (
                                  <box flexDirection="column" width="100%" marginTop={1}>
                                    <box alignSelf={side === "left" ? "flex-start" : "flex-end"} width="72%" border={true} borderStyle="rounded" borderColor={side === "left" ? accent : message.queued ? colors.warn : colors.good} backgroundColor={colors.panel} padding={1} flexDirection="column">
                                      <text fg={message.queued ? colors.warn : accent} bg={colors.panel} width="100%" truncate>{headerForLine(message)}</text>
                                      <Show when={message.role === "user"} fallback={
                                        <Show when={syntaxStyle} fallback={
                                          <text fg={message.queued ? colors.muted : colors.text} bg={colors.panel} width="100%" wrapMode="word">{renderMarkdownLines(message.text || "", wrapWidth).join("\n")}</text>
                                        }>
                                          {(style) => <markdown content={message.text || " "} syntaxStyle={style()} width={wrapWidth} fg={colors.text} bg={colors.panel} conceal tableOptions={{ widthMode: "content" }} />}
                                        </Show>
                                      }>
                                        <text fg={message.queued ? colors.muted : colors.text} bg={colors.panel} width="100%" wrapMode="word">{renderVerbatimLines(message.text || " ", wrapWidth).join("\n")}</text>
                                      </Show>
                                    </box>
                                  </box>
                                  )
                                }}</For>
                              </box>
                          </scrollbox>
                          <Show when={liveActivity().shown.length > 0 || liveActivity().queued.length > 0 || liveActivity().overflow > 0}>
                            <box flexShrink={0} flexDirection="column" paddingLeft={1} paddingRight={1}>
                              <For each={liveActivity().shown}>{(entry) => (
                                <box flexDirection="row" width="100%">
                                  <text fg={colors.muted} bg={colors.bg}>{`${activityFrameForKind(entry.kind, motionFrame(), process.env)} `}</text>
                                  <Show when={entry.kind === "asking"} fallback={
                                    <>
                                      <text fg={authorColor({ agentID: entry.agentID, author: entry.label, role: "agent" })} bg={colors.bg}>{entry.label}</text>
                                      <text fg={colors.muted} bg={colors.bg}>{` · ${entry.verb}`}</text>
                                    </>
                                  }>
                                    <text fg={authorColor({ agentID: entry.agentID, author: entry.label, role: "agent" })} bg={colors.bg}>{entry.verb}</text>
                                  </Show>
                                </box>
                              )}</For>
                              <For each={liveActivity().queued}>{(label) => (
                                <box flexDirection="row" width="100%">
                                  <text fg={colors.muted} bg={colors.bg}>{`${queuedActivityFrame()} `}</text>
                                  <text fg={authorColor({ author: label, role: "agent" })} bg={colors.bg}>{label}</text>
                                  <text fg={colors.muted} bg={colors.bg}> · queued</text>
                                </box>
                              )}</For>
                              <Show when={liveActivity().overflow > 0}>
                                <text fg={colors.faint} bg={colors.bg} width="100%" truncate>· +{liveActivity().overflow} more</text>
                              </Show>
                            </box>
                          </Show>
                          <Show when={showWorkBlock()}>
                            <box flexShrink={0} border borderStyle="single" borderColor={colors.border} backgroundColor={colors.bg} paddingLeft={1} paddingRight={1} flexDirection="column">
                              <text fg={colors.muted} bg={colors.bg} width="100%" truncate>{workSummary(activeTasks(), Date.now())}</text>
                              <For each={orderedTasks()}>{(task, index) => {
                                // Review fixes (findings 2–3): the row with an
                                // in-flight action shows its interim label, and
                                // user-blocked rows carry the needs-you marker —
                                // both derived per row from existing state.
                                const needsYou = isNeedsYouTask(task, pendingApprovalIDs(), nativeBlockedSubtaskIDs())
                                const pending = pendingWork()?.id === task.id ? pendingWork()!.action : null
                                const rowStatus = deriveWorkStatus(task, Date.now())
                                return (
                                <text fg={taskCursor() === index() ? (chromeOwnsFocus(chromeFocus(), "chat") ? colors.good : colors.warn) : (needsYou || pending || rowStatus === "working" || rowStatus === "retrying") ? colors.warn : colors.text} bg={colors.bg} width="100%" truncate>
                                  {taskCursor() === index() && chromeOwnsFocus(chromeFocus(), "chat") ? "› " : "  "}{workRowText(task, agentName(state(), task.assigneeID), Date.now(), { pending, needsYou })}{` ${workRowFrame(rowStatus, motionFrame(), process.env)}`}
                                </text>
                                )
                              }}</For>
                              <text fg={colors.faint} bg={colors.bg} width="100%" truncate>d delegate · t reassign · ↵ result · r retry · R restart · x cancel · o native</text>
                            </box>
                          </Show>
                          <Show when={!atBottom()}>
                            <box position="absolute" bottom={2} right={4} zIndex={40} onMouseDown={() => jumpToBottom()} border borderStyle="rounded" borderColor={colors.focus} backgroundColor={colors.panel} paddingLeft={1} paddingRight={1} paddingTop={0} paddingBottom={0}>
                              <text fg={colors.focus} bg={colors.panel}>↓</text>
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
                      <box flexShrink={0} border borderStyle="single" borderColor={chromeOwnsFocus(chromeFocus(), "composer") ? colors.focus : colors.border} backgroundColor={colors.bg} paddingLeft={1} paddingRight={1}>
                        <textarea ref={(value: any) => { composerRef = value }} initialValue={composerDraft()} placeholder="Message…  $agent · @file · /command" width="100%" height={composerHeight()} backgroundColor={colors.bg} textColor={colors.text} onContentChange={() => { const value = String(composerRef?.plainText ?? ""); setComposerDraft(value); setComposerCursor(Number(composerRef?.cursorOffset ?? value.length)); setDrafts((store) => updateDraft(store, currentDraftKey(), value)); if (composerRef) composerRef.height = computeComposerHeight(value, Math.max(12, messageWidth() - 6)); handleComposerInput(value) }} onSubmit={() => { void submitComposer(String(composerRef?.plainText ?? "")).catch(showError) }} keyBindings={[{ name: "return", action: "submit" }, { name: "return", shift: true, action: "newline" }, { name: "kpenter", action: "submit" }, { name: "kpenter", shift: true, action: "newline" }]} />
                      </box>
                      <text fg={composerActive() ? colors.warn : colors.muted} bg={colors.bg} width="100%" truncate>{completion() ? "↑/↓ select · enter insert · esc close" : composerActive() ? (interaction().mode === "normal" ? "COMPOSER · NORMAL · i/a insert · h/j/k/l move · x/d edit · yy/p yank · enter send" : stoppable() ? "COMPOSER · enter send · esc normal · Ctrl+C stop" : "COMPOSER · enter send · esc normal") : "i compose · $ agent · @ file · / command"}</text>
                    </>
                  </Show>
                }>
                  <ApprovalList colors={colors} approvals={pendingApprovals()} cursor={approvalCursor()} resolvingID={resolvingApprovalID()} state={state()} onResolve={resolveApproval} />
                </Show>
              }>
                <HelpView colors={colors} scrollRef={(value: any) => { helpScrollRef = value }} />
              </Show>
            }>
              <SettingsView colors={colors} agent={draft()} tab={settingsTab()} dirty={dirty()} memories={filteredMemories()} memoryCursor={memoryCursor()} memoryFilter={memoryFilter()} memoryFilterEditing={memoryFilterEditing()} memoryTotal={agentMemories().length} backupCursor={backupCursor()} skills={filteredSkills()} skillCursor={skillCursor()} skillFilter={skillFilter()} filterEditing={skillFilterEditing()} skillCatalog={skills()} skillPage={skillPage()} />
            </Show>
          </box>
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
            <text fg={colors.faint} bg={colors.panel} width="100%" truncate>{promptFooter()}</text>
            </box>
          </box>
        </>
      </Show>
      <Show when={confirm()} keyed>
        <>
          <box position="absolute" top={confirmGeometry().top} left={confirmGeometry().left} width={confirmGeometry().width} zIndex={100} height={10} border borderStyle="double" borderColor={colors.focus} backgroundColor={colors.panel} padding={1} flexDirection="column">
            <box position="absolute" top={0} left={0} width="100%" height="100%" padding={1} flexDirection="column" zIndex={110}>
            <text fg={colors.focus} bg={colors.panel} width="100%" truncate>{confirm()!.title}</text>
            <text fg={colors.text} bg={colors.panel} width="100%" wrapMode="word">{confirm()!.message}</text>
            <text fg={colors.faint} bg={colors.panel} width="100%" truncate>{confirmFooter()}</text>
            </box>
          </box>
        </>
      </Show>
      <Show when={result()} keyed>
        <>
          <box position="absolute" top={resultGeometry().top} left={resultGeometry().left} width={resultGeometry().width} zIndex={100} height={18} border borderStyle="double" borderColor={colors.focus} backgroundColor={colors.panel} padding={1} flexDirection="column">
            <box position="absolute" top={0} left={0} width="100%" height="100%" padding={1} flexDirection="column" zIndex={110}>
            <text fg={colors.focus} bg={colors.panel} width="100%" truncate>{result()!.title}</text>
            <scrollbox ref={(value: any) => { resultScrollRef = value }} flexGrow={1} minHeight={0} stickyScroll stickyStart="top" width="100%">
              <text fg={colors.text} bg={colors.panel} width="100%" wrapMode="word">{result()!.text || " "}</text>
            </scrollbox>
            <text fg={colors.faint} bg={colors.panel} width="100%" truncate>{resultFooter()}</text>
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
                <Show when={wizardItems().length === 0} fallback={
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
                  <text fg={colors.muted} bg={colors.panel} width="100%" truncate>{pickerEmptyLine()}</text>
                </Show>
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
      <box height={3} flexDirection="column" border={["top"]} borderColor={colors.border} backgroundColor={colors.bg} opacity={overlayOpen() ? 0.35 : 1}>
        <text fg={leaderMode() ? colors.warn : interactionMode() === "insert" ? colors.good : colors.muted} bg={colors.bg} width="100%" truncate>
          {statuslineRow1({
            mode: interactionMode(),
            context: statusContext(),
            git: gitState(),
            position: statusPosition(),
            pendingChord: interaction().pendingChord,
            hints: statusHints(),
          })}
        </text>
        <text fg={interaction().message?.tone === "error" ? colors.bad : interaction().message?.tone === "success" ? colors.good : colors.faint} bg={colors.bg} width="100%" truncate>
          {statuslineRow2({ command: interaction().command, message: statusMessage() })}
        </text>
      </box>
    </box>
  )
}
