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

test("queued work past an old delivery deadline still reads pending", () => {
  const task = base({ attempts: 0, deadlineAt: 500, error: "The work deadline passed before it could finish." })
  assert.equal(deriveWorkStatus(task, 1000), "pending")
})

test("unclaimed work with prior attempts and no scheduled retry reads pending", () => {
  assert.equal(deriveWorkStatus(base({ attempts: 1 }), 1000), "pending")
})

test("claimed work with a valid lease reads working", () => {
  const task = base({ state: "working", attempts: 1, claimedBy: "run_1", leaseUntil: 2000 })
  assert.equal(deriveWorkStatus(task, 1000), "working")
})

test("a live lease outranks a passed delivery deadline", () => {
  const task = base({ state: "working", attempts: 1, claimedBy: "run_1", leaseUntil: 2000, deadlineAt: 500 })
  assert.equal(deriveWorkStatus(task, 1000), "working")
})

test("a live lease outranks an exhausted attempt count", () => {
  const task = base({ state: "working", attempts: 5, claimedBy: "run_1", leaseUntil: 2000, deadlineAt: 500 })
  assert.equal(deriveWorkStatus(task, 1000), "working")
})

test("a live active run without a separate lease reads working", () => {
  const task = base({ state: "working", attempts: 1, claimedBy: "run_1", activeRunID: "run_1" })
  assert.equal(deriveWorkStatus(task, 1000), "working")
})

test("an expired lease with attempts reads retrying, not working", () => {
  const task = base({ state: "working", attempts: 1, claimedBy: "run_1", leaseUntil: 500 })
  assert.equal(deriveWorkStatus(task, 1000), "retrying")
})

test("a scheduled retry reads retrying", () => {
  const task = base({ state: "pending", attempts: 1, retryAfter: 2000 })
  assert.equal(deriveWorkStatus(task, 1000), "retrying")
})

test("a due retry stays retrying until the pump claims it", () => {
  const task = base({ state: "pending", attempts: 1, retryAfter: 500 })
  assert.equal(deriveWorkStatus(task, 1000), "retrying")
})

test("a parent awaiting children reads waiting", () => {
  const task = base({ state: "working", attempts: 1, awaitingChildren: true })
  assert.equal(deriveWorkStatus(task, 1000), "waiting")
})

test("waiting for children outranks a scheduled retry", () => {
  const task = base({ state: "working", attempts: 1, awaitingChildren: true, retryAfter: 2000 })
  assert.equal(deriveWorkStatus(task, 1000), "waiting")
})

test("an interrupted task reads needs_you", () => {
  const task = base({ state: "pending", attempts: 1, interrupted: true })
  assert.equal(deriveWorkStatus(task, 1000), "needs_you")
})

test("a task gated on an approval reads needs_you", () => {
  const task = base({ state: "pending", attempts: 1, approvalID: "approval_1" })
  assert.equal(deriveWorkStatus(task, 1000), "needs_you")
})

test("needs-you outranks a scheduled retry and waiting children", () => {
  const task = base({ state: "pending", attempts: 1, interrupted: true, awaitingChildren: true, retryAfter: 2000 })
  assert.equal(deriveWorkStatus(task, 1000), "needs_you")
})

test("a live lease outranks an interruption marker", () => {
  const task = base({ state: "working", attempts: 1, claimedBy: "run_1", leaseUntil: 2000, interrupted: true })
  assert.equal(deriveWorkStatus(task, 1000), "working")
})

test("exhausted attempts without a native error read stalled", () => {
  const task = base({ attempts: 5, error: "boom" })
  assert.equal(deriveWorkStatus(task, 1000), "stalled")
  assert.equal(task.error, "boom")
})

test("a delivery timeout terminal row reads stalled", () => {
  const task = base({ state: "replied", outcome: "failed", deadlineAt: 500, finishedAt: 600, failure: { kind: "delivery", reason: "deadline-exceeded" } })
  assert.equal(deriveWorkStatus(task, 1000), "stalled")
})

test("a lease failure terminal row reads stalled", () => {
  const task = base({ state: "replied", outcome: "failed", finishedAt: 600, failure: { kind: "lease", reason: "lease-expired" } })
  assert.equal(deriveWorkStatus(task, 1000), "stalled")
})

test("a native terminal failure reads failed", () => {
  const task = base({ state: "replied", outcome: "failed", error: "quota exhausted", finishedAt: 600, failure: { kind: "native", reason: "attempts-exhausted" } })
  assert.equal(deriveWorkStatus(task, 1000), "failed")
})

test("finished success reads replied", () => {
  const task = base({ state: "replied", outcome: "succeeded", repliedAt: 900 })
  assert.equal(deriveWorkStatus(task, 1000), "replied")
})

test("legacy terminal failure without a structured cause stays failed", () => {
  const task = base({ state: "replied", outcome: "failed", error: "boom" })
  assert.equal(deriveWorkStatus(task, 1000), "failed")
})

test("stopped work reads cancelled", () => {
  const task = base({ state: "replied", outcome: "failed", error: "Cancelled by user.", stoppedAt: 900 })
  assert.equal(deriveWorkStatus(task, 1000), "cancelled")
})

test("cancellation outranks a structured delivery cause", () => {
  const task = base({ state: "replied", outcome: "failed", stoppedAt: 900, failure: { kind: "delivery", reason: "deadline-exceeded" } })
  assert.equal(deriveWorkStatus(task, 1000), "cancelled")
})

test("cancel text without a structural stop marker stays failed", () => {
  const task = base({ state: "replied", outcome: "failed", error: "Cancelled by user." })
  assert.equal(deriveWorkStatus(task, 1000), "failed")
})

test("a failure whose text mentions cancel without a stop marker stays failed", () => {
  const task = base({ state: "replied", outcome: "failed", error: "upstream cancelled the request mid-stream" })
  assert.equal(deriveWorkStatus(task, 1000), "failed")
})

test("a paused-workspace refusal without a stop marker stays failed", () => {
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

test("root work keys include the dispatch group so repeated commands never dedupe", () => {
  const root = {
    actor: "user",
    workspaceID: "w",
    kind: "delegation" as const,
    assigneeID: "agent_s",
    title: "Coordinate",
    instruction: "Coordinate",
  }
  const first = workKey({ ...root, dispatchGroupID: "dispatch_first" })
  assert.equal(workKey({ ...root, dispatchGroupID: "dispatch_first" }), first)
  assert.notEqual(workKey({ ...root, dispatchGroupID: "dispatch_second" }), first)
  assert.notEqual(workKey(root), first)
  // Group identity is hashed, never stored raw inside the idempotency key.
  assert.ok(!first.includes("dispatch_first"))
  // Run-scoped work stays anchored by its parent, so same-run tool retries
  // still dedupe even when the inherited group is passed through.
  const child = { ...root, parentID: "task_parent" }
  assert.equal(workKey({ ...child, dispatchGroupID: "dispatch_first" }), workKey(child))
  assert.equal(workKey({ ...child, dispatchGroupID: "dispatch_second" }), workKey(child))
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

test("stalled, waiting, and needs-you stay mounted: only replied, failed, and cancelled are terminal", () => {
  const terminal: DerivedWorkStatus[] = ["replied", "failed", "cancelled"]
  const active: DerivedWorkStatus[] = ["pending", "working", "retrying", "needs_you", "waiting", "stalled"]
  for (const status of terminal) assert.equal(isTerminalWorkStatus(status), true)
  for (const status of active) assert.equal(isTerminalWorkStatus(status), false)
})
