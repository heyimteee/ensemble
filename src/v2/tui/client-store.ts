import { batch, createSignal } from "solid-js"
import { createStore, reconcile, unwrap } from "solid-js/store"
import { createInitialState } from "../defaults.ts"
import type { Id, ModelOption, SkillOption, Snapshot, SnapshotState, Subtask } from "../types.ts"

/**
 * Durable client updates. A snapshot is the only full replacement; every
 * other update touches one entity path so Solid can invalidate the readers of
 * that entity without rebuilding unrelated agents, messages, or work.
 */
export type ClientStateUpdate =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "subtask.upsert"; task: Subtask }
  | { type: "subtask.remove"; id: Id }

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
  }
}

export type ClientStore = {
  /** Compatibility accessor for selectors that still read the whole state. */
  state: () => SnapshotState | null
  models: () => ModelOption[]
  skills: () => SkillOption[]
  directory: () => string
  configError: () => string | undefined
  modelsError: () => string | undefined
  catalogRevision: () => number | undefined
  protocol: () => number | undefined
  epoch: () => number | undefined
  applySnapshot: (snapshot: Snapshot) => void
  /** Update catalog/config metadata without touching entity state. */
  applyMetadata: (snapshot: Snapshot) => void
  applySubtask: (task: Subtask) => void
  removeSubtask: (id: Id) => void
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
    setModelsError(snapshot.modelsError)
    setCatalogRevision(snapshot.catalogRevision)
    setProtocol(snapshot.protocol)
    setEpoch(snapshot.epoch)
  }

  return {
    state: () => (data.loaded ? data.state : null),
    models,
    skills,
    directory,
    configError,
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
    reset: () => {
      batch(() => {
        setData("loaded", false)
        setData("state", reconcile(createInitialState()))
        setModels([])
        setSkills([])
        setDirectory("")
        setConfigError(undefined)
        setModelsError(undefined)
        setCatalogRevision(undefined)
        setProtocol(undefined)
        setEpoch(undefined)
      })
    },
  }
}
