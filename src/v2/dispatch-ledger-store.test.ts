import test from "node:test"
import assert from "node:assert/strict"
import { V2Store } from "./store.ts"
import { dispatchGroupState, dispatchGroupRemaining, newRootDispatchGroup } from "./dispatch-budget.ts"
import type { DispatchGroup, PatchBatch, Subtask, Workspace } from "./types.ts"

function fakeContext() {
  const values = new Map<string, unknown>()
  return {
    values,
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

const workspace = (patch: Partial<Workspace> = {}): Workspace => ({
  id: "w", name: "site", directory: "/repo", leaderID: "a", memberIDs: ["a"], synthesis: true,
  archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1, ...patch,
})

const subtask = (patch: Partial<Subtask> = {}): Subtask => ({
  id: "t", workspaceID: "w", creatorType: "agent", creatorAgentID: "a", assigneeID: "b",
  title: "Task", instruction: "Do", mode: "research",
  state: "pending", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
  attempts: 0, createdAt: 1, workKind: "delegation", ...patch,
})

const rootGroup = (patch: Partial<DispatchGroup> = {}): DispatchGroup => ({
  ...newRootDispatchGroup({ id: "dispatch_root", workspaceID: "w", settings: undefined, now: 1 }),
  ...patch,
})

test("ticket160: dispatch groups round-trip through storage and snapshots", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.saveWorkspace(workspace())
  const group = rootGroup()
  await store.saveDispatchGroup(group)
  assert.deepEqual(store.dispatchGroup(group.id), group)
  assert.deepEqual(Object.keys(store.snapshot().dispatchGroups), [group.id])

  const loaded = new V2Store(ctx)
  await loaded.load()
  assert.deepEqual(loaded.dispatchGroup(group.id), group)
  assert.equal(loaded.pendingReconciliationCount(), 0, "a stored group is not a legacy reconciliation")
})

test("ticket160: a dispatch-group upsert travels as a full entity and keeps the protocol-2 fallback", async () => {
  const ctx = fakeContext()
  const batches: PatchBatch[] = []
  const store = new V2Store(ctx, undefined, { epoch: 1, onPatch: (batch: PatchBatch) => batches.push(batch) })
  await store.saveDispatchGroup(rootGroup())
  store.publishPending()
  const entry = batches.flatMap((batch) => batch.entries).at(-1)!
  assert.equal(entry.other, true, "protocol-2 clients fall back to a snapshot")
  assert.equal(entry.nonEntity, undefined, "protocol-3 clients apply the entity batch")
  assert.deepEqual(entry.changes, [], "the legacy subtask view carries no group row")
  assert.deepEqual(entry.entities?.map((change) => `${change.entity}:${change.op}`), ["dispatchGroup:upsert"])
  assert.equal(store.scopeVersions().work, store.version(), "groups move the Work read scope")
  assert.equal(store.scopeVersions().shell < store.version(), true)
})

test("ticket160: legacy groups reconcile once, persist, and grant live tasks the remaining budget", async () => {
  const ctx = fakeContext()
  const seed = new V2Store(ctx)
  await seed.saveWorkspace(workspace())
  const live = subtask({ id: "root-live", creatorType: "user", dispatchGroupID: "dispatch_legacy", taskMaxHops: undefined })
  const child = subtask({ id: "child-live", parentID: "root-live", dispatchGroupID: "dispatch_legacy", createdAt: 2 })
  const child2 = subtask({ id: "child-live-2", parentID: "child-live", dispatchGroupID: "dispatch_legacy", createdAt: 3 })
  const done = subtask({ id: "done", dispatchGroupID: "dispatch_legacy", state: "replied", outcome: "succeeded", createdAt: 4 })
  for (const task of [live, child, child2, done]) await seed.saveSubtask(task)

  const store = new V2Store(ctx)
  await store.load()
  const synthesized = store.dispatchGroup("dispatch_legacy")
  assert.ok(synthesized)
  assert.equal(synthesized!.reconciled, true)
  assert.equal(synthesized!.usedHops, 3, "every non-completion agent delegation counts, terminal or live")
  assert.equal(synthesized!.maxHops, 8)
  assert.equal(synthesized!.commandUsedHops, 3)
  assert.equal(dispatchGroupState(synthesized!), "active")
  assert.equal(store.pendingReconciliationCount(), 1, "synthesis is in-memory until the write pass")

  const reconciled = await store.reconcileDispatchGroups()
  assert.deepEqual(reconciled, ["dispatch_legacy"])
  assert.equal(store.pendingReconciliationCount(), 0)
  const remaining = dispatchGroupRemaining(synthesized!)
  assert.equal(store.subtask("root-live")?.taskMaxHops, remaining)
  assert.equal(store.subtask("child-live")?.taskMaxHops, remaining)
  assert.equal(store.subtask("done")?.taskMaxHops, undefined, "terminal work keeps no new task budget")

  const reloaded = new V2Store(ctx)
  await reloaded.load()
  assert.equal(reloaded.dispatchGroup("dispatch_legacy")?.reconciled, true)
  assert.equal(reloaded.pendingReconciliationCount(), 0, "persisted reconciliation does not repeat")
  assert.equal(await reloaded.reconcileDispatchGroups().then((ids) => ids.length), 0)
  assert.equal(reloaded.subtask("root-live")?.taskMaxHops, remaining)
})

test("ticket160: reconciliation fills only live rows that lack a task budget", async () => {
  const ctx = fakeContext()
  const seed = new V2Store(ctx)
  await seed.saveWorkspace(workspace())
  const explicit = subtask({ id: "explicit", dispatchGroupID: "dispatch_legacy", taskMaxHops: 0, createdAt: 1 })
  const missing = subtask({ id: "missing", dispatchGroupID: "dispatch_legacy", createdAt: 2 })
  for (const task of [explicit, missing]) await seed.saveSubtask(task)

  const store = new V2Store(ctx)
  await store.load()
  const group = store.dispatchGroup("dispatch_legacy")!
  await store.reconcileDispatchGroups()
  assert.equal(store.subtask("explicit")?.taskMaxHops, 0, "a stored zero budget is deliberate and never overwritten")
  assert.equal(store.subtask("missing")?.taskMaxHops, dispatchGroupRemaining(group))
})

test("ticket159: concurrent identical admissions dedupe by queue key and consume once", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.saveWorkspace(workspace())
  await store.saveDispatchGroup(rootGroup())
  const left = subtask({ id: "left", dispatchGroupID: "dispatch_root", queueKey: "work:w:delegation:same" })
  const right = subtask({ id: "right", dispatchGroupID: "dispatch_root", queueKey: "work:w:delegation:same" })
  const [one, two] = await Promise.all([
    store.admitDispatchedSubtask(left, { enforce: true }),
    store.admitDispatchedSubtask(right, { enforce: true }),
  ])
  assert.equal(one.admitted && two.admitted, true)
  assert.equal([one, two].filter((result) => result.consumed).length, 1, "one serialized admission spends the hop")
  assert.equal([one, two].filter((result) => result.deduped).length, 1, "the loser reports the existing row")
  assert.equal(one.task.id, two.task.id, "both callers observe one work item")
  assert.equal([store.subtask("left"), store.subtask("right")].filter(Boolean).length, 1)
  assert.equal(store.dispatchGroup("dispatch_root")?.usedHops, 1)
  assert.equal(store.dispatchGroup("dispatch_root")?.commandUsedHops, 1)
})

test("ticket160: admitting work spends group and command hops in one mutation, once", async () => {
  const ctx = fakeContext()
  const batches: PatchBatch[] = []
  const store = new V2Store(ctx, undefined, { epoch: 1, onPatch: (batch: PatchBatch) => batches.push(batch) })
  await store.saveWorkspace(workspace())
  await store.saveDispatchGroup(rootGroup())
  const first = subtask({ id: "hop-1", dispatchGroupID: "dispatch_root" })
  const admitted = await store.admitDispatchedSubtask(first)
  assert.equal(admitted.admitted, true)
  assert.equal(admitted.consumed, true)
  assert.equal(admitted.group?.usedHops, 1)
  assert.equal(commandUsed(store, "dispatch_root"), 1)
  assert.ok(store.subtask("hop-1"))

  // The same work item replayed is idempotent: no second spend.
  const replay = await store.admitDispatchedSubtask({ ...first, title: "changed" })
  assert.equal(replay.consumed, false)
  assert.equal(replay.task.title, "Task")
  assert.equal(commandUsed(store, "dispatch_root"), 1)

  store.publishPending()
  const entry = batches
    .flatMap((batch) => batch.entries)
    .filter((item) => item.entities?.some((change) => change.entity === "dispatchGroup"))
    .at(-1)!
  assert.deepEqual(entry.entities?.map((change) => `${change.entity}:${change.op}`), ["subtask:upsert", "dispatchGroup:upsert"])
  assert.equal(entry.changes.length, 1, "the task remains visible to protocol-2 clients")
  assert.equal(entry.changes[0]?.entity, "subtask")
})

test("ticket160: concurrent admissions at the last hop admit exactly one when enforcement is on", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.saveWorkspace(workspace())
  await store.saveDispatchGroup(rootGroup({ usedHops: 7, commandUsedHops: 7 }))
  const left = subtask({ id: "left", dispatchGroupID: "dispatch_root" })
  const right = subtask({ id: "right", dispatchGroupID: "dispatch_root" })
  const [one, two] = await Promise.all([
    store.admitDispatchedSubtask(left, { enforce: true }),
    store.admitDispatchedSubtask(right, { enforce: true }),
  ])
  assert.equal([one, two].filter((result) => result.admitted).length, 1)
  const refused = [one, two].find((result) => !result.admitted)
  assert.equal(refused?.reason, "group-exhausted")
  assert.equal(store.dispatchGroup("dispatch_root")?.usedHops, 8)
  assert.equal(store.dispatchGroup("dispatch_root")?.commandUsedHops, 8)
  assert.equal([store.subtask("left"), store.subtask("right")].filter(Boolean).length, 1)
})

test("ticket161: admission enforces task, group, depth, command, and fan-out in order", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.saveWorkspace(workspace())
  await store.saveDispatchGroup(rootGroup({ usedHops: 0, commandUsedHops: 0, depthMax: 2 }))
  const asking = subtask({ id: "ask", creatorType: "user", dispatchGroupID: "dispatch_root", taskMaxHops: 1, dispatchDepth: 0 })
  await store.saveSubtask(asking)
  const child = subtask({ id: "child", parentID: "ask", dispatchGroupID: "dispatch_root", dispatchDepth: 1 })
  await store.saveSubtask(child)
  const candidate = (id: string, patch: Partial<Subtask> = {}) => subtask({ id, parentID: "ask", dispatchGroupID: "dispatch_root", ...patch })

  // The sender's task budget wins the order even when the group is also full.
  await store.saveDispatchGroup(rootGroup({ usedHops: 8, commandUsedHops: 24, depthMax: 2 }))
  const taskLimited = await store.admitDispatchedSubtask(candidate("task-limited"), { enforce: true, maxPerRun: 0 })
  assert.equal(taskLimited.admitted, false)
  assert.equal(taskLimited.reason, "task-exhausted")
  assert.equal(taskLimited.consumed, false)
  assert.equal(store.subtask("task-limited"), undefined)

  // Release the task-local cap so the lower layers can be proven in order.
  const unboundedQuestion = store.cloneSubtask("ask")!
  unboundedQuestion.taskMaxHops = undefined
  await store.saveSubtask(unboundedQuestion)

  // Group before depth and command.
  await store.saveDispatchGroup(rootGroup({ usedHops: 8, commandUsedHops: 24, depthMax: 0 }))
  const groupLimited = await store.admitDispatchedSubtask(candidate("group-limited"), { enforce: true })
  assert.equal(groupLimited.reason, "group-exhausted")

  // Depth before command.
  const deep = store.cloneSubtask("child")!
  deep.dispatchDepth = 2
  deep.taskMaxHops = undefined
  await store.saveSubtask(deep)
  await store.saveDispatchGroup(rootGroup({ usedHops: 1, commandUsedHops: 24, depthMax: 2 }))
  const depthLimited = await store.admitDispatchedSubtask(subtask({ id: "depth-limited", parentID: "child", dispatchGroupID: "dispatch_root" }), { enforce: true })
  assert.equal(depthLimited.reason, "depth-exhausted")

  // Command before fan-out.
  await store.saveDispatchGroup(rootGroup({ usedHops: 1, commandUsedHops: 24, depthMax: 8 }))
  const commandLimited = await store.admitDispatchedSubtask(candidate("command-limited"), { enforce: true, maxPerRun: 0 })
  assert.equal(commandLimited.reason, "command-exhausted")

  // Fan-out is the last guard and never spends a hop.
  await store.saveDispatchGroup(rootGroup({ usedHops: 1, commandUsedHops: 1, depthMax: 8 }))
  const fanOutLimited = await store.admitDispatchedSubtask(candidate("fanout-limited"), { enforce: true, maxPerRun: 1 })
  assert.equal(fanOutLimited.reason, "fanout-exhausted")
  assert.equal(store.dispatchGroup("dispatch_root")?.usedHops, 1)
  assert.equal(store.subtask("fanout-limited"), undefined)

  // The next admitted child records its unified depth and spends one hop.
  await store.saveDispatchGroup(rootGroup({ usedHops: 1, commandUsedHops: 1, depthMax: 8 }))
  const admitted = await store.admitDispatchedSubtask(candidate("ok"), { enforce: true, maxPerRun: 3 })
  assert.equal(admitted.admitted, true)
  assert.equal(admitted.consumed, true)
  assert.equal(store.subtask("ok")?.dispatchDepth, 1)
  assert.equal(store.dispatchGroup("dispatch_root")?.usedHops, 2)
})

test("ticket161: a rejected admission leaves the existing group and tasks untouched", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.saveWorkspace(workspace())
  await store.saveDispatchGroup(rootGroup({ usedHops: 8, commandUsedHops: 8 }))
  const rejected = subtask({ id: "rejected", dispatchGroupID: "dispatch_root", title: "Secret work", instruction: "Secret instruction" })
  const result = await store.admitDispatchedSubtask(rejected, { enforce: true })
  assert.equal(result.admitted, false)
  assert.equal(result.refusal?.layer, "group")
  assert.equal(store.subtask("rejected"), undefined)
  assert.equal(store.dispatchGroup("dispatch_root")?.usedHops, 8)
  assert.equal(store.dispatchGroup("dispatch_root")?.commandUsedHops, 8)
  assert.equal(ctx.values.has("v2/subtask/rejected"), false)
})

function commandUsed(store: V2Store, groupID: string): number | undefined {
  return store.dispatchGroup(groupID)?.commandUsedHops
}

test("ticket160: pruning a workspace removes its dispatch groups", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.saveWorkspace(workspace())
  await store.saveDispatchGroup(rootGroup())
  await store.pruneWorkspace("w")
  assert.equal(store.dispatchGroup("dispatch_root"), undefined)
  assert.equal(ctx.values.has("v2/dispatchgroup/dispatch_root"), false)
})
