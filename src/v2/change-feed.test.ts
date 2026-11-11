import test from "node:test"
import assert from "node:assert/strict"
import { V2Store } from "./store.ts"
import type { Agent, Approval, InitJob, Memory, Message, NativeSubagentRun, PatchBatch, SessionBinding, Subtask, Workspace } from "./types.ts"

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

const agent = (patch: Partial<Agent> = {}): Agent => ({
  id: "a",
  name: "Nova",
  title: "",
  role: "",
  mainModel: { providerID: "p", modelID: "m" },
  backupModels: [],
  skillbox: [],
  color: "cyan",
  archived: false,
  pendingSettings: false,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
})

const approval = (patch: Partial<Approval> = {}): Approval => ({
  id: "ap",
  workspaceID: "w",
  kind: "ask_person",
  title: "Ask",
  detail: "?",
  status: "pending",
  createdAt: 1,
  ...patch,
})

const binding = (patch: Partial<SessionBinding> = {}): SessionBinding => ({
  workspaceID: "w",
  agentID: "a",
  sessionID: "s",
  kind: "workspace",
  directory: "/repo",
  agentVersion: 1,
  updatedAt: 1,
  ...patch,
})

const memory = (patch: Partial<Memory> = {}): Memory => ({
  id: "mem",
  workspaceID: "w",
  scope: "workspace",
  text: "note",
  origin: "manual",
  source: "user",
  createdAt: 1,
  updatedAt: 1,
  history: [],
  ...patch,
})

const initJob = (patch: Partial<InitJob> = {}): InitJob => ({
  id: "init",
  workspaceID: "w",
  messageID: "m",
  state: "running",
  previousAgentsMD: null,
  startedAt: 1,
  ...patch,
})

const nativeSubagent = (patch: Partial<NativeSubagentRun> = {}): NativeSubagentRun => ({
  childSessionID: "child_1",
  parentSessionID: "parent_1",
  parentTaskID: "t1",
  dispatchGroupID: "dispatch_1",
  workspaceID: "w",
  parentAgentID: "a",
  parentAgent: "Nova",
  instruction: "watch the CI",
  state: "working",
  startedAt: 2,
  source: "session-created",
  ...patch,
})

const message = (patch: Partial<Message> = {}): Message => ({
  id: "m",
  workspaceID: "w",
  seq: 1,
  author: "agent",
  text: "reply",
  kind: "text",
  createdAt: 1,
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
  assert.ok(change.entity === "subtask" && change.op === "upsert")
  assert.deepEqual(change.task, task())
  assert.equal(published[0]!.batch.entries[0]!.other, undefined, "a Work-only version needs no snapshot")
})

test("shell entity mutations publish full-entity upserts without a snapshot fallback", async () => {
  const ctx = fakeContext()
  const batches: PatchBatch[] = []
  const store = new V2Store(ctx, undefined, { epoch: 1, onPatch: (batch) => batches.push(batch) })

  await store.saveAgent(agent())
  await store.saveWorkspace(workspace())
  await store.saveApproval(approval())
  await store.saveBinding(binding())
  await store.saveMemory(memory())
  await store.saveInitJob(initJob())
  await store.updateSettings({ maxActiveRuns: 2, maxDelegations: 10, maxDepth: 5, synthesis: true })
  await store.saveUi({ activeWorkspaceID: "w" })
  store.publishPending()

  const changes = batches.flatMap((batch) => batch.entries.flatMap((entry) => entry.entities ?? entry.changes))
  assert.deepEqual(
    changes.map((change) => `${change.entity}:${change.op}`),
    ["agent:upsert", "workspace:upsert", "approval:upsert", "binding:upsert", "memory:upsert", "initJob:upsert", "settings:upsert", "ui:upsert"],
  )
  assert.deepEqual(changes[0], { entity: "agent", op: "upsert", agent: agent() })
  assert.deepEqual(changes[1], { entity: "workspace", op: "upsert", workspace: workspace() })
  assert.deepEqual(changes[2], { entity: "approval", op: "upsert", approval: approval() })
  assert.deepEqual(changes[3], { entity: "binding", op: "upsert", binding: binding() })
  assert.deepEqual(changes[4], { entity: "memory", op: "upsert", memory: memory() })
  assert.deepEqual(changes[5], { entity: "initJob", op: "upsert", job: initJob() })
  assert.deepEqual(changes[6], {
    entity: "settings",
    op: "upsert",
    settings: {
      maxActiveRuns: 2,
      maxDelegations: 10,
      maxDepth: 5,
      synthesis: true,
      nativeFirst: "on",
      nativeMentionRouting: true,
      dispatchGroupMaxHops: 8,
      dispatchCommandMaxHops: 24,
      dispatchDepth: 8,
      dispatchContinuations: 2,
    },
  })
  assert.deepEqual(changes[7], { entity: "ui", op: "upsert", ui: { activeWorkspaceID: "w" } })
  for (const batch of batches) {
    for (const entry of batch.entries) {
      assert.equal(entry.other, true, "protocol-2 clients keep the snapshot fallback")
      assert.equal(entry.nonEntity, undefined, "protocol-3 clients apply the entity batch")
      assert.ok(entry.entities && entry.entities.length > 0)
    }
  }
})

test("native subagent records publish full-entity upserts and removes", async () => {
  const ctx = fakeContext()
  const batches: PatchBatch[] = []
  const store = new V2Store(ctx, undefined, { epoch: 1, onPatch: (batch) => batches.push(batch) })
  await store.saveNativeSubagent(nativeSubagent())
  store.publishPending()
  const upsert = batches.flatMap((batch) => batch.entries)
  assert.equal(upsert.length, 1)
  assert.equal(upsert[0]!.other, true, "protocol-2 clients take the snapshot fallback")
  assert.deepEqual(upsert[0]!.entities, [{ entity: "nativeSubagent", op: "upsert", run: nativeSubagent() }])

  await store.removeNativeSubagent("child_1")
  store.publishPending()
  const remove = batches.at(-1)!.entries.at(-1)!
  assert.deepEqual(remove.entities, [{ entity: "nativeSubagent", op: "remove", id: "child_1" }])
})

test("shell removals publish explicit remove changes", async () => {
  const ctx = fakeContext()
  const batches: PatchBatch[] = []
  const store = new V2Store(ctx, undefined, { epoch: 1, onPatch: (batch) => batches.push(batch) })
  await store.saveAgent(agent())
  await store.saveWorkspace(workspace())
  await store.saveInitJob(initJob())
  await store.saveBinding(binding())
  store.publishPending()

  await store.removeAgent("a")
  await store.removeWorkspace("w")
  await store.removeInitJob("init")
  await store.removeBinding("w", "a")
  store.publishPending()

  const changes = batches.flatMap((batch) => batch.entries.flatMap((entry) => entry.entities ?? entry.changes))
  assert.deepEqual(changes.slice(-4), [
    { entity: "agent", op: "remove", id: "a" },
    { entity: "workspace", op: "remove", id: "w" },
    { entity: "initJob", op: "remove", id: "init" },
    { entity: "binding", op: "remove", workspaceID: "w", agentID: "a" },
  ])
})

test("pruning a workspace publishes message removals and every removed shell entity", async () => {
  const ctx = fakeContext()
  const batches: PatchBatch[] = []
  const store = new V2Store(ctx, undefined, { epoch: 1, onPatch: (batch) => batches.push(batch) })
  await store.saveWorkspace(workspace())
  await store.saveMessage(message())
  await store.saveSubtask(task())
  await store.saveApproval(approval())
  await store.saveMemory(memory())
  await store.saveInitJob(initJob())
  await store.saveNativeSubagent(nativeSubagent())
  await store.saveBinding(binding())
  store.publishPending()
  await store.pruneWorkspace("w")
  store.publishPending()

  const entry = batches.at(-1)!.entries.at(-1)!
  const changes = entry.entities ?? entry.changes
  assert.equal(entry.other, true, "protocol-2 clients resync after a prune")
  assert.equal(entry.nonEntity, undefined, "protocol-3 clients remove patches without a snapshot")
  assert.deepEqual(
    changes.map((change) => `${change.entity}:${change.op}`).sort(),
    ["approval:remove", "binding:remove", "initJob:remove", "memory:remove", "message:remove", "nativeSubagent:remove", "subtask:remove", "workspace:remove"],
  )
  assert.deepEqual(changes.find((change) => change.entity === "message"), { entity: "message", op: "remove", workspaceID: "w", id: "m" })
})

test("durable messages publish full-entity upserts without a snapshot fallback", async () => {
  const ctx = fakeContext()
  const batches: PatchBatch[] = []
  const store = new V2Store(ctx, undefined, { epoch: 1, onPatch: (batch) => batches.push(batch) })
  await store.saveMessage(message({ text: "failed", kind: "system" }))
  await store.saveMessage(message({ id: "m2", seq: 2, text: "task", kind: "task" }))
  store.publishPending()
  const entries = batches.flatMap((batch) => batch.entries)
  assert.equal(entries.length, 2)
  for (const entry of entries) {
    assert.equal(entry.other, true, "protocol-2 clients keep the snapshot fallback")
    assert.equal(entry.nonEntity, undefined, "protocol-3 clients apply message upserts")
    assert.deepEqual(
      entry.entities?.map((change) => `${change.entity}:${change.op}`),
      ["message:upsert"],
    )
  }
  assert.deepEqual(entries[0]!.entities?.[0], { entity: "message", op: "upsert", message: message({ text: "failed", kind: "system" }) })
  assert.deepEqual(entries[1]!.entities?.[0], { entity: "message", op: "upsert", message: message({ id: "m2", seq: 2, text: "task", kind: "task" }) })
})

test("a live-text checkpoint persists without a coordination version or patch", async () => {
  const ctx = fakeContext()
  const batches: PatchBatch[] = []
  const store = new V2Store(ctx, undefined, { epoch: 1, onPatch: (batch) => batches.push(batch) })
  const live = message({ streaming: true, text: "partial", updatedAt: 2 })
  await store.saveMessage(live)
  store.publishPending()
  batches.length = 0
  const version = store.version()

  live.text = "partial checkpoint"
  live.updatedAt = 3
  await store.checkpointMessage(live)

  assert.equal(store.version(), version, "a checkpoint never bumps the coordination version")
  assert.deepEqual(batches, [], "a checkpoint publishes no durable patch")
  assert.equal((ctx.values.get("v2/message/w/00000001") as Message).text, "partial checkpoint")
})

test("a crash recovers the last streamed checkpoint and leaves settlement to the service", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx, undefined, { epoch: 1 })
  const live = message({ streaming: true, text: "partial", updatedAt: 2 })
  await store.saveMessage(live)
  live.text = "partial checkpoint"
  live.updatedAt = 3
  await store.checkpointMessage(live)

  const recovered = new V2Store(ctx, undefined, { epoch: 2 })
  await recovered.load()
  const messageRow = recovered.message("w", "m")
  assert.equal(messageRow?.text, "partial checkpoint", "at most the text after the last checkpoint is lost")
  // Ticket #148: load never declares a live stream dead. The service settles
  // terminal/expired/stale rows from the streaming index after load.
  assert.equal(messageRow?.streaming, true)
  assert.equal(messageRow?.interrupted, undefined, "load writes no restart marker")
  assert.deepEqual(recovered.streamingMessages(), [{ workspaceID: "w", messageID: "m" }])
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
  const ids = batches.flatMap((batch) => batch.entries.flatMap((entry) => entry.changes.flatMap((change: any) => (change.op === "upsert" ? [change.task.id] : []))))
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

test("a reset names why the cursor cannot be served", async () => {
  const store = new V2Store(fakeContext(), undefined, { epoch: 5, ringLimit: 3 })
  for (let index = 1; index <= 5; index++) await store.saveSubtask(task({ id: `t${index}` }))

  assert.equal(store.changesSince(5, 5).reason, undefined, "a current cursor is not a reset")
  assert.equal(store.changesSince(5, 4).reason, undefined, "a contiguous cursor is not a reset")
  assert.equal(store.changesSince(5, 0).reason, "ring-gap", "an evicted cursor names the ring gap")
  assert.equal(store.changesSince(6, 4).reason, "epoch", "a foreign boot epoch names the epoch")
  assert.equal(store.changesSince(5, 99).reason, "future-version", "a cursor ahead of the store names the future version")
  assert.equal(store.changesSince(NaN, 4).reason, "invalid-cursor")
  assert.equal(store.changesSince(5, NaN).reason, "invalid-cursor")
  assert.equal(store.changesSince(5, -1).reason, "invalid-cursor")
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

test("ticket213: direct conversation bindings publish upserts and removes without a snapshot reset", async () => {
  const ctx = fakeContext()
  const batches: PatchBatch[] = []
  const store = new V2Store(ctx, undefined, { epoch: 1, onPatch: (batch) => batches.push(batch) })
  const direct = binding({ sessionID: "s_direct", kind: "direct" })

  await store.saveBinding(direct)
  store.publishPending()
  const upserts = batches.flatMap((batch) => batch.entries.flatMap((entry) => entry.entities ?? entry.changes))
  assert.deepEqual(upserts, [{ entity: "binding", op: "upsert", binding: direct }])

  await store.removeConversationBinding("a", { kind: "direct", workspaceID: "w", agentID: "a" })
  store.publishPending()
  const changes = batches.flatMap((batch) => batch.entries.flatMap((entry) => entry.entities ?? entry.changes))
  assert.deepEqual(changes.at(-1), { entity: "binding", op: "remove", workspaceID: "w", agentID: "a", kind: "direct" })
  assert.ok(batches.every((batch) => batch.reset !== true), "binding patches never force a full snapshot")
})
