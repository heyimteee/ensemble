import { LocationAttachment } from "./location-adapter.ts"
import type { EnsembleV2Service } from "./service.ts"

/**
 * Ticket #240: most service suites exercise the explicit legacy path with
 * `send_message`, `delegate`, and `handoff`. They opt into `nativeFirst: off`
 * explicitly; default-on behavior is covered by the ticket240 suites. The
 * helper merges into an existing meta row so a test may still seed limits.
 */
export function seedLegacySettings(values: Map<string, unknown>): void {
  const meta = (values.get("v2/meta") ?? {}) as any
  values.set("v2/meta", {
    ...meta,
    version: Number(meta.version ?? 0),
    settings: { ...(meta.settings ?? {}), nativeFirst: "off" },
    ui: meta.ui ?? {},
  })
}

/**
 * Test seam for the service-only suites (ticket #153/#154).
 *
 * Production setup goes through `SharedEnsemble.attach(ctx)`, which starts the
 * realm service and attaches a location that owns its RPC handlers, tool
 * transform, retry hook, and event subscriptions. Tests that construct
 * `EnsembleV2Service` directly use this helper to attach the same surfaces to a
 * fake location instead of relying on `service.start()`'s bootstrap context.
 */
export async function startServiceForTest(service: EnsembleV2Service, ctx: any): Promise<() => Promise<void>> {
  const stop = await service.start()
  const location = new LocationAttachment(service, ctx, async () => undefined)
  await location.start()
  return async () => {
    await location.dispose()
    await stop()
  }
}
