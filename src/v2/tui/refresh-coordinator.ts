import type { ChangesSince, EntityChange, FeedMeta, MessageStream, PatchBatch, Revision, Snapshot } from "../types.ts"

export type { Revision }

/** Protocol v3 adds shell entities and catalog/config metadata (ticket #140). */
export const ENSEMBLE_PATCH_PROTOCOL = 3

/**
 * The metadata that decides whether a snapshot may touch client state.
 * Entity data is versioned by the store coordination version; catalog and
 * config changes can happen without a version bump, so they carry their own
 * revision.
 */
export type SnapshotMeta = {
  version: number
  catalogRevision?: number
  configRevision?: number
  protocol?: number
  epoch?: number
  configError?: string
  modelsError?: string
  directory?: string
}

export type SnapshotApply = "replace" | "metadata" | "skip"

export function snapshotMeta(snapshot: Snapshot): SnapshotMeta {
  return {
    version: snapshot.state.version,
    catalogRevision: snapshot.catalogRevision,
    configRevision: snapshot.configRevision,
    protocol: snapshot.protocol,
    epoch: snapshot.epoch,
    configError: snapshot.configError,
    modelsError: snapshot.modelsError,
    directory: snapshot.directory,
  }
}

function sameMetadata(previous: SnapshotMeta, next: SnapshotMeta): boolean {
  return previous.catalogRevision === next.catalogRevision
    && previous.configRevision === next.configRevision
    && previous.protocol === next.protocol
    && previous.epoch === next.epoch
    && previous.configError === next.configError
    && previous.modelsError === next.modelsError
    && previous.directory === next.directory
}

/**
 * Apply snapshots by version, never by which request completed last. An older
 * response is dropped; an equal version never replaces entity state, but may
 * refresh catalog/config metadata when its revision changed.
 */
export function decideSnapshotApply(previous: SnapshotMeta | undefined, next: SnapshotMeta): SnapshotApply {
  if (!previous) return "replace"
  if (previous.epoch !== undefined && next.epoch !== undefined && previous.epoch !== next.epoch) return "replace"
  if (next.version > previous.version) return "replace"
  if (next.version < previous.version) return "skip"
  return sameMetadata(previous, next) ? "skip" : "metadata"
}

/** True when the snapshot advertised the patch-feed contract. */
export function supportsPatchFeed(previous: SnapshotMeta | undefined): boolean {
  return previous !== undefined
    && typeof previous.protocol === "number"
    && previous.protocol >= ENSEMBLE_PATCH_PROTOCOL
    && typeof previous.epoch === "number"
}

export type PatchDecision =
  | { action: "apply"; version: number; changes: EntityChange[]; meta?: FeedMeta }
  | { action: "ignore" }
  | { action: "resync"; reason: "unloaded" | "epoch" | "reset" | "gap" | "malformed" | "other" }

const resync = (reason: "unloaded" | "epoch" | "reset" | "gap" | "malformed" | "other"): PatchDecision => ({ action: "resync", reason })

const isRecord = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === "object" && !Array.isArray(value)
const validID = (value: unknown): value is string => typeof value === "string" && value.length > 0

function validChange(value: any): value is EntityChange {
  if (!isRecord(value)) return false
  const upsert = value.op === "upsert"
  const remove = value.op === "remove"
  switch (value.entity) {
    case "subtask":
      return upsert ? isRecord(value.task) && validID(value.task.id) : remove && validID(value.id)
    case "message":
      return upsert
        ? isRecord(value.message) && validID(value.message.id) && validID(value.message.workspaceID)
        : remove && validID(value.workspaceID) && validID(value.id)
    case "agent":
      return upsert ? isRecord(value.agent) && validID(value.agent.id) : remove && validID(value.id)
    case "workspace":
      return upsert ? isRecord(value.workspace) && validID(value.workspace.id) : remove && validID(value.id)
    case "approval":
      return upsert ? isRecord(value.approval) && validID(value.approval.id) : remove && validID(value.id)
    case "binding":
      return upsert
        ? isRecord(value.binding) && validID(value.binding.workspaceID) && validID(value.binding.agentID)
        : remove && validID(value.workspaceID) && validID(value.agentID)
    case "memory":
      return upsert ? isRecord(value.memory) && validID(value.memory.id) : remove && validID(value.id)
    case "initJob":
      return upsert ? isRecord(value.job) && validID(value.job.id) : remove && validID(value.id)
    case "settings":
      return upsert && isRecord(value.settings)
    case "ui":
      return upsert && isRecord(value.ui)
    default:
      return false
  }
}

/** Validate one ephemeral live-text event, which never advances the cursor. */
export function validMessageStream(value: unknown): value is MessageStream {
  if (!isRecord(value)) return false
  return typeof value.epoch === "number"
    && validID(value.workspaceID)
    && validID(value.id)
    && typeof value.text === "string"
    && typeof value.updatedAt === "number"
}

function validFeedMeta(value: any): value is FeedMeta {
  if (!isRecord(value)) return false
  if (value.catalogRevision !== undefined && typeof value.catalogRevision !== "number") return false
  if (value.configRevision !== undefined && typeof value.configRevision !== "number") return false
  if (value.models !== undefined && !Array.isArray(value.models)) return false
  if (value.skills !== undefined && !Array.isArray(value.skills)) return false
  if (value.modelsError !== undefined && typeof value.modelsError !== "string") return false
  if (value.configError !== undefined && typeof value.configError !== "string") return false
  if (value.directory !== undefined && typeof value.directory !== "string") return false
  return true
}

function metadataChanged(previous: SnapshotMeta, meta: FeedMeta): boolean {
  if (typeof meta.catalogRevision === "number" && (meta.catalogRevision !== previous.catalogRevision || meta.modelsError !== previous.modelsError)) return true
  // Config fields describe one directory; another view's metadata is not ours.
  if (meta.directory && previous.directory && meta.directory !== previous.directory) return false
  if (typeof meta.configRevision === "number" && (meta.configRevision !== previous.configRevision || meta.configError !== previous.configError)) return true
  return false
}

/**
 * Merge feed metadata into the client cursor so the heartbeat does not fetch a
 * snapshot for a catalog/config revision the feed already applied.
 */
export function mergeFeedMeta(previous: SnapshotMeta | undefined, meta: FeedMeta | undefined): SnapshotMeta | undefined {
  if (!previous || !meta) return previous
  const next = { ...previous }
  if (typeof meta.catalogRevision === "number") {
    next.catalogRevision = meta.catalogRevision
    next.modelsError = meta.modelsError
  }
  if (!meta.directory || !previous.directory || meta.directory === previous.directory) {
    if (typeof meta.configRevision === "number") next.configRevision = meta.configRevision
    if (typeof meta.configRevision === "number") next.configError = meta.configError
  }
  return next
}

/**
 * Validate one batched patch against the client cursor. The batch is applied
 * atomically only when every entry is contiguous and well formed; duplicate
 * and reordered deliveries are ignored, while a gap, epoch change, feed reset,
 * or malformed entry asks for a scoped/full resync. No partial batch applies.
 * Protocol-3 clients read `entities` when present and only resync on
 * `nonEntity`; `other` remains the protocol-2 snapshot marker.
 */
export function decidePatchApply(previous: SnapshotMeta | undefined, batch: PatchBatch): PatchDecision {
  if (!previous) return resync("unloaded")
  if (!batch || typeof batch !== "object") return resync("malformed")
  const { epoch, from, version, entries } = batch as any
  if (typeof epoch !== "number" || typeof from !== "number" || typeof version !== "number" || !Array.isArray(entries)) {
    return resync("malformed")
  }
  if (!supportsPatchFeed(previous)) return resync("unloaded")
  if (epoch !== previous.epoch) return resync("epoch")
  if (batch.reset === true) return resync("reset")
  if (!Number.isFinite(from) || !Number.isFinite(version) || version < from) return resync("malformed")
  const meta = (batch as any).meta
  if (meta !== undefined && !validFeedMeta(meta)) return resync("malformed")
  // A duplicate or reordered event is harmless; the entity state it carries is
  // already represented by a later applied version. A catalog/config revision
  // may still be newer than the applied cursor, so an equal-version batch can
  // apply metadata without replacing entity state.
  if (version < previous.version) return { action: "ignore" }
  if (version === previous.version) {
    // An overlapping redelivery is already represented; only an empty
    // equal-version batch may carry a metadata revision.
    if (entries.length > 0) return { action: "ignore" }
    if (from !== version) return resync("malformed")
    if (meta && metadataChanged(previous, meta)) return { action: "apply", version, changes: [], meta }
    return { action: "ignore" }
  }
  if (from > previous.version + 1) return resync("gap")

  let expected = from + 1
  const changes: EntityChange[] = []
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || typeof entry.version !== "number" || !Array.isArray(entry.changes)) {
      return resync("malformed")
    }
    if (entry.other !== undefined && typeof entry.other !== "boolean") return resync("malformed")
    if (entry.nonEntity !== undefined && typeof entry.nonEntity !== "boolean") return resync("malformed")
    if (entry.entities !== undefined && !Array.isArray(entry.entities)) return resync("malformed")
    if (entry.version !== expected) return resync("malformed")
    expected++
    // A version that changed state this feed cannot patch (DM retention) must
    // fall back to the snapshot path. `other` alone is only the protocol-2
    // marker for shell/message changes carried in `entities`.
    if (entry.version > previous.version && entry.nonEntity === true) return resync("other")
    const source = entry.entities ?? entry.changes
    for (const change of source) {
      if (!validChange(change)) return resync("malformed")
      if (entry.version > previous.version) changes.push(change)
    }
  }
  if (expected - 1 !== version) return resync("malformed")
  return { action: "apply", version, changes, ...(meta ? { meta } : {}) }
}

/** Validate the `changes.since` recovery response with the same batch rules. */
export function decideChangesSince(previous: SnapshotMeta | undefined, result: ChangesSince): PatchDecision {
  if (!previous) return resync("unloaded")
  if (!result || typeof result !== "object") return resync("malformed")
  if (!supportsPatchFeed(previous)) return resync("unloaded")
  if (typeof result.epoch !== "number" || typeof result.version !== "number" || !Array.isArray(result.entries)) {
    return resync("malformed")
  }
  if (result.epoch !== previous.epoch) return resync("epoch")
  if (result.reset) return resync("reset")
  if (result.version < previous.version) return resync("gap")
  const meta = (result as any).meta
  if (meta !== undefined && !validFeedMeta(meta)) return resync("malformed")
  if (result.version === previous.version) {
    if (meta && metadataChanged(previous, meta)) return { action: "apply", version: result.version, changes: [], meta }
    return { action: "ignore" }
  }
  return decidePatchApply(previous, {
    epoch: result.epoch,
    from: previous.version,
    version: result.version,
    entries: result.entries,
    ...(meta ? { meta } : {}),
  })
}

/** True when a heartbeat needs a full snapshot to catch up with the server. */
export function revisionChanged(previous: SnapshotMeta | undefined, next: Revision): boolean {
  if (!previous) return true
  return previous.version !== next.version
    || previous.catalogRevision !== next.catalogRevision
    || previous.configRevision !== next.configRevision
    || previous.protocol !== next.protocol
    || previous.epoch !== next.epoch
}

/** Idle heartbeats are cheap; live work checks twice as often. */
export function heartbeatDelay(active: boolean): number {
  return active ? 1_000 : 2_000
}

export type RefreshCoordinatorOptions = {
  run: () => void | Promise<void>
  onError?: (error: unknown) => void
}

export type RefreshCoordinator = {
  /** Request a refresh. Only one runs; the rest collapse into one dirty pass. */
  request: () => void
  /** Resolve once no requested pass remains (a paused request waits for resume). */
  whenIdle: () => Promise<void>
  /** Stop starting runs while the surface is hidden. An in-flight run finishes. */
  setPaused: (paused: boolean) => void
  inFlight: () => boolean
  pending: () => boolean
  paused: () => boolean
  dispose: () => void
}

/**
 * Single-flight refresh loop. It has no request sequence and never discards a
 * completed response: a request made during a run records one dirty pass that
 * starts after the current run settles. Pausing stops new runs but keeps the
 * dirty bit so activation performs one coalesced catch-up.
 */
export function createRefreshCoordinator(options: RefreshCoordinatorOptions): RefreshCoordinator {
  let running = false
  let dirty = false
  let paused = false
  let disposed = false
  let waiters: Array<() => void> = []

  const settle = () => {
    if (running) return
    if (dirty && !paused && !disposed) return
    const pendingWaiters = waiters
    waiters = []
    for (const resolve of pendingWaiters) resolve()
  }

  const start = () => {
    if (running || paused || disposed || !dirty) return
    dirty = false
    running = true
    let result: void | Promise<void>
    try {
      result = options.run()
    } catch (error) {
      options.onError?.(error)
      result = undefined
    }
    void Promise.resolve(result)
      .catch((error) => options.onError?.(error))
      .finally(() => {
        running = false
        if (disposed) {
          settle()
          return
        }
        if (dirty && !paused) start()
        else settle()
      })
  }

  const request = () => {
    if (disposed) return
    dirty = true
    start()
  }

  const whenIdle = (): Promise<void> => {
    if (!running && (!dirty || paused || disposed)) return Promise.resolve()
    return new Promise<void>((resolve) => { waiters.push(resolve) })
  }

  const setPaused = (value: boolean) => {
    if (paused === value) return
    paused = value
    if (paused) {
      if (!running) settle()
      return
    }
    if (dirty) start()
  }

  const dispose = () => {
    disposed = true
    dirty = false
    settle()
  }

  return {
    request,
    whenIdle,
    setPaused,
    inFlight: () => running,
    pending: () => dirty,
    paused: () => paused,
    dispose,
  }
}
