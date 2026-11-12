import { Plugin } from "@opencode/plugin"
import { assertSupportedNode } from "./node-version.ts"
import { sharedEnsemble } from "./shared-service.ts"

// Ticket #258: fail at plugin load with the supported Node range instead of a
// downstream API error. `engines.node` still warns at install time.
assertSupportedNode()

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
