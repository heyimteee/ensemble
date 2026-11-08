import { EnsembleV2Service } from "./service.ts"

type Entry = {
  service: EnsembleV2Service
  stop: () => Promise<void>
  refs: number
  /** Set before the final release starts teardown; acquiring one is invalid. */
  stopping: boolean
}

type CreateService = (ctx: any) => Promise<{ service: EnsembleV2Service; stop: () => Promise<void> }>

/**
 * Contract version for the process-global registry. Bump it when the registry
 * shape or service lifecycle changes; a new registry then starts alongside the
 * old one until the old locations release their references.
 */
export const SHARED_SERVICE_VERSION = 1

const createService: CreateService = async (ctx) => {
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
  return { service, stop }
}

/**
 * Reference-counted service holder for one host realm. OpenCode sets plugins up
 * once per location; without this registry each location keeps its own
 * in-memory copy of the same durable state and the last writer wins.
 */
export class SharedEnsemble {
  readonly version: number
  private pending: Promise<Entry> | undefined
  /** In-flight final teardown: new locations wait before starting a replacement. */
  private stopping: Promise<void> | undefined
  private readonly create: CreateService

  constructor(create: CreateService = createService, version = SHARED_SERVICE_VERSION) {
    this.create = create
    this.version = version
  }

  async acquire(ctx: any): Promise<{ service: EnsembleV2Service; release: () => Promise<void> }> {
    for (;;) {
      // A new location must not overlap the old service's teardown. Every
      // waiter wakes together and coalesces onto the same post-stop creation.
      while (this.stopping) await this.stopping
      if (!this.pending) {
        const created = this.start(ctx)
        this.pending = created
        // Clear the slot only when this attempt still owns it; a replacement
        // may already have been installed by the time rejection is observed.
        created.catch(() => {
          if (this.pending === created) this.pending = undefined
        })
      }
      const pending = this.pending
      const entry = await pending
      // The last release can clear `pending` and start teardown while this
      // acquire was already awaiting the resolved entry. Re-check after the
      // await so an acquire never joins a stopping service.
      if (this.pending !== pending || entry.stopping) continue
      entry.refs += 1
      let released = false
      return {
        service: entry.service,
        release: async () => {
          if (released) return
          released = true
          entry.refs -= 1
          if (entry.refs > 0) return
          entry.stopping = true
          this.pending = undefined
          const stopping = Promise.resolve().then(() => entry.stop())
          this.stopping = stopping
          try {
            await stopping
          } finally {
            if (this.stopping === stopping) this.stopping = undefined
          }
        },
      }
    }
  }

  private async start(ctx: any): Promise<Entry> {
    const { service, stop } = await this.create(ctx)
    return { service, stop, refs: 0, stopping: false }
  }
}

/**
 * Process-global registry key. OpenCode re-evaluates the plugin module for every
 * location, so module-scoped state resets; `globalThis` survives both loads.
 */
const REGISTRY_KEY = Symbol.for("ensemble.v2.shared-service")

function isRegistry(value: unknown): value is SharedEnsemble {
  // Structural on purpose: never `instanceof`, because class identity changes
  // when the plugin module is loaded again for another location.
  return typeof value === "object" && value !== null && typeof (value as SharedEnsemble).acquire === "function"
}

/** The one registry for this host realm. */
export function sharedEnsemble(): SharedEnsemble {
  const scope = globalThis as unknown as Record<symbol, unknown>
  const existing = scope[REGISTRY_KEY]
  if (isRegistry(existing) && existing.version === SHARED_SERVICE_VERSION) return existing
  const registry = new SharedEnsemble()
  scope[REGISTRY_KEY] = registry
  return registry
}

/** Test-only: forget the process-global registry so the next call starts fresh. */
export function resetSharedEnsembleForTests(): void {
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY]
}
