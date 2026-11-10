import test from "node:test"
import assert from "node:assert/strict"
import { V2Store } from "./store.ts"
import { directMessageChannel } from "./message-channel.ts"
import { CLIENT_MESSAGE_LIMIT, TRANSCRIPT_WINDOW, transcriptWindow, trimMessages } from "./scoped-read.ts"
import type { Agent, Message, NativeSubagentRun, PatchBatch, Subtask, Workspace } from "./types.ts"

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
const message = (patch: Partial<Message> = {}): Message => ({
  id: "m", workspaceID: "w", seq: 1, author: "agent", text: "reply", kind: "text", createdAt: 1, ...patch,
})
const nativeSubagent = (patch: Partial<NativeSubagentRun> = {}): NativeSubagentRun => ({
  childSessionID: "child_1",
  parentSessionID: "parent_1",
  parentTaskID: "t",
  dispatchGroupID: "group_1",
  workspaceID: "w",
  parentAgentID: "a",
  parentAgent: "Nova",
  instruction: "watch the CI",
  state: "working",
  startedAt: 2,
  source: "session-created",
  ...patch,
})

test("store reloads settings, UI state, and bindings", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.saveAgent(agent())
  await store.saveWorkspace(workspace())
  await store.updateSettings({ maxActiveRuns: 1, maxDepth: 2 })
  await store.saveUi({ activeWorkspaceID: "w", collapsedRailGroups: ["w"], dismissedHistoryGroups: ["dispatch_1"] })
  await store.saveBinding({ workspaceID: "w", agentID: "a", sessionID: "s", agentVersion: 1, updatedAt: 1 })
  const loaded = new V2Store(ctx)
  await loaded.load()
  assert.equal(loaded.settings().maxActiveRuns, 1)
  assert.equal(loaded.settings().maxDepth, 2)
  assert.equal(loaded.snapshot().ui.activeWorkspaceID, "w")
  assert.deepEqual(loaded.snapshot().ui.collapsedRailGroups, ["w"], "rail collapse state survives a restart")
  assert.deepEqual(loaded.snapshot().ui.dismissedHistoryGroups, ["dispatch_1"], "history dismissal survives a restart without deleting rows")
  assert.equal(loaded.binding("w", "a")?.sessionID, "s")
})

test("ticket183: pane visibility survives a restart", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.saveUi({ paneVisibility: { left: false, right: true } })
  const loaded = new V2Store(ctx)
  await loaded.load()
  assert.deepEqual(loaded.snapshot().ui.paneVisibility, { left: false, right: true }, "column switches are durable UI state")
})

test("native subagent records are durable by child session and removable", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.saveNativeSubagent(nativeSubagent())
  assert.deepEqual(store.nativeSubagent("child_1"), nativeSubagent())
  const loaded = new V2Store(ctx)
  await loaded.load()
  assert.deepEqual(loaded.nativeSubagents(), [nativeSubagent()], "a child record survives restart")
  await loaded.saveNativeSubagent(nativeSubagent({ state: "replied", finishedAt: 9 }))
  assert.equal(loaded.nativeSubagent("child_1")?.state, "replied")
  await loaded.removeNativeSubagent("child_1")
  assert.equal(loaded.nativeSubagent("child_1"), undefined)
  const reloaded = new V2Store(ctx)
  await reloaded.load()
  assert.deepEqual(reloaded.nativeSubagents(), [])
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
  await store.saveNativeSubagent(nativeSubagent())
  await store.pruneWorkspace("w")
  const snapshot = store.snapshot()
  assert.equal(snapshot.workspaces.w, undefined)
  assert.equal(snapshot.messages.w, undefined)
  assert.equal(snapshot.subtasks.t, undefined)
  assert.equal(snapshot.bindings["w:a"], undefined)
  assert.equal(snapshot.approvals.ap, undefined)
  assert.equal(snapshot.memories.mem, undefined)
  assert.equal(snapshot.nativeSubagents.child_1, undefined, "pruning a workspace drops its native child records")
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

test("ticket212: a direct message writes one durable channel row and the legacy line", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.load()
  await store.saveDmMessage("home", "a", { id: "dm_1", role: "user", author: "You", text: "hello", createdAt: 1 })
  const channel = directMessageChannel("a")
  const rows = store.messages(channel)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.channel, channel)
  assert.equal(rows[0]!.text, "hello")
  assert.equal(rows[0]!.author, "user")
  assert.deepEqual(store.dmTranscript("home", "a").map((line) => line.text), ["hello"], "the legacy transcript is dual-written")
  const loaded = new V2Store(ctx)
  await loaded.load()
  assert.equal(loaded.messages(channel).length, 1, "the durable channel row survives reload")
  assert.equal(loaded.messages(channel)[0]!.text, "hello")
})

test("ticket212: a direct channel row updates in place and removes from both stores", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.load()
  await store.saveDmMessage("home", "a", { id: "dm_1", role: "user", author: "You", text: "hello", createdAt: 1 })
  const channel = directMessageChannel("a")
  const seq = store.messages(channel)[0]!.seq
  await store.saveDmMessage("home", "a", { id: "dm_1", role: "user", author: "You", text: "edited", createdAt: 1 })
  assert.equal(store.messages(channel).length, 1)
  assert.equal(store.messages(channel)[0]!.text, "edited")
  assert.equal(store.messages(channel)[0]!.seq, seq, "an update keeps the durable row sequence")
  await store.removeDmMessage("home", "a", "dm_1")
  assert.equal(store.messages(channel).length, 0)
  assert.deepEqual(store.dmTranscript("home", "a"), [])
})

test("ticket212: direct channel sequence continues after reload", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.load()
  await store.appendChannelMessage(directMessageChannel("a"), { id: "dm_1", workspaceID: "home", author: "user", text: "one", kind: "text", createdAt: 1 })
  await store.appendChannelMessage(directMessageChannel("a"), { id: "dm_2", workspaceID: "home", author: "user", text: "two", kind: "text", createdAt: 2 })
  const loaded = new V2Store(ctx)
  await loaded.load()
  await loaded.appendChannelMessage(directMessageChannel("a"), { id: "dm_3", workspaceID: "home", author: "user", text: "three", kind: "text", createdAt: 3 })
  assert.deepEqual(loaded.messages(directMessageChannel("a")).map((row) => row.seq), [1, 2, 3])
})

test("ticket212: a direct message patch is a message entity and never a snapshot reset", async () => {
  const ctx = fakeContext()
  const batches: PatchBatch[] = []
  const store = new V2Store(ctx, undefined, { epoch: 1, onPatch: (batch) => batches.push(batch) })
  await store.load()
  await store.saveDmMessage("home", "a", { id: "dm_1", role: "user", author: "You", text: "hello", createdAt: 1 })
  await store.settled()
  const batch = batches.at(-1)!
  assert.equal(batch.reset, undefined)
  assert.equal(batch.entries.length, 1)
  const entry = batch.entries[0]!
  assert.equal(entry.nonEntity, undefined, "a direct message is patchable entity state")
  const upsert = entry.entities?.find((change) => change.entity === "message" && change.op === "upsert")
  assert.equal(upsert?.message.channel, directMessageChannel("a"))
  assert.equal(upsert?.message.text, "hello")
  await store.removeDmMessage("home", "a", "dm_1")
  await store.settled()
  const remove = batches.at(-1)!.entries[0]!.entities?.find((change) => change.entity === "message" && change.op === "remove")
  assert.equal(remove?.channel, directMessageChannel("a"), "a direct remove names its channel")
})

test("ticket212: direct channel rows use the same transcript window and client bound", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.load()
  const channel = directMessageChannel("a")
  for (let index = 1; index <= 45; index++) {
    await store.appendChannelMessage(channel, {
      id: `dm_${index}`,
      workspaceID: "home",
      author: "user",
      text: `line ${index}`,
      kind: "text",
      createdAt: index,
    })
  }
  const window = transcriptWindow(store.messages(channel), {})
  assert.equal(window.messages.length, TRANSCRIPT_WINDOW)
  assert.equal(window.messages[0]!.text, "line 6")
  assert.equal(window.hasMoreOlder, true)
  assert.equal(trimMessages(store.messages(channel), CLIENT_MESSAGE_LIMIT).length, 45)
})

test("ticket212: pruning a workspace removes its direct channel but keeps home", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.load()
  await store.saveWorkspace(workspace())
  await store.saveDmMessage("w", "a", { id: "dm_w", role: "user", author: "You", text: "workspace", createdAt: 1 })
  await store.saveDmMessage("home", "a", { id: "dm_h", role: "user", author: "You", text: "home", createdAt: 2 })
  await store.pruneWorkspace("w")
  assert.equal(store.messages(directMessageChannel("a", "w")).length, 0)
  assert.deepEqual(store.messages(directMessageChannel("a")).map((row) => row.text), ["home"])
})

test("ticket212: pruning an agent removes every direct channel for that agent", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.load()
  await store.saveDmMessage("home", "a", { id: "dm_home", role: "user", author: "You", text: "home", createdAt: 1 })
  await store.saveWorkspace(workspace({ memberIDs: ["a", "b"] }))
  await store.saveDmMessage("w", "a", { id: "dm_work", role: "user", author: "You", text: "work", createdAt: 2 })
  await store.pruneDmForAgent("a")
  assert.equal(store.messages(directMessageChannel("a")).length, 0)
  assert.equal(store.messages(directMessageChannel("a", "w")).length, 0)
  assert.deepEqual(store.dmTranscript("home", "a"), [])
})

test("pruning a workspace removes its dm transcripts", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.saveWorkspace(workspace())
  await store.saveDmMessage("w", "a", { id: "dm_1", role: "user", author: "You", text: "hi", createdAt: 1 })
  await store.pruneWorkspace("w")
  assert.equal(store.snapshot().dmTranscripts["w:a"], undefined)
})

test("sync refreshes bindings even when the global version is already current", async () => {
  const ctx = fakeContext()
  const writer = new V2Store(ctx)
  await writer.load()
  await writer.saveWorkspace(workspace())
  const reader = new V2Store(ctx)
  await reader.load()
  await writer.saveBinding({ workspaceID: "w", agentID: "a", sessionID: "s", kind: "workspace", directory: "/repo", agentVersion: 1, updatedAt: 1 })
  // A local write advances the reader to the same version as storage without
  // refreshing the binding map. This is the stale tool-session case.
  await reader.updateSettings({ maxActiveRuns: 2 })
  assert.equal(reader.binding("w", "a"), undefined)
  assert.equal(reader.snapshot().version, (await ctx.storage.get("v2/meta") as any).version)

  const changed = await reader.sync()
  assert.equal(changed, false)
  assert.equal(reader.binding("w", "a")?.sessionID, "s")
  assert.equal(reader.binding("w", "a")?.kind, "workspace")
  assert.equal(reader.binding("w", "a")?.directory, "/repo")
})

test("sync picks up subtasks, messages, and approvals written by another store", async () => {
  const ctx = fakeContext()
  const writer = new V2Store(ctx)
  await writer.load()
  await writer.saveWorkspace(workspace())
  await writer.saveSubtask(subtask({ id: "t1", queueKey: "work:w:delegation:root:abc", workKind: "delegation", attempts: 1 }))
  await writer.appendMessage("w", { id: "m1", author: "user", text: "hello", kind: "text", createdAt: 1 })
  await writer.saveApproval({ id: "ap1", workspaceID: "w", kind: "ask_person", title: "Ask", detail: "?", status: "pending", createdAt: 1 })
  await writer.saveMemory({ id: "mem1", workspaceID: "w", scope: "workspace", text: "note", origin: "manual", source: "user", createdAt: 1, updatedAt: 1, history: [] })
  const reader = new V2Store(ctx)
  await reader.load()
  // Simulate a reader that loaded before the writes landed.
  const stale = new V2Store(ctx)
  await stale.load()
  await writer.saveSubtask(subtask({ id: "t2", queueKey: "work:w:delegation:root:def", workKind: "delegation" }))
  await writer.appendMessage("w", { id: "m2", author: "user", text: "again", kind: "text", createdAt: 2 })
  const changed = await stale.sync()
  assert.equal(changed, true)
  const snapshot = stale.snapshot()
  assert.ok(snapshot.subtasks.t1)
  assert.ok(snapshot.subtasks.t2)
  assert.equal(snapshot.subtasks.t1.queueKey, "work:w:delegation:root:abc")
  assert.deepEqual(snapshot.messages.w.map((item) => item.id).sort(), ["m1", "m2"])
  assert.ok(snapshot.approvals.ap1)
  assert.ok(snapshot.memories.mem1)
  await reader.sync()
  assert.equal(reader.snapshot().version, stale.snapshot().version)
})

test("load leaves an unexpired working claim untouched and backfills queue keys", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.load()
  await store.saveWorkspace(workspace())
  const leaseUntil = Date.now() + 60_000
  await store.saveSubtask(subtask({
    id: "t",
    assigneeID: "a",
    state: "working",
    attempts: 2,
    claimedBy: "run_other",
    activeRunID: "run_other",
    leaseUntil,
    error: "in progress",
    deadlineAt: Date.now() + 300_000,
  }))
  const loaded = new V2Store(ctx)
  await loaded.load()
  const recovered = loaded.snapshot().subtasks.t
  // Ticket #148: a live lease belongs to another instance. Load may backfill
  // derived fields, but it must not steal the claim or rewrite the row.
  assert.equal(recovered.state, "working")
  assert.equal(recovered.interrupted, false)
  assert.equal(recovered.claimedBy, "run_other")
  assert.equal(recovered.activeRunID, "run_other")
  assert.equal(recovered.leaseUntil, leaseUntil)
  assert.equal(recovered.error, "in progress")
  assert.equal(recovered.attempts, 2)
  assert.ok(recovered.queueKey?.startsWith("work:w:delegation:user:"))
  assert.equal(Object.keys(loaded.snapshot().subtasks).length, 1)
})

test("load leaves an expired working claim for lease-time recovery", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.load()
  await store.saveWorkspace(workspace())
  await store.saveSubtask(subtask({
    id: "t",
    assigneeID: "a",
    state: "working",
    attempts: 3,
    claimedBy: "run_dead",
    leaseUntil: 1,
  }))
  const loaded = new V2Store(ctx)
  await loaded.load()
  const recovered = loaded.snapshot().subtasks.t
  // Expiry is the reaper's job, not load's: the store must not pre-empt it.
  assert.equal(recovered.state, "working")
  assert.equal(recovered.claimedBy, "run_dead")
  assert.equal(recovered.leaseUntil, 1)
  assert.equal(recovered.attempts, 3)
})

test("sync never overwrites a locally held claim but still merges other fields", async () => {
  const ctx = fakeContext()
  const owner = new V2Store(ctx)
  await owner.load()
  await owner.saveWorkspace(workspace())
  await owner.saveSubtask(subtask({ id: "t", queueKey: "work:w:delegation:user:run:body", workKind: "delegation", claimedBy: "run_local", leaseUntil: Date.now() + 60_000, title: "Local" }))
  const writer = new V2Store(ctx)
  await writer.load()
  // Another writer edits the title and stamps its own claim on the same row.
  await writer.saveSubtask(subtask({ id: "t", queueKey: "work:w:delegation:user:run:body", workKind: "delegation", claimedBy: "run_foreign", leaseUntil: Date.now() + 60_000, title: "Foreign" }))
  const changed = await owner.sync()
  assert.equal(changed, true)
  const merged = owner.snapshot().subtasks.t
  assert.equal(merged.title, "Foreign")
  assert.equal(merged.claimedBy, "run_local")
})

test("sync adopts a foreign claim when this instance holds none", async () => {
  const ctx = fakeContext()
  const idle = new V2Store(ctx)
  await idle.load()
  await idle.saveWorkspace(workspace())
  await idle.saveSubtask(subtask({ id: "t", queueKey: "work:w:delegation:user:run:body", workKind: "delegation" }))
  const writer = new V2Store(ctx)
  await writer.load()
  await writer.saveSubtask(subtask({ id: "t", queueKey: "work:w:delegation:user:run:body", workKind: "delegation", claimedBy: "run_foreign", leaseUntil: Date.now() + 60_000 }))
  const changed = await idle.sync()
  assert.equal(changed, true)
  assert.equal(idle.snapshot().subtasks.t.claimedBy, "run_foreign")
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

test("streaming rows are indexed across save, foreign sync, and removal", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.load()
  await store.saveWorkspace(workspace({ nextSeq: 3 }))
  const live = message({ id: "m1", seq: 1, streaming: true, text: "partial" })
  await store.saveMessage(live)
  assert.deepEqual(store.streamingMessages(), [{ workspaceID: "w", messageID: "m1" }])
  await store.saveMessage({ ...live, streaming: false, text: "done" })
  assert.deepEqual(store.streamingMessages(), [])

  const writer = new V2Store(ctx)
  await writer.load()
  await writer.saveMessage(message({ id: "m2", seq: 2, streaming: true, text: "foreign partial" }))
  assert.equal(await store.sync(), true)
  assert.deepEqual(store.streamingMessages(), [{ workspaceID: "w", messageID: "m2" }])

  await store.removePrefix("v2/message/w/")
  assert.deepEqual(store.streamingMessages(), [])
})

test("load preserves streaming rows and indexes them for settling", async () => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.load()
  await store.saveWorkspace(workspace({ nextSeq: 3 }))
  await store.saveMessage(message({ id: "m1", seq: 1, streaming: true, text: "partial", updatedAt: 1 }))
  await store.saveMessage(message({ id: "m2", seq: 2, streaming: true, text: "fresh", updatedAt: Date.now() }))
  const loaded = new V2Store(ctx)
  await loaded.load()
  // Ticket #148: load never decides a live stream is dead. The service
  // settles terminal, expired, or stale rows from this index after load.
  assert.equal(loaded.message("w", "m1")?.streaming, true)
  assert.equal(loaded.message("w", "m1")?.interrupted, undefined)
  assert.equal(loaded.message("w", "m2")?.streaming, true)
  assert.deepEqual(
    loaded.streamingMessages().sort((a, b) => a.messageID.localeCompare(b.messageID)),
    [{ workspaceID: "w", messageID: "m1" }, { workspaceID: "w", messageID: "m2" }],
  )
})

test("foreign-version sync merges 10k messages within budget", async (t) => {
  const ctx = fakeContext()
  const store = new V2Store(ctx)
  await store.load()
  await store.saveAgent(agent())
  await store.saveWorkspace(workspace({ nextSeq: 5_001 }))
  for (let seq = 1; seq <= 5_000; seq++) {
    ctx.values.set(`v2/message/w/${String(seq).padStart(8, "0")}`, message({ id: `m${seq}`, seq, text: "x".repeat(500), createdAt: seq }))
  }
  const reader = new V2Store(ctx)
  await reader.load()
  assert.equal(reader.messages("w").length, 5_000)
  for (let seq = 5_001; seq <= 10_000; seq++) {
    ctx.values.set(`v2/message/w/${String(seq).padStart(8, "0")}`, message({ id: `m${seq}`, seq, text: "x".repeat(500), createdAt: seq }))
  }
  const meta = ctx.values.get("v2/meta") as { version: number }
  ctx.values.set("v2/meta", { ...(meta as object), version: meta.version + 1 })

  const started = performance.now()
  assert.equal(await reader.sync(), true)
  const elapsed = performance.now() - started
  const merged = reader.messages("w")
  assert.equal(merged.length, 10_000)
  assert.deepEqual([merged[0].seq, merged.at(-1)?.seq], [1, 10_000])
  t.diagnostic(`10k foreign message sync=${elapsed.toFixed(1)}ms`)
  assert.ok(elapsed < 500, `10k foreign message sync ${elapsed.toFixed(1)}ms must stay under the 500ms budget`)
})
