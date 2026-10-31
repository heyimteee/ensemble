import test from "node:test"
import assert from "node:assert/strict"
import { normalizeAgentMentions } from "./routing.ts"
import type { Agent } from "./types.ts"

const agent = { id: "a", name: "Jessy" } as Agent

test("agent chat mentions are display-normalized from @Name to $Name", () => {
  assert.deepEqual(normalizeAgentMentions("@Jessy please introduce yourself.", [agent]), {
    text: "$Jessy please introduce yourself.",
    changed: true,
    names: ["Jessy"],
  })
  assert.equal(normalizeAgentMentions("mail me at me@Jessy.dev", [agent]).changed, false)
  assert.equal(normalizeAgentMentions("@Jessy/file", [agent]).changed, false)
  assert.equal(normalizeAgentMentions("$Jessy is already correct", [agent]).changed, false)
})
