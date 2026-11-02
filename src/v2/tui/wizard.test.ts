import test from "node:test"
import assert from "node:assert/strict"
import { WIZARD_NAV_BINDINGS, overlayGeometry, sameWizardOptions, wizardFilterText, wizardModelEmptyHint, wizardModelKeyFor, wizardModelOptions, wizardNavHint } from "./wizard.ts"
import { platformBind } from "./platform.ts"

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

test("wizard navigation uses one universal Ctrl pair with truthful labels", () => {
  assert.equal(WIZARD_NAV_BINDINGS.back, "ctrl+p")
  assert.equal(WIZARD_NAV_BINDINGS.next, "ctrl+n")
  const hint = wizardNavHint(false)
  assert.ok(hint.startsWith("Ctrl+N next · Ctrl+P back"), hint)
  assert.doesNotMatch(hint, /Cmd/)
  assert.match(hint, /enter continue/)
  assert.match(wizardNavHint(true), /enter submit/)
  // The generic platform transform would rewrite ctrl+ to super+ on macOS;
  // the wizard layer deliberately bypasses it because Cmd never reaches the TUI.
  assert.equal(platformBind(WIZARD_NAV_BINDINGS.next, true), "super+n")
})

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
