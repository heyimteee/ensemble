import { Plugin } from "@opencode/plugin/tui"
import { EnsembleV2App } from "./app.tsx"

export default Plugin.define({
  id: "ensemble.v2.tui",
  setup(ctx) {
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
          slash: { name: "ensemble" },
          palette: true,
          run: () => ctx.ui.router.navigate({ type: "plugin", name: "ensemble" }),
        },
      ],
    }))
    return unregister
  },
})
