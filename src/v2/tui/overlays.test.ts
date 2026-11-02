import test from "node:test"
import assert from "node:assert/strict"
import { confirmKeyAction, resultKeyAction, singleChoiceValue, filterEdit } from "./overlays.ts"

test("confirm modal: enter or y confirms, escape or n cancels", () => {
  assert.equal(confirmKeyAction("return", "\r"), "confirm")
  assert.equal(confirmKeyAction("enter", "\n"), "confirm")
  assert.equal(confirmKeyAction("kpenter", "\r"), "confirm")
  assert.equal(confirmKeyAction("", "y"), "confirm")
  assert.equal(confirmKeyAction("", "Y"), "confirm")
  assert.equal(confirmKeyAction("escape", ""), "cancel")
  assert.equal(confirmKeyAction("", "n"), "cancel")
  assert.equal(confirmKeyAction("", "N"), "cancel")
})

test("confirm modal ignores unrelated keys so focus stays trapped", () => {
  assert.equal(confirmKeyAction("up", ""), undefined)
  assert.equal(confirmKeyAction("", "a"), undefined)
  assert.equal(confirmKeyAction("", " "), undefined)
})

test("result modal: escape, enter, or q dismisses; navigation scrolls", () => {
  assert.equal(resultKeyAction("escape"), "dismiss")
  assert.equal(resultKeyAction("return"), "dismiss")
  assert.equal(resultKeyAction("enter"), "dismiss")
  assert.equal(resultKeyAction("q"), "dismiss")
  assert.equal(resultKeyAction("up"), "up")
  assert.equal(resultKeyAction("down"), "down")
  assert.equal(resultKeyAction("pageup"), "pageUp")
  assert.equal(resultKeyAction("pagedown"), "pageDown")
  assert.equal(resultKeyAction("a"), undefined)
})

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
  assert.deepEqual(filterEdit("a", { name: "", sequence: "~?" }), { query: "a", done: false, cancelled: false })
})
