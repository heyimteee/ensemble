import test from "node:test"
import assert from "node:assert/strict"
import { createInitialState } from "../defaults.ts"
import type { PatchBatch, Snapshot, Subtask } from "../types.ts"
import { createClientStore } from "./client-store.ts"
import { decideChangesSince, decidePatchApply, supportsPatchFeed, type SnapshotMeta } from "./refresh-coordinator.ts"

const meta = (value: Partial<SnapshotMeta> & { version: number }): SnapshotMeta => ({
  catalogRevision: 1,
  configRevision: 1,
  protocol: 2,
  epoch: 10,
  directory: "/tmp/ensemble",
  ...value,
})

const task = (id: string, patch: Partial<Subtask> = {}): Subtask => ({
  id,
  workspaceID: "w1",
  creatorType: "user",
  assigneeID: "a1",
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

const upsert = (version: number, id: string, patch: Partial<Subtask> = {}) => ({
  version,
  changes: [{ entity: "subtask" as const, op: "upsert" as const, task: task(id, patch) }],
})

const removal = (version: number, id: string) => ({
  version,
  changes: [{ entity: "subtask" as const, op: "remove" as const, id }],
})

const batch = (value: Partial<PatchBatch> & { from: number; version: number }): PatchBatch => ({
  epoch: 10,
  entries: [],
  ...value,
})

test("a valid patch applies only the versions after the client cursor", () => {
  const decision = decidePatchApply(meta({ version: 4 }), batch({
    from: 3,
    version: 6,
    entries: [upsert(4, "t1"), upsert(5, "t2"), removal(6, "t3")],
  }))
  assert.deepEqual(decision, {
    action: "apply",
    version: 6,
    changes: [
      { entity: "subtask", op: "upsert", task: task("t2") },
      { entity: "subtask", op: "remove", id: "t3" },
    ],
  })
})

test("a reordered or duplicate patch is ignored", () => {
  assert.deepEqual(decidePatchApply(meta({ version: 6 }), batch({
    from: 3,
    version: 6,
    entries: [upsert(4, "t1"), upsert(5, "t2"), removal(6, "t3")],
  })), { action: "ignore" })
  assert.deepEqual(decidePatchApply(meta({ version: 6 }), batch({
    from: 6,
    version: 6,
    entries: [],
  })), { action: "ignore" })
})

test("overlapping redelivery keeps only the changes after the cursor", () => {
  const decision = decidePatchApply(meta({ version: 5 }), batch({
    from: 3,
    version: 7,
    entries: [upsert(4, "t1"), upsert(5, "t2"), upsert(6, "t3"), upsert(7, "t4")],
  }))
  assert.equal(decision.action, "apply")
  assert.deepEqual(decision.action === "apply" ? decision.changes.map((change) => change.op === "upsert" ? change.task.id : change.id) : [], ["t3", "t4"])
  assert.equal(decision.action === "apply" ? decision.version : 0, 7)
})

test("a gap, epoch change, reset, and malformed batch all ask for a resync", () => {
  assert.equal((decidePatchApply(meta({ version: 4 }), batch({ from: 8, version: 9, entries: [upsert(9, "t1")] })) as any).reason, "gap")
  assert.equal((decidePatchApply(meta({ version: 4, epoch: 10 }), batch({ epoch: 11, from: 4, version: 5, entries: [upsert(5, "t1")] })) as any).reason, "epoch")
  assert.equal((decidePatchApply(meta({ version: 4 }), batch({ from: 4, version: 5, reset: true })) as any).reason, "reset")
  assert.equal((decidePatchApply(undefined, batch({ from: 4, version: 5, entries: [upsert(5, "t1")] })) as any).reason, "unloaded")
  assert.equal((decidePatchApply(meta({ version: 4 }), batch({ from: 4, version: 6, entries: [upsert(5, "t1")] })) as any).reason, "malformed")
  assert.equal((decidePatchApply(meta({ version: 4 }), batch({
    from: 4,
    version: 5,
    entries: [{ version: 5, changes: [{ entity: "agent", op: "upsert", task: task("t1") }] } as any],
  })) as any).reason, "malformed")
  assert.equal((decidePatchApply(meta({ version: 4 }), batch({
    from: 4,
    version: 5,
    entries: [{ version: 5, changes: [{ entity: "subtask", op: "upsert" }] } as any],
  })) as any).reason, "malformed")
})

test("a version with non-Work changes resyncs the full snapshot path", () => {
  const decision = decidePatchApply(meta({ version: 4 }), batch({
    from: 4,
    version: 6,
    entries: [
      upsert(5, "t1"),
      { version: 6, changes: [], other: true },
    ],
  }))
  assert.deepEqual(decision, { action: "resync", reason: "other" })
})

test("a changes.since response recovers a dropped event as patches or a reset", () => {
  const recovered = decideChangesSince(meta({ version: 4 }), {
    epoch: 10,
    version: 6,
    reset: false,
    entries: [upsert(5, "t1"), upsert(6, "t2")],
  })
  assert.equal(recovered.action, "apply")
  assert.deepEqual(recovered.action === "apply" ? recovered.changes.map((change) => change.op === "upsert" ? change.task.id : change.id) : [], ["t1", "t2"])
  assert.equal(recovered.action === "apply" ? recovered.version : 0, 6)

  assert.equal((decideChangesSince(meta({ version: 4 }), {
    epoch: 10,
    version: 6,
    reset: true,
    entries: [],
  }) as any).reason, "reset")
  assert.equal((decideChangesSince(meta({ version: 4 }), {
    epoch: 9,
    version: 6,
    reset: false,
    entries: [upsert(5, "t1")],
  }) as any).reason, "epoch")
})

test("the client only negotiates the feed on protocol 2 or later", () => {
  assert.equal(supportsPatchFeed(meta({ version: 1 })), true)
  assert.equal(supportsPatchFeed({ ...meta({ version: 1 }), protocol: 1 }), false)
  assert.equal(supportsPatchFeed({ ...meta({ version: 1 }), epoch: undefined }), false)
  assert.equal(supportsPatchFeed(undefined), false)
})

test("the client store applies full-entity upserts and removals without replacing other entities", () => {
  const state = createInitialState()
  state.version = 4
  state.agents.a1 = {
    id: "a1", name: "Ada", title: "", role: "", mainModel: { providerID: "p", modelID: "m" },
    backupModels: [], skillbox: [], color: "blue", archived: false, pendingSettings: false,
    version: 1, createdAt: 1, updatedAt: 1,
  }
  state.messages.w1 = [{ id: "m1", workspaceID: "w1", seq: 1, author: "user", text: "hello", kind: "text", createdAt: 1 }]
  state.subtasks.t1 = task("t1")
  state.subtasks.t2 = task("t2")
  const snapshot: Snapshot = {
    state,
    models: [{ providerID: "p", modelID: "m", name: "Model", variants: [] }],
    skills: [],
    directory: "/tmp/ensemble",
    protocol: 2,
    epoch: 10,
    catalogRevision: 3,
    configRevision: 4,
  }
  const store = createClientStore()
  store.applySnapshot(snapshot)

  store.applyWorkChanges([
    { entity: "subtask", op: "upsert", task: task("t1", { state: "working" }) },
    { entity: "subtask", op: "remove", id: "t2" },
  ], 6)

  assert.equal(store.state()?.subtasks.t1?.state, "working")
  assert.equal(store.state()?.subtasks.t2, undefined)
  assert.equal(store.state()?.version, 6)
  assert.equal(store.state()?.agents.a1?.name, "Ada", "unrelated entities keep their identity")
  assert.equal(store.state()?.messages.w1?.[0]?.text, "hello")

  store.applyWorkSnapshot({
    ...snapshot,
    state: { ...state, version: 9, subtasks: { t3: task("t3") } },
  })
  assert.deepEqual(Object.keys(store.state()?.subtasks ?? {}), ["t3"])
  assert.equal(store.state()?.version, 9)
  assert.equal(store.state()?.messages.w1?.[0]?.text, "hello", "a scoped Work resync preserves the transcript")
  assert.equal(store.epoch(), 10)
})

test("SnapshotMeta stays the feed cursor shape", () => {
  const value: SnapshotMeta = meta({ version: 3 })
  assert.equal(value.protocol, 2)
})
