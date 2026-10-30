import { Plugin } from "@opencode/plugin"
import { EnsembleV2Service } from "./service.ts"

export default Plugin.define({
  id: "ensemble.v2",
  async setup(ctx) {
    const service = new EnsembleV2Service(ctx)
    return service.start()
  },
})
