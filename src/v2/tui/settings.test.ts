import test from "node:test"
import assert from "node:assert/strict"
import {
  SETTINGS_LABEL_WIDTH,
  backupRowLabel,
  generalFieldRows,
  memoriesEmptyLine,
  memoriesNoMatchLine,
  modelPickerLabel,
  modelSummary,
  modelsEmptyLine,
  modelsSectionCount,
  railGroupLine,
  settingsCursorMark,
  settingsDivider,
  settingsFieldRow,
  settingsHeader,
  settingsLoadingLine,
  settingsNoAgentLine,
  settingsSectionHeader,
  skillsUnavailableLine,
  sortModelsByProvider,
} from "./settings.ts"
import type { ModelOption } from "../types.ts"

const model = (patch: Partial<ModelOption> = {}): ModelOption => ({
  providerID: "ensemble-fake",
  modelID: "ensemble-fake-model",
  name: "Ensemble Fake Model",
  variants: ["low", "medium", "high"],
  ...patch,
})

test("the selection marker is one consistent grammar across settings surfaces", () => {
  assert.equal(settingsCursorMark(true), "› ")
  assert.equal(settingsCursorMark(false), "  ")
})

test("the settings header names the agent, dirty, saved, and pending states", () => {
  assert.equal(settingsHeader("FakeAgent", false, false), "FakeAgent │ settings")
  assert.ok(settingsHeader("FakeAgent", true, false).includes("UNSAVED"), "dirty names UNSAVED")
  assert.ok(
    settingsHeader("FakeAgent", false, true).includes("pending next message"),
    "pending names the next-message deferral",
  )
  assert.equal(settingsHeader("FakeAgent", true, true), "FakeAgent │ settings │ UNSAVED │ pending next message")
  assert.equal(settingsHeader("FakeAgent", false, false, true), "FakeAgent │ settings │ Saved")
  assert.equal(
    settingsHeader("FakeAgent", true, false, true),
    "FakeAgent │ settings │ UNSAVED",
    "a new edit supersedes the previous saved state",
  )
})

test("every tab renders a section header carrying its counts", () => {
  const counts = (patch: Partial<{ memories: number; backups: number; assigned: number; catalog: number }> = {}) => ({
    memories: 0,
    backups: 0,
    assigned: 0,
    catalog: 0,
    ...patch,
  })
  assert.ok(settingsSectionHeader("general", counts()).length > 0, "general names its section")
  assert.ok(
    settingsSectionHeader("models", counts()).includes("0 backups"),
    `models names the backup count: ${settingsSectionHeader("models", counts())}`,
  )
  assert.ok(
    settingsSectionHeader("models", counts()).includes("main"),
    "models names the main slot",
  )
  assert.ok(
    settingsSectionHeader("memories", counts({ memories: 3 })).includes("(3)"),
    "memories carries the live total",
  )
  const skillbox = settingsSectionHeader("skillbox", counts({ assigned: 2, catalog: 9 }))
  assert.ok(skillbox.includes("2/9"), `skillbox carries assigned/catalog: ${skillbox}`)
  const general = settingsSectionHeader("general", counts())
  assert.notEqual(general, settingsSectionHeader("models", counts()), "sections differ per tab")
})

test("label/value rows share one aligned column width", () => {
  assert.ok(SETTINGS_LABEL_WIDTH >= 10, "labels fit Backup-sized keys")
  const name = settingsFieldRow("Name", "FakeAgent")
  const title = settingsFieldRow("Title", "Engineering")
  const labelOf = (row: string): string => row.slice(0, SETTINGS_LABEL_WIDTH)
  assert.equal(labelOf(name), "Name      ", "labels pad to the shared column")
  assert.equal(labelOf(title), "Title     ", "shorter labels pad to the same column")
  const valueAt = (row: string): string => row.slice(SETTINGS_LABEL_WIDTH + 1)
  assert.equal(valueAt(name), "FakeAgent", "values start at one shared column")
  assert.equal(valueAt(title), "Engineering", "values align across rows")
})

test("general rows summarize identity, role, color, and model with clear labels", () => {
  const rows = generalFieldRows(
    { name: "FakeAgent", title: "Engineering", role: "Renders.", color: "cyan" },
    { providerID: "ensemble-fake", modelID: "ensemble-fake-model" },
  )
  const labels = rows.map(([label]) => label)
  for (const expected of ["Name", "Title", "Role", "Color", "Model"]) {
    assert.ok(labels.includes(expected), `general names ${expected}: ${labels.join(",")}`)
  }
  const byLabel = new Map(rows)
  assert.equal(byLabel.get("Model"), "ensemble-fake/ensemble-fake-model", "model reads provider/model")
  const long = generalFieldRows(
    { name: "A", title: "", role: `x`.repeat(200), color: "cyan" },
    { providerID: "p", modelID: "m" },
  )
  assert.ok((new Map(long).get("Role") ?? "").endsWith("…"), "long roles truncate with an ellipsis")
})

test("model summaries carry provider, id, and variant info", () => {
  assert.equal(modelSummary({ providerID: "p", modelID: "m" }), "p/m")
  assert.equal(
    modelSummary({ providerID: "p", modelID: "m", variant: "high" }),
    "p/m#high",
    "variant info survives the summary",
  )
  assert.equal(backupRowLabel(0, { providerID: "p", modelID: "m" }), "Backup 1: p/m")
  assert.equal(
    backupRowLabel(1, { providerID: "p", modelID: "m", variant: "low" }),
    "Backup 2: p/m#low",
    "backup rows carry their variant",
  )
  assert.equal(modelsSectionCount(0), "main + 0 backups")
  assert.equal(modelsSectionCount(2), "main + 2 backups")
  assert.equal(modelsEmptyLine(), "No backups yet. a adds one.")
})

test("state lines share one grammar: empty, loading, unavailable, and no-agent", () => {
  assert.equal(memoriesEmptyLine(), "No memories yet. a adds one.")
  assert.equal(memoriesNoMatchLine(), "No matching memories — refine filter.")
  assert.ok(modelsEmptyLine().includes("a adds one"), "models empty names the fix key")
  assert.ok(settingsLoadingLine().includes("…"), "loading reads as in-flight work")
  assert.ok(settingsNoAgentLine().includes("s"), "no-agent names the open key")
  assert.ok(skillsUnavailableLine().length > 0, "unavailable catalog has a line")
  assert.ok(
    !skillsUnavailableLine().includes("refine filter"),
    "an empty catalog does not blame the filter",
  )
})

test("the agent list shows group counts and agent descriptions", () => {
  assert.equal(railGroupLine("agent", 3), "AGENTS (3)")
  assert.equal(railGroupLine("workspace", 1), "WORKSPACES (1)")
})

test("the model picker groups by provider with variant info", () => {
  assert.equal(
    modelPickerLabel(model()),
    "Ensemble Fake Model — ensemble-fake/ensemble-fake-model │ 3 variants",
  )
  assert.equal(
    modelPickerLabel(model({ variants: ["low"] })),
    "Ensemble Fake Model — ensemble-fake/ensemble-fake-model │ 1 variant",
  )
  assert.equal(
    modelPickerLabel(model({ name: "Plain", variants: [] })),
    "Plain — ensemble-fake/ensemble-fake-model",
  )
  const sorted = sortModelsByProvider([
    model({ providerID: "zebra", modelID: "b", name: "Z" }),
    model({ providerID: "alpha", modelID: "b", name: "A2" }),
    model({ providerID: "alpha", modelID: "a", name: "A1" }),
  ])
  assert.deepEqual(
    sorted.map((entry) => entry.name),
    ["A1", "A2", "Z"],
    "providers group, then models sort within the provider",
  )
})

test("the divider is one shared rule, not ad-hoc separators", () => {
  const divider = settingsDivider()
  assert.ok(divider.length >= 24, "divider spans the card")
  assert.ok(/^[─-]+$/.test(divider), `divider uses one rule character: ${divider}`)
  assert.equal(settingsDivider(), divider, "divider is deterministic")
})
