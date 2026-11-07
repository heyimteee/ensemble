import type { Revision, Snapshot } from "../types.ts"

export type { Revision }

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
