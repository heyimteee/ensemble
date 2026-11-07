import { batch, createSignal } from "solid-js"
import { createStore, reconcile, unwrap } from "solid-js/store"
import { createInitialState } from "../defaults.ts"
import { WORK_GROUP_HOLD_MS } from "../work-groups.ts"
import { CLIENT_MESSAGE_LIMIT, CLIENT_TASK_GRACE_MS, projectVisibleWork, trimMessages } from "../scoped-read.ts"
import type { EntityChange, FeedMeta, Id, Message, MessageStream, ModelOption, SkillOption, Snapshot, SnapshotState, Subtask, TranscriptWindow, WorkspaceCounts } from "../types.ts"

/**
 * Durable client updates. A snapshot is the only full replacement; every
 * other update touches one entity path so Solid can invalidate the readers of
 * that entity without rebuilding unrelated agents, messages, or work.
 */
export type ClientStateUpdate =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "subtask.upsert"; task: Subtask }
  | { type: "subtask.remove"; id: Id }
  | { type: "message.stream"; workspaceID: Id; id: Id; text: string; updatedAt: number }
  | { type: "entity.changes"; changes: EntityChange[]; version?: number; updatedAt?: number }
  | { type: "work.changes"; changes: EntityChange[]; version?: number; updatedAt?: number }
  | { type: "work.snapshot"; subtasks: Record<Id, Subtask>; version: number; updatedAt?: number }
  | { type: "shell.snapshot"; state: SnapshotState }
  | { type: "transcript.window"; workspaceID: Id; messages: Message[]; mode: "replace" | "older" }

/** Per-workspace loaded transcript range. */
export type ClientTranscriptWindow = Omit<TranscriptWindow, "messages" | "workspaceID">


const bindingKey = (workspaceID: Id, agentID: Id) => `${workspaceID}:${agentID}`

/**
 * Apply full-entity changes to one branch at a time. Unchanged branches keep
 * their identity so a Solid `reconcile` writes only the updated entity path.
 */
function reduceEntityChanges(state: SnapshotState, changes: EntityChange[]): SnapshotState {
  let next = state
  let copied = false
  const copy = () => {
    if (!copied) {
      next = { ...state }
      copied = true
    }
    return next
  }
  for (const change of changes) {
    switch (change.entity) {
      case "subtask": {
        if (change.op === "upsert") {
          if (next.subtasks[change.task.id] === change.task) break
          copy().subtasks = { ...next.subtasks, [change.task.id]: change.task }
        } else {
          if (!(change.id in next.subtasks)) break
          const subtasks = { ...next.subtasks }
          delete subtasks[change.id]
          copy().subtasks = subtasks
        }
        break
      }
      case "message": {
        const workspaceID = change.op === "upsert" ? change.message.workspaceID : change.workspaceID
        const messageID = change.op === "upsert" ? change.message.id : change.id
        const list = next.messages[workspaceID] ?? []
        const index = list.findIndex((message) => message.id === messageID)
        if (change.op === "upsert") {
          if (index >= 0 && list[index] === change.message) break
          const messages = index >= 0 ? list.slice() : [...list, change.message]
          if (index >= 0) messages[index] = change.message
          messages.sort((a, b) => a.seq - b.seq)
          copy().messages = { ...next.messages, [workspaceID]: messages }
        } else {
          if (index < 0) break
          const messages = list.filter((message) => message.id !== messageID)
          const map = { ...next.messages }
          if (messages.length === 0) delete map[workspaceID]
          else map[workspaceID] = messages
          copy().messages = map
        }
        break
      }
      case "agent": {
        if (change.op === "upsert") {
          if (next.agents[change.agent.id] === change.agent) break
          copy().agents = { ...next.agents, [change.agent.id]: change.agent }
        } else {
          if (!(change.id in next.agents)) break
          const agents = { ...next.agents }
          delete agents[change.id]
          copy().agents = agents
        }
        break
      }
      case "workspace": {
        if (change.op === "upsert") {
          if (next.workspaces[change.workspace.id] === change.workspace) break
          copy().workspaces = { ...next.workspaces, [change.workspace.id]: change.workspace }
        } else {
          if (!(change.id in next.workspaces)) break
          const workspaces = { ...next.workspaces }
          delete workspaces[change.id]
          copy().workspaces = workspaces
        }
        break
      }
      case "approval": {
        if (change.op === "upsert") {
          if (next.approvals[change.approval.id] === change.approval) break
          copy().approvals = { ...next.approvals, [change.approval.id]: change.approval }
        } else {
          if (!(change.id in next.approvals)) break
          const approvals = { ...next.approvals }
          delete approvals[change.id]
          copy().approvals = approvals
        }
        break
      }
      case "binding": {
        const key = change.op === "upsert" ? bindingKey(change.binding.workspaceID, change.binding.agentID) : bindingKey(change.workspaceID, change.agentID)
        if (change.op === "upsert") {
          if (next.bindings[key] === change.binding) break
          copy().bindings = { ...next.bindings, [key]: change.binding }
        } else {
          if (!(key in next.bindings)) break
          const bindings = { ...next.bindings }
          delete bindings[key]
          copy().bindings = bindings
        }
        break
      }
      case "memory": {
        if (change.op === "upsert") {
          if (next.memories[change.memory.id] === change.memory) break
          copy().memories = { ...next.memories, [change.memory.id]: change.memory }
        } else {
          if (!(change.id in next.memories)) break
          const memories = { ...next.memories }
          delete memories[change.id]
          copy().memories = memories
        }
        break
      }
      case "initJob": {
        if (change.op === "upsert") {
          if (next.initJobs[change.job.id] === change.job) break
          copy().initJobs = { ...next.initJobs, [change.job.id]: change.job }
        } else {
          if (!(change.id in next.initJobs)) break
          const initJobs = { ...next.initJobs }
          delete initJobs[change.id]
          copy().initJobs = initJobs
        }
        break
      }
      case "settings": {
        if (next.settings === change.settings) break
        copy().settings = change.settings
        break
      }
      case "ui": {
        if (next.ui === change.ui) break
        copy().ui = change.ui
        break
      }
    }
  }
  return next
}

/**
 * Pure store primitive: unchanged branches keep their identity so a Solid
 * `reconcile` writes only the updated entity path. A full snapshot is a
 * replacement, not a merge, so removed entities disappear.
 */
export function reduceClientState(state: SnapshotState, update: ClientStateUpdate): SnapshotState {
  switch (update.type) {
    case "snapshot":
      return update.snapshot.state
    case "subtask.upsert": {
      if (state.subtasks[update.task.id] === update.task) return state
      return { ...state, subtasks: { ...state.subtasks, [update.task.id]: update.task } }
    }
    case "subtask.remove": {
      if (!(update.id in state.subtasks)) return state
      const subtasks = { ...state.subtasks }
      delete subtasks[update.id]
      return { ...state, subtasks }
    }
    case "message.stream": {
      const list = state.messages[update.workspaceID]
      if (!list) return state
      const index = list.findIndex((message) => message.id === update.id)
      if (index < 0) return state
      const message = list[index]!
      // Final durable state always wins: a late event cannot overwrite a row
      // that already settled, and an older event cannot rewind newer text.
      if (!message.streaming) return state
      if (update.updatedAt < (message.updatedAt ?? 0)) return state
      if (update.text === message.text) return state
      if (update.updatedAt === (message.updatedAt ?? 0) && update.text.length < message.text.length) return state
      const messages = list.slice()
      messages[index] = { ...message, text: update.text, updatedAt: update.updatedAt }
      return { ...state, messages: { ...state.messages, [update.workspaceID]: messages } }
    }
    case "entity.changes":
    case "work.changes": {
      const next = reduceEntityChanges(state, update.changes)
      const version = update.version ?? state.version
      const updatedAt = update.updatedAt ?? state.updatedAt
      if (next === state && version === state.version && updatedAt === state.updatedAt) return state
      return { ...next, version, updatedAt }
    }
    case "work.snapshot": {
      return {
        ...state,
        subtasks: update.subtasks,
        version: update.version,
        updatedAt: update.updatedAt ?? state.updatedAt,
      }
    }
    case "shell.snapshot": {
      const shell = update.state
      return {
        ...state,
        agents: shell.agents,
        workspaces: shell.workspaces,
        initJobs: shell.initJobs,
        bindings: shell.bindings,
        memories: shell.memories,
        approvals: shell.approvals,
        dmQueue: shell.dmQueue,
        dmTranscripts: shell.dmTranscripts,
        settings: shell.settings,
        ui: shell.ui,
        runs: shell.runs,
        version: shell.version,
        updatedAt: shell.updatedAt,
      }
    }
    case "transcript.window": {
      const existing = state.messages[update.workspaceID] ?? []
      const merged = update.mode === "replace"
        ? [...update.messages]
        : [...existing, ...update.messages]
      const byID = new Map<Id, Message>()
      for (const message of merged) byID.set(message.id, message)
      const ordered = [...byID.values()].sort((a, b) => a.seq - b.seq)
      const bounded = trimMessages(ordered, CLIENT_MESSAGE_LIMIT, update.mode === "older" ? "oldest" : "newest")
      return { ...state, messages: { ...state.messages, [update.workspaceID]: [...bounded] } }
    }
  }
}

/**
 * Ticket #141 bounded client cache. Keep at most one transcript window per
 * workspace and only visible Work rows (plus a short grace so a sibling
 * transition never needs a resync). Identity is preserved when nothing is
 * trimmed so Solid invalidation stays path-scoped.
 */
export function boundClientState(state: SnapshotState, now: number = Date.now(), keep: "newest" | "oldest" = "newest"): SnapshotState {
  let next = state
  let messages: SnapshotState["messages"] | undefined
  for (const [workspaceID, list] of Object.entries(state.messages)) {
    const bounded = trimMessages(list, CLIENT_MESSAGE_LIMIT, keep)
    if (bounded === list) continue
    messages ??= { ...state.messages }
    messages[workspaceID] = bounded
  }
  if (messages) next = { ...next, messages }
  const visible = projectVisibleWork(state, now, WORK_GROUP_HOLD_MS + CLIENT_TASK_GRACE_MS)
  const currentKeys = Object.keys(state.subtasks)
  const visibleKeys = Object.keys(visible)
  if (visibleKeys.length !== currentKeys.length || visibleKeys.some((id) => !(id in state.subtasks))) {
    next = { ...next, subtasks: visible }
  }
  return next
}

export type ClientStore = {
  /** Compatibility accessor for selectors that still read the whole state. */
  state: () => SnapshotState | null
  models: () => ModelOption[]
  skills: () => SkillOption[]
  directory: () => string
  configError: () => string | undefined
  configRevision: () => number | undefined
  modelsError: () => string | undefined
  catalogRevision: () => number | undefined
  protocol: () => number | undefined
  epoch: () => number | undefined
  /** Ticket #141 server-derived rail counts; undefined on legacy servers. */
  counts: () => Record<Id, WorkspaceCounts> | undefined
  /** Loaded transcript range for one workspace. */
  windowFor: (workspaceID: Id) => ClientTranscriptWindow | undefined
  applySnapshot: (snapshot: Snapshot) => void
  /** Update catalog/config metadata without touching entity state. */
  applyMetadata: (snapshot: Snapshot) => void
  applySubtask: (task: Subtask) => void
  removeSubtask: (id: Id) => void
  /** Apply one validated, atomic batch of full-entity changes. */
  applyChanges: (changes: EntityChange[], version?: number, meta?: FeedMeta, counts?: Record<Id, WorkspaceCounts>) => void
  /** Apply one validated, atomic batch of full-entity work changes. */
  applyWorkChanges: (changes: EntityChange[], version?: number) => void
  /** Apply ephemeral live text to one visible streaming row. */
  applyStream: (update: MessageStream) => void
  /** Scoped Work resync: replace subtasks and metadata, keep other entities. */
  applyWorkSnapshot: (snapshot: Snapshot) => void
  /** Scoped Work projection resync (ticket #141). */
  applyWorkProjection: (tasks: Record<Id, Subtask>, version: number) => void
  /** Scoped shell resync: replace shell entities, keep Work and transcript. */
  applyShellSnapshot: (state: SnapshotState) => void
  /** Merge one durable transcript page; "older" keeps the paged range. */
  applyTranscriptWindow: (workspaceID: Id, window: TranscriptWindow, mode?: "replace" | "older") => void
  /** Apply server-derived counts from a patch, changes.since, or heartbeat. */
  applyCounts: (counts: Record<Id, WorkspaceCounts> | undefined) => void
  /** Revision alias kept explicit at the app seam. */
  applyRevisionCounts: (counts: Record<Id, WorkspaceCounts> | undefined) => void
  reset: () => void
}

/**
 * The TUI's disposable, fine-grained state cache. The initial snapshot loads
 * entity data once; later entity updates write their own path. Catalog,
 * model, skill, protocol, epoch, and config metadata live in sibling signals
 * so they update without replacing entity state (and vice versa).
 */
export function createClientStore(): ClientStore {
  const [data, setData] = createStore<{ loaded: boolean; state: SnapshotState }>({
    loaded: false,
    state: createInitialState(),
  })
  const [models, setModels] = createSignal<ModelOption[]>([])
  const [skills, setSkills] = createSignal<SkillOption[]>([])
  const [directory, setDirectory] = createSignal("")
  const [configError, setConfigError] = createSignal<string | undefined>(undefined)
  const [configRevision, setConfigRevision] = createSignal<number | undefined>(undefined)
  const [modelsError, setModelsError] = createSignal<string | undefined>(undefined)
  const [catalogRevision, setCatalogRevision] = createSignal<number | undefined>(undefined)
  const [protocol, setProtocol] = createSignal<number | undefined>(undefined)
  const [epoch, setEpoch] = createSignal<number | undefined>(undefined)
  const [counts, setCounts] = createSignal<Record<Id, WorkspaceCounts> | undefined>(undefined)
  const [windows, setWindows] = createSignal<Record<Id, ClientTranscriptWindow>>({})

  const windowFrom = (messages: readonly Message[], hasMoreOlder: boolean): ClientTranscriptWindow => ({
    ...(messages.length > 0 ? { oldestSeq: messages[0]!.seq, newestSeq: messages[messages.length - 1]!.seq } : {}),
    hasMoreOlder,
    limit: CLIENT_MESSAGE_LIMIT,
  })

  const apply = (update: ClientStateUpdate, keep: "newest" | "oldest" = "newest") => {
    const next = reduceClientState(unwrap(data.state), update)
    setData("state", reconcile(boundClientState(next, Date.now(), keep)))
    return next
  }

  /** Refresh window metadata for workspaces whose message rows changed. */
  const syncWindows = (workspaceIDs: readonly Id[]) => {
    if (workspaceIDs.length === 0) return
    setWindows((current) => {
      const next = { ...current }
      for (const workspaceID of workspaceIDs) {
        const messages = data.state.messages[workspaceID] ?? []
        const previous = current[workspaceID]
        const trimmed = messages.length >= CLIENT_MESSAGE_LIMIT
          && (previous === undefined || previous.hasMoreOlder || messages[0]!.seq > (previous.oldestSeq ?? messages[0]!.seq))
        next[workspaceID] = windowFrom(messages, previous?.hasMoreOlder === true || trimmed)
      }
      return next
    })
  }

  const applyMetadata = (snapshot: Snapshot) => {
    setModels(snapshot.models)
    setSkills(snapshot.skills)
    setDirectory(snapshot.directory)
    setConfigError(snapshot.configError)
    setConfigRevision(snapshot.configRevision)
    setModelsError(snapshot.modelsError)
    setCatalogRevision(snapshot.catalogRevision)
    setProtocol(snapshot.protocol)
    setEpoch(snapshot.epoch)
  }

  /**
   * Catalog/config metadata is not part of the coordination version. Apply it
   * without replacing any entity branch, and only take config fields that
   * describe this client's directory.
   */
  const applyFeedMeta = (meta: FeedMeta) => {
    if (typeof meta.catalogRevision === "number") {
      if (meta.catalogRevision !== catalogRevision()) {
        setCatalogRevision(meta.catalogRevision)
        if (Array.isArray(meta.models)) setModels(meta.models)
        if (Array.isArray(meta.skills)) setSkills(meta.skills)
      }
      // Feed metadata is a complete catalog revision, so a missing error
      // clears a previous one.
      setModelsError(meta.modelsError)
    }
    const current = directory()
    if (!meta.directory || !current || meta.directory === current) {
      if (typeof meta.configRevision === "number") setConfigRevision(meta.configRevision)
      // The metadata carries this view's complete config error state.
      if (typeof meta.configRevision === "number") setConfigError(meta.configError)
    }
  }

  const applyChanges = (changes: EntityChange[], version?: number, meta?: FeedMeta, nextCounts?: Record<Id, WorkspaceCounts>) => {
    batch(() => {
      const updatedAt = version === undefined || version === data.state.version ? undefined : Date.now()
      apply({ type: "entity.changes", changes, version, updatedAt })
      if (meta) applyFeedMeta(meta)
      if (nextCounts) setCounts(nextCounts)
      const touched = new Set<Id>()
      for (const change of changes) {
        if (change.entity !== "message") continue
        touched.add(change.op === "upsert" ? change.message.workspaceID : change.workspaceID)
      }
      syncWindows([...touched])
    })
  }

  return {
    state: () => (data.loaded ? data.state : null),
    models,
    skills,
    directory,
    configError,
    configRevision,
    modelsError,
    catalogRevision,
    protocol,
    epoch,
    counts,
    windowFor: (workspaceID) => windows()[workspaceID],
    applySnapshot: (snapshot) => {
      batch(() => {
        const bounded = boundClientState(snapshot.state, Date.now())
        const scopedWorkspace = snapshot.window ? Object.keys(snapshot.state.messages)[0] : undefined
        const nextWindows: Record<Id, ClientTranscriptWindow> = {}
        for (const [workspaceID, list] of Object.entries(snapshot.state.messages)) {
          const loaded = bounded.messages[workspaceID] ?? []
          nextWindows[workspaceID] = scopedWorkspace === workspaceID && snapshot.window
            ? { ...snapshot.window }
            : windowFrom(loaded, list.length > loaded.length)
        }
        apply({ type: "snapshot", snapshot: { ...snapshot, state: bounded } })
        setWindows(nextWindows)
        setCounts(snapshot.counts)
        setData("loaded", true)
        applyMetadata(snapshot)
      })
    },
    applyMetadata,
    applySubtask: (task) => apply({ type: "subtask.upsert", task }),
    removeSubtask: (id) => apply({ type: "subtask.remove", id }),
    applyChanges,
    applyWorkChanges: (changes, version) => applyChanges(changes, version),
    applyStream: (update) => {
      if (epoch() !== undefined && update.epoch !== epoch()) return
      apply({ type: "message.stream", workspaceID: update.workspaceID, id: update.id, text: update.text, updatedAt: update.updatedAt })
    },
    applyWorkSnapshot: (snapshot) => {
      batch(() => {
        apply({
          type: "work.snapshot",
          subtasks: snapshot.state.subtasks,
          version: snapshot.state.version,
          updatedAt: snapshot.state.updatedAt,
        })
        applyMetadata(snapshot)
      })
    },
    applyWorkProjection: (tasks, version) => {
      apply({ type: "work.snapshot", subtasks: tasks, version })
    },
    applyShellSnapshot: (state) => {
      apply({ type: "shell.snapshot", state })
    },
    applyTranscriptWindow: (workspaceID, window, mode = "replace") => {
      batch(() => {
        apply({ type: "transcript.window", workspaceID, messages: window.messages, mode }, mode === "older" ? "oldest" : "newest")
        const loaded = data.state.messages[workspaceID] ?? []
        setWindows((current) => ({
          ...current,
          [workspaceID]: {
            ...(loaded.length > 0 ? { oldestSeq: loaded[0]!.seq, newestSeq: loaded[loaded.length - 1]!.seq } : {}),
            hasMoreOlder: window.hasMoreOlder,
            limit: window.limit,
          },
        }))
      })
    },
    applyCounts: (nextCounts) => setCounts(nextCounts),
    applyRevisionCounts: (nextCounts) => setCounts(nextCounts),
    reset: () => {
      batch(() => {
        setData("loaded", false)
        setData("state", reconcile(createInitialState()))
        setModels([])
        setSkills([])
        setDirectory("")
        setConfigError(undefined)
        setConfigRevision(undefined)
        setModelsError(undefined)
        setCatalogRevision(undefined)
        setProtocol(undefined)
        setEpoch(undefined)
        setCounts(undefined)
        setWindows({})
      })
    },
  }
}
