import test from "node:test"
import assert from "node:assert/strict"
import { deriveWorkStatus, isTerminalWorkStatus, type DerivedWorkStatus } from "./queue.ts"
import type { Subtask } from "./types.ts"

const base = (patch: Partial<Subtask> = {}): Subtask => ({
  id: "t",
  workspaceID: "w",
  creatorType: "user",
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

test("first-attempt waiting work reads pending", () => {
  assert.equal(deriveWorkStatus(base(), 1000), "pending")
})

test("claimed work with a valid lease reads working", () => {
  const task = base({ state: "working", attempts: 1, claimedBy: "run_1", leaseUntil: 2000 })
  assert.equal(deriveWorkStatus(task, 1000), "working")
})

test("expired lease with attempts reads retrying, not working", () => {
  const task = base({ state: "working", attempts: 1, claimedBy: "run_1", leaseUntil: 500 })
  assert.equal(deriveWorkStatus(task, 1000), "retrying")
})

test("unclaimed work with attempts reads retrying", () => {
  assert.equal(deriveWorkStatus(base({ attempts: 1 }), 1000), "retrying")
})

test("exhausted attempts read failed with the reason preserved", () => {
  const task = base({ attempts: 5, error: "boom" })
  assert.equal(deriveWorkStatus(task, 1000), "failed")
  assert.equal(task.error, "boom")
})

test("deadline expiry reads failed", () => {
  const task = base({ attempts: 1, deadlineAt: 500 })
  assert.equal(deriveWorkStatus(task, 1000), "failed")
})

test("finished success reads replied", () => {
  const task = base({ state: "replied", outcome: "succeeded", repliedAt: 900 })
  assert.equal(deriveWorkStatus(task, 1000), "replied")
})

test("finished failure reads failed", () => {
  const task = base({ state: "replied", outcome: "failed", error: "boom" })
  assert.equal(deriveWorkStatus(task, 1000), "failed")
})

test("stopped work reads cancelled", () => {
  const task = base({ state: "replied", outcome: "failed", error: "Cancelled by user.", stoppedAt: 900 })
  assert.equal(deriveWorkStatus(task, 1000), "cancelled")
})

test("legacy cancelled rows without stoppedAt still read cancelled", () => {
  const task = base({ state: "replied", outcome: "failed", error: "Cancelled by user." })
  assert.equal(deriveWorkStatus(task, 1000), "cancelled")
})

test("terminal states are replied, failed, and cancelled only", () => {
  const terminal: DerivedWorkStatus[] = ["replied", "failed", "cancelled"]
  const active: DerivedWorkStatus[] = ["pending", "working", "retrying"]
  for (const status of terminal) assert.equal(isTerminalWorkStatus(status), true)
  for (const status of active) assert.equal(isTerminalWorkStatus(status), false)
})
