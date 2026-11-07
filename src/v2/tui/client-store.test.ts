import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createInitialState } from "../defaults.ts"
import type { Agent, Message, ModelOption, SkillOption, Snapshot, SnapshotState, Subtask } from "../types.ts"
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

const message = (id: string, text: string): Message => ({
  id,
  workspaceID: "w1",
  seq: 1,
  author: "user",
  text,
  kind: "text",
  createdAt: 1,
})

const models: ModelOption[] = [{ providerID: "p", modelID: "m", name: "Model", variants: [] }]
const skills: SkillOption[] = [{ id: "skill", name: "Skill" }]

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
