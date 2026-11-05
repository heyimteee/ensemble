import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { initialInteractionState, insertWithoutTarget, interactionReducer } from "./interaction.ts"
import {
  addWizardMemory,
  clampWizardMemoryCursor,
  deleteWizardMemory,
  isWizardMemoryStep,
  overlayGeometry,
  sameWizardOptions,
  updateWizardMemory,
  wizardDraftDirty,
  wizardEnterAction,
  wizardModelEmptyHint,
  wizardModelKeyFor,
  wizardModelOptions,
  wizardMemorySaveList,
  wizardStepArrival,
} from "./wizard.ts"

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
  assert.deepEqual(first, [{ id: "fake/m1", label: "One │ fake/m1" }])
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

test("wizard memory list adds, edits, deletes, and clamps one-by-one entries", () => {
  const first = addWizardMemory([], "  pnpm only  ")
  assert.deepEqual(first, ["pnpm only"])
  const second = addWizardMemory(first, "never edit dist")
  assert.deepEqual(second, ["pnpm only", "never edit dist"])
  assert.deepEqual(addWizardMemory(second, "   "), second, "blank entries never enter the list")

  assert.deepEqual(updateWizardMemory(second, 0, " pnpm only v2 "), ["pnpm only v2", "never edit dist"])
  assert.deepEqual(updateWizardMemory(second, 9, "ignored"), second, "an invalid edit leaves the list alone")
  assert.deepEqual(updateWizardMemory(second, 1, ""), second, "an empty edit never erases the entry")

  assert.deepEqual(deleteWizardMemory(second, 0), ["never edit dist"])
  assert.deepEqual(deleteWizardMemory(second, 7), second, "an invalid delete leaves the list alone")

  assert.equal(clampWizardMemoryCursor(4, 3), 2)
  assert.equal(clampWizardMemoryCursor(-1, 3), 0)
  assert.equal(clampWizardMemoryCursor(2, 0), 0)
})

test("wizard step arrival keeps the mode and only focuses a text target", () => {
  const textArrival = wizardStepArrival("text")
  const insert = interactionReducer(initialInteractionState({ mode: "insert", overlay: "wizard" }), textArrival)
  assert.equal(insert.state.mode, "insert", "arriving at a text step never assigns the mode")
  assert.equal(insert.state.field, "wizard")
  assert.deepEqual(insert.intents, [{ type: "focus-editor", target: "wizard" }])

  const normal = interactionReducer(initialInteractionState({ mode: "normal", overlay: "wizard" }), textArrival)
  assert.equal(normal.state.mode, "normal", "Normal arrival stays Normal")
  assert.equal(normal.state.field, "wizard", "the text field keeps the caret in Normal")

  const listArrival = wizardStepArrival("memories")
  const list = interactionReducer(initialInteractionState({ mode: "insert", overlay: "wizard" }), listArrival)
  assert.equal(list.state.mode, "insert", "a list step never changes the arrival mode")
  assert.equal(list.state.field, null)
  assert.equal(insertWithoutTarget(list.state), true, "Insert on a list step is honest about no target")
  assert.deepEqual(list.intents, [{ type: "blur-editor" }])
})

const draft = (overrides: Record<string, unknown> = {}) => ({
  directory: "/tmp/project",
  name: "",
  title: "",
  role: "",
  memberIDs: [] as string[],
  leaderID: "",
  synthesis: true,
  memories: [] as string[],
  modelKey: "fake/m1",
  variant: "none",
  ...overrides,
})

test("wizard memories save one by one and an empty list skips", () => {
  assert.deepEqual(wizardMemorySaveList([]), [])
  assert.deepEqual(wizardMemorySaveList(["  ", ""]), [], "blank entries never save")
  assert.deepEqual(wizardMemorySaveList([" pnpm only ", "never edit dist", "  "]), ["pnpm only", "never edit dist"])
})

test("wizard dirty compares the draft with the draft opened", () => {
  const initial = draft()
  assert.equal(wizardDraftDirty(initial, draft()), false)
  assert.equal(wizardDraftDirty(initial, draft({ name: "Nova" })), true)
  assert.equal(wizardDraftDirty(initial, draft({ memories: ["pnpm only"] })), true)
  assert.equal(wizardDraftDirty(initial, draft({ memberIDs: ["a"], leaderID: "a" })), true)
  assert.equal(wizardDraftDirty(draft({ name: "Nova" }), draft({ name: "Nova" })), false, "an edit wizard that is unchanged is clean")
})

test("memory actions only exist on the memories step", () => {
  assert.equal(isWizardMemoryStep("memories"), true)
  for (const step of ["name", "title", "role", "model", "variant", "directory", "members", "leader", undefined]) {
    assert.equal(isWizardMemoryStep(step), false, `${step} is not a memory step`)
  }
})

test("the app guards every memory action and the Enter path behind the memories step", () => {
  const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8")
  for (const fn of ["openWizardMemoryField", "wizardMemoryStartEdit", "wizardMemoryDelete", "wizardMemorySubmit", "wizardMemoryClose"]) {
    const declaration = source.indexOf(`const ${fn} =`)
    assert.ok(declaration >= 0, `${fn} exists`)
    const body = source.slice(declaration, declaration + 400)
    assert.ok(body.includes("wizardIsMemoryStep()"), `${fn} checks wizardIsMemoryStep() before acting`)
  }
  const add = source.indexOf("const wizardMemoryStartAdd")
  assert.ok(source.slice(add, add + 200).includes("openWizardMemoryField"), "add delegates to the guarded field opener")
  const actions = source.indexOf('case "wizard.memory.add"')
  for (const id of ["add", "edit", "delete"]) {
    assert.ok(source.includes(`case "wizard.memory.${id}": if (wizardIsMemoryStep())`), `${id} action is guarded in runDialogAction`)
  }
  assert.ok(source.includes("wizardIsMemoryStep() && wizard()!.memoryEditor"), "a stale memory editor cannot swallow Enter on another step")
})
