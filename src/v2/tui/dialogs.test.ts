import test from "node:test"
import assert from "node:assert/strict"
import { dialogEscape, dialogKeyContext, type DialogSurface } from "./dialogs.ts"
import { filterEdit } from "./overlays.ts"

test("dialog Esc goes up exactly one level", () => {
  assert.equal(dialogEscape({ surface: "wizard", filtering: true }), "filter-clear")
  assert.equal(dialogEscape({ surface: "wizard", field: true }), "field-normal")
  assert.equal(dialogEscape({ surface: "wizard" }), "back")
  assert.equal(dialogEscape({ surface: "prompt", field: true }), "field-normal")
  assert.equal(dialogEscape({ surface: "prompt" }), "cancel")
  for (const surface of ["picker", "confirm", "result"] as DialogSurface[]) {
    assert.equal(dialogEscape({ surface }), "cancel", `${surface} cancels on Esc`)
    assert.equal(dialogEscape({ surface, field: true }), "field-normal", `${surface} field leaves first`)
  }
})

test("a wizard filter owns the first Esc and clears its query", () => {
  let state = filterEdit("", { name: "", sequence: "d" })
  assert.deepEqual(state, { query: "d", done: false, cancelled: false })
  state = filterEdit(state.query, { name: "", sequence: "e" })
  state = filterEdit(state.query, { name: "backspace", sequence: "" })
  assert.equal(state.query, "d")
  const done = filterEdit("dev", { name: "return", sequence: "\r" })
  assert.deepEqual(done, { query: "dev", done: true, cancelled: false })
  const cancelled = filterEdit("dev", { name: "escape" })
  assert.deepEqual(cancelled, { query: "dev", done: true, cancelled: true })
  assert.equal(filterEdit("dev", { name: "", sequence: "Z?", ctrl: true }).query, "dev", "chords never leak into a filter")
})

test("each dialog surface maps to the catalog context that teaches it", () => {
  assert.equal(dialogKeyContext({ surface: "wizard" }), "wizard")
  assert.equal(dialogKeyContext({ surface: "wizard", field: "insert" }), "wizardField")
  assert.equal(dialogKeyContext({ surface: "wizard", field: "normal" }), "wizardText")
  assert.equal(dialogKeyContext({ surface: "prompt", field: "insert" }), "promptField")
  assert.equal(dialogKeyContext({ surface: "prompt", field: "normal" }), "promptText")
  assert.equal(dialogKeyContext({ surface: "picker" }), "picker")
  assert.equal(dialogKeyContext({ surface: "confirm" }), "confirm")
  assert.equal(dialogKeyContext({ surface: "result" }), "result")
})
