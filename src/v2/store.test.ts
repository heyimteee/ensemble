import test from "node:test"
import assert from "node:assert/strict"
import { V2Store } from "./store.ts"
import type { Agent, Approval, Memory, Message, Subtask, Workspace } from "./types.ts"

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
const message = (patch: Partial<Message> = {}): Message => ({
  id: "m", workspaceID: "w", seq: 1, author: "user", text: "hello", kind: "text", createdAt: 1, ...patch,
})
const subtask = (patch: Partial<Subtask> = {}): Subtask => ({
  id: "t", workspaceID: "w", creatorType: "user", title: "Task", instruction: "Do", mode: "research",
  state: "pending", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false, attempts: 0, createdAt: 1, ...patch,
})

test("store reloads settings, UI state, and bindings", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.saveAgent(agent())
  await store.saveWorkspace(workspace())
  await store.updateSettings({ maxActiveRuns: 1, maxDepth: 2 })
  await store.saveUi({ activeWorkspaceID: "w" })
  await store.saveBinding({ workspaceID: "w", agentID: "a", sessionID: "s", agentVersion: 1, updatedAt: 1 })
  const loaded = new V2Store(ctx)
  await loaded.load()
  assert.equal(loaded.settings().maxActiveRuns, 1)
  assert.equal(loaded.settings().maxDepth, 2)
  assert.equal(loaded.snapshot().ui.activeWorkspaceID, "w")
  assert.equal(loaded.binding("w", "a")?.sessionID, "s")
})

test("store removes entities and prefixes", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.saveAgent(agent())
  await store.saveWorkspace(workspace())
  await store.saveSubtask(subtask())
  await store.saveAgent(agent({ id: "b", name: "Sage" }))
  await store.removeAgent("b")
  assert.equal(store.snapshot().agents.b, undefined)
  await store.removeSubtask("t")
  assert.equal(store.snapshot().subtasks.t, undefined)
  await store.removeWorkspace("w")
  assert.equal(store.snapshot().workspaces.w, undefined)
  await store.saveBinding({ workspaceID: "w", agentID: "a", sessionID: "s", agentVersion: 1, updatedAt: 1 })
  await store.removeBinding("w", "a")
  assert.equal(store.binding("w", "a"), undefined)
  await store.saveAgent(agent({ id: "c", name: "Echo" }))
  await store.removePrefix("v2/agent/")
  assert.deepEqual(Object.keys(store.snapshot().agents), [])
})

test("pruning a workspace removes its messages, tasks, approvals, memories, and binding", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.saveWorkspace(workspace())
  await store.appendMessage("w", { id: "m", author: "user", text: "hello", kind: "text", createdAt: 1 })
  await store.saveSubtask(subtask())
  await store.saveBinding({ workspaceID: "w", agentID: "a", sessionID: "s", agentVersion: 1, updatedAt: 1 })
  await store.saveApproval({ id: "ap", workspaceID: "w", kind: "ask_person", title: "Ask", detail: "?", status: "pending", createdAt: 1 })
  await store.saveMemory({ id: "mem", workspaceID: "w", scope: "workspace", text: "note", origin: "manual", source: "user", createdAt: 1, updatedAt: 1, history: [] })
  await store.pruneWorkspace("w")
  const snapshot = store.snapshot()
  assert.equal(snapshot.workspaces.w, undefined)
  assert.equal(snapshot.messages.w, undefined)
  assert.equal(snapshot.subtasks.t, undefined)
  assert.equal(snapshot.bindings["w:a"], undefined)
  assert.equal(snapshot.approvals.ap, undefined)
  assert.equal(snapshot.memories.mem, undefined)
})

test("load drops a UI workspace id that no longer exists", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.saveUi({ activeWorkspaceID: "missing" })
  const loaded = new V2Store(ctx)
  await loaded.load()
  assert.equal(loaded.snapshot().ui.activeWorkspaceID, undefined)
})

test("messages are ordered by sequence after reload", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.saveWorkspace(workspace())
  await store.appendMessage("w", { id: "m2", author: "user", text: "two", kind: "text", createdAt: 2 })
  await store.appendMessage("w", { id: "m1", author: "user", text: "one", kind: "text", createdAt: 1 })
  const loaded = new V2Store(ctx)
  await loaded.load()
  assert.deepEqual(loaded.snapshot().messages.w.map((item) => item.seq), [1, 2])
  assert.deepEqual(loaded.snapshot().messages.w.map((item) => item.text), ["two", "one"])
})

test("dm transcripts persist per binding and reload in order", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.saveDmMessage("home", "a", { id: "dm_2", role: "user", author: "You", text: "two", createdAt: 2 })
  await store.saveDmMessage("home", "a", { id: "dm_1", role: "user", author: "You", text: "one", createdAt: 1 })
  await store.saveDmMessage("w", "a", { id: "dm_3", role: "user", author: "You", text: "work", createdAt: 3 })
  const loaded = new V2Store(ctx)
  await loaded.load()
  assert.deepEqual(loaded.snapshot().dmTranscripts["home:a"].map((item) => item.text), ["one", "two"])
  assert.deepEqual(loaded.snapshot().dmTranscripts["w:a"].map((item) => item.text), ["work"])
})

test("pruning a workspace removes its dm transcripts", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.saveWorkspace(workspace())
  await store.saveDmMessage("w", "a", { id: "dm_1", role: "user", author: "You", text: "hi", createdAt: 1 })
  await store.pruneWorkspace("w")
  assert.equal(store.snapshot().dmTranscripts["w:a"], undefined)
})

test("sync picks up dm lines written by another store through the shared ingest", async () => {
  const ctx = fakeContext()
  const writer = new V2Store(ctx)
  await writer.load()
  await writer.saveDmMessage("home", "a", { id: "dm_1", role: "user", author: "You", text: "one", createdAt: 1 })
  const reader = new V2Store(ctx)
  await reader.load()
  assert.deepEqual(reader.snapshot().dmTranscripts["home:a"].map((item) => item.text), ["one"])
  await writer.saveDmMessage("home", "a", { id: "dm_2", role: "user", author: "You", text: "two", createdAt: 2 })
  const changed = await reader.sync()
  assert.equal(changed, true)
  assert.deepEqual(reader.snapshot().dmTranscripts["home:a"].map((item) => item.text), ["one", "two"])
})

test("moving a dm transcript copies before deleting and is idempotent", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.load()
  await store.saveDmMessage("home", "a", { id: "dm_1", role: "user", author: "You", text: "one", createdAt: 1 })
  await store.saveDmMessage("home", "a", { id: "dm_2", role: "user", author: "You", text: "two", createdAt: 2 })
  await store.moveDmTranscript("home", "a", "w")
  assert.deepEqual(store.snapshot().dmTranscripts["w:a"].map((item) => item.text), ["one", "two"])
  assert.equal(store.snapshot().dmTranscripts["home:a"], undefined)
  // Retry after completion is a no-op and keeps the transcript intact.
  await store.moveDmTranscript("home", "a", "w")
  assert.deepEqual(store.snapshot().dmTranscripts["w:a"].map((item) => item.text), ["one", "two"])
})

test("moving an empty dm transcript is a no-op", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.load()
  await store.moveDmTranscript("home", "a", "w")
  assert.equal(store.snapshot().dmTranscripts["home:a"], undefined)
  assert.equal(store.snapshot().dmTranscripts["w:a"], undefined)
  await store.moveDmTranscript("home", "a", "w")
  assert.equal(store.snapshot().dmTranscripts["w:a"], undefined)
})

test("retrying a move after an interruption between phases loses nothing", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.load()
  await store.saveDmMessage("home", "a", { id: "dm_1", role: "user", author: "You", text: "one", createdAt: 1 })
  await store.saveDmMessage("home", "a", { id: "dm_2", role: "user", author: "You", text: "two", createdAt: 2 })
  // Simulate a crash after phase 1 (new keys written) before phase 2
  // (old keys deleted): both copies exist in storage.
  for (const { key, value } of await (store as any).scanAll("v2/dm/home/a/")) {
    const id = key.split("/").at(-1)
    await ctx.storage.set(`v2/dm/w/a/${id}`, { ...(value as object), bindingKey: "w:a" })
  }
  await store.moveDmTranscript("home", "a", "w")
  const snapshot = store.snapshot()
  assert.deepEqual(snapshot.dmTranscripts["w:a"].map((item) => item.text), ["one", "two"])
  assert.equal(snapshot.dmTranscripts["home:a"], undefined)
  const remaining = await (store as any).scanAll("v2/dm/home/a/")
  assert.equal(remaining.length, 0)
})
