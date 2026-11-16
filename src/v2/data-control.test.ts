import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { EnsembleV2Service } from "./service.ts"
import { startServiceForTest } from "./test-service.ts"
import { V2Store } from "./store.ts"
import { LOG_RETENTION_DAYS, purgeLogFiles } from "./logging.ts"
import type { Agent, Message, Memory, SessionBinding, Subtask, Workspace } from "./types.ts"

type Handlers = {
  snapshot: (input: unknown) => Promise<any>
  invoke: (input: unknown) => Promise<any>
}

function fakeContext(values = new Map<string, unknown>()) {
  const handlers: Partial<Handlers> = {}
  const subscriptions = new Set<any>()
  const event = {
    subscribe: async function* (options: any = {}) {
      const subscription = { types: options?.types ?? [], queue: [] as any[], wake: undefined as (() => void) | undefined }
      subscriptions.add(subscription)
      try {
        while (true) {
          if (subscription.queue.length === 0) await new Promise<void>((resolve) => { subscription.wake = resolve })
          while (subscription.queue.length > 0) yield subscription.queue.shift()
        }
      } finally {
        subscriptions.delete(subscription)
      }
    },
  }
  let sessions = 0
  const ctx = {
    onboarding: false,
    location: { directory: process.cwd() },
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
    session: {
      hook: async () => ({ dispose: async () => undefined }),
      create: async ({ title }: any) => ({ data: { id: `native_${++sessions}`, title } }),
      get: async ({ sessionID }: any) => ({ data: { id: sessionID } }),
      instructions: { entry: { put: async () => undefined } },
      switchModel: async () => undefined,
      prompt: async () => undefined,
      synthetic: async () => ({ id: "synthetic_1" }),
      update: async () => undefined,
      wait: async () => { await new Promise((resolve) => setTimeout(resolve, 5)) },
      context: async () => ({
        data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "OK" }] }],
      }),
      interrupt: async () => undefined,
      remove: async () => undefined,
      move: async ({ sessionID, directory }: any) => ({ data: { id: sessionID, directory } }),
      command: async () => ({ data: {} }),
    },
    tool: {
      transform: async (factory: any) => {
        factory({ namespace() {}, add() {} })
        return { dispose: async () => undefined }
      },
    },
    rpc: {
      register: async (_schema: unknown, value: Handlers) => {
        handlers.snapshot = value.snapshot
        handlers.invoke = value.invoke
        return { events: { emit: async () => undefined } }
      },
    },
    model: { list: async () => [{ providerID: "probe", id: "probe-model", name: "Probe", variants: [] }] },
    skill: { list: async () => [] },
    event,
  }
  return { ctx, handlers: handlers as Handlers, values }
}

const nova: Agent = {
  id: "a", name: "Nova", title: "Engineer", role: "Builds the product",
  mainModel: { providerID: "probe", modelID: "probe-model" },
  backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1,
}

const workspace = (id: string, directory: string, patch: Partial<Workspace> = {}): Workspace => ({
  id, name: `site-${id}`, directory, leaderID: "a", memberIDs: ["a"], synthesis: true,
  archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1, ...patch,
})

const message = (id: string, workspaceID: string, seq: number, text: string, patch: Partial<Message> = {}): Message => ({
  id, workspaceID, seq, author: "user", text, kind: "text", createdAt: seq, ...patch,
})

const task = (id: string, workspaceID: string, patch: Partial<Subtask> = {}): Subtask => ({
  id, workspaceID, creatorType: "user", assigneeID: "a", title: `Work ${id}`, instruction: "Do the work",
  mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: false,
  awaitingChildren: false, attempts: 0, createdAt: 1, ...patch,
})

async function seed(values: Map<string, unknown>, directory: string, secondDirectory: string): Promise<V2Store> {
  const store = new V2Store({ storage: fakeContext(values).ctx.storage } as any)
  await store.load()
  await store.saveAgent(nova)
  await store.saveWorkspace(workspace("w1", directory))
  await store.saveWorkspace(workspace("w2", secondDirectory, { name: "site-w2", lastActiveAt: 2 }))
  await store.appendMessage("w1", {
    id: "m1", author: "user", text: "Hello team", kind: "text", createdAt: 10,
  })
  await store.appendChannelMessage("dm:a:w1", {
    id: "d1", author: "agent", agentID: "a", text: "Direct reply",
    kind: "text", createdAt: 11,
  })
  await store.appendMessage("w2", {
    id: "m2", author: "user", text: "Other workspace secret", kind: "text", createdAt: 12,
  })
  await store.saveMessage({
    ...message("m3", "w1", 2, "See attached"),
    attachments: [{ id: "att", name: "diagram.png", mime: "image/png", size: 42, kind: "image" }],
  })
  const at = Date.now()
  await store.saveSubtask(task("t1", "w1", { dispatchGroupID: "g1", state: "replied", outcome: "succeeded", finishedAt: at, repliedAt: at }))
  await store.saveSubtask(task("t2", "dm:a:w1", { dispatchGroupID: "g2", workKind: "turn", origin: "native", conversationID: "dm:a:w1", state: "replied", outcome: "succeeded", finishedAt: at, repliedAt: at }))
  await store.saveSubtask(task("t3", "w2", { dispatchGroupID: "g3", title: "Other workspace work", state: "replied", outcome: "succeeded", finishedAt: at, repliedAt: at }))
  await store.saveDispatchGroup({
    id: "g1", workspaceID: "w1", rootID: "g1", continuationIndex: 0, maxHops: 8, usedHops: 1,
    depthMax: 2, createdAt: 1,
  })
  await store.saveDispatchGroup({
    id: "g2", workspaceID: "dm:a:w1", rootID: "g2", continuationIndex: 0, maxHops: 8, usedHops: 1,
    depthMax: 2, createdAt: 2,
  })
  await store.saveDispatchGroup({
    id: "g3", workspaceID: "w2", rootID: "g3", continuationIndex: 0, maxHops: 8, usedHops: 1,
    depthMax: 2, createdAt: 3,
  })
  await store.saveApproval({
    id: "ap1", workspaceID: "w1", kind: "promote_memory", title: "Promote memory", detail: "Ship on Fridays",
    status: "pending", createdAt: 22,
  })
  await store.saveDmQueueEntry({
    id: "q1", agentID: "a", workspaceID: "w1", directory, text: "Queued direct", status: "sent", createdAt: 23,
  })
  const memory: Memory = {
    id: "mem1", workspaceID: "w1", scope: "workspace", text: "Ship on Fridays", origin: "manual", source: "user",
    createdAt: 20, updatedAt: 20, history: [{ at: 20, action: "created", by: "user" }],
  }
  await store.saveMemory(memory)
  await store.saveMemory({
    id: "mem2", scope: "global", text: "Cross-project preference", origin: "manual", source: "user",
    createdAt: 21, updatedAt: 21, history: [{ at: 21, action: "created", by: "user" }],
  })
  const binding: SessionBinding = {
    workspaceID: "w1", agentID: "a", sessionID: "session_w1_secret", kind: "workspace", directory,
    agentVersion: 1, updatedAt: 1,
  }
  await store.saveBinding(binding)
  return store
}

test("data.export returns the documented workspace export without paths, bindings, or credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-data-export-"))
  const directory = join(root, "workspace-one")
  const secondDirectory = join(root, "workspace-two")
  mkdirSync(directory, { recursive: true })
  mkdirSync(secondDirectory, { recursive: true })
  const { ctx, handlers, values } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    // Seed after start so the start-time native reconciliation sees no bound
    // sessions; these fixtures test data control, not native recovery.
    await seed(values, directory, secondDirectory)
    const response = await handlers.invoke({ directory, action: "data.export", payload: {} })
    assert.equal(response.ok, true, JSON.stringify(response.error))
    const exported = response.result
    assert.equal(exported.format, "ensemble.data-export")
    assert.equal(exported.formatVersion, 1)
    assert.equal(exported.workspace.id, "w1")
    assert.equal(exported.workspace.name, "site-w1")
    assert.deepEqual(exported.workspace.members.map((member: any) => member.name), ["Nova"])
    assert.equal(exported.workspace.members[0].title, "Engineer")
    assert.equal(exported.workspace.members[0].role, "Builds the product")

    const group = exported.conversations.find((conversation: any) => conversation.channel === "w1")
    assert.equal(group.kind, "group")
    assert.deepEqual(group.messages.map((item: any) => item.text), ["Hello team", "See attached"])
    assert.deepEqual(group.messages[1].attachments, [{ name: "diagram.png", mime: "image/png", size: 42, kind: "image" }])
    const direct = exported.conversations.find((conversation: any) => conversation.channel === "dm:a:w1")
    assert.equal(direct.kind, "direct")
    assert.equal(direct.agentName, "Nova")
    assert.deepEqual(direct.messages.map((item: any) => item.text), ["Direct reply"])

    assert.deepEqual(exported.work.map((item: any) => item.id).sort(), ["t1", "t2"])
    assert.deepEqual(exported.memories.map((item: any) => item.id), ["mem1"])
    assert.equal(exported.counts.messages, 3)
    assert.equal(exported.counts.work, 2)
    assert.equal(exported.counts.memories, 1)
    assert.equal(exported.logs.included, false)
    assert.equal(exported.logs.retentionDays, 7)
    assert.equal(exported.logs.retentionDays, LOG_RETENTION_DAYS)
    assert.ok(exported.excluded.includes("workspace-directory-paths"))
    assert.ok(exported.excluded.includes("bindings"))
    assert.ok(exported.excluded.includes("operational-logs"))

    const serialized = JSON.stringify(exported)
    assert.equal(serialized.includes(directory), false, "export must not carry the workspace directory")
    assert.equal(serialized.includes(secondDirectory), false, "export must not carry another workspace directory")
    assert.equal(serialized.includes("session_w1_secret"), false, "export must not carry binding session ids")
    assert.equal(serialized.includes("Other workspace"), false, "export must not carry another workspace's data")
    assert.equal(serialized.includes("Cross-project preference"), false, "export must not carry global memories")
    assert.equal(serialized.includes("providerID"), false, "export must not carry model configuration")
    assert.equal(/"password"|"authorization"|"api[_-]?key"/i.test(serialized), false)
  } finally {
    await stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("data.delete requires DELETE, removes one workspace's data, and leaves the workspace healthy", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-data-delete-"))
  const directory = join(root, "workspace-one")
  const secondDirectory = join(root, "workspace-two")
  mkdirSync(directory, { recursive: true })
  mkdirSync(secondDirectory, { recursive: true })
  const { ctx, handlers, values } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    await seed(values, directory, secondDirectory)
    const refused = await handlers.invoke({ directory, action: "data.delete", payload: {} })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, "confirmation_required")
    const intact = await handlers.invoke({ directory, action: "data.export", payload: {} })
    assert.equal(intact.result.counts.messages, 3, "a refused delete removes nothing")

    const removed = await handlers.invoke({ directory, action: "data.delete", payload: { confirmation: "DELETE" } })
    assert.equal(removed.ok, true, JSON.stringify(removed.error))
    assert.equal(removed.result.workspace.id, "w1")
    assert.equal(removed.result.deleted.messages, 3)
    assert.equal(removed.result.deleted.conversations, 2)
    assert.equal(removed.result.deleted.subtasks, 2)
    assert.equal(removed.result.deleted.dispatchGroups, 2)
    assert.equal(removed.result.deleted.memories, 1)
    assert.equal(removed.result.deleted.approvals, 1)
    assert.equal(removed.result.deleted.dmQueue, 1)
    assert.equal(removed.result.deleted.bindings, 1)
    assert.equal(removed.result.nativeSessionsDeleted, 0, "host sessions are opt-in")
    assert.deepEqual(removed.result.retained, ["workspace", "agents", "workspace-config", "native-host-sessions"])

    const snapshot = await handlers.snapshot({ directory })
    assert.equal(snapshot.state.workspaces.w1.name, "site-w1", "the workspace survives")
    assert.equal(snapshot.state.agents.a.name, "Nova", "the roster survives")
    assert.equal(snapshot.state.messages.w1, undefined, "group messages are deleted")
    assert.equal(snapshot.state.messages["dm:a:w1"], undefined, "direct messages are deleted")
    assert.equal(snapshot.state.subtasks.t1, undefined)
    assert.equal(snapshot.state.subtasks.t2, undefined)
    assert.equal(snapshot.state.subtasks.t3.title, "Other workspace work", "another workspace is untouched")
    assert.equal(snapshot.state.messages.w2[0].text, "Other workspace secret")
    assert.equal(snapshot.state.memories.mem1, undefined)
    assert.equal(snapshot.state.memories.mem2.text, "Cross-project preference")
    assert.equal(Object.values(snapshot.state.bindings).some((binding: any) => binding.workspaceID === "w1"), false)
    assert.equal(Object.values(snapshot.state.approvals).some((approval: any) => approval.workspaceID === "w1"), false)
    assert.deepEqual(Object.keys(snapshot.state.dmQueue), [])

    const emptied = await handlers.invoke({ directory, action: "data.export", payload: {} })
    assert.equal(emptied.ok, true)
    assert.equal(emptied.result.workspace.name, "site-w1")
    assert.equal(emptied.result.counts.messages, 0)
    assert.equal(emptied.result.counts.work, 0)
    assert.equal(emptied.result.counts.memories, 0)

    const sent = await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: "w1", text: "After delete" } })
    assert.equal(sent.ok, true, JSON.stringify(sent.error))
    const healthy = await handlers.snapshot({ directory })
    assert.equal(healthy.state.workspaces.w1.paused, false)
    assert.equal(healthy.state.workspaces.w1.id, "w1")
    assert.ok((healthy.state.messages.w1 ?? []).some((item: any) => item.text === "After delete"))
  } finally {
    await stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("log deletion removes only Ensemble-owned log files", () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-logs-"))
  try {
    for (const name of [
      "service-20261116-123.jsonl",
      "service-20261116-123.jsonl.1",
      "service-failures-20261116-123.jsonl",
      "tui-20261116-9.jsonl",
    ]) writeFileSync(join(directory, name), "{}\n")
    for (const name of ["notes.txt", "other.jsonl", "service-notes.txt"]) writeFileSync(join(directory, name), "keep\n")
    assert.equal(purgeLogFiles(directory), 4)
    assert.deepEqual(readdirSync(directory).sort(), ["notes.txt", "other.jsonl", "service-notes.txt"])
    assert.equal(purgeLogFiles(join(directory, "missing")), 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
