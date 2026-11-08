import test from "node:test"
import assert from "node:assert/strict"
import { V2Store } from "./store.ts"
import { createLogger } from "./logging.ts"
import { createStoreObserver, dispatchGroupEvent, dispatchHopEvent } from "./log-events.ts"
import { continuationDispatchLedger, newRootDispatchGroup } from "./dispatch-budget.ts"
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

test("ticket170: a structured queue cause logs task.stalled, not task.failed", async () => {
  const { log, store } = setup()
  await store.saveWorkspace(workspace())
  await store.saveSubtask(subtask({ id: "stalled", state: "working", title: "SECRET_TITLE", instruction: "SECRET_INSTRUCTION" }))
  await store.saveSubtask(subtask({
    id: "stalled",
    state: "replied",
    outcome: "failed",
    attempts: 5,
    title: "SECRET_TITLE",
    instruction: "SECRET_INSTRUCTION",
    error: "Gave up after 5 attempts.",
    failure: { kind: "attempts", reason: "attempts-exhausted" },
    finishedAt: 5,
    repliedAt: 5,
  }))
  assert.equal(log.recent({ event: "task.failed" }).length, 0, "a stall is never a native failure")
  const stalled = log.recent({ event: "task.stalled" })[0] as any
  assert.ok(stalled)
  assert.equal(stalled.level, "warn")
  assert.equal(stalled.taskID, "stalled")
  assert.equal(stalled.failureKind, "attempts")
  assert.equal(stalled.reason, "attempts-exhausted")
  assert.equal(stalled.attempts, 5)
  assert.equal(stalled.error, undefined, "stall logs carry structured codes, not task or error copy")
  assert.equal(JSON.stringify(stalled).includes("SECRET"), false)
})

test("ticket170: deadline and lease causes log task.stalled; native causes log task.failed", async () => {
  const { log, store } = setup()
  await store.saveWorkspace(workspace())
  await store.saveSubtask(subtask({ id: "delivery", state: "working" }))
  await store.saveSubtask(subtask({
    id: "delivery", state: "replied", outcome: "failed", attempts: 1,
    failure: { kind: "delivery", reason: "deadline-exceeded" }, finishedAt: 5, repliedAt: 5,
  }))
  await store.saveSubtask(subtask({ id: "lease", state: "working" }))
  await store.saveSubtask(subtask({
    id: "lease", state: "replied", outcome: "failed", attempts: 1,
    failure: { kind: "lease", reason: "lease-expired" }, finishedAt: 5, repliedAt: 5,
  }))
  await store.saveSubtask(subtask({ id: "native", state: "working" }))
  await store.saveSubtask(subtask({
    id: "native", state: "replied", outcome: "failed", attempts: 1,
    failure: { kind: "native", reason: "provider-error" }, error: "quota exhausted", finishedAt: 5, repliedAt: 5,
  }))
  const stalled = log.recent({ event: "task.stalled" })
  assert.deepEqual(stalled.map((entry) => entry.taskID).sort(), ["delivery", "lease"])
  assert.deepEqual(stalled.map((entry) => (entry as any).reason).sort(), ["deadline-exceeded", "lease-expired"])
  const failed = log.recent({ event: "task.failed" })
  assert.equal(failed.length, 1)
  assert.equal(failed[0]?.taskID, "native")
  assert.equal((failed[0] as any).failureKind, "native")
})

test("ticket170: a legacy terminal failure without structured evidence stays task.failed", async () => {
  const { log, store } = setup()
  await store.saveWorkspace(workspace())
  await store.saveSubtask(subtask({ id: "legacy", state: "working" }))
  await store.saveSubtask(subtask({
    id: "legacy", state: "replied", outcome: "failed", error: "boom", finishedAt: 5, repliedAt: 5,
  }))
  assert.equal(log.recent({ event: "task.stalled" }).length, 0)
  assert.equal(log.recent({ event: "task.failed" }).length, 1)
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

test("ticket170: a removed notice logs identity and kind only", async () => {
  const { log, store } = setup()
  await store.saveWorkspace(workspace())
  const notice = await store.appendMessage("w", {
    id: "m_notice", author: "system", text: "Retrying in 30s: SECRET_REASON", kind: "system",
    taskID: "t", notice: "retry", createdAt: 1,
  })
  await store.removeMessage("w", notice.id)
  const removed = log.recent({ event: "message.removed" })[0] as any
  assert.ok(removed)
  assert.equal(removed.messageID, "m_notice")
  assert.equal(removed.notice, "retry")
  assert.equal(JSON.stringify(removed).includes("SECRET_REASON"), false)
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

test("ticket163: a sealed group projects one closed event with IDs, counts, duration, and reason", async () => {
  const { log, store } = setup()
  await store.saveWorkspace(workspace())
  const root: DispatchGroup = newRootDispatchGroup({ id: "dispatch_root", workspaceID: "w", settings: undefined, now: 10 })
  await store.saveDispatchGroup({ ...root, usedHops: 8, commandUsedHops: 8 })
  await store.saveDispatchGroup({ ...root, usedHops: 8, commandUsedHops: 8, closedAt: 30, closeReason: "continued" })

  const closed = log.recent({ event: "dispatch.group.closed" })
  assert.equal(closed.length, 1)
  assert.equal(closed[0]?.level, "info")
  assert.equal(closed[0]?.cat, "dispatch")
  assert.equal((closed[0] as any).dispatchGroupID, "dispatch_root")
  assert.equal((closed[0] as any).rootID, "dispatch_root")
  assert.equal((closed[0] as any).usedHops, 8)
  assert.equal((closed[0] as any).maxHops, 8)
  assert.equal((closed[0] as any).closeReason, "continued")
  assert.equal((closed[0] as any).closedAt, 30)
  assert.equal((closed[0] as any).durationMs, 20)
  for (const forbidden of ["title", "instruction", "path", "content", "text"] as const) {
    assert.equal(forbidden in (closed[0] as any), false, `closed events carry no ${forbidden}`)
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

test("ticket162: continuation and exhaustion events carry IDs, counts, and reason codes only", () => {
  const root = {
    ...newRootDispatchGroup({ id: "dispatch_root", workspaceID: "w", settings: undefined, now: 1 }),
    usedHops: 8,
    commandUsedHops: 8,
  }
  const ledger = continuationDispatchLedger({ id: "dispatch_cont", root, parent: root, maxHops: 8, now: 10 })
  const continued = dispatchGroupEvent({ event: "continued", group: ledger.group, root: ledger.root, parent: ledger.parent, reason: "continued" })
  assert.equal(continued.level, "info")
  assert.equal(continued.event, "dispatch.group.continued")
  assert.equal(continued.fields.workspaceID, "w")
  assert.equal(continued.fields.dispatchGroupID, "dispatch_cont")
  assert.equal(continued.fields.rootID, "dispatch_root")
  assert.equal(continued.fields.parentID, "dispatch_root")
  assert.equal(continued.fields.continuationIndex, 1)
  assert.equal(continued.fields.usedHops, 0)
  assert.equal(continued.fields.maxHops, 8)
  assert.equal(continued.fields.groupRemaining, 8)
  assert.equal(continued.fields.commandUsedHops, 8)
  assert.equal(continued.fields.commandMaxHops, 24)
  assert.equal(continued.fields.commandRemaining, 16)
  assert.equal(continued.fields.continuationsUsed, 1)
  assert.equal(continued.fields.maxContinuations, 2)
  assert.equal(continued.fields.parentUsedHops, 8)
  assert.equal(continued.fields.parentMaxHops, 8)
  assert.equal(continued.fields.parentCloseReason, "continued")
  assert.equal(continued.fields.reason, "continued")

  const exhausted = dispatchGroupEvent({ event: "exhausted", group: root, root, reason: "group-exhausted" })
  assert.equal(exhausted.level, "warn")
  assert.equal(exhausted.event, "dispatch.group.exhausted")
  assert.equal(exhausted.fields.dispatchGroupID, "dispatch_root")
  assert.equal(exhausted.fields.usedHops, 8)
  assert.equal(exhausted.fields.maxHops, 8)
  assert.equal(exhausted.fields.commandRemaining, 16)
  assert.equal(exhausted.fields.reason, "group-exhausted")

  for (const entry of [continued, exhausted]) {
    for (const forbidden of ["title", "instruction", "path", "content", "text"] as const) {
      assert.equal(forbidden in entry.fields, false, `dispatch group events carry no ${forbidden}`)
    }
  }
  const serialized = JSON.stringify([continued, exhausted])
  assert.ok(!serialized.includes("secret"))
})
