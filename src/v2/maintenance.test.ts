import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { EnsembleV2Service } from "./service.ts"
import { startServiceForTest } from "./test-service.ts"
import { V2Store } from "./store.ts"
import { MAX_ATTEMPTS } from "./queue.ts"
import type { Agent, Message, Subtask, Workspace } from "./types.ts"

type Handlers = {
  snapshot: (input: unknown) => Promise<any>
  invoke: (input: unknown) => Promise<any>
}

function fakeContext(values = new Map<string, unknown>()) {
  const handlers: Partial<Handlers> = {}
  const writes = { sets: 0, removes: 0 }
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
  const emitEvent = (value: any) => {
    for (const subscription of subscriptions) {
      if (subscription.types.length > 0 && !subscription.types.includes(value.type)) continue
      subscription.queue.push(value)
      subscription.wake?.()
      subscription.wake = undefined
    }
  }
  const ctx = {
    onboarding: false,
    storage: {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: unknown) => {
        writes.sets++
        values.set(key, value)
      },
      remove: async (key: string) => {
        writes.removes++
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
    },
    session: {
      hook: async () => ({ dispose: async () => undefined }),
      create: async ({ title }: any) => ({ data: { id: `session_${title}`, title } }),
      instructions: { entry: { put: async () => undefined } },
      switchModel: async () => undefined,
      prompt: async () => undefined,
      wait: async () => { await new Promise((resolve) => setTimeout(resolve, 5)) },
      context: async () => ({
        data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "OK" }] }],
      }),
      interrupt: async () => undefined,
      remove: async () => undefined,
      move: async ({ sessionID, directory }: any) => ({ data: { id: sessionID, directory } }),
      command: async () => ({ data: {} }),
    },
    tool: { transform: async (factory: any) => factory({ namespace() {}, add() {} }) },
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
  return { ctx, handlers: handlers as Handlers, values, writes, emitEvent }
}

async function waitFor(check: () => Promise<boolean>, timeout = 10_000): Promise<number> {
  const started = performance.now()
  while (performance.now() - started < timeout) {
    if (await check()) return performance.now() - started
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out after ${timeout}ms waiting for condition`)
}

const nova: Agent = {
  id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" },
  backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1,
}
const workspace = (directory: string, patch: Partial<Workspace> = {}): Workspace => ({
  id: "w", name: "site", directory, leaderID: "a", memberIDs: ["a"], synthesis: true,
  archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1, ...patch,
})

async function seedWorkspace(directory: string, values: Map<string, unknown>): Promise<V2Store> {
  const seed = new V2Store({ storage: fakeContext(values).ctx.storage } as any)
  await seed.load()
  await seed.saveAgent(nova)
  await seed.saveWorkspace(workspace(directory))
  return seed
}

test("snapshot performs no writes and runs no maintenance pass", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-pure-"))
  const { ctx, values, writes } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const handlers = service.handlers()
  const stop = await startServiceForTest(service, service.ctx)
  await stop()
  const seed = await seedWorkspace(directory, values)
  const stale: Subtask = {
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Stale", instruction: "Do",
    mode: "research", state: "working", stage: "initial", outcome: "pending", interrupted: false,
    awaitingChildren: false, attempts: MAX_ATTEMPTS, createdAt: 1,
  }
  await seed.saveSubtask(stale)
  const streaming: Message = {
    id: "m", workspaceID: "w", seq: 1, author: "agent", taskID: "t", text: "partial reply",
    kind: "text", streaming: true, createdAt: 2,
  }
  await seed.saveMessage(streaming)
  writes.sets = 0
  writes.removes = 0

  const snapshot = await handlers.snapshot({ directory })
  assert.equal(writes.sets, 0, "snapshot must not persist state")
  assert.equal(writes.removes, 0, "snapshot must not remove state")
  assert.equal(snapshot.state.subtasks.t.state, "working", "snapshot must not reap stale work")
  const live = snapshot.state.messages.w.find((item: Message) => item.id === "m") as Message | undefined
  assert.equal(live?.streaming, true, "snapshot must not settle streams")
  rmSync(directory, { recursive: true, force: true })
})

test("the maintenance timer reaps stale work and settles terminal streams", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-timer-"))
  const { ctx, values } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const handlers = service.handlers()
  const stop = await startServiceForTest(service, service.ctx)
  const seed = await seedWorkspace(directory, values)
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Stale", instruction: "Do",
    mode: "research", state: "working", stage: "initial", outcome: "pending", interrupted: false,
    awaitingChildren: false, attempts: MAX_ATTEMPTS, createdAt: 1,
  })
  await seed.saveMessage({
    id: "m", workspaceID: "w", seq: 1, author: "agent", taskID: "t", text: "partial reply",
    kind: "text", streaming: true, createdAt: 2,
  })
  try {
    const elapsed = await waitFor(async () => {
      const snapshot = await handlers.snapshot({ directory })
      const message = (snapshot.state.messages.w ?? []).find((item: Message) => item.id === "m")
      return snapshot.state.subtasks.t?.state === "replied" && message?.streaming === false
    })
    assert.ok(elapsed < 5_000, `timer maintenance took ${elapsed.toFixed(1)}ms`)
    const snapshot = await handlers.snapshot({ directory })
    assert.equal(snapshot.state.subtasks.t.outcome, "failed")
    const message = snapshot.state.messages.w.find((item: Message) => item.id === "m") as Message
    assert.ok(message)
    assert.equal(message.text, "partial reply")
    assert.equal(message.interrupted, true)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("5k-task waiting-work reconciliation meets the latency budget", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-5k-"))
  const { ctx, values } = fakeContext()
  const seed = await seedWorkspace(directory, values)
  for (let index = 0; index < 5_000; index++) {
    const task: Subtask = {
      id: `t${String(index).padStart(4, "0")}`,
      workspaceID: "w",
      creatorType: "user",
      assigneeID: "a",
      title: `Task ${index}`,
      instruction: "Do",
      mode: "research",
      state: "pending",
      stage: "initial",
      outcome: "pending",
      interrupted: false,
      awaitingChildren: true,
      attempts: 0,
      createdAt: index + 1,
    }
    values.set(`v2/subtask/${task.id}`, task)
  }
  await seed.bump()
  const service = new EnsembleV2Service(ctx)
  const handlers = service.handlers()
  const started = performance.now()
  const stop = await startServiceForTest(service, service.ctx)
  try {
    const elapsed = await waitFor(async () => {
      const snapshot = await handlers.snapshot({ directory })
      const tasks = Object.values(snapshot.state.subtasks) as Subtask[]
      return tasks.length === 5_000 && tasks.every((task) => task.state === "replied")
    }, 15_000)
    const total = performance.now() - started
    t.diagnostic(`5k-task reconciliation=${total.toFixed(1)}ms wait=${elapsed.toFixed(1)}ms`)
    assert.ok(total < 2_000, `5k-task reconciliation took ${total.toFixed(1)}ms, over the 2000ms budget`)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a config file event triggers discovery without a read-path pass", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-config-event-"))
  const { ctx, emitEvent } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const handlers = service.handlers()
  const stop = await startServiceForTest(service, service.ctx)
  try {
    await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    await handlers.snapshot({ directory })
    mkdirSync(join(directory, ".ensemble"), { recursive: true })
    writeFileSync(join(directory, ".ensemble", "config.json"), JSON.stringify({
      version: 1, name: "Eventful", leader: "Nova", members: ["Nova"], synthesis: true, paused: false,
    }))
    emitEvent({ type: "file.edited", data: { file: join(directory, ".ensemble", "config.json") } })
    const elapsed = await waitFor(async () => {
      const snapshot = await handlers.snapshot({ directory })
      return Object.values(snapshot.state.workspaces).some((item: Workspace) => item.name === "Eventful")
    }, 1_200)
    assert.ok(elapsed < 1_000, `config event discovery took ${elapsed.toFixed(1)}ms`)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})
