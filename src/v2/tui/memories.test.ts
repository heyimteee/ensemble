import test from "node:test"
import assert from "node:assert/strict"
import {
  filterMemories,
  memoryCountLabel,
  memoryNeedsReview,
  memoryProvenanceLine,
  memoryStatus,
} from "./memories.ts"
import type { Memory } from "../types.ts"

const memory = (patch: Partial<Memory> = {}): Memory => ({
  id: "m",
  agentID: "a",
  workspaceID: "w",
  scope: "project",
  text: "The team uses pnpm.",
  origin: "manual",
  source: "user",
  createdAt: 1,
  updatedAt: 1,
  history: [{ at: 1, action: "created", by: "user" }],
  ...patch,
})

test("manual memories are reviewed", () => {
  assert.equal(memoryStatus(memory()), "reviewed")
  assert.equal(memoryProvenanceLine(memory()), "manual │ project │ reviewed")
  assert.equal(memoryNeedsReview(memory()), false)
})

test("automatic memories need review until edited or promoted", () => {
  const fresh = memory({ origin: "automatic", source: "agent:nova", history: [{ at: 1, action: "created", by: "agent" }] })
  assert.equal(memoryStatus(fresh), "needs review")
  assert.equal(memoryNeedsReview(fresh), true)
  assert.equal(memoryProvenanceLine(fresh), "automatic │ project │ needs review")

  const edited = memory({
    origin: "automatic",
    history: [
      { at: 1, action: "created", by: "agent" },
      { at: 2, action: "edited", by: "user" },
    ],
  })
  assert.equal(memoryStatus(edited), "reviewed")
})

test("promoted history maps to promoted status", () => {
  const promoted = memory({
    scope: "global",
    history: [
      { at: 1, action: "created", by: "user" },
      { at: 2, action: "promoted", by: "user" },
    ],
  })
  assert.equal(memoryStatus(promoted), "promoted")
  assert.equal(memoryProvenanceLine(promoted), "manual │ global │ promoted")
})

test("provenance line covers workspace scope", () => {
  assert.equal(memoryProvenanceLine(memory({ scope: "workspace" })), "manual │ workspace │ reviewed")
})

test("filter matches text, origin, scope, and status", () => {
  const rows = [
    memory({ id: "1", text: "The team uses pnpm" }),
    memory({ id: "2", text: "Standup at nine", origin: "automatic", history: [{ at: 1, action: "created", by: "agent" }] }),
  ]
  assert.deepEqual(filterMemories(rows, "").map((row) => row.id), ["1", "2"])
  assert.deepEqual(filterMemories(rows, "pnpm").map((row) => row.id), ["1"])
  assert.deepEqual(filterMemories(rows, "automatic").map((row) => row.id), ["2"])
  assert.deepEqual(filterMemories(rows, "needs review").map((row) => row.id), ["2"])
  assert.deepEqual(filterMemories(rows, "no-match-xyz"), [])
})

test("count label renders the live total", () => {
  assert.equal(memoryCountLabel(0), "Memories (0)")
  assert.equal(memoryCountLabel(2), "Memories (2)")
})
