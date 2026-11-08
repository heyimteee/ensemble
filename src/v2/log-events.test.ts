import test from "node:test"
import assert from "node:assert/strict"
import { V2Store } from "./store.ts"
import { createLogger } from "./logging.ts"
import { createStoreObserver, dispatchHopEvent } from "./log-events.ts"
import { newRootDispatchGroup } from "./dispatch-budget.ts"
import type { Approval, DispatchGroup, Subtask, Workspace } from "./types.ts"

function fakeContext() {
  const values = new Map<string, unknown>()
  return {
    storage: {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: unknown) => { values.set(key, value) },
      remove: async (key: string) => { values.delete(key) },
      scan: async ({ prefix, after, limit }: any) => {
        const entries = [...values.entries()]
          .filter(([key]) => key.startsWith(prefix) && (!after || key > after))
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, limit ?? 500)
          .map(([key, value]) => ({ key, value }))
        return { entries, next: entries.length === (limit ?? 500) ? entries.at(-1)?.key : undefined }
      },
    },
  }
}

const logger = () => createLogger({ role: "service", dir: null, level: "debug", ringSize: 200 })

const workspace = (): Workspace => ({
  id: "w", name: "site", directory: "/repo", leaderID: "a", memberIDs: ["a"], synthesis: true,
  archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1,
})

const subtask = (patch: Partial<Subtask> = {}): Subtask => ({
  id: "t", workspaceID: "w", creatorType: "user", title: "Task", instruction: "Do", mode: "research",
  state: "pending", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false, attempts: 0, createdAt: 1, ...patch,
})

function setup() {
  const log = logger()
  const store = new V2Store(fakeContext(), undefined, { observer: createStoreObserver(log) })
  return { log, store }
}

test("task observer logs created, transition, completion, and ignores lease heartbeats", async () => {
  const { log, store } = setup()
  await store.saveWorkspace(workspace())
  await store.saveSubtask(subtask())
  await store.saveSubtask(subtask({ state: "working", claimedBy: "run_1", leaseUntil: 100 }))
  await store.saveSubtask(subtask({ state: "working", claimedBy: "run_1", leaseUntil: 200 }))
  await store.saveSubtask(subtask({ state: "replied", outcome: "succeeded", resultMessageID: "m1", runSummary: "no tool calls" }))

  const events = log.recent().map((entry) => entry.event)
  assert.deepEqual(events, ["task.created", "task.transition", "task.completed"])
  assert.equal(log.recent({ event: "task.transition" }).length, 1)
  const transition = log.recent({ event: "task.transition" })[0] as any
  assert.equal(transition.fromState, "pending")
  assert.equal(transition.toState, "working")
  assert.equal(transition.attempts, 0)
})

test("task observer keeps failure and cancellation distinct", async () => {
  const { log, store } = setup()
  await store.saveWorkspace(workspace())
  await store.saveSubtask(subtask({ id: "fail", state: "working" }))
  await store.saveSubtask(subtask({ id: "fail", state: "replied", outcome: "failed", error: "provider exploded" }))
  await store.saveSubtask(subtask({ id: "cancel", state: "working" }))
  await store.saveSubtask(subtask({ id: "cancel", state: "replied", outcome: "failed", stoppedAt: 5, error: "Cancelled by user." }))

  assert.equal(log.recent({ event: "task.failed" })[0]?.level, "error")
  assert.equal(log.recent({ event: "task.cancelled" }).length, 1)
  assert.equal((log.recent({ event: "task.cancelled" })[0] as any).reason, "Cancelled by user.")
})

test("message observer logs append and finalize, and skips same-length streaming churn", async () => {
  const { log, store } = setup()
  await store.saveWorkspace(workspace())
  const stream = await store.appendMessage("w", { id: "m1", author: "agent", text: "", kind: "text", streaming: true, createdAt: 1 })
  await store.saveMessage({ ...stream, text: "answer", streaming: false, updatedAt: 1 })

  assert.deepEqual(log.recent().map((entry) => entry.event), ["message.appended", "message.finalized"])
  const appended = log.recent()[0] as any
  assert.equal(appended.messageID, "m1")
  assert.equal(appended.chars, 0)
  assert.equal(appended.streaming, true)
  const finalized = log.recent()[1] as any
  assert.equal(finalized.chars, 6)
  assert.equal(finalized.interrupted, false)
})

test("ticket160: dispatch group creation and reconciliation log IDs, counts, and limits only", async () => {
  const { log, store } = setup()
  await store.saveWorkspace(workspace())
  await store.saveSubtask(subtask({ id: "t1", dispatchGroupID: "dispatch_a", title: "secret title", instruction: "secret instruction" }))
  const created: DispatchGroup = newRootDispatchGroup({ id: "dispatch_a", workspaceID: "w", settings: undefined, now: 10 })
  await store.saveDispatchGroup(created)
  const reconciled: DispatchGroup = {
    ...newRootDispatchGroup({ id: "dispatch_legacy", workspaceID: "w", settings: undefined, now: 20 }),
    rootID: "dispatch_legacy",
    usedHops: 2,
    commandUsedHops: 2,
    reconciled: true,
  }
  await store.saveDispatchGroup({ ...reconciled, id: "dispatch_legacy" })
  await store.saveDispatchGroup({ ...reconciled, id: "dispatch_legacy", usedHops: 3, commandUsedHops: 3 })

  const events = log.recent({ cat: "dispatch" })
  assert.deepEqual(events.map((entry) => entry.event), ["dispatch.group.created", "dispatch.group.reconciled", "dispatch.group.updated"])
  assert.equal(events[0]?.level, "info")
  assert.equal(events[0]?.dispatchGroupID, "dispatch_a")
  assert.equal(events[0]?.workspaceID, "w")
  assert.equal(events[0]?.usedHops, 0)
  assert.equal(events[0]?.maxHops, 8)
  assert.equal(events[0]?.commandMaxHops, 24)
  assert.equal(events[0]?.depthMax, 8)
  assert.equal(events[0]?.reconciled, false)
  assert.equal(events[1]?.reconciled, true)
  assert.equal(events[2]?.fromUsedHops, 2)
  assert.equal(events[2]?.usedHops, 3)

  const serialized = JSON.stringify(events)
  assert.ok(!serialized.includes("secret title"), "task titles never enter dispatch events")
  assert.ok(!serialized.includes("secret instruction"), "instructions never enter dispatch events")
  for (const forbidden of ["title", "instruction", "path", "content", "text"] as const) {
    assert.equal(forbidden in (events[0] as any), false, `dispatch events carry no ${forbidden}`)
  }
})

test("ticket161: hop events project IDs, counts, and reason codes only", () => {
  const group: DispatchGroup = {
    ...newRootDispatchGroup({ id: "dispatch_root", workspaceID: "w", settings: undefined, now: 1 }),
    usedHops: 3,
    commandUsedHops: 5,
  }
  const task = subtask({
    id: "hop",
    workspaceID: "w",
    parentID: "parent",
    creatorAgentID: "a",
    assigneeID: "b",
    dispatchGroupID: "dispatch_root",
    taskMaxHops: 2,
    dispatchDepth: 2,
    workKind: "handoff",
    title: "secret title",
    instruction: "secret instruction",
  })
  const consumed = dispatchHopEvent({ outcome: "consumed", task, group })
  assert.equal(consumed.level, "info")
  assert.equal(consumed.event, "dispatch.hop.consumed")
  assert.equal(consumed.fields.workspaceID, "w")
  assert.equal(consumed.fields.dispatchGroupID, "dispatch_root")
  assert.equal(consumed.fields.rootID, "dispatch_root")
  assert.equal(consumed.fields.taskID, "hop")
  assert.equal(consumed.fields.parentID, "parent")
  assert.equal(consumed.fields.actorID, "a")
  assert.equal(consumed.fields.recipientID, "b")
  assert.equal(consumed.fields.workKind, "handoff")
  assert.equal(consumed.fields.usedHops, 3)
  assert.equal(consumed.fields.maxHops, 8)
  assert.equal(consumed.fields.groupRemaining, 5)
  assert.equal(consumed.fields.commandUsedHops, 5)
  assert.equal(consumed.fields.commandMaxHops, 24)
  assert.equal(consumed.fields.commandRemaining, 19)
  assert.equal(consumed.fields.taskMaxHops, 2)
  assert.equal(consumed.fields.dispatchDepth, 2)
  assert.equal(consumed.fields.depthMax, 8)

  const refused = dispatchHopEvent({ outcome: "refused", task, group, refusal: { layer: "group", used: 8, max: 8 } })
  assert.equal(refused.level, "warn")
  assert.equal(refused.event, "dispatch.hop.refused")
  assert.equal(refused.fields.reason, "group-exhausted")
  assert.equal(refused.fields.refusedLayer, "group")
  assert.equal(refused.fields.refusedUsed, 8)
  assert.equal(refused.fields.refusedMax, 8)

  const serialized = JSON.stringify([consumed, refused])
  assert.ok(!serialized.includes("secret title"))
  assert.ok(!serialized.includes("secret instruction"))
  for (const forbidden of ["title", "instruction", "path", "content", "text"] as const) {
    assert.equal(forbidden in consumed.fields, false, `hop events carry no ${forbidden}`)
    assert.equal(forbidden in refused.fields, false, `hop events carry no ${forbidden}`)
  }
})

test("approval observer logs request and resolution", async () => {
  const { log, store } = setup()
  await store.saveWorkspace(workspace())
  const pending: Approval = { id: "ap", workspaceID: "w", kind: "ask_person", title: "Ask", detail: "?", status: "pending", createdAt: 1 }
  await store.saveApproval(pending)
  await store.saveApproval({ ...pending, status: "approved", resolvedAt: 2, resolution: "Approved by user." })

  assert.deepEqual(log.recent().map((entry) => entry.event), ["approval.requested", "approval.resolved"])
  assert.equal((log.recent()[1] as any).fromStatus, "pending")
  assert.equal((log.recent()[1] as any).status, "approved")
})
