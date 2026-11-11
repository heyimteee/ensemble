import test from "node:test"
import assert from "node:assert/strict"
import { registerEnsembleTools } from "./tool-registrar.ts"
import { DISPATCH_GROUP_TIERS } from "./dispatch-budget.ts"
import { TOOL_SURFACE_TOOL_NAMES } from "./tool-surface.ts"

const fail = async () => ({ content: "unused" })
function register(surface: "native" | "legacy") {
  const tools = new Map<string, any>()
  registerEnsembleTools(
    { namespace() {}, add(tool) { tools.set(tool.name, tool) } },
    {
      workspaceInfo: fail,
      listWorkspaces: fail,
      listAgents: fail,
      taskStatus: fail,
      sendMessage: fail,
      handoff: fail,
      delegate: fail,
      review: fail,
      dispatch: fail,
      askPerson: fail,
      remember: fail,
      share: fail,
    },
    surface,
  )
  return tools
}

test("ticket225: the native surface registers only the decision tools", () => {
  const tools = register("native")
  assert.deepEqual([...tools.keys()], [...TOOL_SURFACE_TOOL_NAMES.native])
  assert.equal(TOOL_SURFACE_TOOL_NAMES.native.length, 6, "ticket250: the native surface has six tools")
  assert.equal(TOOL_SURFACE_TOOL_NAMES.legacy.length, 11, "ticket250: the legacy surface is unchanged")
  for (const name of ["send_message", "workspace_info", "list_workspaces", "list_agents", "delegate", "handoff"]) {
    assert.equal(tools.has(name), false, `${name} is absent from the native surface`)
  }
  for (const name of ["task_status", "review", "dispatch", "ask_person", "remember", "share"]) {
    assert.ok(tools.get(name), `${name} remains available`)
  }
})

test("ticket250: ensemble_dispatch takes a next command and its assignment batch", () => {
  const tools = register("native")
  const dispatch = tools.get("dispatch")
  assert.ok(dispatch, "dispatch is registered on the native surface")
  assert.equal(dispatch.input.properties.title.type, "string")
  assert.equal(dispatch.input.properties.instruction.type, "string")
  assert.equal(dispatch.input.properties.continuationOf.type, "string")
  const assignment = dispatch.input.properties.assignments.items
  assert.deepEqual([...assignment.required].sort(), ["assignee", "instruction", "maxHops", "title"])
  assert.equal(assignment.properties.maxHops.type, "integer")
  assert.equal(assignment.properties.maxHops.minimum, 0)
  assert.deepEqual(assignment.properties.mode.enum, ["research", "edit"])
  assert.match(dispatch.description, /leader/i)
  assert.match(dispatch.description, /new command root/i)
  assert.match(dispatch.description, /routing operator/i)
  assert.equal(tools.has("dispatch"), true)
  assert.equal(register("legacy").has("dispatch"), false, "the legacy surface stays unchanged")
})

test("ticket225: the legacy surface keeps send_message as a compatibility shim", () => {
  const tools = register("legacy")
  assert.deepEqual([...tools.keys()], [...TOOL_SURFACE_TOOL_NAMES.legacy])
  assert.match(tools.get("send_message").description, /Compatibility shim/)
  assert.match(tools.get("send_message").description, /\$Name/)
})

test("ticket161: delegate and handoff require a non-negative integer maxHops", () => {
  const tools = new Map<string, any>()
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
      dispatch: fail,
      askPerson: fail,
      remember: fail,
      share: fail,
    },
    "legacy",
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
