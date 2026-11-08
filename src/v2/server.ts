import { Plugin } from "@opencode/plugin"
import { EnsembleV2Rpc } from "./rpc.ts"
import { sharedEnsemble } from "./shared-service.ts"

export default Plugin.define({
  id: "ensemble.v2",
  async setup(ctx) {
    // Resolve per setup: OpenCode re-evaluates this module once per location,
    // and a registry version change must be picked up by later locations.
    const { service, release } = await sharedEnsemble().acquire(ctx)
    let registration: any
    try {
      registration = await ctx.rpc.register(EnsembleV2Rpc, service.handlers())
      service.attach(registration)
    } catch (error) {
      await release()
      throw error
    }
    return async () => {
      await registration?.dispose?.().catch(() => undefined)
      service.detach(registration)
      await release()
    }
  },
})
