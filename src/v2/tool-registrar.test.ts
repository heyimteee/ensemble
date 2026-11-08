import test from "node:test"
import assert from "node:assert/strict"
import { registerEnsembleTools } from "./tool-registrar.ts"

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
})
