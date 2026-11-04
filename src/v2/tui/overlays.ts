/**
 * Pure decision helpers for the in-house overlays. v5.6 T6 moved confirm and
 * result keys onto the shared dialog catalog (`confirm`/`result` contexts);
 * this module keeps the picker value helper and the inline filter editor.
 */

/** Single-choice picker: Enter resolves the focused item, if any. */
export function singleChoiceValue<Item>(items: readonly Item[], cursor: number): Item | undefined {
  if (cursor < 0 || cursor >= items.length) return undefined
  return items[cursor]
}

export type FilterKey = {
  name?: string
  sequence?: string
  ctrl?: boolean
  meta?: boolean
  super?: boolean
}

export type FilterEdit = { query: string; done: boolean; cancelled: boolean }

/**
 * Inline filter editing shared by the skill palette and the memories tab:
 * printable keys append, backspace deletes, Enter submits, Escape cancels.
 * Modifier chords and multi-character sequences are ignored so terminal
 * chords never corrupt the filter.
 */
export function filterEdit(query: string, key: FilterKey | undefined): FilterEdit {
  const name = String(key?.name ?? "")
  const sequence = String(key?.sequence ?? "")
  if (name === "escape") return { query, done: true, cancelled: true }
  if (name === "return" || name === "enter" || name === "kpenter" || sequence === "\r" || sequence === "\n") {
    return { query, done: true, cancelled: false }
  }
  if (name === "backspace") return { query: query.slice(0, -1), done: false, cancelled: false }
  if (sequence.length === 1 && sequence >= " " && !key?.ctrl && !key?.meta && !key?.super) {
    return { query: `${query}${sequence}`, done: false, cancelled: false }
  }
  return { query, done: false, cancelled: false }
}
