import test from "node:test"
import assert from "node:assert/strict"
import { wizardFilterText } from "./wizard.ts"

test("wizard filter appends printable characters without modifiers", () => {
  assert.equal(wizardFilterText({ sequence: "a" }), "a")
  assert.equal(wizardFilterText({ sequence: "A" }), "A")
  assert.equal(wizardFilterText({ sequence: "~?" }), undefined)
  assert.equal(wizardFilterText({ sequence: "" }), undefined)
  assert.equal(wizardFilterText(undefined), undefined)
})

test("wizard filter ignores modifier chords instead of throwing", () => {
  assert.equal(wizardFilterText({ sequence: "a", ctrl: true }), undefined)
  assert.equal(wizardFilterText({ sequence: "a", meta: true }), undefined)
  assert.equal(wizardFilterText({ sequence: "a", super: true }), undefined)
  assert.equal(wizardFilterText({ sequence: "a", ctrl: false }), "a")
})
