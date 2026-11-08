import test from "node:test"
import assert from "node:assert/strict"
import { createInitialState } from "../defaults.ts"
import type { PatchBatch, Snapshot, Subtask } from "../types.ts"
import { createClientStore } from "./client-store.ts"
import { decideChangesSince, decidePatchApply, mergeFeedMeta, supportsPatchFeed, validMessageStream, type SnapshotMeta } from "./refresh-coordinator.ts"

const meta = (value: Partial<SnapshotMeta> & { version: number }): SnapshotMeta => ({
  catalogRevision: 1,
  configRevision: 1,
  protocol: 3,
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
  assert.deepEqual(decision.action === "apply" ? decision.changes.map((change: any) => change.op === "upsert" ? change.task.id : change.id) : [], ["t3", "t4"])
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
    entries: [{ version: 5, changes: [{ entity: "bogus", op: "upsert", task: task("t1") }] } as any],
  })) as any).reason, "malformed")
  assert.equal((decidePatchApply(meta({ version: 4 }), batch({
    from: 4,
    version: 5,
    entries: [{ version: 5, changes: [{ entity: "subtask", op: "upsert" }] } as any],
  })) as any).reason, "malformed")
})

test("shell entity changes apply atomically through the same feed", () => {
  const decision = decidePatchApply(meta({ version: 4 }), batch({
    from: 4,
    version: 6,
    entries: [
      {
        version: 5,
        changes: [
          { entity: "agent", op: "upsert", agent: { id: "a1", name: "Ada" } },
          { entity: "workspace", op: "upsert", workspace: { id: "w1", name: "site" } },
          { entity: "approval", op: "upsert", approval: { id: "ap1", status: "pending" } },
        ],
      },
      {
        version: 6,
        changes: [
          { entity: "binding", op: "upsert", binding: { workspaceID: "w1", agentID: "a1", sessionID: "s1" } },
          { entity: "memory", op: "upsert", memory: { id: "mem1", text: "note" } },
          { entity: "initJob", op: "upsert", job: { id: "init1", state: "running" } },
          { entity: "settings", op: "upsert", settings: { maxActiveRuns: 2 } },
          { entity: "ui", op: "upsert", ui: { activeWorkspaceID: "w1" } },
          { entity: "binding", op: "remove", workspaceID: "w1", agentID: "a2" },
          { entity: "memory", op: "remove", id: "mem2" },
          { entity: "initJob", op: "remove", id: "init2" },
          { entity: "approval", op: "remove", id: "ap2" },
          { entity: "agent", op: "remove", id: "a2" },
          { entity: "workspace", op: "remove", id: "w2" },
        ],
      },
    ] as any,
  }))
  assert.equal(decision.action, "apply")
  assert.equal(decision.action === "apply" ? decision.version : 0, 6)
  assert.deepEqual(
    decision.action === "apply" ? decision.changes.map((change) => `${change.entity}:${change.op}`) : [],
    ["agent:upsert", "workspace:upsert", "approval:upsert", "binding:upsert", "memory:upsert", "initJob:upsert", "settings:upsert", "ui:upsert", "binding:remove", "memory:remove", "initJob:remove", "approval:remove", "agent:remove", "workspace:remove"],
  )
})

test("message upserts and removals apply atomically through the feed", () => {
  const first = {
    id: "m1", workspaceID: "w1", seq: 1, author: "agent" as const, text: "partial", kind: "text" as const, createdAt: 1, streaming: true,
  }
  const final = {
    id: "m1", workspaceID: "w1", seq: 1, author: "agent" as const, text: "exact final", kind: "text" as const, createdAt: 1, streaming: false,
  }
  const decision = decidePatchApply(meta({ version: 4 }), batch({
    from: 4,
    version: 6,
    entries: [
      { version: 5, changes: [], entities: [{ entity: "message", op: "upsert", message: first }] },
      { version: 6, changes: [], entities: [
        { entity: "message", op: "upsert", message: final },
        { entity: "message", op: "remove", workspaceID: "w1", id: "m2" },
      ] },
    ] as any,
  }))
  assert.equal(decision.action, "apply")
  assert.equal(decision.action === "apply" ? decision.version : 0, 6)
  assert.deepEqual(decision.action === "apply" ? decision.changes : [], [
    { entity: "message", op: "upsert", message: first },
    { entity: "message", op: "upsert", message: final },
    { entity: "message", op: "remove", workspaceID: "w1", id: "m2" },
  ])
})

test("duplicate and reordered message patches are harmless", () => {
  const first = {
    id: "m1", workspaceID: "w1", seq: 1, author: "agent" as const, text: "partial", kind: "text" as const, createdAt: 1, streaming: true,
  }
  const applied = meta({ version: 6 })
  assert.deepEqual(decidePatchApply(applied, batch({
    from: 4,
    version: 6,
    entries: [
      { version: 5, changes: [], entities: [{ entity: "message", op: "upsert", message: first }] },
      { version: 6, changes: [], entities: [{ entity: "message", op: "remove", workspaceID: "w1", id: "m2" }] },
    ] as any,
  })), { action: "ignore" })
  const overlapping = decidePatchApply(meta({ version: 5 }), batch({
    from: 4,
    version: 6,
    entries: [
      { version: 5, changes: [], entities: [{ entity: "message", op: "upsert", message: first }] },
      { version: 6, changes: [], entities: [{ entity: "message", op: "remove", workspaceID: "w1", id: "m2" }] },
    ] as any,
  }))
  assert.equal(overlapping.action, "apply")
  assert.deepEqual(overlapping.action === "apply" ? overlapping.changes : [], [
    { entity: "message", op: "remove", workspaceID: "w1", id: "m2" },
  ])
})

test("a malformed message patch asks for a resync", () => {
  const decision = decidePatchApply(meta({ version: 4 }), batch({
    from: 4,
    version: 5,
    entries: [{ version: 5, changes: [], entities: [{ entity: "message", op: "upsert", message: { text: "missing identity" } }] }] as any,
  }))
  assert.deepEqual(decision, { action: "resync", reason: "malformed" })
})

test("a version-neutral metadata batch updates catalog and config revision metadata", () => {
  const decision = decidePatchApply(meta({ version: 4, catalogRevision: 1 }), {
    epoch: 10,
    from: 4,
    version: 4,
    entries: [],
    meta: {
      catalogRevision: 2,
      models: [{ providerID: "p", modelID: "m", name: "Model", variants: [] }],
      skills: [],
      modelsError: "model list failed",
      directory: "/tmp/ensemble",
      configRevision: 7,
      configError: "bad config",
    },
  })
  assert.equal(decision.action, "apply")
  assert.equal(decision.action === "apply" ? decision.version : 0, 4)
  assert.deepEqual(decision.action === "apply" ? decision.changes : [{}], [])
  assert.equal(decision.action === "apply" ? decision.meta?.catalogRevision : 0, 2)
  assert.equal(decision.action === "apply" ? decision.meta?.configError : "", "bad config")

  const unchanged = decidePatchApply(meta({ version: 4 }), {
    epoch: 10,
    from: 4,
    version: 4,
    entries: [],
    meta: { catalogRevision: 1, configRevision: 1 },
  })
  assert.deepEqual(unchanged, { action: "ignore" })
})

test("a version with non-entity changes resyncs the full snapshot path", () => {
  const decision = decidePatchApply(meta({ version: 4 }), batch({
    from: 4,
    version: 6,
    entries: [
      upsert(5, "t1"),
      { version: 6, changes: [], other: true, nonEntity: true },
    ],
  }))
  assert.deepEqual(decision, { action: "resync", reason: "other" })
})

test("protocol-3 reads entities and ignores the protocol-2 other marker", () => {
  const decision = decidePatchApply(meta({ version: 4 }), batch({
    from: 4,
    version: 5,
    entries: [
      {
        version: 5,
        changes: [],
        other: true,
        entities: [{ entity: "agent", op: "upsert", agent: { id: "a1" } }],
      },
    ] as any,
  }))
  assert.equal(decision.action, "apply")
  assert.equal(decision.action === "apply" ? decision.changes[0]?.entity : "", "agent")
})

test("a changes.since response recovers a dropped event as patches or a reset", () => {
  const recovered = decideChangesSince(meta({ version: 4 }), {
    epoch: 10,
    version: 6,
    reset: false,
    entries: [upsert(5, "t1"), upsert(6, "t2")],
  })
  assert.equal(recovered.action, "apply")
  assert.deepEqual(recovered.action === "apply" ? recovered.changes.map((change: any) => change.op === "upsert" ? change.task.id : change.id) : [], ["t1", "t2"])
  assert.equal(recovered.action === "apply" ? recovered.version : 0, 6)

  assert.equal((decideChangesSince(meta({ version: 4 }), {
    epoch: 10,
    version: 6,
    reset: true,
    reason: "ring-gap",
    entries: [],
  }) as any).reason, "reset")
  assert.equal((decideChangesSince(meta({ version: 4 }), {
    epoch: 9,
    version: 6,
    reset: false,
    entries: [upsert(5, "t1")],
  }) as any).reason, "epoch")
})

test("a changes.since metadata response updates the cursor without a version", () => {
  const recovered = decideChangesSince(meta({ version: 4, catalogRevision: 1, configRevision: 3 }), {
    epoch: 10,
    version: 4,
    reset: false,
    entries: [],
    meta: { catalogRevision: 2, models: [], skills: [], directory: "/tmp/ensemble", configRevision: 4 },
  })
  assert.equal(recovered.action, "apply")
  assert.deepEqual(recovered.action === "apply" ? recovered.changes : [{}], [])
  const cursor = mergeFeedMeta(meta({ version: 4 }), recovered.action === "apply" ? recovered.meta : undefined)
  assert.equal(cursor?.version, 4)
  assert.equal(cursor?.catalogRevision, 2)
  assert.equal(cursor?.configRevision, 4)
  assert.equal(mergeFeedMeta(meta({ version: 4, directory: "/tmp/ensemble" }), {
    catalogRevision: 2,
    directory: "/tmp/other",
    configRevision: 99,
    configError: "not mine",
  })?.configRevision, 1, "another directory's config metadata never changes this cursor")
})

test("the client only negotiates the shell feed on protocol 3 or later", () => {
  assert.equal(supportsPatchFeed(meta({ version: 1 })), true)
  assert.equal(supportsPatchFeed({ ...meta({ version: 1 }), protocol: 2 }), false)
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

  store.applyChanges([
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

test("an ephemeral stream event validates without a coordination version", () => {
  const update = { epoch: 10, workspaceID: "w1", id: "m1", text: "live", updatedAt: 12 }
  assert.equal(validMessageStream(update), true)
  assert.equal(validMessageStream({ ...update, epoch: "10" }), false)
  assert.equal(validMessageStream({ ...update, id: "" }), false)
  assert.equal(validMessageStream({ ...update, text: undefined }), false)
  assert.equal(validMessageStream({ ...update, version: 7 }), true, "extra transport fields do not matter")
})

test("SnapshotMeta stays the feed cursor shape", () => {
  const value: SnapshotMeta = meta({ version: 3 })
  assert.equal(value.protocol, 3)
})
