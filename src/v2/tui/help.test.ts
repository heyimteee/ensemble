import test from "node:test"
import assert from "node:assert/strict"
import { helpGroups, shortcutGroups } from "./help.ts"

test("shortcut help includes workspace and agent destructive actions", () => {
  const keys = shortcutGroups.flatMap((group) => group.entries.map((entry) => entry[0]))
  for (const key of ["Ctrl+W", "Ctrl+Shift+W", "Ctrl+A", "Ctrl+Shift+A", "Ctrl+Shift+Delete", "End", "Ctrl+←", "Ctrl+→"]) {
    assert.ok(keys.includes(key), key)
  }
})

test("shortcut search fuzzy-filters by action and key", () => {
  assert.ok(helpGroups("delete workspace").some((group) => group.entries.some((entry) => entry[0] === "Ctrl+Shift+W")))
  assert.ok(helpGroups("archive agent").some((group) => group.entries.some((entry) => entry[0] === "Ctrl+A")))
  assert.deepEqual(helpGroups(""), shortcutGroups)
})
