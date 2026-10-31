import { Plugin } from "@opencode/plugin"
import { EnsembleV2Rpc } from "./rpc.ts"
import { SharedEnsemble } from "./shared-service.ts"

const shared = new SharedEnsemble()

export default Plugin.define({
  id: "ensemble.v2",
  async setup(ctx) {
    const { service, release } = await shared.acquire(ctx)
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
