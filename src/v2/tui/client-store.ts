import { batch, createSignal } from "solid-js"
import { createStore, reconcile, unwrap } from "solid-js/store"
import { createInitialState } from "../defaults.ts"
import type { EntityChange, FeedMeta, Id, MessageStream, ModelOption, SkillOption, Snapshot, SnapshotState, Subtask } from "../types.ts"

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
  }
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
  applySnapshot: (snapshot: Snapshot) => void
  /** Update catalog/config metadata without touching entity state. */
  applyMetadata: (snapshot: Snapshot) => void
  applySubtask: (task: Subtask) => void
  removeSubtask: (id: Id) => void
  /** Apply one validated, atomic batch of full-entity changes. */
  applyChanges: (changes: EntityChange[], version?: number, meta?: FeedMeta) => void
  /** Apply one validated, atomic batch of full-entity work changes. */
  applyWorkChanges: (changes: EntityChange[], version?: number) => void
  /** Apply ephemeral live text to one visible streaming row. */
  applyStream: (update: MessageStream) => void
  /** Scoped Work resync: replace subtasks and metadata, keep other entities. */
  applyWorkSnapshot: (snapshot: Snapshot) => void
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

  const apply = (update: ClientStateUpdate) => {
    setData("state", reconcile(reduceClientState(unwrap(data.state), update)))
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

  const applyChanges = (changes: EntityChange[], version?: number, meta?: FeedMeta) => {
    batch(() => {
      const updatedAt = version === undefined || version === data.state.version ? undefined : Date.now()
      apply({ type: "entity.changes", changes, version, updatedAt })
      if (meta) applyFeedMeta(meta)
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
    applySnapshot: (snapshot) => {
      batch(() => {
        apply({ type: "snapshot", snapshot })
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
      })
    },
  }
}
