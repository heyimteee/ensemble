import test from "node:test"
import assert from "node:assert/strict"
import { clampLineCursor, editLine } from "./line-editor.ts"

test("command line insertion lands at the cursor, not at the end", () => {
  assert.deepEqual(editLine("settings", 0, { insert: ":" }), { text: ":settings", cursor: 1 })
  assert.deepEqual(editLine("setings", 3, { insert: "t" }), { text: "settings", cursor: 4 })
  assert.deepEqual(editLine("", 0, { insert: "/agent" }), { text: "/agent", cursor: 6 })
})

test("left, right, home, and end move the command cursor and clamp at the edges", () => {
  assert.deepEqual(editLine("abc", 2, "left"), { text: "abc", cursor: 1 })
  assert.deepEqual(editLine("abc", 2, "right"), { text: "abc", cursor: 3 })
  assert.deepEqual(editLine("abc", 0, "left"), { text: "abc", cursor: 0 })
  assert.deepEqual(editLine("abc", 3, "right"), { text: "abc", cursor: 3 })
  assert.deepEqual(editLine("abc", 1, "home"), { text: "abc", cursor: 0 })
  assert.deepEqual(editLine("abc", 1, "end"), { text: "abc", cursor: 3 })
})

test("backspace and delete edit around the cursor without touching the other end", () => {
  assert.deepEqual(editLine("abc", 2, "backspace"), { text: "ac", cursor: 1 })
  assert.deepEqual(editLine("abc", 1, "delete"), { text: "ac", cursor: 1 })
  assert.deepEqual(editLine("abc", 0, "backspace"), { text: "abc", cursor: 0 }, "backspace at the start is inert")
  assert.deepEqual(editLine("abc", 3, "delete"), { text: "abc", cursor: 3 }, "delete at the end is inert")
})

test("a cursor past either edge clamps before an edit applies", () => {
  assert.equal(clampLineCursor("abc", 9), 3)
  assert.equal(clampLineCursor("abc", -2), 0)
  assert.equal(clampLineCursor("abc", Number.NaN), 0)
  assert.deepEqual(editLine("abc", 99, "backspace"), { text: "ab", cursor: 2 })
  assert.deepEqual(editLine("abc", -5, { insert: "x" }), { text: "xabc", cursor: 1 })
})
