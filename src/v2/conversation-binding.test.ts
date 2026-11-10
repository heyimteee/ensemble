import test from "node:test"
import assert from "node:assert/strict"
import { bindingConversation, conversationStateKey } from "./conversation-binding.ts"

test("legacy workspace bindings resolve to the workspace group conversation", () => {
  assert.deepEqual(
    bindingConversation({ workspaceID: "w", agentID: "a" }),
    { kind: "workspace", workspaceID: "w", agentID: "a" },
  )
  assert.deepEqual(
    bindingConversation({ workspaceID: "w", agentID: "a", kind: "workspace" }),
    { kind: "workspace", workspaceID: "w", agentID: "a" },
  )
})

test("home bindings resolve to the home direct conversation", () => {
  assert.deepEqual(
    bindingConversation({ workspaceID: "home", agentID: "a" }),
    { kind: "home", agentID: "a" },
  )
  assert.deepEqual(
    bindingConversation({ workspaceID: "home", agentID: "a", kind: "home" }),
    { kind: "home", agentID: "a" },
  )
})

test("direct bindings resolve to a workspace direct conversation", () => {
  assert.deepEqual(
    bindingConversation({ workspaceID: "w", agentID: "a", kind: "direct" }),
    { kind: "direct", workspaceID: "w", agentID: "a" },
  )
})

test("a direct binding cannot live at the home pseudo-workspace", () => {
  assert.equal(bindingConversation({ workspaceID: "home", agentID: "a", kind: "direct" }), undefined)
})

test("group, workspace direct, and home direct have distinct stable state keys", () => {
  const group = conversationStateKey({ kind: "workspace", workspaceID: "w", agentID: "a" })
  const direct = conversationStateKey({ kind: "direct", workspaceID: "w", agentID: "a" })
  const home = conversationStateKey({ kind: "home", agentID: "a" })
  assert.equal(group, "w:a", "the legacy workspace key is unchanged")
  assert.equal(home, "home:a", "the legacy home key is unchanged")
  assert.equal(direct, "dm:a:w")
  assert.equal(new Set([group, direct, home]).size, 3)
})
