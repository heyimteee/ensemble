import type { EnsembleV2Service } from "./service.ts"

/**
 * Test seam for the service-only suites (ticket #153).
 *
 * Production setup goes through `SharedEnsemble.attach(ctx)`, which installs
 * the location-owned tool transform and retry hook after starting the realm
 * service. Tests that construct `EnsembleV2Service` directly use this helper to
 * get the same surfaces on the service's own context.
 */
export async function startServiceForTest(service: EnsembleV2Service, ctx: any): Promise<() => Promise<void>> {
  const stop = await service.start()
  const tools = await service.installToolsFor(ctx)
  const retry = await service.installRetryHook(ctx)
  return async () => {
    await tools.dispose?.()
    await retry.dispose?.()
    await stop()
  }
}
