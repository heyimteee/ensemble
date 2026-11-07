import test from "node:test"
import assert from "node:assert/strict"
import { V2Store, cloneDebugEnabled, cloneStats, resetCloneStats } from "./store.ts"
import type { Agent, Approval, InitJob, Subtask, Workspace } from "./types.ts"

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

const agent = (patch: Partial<Agent> = {}): Agent => ({
  id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "p", modelID: "m" },
  backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1, ...patch,
})
const workspace = (patch: Partial<Workspace> = {}): Workspace => ({
  id: "w", name: "site", directory: "/repo", leaderID: "a", memberIDs: ["a"], synthesis: true,
  archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1, ...patch,
})
const subtask = (patch: Partial<Subtask> = {}): Subtask => ({
  id: "t", workspaceID: "w", creatorType: "user", title: "Task", instruction: "Do", mode: "research",
  state: "pending", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false, attempts: 0, createdAt: 1, ...patch,
})
const approval = (patch: Partial<Approval> = {}): Approval => ({
  id: "ap", workspaceID: "w", kind: "ask_person", title: "Ask", detail: "?", status: "pending", createdAt: 1, ...patch,
})
const initJob = (patch: Partial<InitJob> = {}): InitJob => ({
  id: "init", workspaceID: "w", messageID: "m", state: "running", phases: ["starting"], previousAgentsMD: null, startedAt: 1, ...patch,
})

function withCloneDebug(t: { after: (fn: () => void) => void }): void {
  const previous = process.env.ENSEMBLE_DEBUG_CLONES
  process.env.ENSEMBLE_DEBUG_CLONES = "1"
  resetCloneStats()
  t.after(() => {
    if (previous === undefined) delete process.env.ENSEMBLE_DEBUG_CLONES
    else process.env.ENSEMBLE_DEBUG_CLONES = previous
    resetCloneStats()
  })
}

async function seededStore(): Promise<V2Store> {
  const store = new V2Store(fakeContext())
  await store.saveAgent(agent())
  await store.saveWorkspace(workspace())
  await store.appendMessage("w", { id: "m1", author: "user", text: "hello", kind: "text", createdAt: 1 })
  await store.saveSubtask(subtask())
  await store.saveApproval(approval())
  await store.saveInitJob(initJob())
  await store.saveBinding({ workspaceID: "w", agentID: "a", sessionID: "s1", agentVersion: 1, updatedAt: 1 })
  await store.saveDmQueueEntry({ id: "q1", agentID: "a", directory: "/repo", text: "queued", status: "queued", createdAt: 1 })
  return store
}

test("read accessors expose one or all entities without cloning the full state", async (t) => {
  const store = await seededStore()
  withCloneDebug(t)
  assert.equal(store.agent("a")?.name, "Nova")
  assert.deepEqual(store.agents().map((item) => item.id), ["a"])
  assert.equal(store.workspace("w")?.directory, "/repo")
  assert.deepEqual(store.workspaces().map((item) => item.id), ["w"])
  assert.equal(store.subtask("t")?.title, "Task")
  assert.deepEqual(store.subtasks().map((item) => item.id), ["t"])
  assert.deepEqual(store.messages("w").map((item) => item.text), ["hello"])
  assert.equal(store.message("w", "m1")?.text, "hello")
  assert.deepEqual(store.allMessages().map((list) => list.length), [1])
  assert.equal(store.approval("ap")?.kind, "ask_person")
  assert.deepEqual(store.approvals().map((item) => item.id), ["ap"])
  assert.equal(store.initJob("init")?.state, "running")
  assert.deepEqual(store.initJobs().map((item) => item.id), ["init"])
  assert.equal(store.binding("w", "a")?.sessionID, "s1")
  assert.equal(store.bindingForSession("s1")?.agentID, "a")
  assert.deepEqual(store.bindings().map((item) => item.sessionID), ["s1"])
  assert.equal(store.dmQueueEntry("q1")?.status, "queued")
  assert.deepEqual(store.dmQueue().map((item) => item.id), ["q1"])
  assert.equal(store.version(), 8)
  assert.deepEqual(cloneStats(), {
    enabled: true,
    count: 0,
    totalMs: 0,
    maxMs: 0,
    lastMs: 0,
  })
})

test("one explicit snapshot is the only counted full clone", async (t) => {
  const store = await seededStore()
  withCloneDebug(t)
  const snapshot = store.snapshot()
  const stats = cloneStats()
  assert.equal(stats.enabled, true)
  assert.equal(stats.count, 1)
  assert.ok(stats.lastMs > 0, "the clone duration is recorded")
  assert.equal(stats.maxMs, stats.lastMs)
  assert.equal(snapshot.agents.a.name, "Nova")
  snapshot.agents.a.name = "Changed"
  assert.equal(store.agent("a")?.name, "Nova", "the snapshot is detached")
})

test("writes publish a version without cloning the full state", async (t) => {
  const versions: number[] = []
  const store = new V2Store(fakeContext(), (version) => versions.push(version))
  await store.saveAgent(agent())
  withCloneDebug(t)
  await store.saveAgent(agent({ name: "Sage" }))
  assert.deepEqual(versions, [1, 2])
  assert.equal(store.agent("a")?.name, "Sage")
  assert.equal(cloneStats().count, 0)
})

test("clone counters stay off until the debug flag opts in", async () => {
  const previous = process.env.ENSEMBLE_DEBUG_CLONES
  delete process.env.ENSEMBLE_DEBUG_CLONES
  try {
    resetCloneStats()
    const store = await seededStore()
    store.snapshot()
    assert.equal(cloneDebugEnabled(), false)
    assert.deepEqual(cloneStats(), { enabled: false, count: 0, totalMs: 0, maxMs: 0, lastMs: 0 })
  } finally {
    if (previous === undefined) delete process.env.ENSEMBLE_DEBUG_CLONES
    else process.env.ENSEMBLE_DEBUG_CLONES = previous
    resetCloneStats()
  }
})
