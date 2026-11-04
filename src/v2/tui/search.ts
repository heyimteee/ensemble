/**
 * Transcript search over the loaded window (ticket #80).
 *
 * Search is literal and case-insensitive: no regular expressions, no deep
 * transcript scan. The caller passes exactly the lines that are loaded, and
 * `n`/`N` cycle through the resulting matches with wraparound.
 */

export type SearchableLine = { id: string; text: string }

export type TranscriptMatch = {
  lineID: string
  lineIndex: number
  /** 0-based occurrence within this line. */
  occurrence: number
  start: number
  end: number
  /** The matched slice, retaining its original casing. */
  text: string
  /** A compact phrase around the match for the statusline. */
  excerpt: string
}

/** Compact the text around a match without losing the matched phrase. */
export function matchExcerpt(text: string, start: number, end: number, width = 48): string {
  const context = Math.max(6, Math.floor((width - (end - start)) / 2))
  const from = Math.max(0, start - context)
  const to = Math.min(text.length, end + context)
  const body = text.slice(from, to).replace(/\s+/g, " ").trim()
  return `${from > 0 ? "…" : ""}${body}${to < text.length ? "…" : ""}`
}

export function transcriptMatches(lines: readonly SearchableLine[], query: string): TranscriptMatch[] {
  const needle = query.toLowerCase()
  if (!needle) return []
  const matches: TranscriptMatch[] = []
  lines.forEach((line, lineIndex) => {
    if (!line.text) return
    const haystack = line.text.toLowerCase()
    let occurrence = 0
    let start = haystack.indexOf(needle)
    while (start >= 0) {
      const end = start + needle.length
      matches.push({
        lineID: line.id,
        lineIndex,
        occurrence,
        start,
        end,
        text: line.text.slice(start, end),
        excerpt: matchExcerpt(line.text, start, end),
      })
      occurrence++
      start = haystack.indexOf(needle, end)
    }
  })
  return matches
}

/** Next match index, wrapping at either end. An empty result stays at zero. */
export function matchIndexAfter(total: number, current: number | null, direction: 1 | -1): number {
  if (total <= 0) return 0
  const base = current === null ? (direction > 0 ? -1 : 0) : Math.max(0, Math.min(total - 1, Math.trunc(current)))
  return (base + direction + total) % total
}
