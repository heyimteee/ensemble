import test from "node:test"
import assert from "node:assert/strict"
import { helpKeyLabel, helpGroups, shortcutGroups } from "./help.ts"

test("shortcut help includes workspace and agent destructive actions", () => {
  const keys = shortcutGroups.flatMap((group) => group.entries.map((entry) => entry[0]))
  for (const key of ["Ctrl+W", "Ctrl+Shift+W", "Ctrl+A", "Ctrl+Shift+A", "Ctrl+Shift+Delete", "End", "Ctrl+P", "Ctrl+N", "F2", "Ctrl+G"]) {
    assert.ok(keys.includes(key), key)
  }
})

test("help labels keep wizard navigation truthful on macOS", () => {
  assert.equal(helpKeyLabel("Ctrl+N", true), "Ctrl+N")
  assert.equal(helpKeyLabel("Ctrl+P", true), "Ctrl+P")
  assert.equal(helpKeyLabel("Ctrl+D / Ctrl+U", true), "Ctrl+D / Ctrl+U")
  assert.equal(helpKeyLabel("Ctrl+W", true), "Cmd+W")
  assert.equal(helpKeyLabel("Ctrl+W", false), "Ctrl+W")
})

test("shortcut help documents Space as the leader and retires the tilde prefix", () => {
  const keys = shortcutGroups.flatMap((group) => group.entries.map((entry) => entry[0]))
  assert.ok(keys.includes("Space"), "leader key is Space")
  assert.ok(keys.includes("Space q"), "quit moves to the leader")
  assert.ok(!keys.some((key) => key.includes("~")), "no ~ bindings remain")
})

test("shortcut search fuzzy-filters by action and key", () => {
  assert.ok(helpGroups("delete workspace").some((group) => group.entries.some((entry) => entry[0] === "Ctrl+Shift+W")))
  assert.ok(helpGroups("archive agent").some((group) => group.entries.some((entry) => entry[0] === "Ctrl+A")))
  assert.deepEqual(helpGroups(""), shortcutGroups)
})
