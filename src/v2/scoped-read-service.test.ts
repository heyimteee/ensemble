import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { EnsembleV2Service } from "./service.ts"
import { startServiceForTest } from "./test-service.ts"
import { scopesToResync } from "./scoped-read.ts"
import type { Agent, Message, Subtask, Workspace } from "./types.ts"

function fakeContext(values = new Map<string, unknown>()) {
  const emitted: Array<{ name: string; data: any }> = []
  const ctx = {
    onboarding: false,
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
      create: async ({ title }: any) => ({ data: { id: `session_${title}`, title } }),
      instructions: { entry: { put: async () => undefined } },
      switchModel: async () => undefined,
      prompt: async () => undefined,
      update: async () => undefined,
      wait: async () => undefined,
      context: async () => ({ data: [] }),
      interrupt: async () => undefined,
      remove: async () => undefined,
      move: async ({ sessionID, directory }: any) => ({ data: { id: sessionID, directory } }),
      command: async () => ({ data: {} }),
    },
    tool: { transform: async (factory: any) => factory({ namespace() {}, add() {} }) },
    rpc: {
      register: async (_schema: unknown, _value: unknown) => ({
        events: {
          emit: async (name: string, data: any) => { emitted.push({ name, data }) },
        },
      }),
    },
    model: { list: async () => [{ providerID: "probe", id: "probe-model", name: "Probe", variants: [] }] },
    skill: { list: async (): Promise<any[]> => [] },
    event: {
      subscribe: async function* () {
        await new Promise<void>(() => undefined)
      },
    },
  }
  return { ctx, values, emitted }
}

const agent = (): Agent => ({
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
})

const workspace = (): Workspace => ({
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
})

const message = (seq: number, patch: Partial<Message> = {}): Message => ({
  id: `m${seq}`,
  workspaceID: "w",
  seq,
  author: "agent",
  text: "x".repeat(500),
  kind: "text",
  createdAt: 1 + seq,
  ...patch,
})

const task = (patch: Partial<Subtask> = {}): Subtask => ({
  id: "t",
  workspaceID: "w",
  creatorType: "user",
  assigneeID: "a",
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

function seed(values: Map<string, unknown>, options: { messages: number; oldTasks?: number; version?: number; live?: boolean }) {
  const version = options.version ?? 100
  values.set("v2/meta", { version, updatedAt: 1, settings: {}, ui: {} })
  values.set("v2/agent/a", agent())
  values.set("v2/workspace/w", workspace())
  for (let seq = 1; seq <= options.messages; seq++) {
    values.set(`v2/message/w/${String(seq).padStart(8, "0")}`, message(seq))
  }
  if (options.live !== false) {
    values.set("v2/subtask/live", task({
      id: "live",
      dispatchGroupID: "dispatch_live",
      state: "working",
      claimedBy: "run",
      leaseUntil: Date.now() + 60_000,
      attempts: 1,
      createdAt: 10,
    }))
    values.set("v2/subtask/liveDone", task({
      id: "liveDone",
      dispatchGroupID: "dispatch_live",
      state: "replied",
      outcome: "succeeded",
      finishedAt: Date.now() - 5_000,
      repliedAt: Date.now() - 5_000,
      createdAt: 11,
    }))
  }
  const finished = Date.now() - 60 * 60_000
  for (let index = 0; index < (options.oldTasks ?? 0); index++) {
    const id = `old${index}`
    values.set(`v2/subtask/${id}`, task({
      id,
      dispatchGroupID: `dispatch_old_${index}`,
      state: "replied",
      outcome: "succeeded",
      finishedAt: finished,
      repliedAt: finished,
      createdAt: 20 + index,
    }))
  }
}

test("a large-history workspace bootstraps shell, visible Work, and one bounded transcript window", async (t) => {
  const values = new Map<string, unknown>()
  seed(values, { messages: 10_000, oldTasks: 600 })
  const { ctx } = fakeContext(values)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers() as any
  const directory = mkdtempSync(join(tmpdir(), "ensemble-scoped-"))
  try {
    const started = performance.now()
    const bootstrap = await handlers.bootstrap({ directory })
    const elapsed = performance.now() - started

    assert.equal(bootstrap.scoped, true, "large history uses the scoped bootstrap")
    assert.equal(bootstrap.gate.enabled, true)
    assert.equal(bootstrap.protocol, 4)
    assert.equal(bootstrap.state.messages.w.length, 40, "only the active transcript window travels")
    assert.equal(bootstrap.state.messages.w.at(-1).seq, 10_000)
    assert.deepEqual(Object.keys(bootstrap.state.subtasks).sort(), ["live", "liveDone"], "long-retained terminal rows are excluded")
    assert.equal(bootstrap.counts.w.busy, 1)

    const bytes = Buffer.byteLength(JSON.stringify(bootstrap))
    t.diagnostic(`bootstrap payload=${bytes}B latency=${elapsed.toFixed(1)}ms messages=10000 tasks=602`)
    assert.ok(bytes < 128 * 1024, `bootstrap payload stayed bounded (${bytes} bytes)`)
    assert.ok(elapsed < 500, `bootstrap latency stayed bounded (${elapsed.toFixed(1)} ms)`)
  } finally {
    await stop()
  }
})

test("a small workspace keeps the full snapshot path and records the disabled gate", async () => {
  const values = new Map<string, unknown>()
  seed(values, { messages: 10, live: false })
  const { ctx } = fakeContext(values)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers() as any
  const directory = mkdtempSync(join(tmpdir(), "ensemble-scoped-"))
  try {
    const bootstrap = await handlers.bootstrap({ directory })
    assert.equal(bootstrap.gate.enabled, false)
    assert.equal(bootstrap.gate.reason, "small-history")
    assert.equal(bootstrap.scoped, false)
    assert.equal(bootstrap.state.messages.w.length, 10, "small history still arrives whole")

    const revision = await handlers.revision({ directory })
    assert.deepEqual(revision.counts.w, { unread: 10, busy: 0 })

    // Review fix: a disabled gate keeps the caller on the snapshot path at
    // steady state too; scoped branches are not silently returned.
    const resync = await handlers.resync({ directory, workspaceID: "w" })
    assert.equal(resync.gate.enabled, false)
    assert.equal(resync.shell, undefined)
    assert.equal(resync.work, undefined)
    assert.equal(resync.transcript, undefined)
  } finally {
    await stop()
  }
})

test("a measured full snapshot can enable the gate for the next scoped read", async () => {
  const values = new Map<string, unknown>()
  seed(values, { messages: 950, live: false })
  const { ctx } = fakeContext(values)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers() as any
  const directory = mkdtempSync(join(tmpdir(), "ensemble-scoped-"))
  try {
    const bootstrap = await handlers.bootstrap({ directory })
    assert.equal(bootstrap.scoped, false, "history size alone keeps this boot on the snapshot path")
    assert.equal(bootstrap.gate.enabled, true, "the measured full snapshot upgrades the gate")
    assert.equal(bootstrap.gate.reason, "payload")

    const resync = await handlers.resync({ directory, workspaceID: "w" })
    assert.equal(resync.gate.enabled, true)
    assert.equal(resync.transcript.messages.at(-1).seq, 950, "the next scoped read carries the window")
  } finally {
    await stop()
  }
})

test("transcript windows page older rows and a result outside the window is fetched by id", async () => {
  const values = new Map<string, unknown>()
  seed(values, { messages: 120 })
  values.set("v2/subtask/result", task({
    id: "result",
    state: "replied",
    outcome: "succeeded",
    resultMessageID: "m5",
    finishedAt: Date.now() - 2_000,
    repliedAt: Date.now() - 2_000,
  }))
  const { ctx } = fakeContext(values)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers() as any
  const directory = mkdtempSync(join(tmpdir(), "ensemble-scoped-"))
  try {
    const latest = await handlers["transcript.window"]({ directory, workspaceID: "w", limit: 40 })
    assert.equal(latest.messages.length, 40)
    assert.equal(latest.messages.at(-1).seq, 120)
    assert.equal(latest.hasMoreOlder, true)

    const older = await handlers["transcript.window"]({ directory, workspaceID: "w", beforeSeq: latest.oldestSeq, limit: 40 })
    assert.equal(older.messages.at(-1).seq, latest.oldestSeq! - 1)
    assert.equal(older.hasMoreOlder, true)

    const result = await handlers["message.get"]({ directory, workspaceID: "w", messageID: "m5" })
    assert.equal(result.found, true)
    assert.equal(result.message.id, "m5")

    const missing = await handlers["message.get"]({ directory, workspaceID: "w", messageID: "missing" })
    assert.equal(missing.found, false)
  } finally {
    await stop()
  }
})

test("a gap resync returns only the scopes whose durable state changed after the cursor", async () => {
  const values = new Map<string, unknown>()
  seed(values, { messages: 10, oldTasks: 600, version: 100, live: false })
  const { ctx } = fakeContext(values)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers() as any
  const directory = mkdtempSync(join(tmpdir(), "ensemble-scoped-"))
  try {
    const store = (service as any).store
    await store.saveSubtask(task({ id: "new", state: "working", claimedBy: "run", leaseUntil: Date.now() + 60_000, attempts: 1 }))

    const since = await handlers["changes.since"]({ directory, epoch: 0, version: 100 })
    assert.equal(since.reset, true, "an unknown epoch asks for recovery")
    const scopes = scopesToResync(100, since.scopeVersions)
    assert.deepEqual(scopes, ["work"])

    const resync = await handlers.resync({ directory, workspaceID: "w", scopes })
    assert.equal(resync.shell, undefined, "the shell is not reloaded")
    assert.equal(resync.transcript, undefined, "the transcript is not reloaded")
    assert.ok(resync.work.new, "only the Work projection is repaired")
    assert.equal(resync.work.old0, undefined)
    assert.equal(resync.counts.w.busy, 1, "the crash-recovered seed row is pending; only the new claim is busy")

    const shellAndTranscript = await handlers.resync({ directory, workspaceID: "w", scopes: ["shell", "transcript"] })
    assert.equal(shellAndTranscript.work, undefined, "work is not re-sent when it is already current")
    assert.ok(shellAndTranscript.shell.workspaces.w, "the requested shell scope is present")
    assert.equal(shellAndTranscript.transcript.messages.at(-1).seq, 10, "the requested transcript window is present")
  } finally {
    await stop()
  }
})
