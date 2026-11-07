import test from "node:test"
import assert from "node:assert/strict"
import { V2Store } from "./store.ts"
import type { PatchBatch, Subtask, Workspace } from "./types.ts"

function fakeContext(values = new Map<string, unknown>()) {
  const writes: string[] = []
  const storage = {
    get: async (key: string) => values.get(key),
    set: async (key: string, value: unknown) => {
      writes.push(key)
      values.set(key, value)
    },
    remove: async (key: string) => {
      writes.push(key)
      values.delete(key)
    },
    scan: async ({ prefix, after, limit }: any) => {
      const entries = [...values.entries()]
        .filter(([key]) => key.startsWith(prefix) && (!after || key > after))
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, limit ?? 500)
        .map(([key, value]) => ({ key, value }))
      return { entries, next: entries.length === (limit ?? 500) ? entries.at(-1)?.key : undefined }
    },
  }
  return { values, writes, storage }
}

const workspace = (patch: Partial<Workspace> = {}): Workspace => ({
  id: "w",
  name: "site",
  directory: "/repo",
  leaderID: "a",
  memberIDs: ["a"],
  synthesis: true,
  archived: false,
  paused: false,
  nextSeq: 1,
  createdAt: 1,
  lastActiveAt: 1,
  ...patch,
})

const task = (patch: Partial<Subtask> = {}): Subtask => ({
  id: "t1",
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

const versions = (batches: PatchBatch[]) => batches.flatMap((batch) => batch.entries.map((entry) => entry.version))

test("a task mutation persists its entity and meta before a full-entity patch is published", async () => {
  const ctx = fakeContext()
  const published: Array<{ batch: PatchBatch; taskStored: boolean; metaStored: boolean }> = []
  const store = new V2Store(ctx, undefined, {
    epoch: 7,
    onPatch: (batch) => {
      published.push({ batch, taskStored: ctx.values.has("v2/subtask/t1"), metaStored: ctx.values.has("v2/meta") })
    },
  })

  await store.saveSubtask(task())
  store.publishPending()

  assert.equal(published.length, 1)
  assert.equal(published[0]!.batch.epoch, 7)
  assert.equal(published[0]!.batch.from, 0)
  assert.equal(published[0]!.batch.version, 1)
  assert.equal(published[0]!.taskStored, true, "the entity is durable before publication")
  assert.equal(published[0]!.metaStored, true, "the version is durable before publication")
  assert.deepEqual(versions([published[0]!.batch]), [1])
  const change = published[0]!.batch.entries[0]!.changes[0]!
  assert.equal(change.entity, "subtask")
  assert.equal(change.op, "upsert")
  assert.deepEqual(change.task, task())
  assert.equal(published[0]!.batch.entries[0]!.other, undefined, "a Work-only version needs no snapshot")
})

test("a non-Work version marks its entry so the client falls back to a snapshot", async () => {
  const ctx = fakeContext()
  const batches: PatchBatch[] = []
  const store = new V2Store(ctx, undefined, { epoch: 1, onPatch: (batch) => batches.push(batch) })
  await store.saveWorkspace(workspace())
  store.publishPending()
  assert.equal(batches[0]!.entries[0]!.other, true)
})

test("a removal publishes a full remove change", async () => {
  const ctx = fakeContext()
  const batches: PatchBatch[] = []
  const store = new V2Store(ctx, undefined, { epoch: 1, onPatch: (batch) => batches.push(batch) })
  await store.saveSubtask(task())
  store.publishPending()
  await store.removeSubtask("t1")
  store.publishPending()

  const removal = batches.at(-1)!.entries.at(-1)!.changes[0]!
  assert.equal(removal.entity, "subtask")
  assert.equal(removal.op, "remove")
  assert.equal(removal.id, "t1")
})

test("the write queue serializes concurrent mutations into contiguous versions", async () => {
  const ctx = fakeContext()
  const set = ctx.storage.set
  ctx.storage.set = async (key: string, value: unknown) => {
    await new Promise((resolve) => setTimeout(resolve, key.startsWith("v2/meta") ? 8 : 1))
    await set(key, value)
  }
  const batches: PatchBatch[] = []
  const store = new V2Store(ctx, undefined, { epoch: 1, onPatch: (batch) => batches.push(batch) })

  await Promise.all([
    store.saveSubtask(task({ id: "t1" })),
    store.saveSubtask(task({ id: "t2" })),
    store.saveSubtask(task({ id: "t3" })),
  ])
  store.publishPending()

  assert.deepEqual(Object.keys(store.snapshot().subtasks).sort(), ["t1", "t2", "t3"])
  assert.deepEqual(versions(batches), [1, 2, 3], "one logical version per mutation, in write order")
  const ids = batches.flatMap((batch) => batch.entries.flatMap((entry) => entry.changes.flatMap((change) => (change.op === "upsert" ? [change.task.id] : []))))
  assert.deepEqual(ids, ["t1", "t2", "t3"])
})

test("the change ring is bounded and an old cursor resets instead of returning a gapped patch", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx, undefined, { epoch: 5, ringLimit: 3 })
  for (let index = 1; index <= 5; index++) await store.saveSubtask(task({ id: `t${index}` }))

  assert.deepEqual(store.changesSince(5, 5).entries, [])
  assert.equal(store.changesSince(5, 5).reset, false)
  assert.deepEqual(store.changesSince(5, 4).entries.map((entry) => entry.version), [5])
  assert.equal(store.changesSince(5, 0).reset, true, "an evicted cursor cannot be served as a contiguous patch")
  assert.equal(store.changesSince(6, 4).reset, true, "a different boot epoch always resets")
  assert.equal(store.changesSince(5, 99).reset, true, "a cursor ahead of the server resets")
})

test("a foreign write makes the change feed reset and the synced store keeps the foreign task", async () => {
  const values = new Map<string, unknown>()
  const readerCtx = fakeContext(values)
  const writerCtx = fakeContext(values)
  const reader = new V2Store(readerCtx, undefined, { epoch: 1 })
  await reader.load()
  const baseline = reader.version()

  const writer = new V2Store(writerCtx, undefined, { epoch: 2 })
  await writer.load()
  await writer.saveWorkspace(workspace())
  await writer.saveSubtask(task())

  await reader.sync()
  assert.equal(reader.subtask("t1")?.id, "t1", "the foreign data is hydrated before the feed is asked")
  const result = reader.changesSince(1, baseline)
  assert.equal(result.reset, true, "the local ring cannot describe a foreign version")
  assert.equal(result.version, reader.version())
})
