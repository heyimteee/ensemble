import { existsSync, readFileSync } from "node:fs"
import { SITE_DESCRIPTION, SITE_ORIGIN } from "./site-data.mjs"

function stripInlineMarkdown(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_~>]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim()
}

function frontmatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(markdown)
  if (!match) return { body: markdown, values: {} }
  const values = {}
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!field) continue
    values[field[1]] = field[2].replace(/^["']|["']$/g, "").trim()
  }
  return { body: markdown.slice(match[0].length), values }
}

export function firstParagraph(markdown) {
  const { body } = frontmatter(markdown)
  const text = body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
  for (const block of text.split(/\r?\n\s*\r?\n/)) {
    const trimmed = block.trim()
    if (!trimmed) continue
    if (trimmed.startsWith("#")) continue
    if (trimmed.startsWith("|") || trimmed.startsWith("<!--")) continue
    if (trimmed.startsWith(":::")) continue
    const plain = stripInlineMarkdown(trimmed)
    if (plain.length >= 40) return plain
  }
  return ""
}

export function truncate(text, limit = 160) {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit + 1)
  const space = cut.lastIndexOf(" ")
  return `${cut.slice(0, space > 60 ? space : limit).replace(/[,;:.]$/, "")}…`
}

export function descriptionText(text) {
  return truncate(stripInlineMarkdown(text))
}

export function pageTitle(markdown, fallback = "Ensemble documentation") {
  const { body, values } = frontmatter(markdown)
  if (values.title) return stripInlineMarkdown(values.title)
  const heading = /^#\s+(.+)$/m.exec(body)
  return heading ? stripInlineMarkdown(heading[1]) : fallback
}

export function pageDescription(markdown, fallback = SITE_DESCRIPTION) {
  const { values } = frontmatter(markdown)
  if (values.description) return descriptionText(values.description)
  return truncate(firstParagraph(markdown)) || fallback
}

export function pageDescriptionFromFile(path, fallback = SITE_DESCRIPTION) {
  if (!existsSync(path)) return fallback
  return pageDescription(readFileSync(path, "utf8"), fallback)
}

/** `page` is the rewritten source path, e.g. `getting-started/index.md`. */
export function canonicalFor(page) {
  let route = page.replace(/\.md$/, "")
  if (route === "index") route = ""
  else if (route.endsWith("/index")) route = route.slice(0, -"index".length)
  return `${SITE_ORIGIN}${route}`
}
