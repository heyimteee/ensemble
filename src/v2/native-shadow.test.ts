import test from "node:test"
import assert from "node:assert/strict"
import { buildShadowComparison, shadowTextDigest } from "./native-shadow.ts"
import type { ShadowTurn } from "./native-shadow.ts"

const turn = (patch: Partial<ShadowTurn> = {}): ShadowTurn => ({
  turnID: "task_native_shadow",
  sessionID: "s1",
  inboxID: "m1",
  conversation: { kind: "workspace", workspaceID: "w", agentID: "a" },
  channel: "w",
  agentID: "a",
  phase: "working",
  text: {},
  assistantMessageIDs: [],
  startedAt: 1,
  userRoutes: 0,
  finalRoutes: 0,
  ...patch,
})

test("ticket230: comparison rows carry lengths, digests, phases, and counts only", () => {
  const row = buildShadowComparison({
    turn: turn({ phase: "replied", userRoutes: 1, finalRoutes: 2 }),
    text: "Shadow final answer.",
    visibleText: "Shadow final answer.",
    expectedPhase: "replied",
    at: 10,
  })
  assert.equal(row.phase, "replied")
  assert.equal(row.expectedPhase, "replied")
  assert.equal(row.phaseMatch, true)
  assert.equal(row.textLength, "Shadow final answer.".length)
  assert.equal(row.textDigest, shadowTextDigest("Shadow final answer."))
  assert.equal(row.visibleTextLength, row.textLength)
  assert.equal(row.visibleTextDigest, row.textDigest)
  assert.equal(row.textMatch, true)
  assert.equal(row.visibleHasTurn, false)
  assert.equal(row.plannedUserRoutes, 1)
  assert.equal(row.plannedFinalRoutes, 2)
  assert.equal(row.plannedRoutes, 3)
  assert.equal(row.visibleRoutes, 0)
  assert.equal(row.routingDelta, 3, "the routing difference is reported as data")
  assert.equal(row.routingMatch, true, "a delta is expected when the visible path cannot route")
  assert.equal(row.channelKind, "workspace")
  const serialized = JSON.stringify(row)
  assert.equal(serialized.includes("Shadow final answer."), false)
  assert.equal(serialized.includes("/home/"), false)
})

test("ticket230: an unavailable visible answer is recorded as missing, never guessed", () => {
  const row = buildShadowComparison({
    turn: turn({ phase: "failed", userRoutes: 0, finalRoutes: 0 }),
    text: "partial",
    expectedPhase: "failed",
    at: 20,
  })
  assert.equal(row.visibleTextLength, undefined)
  assert.equal(row.visibleTextDigest, undefined)
  assert.equal(row.textMatch, false)
  assert.equal(row.plannedRoutes, 0)
  assert.equal(row.routingDelta, 0)
  assert.equal(row.routingMatch, true)
  assert.equal(row.channelKind, "workspace")
  assert.deepEqual(buildShadowComparison({
    turn: turn({ conversation: { kind: "home", agentID: "a" }, channel: "dm:a" }),
    text: "home",
    expectedPhase: "replied",
    at: 30,
  }).channelKind, "home")
})
