import test from "node:test"
import assert from "node:assert/strict"
import { markdownStyles } from "./syntax.ts"
import { isDefaultColor } from "./theme.ts"

const THEME = {
  text: {
    base: "#ffffff",
    muted: "#888888",
    faint: "#666666",
    feedback: {
      info: { base: "#00afff" },
      success: { base: "#00ff00" },
      warning: { base: "#ffaa00" },
      error: { base: "#ff0000" },
    },
  },
  hue: { accent: { 200: "#00afff", 300: "#4a8fd4" } },
  markdown: {
    heading: "#d7afff",
    strong: "#ffffff",
    emphasis: "#ffffff",
    link: "#00afff",
    linkText: "#00afff",
    code: "#afffd7",
    blockQuote: "#888888",
    listItem: "#ffffff",
    listEnumeration: "#888888",
    text: "#ffffff",
  },
  syntax: {
    keyword: "#ff00ff",
    string: "#00ff00",
    comment: "#888888",
    number: "#ffaa00",
    function: "#00afff",
    variable: "#ffffff",
    type: "#00afff",
    operator: "#ffffff",
    punctuation: "#888888",
  },
}

test("Markdown styles cover headings, emphasis, links, lists, quotes, and code", () => {
  const styles = markdownStyles({
    text: { base: "#fff", muted: "#888", feedback: { info: { base: "#0af" }, success: { base: "#0f0" } } },
    hue: { accent: { 200: "#0af" } },
    markdown: { heading: "#0af", strong: "#fff", emphasis: "#fff", link: "#0af", linkText: "#0af", code: "#0f0", blockQuote: "#888", listItem: "#fff", listEnumeration: "#888", text: "#fff" },
    syntax: { keyword: "#f0f", string: "#0f0", comment: "#888", number: "#fa0", function: "#0af", variable: "#fff", type: "#0af", operator: "#fff", punctuation: "#888" },
  }, {})
  for (const scope of ["markup.heading.1", "markup.strong", "markup.italic", "markup.raw.inline", "markup.link", "markup.list", "markup.quote", "string.special.url"]) {
    assert.ok(styles[scope], scope)
  }
  assert.equal(styles["markup.heading.1"].bold, true)
  assert.equal(styles["markup.italic"].italic, true)
})

test("ticket284: NO_COLOR resolves Markdown and syntax styles to default colors", () => {
  const mono = markdownStyles(THEME, { NO_COLOR: "" })
  for (const [scope, style] of Object.entries(mono)) {
    assert.ok(isDefaultColor(style.fg), `${scope} must use the terminal default foreground`)
    assert.equal(style.bg, undefined, `${scope} must not paint a background`)
  }
  // Privileged styles keep their non-color attributes, so structure survives.
  assert.equal(mono["markup.heading.1"].bold, true)
  assert.equal(mono["markup.italic"].italic, true)
  assert.equal(mono["markup.link.url"].underline, true)
  assert.equal(mono["markup.strong"].bold, true)
  assert.equal(mono.default.fg.intent, "default")
  assert.ok(isDefaultColor(mono.conceal.fg), "Markdown structural borders use the default foreground")
  // Any NO_COLOR value, including a non-empty one, is the signal.
  assert.ok(isDefaultColor(markdownStyles(THEME, { NO_COLOR: "1" })["markup.heading.1"].fg))
})

test("ticket284: Markdown styles keep host-theme colors without NO_COLOR", () => {
  const styles = markdownStyles(THEME, {})
  assert.equal(styles.default.fg, THEME.markdown.text)
  assert.equal(styles["markup.heading.1"].fg, THEME.markdown.heading)
  assert.equal(styles["markup.raw.inline"].fg, THEME.markdown.code)
  assert.equal(styles["keyword.control"].fg, THEME.syntax.keyword)
  assert.equal(styles["markup.quote"].fg, THEME.markdown.blockQuote)
  assert.deepEqual(styles, markdownStyles(THEME, {}), "the default environment is unchanged without NO_COLOR")
})
