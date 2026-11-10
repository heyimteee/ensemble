import test from "node:test"
import assert from "node:assert/strict"
import {
  DIRECT_CHANNEL_PREFIX,
  chatLineFromMessage,
  directMessageChannel,
  directMessageChannelForBinding,
  dmChannelReadMode,
  isDirectMessageChannel,
  messageChannel,
  projectDirectLines,
} from "./message-channel.ts"
import type { ChatMessage, Message } from "./types.ts"

test("ticket212: a direct conversation channel is keyed by agent and optional workspace", () => {
  assert.equal(directMessageChannel("a"), `${DIRECT_CHANNEL_PREFIX}a`)
  assert.equal(directMessageChannel("a", "w"), `${DIRECT_CHANNEL_PREFIX}a:w`)
  assert.equal(directMessageChannelForBinding("home", "a"), directMessageChannel("a"))
  assert.equal(directMessageChannelForBinding("w", "a"), directMessageChannel("a", "w"))
  assert.equal(isDirectMessageChannel(directMessageChannel("a", "w")), true)
  assert.equal(isDirectMessageChannel("w"), false)
})

test("ticket212: a group message uses its workspace as the channel and a direct row keeps its channel", () => {
  assert.equal(messageChannel({ workspaceID: "w" }), "w")
  assert.equal(messageChannel({ workspaceID: "w", channel: "dm:a:w" }), "dm:a:w")
})

test("ticket212: the direct-channel read flag defaults to the legacy path", () => {
  assert.equal(dmChannelReadMode(undefined), "off")
  assert.equal(dmChannelReadMode(""), "off")
  assert.equal(dmChannelReadMode("off"), "off")
  assert.equal(dmChannelReadMode("shadow"), "shadow")
  assert.equal(dmChannelReadMode("ON"), "on")
  assert.equal(dmChannelReadMode("unexpected"), "off")
})

test("ticket212: the compatibility projection prefers durable rows without losing legacy lines", () => {
  const legacy: ChatMessage[] = [
    { id: "dm_1", role: "user", author: "You", text: "before migration", createdAt: 1 },
    { id: "dm_2", role: "user", author: "You", text: "stale legacy copy", createdAt: 2 },
  ]
  const durable: ChatMessage[] = [
    { id: "dm_2", role: "user", author: "You", text: "durable copy", createdAt: 2 },
    { id: "dm_3", role: "user", author: "You", text: "after migration", createdAt: 3 },
  ]
  const projected = projectDirectLines(durable, legacy)
  assert.deepEqual(projected.map((line) => line.text), ["before migration", "durable copy", "after migration"])
  assert.equal(projected.filter((line) => line.id === "dm_2").length, 1)
})

test("ticket212: a durable direct row maps to the same chat line shape", () => {
  const user: Message = { id: "dm_1", workspaceID: "home", channel: "dm:a", seq: 1, author: "user", text: "hello", kind: "text", createdAt: 4 }
  const agent: Message = { id: "dm_2", workspaceID: "home", channel: "dm:a", seq: 2, author: "agent", agentID: "a", text: "hi", kind: "text", createdAt: 5 }
  assert.deepEqual(chatLineFromMessage(user, "Nova"), {
    id: "dm_1",
    role: "user",
    author: "You",
    text: "hello",
    createdAt: 4,
  })
  assert.deepEqual(chatLineFromMessage(agent, "Nova"), {
    id: "dm_2",
    role: "assistant",
    author: "Nova",
    text: "hi",
    createdAt: 5,
  })
})
