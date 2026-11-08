import test from "node:test"
import assert from "node:assert/strict"
import type { Subtask } from "../types.ts"
import { WORK_CARD_ACTIONS, isWorkActionID, pendingWorkSettled, workLifecycleSignature, workTaskActions } from "./workactions.ts"

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

const ids = (value: Subtask | undefined, now = 5_000) => [...workTaskActions(value, now)].sort()

test("ticket173: an active card advertises the actions it can actually run", () => {
  assert.deepEqual(ids(task({ id: "pending" })), ["work.cancel", "work.delegate", "work.native", "work.reassign", "work.restart"])
  assert.deepEqual(
    ids(task({ id: "working", state: "working", claimedBy: "run", leaseUntil: 99_000, attempts: 1 })),
    ["work.cancel", "work.delegate", "work.native", "work.reassign", "work.restart"],
  )
  assert.deepEqual(
    ids(task({ id: "pending-result", resultMessageID: "m1" })),
    ["work.cancel", "work.delegate", "work.native", "work.open", "work.reassign", "work.restart"],
    "a durable result adds the Enter action",
  )
})

test("ticket173: retry is offered for stalled and scheduled-retry cards, not queued cards", () => {
  const stalled = task({ id: "stalled", attempts: 5 })
  assert.ok(ids(stalled).includes("work.retry"))
  const retrying = task({ id: "retrying", state: "working", attempts: 2, retryAfter: 9_000 })
  assert.ok(ids(retrying).includes("work.retry"))
  assert.ok(!ids(task({ id: "queued" })).includes("work.retry"))
})

test("ticket173: history cards keep only the actions that are valid for a finished row", () => {
  const failed = task({ id: "failed", state: "replied", outcome: "failed", resultMessageID: "m1", createdAt: 1, finishedAt: 2, repliedAt: 2 })
  assert.deepEqual(ids(failed), ["work.native", "work.open", "work.restart", "work.retry"])
  const cancelled = task({ id: "cancelled", state: "replied", outcome: "failed", stoppedAt: 3, resultMessageID: "m2", finishedAt: 3, repliedAt: 3 })
  assert.deepEqual(ids(cancelled), ["work.native", "work.open", "work.restart", "work.retry"])
  const replied = task({ id: "replied", state: "replied", outcome: "succeeded", resultMessageID: "m3", createdAt: 1, finishedAt: 2, repliedAt: 2 })
  assert.deepEqual(ids(replied), ["work.native", "work.open"])
  assert.deepEqual(
    ids(task({ id: "no-result", state: "replied", outcome: "succeeded", createdAt: 1, finishedAt: 2, repliedAt: 2 })),
    ["work.native"],
    "a finished row without a durable result has nothing to open",
  )
})

test("ticket173: no task means no advertised action and a task without an assignee has no native action", () => {
  assert.deepEqual(ids(undefined), [])
  assert.deepEqual(ids(task({ id: "unassigned", assigneeID: undefined })), ["work.cancel", "work.delegate", "work.reassign", "work.restart"])
})

test("ticket173: the advertised action ids are one closed set shared with the keymap", () => {
  assert.deepEqual([...WORK_CARD_ACTIONS].sort(), [
    "work.cancel",
    "work.delegate",
    "work.native",
    "work.open",
    "work.reassign",
    "work.restart",
    "work.retry",
  ])
  assert.equal(isWorkActionID("work.open"), true)
  assert.equal(isWorkActionID("work.filter"), false)
})

test("ticket173: a pending action settles on the durable update, never the RPC return", () => {
  const stalled = task({ id: "stalled", state: "replied", outcome: "failed", attempts: 5, failure: { kind: "attempts", reason: "attempts-exhausted" } })
  const pending = { id: stalled.id, action: "retry" as const, before: workLifecycleSignature(stalled) }
  assert.equal(pendingWorkSettled(pending, stalled), false, "the pre-action row keeps the label visible")
  const requeued = task({ ...stalled, state: "pending", outcome: "pending", attempts: 0, failure: undefined })
  assert.equal(pendingWorkSettled(pending, requeued), true, "the requeued row settles the label")
  assert.equal(pendingWorkSettled(pending, undefined), true, "a disappeared row never sticks")
})
