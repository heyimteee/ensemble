import { LocationAttachment } from "./location-adapter.ts"
import type { EnsembleV2Service } from "./service.ts"

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
