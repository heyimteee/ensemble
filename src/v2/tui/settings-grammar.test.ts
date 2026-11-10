import test from "node:test"
import assert from "node:assert/strict"
import {
  SETTINGS_TABS,
  clampSettingsRow,
  moveSettingsRow,
  normalizeSettingsField,
  settingsAddAction,
  settingsDeleteAction,
  settingsFieldAtRow,
  settingsFieldLabel,
  settingsFilterable,
  settingsPromoteAction,
  settingsReorderAction,
  reorderBackupList,
  settingsRowCount,
  settingsRowKind,
  settingsTabAfterKey,
  settingsTabStep,
  settingsToggleAction,
} from "./settings-grammar.ts"

const counts = (patch: Partial<{ backups: number; memories: number; skills: number }> = {}) => ({
  backups: 0,
  memories: 0,
  skills: 0,
  ...patch,
})

test("h/l and Tab cycle the four settings tabs with wraparound", () => {
  assert.deepEqual([...SETTINGS_TABS], ["general", "models", "memories", "skillbox"])
  assert.equal(settingsTabStep("general", 1), "models")
  assert.equal(settingsTabStep("skillbox", 1), "general", "Tab wraps forward")
  assert.equal(settingsTabStep("general", -1), "skillbox", "h wraps backward")
  assert.equal(settingsTabAfterKey("general", "l"), "models")
  assert.equal(settingsTabAfterKey("models", "h"), "general")
  assert.equal(settingsTabAfterKey("models", "tab"), "memories")
  assert.equal(settingsTabAfterKey("memories", "shift+tab"), "models")
  assert.equal(settingsTabAfterKey("memories", "j"), null, "j/k never switch tabs")
})

test("each tab names its rows and cursor movement clamps at both ends", () => {
  assert.equal(settingsRowCount("general", counts()), 6, "four identity fields plus model and mirror rows")
  assert.equal(settingsRowCount("models", counts({ backups: 2 })), 3, "main plus two backups")
  assert.equal(settingsRowCount("memories", counts({ memories: 4 })), 4)
  assert.equal(settingsRowCount("skillbox", counts({ skills: 7 })), 7)

  assert.equal(settingsRowKind("general", 0, counts()), "field")
  assert.equal(settingsRowKind("general", 3, counts()), "field")
  assert.equal(settingsRowKind("general", 4, counts()), "model")
  assert.equal(settingsRowKind("general", 5, counts()), "toggle", "the native mirror row is a toggle")
  assert.equal(settingsFieldAtRow(0), "name")
  assert.equal(settingsFieldAtRow(2), "role")
  assert.equal(settingsFieldAtRow(4), null, "the model row opens the picker, not a text field")
  assert.equal(settingsRowKind("models", 0, counts({ backups: 2 })), "model")
  assert.equal(settingsRowKind("models", 2, counts({ backups: 2 })), "backup")
  assert.equal(settingsRowKind("memories", 0, counts({ memories: 1 })), "memory")
  assert.equal(settingsRowKind("skillbox", 2, counts({ skills: 3 })), "skill")
  assert.equal(settingsRowKind("memories", 0, counts()), "none", "an empty tab has no rows")

  assert.equal(moveSettingsRow(0, 1, 5), 1)
  assert.equal(moveSettingsRow(4, 1, 5), 4, "j never leaves the last row")
  assert.equal(moveSettingsRow(0, -1, 5), 0, "k never leaves the first row")
  assert.equal(clampSettingsRow(9, 3), 2)
  assert.equal(clampSettingsRow(3, 0), 0, "an empty list keeps a stable zero cursor")
})

test("a adds on memory and backup tabs; x deletes there; / and Space are tab-scoped", () => {
  assert.equal(settingsAddAction("models"), "backup")
  assert.equal(settingsAddAction("memories"), "memory")
  assert.equal(settingsAddAction("general"), "none")
  assert.equal(settingsAddAction("skillbox"), "none")
  assert.equal(settingsDeleteAction("models"), "backup")
  assert.equal(settingsDeleteAction("memories"), "memory")
  assert.equal(settingsDeleteAction("general"), "none")
  assert.equal(settingsFilterable("memories"), true)
  assert.equal(settingsFilterable("skillbox"), true)
  assert.equal(settingsFilterable("general"), false)
  assert.equal(settingsFilterable("models"), false)
  assert.equal(settingsToggleAction("skillbox"), "skill")
  assert.equal(settingsToggleAction("general"), "none")
})

test("text fields normalize before they reach the draft", () => {
  assert.equal(settingsFieldLabel("name"), "Name")
  assert.equal(settingsFieldLabel("role"), "Role")
  assert.equal(normalizeSettingsField("name", "  Fake   Agent  "), "Fake Agent", "single-line identity fields collapse whitespace")
  assert.equal(normalizeSettingsField("color", "cyan\n"), "cyan")
  assert.equal(normalizeSettingsField("role", "  Writes code.\n  Reviews it.  "), "Writes code.\n  Reviews it.", "roles keep intentional line breaks")
})

test("promote is a memory action; backup reorder is a models action", () => {
  assert.equal(settingsPromoteAction("memories"), "memory")
  assert.equal(settingsPromoteAction("models"), "none")
  assert.equal(settingsPromoteAction("general"), "none")
  assert.equal(settingsPromoteAction("skillbox"), "none")
  assert.equal(settingsReorderAction("models"), "backup")
  assert.equal(settingsReorderAction("memories"), "none")
  assert.equal(settingsReorderAction("general"), "none")
  assert.equal(settingsReorderAction("skillbox"), "none")
})

test("backup reorder moves one slot and stops at the ends", () => {
  assert.deepEqual(reorderBackupList(["low", "medium", "high"], 0, "down"), {
    backups: ["medium", "low", "high"],
    index: 1,
  })
  assert.deepEqual(reorderBackupList(["low", "medium", "high"], 2, "up"), {
    backups: ["low", "high", "medium"],
    index: 1,
  })
  assert.equal(reorderBackupList(["low", "medium"], 1, "down"), null, "the last backup cannot move down")
  assert.equal(reorderBackupList(["low", "medium"], 0, "up"), null, "the first backup cannot move up")
  assert.equal(reorderBackupList(["low"], 3, "down"), null, "out-of-range rows are rejected")
  assert.equal(reorderBackupList([], 0, "down"), null)
})
