import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createInitialState } from "../defaults.ts"
import { CLIENT_MESSAGE_LIMIT } from "../scoped-read.ts"
import type { Agent, Approval, InitJob, Memory, Message, ModelOption, SessionBinding, SkillOption, Snapshot, SnapshotState, Subtask } from "../types.ts"
import { createClientStore, reduceClientState } from "./client-store.ts"

const agent = (id: string, name: string): Agent => ({
  id,
  name,
  title: "",
  role: "",
  mainModel: { providerID: "p", modelID: "m" },
  backupModels: [],
  skillbox: [],
  color: "blue",
  archived: false,
  pendingSettings: false,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
})

const task = (id: string, patch: Partial<Subtask> = {}): Subtask => ({
  id,
  workspaceID: "w1",
  creatorType: "user",
  assigneeID: "a1",
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

const message = (id: string, text: string, patch: Partial<Message> = {}): Message => ({
  id,
  workspaceID: "w1",
  seq: 1,
  author: "user",
  text,
  kind: "text",
  createdAt: 1,
  ...patch,
})

const models: ModelOption[] = [{ providerID: "p", modelID: "m", name: "Model", variants: [] }]
const skills: SkillOption[] = [{ id: "skill", name: "Skill" }]

const workspace = (id: string, name: string) => ({
  id,
  name,
  directory: `/tmp/${id}`,
  leaderID: "a1",
  memberIDs: ["a1"],
  synthesis: true,
  archived: false,
  paused: false,
  nextSeq: 1,
  createdAt: 1,
  lastActiveAt: 1,
})

const approval = (id: string): Approval => ({
  id,
  workspaceID: "w1",
  kind: "ask_person",
  title: "Ask",
  detail: "?",
  status: "pending",
  createdAt: 1,
})

const binding = (agentID: string, sessionID: string): SessionBinding => ({
  workspaceID: "w1",
  agentID,
  sessionID,
  agentVersion: 1,
  updatedAt: 1,
})

const memory = (id: string): Memory => ({
  id,
  workspaceID: "w1",
  scope: "workspace",
  text: "note",
  origin: "manual",
  source: "user",
  createdAt: 1,
  updatedAt: 1,
  history: [],
})

const initJob = (id: string): InitJob => ({
  id,
  workspaceID: "w1",
  messageID: "m1",
  state: "running",
  previousAgentsMD: null,
  startedAt: 1,
})

function stateWith(entities: (state: SnapshotState) => void): SnapshotState {
  const state = createInitialState()
  state.version = 4
  state.updatedAt = 10
  entities(state)
  return state
}

function snapshot(state: SnapshotState, metadata: Partial<Snapshot> = {}): Snapshot {
  return { state, models, skills, directory: "/tmp/ensemble", ...metadata }
}

test("the client store starts empty and loads the initial snapshot once", () => {
  const store = createClientStore()
  assert.equal(store.state(), null)

  store.applySnapshot(snapshot(
    stateWith((state) => {
      state.agents.a1 = agent("a1", "Ada")
      state.messages.w1 = [message("m1", "hello")]
      state.subtasks.t1 = task("t1")
    }),
    { configError: "bad config", modelsError: "no models", catalogRevision: 7, protocol: 2, epoch: 3 },
  ))

  assert.equal(store.state()?.version, 4)
  assert.equal(store.state()?.agents.a1?.name, "Ada")
  assert.equal(store.state()?.messages.w1?.[0]?.text, "hello")
  assert.equal(store.models(), models)
  assert.equal(store.skills(), skills)
  assert.equal(store.directory(), "/tmp/ensemble")
  assert.equal(store.configError(), "bad config")
  assert.equal(store.modelsError(), "no models")
  assert.equal(store.catalogRevision(), 7)
  assert.equal(store.protocol(), 2)
  assert.equal(store.epoch(), 3)
})

test("a full snapshot replaces prior state, including removals", () => {
  const store = createClientStore()
  store.applySnapshot(snapshot(stateWith((state) => {
    state.agents.a1 = agent("a1", "Ada")
    state.agents.a2 = agent("a2", "Grace")
    state.subtasks.t1 = task("t1")
  })))

  const replacement = snapshot(stateWith((state) => {
    state.agents.a1 = agent("a1", "Ada")
  }))
  store.applySnapshot(replacement)

  assert.equal(store.state()?.agents.a2, undefined)
  assert.equal(store.state()?.subtasks.t1, undefined)
  assert.equal(store.state()?.agents.a1?.name, "Ada")
})

test("a subtask update keeps unrelated entity and metadata references", () => {
  const store = createClientStore()
  store.applySnapshot(snapshot(stateWith((state) => {
    state.agents.a1 = agent("a1", "Ada")
    state.messages.w1 = [message("m1", "hello")]
    state.subtasks.t1 = task("t1")
    state.subtasks.t2 = task("t2")
  })))
  const before = store.state()!
  const modelsBefore = store.models()

  store.applySubtask({ ...before.subtasks.t1!, state: "working" })

  const after = store.state()!
  assert.equal(after.agents, before.agents)
  assert.equal(after.messages, before.messages)
  assert.equal(after.subtasks.t1?.state, "working")
  assert.equal(after.subtasks.t2, before.subtasks.t2)
  assert.equal(store.models(), modelsBefore)
})

test("a subtask removal leaves other entity branches untouched", () => {
  const store = createClientStore()
  store.applySnapshot(snapshot(stateWith((state) => {
    state.agents.a1 = agent("a1", "Ada")
    state.subtasks.t1 = task("t1")
    state.subtasks.t2 = task("t2")
  })))
  const before = store.state()!

  store.removeSubtask("t2")

  const after = store.state()!
  assert.equal(after.agents, before.agents)
  assert.equal(after.subtasks.t1, before.subtasks.t1)
  assert.equal(after.subtasks.t2, undefined)
})

test("a metadata update leaves entity state untouched", () => {
  const store = createClientStore()
  const initial = stateWith((state) => {
    state.agents.a1 = agent("a1", "Ada")
    state.subtasks.t1 = task("t1")
  })
  store.applySnapshot(snapshot(initial))
  const before = store.state()
  const nextModels = [...models, { providerID: "p", modelID: "m2", name: "Second", variants: [] }]

  store.applyMetadata(snapshot(initial, { models: nextModels, configError: "changed", catalogRevision: 8 }))

  assert.equal(store.state(), before)
  assert.equal(store.state()?.agents.a1, before?.agents.a1)
  assert.equal(store.models(), nextModels)
  assert.equal(store.configError(), "changed")
  assert.equal(store.catalogRevision(), 8)
})

test("shell entity changes apply incrementally without replacing unrelated state", () => {
  const store = createClientStore()
  store.applySnapshot(snapshot(stateWith((state) => {
    state.agents.a1 = agent("a1", "Ada")
    state.subtasks.t1 = task("t1")
    state.messages.w1 = [message("m1", "hello")]
  })))
  const before = store.state()!

  store.applyChanges([
    { entity: "agent", op: "upsert", agent: agent("a1", "Ada Lovelace") },
    { entity: "workspace", op: "upsert", workspace: workspace("w1", "site") },
    { entity: "approval", op: "upsert", approval: approval("ap1") },
    { entity: "binding", op: "upsert", binding: binding("a1", "s1") },
    { entity: "memory", op: "upsert", memory: memory("mem1") },
    { entity: "initJob", op: "upsert", job: initJob("init1") },
    { entity: "settings", op: "upsert", settings: { maxActiveRuns: 1, maxDelegations: 2, maxDepth: 3, synthesis: false } },
    { entity: "ui", op: "upsert", ui: { activeWorkspaceID: "w1" } },
  ], 6)

  const after = store.state()!
  assert.equal(after.version, 6)
  assert.equal(after.agents.a1?.name, "Ada Lovelace")
  assert.equal(after.workspaces.w1?.name, "site")
  assert.equal(after.approvals.ap1?.status, "pending")
  assert.equal(after.bindings["w1:a1"]?.sessionID, "s1")
  assert.equal(after.memories.mem1?.text, "note")
  assert.equal(after.initJobs.init1?.state, "running")
  assert.equal(after.settings.maxActiveRuns, 1)
  assert.equal(after.ui.activeWorkspaceID, "w1")
  assert.equal(after.subtasks, before.subtasks, "unrelated Work state keeps its identity")
  assert.equal(after.messages, before.messages, "unrelated transcript state keeps its identity")
})

test("shell removals and a full snapshot reconstruct every shell entity", () => {
  const store = createClientStore()
  store.applySnapshot(snapshot(stateWith((state) => {
    state.agents.a1 = agent("a1", "Ada")
    state.workspaces.w1 = workspace("w1", "site")
    state.approvals.ap1 = approval("ap1")
    state.bindings["w1:a1"] = binding("a1", "s1")
    state.memories.mem1 = memory("mem1")
    state.initJobs.init1 = initJob("init1")
    state.settings.maxActiveRuns = 3
    state.ui.activeWorkspaceID = "w1"
  })))

  store.applyChanges([
    { entity: "agent", op: "remove", id: "a1" },
    { entity: "workspace", op: "remove", id: "w1" },
    { entity: "approval", op: "remove", id: "ap1" },
    { entity: "binding", op: "remove", workspaceID: "w1", agentID: "a1" },
    { entity: "memory", op: "remove", id: "mem1" },
    { entity: "initJob", op: "remove", id: "init1" },
  ], 5)

  assert.deepEqual(Object.keys(store.state()!.agents), [])
  assert.deepEqual(Object.keys(store.state()!.workspaces), [])
  assert.deepEqual(Object.keys(store.state()!.approvals), [])
  assert.deepEqual(Object.keys(store.state()!.bindings), [])
  assert.deepEqual(Object.keys(store.state()!.memories), [])
  assert.deepEqual(Object.keys(store.state()!.initJobs), [])

  const reset = stateWith((state) => {
    state.agents.a2 = agent("a2", "Grace")
    state.workspaces.w2 = workspace("w2", "other")
    state.approvals.ap2 = approval("ap2")
    state.bindings["w2:a2"] = binding("a2", "s2")
    state.memories.mem2 = memory("mem2")
    state.initJobs.init2 = initJob("init2")
  })
  store.applySnapshot(snapshot(reset))

  assert.equal(store.state()?.agents.a2?.name, "Grace")
  assert.equal(store.state()?.workspaces.w2?.directory, "/tmp/w2")
  assert.equal(store.state()?.approvals.ap2?.id, "ap2")
  assert.equal(store.state()?.bindings["w2:a2"]?.sessionID, "s2")
  assert.equal(store.state()?.memories.mem2?.id, "mem2")
  assert.equal(store.state()?.initJobs.init2?.id, "init2")
})

test("message patches upsert by id, preserve order, and remove without duplicating rows", () => {
  const store = createClientStore()
  store.applySnapshot(snapshot(stateWith((state) => {
    state.messages.w1 = [message("m1", "first", { seq: 1 }), message("m3", "third", { seq: 3 })]
  })))
  const before = store.state()!

  store.applyChanges([
    { entity: "message", op: "upsert", message: message("m2", "second", { seq: 2, author: "system", kind: "system" }) },
    { entity: "message", op: "upsert", message: message("m2", "second", { seq: 2, author: "system", kind: "system" }) },
  ], 6)

  assert.deepEqual(store.state()!.messages.w1?.map((row) => row.id), ["m1", "m2", "m3"])
  assert.equal(store.state()!.messages.w1?.filter((row) => row.id === "m2").length, 1, "a duplicate upsert never duplicates a transcript row")
  assert.deepEqual(store.state()!.messages.w1?.[1], message("m2", "second", { seq: 2, author: "system", kind: "system" }))
  assert.equal(store.state()!.agents, before.agents, "unrelated entity branches keep their identity")

  store.applyChanges([{ entity: "message", op: "remove", workspaceID: "w1", id: "m2" }], 7)
  assert.deepEqual(store.state()!.messages.w1?.map((row) => row.id), ["m1", "m3"])
})

test("an ephemeral stream updates only the visible live row and never bumps the version", () => {
  const store = createClientStore()
  store.applySnapshot(snapshot(stateWith((state) => {
    state.messages.w1 = [
      message("m1", "partial", { seq: 1, author: "agent", streaming: true, updatedAt: 10 }),
      message("m2", "final", { seq: 2, author: "agent", updatedAt: 10 }),
    ]
  })))
  const version = store.state()!.version

  store.applyStream({ epoch: 10, workspaceID: "w1", id: "m1", text: "partial reply", updatedAt: 11 })

  assert.equal(store.state()!.version, version, "ephemeral text does not move the coordination cursor")
  assert.equal(store.state()!.messages.w1?.[0]?.text, "partial reply")
  assert.equal(store.state()!.messages.w1?.[0]?.streaming, true)
  assert.equal(store.state()!.messages.w1?.[1]?.text, "final", "a finalized row ignores live overlays")

  store.applyStream({ epoch: 10, workspaceID: "w1", id: "m1", text: "partial", updatedAt: 9 })
  assert.equal(store.state()!.messages.w1?.[0]?.text, "partial reply", "an older reordered stream never rewinds the row")
})

test("the final durable message replaces the live overlay exactly once", () => {
  const store = createClientStore()
  store.applySnapshot(snapshot(stateWith((state) => {
    state.messages.w1 = [message("m1", "", { seq: 1, author: "agent", streaming: true, updatedAt: 10 })]
  })))
  store.applyStream({ epoch: 10, workspaceID: "w1", id: "m1", text: "live partial", updatedAt: 11 })

  const final = message("m1", "Exact final answer.", { seq: 1, author: "agent", streaming: false, updatedAt: 12 })
  store.applyChanges([{ entity: "message", op: "upsert", message: final }], 8)

  assert.equal(store.state()!.messages.w1?.length, 1)
  assert.equal(store.state()!.messages.w1?.[0]?.text, "Exact final answer.")
  assert.equal(store.state()!.messages.w1?.[0]?.streaming, false)

  store.applyStream({ epoch: 10, workspaceID: "w1", id: "m1", text: "stale overlay", updatedAt: 13 })
  assert.equal(store.state()!.messages.w1?.[0]?.text, "Exact final answer.", "a late overlay cannot replace the durable final text")
  store.applyChanges([{ entity: "message", op: "upsert", message: final }], 8)
  assert.equal(store.state()!.messages.w1?.length, 1, "a duplicate final patch is harmless")
})

test("a missed stream event is recovered by the final message patch", () => {
  const store = createClientStore()
  store.applySnapshot(snapshot(stateWith((state) => {
    state.messages.w1 = [message("m1", "", { seq: 1, author: "agent", streaming: true, updatedAt: 10 })]
  })))
  // No ephemeral stream arrives; only the durable final upsert.
  store.applyChanges([{
    entity: "message",
    op: "upsert",
    message: message("m1", "Recovered exact final.", { seq: 1, author: "agent", streaming: false, updatedAt: 12 }),
  }], 9)

  assert.equal(store.state()!.messages.w1?.[0]?.text, "Recovered exact final.")
  assert.equal(store.state()!.messages.w1?.[0]?.streaming, false)
  assert.equal(store.state()!.version, 9)
})

test("catalog and config metadata apply from the feed without replacing entity state", () => {
  const store = createClientStore()
  store.applySnapshot(snapshot(stateWith((state) => {
    state.agents.a1 = agent("a1", "Ada")
    state.subtasks.t1 = task("t1")
  }), { catalogRevision: 3, configRevision: 4 }))
  const before = store.state()!
  const nextModels = [...models, { providerID: "p", modelID: "m2", name: "Second", variants: [] }]
  const nextSkills = [...skills, { id: "review", name: "Review" }]

  store.applyChanges([], before.version, {
    catalogRevision: 8,
    models: nextModels,
    skills: nextSkills,
    modelsError: "model list failed",
    directory: "/tmp/ensemble",
    configRevision: 9,
    configError: "bad config",
  })

  assert.equal(store.state()?.agents, before.agents)
  assert.equal(store.state()?.subtasks, before.subtasks)
  assert.equal(store.state()?.version, before.version, "metadata does not bump the coordination version")
  assert.equal(store.models(), nextModels)
  assert.equal(store.skills(), nextSkills)
  assert.equal(store.modelsError(), "model list failed")
  assert.equal(store.catalogRevision(), 8)
  assert.equal(store.configRevision(), 9)
  assert.equal(store.configError(), "bad config")
})

test("a subtask update invalidates only the updated entity path", () => {
  // Solid's Node condition resolves the non-reactive server build, so observe
  // the store under the browser condition the TUI bundle uses. This runs the
  // store directly; no TUI renderer is mounted.
  const clientStore = new URL("./client-store.ts", import.meta.url).href
  const defaults = new URL("../defaults.ts", import.meta.url).href
  const probe = `
    import { createRoot, createMemo } from "solid-js"
    import { createClientStore } from ${JSON.stringify(clientStore)}
    import { createInitialState } from ${JSON.stringify(defaults)}
    const state = createInitialState()
    state.agents.a1 = { id: "a1", name: "Ada", title: "", role: "", mainModel: { providerID: "p", modelID: "m" }, backupModels: [], skillbox: [], color: "blue", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 }
    state.messages.w1 = [{ id: "m1", workspaceID: "w1", seq: 1, author: "user", text: "hello", kind: "text", createdAt: 1 }]
    state.subtasks.t1 = { id: "t1", workspaceID: "w1", creatorType: "user", assigneeID: "a1", title: "x", instruction: "x", mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false, attempts: 0, createdAt: 1 }
    createRoot(() => {
      const store = createClientStore()
      store.applySnapshot({ state, models: [], skills: [], directory: "/tmp" })
      let agents = 0, messages = 0, status = 0
      createMemo(() => { agents++; return store.state()?.agents.a1?.name })
      createMemo(() => { messages++; return store.state()?.messages.w1?.[0]?.text })
      createMemo(() => { status++; return store.state()?.subtasks.t1?.state })
      store.applySubtask({ ...state.subtasks.t1, state: "working" })
      console.log(JSON.stringify({ agents, messages, status }))
    })
  `
  const result = spawnSync(
    process.execPath,
    ["--conditions=browser", "--experimental-strip-types", "--input-type=module", "-e", probe],
    { encoding: "utf8" },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { agents: 1, messages: 1, status: 2 })
})

test("the pure reducer shares unchanged branches", () => {
  const state = stateWith((state) => {
    state.agents.a1 = agent("a1", "Ada")
    state.messages.w1 = [message("m1", "hello")]
    state.subtasks.t1 = task("t1")
  })

  const next = reduceClientState(state, { type: "subtask.upsert", task: task("t1", { state: "working" }) })
  assert.equal(next.agents, state.agents)
  assert.equal(next.messages, state.messages)
  assert.notEqual(next.subtasks, state.subtasks)
  assert.equal(next.subtasks.t1?.state, "working")

  const unchanged = reduceClientState(next, { type: "subtask.upsert", task: next.subtasks.t1! })
  assert.equal(unchanged, next)
})

test("the pure reducer treats a snapshot as a full replacement", () => {
  const state = stateWith((state) => {
    state.agents.a1 = agent("a1", "Ada")
    state.agents.a2 = agent("a2", "Grace")
  })
  const replacement = stateWith((state) => {
    state.agents.a1 = agent("a1", "Ada")
  })

  const next = reduceClientState(state, { type: "snapshot", snapshot: snapshot(replacement) })
  assert.equal(next, replacement)
  assert.equal(next.agents.a2, undefined)
})

test("a long client session keeps patched transcript and Work memory bounded", (t) => {
  const store = createClientStore()
  store.applySnapshot(snapshot(stateWith((state) => {
    state.workspaces.w1 = workspace("w1", "site")
    state.agents.a1 = agent("a1", "Ada")
    state.subtasks.live = task("live", {
      dispatchGroupID: "dispatch_live",
      state: "working",
      claimedBy: "run",
      leaseUntil: Date.now() + 60_000,
      attempts: 1,
    })
    state.messages.w1 = Array.from({ length: 500 }, (_, index) => message(`m${index + 1}`, `row ${index + 1}`, { seq: index + 1 }))
    state.dmTranscripts["w:a1"] = Array.from({ length: 500 }, (_, index) => ({
      id: `dm${index + 1}`,
      role: "user" as const,
      author: "You",
      text: `dm ${index + 1}`,
      createdAt: index + 1,
    }))
  })))

  // Review fix: a full snapshot is the legacy recovery path, so it arrives
  // whole; only the scoped patch/window path applies the client bound.
  assert.equal(store.state()!.messages.w1!.length, 500, "a full snapshot keeps the legacy transcript")
  assert.equal(store.state()!.dmTranscripts["w:a1"]!.length, 500, "direct transcript caches keep the legacy full snapshot")
  assert.equal(store.state()!.messages.w1!.at(-1)?.seq, 500)
  assert.equal(store.windowFor("w1")?.hasMoreOlder, false)

  const started = performance.now()
  for (let seq = 501; seq <= 5_000; seq++) {
    store.applyChanges([{ entity: "message", op: "upsert", message: message(`m${seq}`, `row ${seq}`, { seq }) }], seq)
  }
  const elapsed = performance.now() - started

  assert.equal(store.state()!.messages.w1!.length, CLIENT_MESSAGE_LIMIT, "streaming patches never grow the transcript without bound")
  assert.equal(store.state()!.messages.w1!.at(-1)?.seq, 5_000)
  t.diagnostic(`client-bounded messages=${store.state()!.messages.w1!.length} patches=5000 elapsed=${elapsed.toFixed(1)}ms`)
  assert.ok(elapsed < 5_000, `5k bounded message patches stayed responsive (${elapsed.toFixed(1)} ms)`)

  for (let index = 0; index < 1_000; index++) {
    store.applyChanges([{
      entity: "subtask",
      op: "upsert",
      task: task(`old${index}`, {
        dispatchGroupID: `dispatch_old_${index}`,
        state: "replied",
        outcome: "succeeded",
        finishedAt: 1,
        repliedAt: 1,
      }),
    }], 6_000 + index)
  }
  assert.deepEqual(Object.keys(store.state()!.subtasks), ["live"], "invisible terminal rows are pruned from the client cache")
})

test("a short client tombstone rejects a delayed upsert after a remove", () => {
  const store = createClientStore()
  store.applySnapshot(snapshot(stateWith((state) => {
    state.workspaces.w1 = workspace("w1", "site")
    state.subtasks.t1 = task("t1")
  })))
  store.applyChanges([{ entity: "subtask", op: "remove", id: "t1" }], 10)
  assert.equal(store.state()?.subtasks.t1, undefined)

  // A delayed duplicate of the deleted row at the delete version cannot
  // resurrect it while the short tombstone lives.
  store.applyChanges([{ entity: "subtask", op: "upsert", task: task("t1") }], 10)
  assert.equal(store.state()?.subtasks.t1, undefined, "the tombstone suppresses the stale upsert")

  // A genuinely newer durable upsert wins and clears the tombstone.
  store.applyChanges([{ entity: "subtask", op: "upsert", task: task("t1", { state: "working", claimedBy: "run", leaseUntil: 9_000, attempts: 1 }) }], 11)
  assert.equal(store.state()?.subtasks.t1?.state, "working", "a newer version may recreate the entity")
})

test("an older transcript page merges below the loaded window and stays bounded", () => {
  const store = createClientStore()
  store.applySnapshot(snapshot(stateWith((state) => {
    state.workspaces.w1 = workspace("w1", "site")
    state.agents.a1 = agent("a1", "Ada")
  })))
  const latest = Array.from({ length: 40 }, (_, index) => message(`m${index + 61}`, `row ${index + 61}`, { seq: index + 61 }))
  store.applyTranscriptWindow("w1", {
    workspaceID: "w1",
    messages: latest,
    oldestSeq: 61,
    newestSeq: 100,
    hasMoreOlder: true,
    limit: 40,
  }, "replace")
  const older = Array.from({ length: 40 }, (_, index) => message(`m${index + 21}`, `row ${index + 21}`, { seq: index + 21 }))
  store.applyTranscriptWindow("w1", {
    workspaceID: "w1",
    messages: older,
    oldestSeq: 21,
    newestSeq: 60,
    hasMoreOlder: true,
    limit: 40,
  }, "older")

  assert.deepEqual(store.state()!.messages.w1!.map((row) => row.seq).slice(0, 3), [21, 22, 23])
  assert.deepEqual(store.state()!.messages.w1!.map((row) => row.seq).slice(-2), [99, 100])
  assert.equal(store.state()!.messages.w1!.length, 80)
  assert.equal(store.windowFor("w1")?.oldestSeq, 21)
  assert.equal(store.windowFor("w1")?.newestSeq, 100)
  assert.equal(store.windowFor("w1")?.hasMoreOlder, true)
})

test("a patch after paging away keeps the fetched older page", () => {
  const store = createClientStore()
  store.applySnapshot(snapshot(stateWith((state) => {
    state.workspaces.w1 = workspace("w1", "site")
    state.agents.a1 = agent("a1", "Ada")
  })))
  const newest = Array.from({ length: 240 }, (_, index) => message(`m${index + 161}`, `row ${index + 161}`, { seq: index + 161 }))
  store.applyTranscriptWindow("w1", {
    workspaceID: "w1",
    messages: newest,
    oldestSeq: 161,
    newestSeq: 400,
    hasMoreOlder: true,
    limit: 240,
  }, "replace")
  const older = Array.from({ length: 120 }, (_, index) => message(`m${index + 41}`, `row ${index + 41}`, { seq: index + 41 }))
  store.applyTranscriptWindow("w1", {
    workspaceID: "w1",
    messages: older,
    oldestSeq: 41,
    newestSeq: 160,
    hasMoreOlder: true,
    limit: 240,
  }, "older")
  assert.equal(store.state()!.messages.w1![0]?.seq, 41, "the fetched older page is loaded")

  // Review fix: a durable patch while paged away must not re-trim to the
  // newest rows and discard the page the user just fetched.
  store.applyChanges([{ entity: "message", op: "upsert", message: message("m401", "row 401", { seq: 401 }) }], 20)
  assert.equal(store.state()!.messages.w1![0]?.seq, 41, "the older page survives the next patch")
  assert.equal(store.state()!.messages.w1!.at(-1)?.seq, 280, "the anchored window stays bounded")
  assert.equal(store.state()!.messages.w1!.length, CLIENT_MESSAGE_LIMIT)
  assert.equal(store.transcriptAnchored("w1"), true)

  // The app refreshes the newest window when the user returns to the bottom,
  // which replaces the loaded range and releases the anchor.
  const fresh = Array.from({ length: 240 }, (_, index) => message(`m${index + 162}`, `row ${index + 162}`, { seq: index + 162 }))
  store.applyTranscriptWindow("w1", {
    workspaceID: "w1",
    messages: fresh,
    oldestSeq: 162,
    newestSeq: 401,
    hasMoreOlder: true,
    limit: 240,
  }, "replace")
  assert.equal(store.transcriptAnchored("w1"), false)
  assert.equal(store.state()!.messages.w1!.at(-1)?.seq, 401)
  assert.equal(store.windowFor("w1")?.newestSeq, 401)
})

test("a scoped shell resync replaces shell entities but preserves the loaded transcript and Work", () => {
  const store = createClientStore()
  store.applySnapshot(snapshot(stateWith((state) => {
    state.agents.a1 = agent("a1", "Ada")
    state.workspaces.w1 = workspace("w1", "site")
    state.messages.w1 = [message("m1", "hello")]
    state.subtasks.t1 = task("t1")
  })))

  const shell = stateWith((state) => {
    state.version = 9
    state.agents.a2 = agent("a2", "Grace")
    state.workspaces.w2 = workspace("w2", "other")
    state.messages = {}
    state.subtasks = {}
  })
  store.applyShellSnapshot(shell)

  assert.equal(store.state()?.agents.a1, undefined, "removed shell rows disappear")
  assert.equal(store.state()?.agents.a2?.name, "Grace")
  assert.equal(store.state()?.workspaces.w2?.name, "other")
  assert.equal(store.state()?.messages.w1?.[0]?.text, "hello", "transcript is untouched by shell resync")
  assert.equal(store.state()?.subtasks.t1?.id, "t1", "Work is untouched by shell resync")
  assert.equal(store.state()?.version, 9)
})

test("server-derived counts apply from bootstrap, patches, and revisions without scanning", () => {
  const store = createClientStore()
  store.applySnapshot(snapshot(stateWith((state) => {
    state.workspaces.w1 = workspace("w1", "site")
    state.agents.a1 = agent("a1", "Ada")
  }), { counts: { w1: { unread: 3, busy: 1 } } }))

  assert.deepEqual(store.counts(), { w1: { unread: 3, busy: 1 } })

  store.applyChanges([], 5, undefined, { w1: { unread: 4, busy: 0 } })
  assert.deepEqual(store.counts(), { w1: { unread: 4, busy: 0 } })

  store.applyCounts({ w1: { unread: 0, busy: 2 } })
  assert.deepEqual(store.counts(), { w1: { unread: 0, busy: 2 } })
})
