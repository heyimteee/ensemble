import { Plugin } from "@opencode/plugin/tui"
import { EnsembleApp } from "./app.tsx"

export default Plugin.define({
  id: "ensemble.tui",
  setup(ctx) {
    const unregister = ctx.ui.router.register({
      name: "ensemble",
      render: () => <EnsembleApp />,
    })
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "ensemble.open",
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
