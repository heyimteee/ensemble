import DefaultTheme from "vitepress/theme"
import Layout from "./Layout.vue"
import DocsFigure from "./DocsFigure.vue"
import TerminalHero from "./TerminalHero.vue"
import "./custom.css"

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component("DocsFigure", DocsFigure)
    app.component("TerminalHero", TerminalHero)
  },
}
