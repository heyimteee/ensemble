import test from "node:test"
import assert from "node:assert/strict"
import { mapNativeChat, mergeDmTranscript } from "./dm.ts"
import type { ChatMessage } from "./types.ts"

const stored = (patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "dm_1",
  role: "user",
  author: "You",
  text: "Hello DM",
  createdAt: 100,
  ...patch,
})

test("native chat mapping keeps user and assistant text and drops the rest", () => {
  const mapped = mapNativeChat(
    [
      { id: "n1", type: "user", time: { created: 90 }, content: [{ type: "text", text: "Hello DM" }] },
      { id: "n2", type: "assistant", time: { created: 95 }, content: [{ type: "text", text: "Hi there" }] },
      { id: "n3", type: "idle", outcome: "succeeded", time: { created: 96 }, content: [] },
      { id: "n4", type: "assistant", time: { created: 97 }, content: [{ type: "tool", name: "x" }] },
      { id: "n5", type: "assistant", time: { created: 98 }, content: [{ type: "text", text: "   " }] },
      { id: "n6", type: "assistant", time: { created: 99 }, content: "not-an-array" },
    ],
    "Nova",
  )
  assert.deepEqual(mapped.map((message) => message.text), ["Hello DM", "Hi there"])
  assert.deepEqual(mapped.map((message) => message.role), ["user", "assistant"])
  assert.deepEqual(mapped.map((message) => message.author), ["You", "Nova"])
})

test("a stored user line renders exactly once when the native session echoes it", () => {
  const merged = mergeDmTranscript(
    [stored()],
    [
      { id: "n1", role: "user", author: "You", text: "Hello DM", createdAt: 90 },
      { id: "n2", role: "assistant", author: "Nova", text: "Hi there", createdAt: 150 },
    ],
  )
  assert.deepEqual(merged.map((message) => message.text), ["Hello DM", "Hi there"])
  assert.equal(merged.filter((message) => message.role === "user").length, 1)
})

test("native user content without a stored match never renders as a phantom line", () => {
  const merged = mergeDmTranscript(
    [stored()],
    [
      { id: "n1", role: "user", author: "You", text: "You are a focused teammate. Reply as a colleague.", createdAt: 50 },
      { id: "n2", role: "assistant", author: "Nova", text: "Ready.", createdAt: 150 },
    ],
  )
  assert.deepEqual(merged.map((message) => message.text), ["Hello DM", "Ready."])
})

test("merged transcript keeps a stable time order with user lines first on ties", () => {
  const merged = mergeDmTranscript(
    [stored({ id: "dm_2", text: "Second", createdAt: 200 }), stored({ id: "dm_1", text: "First", createdAt: 100 })],
    [{ id: "n1", role: "assistant", author: "Nova", text: "Reply", createdAt: 100 }],
  )
  assert.deepEqual(merged.map((message) => message.text), ["First", "Reply", "Second"])
})

test("queued user lines keep their queued flag through the merge", () => {
  const merged = mergeDmTranscript(
    [stored({ queued: true })],
    [{ id: "n1", role: "assistant", author: "Nova", text: "Reply", createdAt: 200 }],
  )
  assert.equal(merged[0].queued, true)
  assert.equal(merged[0].role, "user")
})
