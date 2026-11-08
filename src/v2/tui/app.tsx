import { For, Show, batch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { unwrap } from "solid-js/store"
import { SyntaxStyle } from "@opentui/core"
import { usePlugin } from "@opencode/plugin/tui"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { relative } from "node:path"
import { homedir } from "node:os"
import type { Agent, Approval, ChangesSince, ChatContext, ChatMessage, InitJobState, Message, MessageStream, ModelOption, PatchBatch, ScopeName, ScopedResync, Snapshot, TranscriptWindow, Workspace, WorkspaceCounts } from "../types.ts"
import { ApprovalList, ChromeText, HelpView, InitRowView, PickerOverlay, Rail, SettingsView, StatuslineMessage, StatuslineRow, ToastOverlay, WorkCardView, WorkCompactRowView, type ChatLine, type PickerItem, type RailItem, type SettingsTab } from "./components.tsx"
import { COMPOSER_COMMANDS, COMPOSER_VALIDATION_MS, composerHeight as computeComposerHeight, composerTrigger, composerValidationBorder, composerValidationReducer, parseSlashCommand, type ComposerValidationState } from "./composer.ts"
import { directSkillIssue, planSkillInvocation, replaceSkillToken, skillPaletteAt } from "../skill-invocation.ts"
import { initComposerIssue, isInitAlias } from "../system-agent.ts"
import { activeInitJobs, initMessageIDs as initJobMessageIDs, initRowForJob } from "./initrow.ts"
import { agentName, fuzzyMatch, headerQueuedSuffix, missingSkills, relayTaskForMessage, renderMarkdownLines, renderVerbatimLines, resultForTask, transcriptRole, unreadCount, workspaceGroupLabel, workspaceLabel } from "./format.ts"
import { filterMemories } from "./memories.ts"
import {
  RAIL_PULSE_STEP_MS,
  emptyRailEmphasis,
  observeRailAttention,
  railArrivalActive,
  railEmphasisAt,
  railPulseActive,
  railRowKey,
  type RailAttentionSnapshot,
  type RailAttentionState,
  type RailEmphasis,
  type RailPulseStart,
} from "./rail.ts"
import { palette } from "./theme.ts"
import { pickerWindow, stablePickerItems, toggleSelected } from "./picker.ts"
import { markdownStyles } from "./syntax.ts"
import {
  addWizardMemory,
  clampWizardMemoryCursor,
  deleteWizardMemory,
  isWizardMemoryStep,
  overlayGeometry,
  sameWizardOptions,
  updateWizardMemory,
  wizardDraftDirty,
  wizardEnterAction,
  wizardModelEmptyHint,
  wizardModelKeyFor,
  wizardModelOptions,
  wizardMemorySaveList,
  wizardStepArrival,
  wizardStepRail,
  wizardStepSettleMs,
  wizardStepSettleOpacity,
  wizardSuccessToast,
  wizardValidation,
  type WizardDraft,
} from "./wizard.ts"
import { CHROME_CLOCK_INTERVAL_MS, EMPTY_MARK, WORK_CLOCK_INTERVAL_MS, isReducedMotion, shouldRunMotion, shouldRunWorkClock } from "./motion.ts"
import { createTideAssignments, createTideFreezeState, pruneTideAssignments, pruneTideFreezes, retainTideFreezes, tideVariantFor } from "./tide.ts"
import {
  TRANSCRIPT_EMPHASIS_MS,
  createTranscriptMotionState,
  observeTranscriptMotion,
  type TranscriptEmphasisEvent,
  type TranscriptEmphasisKind,
  type TranscriptRowSignal,
} from "./transcript-motion.ts"
import {
  chromeOwnsFocus,
  dmEmptyDetail,
  footerLine1,
  footerLine2,
  pickerEmptyLine,
  resolveChromeFocus,
} from "./chrome.ts"
import { skillPageForCursor } from "./skills.ts"
import { modelPickerLabel, sortModelsByProvider } from "./settings.ts"
import {
  clampSettingsRow,
  moveSettingsRow,
  normalizeSettingsField,
  settingsAddAction,
  settingsDeleteAction,
  settingsFieldAtRow,
  settingsFieldLabel,
  settingsFilterable,
  settingsPromoteAction,
  settingsReorderAction,
  settingsRowCount,
  settingsRowKind,
  settingsTabStep,
  settingsToggleAction,
  reorderBackupList,
  type SettingsFieldID,
} from "./settings-grammar.ts"
import {
  SETTINGS_FLASH_MS,
  createMissingSkillsTracker,
  settingsAcknowledgement,
  settingsFeedbackSignal,
  trackMissingSkills,
  type SettingsFeedback as SettingsFeedbackSignal,
} from "./settings-feedback.ts"
import {
  OVERLAY_PRESENCE_MS,
  OVERLAY_PRESENCE_STEP_MS,
  filterEdit,
  overlayPresenceKey as presencePanelKey,
  overlayPresenceOpacity,
  singleChoiceValue,
} from "./overlays.ts"
import { describeGitChange, readGitState, type GitState } from "./git.ts"
import {
  APPROVAL_MOTION_STEP_MS,
  createApprovalInboxTrack,
  updateApprovalInboxMotion,
  type ApprovalInboxMotion,
} from "./approvals.ts"
import {
  caretStyleForMode,
  initialInteractionState,
  insertWithoutTarget,
  interactionReducer,
  visibleMessage,
  type InteractionEvent,
  type InteractionFocus,
  type InteractionMode,
  type InteractionOverlay,
  type InteractionResult,
  type InteractionState,
} from "./interaction.ts"
import { applySendResult, clearDraft, draftFor, draftKey, updateDraft, type DraftStore, type DraftSurface } from "./drafts.ts"
import { createClipboardPort, createEditorPort, createVimBuffer } from "./vim-opentui.ts"
import { MOUSE_PANE_IDS, handleMouseSelection, paneName } from "./mouse.ts"
import { createVimRegisterStore, normalizeVimKey, visualSelectionSize, type VimBuffer, type VimOutcome } from "./vim.ts"
import { dialogEscape, dialogKeyContext } from "./dialogs.ts"
import { buildStatuslineSegments, composerPosition, contextLabel, listPosition, statuslineRow2Parts, statuslineRow2PromptParts, transcriptPosition, type StatuslineRow2Input, type StatuslineSurface } from "./statusline.ts"
import { clearToasts, createToastState, expireToasts, feedbackChannel, initToast, nextToastDeadline, pushToast, toastPlacement, type ToastInput } from "./toast.ts"
import { editLine } from "./line-editor.ts"
import { commandStatusHints, layerEntries, globalEntries, leaderEntries, leaderHints, leaderLayerEntries, normalizeKeyToken, resolveLeaderKey, resolveNormalKey, singleKeyEntry, statuslineHints, whichKeyLines, type KeyContext, type KeyEntry } from "./keymap.ts"
import { filterHelpSections, helpEntryKey, helpMatchAfter, helpSections } from "./help.ts"
import { commandCompletions, completeCommand, parseCommandLine, type ParsedCommand } from "./commands.ts"
import { createLogger, type EnsembleLogger, type LogEntry } from "../logging.ts"
import { formatLogEntry, formatLogStats, logEntryTone, logsRpcInput, logsTitle, parseLogsCommand, sortLogEntries, type LogsViewFilter } from "./logs.ts"
import { createPageActivation } from "./page-activation.ts"
import { chromeJoin, chromeSeparator } from "./separators.ts"
import { focusWhenReady, halfPageCursor, nextFocusZone, type FocusZone } from "./focus.ts"
import { LEADER_POPUP_DELAY_MS } from "./leader.ts"
import { createCommandHistory, recallHistory, rememberHistory, startHistory, type CommandHistory } from "./history.ts"
import { matchIndexAfter, transcriptMatches, type TranscriptMatch } from "./search.ts"
import { normalizeAgentMentions } from "../routing.ts"
import { deriveWorkStatus, isTerminalWorkStatus } from "../queue.ts"
import { scopesToResync } from "../scoped-read.ts"
import { approvalResolutionAt } from "../work-groups.ts"
import { configMetadataApplies, createRefreshCoordinator, decideChangesSince, decidePatchApply, decideSnapshotApply, heartbeatDelay, isForeignEpochPatch, isWorkOnlyPatch, mergeFeedMeta, revisionChanged, snapshotMeta, supportsPatchFeed, supportsScopedReads, validMessageStream, type PatchDecision, type Revision, type SnapshotMeta } from "./refresh-coordinator.ts"
import { createFeedGapReporter } from "./feed-gaps.ts"
import { createClientStore } from "./client-store.ts"
import { createStreamCoalescer } from "../stream-coalescer.ts"
import {
  ACTIVITY_DEFAULT_VERB,
  MAX_VISIBLE_ACTIVITY,
  NEEDS_YOU_MARK,
  TRANSCRIPT_WINDOW,
  activityFrameForKind,
  activityStateForTask,
  hasActiveWork,
  isNeedsYouTask,
  mergeStreamingActivity,
  pendingWorkLabel,
  queuedActivityFrame,
  selectActivityAgents,
  splitActivityGroups,
  splitLiveFinalized,
  suppressCardedActivity,
  createWorkCardCache,
  pruneWorkCardCache,
  workCardForTaskCached,
  workCardGlyph,
  workCardStateWord,
  workCardTide,
  workCardTones,
  workCompactRow,
  workRowFrame,
  type ActivityEntry,
  type ActivityVerbKind,
  type PendingWorkAction,
  type WorkCard,
  type WorkCardOptions,
} from "./workrows.ts"
import { nextWorkInvalidation, workGroupCounts, workGroupLayout, workGroupsForTasks, workSummaryCounts, type WorkGroupSection } from "./workgroups.ts"
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
  mode: "members" | "leader" | "workspace" | "choice" | "agent"
  title: string
  candidates: Array<{ id: string; label: string }>
  selected: Set<string>
  cursor: number
  query: string
  /** A `/` filter owns the keyboard until Enter or Esc. */
  filtering: boolean
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
type WizardStepKind = "pick" | "multi" | "text" | "choice" | "memories"
type WizardStep = {
  key: string
  title: string
  description: string
  kind: WizardStepKind
  placeholder?: string
  options?: WizardOption[]
}
/** The memory add/edit field stays open in Insert until Esc returns to the list. */
type WizardMemoryEditor = { mode: "add" | "edit"; index: number | null }
type WizardState = {
  flow: "workspace" | "agent"
  title: string
  draft: WizardDraft
  /** The draft as opened; Esc only asks to discard once it differs. */
  initialDraft: WizardDraft
  steps: WizardStep[]
  index: number
  query: string
  /** A `/` filter owns the keyboard until Enter or Esc. */
  filtering: boolean
  cursor: number
  /** Selected memory in the one-by-one list editor. */
  memoryCursor: number
  /** Open memory add/edit field; null on the list. */
  memoryEditor: WizardMemoryEditor | null
  /** The add field's uncommitted text, kept across an Esc back to the list. */
  memoryDraft: string
  /** A dirty cancel waits for y/Enter (discard) or n/Esc (keep). */
  discardConfirm: boolean
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
  end: number
  cursor: number
  scope?: "start" | "agent"
  ownerName?: string
  items: Array<{ title: string; value: string; action?: "command" | "skill"; insert?: string }>
}

/** Where a `/` search applies: the rail, the settings tab, or the transcript. */
type CommandTarget = "roster" | "settings" | "transcript"

type CommandSession = {
  target: CommandTarget
  previous: {
    workspaceFilter: string
    memoryFilter: string
    skillFilter: string
    search: { query: string; cursor: number } | null
  }
}

/**
 * The settings text buffer currently in Insert or field Normal. `agent`
 * fields live in the draft; `memory` fields persist on commit. A null
 * memoryID means a new memory.
 */
type SettingsFieldState =
  | { kind: "agent"; field: SettingsFieldID; label: string; value: string }
  | { kind: "memory"; memoryID: string | null; label: string; value: string }

type TranscriptSearch = { query: string; cursor: number }

function directoryOf(context: any): string {
  return context.location?.directory ?? context.data.location.default().directory
}

// v5.6 T11: the host keeps earlier plugin pages mounted, so their raw key
// listeners outlive the navigation. Only the newest page may handle keys.
const pageActivation = createPageActivation()


/**
 * Ticket #145: the TUI owns its own per-process log file so it never shares a
 * rotating sink with the service. `callRpc` records failures and slow calls;
 * successful calls stay at debug so the ring is not a request feed.
 */
let tuiLogger: EnsembleLogger | undefined

async function callRpc<T = any>(context: any, method: string, input: any): Promise<T> {
  const started = performance.now()
  try {
    const response = await context.client.rpc.call({ rpcID: "ensemble.v2", method, location: { directory: directoryOf(context) }, input })
    const durationMs = performance.now() - started
    if (durationMs >= 1_000) tuiLogger?.event("warn", "tui", "tui.rpc.slow", { method, durationMs })
    else tuiLogger?.event("debug", "tui", "tui.rpc", { method, durationMs })
    return response?.output ?? response
  } catch (error: any) {
    tuiLogger?.event("error", "tui", "tui.rpc.error", {
      method,
      durationMs: performance.now() - started,
      error,
    })
    throw error
  }
}

async function invoke(context: any, action: string, payload: any = {}): Promise<any> {
  const response = await callRpc(context, "invoke", { directory: directoryOf(context), action, payload })
  if (!response?.ok) throw new Error(response?.error?.message ?? "Ensemble request failed.")
  return response.result
}

export function EnsembleV2App() {
  const context = usePlugin()
  const pageToken = {}
  const logger = createLogger({ role: "tui", instanceID: randomUUID() })
  tuiLogger = logger
  logger.event("info", "tui", "tui.mount", {
    directory: directoryOf(context),
    protocol: "ensemble.v2",
  })
  onCleanup(() => {
    logger.event("info", "tui", "tui.unmount", {})
    void logger.close().catch(() => undefined)
    if (tuiLogger === logger) tuiLogger = undefined
  })
  // Ticket #137: the host theme mode selects the readable pale-blue identity pair.
  const colors = palette(context.theme as any, context.themeMode)
  // Ticket #119: the host toast is only a fallback for feedback that cannot be
  // painted by the mounted Ensemble surface (setup failure, or an async
  // completion while the native route is visible). Everything else renders in
  // the app-owned toast below.
  const showHostToast = (input: ToastInput) => {
    try { context.ui.toast.show({ title: input.title, message: input.message, variant: input.tone ?? "info" }) } catch {}
  }
  const syntaxStyle = (() => {
    try {
      return SyntaxStyle.fromStyles(markdownStyles(context.theme), (context.renderer as any).nativeScene)
    } catch (error) {
      console.error("ensemble: markdown styling unavailable", error)
      showHostToast({ title: "Ensemble", message: "Rich Markdown styling unavailable; using plain text.", tone: "warning" })
      return undefined
    }
  })()
  onCleanup(() => { try { syntaxStyle?.destroy?.() } catch {} })
  // Ticket #132: the TUI owns a disposable fine-grained client store. The
  // initial full snapshot seeds entity paths once; catalog/model/skill/config
  // metadata lives in sibling signals, so entity updates never replace it.
  const client = createClientStore()
  const [workspaceID, setWorkspaceID] = createSignal<string | null>(null)
  const [surface, setSurface] = createSignal<Surface | null>(null)
  // v5.6 T1 interaction foundation: the pure reducer owns mode, focus,
  // overlay context, command input, pending chord, selection, and the
  // transient statusline message. Focus areas elsewhere in the app read
  // through the compatibility accessors below.
  const [interaction, setInteraction] = createSignal<InteractionState>(initialInteractionState())
  const [commandHistory, setCommandHistory] = createSignal<CommandHistory>(createCommandHistory())
  const [transcriptSearch, setTranscriptSearch] = createSignal<TranscriptSearch | null>(null)
  let commandSession: CommandSession | undefined
  const [railCursor, setRailCursor] = createSignal(0)
  const [taskCursor, setTaskCursor] = createSignal(0)
  const [chatContext, setChatContext] = createSignal<ChatContext | null>(null)
  const [settingsAgentID, setSettingsAgentID] = createSignal<string | null>(null)
  const [settingsTab, setSettingsTab] = createSignal<SettingsTab>("general")
  const [draft, setDraft] = createSignal<Agent | null>(null)
  const [dirty, setDirty] = createSignal(false)
  const [leaderMode, setLeaderMode] = createSignal(false)
  // The which-key popup waits a short beat; leader keys act immediately.
  const [leaderPopup, setLeaderPopup] = createSignal(false)
  let leaderPopupTimer: ReturnType<typeof setTimeout> | undefined
  const [helpOpen, setHelpOpen] = createSignal(false)
  // Help owns a local filter so its keys never touch interaction mode/focus.
  const [helpFiltering, setHelpFiltering] = createSignal(false)
  const [helpQuery, setHelpQuery] = createSignal("")
  const [helpMatch, setHelpMatch] = createSignal(0)
  const helpCatalogSections = helpSections()
  let helpPendingKeys: string[] = []
  const [approvalsOpen, setApprovalsOpen] = createSignal(false)
  const [logsOpen, setLogsOpen] = createSignal(false)
  const [logsFilter, setLogsFilter] = createSignal<LogsViewFilter>({ kind: "all" })
  const [logsEntries, setLogsEntries] = createSignal<LogEntry[]>([])
  const [logsStats, setLogsStats] = createSignal<any>(null)
  const [logsLoading, setLogsLoading] = createSignal(false)
  const [logsError, setLogsError] = createSignal("")
  let logsScrollRef: any
  const [status, setStatus] = createSignal("Loading workspace…")
  const [gitState, setGitState] = createSignal<GitState | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [modal, setModal] = createSignal(false)
  const [approvalCursor, setApprovalCursor] = createSignal(0)
  const [resolvingApprovalID, setResolvingApprovalID] = createSignal<string | null>(null)
  // Ticket #126: the approval inbox owns one-shot transitions derived from the
  // durable rows. The track is UI-local and prunes itself after each window.
  const [approvalMotion, setApprovalMotion] = createSignal<ApprovalInboxMotion>({ emphasized: new Set(), resolved: [], active: false })
  const approvalTrack = createApprovalInboxTrack()
  // Review fix (finding 2): the work row with an in-flight Stop/Cancel (or
  // retry/restart) action shows its interim label until the terminal state
  // arrives; cleared in a finally so it can never stick.
  const [pendingWork, setPendingWork] = createSignal<{ id: string; action: PendingWorkAction } | null>(null)
  const [settingsCursor, setSettingsCursor] = createSignal(0)
  const [settingsField, setSettingsField] = createSignal<SettingsFieldState | null>(null)
  const [settingsFieldText, setSettingsFieldText] = createSignal("")
  const [settingsFieldCursor, setSettingsFieldCursor] = createSignal(0)
  // The created memory id is authoritative; the snapshot that carries it can
  // land one event-refresh later, so the cursor resolves from this id instead
  // of guessing a row from a possibly stale filtered list.
  const [pendingMemorySelectID, setPendingMemorySelectID] = createSignal<string | null>(null)
  // Ticket #124: one-shot settings acknowledgements. A signal lights its
  // target for one window, then settles; the timer ends that window once and
  // never restarts it. Reduced motion renders the settled state immediately.
  const [settingsFeedback, setSettingsFeedback] = createSignal<SettingsFeedbackSignal | null>(null)
  const [settingsFeedbackNow, setSettingsFeedbackNow] = createSignal(0)
  let settingsFeedbackTimer: ReturnType<typeof setTimeout> | undefined
  const clearSettingsFeedback = () => {
    if (settingsFeedbackTimer !== undefined) { clearTimeout(settingsFeedbackTimer); settingsFeedbackTimer = undefined }
    setSettingsFeedback(null)
    setSettingsFeedbackNow(0)
  }
  const signalSettingsFeedback = (feedback: SettingsFeedbackSignal) => {
    if (settingsFeedbackTimer !== undefined) { clearTimeout(settingsFeedbackTimer); settingsFeedbackTimer = undefined }
    setSettingsFeedback(feedback)
    setSettingsFeedbackNow(feedback.at)
    settingsFeedbackTimer = setTimeout(() => {
      setSettingsFeedbackNow(feedback.at + SETTINGS_FLASH_MS)
      settingsFeedbackTimer = undefined
    }, SETTINGS_FLASH_MS)
  }
  const settingsAck = createMemo(() => settingsAcknowledgement(settingsFeedback(), settingsFeedbackNow()))
  onCleanup(() => { if (settingsFeedbackTimer !== undefined) clearTimeout(settingsFeedbackTimer) })
  const [memoryFilter, setMemoryFilter] = createSignal("")
  const [skillFilter, setSkillFilter] = createSignal("")
  const [workspaceFilter, setWorkspaceFilter] = createSignal("")
  const [composerDraft, setComposerDraft] = createSignal("")
  const [composerCursor, setComposerCursor] = createSignal(0)
  const [drafts, setDrafts] = createSignal<DraftStore>({})
  const [composerValidation, setComposerValidation] = createSignal<ComposerValidationState | null>(null)
  const [completion, setCompletion] = createSignal<Completion | null>(null)
  const [picker, setPicker] = createSignal<PickerState | null>(null)
  const [textPrompt, setTextPrompt] = createSignal<TextPromptState | null>(null)
  const [confirm, setConfirm] = createSignal<ConfirmState | null>(null)
  const [result, setResult] = createSignal<ResultState | null>(null)
  const [motionFrame, setMotionFrame] = createSignal(0)
  // Ticket #116: the Work-card tide runs on its own 15 fps clock, independent
  // of the 8 fps chrome clock. It stops (and resets) when no unblocked
  // working card remains, so idle cards cost nothing.
  const [workFrame, setWorkFrame] = createSignal(0)
  // Ticket #142: derived Work status and the 1.2 s group hold can expire
  // without a durable update. One dedicated timer bumps this revision at the
  // next such instant; it is not an animation clock and never rebuilds the
  // animated glyph or tide cells.
  const [workRevision, setWorkRevision] = createSignal(0)
  // Ticket #119: one visible app toast and a bounded queue. The effect below
  // schedules exactly one timeout for the visible toast's deadline.
  const [toasts, setToasts] = createSignal(createToastState())
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  // Ticket #120: shell overlay presence is one-shot; the key tracks which
  // panel owns the current settle so a replaced panel starts clean.
  const [overlayPresence, setOverlayPresence] = createSignal(overlayPresenceOpacity(0))
  const [overlayPresenceKey, setOverlayPresenceKey] = createSignal("none")
  // Ticket #121: rail attention is one-shot. Pulses and row-arrival emphasis
  // are derived transitions, never a permanent beacon; reduced motion leaves
  // this at the empty set and starts no timer.
  const [railEmphasis, setRailEmphasis] = createSignal<RailEmphasis>(emptyRailEmphasis())
  const [wizard, setWizard] = createSignal<WizardState | null>(null)
  // One-shot step settle: the content dims once on arrival and returns to
  // full color, never moving geometry. Reduced motion leaves it settled.
  const [wizardSettling, setWizardSettling] = createSignal(false)
  // The persistent memory field's live buffer. The renderable's ref can trail
  // a step switch by one frame, so the pure state owns the text Enter saves.
  const [wizardMemoryInput, setWizardMemoryInput] = createSignal("")
  const [liveDm, setLiveDm] = createSignal<{ sessionID: string; text: string } | null>(null)
  const [atBottom, setAtBottom] = createSignal(true)
  const [transcriptScroll, setTranscriptScroll] = createSignal({ top: 0, height: 0, viewport: 0 })
  let composerRef: any
  // Ticket #77d: identifies the current composer session. A send that is
  // still in flight must not re-focus (or wipe) a composer the user already
  // left with Escape.
  let composerEpoch = 0
  // v5.6 T3: chord prefixes (gg) are app-local pending keys; the interaction
  // reducer mirrors them as `pendingChord` for the statusline.
  let pendingKeys: string[] = []
  let textPromptRef: any
  let wizardRef: any
  let wizardMemoryRef: any
  let resultScrollRef: any
  let transcriptScrollRef: any
  let helpScrollRef: any
  let settingsFieldRef: any
  // v5.6 T9: pane where the current mouse drag started. Set on the left
  // button down (the renderer's selection event fires later, on release).
  let mouseSelectionPane: string | null = null
  // Remember where settings was opened so closing returns to the same column.
  let settingsReturnFocus: InteractionFocus = "chat"
  let messageTimer: ReturnType<typeof setTimeout> | undefined
  let wizardSettleTimer: ReturnType<typeof setTimeout> | undefined
  let wizardSettledKey = ""
  let composerValidationTimer: ReturnType<typeof setTimeout> | undefined

  // v5.7 T2: every text editor paints the same mode-driven caret. A block in
  // Normal shows the character Vim acts on; a line in Insert/Visual/Command
  // shows the insertion point. The editor stays focused across Insert ->
  // Normal, so the shape change is always visible.
  const applyEditorCaret = (ref: any) => {
    if (!ref) return
    try { ref.cursorStyle = caretStyleForMode(interaction().mode) } catch {}
  }
  const syncEditorCarets = () => {
    applyEditorCaret(composerRef)
    applyEditorCaret(settingsFieldRef)
    applyEditorCaret(textPromptRef)
    applyEditorCaret(wizardRef)
  }
  createEffect(() => {
    // Track the mode: caret shape must change on every explicit transition.
    caretStyleForMode(interaction().mode)
    syncEditorCarets()
  })

  // Focus/mode compatibility accessors: existing call sites keep reading
  // `focusArea()` and `composerActive()` while the reducer owns the values.
  const focusArea = (): FocusArea => (interaction().focus === "rail" ? "rail" : "chat")
  const composerActive = () => interaction().focus === "composer"
  const interactionMode = (): InteractionMode => interaction().mode
  const commandActive = () => interaction().command !== null
  const setFocusArea = (area: FocusArea) => { dispatchInteraction({ type: "focus.set", focus: area }) }
  const applyInteraction = (result: InteractionResult) => {
    setInteraction(result.state)
    for (const intent of result.intents) {
      if (intent.type === "focus-editor") {
        const target = intent.target ?? result.state.field ?? "composer"
        if (target === "settings") focusWhenReady(() => settingsFieldRef)
        else if (target === "prompt") focusWhenReady(() => textPromptRef)
        else if (target === "wizard") focusWhenReady(() => wizardRef)
        else focusWhenReady(() => composerRef)
      } else if (intent.type === "blur-editor") {
        try { composerRef?.blur?.() } catch {}
        try { settingsFieldRef?.blur?.() } catch {}
        try { textPromptRef?.blur?.() } catch {}
        try { wizardRef?.blur?.() } catch {}
      } else if (intent.type === "wizard-back") {
        wizardPrev()
      } else if (intent.type === "wizard-cancel") {
        wizardCancel()
      } else if (intent.type === "close-overlay") {
        closeOverlay(intent.overlay)
      }
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

  // Ticket #123: invalid commands and failed validation flash the composer
  // border once while the draft stays intact. Typing or a successful send
  // clears the signal; the short timer is the one-shot lifetime.
  const clearComposerValidation = (reason: "input" | "send-success" = "input") => {
    if (composerValidationTimer !== undefined) {
      clearTimeout(composerValidationTimer)
      composerValidationTimer = undefined
    }
    setComposerValidation((state) => composerValidationReducer(state, { type: reason }))
  }
  const markComposerInvalid = (message: string) => {
    setComposerValidation((state) => composerValidationReducer(state, { type: "invalid", message, at: Date.now() }))
    if (composerValidationTimer !== undefined) clearTimeout(composerValidationTimer)
    composerValidationTimer = setTimeout(() => {
      composerValidationTimer = undefined
      setComposerValidation((state) => composerValidationReducer(state, { type: "tick", at: Date.now() }))
    }, COMPOSER_VALIDATION_MS)
  }
  onCleanup(() => { if (composerValidationTimer !== undefined) clearTimeout(composerValidationTimer) })
  // One composer rejection path: the statusline names the problem and the
  // border flashes once. No second (toast) channel competes with it.
  const rejectComposerInput = (message: string) => {
    notify(message, "error")
    markComposerInvalid(message)
  }

  // v5.6 T7: Normal-mode Vim editing for every text buffer. One internal
  // register is shared by the composer, prompts, and wizard fields; the
  // system clipboard is primary and the adapter writes/reads it
  // asynchronously with the register as fallback.
  const vimRegister = createVimRegisterStore()
  let vimClipboard: ReturnType<typeof createClipboardPort> | null = null
  type EditorCache = { source: any; buffer: VimBuffer | null }
  const composerCache: EditorCache = { source: null, buffer: null }
  const promptCache: EditorCache = { source: null, buffer: null }
  const wizardCache: EditorCache = { source: null, buffer: null }
  const clipboardPort = () => {
    if (!vimClipboard) vimClipboard = createClipboardPort(context.renderer)
    return vimClipboard
  }
  const editorBuffer = (ref: any, cache: EditorCache): VimBuffer | null => {
    if (!ref) return null
    if (cache.buffer && cache.source === ref) return cache.buffer
    cache.source = ref
    cache.buffer = createVimBuffer({
      editor: createEditorPort(ref),
      clipboard: clipboardPort(),
      register: vimRegister,
      onMessage: (message) => showToast({ title: "Clipboard", message: message.text, tone: message.tone }),
    })
    return cache.buffer
  }
  // Ticket #83: settings text fields reuse the same Vim adapter, register, and
  // clipboard as the composer. The input remounts for every field, so the
  // buffer is recreated only when the renderable reference changes.
  let settingsVim: VimBuffer | null = null
  let settingsVimRef: any
  const settingsFieldVimBuffer = (): VimBuffer | null => {
    if (!settingsFieldRef) return null
    if (settingsVim && settingsVimRef === settingsFieldRef) return settingsVim
    settingsVimRef = settingsFieldRef
    settingsVim = createVimBuffer({
      editor: createEditorPort(settingsFieldRef),
      clipboard: clipboardPort(),
      register: vimRegister,
      onMessage: (message) => showToast({ title: "Clipboard", message: message.text, tone: message.tone }),
    })
    return settingsVim
  }
  const composerVimBuffer = (): VimBuffer | null => editorBuffer(composerRef, composerCache)
  const promptVimBuffer = (): VimBuffer | null => editorBuffer(textPromptRef, promptCache)
  const wizardVimBuffer = (): VimBuffer | null => editorBuffer(wizardRef, wizardCache)
  const syncVimChord = (chord: string | null | undefined) => {
    if (chord) dispatchInteraction({ type: "chord.set", chord })
    else if (interaction().pendingChord) dispatchInteraction({ type: "chord.clear" })
  }
  const visualHint = statuslineHints("composerVisual")
  /**
   * Ticket #86: the Vim controller owns the selection while a text buffer is
   * focused; mirror its mode and range into the interaction state so the
   * statusline and the Esc ladder agree. Buffer edits update the caller's
   * cursor signal after the mode transition.
   */
  const applyVimOutcome = (
    outcome: VimOutcome,
    handlers: { insert: () => void; cursor?: () => void },
  ) => {
    syncVimChord(outcome.pendingChord)
    if (outcome.mode === "insert") {
      handlers.insert()
    } else if (outcome.mode === "visual" && outcome.selection) {
      dispatchInteraction({ type: "visual.set", selection: outcome.selection })
    } else if (outcome.mode === "normal" && interaction().mode === "visual") {
      dispatchInteraction({ type: "visual.leave" })
    }
    handlers.cursor?.()
  }
  onCleanup(() => {
    vimClipboard?.dispose()
    vimClipboard = null
    composerCache.buffer = null
    promptCache.buffer = null
    wizardCache.buffer = null
    settingsVim = null
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
    if (logsOpen()) return "logs"
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
    // Apply the reducer's intents too: closing a picker/prompt/confirm/result
    // in Insert restores the editor that owned the caret before the overlay.
    dispatchInteraction({ type: "overlay.set", overlay })
  })

  const lineCache = new Map<string, ChatLine>()
  // Ticket #133: one coordinator per fetch path. At most one refresh runs and
  // a burst collapses into one queued dirty pass; no request sequence discards
  // a completed response. The metadata of the last applied snapshot decides
  // version application and catalog/config refreshes.
  let lastSnapshotMeta: SnapshotMeta | undefined = undefined
  // Ticket #138: a forced replacement is used for an epoch change or a feed
  // reset; the version guard cannot express "same version, discard state".
  let forceSnapshotReplace = false
  const snapshotRefresh = createRefreshCoordinator({
    run: () => loadData(),
    onError: (error: any) => setStatus(`Ensemble unavailable: ${error?.message ?? error}`),
  })
  const chatRefresh = createRefreshCoordinator({
    run: () => loadChat(),
  })
  const [restored, setRestored] = createSignal(false)
  let lastSavedHistory = ""
  let lastConfigError = ""
  const [uiState] = context.storage.store("ensemble.v2.ui", { initial: { workspaceID: null as string | null, taskID: null as string | null, transcriptOffset: 0 } })

  // Compatibility accessors: existing selectors keep reading through
  // `state()` and the catalog signals while entity paths migrate to the store.
  const state = client.state
  const models = client.models
  const skills = client.skills
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
  const [renderSize, setRenderSize] = createSignal({ width: context.renderer.width ?? 120, height: context.renderer.height ?? 40 })
  onMount(() => {
    const update = () => setRenderSize({ width: context.renderer.width ?? 120, height: context.renderer.height ?? 40 })
    context.renderer.on("resize", update)
    onCleanup(() => context.renderer.off("resize", update))
  })
  // The rail stays transparent; the inline LEADER label uses the leader
  // color, so there is no badge box or opaque cutout to paint.
  const viewWidth = () => Math.max(60, renderSize().width - 2)
  const railWidth = () => Math.max(26, Math.min(34, Math.floor(viewWidth() * 0.26)))
  // Two-column layout (ticket #56): the task board is gone and the chat
  // reclaims its width. Only the rail is subtracted now.
  const messageWidth = () => Math.max(20, viewWidth() - railWidth() - 10)
  const viewHeight = () => renderSize().height
  const messageHeight = () => Math.max(6, viewHeight() - 14)
  // Ticket #115/#117: Work cards. The grid uses the full chat content width
  // minus the section padding. The layout decides the column count, card
  // width, and row capacity; card content width sits inside border/accent.
  const workContentWidth = () => Math.max(20, messageWidth() - 2)
  const activeCount = createMemo(() => activeTasks().filter((task) => task.state === "working").length)
  // Ticket #118: the System Agent init row is a live, staged row. It belongs
  // to the workspace surface, survives navigation through snapshot state, and
  // shows only honest stages. The ids keep the generic streaming-activity
  // line from duplicating the same System Agent job.
  const liveInitJobs = createMemo(() => {
    if (surface()?.kind !== "workspace") return []
    const workspace = activeWorkspace()
    if (!workspace) return []
    return activeInitJobs(state()?.initJobs ?? {}, workspace.id)
  })
  const initRows = createMemo(() => liveInitJobs().map((job) => initRowForJob(job, motionFrame(), process.env)))
  const initRowMessageIDs = createMemo(() => initJobMessageIDs(state()?.initJobs ?? {}, surface()?.kind === "workspace" ? activeWorkspace()?.id : undefined))
  const pendingApprovals = createMemo(() => Object.values(state()?.approvals ?? {}).filter((approval) => approval.status === "pending"))
  // Ticket #126: one-shot inbox transitions. The first snapshot is the
  // baseline; later arrivals emphasize once and resolved rows settle once.
  // A short app-owned cadence repaints only while one of those windows is
  // live, so idle approvals never run a decorative clock. It never dispatches
  // interaction: keys, focus, and cursor ownership stay untouched.
  let approvalMotionTimer: ReturnType<typeof setInterval> | undefined
  const stopApprovalMotion = () => {
    if (approvalMotionTimer === undefined) return
    clearInterval(approvalMotionTimer)
    approvalMotionTimer = undefined
  }
  const refreshApprovalMotion = () => {
    const current = state()
    if (!current) {
      stopApprovalMotion()
      return
    }
    const view = updateApprovalInboxMotion(approvalTrack, Object.values(current.approvals), Date.now(), process.env)
    setApprovalMotion(view)
    if (!view.active) {
      stopApprovalMotion()
      return
    }
    if (approvalMotionTimer === undefined) {
      approvalMotionTimer = setInterval(refreshApprovalMotion, APPROVAL_MOTION_STEP_MS)
    }
  }
  createEffect(refreshApprovalMotion)
  onCleanup(stopApprovalMotion)
  // Review fix (finding 3): needs-you derives from existing state only —
  // the set of still-pending approval ids, matched against each task's
  // approvalID (or its interrupted flag inside isNeedsYouTask).
  const pendingApprovalIDs = createMemo(() => new Set(pendingApprovals().map((approval) => approval.id)))
  // Native mirrors block their linked subtask's session without setting
  // approvalID, so the needs-you marker needs the subtask set too.
  const nativeBlockedSubtaskIDs = createMemo(() => new Set(pendingApprovals().filter((approval) => approval.kind === "native" && approval.subtaskID).map((approval) => approval.subtaskID!)))
  // Ticket #116: one shuffled-deck assignment state for the session. Variants
  // are resolved by subtask id and survive every snapshot refresh. Ticket #136
  // gives presentation retention its own clock, independent of Work visibility.
  // A blocked card also keeps the tide frame it had when it started waiting.
  const tideAssignments = createTideAssignments()
  const tideFreezes = createTideFreezeState()
  // Ticket #136: the Work pane is dispatch groups, not active cards plus
  // per-task recent cards. Group visibility and layout are pure; this memo
  // joins them to the static card mapping, activity detail, and tide
  // assignment. Ticket #142: it reads no animation clock. Only the glyph and
  // tide cells are rebuilt per frame, and value-equal cards keep their
  // previous reference across unrelated snapshot polls.
  const workCardCache = createWorkCardCache()
  type WorkPaneSection = WorkGroupSection & { cards: WorkCard[] }
  const workPane = createMemo(() => {
    // Track the dedicated expiry revision; a durable state change re-runs the
    // memo through activeTasks/state/approvals below.
    workRevision()
    const now = Date.now()
    const active = activeTasks()
    const groups = workGroupsForTasks(active, state()?.subtasks ?? {}, {
      now,
      pendingApprovalIDs: pendingApprovalIDs(),
      nativeBlockedSubtaskIDs: nativeBlockedSubtaskIDs(),
      resolvedAtForTask: approvalResolutionAt(state()?.approvals ?? {}),
    })
    const layout = workGroupLayout(groups, workContentWidth(), viewHeight(), now)
    const pendingApprovalSet = pendingApprovalIDs()
    const nativeBlockedSet = nativeBlockedSubtaskIDs()
    const options: WorkCardOptions = {
      now,
      width: Math.max(12, layout.cardContentWidth),
      pendingApprovalIDs: pendingApprovalSet,
      nativeBlockedSubtaskIDs: nativeBlockedSet,
      pendingFor: (item) => (pendingWork()?.id === item.id ? pendingWork()!.action : null),
      variantFor: (item) => tideVariantFor(tideAssignments, item.id, now),
      detailFor: (item) => activityStateForTask(item, {
        now,
        pendingApprovalIDs: pendingApprovalSet,
        nativeBlockedIDs: nativeBlockedSet,
        children: active.filter((child) => child.parentID === item.id),
        agentNameFor: (agentID) => agentName(state(), agentID),
      }).verb,
    }
    const sections: WorkPaneSection[] = layout.sections.map((section) => ({
      ...section,
      cards: section.mode === "cards"
        ? section.tasks.map((task) =>
            workCardForTaskCached(workCardCache, task, agentName(state(), task.assigneeID), options),
          )
        : [],
    }))
    pruneWorkCardCache(
      workCardCache,
      new Set(sections.flatMap((section) => section.cards.map((card) => card.id))),
    )
    pruneTideAssignments(tideAssignments, now)
    // A needs-you card stops the work clock, so its freeze frame has no
    // per-tick refresh. Keep frames for cards that are still on screen.
    retainTideFreezes(
      tideFreezes,
      new Set(
        sections
          .flatMap((section) => section.cards)
          .filter((card) => card.status === "working" && card.needsYou)
          .map((card) => card.id),
      ),
      now,
    )
    pruneTideFreezes(tideFreezes, now)
    return { groups, layout, sections, counts: workGroupCounts(groups) }
  })
  // Ticket #142: status deadlines, lease expiry, and the shared group hold
  // are wall-clock transitions, not animation. One one-shot timer invalidates
  // the static pane exactly when the next transition is due, so the group
  // lifecycle and honest statuses still settle with both motion clocks off.
  let workExpiryTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    workRevision()
    const now = Date.now()
    const next = nextWorkInvalidation(activeTasks(), workPane().groups, now)
    if (workExpiryTimer !== undefined) {
      clearTimeout(workExpiryTimer)
      workExpiryTimer = undefined
    }
    if (next === undefined) return
    // Node clamps delays above 2^31-1 ms to 1 ms, which would spin. Wake at
    // the cap instead and reschedule from the fresh deadline.
    const delay = Math.min(Math.max(0, next - now) + 1, 2_147_483_647)
    workExpiryTimer = setTimeout(() => {
      workExpiryTimer = undefined
      setWorkRevision((revision) => revision + 1)
    }, delay)
  })
  onCleanup(() => {
    if (workExpiryTimer !== undefined) {
      clearTimeout(workExpiryTimer)
      workExpiryTimer = undefined
    }
  })
  const cardedTaskIDs = createMemo(() => {
    const sections = workPane().sections
    return new Set(
      sections
        .filter((section) => section.mode === "cards")
        .flatMap((section) => section.cards.map((card) => card.id)),
    )
  })
  // Ticket #136: the cursor and every work action target only visible
  // non-terminal cards. Terminal cards remain display-only until their group
  // completes; overflow and summarized tasks are never selectable.
  const visibleTasks = createMemo(() => workPane().layout.selectableTasks)
  const taskCursorClamped = () => {
    const length = visibleTasks().length
    if (length <= 0) return 0
    return Math.max(0, Math.min(length - 1, taskCursor()))
  }
  const selectedTask = createMemo(() => visibleTasks()[taskCursorClamped()])
  createEffect(() => {
    const length = visibleTasks().length
    if (length <= 0) {
      if (taskCursor() !== 0) setTaskCursor(0)
      return
    }
    if (taskCursor() >= length) setTaskCursor(length - 1)
  })
  const workHeader = () => {
    const pane = workPane()
    const summary = workSummaryCounts(pane.counts.groups, pane.counts.active, pane.counts.done)
    const extras: string[] = []
    if (pane.layout.hiddenGroups > 0) {
      extras.push(`+${pane.layout.hiddenGroups} ${pane.layout.hiddenGroups === 1 ? "group" : "groups"}`)
    }
    if (pane.layout.mode === "compact" && pane.layout.overflow > 0) extras.push(`+${pane.layout.overflow} more`)
    return extras.length > 0 ? `${summary} ${chromeSeparator()} ${extras.join(` ${chromeSeparator()} `)}` : summary
  }
  // Compact/card-mode gap between card sections, matching the layout budget.
  const workSectionMarginTop = (index: number) =>
    workPane().sections.slice(0, index).some((section) => section.mode === "cards") ? 1 : 0
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
  // Ticket #141: the group transcript renders the bounded loaded window, not
  // a hard 40-row slice, so paging older rows can actually display them.
  const groupMessages = createMemo(() => {
    const workspace = activeWorkspace()
    return workspace ? (state()?.messages[workspace.id] ?? []) : []
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
      author: message.displayAuthor ?? (message.author === "user" ? "You" : message.author === "system" ? "Ensemble" : state()?.agents[message.agentID ?? ""]?.name ?? "Unknown agent"),
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
  // Ticket #80: search only the loaded transcript window (`chatLines` is
  // already sliced to TRANSCRIPT_WINDOW). Matches are literal and
  // case-insensitive; n/N moves the cursor with wraparound.
  const transcriptSearchMatches = createMemo<TranscriptMatch[]>(() => {
    const search = transcriptSearch()
    if (!search || !search.query.trim()) return []
    return transcriptMatches(chatLines(), search.query)
  })
  const searchLineState = (lineID: string) => {
    const search = transcriptSearch()
    if (!search) return null
    let count = 0
    let current = false
    transcriptSearchMatches().forEach((match, index) => {
      if (match.lineID !== lineID) return
      count++
      if (index === search.cursor) current = true
    })
    return count > 0 ? { count, current } : null
  }
  const chatRowID = (lineID: string) => `chat-${lineID.replace(/[^a-zA-Z0-9_-]/g, "_")}`
  const scrollMatchIntoView = (lineID: string) => queueMicrotask(() => {
    try { transcriptScrollRef?.scrollChildIntoView?.(chatRowID(lineID)) } catch {}
  })
  const moveSearchMatch = (direction: 1 | -1) => {
    const search = transcriptSearch()
    if (!search) return
    const matches = transcriptSearchMatches()
    if (matches.length === 0) { notify(`No matches: ${search.query}`, "info"); return }
    const cursor = matchIndexAfter(matches.length, search.cursor, direction)
    setTranscriptSearch({ ...search, cursor })
    const match = matches[cursor]
    notify(chromeJoin([`Match ${cursor + 1}/${matches.length}`, match.excerpt]), "info")
    scrollMatchIntoView(match.lineID)
  }
  const clearSearchAndFilter = (): boolean => {
    let cleared = false
    if (transcriptSearch()) { setTranscriptSearch(null); cleared = true }
    if (workspaceFilter()) { setWorkspaceFilter(""); cleared = true }
    return cleared
  }
  // Active-work surface: every streaming message renders its own live row
  // with per-item text, so concurrent work stays watchable. Finalization
  // flips streaming off, which moves that id from this list into the
  // finalized transcript — one id renders in exactly one place, so live
  // items fold into the transcript in place with no duplicates or stale
  // lines. The transcript scrollbox keeps a stable identity throughout.
  const liveMessages = createMemo(() => splitTranscript().live.filter((line) => {
    // The dedicated init row owns this System Agent stream; the generic
    // activity line would be a duplicate and could not show phases.
    if (initRowMessageIDs().has(line.id)) return false
    if (!line.taskID) return true
    const task = state()?.subtasks[line.taskID]
    return Boolean(task && !isTerminalWorkStatus(deriveWorkStatus(task, Date.now())))
  }))
  // Slice A (#64), ticket #136: the WORK block is ephemeral — it mounts while
  // a visible dispatch group has active work, needs the user, or is inside its
  // shared 1.2 s completion hold. Key actions remain active-only: the work
  // cursor and every work action come from the layout's visible non-terminal
  // tasks. Terminal outcomes render once as transcript system lines (the
  // durable record), and per-agent activity lines replace the raw streaming
  // dump: no streamed body text anywhere. The motion tick keeps the hold
  // closing reactive while the work clock owns the repaint.
  const hasActiveWorkNow = () => hasActiveWork(activeTasks(), Date.now())
  const showWorkBlock = createMemo(
    () => surface()?.kind === "workspace" && workPane().groups.length > 0,
  )
  // Slice C stop affordance (brief §2.5): while active work runs on the group
  // surface a run is abortable, so the composer names `Ctrl+C stop`; the hint
  // and the binding stay hidden otherwise. Terminal cards are display-only.
  const stoppable = () => surface()?.kind === "workspace" && hasActiveWorkNow()
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
  // Ticket #122 one-shot transcript feedback: a group message that was
  // observed streaming and then finalizes gets one brief brighter
  // border/background beat; failed/cancelled completions and interrupted
  // agent messages get one error beat. `observeTranscriptMotion` owns the
  // exactly-once guard, so heartbeat refreshes never restart a beat.
  // Reduced motion records the final state and emits nothing. The beat is a
  // short-lived signal only: row keys, the scrollbox, sticky scroll, and the
  // scroll cue are untouched.
  const [transcriptEmphasis, setTranscriptEmphasis] = createSignal(new Map<string, TranscriptEmphasisKind>())
  const transcriptMotion = createTranscriptMotionState()
  const transcriptEmphasisTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const clearTranscriptEmphasis = (id: string) => {
    const timer = transcriptEmphasisTimers.get(id)
    if (timer !== undefined) { clearTimeout(timer); transcriptEmphasisTimers.delete(id) }
    setTranscriptEmphasis((current) => {
      if (!current.has(id)) return current
      const next = new Map(current)
      next.delete(id)
      return next
    })
  }
  const flashTranscriptRows = (events: readonly TranscriptEmphasisEvent[]) => {
    for (const event of events) {
      setTranscriptEmphasis((current) => {
        const next = new Map(current)
        next.set(event.id, event.kind)
        return next
      })
      const previous = transcriptEmphasisTimers.get(event.id)
      if (previous !== undefined) clearTimeout(previous)
      const timer = setTimeout(() => clearTranscriptEmphasis(event.id), TRANSCRIPT_EMPHASIS_MS)
      timer.unref?.()
      transcriptEmphasisTimers.set(event.id, timer)
    }
  }
  onCleanup(() => {
    for (const timer of transcriptEmphasisTimers.values()) clearTimeout(timer)
    transcriptEmphasisTimers.clear()
  })
  // Fresh completions only: the completion map accumulates every terminal task
  // in the workspace, so a surface switch can replay history. Old outcomes are
  // already settled state, not new feedback to flash.
  const TRANSCRIPT_ERROR_FRESH_MS = 10_000
  // Direct conversations persist no streaming flag on the chat line: the live
  // row is synthetic. Remember the ids present when a live DM starts, then
  // mark the first new agent line after it ends as the finalizing row.
  const [dmFinalizeID, setDmFinalizeID] = createSignal<string | null>(null)
  let dmKnownIDs: Set<string> | null = null
  createEffect(() => {
    const live = liveDm()
    if (live) {
      if (dmKnownIDs === null) dmKnownIDs = new Set(chatLines().map((line) => line.id))
      if (dmFinalizeID() !== null) setDmFinalizeID(null)
      return
    }
    const known = dmKnownIDs
    if (!known) return
    if (surface()?.kind !== "agent") { dmKnownIDs = null; return }
    const candidate = chatLines()
      .filter((line) => !known.has(line.id) && line.role === "agent" && line.id !== "live")
      .at(-1)
    if (!candidate) return
    dmKnownIDs = null
    setDmFinalizeID(candidate.id)
  })
  const transcriptMotionRows = createMemo<TranscriptRowSignal[]>(() => {
    const now = Date.now()
    const dmFinalize = dmFinalizeID()
    const rows: TranscriptRowSignal[] = chatLines().map((line) => ({
      id: line.id,
      streaming: line.streaming,
      entering: line.id === dmFinalize,
      error: line.role === "agent" && Boolean(line.interrupted),
    }))
    for (const completion of completionMap().values()) {
      rows.push({
        id: completion.id,
        error: completion.tone === "error" && now - completion.at <= TRANSCRIPT_ERROR_FRESH_MS,
      })
    }
    return rows
  })
  createEffect(() => {
    const events = observeTranscriptMotion(transcriptMotion, transcriptMotionRows(), {
      enabled: !isReducedMotion(process.env),
    })
    if (events.length > 0) flashTranscriptRows(events)
  })
  // One time-ordered transcript window: conversation lines interleaved with
  // inline completions by (finish/created) time. The scrollbox keeps a stable
  // identity and the live/finalized partition stays intact upstream.
  // Ticket #72 idle-quiescence: merged wrappers are referentially stabilized
  // onto the previous array (same treatment as `stableLines` inner refs), so
  // Solid's `<For>` reconciles by stable reference and idle refreshes mount
  // nothing. New/changed rows still mount; ordering/partition untouched.
  let previousMergedRows: ReturnType<typeof mergeTranscriptRows<ChatLine>> = []
  const mergedRows = createMemo(() => {
    // Ticket #141: the loaded transcript page is already bounded by the
    // client store; the merge bound must cover it so older pages stay visible.
    const limit = Math.max(TRANSCRIPT_WINDOW, finalizedLines().length + completionMap().size)
    const fresh = mergeTranscriptRows(finalizedLines(), [...completionMap().values()], limit)
    const stable = stabilizeMergedRows(previousMergedRows, fresh)
    previousMergedRows = stable
    return stable
  })
  const liveActivity = createMemo(() => {
    const taskLive: ActivityEntry[] = []
    let queuedEntries: ActivityEntry[] = []
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
      queuedEntries = groups.queued
    }
    // Ticket #74: task-less streaming rows never synthesize the generic
    // checking verb. A fresh live row reads honest `working…` while a run
    // or recent delta exists; stale orphans and task-backed agents add
    // nothing, so finished turns leave no ghost line behind.
    const merged = mergeStreamingActivity(taskLive, liveMessages(), Date.now())
    // Ticket #115 follow-up: suppress the task-backed line only after the
    // merge. Keeping it in `taskLive` during the merge prevents the same
    // agent's streaming row from replacing the suppressed card detail.
    const visible = suppressCardedActivity({ live: merged, queued: queuedEntries }, cardedTaskIDs())
    const live = visible.live
    const queued = visible.queued.map((entry) => entry.label)
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
      liveInitJobs().length > 0 ||
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
    const decorate = (header: string) => {
      const hit = searchLineState(line.id)
      if (!hit) return header
      return `${hit.current ? "▶" : "▸"} ${header} · /${transcriptSearch()?.query ?? ""}`
    }
    let head = line.author
    if (line.role === "agent" && line.correlationID) {
      const relay = relayTaskForMessage({ correlationID: line.correlationID, agentID: line.agentID }, activeTasks())
      if (relay) {
        const parties = relayPartiesForTask(relay, (id) => agentName(state(), id))
        if (parties) return decorate(bubbleHead(line.author, parties))
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
    return decorate(header)
  }
  let refreshingTranscriptNewest = false
  const syncTranscriptScroll = () => {
    const box = transcriptScrollRef
    if (!box) { setAtBottom(true); return }
    const height = Number(box.height ?? messageHeight())
    const scrollHeight = Number(box.scrollHeight ?? 0)
    const scrollTop = Number(box.scrollTop ?? 0)
    const max = Math.max(0, scrollHeight - height)
    const bottom = scrollTop >= max - 1
    setAtBottom(bottom)
    setTranscriptScroll({ top: scrollTop, height: scrollHeight, viewport: height })
    // Ticket #141 review fix: while an older page anchors the window, a new
    // patch must not discard it. Returning to the bottom replaces the loaded
    // range with the newest bounded window and releases the anchor.
    if (bottom && !refreshingTranscriptNewest) {
      const current = surface()
      const target = current?.kind === "workspace" ? current.workspaceID : undefined
      if (target && client.transcriptAnchored(target)) {
        refreshingTranscriptNewest = true
        void loadScoped(["transcript"])
          .catch(() => undefined)
          .finally(() => { refreshingTranscriptNewest = false })
      }
    }
  }
  const jumpToBottom = () => {
    const box = transcriptScrollRef
    if (box) box.scrollTop = Number(box.scrollHeight ?? 0)
    setAtBottom(true)
    queueMicrotask(() => syncTranscriptScroll())
  }

  // Ticket #141: page older durable transcript windows on demand. The client
  // keeps one bounded loaded window per workspace, not all history.
  let loadingOlderTranscript = false
  const loadOlderTranscript = async () => {
    if (loadingOlderTranscript || !scopedReads || surface()?.kind !== "workspace") return
    const workspace = activeWorkspace()
    const window = workspace ? client.windowFor(workspace.id) : undefined
    if (!workspace || !window?.hasMoreOlder || window.oldestSeq === undefined) return
    loadingOlderTranscript = true
    const box = transcriptScrollRef
    const previousHeight = Number(box?.scrollHeight ?? 0)
    try {
      const next = await callRpc<TranscriptWindow & { version: number; epoch: number }>(context, "transcript.window", {
        directory: directoryOf(context),
        workspaceID: workspace.id,
        beforeSeq: window.oldestSeq,
        limit: window.limit,
      })
      client.applyTranscriptWindow(workspace.id, next, "older")
      try { (context.renderer as any)?.requestRender?.() } catch {}
      queueMicrotask(() => {
        const added = Number(box?.scrollHeight ?? 0) - previousHeight
        if (box && added > 0) box.scrollTop = Number(box.scrollTop ?? 0) + added
        syncTranscriptScroll()
      })
    } catch {
      // A missing older page is harmless; the loaded window stays usable.
    } finally {
      loadingOlderTranscript = false
    }
  }
  const maybeLoadOlderTranscript = () => {
    const box = transcriptScrollRef
    if (!box || loadingOlderTranscript || atBottom()) return
    if (Number(box.scrollHeight ?? 0) <= Number(box.height ?? 0)) return
    if (Number(box.scrollTop ?? 0) > 1) return
    void loadOlderTranscript()
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
  // cursor. The unified settings cursor now drives it (#83).
  const skillPage = () => skillPageForCursor(clampSettingsRow(settingsCursor(), settingsCounts().skills))
  const filteredMemories = createMemo(() => filterMemories(agentMemories(), memoryFilter()))
  // A freshly saved memory is selected by id once the snapshot carrying it
  // arrives. This removes the stale-list guess: no sleep and no reliance on
  // the order of an event refresh vs. the explicit mutation refresh.
  createEffect(() => {
    const id = pendingMemorySelectID()
    if (!id) return
    if (settingsTab() !== "memories" || !settingsAgentID()) { setPendingMemorySelectID(null); return }
    const index = filteredMemories().findIndex((memory) => memory.id === id)
    if (index < 0) return
    setPendingMemorySelectID(null)
    setSettingsCursor(index)
  })
  // Ticket #83: one cursor and one row model across all four tabs. The
  // catalog owns the keys; the pure grammar owns counts, clamping, and which
  // action a row supports.
  const settingsCounts = createMemo(() => ({
    backups: draft()?.backupModels.length ?? 0,
    memories: filteredMemories().length,
    skills: filteredSkills().length,
  }))
  const settingsRowTotal = () => settingsRowCount(settingsTab(), settingsCounts())
  const settingsCursorClamped = () => clampSettingsRow(settingsCursor(), settingsRowTotal())
  const settingsCurrentKind = () => settingsRowKind(settingsTab(), settingsCursorClamped(), settingsCounts())
  const settingsActionEnabled = (id: string): boolean => {
    switch (id) {
      case "settings.add":
        return settingsAddAction(settingsTab()) !== "none"
      case "settings.delete":
        return settingsDeleteAction(settingsTab()) === "memory"
          ? settingsCounts().memories > 0
          : (settingsDeleteAction(settingsTab()) === "backup" && settingsCounts().backups > 0)
      case "settings.promote":
        return settingsPromoteAction(settingsTab()) === "memory" && settingsCounts().memories > 0
      case "settings.backup.down":
      case "settings.backup.up":
        return settingsReorderAction(settingsTab()) === "backup" && settingsCursorClamped() >= 1
      case "settings.toggle":
        return settingsToggleAction(settingsTab()) === "skill" && settingsRowTotal() > 0
      case "settings.filter":
        return settingsFilterable(settingsTab())
      case "settings.edit":
      case "settings.edit.alt":
        return settingsRowTotal() > 0
      default:
        return true
    }
  }
  const setSettingsTabTo = (tab: SettingsTab) => {
    setSettingsTab(tab)
    setSettingsCursor(0)
  }
  const selectedMissingSkills = createMemo(() => {
    const agent = draft() ?? selectedAgent()
    return agent ? missingSkills(agent, skills()) : []
  })
  // Ticket #124: a missing-skill warning emphasizes once when its set first
  // appears on the Skillbox tab. Snapshot paints and same-set refreshes do not
  // re-signal, so the warning never loops back into motion.
  const missingSkillsTracker = createMissingSkillsTracker()
  createEffect(() => {
    if (!settingsAgentID() || settingsTab() !== "skillbox") return
    const feedback = trackMissingSkills(missingSkillsTracker, selectedMissingSkills())
    if (feedback) signalSettingsFeedback(feedback)
  })
  const statuslineWidth = () => Math.max(10, renderSize().width - 2)
  const pickerGeometry = () => overlayGeometry(viewWidth(), viewHeight(), 16)
  const promptGeometry = () => overlayGeometry(viewWidth(), viewHeight(), 14)
  const confirmGeometry = () => overlayGeometry(viewWidth(), viewHeight(), 10)
  const resultGeometry = () => overlayGeometry(viewWidth(), viewHeight(), 18)
  const logsHeight = 22
  const logsGeometry = () => overlayGeometry(viewWidth(), viewHeight(), logsHeight)
  const wizardHeight = 20
  const wizardGeometry = () => overlayGeometry(viewWidth(), viewHeight(), wizardHeight)

  const isOurRoute = () => {
    const route = context.ui.router.current()
    return route.type === "plugin" && route.name === "ensemble"
  }
  // Ticket #91: a page left mounted behind the native route must not own raw
  // keys. The newest mount alone is not enough; the Ensemble route must be
  // visible too.
  const ownsRawKeys = () => pageActivation.ownsRawKeys(pageToken, isOurRoute())
  const isModal = () => modal() || helpOpen() || approvalsOpen() || logsOpen() || Boolean(settingsAgentID())
  // Ticket #119: feedback raised while a dialog owns the surface goes to the
  // statusline; the toast never paints over a modal. The host toast remains a
  // fallback only when this page is not the visible route.
  const isToastModal = () => isModal() || wizard() !== null
  const showToast = (input: ToastInput) => {
    if (!isOurRoute()) { showHostToast(input); return }
    if (feedbackChannel(isToastModal()) === "statusline") {
      const tone = input.tone === "error" ? "error" : input.tone === "success" ? "success" : "info"
      notify(`${input.title}: ${input.message}`, tone)
      return
    }
    setToasts((state) => pushToast(state, input, Date.now()))
  }
  createEffect(() => {
    const deadline = nextToastDeadline(toasts())
    if (toastTimer !== undefined) { clearTimeout(toastTimer); toastTimer = undefined }
    if (deadline === undefined) return
    toastTimer = setTimeout(() => {
      toastTimer = undefined
      setToasts((state) => expireToasts(state, Date.now()))
    }, Math.max(0, deadline - Date.now()))
  })
  onCleanup(() => { if (toastTimer !== undefined) clearTimeout(toastTimer) })
  // Init completion is asynchronous: report the transition into a terminal
  // state, not every snapshot. Jobs that finished before this page mounted are
  // already represented by their System Agent transcript report and stay quiet.
  const appStartedAt = Date.now()
  let knownInitStates = new Map<string, InitJobState>()
  let initStatesInitialized = false
  createEffect(() => {
    const jobs = state()?.initJobs
    if (!jobs) return
    const entries = Object.entries(jobs)
    for (const [id, job] of entries) {
      const previous = knownInitStates.get(id)
      const firstSeenTerminal = previous === undefined && !initStatesInitialized && job.startedAt >= appStartedAt
      const terminalAfterRunning = previous === "running" && job.state !== "running"
      const firstSeenAfterRunning = previous === undefined && initStatesInitialized && job.state !== "running" && job.startedAt >= appStartedAt
      if (terminalAfterRunning || firstSeenTerminal || firstSeenAfterRunning) {
        const feedback = initToast(job.state, job.error)
        if (feedback) showToast(feedback)
      }
    }
    knownInitStates = new Map(entries.map(([id, job]) => [id, job.state]))
    initStatesInitialized = true
  })
  const isBusy = () => busy() || chatContext()?.busy === true

  const overlayOpen = () => picker() !== null || textPrompt() !== null || wizard() !== null || confirm() !== null || result() !== null || logsOpen()

  // Ticket #120: opening a shell overlay plays one short opacity settle while
  // the background panes stay dimmed. Only the panel opacity changes: no
  // geometry, layout, focus, mode, overlay ownership, or key routing moves.
  // Close clears the timer and resets the baseline so repeated open/close
  // cannot leave stale translucency; reduced motion mounts at full opacity.
  // The key is memoized so unrelated state churn inside an open panel (a
  // wizard filter keystroke, approvals list refresh) cannot restart the
  // one-shot presence settle or leave the panel translucent. Only a change of
  // the owning panel produces a new key.
  const overlayPanelKey = createMemo(() => presencePanelKey({
    picker: picker() !== null,
    prompt: textPrompt() !== null,
    confirm: confirm() !== null,
    result: result() !== null,
    wizard: wizard() !== null,
    logs: logsOpen(),
    help: helpOpen(),
    approvals: approvalsOpen(),
    leader: leaderPopup(),
  }))
  let overlayPresenceTimer: ReturnType<typeof setInterval> | undefined
  const stopOverlayPresence = () => {
    if (overlayPresenceTimer === undefined) return
    clearInterval(overlayPresenceTimer)
    overlayPresenceTimer = undefined
  }
  const syncOverlayPresence = () => {
    const key = overlayPanelKey()
    onCleanup(stopOverlayPresence)
    setOverlayPresenceKey(key)
    setOverlayPresence(overlayPresenceOpacity(0))
    if (key === "none" || isReducedMotion()) return
    const startedAt = Date.now()
    overlayPresenceTimer = setInterval(() => {
      const elapsed = Date.now() - startedAt
      setOverlayPresence(overlayPresenceOpacity(elapsed))
      if (elapsed >= OVERLAY_PRESENCE_MS) stopOverlayPresence()
    }, OVERLAY_PRESENCE_STEP_MS)
  }
  createEffect(syncOverlayPresence)
  const overlayOpacity = () => {
    const key = overlayPanelKey()
    if (key === "none") return 1
    return overlayPresenceKey() === key ? overlayPresence() : overlayPresenceOpacity(0)
  }

  // Ticket #121: the rail observes one snapshot baseline and emits a pulse only
  // when unread work, the pending-approval count, or the row set actually
  // changes. The first populated snapshot is the baseline, so opening Ensemble
  // does not flash the whole rail. Pulses and arrivals share one short timer;
  // it stops as soon as the last one-shot window closes. Reduced motion still
  // advances the baseline but suppresses every pulse and timer.
  const railAttentionInput = createMemo<RailAttentionSnapshot | null>(() => {
    const snapshot = state()
    if (!snapshot) return null
    const serverCounts = client.counts()
    const unread: Record<string, number> = {}
    for (const workspace of workspaces()) unread[workspace.id] = serverCounts?.[workspace.id]?.unread ?? unreadCount(snapshot, workspace)
    return {
      unread,
      approvals: pendingApprovals().length,
      rows: [
        ...rosterAgents().map((agent) => railRowKey("agent", agent.id)),
        ...workspaces().map((workspace) => railRowKey("workspace", workspace.id)),
      ],
    }
  })
  let railAttentionState: RailAttentionState | null = null
  let railPulseStarts: RailPulseStart[] = []
  let railPulseTimer: ReturnType<typeof setInterval> | undefined
  let railEmphasisKey = ""
  const stopRailPulseTimer = () => {
    if (railPulseTimer === undefined) return
    clearInterval(railPulseTimer)
    railPulseTimer = undefined
  }
  const railStartActive = (start: RailPulseStart, now: number) => {
    const elapsed = now - start.startedAt
    return start.pulse.kind === "arrival" ? railArrivalActive(elapsed, process.env) : railPulseActive(elapsed, process.env)
  }
  const publishRailEmphasis = () => {
    const now = Date.now()
    const active = railPulseStarts.filter((start) => railStartActive(start, now))
    if (active.length !== railPulseStarts.length) {
      railPulseStarts = active
      if (active.length === 0) stopRailPulseTimer()
    }
    const key = active.map((start) => `${start.pulse.kind}:${start.pulse.id}`).sort().join("\u0000")
    if (key === railEmphasisKey) return
    railEmphasisKey = key
    setRailEmphasis(railEmphasisAt(active, now, process.env))
  }
  const syncRailAttention = () => {
    const input = railAttentionInput()
    if (!input) return
    const observed = observeRailAttention(railAttentionState, input)
    railAttentionState = observed.state
    if (observed.pulses.length === 0 || isReducedMotion()) return
    const now = Date.now()
    for (const pulse of observed.pulses) {
      railPulseStarts = railPulseStarts.filter((start) => !(start.pulse.kind === pulse.kind && start.pulse.id === pulse.id))
      railPulseStarts.push({ pulse, startedAt: now })
    }
    publishRailEmphasis()
    if (railPulseTimer === undefined) railPulseTimer = setInterval(publishRailEmphasis, RAIL_PULSE_STEP_MS)
  }
  createEffect(syncRailAttention)
  onCleanup(stopRailPulseTimer)

  // v5.6 T2 command and search. `:`/`/` open a one-line input in the bottom
  // bar; the pure commands/history/search modules own parsing, recall, and
  // match navigation. The adapter here only previews filters, records
  // history, and maps command names onto existing navigation and state
  // actions.
  const commandTarget = (): CommandTarget | null => {
    if (settingsAgentID()) return "settings"
    if (!surface() || focusArea() === "rail") return "roster"
    return "transcript"
  }
  const canOpenCommand = () =>
    !leaderMode() && !wizard() && !picker() && !textPrompt() && !confirm() && !result() &&
    !helpOpen() && !approvalsOpen() && settingsField() === null

  const applySearchPreview = (target: CommandTarget, text: string) => {
    if (target === "roster") { setTranscriptSearch(null); setWorkspaceFilter(text); return }
    if (target === "settings") {
      setTranscriptSearch(null)
      if (settingsTab() === "memories") { setMemoryFilter(text); setSettingsCursor(0) }
      else if (settingsTab() === "skillbox") { setSkillFilter(text); setSettingsCursor(0) }
      return
    }
    const query = text.trim()
    setTranscriptSearch(query ? { query, cursor: 0 } : null)
  }

  const restoreCommandPreview = () => {
    const session = commandSession
    if (!session) return
    setWorkspaceFilter(session.previous.workspaceFilter)
    setMemoryFilter(session.previous.memoryFilter)
    setSkillFilter(session.previous.skillFilter)
    setTranscriptSearch(session.previous.search)
  }

  const openCommandLine = (kind: ":" | "/"): boolean => {
    if (commandActive() || !canOpenCommand()) return false
    const target = commandTarget()
    if (kind === "/" && !target) {
      notify("Search is available on the roster, a chat, or settings.", "info")
      return false
    }
    commandSession = {
      target: target ?? "roster",
      previous: {
        workspaceFilter: workspaceFilter(),
        memoryFilter: memoryFilter(),
        skillFilter: skillFilter(),
        search: transcriptSearch(),
      },
    }
    setCommandHistory((history) => startHistory(history, kind))
    dispatchInteraction({ type: "command.open", kind, text: "" })
    // A search starts from the whole surface so the typed query is the only
    // filter visible; Esc restores the captured filter/state.
    if (kind === "/" && target) applySearchPreview(target, "")
    return true
  }

  const updateCommandText = (text: string, cursor = text.length) => {
    const kind = interaction().command?.kind
    dispatchInteraction({ type: "command.update", text, cursor })
    if (kind === "/" && commandSession) applySearchPreview(commandSession.target, text)
  }

  const closeCommandLine = (restore: boolean) => {
    if (restore) restoreCommandPreview()
    commandSession = undefined
    dispatchInteraction({ type: "command.close" })
  }

  const runNamedCommand = async (command: ParsedCommand): Promise<void> => {
    switch (command.name) {
      case "settings": openSettings(); return
      case "approvals": openApprovals(); return
      case "workspace": await pickWorkspace(); return
      case "agent": await pickAgent(); return
      case "new-agent": await createAgent(); return
      case "new-workspace": await createWorkspace(); return
      case "edit-workspace": await editWorkspace(); return
      case "pause": await togglePause(true); return
      case "resume": await togglePause(false); return
      case "init": await initEnsemble(); return
      case "native": openNative(); return
      case "logs": openLogs(command.args ?? []); return
      case "help": openHelp(); return
      case "q": leaveEnsemble(); return
    }
  }

  const submitCommandLine = async (): Promise<void> => {
    const current = interaction().command
    if (!current) return
    const { kind, text } = current
    const session = commandSession
    setCommandHistory((history) => rememberHistory(history, kind, text))
    closeCommandLine(false)

    if (kind === ":") {
      const initIssue = initComposerIssue(`:${text}`)
      if (initIssue) {
        notify(initIssue, "error")
        return
      }
      const parsed = parseCommandLine(text)
      if (!parsed) {
        notify(text.trim() ? `Unknown command: ${text.trim()}` : "Enter a command.", "error")
        return
      }
      await runNamedCommand(parsed)
      return
    }

    if (!session) return
    const query = text.trim()
    if (session.target === "transcript") {
      if (!query) { setTranscriptSearch(null); notify("Search cleared", "info"); return }
      const matches = transcriptMatches(chatLines(), query)
      if (matches.length === 0) { notify(`No matches: ${query}`, "info"); return }
      setTranscriptSearch({ query, cursor: 0 })
      notify(chromeJoin([`Match 1/${matches.length}`, matches[0].excerpt]), "info")
      scrollMatchIntoView(matches[0].lineID)
      return
    }
    if (session.target === "roster") {
      setWorkspaceFilter(text)
      const count = railItems().length
      notify(chromeJoin([`${count} roster ${count === 1 ? "match" : "matches"}`, `/${query}`]), "info")
      return
    }
    const count = settingsTab() === "memories" ? filteredMemories().length : settingsTab() === "skillbox" ? filteredSkills().length : 0
    notify(chromeJoin([`${count} settings ${count === 1 ? "match" : "matches"}`, `/${query}`]), "info")
  }

  const handleCommandKey = (event: any): boolean => {
    const current = interaction().command
    if (!current) return false
    event?.preventDefault?.(); event?.stopPropagation?.()
    const token = normalizeKeyToken(event)
    const entry = singleKeyEntry("command", token)
    if (entry) {
      switch (entry.id) {
        case "command.run":
          void submitCommandLine().catch(showError)
          return true
        case "command.cancel":
          closeCommandLine(true)
          return true
        case "command.history.up":
        case "command.history.down": {
          const recalled = recallHistory(commandHistory(), current.kind, entry.id === "command.history.up" ? "up" : "down", current.text)
          setCommandHistory(recalled.history)
          updateCommandText(recalled.text)
          return true
        }
        case "command.complete":
          if (current.kind === ":") {
            const completed = completeCommand(current.text)
            if (completed) updateCommandText(completed)
          }
          return true
        case "command.left":
          updateCommandText(current.text, current.cursor - 1)
          return true
        case "command.right":
          updateCommandText(current.text, current.cursor + 1)
          return true
        case "command.home":
          updateCommandText(current.text, 0)
          return true
        case "command.end":
          updateCommandText(current.text, current.text.length)
          return true
        case "command.backspace": {
          const edited = editLine(current.text, current.cursor, "backspace")
          updateCommandText(edited.text, edited.cursor)
          return true
        }
        case "command.delete": {
          const edited = editLine(current.text, current.cursor, "delete")
          updateCommandText(edited.text, edited.cursor)
          return true
        }
      }
    }
    const sequence = String(event?.sequence ?? "")
    if (sequence.length === 1 && sequence >= " " && !event?.ctrl && !event?.meta && !event?.super) {
      const edited = editLine(current.text, current.cursor, { insert: sequence })
      updateCommandText(edited.text, edited.cursor)
    }
    return true
  }

  // Slice E single-focus model (brief §2.10): exactly one focus-colored border
  // renders at all times. Precedence is dialog, then composer, then the
  // column — `focusArea` stays the persisted rail/chat column while the
  // composer focus state derives from `composerActive`, so the two can never
  // drift apart. Help/settings/approvals render inside the chat surface and
  // inherit its border; only true overlays steal it.
  const chromeFocus = () => resolveChromeFocus({ focusArea: focusArea(), composerActive: composerActive(), overlayOpen: overlayOpen() })

  // v5.6 T3/T5: the generated Normal keymap layers are enabled for exactly
  // one of these contexts at a time. Settings is a modal context but its rows
  // use the same grammar; a focused settings field owns the keys first.
  const surfaceKeyContext = (): KeyContext | null => {
    if (!isOurRoute() || leaderMode() || wizard() !== null) return null
    if (interaction().command !== null) return null
    if (settingsAgentID()) {
      if (settingsField() !== null || overlayOpen()) return null
      return "settings"
    }
    if (isModal() || interaction().overlay !== "none") return null
    if (composerActive()) return null
    switch (interaction().focus) {
      case "rail": return "roster"
      case "chat": return "chat"
      case "work": return "work"
      default: return null
    }
  }
  const hasWorkZone = () => visibleTasks().length > 0

  const run = async (label: string, action: () => Promise<void>): Promise<boolean> => {
    if (busy()) return false
    setBusy(true)
    try { await action(); await refresh(); return true } catch (error: any) {
      const message = error?.message ?? String(error)
      setStatus(`${label}: ${message}`)
      notify(`${label}: ${message}`, "error")
      showToast({ title: "Ensemble", message: error?.message ?? String(error), tone: "error" })
      return false
    } finally { setBusy(false) }
  }

  const loadChat = async () => {
    const value = surface()
    if (value?.kind !== "agent") { setChatContext(null); return }
    try {
      const next = await invoke(context, "chat.context", { agentID: value.agentID, workspaceID: value.workspaceID })
      const current = surface()
      if (current?.kind !== "agent" || current.agentID !== value.agentID || current.workspaceID !== value.workspaceID) return
      setChatContext(next)
    } catch (error: any) {
      const current = surface()
      if (current?.kind !== "agent" || current.agentID !== value.agentID || current.workspaceID !== value.workspaceID) return
      setChatContext(null)
      setStatus(`Chat unavailable: ${error?.message ?? error}`)
    }
  }
  // Same coalescing as the snapshot path: a slow chat fetch never starves and
  // a surface switch queues one dirty pass for the new target.
  const refreshChat = async () => {
    chatRefresh.request()
    await chatRefresh.whenIdle()
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
    const next = readGitState(directory)
    const change = describeGitChange(gitState(), next)
    setGitState(next)
    if (change) showToast({ title: "Git", message: change.message, tone: change.tone })
  }

  // Ticket #141: the first fetch tries the gated scoped bootstrap. If the
  // server does not advertise protocol 4, the full snapshot path is kept.
  let scopedReads = false
  let bootstrapTried = false

  const applyStateEffects = (next: Snapshot) => {
    try { (context.renderer as any)?.requestRender?.() } catch {}
    if (next.configError && next.configError !== lastConfigError) {
      lastConfigError = next.configError
      showToast({ title: "Ensemble config", message: next.configError, tone: "warning" })
    }
    if (!next.configError) lastConfigError = ""
    // Ticket #77d: keep the composer focused across snapshot repaints. A
    // poll that lands between typing and Enter must not silently drop the
    // key because the textarea lost focus.
    if (composerActive() && interaction().mode === "insert") focusWhenReady(() => composerRef)
    syncTranscriptScroll()
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
        // from an older session lands on the chat surface, which now owns the
        // inline work rows.
        if (history?.column) setFocusArea(history.column === ("tasks" as string) ? "chat" : history.column)
        const taskID = history?.taskID ?? uiState.taskID
        if (taskID) {
          const index = visibleTasks().findIndex((task) => task.id === taskID)
          if (index >= 0) setTaskCursor(index)
        }
      }
    } else {
      if (!currentWorkspace || !next.state.workspaces[currentWorkspace] || next.state.workspaces[currentWorkspace].archived) setWorkspaceID(null)
      if (!surface()) setSurface(null)
    }
    if (surface()?.kind === "agent") chatRefresh.request()
    refreshGit()
    const current = surface()
    if (current?.kind === "workspace" && !next.state.workspaces[current.workspaceID]) setSurface(null)
    if (current?.kind === "agent" && !next.state.agents[current.agentID]) setSurface(null)
    setStatus(chromeJoin([`${workspaces().length} workspaces`, `${rosterAgents().length} agents`, `${activeCount()} working`]))
  }

  const loadSnapshot = async () => {
    const next = await callRpc<Snapshot>(context, "snapshot", { directory: directoryOf(context) })
    const nextMeta = snapshotMeta(next)
    // A feed reset or epoch change forces a real replacement even when the
    // restarted store reports a version the client has not seen before.
    const forced = forceSnapshotReplace
    forceSnapshotReplace = false
    const apply = forced ? "replace" : decideSnapshotApply(lastSnapshotMeta, nextMeta)
    if (apply === "skip") return
    lastSnapshotMeta = nextMeta
    if (apply === "replace") client.applySnapshot(next)
    else client.applyMetadata(next)
    // An equal-version snapshot only refreshes catalog/config metadata; entity
    // state, selection, workspace restoration, and git state stay untouched.
    if (apply === "metadata") return
    applyStateEffects(next)
  }

  /** Initial gated bootstrap: shell + visible Work + one transcript window. */
  const loadBootstrap = async () => {
    const current = activeWorkspace()?.id ?? workspaceID() ?? undefined
    const next = await callRpc<Snapshot>(context, "bootstrap", {
      directory: directoryOf(context),
      ...(current ? { workspaceID: current } : {}),
    })
    forceSnapshotReplace = false
    const meta = snapshotMeta(next)
    // Review fix: the gate decides the steady-state path. A full bootstrap
    // still carries its measured gate, so a borderline workspace can switch
    // to scoped reads on the next refresh.
    scopedReads = supportsScopedReads(meta) && (next.scoped === true || next.gate?.enabled === true)
    lastSnapshotMeta = meta
    client.applySnapshot(next)
    applyStateEffects(next)
  }

  const syncScopedSelection = () => {
    const current = surface()
    if (current?.kind === "workspace" && !state()?.workspaces[current.workspaceID]) setSurface(null)
    if (current?.kind === "agent" && !state()?.agents[current.agentID]) setSurface(null)
    if (workspaceID() && !state()?.workspaces[workspaceID()!]) setWorkspaceID(null)
  }

  /** Apply one scoped resync atomically; only returned scopes are replaced. */
  const applyScopedResync = (result: ScopedResync, requestedWorkspaceID?: string) => {
    // A patch may have advanced the cursor while the resync was in flight.
    // Never rewind entity state to an older durable version.
    if (lastSnapshotMeta && result.epoch === lastSnapshotMeta.epoch && result.version < lastSnapshotMeta.version) return
    batch(() => {
      if (result.shell) client.applyShellSnapshot(result.shell)
      if (result.work) client.applyWorkProjection(result.work, result.version)
      const window = result.transcript
      const target = window?.workspaceID ?? requestedWorkspaceID
      if (window && target) client.applyTranscriptWindow(target, window, "replace")
      client.applyCounts(result.counts)
      if (result.meta) client.applyChanges([], undefined, result.meta, result.counts)
      if (lastSnapshotMeta) lastSnapshotMeta = { ...lastSnapshotMeta, version: result.version, epoch: result.epoch }
    })
    syncScopedSelection()
    repaintFromFeed()
  }

  const loadScoped = async (scopes: ScopeName[] = ["shell", "work", "transcript"]): Promise<boolean> => {
    const target = activeWorkspace()?.id ?? workspaceID() ?? undefined
    logger.event("debug", "refresh", "refresh.scoped", { scopes, workspaceID: target })
    const result = await callRpc<ScopedResync>(context, "resync", {
      directory: directoryOf(context),
      scopes,
      ...(target ? { workspaceID: target } : {}),
    })
    // Review fix: a disabled gate means the caller must keep the snapshot path.
    if (result.gate && !result.gate.enabled) {
      scopedReads = false
      return false
    }
    applyScopedResync(result, target)
    return true
  }

  /** First fetch and later refresh both select the cheapest valid read path. */
  const loadData = async () => {
    if (forceSnapshotReplace) return loadSnapshot()
    if (!bootstrapTried) {
      bootstrapTried = true
      try {
        await loadBootstrap()
        return
      } catch {}
    }
    if (scopedReads) {
      try {
        if (await loadScoped()) return
      } catch {}
    }
    return loadSnapshot()
  }

  // Ensure at least one fetch that started at or after this call settles. The
  // coordinator queues a dirty pass when an earlier fetch is still in flight.
  const refresh = async () => {
    snapshotRefresh.request()
    await snapshotRefresh.whenIdle()
  }

  // Ticket #138: the fine-grained feed path. Applying a validated batch
  // touches only the changed Work entities; a gap or malformed batch asks the
  // server for `changes.since`, then falls back to a scoped Work snapshot and
  // finally to the full snapshot boundary.
  const repaintFromFeed = () => {
    try { (context.renderer as any)?.requestRender?.() } catch {}
  }
  // Ticket #139: workspace live text and direct-chat deltas share one
  // coalescing primitive, so a burst updates the visible row once per window.
  // The workspace event is already an accumulated-text snapshot; the direct
  // path appends native deltas locally.
  const groupStream = createStreamCoalescer<MessageStream>((updates) => {
    for (const update of updates.values()) client.applyStream(update)
    repaintFromFeed()
  })
  const dmStream = createStreamCoalescer<string>((updates) => {
    const context = chatContext()
    if (surface()?.kind !== "agent") return
    for (const [sessionID, text] of updates) {
      if (context?.sessionID === sessionID) setLiveDm({ sessionID, text })
    }
  })
  const applyFeedDecision = (decision: PatchDecision, counts?: Record<string, WorkspaceCounts>): boolean => {
    if (decision.action !== "apply") return false
    logger.event("debug", "refresh", "refresh.patch", {
      version: decision.version,
      changes: decision.changes.length,
      meta: decision.meta !== undefined,
      epoch: lastSnapshotMeta?.epoch,
    })
    client.applyChanges(decision.changes, decision.version, decision.meta, counts)
    if (lastSnapshotMeta) {
      lastSnapshotMeta = mergeFeedMeta({ ...lastSnapshotMeta, version: decision.version }, decision.meta)
    }
    if (decision.meta && configMetadataApplies(decision.meta.directory, directoryOf(context))) {
      const configError = decision.meta.configError ?? ""
      if (configError && configError !== lastConfigError) {
        lastConfigError = configError
        showToast({ title: "Ensemble config", message: configError, tone: "warning" })
      }
      if (!configError) lastConfigError = ""
    }
    repaintFromFeed()
    return true
  }
  const refreshFull = async (): Promise<void> => {
    logger.event("debug", "refresh", "refresh.full", { version: lastSnapshotMeta?.version, epoch: lastSnapshotMeta?.epoch })
    forceSnapshotReplace = true
    snapshotRefresh.request()
    await snapshotRefresh.whenIdle()
  }
  // Ticket #150: a foreign boot epoch has no comparable cursor. Collapse a
  // burst into one forced snapshot after a 200 ms window and never enter the
  // changes.since loop.
  const foreignEpochRefresh = createRefreshCoordinator({
    run: () => { void refreshFull().catch(() => undefined) },
    delayMs: 200,
  })
  // Ticket #150 follow-up: count every gap, but emit one truthful summary per
  // window. Recovered catch-ups are debug; only a full-snapshot fallback or
  // exhausted recovery passes warn.
  const feedGapReporter = createFeedGapReporter({
    emit: (level, event, fields) => logger.event(level, "feed", event, fields),
    count: () => logger.recordFeedGap(),
  })
  /** Review fix: a Work-shaped bad batch repairs only the Work scope. */
  const recoverWorkScope = async (): Promise<void> => {
    if (scopedReads && supportsScopedReads(lastSnapshotMeta)) {
      try {
        if (await loadScoped(["work"])) return
      } catch {}
    }
    await refreshFull().catch(() => undefined)
  }
  let feedRecovery: Promise<void> | undefined
  let feedRecoveryAgain = false
  let feedRecoverySettle: ((outcome: "recovered" | "full" | "exhausted") => void) | undefined
  const recoverFeed = (onOutcome?: (outcome: "recovered" | "full" | "exhausted") => void): Promise<void> => {
    if (feedRecovery) {
      feedRecoveryAgain = true
      if (onOutcome && !feedRecoverySettle) feedRecoverySettle = onOutcome
      return feedRecovery
    }
    feedRecoverySettle = onOutcome
    feedRecovery = (async () => {
      let outcome: "recovered" | "full" | "exhausted" = "recovered"
      try {
        let passes = 0
        do {
          feedRecoveryAgain = false
          passes++
          const cursor = lastSnapshotMeta
          if (!cursor || !supportsPatchFeed(cursor)) {
            await refreshFull().catch(() => undefined)
            outcome = "full"
            continue
          }
          let result: ChangesSince
          try {
            result = await callRpc<ChangesSince>(context, "changes.since", {
              directory: directoryOf(context),
              epoch: cursor.epoch,
              version: cursor.version,
            })
          } catch {
            await refreshFull().catch(() => undefined)
            outcome = "full"
            continue
          }
          const decision = decideChangesSince(cursor, result)
          if (decision.action === "apply") {
            applyFeedDecision(decision, result.counts)
            continue
          }
          if (decision.action === "ignore") {
            if (result.counts) client.applyCounts(result.counts)
            continue
          }
          // Ticket #141: a gap or reset names only the scopes that moved after
          // the cursor; unchanged shell/Work/transcript branches stay put.
          // An epoch change has no comparable cursor and takes the full
          // snapshot fallback.
          if (scopedReads && supportsScopedReads(cursor) && decision.reason !== "epoch") {
            const scopes = scopesToResync(cursor.version, result.scopeVersions)
            if (scopes.length > 0) {
              try {
                if (await loadScoped(scopes)) continue
              } catch {}
            } else if (result.version === cursor.version) {
              client.applyCounts(result.counts)
              continue
            }
          }
          // A scoped resync that cannot name or repair the gap falls back to
          // the full durable snapshot.
          await refreshFull().catch(() => undefined)
          outcome = "full"
        } while (feedRecoveryAgain && passes < 3)
        if (feedRecoveryAgain && passes >= 3 && outcome !== "full") outcome = "exhausted"
      } finally {
        const settle = feedRecoverySettle
        feedRecoverySettle = undefined
        feedRecovery = undefined
        settle?.(outcome)
      }
    })()
    return feedRecovery
  }
  const handlePatchEvent = (payload: PatchBatch) => {
    if (!lastSnapshotMeta || !supportsPatchFeed(lastSnapshotMeta)) return
    // Ticket #150: a foreign-epoch patch must not ask `changes.since` for a
    // cursor the server can only reset. Coalesce one full snapshot instead.
    if (isForeignEpochPatch(lastSnapshotMeta, payload?.epoch)) {
      if (foreignEpochRefresh.request()) {
        logger.event("info", "feed", "feed.epoch.foreign", {
          epoch: payload?.epoch,
          cursorEpoch: lastSnapshotMeta.epoch,
        })
      }
      return
    }
    const decision = decidePatchApply(lastSnapshotMeta, payload)
    if (decision.action === "apply") {
      applyFeedDecision(decision, payload.counts)
      return
    }
    if (payload.counts) client.applyCounts(payload.counts)
    if (decision.action === "ignore") return
    // One observation per gap, one summary per burst. Recovery below classifies
    // whether the gap actually resolved or fell back.
    feedGapReporter.record({
      reason: decision.reason,
      ...(payload.epoch !== undefined ? { epoch: payload.epoch } : {}),
      ...(payload.from !== undefined ? { from: payload.from } : {}),
      ...(payload.version !== undefined ? { version: payload.version } : {}),
      ...(payload.entries !== undefined ? { entries: payload.entries.length } : {}),
      reset: payload.reset === true,
    })
    // A malformed batch that can only have touched Work resyncs just the Work
    // scope; anything else needs the full durable snapshot boundary. These
    // decisions are hard fallbacks, not recoverable cursor catch-ups.
    if (decision.reason === "malformed" || decision.reason === "other") {
      feedGapReporter.settle("full")
      if (isWorkOnlyPatch(payload)) void recoverWorkScope()
      else void refreshFull().catch(() => undefined)
      return
    }
    if (decision.reason !== "gap") {
      // reset/epoch/unloaded keep their warning semantics even when a scoped
      // resync can repair them: the service cursor was not usable.
      feedGapReporter.settle("full")
      void recoverFeed()
      return
    }
    void recoverFeed((outcome) => feedGapReporter.settle(outcome))
  }

  const openAgent = (agent: Agent) => {
    const workspace = activeWorkspace()
    const workspaceID = workspace?.memberIDs.includes(agent.id) ? workspace.id : undefined
    setSurface({ kind: "agent", agentID: agent.id, workspaceID })
    setFocusArea("chat")
    setChatContext(null)
    dmStream.clear()
    setLiveDm(null)
    setTranscriptSearch(null)
    void refreshChat()
  }

  const openWorkspace = async (workspace: Workspace) => {
    setWorkspaceID(workspace.id)
    setSurface({ kind: "workspace", workspaceID: workspace.id })
    setFocusArea("chat")
    dmStream.clear()
    setLiveDm(null)
    setTaskCursor(0)
    setTranscriptSearch(null)
    await run("Activate workspace", async () => { await invoke(context, "workspace.activate", { id: workspace.id }) })
  }

  const enterRail = async (): Promise<boolean> => {
    const item = railItems()[railCursor()]
    if (!item) return false
    if (item.kind === "agent") {
      const agent = state()?.agents[item.id]
      if (!agent) return false
      openAgent(agent)
      return true
    }
    const workspace = state()?.workspaces[item.id]
    if (!workspace) return false
    await openWorkspace(workspace)
    return true
  }

  /** Roster Enter opens the target and focuses chat without changing mode. */
  const openRailSelection = async () => {
    await enterRail()
  }
  /**
   * Chat Enter focuses the composer target but keeps the current mode. `i`
   * remains the explicit Insert entry.
   */
  const focusComposerKeepingMode = () => {
    if (!surface()) {
      showToast({ title: "Ensemble", message: "Open an agent or workspace first.", tone: "warning" })
      return
    }
    composerCache.buffer?.invalidate()
    dispatchInteraction({ type: "focus.set", focus: "composer" })
    focusComposer()
  }

  const listPage = () => Math.max(1, Math.floor(messageHeight() / 2))
  const moveRail = (delta: number) => {
    const length = railItems().length
    if (length === 0) return
    setRailCursor((cursor) => Math.max(0, Math.min(length - 1, cursor + delta)))
  }
  const moveRailHalf = (direction: 1 | -1) => {
    setRailCursor((cursor) => halfPageCursor(cursor, railItems().length, direction, listPage()))
  }
  const moveTask = (delta: number) => {
    const length = visibleTasks().length
    if (length === 0) return
    const columns = Math.max(1, workPane().layout.columns)
    const cursor = taskCursorClamped()
    const next = cursor + delta * columns
    setTaskCursor(Math.max(0, Math.min(length - 1, next < 0 ? cursor % columns : next)))
  }
  const moveTaskColumn = (delta: number) => {
    const length = visibleTasks().length
    if (length === 0) return
    const columns = Math.max(1, workPane().layout.columns)
    const cursor = taskCursorClamped()
    const rowStart = Math.floor(cursor / columns) * columns
    const rowEnd = Math.min(length - 1, rowStart + columns - 1)
    setTaskCursor(Math.max(rowStart, Math.min(rowEnd, cursor + delta)))
  }
  const moveTaskHalf = (direction: 1 | -1) => {
    const length = visibleTasks().length
    if (length === 0) return
    const columns = Math.max(1, workPane().layout.columns)
    const delta = direction * columns * Math.max(1, Math.floor(listPage() / 2))
    setTaskCursor((cursor) => Math.max(0, Math.min(length - 1, cursor + delta)))
  }
  /**
   * Tab/Shift+Tab move focus zones. Forward: roster -> chat -> work list ->
   * chat; reverse mirrors it, and the rail reaches the work zone directly.
   * A group chat with no inline work falls back to the rail; Direct
   * conversations have no work list. The composer is entered with i/Enter,
   * never Tab.
   */
  const cycleFocusZone = (direction: 1 | -1 = 1) => {
    clearPendingChord()
    const focus = interaction().focus
    if (focus !== "rail" && focus !== "chat" && focus !== "work") return
    const next: FocusZone = nextFocusZone(focus, direction, hasWorkZone())
    dispatchInteraction({ type: "focus.set", focus: next })
  }

  const scrollTranscriptBy = (delta: number) => {
    try { transcriptScrollRef?.scrollBy?.(delta) } catch {}
    queueMicrotask(() => {
      syncTranscriptScroll()
      if (delta < 0) maybeLoadOlderTranscript()
    })
  }
  const scrollTranscriptTop = () => {
    if (transcriptScrollRef) transcriptScrollRef.scrollTop = 0
    setAtBottom(false)
    queueMicrotask(() => {
      syncTranscriptScroll()
      maybeLoadOlderTranscript()
    })
  }
  const scrollTranscriptHalf = (direction: 1 | -1) => {
    scrollTranscriptBy(direction * Math.max(1, Math.floor(messageHeight() / 2)))
  }

  // Roster selection helpers: a/e/s/x/X act on the rail cursor, not the open
  // surface, so they work before Enter opens a chat.
  const railSelection = () => railItems()[railCursor()]
  const railAgent = () => {
    const item = railSelection()
    return item?.kind === "agent" ? state()?.agents[item.id] : undefined
  }
  const railWorkspace = () => {
    const item = railSelection()
    return item?.kind === "workspace" ? state()?.workspaces[item.id] : undefined
  }
  const editRailSelection = async () => {
    const workspace = railWorkspace()
    if (workspace) { await editWorkspace(workspace); return }
    const agent = railAgent()
    if (agent) openSettings(agent)
  }
  const archiveRailSelection = async () => {
    const workspace = railWorkspace()
    if (workspace) { await archiveWorkspace(workspace); return }
    const agent = railAgent()
    if (agent) await archiveSelectedAgent(agent)
  }
  const deleteRailSelection = async () => {
    const workspace = railWorkspace()
    if (workspace) { await deleteWorkspace(workspace); return }
    const agent = railAgent()
    if (agent) await deleteSelectedAgent(agent)
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
      showToast(wizardSuccessToast("workspace-created", created.name))
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
      // Ticket #94: each listed memory is saved one by one after the agent
      // exists; an empty list skips the step and never blocks creation.
      const memories = wizardMemorySaveList(draft.memories)
      for (const text of memories) {
        await invoke(context, "memory.add", { agentID: agent.id, scope: "project", text, source: "wizard" }).catch(() => undefined)
      }
      showToast(wizardSuccessToast("agent-created", agent.name, memories.length))
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

  const editWorkspace = async (target?: Workspace) => {
    const workspace = target ?? activeWorkspace()
    if (!workspace) return
    const draft = await openWizard("workspace", workspace)
    if (!draft) return
    const updated = await run("Update workspace", async () => {
      await invoke(context, "workspace.update", { id: workspace.id, memberIDs: draft.memberIDs, leaderID: draft.leaderID, synthesis: draft.synthesis })
      await offerMoveHome(workspace, draft.memberIDs.filter((id) => !workspace.memberIDs.includes(id)))
    })
    if (updated) showToast(wizardSuccessToast("workspace-updated", workspace.name))
  }

  const composerPlan = (text: string, ownerSelections?: Record<string, string>) => {
    const current = surface()
    if (!current || current.kind !== "workspace") return undefined
    const workspace = state()?.workspaces[current.workspaceID]
    if (!workspace) return undefined
    return planSkillInvocation({
      text,
      workspace,
      agents: state()?.agents ?? {},
      skills: skills(),
      maxSkills: Math.min(state()?.settings.maxDelegations ?? 8, 8),
      ownerSelections,
    })
  }

  const send = async (text: string, recipientIDs?: string[], onInvalid?: (message: string) => void): Promise<boolean> => {
    const value = text.trim()
    if (!value) return false
    const current = surface()
    if (!current) {
      onInvalid?.("Open an agent or workspace first.")
      showToast({ title: "Ensemble", message: "Open an agent or workspace first.", tone: "warning" })
      return false
    }
    const failure = (message: string) => {
      onInvalid?.(message)
      notify(message, "error")
      showToast({ title: "Ensemble", message, tone: "error" })
      return false
    }
    if (current.kind === "agent") {
      const agent = state()?.agents[current.agentID]
      if (!agent) return failure("Agent not found.")
      const issue = directSkillIssue({
        text: value,
        agent,
        workspace: current.workspaceID ? state()?.workspaces[current.workspaceID] : undefined,
        agents: state()?.agents ?? {},
        skills: skills(),
      })
      if (issue) return failure(issue.message)
    }
    let plan = current.kind === "workspace" ? composerPlan(value) : undefined
    const error = plan?.errors[0]
    if (error) return failure(error.message)
    let ownerSelections: Record<string, string> | undefined
    if (plan?.kind === "skills" && plan.ownerChoices?.length) {
      ownerSelections = {}
      for (const choice of plan.ownerChoices) {
        const picked = await openChoice(
          `Owner for /${choice.skillID}`,
          choice.ownerIDs.map((ownerID) => ({ title: state()?.agents[ownerID]?.name ?? ownerID, value: ownerID })),
        )
        if (!picked) return false
        ownerSelections[choice.skillID] = picked
      }
      plan = composerPlan(value, ownerSelections)
      const resolvedError = plan?.errors[0]
      if (resolvedError) return failure(resolvedError.message)
    }
    return run("Send message", async () => {
      if (current.kind === "agent") {
        await invoke(context, "chat.send", { agentID: current.agentID, workspaceID: current.workspaceID, text: value })
        await refreshChat()
      } else {
        const action = plan?.kind === "skills" ? "skill.send" : "message.send"
        await invoke(context, action, {
          workspaceID: current.workspaceID,
          text: value,
          recipientIDs,
          ...(ownerSelections ? { ownerSelections } : {}),
        })
      }
    })
  }

  const focusComposer = () => focusWhenReady(() => composerRef)
  const composerHeight = () => computeComposerHeight(composerDraft(), Math.max(12, messageWidth() - 6))
  const composerBorderColor = () => {
    // Read the motion tick so the bounded bad-border pulse repaints itself.
    motionFrame()
    const role = composerValidationBorder(composerValidation(), Date.now(), isReducedMotion(process.env))
    if (role === "bad") return colors.bad
    return chromeOwnsFocus(chromeFocus(), "composer") ? colors.focus : colors.border
  }
  const setComposerValue = (value: string, cursor = value.length) => {
    clearComposerValidation()
    composerCache.buffer?.invalidate()
    if (composerRef) {
      composerRef.setText?.(value)
      composerRef.cursorOffset = cursor
      composerRef.height = computeComposerHeight(value, Math.max(12, messageWidth() - 6))
    }
    setComposerDraft(value)
    setComposerCursor(cursor)
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
    clearComposerValidation()
    composerCache.buffer?.invalidate()
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
        const current = liveDm()
        dmStream.push(session, (previous) => (previous ?? (current?.sessionID === session ? current.text : "")) + delta)
      }
    }
    if ((event?.type === "session.idle" || event?.type === "session.execution.succeeded" || event?.type === "session.execution.failed" || event?.type === "session.execution.interrupted") && session) {
      if (chatContext()?.sessionID === session) { dmStream.clear(); setLiveDm(null); void refreshChat() }
      void refresh()
    }
  }

  // v5.6 T3 chord/leader/search plumbing ---------------------------------
  const clearPendingChord = () => {
    pendingKeys = []
    if (interaction().pendingChord !== null) dispatchInteraction({ type: "chord.clear" })
  }
  const setPendingChord = (keys: string[]) => {
    pendingKeys = keys
    setInteraction((state) => interactionReducer(state, { type: "chord.set", chord: keys.join(" ") }).state)
  }
  const openLeader = () => {
    clearPendingChord()
    setLeaderMode(true)
    setLeaderPopup(false)
    if (leaderPopupTimer !== undefined) clearTimeout(leaderPopupTimer)
    leaderPopupTimer = setTimeout(() => {
      leaderPopupTimer = undefined
      setLeaderPopup(true)
    }, LEADER_POPUP_DELAY_MS)
    setInteraction((state) => interactionReducer(state, { type: "chord.set", chord: "space" }).state)
  }
  const closeLeader = () => {
    if (leaderPopupTimer !== undefined) { clearTimeout(leaderPopupTimer); leaderPopupTimer = undefined }
    setLeaderPopup(false)
    setLeaderMode(false)
    clearPendingChord()
  }
  onCleanup(() => { if (leaderPopupTimer !== undefined) { clearTimeout(leaderPopupTimer); leaderPopupTimer = undefined } })
  /**
   * Ticket #91: leaving Ensemble keeps the page mounted for F2, but the
   * native route must own the keyboard immediately. Blur every Ensemble
   * editor, settle any awaited overlay, drop the leader/command/pending
   * state, and reset the interaction reducer to Normal.
   */
  const clearInteractionForLeave = () => {
    try { composerRef?.blur?.() } catch {}
    try { settingsFieldRef?.blur?.() } catch {}
    try { textPromptRef?.blur?.() } catch {}
    try { wizardRef?.blur?.() } catch {}
    composerCache.buffer?.invalidate()
    promptCache.buffer?.invalidate()
    wizardCache.buffer?.invalidate()
    settingsVim?.invalidate()
    settingsVim = null
    settingsVimRef = null
    if (textPrompt()) finishTextPrompt(undefined)
    if (picker()) finishPicker(undefined)
    if (confirm()) finishConfirm(undefined)
    if (result()) finishResultModal()
    const activeWizard = wizard()
    if (activeWizard) completeWizard(activeWizard, undefined)
    if (settingsAgentID()) finishSettingsClose()
    if (logsOpen()) closeLogs()
    if (helpOpen()) closeHelp()
    setApprovalsOpen(false)
    setModal(false)
    setCompletion(null)
    clearComposerValidation()
    closeLeader()
    if (commandActive()) closeCommandLine(true)
    clearPendingChord()
    if (messageTimer !== undefined) {
      clearTimeout(messageTimer)
      messageTimer = undefined
    }
    if (toastTimer !== undefined) {
      clearTimeout(toastTimer)
      toastTimer = undefined
    }
    setToasts(clearToasts)
    dispatchInteraction({ type: "route.leave" })
  }
  /** The one deliberate quit path behind `:q` and `Space q`. */
  const leaveEnsemble = () => {
    clearInteractionForLeave()
    context.ui.router.navigate({ type: "home" })
  }
  const surfaceEscape = () => {
    clearPendingChord()
    if (clearSearchAndFilter()) return
    if (interaction().focus === "work") dispatchInteraction({ type: "escape" })
  }

  const startCompose = () => {
    if (!surface()) { showToast({ title: "Ensemble", message: "Open an agent or workspace first.", tone: "warning" }); return }
    composerEpoch++
    composerCache.buffer?.invalidate()
    dispatchInteraction({ type: "insert.enter" })
    focusComposer()
  }
  /** Esc/Ctrl+G leave the editor but keep its surface draft. */
  const leaveComposer = () => {
    composerEpoch++
    composerCache.buffer?.invalidate()
    syncVimChord(null)
    try { composerRef?.blur?.() } catch {}
    closeCompletion()
    dispatchInteraction({ type: "leave.editor" })
  }
  /** Slash commands consume their text, so only this path clears a draft. */
  const resetComposer = () => {
    clearComposerValidation()
    composerEpoch++
    composerCache.buffer?.invalidate()
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
    // Running a slash command consumes the editor but is not a mode command:
    // focus returns to chat and the current mode persists.
    if (composerActive()) dispatchInteraction({ type: "focus.set", focus: "chat" })
  }

  const agentItems = () => activeAgents().map((agent) => ({ title: activeWorkspace()?.leaderID === agent.id ? chromeJoin([agent.name, "leader"]) : agent.name, value: agent.name }))

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

  const skillPalette = (value: string, cursor: number) => {
    const workspace = activeWorkspace()
    if (!workspace) return undefined
    return skillPaletteAt({
      text: value,
      cursor,
      workspace,
      agents: state()?.agents ?? {},
      skills: skills(),
    })
  }

  const commandPaletteCompletion = (value: string, cursor: number): boolean => {
    const palette = skillPalette(value, cursor)
    if (!palette) {
      if (completion()?.kind === "command") setCompletion(null)
      return false
    }
    const previous = completion()
    const sameToken = previous?.kind === "command" && previous.start === palette.tokenStart && previous.scope === palette.scope
    const items = palette.rows.map((row) => ({
      title: chromeJoin([row.label, row.flag]),
      value: row.executor === "init" ? "init" : row.kind === "command" ? row.command! : row.skillID!,
      action: row.executor === "init" ? "command" as const : row.kind,
      insert: row.insert,
    }))
    setCompletion({
      kind: "command",
      query: palette.query,
      start: palette.tokenStart,
      end: palette.tokenEnd,
      cursor: sameToken ? Math.min(previous.cursor, Math.max(0, items.length - 1)) : 0,
      scope: palette.scope,
      ownerName: palette.ownerID ? state()?.agents[palette.ownerID]?.name : undefined,
      items,
    })
    return true
  }

  const openCompletion = (kind: "agent" | "file", value: string, start: number) => {
    const source = kind === "agent" ? agentItems() : fileItems()
    setCompletion({ kind, query: value.slice(start + 1).toLowerCase(), start, end: value.length, cursor: 0, items: source })
  }

  const filterCompletion = (state: Completion, query: string) => {
    const source = state.kind === "agent" ? agentItems() : fileItems()
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
      if (item.action === "command") {
        closeCompletion()
        await runSlashCommand(`/${item.value}`)
        return
      }
      if (item.action === "skill" && item.insert) {
        const value = String(composerRef?.plainText ?? "")
        const next = replaceSkillToken(value, state.start, state.end, item.insert)
        closeCompletion()
        setComposerValue(next.text, next.cursor)
        setComposerActive(true)
        focusComposer()
      }
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

  const pickWorkspace = async () => {
    const selected = await openPicker("workspace", { selected: workspaceID() ? [workspaceID()!] : [] })
    const workspace = selected?.[0] ? state()?.workspaces[selected[0]] : undefined
    if (workspace) await openWorkspace(workspace)
  }

  const pickAgent = async () => {
    const selected = await openPicker("agent")
    const agent = selected?.[0] ? state()?.agents[selected[0]] : undefined
    if (agent) openAgent(agent)
  }

  const initEnsemble = async () => {
    if (surface()?.kind === "agent") {
      showToast({ title: "Ensemble", message: "Init is workspace-only. Open the workspace group chat and rerun /init.", tone: "warning" })
      return
    }
    const workspace = activeWorkspace()
    if (!workspace) { showToast({ title: "Ensemble", message: "Open a workspace first.", tone: "warning" }); return }
    await run("Initialize Ensemble", async () => {
      await invoke(context, "workspace.init", { id: workspace.id, text: "/init" })
      notify("Init started — the System Agent is inspecting the workspace.", "info")
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
      client.reset()
      await refresh()
    })
  }

  const runSlashCommand = async (input: string): Promise<void> => {
    const raw = input.trim()
    // Composer Insert can carry the Normal-command colon form (`:init`); the
    // command line has its own parser, so normalize here before dispatching.
    const parsed = parseSlashCommand(raw.startsWith(":") ? `/${raw.slice(1)}` : raw)
    const command = parsed?.command ?? ""
    const known = COMPOSER_COMMANDS.some((entry) => entry.name === command) || isInitAlias(command)
    if (!known) {
      // An invalid command is non-destructive: keep the draft and show the
      // one-shot bad border until the user types or submits successfully.
      rejectComposerInput(`Unknown command: /${command}`)
      return
    }
    if (isInitAlias(command)) {
      if ((parsed?.args.length ?? 0) > 0) {
        rejectComposerInput("Init is solo-only. Send /init by itself; remove agent mentions, skills, and extra text.")
        return
      }
      resetComposer()
      await initEnsemble()
      return
    }
    resetComposer()
    switch (command) {
      case "workspace": await pickWorkspace(); return
      case "agent": mention(); return
      case "settings": openSettings(); return
      case "approvals": openApprovals(); return
      case "pause": await togglePause(true); return
      case "resume": await togglePause(false); return
      case "help": openHelp(); return
      case "native": openNative(); return
      case "delegate": await delegateSelected(); return
      case "retry": await retrySelected(); return
      case "restart": await restartSelected(); return
      case "cancel": await cancelSelected(); return
      case "reset-ensemble": await resetEnsemble(); return
      default:
        rejectComposerInput(`Unknown command: /${command}`)
    }
  }

  const handleComposerInput = (value: string, cursor: number) => {
    clearComposerValidation()
    const current = completion()
    if (current) {
      if (current.kind === "command") { commandPaletteCompletion(value, cursor); return }
      const trigger = current.kind === "agent" ? "$" : "@"
      if (value[current.start] !== trigger) { closeCompletion(); return }
      setCompletion(filterCompletion(current, value.slice(current.start + 1).toLowerCase()))
      return
    }
    if (commandPaletteCompletion(value, cursor)) return
    const trigger = composerTrigger(value)
    if (!trigger || trigger === "command") return
    openCompletion(trigger, value, value.length - 1)
  }

  const moveCompletion = (delta: number) => {
    setCompletion((current) => current ? { ...current, cursor: Math.max(0, Math.min(Math.max(0, current.items.length - 1), current.cursor + delta)) } : current)
  }

  const submitComposer = async (value: string) => {
    const text = value.trim()
    if (!text) return
    if (completion()) { await selectCompletion(); return }
    if (text === "/") { commandPaletteCompletion("/", 1); return }
    const initIssue = initComposerIssue(text)
    if (initIssue) { rejectComposerInput(initIssue); return }
    const plan = composerPlan(text)
    if (plan?.kind === "command" || plan?.kind === "init") { await runSlashCommand(text); return }
    const parsed = parseSlashCommand(text)
    // A Direct conversation's slash token is a skill request, not an Ensemble
    // command, unless the command is a real composer command. Known commands
    // keep their workspace-wide behavior (for example /init explains that init
    // is workspace-only); skill tokens go through send() for DM validation.
    const directSurface = surface()?.kind === "agent"
    const knownCommand = parsed ? COMPOSER_COMMANDS.some((command) => command.name === parsed.command) : false
    if (!plan && parsed && (!directSurface || knownCommand)) { await runSlashCommand(text); return }
    // v5.6 T1: Enter sends and keeps Insert focus. The draft is owned by the
    // surface, cleared only after a successful send; busy/failed sends keep
    // it. A send can outlive the composer session, and a newer draft typed
    // while it is in flight must never be wiped.
    const key = currentDraftKey()
    const epoch = composerEpoch
    const wasBusy = busy()
    const sent = await send(text, undefined, markComposerInvalid)
    if (!sent) {
      if (wasBusy) notify("Busy — draft kept", "info")
      return
    }
    clearComposerValidation("send-success")
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
    const token = normalizeKeyToken(event)
    const prevent = () => { event?.preventDefault?.(); event?.stopPropagation?.() }
    const leaveEditor = () => {
      prevent()
      leaveComposer()
      return true
    }
    const escapeEditor = (wasInsert: boolean) => {
      prevent()
      if (completion()) { closeCompletion(); return true }
      dispatchInteraction({ type: "escape" })
      const vim = composerVimBuffer()
      vim?.invalidate()
      if (wasInsert) {
        vim?.normalizeCursor()
        if (composerRef) setComposerCursor(Number(composerRef.cursorOffset ?? 0))
      }
      syncVimChord(null)
      return true
    }

    // Ctrl+C stays on the shared keymap layer so it can stop running work in
    // any composer mode.
    if (singleKeyEntry("composerInsert", token)?.id === "composerInsert.stop") return false

    const mode = interaction().mode
    if (mode === "insert") {
      const entry = singleKeyEntry("composerInsert", token)
      if (entry?.id === "composerInsert.escape") return escapeEditor(true)
      if (entry?.id === "composerInsert.leave") return leaveEditor()
      return false
    }

    const context: KeyContext = mode === "visual" ? "composerVisual" : "composerNormal"
    const entry = singleKeyEntry(context, token)
    if (entry?.id === `${context}.escape`) return escapeEditor(false)
    if (entry?.id === `${context}.leave`) return leaveEditor()
    if (mode === "normal" && entry?.id === "composerNormal.command") { prevent(); openCommandLine(":"); return true }
    if (mode === "normal" && entry?.id === "composerNormal.search") { prevent(); openCommandLine("/"); return true }
    if (entry?.id === "composerNormal.enter") {
      prevent()
      composerCache.buffer?.invalidate()
      syncVimChord(null)
      void submitComposer(String(composerRef?.plainText ?? "")).catch(showError)
      return true
    }
    // Visual swallows Enter: a pending selection is never submitted.
    if (mode === "visual" && token === "enter") { prevent(); return true }

    // Normal and Visual own the composer's keys: motions, operators, insert
    // entries, selection, yank/paste, undo/redo. Unbound keys are swallowed
    // so app actions never fire while the composer holds focus.
    prevent()
    const vim = composerVimBuffer()
    const key = normalizeVimKey({ name, ctrl, shift: Boolean(event?.shift) })
    if (!vim || !key) return true
    void vim
      .press(key)
      .then((outcome) =>
        applyVimOutcome(outcome, {
          insert: () => {
            dispatchInteraction({ type: "insert.enter" })
            focusComposer()
          },
          cursor: () => {
            if (composerRef) setComposerCursor(Number(composerRef.cursorOffset ?? 0))
          },
        }),
      )
      .catch(showError)
    return true
  }

  const handleSettingsFieldKey = (event: any) => {
    const field = settingsField()
    if (!field) return false
    const rawName = String(event?.name ?? "")
    const ctrl = Boolean(event?.ctrl) || rawName.startsWith("ctrl+")
    const name = rawName.startsWith("ctrl+") ? rawName.slice("ctrl+".length) : rawName
    const prevent = () => { event?.preventDefault?.(); event?.stopPropagation?.() }
    const mode = interaction().mode

    if (name === "escape" && !ctrl) {
      prevent()
      if (mode === "visual") {
        dispatchInteraction({ type: "escape" })
        const vim = settingsFieldVimBuffer()
        vim?.invalidate()
        syncVimChord(null)
        return true
      }
      if (mode === "insert") {
        const wasCursor = Number(settingsFieldRef?.cursorOffset ?? 0)
        dispatchInteraction({ type: "escape" })
        const vim = settingsFieldVimBuffer()
        vim?.invalidate()
        vim?.normalizeCursor()
        setSettingsFieldCursor(Number(settingsFieldRef?.cursorOffset ?? wasCursor))
        syncVimChord(null)
      } else {
        finishSettingsField()
      }
      return true
    }
    if (ctrl && name === "g") {
      prevent()
      finishSettingsField({ leaveEditor: true })
      return true
    }
    if (name === "return" || name === "enter" || name === "kpenter") {
      // Enter submits the field, matching the old prompt and the composer's
      // Insert behavior; Visual swallows it like any non-visual key. Memory
      // fields stay open for the next entry instead of closing.
      prevent()
      if (mode !== "visual") finishSettingsField({ keepOpen: field.kind === "memory" })
      return true
    }
    if (mode === "insert") return true
    prevent()
    const vim = settingsFieldVimBuffer()
    const key = normalizeVimKey({ name, ctrl, shift: Boolean(event?.shift) })
    if (!vim || !key) return true
    void vim
      .press(key)
      .then((outcome) =>
        applyVimOutcome(outcome, {
          insert: () => {
            dispatchInteraction({ type: "insert.enter", target: "settings" })
          },
          cursor: syncSettingsFieldFromEditor,
        }),
      )
      .catch(showError)
    return true
  }

  const togglePause = async (paused?: boolean) => {
    const workspace = activeWorkspace()
    if (!workspace) return
    const next = paused ?? !workspace.paused
    const ok = await run(next ? "Pause workspace" : "Resume workspace", async () => {
      await invoke(context, next ? "workspace.pause" : "workspace.resume", { id: workspace.id })
    })
    if (ok) showToast({ title: "Workspace", message: `${next ? "Paused" : "Resumed"} #${workspace.name}.`, tone: "success" })
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
    let result = resultForTask(state(), task)
    // Ticket #141: a result outside the loaded transcript window is fetched
    // by id from durable storage instead of loading the whole history.
    if (!result && task.resultMessageID) {
      try {
        const fetched = await callRpc<{ found: boolean; message?: Message }>(context, "message.get", {
          directory: directoryOf(context),
          workspaceID: task.workspaceID,
          messageID: task.resultMessageID,
        })
        result = fetched.found ? fetched.message : undefined
      } catch {}
    }
    if (!result) { showToast({ title: "Ensemble", message: "No result yet.", tone: "warning" }); return }
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
      if (sessionID) {
        clearInteractionForLeave()
        context.ui.router.navigate({ type: "session", sessionID })
        return
      }
    }
    const agentID = selectedTask()?.assigneeID ?? workspace?.leaderID
    if (!workspace || !agentID) return
    const binding = state()?.bindings[`${workspace.id}:${agentID}`]
    if (binding) {
      clearInteractionForLeave()
      context.ui.router.navigate({ type: "session", sessionID: binding.sessionID })
    }
  }

  const restoreSettingsFocus = () => {
    const target = settingsReturnFocus
    dispatchInteraction({ type: "focus.set", focus: target })
  }

  const finishSettingsClose = () => {
    if (interaction().field === "settings") dispatchInteraction({ type: "settings.field.close" })
    settingsVim?.invalidate()
    setSettingsField(null)
    setSettingsFieldText("")
    setSettingsFieldCursor(0)
    setPendingMemorySelectID(null)
    clearSettingsFeedback()
    missingSkillsTracker.key = ""
    setSettingsAgentID(null)
    setDraft(null)
    setDirty(false)
    restoreSettingsFocus()
  }

  const openSettings = (agent?: Agent) => {
    const target = agent ?? selectedAgent() ?? rosterAgents()[0]
    if (!target) return
    if (interaction().focus !== "settings") settingsReturnFocus = interaction().focus
    // Ticket #141: target may be a Solid store node; unwrap before the draft
    // clone so scoped-resync proxies can never make settings unopenable.
    setSettingsAgentID(target.id); setSettingsTab("general"); setDraft(structuredClone(unwrap(target))); setDirty(false)
    // Fresh filters and cursor so the settings surface always opens on a row
    // that exists in the current tab.
    setSkillFilter(""); setMemoryFilter(""); setSettingsCursor(0)
    setSettingsField(null); setSettingsFieldText(""); setSettingsFieldCursor(0)
    clearSettingsFeedback()
    missingSkillsTracker.key = ""
    dispatchInteraction({ type: "focus.set", focus: "settings" })
  }

  // An edit always wins over the previous save acknowledgement, so the header
  // can never show Saved while the draft is dirty.
  const markSettingsDirty = () => {
    setDirty(true)
    if (settingsFeedback()?.kind === "saved") clearSettingsFeedback()
  }

  const closeSettings = async () => {
    if (dirty()) {
      const discard = await openConfirm("Discard changes?", "This agent has unsaved settings.")
      if (!discard) return
    }
    finishSettingsClose()
  }

  const saveSettings = async () => {
    const agent = draft(); if (!agent) return
    if (!agent.name.trim()) throw new Error("Agent name is required.")
    clearSettingsFeedback()
    const ok = await run("Save settings", async () => {
      await invoke(context, "agent.update", { id: agent.id, name: agent.name, title: agent.title, role: agent.role, mainModel: agent.mainModel, backupModels: agent.backupModels, skillbox: agent.skillbox, color: agent.color })
      // Restore the pre-#124 save-then-close flow. The confirmation is one
      // one-shot toast after the surface closes; the statusline remains the
      // modal fallback, so save never has two competing feedback channels.
      setDirty(false)
      finishSettingsClose()
    })
    if (ok) showToast({ title: "Settings", message: `Saved ${agent.name}.`, tone: "success" })
  }

  const addBackup = async () => {
    const agent = draft(); if (!agent) return
    const model = await chooseModel(); if (!model) return
    const variant = await chooseVariant(model)
    setDraft({ ...agent, backupModels: [...agent.backupModels, { providerID: model.providerID, modelID: model.modelID, variant }] })
    // Row 0 is the main model, so the appended backup lands at row N+1.
    setSettingsCursor(agent.backupModels.length + 1)
    markSettingsDirty()
  }

  const editModelRow = async (row: number) => {
    const agent = draft(); if (!agent) return
    if (row <= 0) {
      const model = await chooseModel(agent.mainModel); if (!model) return
      const variant = await chooseVariant(model)
      setDraft({ ...agent, mainModel: { providerID: model.providerID, modelID: model.modelID, variant } }); markSettingsDirty()
      return
    }
    const index = row - 1
    const current = agent.backupModels[index]; if (!current) return
    const model = await chooseModel(current); if (!model) return
    const variant = await chooseVariant(model)
    const backupModels = [...agent.backupModels]
    backupModels[index] = { providerID: model.providerID, modelID: model.modelID, variant }
    setDraft({ ...agent, backupModels }); markSettingsDirty()
  }

  const removeBackup = () => {
    const agent = draft(); if (!agent || agent.backupModels.length === 0) return
    const row = settingsCursorClamped()
    if (row < 1) return
    const index = row - 1
    setDraft({ ...agent, backupModels: agent.backupModels.filter((_, i) => i !== index) })
    setSettingsCursor(Math.max(0, row - 1))
    markSettingsDirty()
  }

  const toggleSkill = () => {
    const agent = draft(); const skill = filteredSkills()[settingsCursorClamped()]
    if (!agent || !skill) return
    const has = agent.skillbox.includes(skill.id)
    setDraft({ ...agent, skillbox: has ? agent.skillbox.filter((id) => id !== skill.id) : [...agent.skillbox, skill.id] })
    markSettingsDirty()
    // Ticket #124: acknowledge the row that actually changed, once.
    signalSettingsFeedback(settingsFeedbackSignal("skill-changed", skill.id))
  }

  const deleteMemory = async () => {
    const memory = filteredMemories()[settingsCursorClamped()]; if (!memory) return
    const row = settingsCursorClamped()
    await run("Delete memory", async () => { await invoke(context, "memory.delete", { id: memory.id }) })
    setSettingsCursor(Math.max(0, row - 1))
  }

  const promoteMemory = async () => {
    const memory = filteredMemories()[settingsCursorClamped()]; if (!memory) return
    await run("Promote memory", async () => { await invoke(context, "memory.promote", { id: memory.id }) })
  }

  // Backup reorder keeps j/k on the row cursor: J/K move the selected backup
  // one slot, and the cursor follows the moved row.
  const reorderBackup = (direction: "up" | "down") => {
    const agent = draft(); if (!agent) return
    const row = settingsCursorClamped()
    if (row < 1) return
    const moved = reorderBackupList(agent.backupModels, row - 1, direction)
    if (!moved) return
    setDraft({ ...agent, backupModels: moved.backups })
    setSettingsCursor(moved.index + 1)
    markSettingsDirty()
  }

  // Settings text fields reuse the composer Vim adapter (#85): Insert type,
  // Esc -> field Normal, Esc -> settings Normal, Esc -> close. The adapter is
  // rebuilt when the renderable changes and shares the internal register.
  const beginSettingsField = (field: SettingsFieldState) => {
    clearPendingChord()
    settingsVim?.invalidate()
    settingsVim = null
    settingsVimRef = null
    setSettingsField(field)
    setSettingsFieldText(field.value)
    setSettingsFieldCursor(field.value.length)
    dispatchInteraction({ type: "settings.field.open" })
    queueMicrotask(() => {
      if (!settingsFieldRef) return
      settingsFieldRef.cursorOffset = field.value.length
      setSettingsFieldCursor(field.value.length)
    })
  }

  const syncSettingsFieldFromEditor = () => {
    const field = settingsField()
    if (!field) return
    const value = String(settingsFieldRef?.plainText ?? field.value)
    const cursor = Number(settingsFieldRef?.cursorOffset ?? value.length)
    setSettingsFieldText(value)
    setSettingsFieldCursor(cursor)
    if (field.kind !== "agent") return
    const agent = draft()
    if (!agent || String(agent[field.field] ?? "") === value) return
    setDraft({ ...agent, [field.field]: value } as Agent)
    markSettingsDirty()
  }

  const commitSettingsField = async (field: SettingsFieldState, raw: string): Promise<boolean> => {
    if (field.kind === "agent") {
      const agent = draft(); if (!agent) return false
      const value = normalizeSettingsField(field.field, raw)
      if (String(agent[field.field] ?? "") === value) return false
      setDraft({ ...agent, [field.field]: value } as Agent)
      markSettingsDirty()
      return true
    }
    const text = raw.trim()
    if (field.memoryID === null) {
      if (!text) return false
      const agent = draft(); if (!agent) return false
      let createdID: string | undefined
      const ok = await run("Add memory", async () => {
        const created = await invoke(context, "memory.add", { agentID: agent.id, workspaceID: activeWorkspace()?.id, scope: "project", text, source: "user" })
        createdID = created?.id
      })
      if (!ok || !createdID) return false
      // Ticket #124: acknowledge the new row once; the id survives until the
      // snapshot carrying the memory paints.
      signalSettingsFeedback(settingsFeedbackSignal("memory-added", createdID))
      // The created id is authoritative; resolve it now if the snapshot is
      // current, otherwise let the effect above select it when it arrives.
      setPendingMemorySelectID(null)
      setMemoryFilter("")
      const index = filteredMemories().findIndex((memory) => memory.id === createdID)
      if (index >= 0) setSettingsCursor(index)
      else setPendingMemorySelectID(createdID)
      return true
    }
    if (!text || text === field.value.trim()) return false
    return run("Edit memory", async () => { await invoke(context, "memory.update", { id: field.memoryID!, text }) })
  }

  const clearSettingsMemoryField = (field: SettingsFieldState) => {
    // Keep the add field focused and ready for the next memory.
    setSettingsField({ ...field, value: "" })
    setSettingsFieldText("")
    setSettingsFieldCursor(0)
    settingsVim?.invalidate()
    queueMicrotask(() => {
      if (!settingsFieldRef) return
      try {
        settingsFieldRef.value = ""
        settingsFieldRef.cursorOffset = 0
        focusWhenReady(() => settingsFieldRef)
      } catch {}
    })
  }

  const keepSettingsMemoryField = (field: SettingsFieldState, value: string) => {
    setSettingsField({ ...field, value })
    setSettingsFieldText(value)
    setSettingsFieldCursor(value.length)
    settingsVim?.invalidate()
    queueMicrotask(() => {
      if (!settingsFieldRef) return
      try { focusWhenReady(() => settingsFieldRef) } catch {}
    })
  }

  const finishSettingsField = (options: { leaveEditor?: boolean; keepOpen?: boolean } = {}) => {
    const field = settingsField()
    if (!field) return
    const raw = String(settingsFieldRef?.plainText ?? field.value)
    // Settings memory add/edit is persistent: Enter saves without closing,
    // clearing an add for the next entry and keeping an edit's text.
    if (options.keepOpen && field.kind === "memory") {
      syncVimChord(null)
      if (field.memoryID === null) {
        if (!raw.trim()) return
        // Clear at once for the next entry; restore the draft if the save
        // fails so an error never eats the user's text.
        clearSettingsMemoryField(field)
        void commitSettingsField(field, raw)
          .then((ok) => { if (!ok) keepSettingsMemoryField(field, raw) })
          .catch(showError)
        return
      }
      if (!raw.trim() || raw.trim() === field.value.trim()) return
      const previous = field.value
      keepSettingsMemoryField(field, raw)
      void commitSettingsField(field, raw)
        .then((ok) => { if (!ok) keepSettingsMemoryField(field, previous) })
        .catch(showError)
      return
    }
    settingsVim?.invalidate()
    settingsVim = null
    settingsVimRef = null
    syncVimChord(null)
    // Ctrl+G leaves the editor and always sets Normal; finishing a field by
    // Enter or field-Normal Esc is a focus move and keeps the current mode.
    dispatchInteraction({ type: options.leaveEditor ? "leave.editor" : "settings.field.close" })
    setSettingsField(null)
    setSettingsFieldText("")
    setSettingsFieldCursor(0)
    void commitSettingsField(field, raw).catch(showError)
  }

  const editSettingsRow = async () => {
    const cursor = settingsCursorClamped()
    const kind = settingsCurrentKind()
    if (kind === "field") {
      const field = settingsFieldAtRow(cursor)
      const agent = draft()
      if (field && agent) beginSettingsField({ kind: "agent", field, label: settingsFieldLabel(field), value: String(agent[field] ?? "") })
      return
    }
    if (kind === "model") { await editModelRow(0); return }
    if (kind === "backup") { await editModelRow(cursor); return }
    if (kind === "memory") {
      const memory = filteredMemories()[cursor]
      if (memory) beginSettingsField({ kind: "memory", memoryID: memory.id, label: "Edit memory", value: memory.text })
      return
    }
    if (kind === "skill") toggleSkill()
  }

  const addSettingsRow = async () => {
    const action = settingsAddAction(settingsTab())
    if (action === "backup") { await addBackup(); return }
    if (action === "memory") beginSettingsField({ kind: "memory", memoryID: null, label: "New memory", value: "" })
  }

  const deleteSettingsRow = async () => {
    const kind = settingsCurrentKind()
    if (kind === "memory") { await deleteMemory(); return }
    if (kind === "backup") removeBackup()
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
  const archiveWorkspace = async (target?: Workspace) => {
    const workspace = target ?? activeWorkspace(); if (!workspace) return
    if (!(await openConfirm(`Archive #${workspace.name}?`, "History is preserved."))) return
    const ok = await run("Archive workspace", async () => {
      await invoke(context, "workspace.archive", { id: workspace.id })
      if (workspaceID() === workspace.id || surface()?.kind === "workspace" && surface()!.workspaceID === workspace.id) { setSurface(null); setWorkspaceID(null) }
    })
    if (ok) showToast({ title: "Workspace", message: `#${workspace.name} archived.`, tone: "success" })
  }
  const deleteWorkspace = async (target?: Workspace) => {
    const workspace = target ?? activeWorkspace(); if (!workspace) return
    if (!(await openConfirm(`Delete #${workspace.name}?`, "Removes workspace data."))) return
    const deleteNativeSessions = await openConfirm("Delete native sessions too?", "No preserves them for inspection.")
    await run("Delete workspace", async () => {
      await invoke(context, "workspace.delete", { id: workspace.id, deleteNativeSessions: Boolean(deleteNativeSessions) })
      if (workspaceID() === workspace.id || surface()?.kind === "workspace" && surface()!.workspaceID === workspace.id) { setSurface(null); setWorkspaceID(null) }
    })
  }
  const archiveSelectedAgent = async (target?: Agent) => {
    const agent = target ?? selectedAgent(); if (!agent) return
    if (!(await openConfirm(`Archive ${agent.name}?`, "History is preserved."))) return
    const ok = await run("Archive agent", async () => {
      await invoke(context, "agent.archive", { id: agent.id })
      if (surfaceAgent()?.id === agent.id) setSurface(null)
    })
    if (ok) showToast({ title: "Agent", message: `${agent.name} archived.`, tone: "success" })
  }
  const deleteSelectedAgent = async (target?: Agent) => {
    const agent = target ?? selectedAgent(); if (!agent) return
    if (!(await openConfirm(`Delete ${agent.name}?`, "Removes the agent profile and memory."))) return
    const deleteNativeSessions = await openConfirm("Delete native sessions too?", "No preserves them for inspection.")
    await run("Delete agent", async () => {
      await invoke(context, "agent.delete", { id: agent.id, deleteNativeSessions: Boolean(deleteNativeSessions) })
      if (surfaceAgent()?.id === agent.id) setSurface(null)
    })
  }

  // Task actions stay keyboard-first from the inline work rows. Tab focuses
  // the work zone; the transcript keeps j/k as scroll, never a row cursor.

  const moveSettingsCursor = (delta: number) => {
    setSettingsCursor(moveSettingsRow(settingsCursorClamped(), delta, settingsRowTotal()))
  }
  const moveSettingsHalf = (direction: 1 | -1) => {
    setSettingsCursor(halfPageCursor(settingsCursorClamped(), settingsRowTotal(), direction, listPage()))
  }

  // Slice B motion gate: the 8 fps clock runs only while something is in
  // flight (busy, live streaming text, task-backed activity lines, the
  // ephemeral WORK block, or an approval resolve RPC) or composing — and
  // never under reduced motion (`ENSEMBLE_REDUCED_MOTION`/`NO_COLOR`), where
  // every animated cell pins to its frame-0 glyph. Idle screens hold tick 0
  // with no interval.
  const motionOn = () =>
    shouldRunMotion(
      {
        busy: isBusy() || resolvingApprovalID() !== null,
        live: liveInitJobs().length > 0 || liveMessages().length > 0 || (showWorkBlock() ?? false) || liveActivity().shown.length > 0,
        composerActive: composerActive() || composerValidation() !== null,
      },
      process.env,
    )

  // Transcript text never dims for entrance motion (ticket #77): color
  // dimming read as a wrong/muted author name while the Markdown body kept
  // full color, and the modulo motion tick could re-dim old rows. Attribution
  // and body colors are stable; only frames/glyphs animate.

  // Idle-quiescent frame clock (slice B): one 8 fps interval per
  // motion-active epoch. Heartbeat refreshes re-run this effect only when a
  // tracked flag changes, so the interval is reconciled by boolean transition
  // — never cleared and recreated while motion stays active. Cleanup clears
  // it on finalize/unmount/route-leave, and the still frame (tick 0) holds
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
      clockTimer = setInterval(() => setMotionFrame((frame) => frame + 1), CHROME_CLOCK_INTERVAL_MS)
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

  // Ticket #116: dedicated 15 fps Work-card clock. It runs only while at
  // least one working card is not waiting on the user, the Ensemble route is
  // visible, no modal owns attention, and reduced motion is off. Needs-you
  // cards freeze on their assigned variant; pending, retrying, and terminal
  // cards hold the still frame. Stopping resets the tick so a later run starts
  // clean instead of resuming an old phase.
  let workClockTimer: ReturnType<typeof setInterval> | undefined;
  let workClockRunning = false;
  const workClockOn = () =>
    shouldRunWorkClock(
      {
        // Cards only render on the workspace surface; a DM/settings surface
        // must not keep the tide clock alive in the background.
        workingCards: surface()?.kind === "workspace"
          ? workPane()
              .sections.flatMap((section) => section.cards)
              .filter((card) => card.status === "working" && !card.needsYou).length
          : 0,
        routeActive: isOurRoute(),
        modalOpen: isModal(),
      },
      process.env,
    )
  const syncWorkClock = () => {
    const want = workClockOn()
    if (want === workClockRunning) return
    workClockRunning = want
    if (workClockTimer !== undefined) { clearInterval(workClockTimer); workClockTimer = undefined }
    if (want) {
      workClockTimer = setInterval(() => setWorkFrame((frame) => frame + 1), WORK_CLOCK_INTERVAL_MS)
    } else {
      setWorkFrame(0)
    }
  };
  onCleanup(() => {
    if (workClockTimer !== undefined) { clearInterval(workClockTimer); workClockTimer = undefined }
    workClockRunning = false
  })
  createEffect(() => {
    syncWorkClock()
  })

  createEffect(() => {
    if (!restored()) return
    void persistHistory(surface())
  })

  // v5.6 T3: the catalog ids resolve to app actions here. The generated
  // keymap layers, the gg chord resolver, and the which-key popup all share
  // this one registry.
  const runAction = (action: (() => unknown) | undefined) => {
    if (!action) return
    try {
      const result = action()
      if (result && typeof (result as Promise<unknown>).catch === "function") void (result as Promise<unknown>).catch(showError)
    } catch (error) {
      showError(error)
    }
  }
  const keyActionHandlers: Record<string, () => unknown> = {
    "nav.down": () => moveRail(1),
    "nav.up": () => moveRail(-1),
    "nav.top": () => setRailCursor(0),
    "nav.bottom": () => setRailCursor(Math.max(0, railItems().length - 1)),
    "nav.half.down": () => moveRailHalf(1),
    "nav.half.up": () => moveRailHalf(-1),
    "nav.left": () => setFocusArea("rail"),
    "nav.right": () => setFocusArea("chat"),
    "focus.tab": () => cycleFocusZone(1),
    "focus.shift.tab": () => cycleFocusZone(-1),
    open: () => openRailSelection(),
    "new.agent": () => createAgent(),
    "new.workspace": () => createWorkspace(),
    edit: () => editRailSelection(),
    settings: () => openSettings(railAgent()),
    archive: () => archiveRailSelection(),
    delete: () => deleteRailSelection(),
    approvals: () => openApprovals(),
    init: () => initEnsemble(),
    pause: () => togglePause(),
    filter: () => openCommandLine("/"),
    leader: () => openLeader(),
    escape: () => surfaceEscape(),
    "chat.scroll.down": () => scrollTranscriptBy(1),
    "chat.scroll.up": () => scrollTranscriptBy(-1),
    "chat.top": () => scrollTranscriptTop(),
    "chat.bottom": () => jumpToBottom(),
    "chat.half.down": () => scrollTranscriptHalf(1),
    "chat.half.up": () => scrollTranscriptHalf(-1),
    "chat.nav.left": () => setFocusArea("rail"),
    "chat.nav.right": () => setFocusArea("chat"),
    compose: () => focusComposerKeepingMode(),
    "compose.alt": () => startCompose(),
    "chat.new.agent": () => createAgent(),
    "chat.new.workspace": () => createWorkspace(),
    "chat.settings": () => openSettings(),
    "chat.approvals": () => openApprovals(),
    "chat.init": () => initEnsemble(),
    "chat.pause": () => togglePause(),
    "chat.native": () => openNative(),
    "chat.cancel": () => {
      if (surface()?.kind === "agent" && (chatContext()?.queued ?? 0) > 0) return removeQueuedDm()
      return cancelSelected()
    },
    "chat.filter": () => openCommandLine("/"),
    "chat.workspace.next": () => cycleWorkspace(1),
    "chat.workspace.prev": () => cycleWorkspace(-1),
    "chat.agent.next": () => cycleAgent(1),
    "chat.agent.prev": () => cycleAgent(-1),
    "chat.page.up": () => scrollTranscriptBy(-messageHeight()),
    "chat.page.down": () => scrollTranscriptBy(messageHeight()),
    "chat.page.bottom": () => jumpToBottom(),
    "work.down": () => moveTask(1),
    "work.up": () => moveTask(-1),
    "work.left": () => moveTaskColumn(-1),
    "work.right": () => moveTaskColumn(1),
    "work.top": () => setTaskCursor(0),
    "work.bottom": () => setTaskCursor(Math.max(0, visibleTasks().length - 1)),
    "work.half.down": () => moveTaskHalf(1),
    "work.half.up": () => moveTaskHalf(-1),
    "work.open": () => openResult(),
    "work.delegate": () => delegateSelected(),
    "work.reassign": () => reassignSelected(),
    "work.retry": () => retrySelected(),
    "work.restart": () => restartSelected(),
    "work.cancel": () => cancelSelected(),
    "work.native": () => openNative(),
    // Settings grammar (#83): the keys live in the catalog; these handlers
    // only mutate the cursor or dispatch the row action.
    "settings.tab.prev": () => setSettingsTabTo(settingsTabStep(settingsTab(), -1)),
    "settings.tab.next": () => setSettingsTabTo(settingsTabStep(settingsTab(), 1)),
    "settings.tab.cycle": () => setSettingsTabTo(settingsTabStep(settingsTab(), 1)),
    "settings.tab.cycle.prev": () => setSettingsTabTo(settingsTabStep(settingsTab(), -1)),
    "settings.down": () => moveSettingsCursor(1),
    "settings.up": () => moveSettingsCursor(-1),
    "settings.top": () => setSettingsCursor(0),
    "settings.bottom": () => setSettingsCursor(Math.max(0, settingsRowTotal() - 1)),
    "settings.half.down": () => moveSettingsHalf(1),
    "settings.half.up": () => moveSettingsHalf(-1),
    "settings.edit": () => editSettingsRow(),
    "settings.edit.alt": () => editSettingsRow(),
    "settings.add": () => addSettingsRow(),
    "settings.delete": () => deleteSettingsRow(),
    "settings.promote": () => promoteMemory(),
    "settings.backup.down": () => reorderBackup("down"),
    "settings.backup.up": () => reorderBackup("up"),
    "settings.toggle": () => toggleSkill(),
    "settings.save": () => saveSettings(),
    "settings.filter": () => openCommandLine("/"),
    "settings.escape": () => closeSettings(),
  }
  const leaderActionHandlers: Record<string, () => unknown> = {
    "leader.help": () => openHelp(),
    "leader.leave": () => leaveEnsemble(),
    "leader.cancel": () => closeLeader(),
    "leader.new.agent": () => createAgent(),
    "leader.new.workspace": () => createWorkspace(),
    "leader.edit.workspace": () => editWorkspace(),
    "leader.settings": () => openSettings(),
    "leader.archive.workspace": () => archiveWorkspace(),
    "leader.delete.workspace": () => deleteWorkspace(),
    "leader.archive.agent": () => archiveSelectedAgent(),
    "leader.delete.agent": () => deleteSelectedAgent(),
    "leader.approvals": () => openApprovals(),
    "leader.pause": () => togglePause(),
    "leader.init": () => initEnsemble(),
    "leader.native": () => openNative(),
    "leader.delegate": () => delegateSelected(),
    "leader.reassign": () => reassignSelected(),
    "leader.retry": () => retrySelected(),
    "leader.restart": () => restartSelected(),
    "leader.cancel.task": () => cancelSelected(),
  }
  const runKeyAction = (id: string) => {
    clearPendingChord()
    runAction(keyActionHandlers[id])
  }
  const runLeaderAction = (id: string) => {
    closeLeader()
    runAction(leaderActionHandlers[id])
  }

  // Ticket #133: the 250 ms full-snapshot poll is gone. A cheap revision
  // check runs every 2 s idle and 1 s while work is live, plus immediately on
  // reconnect and route activation. Full refresh pauses off-route.
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined
  let heartbeatGeneration = 0
  let heartbeatCheck: Promise<void> | undefined
  let heartbeatForce = false
  let heartbeatDisposed = false
  const heartbeatActive = () =>
    isBusy() || chatContext()?.busy === true || hasActiveWorkNow() || liveInitJobs().length > 0
  const stopHeartbeat = () => {
    heartbeatGeneration++
    if (heartbeatTimer !== undefined) { clearTimeout(heartbeatTimer); heartbeatTimer = undefined }
  }
  const checkRevision = (force = false): Promise<void> => {
    if (force) heartbeatForce = true
    if (heartbeatCheck) return heartbeatCheck
    heartbeatCheck = (async () => {
      try {
        const revision = await callRpc<Revision>(context, "revision", { directory: directoryOf(context) })
        // Ticket #141: counts are server-derived and refreshed on every beat;
        // the client never scans all messages or tasks for the rail. The gate
        // rides the same beat so a growing workspace switches read paths.
        client.applyCounts(revision.counts)
        const cursor = lastSnapshotMeta
        if (revision.gate && supportsScopedReads(cursor)) scopedReads = revision.gate.enabled
        const forced = heartbeatForce
        heartbeatForce = false
        if (revisionChanged(cursor, revision)) {
          // Ticket #138: a version gap recovers through `changes.since` instead
          // of a full snapshot. Epoch/protocol changes, an unloaded client, and
          // a forced reconnect still take the full-snapshot fallback.
          const patchCursor = !forced && cursor && supportsPatchFeed(cursor)
            && revision.epoch === cursor.epoch && revision.protocol === cursor.protocol
          if (patchCursor) {
            if (revision.version > cursor!.version) await recoverFeed()
            else if (revision.version < cursor!.version) await refreshFull()
            // An equal version with a catalog/config revision is metadata-only:
            // recover it through the feed, never through entity replacement.
            else await recoverFeed()
          } else {
            await refreshFull()
          }
        } else if (forced) {
          await refreshFull()
        }
        if (lastSnapshotMeta && (revision.catalogRevision !== lastSnapshotMeta.catalogRevision || revision.configRevision !== lastSnapshotMeta.configRevision)) {
          snapshotRefresh.request()
        }
        if (surface()?.kind === "agent") chatRefresh.request()
      } catch {
        // The revision RPC is an optimization; keep the snapshot path as the
        // fallback whenever it is unavailable.
        heartbeatForce = false
        snapshotRefresh.request()
      } finally {
        heartbeatCheck = undefined
        if (!heartbeatDisposed) {
          syncClock()
          // Git state is outside the coordination version; keep its existing
          // throttled cadence without a full snapshot refresh.
          refreshGit()
        }
      }
    })()
    return heartbeatCheck
  }
  const scheduleHeartbeat = (active = heartbeatActive()) => {
    stopHeartbeat()
    if (!isOurRoute()) return
    const generation = heartbeatGeneration
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = undefined
      void checkRevision().finally(() => {
        if (generation === heartbeatGeneration && isOurRoute()) scheduleHeartbeat()
      })
    }, heartbeatDelay(active))
  }
  let heartbeatStarted = false
  let heartbeatVisible = false
  createEffect(() => {
    const visible = isOurRoute()
    const active = heartbeatActive()
    snapshotRefresh.setPaused(!visible)
    chatRefresh.setPaused(!visible)
    if (!visible) {
      heartbeatVisible = false
      stopHeartbeat()
      return
    }
    const resumed = heartbeatStarted && !heartbeatVisible
    heartbeatStarted = true
    heartbeatVisible = true
    scheduleHeartbeat(active)
    if (resumed) void checkRevision()
  })
  onCleanup(() => {
    heartbeatDisposed = true
    stopHeartbeat()
    foreignEpochRefresh.dispose()
    feedGapReporter.dispose()
    groupStream.dispose()
    dmStream.dispose()
    snapshotRefresh.dispose()
    chatRefresh.dispose()
  })

  onMount(() => {
    pageActivation.mount(pageToken)
    void refresh()
    const stopData = context.data.listen(({ details }: any) => {
      const type = typeof details?.type === "string" ? details.type : ""
      if (type === "session.text.delta" || type === "session.idle" || type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.execution.interrupted") handleNativeEvent(details)
      // Reconnect may have missed events; recover with an immediate forced
      // snapshot while the version guard still prevents an older response
      // from repainting newer state.
      if (type === "server.connected") {
        void checkRevision(true)
        return
      }
      // Ticket #138: batched full-entity patches drive the client store
      // directly. A gapped, duplicated, or malformed batch never partially
      // applies; the cursor recovery path resyncs the Work scope.
      if (type === "rpc.ensemble.v2.patches") {
        const payload = details?.data && typeof details.data === "object" ? details.data : details
        handlePatchEvent(payload as PatchBatch)
        return
      }
      // Ticket #139: ephemeral, coalesced live text. It never advances the
      // patch cursor; the durable final message upsert replaces it.
      if (type === "rpc.ensemble.v2.stream") {
        const payload = details?.data && typeof details.data === "object" ? details.data : details
        if (!validMessageStream(payload)) return
        groupStream.push(`${payload.workspaceID}\u0000${payload.id}`, () => payload)
        return
      }
      // Durable writes also emit the legacy `changed` event with the affected
      // scope (workspace, subtask, correlation, kind) for older clients and for
      // this client when the server does not advertise the patch protocol.
      // An event that is not newer than the applied snapshot is already
      // visible, so it skips the fetch. The revision heartbeat remains the
      // fallback for missed events.
      if (type === "rpc.ensemble.v2.changed") {
        if (lastSnapshotMeta && supportsPatchFeed(lastSnapshotMeta)) return
        const eventVersion = typeof details?.version === "number" ? details.version : typeof details?.data?.version === "number" ? details.data.version : undefined
        if (eventVersion !== undefined && lastSnapshotMeta !== undefined && eventVersion <= lastSnapshotMeta.version) return
        snapshotRefresh.request()
        return
      }
      if (type.startsWith("rpc.ensemble.v2.")) snapshotRefresh.request()
    })
    const keyInput = context.renderer.keyInput
    const onKey = (event: any) => {
      // Ticket #91: a stale stacked page or a hidden Ensemble route must never
      // consume a key before the native prompt sees it.
      if (!ownsRawKeys()) return
      if (interaction().command) { handleCommandKey(event); return }
      // v5.7 T2: Insert without a text target is honest but inert for text.
      // Enter, Esc, Tab/Shift+Tab, and Ctrl+G stay structural; every other
      // key is swallowed so a letter can never fire a Normal action.
      if (insertWithoutTarget(interaction())) {
        const token = normalizeKeyToken(event)
        if (token === "escape") {
          event?.preventDefault?.(); event?.stopPropagation?.()
          dispatchInteraction({ type: "escape" })
          return
        }
        if (token === "ctrl+g") {
          event?.preventDefault?.(); event?.stopPropagation?.()
          dispatchInteraction({ type: "leave.editor" })
          return
        }
        if (token !== "enter" && token !== "tab" && token !== "shift+tab") {
          event?.preventDefault?.(); event?.stopPropagation?.()
          return
        }
      }
      // Ticket #145: logs is a read-only overlay that traps every key while
      // open; it never changes interaction mode or focus.
      if (logsOpen()) { handleLogsKey(event); return }
      // v5.6 T10: the help overlay owns every key while open. Its grammar is
      // local to the overlay and never changes interaction mode or focus.
      if (helpOpen()) { handleHelpKey(event); return }
      // v5.6 T6: one catalog-driven handler owns wizards, pickers, prompts,
      // confirms, results, and the approval inbox. It traps every key while a
      // dialog is open so `:`/Space never leak to the surface underneath.
      if (dialogDescriptor()) { handleDialogKey(event); return }
      // Ticket #83: a settings field owns every raw key. Insert lets the
      // input renderable type; field Normal runs the shared Vim adapter.
      if (settingsField()) { handleSettingsFieldKey(event); return }
      // v5.6 T1: the composer owns its Esc ladder at the raw key layer — the
      // focused textarea consumes Escape before the keymap layer can.
      if (composerActive() && !isModal() && handleComposerKey(event)) return
      // v5.6 T2: n/N move through the committed transcript search, Esc
      // clears a committed filter/search, and `:`/`/` open the command line.
      // These run before the leader/chord layers so `n` cannot create a
      // workspace while a search is active.
      const pressed = String(event?.name ?? "")
      const token = normalizeKeyToken(event)
      if (!leaderMode() && !composerActive() && interaction().overlay === "none") {
        if (focusArea() === "chat" && transcriptSearch() && (pressed === "n" || pressed === "N")) {
          event?.preventDefault?.(); event?.stopPropagation?.()
          const matches = transcriptSearchMatches()
          if (matches.length === 0) notify(`No matches: ${transcriptSearch()!.query}`, "info")
          else moveSearchMatch(pressed === "N" ? -1 : 1)
          return
        }
        if (pressed === "escape" && clearSearchAndFilter()) {
          event?.preventDefault?.(); event?.stopPropagation?.()
          return
        }
      }
      if (!leaderMode() && !composerActive() && (token === ":" || token === "/")) {
        if (openCommandLine(token)) {
          event?.preventDefault?.(); event?.stopPropagation?.()
          return
        }
      }
      // v5.6 T10: `?` opens the full help from any Normal surface. The key
      // is the catalog's global binding, so help cannot invent it.
      if (!leaderMode() && !composerActive() && !isModal() && interaction().overlay === "none") {
        const globalHelp = globalEntries().find((entry) => entry.id === "global.help")
        if (globalHelp && token === globalHelp.keys[0]) {
          event?.preventDefault?.(); event?.stopPropagation?.()
          openHelp()
          return
        }
      }
      // v5.6 T3: the leader owns known keys through the generated leader
      // layer; anything else closes which-key with a truthful warning.
      if (leaderMode()) {
        if (token === "escape" || resolveLeaderKey(token).type === "action") return
        event?.preventDefault?.(); event?.stopPropagation?.()
        setLeaderMode(false)
        clearPendingChord()
        showToast({ title: "Leader", message: `Unknown shortcut: ${String(event?.sequence ?? event?.name ?? token)}`, tone: "warning" })
        return
      }
      // Multi-key chords (gg) live above the host keymap: single keys belong
      // to the generated layers, prefixes set the statusline pending chord.
      const keyContext = surfaceKeyContext()
      if (!keyContext) return
      if (!token) return
      const sequence = [...pendingKeys, token]
      const resolved = resolveNormalKey(keyContext, pendingKeys, token)
      if (resolved.type === "pending") {
        event?.preventDefault?.(); event?.stopPropagation?.()
        setPendingChord([...resolved.prefix])
        return
      }
      if (resolved.type === "action" && resolved.entry.keys.length > 1 && resolved.entry.keys.join(" ") === sequence.join(" ")) {
        event?.preventDefault?.(); event?.stopPropagation?.()
        runKeyAction(resolved.entry.id)
        return
      }
      // Settings rows run from the same resolved catalog at the raw layer:
      // G, Space, and punctuation bindings are unreliable as host keymap
      // strings, so the settings context executes every catalog action here.
      if (keyContext === "settings" && resolved.type === "action" && resolved.entry.keys.join(" ") === sequence.join(" ")) {
        event?.preventDefault?.(); event?.stopPropagation?.()
        if (settingsActionEnabled(resolved.entry.id)) runKeyAction(resolved.entry.id)
        return
      }
      // A stale prefix never swallows a fresh single key: clear it and let
      // the generated single-key layer handle the event.
      if (pendingKeys.length > 0) clearPendingChord()
    }
    keyInput.on("keypress", onKey)

    // v5.6 T9: OpenTUI owns the drag gesture and emits one selection on
    // release. The mouse module normalizes it to a pane-bounded payload and
    // copies through the same system-first clipboard port as keyboard yank.
    // Nothing here touches interaction mode or focus; the only state write is
    // the transient toast in the bottom bar.
    const onSelection = (selection: any) => {
      const startPane = mouseSelectionPane
      mouseSelectionPane = null
      void handleMouseSelection(selection, startPane, {
        writeClipboard: (text) => clipboardPort().write(text),
        clearSelection: () => {
          try {
            // Only clear the selection that was copied: a new drag may have
            // started while the asynchronous clipboard write was in flight.
            if (context.renderer.getSelection() === selection) context.renderer.clearSelection()
          } catch {}
        },
        notify: (message, tone) => showToast({ title: "Clipboard", message, tone }),
      })
    }
    context.renderer.on("selection", onSelection)

    // v5.6 T3: every surface layer is generated from the declarative catalog.
    // One context is active at a time; the composer, overlays, the command
    // line, and the leader own their keys before these layers.
    const catalogCommand = (entry: KeyEntry, id: string, enabled?: () => boolean) => ({
      id,
      title: `Ensemble: ${entry.title}`,
      bind: entry.keys[0],
      enabled: enabled ?? (entry.availability === "no-transcript-search" ? () => !transcriptSearch() : undefined),
      run: (_input: string | undefined, event: any) => {
        event?.preventDefault?.(); event?.stopPropagation?.()
        runKeyAction(entry.id)
      },
    })
    const surfaceLayer = (keyContext: "roster" | "chat" | "work") => {
      const entries = layerEntries(keyContext)
      if (entries.length === 0) return
      const commands = entries.map((entry) => catalogCommand(entry, `ensemble.v2.key.${keyContext}.${entry.id}`))
      const factory = () => ({
        mode: "global",
        priority: 100,
        enabled: () => ownsRawKeys() && !isModal() && !leaderMode() && !commandActive() && wizard() === null && !composerActive() && interaction().command === null && surfaceKeyContext() === keyContext,
        commands,
        bindings: commands.map((command) => command.id),
      })
      context.keymap.layer(factory)
    }
    for (const keyContext of ["roster", "chat", "work"] as const) {
      surfaceLayer(keyContext)
    }
    // Ticket #83: settings is generated from its own catalog context. The
    // layer is disabled while a text field owns the keyboard so Insert typing
    // and field Normal Vim never leak into rows.
    const settingsCommands = layerEntries("settings").map((entry) =>
      catalogCommand(entry, `ensemble.v2.key.settings.${entry.id}`, () => settingsActionEnabled(entry.id)),
    )
    context.keymap.layer(() => ({
      mode: "global",
      priority: 110,
      enabled: () => ownsRawKeys() && Boolean(settingsAgentID()) && settingsField() === null && !overlayOpen() && !leaderMode() && !commandActive() && wizard() === null && interaction().command === null,
      commands: settingsCommands,
      bindings: settingsCommands.map((command) => command.id),
    }))
    const leaderCommands = leaderLayerEntries().map((entry) => ({
      id: `ensemble.v2.key.leader.${entry.id}`,
      title: `Ensemble: ${entry.title}`,
      bind: entry.keys[0],
      run: (_input: string | undefined, event: any) => {
        event?.preventDefault?.(); event?.stopPropagation?.()
        runLeaderAction(entry.id)
      },
    }))
    context.keymap.layer(() => ({
      mode: "global",
      priority: 120,
      enabled: () => ownsRawKeys() && !isModal() && leaderMode() && !commandActive(),
      commands: leaderCommands,
      bindings: leaderCommands.map((command) => command.id),
    }))
    context.keymap.layer(() => ({
      mode: "global", priority: 130,
      enabled: () => ownsRawKeys() && composerActive() && !isModal() && wizard() === null && !commandActive(),
      commands: [
        { id: "ensemble.v2.composer.cancel", title: "Ensemble: Composer Esc ladder", bind: "escape", run: (_input, event) => { event?.preventDefault?.(); event?.stopPropagation?.(); if (completion()) closeCompletion(); else dispatchInteraction({ type: "escape" }) } },
        // Host Escape handling can swallow the key while a native run is
        // active; Ctrl+G is the reliable leave-composer chord.
        { id: "ensemble.v2.composer.leave", title: "Ensemble: Leave composer", bind: "ctrl+g", run: (_input, event) => { event?.preventDefault?.(); event?.stopPropagation?.(); leaveComposer() } },
        { id: "ensemble.v2.composer.stop", title: "Ensemble: Stop running work", bind: "ctrl+c", enabled: () => stoppable(), run: (_input, event) => { event?.preventDefault?.(); event?.stopPropagation?.(); void cancelSelected("stop").catch(showError) } },
      ],
      bindings: ["ensemble.v2.composer.cancel", "ensemble.v2.composer.leave", "ensemble.v2.composer.stop"],
    }))
    context.keymap.layer(() => ({
      mode: "global", priority: 140,
      enabled: () => ownsRawKeys() && composerActive() && completion() !== null && !modal() && wizard() === null && !commandActive(),
      commands: [
        { id: "ensemble.v2.completion.up", title: "Ensemble: Previous completion", bind: "up", run: () => moveCompletion(-1) },
        { id: "ensemble.v2.completion.down", title: "Ensemble: Next completion", bind: "down", run: () => moveCompletion(1) },
        { id: "ensemble.v2.completion.select", title: "Ensemble: Select completion", bind: "enter", run: () => { void selectCompletion().catch(showError) } },
        { id: "ensemble.v2.completion.cancel", title: "Ensemble: Close completion", bind: "escape", run: () => closeCompletion() },
      ],
      bindings: ["ensemble.v2.completion.up", "ensemble.v2.completion.down", "ensemble.v2.completion.select", "ensemble.v2.completion.cancel"],
    }))
    // Ticket #145: the host may consume a lone Escape before the raw listener
    // sees it; keep a thin layer so the logs overlay always closes/refreshes.
    context.keymap.layer(() => ({
      mode: "global", priority: 116,
      enabled: () => ownsRawKeys() && logsOpen() && !leaderMode() && !commandActive() && wizard() === null,
      commands: [
        { id: "ensemble.v2.logs.close", title: "Ensemble: Close logs", bind: "escape", run: () => closeLogs() },
        { id: "ensemble.v2.logs.refresh", title: "Ensemble: Refresh logs", bind: "r", run: () => { void refreshLogs() } },
      ],
      bindings: ["ensemble.v2.logs.close", "ensemble.v2.logs.refresh"],
    }))
    // v5.6 T10: the raw listener owns help navigation, but the host may
    // consume a lone Escape before it reaches that listener. Keep a thin
    // generated layer for the close/page keys so help always closes.
    context.keymap.layer(() => ({
      mode: "global", priority: 115,
      enabled: () => ownsRawKeys() && helpOpen() && !leaderMode() && !commandActive() && wizard() === null,
      commands: [
        { id: "ensemble.v2.help.close", title: "Ensemble: Close help", bind: "escape", run: () => closeHelp() },
        { id: "ensemble.v2.help.up", title: "Ensemble: Help page up", bind: "pageup", run: (_input, event) => { event?.preventDefault?.(); event?.stopPropagation?.(); scrollHelpBy(-10) } },
        { id: "ensemble.v2.help.down", title: "Ensemble: Help page down", bind: "pagedown", run: (_input, event) => { event?.preventDefault?.(); event?.stopPropagation?.(); scrollHelpBy(10) } },
      ],
      bindings: ["ensemble.v2.help.close", "ensemble.v2.help.up", "ensemble.v2.help.down"],
    }))
    // v5.6 T6: the wizard/dialog catalog owns its keys through the raw
    // listener above; the help overlay owns its grammar there too (T10).
    return () => { pageActivation.unmount(pageToken); keyInput.off("keypress", onKey); context.renderer.off("selection", onSelection); stopData() }
  })

  const showError = (error: any) => {
    logger.event("error", "tui", "tui.error", { error })
    showToast({ title: "Ensemble", message: error?.message ?? String(error), tone: "error" })
  }

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
    clearPendingChord()
  }

  const openPicker = (mode: PickerState["mode"], options: { selected?: string[]; candidates?: string[] } = {}): Promise<string[] | undefined> => new Promise((resolve) => {
    // Overlays never steal Enter/focus while a wizard owns the keyboard.
    if (wizard()) { resolve(undefined); return }
    clearPendingChord()
    const candidates = mode === "workspace"
      ? workspaces().map((workspace) => ({ id: workspace.id, label: chromeJoin([`#${workspace.name}`, workspaceLabel(workspace.directory)]) }))
      : mode === "leader"
        ? (options.candidates ?? []).map((id) => rosterAgents().find((agent) => agent.id === id)).filter((agent): agent is Agent => Boolean(agent)).map((agent) => ({ id: agent.id, label: agent.name }))
        : rosterAgents().map((agent) => ({ id: agent.id, label: agent.name }))
    const state: PickerState = {
      mode,
      title: mode === "members" ? "Workspace members" : mode === "leader" ? "Workspace leader" : mode === "agent" ? "Open agent" : "Switch workspace",
      candidates,
      selected: new Set(options.selected ?? []),
      cursor: 0,
      query: "",
      filtering: false,
      resolve,
    }
    setModal(true)
    setPicker(state)
    dispatchInteraction({ type: "overlay.set", overlay: "dialog" })
  })

  const pickerMove = (delta: number) => {
    const state = picker()
    if (!state) return
    const length = pickerItems().length
    setPicker({ ...state, cursor: Math.max(0, Math.min(Math.max(0, length - 1), state.cursor + delta)) })
  }

  const pickerJump = (index: number) => {
    const state = picker()
    if (!state) return
    const length = pickerItems().length
    setPicker({ ...state, cursor: Math.max(0, Math.min(Math.max(0, length - 1), index)) })
  }

  const pickerToggle = () => {
    const state = picker()
    if (!state || state.mode !== "members") return
    const item = pickerItems()[state.cursor]
    if (item) setPicker({ ...state, selected: toggleSelected(state.selected, item.id) })
  }

  const pickerActivate = () => {
    const state = picker()
    if (!state) return
    if (state.mode === "members") {
      if (state.selected.size === 0) {
        showToast({ title: "Ensemble", message: "Choose at least one member.", tone: "warning" })
        return
      }
      finishPicker([...state.selected])
      return
    }
    const item = singleChoiceValue(pickerItems(), state.cursor)
    if (item) finishPicker([item.id])
  }

  const beginPickerFilter = () => {
    const state = picker()
    if (!state) return
    setPicker({ ...state, filtering: true, query: "", cursor: 0 })
  }

  const finishTextPrompt = (value: string | undefined) => {
    const state = textPrompt()
    if (!state) return
    setTextPrompt(null)
    setModal(false)
    // The prompt's field target ends with the prompt; the mode persists.
    dispatchInteraction({ type: "field.leave" })
    state.resolve(value)
    clearPendingChord()
  }

  const openTextPrompt = (title: string, options: { description?: string; value?: string; placeholder?: string } = {}): Promise<string | undefined> => new Promise((resolve) => {
    if (wizard()) { resolve(undefined); return }
    clearPendingChord()
    setModal(true)
    setTextPrompt({
      title,
      description: options.description ?? chromeJoin(["Enter submits", "Shift+Enter adds a line"]),
      value: options.value ?? "",
      placeholder: options.placeholder ?? "",
      resolve,
    })
    dispatchInteraction({ type: "overlay.set", overlay: "dialog" })
    dispatchInteraction({ type: "field.enter", target: "prompt" })
  })

  const openChoice = (title: string, options: Array<{ title: string; value: string }>, current?: string): Promise<string | undefined> => new Promise((resolve) => {
    if (wizard()) { resolve(undefined); return }
    clearPendingChord()
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
      filtering: false,
      resolve: (value) => { setLeaderMode(previous); resolve(value?.[0]) },
    })
    dispatchInteraction({ type: "overlay.set", overlay: "dialog" })
  })

  const openConfirm = (title: string, message: string): Promise<boolean | undefined> => new Promise((resolve) => {
    if (wizard()) { resolve(undefined); return }
    clearPendingChord()
    const previous = leaderMode()
    const returnEditor = composerActive() ? "composer" as const : undefined
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
    dispatchInteraction({ type: "overlay.set", overlay: "dialog", returnEditor })
  })

  const finishConfirm = (value: boolean | undefined) => {
    const state = confirm()
    if (!state) return
    clearPendingChord()
    state.resolve(value)
  }

  const openResultModal = (title: string, text: string): Promise<void> => new Promise((resolve) => {
    if (wizard()) { resolve(); return }
    clearPendingChord()
    const previous = leaderMode()
    const returnEditor = composerActive() ? "composer" as const : undefined
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
    dispatchInteraction({ type: "overlay.set", overlay: "dialog", returnEditor })
  })

  const finishResultModal = () => {
    const state = result()
    if (!state) return
    clearPendingChord()
    state.resolve()
  }

  const resultScroll = (delta: number) => {
    try { resultScrollRef?.scrollBy?.(delta) } catch {}
  }

  const openApprovals = () => {
    setApprovalCursor(0)
    setApprovalsOpen(true)
    dispatchInteraction({ type: "overlay.set", overlay: "approvals" })
  }

  // v5.6 T10: help navigation is local to the overlay. It never dispatches
  // focus or mode changes; opening/closing only sets the overlay, so the
  // underlying mode/focus is exactly where it was.
  const helpVisibleSections = () => filterHelpSections(helpCatalogSections, helpQuery())
  const helpMatchEntries = () => helpVisibleSections().flatMap((section) =>
    section.entries.map((entry) => ({ section, entry })),
  )
  const helpMatchKey = () => {
    if (!helpQuery() && !helpFiltering()) return null
    const current = helpMatchEntries()[helpMatch()]
    return current ? helpEntryKey(current.section, current.entry) : null
  }
  const scrollHelpBy = (delta: number) => {
    try { helpScrollRef?.scrollBy?.(delta) } catch {}
  }
  const scrollHelpTo = (position: number) => {
    try { helpScrollRef?.scrollTo?.(position) } catch {}
  }
  const resetHelpFilter = () => {
    setHelpFiltering(false)
    setHelpQuery("")
    setHelpMatch(0)
    helpPendingKeys = []
  }
  const moveHelpMatch = (direction: 1 | -1) => {
    const matches = helpMatchEntries()
    if (matches.length === 0) return
    const next = helpMatchAfter(matches.length, helpMatch(), direction)
    setHelpMatch(next)
    const target = matches[next]
    if (target) queueMicrotask(() => {
      try { helpScrollRef?.scrollChildIntoView?.(`help-${helpEntryKey(target.section, target.entry)}`) } catch {}
    })
  }
  const handleHelpKey = (event: any): void => {
    event?.preventDefault?.()
    event?.stopPropagation?.()
    const token = normalizeKeyToken(event)
    if (helpFiltering()) {
      const edit = filterEdit(helpQuery(), {
        name: String(event?.name ?? ""),
        sequence: String(event?.sequence ?? ""),
        ctrl: Boolean(event?.ctrl),
        meta: Boolean(event?.meta),
        super: Boolean(event?.super),
      })
      if (edit.cancelled) { resetHelpFilter(); return }
      if (edit.done) { setHelpFiltering(false); return }
      setHelpQuery(edit.query)
      setHelpMatch(0)
      return
    }
    const resolved = resolveNormalKey("help", helpPendingKeys, token)
    if (resolved.type === "pending") {
      helpPendingKeys = [...resolved.prefix]
      return
    }
    helpPendingKeys = []
    if (resolved.type !== "action") return
    switch (resolved.entry.id) {
      case "help.down": scrollHelpBy(1); return
      case "help.up": scrollHelpBy(-1); return
      case "help.half.down": scrollHelpBy(10); return
      case "help.half.up": scrollHelpBy(-10); return
      case "help.page.down": scrollHelpBy(10); return
      case "help.page.up": scrollHelpBy(-10); return
      case "help.top": scrollHelpTo(0); return
      case "help.bottom": scrollHelpTo(1_000_000); return
      case "help.filter": setHelpFiltering(true); setHelpQuery(""); setHelpMatch(0); return
      case "help.match.next": moveHelpMatch(1); return
      case "help.match.prev": moveHelpMatch(-1); return
      case "help.close": closeHelp(); return
    }
  }
  const openHelp = () => {
    clearPendingChord()
    resetHelpFilter()
    setHelpOpen(true)
    dispatchInteraction({ type: "overlay.set", overlay: "help" })
  }
  const closeHelp = () => {
    setHelpOpen(false)
    resetHelpFilter()
    dispatchInteraction({ type: "overlay.set", overlay: "none" })
  }

  /** Refresh the service ring for the current `:logs` filter. */
  const refreshLogs = async (): Promise<void> => {
    setLogsLoading(true)
    setLogsError("")
    try {
      const result = await callRpc<any>(context, "logs.recent", {
        directory: directoryOf(context),
        ...logsRpcInput(logsFilter()),
      })
      setLogsEntries(sortLogEntries(Array.isArray(result?.entries) ? result.entries : []))
      // The service logger does not see TUI gaps; show the TUI logger's count
      // alongside the service stats in `:logs`.
      setLogsStats({
        ...(result?.stats ?? {}),
        feedGaps: (result?.stats?.feedGaps ?? 0) + logger.stats().feedGaps,
      })
      logger.event("debug", "tui", "tui.logs.open", {
        filter: logsFilter().kind,
        entries: Array.isArray(result?.entries) ? result.entries.length : 0,
      })
    } catch (error: any) {
      setLogsError(error?.message ?? String(error))
      logger.event("error", "tui", "tui.logs.error", { error })
    } finally {
      setLogsLoading(false)
    }
  }

  const openLogs = (args: readonly string[] = []): void => {
    const parsed = parseLogsCommand(args)
    if ("error" in parsed) {
      notify(parsed.error, "error")
      return
    }
    clearPendingChord()
    setLogsFilter(parsed)
    setLogsOpen(true)
    dispatchInteraction({ type: "overlay.set", overlay: "logs" })
    void refreshLogs()
  }

  const closeLogs = (): void => {
    setLogsOpen(false)
    setLogsEntries([])
    setLogsStats(null)
    setLogsError("")
    setLogsLoading(false)
    dispatchInteraction({ type: "overlay.set", overlay: "none" })
  }

  const scrollLogsBy = (delta: number): void => {
    try { logsScrollRef?.scrollBy?.(delta) } catch {}
  }

  // Logs is a read-only overlay: Esc closes, r refetches, and the Vim movement
  // keys scroll. Every other key is trapped so it cannot leak to the surface.
  const handleLogsKey = (event: any): void => {
    event?.preventDefault?.(); event?.stopPropagation?.()
    const token = normalizeKeyToken(event)
    switch (token) {
      case "escape":
      case "q":
        closeLogs()
        return
      case "r":
        void refreshLogs()
        return
      case "j":
      case "down":
        scrollLogsBy(1)
        return
      case "k":
      case "up":
        scrollLogsBy(-1)
        return
      case "pagedown":
      case "ctrl+d":
        scrollLogsBy(10)
        return
      case "pageup":
      case "ctrl+u":
        scrollLogsBy(-10)
        return
      case "g":
        try { logsScrollRef?.scrollTo?.(0) } catch {}
        return
      case "shift+g":
        scrollLogsBy(Number.MAX_SAFE_INTEGER)
        return
    }
  }

  /**
   * The reducer's typed close intent maps onto exactly one dialog. Signals
   * update synchronously, so reading them here is the same surface the user
   * saw when Esc was pressed.
   */
  const closeOverlay = (overlay: InteractionOverlay) => {
    if (overlay === "dialog") {
      if (textPrompt()) { finishTextPrompt(undefined); return }
      if (picker()) { finishPicker(undefined); return }
      if (confirm()) { finishConfirm(undefined); return }
      if (result()) { finishResultModal(); return }
      return
    }
    if (overlay === "wizard") { wizardCancel(); return }
    if (overlay === "logs") { closeLogs(); return }
    if (overlay === "approvals") { setApprovalsOpen(false); return }
    if (overlay === "help") { closeHelp(); return }
    if (overlay === "settings") void closeSettings()
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
        label: directory === current ? chromeJoin(["Use current directory", workspaceLabel(directory)]) : workspaceLabel(directory),
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
      { key: "memories", title: "Agent memories (optional)", description: "Add memories one by one. a adds, e edits, x deletes; Enter continues.", kind: "memories", placeholder: "The team uses pnpm." },
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
    next.memoryCursor = clampWizardMemoryCursor(next.memoryCursor, next.draft.memories.length)
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

  // Forward and back share one one-shot settle keyed by the step identity.
  // A changed key starts the short dim interval; reduced motion starts and
  // ends it immediately so the next step is simply there.
  const clearWizardSettle = () => {
    if (wizardSettleTimer !== undefined) {
      clearTimeout(wizardSettleTimer)
      wizardSettleTimer = undefined
    }
  }
  createEffect(() => {
    const active = wizard()
    const key = active ? wizardStepKey() : ""
    if (!active) {
      wizardSettledKey = ""
      clearWizardSettle()
      setWizardSettling(false)
      return
    }
    if (key === wizardSettledKey) return
    wizardSettledKey = key
    clearWizardSettle()
    const duration = wizardStepSettleMs()
    if (duration <= 0) {
      setWizardSettling(false)
      return
    }
    setWizardSettling(true)
    wizardSettleTimer = setTimeout(() => {
      wizardSettleTimer = undefined
      setWizardSettling(false)
    }, duration)
  })
  onCleanup(() => {
    clearWizardSettle()
    wizardSettledKey = ""
  })

  const wizardItems = (): WizardOption[] => {
    const state = wizard()
    const step = wizardStep()
    if (!state || !step?.options) return []
    const query = state.query
    return step.options.filter((option) => option.id === "__manual__" || !query || fuzzyMatch(query, option.label))
  }

  const wizardIsMemoryStep = () => isWizardMemoryStep(wizardStep()?.key)

  const wizardMemories = (): string[] => wizard()?.draft.memories ?? []

  const wizardMemoryCursor = () => clampWizardMemoryCursor(wizard()?.memoryCursor ?? 0, wizardMemories().length)

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
    if (!state || !step || step.kind !== "text") return ""
    if (step.key === "directoryPath") return state.draft.directory
    return String((state.draft as any)[step.key] ?? "")
  }

  const wizardFinal = (state: WizardState) => !state.customDirectory && state.index >= state.steps.length - 1

  const validateWizard = (state: WizardState) =>
    wizardValidation({
      flow: state.flow,
      draft: state.draft,
      agentNames: rosterAgents().map((agent) => agent.name),
      models: models().map((model) => ({ key: `${model.providerID}/${model.modelID}`, variants: model.variants })),
    })

  const completeWizard = (state: WizardState, value: WizardDraft | undefined) => {
    // A queued submit or a stale closure must never close a different (or
    // already closed) wizard a second time.
    if (wizard() !== state) return
    setWizard(null)
    // A later wizard must never focus the unmounted editor of this one.
    wizardRef = null
    wizardMemoryRef = null
    setWizardMemoryInput("")
    setModal(false)
    clearPendingChord()
    // Closing the wizard drops its field target without changing the mode.
    dispatchInteraction({ type: "field.leave" })
    state.resolve(value)
  }

  const submitWizard = (state: WizardState) => {
    const validation = validateWizard(state)
    if (validation.error) {
      const invalid = state.steps.findIndex((step) => step.key === validation.stepKey)
      const next = {
        ...state,
        index: invalid >= 0 ? invalid : 0,
        error: validation.error,
        query: "",
        filtering: false,
        cursor: 0,
        memoryEditor: null,
        discardConfirm: false,
      }
      wizardRef = null
      wizardMemoryRef = null
      setWizard(next)
      syncWizardMode(next)
      notify(`Wizard: ${validation.error}`, "error")
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

  /** The draft including the focused field's uncommitted buffer. */
  const wizardBufferedDraft = (state: WizardState): WizardDraft => {
    const step = wizardStepFor(state)
    const draft: WizardDraft = {
      ...state.draft,
      memberIDs: [...state.draft.memberIDs],
      memories: [...state.draft.memories],
    }
    if (step?.kind === "text") {
      const value = String(wizardRef?.plainText ?? "")
      if (step.key === "directoryPath") draft.directory = value.trim()
      else (draft as any)[step.key] = value
    }
    return draft
  }

  const wizardHasUnsavedWork = (state: WizardState): boolean => {
    if (wizardDraftDirty(state.initialDraft, wizardBufferedDraft(state))) return true
    const memoryText = state.memoryEditor ? String(wizardMemoryRef?.plainText ?? wizardMemoryInput()) : state.memoryDraft
    return memoryText.trim().length > 0
  }

  const wizardCancel = () => {
    const state = wizard()
    if (!state || state.discardConfirm) return
    if (wizardHasUnsavedWork(state)) {
      setWizard({ ...state, discardConfirm: true, filtering: false, error: undefined })
      return
    }
    completeWizard(state, undefined)
  }

  const wizardDiscard = () => {
    const state = wizard()
    if (state) completeWizard(state, undefined)
  }

  const wizardKeepEditing = () => {
    const state = wizard()
    if (!state) return
    const next = { ...state, discardConfirm: false }
    setWizard(next)
    // The cancel Esc may have left the field; returning to the draft puts
    // the caret back on a text step without changing the mode.
    syncWizardMode(next)
  }

  const wizardStepFor = (state: WizardState): WizardStep | undefined =>
    state.customDirectory
      ? { key: "directoryPath", title: "Workspace directory", description: "Type or paste a directory path. Enter continues.", kind: "text", placeholder: "~/dev/project" }
      : state.steps[state.index]

  /**
   * Text steps focus an editor; list steps have no text target. Arrival
   * keeps the current mode: Insert stays Insert, Normal stays Normal, and a
   * list step honestly reports Insert without a target.
   */
  const syncWizardMode = (state: WizardState) => {
    const step = wizardStepFor(state)
    dispatchInteraction(wizardStepArrival(step?.kind))
  }

  const advanceWizard = (state: WizardState | undefined) => {
    if (!state) return
    if (wizardFinal(state)) { submitWizard(state); return }
    const next = {
      ...state,
      index: state.index + 1,
      query: "",
      filtering: false,
      cursor: 0,
      memoryEditor: null,
      discardConfirm: false,
      error: undefined,
      steps: makeWizardSteps(state),
    }
    wizardRef = null
    wizardMemoryRef = null
    setWizard(next)
    syncWizardMode(next)
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
    if (state.discardConfirm) return
    if (state.filtering) { setWizard({ ...state, filtering: false, query: "", cursor: 0 }); return }
    if (state.customDirectory) {
      const next = { ...state, customDirectory: false, query: "", filtering: false, cursor: 0, error: undefined }
      setWizard(next)
      syncWizardMode(next)
      return
    }
    const step = wizardStep()
    const saved = step?.kind === "text" ? saveWizardText() : state
    const next = saved ?? state
    // N at the first step is a no-op; Esc owns cancel.
    if (next.index <= 0) return
    const previous = {
      ...next,
      index: next.index - 1,
      query: "",
      filtering: false,
      cursor: 0,
      memoryEditor: null,
      discardConfirm: false,
      error: undefined,
      steps: makeWizardSteps(next),
    }
    wizardRef = null
    wizardMemoryRef = null
    setWizard(previous)
    syncWizardMode(previous)
  }

  const wizardMove = (delta: number) => {
    const state = wizard()
    if (!state) return
    if (wizardIsMemoryStep()) {
      setWizard({ ...state, memoryCursor: clampWizardMemoryCursor(wizardMemoryCursor() + delta, state.draft.memories.length) })
      return
    }
    const length = wizardItems().length
    setWizard({ ...state, cursor: Math.max(0, Math.min(Math.max(0, length - 1), wizardCursor() + delta)) })
  }

  const wizardJump = (index: number) => {
    const state = wizard()
    if (!state) return
    if (wizardIsMemoryStep()) {
      setWizard({ ...state, memoryCursor: clampWizardMemoryCursor(index, state.draft.memories.length) })
      return
    }
    const length = wizardItems().length
    setWizard({ ...state, cursor: Math.max(0, Math.min(Math.max(0, length - 1), index)) })
  }

  const wizardBeginFilter = () => {
    const state = wizard()
    if (!state) return
    setWizard({ ...state, filtering: true, query: "", cursor: 0 })
  }

  const wizardApplyFilter = (event: any) => {
    const state = wizard()
    if (!state) return
    const edit = filterEdit(state.query, {
      name: String(event?.name ?? ""),
      sequence: String(event?.sequence ?? ""),
      ctrl: Boolean(event?.ctrl),
      meta: Boolean(event?.meta),
      super: Boolean(event?.super),
    })
    if (edit.cancelled) {
      setWizard({ ...state, filtering: false, query: "", cursor: 0 })
      return
    }
    if (edit.done) {
      setWizard({ ...state, filtering: false, query: edit.query, cursor: 0 })
      return
    }
    setWizard({ ...state, query: edit.query, cursor: 0 })
  }

  const pickerApplyFilter = (event: any) => {
    const state = picker()
    if (!state) return
    const edit = filterEdit(state.query, {
      name: String(event?.name ?? ""),
      sequence: String(event?.sequence ?? ""),
      ctrl: Boolean(event?.ctrl),
      meta: Boolean(event?.meta),
      super: Boolean(event?.super),
    })
    if (edit.cancelled) {
      setPicker({ ...state, filtering: false, query: "", cursor: 0 })
      return
    }
    if (edit.done) {
      setPicker({ ...state, filtering: false, query: edit.query, cursor: 0 })
      return
    }
    setPicker({ ...state, query: edit.query, cursor: 0 })
  }

  const wizardMemoryClearInput = () => {
    setWizardMemoryInput("")
    queueMicrotask(() => {
      const target = wizardMemoryRef ?? wizardRef
      if (!target) return
      try {
        target.value = ""
        target.cursorOffset = 0
        focusWhenReady(() => wizardMemoryRef ?? wizardRef)
      } catch {}
    })
  }

  const wizardMemoryKeepInput = (text: string) => {
    setWizardMemoryInput(text)
    queueMicrotask(() => {
      const target = wizardMemoryRef ?? wizardRef
      if (!target) return
      try {
        target.value = text
        target.cursorOffset = text.length
        focusWhenReady(() => wizardMemoryRef ?? wizardRef)
      } catch {}
    })
  }

  const openWizardMemoryField = (mode: "add" | "edit", index: number | null) => {
    const state = wizard()
    if (!state || !wizardIsMemoryStep()) return
    const text = mode === "edit" && index !== null ? (state.draft.memories[index] ?? "") : state.memoryDraft
    setWizardMemoryInput(text)
    const next: WizardState = {
      ...state,
      memoryEditor: { mode, index },
      memoryDraft: mode === "add" ? text : state.memoryDraft,
      query: "",
      filtering: false,
      discardConfirm: false,
      error: undefined,
    }
    // The previous step's editor is unmounted; never focus its stale ref.
    wizardRef = null
    wizardMemoryRef = null
    setWizard(next)
    dispatchInteraction({ type: "insert.enter", target: "wizard" })
    wizardMemoryKeepInput(text)
  }

  const wizardMemoryStartAdd = () => openWizardMemoryField("add", null)

  const wizardMemoryStartEdit = () => {
    const state = wizard()
    if (!wizardIsMemoryStep() || !state || state.draft.memories.length === 0) return
    openWizardMemoryField("edit", wizardMemoryCursor())
  }

  const wizardMemoryDelete = () => {
    const state = wizard()
    if (!wizardIsMemoryStep() || !state || state.draft.memories.length === 0) return
    const index = wizardMemoryCursor()
    const memories = deleteWizardMemory(state.draft.memories, index)
    setWizard({
      ...state,
      draft: { ...state.draft, memories },
      memoryCursor: clampWizardMemoryCursor(index, memories.length),
      error: undefined,
    })
  }

  /** Enter in the persistent memory field: add clears for the next entry, edit keeps its text. */
  const wizardMemorySubmit = () => {
    const state = wizard()
    const editor = state?.memoryEditor
    const raw = String(wizardMemoryRef?.plainText ?? wizardMemoryInput())
    if (!wizardIsMemoryStep() || !state || !editor) return
    if (editor.mode === "add") {
      const memories = addWizardMemory(state.draft.memories, raw)
      const saved = memories.length !== state.draft.memories.length
      setWizard({
        ...state,
        draft: { ...state.draft, memories },
        memoryCursor: saved ? memories.length - 1 : wizardMemoryCursor(),
        memoryDraft: "",
        error: undefined,
      })
      wizardMemoryClearInput()
      dispatchInteraction({ type: "insert.enter", target: "wizard" })
      return
    }
    const index = editor.index
    if (index === null) return
    if (!raw.trim()) return
    const memories = updateWizardMemory(state.draft.memories, index, raw)
    setWizard({
      ...state,
      draft: { ...state.draft, memories },
      memoryCursor: clampWizardMemoryCursor(index, memories.length),
      error: undefined,
    })
    // An edit saves in place and keeps its text and focus in Insert.
    wizardMemoryKeepInput(raw)
    dispatchInteraction({ type: "insert.enter", target: "wizard" })
  }

  /** Esc leaves the persistent field for the step Normal list. */
  const wizardMemoryClose = () => {
    const state = wizard()
    if (!wizardIsMemoryStep() || !state?.memoryEditor) return
    const raw = String(wizardMemoryRef?.plainText ?? wizardMemoryInput())
    dispatchInteraction({ type: "editor.normal" })
    dispatchInteraction({ type: "field.leave" })
    wizardRef = null
    wizardMemoryRef = null
    setWizard({
      ...state,
      memoryEditor: null,
      memoryDraft: state.memoryEditor.mode === "add" ? raw : state.memoryDraft,
      discardConfirm: false,
      error: undefined,
    })
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
      const next = { ...state, customDirectory: true, query: "", filtering: false, cursor: 0, error: undefined }
      setWizard(next)
      syncWizardMode(next)
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

  const wizardActivate = () => {
    const state = wizard()
    const step = wizardStep()
    if (!state || !step) return
    if (step.kind === "text" || step.kind === "memories") { wizardNext(); return }
    const action = wizardEnterAction(step.kind, wizardFinal(state))
    if (wizardItems().length === 0) return
    if (action === "continue") advanceWizard(state)
    else wizardSelect()
  }

  const openWizard = (flow: "workspace" | "agent", edit?: Workspace): Promise<WizardDraft | undefined> => new Promise((resolve) => {
    clearPendingChord()
    // Reopening a wizard must not focus the unmounted editor of the previous
    // one; the step's field ref is resolved after this state mounts.
    wizardRef = null
    wizardMemoryRef = null
    setWizardMemoryInput("")
    const first = rosterAgents()[0]
    const model = models()[0]
    const draft: WizardDraft = flow === "workspace"
      ? edit
        ? { directory: edit.directory, name: edit.name, memberIDs: [...edit.memberIDs], leaderID: edit.leaderID, synthesis: edit.synthesis, title: "", role: "", memories: [], modelKey: "", variant: "" }
        : { directory: directoryOf(context), name: "", memberIDs: first ? [first.id] : [], leaderID: first?.id ?? "", synthesis: true, title: "", role: "", memories: [], modelKey: "", variant: "" }
      : { directory: "", name: "", memberIDs: [], leaderID: "", synthesis: true, title: "", role: "", memories: [], modelKey: model ? `${model.providerID}/${model.modelID}` : "", variant: model?.variants[0] ?? "none" }
    const state: WizardState = {
      flow,
      title: edit ? chromeJoin(["Edit workspace", `#${edit.name}`]) : flow === "workspace" ? "New workspace" : "New agent",
      draft,
      initialDraft: structuredClone(draft),
      steps: [],
      index: 0,
      query: "",
      filtering: false,
      cursor: 0,
      memoryCursor: 0,
      memoryEditor: null,
      memoryDraft: "",
      discardConfirm: false,
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
    const returnEditor = composerActive() ? "composer" as const : undefined
    setComposerActive(false)
    try { composerRef?.blur?.() } catch {}
    setWizard(state)
    dispatchInteraction({ type: "overlay.set", overlay: "wizard", returnEditor })
    syncWizardMode(state)
  })

  type DialogDescriptor =
    | { surface: "wizard"; field?: "insert" | "normal"; filtering: boolean }
    | { surface: "picker"; filtering: boolean }
    | { surface: "prompt"; field: "insert" | "normal" }
    | { surface: "confirm" }
    | { surface: "result" }
    | { surface: "approvals" }

  const dialogDescriptor = (): DialogDescriptor | null => {
    if (wizard()) {
      if (wizardIsMemoryStep() && wizard()!.memoryEditor) return { surface: "wizard", field: "insert", filtering: false }
      const step = wizardStep()
      if (step?.kind === "text") return { surface: "wizard", field: interaction().mode === "insert" ? "insert" : "normal", filtering: false }
      return { surface: "wizard", filtering: wizard()!.filtering }
    }
    if (picker()) return { surface: "picker", filtering: picker()!.filtering }
    if (textPrompt()) return { surface: "prompt", field: interaction().mode === "insert" ? "insert" : "normal" }
    if (confirm()) return { surface: "confirm" }
    if (result()) return { surface: "result" }
    if (approvalsOpen() && !helpOpen() && !settingsAgentID()) return { surface: "approvals" }
    return null
  }

  const runDialogAction = (id: string) => {
    switch (id) {
      case "wizard.down": case "wizard.down.arrow": return wizardMove(1)
      case "wizard.up": case "wizard.up.arrow": return wizardMove(-1)
      case "wizard.top": return wizardJump(0)
      case "wizard.bottom": return wizardJump(Math.max(0, wizardItems().length - 1))
      case "wizard.activate": return wizardActivate()
      case "wizard.next": return wizardNext()
      case "wizard.prev": return wizardPrev()
      // Memory actions only exist on the memories step. Keymap hints already
      // filter these entries; the handlers also guard so a stray catalog
      // resolution on a list step cannot open an unmounted field or delete a
      // saved memory.
      case "wizard.memory.add": if (wizardIsMemoryStep()) wizardMemoryStartAdd(); return
      case "wizard.memory.edit": if (wizardIsMemoryStep()) wizardMemoryStartEdit(); return
      case "wizard.memory.delete": if (wizardIsMemoryStep()) wizardMemoryDelete(); return
      case "wizard.toggle": return wizardToggle()
      case "wizard.filter": if (!wizardIsMemoryStep()) wizardBeginFilter(); return
      case "wizard.cancel": return wizardCancel()
      case "picker.down": case "picker.down.arrow": return pickerMove(1)
      case "picker.up": case "picker.up.arrow": return pickerMove(-1)
      case "picker.top": return pickerJump(0)
      case "picker.bottom": return pickerJump(Math.max(0, pickerItems().length - 1))
      case "picker.activate": return pickerActivate()
      case "picker.toggle": return pickerToggle()
      case "picker.filter": return beginPickerFilter()
      case "picker.cancel": return finishPicker(undefined)
      case "confirm.accept": case "confirm.accept.enter": return finishConfirm(true)
      case "confirm.reject": case "confirm.reject.escape": return finishConfirm(false)
      case "result.down": case "result.down.arrow": return resultScroll(3)
      case "result.up": case "result.up.arrow": return resultScroll(-3)
      case "result.top": return resultScroll(-1_000_000)
      case "result.bottom": return resultScroll(1_000_000)
      case "result.half.down": return resultScroll(Math.max(3, Math.floor(messageHeight() / 2)))
      case "result.half.up": return resultScroll(-Math.max(3, Math.floor(messageHeight() / 2)))
      case "result.page.down": return resultScroll(messageHeight())
      case "result.page.up": return resultScroll(-messageHeight())
      case "result.close.enter": case "result.close.escape": return finishResultModal()
      case "approvals.down": case "approvals.down.arrow": return setApprovalCursor((cursor) => Math.min(Math.max(0, pendingApprovals().length - 1), cursor + 1))
      case "approvals.up": case "approvals.up.arrow": return setApprovalCursor((cursor) => Math.max(0, cursor - 1))
      case "approvals.top": return setApprovalCursor(0)
      case "approvals.bottom": return setApprovalCursor(Math.max(0, pendingApprovals().length - 1))
      case "approvals.resolve": { const approval = selectedApproval(); if (approval) void resolveApproval(approval).catch(showError); return }
      case "approvals.close": dispatchInteraction({ type: "escape" }); return
    }
  }

  const fieldEnter = (surface: "wizard" | "prompt") =>
    dispatchInteraction({ type: "insert.enter", target: surface })

  const fieldInsertContext = (surface: "wizard" | "prompt"): KeyContext =>
    surface === "wizard" ? "wizardField" : "promptField"
  const fieldNormalContext = (surface: "wizard" | "prompt"): KeyContext =>
    surface === "wizard" ? "wizardText" : "promptText"

  const handleFieldInsertKey = (surface: "wizard" | "prompt", event: any): boolean => {
    const context = fieldInsertContext(surface)
    const token = normalizeKeyToken(event)
    const entry = singleKeyEntry(context, token)
    const vim = surface === "wizard" ? wizardVimBuffer() : promptVimBuffer()
    if (entry?.id === `${context}.escape`) {
      event?.preventDefault?.(); event?.stopPropagation?.()
      // Insert -> field Normal. The field stays focused; the raw handler owns
      // keys in Normal and the caret changes to a block.
      if (dialogEscape({ surface, field: true }) === "field-normal") dispatchInteraction({ type: "editor.normal" })
      vim?.invalidate()
      vim?.normalizeCursor()
      return true
    }
    if (entry?.id === `${context}.leave`) {
      event?.preventDefault?.(); event?.stopPropagation?.()
      vim?.invalidate()
      syncVimChord(null)
      dispatchInteraction({ type: "leave.editor" })
      return true
    }
    // Enter stays with the textarea's `onSubmit`; Shift+Enter adds a line.
    // Insert is otherwise the editor's own mode: printable keys, Backspace,
    // arrows, and the system clipboard all belong to the renderable.
    return false
  }

  const handleFieldNormalKey = (surface: "wizard" | "prompt", event: any): boolean => {
    const context = fieldNormalContext(surface)
    const token = normalizeKeyToken(event)
    const mode = interaction().mode
    const vim = surface === "wizard" ? wizardVimBuffer() : promptVimBuffer()
    const entry = singleKeyEntry(context, token)
    if (entry?.id === `${context}.escape`) {
      event?.preventDefault?.(); event?.stopPropagation?.()
      if (mode === "visual") {
        dispatchInteraction({ type: "escape" })
        vim?.invalidate()
        syncVimChord(null)
        return true
      }
      const action = dialogEscape({ surface })
      vim?.invalidate()
      syncVimChord(null)
      if (surface === "wizard") {
        // Esc from field Normal cancels the wizard (the adapter asks to
        // discard only when the draft is dirty); N goes back one step.
        dispatchInteraction({ type: "escape" })
      } else {
        dispatchInteraction({ type: "field.leave" })
        if (action === "cancel") finishTextPrompt(undefined)
      }
      return true
    }
    if (entry?.id === `${context}.leave`) {
      event?.preventDefault?.(); event?.stopPropagation?.()
      vim?.invalidate()
      syncVimChord(null)
      dispatchInteraction({ type: "leave.editor" })
      return true
    }
    if (entry?.id === `${context}.next`) {
      event?.preventDefault?.(); event?.stopPropagation?.()
      vim?.invalidate()
      syncVimChord(null)
      wizardNext()
      return true
    }
    if (entry?.id === `${context}.prev`) {
      event?.preventDefault?.(); event?.stopPropagation?.()
      vim?.invalidate()
      syncVimChord(null)
      wizardPrev()
      return true
    }
    if (entry?.id === `${context}.submit` || token === "shift+enter") {
      // The focused textarea owns submit/newline in both Normal and Insert;
      // Visual swallows them so a pending selection is never submitted.
      if (mode === "visual") {
        event?.preventDefault?.(); event?.stopPropagation?.()
        return true
      }
      return false
    }
    event?.preventDefault?.(); event?.stopPropagation?.()
    const rawName = String(event?.name ?? "")
    const ctrl = Boolean(event?.ctrl) || rawName.startsWith("ctrl+")
    const name = rawName.startsWith("ctrl+") ? rawName.slice("ctrl+".length) : rawName
    const key = normalizeVimKey({ name, ctrl, shift: Boolean(event?.shift) })
    if (!vim || !key) return true
    void vim
      .press(key)
      .then((outcome) =>
        applyVimOutcome(outcome, {
          insert: () => fieldEnter(surface),
        }),
      )
      .catch(showError)
    return true
  }

  const handleWizardMemoryKey = (event: any): boolean => {
    const token = normalizeKeyToken(event)
    const entry = singleKeyEntry("wizardMemory", token)
    const prevent = () => { event?.preventDefault?.(); event?.stopPropagation?.() }
    if (entry?.id === "wizardMemory.save") {
      prevent()
      wizardMemorySubmit()
      return true
    }
    if (entry?.id === "wizardMemory.list" || entry?.id === "wizardMemory.leave") {
      prevent()
      wizardMemoryClose()
      return true
    }
    // Insert is the input's own mode; printable keys, Backspace, arrows, and
    // the clipboard stay with the field.
    return false
  }

  /**
   * One catalog-driven handler for every dialog. Text fields follow the
   * Insert -> field Normal -> back/cancel ladder and route motions through
   * the shared Vim adapter; list surfaces route j/k, gg/G, Enter, Space, /,
   * and Esc through the same keymap catalog as the roster and chat.
   */
  const handleDialogKey = (event: any): boolean => {
    const dialog = dialogDescriptor()
    if (!dialog) return false
    const token = normalizeKeyToken(event)
    if (wizard()?.discardConfirm) {
      event?.preventDefault?.(); event?.stopPropagation?.()
      if (token === "y" || token === "enter") wizardDiscard()
      else if (token === "n" || token === "shift+n" || token === "escape") wizardKeepEditing()
      return true
    }
    if (dialog.surface === "wizard" && wizard()?.memoryEditor) return handleWizardMemoryKey(event)
    if (dialog.surface === "wizard" && dialog.field === "insert") return handleFieldInsertKey("wizard", event)
    if (dialog.surface === "prompt" && dialog.field === "insert") return handleFieldInsertKey("prompt", event)
    if (dialog.surface === "wizard" && dialog.field === "normal") return handleFieldNormalKey("wizard", event)
    if (dialog.surface === "prompt" && dialog.field === "normal") return handleFieldNormalKey("prompt", event)
    if ((dialog.surface === "wizard" || dialog.surface === "picker") && dialog.filtering) {
      event?.preventDefault?.(); event?.stopPropagation?.()
      if (dialog.surface === "wizard") wizardApplyFilter(event)
      else pickerApplyFilter(event)
      return true
    }

    event?.preventDefault?.(); event?.stopPropagation?.()
    if (token === "escape") {
      dispatchInteraction({ type: "escape" })
      return true
    }
    const context: KeyContext = dialog.surface === "approvals" ? "approvals" : dialogKeyContext({ surface: dialog.surface })
    const resolved = resolveNormalKey(context, pendingKeys, token)
    if (resolved.type === "pending") {
      setPendingChord([...resolved.prefix])
      return true
    }
    if (resolved.type === "action") {
      runDialogAction(resolved.entry.id)
      return true
    }
    if (pendingKeys.length > 0) clearPendingChord()
    // A dialog traps every other key: `:` and Space never reach the surface
    // underneath, and the wizard never opens the command line or the leader.
    return true
  }

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
      return chromeJoin([surfaceAgent()?.name ?? "Agent", "direct", workspace ? `#${workspace.name}` : "no workspace"])
    }
    const workspace = state()?.workspaces[current.workspaceID]
    if (!workspace) return "Workspace"
    const leader = state()?.agents[workspace.leaderID]?.name ?? workspace.leaderID
    return chromeJoin([`#${workspace.name}`, workspaceLabel(workspace.directory), `leader ${leader}`])
  }

  const statusSurface = (): StatuslineSurface => surface()?.kind ?? "none"
  const statusContext = () => contextLabel({ focus: interaction().focus, overlay: interaction().overlay, surface: statusSurface() })
  const statusPosition = () => {
    if (settingsField()) return composerPosition(settingsFieldText(), settingsFieldCursor())
    if (composerActive()) return composerPosition(composerDraft(), composerCursor())
    if (settingsAgentID()) return listPosition(settingsCursorClamped(), settingsRowTotal())
    const activeWizard = wizard()
    if (activeWizard) {
      if (activeWizard.memoryEditor) return composerPosition(wizardMemoryInput(), wizardMemoryInput().length)
      if (wizardStep()?.kind === "text") return composerPosition(String(wizardRef?.plainText ?? ""), Number(wizardRef?.cursorOffset ?? 0))
      if (wizardIsMemoryStep()) return listPosition(wizardMemoryCursor(), wizardMemories().length)
      return listPosition(wizardCursor(), wizardItems().length)
    }
    if (picker()) return listPosition(picker()!.cursor, pickerItems().length)
    const prompt = textPrompt()
    if (prompt) return composerPosition(String(textPromptRef?.plainText ?? prompt.value), Number(textPromptRef?.cursorOffset ?? 0))
    if (interaction().focus === "rail") return listPosition(railCursor(), railItems().length)
    if (interaction().focus === "work") return listPosition(taskCursorClamped(), visibleTasks().length)
    const metrics = transcriptScroll()
    return transcriptPosition(metrics.top, metrics.height, metrics.viewport)
  }
  const statusTextValue = (): string => {
    if (settingsField()) return settingsFieldText()
    const activeWizard = wizard()
    if (activeWizard?.memoryEditor) return wizardMemoryInput()
    if (activeWizard && wizardStep()?.kind === "text") return String(wizardRef?.plainText ?? "")
    const prompt = textPrompt()
    if (prompt) return String(textPromptRef?.plainText ?? prompt.value)
    if (composerActive()) return String(composerRef?.plainText ?? composerDraft())
    return ""
  }
  const statusSelectionSize = (): string | undefined => {
    const selection = interaction().selection
    if (interaction().mode !== "visual" || !selection) return undefined
    return visualSelectionSize(statusTextValue(), selection)
  }
  const settingsEntryEnabled = (entry: KeyEntry) => settingsActionEnabled(entry.id)
  const wizardHint = () => {
    if (interaction().mode === "visual") return visualHint
    const state = wizard()
    if (!state) return ""
    if (state.discardConfirm) return chromeJoin(["discard draft?", "y/enter discard", "n/esc keep editing"])
    if (state.memoryEditor) return statuslineHints("wizardMemory")
    const step = wizardStep()
    if (state.filtering) return statuslineHints("filter")
    if (step?.kind === "text") {
      return statuslineHints(dialogKeyContext({ surface: "wizard", field: interaction().mode === "insert" ? "insert" : "normal" }))
    }
    return statuslineHints("wizard", {
      multiple: step?.kind === "multi",
      memory: step?.kind === "memories",
      filter: (entry) => !wizardIsMemoryStep() || entry.id !== "wizard.filter",
    })
  }
  const dialogHint = () => {
    if (interaction().mode === "visual") return visualHint
    const prompt = textPrompt()
    if (prompt) {
      return statuslineHints(dialogKeyContext({ surface: "prompt", field: interaction().mode === "insert" ? "insert" : "normal" }))
    }
    const chooser = picker()
    if (chooser?.filtering) return statuslineHints("filter")
    if (chooser) return statuslineHints("picker", { multiple: chooser.mode === "members" })
    if (confirm()) return statuslineHints("confirm")
    if (result()) return statuslineHints("result")
    return ""
  }
  const statusHints = () => {
    if (leaderMode()) return leaderHints()
    const command = interaction().command
    if (command) {
      const hints = commandStatusHints(command.kind)
      if (command.kind === ":") {
        const suggestions = commandCompletions(command.text).slice(0, 3).map((item) => item.name)
        return suggestions.length > 0 ? chromeJoin([hints, ...suggestions]) : hints
      }
      return hints
    }
    if (insertWithoutTarget(interaction())) return "Esc normal"
    if (interaction().mode === "visual") return visualHint
    if (wizard()) return wizardHint()
    if (picker() || textPrompt() || confirm() || result()) return dialogHint()
    if (approvalsOpen() && !helpOpen() && !settingsAgentID()) return statuslineHints("approvals")
    if (interaction().overlay === "none") {
      const search = transcriptSearch()
      if (search) {
        const total = transcriptSearchMatches().length
        const position = total > 0 ? Math.min(total, search.cursor + 1) : 0
        return chromeJoin([`match ${position}/${total}`, statuslineHints("search")])
      }
      if (workspaceFilter()) return chromeJoin([`filter “${workspaceFilter()}”`, "esc clear"])
    }
    if (selectedMissingSkills().length > 0) {
      return footerLine2({ focus: chromeFocus(), hasWork: hasWorkZone(), missingSkills: selectedMissingSkills() })
    }
    if (settingsField()) {
      const memory = settingsField()!.kind === "memory"
      return interaction().mode === "insert"
        ? statuslineHints(memory ? "settingsMemoryField" : "settingsField")
        : statuslineHints(memory ? "settingsMemoryText" : "settingsText")
    }
    if (settingsAgentID()) return statuslineHints("settings", { filter: settingsEntryEnabled })
    if (interaction().overlay === "help") {
      if (helpFiltering()) return statuslineHints("filter")
      const matches = helpMatchEntries().length
      if (helpQuery()) return chromeJoin([`match ${matches > 0 ? Math.min(matches, helpMatch() + 1) : 0}/${matches}`, statuslineHints("help")])
      return statuslineHints("help")
    }
    if (composerActive()) {
      if (interaction().mode === "visual") return visualHint
      if (interaction().mode === "normal") return statuslineHints("composerNormal")
      return statuslineHints("composerInsert", {
        filter: (entry) => entry.id !== "composerInsert.stop" || stoppable(),
      })
    }
    if (interaction().focus === "work") return statuslineHints("work", { hasWork: hasWorkZone() })
    const keyContext = surfaceKeyContext()
    if (keyContext) return statuslineHints(keyContext, { hasWork: hasWorkZone() })
    return footerLine1({ focus: chromeFocus(), hasWork: hasWorkZone() })
  }
  const statusMessage = () => visibleMessage(interaction(), Date.now())?.text ?? null
  const statusSegments = () => buildStatuslineSegments({
    mode: interactionMode(),
    visualKind: interaction().selection?.kind,
    leader: leaderMode(),
    context: statusContext(),
    // Insert without a target only replaces the typing hints with a notice;
    // git, position, selection size, and the pending chord stay visible.
    notice: insertWithoutTarget(interaction()) ? "no text target" : undefined,
    git: gitState(),
    position: statusPosition(),
    selectionSize: statusSelectionSize(),
    pendingChord: interaction().pendingChord,
    hints: statusHints(),
  })
  // Row two has two display shapes: the Command/Search line (a fixed prompt
  // cell plus a horizontally scrolling input with a visible caret) and a
  // transient message. Help filtering uses the same line shape but is not a
  // CommandInput.
  const statusRow2Input = (): StatuslineRow2Input => {
    const command = interaction().command
    if (command) return { prompt: command.kind, text: command.text, cursor: command.cursor, width: Math.max(1, statuslineWidth() - 1) }
    if (helpFiltering()) return { prompt: "/", text: helpQuery(), cursor: helpQuery().length, width: Math.max(1, statuslineWidth() - 1) }
    return { message: statusMessage(), tone: interaction().message?.tone }
  }
  const statusRow2Prompt = () => statuslineRow2PromptParts(statusRow2Input())
  const statusRow2 = () => statuslineRow2Parts(statusRow2Input())
  /** The in-chat line under the composer, from the same catalog as the bar. */
  const composerInlineHint = () => {
    if (completion()) return statuslineHints("completion")
    if (!composerActive()) {
      const compose = statuslineHints("chat", { filter: (entry) => entry.id === "compose.alt" })
      const insert = statuslineHints("composerInsert", {
        filter: (entry) => ["composerInsert.mention", "composerInsert.file", "composerInsert.slash"].includes(entry.id),
      })
      return chromeJoin([compose, insert].filter(Boolean))
    }
    if (interaction().mode === "visual") return visualHint
    if (interaction().mode === "normal") return statuslineHints("composerNormal")
    return statuslineHints("composerInsert", {
      filter: (entry) => entry.id !== "composerInsert.stop" || stoppable(),
    })
  }

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor={colors.bg}
      padding={1}
      gap={1}
      onMouseDown={(event: any) => {
        if (Number(event?.button) !== 0) return
        // OpenTUI clears a fresh selection and focuses the nearest focusable
        // ancestor on an unprevented left down. Preventing it keeps the drag
        // selection alive and makes every mouse gesture focus/mode-neutral.
        event?.preventDefault?.()
        mouseSelectionPane = paneName(event?.target)
      }}
    >
      <box id={MOUSE_PANE_IDS.header} height={3} flexDirection="row" border={["bottom"]} borderColor={colors.border} backgroundColor={colors.bg} paddingLeft={1} paddingRight={1} opacity={overlayOpen() ? 0.35 : 1}>
        <box flexDirection="column" flexGrow={1}>
          <ChromeText colors={colors} fg={colors.accent} bg={colors.bg} width="100%" truncate text={chromeJoin(["ENSEMBLE", ...(activeWorkspace() ? [`#${activeWorkspace()!.name}`, ...(activeWorkspace()!.paused ? ["paused"] : []), workspaceLabel(activeWorkspace()!.directory)] : ["no workspace"])])} />
          <ChromeText colors={colors} fg={leaderMode() ? colors.warn : busy() ? colors.warn : colors.muted} bg={colors.bg} width="100%" truncate text={leaderMode() ? chromeJoin(["LEADER", "which-key", "esc cancel"]) : `${isBusy() ? `${chromeJoin(["BUSY", status()])}` : status()}`} />
        </box>
      </box>
        <box flexDirection="row" flexGrow={1} gap={1} opacity={overlayOpen() ? 0.35 : 1}>
          <Rail colors={colors} items={railItems()} cursor={railCursor()} focus={chromeOwnsFocus(chromeFocus(), "rail")} cursorVisible={chromeOwnsFocus(chromeFocus(), "rail")} activeWorkspaceID={workspaceID()} state={state()} counts={client.counts()} pendingApprovals={pendingApprovals().length} width={railWidth()} filter={workspaceFilter()} motionTick={motionFrame()} emphasis={railEmphasis()} />
          <box id={MOUSE_PANE_IDS.chat} flexGrow={1} minHeight={0} overflow="hidden" position="relative" border borderStyle="single" borderColor={chromeOwnsFocus(chromeFocus(), "chat") ? colors.focus : colors.border} backgroundColor={colors.bg} flexDirection="column" padding={1}>
            <ChromeText colors={colors} fg={chromeFocus() === "chat" || chromeFocus() === "composer" ? colors.focus : colors.muted} bg={colors.bg} width="100%" truncate flexShrink={0} text={surfaceTitle()} />
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
                                    // Ticket #122: a failed/cancelled
                                    // outcome emphasizes once, then settles
                                    // back to the muted inline line.
                                    const emphasized = () => transcriptEmphasis().get(row.id) === "error"
                                    return (
                                    <box flexDirection="column" marginTop={1} paddingLeft={1} paddingRight={1}>
                                      <text fg={emphasized() ? colors.bad : colors.muted} bg={emphasized() ? colors.panel : colors.bg} width="100%" wrapMode="word">{row.completion.text}</text>
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
                                    const hit = searchLineState(message.id)
                                    return (
                                    <box id={chatRowID(message.id)} flexDirection="column" marginTop={1} paddingLeft={1} paddingRight={1}>
                                      <text fg={hit ? (hit.current ? colors.warn : colors.focus) : message.queued ? colors.warn : authorColor({ agentID: message.agentID, author: message.author, role: message.role })} bg={hit ? colors.panel : colors.bg} width="100%" truncate>{headerForLine(message)}</text>
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
                                  const hit = searchLineState(message.id)
                                  const accent = hit ? (hit.current ? colors.warn : colors.focus) : authorColor({ agentID: message.agentID, author: message.author, role: message.role })
                                  // Ticket #122: one-shot completion/error beat.
                                  // The accessor stays reactive inside the stable
                                  // <For> row, so only colors change — never row
                                  // identity, geometry, or scroll state.
                                  const emphasis = () => transcriptEmphasis().get(message.id)
                                  const wrapWidth = bubbleContentWidth(messageWidth(), BUBBLE_CHROME)
                                  return (
                                  <box id={chatRowID(message.id)} flexDirection="column" width="100%" marginTop={1}>
                                    <box alignSelf={side === "left" ? "flex-start" : "flex-end"} width="72%" border={true} borderStyle="rounded" borderColor={emphasis() === "error" ? colors.bad : emphasis() === "finalized" ? colors.focus : side === "left" ? accent : message.queued ? colors.warn : colors.good} backgroundColor={colors.panel} padding={1} flexDirection="column">
                                      <text fg={emphasis() === "error" ? colors.bad : message.queued && !hit ? colors.warn : accent} bg={colors.panel} width="100%" truncate>{headerForLine(message)}</text>
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
                                      <text fg={colors.faint} bg={colors.bg}>{` ${chromeSeparator()} `}</text>
                                      <text fg={colors.muted} bg={colors.bg}>{entry.verb}</text>
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
                                  <text fg={colors.faint} bg={colors.bg}>{` ${chromeSeparator()} `}</text>
                                  <text fg={colors.muted} bg={colors.bg}>queued</text>
                                </box>
                              )}</For>
                              <Show when={liveActivity().overflow > 0}>
                                <text fg={colors.faint} bg={colors.bg} width="100%" truncate>+{liveActivity().overflow} more</text>
                              </Show>
                            </box>
                          </Show>
                          <Show when={initRows().length > 0}>
                            <box flexShrink={0} flexDirection="column" paddingLeft={1} paddingRight={1}>
                              <For each={initRows()}>{(row) => (
                                <InitRowView colors={colors} row={row} />
                              )}</For>
                            </box>
                          </Show>
                          <Show when={showWorkBlock()}>
                            <box flexShrink={0} backgroundColor={colors.bg} paddingLeft={1} paddingRight={1} flexDirection="column">
                              <ChromeText colors={colors} fg={colors.muted} bg={colors.bg} width="100%" truncate text={workHeader()} />
                              <Show when={workPane().layout.mode === "cards"} fallback={
                                <For each={workPane().sections}>{(section) => (
                                  <box flexDirection="column" width="100%">
                                    <Show when={section.label}>
                                      <ChromeText colors={colors} fg={colors.faint} bg={colors.bg} width="100%" truncate text={section.label ?? ""} />
                                    </Show>
                                    <For each={section.tasks}>{(task) => {
                                      // Ticket #142: compact rows are not Work
                                      // cards, but the fallback still needs its
                                      // own reactive view. A local memo keeps
                                      // the cursor and glyph live without
                                      // rebuilding static card data.
                                      const view = createMemo(() => {
                                        const now = Date.now()
                                        const rowStatus = deriveWorkStatus(task, now)
                                        const terminal = isTerminalWorkStatus(rowStatus)
                                        const needsYou = !terminal && isNeedsYouTask(task, pendingApprovalIDs(), nativeBlockedSubtaskIDs())
                                        const pending = !terminal && pendingWork()?.id === task.id ? pendingWork()!.action : null
                                        const glyph = needsYou ? NEEDS_YOU_MARK : workRowFrame(rowStatus, motionFrame(), process.env)
                                        return {
                                          terminal,
                                          selected: !terminal && interaction().focus === "work" && selectedTask()?.id === task.id,
                                          row: workCompactRow(
                                            agentName(state(), task.assigneeID),
                                            task.title || "(untitled)",
                                            glyph,
                                            pending ? pendingWorkLabel(pending) : workCardStateWord(rowStatus, needsYou),
                                            Math.max(1, workContentWidth() - 2),
                                          ),
                                          tones: workCardTones(rowStatus, needsYou),
                                        }
                                      })
                                      return (
                                        <WorkCompactRowView
                                          colors={colors}
                                          row={view().row}
                                          tones={view().tones}
                                          selected={view().selected}
                                          terminal={view().terminal}
                                        />
                                      )
                                    }}</For>
                                  </box>
                                )}</For>
                              }>
                                <For each={workPane().sections}>{(section, sectionIndex) => (
                                  <Show when={section.mode === "cards"} fallback={
                                    <Show when={section.label}>
                                      <ChromeText colors={colors} fg={colors.faint} bg={colors.bg} width="100%" truncate text={section.label ?? ""} />
                                    </Show>
                                  }>
                                    <box flexDirection="column" width="100%" marginTop={workSectionMarginTop(sectionIndex())}>
                                      <Show when={section.label}>
                                        <ChromeText colors={colors} fg={colors.faint} bg={colors.bg} width="100%" truncate text={section.label ?? ""} />
                                      </Show>
                                      <box flexDirection="row" width="100%" gap={1}>
                                        <For each={section.cards}>{(card) => (
                                          <WorkCardView
                                            colors={colors}
                                            card={card}
                                            glyph={workCardGlyph(card, motionFrame(), process.env)}
                                            tide={workCardTide(card, {
                                              tideTick: workFrame(),
                                              env: process.env,
                                              freezeState: tideFreezes,
                                              now: Date.now(),
                                            })}
                                            width={workPane().layout.cardWidth}
                                            selected={interaction().focus === "work" && selectedTask()?.id === card.id}
                                          />
                                        )}</For>
                                      </box>
                                      <Show when={section.overflow > 0}>
                                        <text fg={colors.faint} bg={colors.bg} width="100%" truncate>+{section.overflow} more</text>
                                      </Show>
                                    </box>
                                  </Show>
                                )}</For>
                                <text fg={colors.faint} bg={colors.bg} width="100%" truncate>{chromeJoin(["d delegate", "t reassign", "↵ result", "r retry", "R restart", "x cancel", "o native"])}</text>
                              </Show>
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
                            const title = state.kind === "agent" ? "$ agents" : state.kind === "file" ? "@ files" : state.scope === "agent" ? chromeJoin([`$${state.ownerName ?? "agent"} /`, "skills"]) : chromeJoin(["/ commands", "skills"])
                            return state.query ? chromeJoin([title, state.query]) : title
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
                      <box flexShrink={0} border borderStyle="single" borderColor={composerBorderColor()} backgroundColor={colors.bg} paddingLeft={1} paddingRight={1}>
                        <textarea ref={(value: any) => { composerRef = value; applyEditorCaret(value) }} initialValue={composerDraft()} placeholder="Message…  $agent │ @file │ /command" width="100%" height={composerHeight()} backgroundColor={colors.bg} textColor={colors.text} onContentChange={() => { const value = String(composerRef?.plainText ?? ""); const cursor = Number(composerRef?.cursorOffset ?? value.length); setComposerDraft(value); setComposerCursor(cursor); setDrafts((store) => updateDraft(store, currentDraftKey(), value)); if (composerRef) composerRef.height = computeComposerHeight(value, Math.max(12, messageWidth() - 6)); handleComposerInput(value, cursor) }} onCursorChange={() => { const value = String(composerRef?.plainText ?? ""); const cursor = Number(composerRef?.cursorOffset ?? value.length); setComposerCursor(cursor); if (completion()?.kind === "command") commandPaletteCompletion(value, cursor) }} onSubmit={() => { void submitComposer(String(composerRef?.plainText ?? "")).catch(showError) }} keyBindings={[{ name: "return", action: "submit" }, { name: "return", shift: true, action: "newline" }, { name: "kpenter", action: "submit" }, { name: "kpenter", shift: true, action: "newline" }]} />
                      </box>
                      <ChromeText colors={colors} fg={composerActive() ? colors.warn : colors.muted} bg={colors.bg} width="100%" truncate text={composerActive() && interaction().mode === "visual" ? chromeJoin(["COMPOSER", interaction().selection?.kind === "line" ? "V-LINE" : "VISUAL", composerInlineHint()].filter(Boolean)) : composerActive() ? chromeJoin(["COMPOSER", interaction().mode === "normal" ? "NORMAL" : "", composerInlineHint()].filter(Boolean)) : composerInlineHint()} />
                    </>
                  </Show>
                }>
                  <box flexDirection="column" opacity={overlayOpacity()}>
                    <ApprovalList colors={colors} approvals={pendingApprovals()} cursor={approvalCursor()} resolvingID={resolvingApprovalID()} state={state()} onResolve={resolveApproval} motionTick={motionFrame()} emphasized={approvalMotion().emphasized} resolved={approvalMotion().resolved} />
                  </box>
                </Show>
              }>
                <box flexGrow={1} minHeight={0} flexDirection="column" opacity={overlayOpacity()}>
                  <HelpView
                    colors={colors}
                    sections={helpVisibleSections()}
                    query={helpQuery()}
                    filtering={helpFiltering()}
                    matchKey={helpMatchKey()}
                    scrollRef={(value: any) => { helpScrollRef = value }}
                  />
                </box>
              </Show>
            }>
              <SettingsView colors={colors} agent={draft()} tab={settingsTab()} dirty={dirty()} cursor={settingsCursorClamped()} memories={filteredMemories()} memoryFilter={memoryFilter()} memoryTotal={agentMemories().length} skills={filteredSkills()} skillFilter={skillFilter()} skillCatalog={skills()} skillPage={skillPage()} acknowledgement={settingsAck()} field={settingsField()} fieldMode={interaction().mode} fieldRef={(value: any) => { settingsFieldRef = value; applyEditorCaret(value); if (value) settingsFieldVimBuffer() }} onFieldContentChange={syncSettingsFieldFromEditor} onFieldCursorChange={syncSettingsFieldFromEditor} />
            </Show>
          </box>
        </box>
      <Show when={logsOpen()}>
        <box id={MOUSE_PANE_IDS.dialog} position="absolute" top={logsGeometry().top} left={logsGeometry().left} width={logsGeometry().width} height={logsHeight} zIndex={100} border borderStyle="double" borderColor={colors.focus} backgroundColor={colors.panel} padding={1} flexDirection="column" opacity={overlayOpacity()}>
          <text fg={colors.focus} bg={colors.panel} width="100%" truncate>{logsTitle(logsFilter())}</text>
          <text fg={colors.muted} bg={colors.panel} width="100%" truncate>{formatLogStats(logsStats())}</text>
          <scrollbox ref={(value: any) => { logsScrollRef = value }} flexGrow={1} minHeight={0} stickyScroll stickyStart="bottom" width="100%">
            <For each={logsEntries()}>{(entry) => (
              <text fg={colors[logEntryTone(entry.level)]} bg={colors.panel} width="100%" truncate>{formatLogEntry(entry)}</text>
            )}</For>
          </scrollbox>
          <text fg={logsError() ? colors.bad : colors.faint} bg={colors.panel} width="100%" truncate>{logsError() || (logsLoading() ? "loading…" : `${logsEntries().length} entries · r refresh · j/k scroll · esc close`)}</text>
        </box>
      </Show>
      <Show when={isToastModal() ? null : toasts().visible} keyed>
        {(toast) => {
          const placement = toastPlacement(viewWidth())
          return <ToastOverlay colors={colors} toast={toast} top={placement.top} left={placement.left} width={placement.width} />
        }}
      </Show>
      <Show when={picker()?.mode} keyed>
        <>
          <box id={MOUSE_PANE_IDS.dialog} position="absolute" top={pickerGeometry().top} left={pickerGeometry().left} width={pickerGeometry().width} height={16} zIndex={100} backgroundColor={colors.panel} flexDirection="column" opacity={overlayOpacity()}>
            <box position="absolute" top={0} left={0} width="100%" height="100%" zIndex={110}>
              <PickerOverlay colors={colors} title={() => picker()!.title} query={() => picker()!.query} items={() => pickerItems()} cursor={() => picker()!.cursor} multiple={() => picker()!.mode === "members"} footer={() => statuslineHints("picker", { multiple: picker()?.mode === "members" })} />
            </box>
          </box>
        </>
      </Show>
      <Show when={textPrompt()} keyed>
        <>
          <box id={MOUSE_PANE_IDS.dialog} position="absolute" top={promptGeometry().top} left={promptGeometry().left} width={promptGeometry().width} zIndex={100} height={14} border borderStyle="double" borderColor={colors.focus} backgroundColor={colors.panel} padding={1} flexDirection="column" opacity={overlayOpacity()}>
            <box position="absolute" top={0} left={0} width="100%" height="100%" padding={1} flexDirection="column" zIndex={110}>
            <text fg={colors.focus} bg={colors.panel} width="100%" truncate>{textPrompt()!.title}</text>
            <text fg={colors.muted} bg={colors.panel} width="100%" wrapMode="word">{textPrompt()!.description}</text>
            <box height={7} minHeight={7} flexShrink={0} border borderStyle="single" borderColor={colors.focus} backgroundColor={colors.panel} paddingLeft={1} paddingRight={1}>
              <textarea ref={(value: any) => { textPromptRef = value; applyEditorCaret(value); if (value) focusWhenReady(() => value) }} initialValue={textPrompt()!.value} placeholder={textPrompt()!.placeholder} width="100%" height={5} backgroundColor={colors.panel} textColor={colors.text} onSubmit={() => finishTextPrompt(String(textPromptRef?.plainText ?? ""))} keyBindings={[{ name: "return", action: "submit" }, { name: "return", shift: true, action: "newline" }, { name: "kpenter", action: "submit" }, { name: "kpenter", shift: true, action: "newline" }]} />
            </box>
            <text fg={colors.faint} bg={colors.panel} width="100%" truncate>{interaction().mode === "visual" ? visualHint : statuslineHints(dialogKeyContext({ surface: "prompt", field: interaction().mode === "insert" ? "insert" : "normal" }))}</text>
            </box>
          </box>
        </>
      </Show>
      <Show when={confirm()} keyed>
        <>
          <box id={MOUSE_PANE_IDS.dialog} position="absolute" top={confirmGeometry().top} left={confirmGeometry().left} width={confirmGeometry().width} zIndex={100} height={10} border borderStyle="double" borderColor={colors.focus} backgroundColor={colors.panel} padding={1} flexDirection="column" opacity={overlayOpacity()}>
            <box position="absolute" top={0} left={0} width="100%" height="100%" padding={1} flexDirection="column" zIndex={110}>
            <text fg={colors.focus} bg={colors.panel} width="100%" truncate>{confirm()!.title}</text>
            <text fg={colors.text} bg={colors.panel} width="100%" wrapMode="word">{confirm()!.message}</text>
            <text fg={colors.faint} bg={colors.panel} width="100%" truncate>{statuslineHints("confirm")}</text>
            </box>
          </box>
        </>
      </Show>
      <Show when={result()} keyed>
        <>
          <box id={MOUSE_PANE_IDS.dialog} position="absolute" top={resultGeometry().top} left={resultGeometry().left} width={resultGeometry().width} zIndex={100} height={18} border borderStyle="double" borderColor={colors.focus} backgroundColor={colors.panel} padding={1} flexDirection="column" opacity={overlayOpacity()}>
            <box position="absolute" top={0} left={0} width="100%" height="100%" padding={1} flexDirection="column" zIndex={110}>
            <text fg={colors.focus} bg={colors.panel} width="100%" truncate>{result()!.title}</text>
            <scrollbox ref={(value: any) => { resultScrollRef = value }} flexGrow={1} minHeight={0} stickyScroll stickyStart="top" width="100%">
              <text fg={colors.text} bg={colors.panel} width="100%" wrapMode="word">{result()!.text || " "}</text>
            </scrollbox>
            <text fg={colors.faint} bg={colors.panel} width="100%" truncate>{statuslineHints("result")}</text>
            </box>
          </box>
        </>
      </Show>
      <Show when={wizard()}>
        <box id={MOUSE_PANE_IDS.dialog} position="absolute" top={wizardGeometry().top} left={wizardGeometry().left} width={wizardGeometry().width} height={wizardHeight} zIndex={100} border borderStyle="double" borderColor={colors.focus} backgroundColor={colors.panel} padding={1} flexDirection="column" opacity={overlayOpacity()}>
          <box width="100%" flexGrow={1} minHeight={0} flexDirection="column" opacity={wizardStepSettleOpacity(wizardSettling())}>
            <ChromeText colors={colors} fg={colors.focus} bg={colors.panel} width="100%" truncate text={chromeJoin([wizard()!.title, wizardStepRail(wizard()!.steps.length, wizard()!.index), `${wizard()!.index + 1} / ${wizard()!.steps.length}`])} />
            <text fg={colors.text} bg={colors.panel} width="100%" truncate>{wizardStep()?.title ?? ""}</text>
            <text fg={colors.muted} bg={colors.panel} width="100%" wrapMode="word">{wizardStep()?.description ?? ""}</text>
            <Show when={wizardIsMemoryStep()} fallback={
              <Show when={wizardStep()?.kind === "text"} fallback={
                <box flexDirection="column" height={9}>
                  <ChromeText colors={colors} fg={colors.faint} bg={colors.panel} width="100%" truncate text={chromeJoin([`filter: ${wizard()!.query || "(none)"}`, `${wizardItems().length} options`, ...(wizard()!.filtering ? ["typing"] : [])])} />
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
                        return `${offset + slot === wizardCursor() ? "›" : " "} ${marker}${item.detail ? chromeJoin([item.label, item.detail]) : item.label}`
                      })()}</text>
                    )}</For>
                    }>
                      <text fg={colors.muted} bg={colors.panel} width="100%" truncate>{pickerEmptyLine()}</text>
                    </Show>
                  }>
                    <text fg={colors.warn} bg={colors.panel} width="100%" wrapMode="word">{wizardModelEmptyHint(client.modelsError())}</text>
                  </Show>
                </box>
              }>
                <Show when={wizardStepKey()} keyed>
                  <box height={7} minHeight={7} flexShrink={0} border borderStyle="single" borderColor={colors.focus} backgroundColor={colors.panel} paddingLeft={1} paddingRight={1}>
                    <textarea ref={(value: any) => { wizardRef = value; applyEditorCaret(value); if (value) focusWhenReady(() => value) }} initialValue={wizardTextValue()} placeholder={wizardStep()?.placeholder ?? ""} width="100%" height={5} backgroundColor={colors.panel} textColor={colors.text} onSubmit={() => wizardNext()} keyBindings={[{ name: "return", action: "submit" }, { name: "return", shift: true, action: "newline" }, { name: "kpenter", action: "submit" }, { name: "kpenter", shift: true, action: "newline" }]} />
                  </box>
                </Show>
              </Show>
            }>
              <box flexDirection="column" height={6} flexShrink={0}>
                <ChromeText colors={colors} fg={colors.faint} bg={colors.panel} width="100%" truncate text={chromeJoin([`memories: ${wizardMemories().length}`, ...(wizardMemories().length > 0 ? [`${wizardMemoryCursor() + 1}/${wizardMemories().length}`] : [])])} />
                <Show when={wizardMemories().length === 0} fallback={
                  <For each={[0, 1, 2, 3]}>{(slot) => (
                    <text fg={colors.text} bg={colors.panel} width="100%" truncate>{(() => {
                      const memories = wizardMemories()
                      if (memories.length === 0) return ""
                      const offset = pickerWindow(wizardMemoryCursor(), memories.length, 4).start
                      const index = offset + slot
                      const text = memories[index]
                      if (text === undefined) return ""
                      return `${index === wizardMemoryCursor() ? "›" : " "} ${index + 1}. ${text}`
                    })()}</text>
                  )}</For>
                }>
                  <text fg={colors.muted} bg={colors.panel} width="100%" truncate>No memories yet. a adds one.</text>
                </Show>
              </box>
              <Show when={wizard()!.memoryEditor}>
                <box height={3} minHeight={3} flexShrink={0} border borderStyle="single" borderColor={colors.focus} backgroundColor={colors.panel} paddingLeft={1} paddingRight={1}>
                  <input ref={(value: any) => { wizardMemoryRef = value; wizardRef = value; applyEditorCaret(value); if (value) focusWhenReady(() => value) }} value={wizardMemoryInput()} onInput={(value: string) => setWizardMemoryInput(String(value ?? ""))} placeholder={wizardStep()?.placeholder ?? ""} width="100%" backgroundColor={colors.panel} textColor={colors.text} onSubmit={() => wizardMemorySubmit()} />
                </box>
              </Show>
            </Show>
            <Show when={wizard()?.error}><text fg={colors.bad} bg={colors.panel} width="100%" wrapMode="word">{`! ${wizard()!.error}`}</text></Show>
          </box>
          <box width="100%" flexDirection="row" justifyContent="center" flexShrink={0}>
            <text fg={colors.faint} bg={colors.panel} truncate>{wizardHint()}</text>
          </box>
        </box>
      </Show>
      <Show when={leaderMode() && leaderPopup()}>
        <box
          id={MOUSE_PANE_IDS.dialog}
          position="absolute"
          bottom={4}
          right={4}
          width={68}
          height={whichKeyLines(leaderEntries()).length + 2}
          zIndex={90}
          border
          borderStyle="rounded"
          borderColor={colors.leader}
          backgroundColor={colors.panel}
          paddingLeft={1}
          paddingRight={1}
          flexDirection="column"
          opacity={overlayOpacity()}
        >
          <ChromeText colors={colors} fg={colors.leader} bg={colors.panel} width="100%" truncate text={chromeJoin(["LEADER", "Space"])} />
          <For each={whichKeyLines(leaderEntries())}>{(line) => <text fg={colors.text} bg={colors.panel} width="100%" truncate>{line}</text>}</For>
        </box>
      </Show>
      <box id={MOUSE_PANE_IDS.statusline} height={3} flexDirection="column" border={["top"]} borderColor={colors.border} backgroundColor={colors.bg} opacity={overlayOpen() ? 0.35 : 1}>
        <StatuslineRow colors={colors} segments={statusSegments()} width={statuslineWidth()} bg={colors.bg} />
        <StatuslineMessage colors={colors} prompt={statusRow2Prompt()} parts={statusRow2()} width={statuslineWidth()} bg={colors.bg} />
      </box>
    </box>
  )
}
