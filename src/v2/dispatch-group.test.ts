import test from "node:test"
import assert from "node:assert/strict"
import {
  DISPATCH_GROUP_PREFIX,
  dispatchGroupIDFor,
  inheritDispatchGroupID,
  legacyDispatchGroupID,
  newDispatchGroupID,
  resolveDispatchGroupID,
} from "./dispatch-group.ts"
import type { Subtask } from "./types.ts"

const task = (id: string, patch: Partial<Subtask> = {}): Subtask => ({
  id,
  workspaceID: "w",
  creatorType: "user",
  title: id,
  instruction: id,
  mode: "research",
  state: "pending",
  stage: "initial",
  outcome: "pending",
  interrupted: false,
  awaitingChildren: false,
  attempts: 0,
  createdAt: 1,
  ...patch,
})

test("new dispatch groups are distinct, non-empty, and clearly namespaced", () => {
  const first = newDispatchGroupID()
  const second = newDispatchGroupID()
  assert.ok(first.startsWith(DISPATCH_GROUP_PREFIX))
  assert.ok(second.startsWith(DISPATCH_GROUP_PREFIX))
  assert.notEqual(first, second)
})

test("an explicit group wins and descendants inherit the nearest stored group", () => {
  const root = task("root", { dispatchGroupID: "dispatch_root" })
  const child = task("child", { parentID: "root" })
  const grandchild = task("grandchild", { parentID: "child", dispatchGroupID: "dispatch_explicit" })
  const index = { root, child, grandchild }
  assert.equal(dispatchGroupIDFor(root, index), "dispatch_root")
  assert.equal(dispatchGroupIDFor(child, index), "dispatch_root")
  assert.equal(dispatchGroupIDFor(grandchild, index), "dispatch_explicit")
  assert.equal(resolveDispatchGroupID(child, index), "dispatch_root")
})

test("legacy rows derive one deterministic group from their root ancestor", () => {
  const root = task("legacy-root")
  const child = task("legacy-child", { parentID: "legacy-root" })
  const grandchild = task("legacy-grandchild", { parentID: "legacy-child" })
  const other = task("other-root")
  const index = { [root.id]: root, [child.id]: child, [grandchild.id]: grandchild, [other.id]: other }
  const expected = legacyDispatchGroupID("legacy-root")
  assert.equal(resolveDispatchGroupID(root, index), expected)
  assert.equal(resolveDispatchGroupID(child, index), expected)
  assert.equal(resolveDispatchGroupID(grandchild, index), expected)
  assert.equal(legacyDispatchGroupID("legacy-root"), expected)
  assert.notEqual(resolveDispatchGroupID(other, index), expected)
  assert.ok(!expected.includes("legacy-root"))
})

test("a legacy child joins a stored ancestor group rather than minting a new one", () => {
  const root = task("root", { dispatchGroupID: "dispatch_stored" })
  const child = task("child", { parentID: "root" })
  const index = { root, child }
  assert.equal(resolveDispatchGroupID(child, index), "dispatch_stored")
})

test("inheritance prefers an explicit group, then the parent group, then mints once", () => {
  const root = task("root", { dispatchGroupID: "dispatch_root" })
  const child = task("child", { parentID: "root" })
  const index = { root, child }
  let minted = 0
  const mint = () => {
    minted++
    return "dispatch_minted"
  }
  assert.equal(inheritDispatchGroupID({ explicit: "dispatch_explicit", parent: child, subtasks: index, mint }), "dispatch_explicit")
  assert.equal(inheritDispatchGroupID({ parent: child, subtasks: index, mint }), "dispatch_root")
  assert.equal(inheritDispatchGroupID({ subtasks: index, mint }), "dispatch_minted")
  assert.equal(minted, 1)
})

test("missing and cyclic parent links resolve without hanging", () => {
  const orphan = task("orphan", { parentID: "missing" })
  const loopA = task("loop-a", { parentID: "loop-b" })
  const loopB = task("loop-b", { parentID: "loop-a" })
  const index = { orphan, "loop-a": loopA, "loop-b": loopB }
  assert.equal(resolveDispatchGroupID(orphan, index), legacyDispatchGroupID("orphan"))
  assert.ok(resolveDispatchGroupID(loopA, index))
  assert.ok(resolveDispatchGroupID(loopB, index))
})

test("blank and non-string group fields are treated as absent", () => {
  const blank = task("blank", { dispatchGroupID: "   " })
  const index = { blank }
  assert.equal(dispatchGroupIDFor(blank, index), undefined)
  assert.equal(resolveDispatchGroupID(blank, index), legacyDispatchGroupID("blank"))
})
