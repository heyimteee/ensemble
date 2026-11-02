import test from "node:test"
import assert from "node:assert/strict"
import { registerLiveSlot, type LiveSlot } from "./live-slot.ts"

const message = (id: string) => ({
  id,
  workspaceID: "w",
  seq: 1,
  author: "agent" as const,
  text: "partial",
  kind: "text" as const,
  createdAt: 1,
})

test("registering over an empty session installs a fresh slot with no orphan", () => {
  const slots = new Map<string, LiveSlot>()
  const { slot, orphaned } = registerLiveSlot(slots, "session_1", 100)
  assert.equal(orphaned, undefined)
  assert.equal(slot.message, undefined)
  assert.equal(slot.buffer, "")
  assert.equal(slots.get("session_1"), slot)
})

test("registering over an occupied slot orphans the opening row instead of dropping it", () => {
  const slots = new Map<string, LiveSlot>()
  const first = registerLiveSlot(slots, "session_1", 100)
  first.slot.message = message("live_1")
  first.slot.buffer = "partial text"
  const second = registerLiveSlot(slots, "session_1", 200)
  assert.ok(second.orphaned)
  assert.equal(second.orphaned.message.id, "live_1")
  assert.equal(second.orphaned.buffer, "partial text")
  assert.equal(second.slot.message, undefined)
  assert.equal(slots.get("session_1"), second.slot)
})

test("a slot with no opening row yet leaves no orphan", () => {
  const slots = new Map<string, LiveSlot>()
  const first = registerLiveSlot(slots, "session_1", 100)
  first.slot.buffer = "early delta"
  const second = registerLiveSlot(slots, "session_1", 200)
  assert.equal(second.orphaned, undefined)
})
