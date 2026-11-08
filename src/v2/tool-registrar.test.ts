import test from "node:test"
import assert from "node:assert/strict"
import { registerEnsembleTools } from "./tool-registrar.ts"
import { DISPATCH_GROUP_TIERS } from "./dispatch-budget.ts"

test("ticket161: delegate and handoff require a non-negative integer maxHops", () => {
  const tools = new Map<string, any>()
  const fail = async () => ({ content: "unused" })
  registerEnsembleTools(
    {
      namespace() {},
      add(tool) { tools.set(tool.name, tool) },
    },
    {
      workspaceInfo: fail,
      listWorkspaces: fail,
      listAgents: fail,
      taskStatus: fail,
      sendMessage: fail,
      handoff: fail,
      delegate: fail,
      review: fail,
      askPerson: fail,
      remember: fail,
      share: fail,
    },
  )
  for (const name of ["handoff", "delegate"]) {
    const tool = tools.get(name)
    assert.ok(tool, `${name} is registered`)
    assert.ok(tool.input.required.includes("maxHops"), `${name} requires maxHops`)
    assert.equal(tool.input.properties.maxHops.type, "integer")
    assert.equal(tool.input.properties.maxHops.minimum, 0)
    assert.match(tool.description, /maxHops|typed hop|typed subtask/)
  }
  const delegate = tools.get("delegate")
  assert.equal(delegate.input.properties.continuationOf.type, "string")
  assert.deepEqual(delegate.input.properties.groupMaxHops.enum, [...DISPATCH_GROUP_TIERS])
  assert.match(delegate.description, /continuationOf/)
  assert.match(delegate.description, /groupMaxHops/)
  const handoff = tools.get("handoff")
  assert.equal("continuationOf" in handoff.input.properties, false, "peers cannot open a continuation group")
  const review = tools.get("review")
  assert.ok("maxHops" in review.input.properties.decisions.items.properties, "review decisions accept an explicit budget")
  assert.equal(review.input.properties.decisions.items.properties.maxHops.minimum, 0)
})
