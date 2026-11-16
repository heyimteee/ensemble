import { Plugin } from "@opencode/plugin/tui"
import { assertSupportedNode } from "../node-version.ts"
import { EnsembleV2App } from "./app.tsx"
import { globalEntries } from "./keymap.ts"

// Ticket #258: the TUI can load independently of the server plugin.
assertSupportedNode()

export default Plugin.define({
  id: "ensemble.v2.tui",
  setup(ctx) {
    const native = globalEntries().find((entry) => entry.id === "global.native")
    const unregister = ctx.ui.router.register({
      name: "ensemble",
      render: () => <EnsembleV2App />,
    })
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "ensemble.v2.open",
          title: "Open Ensemble",
          group: "Ensemble",
          bind: native?.keys[0] ?? "f2",
          slash: { name: "ensemble" },
          palette: true,
          run: () => ctx.ui.router.navigate({ type: "plugin", name: "ensemble" }),
        },
      ],
    }))
    return unregister
  },
})
