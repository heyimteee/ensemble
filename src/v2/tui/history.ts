/**
 * Per-kind command-line history (ticket #80).
 *
 * Command (`:`) and search (`/`) recall separate lists for the lifetime of
 * the session. Recall is readline-shaped: Up walks towards older entries and
 * stops; Down walks back to the draft that was typed before recall.
 */

export type HistoryKind = ":" | "/"

export type HistoryEntry = {
  entries: string[]
  index: number | null
  draft: string
}

export type CommandHistory = Record<HistoryKind, HistoryEntry>

const EMPTY_ENTRY = (): HistoryEntry => ({ entries: [], index: null, draft: "" })

export function createCommandHistory(): CommandHistory {
  return { ":": EMPTY_ENTRY(), "/": EMPTY_ENTRY() }
}

function withEntry(history: CommandHistory, kind: HistoryKind, entry: HistoryEntry): CommandHistory {
  return { ...history, [kind]: entry }
}

/** Record a submitted command or search; empty and adjacent duplicates are skipped. */
export function rememberHistory(history: CommandHistory, kind: HistoryKind, text: string): CommandHistory {
  const value = text.trim()
  if (!value) return history
  const entry = history[kind]
  if (entry.entries[entry.entries.length - 1] === value) {
    return withEntry(history, kind, { ...entry, index: null, draft: "" })
  }
  return withEntry(history, kind, { entries: [...entry.entries, value], index: null, draft: "" })
}

/** Called when a line opens: the list survives, recall and the draft start fresh. */
export function startHistory(history: CommandHistory, kind: HistoryKind): CommandHistory {
  return withEntry(history, kind, { ...history[kind], index: null, draft: "" })
}

export type HistoryRecall = { history: CommandHistory; text: string }

export function recallHistory(
  history: CommandHistory,
  kind: HistoryKind,
  direction: "up" | "down",
  current: string,
): HistoryRecall {
  const entry = history[kind]
  if (entry.entries.length === 0) return { history, text: current }

  if (direction === "up") {
    const index = entry.index === null ? entry.entries.length - 1 : Math.max(0, entry.index - 1)
    const draft = entry.index === null ? current : entry.draft
    return {
      history: withEntry(history, kind, { ...entry, index, draft }),
      text: entry.entries[index],
    }
  }

  if (entry.index === null) return { history, text: current }
  if (entry.index >= entry.entries.length - 1) {
    return { history: withEntry(history, kind, { ...entry, index: null }), text: entry.draft }
  }
  const index = entry.index + 1
  return {
    history: withEntry(history, kind, { ...entry, index }),
    text: entry.entries[index],
  }
}
