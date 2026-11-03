import test from "node:test"
import assert from "node:assert/strict"
import type { Message, Subtask } from "../types.ts"
import { settleStreamMessage } from "../service.ts"
import {
  ACTIVITY_DEFAULT_VERB,
  isActivityStale,
  mergeStreamingActivity,
  splitActivityGroups,
  workingLine,
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

const message = (patch: Partial<Message> = {}): Message => ({
  id: "m",
  workspaceID: "w",
  seq: 1,
  author: "agent",
  agentID: "clark",
  text: "partial",
  kind: "text",
  streaming: true,
  createdAt: 1_000,
  ...patch,
})

// Ticket #74.1: the finalizeStream epoch guard returned before clearing or
// persisting `streaming`, leaving orphaned live rows until the 120 s age
// filter. Settlement must always clear the flag, even on epoch mismatch.
test("ticket #74: settling a stream always clears streaming, even on epoch mismatch", () => {
  const settled = settleStreamMessage(message({ streaming: true, text: "partial" }), "done", false)
  assert.equal(settled.streaming, false)
  assert.equal(settled.text, "done")
  assert.equal(settled.interrupted, false)
})

test("ticket #74: settled streams carry a last-delta heartbeat", () => {
  const settled = settleStreamMessage(message({ streaming: true }), "done", true)
  assert.equal(settled.streaming, false)
  assert.equal(settled.interrupted, true)
  assert.ok(typeof settled.updatedAt === "number")
})

// Ticket #74.2: task-less streaming rows must never synthesize the generic
// checking verb. A fresh live row reads honest `working…`; a stale orphan
// is hidden, never wedged.
test("ticket #74: fresh task-less streams read working, never the generic checking verb", () => {
  const merged = mergeStreamingActivity([], [message({ agentID: "clark", createdAt: 1_000 })], 2_000)
  assert.equal(merged.length, 1)
  assert.equal(merged[0]?.verb, workingLine())
  assert.notEqual(merged[0]?.verb, ACTIVITY_DEFAULT_VERB)
})

test("ticket #74: stale orphaned streams are hidden, not rendered as checking", () => {
  const merged = mergeStreamingActivity([], [message({ agentID: "clark", createdAt: 1_000 })], 1_000_000)
  assert.deepEqual(merged, [])
})

test("ticket #74: task-backed agents never gain a duplicate streaming line", () => {
  const live = [{ key: "clark", label: "Clark", agentID: "clark", createdAt: 900, verb: workingLine(), kind: "working" as const }]
  const merged = mergeStreamingActivity(live, [message({ agentID: "clark", createdAt: 1_000 })], 2_000)
  assert.equal(merged.length, 1)
  assert.equal(merged[0]?.verb, workingLine())
})

// Ticket #74.3: stream staleness runs on the last delta/heartbeat, not only
// creation — long live streams stay visible while fresh, orphans expire.
test("ticket #74: staleness follows the last delta, not creation", () => {
  // Old row with a fresh heartbeat is live.
  assert.equal(isActivityStale({ createdAt: 1, updatedAt: 999_000 }, 1_000_000), false)
  // Young row with no heartbeat for the full window is an orphan.
  assert.equal(isActivityStale({ createdAt: 1, updatedAt: 1 }, 1_000_000), true)
})

// Ticket #74.4: completion/batch-review work gets honest review verbs and
// never self-waits (`Waiting for $Leader…` when the waiter is the leader).
test("ticket #74: batch review reads as reviewing, never self-wait", async () => {
  const { activityStateForTask } = await import("./workrows.ts")
  const batch = task({
    id: "batch",
    assigneeID: "leader",
    state: "working",
    claimedBy: "run",
    leaseUntil: 9_999,
    attempts: 1,
    awaitingChildren: true,
    workKind: "handoff",
    handoff: { correlationID: "c", senderID: "clark", recipientID: "leader", depth: 1, batch: true, itemIDs: ["i1", "i2"] },
  })
  const item = task({ id: "i1", parentID: "batch", assigneeID: "leader", state: "pending", workKind: "handoff", handoff: { correlationID: "c", senderID: "clark", recipientID: "leader", depth: 1, completion: true, batchedIn: "batch" } })
  const derived = activityStateForTask(batch, {
    now: 1_000,
    pendingApprovalIDs: new Set(),
    nativeBlockedIDs: new Set(),
    children: [item],
    agentNameFor: (id) => (id === "leader" ? "Ava" : "Clark"),
  })
  assert.notEqual(derived.verb, ACTIVITY_DEFAULT_VERB)
  assert.ok(!derived.verb.includes("$Ava") || !derived.verb.startsWith("Waiting for"), `no self-wait, got: ${derived.verb}`)
})

test("ticket #74: pending completion hops attribute to the leader, never the finisher", () => {
  const hop = task({
    id: "hop",
    assigneeID: "leader",
    state: "pending",
    workKind: "handoff",
    createdAt: 5,
    handoff: { correlationID: "c", senderID: "clark", recipientID: "leader", depth: 1, completion: true },
  })
  const groups = splitActivityGroups(
    [hop],
    (item) => item.assigneeID ?? "unassigned",
    (item) => (item.assigneeID === "leader" ? "Ava" : "Clark"),
    1_000,
  )
  assert.deepEqual(groups.queued.map((entry) => entry.label), ["Ava"])
  assert.deepEqual(groups.live.map((entry) => entry.label), [])
})

// Ticket #74.5: finisher absence. After both turns finished and handed off,
// no `checking` activity line remains for either finisher.
test("ticket #74: finished turns leave no checking line for the finishers", () => {
  const now = 1_000
  const finishedClark = task({ id: "d1", assigneeID: "clark", state: "replied", outcome: "succeeded", attempts: 1, createdAt: 10, finishedAt: 20, repliedAt: 20 })
  const finishedKaluna = task({ id: "d2", assigneeID: "kaluna", state: "replied", outcome: "succeeded", attempts: 1, createdAt: 11, finishedAt: 21, repliedAt: 21 })
  const hopClark = task({ id: "h1", assigneeID: "leader", state: "pending", workKind: "handoff", createdAt: 22, handoff: { correlationID: "c1", senderID: "clark", recipientID: "leader", depth: 1, completion: true } })
  const hopKaluna = task({ id: "h2", assigneeID: "leader", state: "pending", workKind: "handoff", createdAt: 23, handoff: { correlationID: "c2", senderID: "kaluna", recipientID: "leader", depth: 1, completion: true } })
  const groups = splitActivityGroups(
    [finishedClark, finishedKaluna, hopClark, hopKaluna],
    (item) => item.assigneeID ?? "unassigned",
    (item) => ({ clark: "Clark", kaluna: "Kaluna", leader: "Ava" })[item.assigneeID ?? ""] ?? "?",
    now,
  )
  assert.ok(!groups.live.some((entry) => entry.label === "Clark" || entry.label === "Kaluna"))
  assert.ok(!groups.live.some((entry) => entry.verb === ACTIVITY_DEFAULT_VERB))
  const merged = mergeStreamingActivity(groups.live, [], now)
  assert.ok(!merged.some((entry) => entry.verb === ACTIVITY_DEFAULT_VERB))
})
