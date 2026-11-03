import test from "node:test"
import assert from "node:assert/strict"
import type { Subtask } from "../types.ts"
import {
  ACTIVITY_DEFAULT_VERB,
  activityStateForTask,
  isActivityStale,
  waitingForLine,
  waitingForYouLine,
} from "./workrows.ts"

const task = (patch: Partial<Subtask> = {}): Subtask => ({
  id: "t",
  workspaceID: "w",
  creatorType: "user",
  assigneeID: "a",
  title: "Check the build",
  instruction: "do",
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

// Hang reproduction (ticket #70): these states must never read as indefinite
// "checking the details…" working lines.
test("hang reproduction: approval-gated work derives as waiting-for-user, not working", () => {
  const gated = task({ state: "working", claimedBy: "run", leaseUntil: 9_999, attempts: 1, approvalID: "ap" })
  const derived = activityStateForTask(gated, {
    now: 1_000,
    pendingApprovalIDs: new Set(["ap"]),
    nativeBlockedIDs: new Set(),
    children: [],
    agentNameFor: () => "Nova",
  })
  assert.equal(derived.kind, "waiting")
  assert.equal(derived.verb, waitingForYouLine())
  assert.notEqual(derived.verb, ACTIVITY_DEFAULT_VERB)
})

test("hang reproduction: native-blocked work derives as waiting-for-user without an approvalID", () => {
  const blocked = task({ id: "nb", state: "working", claimedBy: "run", leaseUntil: 9_999, attempts: 1 })
  const derived = activityStateForTask(blocked, {
    now: 1_000,
    pendingApprovalIDs: new Set(),
    nativeBlockedIDs: new Set(["nb"]),
    children: [],
    agentNameFor: () => "Nova",
  })
  assert.equal(derived.kind, "waiting")
  assert.equal(derived.verb, waitingForYouLine())
})

test("hang reproduction: parent awaiting children derives as waiting for the child agent", () => {
  const parent = task({ id: "p", state: "working", claimedBy: "run", leaseUntil: 9_999, attempts: 1, awaitingChildren: true })
  const child = task({ id: "c", parentID: "p", assigneeID: "child-agent", state: "pending" })
  const derived = activityStateForTask(parent, {
    now: 1_000,
    pendingApprovalIDs: new Set(),
    nativeBlockedIDs: new Set(),
    children: [child],
    agentNameFor: (id) => (id === "child-agent" ? "Clark" : "Nova"),
  })
  assert.equal(derived.kind, "waiting")
  assert.equal(derived.verb, waitingForLine("Clark"))
})

test("hang reproduction: retrying work names retrying instead of checking", () => {
  const retrying = task({ state: "pending", attempts: 1, error: "boom" })
  const derived = activityStateForTask(retrying, {
    now: 1_000,
    pendingApprovalIDs: new Set(),
    nativeBlockedIDs: new Set(),
    children: [],
    agentNameFor: () => "Nova",
  })
  assert.ok(derived.verb.includes("retrying"))
  assert.notEqual(derived.verb, ACTIVITY_DEFAULT_VERB)
})

test("hang reproduction: stale lines resolve instead of hanging forever", () => {
  const old = task({ state: "working", claimedBy: "run", leaseUntil: 9_999, attempts: 1, createdAt: 1 })
  assert.equal(isActivityStale({ createdAt: 1 } as any, 1_000_000), true)
  assert.equal(isActivityStale({ createdAt: 999_999 } as any, 1_000_000), false)
  assert.ok(old.createdAt < 1_000_000)
})

test("waiting copy follows the $Name grammar", () => {
  assert.equal(waitingForLine("Clark"), "Waiting for $Clark…")
  assert.ok(!waitingForLine("Clark").includes("@"))
})

test("stale claims leave the live activity surface but stay listed as work", async () => {
  const { splitActivityGroups } = await import("./workrows.ts")
  const live = task({ id: "live", state: "working", claimedBy: "run", leaseUntil: 9_999, attempts: 1, createdAt: 2 })
  // Lapsed lease: the heartbeat owns live claims, so this line is stuck.
  const stuck = task({ id: "stuck", state: "working", claimedBy: "dead-run", leaseUntil: 500, attempts: 1, createdAt: 1 })
  const groups = splitActivityGroups(
    [live, stuck],
    (item) => item.assigneeID ?? "unassigned",
    () => "Nova",
    1_000,
  )
  assert.deepEqual(groups.live.map((entry) => entry.label), ["Nova"])
  assert.equal(groups.live.length, 1)
})

test("pending approval-gated work shows waiting-for-you in live, not queued", async () => {
  const { splitActivityGroups } = await import("./workrows.ts")
  const gated = task({ id: "g", assigneeID: "a", state: "pending", approvalID: "ap", createdAt: 1 })
  const stalled = task({ id: "s", assigneeID: "c", state: "pending", interrupted: true, createdAt: 2 })
  const blocked = task({ id: "b", assigneeID: "d", state: "pending", createdAt: 3 })
  const plain = task({ id: "q", assigneeID: "b", state: "pending", createdAt: 4 })
  const groups = splitActivityGroups(
    [gated, stalled, blocked, plain],
    (item) => item.assigneeID ?? "unassigned",
    (item) => ({ a: "Nova", c: "June", d: "Theo", b: "Ana" })[item.assigneeID ?? ""] ?? "?",
    1_000,
    { pendingApprovalIDs: new Set(["ap"]), nativeBlockedIDs: new Set(["b"]) },
  )
  // Approval-gated, interrupted, and native-blocked pending work is
  // user-blocked: it reads waiting-for-you in live, never "queued".
  assert.deepEqual(groups.live.map((entry) => entry.label), ["Nova", "June", "Theo"])
  for (const entry of groups.live) {
    assert.equal(entry.verb, waitingForYouLine())
    assert.equal(entry.kind, "waiting")
  }
  // Genuinely queued work stays queued with no waiting verb.
  assert.deepEqual(groups.queued.map((entry) => entry.label), ["Ana"])
})

test("split groups thread approval-gated waits instead of working", async () => {
  const { splitActivityGroups } = await import("./workrows.ts")
  const gated = task({ id: "g", assigneeID: "a", state: "working", claimedBy: "run", leaseUntil: 9_999, attempts: 1, approvalID: "ap", createdAt: 1 })
  const groups = splitActivityGroups(
    [gated],
    (item) => item.assigneeID ?? "unassigned",
    () => "Nova",
    1_000,
    { pendingApprovalIDs: new Set(["ap"]), nativeBlockedIDs: new Set() },
  )
  assert.equal(groups.live[0]?.verb, waitingForYouLine())
  assert.equal(groups.live[0]?.kind, "waiting")
})
