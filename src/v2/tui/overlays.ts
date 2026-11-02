/**
 * Pure decision helpers for the in-house overlays. Every interactive native
 * dialog migrates to one of these: a single-choice picker, an in-house
 * confirm modal, a scrollable result modal, a multiline text prompt (handled
 * by the existing overlay), or inline skill filtering. Toasts stay native.
 */

export type ConfirmKeyAction = "confirm" | "cancel"

/**
 * Confirm modal keys: Enter (any return shape) or y confirms, Escape or n
 * cancels. Everything else is ignored so overlay focus stays trapped.
 */
export function confirmKeyAction(name: string, sequence: string): ConfirmKeyAction | undefined {
  if (name === "return" || name === "enter" || name === "kpenter" || sequence === "\r" || sequence === "\n") return "confirm"
  if (name === "escape") return "cancel"
  if (sequence === "y" || sequence === "Y") return "confirm"
  if (sequence === "n" || sequence === "N") return "cancel"
  return undefined
}

export type ResultKeyAction = "dismiss" | "up" | "down" | "pageUp" | "pageDown"

/** Result modal keys: dismiss without a dialog; navigation scrolls. */
export function resultKeyAction(name: string): ResultKeyAction | undefined {
  if (name === "escape" || name === "return" || name === "enter" || name === "kpenter" || name === "q") return "dismiss"
  if (name === "up") return "up"
  if (name === "down") return "down"
  if (name === "pageup") return "pageUp"
  if (name === "pagedown") return "pageDown"
  return undefined
}

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
