import { EnsembleV2Rpc } from "./rpc.ts"
import type { EnsembleV2Service } from "./service.ts"

type HostRegistration = { dispose?: () => Promise<void> | void }

/**
 * One host location's attachment to the shared Ensemble realm (ticket #153).
 *
 * OpenCode re-evaluates the plugin for every location and gives each setup its
 * own plugin context. The realm service and store are shared, but every
 * location-scoped host surface belongs to this attachment: RPC registration,
 * tool transform, retry hook, and the reference that keeps the service alive.
 * Disposing the attachment removes only these registrations and releases this
 * location's reference.
 */
export class LocationAttachment {
  readonly service: EnsembleV2Service
  readonly ctx: any
  readonly directory: string | undefined
  private rpcRegistration: HostRegistration | undefined
  private toolRegistration: HostRegistration | undefined
  private hookRegistration: HostRegistration | undefined
  private disposal: Promise<void> | undefined
  private readonly releaseReference: () => Promise<void>

  constructor(service: EnsembleV2Service, ctx: any, release: () => Promise<void>) {
    this.service = service
    this.ctx = ctx
    this.releaseReference = release
    const directory = ctx?.location?.directory
    this.directory = typeof directory === "string" && directory.length > 0 ? directory : undefined
  }

  /**
   * Register all location-owned surfaces. A failure unwinds the partial
   * attachment, including the service reference, before the error escapes.
   */
  async start(): Promise<this> {
    try {
      this.rpcRegistration = await this.ctx.rpc.register(EnsembleV2Rpc, this.service.handlers())
      this.service.attach(this.rpcRegistration)
      this.toolRegistration = await this.service.installToolsFor(this.ctx)
      this.hookRegistration = await this.service.installRetryHook(this.ctx)
      return this
    } catch (error) {
      await this.dispose().catch(() => undefined)
      throw error
    }
  }

  /**
   * Idempotent cleanup. Disposal is best-effort per registration so a host
   * failure in one surface cannot strand the shared service reference.
   */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposal = (async () => {
      await this.disposeRegistration(this.hookRegistration)
      await this.disposeRegistration(this.toolRegistration)
      if (this.rpcRegistration) this.service.detach(this.rpcRegistration)
      await this.disposeRegistration(this.rpcRegistration)
      await this.releaseReference()
    })()
    return this.disposal
  }

  private async disposeRegistration(registration: HostRegistration | undefined): Promise<void> {
    try {
      await registration?.dispose?.()
    } catch {
      // Cleanup is best-effort: releasing the shared reference still runs.
    }
  }
}
