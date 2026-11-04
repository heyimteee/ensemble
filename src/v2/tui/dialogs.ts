/**
 * v5.6 T6 dialog grammar.
 *
 * Wizards, pickers, confirms, prompts, results, and approvals all share one
 * Esc ladder and one list grammar. This module keeps the transition policy
 * pure so the app adapter only maps an outcome onto its signals:
 *
 *   filter input -> filter list -> field Normal -> step Normal -> cancel
 *
 * The key vocabulary itself lives in `keymap.ts`; this file answers where Esc
 * goes and which catalog context teaches the current dialog level.
 */

import { filterEdit, type FilterEdit, type FilterKey } from "./overlays.ts"
import type { KeyContext } from "./keymap.ts"

export type DialogSurface = "wizard" | "picker" | "prompt" | "confirm" | "result"

export type DialogEscape = "filter-clear" | "field-normal" | "back" | "cancel"

export function dialogEscape(input: {
  surface: DialogSurface
  /** A text field currently owns the caret. */
  field?: boolean
  /** An inline `/` filter owns the caret. */
  filtering?: boolean
}): DialogEscape {
  if (input.filtering) return "filter-clear"
  if (input.field) return "field-normal"
  if (input.surface === "wizard") return "back"
  return "cancel"
}

/** Inline `/` filtering shared by wizards and pickers. */
export function dialogFilterEdit(query: string, key: FilterKey | undefined): FilterEdit {
  return filterEdit(query, key)
}

export type DialogFieldMode = "insert" | "normal"

/** The catalog context that teaches a dialog level, including text fields. */
export function dialogKeyContext(input: {
  surface: DialogSurface
  field?: DialogFieldMode
}): KeyContext {
  if (input.surface === "wizard") {
    if (input.field === "insert") return "wizardField"
    if (input.field === "normal") return "wizardText"
    return "wizard"
  }
  if (input.surface === "prompt") {
    return input.field === "normal" ? "promptText" : "promptField"
  }
  return input.surface
}
