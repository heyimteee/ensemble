/**
 * One grammar for `@path` workspace file references, shared by the composer
 * tokenizer and the server resolver. The token starts at an `@` at the start
 * of the text or after whitespace and ends at the first unescaped whitespace.
 * A backslash escapes the next character: `\ ` is a space, `\\` a backslash.
 */
export type FileReferenceToken = {
  /** Index of the leading `@`. */
  start: number
  /** Exclusive end of the typed token. */
  end: number
  /** The exact typed token, including `@` and escapes. */
  raw: string
  /** The unescaped path query. */
  path: string
}

type Scan = {
  path: string
  end: number
  malformed: boolean
}

const WHITESPACE = /\s/

function isWhitespace(character: string | undefined): boolean {
  return character !== undefined && WHITESPACE.test(character)
}

/** Whether a whitespace character is itself escaped by a preceding backslash. */
function isUnescapedWhitespaceAt(text: string, index: number): boolean {
  if (!isWhitespace(text[index])) return false
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) backslashes++
  return backslashes % 2 === 0
}

function scanPath(text: string, from: number, limit: number): Scan {
  let end = from
  let path = ""
  while (end < limit) {
    const character = text[end]
    if (character === "\\") {
      if (end + 1 >= limit) return { path, end, malformed: true }
      path += text[end + 1]
      end += 2
      continue
    }
    if (isWhitespace(character)) break
    path += character
    end++
  }
  return { path, end, malformed: false }
}

/** Unescape a path typed without its leading `@`; rejects dangling escapes. */
export function unescapeFileReference(raw: string): string | undefined {
  const scan = scanPath(raw, 0, raw.length)
  if (scan.malformed || scan.end !== raw.length) return undefined
  return scan.path
}

/** Escape a path for insertion; `@path\ with\ spaces` round-trips exactly. */
export function escapeFileReference(path: string): string {
  return path.replace(/[\\\s]/g, (character) => `\\${character}`)
}

/**
 * Replace a bounded file-reference token with the selected path. Text before
 * `start` and after `end` is untouched; one existing leading suffix space is
 * collapsed so the inserted trailing space does not double.
 */
export function replaceFileReference(
  text: string,
  path: string,
  start: number,
  end: number,
): { text: string; cursor: number } {
  const suffix = text.slice(end)
  const rest = suffix.startsWith(" ") ? suffix.slice(1) : suffix
  const inserted = `@${escapeFileReference(path)} `
  return { text: `${text.slice(0, start)}${inserted}${rest}`, cursor: start + inserted.length }
}

/**
 * The file-reference token whose typed prefix reaches `cursor`, or undefined
 * when the cursor is outside every token (including after a closing space).
 * The returned `end` is the cursor, so a selection replaces only the typed
 * prefix and the untouched suffix stays in the composer.
 */
export function fileReferenceTokenAt(text: string, cursor: number): FileReferenceToken | undefined {
  if (!Number.isInteger(cursor) || cursor <= 0 || cursor > text.length) return undefined
  let start = -1
  for (let index = cursor - 1; index >= 0; index--) {
    if (text[index] === "@" && (index === 0 || isUnescapedWhitespaceAt(text, index - 1))) {
      start = index
      break
    }
    if (isUnescapedWhitespaceAt(text, index)) return undefined
  }
  if (start < 0) return undefined
  const scan = scanPath(text, start + 1, cursor)
  if (scan.malformed || scan.end !== cursor) return undefined
  return { start, end: cursor, raw: text.slice(start, cursor), path: scan.path }
}

/** Every file-reference token in a message, in order. Malformed tokens are skipped. */
export function fileReferenceTokens(text: string): FileReferenceToken[] {
  const tokens: FileReferenceToken[] = []
  let index = 0
  while (index < text.length) {
    if (text[index] !== "@" || (index > 0 && !isUnescapedWhitespaceAt(text, index - 1))) {
      index++
      continue
    }
    const scan = scanPath(text, index + 1, text.length)
    if (scan.malformed) {
      index = scan.end + 1
      continue
    }
    tokens.push({ start: index, end: scan.end, raw: text.slice(index, scan.end), path: scan.path })
    index = scan.end
  }
  return tokens
}
