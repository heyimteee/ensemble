import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { initialInteractionState, insertWithoutTarget, interactionReducer } from "./interaction.ts"
import {
  WIZARD_STEP_SETTLE_MS,
  WIZARD_STEP_SETTLE_OPACITY,
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
  wizardStepRail,
  wizardStepSettleMs,
  wizardStepSettleOpacity,
  wizardSuccessToast,
  wizardValidation,
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

test("the app gates wizard memory actions behind the memories step", () => {
  // Narrow wiring guard: the predicate itself is behavior-tested above and in
  // the live wizard walkthrough.
  const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8")
  assert.equal(
    (source.match(/case "wizard\.memory\.[a-z]+": if \(wizardIsMemoryStep\(\)\)/g) ?? []).length,
    3,
    "add, edit, and delete share the one guard",
  )
  assert.ok(source.includes("wizardIsMemoryStep() && wizard()!.memoryEditor"), "a stale memory editor cannot swallow Enter on another step")
})

test("the wizard step rail is a single line of one-cell step marks around the current step", () => {
  assert.equal(wizardStepRail(5, 0), "▣ ▫ ▫ ▫ ▫")
  assert.equal(wizardStepRail(5, 2), "▪ ▪ ▣ ▫ ▫")
  assert.equal(wizardStepRail(5, 4), "▪ ▪ ▪ ▪ ▣")
  assert.equal(wizardStepRail(5, 99), "▪ ▪ ▪ ▪ ▣", "the current cell clamps to the last step")
  assert.equal(wizardStepRail(5, -1), "▣ ▫ ▫ ▫ ▫", "the current cell clamps to the first step")
  assert.equal(wizardStepRail(0, 0), "", "an empty wizard has no rail")
  assert.ok(!wizardStepRail(6, 2).includes("\n"), "the rail is always one line")
  assert.equal(wizardStepRail(6, 2).split(" ").length, 6, "one cell per step")
})

test("the step settle is one shot and vanishes under reduced motion", () => {
  assert.equal(wizardStepSettleMs({}), WIZARD_STEP_SETTLE_MS)
  assert.ok(WIZARD_STEP_SETTLE_MS > 0 && WIZARD_STEP_SETTLE_MS <= 200, "the settle is short")
  assert.equal(wizardStepSettleMs({ ENSEMBLE_REDUCED_MOTION: "1" }), 0)
  assert.equal(wizardStepSettleMs({ NO_COLOR: "1" }), 0)
  assert.equal(wizardStepSettleOpacity(true), WIZARD_STEP_SETTLE_OPACITY)
  assert.equal(wizardStepSettleOpacity(false), 1)
})

test("workspace validation reports the first missing field without touching the draft", () => {
  const valid = draft({ directory: "/tmp/project", name: "Site", memberIDs: ["a"], leaderID: "a" })
  const before = structuredClone(valid)
  assert.deepEqual(wizardValidation({ flow: "workspace", draft: valid, agentNames: [], models: [] }), { error: undefined, stepKey: "" })
  assert.deepEqual(wizardValidation({ flow: "workspace", draft: draft({ directory: " " }), agentNames: [], models: [] }), { error: "Choose a workspace directory.", stepKey: "directory" })
  assert.deepEqual(wizardValidation({ flow: "workspace", draft: draft({ name: "Site", memberIDs: [], leaderID: "" }), agentNames: [], models: [] }), { error: "Choose at least one member.", stepKey: "members" })
  assert.deepEqual(wizardValidation({ flow: "workspace", draft: draft({ name: "Site", memberIDs: ["a"], leaderID: "b" }), agentNames: [], models: [] }), { error: "Choose a leader from the selected members.", stepKey: "leader" })
  assert.deepEqual(valid, before, "validation never mutates the entered values")
})

test("agent validation checks required text, unique names, and the live model variants", () => {
  const models = [{ key: "fake/m1", variants: ["low", "high"] }]
  const valid = draft({ name: "Nova", role: "Engineer", modelKey: "fake/m1", variant: "low" })
  assert.deepEqual(wizardValidation({ flow: "agent", draft: valid, agentNames: ["Other"], models }), { error: undefined, stepKey: "" })
  assert.deepEqual(wizardValidation({ flow: "agent", draft: draft({ name: " ", role: "Engineer" }), agentNames: [], models }), { error: "Agent name is required.", stepKey: "name" })
  assert.deepEqual(wizardValidation({ flow: "agent", draft: draft({ name: "Nova", role: " ", modelKey: "fake/m1" }), agentNames: [], models }), { error: "Agent role is required.", stepKey: "role" })
  assert.deepEqual(wizardValidation({ flow: "agent", draft: draft({ name: "Nova", role: "Engineer", modelKey: "" }), agentNames: [], models }), { error: "Choose a main model.", stepKey: "model" })
  assert.deepEqual(wizardValidation({ flow: "agent", draft: draft({ name: "nova", role: "Engineer", modelKey: "fake/m1" }), agentNames: ["Nova"], models }), { error: "An agent with that name already exists.", stepKey: "name" })
  assert.deepEqual(wizardValidation({ flow: "agent", draft: draft({ name: "Nova", role: "Engineer", modelKey: "fake/m1", variant: "max" }), agentNames: [], models }), { error: "Choose a reasoning effort.", stepKey: "variant" })
})

test("submitted wizards use one success toast per outcome", () => {
  assert.deepEqual(wizardSuccessToast("workspace-created", "Site"), { title: "Ensemble", message: "#Site created.", tone: "success" })
  assert.deepEqual(wizardSuccessToast("workspace-updated", "Site"), { title: "Ensemble", message: "#Site updated.", tone: "success" })
  assert.deepEqual(wizardSuccessToast("agent-created", "Nova"), { title: "Ensemble", message: "Nova created. Opening a direct chat.", tone: "success" })
  assert.deepEqual(wizardSuccessToast("agent-created", "Nova", 2), { title: "Ensemble", message: "Nova created. Opening a direct chat. Saved 2 memories.", tone: "success" })
})

test("closing a wizard overlay in Insert restores the composer focus", () => {
  let state = interactionReducer(initialInteractionState(), { type: "insert.enter" }).state
  state = interactionReducer(state, { type: "overlay.set", overlay: "wizard" }).state
  state = interactionReducer(state, { type: "field.enter", target: "wizard" }).state
  state = interactionReducer(state, { type: "field.leave" }).state
  const closed = interactionReducer(state, { type: "overlay.set", overlay: "none" })
  assert.equal(closed.state.mode, "insert", "closing the wizard never assigns a mode")
  assert.equal(closed.state.focus, "composer")
  assert.deepEqual(closed.intents.at(-1), { type: "focus-editor", target: "composer" })
})

test("the wizard renders its step rail and sends success through the app toast", () => {
  // Narrow wiring guards only: the rail and submit feedback behavior are
  // covered by the pure wizard tests and the fake live scenario.
  const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8")
  assert.ok(source.includes("wizardStepRail(wizard()!.steps.length, wizard()!.index)"), "the header renders the current step rail")
  assert.ok(source.includes("showToast(wizardSuccessToast("), "submitted wizards use the app toast")
})
