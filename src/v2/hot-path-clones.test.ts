import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { EnsembleV2Service } from "./service.ts"
import { seedLegacySettings, startServiceForTest } from "./test-service.ts"
import { V2Store, cloneStats, resetCloneStats } from "./store.ts"
import type { Agent, Workspace } from "./types.ts"

type Handlers = {
  snapshot: (input: unknown) => Promise<any>
  diagnostic: (input: unknown) => Promise<any>
  invoke: (input: unknown) => Promise<any>
}

function fakeContext(values: Map<string, unknown>) {
  seedLegacySettings(values)
  const tools = new Map<string, any>()
  const handlers: Partial<Handlers> = {}
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
      wait: async () => { await new Promise((resolve) => setTimeout(resolve, 5)) },
      context: async () => ({
        data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "OK" }] }],
      }),
      interrupt: async () => undefined,
      remove: async () => undefined,
      move: async ({ sessionID, directory }: any) => ({ data: { id: sessionID, directory } }),
      command: async () => ({ data: {} }),
    },
    tool: { transform: async (factory: any) => factory({ namespace() {}, add(tool: any) { tools.set(tool.name, tool) } }) },
    rpc: {
      register: async (_schema: unknown, value: Handlers) => {
        handlers.snapshot = value.snapshot
        handlers.diagnostic = value.diagnostic
        handlers.invoke = value.invoke
        return { events: { emit: async () => undefined } }
      },
    },
    model: { list: async () => [{ providerID: "probe", id: "probe-model", name: "Probe", variants: [] }] },
    skill: { list: async () => [] },
    event: { subscribe: async function* () { while (true) await new Promise<void>(() => undefined) } },
  }
  return { ctx, handlers: handlers as Handlers, tools }
}

const nova: Agent = {
  id: "agent_nova", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" },
  backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1,
}
const sage: Agent = {
  id: "agent_sage", name: "Sage", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" },
  backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1,
}

async function seedLargeWorkspace(messageCount: number) {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-hot-path-"))
  const values = new Map<string, unknown>()
  const seed = new V2Store({ storage: fakeContext(values).ctx.storage })
  await seed.saveAgent(nova)
  await seed.saveAgent(sage)
  const workspace: Workspace = {
    id: "w", name: "site", directory, leaderID: nova.id, memberIDs: [nova.id, sage.id], synthesis: true,
    archived: false, paused: false, nextSeq: messageCount + 1, createdAt: 1, lastActiveAt: 1,
  }
  await seed.saveWorkspace(workspace)
  for (let seq = 1; seq <= messageCount; seq++) {
    values.set(`v2/message/w/${String(seq).padStart(8, "0")}`, {
      id: `m${seq}`, workspaceID: "w", seq, author: "user", text: "x".repeat(500), kind: "text", createdAt: seq,
    })
  }
  await seed.saveBinding({ workspaceID: "w", agentID: nova.id, sessionID: "sess_nova", agentVersion: 1, updatedAt: 1, kind: "workspace", directory })
  await seed.saveBinding({ workspaceID: "w", agentID: sage.id, sessionID: "sess_sage", agentVersion: 1, updatedAt: 1, kind: "workspace", directory })
  return { directory, values, workspace }
}

async function waitFor(check: () => boolean, timeout = 5000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for condition")
}

async function setup(messageCount: number) {
  const { directory, values, workspace } = await seedLargeWorkspace(messageCount)
  const { ctx, tools } = fakeContext(values)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const store = (service as any).store as V2Store
  return { directory, values, workspace, handlers: service.handlers(), tools, service, stop, store }
}

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

function elapsed(fn: () => void): number {
  const started = performance.now()
  fn()
  return performance.now() - started
}

test("10k-message handoff publishes its task change with zero full-state clones", async (t) => {
  const setupState = await setup(10_000)
  try {
    withCloneDebug(t)
    const samples = [
      elapsed(() => setupState.store.snapshot()),
      elapsed(() => setupState.store.snapshot()),
      elapsed(() => setupState.store.snapshot()),
    ].sort((a, b) => a - b)
    const baseline = samples[Math.floor(samples.length / 2)]
    resetCloneStats()
    mkdirSync(join(setupState.directory, ".ensemble", "handoffs"), { recursive: true })
    const path = join(setupState.directory, ".ensemble", "handoffs", "ask.md")
    writeFileSync(path, "---\nensemble: handoff\ntask: Summarize the deploy\n---\n# Handoff\n")
    const started = performance.now()
    const asked = await setupState.tools.get("handoff").execute(
      { maxHops: 1, task: "Summarize the deploy", summary: "Short version", path: ".ensemble/handoffs/ask.md", to: "Sage" },
      { sessionID: "sess_nova" },
    )
    const handoffMs = performance.now() - started
    assert.match(asked.content, /Handed to \$Sage/)
    assert.equal(cloneStats().count, 0, "a handoff clones no full state before publishing its task")
    assert.ok(
      handoffMs < baseline,
      `handoff ${handoffMs.toFixed(2)}ms must beat one snapshot clone ${baseline.toFixed(2)}ms`,
    )
    t.diagnostic(`10k handoff=${handoffMs.toFixed(2)}ms snapshot=${baseline.toFixed(2)}ms`)
    const hops = setupState.store.subtasks().filter((task) => task.workKind === "handoff")
    assert.equal(hops.length, 1)
    assert.equal(hops[0].assigneeID, sage.id)
  } finally {
    await setupState.stop()
  }
})

test("10k-message delegation publishes its task change with zero full-state clones", async (t) => {
  const setupState = await setup(10_000)
  try {
    withCloneDebug(t)
    const delegated = await setupState.tools.get("delegate").execute(
      { maxHops: 1, assignee: "Sage", title: "Check the deploy", instruction: "Review it." },
      { sessionID: "sess_nova" },
    )
    assert.match(delegated.content, /Delegated to Sage/)
    assert.equal(cloneStats().count, 0)
    const tasks = setupState.store.subtasks()
    assert.equal(tasks.filter((task) => task.assigneeID === sage.id && task.workKind === "delegation").length, 1)
  } finally {
    await setupState.stop()
  }
})

test("the explicit snapshot boundary performs exactly one full-state clone", async (t) => {
  const setupState = await setup(10_000)
  try {
    withCloneDebug(t)
    const payload = await setupState.handlers.snapshot({ directory: setupState.directory })
    assert.equal(payload.state.messages.w.length, 10_000)
    assert.equal(cloneStats().count, 1)
  } finally {
    await setupState.stop()
  }
})

test("chat context and tool handlers read one agent or task without cloning messages", async (t) => {
  const setupState = await setup(10_000)
  try {
    withCloneDebug(t)
    const context = await setupState.handlers.invoke({
      directory: setupState.directory,
      action: "chat.context",
      payload: { agentID: nova.id, workspaceID: "w" },
    })
    assert.equal(context.ok, true)
    assert.equal(cloneStats().count, 0)
    const status = await setupState.tools.get("task_status").execute({}, { sessionID: "sess_nova" })
    assert.equal(typeof status.content, "string")
    assert.equal(cloneStats().count, 0)
    const agents = await setupState.tools.get("list_agents").execute()
    assert.match(agents.content, /Nova/)
    assert.equal(cloneStats().count, 0)
  } finally {
    await setupState.stop()
  }
})

test("a pump and run-start cycle does not clone the full state", async (t) => {
  const setupState = await setup(10_000)
  try {
    withCloneDebug(t)
    const sent = await setupState.handlers.invoke({
      directory: setupState.directory,
      action: "message.send",
      payload: { workspaceID: "w", text: "Hello team" },
    })
    assert.equal(sent.ok, true)
    await waitFor(() => setupState.store.subtasks().some((task) => task.state === "replied"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(cloneStats().count, 0, "pump, run-start, and stream settling clone no full state")
  } finally {
    await setupState.stop()
  }
})

test("the diagnostic read reports clone metrics only under the debug flag", async (t) => {
  const setupState = await setup(10)
  try {
    withCloneDebug(t)
    const enabled = await (setupState.handlers.diagnostic({ directory: setupState.directory }) as Promise<any>)
    assert.equal(enabled.clones.enabled, true)
    assert.equal(enabled.clones.count, 1)
  } finally {
    await setupState.stop()
  }
})
