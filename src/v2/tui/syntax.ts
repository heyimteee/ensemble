import { RGBA } from "@opentui/core"
import { isNoColor } from "./theme.ts"

export function markdownStyles(theme: any, env: NodeJS.ProcessEnv = process.env): Record<string, any> {
  const md = theme?.markdown ?? {}
  const syntax = theme?.syntax ?? {}
  const text = theme?.text ?? {}
  const heading = md.heading ?? theme?.hue?.accent?.[200] ?? text.base
  const link = md.link ?? theme?.text?.feedback?.info?.base ?? text.base
  const linkText = md.linkText ?? link
  const code = md.code ?? theme?.text?.feedback?.info?.base ?? text.base
  const quote = md.blockQuote ?? text.muted
  const list = md.listItem ?? text.base
  const enumeration = md.listEnumeration ?? text.muted
  const strong = md.strong ?? text.base
  const emphasis = md.emphasis ?? text.base
  const styles: Record<string, any> = {
    default: { fg: md.text ?? text.base },
    text: { fg: md.text ?? text.base },
    keyword: { fg: syntax.keyword ?? text.base },
    "keyword.control": { fg: syntax.keyword ?? text.base },
    "keyword.operator": { fg: syntax.operator ?? syntax.keyword ?? text.base },
    function: { fg: syntax.function ?? text.base },
    variable: { fg: syntax.variable ?? text.base },
    string: { fg: syntax.string ?? text.base },
    "string.special": { fg: syntax.string ?? text.base },
    "string.special.url": { fg: linkText },
    number: { fg: syntax.number ?? text.base },
    "number.float": { fg: syntax.number ?? text.base },
    "number.integer": { fg: syntax.number ?? text.base },
    type: { fg: syntax.type ?? text.base },
    operator: { fg: syntax.operator ?? text.base },
    punctuation: { fg: syntax.punctuation ?? text.muted },
    comment: { fg: syntax.comment ?? text.muted, italic: true },
    "comment.line": { fg: syntax.comment ?? text.muted, italic: true },
    "comment.block": { fg: syntax.comment ?? text.muted, italic: true },
    property: { fg: syntax.variable ?? text.base },
    constant: { fg: syntax.number ?? text.base },
    boolean: { fg: syntax.keyword ?? text.base },
    tag: { fg: syntax.keyword ?? text.base },
    attribute: { fg: syntax.function ?? text.base },
    "markup.heading": { fg: heading, bold: true },
    "markup.heading.1": { fg: heading, bold: true },
    "markup.heading.2": { fg: heading, bold: true },
    "markup.heading.3": { fg: heading, bold: true },
    "markup.heading.4": { fg: heading, bold: true },
    "markup.heading.5": { fg: heading, bold: true },
    "markup.heading.6": { fg: heading, bold: true },
    "markup.strong": { fg: strong, bold: true },
    "markup.italic": { fg: emphasis, italic: true },
    "markup.strikethrough": { fg: text.muted },
    "markup.raw": { fg: code },
    "markup.raw.inline": { fg: code },
    "markup.raw.block": { fg: code },
    "markup.link": { fg: link },
    "markup.link.label": { fg: linkText },
    "markup.link.url": { fg: linkText, underline: true },
    "markup.list": { fg: list },
    "markup.list.checked": { fg: theme?.text?.feedback?.success?.base ?? list },
    "markup.list.unchecked": { fg: enumeration },
    "markup.quote": { fg: quote, italic: true },
    "markup.horizontalRule": { fg: quote },
    "markup.image": { fg: link },
    "markup.imageText": { fg: linkText },
    "markup.codeBlock": { fg: code },
  }
  // Ticket #284: the host theme's Markdown/syntax styles are the transcript's
  // remaining concrete-color source. Under `NO_COLOR` keep every scope and
  // its emphasis attributes, but resolve the foreground to the terminal
  // default and paint no background. The caller still passes default-intent
  // fg/bg to `<markdown>`, so code blocks inherit the terminal surface.
  return isNoColor(env) ? monochromeMarkdownStyles(styles) : styles
}

function monochromeMarkdownStyles(styles: Record<string, any>): Record<string, any> {
  const foreground = RGBA.defaultForeground()
  const plain: Record<string, any> = {}
  for (const [scope, style] of Object.entries(styles)) {
    plain[scope] = { ...style, fg: foreground }
    delete plain[scope].bg
  }
  // OpenTUI's Markdown renderable paints blockquote/table/rule borders from
  // the `conceal` style and otherwise falls back to a hard-coded `#888888`.
  // Registering the scope keeps those structural glyphs on the default
  // foreground without changing any non-NO_COLOR style.
  plain.conceal = { fg: foreground }
  return plain
}
