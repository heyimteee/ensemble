import { Plugin } from "@opencode/plugin"
import { EnsembleV2Rpc } from "./rpc.ts"
import { EnsembleV2Service } from "./service.ts"

export default Plugin.define({
  id: "ensemble.v2",
  async setup(ctx) {
    const service = new EnsembleV2Service(ctx)
    const stop = await service.start()
    const registration = await ctx.rpc.register(EnsembleV2Rpc, service.handlers())
    service.attach(registration)
    return async () => {
      await registration.dispose?.().catch(() => undefined)
      await stop()
    }
  },
})
