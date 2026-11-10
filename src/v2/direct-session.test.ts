import test from "node:test"
import assert from "node:assert/strict"
import { directSessionCutover, selectDirectConversation } from "./direct-session.ts"
import type { BindingConversation } from "./types.ts"

const direct = (workspaceID: string): BindingConversation => ({ kind: "direct", workspaceID, agentID: "a" })
const group = (workspaceID: string): BindingConversation => ({ kind: "workspace", workspaceID, agentID: "a" })
const home = (): BindingConversation => ({ kind: "home", agentID: "a" })

test("ticket214: only the on mode cuts direct chat over to its own conversation", () => {
  assert.equal(directSessionCutover("on"), true)
  assert.equal(directSessionCutover("shadow"), false)
  assert.equal(directSessionCutover("off"), false)
})

test("ticket214: a workspace member's direct chat owns a workspace-direct session when cut over", () => {
  const selected = selectDirectConversation({ agentID: "a", workspaceID: "w", workspaceMember: true, mode: "on" })
  assert.deepEqual(selected, direct("w"))
})

test("ticket214: off and shadow keep the pre-cutover group selection for a workspace member", () => {
  for (const mode of ["off", "shadow"] as const) {
    const selected = selectDirectConversation({ agentID: "a", workspaceID: "w", workspaceMember: true, mode })
    assert.deepEqual(selected, group("w"), `${mode} must keep the old selection`)
  }
})

test("ticket214: direct chat without workspace membership resolves the home context", () => {
  for (const mode of ["off", "shadow", "on"] as const) {
    assert.deepEqual(
      selectDirectConversation({ agentID: "a", workspaceID: "w", workspaceMember: false, mode }),
      home(),
      `${mode} must not borrow a workspace session for a non-member`,
    )
    assert.deepEqual(
      selectDirectConversation({ agentID: "a", mode }),
      home(),
      `${mode} must use home outside a workspace`,
    )
    assert.deepEqual(
      selectDirectConversation({ agentID: "a", workspaceID: "home", workspaceMember: true, mode }),
      home(),
      "the home pseudo-workspace never selects a workspace conversation",
    )
  }
})
