import test from "node:test"
import assert from "node:assert/strict"
import { ensembleTurnContext, turnContextSize } from "./turn-context.ts"

const agents = Object.fromEntries(
  ["Nova", "Sage", "Echo", "Iris", "Milo", "Juno", "Kai", "Lena", "Otto", "Pia", "Quinn", "Rhea"].map((name, index) => {
    const id = `a${index}`
    return [id, { id, name, archived: false }]
  }),
)

const workspace = {
  id: "w",
  name: "site",
  directory: "/tmp/ensemble-test-site",
  leaderID: "a0",
  memberIDs: ["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10", "a11"],
}

test("ticket225: native turn context carries a compact group roster, conversation, and budget", () => {
  const context = ensembleTurnContext({
    agent: { id: "a1", name: "Sage", role: "Backend" },
    conversation: { kind: "workspace", workspaceID: "w" },
    workspace,
    agents,
    routing: true,
    budget: {
      groupID: "dispatch_root",
      rootID: "dispatch_root",
      continuationIndex: 0,
      groupUsed: 2,
      groupMax: 8,
      groupRemaining: 6,
      closed: false,
      commandUsed: 3,
      commandMax: 24,
      commandRemaining: 21,
      taskUsed: 0,
      depth: 1,
      depthMax: 8,
    },
  })
  assert.match(context, /<ensemble_turn /)
  assert.match(context, /agent="Sage"/)
  assert.match(context, /conversation="group"/)
  assert.match(context, /workspace="site"/)
  assert.match(context, /Leader: Nova/)
  assert.match(context, /Members: Nova, Sage, Echo/)
  assert.match(context, /Budget: group 2\/8 \(6 left\) · command 3\/24 \(21 left\) · task 0 used \(unlimited\) · depth 1\/8/)
  assert.match(context, /Final text is the group message/)
  assert.match(context, /\$Name/)
  assert.match(context, /`@path` is file-only/)
  assert.ok(context.length < 700, `compact context stayed under 700 chars, got ${context.length}`)
})

test("ticket225: a direct turn has no workspace roster and no routing promise", () => {
  const context = ensembleTurnContext({
    agent: { id: "a1", name: "Sage", role: "Backend" },
    conversation: { kind: "direct", workspaceID: "w" },
    agents,
  })
  assert.match(context, /conversation="direct"/)
  assert.match(context, /one-to-one/i)
  assert.match(context, /\$Name` does not create work/)
  assert.doesNotMatch(context, /Leader:/)
  assert.doesNotMatch(context, /Members:/)
  assert.doesNotMatch(context, /Budget:/)
})

test("ticket225: a home direct turn and an empty roster stay compact and truthful", () => {
  const context = ensembleTurnContext({
    agent: { id: "a1", name: "Sage" },
    conversation: { kind: "home" },
    agents: {},
  })
  assert.match(context, /conversation="home"/)
  assert.match(context, /home direct/i)
  assert.doesNotMatch(context, /Leader:/)
  assert.ok(turnContextSize(context) < 400)
})
