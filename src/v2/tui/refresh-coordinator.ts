import type { ChangesSince, PatchBatch, Revision, Snapshot, WorkEntityChange } from "../types.ts"

export type { Revision }

/** Protocol v2 adds the versioned full-entity patch feed (ticket #138). */
export const ENSEMBLE_PATCH_PROTOCOL = 2

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
  | { action: "apply"; version: number; changes: WorkEntityChange[] }
  | { action: "ignore" }
  | { action: "resync"; reason: "unloaded" | "epoch" | "reset" | "gap" | "malformed" | "other" }

const resync = (reason: "unloaded" | "epoch" | "reset" | "gap" | "malformed" | "other"): PatchDecision => ({ action: "resync", reason })

function validChange(value: any): value is WorkEntityChange {
  if (!value || typeof value !== "object" || value.entity !== "subtask") return false
  if (value.op === "upsert") return Boolean(value.task) && typeof value.task === "object" && typeof value.task.id === "string" && value.task.id.length > 0
  if (value.op === "remove") return typeof value.id === "string" && value.id.length > 0
  return false
}

/**
 * Validate one batched patch against the client cursor. The batch is applied
 * atomically only when every entry is contiguous and well formed; duplicate
 * and reordered deliveries are ignored, while a gap, epoch change, feed reset,
 * or malformed entry asks for a scoped/full resync. No partial batch applies.
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
  // A duplicate or reordered event is harmless; the entity state it carries is
  // already represented by a later applied version.
  if (version <= previous.version) return { action: "ignore" }
  if (from > previous.version + 1) return resync("gap")

  let expected = from + 1
  const changes: WorkEntityChange[] = []
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || typeof entry.version !== "number" || !Array.isArray(entry.changes)) {
      return resync("malformed")
    }
    if (entry.other !== undefined && typeof entry.other !== "boolean") return resync("malformed")
    if (entry.version !== expected) return resync("malformed")
    expected++
    // A version that touched non-Work entities cannot be represented by this
    // store-only feed; the snapshot path must refresh those views.
    if (entry.version > previous.version && entry.other === true) return resync("other")
    for (const change of entry.changes) {
      if (!validChange(change)) return resync("malformed")
      if (entry.version > previous.version) changes.push(change)
    }
  }
  if (expected - 1 !== version) return resync("malformed")
  return { action: "apply", version, changes }
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
  if (result.version === previous.version) return { action: "ignore" }
  return decidePatchApply(previous, {
    epoch: result.epoch,
    from: previous.version,
    version: result.version,
    entries: result.entries,
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
