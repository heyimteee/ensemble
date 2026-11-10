import { EnsembleV2Rpc } from "./rpc.ts"
import type { EnsembleV2Service } from "./service.ts"

type HostRegistration = { dispose?: () => Promise<void> | void }

/**
 * Event groups the host exposes per location. They are subscribed separately so
 * a slow durable write for one group cannot hold back text deltas from another.
 */
const LOCATION_EVENT_TYPES: string[][] = [
  ["skill.updated", "model.updated", "provider.updated"],
  ["session.text.delta", "session.idle"],
  ["permission.asked", "permission.replied"],
  ["config.updated", "file.edited"],
  // Ticket #155: native tool activity and execution lifecycle for Work cards.
  // `input.started` carries the tool name; `called` carries its input head.
  ["session.tool.input.started", "session.tool.called", "session.tool.progress", "session.tool.success", "session.tool.failed"],
  ["session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"],
  // Ticket #182: host child sessions are the durable identity for native
  // subagent records. The tracker maps them to their parent task and group.
  // Ticket #224: the same subscription refreshes the native session picker on
  // created, renamed/metadata, archive, move, fork, and delete events.
  [
    "session.created",
    "session.deleted",
    "session.renamed",
    "session.metadata.updated",
    "session.permissions",
    "session.moved",
    "session.archived",
    "session.unarchived",
    "session.forked",
  ],
]

/**
 * One host location's attachment to the shared Ensemble realm (ticket #153).
 *
 * OpenCode re-evaluates the plugin for every location and gives each setup its
 * own plugin context. The realm service and store are shared, but every
 * location-scoped host surface belongs to this attachment: RPC registration,
 * tool transform, retry hook, event subscriptions, and the reference that keeps
 * the service alive. Disposing the attachment removes only these registrations
 * and releases this location's reference.
 */
export class LocationAttachment {
  readonly service: EnsembleV2Service
  readonly ctx: any
  readonly directory: string | undefined
  private rpcRegistration: HostRegistration | undefined
  private toolRegistration: HostRegistration | undefined
  private hookRegistration: HostRegistration | undefined
  private idleHookRegistration: HostRegistration | undefined
  private eventAbort: AbortController | undefined
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
      this.idleHookRegistration = await this.service.installIdleHook(this.ctx)
      this.service.trackLocation(this.ctx, this.directory)
      this.startEventSubscriptions()
      return this
    } catch (error) {
      await this.dispose().catch(() => undefined)
      throw error
    }
  }

  /**
   * Idempotent cleanup. Disposal is best-effort per registration so a host
   * failure in one surface cannot strand the shared service reference. Event
   * loops are aborted and left to unwind; a host generator that ignores its
   * signal must not hold up the service reference release.
   */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposal = (async () => {
      this.eventAbort?.abort()
      await this.service.untrackLocation(this.ctx)
      await this.disposeRegistration(this.idleHookRegistration)
      await this.disposeRegistration(this.hookRegistration)
      await this.disposeRegistration(this.toolRegistration)
      if (this.rpcRegistration) this.service.detach(this.rpcRegistration)
      await this.disposeRegistration(this.rpcRegistration)
      await this.releaseReference()
    })()
    return this.disposal
  }

  private startEventSubscriptions(): void {
    this.eventAbort = new AbortController()
    const signal = this.eventAbort.signal
    for (const types of LOCATION_EVENT_TYPES) void this.consumeEvents(types, signal)
  }

  private async consumeEvents(types: string[], signal: AbortSignal): Promise<void> {
    try {
      for await (const event of this.ctx.event.subscribe({ types, signal })) {
        if (signal.aborted) return
        await this.service.handleHostEvent(event, this.ctx)
      }
    } catch {
      // A host teardown or abort closes the iterator; disposal owns cleanup.
    }
  }

  private async disposeRegistration(registration: HostRegistration | undefined): Promise<void> {
    try {
      await registration?.dispose?.()
    } catch {
      // Cleanup is best-effort: releasing the shared reference still runs.
    }
  }
}
