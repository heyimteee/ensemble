import { EnsembleV2Service } from "./service.ts"

type Entry = {
  service: EnsembleV2Service
  stop: () => Promise<void>
  refs: number
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
  private readonly create: CreateService

  constructor(create: CreateService = createService, version = SHARED_SERVICE_VERSION) {
    this.create = create
    this.version = version
  }

  async acquire(ctx: any): Promise<{ service: EnsembleV2Service; release: () => Promise<void> }> {
    if (!this.pending) {
      this.pending = this.start(ctx).catch((error) => {
        this.pending = undefined
        throw error
      })
    }
    const entry = await this.pending
    entry.refs += 1
    let released = false
    return {
      service: entry.service,
      release: async () => {
        if (released) return
        released = true
        entry.refs -= 1
        if (entry.refs > 0) return
        this.pending = undefined
        await entry.stop()
      },
    }
  }

  private async start(ctx: any): Promise<Entry> {
    const { service, stop } = await this.create(ctx)
    return { service, stop, refs: 0 }
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
