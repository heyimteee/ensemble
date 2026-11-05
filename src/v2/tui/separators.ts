/**
 * Chrome separator grammar (v5.7 T3, ticket #93).
 *
 * One separator is shared by the statusline, hints, footers, rail metadata,
 * work rows, and activity lines: a faint `│` with one space on each side.
 * ASCII `|` is only the fallback for a dumb terminal or an explicit request.
 * Chat message content is never rewritten through this module.
 */

export const CHROME_SEPARATOR = "│"
export const ASCII_SEPARATOR = "|"

/** The separator for this process. Unicode unless the terminal is ASCII-only. */
export function chromeSeparator(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ENSEMBLE_ASCII === "1" || env.ENSEMBLE_ASCII === "true") return ASCII_SEPARATOR
  if (env.TERM === "dumb") return ASCII_SEPARATOR
  return CHROME_SEPARATOR
}

/** Join chrome parts with ` │ ` (or the ASCII fallback). */
export function chromeJoin(parts: readonly string[], separator: string = chromeSeparator()): string {
  return parts.join(` ${separator} `)
}

export type ChromePart = { text: string; separator: boolean }

/**
 * Split a chrome line into content and separator spans so the renderer can
 * paint separators faint while content keeps its own tone. Legacy ` · ` lists
 * still split, which keeps old strings from leaking a dot during migration.
 */
export function chromeSeparatorParts(text: string, separator: string = chromeSeparator()): ChromePart[] {
  const markers = [` ${separator} `, ` ${CHROME_SEPARATOR} `, ` ${ASCII_SEPARATOR} `, " · "].filter(
    (marker, index, all) => all.indexOf(marker) === index,
  )
  const pattern = new RegExp(markers.map(escapeRegExp).join("|"), "g")
  const parts: ChromePart[] = []
  let start = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > start) parts.push({ text: text.slice(start, index), separator: false })
    parts.push({ text: match[0], separator: true })
    start = index + match[0].length
  }
  if (start < text.length) parts.push({ text: text.slice(start), separator: false })
  if (parts.length === 0) parts.push({ text, separator: false })
  return parts
}

/** Split a chrome list on the shared separator, tolerating the legacy dot. */
export function chromeSplit(text: string, separator: string = chromeSeparator()): string[] {
  return chromeSeparatorParts(text, separator)
    .filter((part) => !part.separator)
    .map((part) => part.text)
    .filter((part) => part.length > 0)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
