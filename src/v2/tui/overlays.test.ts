import test from "node:test"
import assert from "node:assert/strict"
import { singleChoiceValue, filterEdit } from "./overlays.ts"

test("single-choice picker resolves the focused item", () => {
  const items = [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }]
  assert.deepEqual(singleChoiceValue(items, 0), { id: "a", label: "Alpha" })
  assert.deepEqual(singleChoiceValue(items, 1), { id: "b", label: "Beta" })
  assert.equal(singleChoiceValue(items, 2), undefined)
  assert.equal(singleChoiceValue([], 0), undefined)
})

test("inline skill filter edits the query without a dialog", () => {
  assert.deepEqual(filterEdit("", { name: "", sequence: "a" }), { query: "a", done: false, cancelled: false })
  assert.deepEqual(filterEdit("ab", { name: "backspace", sequence: "" }), { query: "a", done: false, cancelled: false })
  assert.deepEqual(filterEdit("", { name: "backspace", sequence: "" }), { query: "", done: false, cancelled: false })
  assert.deepEqual(filterEdit("ab", { name: "return", sequence: "\r" }), { query: "ab", done: true, cancelled: false })
  assert.deepEqual(filterEdit("ab", { name: "escape", sequence: "" }), { query: "ab", done: true, cancelled: true })
})

test("inline skill filter ignores modifier chords and multi-character sequences", () => {
  assert.deepEqual(filterEdit("a", { name: "", sequence: "b", ctrl: true }), { query: "a", done: false, cancelled: false })
  assert.deepEqual(filterEdit("a", { name: "", sequence: "Z?" }), { query: "a", done: false, cancelled: false })
})
