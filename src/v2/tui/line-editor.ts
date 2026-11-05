/**
 * One-line editor for Command/Search (v5.7 review fix).
 *
 * The statusline command input is not an OpenTUI text renderable, so it owns
 * its own cursor. This module is the pure editing core: insert at the cursor,
 * backspace/delete around it, and move it between code-unit boundaries. The
 * renderer turns the cursor into a visible line caret and scrolls the text so
 * the caret stays in view.
 */

export type LineEditorState = { text: string; cursor: number }

export type LineEditorAction =
  | "left"
  | "right"
  | "home"
  | "end"
  | "backspace"
  | "delete"
  | { insert: string }

/** Keep a cursor inside `0..text.length`; non-integers truncate toward zero. */
export function clampLineCursor(text: string, cursor: number): number {
  const value = Number.isFinite(cursor) ? Math.trunc(cursor) : 0
  return Math.max(0, Math.min(text.length, value))
}

/** Apply one editing action without mutating the input. */
export function editLine(text: string, cursor: number, action: LineEditorAction): LineEditorState {
  const at = clampLineCursor(text, cursor)
  if (typeof action !== "string") {
    const insert = action.insert
    return { text: text.slice(0, at) + insert + text.slice(at), cursor: at + insert.length }
  }
  switch (action) {
    case "left":
      return { text, cursor: Math.max(0, at - 1) }
    case "right":
      return { text, cursor: Math.min(text.length, at + 1) }
    case "home":
      return { text, cursor: 0 }
    case "end":
      return { text, cursor: text.length }
    case "backspace":
      if (at === 0) return { text, cursor: 0 }
      return { text: text.slice(0, at - 1) + text.slice(at), cursor: at - 1 }
    case "delete":
      if (at >= text.length) return { text, cursor: at }
      return { text: text.slice(0, at) + text.slice(at + 1), cursor: at }
  }
}
