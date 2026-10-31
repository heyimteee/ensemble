export function markdownStyles(theme: any): Record<string, any> {
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
  return styles
}
