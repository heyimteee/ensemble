import test from "node:test"
import assert from "node:assert/strict"
import {
  claimWon,
  correlationIDForKey,
  deriveWorkStatus,
  isTerminalWorkStatus,
  parseWorkKind,
  runPrefixHash,
  workKey,
  type DerivedWorkStatus,
} from "./queue.ts"
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

test("cancel text without a structural stop marker reads failed, not cancelled", () => {
  const task = base({ state: "replied", outcome: "failed", error: "Cancelled by user." })
  assert.equal(deriveWorkStatus(task, 1000), "failed")
})

test("a failure whose text mentions cancel without a stop marker reads failed, not cancelled", () => {
  const task = base({ state: "replied", outcome: "failed", error: "upstream cancelled the request mid-stream" })
  assert.equal(deriveWorkStatus(task, 1000), "failed")
})

test("a paused-workspace refusal without a stop marker reads failed, not cancelled", () => {
  const task = base({ state: "replied", outcome: "failed", error: "workspace is paused" })
  assert.equal(deriveWorkStatus(task, 1000), "failed")
})

test("parseWorkKind accepts only the domain union", () => {
  assert.equal(parseWorkKind("delegation"), "delegation")
  assert.equal(parseWorkKind("handoff"), "handoff")
  assert.equal(parseWorkKind("turn"), "turn")
  assert.equal(parseWorkKind("bogus"), undefined)
  assert.equal(parseWorkKind(undefined), undefined)
})

test("idempotency keys scope actor, workspace, kind, hashed run prefix, and recipient", () => {
  const input = {
    actor: "agent_n",
    workspaceID: "w",
    kind: "delegation" as const,
    parentID: "task_parent",
    assigneeID: "agent_s",
    title: "Child",
    instruction: "Check",
  }
  const key = workKey(input)
  const segments = key.split(":")
  assert.equal(segments[0], "work")
  assert.equal(segments[1], "w")
  assert.equal(segments[2], "delegation")
  assert.equal(segments[3], "agent_n")
  assert.equal(segments[4], runPrefixHash("task_parent"))
  assert.equal(segments[5], "agent_s")
  // The raw parent task id never appears in the key.
  assert.ok(!key.includes("task_parent"))
  // A different run prefix is a different unit of work.
  assert.notEqual(workKey({ ...input, parentID: "task_other" }), key)
  // A root (user-level) ask hashes its own prefix, distinct from a run ask.
  assert.notEqual(workKey({ ...input, parentID: undefined }), key)
  // Same logical work from a different actor is a different unit of work.
  assert.notEqual(workKey({ ...input, actor: "user" }), key)
  // Canonicalization: surrounding whitespace does not fork the key.
  assert.equal(workKey({ ...input, title: "  Child  " }), key)
})

test("correlation ids derive deterministically from the work key", () => {
  const key = workKey({
    actor: "user",
    workspaceID: "w",
    kind: "turn",
    assigneeID: "agent_s",
    title: "Hi",
    instruction: "Hi",
  })
  assert.equal(correlationIDForKey("turn", key), correlationIDForKey("turn", key))
  assert.ok(correlationIDForKey("turn", key).startsWith("turn_"))
  assert.ok(correlationIDForKey("handoff", key).startsWith("handoff_"))
  assert.notEqual(correlationIDForKey("turn", key), correlationIDForKey("turn", `${key}:other`))
})

test("claim fencing reports the winner by stored claim ownership", () => {
  assert.equal(claimWon(base({ claimedBy: "run_a" }), "run_a"), true)
  assert.equal(claimWon(base({ claimedBy: "run_b" }), "run_a"), false)
  assert.equal(claimWon(base({}), "run_a"), false)
  assert.equal(claimWon(undefined, "run_a"), false)
})

test("terminal states are replied, failed, and cancelled only", () => {
  const terminal: DerivedWorkStatus[] = ["replied", "failed", "cancelled"]
  const active: DerivedWorkStatus[] = ["pending", "working", "retrying"]
  for (const status of terminal) assert.equal(isTerminalWorkStatus(status), true)
  for (const status of active) assert.equal(isTerminalWorkStatus(status), false)
})
