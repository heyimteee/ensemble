import test from "node:test"
import assert from "node:assert/strict"
import { overlayGeometry, sameWizardOptions, wizardEnterAction, wizardMemoryLines, wizardModelEmptyHint, wizardModelKeyFor, wizardModelOptions } from "./wizard.ts"

test("overlay geometry centers a bounded box and recomputes on resize", () => {
  const wide = overlayGeometry(200, 60, 20)
  assert.equal(wide.width, 96)
  assert.equal(wide.left, Math.floor((200 - 96) / 2))
  assert.equal(wide.top, 20)

  const narrow = overlayGeometry(100, 40, 20)
  assert.equal(narrow.width, 70)
  assert.equal(narrow.left, 15)
  assert.equal(narrow.top, 10)

  const small = overlayGeometry(60, 20, 20)
  assert.equal(small.width, 48)
  assert.ok(small.left >= 1 && small.left + small.width <= 60)
  assert.equal(small.top, 1)
})

test("wizard model options derive from the live catalog", () => {
  const first = wizardModelOptions([{ providerID: "fake", modelID: "m1", name: "One" }])
  assert.deepEqual(first, [{ id: "fake/m1", label: "One · fake/m1" }])
  const second = wizardModelOptions([
    { providerID: "fake", modelID: "m1", name: "One" },
    { providerID: "fake", modelID: "m2", name: "Two" },
  ])
  assert.equal(sameWizardOptions(first, first), true)
  assert.equal(sameWizardOptions(first, second), false)
  // A still-valid choice survives a refresh; a missing choice falls back safely.
  assert.equal(wizardModelKeyFor("fake/m2", second), "fake/m2")
  assert.equal(wizardModelKeyFor("", second), "fake/m1")
  assert.equal(wizardModelKeyFor("gone/model", second), "fake/m1")
  assert.equal(wizardModelKeyFor("fake/m1", []), "")
})

test("an empty model step explains why instead of showing a bare zero", () => {
  assert.match(wizardModelEmptyHint(undefined), /No models reported by OpenCode yet/)
  assert.match(wizardModelEmptyHint("  "), /refresh automatically/)
  const explained = wizardModelEmptyHint("OpenCode reported no models for this project.")
  assert.match(explained, /No models available/)
  assert.match(explained, /OpenCode reported no models/)
})

test("enter owns selection, continue, and submit on non-text steps", () => {
  assert.equal(wizardEnterAction("choice", false), "select")
  assert.equal(wizardEnterAction("pick", false), "select")
  assert.equal(wizardEnterAction("multi", false), "continue")
  assert.equal(wizardEnterAction("choice", true), "submit")
  assert.equal(wizardEnterAction("pick", true), "submit")
  assert.equal(wizardEnterAction("multi", true), "submit")
})

test("text steps keep enter for continue handled by the field", () => {
  assert.equal(wizardEnterAction("text", false), "text")
  assert.equal(wizardEnterAction("text", true), "text")
})

test("wizard memory lines split one-per-line and skip blanks", () => {
  assert.deepEqual(wizardMemoryLines("pnpm only\n\n  never edit dist  \n"), ["pnpm only", "never edit dist"])
  assert.deepEqual(wizardMemoryLines(""), [])
  assert.deepEqual(wizardMemoryLines("one\r\ntwo"), ["one", "two"])
})
