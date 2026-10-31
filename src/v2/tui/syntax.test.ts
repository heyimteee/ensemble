import test from "node:test"
import assert from "node:assert/strict"
import { markdownStyles } from "./syntax.ts"

test("Markdown styles cover headings, emphasis, links, lists, quotes, and code", () => {
  const styles = markdownStyles({
    text: { base: "#fff", muted: "#888", feedback: { info: { base: "#0af" }, success: { base: "#0f0" } } },
    hue: { accent: { 200: "#0af" } },
    markdown: { heading: "#0af", strong: "#fff", emphasis: "#fff", link: "#0af", linkText: "#0af", code: "#0f0", blockQuote: "#888", listItem: "#fff", listEnumeration: "#888", text: "#fff" },
    syntax: { keyword: "#f0f", string: "#0f0", comment: "#888", number: "#fa0", function: "#0af", variable: "#fff", type: "#0af", operator: "#fff", punctuation: "#888" },
  })
  for (const scope of ["markup.heading.1", "markup.strong", "markup.italic", "markup.raw.inline", "markup.link", "markup.list", "markup.quote", "string.special.url"]) {
    assert.ok(styles[scope], scope)
  }
  assert.equal(styles["markup.heading.1"].bold, true)
  assert.equal(styles["markup.italic"].italic, true)
})
