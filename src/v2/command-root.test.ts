import test from "node:test"
import assert from "node:assert/strict"
import { resolveCommandRoot } from "./command-root.ts"
import type { Subtask } from "./types.ts"

const task = (patch: Partial<Subtask> & { id: string }): Subtask => ({
  workspaceID: "w",
  creatorType: "agent",
  assigneeID: "a",
  title: "Task",
  instruction: "Do",
  mode: "research",
  state: "pending",
  stage: "initial",
  outcome: "pending",
  interrupted: false,
  awaitingChildren: false,
  attempts: 0,
  createdAt: 1,
  ...patch,
})

test("command root walks a five-hop parent chain to the topmost subtask", () => {
  const tasks = {
    root: task({ id: "root" }),
    a: task({ id: "a", parentID: "root" }),
    b: task({ id: "b", parentID: "a" }),
    c: task({ id: "c", parentID: "b" }),
    d: task({ id: "d", parentID: "c" }),
    e: task({ id: "e", parentID: "d" }),
  }
  const resolved = resolveCommandRoot("e", tasks)
  assert.ok(resolved)
  assert.equal(resolved.root.id, "root")
  assert.deepEqual(resolved.chain.map((item) => item.id), ["root", "a", "b", "c", "d", "e"])
  assert.equal(resolved.hostAnswered, false)
})

test("a native turn anywhere on the chain stays host-answered", () => {
  const tasks = {
    root: task({ id: "root" }),
    native: task({ id: "native", parentID: "root", origin: "native", workKind: "turn", assigneeID: "a" }),
    child: task({ id: "child", parentID: "native" }),
  }
  const resolved = resolveCommandRoot("child", tasks)
  assert.ok(resolved)
  assert.equal(resolved.root.id, "root")
  assert.equal(resolved.hostAnswered, true)
})

test("an unknown task resolves to nothing and a cycle terminates", () => {
  assert.equal(resolveCommandRoot("missing", {}), undefined)
  const cyclic = {
    a: task({ id: "a", parentID: "b" }),
    b: task({ id: "b", parentID: "a" }),
  }
  const resolved = resolveCommandRoot("a", cyclic)
  assert.ok(resolved)
  assert.deepEqual(new Set(resolved.chain.map((item) => item.id)), new Set(["a", "b"]))
})
