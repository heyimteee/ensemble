import { Plugin } from "@opencode/plugin"
import { sharedEnsemble } from "./shared-service.ts"

export default Plugin.define({
  id: "ensemble.v2",
  async setup(ctx) {
    // Resolve per setup: OpenCode re-evaluates this module once per location,
    // and a registry version change must be picked up by later locations. The
    // attachment owns this location's RPC, tools, retry hook, and realm ref.
    const attachment = await sharedEnsemble().attach(ctx)
    return () => attachment.dispose()
  },
})
