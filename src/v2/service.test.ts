import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { EnsembleV2Service, streamFinalization } from "./service.ts"
import { startServiceForTest } from "./test-service.ts"
import { SharedEnsemble } from "./shared-service.ts"
import { workKey } from "./queue.ts"
import { V2Store, bindingKey } from "./store.ts"
import type { Agent, Workspace } from "./types.ts"
import { INIT_PROGRESS_TEXT, INIT_START_TEXT, SYSTEM_AGENT_NAME, initJobPhase } from "./system-agent.ts"
import { ENSEMBLE_BLOCK_VERSION } from "./init-block.ts"
import { SHARED_SERVICE_VERSION } from "./shared-version.ts"
import { FALLBACK_REPLIES } from "./execution.ts"

type Handlers = {
  snapshot: (input: unknown) => Promise<any>
  revision: (input: unknown) => Promise<any>
  "changes.since": (input: unknown) => Promise<any>
  invoke: (input: unknown) => Promise<any>
}

function fakeContext(sharedValues?: Map<string, unknown>) {
  const values = sharedValues ?? new Map<string, unknown>()
  const removedSessions: string[] = []
  const interruptedSessions: string[] = []
  const movedSessions: Array<{ sessionID: string; directory: string }> = []
  const commands: Array<{ sessionID: string; name: string; text?: string }> = []
  const prompts: any[] = []
  const permissionUpdates: Array<{ sessionID: string; permissions: any[] }> = []
  const instructions: Array<{ sessionID: string; key: string; value: string }> = []
  const createdSessionIDs: string[] = []
  let sessions = 0
  const handlers: Partial<Handlers> = {}
  const emitted: Array<{ name: string; data: any }> = []
  const tools = new Map<string, any>()
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
    // The declared plugin Context carries the loaded location; tests that
    // assert `service.start` attribution point this at a sentinel directory.
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
      create: async ({ title }: any) => { const id = `session_${++sessions}`; createdSessionIDs.push(id); return { data: { id, title } } },
      instructions: { entry: { put: async (input: any) => { instructions.push(input) } } },
      switchModel: async () => undefined,
      prompt: async (input: any) => { prompts.push({ ...input }) },
      update: async (input: any) => { permissionUpdates.push({ sessionID: String(input.sessionID), permissions: input.permissions }) },
      wait: async () => { await new Promise((resolve) => setTimeout(resolve, 5)) },
      context: async () => ({
        data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "OK" }] }],
      }),
      interrupt: async ({ sessionID }: any) => { interruptedSessions.push(sessionID) },
      remove: async ({ sessionID }: any) => { removedSessions.push(sessionID) },
      move: async ({ sessionID, directory }: any) => { movedSessions.push({ sessionID, directory }); return { data: { id: sessionID, directory } } },
      command: async ({ sessionID, name, text }: any) => { commands.push({ sessionID, name, text }); return { data: {} } },
    },
    tool: { transform: async (factory: any) => factory({ namespace() {}, add(tool: any) { tools.set(tool.name, tool) } }) },
    rpc: {
      register: async (_schema: unknown, value: Handlers) => {
        handlers.snapshot = value.snapshot
        handlers.revision = value.revision
        handlers["changes.since"] = value["changes.since"]
        handlers.invoke = value.invoke
        return {
          events: {
            emit: async (name: string, data: any) => {
              emitted.push({ name, data })
            },
          },
        }
      },
    },
    model: {
      list: async () => [{ providerID: "probe", id: "probe-model", name: "Probe", variants: [] }],
    },
    skill: { list: async (): Promise<any[]> => [] },
    event,
  }
  return { ctx, handlers: handlers as Handlers, values, removedSessions, interruptedSessions, movedSessions, commands, prompts, permissionUpdates, instructions, createdSessionIDs, tools, emitted, emitEvent }
}

/** Shared fixtures for tests that need durable work without exercising setup. */
const novaAgent = (patch: Partial<Agent> = {}): Agent => ({
  id: "a", name: "Nova", title: "", role: "",
  mainModel: { providerID: "probe", modelID: "probe-model" },
  backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false,
  version: 1, createdAt: 1, updatedAt: 1, ...patch,
})

const siteWorkspace = (directory: string, patch: Partial<Workspace> = {}): Workspace => ({
  id: "w", name: "site", directory, leaderID: "a", memberIDs: ["a"], synthesis: true,
  archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1, ...patch,
})

async function seedAgent(store: V2Store, patch: Partial<Agent> = {}): Promise<void> {
  await store.saveAgent(novaAgent(patch))
}

async function seedWorkspace(store: V2Store, directory: string, patch: Partial<Workspace> = {}): Promise<void> {
  await store.saveWorkspace(siteWorkspace(directory, patch))
}

async function waitFor(check: () => Promise<boolean>, timeout = 2000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for condition")
}

/** Ticket #182: one live Ensemble parent task with a bound native session. */
async function seedNativeParent(seed: V2Store, directory: string): Promise<void> {
  await seedAgent(seed)
  await seedWorkspace(seed, directory)
  await seed.saveDispatchGroup({
    id: "group_parent",
    workspaceID: "w",
    rootID: "group_parent",
    continuationIndex: 0,
    maxHops: 8,
    usedHops: 1,
    depthMax: 8,
    createdAt: 1,
  })
  await seed.saveSubtask({
    id: "task_parent",
    workspaceID: "w",
    creatorType: "user",
    assigneeID: "a",
    title: "Parent",
    instruction: "Do parent",
    mode: "research",
    state: "working",
    stage: "initial",
    outcome: "pending",
    interrupted: false,
    awaitingChildren: false,
    attempts: 1,
    createdAt: 1,
    dispatchGroupID: "group_parent",
    claimedBy: "run_parent",
    activeRunID: "run_parent",
    leaseUntil: Date.now() + 60_000,
  })
  await seed.saveBinding({
    workspaceID: "w",
    agentID: "a",
    sessionID: "session_parent",
    kind: "workspace",
    directory,
    agentVersion: 1,
    updatedAt: 1,
  })
}

test("service.start installs no event subscriptions on the bootstrap context", async () => {
  const { ctx } = fakeContext()
  let subscriptions = 0
  const original = ctx.event.subscribe
  ;(ctx.event as any).subscribe = (options?: any) => {
    subscriptions += 1
    return original.call(ctx.event, options)
  }
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
  try {
    assert.equal(subscriptions, 0, "location adapters own the event streams")
  } finally {
    await stop()
  }
})

test("service routes group messages, persists sequence, and restores the active workspace", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova", role: "Engineering" } })
    assert.equal(agent.ok, true)
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id },
    })
    assert.equal(workspace.ok, true)
    const activated = await handlers.invoke({ directory, action: "workspace.activate", payload: { id: workspace.result.id } })
    assert.equal(activated.ok, true)
    const snapshot = await handlers.snapshot({ directory })
    assert.equal(snapshot.state.ui.activeWorkspaceID, workspace.result.id)

    const sent = await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Hello team" } })
    assert.equal(sent.ok, true)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.state === "replied")
    })
    const next = await handlers.snapshot({ directory })
    const messages = next.state.messages[workspace.result.id]
    assert.deepEqual(messages.map((message: any) => message.seq), [1, 2, 3])
    assert.equal(messages[2].text, "OK")
  } finally {
    await stop()
  }
})

test("unknown mentions fail clearly instead of silently reaching the leader", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id },
    })
    const response = await handlers.invoke({
      directory,
      action: "message.send",
      payload: { workspaceID: workspace.result.id, text: "$Ghost take a look" },
    })
    assert.equal(response.ok, false)
    assert.equal(response.error?.code, "unknown_member")
    assert.match(response.error?.message ?? "", /\$Ghost/)
  } finally {
    await stop()
  }
})

test("restart recovery requeues working subtasks without an approval gate", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seed.saveAgent({
    id: "a",
    name: "Nova",
    title: "",
    role: "",
    mainModel: { providerID: "probe", modelID: "probe-model" },
    backupModels: [],
    skillbox: [],
    color: "cyan",
    archived: false,
    pendingSettings: false,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  })
  await seed.saveWorkspace({
    id: "w",
    name: "site",
    directory,
    leaderID: "a",
    memberIDs: ["a"],
    synthesis: true,
    archived: false,
    paused: false,
    nextSeq: 1,
    createdAt: 1,
    lastActiveAt: 1,
  })
  await seed.saveSubtask({
    id: "t",
    workspaceID: "w",
    creatorType: "user",
    assigneeID: "a",
    title: "Interrupted",
    instruction: "Do work",
    mode: "research",
    state: "working",
    stage: "initial",
    outcome: "pending",
    interrupted: false,
    awaitingChildren: false,
    attempts: 1,
    createdAt: 1,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    // Nothing on startup mints an approval: the snapshot may already show
    // the requeued task claimed by a fresh run, but no decision is ever owed.
    const snapshot = await handlers.snapshot({ directory })
    assert.equal(Object.values(snapshot.state.approvals).length, 0)
    assert.equal(snapshot.state.subtasks.t.interrupted, false)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return next.state.subtasks.t.state === "replied"
    })
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.subtasks.t.outcome, "succeeded")
    assert.equal(Object.values(after.state.approvals).length, 0)
  } finally {
    await stop()
  }
})

test("approval resolution is idempotent for the same decision", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const memory = await handlers.invoke({
      directory,
      action: "memory.add",
      payload: { agentID: agent.result.id, scope: "project", text: "Use pnpm" },
    })
    const promotion = await handlers.invoke({ directory, action: "memory.promote", payload: { id: memory.result.id } })
    const first = await handlers.invoke({ directory, action: "approval.resolve", payload: { id: promotion.result.id, approve: true } })
    const second = await handlers.invoke({ directory, action: "approval.resolve", payload: { id: promotion.result.id, approve: true } })
    const conflict = await handlers.invoke({ directory, action: "approval.resolve", payload: { id: promotion.result.id, approve: false } })
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(second.result.status, "approved")
    assert.equal(conflict.ok, false)
    assert.equal(conflict.error?.code, "already_resolved")
  } finally {
    await stop()
  }
})

test("reassigning a working subtask ignores the interrupted run's late result", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 200)) }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const nova = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const sage = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Sage" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "site", directory, memberIDs: [nova.result.id, sage.result.id], leaderID: nova.result.id },
    })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Do the work" } })
    const first = await handlers.snapshot({ directory })
    const task = Object.values(first.state.subtasks)[0] as any
    const reassigned = await handlers.invoke({ directory, action: "task.reassign", payload: { id: task.id, assigneeID: sage.result.id } })
    assert.equal(reassigned.ok, true)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return next.state.subtasks[task.id].state === "replied"
    })
    const final = await handlers.snapshot({ directory })
    assert.equal(final.state.subtasks[task.id].assigneeID, sage.result.id)
    const agentMessages = final.state.messages[workspace.result.id].filter((message: any) => message.author === "agent")
    assert.equal(agentMessages.at(-1)?.agentID, sage.result.id)
  } finally {
    await stop()
  }
})

test("approving interrupted work resumes it exactly once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seed.saveAgent({
    id: "a", name: "Nova", title: "", role: "",
    mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [],
    color: "cyan", archived: false, pendingSettings: false, version: 1, updatedAt: 1, createdAt: 1,
  })
  await seed.saveWorkspace({
    id: "w", name: "site", directory, leaderID: "a", memberIDs: ["a"], synthesis: true,
    archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1,
  })
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Interrupted", instruction: "Do work",
    mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: true,
    approvalID: "ap", awaitingChildren: false, attempts: 1, createdAt: 1,
  })
  await seed.saveApproval({
    id: "ap", workspaceID: "w", subtaskID: "t", agentID: "a", kind: "interrupted", source: "workspace",
    title: "Resume interrupted work: Interrupted", detail: "The run stopped before it could reply.",
    payload: { subtaskID: "t" }, status: "pending", createdAt: 1,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const before = await handlers.snapshot({ directory })
    const approval = Object.values(before.state.approvals)[0] as any
    const resumed = await handlers.invoke({ directory, action: "approval.resolve", payload: { id: approval.id, approve: true } })
    assert.equal(resumed.ok, true)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return next.state.subtasks.t.state === "replied"
    })
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.subtasks.t.interrupted, false)
    assert.equal(after.state.subtasks.t.attempts, 2)
  } finally {
    await stop()
  }
})

test("pausing a workspace rejects new work until resumed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id },
    })
    await handlers.invoke({ directory, action: "workspace.pause", payload: { id: workspace.result.id } })
    const paused = await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Do work" } })
    assert.equal(paused.ok, false)
    assert.equal(paused.error?.code, "workspace_paused")
    await handlers.invoke({ directory, action: "workspace.resume", payload: { id: workspace.result.id } })
    const resumed = await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Do work" } })
    assert.equal(resumed.ok, true)
  } finally {
    await stop()
  }
})

test("stable recipient ids route without relying on a display name", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const nova = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const sage = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Sage" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "site", directory, memberIDs: [nova.result.id, sage.result.id], leaderID: nova.result.id },
    })
    const sent = await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Review this", recipientIDs: [sage.result.id] } })
    assert.equal(sent.ok, true)
    const next = await handlers.snapshot({ directory })
    const task = Object.values(next.state.subtasks)[0] as any
    assert.equal(task.assigneeID, sage.result.id)
  } finally {
    await stop()
  }
})

test("unknown actions return a structured error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const response = await handlers.invoke({ directory, action: "nope" })
    assert.equal(response.ok, false)
    assert.equal(response.error?.code, "unknown_action")
  } finally {
    await stop()
  }
})


test("archiving the leader requires and applies a replacement", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const nova = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const sage = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Sage" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "site", directory, memberIDs: [nova.result.id, sage.result.id], leaderID: nova.result.id },
    })
    const refused = await handlers.invoke({ directory, action: "agent.archive", payload: { id: nova.result.id } })
    assert.equal(refused.ok, false)
    assert.equal(refused.error?.code, "leader_replacement_required")
    const archived = await handlers.invoke({ directory, action: "agent.archive", payload: { id: nova.result.id, replacementLeaderID: sage.result.id } })
    assert.equal(archived.ok, true)
    const next = await handlers.snapshot({ directory })
    assert.equal(next.state.workspaces[workspace.result.id].leaderID, sage.result.id)
    assert.deepEqual(next.state.workspaces[workspace.result.id].memberIDs, [sage.result.id])
    assert.equal(next.state.agents[nova.result.id].archived, true)
  } finally {
    await stop()
  }
})

test("deleting a workspace can remove its native sessions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx, removedSessions } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id },
    })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Hello" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.state === "replied")
    })
    const before = await handlers.snapshot({ directory })
    const binding = Object.values(before.state.bindings)[0] as any
    const deleted = await handlers.invoke({ directory, action: "workspace.delete", payload: { id: workspace.result.id, deleteNativeSessions: true } })
    assert.equal(deleted.ok, true)
    assert.ok(removedSessions.includes(binding.sessionID))
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.workspaces[workspace.result.id], undefined)
    assert.equal(after.state.messages[workspace.result.id], undefined)
  } finally {
    await stop()
  }
})

test("maxActiveRuns limits simultaneous work and queues the rest", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 120)) }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id },
    })
    await handlers.invoke({ directory, action: "settings.update", payload: { maxActiveRuns: 1 } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "First" } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Second" } })
    await new Promise((resolve) => setTimeout(resolve, 40))
    const during = await handlers.snapshot({ directory })
    const working = Object.values(during.state.subtasks).filter((task: any) => task.state === "working")
    assert.equal(working.length, 1)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).every((task: any) => task.state === "replied")
    }, 4000)
  } finally {
    await stop()
  }
})

test("v1 agent profiles merge into an existing v2 roster", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx, values } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seed.saveAgent({
    id: "v2", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" },
    backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1,
  })
  values.set("ensemble.state", {
    agents: {
      old: { id: "old", name: "Legacy", instructions: "Old role", mainModel: { providerID: "probe", modelID: "probe-model" } },
      v2: { id: "v2", name: "Duplicate", instructions: "Should not overwrite" },
    },
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const snapshot = await handlers.snapshot({ directory })
    assert.equal(snapshot.state.agents.old.name, "Legacy")
    assert.equal(snapshot.state.agents.v2.name, "Nova")
  } finally {
    await stop()
  }
})

test("edit work in one directory runs one subtask at a time", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 120)) }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const nova = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const sage = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Sage" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "site", directory, memberIDs: [nova.result.id, sage.result.id], leaderID: nova.result.id },
    })
    await handlers.invoke({ directory, action: "task.delegate", payload: { workspaceID: workspace.result.id, assigneeID: nova.result.id, title: "Edit one", instruction: "Edit", mode: "edit" } })
    await handlers.invoke({ directory, action: "task.delegate", payload: { workspaceID: workspace.result.id, assigneeID: sage.result.id, title: "Edit two", instruction: "Edit", mode: "edit" } })
    await new Promise((resolve) => setTimeout(resolve, 40))
    const during = await handlers.snapshot({ directory })
    const working = Object.values(during.state.subtasks).filter((task: any) => task.state === "working")
    assert.equal(working.length, 1)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).every((task: any) => task.state === "replied")
    }, 4000)
  } finally {
    await stop()
  }
})


test("answering a pending question after restart resumes the interrupted task", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seed.saveAgent({
    id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" },
    backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1,
  })
  await seed.saveWorkspace({
    id: "w", name: "site", directory, leaderID: "a", memberIDs: ["a"], synthesis: true,
    archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1,
  })
  await seed.saveApproval({
    id: "ap", workspaceID: "w", subtaskID: "t", agentID: "a", kind: "ask_person",
    title: "Need input", detail: "Which API?", status: "pending", createdAt: 1,
  })
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Question", instruction: "Do work",
    mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: true, approvalID: "ap",
    awaitingChildren: false, attempts: 1, createdAt: 1,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const answered = await handlers.invoke({ directory, action: "approval.resolve", payload: { id: "ap", approve: true, resolution: "Use v2" } })
    assert.equal(answered.ok, true)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return next.state.subtasks.t.state === "replied"
    })
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.subtasks.t.interrupted, false)
    assert.equal(after.state.subtasks.t.attempts, 2)
  } finally {
    await stop()
  }
})

test("resolved stale approvals do not resurrect cancelled work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seed.saveAgent({
    id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" },
    backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1,
  })
  await seed.saveWorkspace({
    id: "w", name: "site", directory, leaderID: "a", memberIDs: ["a"], synthesis: true,
    archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1,
  })
  await seed.saveApproval({
    id: "ap", workspaceID: "w", subtaskID: "t", agentID: "a", kind: "ask_person",
    title: "Need input", detail: "Which API?", status: "pending", createdAt: 1,
  })
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Cancelled", instruction: "Do work",
    mode: "research", state: "replied", stage: "initial", outcome: "failed", interrupted: false,
    awaitingChildren: false, attempts: 1, createdAt: 1, error: "Cancelled by user.",
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const resolved = await handlers.invoke({ directory, action: "approval.resolve", payload: { id: "ap", approve: true, resolution: "Too late" } })
    assert.equal(resolved.ok, true)
    assert.equal(resolved.result.status, "rejected")
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.subtasks.t.state, "replied")
    assert.equal(after.state.subtasks.t.attempts, 1)
  } finally {
    await stop()
  }
})

test("native-session deletion covers sessions replaced by behavior changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx, removedSessions } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id },
    })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "First" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.state === "replied")
    })
    await handlers.invoke({ directory, action: "agent.update", payload: { id: agent.result.id, role: "New role" } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Second" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).filter((task: any) => task.state === "replied").length >= 2
    })
    const before = await handlers.snapshot({ directory })
    const binding = Object.values(before.state.bindings)[0] as any
    const deleted = await handlers.invoke({ directory, action: "workspace.delete", payload: { id: workspace.result.id, deleteNativeSessions: true } })
    assert.equal(deleted.ok, true)
    assert.equal(removedSessions.length, 2)
    assert.ok(removedSessions.includes(binding.sessionID))
    assert.ok(removedSessions.includes(binding.history[0]))
  } finally {
    await stop()
  }
})

test("archiving a workspace interrupts its active native run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx, interruptedSessions } = fakeContext()
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 200)) }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id },
    })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Long work" } })
    await new Promise((resolve) => setTimeout(resolve, 40))
    const archived = await handlers.invoke({ directory, action: "workspace.archive", payload: { id: workspace.result.id } })
    assert.equal(archived.ok, true)
    assert.equal(interruptedSessions.length, 1)
  } finally {
    await stop()
  }
})

test("creating an agent inside a workspace leaves it with no workspace until explicitly added", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const leader = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "site", directory, memberIDs: [leader.result.id], leaderID: leader.result.id },
    })
    const added = await handlers.invoke({
      directory,
      action: "agent.create",
      payload: { name: "Sage", workspaceID: workspace.result.id },
    })
    assert.equal(added.ok, true)
    const next = await handlers.snapshot({ directory })
    assert.deepEqual(next.state.workspaces[workspace.result.id].memberIDs, [leader.result.id])
    const updated = await handlers.invoke({
      directory,
      action: "workspace.update",
      payload: { id: workspace.result.id, memberIDs: [leader.result.id, added.result.id], leaderID: leader.result.id },
    })
    assert.equal(updated.ok, true)
    assert.deepEqual(updated.result.memberIDs, [leader.result.id, added.result.id])
  } finally {
    await stop()
  }
})

test("workspace member edits validate membership and the leader", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const nova = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const sage = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Sage" } })
    const outside = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Echo" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "site", directory, memberIDs: [nova.result.id], leaderID: nova.result.id },
    })
    const updated = await handlers.invoke({
      directory,
      action: "workspace.update",
      payload: { id: workspace.result.id, memberIDs: [nova.result.id, sage.result.id], leaderID: sage.result.id },
    })
    assert.equal(updated.ok, true)
    assert.deepEqual(updated.result.memberIDs, [nova.result.id, sage.result.id])
    assert.equal(updated.result.leaderID, sage.result.id)
    const invalid = await handlers.invoke({
      directory,
      action: "workspace.update",
      payload: { id: workspace.result.id, memberIDs: [nova.result.id], leaderID: outside.result.id },
    })
    assert.equal(invalid.ok, false)
    assert.equal(invalid.error?.code, "invalid_leader")
  } finally {
    await stop()
  }
})

test("agent renames do not bump behavior version but role changes do", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const created = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova", role: "Old" } })
    const renamed = await handlers.invoke({ directory, action: "agent.update", payload: { id: created.result.id, name: "Nova Prime" } })
    assert.equal(renamed.result.version, 1)
    assert.equal(renamed.result.pendingSettings, false)
    const changed = await handlers.invoke({ directory, action: "agent.update", payload: { id: created.result.id, role: "New" } })
    assert.equal(changed.result.version, 2)
    assert.equal(changed.result.pendingSettings, true)
  } finally {
    await stop()
  }
})

test("agent and workspace creation reject invalid input", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const blank = await handlers.invoke({ directory, action: "agent.create", payload: { name: "  " } })
    assert.equal(blank.ok, false)
    assert.equal(blank.error?.code, "invalid_name")
    const badModel = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova", mainModel: { providerID: "nope", modelID: "nope" } } })
    assert.equal(badModel.ok, false)
    assert.equal(badModel.error?.code, "invalid_model")
    const nova = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const sage = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Sage" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [nova.result.id], leaderID: nova.result.id } })
    assert.equal(workspace.ok, true)
    const duplicate = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "again", directory, memberIDs: [nova.result.id], leaderID: nova.result.id } })
    assert.equal(duplicate.ok, false)
    assert.equal(duplicate.error?.code, "workspace_exists")
    const outside = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "bad", directory: mkdtempSync(join(tmpdir(), "ensemble-other-")), memberIDs: [nova.result.id], leaderID: sage.result.id } })
    assert.equal(outside.ok, false)
    assert.equal(outside.error?.code, "invalid_leader")
  } finally {
    await stop()
  }
})

test("memory edit preserves provenance history and updatedAt semantics", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const memory = await handlers.invoke({ directory, action: "memory.add", payload: { agentID: agent.result.id, scope: "project", text: "Use pnpm" } })
    const before = (await handlers.snapshot({ directory })).state.memories[memory.result.id]
    const edited = await handlers.invoke({ directory, action: "memory.update", payload: { id: memory.result.id, text: "Use pnpm 9" } })
    assert.equal(edited.result.text, "Use pnpm 9")
    assert.equal(edited.result.origin, "manual")
    assert.equal(edited.result.scope, "project")
    assert.ok(edited.result.updatedAt >= before.updatedAt)
    assert.deepEqual(edited.result.history.map((entry: any) => entry.action), ["created", "edited"])
    // Empty edits are rejected; the stored fact is untouched.
    const empty = await handlers.invoke({ directory, action: "memory.update", payload: { id: memory.result.id, text: "   " } })
    assert.equal(empty.ok, false)
    const kept = (await handlers.snapshot({ directory })).state.memories[memory.result.id]
    assert.equal(kept.text, "Use pnpm 9")
  } finally {
    await stop()
  }
})

test("memory delete and global-promotion approvals stay gated", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const memory = await handlers.invoke({ directory, action: "memory.add", payload: { agentID: agent.result.id, scope: "project", text: "Keep" } })
    // Promotion creates a pending approval and leaves scope untouched.
    const promotion = await handlers.invoke({ directory, action: "memory.promote", payload: { id: memory.result.id } })
    assert.equal(promotion.ok, true)
    const pending = (await handlers.snapshot({ directory })).state.approvals[promotion.result.id]
    assert.equal(pending.status, "pending")
    assert.equal(pending.kind, "promote_memory")
    assert.equal((await handlers.snapshot({ directory })).state.memories[memory.result.id].scope, "project")
    // Rejecting keeps project scope; approving flips to global.
    await handlers.invoke({ directory, action: "approval.resolve", payload: { id: promotion.result.id, approve: false } })
    assert.equal((await handlers.snapshot({ directory })).state.memories[memory.result.id].scope, "project")
    const second = await handlers.invoke({ directory, action: "memory.promote", payload: { id: memory.result.id } })
    await handlers.invoke({ directory, action: "approval.resolve", payload: { id: second.result.id, approve: true } })
    assert.equal((await handlers.snapshot({ directory })).state.memories[memory.result.id].scope, "global")
    // Delete soft-deletes with history; unknown ids stay not-found.
    const deleted = await handlers.invoke({ directory, action: "memory.delete", payload: { id: memory.result.id } })
    assert.equal(deleted.ok, true)
    const tombstoned = (await handlers.snapshot({ directory })).state.memories[memory.result.id]
    assert.ok(tombstoned.deletedAt)
    assert.ok(tombstoned.history.some((entry: any) => entry.action === "deleted"))
    const missing = await handlers.invoke({ directory, action: "memory.delete", payload: { id: "mem-missing" } })
    assert.equal(missing.ok, false)
  } finally {
    await stop()
  }
})

test("stale promote_memory approvals resolve as rejected without re-applying", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory)
  // Already promoted: a second pending promote decision is moot.
  await seed.saveMemory({ id: "mem-done", agentID: "a", workspaceID: "w", scope: "global", text: "Keep", origin: "manual", source: "user", createdAt: 1, updatedAt: 1, history: [{ at: 1, action: "created", by: "user" }] })
  await seed.saveApproval({ id: "ap-stale", workspaceID: "w", agentID: "a", kind: "promote_memory", title: "Promote", detail: "Keep", payload: { memoryID: "mem-done" }, status: "pending", createdAt: 1 })
  // Deleted memory: there is nothing left to promote.
  await seed.saveApproval({ id: "ap-gone", workspaceID: "w", agentID: "a", kind: "promote_memory", title: "Promote", detail: "Gone", payload: { memoryID: "mem-missing" }, status: "pending", createdAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const stale = await handlers.invoke({ directory, action: "approval.resolve", payload: { id: "ap-stale", approve: true } })
    assert.equal(stale.ok, true)
    assert.equal(stale.result.status, "rejected")
    assert.match(stale.result.resolution, /no longer/)
    const gone = await handlers.invoke({ directory, action: "approval.resolve", payload: { id: "ap-gone", approve: true } })
    assert.equal(gone.ok, true)
    assert.equal(gone.result.status, "rejected")
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.memories["mem-done"].history.length, 1)
  } finally {
    await stop()
  }
})

test("memory entries can be added, edited, promoted, and deleted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const memory = await handlers.invoke({ directory, action: "memory.add", payload: { agentID: agent.result.id, scope: "project", text: "Use pnpm" } })
    assert.equal(memory.result.text, "Use pnpm")
    const edited = await handlers.invoke({ directory, action: "memory.update", payload: { id: memory.result.id, text: "Use pnpm 9" } })
    assert.equal(edited.result.text, "Use pnpm 9")
    const promotion = await handlers.invoke({ directory, action: "memory.promote", payload: { id: memory.result.id } })
    await handlers.invoke({ directory, action: "approval.resolve", payload: { id: promotion.result.id, approve: true } })
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.memories[memory.result.id].scope, "global")
    const deleted = await handlers.invoke({ directory, action: "memory.delete", payload: { id: memory.result.id } })
    assert.equal(deleted.ok, true)
    const final = await handlers.snapshot({ directory })
    assert.ok(final.state.memories[memory.result.id].deletedAt)
  } finally {
    await stop()
  }
})

test("outside-roster approvals create the delegated child once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seed.saveAgent({ id: "b", name: "Echo", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  await seedWorkspace(seed, directory)
  await seed.saveSubtask({ id: "parent", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Parent", instruction: "Parent", mode: "research", state: "working", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false, attempts: 1, createdAt: 1 })
  await seed.saveApproval({ id: "ap", workspaceID: "w", subtaskID: "parent", agentID: "a", kind: "outside_roster", title: "Contact Echo", detail: "Check", payload: { assigneeID: "b", title: "Child", instruction: "Check" }, status: "pending", createdAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const resolved = await handlers.invoke({ directory, action: "approval.resolve", payload: { id: "ap", approve: true } })
    assert.equal(resolved.ok, true)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.title === "Child" && task.state === "replied")
    })
    const again = await handlers.invoke({ directory, action: "approval.resolve", payload: { id: "ap", approve: true } })
    assert.equal(again.ok, true)
    const final = await handlers.snapshot({ directory })
    // The approved hop is created once; the recipient's mandatory completion
    // handoff (ticket #71) is a separate terminal delivery under its own key.
    assert.equal(Object.values(final.state.subtasks).filter((task: any) => task.title === "Child" && task.handoff?.completion !== true).length, 1)
  } finally {
    await stop()
  }
})

test("cross-project approval becomes global memory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory)
  await seed.saveApproval({ id: "ap", workspaceID: "w", agentID: "a", kind: "cross_project", title: "Share", detail: "Shared note", payload: { text: "Shared note" }, status: "pending", createdAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "approval.resolve", payload: { id: "ap", approve: true } })
    const after = await handlers.snapshot({ directory })
    assert.ok(Object.values(after.state.memories).some((memory: any) => memory.scope === "global" && memory.text === "Shared note"))
  } finally {
    await stop()
  }
})

test("discarding interrupted work marks it failed without running", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory)
  await seed.saveSubtask({ id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Interrupted", instruction: "Do", mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: true, approvalID: "ap", awaitingChildren: false, attempts: 1, activeRunID: "run", claimedBy: "run", leaseUntil: Date.now() + 60_000, createdAt: 1 })
  await seed.saveApproval({ id: "ap", workspaceID: "w", subtaskID: "t", agentID: "a", kind: "interrupted", source: "workspace", title: "Resume interrupted work: Interrupted", detail: "The run stopped before it could reply.", payload: { subtaskID: "t" }, status: "pending", createdAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const before = await handlers.snapshot({ directory })
    const approval = Object.values(before.state.approvals)[0] as any
    await handlers.invoke({ directory, action: "approval.resolve", payload: { id: approval.id, approve: false } })
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.subtasks.t.state, "replied")
    assert.equal(after.state.subtasks.t.outcome, "failed")
    assert.equal(after.state.subtasks.t.attempts, 1)
    assert.equal(after.state.subtasks.t.activeRunID, undefined, "discarding interrupted work clears the active run id")
  } finally {
    await stop()
  }
})

test("file references in messages are attached to the task instruction", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  writeFileSync(join(directory, "notes.md"), "hello")
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Read @notes.md" } })
    const after = await handlers.snapshot({ directory })
    const task = Object.values(after.state.subtasks)[0] as any
    assert.match(task.instruction, /Referenced files:\n- notes\.md/)
  } finally {
    await stop()
  }
})

test("paused workspaces reject delegation and depth limits are enforced", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    await handlers.invoke({ directory, action: "settings.update", payload: { dispatchDepth: 1 } })
    const root = await handlers.invoke({ directory, action: "task.delegate", payload: { workspaceID: workspace.result.id, assigneeID: agent.result.id, title: "Root", instruction: "Root" } })
    const child = await handlers.invoke({ directory, action: "task.delegate", payload: { workspaceID: workspace.result.id, parentID: root.result.id, assigneeID: agent.result.id, title: "Child", instruction: "Child" } })
    const grandchild = await handlers.invoke({ directory, action: "task.delegate", payload: { workspaceID: workspace.result.id, parentID: child.result.id, assigneeID: agent.result.id, title: "Grandchild", instruction: "Grandchild" } })
    assert.equal(grandchild.ok, false)
    assert.equal(grandchild.error?.code, "delegation_depth")
    await handlers.invoke({ directory, action: "workspace.pause", payload: { id: workspace.result.id } })
    const paused = await handlers.invoke({ directory, action: "task.delegate", payload: { workspaceID: workspace.result.id, assigneeID: agent.result.id, title: "No", instruction: "No" } })
    assert.equal(paused.ok, false)
    assert.equal(paused.error?.code, "workspace_paused")
  } finally {
    await stop()
  }
})

test("model fallback emits a visible switch message", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  let calls = 0
  ;(ctx.session as any).context = async () => {
    calls++
    if (calls === 1) return { data: [{ type: "idle", outcome: "failed", error: { type: "provider.unavailable", message: "503 unavailable" } }] }
    return { data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "Recovered" }] }] }
  }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova", backupModels: [{ providerID: "probe", modelID: "probe-model" }] } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Try" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.state === "replied")
    })
    const final = await handlers.snapshot({ directory })
    assert.ok(final.state.messages[workspace.result.id].some((message: any) => message.text.startsWith("Model unavailable; switched to")))
  } finally {
    await stop()
  }
})

test("agent tools delegate, ask, remember, and share while a run is active", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx, tools } = fakeContext()
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 300)) }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const nova = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const sage = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Sage" } })
    const echo = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Echo" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "site", directory, memberIDs: [nova.result.id, sage.result.id], leaderID: nova.result.id },
    })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Coordinate" } })
    let sessionID = ""
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const binding = Object.values(next.state.bindings)[0] as any
      if (!binding) return false
      sessionID = binding.sessionID
      return true
    })
    const toolContext = { sessionID }
    const delegated = await tools.get("delegate").execute({ maxHops: 1, assignee: "Sage", title: "Child", instruction: "Check" }, toolContext)
    assert.match(delegated.content, /Delegated to Sage/)
    const outside = await tools.get("delegate").execute({ maxHops: 1, assignee: "Echo", title: "Outside", instruction: "Check" }, toolContext)
    assert.match(outside.content, /Approval required/)
    const asked = await tools.get("ask_person").execute({ question: "Which API?" }, toolContext)
    assert.match(asked.content, /Waiting/)
    const remembered = await tools.get("remember").execute({ text: "Use pnpm", scope: "project" }, toolContext)
    assert.match(remembered.content, /Saved project memory/)
    const shared = await tools.get("share").execute({ text: "Share this", scope: "cross_project" }, toolContext)
    assert.match(shared.content, /authorization/)
    const info = await tools.get("workspace_info").execute({}, toolContext)
    assert.match(info.content, /site/)
    const roster = await tools.get("list_agents").execute({}, toolContext)
    assert.match(roster.content, /Nova/)
    const allWorkspaces = await tools.get("list_workspaces").execute({}, toolContext)
    assert.match(allWorkspaces.content, /workspace/)
    const status = await tools.get("task_status").execute({}, toolContext)
    assert.match(status.content, /working|pending|replied/)
    const posted = await tools.get("send_message").execute({ kind: "workspace", text: "Tool message" }, toolContext)
    assert.match(posted.content, /Posted/)
    const otherDirectory = mkdtempSync(join(tmpdir(), "ensemble-other-"))
    const otherWorkspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "other", directory: otherDirectory, memberIDs: [nova.result.id], leaderID: nova.result.id } })
    const cross = await tools.get("send_message").execute({ kind: "workspace", id: otherWorkspace.result.id, text: "Nope" }, toolContext)
    assert.match(cross.content, /Cross-workspace/)
    mkdirSync(join(directory, ".ensemble", "handoffs"), { recursive: true })
    writeFileSync(join(directory, ".ensemble", "handoffs", "task-nova-sage-1.md"), "---\nensemble: handoff\ntask: task\n---\n# Handoff\n")
    const handoff = await tools.get("handoff").execute({ maxHops: 1, task: "task", summary: "summary", path: ".ensemble/handoffs/task-nova-sage-1.md", to: "Sage" }, toolContext)
    assert.match(handoff.content, /Handed to \$Sage/)
    const snapshot = await handlers.snapshot({ directory })
    assert.ok(Object.values(snapshot.state.memories).some((memory: any) => memory.text === "Use pnpm"))
    const kinds = Object.values(snapshot.state.approvals).map((approval: any) => approval.kind)
    assert.ok(kinds.includes("outside_roster"))
    assert.ok(kinds.includes("ask_person"))
    assert.ok(kinds.includes("cross_project"))
    assert.ok(Object.values(snapshot.state.subtasks).some((task: any) => task.title === "Child"))
    assert.ok(Object.values(snapshot.state.agents).some((agent: any) => agent.id === echo.result.id))
  } finally {
    await stop()
  }
})

test("deleting an agent replaces the leader, cancels work, and removes sessions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx, removedSessions } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const nova = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const sage = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Sage" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [nova.result.id, sage.result.id], leaderID: nova.result.id } })
    await handlers.invoke({ directory, action: "memory.add", payload: { agentID: nova.result.id, scope: "project", text: "Keep" } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Hello" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.state === "replied")
    })
    const before = await handlers.snapshot({ directory })
    const binding = Object.values(before.state.bindings)[0] as any
    const deleted = await handlers.invoke({ directory, action: "agent.delete", payload: { id: nova.result.id, replacementLeaderID: sage.result.id, deleteNativeSessions: true } })
    assert.equal(deleted.ok, true)
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.agents[nova.result.id], undefined)
    assert.equal(after.state.workspaces[workspace.result.id].leaderID, sage.result.id)
    assert.deepEqual(after.state.workspaces[workspace.result.id].memberIDs, [sage.result.id])
    assert.ok(removedSessions.includes(binding.sessionID))
    const memory = Object.values(after.state.memories).find((item: any) => item.text === "Keep") as any
    assert.ok(memory.deletedAt)
  } finally {
    await stop()
  }
})

test("workspace_info refreshes a binding written after startup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx, tools } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const nova = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [nova.result.id], leaderID: nova.result.id } })
    const externalSession = "ses_external_binding"
    await ctx.storage.set(`v2/binding/${workspace.result.id}/${nova.result.id}`, {
      workspaceID: workspace.result.id,
      agentID: nova.result.id,
      sessionID: externalSession,
      kind: "workspace",
      directory,
      agentVersion: 1,
      updatedAt: Date.now(),
    })
    const info = await tools.get("workspace_info").execute({}, { sessionID: externalSession })
    assert.match(info.content, /site/)
    assert.match(info.content, /Nova/)
  } finally {
    await stop()
  }
})

test("session creation failures mark a subtask failed with an explanation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  ;(ctx.session as any).create = async () => ({ data: {} })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Hello" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.state === "replied")
    })
    const after = await handlers.snapshot({ directory })
    const task = Object.values(after.state.subtasks)[0] as any
    assert.equal(task.outcome, "failed")
    assert.match(task.error, /native session/)
    assert.ok(
      !after.state.messages[workspace.result.id].some((message: any) => message.text.includes("Subtask failed")),
      "the terminal task record owns the single failure event; no duplicate generic line",
    )
  } finally {
    await stop()
  }
})

test("disabling synthesis closes a parent task when children reply", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx, tools } = fakeContext()
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 300)) }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const nova = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const sage = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Sage" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [nova.result.id, sage.result.id], leaderID: nova.result.id, synthesis: false } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Coordinate" } })
    let sessionID = ""
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const binding = Object.values(next.state.bindings)[0] as any
      if (!binding) return false
      sessionID = binding.sessionID
      const parent = Object.values(next.state.subtasks).find((task: any) => task.title === "Coordinate") as any
      return parent?.state === "working" && Object.values(next.state.runs).some((run: any) => run.status === "running")
    })
    await tools.get("delegate").execute({ maxHops: 1, assignee: "Sage", title: "Child", instruction: "Check" }, { sessionID })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.messages[workspace.result.id] ?? []).some((message: any) => message.text === "Delegated subtasks completed.")
    }, 3000)
    const after = await handlers.snapshot({ directory })
    assert.ok(after.state.messages[workspace.result.id].some((message: any) => message.text === "Delegated subtasks completed."))
  } finally {
    await stop()
  }
})

test("rejecting a question fails the waiting task", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory)
  await seed.saveApproval({ id: "ap", workspaceID: "w", subtaskID: "t", agentID: "a", kind: "ask_person", title: "Need input", detail: "Which?", status: "pending", createdAt: 1 })
  await seed.saveSubtask({ id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Waiting", instruction: "Do", mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: false, approvalID: "ap", awaitingChildren: false, attempts: 1, createdAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const resolved = await handlers.invoke({ directory, action: "approval.resolve", payload: { id: "ap", approve: false } })
    assert.equal(resolved.ok, true)
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.subtasks.t.state, "replied")
    assert.equal(after.state.subtasks.t.outcome, "failed")
    assert.match(after.state.subtasks.t.error ?? "", /rejected/)
  } finally {
    await stop()
  }
})

test("agent model, backup, and skillbox updates bump behavior version", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const created = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const model = created.result.mainModel
    const updated = await handlers.invoke({
      directory,
      action: "agent.update",
      payload: { id: created.result.id, mainModel: model, backupModels: [model], skillbox: ["alpha"], color: "magenta" },
    })
    assert.equal(updated.ok, true)
    assert.equal(updated.result.version, 2)
    assert.equal(updated.result.pendingSettings, true)
    assert.deepEqual(updated.result.backupModels, [model])
    assert.deepEqual(updated.result.skillbox, ["alpha"])
    assert.equal(updated.result.color, "magenta")
  } finally {
    await stop()
  }
})

test("workspace config is authoritative and can register a workspace on discovery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const nova = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const sage = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Sage" } })
    mkdirSync(join(directory, ".ensemble"), { recursive: true })
    writeFileSync(join(directory, ".ensemble", "config.json"), JSON.stringify({ version: 1, name: "Manual", leader: "Sage", members: ["Nova", "Sage"], synthesis: false, paused: true }))
    let imported: any
    await waitFor(async () => {
      imported = await handlers.snapshot({ directory })
      return (Object.values(imported.state.workspaces)[0] as any)?.name === "Manual"
    }, 10_000)
    const workspace = Object.values(imported.state.workspaces)[0] as any
    assert.equal(workspace.name, "Manual")
    assert.equal(workspace.leaderID, sage.result.id)
    assert.deepEqual(workspace.memberIDs, [nova.result.id, sage.result.id])
    assert.equal(workspace.synthesis, false)
    assert.equal(workspace.paused, true)
    assert.equal(workspace.configVersion, 1)
    writeFileSync(join(directory, ".ensemble", "config.json"), JSON.stringify({ version: 1, name: "Edited", leader: "Nova", members: ["Nova"], synthesis: true, paused: false }))
    let edited: any
    await waitFor(async () => {
      edited = await handlers.snapshot({ directory })
      return (Object.values(edited.state.workspaces)[0] as any)?.name === "Edited"
    }, 10_000)
    const current = Object.values(edited.state.workspaces)[0] as any
    assert.equal(current.name, "Edited")
    assert.deepEqual(current.memberIDs, [nova.result.id])
  } finally {
    await stop()
  }
})

test("ticket159: stale workspace instructions refresh on config reconciliation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const nova = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const sage = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Sage" } })
    await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "site", directory, memberIDs: [nova.result.id, sage.result.id], leaderID: nova.result.id },
    })
    writeFileSync(
      join(directory, "AGENTS.md"),
      "<!-- ensemble:start v3 -->\nSTALE CONTRACT\n<!-- ensemble:end -->\n\n# Project\n\nKeep me.\n",
    )
    writeFileSync(join(directory, ".ensemble", "init.json"), `${JSON.stringify({ version: 3 }, null, 2)}\n`)
    await waitFor(async () => {
      const content = readFileSync(join(directory, "AGENTS.md"), "utf8")
      const metadata = JSON.parse(readFileSync(join(directory, ".ensemble", "init.json"), "utf8"))
      return content.includes(`<!-- ensemble:start v${ENSEMBLE_BLOCK_VERSION} -->`) && metadata.version === ENSEMBLE_BLOCK_VERSION
    }, 10_000)
    const content = readFileSync(join(directory, "AGENTS.md"), "utf8")
    assert.equal((content.match(/<!-- ensemble:start/g) ?? []).length, 1, "one canonical block")
    assert.ok(content.includes("# Project"), "project-owned guidance is preserved")
    assert.ok(!content.includes("STALE CONTRACT"))
  } finally {
    await stop()
  }
})

test("agent names are unique and config names must resolve uniquely", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const first = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const duplicate = await handlers.invoke({ directory, action: "agent.create", payload: { name: "nova" } })
    assert.equal(duplicate.ok, false)
    assert.equal(duplicate.error?.code, "duplicate_name")
    const other = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova Prime" } })
    mkdirSync(join(directory, ".ensemble"), { recursive: true })
    writeFileSync(join(directory, ".ensemble", "config.json"), JSON.stringify({ version: 1, name: "Bad", leader: "Ghost", members: ["Ghost"], synthesis: true }))
    const snapshot = await handlers.snapshot({ directory })
    assert.equal(Object.values(snapshot.state.workspaces).length, 0)
    assert.equal(first.ok, true)
    assert.equal(other.ok, true)
  } finally {
    await stop()
  }
})

test("direct chat creates a home session and queues messages while busy", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-home-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seed.saveAgent({
    id: "a", name: "Nova", title: "", role: "Helpful", mainModel: { providerID: "probe", modelID: "probe-model" },
    backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1,
    homeDirectory: home, createdAt: 1, updatedAt: 1,
  })
  await seedWorkspace(seed, directory)
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 250)) }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const homeChat = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a" } })
    assert.equal(homeChat.ok, true)
    assert.equal(homeChat.result.directory, home)
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: "w", text: "Work" } })
    let sessionID = ""
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const binding = next.state.bindings["w:a"]
      if (!binding) return false
      sessionID = binding.sessionID
      return true
    })
    const queued = await handlers.invoke({ directory, action: "chat.send", payload: { agentID: "a", workspaceID: "w", text: "DM while busy" } })
    assert.equal(queued.result.queued, true)
    const after = await handlers.snapshot({ directory })
    assert.equal(Object.values(after.state.dmQueue).filter((entry: any) => entry.status === "queued").length, 1)
    assert.ok(sessionID)
  } finally {
    await stop()
  }
})

test("group replies stream as one growing message and finalize", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 220)) }
  ;(ctx.session as any).context = async () => ({ data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "Partial reply" }] }] })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Hello" } })
    await new Promise((resolve) => setTimeout(resolve, 80))
    const during = await handlers.snapshot({ directory })
    const streaming = Object.values(during.state.messages[workspace.result.id]).find((message: any) => message.streaming)
    assert.ok(streaming)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.state === "replied")
    }, 3000)
    const final = await handlers.snapshot({ directory })
    const messages = final.state.messages[workspace.result.id]
    assert.equal(messages.filter((message: any) => message.text === "Partial reply").length >= 1, true)
    assert.equal(messages.some((message: any) => message.streaming), false)
  } finally {
    await stop()
  }
})

test("init runs as a visible System Agent job and publishes the full report", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx, commands } = fakeContext()
  ;(ctx.session as any).command = async ({ sessionID, name, text }: any) => {
    commands.push({ sessionID, name, text })
    writeFileSync(join(directory, "AGENTS.md"), "# Repo\n\nExisting.\n")
    return { data: {} }
  }
  ;(ctx.session as any).context = async () => ({
    data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "Native init inspected the repo." }] }],
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    const init = await handlers.invoke({ directory, action: "workspace.init", payload: { id: workspace.result.id, text: "/init" } })
    assert.equal(init.ok, true)
    assert.ok(init.result.jobID)
    assert.ok(init.result.messageID)
    const during = await handlers.snapshot({ directory })
    const messages = during.state.messages[workspace.result.id]
    const audit = messages.find((message: any) => message.author === "user" && message.text === "/init")
    const streaming = messages.find((message: any) => message.id === init.result.messageID)
    assert.ok(audit, "the trigger leaves a visible /init user line")
    assert.ok(streaming)
    assert.equal(streaming.displayAuthor, SYSTEM_AGENT_NAME)
    assert.equal(streaming.author, "agent")
    assert.equal(streaming.streaming, true)
    assert.equal(Object.values(during.state.agents).some((agent: any) => agent.name === SYSTEM_AGENT_NAME), false)
    assert.equal(during.state.initJobs[init.result.jobID].state, "running")
    const command = commands.find((entry) => entry.name === "init")
    assert.ok(command, "native /init runs inside the temporary session")
    const instruction = String(command?.text)
    assert.match(instruction, /ensemble_init/)
    assert.match(instruction, /Inspect the repository/i, "the native init receives the full workspace instructions")
    assert.match(instruction, /build, test, and lint/i)
    assert.match(instruction, /Preserve the project's own guidance/i)
    assert.match(instruction, /replace that block in place/)
    assert.ok(instruction.length > 400, "the command text is more than the short replace note")
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return next.state.initJobs[init.result.jobID]?.state === "succeeded"
    }, 3000)
    const final = await handlers.snapshot({ directory })
    const report = final.state.messages[workspace.result.id].find((message: any) => message.id === init.result.messageID)
    assert.ok(report)
    assert.equal(report.streaming, false)
    assert.equal(report.interrupted, false)
    assert.equal(report.displayAuthor, SYSTEM_AGENT_NAME)
    assert.match(report.text, /Ensemble init complete/)
    assert.match(report.text, /Native init inspected the repo\./)
    const job = final.state.initJobs[init.result.jobID]
    assert.ok(job.sessionID)
    assert.equal(job.sessionID.startsWith("session_"), true)
    assert.equal(commands.filter((entry) => entry.name === "init").length, 1)
    const content = readFileSync(join(directory, "AGENTS.md"), "utf8")
    assert.ok(content.startsWith("<!-- ensemble:start v4 -->"))
    assert.ok(content.includes("# Repo"))
    assert.equal((content.match(/<!-- ensemble:start/g) ?? []).length, 1)
    const metadata = JSON.parse(readFileSync(join(directory, ".ensemble", "init.json"), "utf8"))
    assert.equal(metadata.version, 4)
  } finally {
    await stop()
  }
})

test("init carries the starting, running, writing, reporting phases in order", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  let releaseCreate: (() => void) | undefined
  const createParked = new Promise<void>((resolve) => { releaseCreate = resolve })
  ;(ctx.session as any).create = async ({ title }: any) => {
    await createParked
    return { data: { id: "session_phase", title } }
  }
  let releaseWait: (() => void) | undefined
  const waitParked = new Promise<void>((resolve) => { releaseWait = resolve })
  ;(ctx.session as any).wait = async () => { await waitParked }
  ;(ctx.session as any).context = async () => ({
    data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "Native init inspected the repo." }] }],
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    const init = await handlers.invoke({ directory, action: "workspace.init", payload: { id: workspace.result.id, text: "/init" } })
    assert.equal(init.ok, true)

    const starting = await handlers.snapshot({ directory })
    const startJob = starting.state.initJobs[init.result.jobID]
    assert.equal(startJob.state, "running")
    assert.equal(initJobPhase(startJob), "starting")
    assert.deepEqual(startJob.phases, ["starting"])
    const startMessage = starting.state.messages[workspace.result.id].find((message: any) => message.id === init.result.messageID)
    assert.ok(startMessage)
    assert.equal(startMessage.text, INIT_START_TEXT)
    assert.equal(startMessage.streaming, true)
    assert.equal(String(startMessage.text).includes("%"), false)

    releaseCreate?.()
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return next.state.initJobs[init.result.jobID] ? initJobPhase(next.state.initJobs[init.result.jobID]) === "running" : false
    })
    const running = await handlers.snapshot({ directory })
    const runningJob = running.state.initJobs[init.result.jobID]
    assert.equal(runningJob.state, "running")
    assert.deepEqual(runningJob.phases, ["starting", "running"])
    const runningMessage = running.state.messages[workspace.result.id].find((message: any) => message.id === init.result.messageID)
    assert.ok(runningMessage)
    assert.equal(runningMessage.text, INIT_PROGRESS_TEXT)
    assert.equal(runningMessage.streaming, true)

    releaseWait?.()
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return next.state.initJobs[init.result.jobID]?.state === "succeeded"
    }, 3000)
    const final = await handlers.snapshot({ directory })
    const job = final.state.initJobs[init.result.jobID]
    assert.equal(initJobPhase(job), "reporting")
    assert.deepEqual(job.phases, ["starting", "running", "writing", "reporting"])
    const report = final.state.messages[workspace.result.id].find((message: any) => message.id === init.result.messageID)
    assert.ok(report)
    assert.equal(report.streaming, false)
    assert.match(report.text, /Ensemble init complete/)
  } finally {
    releaseCreate?.()
    releaseWait?.()
    await stop()
  }
})

test("init streams native worker text into the System Agent message before finalizing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx, emitEvent } = fakeContext()
  let release: (() => void) | undefined
  const parked = new Promise<void>((resolve) => { release = resolve })
  ;(ctx.session as any).wait = async () => { await parked }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    const init = await handlers.invoke({ directory, action: "workspace.init", payload: { id: workspace.result.id, text: "/init" } })
    assert.equal(init.ok, true)
    let sessionID = ""
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      sessionID = next.state.initJobs[init.result.jobID]?.sessionID ?? ""
      return Boolean(sessionID)
    })
    emitEvent({ type: "session.text.delta", data: { sessionID, delta: "Streamed init progress" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const message = next.state.messages[workspace.result.id].find((item: any) => item.id === init.result.messageID)
      return message?.streaming === true && String(message.text).includes("Streamed init progress")
    })
    release?.()
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return next.state.initJobs[init.result.jobID]?.state === "succeeded"
    }, 3000)
    const final = await handlers.snapshot({ directory })
    const message = final.state.messages[workspace.result.id].find((item: any) => item.id === init.result.messageID)
    assert.ok(message)
    assert.equal(message.streaming, false)
    assert.match(message.text, /Ensemble init complete/)
  } finally {
    release?.()
    await stop()
  }
})

test("reset removes ensemble state, config, and bound sessions but preserves handoffs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx, removedSessions } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    writeFileSync(join(directory, ".ensemble", "handoffs", "keep.md"), "handoff")
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Hello" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.state === "replied")
    })
    const before = await handlers.snapshot({ directory })
    const binding = Object.values(before.state.bindings)[0] as any
    const wrong = await handlers.invoke({ directory, action: "ensemble.reset", payload: { confirmation: "no" } })
    assert.equal(wrong.ok, false)
    const reset = await handlers.invoke({ directory, action: "ensemble.reset", payload: { confirmation: "RESET", deleteHandoffs: false } })
    assert.equal(reset.ok, true)
    assert.ok(removedSessions.includes(binding.sessionID))
    const after = await handlers.snapshot({ directory })
    assert.deepEqual(Object.keys(after.state.agents), [])
    assert.deepEqual(Object.keys(after.state.workspaces), [])
    assert.equal(existsSync(join(directory, ".ensemble", "config.json")), false)
    assert.equal(existsSync(join(directory, ".ensemble", "handoffs", "keep.md")), true)
  } finally {
    await stop()
  }
})

test("adding an agent can move its no-workspace direct-chat session into a workspace", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-home-"))
  const { ctx, movedSessions } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed, { homeDirectory: home })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const chat = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a" } })
    assert.equal(chat.ok, true)
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: ["a"], leaderID: "a" } })
    const moved = await handlers.invoke({ directory, action: "agent.moveHome", payload: { agentID: "a", workspaceID: workspace.result.id } })
    assert.equal(moved.result.moved, true)
    assert.equal(movedSessions.length, 1)
    assert.equal(movedSessions[0].directory, directory)
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.bindings["home:a"], undefined)
    assert.ok(after.state.bindings[`${workspace.result.id}:a`])
  } finally {
    await stop()
  }
})

test("reset during a streaming run leaves no resurrected transcript", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 400)) }
  ;(ctx.session as any).context = async () => ({ data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "SECRET PARTIAL" }] }] })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Long" } })
    await new Promise((resolve) => setTimeout(resolve, 80))
    const reset = await handlers.invoke({ directory, action: "ensemble.reset", payload: { confirmation: "RESET" } })
    assert.equal(reset.ok, true)
    await new Promise((resolve) => setTimeout(resolve, 600))
    const after = await handlers.snapshot({ directory })
    assert.deepEqual(Object.keys(after.state.messages), [])
    assert.deepEqual(Object.keys(after.state.workspaces), [])
    assert.deepEqual(Object.keys(after.state.agents), [])
  } finally {
    await stop()
  }
})

test("a failed direct prompt releases the busy lock", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-home-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed, { homeDirectory: home })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a" } })
    ;(ctx.session as any).prompt = async () => { throw new Error("session gone") }
    const failed = await handlers.invoke({ directory, action: "chat.send", payload: { agentID: "a", text: "Hello" } })
    assert.equal(failed.ok, false)
    const after = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a" } })
    assert.equal(after.result.busy, false)
  } finally {
    await stop()
  }
})

test("the streaming poller cannot write after reset", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 1200)) }
  ;(ctx.session as any).context = async () => ({ data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "SECRET PARTIAL" }] }] })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Long" } })
    await new Promise((resolve) => setTimeout(resolve, 150))
    const reset = await handlers.invoke({ directory, action: "ensemble.reset", payload: { confirmation: "RESET" } })
    assert.equal(reset.ok, true)
    await new Promise((resolve) => setTimeout(resolve, 1400))
    const after = await handlers.snapshot({ directory })
    assert.deepEqual(Object.keys(after.state.messages), [])
  } finally {
    await stop()
  }
})


test("parallel direct-chat opens create only one no-workspace session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-home-"))
  const { ctx, createdSessionIDs } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed, { homeDirectory: home })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await Promise.all([
      handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a" } }),
      handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a" } }),
      handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a" } }),
    ])
    assert.equal(createdSessionIDs.length, 1)
    const after = await handlers.snapshot({ directory })
    assert.equal(Object.keys(after.state.bindings).length, 1)
  } finally {
    await stop()
  }
})

test("editing an agent cannot resurrect an archived workspace config", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    await handlers.invoke({ directory, action: "workspace.archive", payload: { id: workspace.result.id } })
    assert.equal(existsSync(join(directory, ".ensemble", "config.json")), false)
    await handlers.invoke({ directory, action: "agent.update", payload: { id: agent.result.id, role: "New" } })
    assert.equal(existsSync(join(directory, ".ensemble", "config.json")), false)
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.workspaces[workspace.result.id].archived, true)
  } finally {
    await stop()
  }
})

test("failed init removes AGENTS.md that did not exist and reports the failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  ;(ctx.session as any).wait = async () => { throw new Error("agent failed") }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    const init = await handlers.invoke({ directory, action: "workspace.init", payload: { id: workspace.result.id, text: "/init" } })
    assert.equal(init.ok, true)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return next.state.initJobs[init.result.jobID]?.state === "failed"
    }, 3000)
    const final = await handlers.snapshot({ directory })
    const failedJob = final.state.initJobs[init.result.jobID]
    assert.ok(failedJob.error)
    assert.match(failedJob.error, /agent failed/)
    assert.equal(initJobPhase(failedJob), "reporting")
    assert.deepEqual(failedJob.phases, ["starting", "running", "reporting"])
    assert.equal(existsSync(join(directory, "AGENTS.md")), false)
    const report = final.state.messages[workspace.result.id].find((message: any) => message.id === init.result.messageID)
    assert.ok(report)
    assert.equal(report.streaming, false)
    assert.equal(report.interrupted, true)
    assert.match(report.text, /Ensemble init failed/)
    assert.match(report.text, /removed/)
  } finally {
    await stop()
  }
})

test("init rejects duplicate runs and non-solo or direct requests before appending anything", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx, interruptedSessions } = fakeContext()
  let release: (() => void) | undefined
  const parked = new Promise<void>((resolve) => { release = resolve })
  ;(ctx.session as any).wait = async () => { await parked }
  ;(ctx.session as any).interrupt = async ({ sessionID }: any) => { interruptedSessions.push(sessionID); release?.() }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    const solo = await handlers.invoke({ directory, action: "workspace.init", payload: { id: workspace.result.id, text: "$Nova /init" } })
    assert.equal(solo.ok, false)
    assert.equal(solo.error?.code, "init_solo")
    const mixed = await handlers.invoke({ directory, action: "workspace.init", payload: { id: workspace.result.id, text: "/init /plan" } })
    assert.equal(mixed.ok, false)
    assert.equal(mixed.error?.code, "init_solo")
    const colonMention = await handlers.invoke({ directory, action: "workspace.init", payload: { id: workspace.result.id, text: ":init $Nova" } })
    assert.equal(colonMention.ok, false)
    assert.equal(colonMention.error?.code, "init_solo")
    assert.match(colonMention.error?.message ?? "", /mention/i)
    const direct = await handlers.invoke({ directory, action: "workspace.init", payload: { id: workspace.result.id, text: "/init", direct: true } })
    assert.equal(direct.ok, false)
    assert.equal(direct.error?.code, "init_workspace_only")
    const before = await handlers.snapshot({ directory })
    assert.equal(Object.keys(before.state.initJobs).length, 0)
    assert.equal((before.state.messages[workspace.result.id] ?? []).length, 0)
    const init = await handlers.invoke({ directory, action: "workspace.init", payload: { id: workspace.result.id, text: "/init" } })
    assert.equal(init.ok, true)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Boolean(next.state.initJobs[init.result.jobID]?.sessionID)
    })
    const duplicate = await handlers.invoke({ directory, action: "workspace.init", payload: { id: workspace.result.id, text: "/init" } })
    assert.equal(duplicate.ok, false)
    assert.equal(duplicate.error?.code, "init_running")
    const during = await handlers.snapshot({ directory })
    assert.equal((during.state.messages[workspace.result.id] ?? []).filter((message: any) => message.author === "user" && message.text === "/init").length, 1)
  } finally {
    release?.()
    await stop()
  }
})

test("service restart marks a running init interrupted, restores AGENTS.md, and tells the user to rerun", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const previous = "# Before restart\n"
  writeFileSync(join(directory, "AGENTS.md"), previous)
  const { ctx, removedSessions } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory)
  await seed.saveMessage({ id: "m", workspaceID: "w", seq: 1, author: "agent", displayAuthor: SYSTEM_AGENT_NAME, text: "Initializing workspace…", kind: "text", streaming: true, createdAt: 1, updatedAt: 1 })
  await seed.saveMessage({ id: "other", workspaceID: "w", seq: 2, author: "agent", displayAuthor: SYSTEM_AGENT_NAME, text: INIT_START_TEXT, kind: "text", createdAt: 2 })
  await seed.saveInitJob({ id: "init_1", workspaceID: "w", messageID: "m", sessionID: "old_session", state: "running", phases: ["starting", "running"], previousAgentsMD: previous, startedAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.initJobs.init_1.state, "interrupted")
    assert.ok(after.state.initJobs.init_1.error)
    assert.match(after.state.initJobs.init_1.error, /restart/i)
    assert.equal(initJobPhase(after.state.initJobs.init_1), "reporting")
    assert.deepEqual(after.state.initJobs.init_1.phases, ["starting", "running", "reporting"])
    const message = after.state.messages.w.find((item: any) => item.id === "m")
    assert.ok(message)
    assert.equal(message.streaming, false)
    assert.equal(message.interrupted, true)
    assert.match(message.text, /restart/i)
    assert.match(message.text, /rerun/i)
    assert.match(message.text, /restored/i)
    const unrelated = after.state.messages.w.find((item: any) => item.id === "other")
    assert.ok(unrelated)
    assert.equal(unrelated.interrupted, undefined, "reconciliation only settles the running init job's row")
    assert.equal(unrelated.text, INIT_START_TEXT)
    assert.equal(readFileSync(join(directory, "AGENTS.md"), "utf8"), previous)
    assert.ok(removedSessions.includes("old_session"))
  } finally {
    await stop()
  }
})

test("workspace archive cancels an active init, restores AGENTS.md, and removes its temporary session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const previous = "# Archive rollback\n"
  writeFileSync(join(directory, "AGENTS.md"), previous)
  const { ctx, removedSessions, interruptedSessions } = fakeContext()
  let release: (() => void) | undefined
  const parked = new Promise<void>((resolve) => { release = resolve })
  ;(ctx.session as any).wait = async () => { await parked }
  ;(ctx.session as any).interrupt = async ({ sessionID }: any) => { interruptedSessions.push(sessionID); release?.() }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    const init = await handlers.invoke({ directory, action: "workspace.init", payload: { id: workspace.result.id, text: "/init" } })
    let sessionID = ""
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      sessionID = next.state.initJobs[init.result.jobID]?.sessionID ?? ""
      return Boolean(sessionID)
    })
    const archived = await handlers.invoke({ directory, action: "workspace.archive", payload: { id: workspace.result.id } })
    assert.equal(archived.ok, true)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return next.state.initJobs[init.result.jobID]?.state === "cancelled"
    }, 3000)
    const after = await handlers.snapshot({ directory })
    const job = after.state.initJobs[init.result.jobID]
    assert.equal(job.state, "cancelled")
    assert.ok(job.error)
    assert.match(job.error, /archiv/i)
    assert.equal(initJobPhase(job), "reporting")
    assert.deepEqual(job.phases, ["starting", "running", "reporting"])
    const message = after.state.messages[workspace.result.id].find((item: any) => item.id === init.result.messageID)
    assert.ok(message)
    assert.equal(message.streaming, false)
    assert.equal(message.interrupted, true)
    assert.match(message.text, /cancelled/i)
    assert.equal(readFileSync(join(directory, "AGENTS.md"), "utf8"), previous)
    assert.ok(interruptedSessions.includes(sessionID))
    assert.ok(removedSessions.includes(sessionID))
  } finally {
    release?.()
    await stop()
  }
})

test("workspace delete and reset cancel active init jobs and remove their temporary sessions", async () => {
  for (const action of ["workspace.delete", "ensemble.reset"] as const) {
    const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
    const previous = `# ${action} rollback\n`
    writeFileSync(join(directory, "AGENTS.md"), previous)
    const { ctx, removedSessions, interruptedSessions } = fakeContext()
    let release: (() => void) | undefined
    const parked = new Promise<void>((resolve) => { release = resolve })
    ;(ctx.session as any).wait = async () => { await parked }
    ;(ctx.session as any).interrupt = async ({ sessionID }: any) => { interruptedSessions.push(sessionID); release?.() }
    const service = new EnsembleV2Service(ctx)
    const stop = await startServiceForTest(service, service.ctx)
    const handlers = service.handlers()
    try {
      const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
      const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
      const init = await handlers.invoke({ directory, action: "workspace.init", payload: { id: workspace.result.id, text: "/init" } })
      let sessionID = ""
      await waitFor(async () => {
        const next = await handlers.snapshot({ directory })
        sessionID = next.state.initJobs[init.result.jobID]?.sessionID ?? ""
        return Boolean(sessionID)
      })
      const result = action === "workspace.delete"
        ? await handlers.invoke({ directory, action, payload: { id: workspace.result.id } })
        : await handlers.invoke({ directory, action, payload: { confirmation: "RESET" } })
      assert.equal(result.ok, true)
      await waitFor(() => Promise.resolve(removedSessions.includes(sessionID)), 3000)
      assert.ok(interruptedSessions.includes(sessionID))
      assert.equal(readFileSync(join(directory, "AGENTS.md"), "utf8"), previous)
      const after = await handlers.snapshot({ directory })
      assert.equal(after.state.initJobs[init.result.jobID], undefined)
    } finally {
      release?.()
      await stop()
    }
  }
})

test("failed init restores the previous AGENTS.md content", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const previous = "# Project rules\n\nKeep this line.\n"
  writeFileSync(join(directory, "AGENTS.md"), previous)
  const { ctx } = fakeContext()
  ;(ctx.session as any).command = async () => {
    writeFileSync(join(directory, "AGENTS.md"), "<!-- ensemble:start v2 -->\npartial\n<!-- ensemble:end -->\n")
    return { data: {} }
  }
  ;(ctx.session as any).wait = async () => { throw new Error("native init failed") }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    const init = await handlers.invoke({ directory, action: "workspace.init", payload: { id: workspace.result.id, text: "/init" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return next.state.initJobs[init.result.jobID]?.state === "failed"
    }, 3000)
    assert.equal(readFileSync(join(directory, "AGENTS.md"), "utf8"), previous)
    const final = await handlers.snapshot({ directory })
    const report = final.state.messages[workspace.result.id].find((message: any) => message.id === init.result.messageID)
    assert.ok(report)
    assert.match(report.text, /restored/)
  } finally {
    await stop()
  }
})


test("streaming deltas accumulate into the live reply and reconcile with the final answer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-stream-"))
  const { ctx, emitEvent } = fakeContext()
  ctx.session.wait = async () => { await new Promise((resolve) => setTimeout(resolve, 300)) }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  await new Promise((resolve) => setTimeout(resolve, 20))
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "stream", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    const workspaceID = workspace.result.id
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID, text: "Hello team" } })
    let sessionID = ""
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const run = Object.values(next.state.runs).find((item: any) => item.status === "running") as any
      sessionID = run?.sessionID ?? ""
      return Boolean(sessionID)
    })
    emitEvent({ type: "session.text.delta", data: { sessionID, delta: "Working" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.messages[workspaceID] ?? []).some((message: any) => message.streaming && message.text === "Working")
    })
    emitEvent({ type: "session.text.delta", data: { sessionID, delta: " on it" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.messages[workspaceID] ?? []).some((message: any) => message.streaming && message.text === "Working on it")
    })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.state === "replied")
    })
    const final = await handlers.snapshot({ directory })
    const reply = (final.state.messages[workspaceID] ?? []).at(-1) as any
    assert.equal(reply.text, "OK")
    assert.equal(reply.streaming, false)
    assert.equal(reply.interrupted, false)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})


test("workspace streams coalesce ephemeral text and durable message patches finalize exactly once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-stream-patches-"))
  const { ctx, emitEvent, values } = fakeContext()
  ctx.session.wait = async () => { await new Promise((resolve) => setTimeout(resolve, 650)) }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const emitted: Array<{ name: string; data: any }> = []
  service.attach({ events: { emit: async (name: string, data: any) => { emitted.push({ name, data }) } } })
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "stream", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    const workspaceID = workspace.result.id
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID, text: "Hello team" } })

    let sessionID = ""
    let liveID = ""
    let liveSeq = 1
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const run = Object.values(next.state.runs).find((item: any) => item.status === "running") as any
      sessionID = run?.sessionID ?? ""
      const live = (next.state.messages[workspaceID] ?? []).find((message: any) => message.streaming)
      liveID = live?.id ?? ""
      liveSeq = live?.seq ?? 1
      return Boolean(sessionID && liveID)
    })
    const before = await handlers.revision({ directory })

    // A burst of native deltas becomes one coalesced ephemeral update, not one
    // event per chunk and never a coordination-version change.
    emitEvent({ type: "session.text.delta", data: { sessionID, delta: "Working" } })
    emitEvent({ type: "session.text.delta", data: { sessionID, delta: " on" } })
    emitEvent({ type: "session.text.delta", data: { sessionID, delta: " it" } })

    await waitFor(async () => Promise.resolve(emitted.some((event) => event.name === "stream" && event.data.id === liveID && event.data.text === "Working on it")))
    const streamEvents = emitted.filter((event) => event.name === "stream" && event.data.id === liveID)
    assert.equal(streamEvents.length, 1, "a synchronous delta burst coalesces into one stream event")
    assert.equal(streamEvents[0]!.data.workspaceID, workspaceID)
    assert.equal(streamEvents[0]!.data.epoch, before.epoch)
    assert.equal(streamEvents[0]!.data.updatedAt >= 1, true)

    const key = `v2/message/${workspaceID}/${String(liveSeq).padStart(8, "0")}`
    await waitFor(async () => Promise.resolve((values.get(key) as any)?.text === "Working on it" && (values.get(key) as any)?.streaming === true), 3000)
    const afterCheckpoint = await handlers.revision({ directory })
    assert.equal(afterCheckpoint.version, before.version, "live-text checkpoints never bump the coordination version")

    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.state === "replied")
    }, 4000)
    const finalPatches = emitted
      .filter((event) => event.name === "patches")
      .flatMap((event) => event.data.entries ?? [])
      .flatMap((entry: any) => entry.entities ?? entry.changes ?? [])
      .filter((change: any) => change.entity === "message" && change.op === "upsert" && change.message.id === liveID)
    const final = finalPatches.at(-1)
    assert.ok(final, "the final text arrives as a durable message upsert")
    assert.equal(final!.message.text, "OK")
    assert.equal(final!.message.streaming, false)
    assert.equal(finalPatches.filter((change: any) => change.message.text === "OK" && !change.message.streaming).length, 1, "the final text replaces the live row exactly once")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("user and system messages publish durable upserts without a snapshot fallback", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-message-patches-"))
  const { ctx } = fakeContext()
  let calls = 0
  ;(ctx.session as any).context = async () => {
    calls++
    if (calls === 1) return { data: [{ type: "idle", outcome: "failed", error: { type: "provider.unavailable", message: "503 unavailable" } }] }
    return { data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "Recovered" }] }] }
  }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const emitted: Array<{ name: string; data: any }> = []
  service.attach({ events: { emit: async (name: string, data: any) => { emitted.push({ name, data }) } } })
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova", backupModels: [{ providerID: "probe", modelID: "probe-model" }] } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "patches", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Try" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.state === "replied")
    })

    const entries = emitted
      .filter((event) => event.name === "patches")
      .flatMap((event) => event.data.entries ?? [])
      .filter((entry: any) => (entry.entities ?? entry.changes ?? []).some((change: any) => change.entity === "message"))
    assert.ok(entries.some((entry: any) => (entry.entities ?? []).some((change: any) => change.entity === "message" && change.op === "upsert" && change.message.author === "user" && change.message.text === "Try")))
    assert.ok(entries.some((entry: any) => (entry.entities ?? []).some((change: any) => change.entity === "message" && change.op === "upsert" && change.message.kind === "system" && change.message.text.startsWith("Model unavailable; switched to"))))
    for (const entry of entries) {
      assert.equal(entry.nonEntity, undefined, `message ${entry.version} applies from patches without a snapshot`)
    }
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})


test("the shared registry keeps one service and one store across locations", async () => {
  const values = new Map<string, unknown>()
  const first = fakeContext(values)
  const second = fakeContext(values)
  const shared = new SharedEnsemble()
  const one = await shared.acquire(first.ctx)
  const two = await shared.acquire(second.ctx)
  try {
    assert.equal(one.service, two.service)
    const directory = mkdtempSync(join(tmpdir(), "ensemble-shared-"))
    const created = await one.service.handlers().invoke({ directory, action: "agent.create", payload: { name: "Jessy" } })
    assert.equal(created.ok, true)
    const seen = await two.service.handlers().snapshot({ directory })
    assert.ok(seen.state.agents[created.result.id])
  } finally {
    await one.release()
    await two.release()
  }
})

test("config discovery restores a member missing from a stale workspace row", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-jessy-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const clark = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Clark" } })
    const angkasa = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Angkasa" } })
    const jessy = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Jessy" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "Vera", directory, memberIDs: [clark.result.id, angkasa.result.id], leaderID: clark.result.id } })
    writeFileSync(join(directory, ".ensemble", "config.json"), JSON.stringify({
      version: 1,
      id: workspace.result.id,
      name: "Vera",
      leader: "Clark",
      members: ["Clark", "Angkasa", "Jessy"],
      synthesis: true,
      paused: false,
    }))
    let restored: any
    await waitFor(async () => {
      const fresh = await handlers.snapshot({ directory })
      restored = fresh.state.workspaces[workspace.result.id]
      return Boolean(restored?.memberIDs?.includes(jessy.result.id))
    }, 10_000)
    const final = await handlers.snapshot({ directory })
    restored = final.state.workspaces[workspace.result.id]
    assert.ok(restored.memberIDs.includes(jessy.result.id))
    assert.deepEqual(restored.memberIDs, [clark.result.id, angkasa.result.id, jessy.result.id])
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})


test("separate service instances converge over shared storage", async () => {
  const values = new Map<string, unknown>()
  const directory = mkdtempSync(join(tmpdir(), "ensemble-converge-"))
  const first = fakeContext(values)
  const second = fakeContext(values)
  const a = new EnsembleV2Service(first.ctx)
  const b = new EnsembleV2Service(second.ctx)
  const stopA = await a.start()
  const stopB = await b.start()
  try {
    const clark = await a.handlers().invoke({ directory, action: "agent.create", payload: { name: "Clark" } })
    const angkasa = await a.handlers().invoke({ directory, action: "agent.create", payload: { name: "Angkasa" } })
    const jessy = await a.handlers().invoke({ directory, action: "agent.create", payload: { name: "Jessy" } })
    const workspace = await a.handlers().invoke({ directory, action: "workspace.create", payload: { name: "Vera", directory, memberIDs: [clark.result.id, angkasa.result.id], leaderID: clark.result.id } })
    await a.handlers().invoke({ directory, action: "workspace.update", payload: { id: workspace.result.id, memberIDs: [clark.result.id, angkasa.result.id, jessy.result.id], leaderID: clark.result.id } })
    const seen = await b.handlers().snapshot({ directory })
    assert.deepEqual(seen.state.workspaces[workspace.result.id].memberIDs, [clark.result.id, angkasa.result.id, jessy.result.id])
    await b.handlers().invoke({ directory, action: "workspace.activate", payload: { id: workspace.result.id } })
    const again = await a.handlers().snapshot({ directory })
    assert.deepEqual(again.state.workspaces[workspace.result.id].memberIDs, [clark.result.id, angkasa.result.id, jessy.result.id])
  } finally {
    await stopA()
    await stopB()
    rmSync(directory, { recursive: true, force: true })
  }
})


test("agent replies normalize @KnownAgent and add a no-dispatch warning", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-mention-"))
  const { ctx } = fakeContext()
  ;(ctx.session as any).context = async () => ({ data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "@Jessy please introduce yourself." }] }] })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const clark = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Clark" } })
    const jessy = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Jessy" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "Vera", directory, memberIDs: [clark.result.id, jessy.result.id], leaderID: clark.result.id } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Coordinate" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.state === "replied")
    })
    const next = await handlers.snapshot({ directory })
    const messages = next.state.messages[workspace.result.id]
    assert.ok(messages.some((message: any) => message.author === "agent" && message.text === "$Jessy please introduce yourself."))
    assert.ok(messages.some((message: any) => message.author === "system" && message.text.includes("Chat mentions do not assign work")))
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("rpc boundary rejects snapshot input without a directory", async () => {  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await assert.rejects(handlers.snapshot({}), (error: { code?: string }) => error.code === "invalid_input")
    await assert.rejects(handlers.snapshot({ directory: 42 }), (error: { code?: string }) => error.code === "invalid_input")
  } finally {
    await stop()
  }
})

test("rpc boundary rejects invoke input without an action or with a malformed payload", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-rpc-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const missingAction = await handlers.invoke({ directory })
    assert.equal(missingAction.ok, false)
    assert.equal(missingAction.error?.code, "invalid_input")
    const malformedPayload = await handlers.invoke({ directory, action: "agent.create", payload: "Nova" })
    assert.equal(malformedPayload.ok, false)
    assert.equal(malformedPayload.error?.code, "invalid_input")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("agent skillbox updates reject non-list values without clearing the skillbox", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-skillbox-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const created = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const updated = await handlers.invoke({ directory, action: "agent.update", payload: { id: created.result.id, skillbox: "alpha" } })
    assert.equal(updated.ok, false)
    assert.equal(updated.error?.code, "invalid_input")
    const next = await handlers.snapshot({ directory })
    assert.deepEqual(next.state.agents[created.result.id].skillbox, [])
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("workspace member updates reject non-list values without changing membership", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-members-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    const updated = await handlers.invoke({ directory, action: "workspace.update", payload: { id: workspace.result.id, memberIDs: "not-a-list" } })
    assert.equal(updated.ok, false)
    assert.equal(updated.error?.code, "invalid_input")
    const next = await handlers.snapshot({ directory })
    assert.deepEqual(next.state.workspaces[workspace.result.id].memberIDs, [agent.result.id])
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("snapshot explains an empty or failed model catalog without leaking credentials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-models-error-"))
  try {
    const { ctx } = fakeContext()
    ctx.model.list = async () => []
    const emptyService = new EnsembleV2Service(ctx)
    const emptyStop = await emptyService.start()
    try {
      const handlers = emptyService.handlers()
      await waitFor(async () => Boolean((await handlers.snapshot({ directory })).modelsError))
      const snapshot = await handlers.snapshot({ directory })
      assert.deepEqual(snapshot.models, [])
      assert.ok(snapshot.modelsError)
      assert.match(snapshot.modelsError!, /no models/i)
    } finally {
      await emptyStop()
    }

    const failing = fakeContext()
    failing.ctx.model.list = async () => { throw new Error("unauthorized password=hunter2 Authorization: Bearer sk-live-ABC123456") }
    const failingService = new EnsembleV2Service(failing.ctx)
    const failingStop = await failingService.start()
    try {
      const handlers = failingService.handlers()
      await waitFor(async () => Boolean((await handlers.snapshot({ directory })).modelsError))
      const snapshot = await handlers.snapshot({ directory })
      assert.ok(snapshot.modelsError)
      assert.match(snapshot.modelsError!, /model list failed/i)
      assert.equal(snapshot.modelsError!.includes("hunter2"), false)
      assert.equal(snapshot.modelsError!.includes("sk-live-ABC123456"), false)
      assert.equal(snapshot.modelsError!.includes("Bearer sk-live"), false)
    } finally {
      await failingStop()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("revision reports the coordinated version and catalog metadata without a store bump", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-revision-catalog-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => (await handlers.snapshot({ directory })).models.length > 0)
    const before = await handlers.revision({ directory })
    const snapshot = await handlers.snapshot({ directory })
    assert.equal(before.version, snapshot.state.version)
    assert.equal(before.catalogRevision, snapshot.catalogRevision)
    assert.equal(before.configRevision, snapshot.configRevision)
    assert.equal(before.protocol, snapshot.protocol)
    assert.equal(before.epoch, snapshot.epoch)

    ctx.skill.list = async () => [{ id: "review", name: "Review", description: "Review changes" }]
    await (service as any).catalog.refresh()
    const after = await handlers.revision({ directory })

    assert.equal(after.version, before.version, "a catalog revision does not bump the coordination version")
    assert.ok(after.catalogRevision > before.catalogRevision)
    const refreshed = await handlers.snapshot({ directory })
    assert.equal(refreshed.state.version, before.version)
    assert.equal(refreshed.catalogRevision, after.catalogRevision)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("revision notices workspace config changes without hydrating the full store", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-revision-config-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const created = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    const workspaceID = created.result.id
    const before = await handlers.revision({ directory })

    const path = join(directory, ".ensemble", "config.json")
    const config = JSON.parse(readFileSync(path, "utf8"))
    config.name = "renamed site"
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)

    const after = await handlers.revision({ directory })
    assert.equal(after.version, before.version, "the revision check does not discover or persist the config")
    assert.notEqual(after.configRevision, before.configRevision)

    let snapshot: any
    await waitFor(async () => {
      snapshot = await handlers.snapshot({ directory })
      return snapshot.state.workspaces[workspaceID]?.name === "renamed site"
    }, 10_000)
    assert.ok(snapshot.state.version > before.version, "maintenance discovery applies the config change")
    assert.equal(snapshot.configRevision, after.configRevision)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("direct chat context does not rewrite identity metadata on every poll", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-dm-identity-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-dm-identity-home-"))
  const { ctx, instructions, createdSessionIDs } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seed.saveAgent({
    id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" },
    backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1,
    homeDirectory: home, createdAt: 1, updatedAt: 1,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    for (let poll = 0; poll < 3; poll++) await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a" } })
    assert.equal(createdSessionIDs.length, 1)
    assert.equal(instructions.filter((entry) => entry.key === "ensemble.v2.identity").length, 1)

    await handlers.invoke({ directory, action: "agent.update", payload: { id: "a", role: "Updated role" } })
    for (let poll = 0; poll < 2; poll++) await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a" } })
    assert.equal(createdSessionIDs.length, 1, "a behavioral edit does not fork the direct session")
    assert.equal(instructions.filter((entry) => entry.key === "ensemble.v2.identity").length, 2, "the new identity is written once")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("a direct message is stored durably and renders exactly once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-dm-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const sent = await handlers.invoke({ directory, action: "chat.send", payload: { agentID: agent.result.id, text: "Hello DM" } })
    assert.equal(sent.ok, true)
    assert.equal(sent.result.queued, false)
    const context = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: agent.result.id } })
    const userLines = (context.result.messages as any[]).filter((message) => message.role === "user")
    assert.equal(userLines.length, 1)
    assert.equal(userLines[0].text, "Hello DM")
    assert.equal(userLines[0].author, "You")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a direct message survives restart via the load path and never duplicates", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-dm-"))
  const values = new Map<string, unknown>()
  const first = fakeContext(values)
  const service = new EnsembleV2Service(first.ctx)
  const stop = await startServiceForTest(service, service.ctx)
  let agentID = ""
  try {
    const agent = await service.handlers().invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    agentID = agent.result.id
    await service.handlers().invoke({ directory, action: "chat.send", payload: { agentID, text: "Persist me" } })
  } finally {
    await stop()
  }
  const second = fakeContext(values)
  ;(second.ctx.session as any).context = async () => ({
    data: [
      { type: "user", time: { created: Date.now() }, content: [{ type: "text", text: "Persist me" }] },
      { type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "OK" }] },
    ],
  })
  const restarted = new EnsembleV2Service(second.ctx)
  const stopRestarted = await restarted.start()
  try {
    const context = await restarted.handlers().invoke({ directory, action: "chat.context", payload: { agentID } })
    assert.equal(context.ok, true)
    const texts = (context.result.messages as any[]).map((message) => message.text)
    assert.deepEqual(texts, ["Persist me", "OK"])
  } finally {
    await stopRestarted()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a new direct message after restart orders after stored lines even when the wall clock lags", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-dm-"))
  const values = new Map<string, unknown>()
  const first = fakeContext(values)
  const service = new EnsembleV2Service(first.ctx)
  const stop = await startServiceForTest(service, service.ctx)
  let agentID = ""
  try {
    const agent = await service.handlers().invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    agentID = agent.result.id
    await service.handlers().invoke({ directory, action: "chat.send", payload: { agentID, text: "First" } })
  } finally {
    await stop()
  }
  // Simulate a restart where the stored transcript carries a timestamp ahead
  // of the wall clock (e.g. previous clock skew or a future-dated seed).
  const future = Date.now() + 60_000
  for (const [key, value] of [...values.entries()]) {
    if (key.startsWith("v2/dm/") && value && typeof value === "object") {
      values.set(key, { ...(value as Record<string, unknown>), createdAt: future })
    }
  }
  const second = fakeContext(values)
  const restarted = new EnsembleV2Service(second.ctx)
  const stopRestarted = await restarted.start()
  try {
    const sent = await restarted.handlers().invoke({ directory, action: "chat.send", payload: { agentID, text: "Second" } })
    assert.equal(sent.ok, true)
    const context = await restarted.handlers().invoke({ directory, action: "chat.context", payload: { agentID } })
    assert.equal(context.ok, true)
    const lines = (context.result.messages as any[]).filter((message) => message.role === "user")
    assert.deepEqual(lines.map((message) => message.text), ["First", "Second"])
    assert.ok(lines[1].createdAt > lines[0].createdAt)
    assert.ok(lines[1].createdAt > future)
  } finally {
    await stopRestarted()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a queued direct message stays visible as queued, then sent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-dm-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-home-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seed.saveAgent({
    id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" },
    backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1,
    homeDirectory: home, createdAt: 1, updatedAt: 1,
  })
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 250)) }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const first = await handlers.invoke({ directory, action: "chat.send", payload: { agentID: "a", text: "First" } })
    assert.equal(first.result.queued, false)
    const queued = await handlers.invoke({ directory, action: "chat.send", payload: { agentID: "a", text: "While busy" } })
    assert.equal(queued.result.queued, true)
    const during = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a" } })
    const lines = (during.result.messages as any[]).filter((message) => message.role === "user")
    assert.deepEqual(lines.map((message) => message.text), ["First", "While busy"])
    assert.equal(lines[1].queued, true)
    await waitFor(async () => {
      const next = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a" } })
      const items = (next.result.messages as any[]).filter((message) => message.role === "user")
      return items.length === 2 && items.every((message) => message.queued !== true)
    }, 4000)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("a sent direct message ignores a stale persisted queued flag", async () => {
  // Ticket #77 root cause of permanently-grey sent lines: chatContext used to
  // OR the stored line's own `queued` bit, so a line flushed after the fact
  // stayed queued forever. The queue entry is the single source of truth.
  const directory = mkdtempSync(join(tmpdir(), "ensemble-dm-stale-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-home-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seed.saveAgent({
    id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" },
    backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1,
    homeDirectory: home, createdAt: 1, updatedAt: 1,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const sent = await handlers.invoke({ directory, action: "chat.send", payload: { agentID: "a", text: "Sent already" } })
    assert.ok(sent.ok)
    const store = (service as any).store as V2Store
    const stored = store.snapshot().dmTranscripts[bindingKey("home", "a")].find((message) => message.id === sent.result.id)
    assert.ok(stored)
    await store.saveDmMessage("home", "a", { ...stored!, queued: true })
    const context = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a" } })
    const line = (context.result.messages as any[]).find((message) => message.id === sent.result.id)
    assert.equal(line.queued, false)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("a queued direct message can be removed by key before it sends", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-dm-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-home-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seed.saveAgent({
    id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" },
    backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1,
    homeDirectory: home, createdAt: 1, updatedAt: 1,
  })
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 250)) }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const first = await handlers.invoke({ directory, action: "chat.send", payload: { agentID: "a", text: "First" } })
    assert.equal(first.result.queued, false)
    const queued = await handlers.invoke({ directory, action: "chat.send", payload: { agentID: "a", text: "While busy" } })
    assert.equal(queued.result.queued, true)
    const removed = await handlers.invoke({ directory, action: "chat.removeQueued", payload: { agentID: "a", id: queued.result.id } })
    assert.equal(removed.ok, true)
    assert.equal(removed.result.removed, 1)
    const after = await handlers.snapshot({ directory })
    assert.equal(Object.values(after.state.dmQueue).filter((entry: any) => entry.status === "queued").length, 0)
    const context = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a" } })
    const lines = (context.result.messages as any[]).filter((message) => message.role === "user")
    assert.deepEqual(lines.map((message) => message.text), ["First"])
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("unmentioned group messages create work only for the workspace leader", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-route-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const nova = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const sage = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Sage" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "site", directory, memberIDs: [nova.result.id, sage.result.id], leaderID: nova.result.id },
    })
    const sent = await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Do the thing" } })
    assert.equal(sent.ok, true)
    assert.deepEqual(sent.result.recipients, [nova.result.id])
    const next = await handlers.snapshot({ directory })
    const tasks = Object.values(next.state.subtasks) as any[]
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].assigneeID, nova.result.id)
    assert.ok(next.state.messages[workspace.result.id].some((message: any) => message.author === "system" && message.text === `→ Assigned to $Nova: Do the thing`))
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("mentioned group messages go only to the mentioned active members", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-route-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const nova = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const sage = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Sage" } })
    const echo = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Echo" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "site", directory, memberIDs: [nova.result.id, sage.result.id, echo.result.id], leaderID: nova.result.id },
    })
    const single = await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "$Sage take this" } })
    assert.deepEqual(single.result.recipients, [sage.result.id])
    const fanout = await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "$Sage and $Echo pair up" } })
    assert.deepEqual([...fanout.result.recipients].sort(), [sage.result.id, echo.result.id].sort())
    const next = await handlers.snapshot({ directory })
    const assignees = (Object.values(next.state.subtasks) as any[]).map((task) => task.assigneeID).sort()
    assert.deepEqual(assignees, [echo.result.id, sage.result.id, sage.result.id].sort())
    assert.ok(!assignees.includes(nova.result.id))
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("unmentioned routing ignores recent activity and stays with the leader", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-route-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const nova = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const sage = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Sage" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "site", directory, memberIDs: [nova.result.id, sage.result.id], leaderID: nova.result.id },
    })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "$Sage you take this one" } })
    const afterMention = await handlers.snapshot({ directory })
    assert.equal(afterMention.state.workspaces[workspace.result.id].leaderID, nova.result.id)
    const sent = await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "No mention here" } })
    assert.deepEqual(sent.result.recipients, [nova.result.id])
    const next = await handlers.snapshot({ directory })
    const latest = (Object.values(next.state.subtasks) as any[]).sort((a, b) => a.createdAt - b.createdAt).at(-1)
    assert.equal(latest.assigneeID, nova.result.id)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("agent-created delegation starts work with no further RPC", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-queue-"))
  const { ctx, tools } = fakeContext()
  let releaseGate: (() => void) | undefined
  const held = new Promise<void>((resolve) => { releaseGate = resolve })
  let waits = 0
  ;(ctx.session as any).wait = async () => {
    waits++
    if (waits === 1) await held
    else await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const nova = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const kaluna = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Kaluna" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "site", directory, memberIDs: [nova.result.id, kaluna.result.id], leaderID: nova.result.id },
    })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Coordinate" } })
    let sessionID = ""
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const binding = Object.values(next.state.bindings)[0] as any
      if (!binding) return false
      sessionID = binding.sessionID
      const parent = Object.values(next.state.subtasks).find((task: any) => task.title === "Coordinate") as any
      return parent?.state === "working" && Object.values(next.state.runs).some((run: any) => run.status === "running")
    })
    const delegated = await tools.get("delegate").execute({ maxHops: 1, assignee: "Kaluna", title: "Child", instruction: "Check" }, { sessionID })
    assert.match(delegated.content, /Delegated to Kaluna/)
    // No further RPC: snapshots alone must show the child running to completion.
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const child = Object.values(next.state.subtasks).find((task: any) => task.title === "Child") as any
      return child?.state === "replied"
    })
    const after = await handlers.snapshot({ directory })
    const child = Object.values(after.state.subtasks).find((task: any) => task.title === "Child") as any
    assert.equal(child.outcome, "succeeded")
    assert.ok(child.attempts >= 1)
    assert.ok(child.queueKey)
  } finally {
    releaseGate?.()
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("non-leader delegation refusal is visible in the group chat", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-queue-"))
  const { ctx, tools } = fakeContext()
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 300)) }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const nova = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const sage = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Sage" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "site", directory, memberIDs: [nova.result.id, sage.result.id], leaderID: nova.result.id },
    })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "$Sage take this" } })
    let sessionID = ""
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const binding = Object.values(next.state.bindings).find((item: any) => item.agentID === sage.result.id) as any
      if (!binding) return false
      sessionID = binding.sessionID
      return true
    })
    const before = await handlers.snapshot({ directory })
    const taskCount = Object.keys(before.state.subtasks).length
    const refused = await tools.get("delegate").execute({ maxHops: 1, assignee: "Nova", title: "Sneaky", instruction: "Check" }, { sessionID })
    assert.match(refused.content, /Only the workspace leader/)
    const after = await handlers.snapshot({ directory })
    assert.equal(Object.keys(after.state.subtasks).length, taskCount)
    const messages = after.state.messages[workspace.result.id] as any[]
    assert.ok(messages.some((message) => message.author === "system" && /only the workspace leader/i.test(message.text)), "expected a visible refusal in the group chat")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("resubmitting the same delegation executes once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-queue-"))
  const { ctx, tools } = fakeContext()
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 300)) }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const nova = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const sage = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Sage" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "site", directory, memberIDs: [nova.result.id, sage.result.id], leaderID: nova.result.id },
    })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Coordinate" } })
    let sessionID = ""
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const binding = Object.values(next.state.bindings)[0] as any
      if (!binding) return false
      sessionID = binding.sessionID
      const parent = Object.values(next.state.subtasks).find((task: any) => task.title === "Coordinate") as any
      return parent?.state === "working" && Object.values(next.state.runs).some((run: any) => run.status === "running")
    })
    const first = await tools.get("delegate").execute({ maxHops: 1, assignee: "Sage", title: "Child", instruction: "Check" }, { sessionID })
    assert.match(first.content, /Delegated to Sage/)
    const second = await tools.get("delegate").execute({ maxHops: 1, assignee: "Sage", title: "Child", instruction: "Check" }, { sessionID })
    assert.match(second.content, /Already delegated to Sage/)
    const after = await handlers.snapshot({ directory })
    const children = Object.values(after.state.subtasks).filter((task: any) => task.title === "Child")
    assert.equal(children.length, 1)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a repeated user command forms a new dispatch group and task, with retry as the explicit re-ask", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-queue-"))
  const shared = new Map<string, unknown>()
  const seed = new V2Store(fakeContext(shared).ctx)
  await seed.load()
  await seed.saveAgent({ id: "n", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  await seed.saveAgent({ id: "s", name: "Sage", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  await seedWorkspace(seed, directory, { leaderID: "n", memberIDs: ["n", "s"], synthesis: false })
  // A retained terminal row for the exact work the user path would create.
  const at = Date.now()
  const retainedKey = workKey({ actor: "user", workspaceID: "w", kind: "delegation", parentID: undefined, assigneeID: "n", title: "Coordinate", instruction: "Coordinate" })
  await seed.saveSubtask({ id: "t", workspaceID: "w", creatorType: "user", assigneeID: "n", title: "Coordinate", instruction: "Coordinate", mode: "research", state: "replied", stage: "initial", outcome: "succeeded", interrupted: false, awaitingChildren: false, attempts: 1, createdAt: 1, repliedAt: at, finishedAt: at, queueKey: retainedKey, workKind: "delegation" })
  const { ctx } = fakeContext(shared)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    // A repeated identical user command is a new dispatch: the group is part
    // of the root work idempotency key, so no retained row may suppress it.
    const sent = await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: "w", text: "Coordinate" } })
    assert.deepEqual(sent.result.recipients, ["n"])
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const rows = Object.values(next.state.subtasks).filter((task: any) => task.title === "Coordinate") as any[]
      return rows.length === 2 && rows.every((task) => task.state === "replied")
    })
    const after = await handlers.snapshot({ directory })
    const rows = Object.values(after.state.subtasks).filter((task: any) => task.title === "Coordinate") as any[]
    assert.equal(rows.length, 2)
    assert.ok(rows.every((task) => typeof task.dispatchGroupID === "string" && task.dispatchGroupID.length > 0))
    assert.notEqual(rows[0].dispatchGroupID, rows[1].dispatchGroupID)
    // Intentional re-asks stay explicit: task.retry re-queues the same row,
    // which then runs exactly once through the normal queue path with its
    // original dispatch group intact.
    const retried = await handlers.invoke({ directory, action: "task.retry", payload: { id: "t" } })
    assert.equal(retried.result.id, "t")
    assert.equal(retried.result.state, "pending")
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks as any).t?.state === "replied" && (next.state.subtasks as any).t?.attempts === 2
    })
    const rerun = await handlers.snapshot({ directory })
    assert.equal(Object.values(rerun.state.subtasks).filter((task: any) => task.title === "Coordinate").length, 2)
    assert.equal((rerun.state.subtasks as any).t.dispatchGroupID, rows.find((task) => task.id === "t").dispatchGroupID)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("restart recovery re-queues claimed work without duplicating it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-queue-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seed.saveAgent({ id: "n", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  await seed.saveAgent({ id: "s", name: "Sage", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  await seedWorkspace(seed, directory, { leaderID: "n", memberIDs: ["n", "s"], synthesis: false })
  await seed.saveSubtask({ id: "t", workspaceID: "w", creatorType: "agent", creatorAgentID: "n", assigneeID: "s", title: "Child", instruction: "Check", mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false, attempts: 2, createdAt: 1, claimedBy: "run_old", leaseUntil: 1, queueKey: "work:w:delegation:root:seed", workKind: "delegation" })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks as any).t?.state === "replied"
    })
    const after = await handlers.snapshot({ directory })
    // The recovered work item is not duplicated; its mandatory completion
    // handoff to the leader (ticket #71) is a separate terminal delivery.
    assert.equal(Object.values(after.state.subtasks).filter((task: any) => task.title === "Child" && task.handoff?.completion !== true).length, 1)
    assert.equal(after.state.subtasks.t.attempts, 3)
    assert.equal(after.state.subtasks.t.outcome, "succeeded")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket148: load leaves a live foreign lease working row untouched", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-148-live-lease-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory)
  const leaseUntil = Date.now() + 60_000
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Live", instruction: "Do",
    mode: "research", state: "working", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 2, claimedBy: "run_other", activeRunID: "run_other", leaseUntil, createdAt: 1,
  })
  const service = new EnsembleV2Service(ctx)
  const previousLevel = process.env.ENSEMBLE_LOG_LEVEL
  process.env.ENSEMBLE_LOG_LEVEL = "debug"
  let stop = async () => {}
  try {
    stop = await startServiceForTest(service, service.ctx)
  } finally {
    if (previousLevel === undefined) delete process.env.ENSEMBLE_LOG_LEVEL
    else process.env.ENSEMBLE_LOG_LEVEL = previousLevel
  }
  const handlers = service.handlers()
  try {
    const snapshot = await handlers.snapshot({ directory })
    const row = snapshot.state.subtasks.t as any
    assert.equal(row.state, "working")
    assert.equal(row.claimedBy, "run_other")
    assert.equal(row.activeRunID, "run_other")
    assert.equal(row.leaseUntil, leaseUntil)
    assert.equal(row.attempts, 2)
    assert.equal(row.error, undefined, "load never writes a restart error onto live work")
    const logs = await handlers["logs.recent"]({ directory, event: "task.recovery.deferred", limit: 20 })
    assert.ok(logs.entries.length >= 1, "a live foreign lease is deferred, not reaped")
    assert.equal((logs.entries[0] as any).claimedBy, "run_other")
    assert.equal((logs.entries[0] as any).taskID, "t")
    // A later maintenance pass, triggered through the public invoke boundary,
    // still defers to the live lease.
    await handlers.invoke({ directory, action: "settings.update", payload: { maxActiveRuns: 2 } })
    const later = await handlers.snapshot({ directory })
    assert.equal((later.state.subtasks.t as any).state, "working")
    assert.equal((later.state.subtasks.t as any).claimedBy, "run_other")
    assert.equal((later.state.subtasks.t as any).attempts, 2)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket148: a live lease is never retired for attempts or a passed deadline", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-148-live-retire-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { paused: true })
  const leaseUntil = Date.now() + 60_000
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Live", instruction: "Do",
    mode: "research", state: "working", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 5, claimedBy: "run_live", activeRunID: "run_live", leaseUntil, deadlineAt: 1, createdAt: 1,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const snapshot = await handlers.snapshot({ directory })
    const row = snapshot.state.subtasks.t as any
    assert.equal(row.state, "working", "a live lease survives attempt exhaustion and a passed deadline")
    assert.equal(row.status, "working", "a live lease outranks the old delivery deadline")
    assert.equal(row.claimedBy, "run_live")
    assert.equal(row.leaseUntil, leaseUntil)
    assert.equal(row.attempts, 5)
    const live = await handlers["logs.recent"]({ directory, event: "failure.terminal", taskID: "t", limit: 50 })
    assert.equal(live.entries.length, 0, "no terminal record is written while the lease is live")

    // Expire the lease and force a maintenance pass through the public invoke
    // boundary; only now may the row retire.
    const stored = seed.subtask("t")!
    stored.leaseUntil = 1
    await seed.saveSubtask(stored)
    await handlers.invoke({ directory, action: "settings.update", payload: { maxActiveRuns: 2 } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks.t as any)?.state === "replied"
    })
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.subtasks.t.outcome, "failed")
    assert.equal(after.state.subtasks.t.error, "Gave up after 5 attempts.")
    const logs = await handlers["logs.recent"]({ directory, event: "failure.terminal", taskID: "t", limit: 50 })
    assert.equal((logs.entries.at(-1) as any).failureClass, "internal")
    assert.equal((logs.entries.at(-1) as any).reason, "attempts-exhausted")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket148: an expired lease is requeued once and attempts rise only on the next claim", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-148-expired-lease-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { paused: true })
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Stale", instruction: "Do",
    mode: "research", state: "working", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 2, claimedBy: "run_dead", leaseUntil: 1, createdAt: 1,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const snapshot = await handlers.snapshot({ directory })
    const row = snapshot.state.subtasks.t as any
    // The expired claim is requeued without consuming an attempt. Ticket #169:
    // the requeue is a due retry with structured evidence, so a late result
    // from the expired run can still repair the row.
    assert.equal(row.state, "pending")
    assert.equal(row.status, "retrying")
    assert.equal(typeof row.retryAfter, "number")
    assert.equal(row.claimedBy, undefined)
    assert.equal(row.leaseUntil, undefined)
    assert.equal(row.attempts, 2)
    assert.equal(row.error, undefined, "requeue records failure evidence without a new user-visible error")
    const logs = await handlers["logs.recent"]({ directory, event: "task.recovery.requeued", limit: 50 })
    assert.equal(logs.entries.length, 1)
    assert.equal((logs.entries[0] as any).claimedBy, "run_dead")
    assert.equal((logs.entries[0] as any).attempts, 2)
    // A second maintenance pass through the public invoke boundary sees a
    // claimless row; it is not requeued again.
    await handlers.invoke({ directory, action: "settings.update", payload: { maxActiveRuns: 2 } })
    const again = await handlers["logs.recent"]({ directory, event: "task.recovery.requeued", limit: 50 })
    assert.equal(again.entries.length, 1)
    assert.equal((await handlers.snapshot({ directory })).state.subtasks.t.attempts, 2)
    // The next claim is the one that consumes attempt 3.
    await handlers.invoke({ directory, action: "workspace.resume", payload: { id: "w" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks.t as any)?.state === "replied"
    }, 5_000)
    const after = await handlers.snapshot({ directory })
    assert.equal((after.state.subtasks.t as any).attempts, 3)
    assert.equal((after.state.subtasks.t as any).outcome, "succeeded")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket149: restart requeue writes a failure attempt with the previous claim and lease", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-149-requeue-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { paused: true })
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Recovered", instruction: "Do",
    mode: "research", state: "working", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 2, claimedBy: "run_dead", activeRunID: "run_dead", leaseUntil: 1, createdAt: 1,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const snapshot = await handlers.snapshot({ directory })
    const row = snapshot.state.subtasks.t as any
    assert.equal(row.state, "pending")
    assert.equal(row.attempts, 2, "requeue never consumes an attempt")
    assert.equal(row.claimedBy, undefined)
    const logs = await handlers["logs.recent"]({ directory, event: "failure.attempt", taskID: "t", limit: 50 })
    const record = logs.entries.at(-1) as any
    assert.ok(record, "the requeue reaches the failure sink")
    assert.equal(record.failureClass, "restart")
    assert.equal(record.previousClaim, "run_dead")
    assert.equal(record.leaseExpiredAt, 1)
    assert.equal(record.reason, "lease-expired")
    assert.equal(typeof record.instanceID, "string", "the logger stamps the service instance")
    assert.equal(typeof record.threadID, "number", "the logger stamps the worker thread")
    assert.equal(record.decision.type, "retry")
    assert.equal(record.decision.reason, "lease-expired")
    assert.equal(record.decision.attempt, 3)
    assert.equal(record.decision.maxAttempts, 5)
    assert.equal(record.decision.delayMs, 0)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket170: a rejected ask is a controlled stop, not a native failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-170-rejected-ask-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory)
  await seed.saveApproval({
    id: "ap", workspaceID: "w", subtaskID: "t", agentID: "a", kind: "ask_person",
    title: "Need input", detail: "Which API?", status: "pending", createdAt: 1,
  })
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Question", instruction: "Do work",
    mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: true, approvalID: "ap",
    awaitingChildren: false, attempts: 1, activeRunID: "run", claimedBy: "run", leaseUntil: Date.now() + 60_000, createdAt: 1,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "approval.resolve", payload: { id: "ap", approve: false } })
    const after = await handlers.snapshot({ directory })
    const task = after.state.subtasks.t as any
    assert.equal(task.status, "cancelled")
    assert.equal(task.stoppedAt !== undefined, true)
    assert.equal(task.activeRunID, undefined, "a controlled stop clears the active run id")
    assert.equal(task.claimedBy, undefined, "a controlled stop clears the claim")
    const failed = await handlers["logs.recent"]({ directory, event: "task.failed", taskID: "t", limit: 20 })
    assert.equal(failed.entries.length, 0, "a user rejection is never logged as a native failure")
    const cancelled = await handlers["logs.recent"]({ directory, event: "task.cancelled", taskID: "t", limit: 20 })
    assert.equal(cancelled.entries.length, 1)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket170: a run whose delivery deadline is long past completes while its lease is live", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-170-late-deadline-"))
  const { ctx } = fakeContext()
  let releaseWait: () => void = () => {}
  const waitGate = new Promise<void>((resolve) => { releaseWait = resolve })
  ;(ctx.session as any).wait = async () => { await waitGate }
  ;(ctx.session as any).context = async () => ({
    data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "Finished after the old deadline." }] }],
  })
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory)
  const oldDeadline = Date.now() - 6 * 60_000
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Long run", instruction: "Do",
    mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 0, createdAt: oldDeadline, deadlineAt: oldDeadline,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const task = next.state.subtasks.t as any
      return task?.status === "working" && task?.claimedBy !== undefined
    }, 5_000)
    const live = await handlers.snapshot({ directory })
    const task = live.state.subtasks.t as any
    assert.equal(task.deadlineAt, oldDeadline, "the delivery timestamp is kept for visibility")
    assert.equal(task.status, "working", "the live heartbeat lease outranks the old delivery deadline")
    assert.ok(task.leaseUntil > Date.now(), "the claim remains live")
    releaseWait()
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks.t as any)?.status === "replied"
    }, 5_000)
    const after = await handlers.snapshot({ directory })
    assert.equal((after.state.subtasks.t as any).outcome, "succeeded")
    assert.equal((after.state.subtasks.t as any).attempts, 1)
  } finally {
    releaseWait()
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket170: explicit retry and restart requeue exhausted rows with a fresh attempt budget", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-170-manual-retry-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { paused: true })
  const finishedAt = Date.now() - 1_000
  const exhausted = (id: string) => ({
    id, workspaceID: "w", creatorType: "user" as const, assigneeID: "a", title: id, instruction: "Do",
    mode: "research" as const, state: "replied" as const, stage: "initial" as const, outcome: "failed" as const,
    interrupted: false, awaitingChildren: false, attempts: 5, createdAt: finishedAt - 10,
    finishedAt, repliedAt: finishedAt, error: "Gave up after 5 attempts.",
    failure: { kind: "attempts" as const, reason: "attempts-exhausted" },
  })
  await seed.saveSubtask(exhausted("retry_me"))
  await seed.saveSubtask(exhausted("restart_me"))
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "task.retry", payload: { id: "retry_me" } })
    await handlers.invoke({ directory, action: "task.restart", payload: { id: "restart_me" } })
    const queued = await handlers.snapshot({ directory })
    for (const id of ["retry_me", "restart_me"]) {
      const task = queued.state.subtasks[id] as any
      assert.equal(task.state, "pending", `${id} is requeued despite the exhausted automatic budget`)
      assert.equal(task.attempts, 0, `${id} receives a fresh explicit budget`)
      assert.equal(task.status, "pending")
      assert.equal(task.failure, undefined)
      assert.equal(task.error, undefined)
    }
    const requested = await handlers["logs.recent"]({ directory, event: "task.retry.requested", limit: 20 })
    assert.deepEqual(requested.entries.map((entry: any) => entry.reason).sort(), ["manual-restart", "manual-retry"])
    assert.deepEqual(requested.entries.map((entry: any) => entry.from).sort(), ["stalled", "stalled"])
    assert.ok(requested.entries.every((entry: any) => entry.attempts === 5 && entry.maxAttempts === 5))
    assert.ok(requested.entries.every((entry: any) => entry.attemptsReset === true))
    await handlers.invoke({ directory, action: "workspace.resume", payload: { id: "w" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return ["retry_me", "restart_me"].every((id) => (next.state.subtasks[id] as any)?.outcome === "succeeded")
    }, 5_000)
    const after = await handlers.snapshot({ directory })
    for (const id of ["retry_me", "restart_me"]) {
      assert.equal((after.state.subtasks[id] as any).status, "replied")
      assert.equal((after.state.subtasks[id] as any).attempts, 1, "the fresh budget starts at one real attempt")
    }
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket170: a late success removes stale retry and failure notices without losing the answer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-170-recovery-notices-"))
  const { ctx } = fakeContext()
  let releaseWait: () => void = () => {}
  const waitGate = new Promise<void>((resolve) => { releaseWait = resolve })
  ;(ctx.session as any).wait = async () => { await waitGate }
  ;(ctx.session as any).context = async () => ({
    data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "The recovered final answer." }] }],
  })
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { nextSeq: 10 })
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Recover", instruction: "Do",
    mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 0, createdAt: 1,
  })
  await seed.saveMessage({ id: "m_retry", workspaceID: "w", seq: 1, author: "system", taskID: "t", text: "Retrying in 30s (attempt 2/5): native failure", kind: "system", notice: "retry", createdAt: 2 })
  await seed.saveMessage({ id: "m_failure", workspaceID: "w", seq: 2, author: "system", taskID: "t", text: "Handoff to Sage failed.", kind: "system", notice: "failure", createdAt: 3 })
  await seed.saveMessage({ id: "m_answer", workspaceID: "w", seq: 3, author: "agent", agentID: "a", taskID: "t", text: "Reply interrupted.", kind: "text", streaming: false, interrupted: true, createdAt: 4 })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.messages.w as any[]).some((message) => message.id === "m_answer" && message.streaming === true)
    }, 5_000)
    // A false terminal state lands while the native run still owns the answer.
    // The settled placeholder must still be repaired by the late result.
    const foreign = new V2Store(ctx)
    await foreign.load()
    const stale = foreign.cloneSubtask("t")!
    stale.state = "replied"
    stale.outcome = "failed"
    stale.error = "The work deadline passed before it could finish."
    stale.failure = { kind: "delivery", reason: "deadline-exceeded" }
    stale.activeRunID = undefined
    stale.claimedBy = undefined
    stale.leaseUntil = undefined
    stale.repliedAt = Date.now()
    stale.finishedAt = Date.now()
    await foreign.saveSubtask(stale)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const live = (next.state.messages.w as any[]).find((message) => message.id === "m_answer")
      return live?.streaming === false && live?.text === "Reply interrupted." && live?.interrupted === true
    }, 5_000)
    releaseWait()
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks.t as any)?.outcome === "succeeded"
    }, 5_000)
    const after = await handlers.snapshot({ directory })
    const rows = after.state.messages.w as any[]
    assert.equal(rows.some((message) => message.id === "m_retry"), false, "the stale retry notice is removed")
    assert.equal(rows.some((message) => message.id === "m_failure"), false, "the false failure notice is removed")
    const answer = rows.find((message) => message.id === "m_answer") as any
    assert.equal(answer.text, "The recovered final answer.")
    assert.equal(answer.interrupted, false)
    assert.equal((after.state.subtasks.t as any).status, "replied")
    await waitFor(async () => {
      const logs = await handlers["logs.recent"]({ directory, event: "task.recovered", limit: 20 })
      return logs.entries.length === 1
    }, 5_000)
    const recovered = await handlers["logs.recent"]({ directory, event: "task.recovered", limit: 20 })
    assert.equal(recovered.entries.length, 1)
    assert.equal(recovered.entries[0]?.reason, "late-success")
    const diagnostic = await (handlers as any).diagnostic({ directory })
    assert.equal(diagnostic.recoveries.length, 1)
    assert.equal(diagnostic.recoveries[0].taskID, "t")
    assert.equal(diagnostic.recoveries[0].to, "replied")
    assert.equal(typeof diagnostic.recoveries[0].at, "number")
    assert.equal(JSON.stringify(diagnostic.recoveries).includes("recovered final answer"), false, "diagnostic recovery rows never carry content")
  } finally {
    releaseWait()
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket170: a tool-only empty turn fails honestly without a false interruption placeholder", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-170-tool-only-"))
  const { ctx } = fakeContext()
  ;(ctx.session as any).context = async () => ({
    data: [{
      type: "assistant",
      time: { created: Date.now() },
      content: [{ type: "tool", name: "bash", state: { status: "completed" } }],
    }],
  })
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory)
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Tool only", instruction: "Do",
    mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 4, createdAt: 1,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks.t as any)?.outcome === "failed"
    }, 5_000)
    const after = await handlers.snapshot({ directory })
    const task = after.state.subtasks.t as any
    assert.equal(task.status, "failed")
    assert.deepEqual(task.failure, { kind: "native", reason: "empty-reply" })
    const rows = (after.state.messages.w as any[]).filter((message) => message.taskID === "t")
    assert.equal(rows.some((message) => message.text === "Reply interrupted."), false, "a tool-only empty turn is not an interruption")
    const answer = rows.find((message) => message.author === "agent" && message.kind === "text") as any
    assert.equal(answer.text, "The agent produced no answer.")
    assert.equal(answer.streaming, false)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket168: attempt exhaustion stalls while an old delivery deadline only requeues", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-149-retire-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { paused: true })
  await seed.saveSubtask({
    id: "t_exhausted", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Exhausted", instruction: "Do",
    mode: "research", state: "working", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 5, claimedBy: "run_dead", leaseUntil: 1, createdAt: 1,
  })
  await seed.saveSubtask({
    id: "t_expired", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Expired", instruction: "Do",
    mode: "research", state: "working", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 2, claimedBy: "run_dead", leaseUntil: 1, deadlineAt: 1, createdAt: 2,
  })
  await seed.saveSubtask({
    id: "t_transient", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Transient", instruction: "Do",
    mode: "research", state: "working", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 5, claimedBy: "run_dead", leaseUntil: 1, error: "Recovered after an expired lease; retrying.", createdAt: 3,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const snapshot = await handlers.snapshot({ directory })
    assert.equal((snapshot.state.subtasks.t_exhausted as any).state, "replied")
    assert.equal((snapshot.state.subtasks.t_exhausted as any).outcome, "failed")
    assert.equal((snapshot.state.subtasks.t_exhausted as any).status, "stalled")
    assert.deepEqual((snapshot.state.subtasks.t_exhausted as any).failure, { kind: "attempts", reason: "attempts-exhausted" })
    assert.equal((snapshot.state.subtasks.t_expired as any).state, "pending", "an old delivery timestamp does not retire queued work")
    assert.equal((snapshot.state.subtasks.t_expired as any).outcome, "pending")
    assert.equal((snapshot.state.subtasks.t_expired as any).status, "retrying", "a lost lease is a scheduled retry")
    assert.equal(typeof (snapshot.state.subtasks.t_expired as any).retryAfter, "number")
    assert.equal((snapshot.state.subtasks.t_expired as any).claimedBy, undefined, "the lost lease is requeued")
    assert.equal((snapshot.state.subtasks.t_transient as any).state, "replied")
    assert.equal((snapshot.state.subtasks.t_transient as any).status, "stalled")
    assert.equal((snapshot.state.subtasks.t_transient as any).error, "Gave up after 5 attempts.", "a transient recovery string never becomes terminal truth")

    const logs = await handlers["logs.recent"]({ directory, event: "failure.terminal", limit: 50 })
    const exhausted = logs.entries.find((entry: any) => entry.taskID === "t_exhausted") as any
    assert.ok(exhausted, "attempt exhaustion is never silent")
    assert.equal(exhausted.failureClass, "internal", "attempt exhaustion is internal truth, not a restart")
    assert.equal(exhausted.previousClaim, "run_dead")
    assert.equal(exhausted.leaseExpiredAt, 1)
    assert.equal(exhausted.reason, "attempts-exhausted")
    assert.equal(typeof exhausted.instanceID, "string")
    assert.equal(typeof exhausted.threadID, "number")
    assert.equal(exhausted.decision.type, "terminal")
    assert.equal(exhausted.decision.reason, "attempts-exhausted")
    assert.equal(exhausted.decision.attempt, 5)
    assert.equal(exhausted.decision.maxAttempts, 5)
    assert.equal(exhausted.workFailureKind, "attempts")
    assert.equal(exhausted.workFailureReason, "attempts-exhausted")

    const stalledLogs = await handlers["logs.recent"]({ directory, event: "task.stalled", taskID: "t_exhausted", limit: 20 })
    assert.equal(stalledLogs.entries.length, 1, "the lifecycle log names a stall, not a native failure")
    assert.equal((stalledLogs.entries[0] as any).level, "warn")
    assert.equal((stalledLogs.entries[0] as any).failureKind, "attempts")
    assert.equal((stalledLogs.entries[0] as any).reason, "attempts-exhausted")
    const failedLogs = await handlers["logs.recent"]({ directory, event: "task.failed", taskID: "t_exhausted", limit: 20 })
    assert.equal(failedLogs.entries.length, 0, "task.failed is native-only")

    const expired = logs.entries.find((entry: any) => entry.taskID === "t_expired") as any
    assert.equal(expired, undefined, "a delivery deadline never writes a terminal failure")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket168: pending work past the delivery window stays queued and still runs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-168-queue-wait-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { paused: true })
  const enqueuedAt = Date.now() - 10 * 60_000
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Queued", instruction: "Do",
    mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 0, createdAt: enqueuedAt, deadlineAt: enqueuedAt + 5 * 60_000,
    error: "The work deadline passed before it could finish.",
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const snapshot = await handlers.snapshot({ directory })
    const row = snapshot.state.subtasks.t as any
    assert.equal(row.state, "pending", "queue age does not retire unclaimed work")
    assert.equal(row.status, "pending")
    assert.equal(row.outcome, "pending")
    assert.equal(row.failure, undefined)
    const terminal = await handlers["logs.recent"]({ directory, event: "failure.terminal", taskID: "t", limit: 20 })
    assert.equal(terminal.entries.length, 0, "a queued wait is never a terminal failure")
    await handlers.invoke({ directory, action: "workspace.resume", payload: { id: "w" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks.t as any)?.state === "replied" && (next.state.subtasks.t as any)?.outcome === "succeeded"
    }, 5_000)
    const after = await handlers.snapshot({ directory })
    assert.equal((after.state.subtasks.t as any).status, "replied")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket168: a completion handoff is not failed by the delivery window", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-168-completion-handoff-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { paused: true })
  await seed.saveSubtask({
    id: "hop", workspaceID: "w", creatorType: "agent", creatorAgentID: "a", assigneeID: "a", title: "Completion", instruction: "Finish",
    mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 0, createdAt: Date.now() - 10 * 60_000, deadlineAt: Date.now() - 5 * 60_000,
    workKind: "handoff", queueKey: "completion:w:parent:a", failure: undefined,
    handoff: { correlationID: "handoff_completion", senderID: "a", recipientID: "a", depth: 1, completion: true },
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const queued = await handlers.snapshot({ directory })
    assert.equal((queued.state.subtasks.hop as any).state, "pending", "a completion delivery stays queued")
    assert.equal((queued.state.subtasks.hop as any).status, "pending")
    assert.equal((queued.state.subtasks.hop as any).failure, undefined)
    const terminal = await handlers["logs.recent"]({ directory, event: "failure.terminal", taskID: "hop", limit: 20 })
    assert.equal(terminal.entries.length, 0)
    await handlers.invoke({ directory, action: "workspace.resume", payload: { id: "w" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks.hop as any)?.state === "replied" && (next.state.subtasks.hop as any)?.outcome === "succeeded"
    }, 5_000)
    assert.equal(((await handlers.snapshot({ directory })).state.subtasks.hop as any).status, "replied")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket168: a parent awaiting children reads waiting, not retrying", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-168-waiting-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { paused: true })
  await seed.saveSubtask({
    id: "parent", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Parent", instruction: "Do parent",
    mode: "research", state: "working", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: true,
    attempts: 1, retryAfter: Date.now() + 60_000, createdAt: 1,
  })
  await seed.saveSubtask({
    id: "child", workspaceID: "w", parentID: "parent", creatorType: "agent", creatorAgentID: "a", assigneeID: "a",
    title: "Child", instruction: "Do child", mode: "research", state: "pending", stage: "initial", outcome: "pending",
    interrupted: false, awaitingChildren: false, attempts: 0, createdAt: 2,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const snapshot = await handlers.snapshot({ directory })
    assert.equal((snapshot.state.subtasks.parent as any).status, "waiting", "children are a dependency wait, not a retry")
    assert.equal((snapshot.state.subtasks.child as any).status, "pending")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket168: cancellation is explicit and never a timeout or failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-168-cancel-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { paused: true })
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Stop me", instruction: "Do",
    mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 1, retryAfter: Date.now() + 60_000, createdAt: 1,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const cancelled = await handlers.invoke({ directory, action: "task.cancel", payload: { id: "t" } })
    assert.equal(cancelled.ok, true)
    const snapshot = await handlers.snapshot({ directory })
    const row = snapshot.state.subtasks.t as any
    assert.equal(row.state, "replied")
    assert.equal(row.status, "cancelled")
    assert.equal(row.stoppedAt !== undefined, true)
    assert.equal(row.failure, undefined, "a stop is not a native failure")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket168: legacy deadline and lease terminal rows reconcile to stalled from structured causes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-168-reconcile-"))
  const logDirectory = mkdtempSync(join(tmpdir(), "ensemble-168-reconcile-logs-"))
  const previousLogDirectory = process.env.ENSEMBLE_LOG_DIR
  process.env.ENSEMBLE_LOG_DIR = logDirectory
  const { ctx } = fakeContext()
  let stop = async () => {}
  try {
    const seed = new V2Store(ctx)
    await seed.load()
    await seedAgent(seed)
    await seedWorkspace(seed, directory)
    const finishedAt = Date.now()
    const terminal = (id: string, error: string) => ({
      id, workspaceID: "w", creatorType: "user" as const, assigneeID: "a", title: id, instruction: "Do",
      mode: "research" as const, state: "replied" as const, stage: "initial" as const, outcome: "failed" as const,
      interrupted: false, awaitingChildren: false, attempts: 1, createdAt: finishedAt - 10,
      deadlineAt: finishedAt - 1, finishedAt, repliedAt: finishedAt, error,
    })
    await seed.saveSubtask(terminal("legacy_deadline", "The work deadline passed before it could finish."))
    await seed.saveSubtask(terminal("legacy_lease", "The lease expired before the run finished."))
    await seed.saveSubtask(terminal("legacy_lease_exhausted", "Gave up after 5 attempts."))
    await seed.saveSubtask(terminal("legacy_native", "quota exhausted"))
    writeFileSync(
      join(logDirectory, "service-failures-20261108-1.jsonl"),
      [
        { cat: "failure", event: "failure.terminal", taskID: "legacy_deadline", failureClass: "timeout", reason: "deadline-exceeded", decision: { type: "terminal", reason: "deadline-exceeded" } },
        { cat: "failure", event: "failure.terminal", taskID: "legacy_lease", failureClass: "timeout", reason: "lease-expired", decision: { type: "terminal", reason: "lease-expired" } },
        { cat: "failure", event: "failure.terminal", taskID: "legacy_lease_exhausted", failureClass: "internal", reason: "attempts-exhausted", previousClaim: "run_dead", leaseExpiredAt: 1, decision: { type: "terminal", reason: "attempts-exhausted" } },
        { cat: "failure", event: "failure.terminal", taskID: "legacy_native", failureClass: "provider", reason: "attempts-exhausted", decision: { type: "terminal", reason: "attempts-exhausted" } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    )
    const service = new EnsembleV2Service(ctx)
    stop = await startServiceForTest(service, service.ctx)
    const handlers = service.handlers()
    const snapshot = await handlers.snapshot({ directory })
    assert.equal((snapshot.state.subtasks.legacy_deadline as any).status, "stalled")
    assert.deepEqual((snapshot.state.subtasks.legacy_deadline as any).failure, { kind: "delivery", reason: "deadline-exceeded" })
    assert.equal((snapshot.state.subtasks.legacy_lease as any).status, "stalled")
    assert.deepEqual((snapshot.state.subtasks.legacy_lease as any).failure, { kind: "lease", reason: "lease-expired" })
    assert.equal((snapshot.state.subtasks.legacy_lease_exhausted as any).status, "stalled")
    assert.deepEqual((snapshot.state.subtasks.legacy_lease_exhausted as any).failure, { kind: "attempts", reason: "attempts-exhausted" })
    assert.equal((snapshot.state.subtasks.legacy_native as any).status, "failed", "a genuine native failure is never masked")
    assert.equal((snapshot.state.subtasks.legacy_native as any).failure, undefined)
    const logs = await handlers["logs.recent"]({ directory, event: "task.reconciled", limit: 20 })
    assert.deepEqual(logs.entries.map((entry: any) => entry.taskID).sort(), ["legacy_deadline", "legacy_lease", "legacy_lease_exhausted"])
    const reconciled = logs.entries.find((entry: any) => entry.taskID === "legacy_deadline") as any
    assert.equal(reconciled.from, "failed")
    assert.equal(reconciled.to, "stalled")
    assert.equal(reconciled.reason, "deadline-exceeded")
    assert.equal(reconciled.failureClass, "timeout")
  } finally {
    await stop()
    if (previousLogDirectory === undefined) delete process.env.ENSEMBLE_LOG_DIR
    else process.env.ENSEMBLE_LOG_DIR = previousLogDirectory
    rmSync(directory, { recursive: true, force: true })
    rmSync(logDirectory, { recursive: true, force: true })
  }
})

test("ticket149: stream finalization reports settlement and result eligibility separately", () => {
  const row = {
    id: "m", workspaceID: "w", seq: 1, author: "agent", agentID: "a", text: "answer",
    kind: "text", streaming: false, createdAt: 1,
  } as any

  assert.deepEqual(streamFinalization(undefined, true, false, "answer"), { eligible: false, reason: "no-message" })
  const eligible = streamFinalization(row, true, false, "answer")
  assert.equal(eligible.eligible, true)
  assert.equal(eligible.message, row)
  assert.equal(eligible.reason, undefined)

  assert.equal(streamFinalization(row, false, false, "answer").reason, "stale", "a stale epoch still settles but is not a result")
  assert.equal(streamFinalization(row, true, true, "answer").reason, "interrupted")
  assert.equal(streamFinalization(row, true, false, "Reply completed.").reason, "fallback")
  assert.equal(streamFinalization(row, true, false, "   ").reason, "empty")
})

test("ticket149: a recovered then successful task clears its restart error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-149-clear-error-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory)
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Recovered", instruction: "Do",
    mode: "research", state: "working", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 1, claimedBy: "run_dead", activeRunID: "run_dead", leaseUntil: 1,
    error: "Ensemble restarted while this subtask was working.", createdAt: 1,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks.t as any)?.state === "replied"
    }, 5_000)
    const after = await handlers.snapshot({ directory })
    const task = after.state.subtasks.t as any
    assert.equal(task.outcome, "succeeded")
    assert.equal(task.attempts, 2)
    assert.equal(task.error, undefined, "a success never retains a restart reason")
    const result = after.state.messages.w.find((message: any) => message.id === task.resultMessageID) as any
    assert.ok(result)
    assert.equal(result.text, "OK")
    assert.equal(FALLBACK_REPLIES.has(result.text), false)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket149: a fallback reply is retried as an empty answer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-149-fallback-retry-"))
  const { ctx } = fakeContext()
  ;(ctx.session as any).context = async () => ({
    data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "Reply completed." }] }],
  })
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { nextSeq: 2 })
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Placeholder", instruction: "Do",
    mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 1, createdAt: 1,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks.t as any)?.error === "The agent produced no answer."
    }, 5_000)
    const after = await handlers.snapshot({ directory })
    const task = after.state.subtasks.t as any
    assert.equal(task.state, "pending")
    assert.equal(task.outcome, "pending")
    assert.equal(task.attempts, 2)
    assert.equal(task.resultMessageID, undefined)
    assert.ok(task.retryAfter > Date.now() - 1_000)
    const messages = (after.state.messages.w ?? []) as any[]
    assert.equal(messages.some((message) => message.text === "Reply completed."), false)
    assert.equal(messages.some((message) => message.taskID === "t" && FALLBACK_REPLIES.has(message.text)), false)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket149: an exhausted fallback reply fails visibly without a result", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-149-fallback-fail-"))
  const { ctx } = fakeContext()
  ;(ctx.session as any).context = async () => ({
    data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "Reply interrupted before completion." }] }],
  })
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { nextSeq: 2 })
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Placeholder exhausted", instruction: "Do",
    mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 4, createdAt: 1,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks.t as any)?.state === "replied"
    }, 5_000)
    const after = await handlers.snapshot({ directory })
    const task = after.state.subtasks.t as any
    assert.equal(task.outcome, "failed")
    assert.equal(task.error, "The agent produced no answer.")
    assert.equal(task.resultMessageID, undefined, "a fallback never becomes the result")
    const messages = (after.state.messages.w ?? []) as any[]
    assert.equal(messages.some((message) => message.taskID === "t" && FALLBACK_REPLIES.has(message.text) && message.interrupted !== true), false)
    assert.equal(messages.some((message) => message.id === task.resultMessageID), false)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket149: the request-23 shape never succeeds on a stale fallback", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-149-request23-"))
  const { ctx } = fakeContext()
  // A recovered attempt sees the previous attempt's substantive answer in the
  // native session and only a stale fallback as "new" assistant text.
  ;(ctx.session as any).context = async () => ({
    data: [
      { type: "assistant", time: { created: 1 }, content: [{ type: "text", text: "Previous answer" }] },
      { type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "Reply completed." }] },
    ],
  })
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { nextSeq: 2 })
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Recovered attempt", instruction: "Do",
    mode: "research", state: "working", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 4, claimedBy: "run_dead", activeRunID: "run_dead", leaseUntil: 1,
    error: "Ensemble restarted while this subtask was working.", createdAt: 1,
  })
  await seed.saveMessage({
    id: "m_previous", workspaceID: "w", seq: 1, author: "agent", agentID: "a", taskID: "t",
    text: "Previous answer", kind: "text", interrupted: false, createdAt: 2,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks.t as any)?.state === "replied"
    }, 5_000)
    const after = await handlers.snapshot({ directory })
    const task = after.state.subtasks.t as any
    assert.equal(task.outcome, "failed", "no new substantive native text cannot succeed")
    assert.equal(task.error, "The agent produced no answer.")
    assert.equal(task.resultMessageID, undefined, "the result never points at a placeholder")
    assert.equal(task.attempts, 5)
    const messages = (after.state.messages.w ?? []) as any[]
    assert.equal(messages.filter((message) => message.text === "Previous answer").length, 1, "the old answer is not duplicated")
    assert.equal(messages.some((message) => message.taskID === "t" && FALLBACK_REPLIES.has(message.text) && message.interrupted !== true), false)
    assert.equal(messages.some((message) => message.id === task.resultMessageID), false)
    assert.equal(Object.values(after.state.subtasks).some((item: any) => item.parentID === "t" && item.handoff?.completion === true), false, "a failed attempt never emits a completion handoff")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket149: an empty terminal stream settles as interrupted, never a completed placeholder", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-149-empty-stream-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { nextSeq: 2 })
  await seed.saveSubtask({ id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Done", instruction: "Do", mode: "research", state: "replied", stage: "initial", outcome: "succeeded", interrupted: false, awaitingChildren: false, attempts: 1, createdAt: 1, repliedAt: 2, finishedAt: 2 })
  await seed.saveMessage({ id: "m", workspaceID: "w", seq: 1, author: "agent", agentID: "a", taskID: "t", text: "", kind: "text", streaming: true, createdAt: 1, updatedAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const snapshot = await handlers.snapshot({ directory })
    const message = (snapshot.state.messages.w as any[]).find((item) => item.id === "m") as any
    assert.equal(message.streaming, false)
    assert.equal(message.interrupted, true)
    assert.equal(message.text, "Reply interrupted.")
    assert.notEqual(message.text, "Reply completed.", "an empty stream is never a successful answer")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket169: a stalled task's non-empty stream settles without interruption", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-169-stalled-stream-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { nextSeq: 2 })
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Stalled", instruction: "Do",
    mode: "research", state: "replied", stage: "initial", outcome: "failed", interrupted: false, awaitingChildren: false,
    attempts: 2, createdAt: 1, repliedAt: Date.now(), finishedAt: Date.now(),
    error: "The lease expired before the run finished.",
    failure: { kind: "lease", reason: "lease-expired" },
  })
  await seed.saveMessage({ id: "m", workspaceID: "w", seq: 1, author: "agent", agentID: "a", taskID: "t", text: "A real partial answer.", kind: "text", streaming: true, createdAt: 1, updatedAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const snapshot = await handlers.snapshot({ directory })
    const message = (snapshot.state.messages.w as any[]).find((item) => item.id === "m") as any
    assert.equal(message.streaming, false)
    assert.equal(message.interrupted, false, "a lease problem never interrupts a real answer")
    assert.equal(message.text, "A real partial answer.")
    assert.equal((snapshot.state.subtasks.t as any).status, "stalled")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket169: a native failure still settles a substantive stream as interrupted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-169-native-stream-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { nextSeq: 2 })
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Native failure", instruction: "Do",
    mode: "research", state: "replied", stage: "initial", outcome: "failed", interrupted: false, awaitingChildren: false,
    attempts: 2, createdAt: 1, repliedAt: Date.now(), finishedAt: Date.now(),
    error: "quota exhausted",
    failure: { kind: "native", reason: "attempts-exhausted" },
  })
  await seed.saveMessage({ id: "m", workspaceID: "w", seq: 1, author: "agent", agentID: "a", taskID: "t", text: "A partial answer.", kind: "text", streaming: true, createdAt: 1, updatedAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const snapshot = await handlers.snapshot({ directory })
    const message = (snapshot.state.messages.w as any[]).find((item) => item.id === "m") as any
    assert.equal(message.streaming, false)
    assert.equal(message.interrupted, true, "a genuine native failure remains visible")
    assert.equal(message.text, "A partial answer.")
    assert.equal((snapshot.state.subtasks.t as any).status, "failed")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket169: cancellation still settles a substantive stream as interrupted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-169-cancelled-stream-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { nextSeq: 2 })
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Cancelled", instruction: "Do",
    mode: "research", state: "replied", stage: "initial", outcome: "failed", interrupted: false, awaitingChildren: false,
    attempts: 1, createdAt: 1, repliedAt: Date.now(), finishedAt: Date.now(), stoppedAt: Date.now(),
    error: "Cancelled by user.",
  })
  await seed.saveMessage({ id: "m", workspaceID: "w", seq: 1, author: "agent", agentID: "a", taskID: "t", text: "A partial answer.", kind: "text", streaming: true, createdAt: 1, updatedAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const snapshot = await handlers.snapshot({ directory })
    const message = (snapshot.state.messages.w as any[]).find((item) => item.id === "m") as any
    assert.equal(message.streaming, false)
    assert.equal(message.interrupted, true, "a structural stop is a genuine interruption")
    assert.equal(message.text, "A partial answer.")
    assert.equal((snapshot.state.subtasks.t as any).status, "cancelled")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket169: an empty stalled stream still settles to the interruption placeholder", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-169-empty-stalled-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { nextSeq: 2 })
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Stalled empty", instruction: "Do",
    mode: "research", state: "replied", stage: "initial", outcome: "failed", interrupted: false, awaitingChildren: false,
    attempts: 5, createdAt: 1, repliedAt: Date.now(), finishedAt: Date.now(),
    failure: { kind: "attempts", reason: "attempts-exhausted" },
  })
  await seed.saveMessage({ id: "m", workspaceID: "w", seq: 1, author: "agent", agentID: "a", taskID: "t", text: "", kind: "text", streaming: true, createdAt: 1, updatedAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const snapshot = await handlers.snapshot({ directory })
    const message = (snapshot.state.messages.w as any[]).find((item) => item.id === "m") as any
    assert.equal(message.streaming, false)
    assert.equal(message.interrupted, true)
    assert.equal(message.text, "Reply interrupted.")
    assert.equal((snapshot.state.subtasks.t as any).status, "stalled")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket169: a successful retry repairs the interrupted placeholder and logs task.recovered", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-169-retry-repair-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { nextSeq: 2 })
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Retried", instruction: "Do",
    mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 1, createdAt: 1, retryAfter: Date.now() - 1, error: "The previous attempt was interrupted.",
  })
  await seed.saveMessage({ id: "m", workspaceID: "w", seq: 1, author: "agent", agentID: "a", taskID: "t", text: "Reply interrupted.", kind: "text", streaming: false, interrupted: true, createdAt: 1, updatedAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks.t as any)?.state === "replied"
    }, 5_000)
    const after = await handlers.snapshot({ directory })
    const task = after.state.subtasks.t as any
    assert.equal(task.outcome, "succeeded")
    assert.equal(task.status, "replied")
    assert.equal(task.error, undefined)
    const rows = (after.state.messages.w as any[]).filter((message) => message.taskID === "t" && message.author === "agent")
    assert.equal(rows.length, 1, "the retry repairs the placeholder instead of appending a duplicate")
    assert.equal(rows[0].id, "m")
    assert.equal(rows[0].text, "OK")
    assert.equal(rows[0].interrupted, false)
    assert.equal(rows[0].streaming, false)
    assert.equal(task.resultMessageID, "m")
    const recovered = await handlers["logs.recent"]({ directory, event: "task.recovered", limit: 20 })
    assert.equal(recovered.entries.length, 1)
    assert.equal(recovered.entries[0].taskID, "t")
    assert.equal(recovered.entries[0].from, "retrying")
    assert.equal(recovered.entries[0].to, "replied")
    assert.equal(recovered.entries[0].reason, "late-success")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket169: incident replay — a pending deadline, existing reply, late success, and 18-character placeholder", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-169-incident-"))
  const queuedDirectory = mkdtempSync(join(tmpdir(), "ensemble-169-incident-queued-"))
  const { ctx } = fakeContext()
  let releaseWait: () => void = () => {}
  const waitGate = new Promise<void>((resolve) => { releaseWait = resolve })
  ;(ctx.session as any).wait = async () => { await waitGate }
  ;(ctx.session as any).context = async () => ({
    data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "The late final answer." }] }],
  })
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { nextSeq: 10 })
  await seed.saveWorkspace({ ...siteWorkspace(queuedDirectory, { paused: true }), id: "wq", name: "queued" })
  // The 18-character placeholder from the incident, already settled.
  await seed.saveMessage({ id: "m_placeholder", workspaceID: "w", seq: 1, author: "agent", agentID: "a", taskID: "t_late", text: "Reply interrupted.", kind: "text", streaming: false, interrupted: true, createdAt: 2, updatedAt: 2 })
  // A real answer already existed in the transcript and must survive.
  const existingReply = "The source answer was already recorded. ".repeat(60).slice(0, 2_238)
  assert.equal(existingReply.length, 2_238, "the incident's existing reply size")
  await seed.saveSubtask({
    id: "t_source", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Source", instruction: "Do",
    mode: "research", state: "replied", stage: "initial", outcome: "succeeded", interrupted: false, awaitingChildren: false,
    attempts: 1, createdAt: 1, repliedAt: 2, finishedAt: 2, resultMessageID: "m_existing",
  })
  await seed.saveMessage({ id: "m_existing", workspaceID: "w", seq: 2, author: "agent", agentID: "a", taskID: "t_source", text: existingReply, kind: "text", streaming: false, interrupted: false, createdAt: 2 })
  await seed.saveSubtask({
    id: "t_late", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Late", instruction: "Do",
    mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 0, createdAt: 3, deadlineAt: Date.now() - 5 * 60_000,
    error: "The work deadline passed before it could finish.",
  })
  // The same incident from the completion queue: old delivery, never run.
  await seed.saveSubtask({
    id: "t_queued", workspaceID: "wq", creatorType: "agent", creatorAgentID: "a", assigneeID: "a", title: "Completion", instruction: "Finish",
    mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 0, createdAt: Date.now() - 10 * 60_000, deadlineAt: Date.now() - 5 * 60_000,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  const patches: any[] = []
  service.attach({ events: { emit: async (name: string, data: any) => { if (name === "patches") patches.push(data) } } })
  try {
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.runs).some((run: any) => run.status === "running")
    }, 5_000)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const live = (next.state.messages.w as any[]).find((message) => message.id === "m_placeholder")
      return live?.streaming === true
    }, 5_000)
    // The reaper's false terminal state lands while the native run is still working.
    const foreign = new V2Store(ctx)
    await foreign.load()
    const stale = foreign.cloneSubtask("t_late")!
    stale.state = "replied"
    stale.outcome = "failed"
    stale.error = "The work deadline passed before it could finish."
    stale.failure = { kind: "delivery", reason: "deadline-exceeded" }
    stale.activeRunID = undefined
    stale.claimedBy = undefined
    stale.leaseUntil = undefined
    stale.retryAfter = undefined
    stale.repliedAt = Date.now()
    stale.finishedAt = Date.now()
    await foreign.saveSubtask(stale)
    // The placeholder is settled before the late result arrives (the incident).
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const live = (next.state.messages.w as any[]).find((message) => message.id === "m_placeholder")
      return live?.streaming === false && live?.text === "Reply interrupted." && live?.interrupted === true
    }, 5_000)
    assert.equal(((await handlers.snapshot({ directory })).state.subtasks.t_late as any).status, "stalled")
    releaseWait()
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks.t_late as any)?.outcome === "succeeded"
    }, 5_000)
    const after = await handlers.snapshot({ directory })
    const task = after.state.subtasks.t_late as any
    assert.equal(task.state, "replied")
    assert.equal(task.outcome, "succeeded")
    assert.equal(task.status, "replied", "the late card ends replied, not failed or stalled")
    assert.equal(task.failure, undefined, "the false delivery cause is cleared")
    assert.equal(task.error, undefined, "no false deadline line survives")
    assert.equal(task.resultMessageID, "m_placeholder")
    const repaired = (after.state.messages.w as any[]).find((message) => message.id === "m_placeholder") as any
    assert.equal(repaired.text, "The late final answer.")
    assert.equal(repaired.interrupted, false, "the placeholder is no longer interrupted")
    assert.equal(repaired.streaming, false)
    const messageUpserts = patches
      .flatMap((batch) => batch.entries ?? [])
      .flatMap((entry: any) => entry.entities ?? entry.changes ?? [])
      .filter((change: any) => change.entity === "message" && change.op === "upsert" && change.message?.id === "m_placeholder")
    assert.ok(
      messageUpserts.some((change: any) => change.message.text === "The late final answer." && change.message.interrupted === false),
      "the repair publishes a durable message upsert",
    )
    assert.equal(
      (after.state.messages.w as any[]).find((message) => message.id === "m_existing")?.text,
      existingReply,
      "the existing real answer is preserved",
    )
    const queued = after.state.subtasks.t_queued as any
    assert.equal(queued.state, "pending")
    assert.equal(queued.status, "pending", "an old delivery deadline never retires queued work")
    assert.equal(queued.failure, undefined)
    const failures = await handlers["logs.recent"]({ directory, event: "task.failed", limit: 50 })
    assert.equal(failures.entries.some((entry: any) => entry.taskID === "t_late" || entry.taskID === "t_queued"), false)
    const terminal = await handlers["logs.recent"]({ directory, event: "failure.terminal", limit: 50 })
    assert.equal(terminal.entries.some((entry: any) => entry.taskID === "t_late" || entry.taskID === "t_queued"), false)
    const recovered = await handlers["logs.recent"]({ directory, event: "task.recovered", limit: 20 })
    assert.equal(recovered.entries.length, 1)
    assert.equal(recovered.entries[0].taskID, "t_late")
    assert.equal(recovered.entries[0].from, "stalled")
    assert.equal(recovered.entries[0].to, "replied")
    assert.equal(recovered.entries[0].reason, "late-success")
    assert.equal(recovered.entries[0].messageID, "m_placeholder")
    assert.ok(!JSON.stringify(recovered.entries[0]).includes("late final answer"), "recovery logs never carry content")
  } finally {
    releaseWait()
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(queuedDirectory, { recursive: true, force: true })
  }
})

test("ticket169: an empty native result never promotes a stalled live partial to success", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-169-empty-late-"))
  const { ctx, emitEvent } = fakeContext()
  let releaseWait: () => void = () => {}
  const waitGate = new Promise<void>((resolve) => { releaseWait = resolve })
  ;(ctx.session as any).wait = async () => { await waitGate }
  ;(ctx.session as any).context = async () => ({
    data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "" }] }],
  })
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { nextSeq: 10 })
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Empty late", instruction: "Do",
    mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 0, createdAt: 1,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    let sessionID = ""
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const run = Object.values(next.state.runs).find((item: any) => item.status === "running") as any
      sessionID = run?.sessionID ?? ""
      return Boolean(sessionID)
    }, 5_000)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.messages.w as any[]).some((message) => message.taskID === "t" && message.streaming)
    }, 5_000)
    emitEvent({ id: "evt_empty_late_delta", type: "session.text.delta", data: { sessionID, delta: "A live partial answer." } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.messages.w as any[]).some((message) => message.taskID === "t" && message.text === "A live partial answer.")
    }, 5_000)
    const foreign = new V2Store(ctx)
    await foreign.load()
    const stale = foreign.cloneSubtask("t")!
    stale.state = "replied"
    stale.outcome = "failed"
    stale.error = "The work deadline passed before it could finish."
    stale.failure = { kind: "delivery", reason: "deadline-exceeded" }
    stale.activeRunID = undefined
    stale.claimedBy = undefined
    stale.leaseUntil = undefined
    stale.repliedAt = Date.now()
    stale.finishedAt = Date.now()
    await foreign.saveSubtask(stale)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks.t as any)?.status === "stalled"
    }, 5_000)
    releaseWait()
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.messages.w as any[]).some((message) => message.taskID === "t" && message.streaming === false && message.text === "A live partial answer.")
    }, 5_000)
    const after = await handlers.snapshot({ directory })
    const task = after.state.subtasks.t as any
    assert.equal(task.state, "replied")
    assert.equal(task.outcome, "failed", "an empty native result never becomes success")
    assert.equal(task.status, "stalled")
    assert.equal(task.failure.kind, "delivery", "the queue cause is preserved, never rewritten as a false success")
    assert.equal(task.resultMessageID, undefined)
    const message = (after.state.messages.w as any[]).find((item) => item.taskID === "t") as any
    assert.equal(message.text, "A live partial answer.")
    assert.equal(message.streaming, false)
    assert.equal(message.interrupted, false, "a substantive partial is preserved, not interrupted")
    const recovered = await handlers["logs.recent"]({ directory, event: "task.recovered", limit: 20 })
    assert.equal(recovered.entries.length, 0, "an empty late result is not a recovery")
  } finally {
    releaseWait()
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket169: a late delta cannot resurrect a settled row", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-169-late-delta-"))
  const { ctx, emitEvent } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { nextSeq: 2 })
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Done", instruction: "Do",
    mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 0, createdAt: 1,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks.t as any)?.state === "replied"
    }, 5_000)
    const before = await handlers.snapshot({ directory })
    const sessionID = String((Object.values(before.state.bindings)[0] as any)?.sessionID ?? "")
    assert.ok(sessionID)
    const settled = (before.state.messages.w as any[]).find((message) => message.taskID === "t") as any
    assert.equal(settled.text, "OK")
    emitEvent({ id: "evt_late_delta", type: "session.text.delta", data: { sessionID, delta: " and more" } })
    await new Promise((resolve) => setTimeout(resolve, 30))
    const after = await handlers.snapshot({ directory })
    const message = (after.state.messages.w as any[]).find((item) => item.id === settled.id) as any
    assert.equal(message.text, "OK", "a late delta never rewrites the exact final text")
    assert.equal(message.streaming, false)
    assert.equal(message.interrupted, false)
    assert.equal((after.state.messages.w as any[]).filter((item) => item.taskID === "t" && item.author === "agent").length, 1)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket148: a working row with no claim and no local run is repaired", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-148-no-claim-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { paused: true })
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Orphan", instruction: "Do",
    mode: "research", state: "working", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 1, createdAt: 1,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const snapshot = await handlers.snapshot({ directory })
    const row = snapshot.state.subtasks.t as any
    assert.equal(row.state, "pending")
    assert.equal(row.claimedBy, undefined)
    assert.equal(row.leaseUntil, undefined)
    assert.equal(row.attempts, 1, "repair never consumes an attempt")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket148: stop releases local claims and preserves foreign claims", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-148-stop-claims-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  const leaseUntil = Date.now() + 60_000
  await seed.saveSubtask({
    id: "t_local", workspaceID: "w", creatorType: "user", title: "Local", instruction: "Do",
    mode: "research", state: "working", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 1, claimedBy: "run_local", activeRunID: "run_local", leaseUntil, createdAt: 1,
  })
  await seed.saveSubtask({
    id: "t_foreign", workspaceID: "w", creatorType: "user", title: "Foreign", instruction: "Do",
    mode: "research", state: "working", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 1, claimedBy: "run_foreign", activeRunID: "run_foreign", leaseUntil, createdAt: 2,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    // Register the local run identity without starting native work: stop() may
    // only clear claims owned by this service's run set.
    service.registerLocalRunForTest({
      id: "run_local", subtaskID: "t_local", workspaceID: "w", agentID: "a", sessionID: "session_local", status: "running", startedAt: 1,
    } as any)
  } finally {
    await stop()
  }
  try {
    const reloaded = new V2Store(ctx)
    await reloaded.load()
    const local = reloaded.subtask("t_local") as any
    const foreign = reloaded.subtask("t_foreign") as any
    assert.equal(local.claimedBy, undefined)
    assert.equal(local.leaseUntil, undefined)
    assert.equal(foreign.claimedBy, "run_foreign")
    assert.equal(foreign.leaseUntil, leaseUntil)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("exhausted attempts stall with the reason preserved", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-queue-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory)
  await seed.saveSubtask({ id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Tired", instruction: "Do", mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false, attempts: 5, error: "boom", createdAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks as any).t?.state === "replied"
    })
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.subtasks.t.outcome, "failed")
    assert.equal((after.state.subtasks.t as any).status, "stalled")
    assert.equal((after.state.subtasks.t as any).failure.kind, "attempts")
    assert.equal(after.state.subtasks.t.error, "boom")
    assert.ok(
      !((after.state.messages.w ?? []) as any[]).some((message) => message.text.includes("Subtask failed")),
      "exhausted work announces one failure through the canonical terminal record, not a duplicate system line",
    )
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("handoff creates a pending typed hop with correlation and dedupes resubmission", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-queue-"))
  const { ctx, tools } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const nova = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const sage = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Sage" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "site", directory, memberIDs: [nova.result.id, sage.result.id], leaderID: nova.result.id },
    })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Coordinate" } })
    let sessionID = ""
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const binding = Object.values(next.state.bindings)[0] as any
      if (!binding) return false
      sessionID = binding.sessionID
      return true
    })
    mkdirSync(join(directory, ".ensemble", "handoffs"), { recursive: true })
    writeFileSync(join(directory, ".ensemble", "handoffs", "task-nova-sage-1.md"), "---\nensemble: handoff\ntask: task\n---\n# Handoff\n")
    const input = { task: "task", summary: "summary", path: ".ensemble/handoffs/task-nova-sage-1.md", to: "Sage", maxHops: 1 }
    const first = await tools.get("handoff").execute(input, { sessionID })
    assert.match(first.content, /Handed to \$Sage/)
    const second = await tools.get("handoff").execute(input, { sessionID })
    assert.match(second.content, /Already handed to \$Sage/)
    const after = await handlers.snapshot({ directory })
    const handoffs = Object.values(after.state.subtasks).filter((task: any) => task.workKind === "handoff")
    assert.equal(handoffs.length, 1)
    // The hop runs through the queue immediately: pending, claimed working,
    // or retrying are all valid in-flight reads; it must not be a terminal
    // registration row anymore.
    assert.ok(["pending", "working", "retrying"].includes((handoffs[0] as any).state))
    assert.equal((handoffs[0] as any).assigneeID, sage.result.id)
    assert.equal((handoffs[0] as any).creatorAgentID, nova.result.id)
    assert.ok((handoffs[0] as any).queueKey)
    assert.ok((handoffs[0] as any).deadlineAt)
    assert.ok(((handoffs[0] as any).handoff as any)?.correlationID)
    assert.equal(((handoffs[0] as any).handoff as any)?.recipientID, sage.result.id)
    assert.equal(((handoffs[0] as any).handoff as any)?.senderID, nova.result.id)
    // Ticket #73: the group ack is a concise system line — policy and the
    // ref stay in the tool result, never in an agent bubble.
    const ack = (after.state.messages[workspace.result.id] as any[]).find((message: any) => message.text.includes("Handed to $Sage"))
    assert.ok(ack)
    assert.equal(ack.author, "system")
    assert.equal(ack.text, "Handed to $Sage · summary")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("task_status exposes the derived lifecycle facts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-queue-"))
  const { ctx, tools } = fakeContext()
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 300)) }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const nova = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const sage = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Sage" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "site", directory, memberIDs: [nova.result.id, sage.result.id], leaderID: nova.result.id },
    })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Coordinate" } })
    let sessionID = ""
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const binding = Object.values(next.state.bindings)[0] as any
      if (!binding) return false
      sessionID = binding.sessionID
      return true
    })
    await tools.get("delegate").execute({ maxHops: 1, assignee: "Sage", title: "Child", instruction: "Check" }, { sessionID })
    // Derived lifecycle facts are asserted once the child is actually claimed;
    // an immediate read can legitimately observe the queued row first.
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const child = Object.values(next.state.subtasks).find((item: any) => item.title === "Child") as any
      return child?.state === "working" && Boolean(child.leaseUntil)
    }, 5_000)
    const status = await tools.get("task_status").execute({}, { sessionID })
    const rows = JSON.parse(status.content)
    const child = rows.find((row: any) => row.title === "Child")
    assert.ok(child)
    assert.ok(["pending", "working", "retrying"].includes(child.status))
    assert.equal(typeof child.attempts, "number")
    assert.ok(child.queueKey)
    assert.ok("leaseUntil" in child)
    assert.ok("deadlineAt" in child)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket68: an order with no native block produces no approval and answers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-68-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Do the thing" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.state === "replied")
    })
    const after = await handlers.snapshot({ directory })
    const task = Object.values(after.state.subtasks)[0] as any
    assert.equal(task.outcome, "succeeded")
    assert.equal(Object.values(after.state.approvals).filter((approval: any) => approval.status === "pending").length, 0)
    assert.ok(after.state.messages[workspace.result.id].some((message: any) => message.author === "agent" && message.text === "OK"))
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket68: restart recovery requeues dead work without a phantom approval", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-68-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory)
  await seed.saveSubtask({ id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Stale", instruction: "Do work", mode: "research", state: "working", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false, attempts: 1, createdAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const snapshot = await handlers.snapshot({ directory })
    assert.equal(snapshot.state.subtasks.t.interrupted, false)
    assert.equal(Object.values(snapshot.state.approvals).filter((approval: any) => approval.status === "pending").length, 0)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return next.state.subtasks.t.state === "replied"
    })
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.subtasks.t.outcome, "succeeded")
    assert.equal(Object.values(after.state.approvals).filter((approval: any) => approval.status === "pending").length, 0)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket68: a native permission request gates work and resolves through the host", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-68-"))
  const { ctx, emitEvent } = fakeContext()
  const replies: any[] = []
  ;(ctx as any).permission = { reply: async (input: any) => { replies.push(input) } }
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 400)) }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Run it" } })
    let sessionID = ""
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const binding = Object.values(next.state.bindings)[0] as any
      if (!binding) return false
      sessionID = binding.sessionID
      return true
    })
    emitEvent({ type: "permission.asked", data: { sessionID, id: "perm_1", action: "shell", resources: ["echo hi"] } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.approvals).some((approval: any) => approval.status === "pending" && approval.kind === "native")
    })
    const blocked = await handlers.snapshot({ directory })
    const native = Object.values(blocked.state.approvals).find((approval: any) => approval.kind === "native") as any
    assert.equal(native.source, "native")
    assert.equal(native.payload.permissionID, "perm_1")
    assert.equal(native.payload.sessionID, sessionID)
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Follow-up" } })
    await new Promise((resolve) => setTimeout(resolve, 150))
    const held = await handlers.snapshot({ directory })
    const followup = Object.values(held.state.subtasks).find((task: any) => task.title === "Follow-up") as any
    assert.ok(followup)
    assert.equal(followup.state, "pending")
    emitEvent({ type: "permission.replied", data: { sessionID, requestID: "perm_1", reply: "once" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.approvals[native.id] as any)?.status === "approved"
    })
    assert.equal(replies.length, 0)
    const resolved = await handlers.invoke({ directory, action: "approval.resolve", payload: { id: native.id, approve: true } })
    assert.equal(resolved.ok, true)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.title === "Run it" && task.state === "replied")
    }, 3000)
    const done = await handlers.snapshot({ directory })
    assert.equal((done.state.subtasks[Object.values(done.state.subtasks).find((task: any) => task.title === "Run it")!.id] as any).outcome, "succeeded")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket68: resolving a native approval replies on the native session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-68-"))
  const { ctx, emitEvent } = fakeContext()
  const replies: any[] = []
  ;(ctx as any).permission = { reply: async (input: any) => { replies.push(input) } }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Hello" } })
    let sessionID = ""
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const binding = Object.values(next.state.bindings)[0] as any
      if (!binding) return false
      sessionID = binding.sessionID
      return true
    })
    emitEvent({ type: "permission.asked", data: { sessionID, id: "perm_9", action: "read", resources: ["/etc/hosts"] } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.approvals).some((approval: any) => approval.status === "pending" && approval.kind === "native")
    })
    const before = await handlers.snapshot({ directory })
    const native = Object.values(before.state.approvals).find((approval: any) => approval.kind === "native") as any
    const resolved = await handlers.invoke({ directory, action: "approval.resolve", payload: { id: native.id, approve: false } })
    assert.equal(resolved.ok, true)
    assert.equal(resolved.result.status, "rejected")
    assert.equal(replies.length, 1)
    assert.equal(replies[0].sessionID, sessionID)
    assert.equal(replies[0].requestID, "perm_9")
    assert.equal(replies[0].decision, "reject")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket68: ask_person parks the run until the user answers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-68-"))
  const { ctx, tools } = fakeContext()
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 400)) }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Decide this" } })
    let sessionID = ""
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const binding = Object.values(next.state.bindings)[0] as any
      if (!binding) return false
      sessionID = binding.sessionID
      // The ask must land inside the live run; wait for the claim itself.
      const task = Object.values(next.state.subtasks).find((item: any) => item.title === "Decide this") as any
      return Boolean(task) && Object.values(next.state.runs ?? {}).some((run: any) => run.subtaskID === task.id && run.status === "running")
    })
    const asked = await tools.get("ask_person").execute({ question: "Which API?" }, { sessionID })
    assert.match(asked.content, /Waiting/)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).every((task: any) => task.activeRunID === undefined)
    }, 3000)
    const parked = await handlers.snapshot({ directory })
    const task = Object.values(parked.state.subtasks)[0] as any
    assert.equal(task.state, "working")
    assert.ok(task.approvalID)
    const approval = parked.state.approvals[task.approvalID] as any
    assert.equal(approval.kind, "ask_person")
    assert.equal(approval.source, "agent")
    assert.equal(approval.status, "pending")
    assert.equal(task.resultMessageID, undefined)
    const agentMessages = parked.state.messages[workspace.result.id].filter((message: any) => message.author === "agent")
    assert.ok(agentMessages.every((message: any) => message.text !== "OK"))
    const answered = await handlers.invoke({ directory, action: "approval.resolve", payload: { id: approval.id, approve: true, resolution: "Use v2" } })
    assert.equal(answered.ok, true)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((item: any) => item.state === "replied")
    }, 3000)
    const done = await handlers.snapshot({ directory })
    const finished = Object.values(done.state.subtasks)[0] as any
    assert.equal(finished.outcome, "succeeded")
    assert.match(finished.instruction, /Use v2/)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket68: settling work rejects stale product approvals of every kind", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-68-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory)
  await seed.saveSubtask({ id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Work", instruction: "Do", mode: "research", state: "working", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false, attempts: 0, createdAt: 1 })
  await seed.saveApproval({ id: "out", workspaceID: "w", subtaskID: "t", agentID: "a", kind: "outside_roster", title: "Contact", detail: "Check", status: "pending", createdAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const cancelled = await handlers.invoke({ directory, action: "task.cancel", payload: { id: "t" } })
    assert.equal(cancelled.ok, true)
    const after = await handlers.snapshot({ directory })
    assert.equal((after.state.approvals.out as any).status, "rejected")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket75: an empty assistant reply is retried, never a silent success", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-75-empty-"))
  const { ctx } = fakeContext()
  ctx.session.context = async () => ({
    data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "   " }] }],
  })
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: "w", text: "introduce yourself" } })
    await waitFor(async () => {
      const snapshot = await handlers.snapshot({ directory })
      return Object.values(snapshot.state.subtasks).some((task: any) => task.error === "The agent produced no answer.")
    }, 15_000)
    const snapshot = await handlers.snapshot({ directory })
    const tasks = Object.values(snapshot.state.subtasks) as any[]
    const task = tasks.find((item) => item.title === "introduce yourself")
    assert.ok(task)
    assert.equal(task.error, "The agent produced no answer.")
    assert.notEqual(task.state, "replied")
    assert.equal(tasks.some((item) => item.workKind === "handoff"), false)
    const retryEvents = snapshot.state.messages.w.filter((message: any) => /Retrying in \d+s \(attempt 2\/5\): The agent produced no answer\./.test(message.text))
    assert.equal(retryEvents.length, 1, "one durable event names the retry ETA and reason")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket144: maintenance claims a future retry without an unrelated schedule", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-144-retry-wake-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory)
  const retryAt = Date.now() + 1_500
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Wake retry", instruction: "Do",
    mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 1, error: "boom", retryAfter: retryAt, createdAt: 1,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const task = next.state.subtasks.t
      return task?.state === "replied" && task.attempts === 2
    }, 6_000)
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.subtasks.t.outcome, "succeeded")
    assert.equal(after.state.subtasks.t.attempts, 2)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket144: an uncertain tool outcome parks for review instead of auto-retrying", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-144-uncertain-"))
  const { ctx } = fakeContext()
  const at = Date.now() + 60_000
  ;(ctx.session as any).context = async () => ({
    data: [
      { type: "assistant", time: { created: at }, content: [{ type: "tool", name: "bash", state: { status: "failed" } }] },
      { type: "idle", outcome: "failed", time: { created: at }, error: { message: "provider failed" } },
    ],
  })
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: "w", text: "run the risky tool" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const task = Object.values(next.state.subtasks).find((item: any) => item.title === "run the risky tool") as any
      return task?.interrupted === true && Boolean(task.approvalID)
    }, 5_000)
    const after = await handlers.snapshot({ directory })
    const task = Object.values(after.state.subtasks).find((item: any) => item.title === "run the risky tool") as any
    assert.equal(task.state, "pending")
    assert.equal(task.retryAfter, undefined, "uncertain work is not put on a timer")
    assert.match(task.error, /tool outcome is uncertain/i)
    const approval = after.state.approvals[task.approvalID]
    assert.equal(approval.kind, "interrupted")
    assert.equal(approval.status, "pending")
    assert.ok(after.state.messages.w.some((message: any) => message.text.startsWith("Approval needed:")))
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket145: a terminal task failure writes a self-contained failure record", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-145-failure-"))
  const { ctx } = fakeContext()
  ;(ctx.session as any).context = async () => ({
    data: [{ type: "idle", outcome: "failed", error: { type: "provider.internal", message: "quota exhausted" } }],
  })
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory)
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Terminal", instruction: "Do",
    mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 4, dispatchGroupID: "g1", createdAt: 1,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return next.state.subtasks.t?.state === "replied" && next.state.subtasks.t?.outcome === "failed"
    }, 5_000)
    const failedRow = (await handlers.snapshot({ directory })).state.subtasks.t as any
    assert.equal(failedRow.status, "failed", "a real native execution error stays failed")
    assert.equal(failedRow.failure.kind, "native")
    assert.equal(failedRow.failure.reason, "attempts-exhausted")
    const logs = await handlers["logs.recent"]({ directory, limit: 100 })
    const terminal = logs.entries.find((entry: any) => entry.event === "failure.terminal" && entry.taskID === "t") as any
    assert.ok(terminal, "the failure sink carries one self-contained terminal record")
    assert.equal(terminal.failureClass, "provider")
    assert.equal(terminal.attempts, 5)
    assert.equal(terminal.dispatchGroupID, "g1")
    assert.equal(terminal.decision.type, "terminal")
    assert.equal(terminal.decision.reason, "attempts-exhausted")
    assert.match(terminal.error.message, /quota exhausted/)
    assert.ok(terminal.error.stack === undefined || typeof terminal.error.stack === "string")
    const events = logs.entries.map((entry: any) => entry.event)
    assert.ok(events.includes("task.claimed"))
    assert.ok(events.includes("task.failed"))
    assert.equal(logs.stats.content, false, "conversation text is off by default")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket145: an uncertain park carries tool outcomes and the approval decision", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-145-park-"))
  const { ctx } = fakeContext()
  const at = Date.now() + 60_000
  ;(ctx.session as any).context = async () => ({
    data: [
      { type: "assistant", time: { created: at }, content: [{ type: "tool", name: "bash", state: { status: "failed", error: { message: "exit 1", code: "E_TOOL" } } }] },
      { type: "idle", outcome: "failed", time: { created: at }, error: { message: "provider failed" } },
    ],
  })
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: "w", text: "risky" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.interrupted === true && Boolean(task.approvalID))
    }, 5_000)
    const after = await handlers.snapshot({ directory })
    const task = Object.values(after.state.subtasks).find((item: any) => item.interrupted === true) as any
    const logs = await handlers["logs.recent"]({ directory, limit: 100 })
    const parked = logs.entries.find((entry: any) => entry.event === "failure.parked" && entry.taskID === task.id) as any
    assert.ok(parked)
    assert.equal(parked.failureClass, "uncertain")
    assert.equal(parked.decision.type, "park")
    assert.equal(parked.decision.approvalID, task.approvalID)
    assert.equal(parked.toolOutcomes[0].name, "bash")
    assert.equal(parked.toolOutcomes[0].status, "failed")
    assert.equal(parked.toolOutcomes[0].code, "E_TOOL")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket75: a waiting parent with terminal children is reconciled, not stuck working", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-75-reconcile-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory)
  await seed.saveSubtask({ id: "parent", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Parent", instruction: "Do parent", mode: "research", state: "working", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: true, attempts: 1, createdAt: 1 })
  await seed.saveSubtask({ id: "child", workspaceID: "w", parentID: "parent", creatorType: "agent", creatorAgentID: "a", assigneeID: "a", title: "Child", instruction: "Do child", mode: "research", state: "replied", stage: "initial", outcome: "succeeded", interrupted: false, awaitingChildren: false, attempts: 1, createdAt: 2, repliedAt: 3, finishedAt: 3 })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const snapshot = await handlers.snapshot({ directory })
      return snapshot.state.subtasks.parent?.state === "replied"
    }, 15_000)
    const snapshot = await handlers.snapshot({ directory })
    const parent = snapshot.state.subtasks.parent as any
    assert.equal(parent.state, "replied")
    assert.equal(parent.awaitingChildren, false)
    assert.notEqual(parent.state, "working")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket76: snapshot settles a streaming message whose task is terminal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-76-stream-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { nextSeq: 2 })
  await seed.saveSubtask({ id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Done", instruction: "Do", mode: "research", state: "replied", stage: "initial", outcome: "succeeded", interrupted: false, awaitingChildren: false, attempts: 1, createdAt: 1, repliedAt: 2, finishedAt: 2 })
  await seed.saveMessage({ id: "m", workspaceID: "w", seq: 1, author: "agent", agentID: "a", taskID: "t", text: "partial reply", kind: "text", streaming: true, createdAt: 2 })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const snapshot = await handlers.snapshot({ directory })
    const message = snapshot.state.messages.w.find((item: any) => item.id === "m")
    assert.ok(message)
    assert.equal(message.streaming, false)
    assert.equal(message.text, "partial reply")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket148: streaming rows survive load only while their lease is live", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-148-stream-lease-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { paused: true, nextSeq: 10 })
  const liveUntil = Date.now() + 60_000
  await seed.saveSubtask({ id: "t_live", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Live", instruction: "Do", mode: "research", state: "working", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false, attempts: 1, claimedBy: "run_live", leaseUntil: liveUntil, createdAt: 1 })
  await seed.saveSubtask({ id: "t_dead", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Dead", instruction: "Do", mode: "research", state: "working", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false, attempts: 1, claimedBy: "run_dead", leaseUntil: 1, createdAt: 2 })
  const nowMs = Date.now()
  await seed.saveSubtask({ id: "t_done", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Done", instruction: "Do", mode: "research", state: "replied", stage: "initial", outcome: "succeeded", interrupted: false, awaitingChildren: false, attempts: 1, createdAt: nowMs - 1_000, repliedAt: nowMs, finishedAt: nowMs })
  await seed.saveMessage({ id: "m_live", workspaceID: "w", seq: 1, author: "agent", agentID: "a", taskID: "t_live", text: "live partial", kind: "text", streaming: true, createdAt: 1, updatedAt: Date.now() })
  await seed.saveMessage({ id: "m_dead", workspaceID: "w", seq: 2, author: "agent", agentID: "a", taskID: "t_dead", text: "dead partial", kind: "text", streaming: true, createdAt: 1, updatedAt: 1 })
  await seed.saveMessage({ id: "m_done", workspaceID: "w", seq: 3, author: "agent", agentID: "a", taskID: "t_done", text: "done partial", kind: "text", streaming: true, createdAt: 1, updatedAt: 1 })
  await seed.saveMessage({ id: "m_old", workspaceID: "w", seq: 4, author: "agent", agentID: "a", text: "orphan old", kind: "text", streaming: true, createdAt: 1, updatedAt: 1 })
  await seed.saveMessage({ id: "m_fresh", workspaceID: "w", seq: 5, author: "agent", agentID: "a", text: "orphan fresh", kind: "text", streaming: true, createdAt: Date.now(), updatedAt: Date.now() })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const snapshot = await handlers.snapshot({ directory })
    const find = (id: string) => (snapshot.state.messages.w as any[]).find((message) => message.id === id)
    assert.equal(find("m_live").streaming, true, "a live lease keeps its row open across load")
    assert.equal(find("m_live").interrupted, undefined)
    assert.equal(find("m_dead").streaming, false, "an expired task lease settles the row")
    // Ticket #169: a lost lease is a retry/queue state; a substantive partial
    // reply is preserved instead of being rewritten as an interruption.
    assert.equal(find("m_dead").interrupted, false)
    assert.equal(find("m_done").streaming, false, "a terminal task settles the row")
    assert.equal(find("m_done").interrupted, false)
    assert.equal(find("m_old").streaming, false, "an old taskless row settles")
    assert.equal(find("m_old").interrupted, true)
    assert.equal(find("m_fresh").streaming, true, "a fresh taskless row may still be live")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket76: sequential user tasks settle in order with no stuck work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-76-seq-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const nova = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [nova.result.id], leaderID: nova.result.id } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "first" } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "second" } })
    await waitFor(async () => {
      const snapshot = await handlers.snapshot({ directory })
      return Object.values(snapshot.state.subtasks).every((task: any) => task.state === "replied")
    }, 15_000)
    const snapshot = await handlers.snapshot({ directory })
    const tasks = Object.values(snapshot.state.subtasks) as any[]
    assert.deepEqual(tasks.map((task) => task.title).sort(), ["first", "second"])
    assert.equal(tasks.some((task) => task.state !== "replied"), false)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket76: a delegated child and a later user task both settle in order", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-76-delegate-"))
  const { ctx, tools } = fakeContext()
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 200)) }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const nova = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const sage = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Sage" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [nova.result.id, sage.result.id], leaderID: nova.result.id } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "coordinate" } })
    let sessionID = ""
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const binding = Object.values(next.state.bindings).find((item: any) => item.agentID === nova.result.id) as any
      if (!binding) return false
      sessionID = binding.sessionID
      return true
    })
    await tools.get("delegate").execute({ maxHops: 1, assignee: "Sage", title: "child", instruction: "check" }, { sessionID })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "later" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).every((task: any) => task.state === "replied")
    }, 15_000)
    const next = await handlers.snapshot({ directory })
    const tasks = Object.values(next.state.subtasks) as any[]
    assert.deepEqual(tasks.filter((task) => task.workKind !== "handoff").map((task) => task.title).sort(), ["child", "coordinate", "later"])
    assert.equal(tasks.some((task) => task.state === "working"), false)
    assert.equal(tasks.some((task) => task.awaitingChildren), false)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

// --- v5.8 ticket #101: deliberate assigned-skill invocation -----------------

const skillAgent = (id: string, name: string, skillbox: string[], archived = false): Agent => ({
  id,
  name,
  title: "",
  role: "",
  mainModel: { providerID: "probe", modelID: "probe-model" },
  backupModels: [],
  skillbox,
  color: "cyan",
  archived,
  pendingSettings: false,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
})

const skillWorkspace: Workspace = {
  id: "w",
  name: "site",
  directory: "",
  leaderID: "nova",
  memberIDs: ["nova", "sage"],
  synthesis: true,
  archived: false,
  paused: false,
  nextSeq: 1,
  createdAt: 1,
  lastActiveAt: 1,
}

async function seedSkillWorkspace(directory: string, ctx: any, agents: Agent[], patch: Partial<Workspace> = {}): Promise<void> {
  const seed = new V2Store(ctx)
  await seed.load()
  for (const agent of agents) await seed.saveAgent(agent)
  await seed.saveWorkspace({ ...skillWorkspace, directory, ...patch })
}

test("skill.send delivers the exact text to the assigned owner as one peer turn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-skill-send-"))
  const { ctx, prompts } = fakeContext()
  ctx.skill.list = async () => [
    { id: "review", name: "Review", description: "Thorough code review" },
    { id: "deploy", name: "Deploy", description: "Ship the release" },
  ]
  await seedSkillWorkspace(directory, ctx, [
    skillAgent("nova", "Nova", ["review"]),
    skillAgent("sage", "Sage", ["deploy"]),
  ])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => (await handlers.snapshot({ directory })).skills.length === 2)
    const text = "$Nova /review check this carefully"
    const response = await handlers.invoke({ directory, action: "skill.send", payload: { workspaceID: "w", text } })
    assert.equal(response.ok, true, JSON.stringify(response.error))
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.creatorType === "user" && task.state === "replied")
    })
    const next = await handlers.snapshot({ directory })
    const userTasks = Object.values(next.state.subtasks).filter((task: any) => task.creatorType === "user") as any[]
    assert.equal(userTasks.length, 1, "one work row for the addressed agent")
    assert.equal(userTasks[0].workKind, "turn")
    assert.equal(userTasks[0].assigneeID, "nova")
    assert.equal(userTasks[0].instruction, text, "the exact user text is the instruction")
    const messages = next.state.messages.w ?? []
    assert.equal(messages.find((message: any) => message.author === "user")?.text, text)
    const replies = messages.filter((message: any) => message.agentID === "nova" && message.taskID === userTasks[0].id)
    assert.equal(replies.length, 1, "one reply, attributed to the owner")
    assert.equal(replies[0].text, "OK")
    const prompt = prompts.find((item) => item.text.includes(text))
    assert.ok(prompt, "the owner receives the exact text in its turn prompt")
    assert.equal("skills" in prompt, false, "no prompt skill attachment bypass is used")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("message.send also accepts a leader-owned message-start skill", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-skill-leader-"))
  const { ctx } = fakeContext()
  ctx.skill.list = async () => [{ id: "review", name: "Review", description: "Thorough code review" }]
  await seedSkillWorkspace(directory, ctx, [
    skillAgent("nova", "Nova", ["review"]),
    skillAgent("sage", "Sage", []),
  ])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => (await handlers.snapshot({ directory })).skills.length === 1)
    const text = "/review check the release"
    const response = await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: "w", text } })
    assert.equal(response.ok, true, JSON.stringify(response.error))
    const next = await handlers.snapshot({ directory })
    const userTasks = Object.values(next.state.subtasks).filter((task: any) => task.creatorType === "user") as any[]
    assert.equal(userTasks.length, 1)
    assert.equal(userTasks[0].assigneeID, "nova")
    assert.equal(userTasks[0].instruction, text)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("explicit recipient ids cannot bypass skill ownership or routing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-skill-explicit-"))
  const { ctx } = fakeContext()
  ctx.skill.list = async () => [{ id: "review", name: "Review", description: "Thorough code review" }]
  await seedSkillWorkspace(directory, ctx, [
    skillAgent("nova", "Nova", ["review"]),
    skillAgent("sage", "Sage", []),
  ])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => (await handlers.snapshot({ directory })).skills.length === 1)
    const text = "$Nova /review check this"
    const bypass = await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: "w", text, recipientIDs: ["sage"] } })
    assert.equal(bypass.ok, false)
    assert.equal(bypass.error?.code, "skill_recipient_mismatch")
    assert.ok(bypass.error?.message.includes("$Nova"), bypass.error?.message)
    let next = await handlers.snapshot({ directory })
    assert.deepEqual(next.state.messages.w ?? [], [], "a mismatched explicit recipient appends nothing")
    assert.deepEqual(Object.values(next.state.subtasks), [], "a mismatched explicit recipient creates no work")

    const allowed = await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: "w", text, recipientIDs: ["nova"] } })
    assert.equal(allowed.ok, true, JSON.stringify(allowed.error))
    next = await handlers.snapshot({ directory })
    const task = Object.values(next.state.subtasks).find((item: any) => item.creatorType === "user") as any
    assert.equal(task.assigneeID, "nova", "the planner owner still receives the skill turn")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("skill messages keep file-reference blocks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-skill-refs-"))
  writeFileSync(join(directory, "notes.md"), "hello")
  const { ctx } = fakeContext()
  ctx.skill.list = async () => [{ id: "review", name: "Review", description: "Thorough code review" }]
  await seedSkillWorkspace(directory, ctx, [skillAgent("nova", "Nova", ["review"])])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => (await handlers.snapshot({ directory })).skills.length === 1)
    const text = "$Nova /review @notes.md please"
    const response = await handlers.invoke({ directory, action: "skill.send", payload: { workspaceID: "w", text } })
    assert.equal(response.ok, true, JSON.stringify(response.error))
    const next = await handlers.snapshot({ directory })
    const task = Object.values(next.state.subtasks).find((item: any) => item.creatorType === "user") as any
    assert.match(task.instruction, /Referenced files:\n- notes\.md/)
    assert.ok(task.instruction.startsWith(text), "the exact user text stays first")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("invalid skill references reject atomically before any message or task", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-skill-invalid-"))
  const { ctx } = fakeContext()
  ctx.skill.list = async () => [
    { id: "review", name: "Review", description: "Thorough code review" },
    { id: "deploy", name: "Deploy", description: "Ship the release" },
  ]
  await seedSkillWorkspace(directory, ctx, [
    skillAgent("nova", "Nova", ["review", "missing"]),
    skillAgent("sage", "Sage", ["deploy"]),
    skillAgent("echo", "Echo", ["review"]),
    skillAgent("retired", "Retired", ["review"], true),
  ])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => (await handlers.snapshot({ directory })).skills.length === 2)
    const cases = [
      { text: "$Nova /deploy check this", code: "skill_not_assigned", includes: ["/deploy", "$Sage"] },
      { text: "$Nova /ghost check this", code: "unknown_skill", includes: ["/ghost"] },
      { text: "$Ghost /review check this", code: "unknown_agent", includes: ["$Ghost"] },
      { text: "$Echo /review check this", code: "not_member", includes: ["$Echo", "member"] },
      { text: "$Retired /review check this", code: "agent_archived", includes: ["$Retired", "archived"] },
      { text: "$Nova /missing check this", code: "skill_unavailable", includes: ["/missing", "catalog"] },
    ]
    for (const item of cases) {
      const action = item.code === "unknown_skill" ? "message.send" : "skill.send"
      const response = await handlers.invoke({ directory, action, payload: { workspaceID: "w", text: item.text } })
      assert.equal(response.ok, false, item.text)
      assert.equal(response.error?.code, item.code, item.text)
      for (const part of item.includes) assert.ok(response.error?.message.includes(part), `${item.text}: ${response.error?.message}`)
      const next = await handlers.snapshot({ directory })
      assert.deepEqual(next.state.messages.w ?? [], [], `${item.text} must not append a message`)
      assert.deepEqual(Object.values(next.state.subtasks), [], `${item.text} must not create work`)
    }
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("skill.send creates one exact prompt per unique agent with resolved titles and independent replies", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-skill-multi-"))
  const { ctx, prompts, instructions } = fakeContext()
  ctx.skill.list = async () => [
    { id: "review", name: "Review", description: "Thorough code review" },
    { id: "deploy", name: "Deploy", description: "Ship the release" },
    { id: "notes", name: "Notes", description: "Write the notes" },
  ]
  await seedSkillWorkspace(directory, ctx, [
    skillAgent("nova", "Nova", ["review", "notes"]),
    skillAgent("sage", "Sage", ["deploy"]),
    skillAgent("echo", "Echo", []),
  ], { memberIDs: ["nova", "sage", "echo"] })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => (await handlers.snapshot({ directory })).skills.length === 3)
    const text = "$Nova /review /notes and $Sage /deploy and $Echo please check"
    const response = await handlers.invoke({ directory, action: "skill.send", payload: { workspaceID: "w", text } })
    assert.equal(response.ok, true, JSON.stringify(response.error))
    assert.deepEqual(response.result.recipients, ["nova", "sage", "echo"])
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks)
        .filter((task: any) => task.creatorType === "user" && task.instruction === text)
        .every((task: any) => task.state === "replied")
    }, 10_000)
    const next = await handlers.snapshot({ directory })
    const tasks = Object.values(next.state.subtasks).filter((task: any) => task.creatorType === "user" && task.instruction === text) as any[]
    assert.equal(tasks.length, 3, "one work row per addressed agent")
    const byAgent = new Map(tasks.map((task) => [task.assigneeID, task]))
    assert.deepEqual(byAgent.get("nova")?.title, `/review /notes — ${text.slice(0, 80)}`)
    assert.deepEqual(byAgent.get("sage")?.title, `/deploy — ${text.slice(0, 80)}`)
    assert.deepEqual(byAgent.get("echo")?.title, text.slice(0, 80), "a normal-only agent keeps the request snippet")
    for (const task of tasks) {
      assert.equal(task.instruction, text, "the exact user text is the core instruction")
      const replies = next.state.messages.w.filter((message: any) => message.author === "agent" && message.agentID === task.assigneeID && message.taskID === task.id)
      assert.equal(replies.length, 1, `one reply for ${task.assigneeID}`)
      assert.equal(replies[0].agentID, task.assigneeID, "the reply is attributed to the addressed agent")
      assert.equal(replies[0].text, "OK")
    }
    const peerPrompts = prompts.filter((prompt) => prompt.text?.includes(text))
    assert.equal(peerPrompts.length, 3, "one prompt per unique addressed agent, not per skill")
    for (const prompt of peerPrompts) assert.equal("skills" in prompt, false, "no prompt skill attachment bypass")
    assert.ok(
      instructions.some((entry) => entry.value.includes("When a user message addresses multiple agents") && entry.value.includes("ensemble_task_status")),
      "the identity contract tells each agent to handle only its addressed part",
    )
    assert.ok(
      instructions.some((entry) => entry.value.includes("requires maxHops") && entry.value.includes("maxHops: 0")),
      "the identity contract teaches the required task budget and the zero option",
    )
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("skill.send groups repeated anchors and separate messages stay separate work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-skill-separate-"))
  const { ctx } = fakeContext()
  ctx.skill.list = async () => [
    { id: "review", name: "Review", description: "Thorough code review" },
    { id: "notes", name: "Notes", description: "Write the notes" },
  ]
  await seedSkillWorkspace(directory, ctx, [skillAgent("nova", "Nova", ["review", "notes"])])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => (await handlers.snapshot({ directory })).skills.length === 2)
    const first = "$Nova /review /notes first request"
    const second = "$Nova /review second request"
    assert.equal((await handlers.invoke({ directory, action: "skill.send", payload: { workspaceID: "w", text: first } })).ok, true)
    assert.equal((await handlers.invoke({ directory, action: "skill.send", payload: { workspaceID: "w", text: second } })).ok, true)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).filter((task: any) => task.creatorType === "user").every((task: any) => task.state === "replied")
    }, 10_000)
    const next = await handlers.snapshot({ directory })
    const userTasks = Object.values(next.state.subtasks).filter((task: any) => task.creatorType === "user") as any[]
    assert.equal(userTasks.length, 2, "separate messages create separate work rows")
    assert.deepEqual(userTasks.map((task) => task.instruction).sort(), [first, second].sort())
    assert.deepEqual(userTasks.map((task) => task.title).sort(), [
      `/review /notes — ${first.slice(0, 80)}`,
      `/review — ${second.slice(0, 80)}`,
    ].sort())
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("the skill batch cap honors settings and rejects the whole message atomically", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-skill-cap-"))
  const { ctx } = fakeContext()
  ctx.skill.list = async () => [
    { id: "review", name: "Review", description: "Thorough code review" },
    { id: "notes", name: "Notes", description: "Write the notes" },
    { id: "deploy", name: "Deploy", description: "Ship the release" },
  ]
  await seedSkillWorkspace(directory, ctx, [skillAgent("nova", "Nova", ["review", "notes", "deploy"])])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => (await handlers.snapshot({ directory })).skills.length === 3)
    await handlers.invoke({ directory, action: "settings.update", payload: { maxDelegations: 2 } })
    const text = "$Nova /review /notes /deploy cap request"
    const response = await handlers.invoke({ directory, action: "skill.send", payload: { workspaceID: "w", text } })
    assert.equal(response.ok, false)
    assert.equal(response.error?.code, "skill_limit")
    assert.ok(response.error?.message.includes("at most 2"), response.error?.message)
    const next = await handlers.snapshot({ directory })
    assert.deepEqual(next.state.messages.w ?? [], [], "the rejected message never appends")
    assert.deepEqual(Object.values(next.state.subtasks), [], "the rejected message never creates work")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

// --- v5.8 ticket #103: General-skill leader triage ---------------------------

test("a General skill routes to the leader with a one-run native grant, then restores it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-skill-general-"))
  const { ctx, prompts, permissionUpdates } = fakeContext()
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 250)) }
  ctx.skill.list = async () => [
    { id: "review", name: "Review", description: "Thorough code review" },
    { id: "public-research", name: "Public research", description: "Find primary sources" },
  ]
  await seedSkillWorkspace(directory, ctx, [
    skillAgent("nova", "Nova", ["review"]),
    skillAgent("sage", "Sage", []),
  ], { synthesis: false })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => (await handlers.snapshot({ directory })).skills.length === 2)
    const text = "/public-research leader-triage-check"
    const response = await handlers.invoke({ directory, action: "skill.send", payload: { workspaceID: "w", text } })
    assert.equal(response.ok, true, JSON.stringify(response.error))
    assert.deepEqual(response.result.recipients, ["nova"], "the leader receives General triage")
    const next = await handlers.snapshot({ directory })
    const task = Object.values(next.state.subtasks).find((item: any) => item.creatorType === "user") as any
    assert.ok(task)
    assert.equal(task.assigneeID, "nova")
    assert.deepEqual(task.skillGrants, ["public-research"], "General triage is derived from the resolved skill grant")
    assert.equal(task.triage, undefined, "there is one triage source of truth")
    assert.equal(task.instruction, text, "the exact user text stays the instruction")
    assert.equal(task.title, `/public-research — ${text}`)
    let binding: any
    await waitFor(async () => {
      const fresh = await handlers.snapshot({ directory })
      binding = Object.values(fresh.state.bindings).find((item: any) => item.workspaceID === "w" && item.agentID === "nova")
      return Boolean(binding)
    })
    assert.ok(binding)
    await waitFor(async () => prompts.some((prompt) => prompt.sessionID === binding.sessionID && prompt.text.includes(text)))
    const leaderPrompt = prompts.find((prompt) => prompt.sessionID === binding.sessionID && prompt.text.includes(text))
    assert.ok(leaderPrompt, "the leader receives the exact message")
    assert.ok(leaderPrompt.text.includes("Leader triage"), "the leader gets a triage directive outside the user text")
    assert.ok(leaderPrompt.text.includes("/public-research"))
    assert.equal("skills" in leaderPrompt, false, "no prompt skill attachment bypass")
    await waitFor(async () => permissionUpdates.some((update) => update.sessionID === binding.sessionID && update.permissions.some((rule: any) => rule.resource === "public-research" && rule.effect === "allow")))
    const grants = permissionUpdates.filter((update) => update.sessionID === binding.sessionID)
    const grant = grants.find((update) => update.permissions.some((rule: any) => rule.resource === "public-research" && rule.effect === "allow"))
    assert.ok(grant, "the leader session receives a one-run allow rule")
    assert.ok(grant.permissions.some((rule: any) => rule.action === "skill" && rule.resource === "*" && rule.effect === "deny"), "the Skillbox baseline remains")
    await waitFor(async () => {
      const current = await handlers.snapshot({ directory })
      return current.state.subtasks[task.id].state === "replied"
    })
    const after = await handlers.snapshot({ directory })
    const restored = permissionUpdates.filter((update) => update.sessionID === binding.sessionID).at(-1)
    assert.deepEqual(restored?.permissions, [
      { action: "skill", resource: "*", effect: "deny" },
      { action: "skill", resource: "review", effect: "allow" },
    ], "the grant is restored after the turn")
    assert.equal(after.state.subtasks[task.id].outcome, "succeeded")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a General skill under a non-leader mention is rejected atomically", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-skill-general-nonleader-"))
  const { ctx } = fakeContext()
  ctx.skill.list = async () => [{ id: "public-research", name: "Public research", description: "Find primary sources" }]
  await seedSkillWorkspace(directory, ctx, [
    skillAgent("nova", "Nova", []),
    skillAgent("sage", "Sage", []),
  ])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => (await handlers.snapshot({ directory })).skills.length === 1)
    const text = "$Sage /public-research leader-only-check"
    const response = await handlers.invoke({ directory, action: "skill.send", payload: { workspaceID: "w", text } })
    assert.equal(response.ok, false)
    assert.equal(response.error?.code, "general_skill_non_leader")
    assert.ok(response.error?.message.includes("$Nova"), response.error?.message)
    assert.ok(response.error?.message.includes("leader"), response.error?.message)
    const next = await handlers.snapshot({ directory })
    assert.deepEqual(next.state.messages.w ?? [], [], "the rejected message never appends")
    assert.deepEqual(Object.values(next.state.subtasks), [], "the rejected message never creates work")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("message-start assigned skills use the owner picker and keep the exact text", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-skill-owner-picker-"))
  const { ctx, prompts } = fakeContext()
  ctx.skill.list = async () => [{ id: "deploy", name: "Deploy", description: "Ship the release" }]
  await seedSkillWorkspace(directory, ctx, [
    skillAgent("nova", "Nova", []),
    skillAgent("sage", "Sage", ["deploy"]),
  ])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => (await handlers.snapshot({ directory })).skills.length === 1)
    const text = "/deploy ship the release"
    const unresolved = await handlers.invoke({ directory, action: "skill.send", payload: { workspaceID: "w", text } })
    assert.equal(unresolved.ok, false)
    assert.equal(unresolved.error?.code, "owner_choice_required")
    assert.ok(unresolved.error?.message.includes("$Sage"), unresolved.error?.message)
    let next = await handlers.snapshot({ directory })
    assert.deepEqual(next.state.messages.w ?? [], [], "no message before an owner is chosen")
    assert.deepEqual(Object.values(next.state.subtasks), [], "no work before an owner is chosen")

    const invalid = await handlers.invoke({ directory, action: "skill.send", payload: { workspaceID: "w", text, ownerSelections: { deploy: "nova" } } })
    assert.equal(invalid.ok, false)
    assert.equal(invalid.error?.code, "owner_not_assigned")
    next = await handlers.snapshot({ directory })
    assert.deepEqual(next.state.messages.w ?? [], [], "an invalid owner appends nothing")
    assert.deepEqual(Object.values(next.state.subtasks), [], "an invalid owner creates no work")

    const response = await handlers.invoke({ directory, action: "skill.send", payload: { workspaceID: "w", text, ownerSelections: { deploy: "sage" } } })
    assert.equal(response.ok, true, JSON.stringify(response.error))
    assert.deepEqual(response.result.recipients, ["sage"])
    next = await handlers.snapshot({ directory })
    const task = Object.values(next.state.subtasks).find((item: any) => item.creatorType === "user") as any
    assert.equal(task.assigneeID, "sage")
    assert.equal(task.instruction, text, "the picker does not rewrite the user text")
    assert.equal(next.state.messages.w.find((message: any) => message.author === "user")?.text, text)
    await waitFor(async () => prompts.some((prompt) => prompt.text.includes(text)))
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a delegatee receives leader guidance without a host skill grant", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-skill-delegate-grant-"))
  const { ctx, prompts, permissionUpdates, tools } = fakeContext()
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 300)) }
  ctx.skill.list = async () => [{ id: "public-research", name: "Public research", description: "Find primary sources" }]
  await seedSkillWorkspace(directory, ctx, [
    skillAgent("nova", "Nova", []),
    skillAgent("sage", "Sage", []),
  ], { synthesis: false })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => (await handlers.snapshot({ directory })).skills.length === 1)
    const text = "/public-research triage-delegate-check"
    await handlers.invoke({ directory, action: "skill.send", payload: { workspaceID: "w", text } })
    let leaderSession = ""
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const task = Object.values(next.state.subtasks).find((item: any) => (item.skillGrants ?? []).length > 0) as any
      const binding = Object.values(next.state.bindings).find((item: any) => item.workspaceID === "w" && item.agentID === "nova") as any
      leaderSession = binding?.sessionID ?? ""
      return task?.state === "working" && Boolean(leaderSession)
    })
    const guidance = "Apply the public-research method to the release notes; return a concise source list."
    const delegated = await tools.get("delegate").execute({ maxHops: 1, assignee: "Sage", title: "Research follow-up", instruction: guidance }, { sessionID: leaderSession })
    assert.match(delegated.content, /Delegated to Sage/)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const child = Object.values(next.state.subtasks).find((item: any) => item.title === "Research follow-up") as any
      return child?.state === "replied"
    }, 10_000)
    const next = await handlers.snapshot({ directory })
    const child = Object.values(next.state.subtasks).find((item: any) => item.title === "Research follow-up") as any
    assert.ok(child)
    assert.equal(child.instruction, guidance, "the delegatee receives the leader's self-authored instruction")
    assert.equal(child.skillGrants, undefined, "no host skill grant is attached to the delegatee task")
    const sageBinding = Object.values(next.state.bindings).find((item: any) => item.workspaceID === "w" && item.agentID === "sage") as any
    const sageUpdates = permissionUpdates.filter((update) => update.sessionID === sageBinding.sessionID)
    assert.deepEqual(sageUpdates, [], "the delegatee session never receives the leader's General-skill grant")
    const childPrompt = prompts.find((prompt) => prompt.sessionID === sageBinding.sessionID && prompt.text.includes(guidance))
    assert.ok(childPrompt)
    assert.equal("skills" in childPrompt, false, "delegation never uses a prompt skill attachment")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("direct conversations reject General skills and /init before creating a DM line", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-skill-direct-"))
  const { ctx } = fakeContext()
  ctx.skill.list = async () => [
    { id: "review", name: "Review", description: "Thorough code review" },
    { id: "public-research", name: "Public research", description: "Find primary sources" },
  ]
  await seedSkillWorkspace(directory, ctx, [skillAgent("nova", "Nova", ["review"])])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => (await handlers.snapshot({ directory })).skills.length === 2)
    const general = await handlers.invoke({ directory, action: "chat.send", payload: { agentID: "nova", workspaceID: "w", text: "/public-research direct-check" } })
    assert.equal(general.ok, false)
    assert.equal(general.error?.code, "general_skill_direct")
    assert.ok(general.error?.message.includes("workspace group chat"), general.error?.message)
    const init = await handlers.invoke({ directory, action: "chat.send", payload: { agentID: "nova", workspaceID: "w", text: "/init" } })
    assert.equal(init.ok, false)
    assert.equal(init.error?.code, "init_direct")
    assert.ok(init.error?.message.includes("workspace group chat"), init.error?.message)
    let next = await handlers.snapshot({ directory })
    assert.equal(Object.keys(next.state.dmTranscripts).length, 0, "rejected direct messages never persist a line")
    const assigned = await handlers.invoke({ directory, action: "chat.send", payload: { agentID: "nova", workspaceID: "w", text: "/review direct-check" } })
    assert.equal(assigned.ok, true, JSON.stringify(assigned.error))
    next = await handlers.snapshot({ directory })
    assert.ok(Object.values(next.state.dmTranscripts).some((lines: any) => lines.some((line: any) => line.text === "/review direct-check")))
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a leader triage task cannot be reassigned away from the leader", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-skill-triage-reassign-"))
  const { ctx } = fakeContext()
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 300)) }
  ctx.skill.list = async () => [{ id: "public-research", name: "Public research", description: "Find primary sources" }]
  await seedSkillWorkspace(directory, ctx, [
    skillAgent("nova", "Nova", []),
    skillAgent("sage", "Sage", []),
  ], { synthesis: false })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => (await handlers.snapshot({ directory })).skills.length === 1)
    await handlers.invoke({ directory, action: "skill.send", payload: { workspaceID: "w", text: "/public-research reassign-check" } })
    const next = await handlers.snapshot({ directory })
    const task = Object.values(next.state.subtasks).find((item: any) => (item.skillGrants ?? []).length > 0) as any
    assert.ok(task)
    const refused = await handlers.invoke({ directory, action: "task.reassign", payload: { id: task.id, assigneeID: "sage" } })
    assert.equal(refused.ok, false)
    assert.equal(refused.error?.code, "triage_leader_only")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a leader triage task cannot be delegated from", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-skill-triage-delegate-"))
  const { ctx } = fakeContext()
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 300)) }
  ctx.skill.list = async () => [{ id: "public-research", name: "Public research", description: "Find primary sources" }]
  await seedSkillWorkspace(directory, ctx, [
    skillAgent("nova", "Nova", []),
    skillAgent("sage", "Sage", []),
  ], { synthesis: false })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => (await handlers.snapshot({ directory })).skills.length === 1)
    await handlers.invoke({ directory, action: "skill.send", payload: { workspaceID: "w", text: "/public-research delegate-guard-check" } })
    const next = await handlers.snapshot({ directory })
    const task = Object.values(next.state.subtasks).find((item: any) => (item.skillGrants ?? []).length > 0) as any
    assert.ok(task)
    const refused = await handlers.invoke({
      directory,
      action: "task.delegate",
      payload: { workspaceID: "w", parentID: task.id, assigneeID: "sage", title: "Delegated triage", instruction: "Take over triage." },
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.error?.code, "triage_no_delegate")
    assert.match(refused.error?.message ?? "", /triage/i)
    const after = await handlers.snapshot({ directory })
    assert.equal(Object.values(after.state.subtasks).some((item: any) => item.parentID === task.id), false, "no child task is created from triage")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("the deliberate skill action never falls through to a native /init turn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-skill-init-bypass-"))
  const { ctx } = fakeContext()
  await seedSkillWorkspace(directory, ctx, [skillAgent("nova", "Nova", [])])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    for (const text of ["/init", "/ensemble-init"]) {
      const response = await handlers.invoke({ directory, action: "skill.send", payload: { workspaceID: "w", text } })
      assert.equal(response.ok, false, text)
      assert.equal(response.error?.code, "init_command", text)
    }
    const next = await handlers.snapshot({ directory })
    assert.deepEqual(next.state.messages.w ?? [], [], "init never becomes a leader peer turn")
    assert.deepEqual(Object.values(next.state.subtasks), [], "init never becomes work")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("prose /init is delivered as ordinary group text", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-skill-init-prose-"))
  const { ctx, commands } = fakeContext()
  await seedSkillWorkspace(directory, ctx, [skillAgent("nova", "Nova", [])])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const text = "hello /init, keep going"
    const response = await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: "w", text } })
    assert.equal(response.ok, true, JSON.stringify(response.error))
    const next = await handlers.snapshot({ directory })
    const task = Object.values(next.state.subtasks).find((item: any) => item.creatorType === "user") as any
    assert.ok(task)
    assert.equal(task.instruction, text, "prose keeps the exact text as an ordinary message")
    assert.deepEqual(next.state.initJobs, {}, "no init job is started")
    assert.deepEqual(commands, [], "no native command is invoked")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

// --- v5.9 ticket #109: service routing regression matrix ---------------------

type RoutedWork = { assigneeID: string; title: string }

type RoutingCase = {
  name: string
  action: "message.send" | "skill.send" | "chat.send"
  text: string
  agentID?: string
  recipientIDs?: string[]
  ownerSelections?: Record<string, string>
  files?: string[]
  expects:
    | { ok: true; recipients?: string[]; work: RoutedWork[] }
    | { ok: false; code: string; includes: string[] }
}

// Roster: Nova leads and owns review/notes; Sage owns deploy; Echo is a
// normal-only member; public-research belongs to no member (General).
// Every text below stays under the 80-character request snippet so a title
// mismatch points at routing rather than truncation.
const routingMatrix: RoutingCase[] = [
  {
    name: "explicit recipient IDs may repeat an assigned skill route",
    action: "message.send",
    text: "$Nova /review @notes.md check",
    recipientIDs: ["nova"],
    files: ["notes.md"],
    expects: {
      ok: true,
      recipients: ["nova"],
      work: [{ assigneeID: "nova", title: "/review — $Nova /review @notes.md check" }],
    },
  },
  {
    name: "a multi-agent skill route accepts the exact routed set in any order",
    action: "skill.send",
    text: "$Nova /review @notes.md and $Sage /deploy",
    recipientIDs: ["sage", "nova"],
    files: ["notes.md"],
    expects: {
      ok: true,
      recipients: ["sage", "nova"],
      work: [
        { assigneeID: "nova", title: "/review — $Nova /review @notes.md and $Sage /deploy" },
        { assigneeID: "sage", title: "/deploy — $Nova /review @notes.md and $Sage /deploy" },
      ],
    },
  },
  {
    name: "explicit recipient IDs cannot retarget a skill to another owner",
    action: "skill.send",
    text: "$Nova /review @notes.md check",
    recipientIDs: ["sage"],
    files: ["notes.md"],
    expects: { ok: false, code: "skill_recipient_mismatch", includes: ["$Nova"] },
  },
  {
    name: "explicit recipient IDs cannot add a non-owner to a skill route",
    action: "message.send",
    text: "$Nova /review @notes.md check",
    recipientIDs: ["nova", "echo"],
    files: ["notes.md"],
    expects: { ok: false, code: "skill_recipient_mismatch", includes: ["$Nova", "$Echo"] },
  },
  {
    name: "explicit recipient IDs cannot narrow a multi-agent skill route",
    action: "skill.send",
    text: "$Nova /review @notes.md and $Sage /deploy",
    recipientIDs: ["nova"],
    files: ["notes.md"],
    expects: { ok: false, code: "skill_recipient_mismatch", includes: ["$Nova", "$Sage"] },
  },
  {
    name: "a message-start skill rejects an explicit recipient that is not its owner",
    action: "skill.send",
    text: "/review @notes.md leader",
    recipientIDs: ["sage"],
    files: ["notes.md"],
    expects: { ok: false, code: "skill_recipient_mismatch", includes: ["$Nova"] },
  },
  {
    name: "a message-start skill accepts the leader owner as the explicit recipient",
    action: "skill.send",
    text: "/review @notes.md leader",
    recipientIDs: ["nova"],
    files: ["notes.md"],
    expects: {
      ok: true,
      recipients: ["nova"],
      work: [{ assigneeID: "nova", title: "/review — /review @notes.md leader" }],
    },
  },
  {
    name: "the owner picker routes a message-start skill owned outside the leader",
    action: "skill.send",
    text: "/deploy @notes.md pick",
    recipientIDs: ["sage"],
    ownerSelections: { deploy: "sage" },
    files: ["notes.md"],
    expects: {
      ok: true,
      recipients: ["sage"],
      work: [{ assigneeID: "sage", title: "/deploy — /deploy @notes.md pick" }],
    },
  },
  {
    name: "an owner-picker selection cannot be overridden by an explicit recipient",
    action: "skill.send",
    text: "/deploy @notes.md pick",
    recipientIDs: ["nova"],
    ownerSelections: { deploy: "sage" },
    files: ["notes.md"],
    expects: { ok: false, code: "skill_recipient_mismatch", includes: ["$Sage"] },
  },
  {
    name: "the owner picker is required when the leader does not own a start skill",
    action: "message.send",
    text: "/deploy @notes.md pick",
    files: ["notes.md"],
    expects: { ok: false, code: "owner_choice_required", includes: ["/deploy", "$Sage"] },
  },
  {
    name: "mixed skill and normal anchors route one turn per unique agent",
    action: "skill.send",
    text: "$Nova /review @notes.md and $Echo inspect",
    files: ["notes.md"],
    expects: {
      ok: true,
      recipients: ["nova", "echo"],
      work: [
        { assigneeID: "nova", title: "/review — $Nova /review @notes.md and $Echo inspect" },
        { assigneeID: "echo", title: "$Nova /review @notes.md and $Echo inspect" },
      ],
    },
  },
  {
    name: "mixed anchors accept the exact explicit routed set",
    action: "message.send",
    text: "$Nova /review @notes.md and $Echo inspect",
    recipientIDs: ["nova", "echo"],
    files: ["notes.md"],
    expects: {
      ok: true,
      recipients: ["nova", "echo"],
      work: [
        { assigneeID: "nova", title: "/review — $Nova /review @notes.md and $Echo inspect" },
        { assigneeID: "echo", title: "$Nova /review @notes.md and $Echo inspect" },
      ],
    },
  },
  {
    name: "mixed anchors reject an explicit set that drops the normal anchor",
    action: "skill.send",
    text: "$Nova /review @notes.md and $Echo inspect",
    recipientIDs: ["nova"],
    files: ["notes.md"],
    expects: { ok: false, code: "skill_recipient_mismatch", includes: ["$Nova", "$Echo"] },
  },
  {
    name: "bang aliases route the same as dollar anchors",
    action: "skill.send",
    text: "!Nova /review @notes.md and $Echo inspect",
    files: ["notes.md"],
    expects: {
      ok: true,
      recipients: ["nova", "echo"],
      work: [
        { assigneeID: "nova", title: "/review — !Nova /review @notes.md and $Echo inspect" },
        { assigneeID: "echo", title: "!Nova /review @notes.md and $Echo inspect" },
      ],
    },
  },
  {
    name: "General skills route to the leader and cannot be retargeted by explicit IDs",
    action: "skill.send",
    text: "/public-research @notes.md general",
    recipientIDs: ["sage"],
    files: ["notes.md"],
    expects: { ok: false, code: "skill_recipient_mismatch", includes: ["$Nova"] },
  },
  {
    name: "General skills route to the leader with file references intact",
    action: "skill.send",
    text: "/public-research @notes.md general",
    files: ["notes.md"],
    expects: {
      ok: true,
      recipients: ["nova"],
      work: [{ assigneeID: "nova", title: "/public-research — /public-research @notes.md general" }],
    },
  },
  {
    name: "a General skill under a non-leader anchor stays atomic",
    action: "skill.send",
    text: "$Sage /public-research @notes.md",
    files: ["notes.md"],
    expects: { ok: false, code: "general_skill_non_leader", includes: ["$Nova"] },
  },
  {
    name: "multiple file references survive a skill route in order",
    action: "skill.send",
    text: "$Nova /review @notes.md @docs/guide.md review",
    files: ["notes.md", "docs/guide.md"],
    expects: {
      ok: true,
      recipients: ["nova"],
      work: [{ assigneeID: "nova", title: "/review — $Nova /review @notes.md @docs/guide.md review" }],
    },
  },
  {
    name: "invalid skill/owner pairs stay atomic with explicit recipient IDs",
    action: "skill.send",
    text: "$Nova /deploy @notes.md check",
    recipientIDs: ["sage"],
    files: ["notes.md"],
    expects: { ok: false, code: "skill_not_assigned", includes: ["$Sage"] },
  },
  {
    name: "ordinary group messages keep file references for explicit recipients",
    action: "message.send",
    text: "@notes.md please inspect",
    recipientIDs: ["sage"],
    files: ["notes.md"],
    expects: {
      ok: true,
      recipients: ["sage"],
      work: [{ assigneeID: "sage", title: "@notes.md please inspect" }],
    },
  },
  {
    name: "ordinary group messages keep file references for the default leader",
    action: "message.send",
    text: "@notes.md please inspect",
    files: ["notes.md"],
    expects: {
      ok: true,
      recipients: ["nova"],
      work: [{ assigneeID: "nova", title: "@notes.md please inspect" }],
    },
  },
  {
    name: "direct conversations deliver a skill message with its file reference as written",
    action: "chat.send",
    agentID: "nova",
    text: "/review @notes.md direct",
    files: ["notes.md"],
    expects: { ok: true, work: [] },
  },
  {
    name: "direct conversations cannot route another owner's skill via explicit IDs",
    action: "chat.send",
    agentID: "sage",
    text: "/review @notes.md direct",
    recipientIDs: ["nova"],
    files: ["notes.md"],
    expects: { ok: false, code: "skill_not_assigned_direct", includes: ["$Nova"] },
  },
  {
    name: "direct conversations reject a General skill atomically",
    action: "chat.send",
    agentID: "nova",
    text: "/public-research @notes.md direct",
    files: ["notes.md"],
    expects: { ok: false, code: "general_skill_direct", includes: ["workspace group chat"] },
  },
]

test("service routing matrix: skills, explicit recipients, files, and direct conversations", async (t) => {
  for (const item of routingMatrix) {
    await t.test(item.name, async () => {
      const directory = mkdtempSync(join(tmpdir(), "ensemble-routing-"))
      writeFileSync(join(directory, "notes.md"), "notes")
      mkdirSync(join(directory, "docs"), { recursive: true })
      writeFileSync(join(directory, "docs", "guide.md"), "guide")
      const { ctx, prompts } = fakeContext()
      ctx.skill.list = async () => [
        { id: "review", name: "Review", description: "Thorough code review" },
        { id: "notes", name: "Notes", description: "Write the notes" },
        { id: "deploy", name: "Deploy", description: "Ship the release" },
        { id: "public-research", name: "Public research", description: "Find primary sources" },
      ]
      await seedSkillWorkspace(directory, ctx, [
        skillAgent("nova", "Nova", ["review", "notes"]),
        skillAgent("sage", "Sage", ["deploy"]),
        skillAgent("echo", "Echo", []),
      ], { memberIDs: ["nova", "sage", "echo"] })
      const service = new EnsembleV2Service(ctx)
      const stop = await startServiceForTest(service, service.ctx)
      const handlers = service.handlers()
      try {
        await waitFor(async () => (await handlers.snapshot({ directory })).skills.length === 4)
        const payload: Record<string, unknown> = { workspaceID: "w", text: item.text }
        if (item.agentID) payload.agentID = item.agentID
        if (item.recipientIDs) payload.recipientIDs = item.recipientIDs
        if (item.ownerSelections) payload.ownerSelections = item.ownerSelections
        const response = await handlers.invoke({ directory, action: item.action, payload })
        const next = await handlers.snapshot({ directory })
        if (!item.expects.ok) {
          assert.equal(response.ok, false, item.name)
          assert.equal(response.error?.code, item.expects.code, item.name)
          for (const part of item.expects.includes) {
            assert.ok(response.error?.message.includes(part), `${item.name}: ${response.error?.message}`)
          }
          assert.deepEqual(next.state.messages.w ?? [], [], `${item.name} appends no group message`)
          assert.deepEqual(Object.values(next.state.subtasks), [], `${item.name} creates no work`)
          assert.deepEqual(Object.values(next.state.dmTranscripts), [], `${item.name} appends no direct line`)
          return
        }
        assert.equal(response.ok, true, `${item.name}: ${JSON.stringify(response.error)}`)
        if (item.expects.recipients) assert.deepEqual(response.result.recipients, item.expects.recipients, item.name)
        const referenceBlock = item.files?.length
          ? `\n\nReferenced files:\n${item.files.map((file) => `- ${file}`).join("\n")}`
          : ""
        if (item.action === "chat.send") {
          const lines = Object.values(next.state.dmTranscripts).flat() as any[]
          assert.deepEqual(lines.map((line) => line.text), [item.text], `${item.name} persists the exact line`)
          assert.ok(prompts.some((prompt) => prompt.text === item.text), `${item.name} prompts the exact text`)
          assert.deepEqual(Object.values(next.state.subtasks), [], `${item.name} creates no group work`)
          return
        }
        const tasks = Object.values(next.state.subtasks).filter((task: any) => task.creatorType === "user") as any[]
        assert.deepEqual(
          tasks.map((task) => ({ assigneeID: task.assigneeID, title: task.title })).sort((a, b) => a.assigneeID.localeCompare(b.assigneeID)),
          [...item.expects.work].sort((a, b) => a.assigneeID.localeCompare(b.assigneeID)),
          `${item.name} creates one work row per routed agent`,
        )
        for (const task of tasks) {
          assert.equal(task.instruction, `${item.text}${referenceBlock}`, `${item.name}: ${task.assigneeID} keeps the exact text and file references`)
        }
        const userMessages = (next.state.messages.w ?? []).filter((message: any) => message.author === "user")
        assert.deepEqual(userMessages.map((message: any) => message.text), [item.text], `${item.name} appends the exact user text once`)
      } finally {
        await stop()
        rmSync(directory, { recursive: true, force: true })
      }
    })
  }
})

test("delegation publishes the task change before pump work and changes.since recovers a dropped event", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-change-feed-"))
  const { ctx } = fakeContext()
  const emitted: Array<{ name: string; data: any }> = []
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  service.attach({ events: { emit: async (name: string, data: any) => { emitted.push({ name, data }) } } })
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "feed", directory, memberIDs: [agent.result.id], leaderID: agent.result.id },
    })
    const before = await handlers.snapshot({ directory })
    const delegated = await handlers.invoke({
      directory,
      action: "task.delegate",
      payload: { workspaceID: workspace.result.id, assigneeID: agent.result.id, title: "Patch card", instruction: "Do it" },
    })
    assert.equal(delegated.ok, true)
    const taskID = delegated.result.id

    const firstPatch = emitted.find((event) =>
      event.name === "patches"
      && event.data.entries.some((entry: any) =>
        entry.changes.some((change: any) => change.entity === "subtask" && change.op === "upsert" && change.task.id === taskID),
      ),
    )
    assert.ok(firstPatch, "the card arrives from a batched patch, without a snapshot")
    const firstChange = firstPatch!.data.entries
      .flatMap((entry: any) => entry.changes)
      .find((change: any) => change.entity === "subtask" && change.op === "upsert" && change.task.id === taskID)
    assert.equal(firstChange.task.title, "Patch card")
    assert.equal(firstChange.task.state, "pending", "the change is published before pump work claims the task")
    assert.equal(firstPatch!.data.epoch, before.epoch)

    assert.ok(
      emitted.some((event) => event.name === "changed" && event.data.version === firstPatch!.data.version),
      "old clients keep receiving the legacy changed event",
    )

    const recovered = await handlers["changes.since"]({ directory, epoch: before.epoch, version: before.state.version })
    assert.equal(recovered.reset, false)
    const recoveredChange = recovered.entries
      .flatMap((entry: any) => entry.changes)
      .find((change: any) => change.entity === "subtask" && change.op === "upsert" && change.task.id === taskID)
    assert.equal(recoveredChange.task.id, taskID, "the heartbeat cursor recovers the dropped patch")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("changes.since output stays JSON-safe at the RPC boundary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-change-json-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  const assertJsonValues = (value: any, path: string): void => {
    if (value === undefined) assert.fail(`${path} is undefined`)
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertJsonValues(item, `${path}[${index}]`))
      return
    }
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) assertJsonValues(item, `${path}.${key}`)
    }
  }
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "json", directory, memberIDs: [agent.result.id], leaderID: agent.result.id },
    })
    const before = await handlers.snapshot({ directory })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Hello" } })
    const recovered = await handlers["changes.since"]({ directory, epoch: before.epoch, version: before.state.version })
    assert.equal(recovered.reset, false)
    assert.ok(recovered.entries.some((entry: any) =>
      (entry.entities ?? entry.changes).some((change: any) => change.entity === "message" && change.op === "upsert"),
    ), "the recovered batch carries a message entity")
    // The host RPC output validator rejects explicit undefined values; the
    // snapshot boundary already strips them and changes.since must match it.
    assertJsonValues(recovered, "changes.since")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a service restart changes the boot epoch and resets the feed without losing work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-change-epoch-"))
  const { ctx } = fakeContext()
  const first = new EnsembleV2Service(ctx)
  const stopFirst = await first.start()
  const handlers = first.handlers()
  let baseline: any
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "epoch", directory, memberIDs: [agent.result.id], leaderID: agent.result.id },
    })
    baseline = await handlers.snapshot({ directory })
    const delegated = await handlers.invoke({
      directory,
      action: "task.delegate",
      payload: { workspaceID: workspace.result.id, assigneeID: agent.result.id, title: "Durable card", instruction: "Do it" },
    })
    baseline.taskID = delegated.result.id
  } finally {
    await stopFirst()
  }

  const second = new EnsembleV2Service(ctx)
  const stopSecond = await second.start()
  try {
    const next = second.handlers()
    const recovered = await next["changes.since"]({ directory, epoch: baseline.epoch, version: baseline.state.version })
    assert.equal(recovered.reset, true, "a new boot epoch always resets the client cursor")
    assert.notEqual(recovered.epoch, baseline.epoch)
    const snapshot = await next.snapshot({ directory })
    assert.ok(snapshot.state.subtasks[baseline.taskID], "the durable task survives the restart")
  } finally {
    await stopSecond()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a foreign-version write resets the feed and is recovered without data loss", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-change-foreign-"))
  const values = new Map<string, unknown>()
  const first = fakeContext(values)
  const second = fakeContext(values)
  const serviceA = new EnsembleV2Service(first.ctx)
  const stopA = await serviceA.start()
  const handlersA = serviceA.handlers()
  const serviceB = new EnsembleV2Service(second.ctx)
  let stopB = async () => {}
  try {
    const agent = await handlersA.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlersA.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "foreign", directory, memberIDs: [agent.result.id], leaderID: agent.result.id },
    })
    const baseline = await handlersA.snapshot({ directory })

    stopB = await serviceB.start()
    const handlersB = serviceB.handlers()
    const delegated = await handlersB.invoke({
      directory,
      action: "task.delegate",
      payload: { workspaceID: workspace.result.id, assigneeID: agent.result.id, title: "Foreign card", instruction: "Do it" },
    })
    assert.equal(delegated.ok, true)

    const recovered = await handlersA["changes.since"]({ directory, epoch: baseline.epoch, version: baseline.state.version })
    assert.equal(recovered.reset, true, "the local ring cannot describe a foreign write")
    const snapshot = await handlersA.snapshot({ directory })
    assert.equal(snapshot.state.subtasks[delegated.result.id]?.title, "Foreign card", "the foreign task is hydrated, not lost")
  } finally {
    await stopB()
    await stopA()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket148: a second service over shared storage never steals a live claim", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-148-two-services-"))
  const values = new Map<string, unknown>()
  const first = fakeContext(values)
  const second = fakeContext(values)
  let release: (() => void) | undefined
  const parked = new Promise<void>((resolve) => { release = resolve })
  ;(first.ctx.session as any).wait = async () => { await parked }
  const serviceA = new EnsembleV2Service(first.ctx)
  const stopA = await serviceA.start()
  const handlersA = serviceA.handlers()
  let stopB = async () => {}
  try {
    const agent = await handlersA.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlersA.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "shared", directory, memberIDs: [agent.result.id], leaderID: agent.result.id },
    })
    await handlersA.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Do the thing" } })
    let taskID = ""
    let ownerRunID = ""
    await waitFor(async () => {
      const next = await handlersA.snapshot({ directory })
      const task = Object.values(next.state.subtasks).find((item: any) => item.state === "working") as any
      if (!task?.claimedBy || !task.leaseUntil || task.leaseUntil <= Date.now()) return false
      if (first.prompts.length !== 1) return false
      taskID = task.id
      ownerRunID = task.claimedBy
      return true
    })
    const before = await handlersA.snapshot({ directory })
    const original = before.state.subtasks[taskID] as any
    assert.equal(first.prompts.length, 1)

    // The second service loads the same durable state while the first owns a
    // live claim. Load must not requeue or rewrite the running row.
    const serviceB = new EnsembleV2Service(second.ctx)
    stopB = await serviceB.start()
    const handlersB = serviceB.handlers()
    const seen = await handlersB.snapshot({ directory })
    const foreign = seen.state.subtasks[taskID] as any
    assert.equal(foreign.state, "working")
    assert.equal(foreign.claimedBy, ownerRunID)
    assert.equal(foreign.activeRunID, original.activeRunID)
    assert.equal(foreign.attempts, original.attempts)
    assert.doesNotMatch(String(foreign.error ?? ""), /restart/i)
    assert.equal(first.prompts.length + second.prompts.length, 1, "only the claim owner prompts")

    release?.()
    await waitFor(async () => {
      const next = await handlersA.snapshot({ directory })
      return (next.state.subtasks[taskID] as any)?.state === "replied"
    }, 5_000)
    await waitFor(async () => {
      const next = await handlersB.snapshot({ directory })
      return (next.state.subtasks[taskID] as any)?.state === "replied"
    }, 5_000)
    const finalA = await handlersA.snapshot({ directory })
    const finalB = await handlersB.snapshot({ directory })
    assert.equal((finalA.state.subtasks[taskID] as any).attempts, 1, "one claim winner, one attempt")
    assert.equal((finalB.state.subtasks[taskID] as any).attempts, 1)
    assert.equal((finalA.state.subtasks[taskID] as any).outcome, "succeeded")
    assert.equal((finalB.state.subtasks[taskID] as any).outcome, "succeeded")
    assert.equal(first.prompts.length + second.prompts.length, 1, "one prompt total")
    const replies = (finalB.state.messages[workspace.result.id] as any[]).filter((message) => message.author === "agent")
    assert.equal(replies.length, 1, "one durable result")
    assert.equal(replies[0].text, "OK")
  } finally {
    release?.()
    await stopB()
    await stopA()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("shell actions publish incremental patches and an approval resolution reaches the feed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-shell-feed-"))
  const { ctx } = fakeContext()
  const emitted: Array<{ name: string; data: any }> = []
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  service.attach({ events: { emit: async (name: string, data: any) => { emitted.push({ name, data }) } } })
  const handlers = service.handlers()
  try {
    const before = await handlers.snapshot({ directory })
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "shell", directory, memberIDs: [agent.result.id], leaderID: agent.result.id },
    })
    const memory = await handlers.invoke({ directory, action: "memory.add", payload: { agentID: agent.result.id, scope: "project", text: "Use pnpm" } })
    const promotion = await handlers.invoke({ directory, action: "memory.promote", payload: { id: memory.result.id } })
    await handlers.invoke({ directory, action: "settings.update", payload: { maxActiveRuns: 2 } })

    const changes = emitted
      .filter((event) => event.name === "patches")
      .flatMap((event) => event.data.entries ?? [])
      .flatMap((entry: any) => entry.entities ?? entry.changes ?? [])
    const change = (entity: string, op = "upsert") => changes.filter((item: any) => item.entity === entity && item.op === op)

    assert.equal(change("agent").at(-1)?.agent.id, agent.result.id)
    assert.equal(change("workspace").at(-1)?.workspace.id, workspace.result.id)
    assert.equal(change("memory").at(-1)?.memory.id, memory.result.id)
    assert.equal(change("settings").at(-1)?.settings.maxActiveRuns, 2)
    assert.equal(change("approval").at(-1)?.approval.id, promotion.result.id)
    assert.equal(change("approval").at(-1)?.approval.status, "pending")

    const resolved = await handlers.invoke({ directory, action: "approval.resolve", payload: { id: promotion.result.id, approve: true } })
    assert.equal(resolved.ok, true)
    const afterResolution = emitted
      .filter((event) => event.name === "patches")
      .flatMap((event) => event.data.entries ?? [])
      .flatMap((entry: any) => entry.entities ?? entry.changes ?? [])
      .filter((item: any) => item.entity === "approval" && item.approval?.id === promotion.result.id)
      .at(-1)
    assert.equal(afterResolution.approval.status, "approved", "needs-you state updates without a snapshot")

    const recovered = await handlers["changes.since"]({ directory, epoch: before.epoch, version: before.state.version })
    assert.equal(recovered.reset, false)
    const recoveredChanges = recovered.entries.flatMap((entry: any) => entry.entities ?? entry.changes)
    assert.ok(recoveredChanges.some((item: any) => item.entity === "agent" && item.agent.id === agent.result.id))
    assert.ok(recoveredChanges.some((item: any) => item.entity === "workspace" && item.workspace.id === workspace.result.id))
    assert.equal(
      recoveredChanges.filter((item: any) => item.entity === "approval" && item.approval?.id === promotion.result.id).at(-1)?.approval.status,
      "approved",
    )
    assert.ok(emitted.some((event) => event.name === "changed"), "legacy clients keep the changed event")

    const reset = await handlers.invoke({ directory, action: "ensemble.reset", payload: { confirmation: "RESET" } })
    assert.equal(reset.ok, true)
    const resetPatch = emitted.filter((event) => event.name === "patches").at(-1)!
    assert.equal(resetPatch.data.reset, true, "a reset asks every client for a full resync")
    const resetSince = await handlers["changes.since"]({ directory, epoch: resetPatch.data.epoch, version: resetPatch.data.version - 1 })
    assert.equal(resetSince.reset, true)
    const cleared = await handlers.snapshot({ directory })
    assert.deepEqual(Object.keys(cleared.state.agents), [], "the full resync reconstructs an empty shell")
    assert.deepEqual(Object.keys(cleared.state.workspaces), [])
    assert.deepEqual(Object.keys(cleared.state.approvals), [])
    assert.deepEqual(Object.keys(cleared.state.memories), [])
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("catalog and config metadata travel on version-neutral patch events", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-shell-meta-"))
  const { ctx } = fakeContext()
  const emitted: Array<{ name: string; data: any }> = []
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  service.attach({ events: { emit: async (name: string, data: any) => { emitted.push({ name, data }) } } })
  const handlers = service.handlers()
  try {
    await waitFor(async () => (await handlers.snapshot({ directory })).models.length > 0)
    const before = await handlers.revision({ directory })
    ctx.skill.list = async () => [{ id: "review", name: "Review", description: "Review changes" }]
    await (service as any).catalog.refresh()

    const metadata = emitted
      .filter((event) => event.name === "patches")
      .map((event) => event.data)
      .filter((batch) => batch.meta && batch.version === batch.from && batch.entries.length === 0)
      .at(-1)
    assert.ok(metadata, "a catalog refresh publishes a version-neutral metadata batch")
    assert.equal(metadata.version, before.version, "catalog metadata does not bump the coordination version")
    assert.ok(metadata.meta.catalogRevision > before.catalogRevision)
    assert.ok(metadata.meta.skills.some((skill: any) => skill.id === "review"))
    assert.equal(metadata.meta.directory, directory)
    assert.ok(typeof metadata.meta.configRevision === "number")

    const since = await handlers["changes.since"]({ directory, epoch: before.epoch, version: before.version })
    assert.equal(since.reset, false)
    assert.ok(since.meta)
    assert.equal(since.meta.catalogRevision, metadata.meta.catalogRevision, "a missed metadata event is recoverable")

    mkdirSync(join(directory, ".ensemble"), { recursive: true })
    writeFileSync(join(directory, ".ensemble", "config.json"), `${JSON.stringify({ version: 1, name: "broken", leader: "Ghost", members: ["Ghost"] }, null, 2)}\n`)
    await waitFor(() => Promise.resolve(emitted.some((event) => event.name === "patches" && typeof event.data.meta?.configError === "string")), 4000)
    const broken = emitted.filter((event) => event.name === "patches" && typeof event.data.meta?.configError === "string").at(-1)!
    assert.match(broken.data.meta.configError, /unknown or ambiguous/i)
    assert.equal(broken.data.meta.directory, directory)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket150: log rows identify the service instance, location, and thread", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-150-logs-"))
  const pluginLocation = mkdtempSync(join(tmpdir(), "ensemble-150-location-"))
  const { ctx } = fakeContext()
  ctx.location.directory = pluginLocation
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.snapshot({ directory })
    await handlers.snapshot({ directory })
    const logs = await handlers["logs.recent"]({ directory, limit: 500 })
    assert.ok(logs.entries.length > 0)
    const start = logs.entries.find((entry: any) => entry.event === "service.start")
    assert.ok(start)
    assert.equal(start.directory, pluginLocation, "the start row names the plugin location, not the process cwd")
    assert.equal(start.role, "service")
    assert.equal(start.instanceID, logs.stats.instanceID)
    assert.equal(start.threadID, 0)
    for (const entry of logs.entries) {
      assert.equal(entry.role, "service")
      assert.equal(entry.instanceID, logs.stats.instanceID)
      assert.equal(entry.threadID, 0)
    }
    const locations = logs.entries.filter((entry: any) => entry.event === "service.location")
    assert.equal(locations.length, 1, "the first view directory is logged once per instance")
    assert.equal(locations[0].directory, directory)

    const diagnostic = await handlers.diagnostic({ directory }) as any
    assert.equal(diagnostic.service.instanceID, logs.stats.instanceID)
    assert.equal(diagnostic.service.threadID, 0)
    assert.equal(diagnostic.service.registryVersion, SHARED_SERVICE_VERSION)
    assert.ok(diagnostic.service.startedAt > 0)

    const filtered = await handlers["logs.recent"]({ directory, instanceID: logs.stats.instanceID, limit: 500 })
    assert.equal(filtered.entries.length, logs.entries.length)
    const foreign = await handlers["logs.recent"]({ directory, instanceID: "another-instance", limit: 500 })
    assert.deepEqual(foreign.entries, [])
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(pluginLocation, { recursive: true, force: true })
  }
})

test("ticket150: feed resets name the reason and identical resets are rate-limited", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-150-reset-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const first = await handlers["changes.since"]({ directory, epoch: -1, version: 0 })
    assert.equal(first.reset, true)
    assert.equal(first.reason, "epoch")
    const second = await handlers["changes.since"]({ directory, epoch: -2, version: 0 })
    assert.equal(second.reset, true)
    assert.equal(second.reason, "epoch")

    const logs = await handlers["logs.recent"]({ directory, event: "feed.reset", limit: 100 })
    assert.equal(logs.entries.length, 2, "the window summary reaches the viewer")
    assert.equal(logs.entries[0].reason, "epoch")
    assert.equal(logs.entries[0].suppressed, 0)
    assert.equal(logs.entries[0].instanceID, logs.stats.instanceID)
    const summary = logs.entries[1] as any
    assert.equal(summary.reason, "epoch")
    assert.equal(summary.suppressed, 1, "a burst that stopped still reports its suppressed total")
    assert.equal(summary.trailing, true)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket155: native tool events bridge to one coalesced work.activity without durable writes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-155-activity-"))
  const { ctx, emitEvent } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const emitted: Array<{ name: string; data: any }> = []
  service.attach({ events: { emit: async (name: string, data: any) => { emitted.push({ name, data }) } } })
  service.registerLocalRunForTest({
    id: "run_activity",
    subtaskID: "task_activity",
    workspaceID: "workspace_activity",
    agentID: "a",
    sessionID: "session_activity",
    status: "running",
    startedAt: 1,
  } as any)
  const handlers = service.handlers()
  try {
    const before = await handlers.revision({ directory })
    emitEvent({
      id: "evt_activity_input",
      created: 10,
      type: "session.tool.input.started",
      data: { sessionID: "session_activity", assistantMessageID: "message_activity", id: "call_activity", name: "bash" },
    })
    emitEvent({
      id: "evt_activity_called",
      created: 11,
      type: "session.tool.called",
      data: { sessionID: "session_activity", assistantMessageID: "message_activity", id: "call_activity", input: { command: "npm test -- --watch" }, executed: true },
    })
    emitEvent({
      id: "evt_activity_progress",
      created: 12,
      type: "session.tool.progress",
      data: { sessionID: "session_activity", assistantMessageID: "message_activity", id: "call_activity", metadata: { output: "secret partial output" } },
    })

    await waitFor(async () => emitted.some((event) => event.name === "work.activity"))
    const activities = emitted.filter((event) => event.name === "work.activity")
    assert.equal(activities.length, 1, "a synchronous tool-event burst coalesces into one activity event")
    const activity = activities[0]!.data
    assert.deepEqual(Object.keys(activity).sort(), ["epoch", "label", "sessionID", "status", "taskID", "tool", "updatedAt", "workspaceID"])
    assert.equal(activity.workspaceID, "workspace_activity")
    assert.equal(activity.taskID, "task_activity")
    assert.equal(activity.sessionID, "session_activity")
    assert.equal(activity.tool, "bash")
    assert.equal(activity.status, "progress")
    assert.equal(activity.label, "running npm test -- --watch…")
    assert.equal(activity.epoch, before.epoch)
    assert.equal(activity.updatedAt >= 1, true)
    assert.ok(!JSON.stringify(activity).includes("secret partial output"), "tool progress metadata never reaches the client")

    const after = await handlers.revision({ directory })
    assert.equal(after.version, before.version, "tool activity never writes durable work")
    assert.equal(emitted.some((event) => event.name === "patches" || event.name === "changed"), false, "tool activity never enters the durable feed")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket155: activity suppresses duplicate deliveries and falls back for text and unknown tools", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-155-activity-dup-"))
  const { ctx, emitEvent } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const emitted: Array<{ name: string; data: any }> = []
  service.attach({ events: { emit: async (name: string, data: any) => { emitted.push({ name, data }) } } })
  service.registerLocalRunForTest({
    id: "run_dup",
    subtaskID: "task_dup",
    workspaceID: "workspace_dup",
    agentID: "a",
    sessionID: "session_dup",
    status: "running",
    startedAt: 1,
  } as any)
  try {
    const called = {
      id: "evt_dup_called",
      created: 20,
      type: "session.tool.called",
      data: { sessionID: "session_dup", assistantMessageID: "message_dup", id: "call_dup", input: { command: "first command" }, executed: true },
    }
    emitEvent({ id: "evt_dup_input", created: 19, type: "session.tool.input.started", data: { sessionID: "session_dup", assistantMessageID: "message_dup", id: "call_dup", name: "bash" } })
    emitEvent(called)
    await waitFor(async () => emitted.some((event) => event.name === "work.activity" && event.data.label === "running first command…"))
    const duplicate = { ...called, data: { ...called.data, input: { command: "second command" } } }
    emitEvent(duplicate)
    await new Promise((resolve) => setTimeout(resolve, 350))
    const labels = emitted.filter((event) => event.name === "work.activity").map((event) => event.data.label)
    assert.deepEqual(labels, ["running first command…"], "the realm claims the host event id before dispatch")

    emitEvent({ id: "evt_dup_text", created: 21, type: "session.text.delta", data: { sessionID: "session_dup", delta: "A partial answer" } })
    await waitFor(async () => emitted.some((event) => event.name === "work.activity" && event.data.label === "writing reply…"))
    const textActivity = emitted.filter((event) => event.name === "work.activity").at(-1)!
    assert.equal(textActivity.data.status, "writing")
    assert.equal(textActivity.data.tool, undefined, "text-only activity names no tool")

    emitEvent({ id: "evt_dup_unknown", created: 22, type: "session.tool.called", data: { sessionID: "session_dup", assistantMessageID: "message_dup", id: "call_unknown", input: {}, executed: true } })
    await waitFor(async () => emitted.some((event) => event.name === "work.activity" && event.data.label === "thinking…"))
    const unknownActivity = emitted.filter((event) => event.name === "work.activity").at(-1)!
    assert.equal(unknownActivity.data.status, "called")
    assert.equal(unknownActivity.data.tool, undefined, "a tool call with no known name stays honest")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket155: idle and terminal host events clear the task activity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-155-activity-clear-"))
  const { ctx, emitEvent } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const emitted: Array<{ name: string; data: any }> = []
  service.attach({ events: { emit: async (name: string, data: any) => { emitted.push({ name, data }) } } })
  service.registerLocalRunForTest({
    id: "run_clear",
    subtaskID: "task_clear",
    workspaceID: "workspace_clear",
    agentID: "a",
    sessionID: "session_clear",
    status: "running",
    startedAt: 1,
  } as any)
  try {
    emitEvent({ id: "evt_clear_called", created: 30, type: "session.tool.called", data: { sessionID: "session_clear", assistantMessageID: "message_clear", id: "call_clear", input: { filePath: "/tmp/auth.ts" }, executed: true } })
    // The tool name is supplied by the host's input.started event; without it
    // the label stays honest thinking, which is still an activity event.
    await waitFor(async () => emitted.some((event) => event.name === "work.activity"))

    emitEvent({ id: "evt_clear_idle", created: 31, type: "session.idle", data: { sessionID: "session_clear" } })
    await waitFor(async () => emitted.some((event) => event.name === "work.activity" && event.data.status === "idle"))
    const idle = emitted.filter((event) => event.name === "work.activity").at(-1)!
    assert.equal(idle.data.label, "")
    assert.equal(idle.data.taskID, "task_clear")

    emitEvent({ id: "evt_clear_started", created: 32, type: "session.execution.started", data: { sessionID: "session_clear" } })
    await waitFor(async () => emitted.some((event) => event.name === "work.activity" && event.data.status === "thinking"))
    emitEvent({ id: "evt_clear_terminal", created: 33, type: "session.execution.succeeded", data: { sessionID: "session_clear" } })
    await waitFor(async () => emitted.some((event) => event.name === "work.activity" && event.data.status === "terminal"))
    const terminal = emitted.filter((event) => event.name === "work.activity").at(-1)!
    assert.equal(terminal.data.label, "")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket170: a stalled child keeps its parent waiting during reconciliation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-170-stalled-parent-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { paused: true })
  await seed.saveSubtask({
    id: "parent", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Parent", instruction: "Do parent",
    mode: "research", state: "working", stage: "initial", outcome: "pending", interrupted: false,
    awaitingChildren: true, attempts: 1, createdAt: 1,
  })
  await seed.saveSubtask({
    id: "child", workspaceID: "w", parentID: "parent", creatorType: "agent", creatorAgentID: "a", assigneeID: "a",
    title: "Child", instruction: "Do child", mode: "research", state: "replied", stage: "initial", outcome: "failed",
    interrupted: false, awaitingChildren: false, attempts: 5, createdAt: 2, repliedAt: 3, finishedAt: 3,
    failure: { kind: "lease", reason: "lease-expired" },
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const snapshot = await handlers.snapshot({ directory })
      return (snapshot.state.subtasks.child as any)?.status === "stalled"
    })
    // A maintenance pass must not treat the stalled child as terminal.
    await handlers.invoke({ directory, action: "settings.update", payload: { maxActiveRuns: 2 } })
    const snapshot = await handlers.snapshot({ directory })
    const parent = snapshot.state.subtasks.parent as any
    assert.equal(parent.state, "working")
    assert.equal(parent.awaitingChildren, true, "a stalled child still owns the parent's wait")
    assert.equal(parent.status, "waiting", "the parent reads waiting, never replied")
    assert.equal((snapshot.state.subtasks.child as any).outcome, "failed")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket170: a stalled row survives finished-work retention until acted on", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-170-stalled-retention-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { paused: true })
  const old = Date.now() - 25 * 60 * 60_000
  await seed.saveSubtask({
    id: "stalled", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Stalled", instruction: "Do",
    mode: "research", state: "replied", stage: "initial", outcome: "failed", interrupted: false,
    awaitingChildren: false, attempts: 5, createdAt: old, repliedAt: old + 1, finishedAt: old + 1,
    failure: { kind: "attempts", reason: "attempts-exhausted" },
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { maxActiveRuns: 2 } })
    const snapshot = await handlers.snapshot({ directory })
    assert.ok(snapshot.state.subtasks.stalled, "a stalled row is retained past the finished-work window")
    assert.equal((snapshot.state.subtasks.stalled as any).status, "stalled")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket169: a lease-loss requeue keeps retry evidence and the late answer repairs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-169-lease-late-success-"))
  const { ctx } = fakeContext()
  let releaseWait: () => void = () => {}
  const waitGate = new Promise<void>((resolve) => { releaseWait = resolve })
  ;(ctx.session as any).wait = async () => { await waitGate }
  ;(ctx.session as any).context = async () => ({
    data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "The late lease-loss answer." }] }],
  })
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { nextSeq: 10 })
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Recover", instruction: "Do",
    mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: false,
    awaitingChildren: false, attempts: 0, createdAt: 1,
  })
  await seed.saveMessage({ id: "m_placeholder", workspaceID: "w", seq: 1, author: "agent", agentID: "a", taskID: "t", text: "Reply interrupted.", kind: "text", streaming: false, interrupted: true, createdAt: 2 })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks.t as any)?.status === "working"
    }, 5_000)
    // Freeze the queue so the requeued row cannot be claimed by a second run.
    await handlers.invoke({ directory, action: "workspace.pause", payload: { id: "w" } })
    // A foreign writer marks the claim dead; the live run still finishes.
    const serviceStore = (service as any).store as V2Store
    const stolen = serviceStore.cloneSubtask("t")!
    stolen.claimedBy = "run_dead"
    stolen.activeRunID = "run_dead"
    stolen.leaseUntil = 1
    await serviceStore.saveSubtask(stolen)
    await handlers.invoke({ directory, action: "settings.update", payload: { maxActiveRuns: 2 } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const task = next.state.subtasks.t as any
      return task?.claimedBy === undefined && task?.retryAfter !== undefined
    }, 5_000)
    const requeued = (await handlers.snapshot({ directory })).state.subtasks.t as any
    assert.equal(requeued.status, "retrying", "a lost lease reads as a due retry, not a fresh queue row")
    assert.equal(typeof requeued.retryAfter, "number")
    releaseWait()
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks.t as any)?.status === "replied"
    }, 5_000)
    const after = await handlers.snapshot({ directory })
    const task = after.state.subtasks.t as any
    assert.equal(task.outcome, "succeeded")
    assert.equal(task.retryAfter, undefined)
    const message = (after.state.messages.w as any[]).find((row) => row.id === "m_placeholder")
    assert.equal(message.text, "The late lease-loss answer.")
    assert.equal(message.interrupted, false)
    const recovered = await handlers["logs.recent"]({ directory, event: "task.recovered", limit: 20 })
    assert.equal(recovered.entries.length, 1)
    assert.equal(recovered.entries[0]?.reason, "late-success")
  } finally {
    releaseWait()
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket165: migration repairs an existing late result and ends replied", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-165-migrate-late-result-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory, { paused: true, nextSeq: 10 })
  const finishedAt = Date.now() - 1_000
  const legacy = (id: string) => ({
    id, workspaceID: "w", creatorType: "user" as const, assigneeID: "a", title: id, instruction: "Do",
    mode: "research" as const, state: "replied" as const, stage: "initial" as const, outcome: "failed" as const,
    interrupted: false, awaitingChildren: false, attempts: 1, createdAt: finishedAt - 10,
    finishedAt, repliedAt: finishedAt,
  })
  await seed.saveSubtask(legacy("late_answer"))
  await seed.saveSubtask(legacy("late_placeholder"))
  await seed.saveMessage({ id: "m_answer", workspaceID: "w", seq: 1, author: "agent", agentID: "a", taskID: "late_answer", text: "The substantial late answer.", kind: "text", streaming: false, createdAt: finishedAt - 5 })
  await seed.saveMessage({ id: "m_placeholder", workspaceID: "w", seq: 2, author: "agent", agentID: "a", taskID: "late_placeholder", text: "Reply interrupted.", kind: "text", streaming: false, interrupted: true, createdAt: finishedAt - 4 })
  await seed.saveMessage({ id: "m_recorded", workspaceID: "w", seq: 3, author: "agent", agentID: "a", taskID: "late_placeholder", text: "The recorded answer.", kind: "text", streaming: false, createdAt: finishedAt - 3 })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const snapshot = await handlers.snapshot({ directory })
      return (snapshot.state.subtasks.late_answer as any)?.status === "replied"
        && (snapshot.state.subtasks.late_placeholder as any)?.status === "replied"
    })
    const snapshot = await handlers.snapshot({ directory })
    for (const id of ["late_answer", "late_placeholder"]) {
      const task = snapshot.state.subtasks[id] as any
      assert.equal(task.state, "replied")
      assert.equal(task.outcome, "succeeded")
      assert.equal(task.failure, undefined)
      assert.equal(typeof task.resultMessageID, "string")
    }
    assert.equal((snapshot.state.subtasks.late_answer as any).resultMessageID, "m_answer")
    assert.equal((snapshot.state.subtasks.late_placeholder as any).resultMessageID, "m_placeholder")
    const placeholder = (snapshot.state.messages.w as any[]).find((row) => row.id === "m_placeholder")
    assert.equal(placeholder.text, "The recorded answer.")
    assert.equal(placeholder.interrupted, false)
    const reconciled = await handlers["logs.recent"]({ directory, event: "task.reconciled", limit: 20 })
    assert.deepEqual(reconciled.entries.map((entry: any) => entry.reason).sort(), ["late-result", "late-result"])
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket170: a held run heartbeats across its delivery deadline and still completes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-170-heartbeat-crossing-"))
  const { ctx } = fakeContext()
  let releaseWait: () => void = () => {}
  const waitGate = new Promise<void>((resolve) => { releaseWait = resolve })
  ;(ctx.session as any).wait = async () => { await waitGate }
  ;(ctx.session as any).context = async () => ({
    data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "Finished after several heartbeats." }] }],
  })
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory)
  const deadlineAt = Date.now() + 350
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Held run", instruction: "Do",
    mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: false,
    awaitingChildren: false, attempts: 0, createdAt: Date.now(), deadlineAt,
  })
  const service = new EnsembleV2Service(ctx, { heartbeatMs: 50 })
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const task = next.state.subtasks.t as any
      return task?.status === "working" && task?.claimedBy !== undefined
    }, 5_000)
    const claimed = (await handlers.snapshot({ directory })).state.subtasks.t as any
    const firstLease = claimed.leaseUntil as number
    // The run is held past its delivery deadline while its heartbeat renews
    // the lease. This is the real crossing, not an already-expired seed.
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const task = next.state.subtasks.t as any
      return Date.now() > deadlineAt && typeof task?.leaseUntil === "number" && task.leaseUntil > firstLease + 100
    }, 5_000)
    const during = (await handlers.snapshot({ directory })).state.subtasks.t as any
    assert.equal(during.deadlineAt, deadlineAt, "the queue delivery timestamp is kept for visibility")
    assert.equal(during.status, "working", "a heartbeating lease outlives the delivery deadline")
    assert.ok(during.leaseUntil > Date.now(), "the heartbeat still owns a live lease")
    assert.equal(during.attempts, 1, "the run was never retired or re-claimed")
    const failures = await handlers["logs.recent"]({ directory, event: "failure.terminal", taskID: "t", limit: 20 })
    assert.equal(failures.entries.length, 0, "crossing the deadline writes no terminal failure")
    releaseWait()
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks.t as any)?.status === "replied"
    }, 5_000)
    const after = await handlers.snapshot({ directory })
    assert.equal((after.state.subtasks.t as any).outcome, "succeeded")
    assert.equal((after.state.subtasks.t as any).attempts, 1)
  } finally {
    releaseWait()
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket188: a background child holds the parent task working until the child terminates", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-188-barrier-"))
  const { ctx, emitEvent } = fakeContext()
  const service = new EnsembleV2Service(ctx, { heartbeatMs: 20, nativeSubagentBarrierMs: 5_000 })
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  let waitCalls = 0
  let releaseWait: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { releaseWait = resolve })
  ctx.session.wait = async () => {
    waitCalls += 1
    await gate
  }
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Kakiko" } })
    assert.equal(agent.ok, true)
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "probe", directory, memberIDs: [agent.result.id], leaderID: agent.result.id },
    })
    assert.equal(workspace.ok, true)
    const sent = await handlers.invoke({
      directory,
      action: "message.send",
      payload: { workspaceID: workspace.result.id, text: "watch the CI", recipientIDs: [agent.result.id] },
    })
    assert.equal(sent.ok, true)
    await waitFor(async () => waitCalls === 1)
    const claimed = await handlers.snapshot({ directory })
    const task = Object.values(claimed.state.subtasks)[0] as any
    const binding = Object.values(claimed.state.bindings)[0] as any
    assert.ok(task && binding, "the run owns a task and a native session")
    emitEvent({
      id: "evt_188_child_created",
      created: Date.now(),
      type: "session.created",
      data: { sessionID: "child_188", parentID: binding.sessionID, agent: "explore", title: "Watch the CI pipeline" },
    })
    await waitFor(async () => (await handlers.snapshot({ directory })).state.nativeSubagents.child_188?.state === "working")
    releaseWait?.()
    await new Promise((resolve) => setTimeout(resolve, 120))
    const during = await handlers.snapshot({ directory })
    assert.equal(during.state.subtasks[task.id].state, "working", "the parent stays working while the child is active")
    assert.ok(during.state.subtasks[task.id].activeRunID, "the parent run still owns its claim")
    const lease = during.state.subtasks[task.id].leaseUntil as number
    assert.ok(lease > Date.now(), "the lease is live during the barrier")
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks[task.id].leaseUntil as number) > lease
    }, 2_000)
    emitEvent({
      id: "evt_188_child_done",
      created: Date.now(),
      type: "session.execution.succeeded",
      data: { sessionID: "child_188" },
    })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return next.state.nativeSubagents.child_188?.state === "replied" && next.state.subtasks[task.id].state === "replied"
    })
    assert.equal((await handlers.snapshot({ directory })).state.subtasks[task.id].outcome, "succeeded")
  } finally {
    releaseWait?.()
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket188: the barrier releases work after its bound and logs no instruction content", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-188-barrier-timeout-"))
  const { ctx, emitEvent } = fakeContext()
  const service = new EnsembleV2Service(ctx, { heartbeatMs: 20, nativeSubagentBarrierMs: 80 })
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  let waitCalls = 0
  let releaseWait: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { releaseWait = resolve })
  ctx.session.wait = async () => {
    waitCalls += 1
    await gate
  }
  const instruction = "PRIVATE watch the CI"
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Kakiko" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "probe", directory, memberIDs: [agent.result.id], leaderID: agent.result.id },
    })
    await handlers.invoke({
      directory,
      action: "message.send",
      payload: { workspaceID: workspace.result.id, text: "watch the CI", recipientIDs: [agent.result.id] },
    })
    await waitFor(async () => waitCalls === 1)
    const claimed = await handlers.snapshot({ directory })
    const task = Object.values(claimed.state.subtasks)[0] as any
    const binding = Object.values(claimed.state.bindings)[0] as any
    emitEvent({
      id: "evt_188_timeout_child_created",
      created: Date.now(),
      type: "session.created",
      data: { sessionID: "child_188_timeout", parentID: binding.sessionID, agent: "explore", title: instruction },
    })
    await waitFor(async () => (await handlers.snapshot({ directory })).state.nativeSubagents.child_188_timeout?.instruction === instruction)
    releaseWait?.()
    await waitFor(async () => (await handlers.snapshot({ directory })).state.subtasks[task.id].state === "replied", 2_000)
    await waitFor(async () => (await handlers.snapshot({ directory })).state.nativeSubagents.child_188_timeout?.state === "cancelled")
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.nativeSubagents.child_188_timeout.state, "cancelled", "a timed-out parent closes its live child record")
    const logs = await (handlers as any)["logs.recent"]({ directory, event: "native.subagent.barrier.timeout", limit: 20 })
    assert.equal(logs.entries.length, 1, "the timeout is audited once")
    assert.ok(!JSON.stringify(logs.entries).includes(instruction), "the barrier log carries no instruction content")
  } finally {
    releaseWait?.()
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket188: experimental.idle accepts the documented subagent background shape without content logs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-188-idle-hook-"))
  const previousLogLevel = process.env.ENSEMBLE_LOG_LEVEL
  process.env.ENSEMBLE_LOG_LEVEL = "debug"
  const { ctx } = fakeContext()
  const hooks = new Map<string, (event: any) => void>()
  ;(ctx.session as any).hook = async (name: string, callback: (event: any) => void) => {
    hooks.set(name, callback)
    return { dispose: async () => undefined }
  }
  const seed = new V2Store(ctx)
  await seed.load()
  await seedNativeParent(seed, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  service.registerLocalRunForTest({
    id: "run_parent",
    subtaskID: "task_parent",
    workspaceID: "w",
    agentID: "a",
    sessionID: "session_parent",
    status: "running",
    startedAt: 1,
  } as any)
  const instruction = "PRIVATE watch the CI"
  try {
    await service.installIdleHook(ctx)
    const hook = hooks.get("experimental.idle")
    assert.ok(hook, "the idle hook is installed")
    hook!({
      sessionID: "session_parent",
      background: [
        { kind: "shell", sessionID: "session_parent", shellID: "shell_1", command: "PRIVATE shell command" },
        { kind: "subagent", sessionID: "session_parent", childSessionID: "child_idle", agent: "explore", description: instruction },
        { kind: "image", sessionID: "session_parent", path: "/tmp/PRIVATE/image.png", model: "image-model" },
      ],
    })
    await waitFor(async () => (await handlers.snapshot({ directory })).state.nativeSubagents.child_idle?.instruction === instruction)
    const run = (await handlers.snapshot({ directory })).state.nativeSubagents.child_idle!
    assert.equal(run.parentSessionID, "session_parent")
    assert.equal(run.parentTaskID, "task_parent")
    assert.equal(run.source, "idle-background")
    assert.equal(run.state, "working")
    const logs = await (handlers as any)["logs.recent"]({ directory, event: "native.subagent.idle-hook", level: "debug", limit: 10 })
    assert.equal(logs.entries.length, 1, "the hook records one structured delivery")
    const payload = JSON.stringify(logs.entries[0])
    assert.ok(!payload.includes(instruction), "the subagent description never enters the log")
    assert.ok(!payload.includes("PRIVATE shell command"), "shell commands never enter the log")
    assert.ok(!payload.includes("/tmp/PRIVATE/image.png"), "image paths never enter the log")
    assert.ok(payload.includes("child_idle"), "the subagent child session id is logged")
  } finally {
    if (previousLogLevel === undefined) delete process.env.ENSEMBLE_LOG_LEVEL
    else process.env.ENSEMBLE_LOG_LEVEL = previousLogLevel
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket182: session.created maps a child session to its parent task and group without queue effects", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-182-child-create-"))
  const { ctx, emitEvent } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedNativeParent(seed, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  service.registerLocalRunForTest({
    id: "run_parent",
    subtaskID: "task_parent",
    workspaceID: "w",
    agentID: "a",
    sessionID: "session_parent",
    status: "running",
    startedAt: 1,
  } as any)
  try {
    const before = await handlers.snapshot({ directory })
    emitEvent({
      id: "evt_child_created",
      created: 5,
      type: "session.created",
      data: { sessionID: "child_1", parentID: "session_parent", agent: "build", title: "CI watcher" },
    })
    await waitFor(async () => Boolean((await handlers.snapshot({ directory })).state.nativeSubagents.child_1))
    const after = await handlers.snapshot({ directory })
    const run = after.state.nativeSubagents.child_1
    assert.deepEqual(
      {
        childSessionID: run.childSessionID,
        parentSessionID: run.parentSessionID,
        parentTaskID: run.parentTaskID,
        dispatchGroupID: run.dispatchGroupID,
        workspaceID: run.workspaceID,
        parentAgentID: run.parentAgentID,
        parentAgent: run.parentAgent,
        state: run.state,
        source: run.source,
        startedAt: run.startedAt,
      },
      {
        childSessionID: "child_1",
        parentSessionID: "session_parent",
        parentTaskID: "task_parent",
        dispatchGroupID: "group_parent",
        workspaceID: "w",
        parentAgentID: "a",
        parentAgent: "Nova",
        state: "working",
        source: "session-created",
        startedAt: 5,
      },
    )
    assert.equal(run.instruction, "CI watcher", "the child title is the honest fallback instruction")
    assert.equal(after.state.dispatchGroups.group_parent!.usedHops, 1, "a subagent spends no dispatch hop")
    assert.deepEqual(Object.keys(after.state.subtasks), ["task_parent"], "a subagent never becomes a queue row")
    assert.deepEqual(Object.keys(before.state.nativeSubagents), [])

    emitEvent({
      id: "evt_child_created_duplicate",
      created: 6,
      type: "session.created",
      data: { sessionID: "child_1", parentID: "session_parent", agent: "build", title: "A different title" },
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    const deduped = await handlers.snapshot({ directory })
    assert.deepEqual(Object.keys(deduped.state.nativeSubagents), ["child_1"], "dedupe is by child session")
    assert.equal(deduped.state.nativeSubagents.child_1!.instruction, "CI watcher")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket182: the parent task/subagent tool instruction wins over the fallback", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-182-instruction-"))
  const { ctx, emitEvent } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedNativeParent(seed, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  service.registerLocalRunForTest({
    id: "run_parent",
    subtaskID: "task_parent",
    workspaceID: "w",
    agentID: "a",
    sessionID: "session_parent",
    status: "running",
    startedAt: 1,
  } as any)
  try {
    emitEvent({
      id: "evt_tool_input",
      created: 10,
      type: "session.tool.input.started",
      data: { sessionID: "session_parent", assistantMessageID: "message_parent", id: "call_task", name: "task" },
    })
    emitEvent({
      id: "evt_tool_called",
      created: 11,
      type: "session.tool.called",
      data: {
        sessionID: "session_parent",
        assistantMessageID: "message_parent",
        id: "call_task",
        input: { description: "watch the CI\nuntil green", prompt: "a very long prompt that must not win" },
      },
    })
    emitEvent({
      id: "evt_child_after_tool",
      created: 12,
      type: "session.created",
      data: { sessionID: "child_1", parentID: "session_parent", agent: "build", title: "New session" },
    })
    await waitFor(async () => Boolean((await handlers.snapshot({ directory })).state.nativeSubagents.child_1))
    const run = (await handlers.snapshot({ directory })).state.nativeSubagents.child_1!
    assert.equal(run.instruction, "watch the CI until green", "the tool instruction is single-line and bounded")
    assert.equal(run.source, "session-created")
    assert.ok(!run.instruction.includes("\n"))
    assert.ok(!run.instruction.includes("very long prompt"))
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket182: execution, idle, failure, and deletion transition child state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-182-states-"))
  const { ctx, emitEvent } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedNativeParent(seed, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  service.registerLocalRunForTest({
    id: "run_parent",
    subtaskID: "task_parent",
    workspaceID: "w",
    agentID: "a",
    sessionID: "session_parent",
    status: "running",
    startedAt: 1,
  } as any)
  const child = (childSessionID: string) => ({
    type: "session.created",
    data: { sessionID: childSessionID, parentID: "session_parent", agent: "build", title: `title ${childSessionID}` },
  })
  try {
    emitEvent({ id: "evt_ok_create", created: 20, ...child("child_ok") })
    emitEvent({ id: "evt_ok_started", created: 21, type: "session.execution.started", data: { sessionID: "child_ok" } })
    emitEvent({ id: "evt_ok_done", created: 22, type: "session.execution.succeeded", data: { sessionID: "child_ok" } })
    emitEvent({ id: "evt_fail_create", created: 23, ...child("child_fail") })
    emitEvent({ id: "evt_fail_done", created: 24, type: "session.execution.failed", data: { sessionID: "child_fail" } })
    emitEvent({ id: "evt_idle_create", created: 25, ...child("child_idle") })
    emitEvent({ id: "evt_idle_done", created: 26, type: "session.idle", data: { sessionID: "child_idle" } })
    emitEvent({ id: "evt_gone_create", created: 27, ...child("child_gone") })
    emitEvent({ id: "evt_gone_delete", created: 28, type: "session.deleted", data: { sessionID: "child_gone" } })
    await waitFor(async () => {
      const state = (await handlers.snapshot({ directory })).state.nativeSubagents
      return state.child_ok?.state === "replied"
        && state.child_fail?.state === "failed"
        && state.child_idle?.state === "replied"
        && state.child_gone?.state === "cancelled"
    })
    const state = (await handlers.snapshot({ directory })).state.nativeSubagents
    assert.ok(state.child_ok.finishedAt! >= 22)
    assert.ok(state.child_fail.finishedAt! >= 24)
    assert.ok(state.child_idle.finishedAt! >= 26)
    assert.ok(state.child_gone.finishedAt! >= 28)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket182: session.idle background reconciles a missed session.created", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-182-idle-bg-"))
  const { ctx, emitEvent } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedNativeParent(seed, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  service.registerLocalRunForTest({
    id: "run_parent",
    subtaskID: "task_parent",
    workspaceID: "w",
    agentID: "a",
    sessionID: "session_parent",
    status: "running",
    startedAt: 1,
  } as any)
  try {
    emitEvent({
      id: "evt_parent_idle_background",
      created: 30,
      type: "session.idle",
      data: {
        sessionID: "session_parent",
        background: [{
          kind: "subagent",
          sessionID: "session_parent",
          childSessionID: "child_missed",
          agent: "build",
          description: "reconcile the missed child",
        }],
      },
    })
    await waitFor(async () => Boolean((await handlers.snapshot({ directory })).state.nativeSubagents.child_missed))
    const run = (await handlers.snapshot({ directory })).state.nativeSubagents.child_missed!
    assert.equal(run.parentSessionID, "session_parent")
    assert.equal(run.parentTaskID, "task_parent")
    assert.equal(run.dispatchGroupID, "group_parent")
    assert.equal(run.workspaceID, "w")
    assert.equal(run.source, "idle-background")
    assert.equal(run.state, "working")
    assert.equal(run.instruction, "reconcile the missed child")

    emitEvent({ id: "evt_missed_done", created: 31, type: "session.execution.succeeded", data: { sessionID: "child_missed" } })
    await waitFor(async () => (await handlers.snapshot({ directory })).state.nativeSubagents.child_missed?.state === "replied")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket182: a terminal task or deleted parent session cancels its active children", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-182-cleanup-"))
  const { ctx, emitEvent } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedNativeParent(seed, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  service.registerLocalRunForTest({
    id: "run_parent",
    subtaskID: "task_parent",
    workspaceID: "w",
    agentID: "a",
    sessionID: "session_parent",
    status: "running",
    startedAt: 1,
  } as any)
  try {
    emitEvent({
      id: "evt_cancel_create",
      created: 40,
      type: "session.created",
      data: { sessionID: "child_cancel", parentID: "session_parent", agent: "build", title: "task child" },
    })
    await waitFor(async () => (await handlers.snapshot({ directory })).state.nativeSubagents.child_cancel?.state === "working")
    const cancelled = await handlers.invoke({ directory, action: "task.cancel", payload: { id: "task_parent" } })
    assert.equal(cancelled.ok, true)
    await waitFor(async () => (await handlers.snapshot({ directory })).state.nativeSubagents.child_cancel?.state === "cancelled")
    const afterTask = (await handlers.snapshot({ directory })).state.nativeSubagents.child_cancel!
    assert.ok(afterTask.finishedAt !== undefined)

    const restart = new V2Store(ctx)
    await restart.load()
    await restart.saveSubtask({
      ...restart.subtask("task_parent")!,
      state: "working",
      outcome: "pending",
      stoppedAt: undefined,
      finishedAt: undefined,
      repliedAt: undefined,
      claimedBy: "run_parent",
      activeRunID: "run_parent",
      leaseUntil: Date.now() + 60_000,
    })
    emitEvent({
      id: "evt_parent_delete_child",
      created: 41,
      type: "session.created",
      data: { sessionID: "child_orphan", parentID: "session_parent", agent: "build", title: "orphan child" },
    })
    await waitFor(async () => (await handlers.snapshot({ directory })).state.nativeSubagents.child_orphan?.state === "working")
    emitEvent({ id: "evt_parent_deleted", created: 42, type: "session.deleted", data: { sessionID: "session_parent" } })
    await waitFor(async () => (await handlers.snapshot({ directory })).state.nativeSubagents.child_orphan?.state === "cancelled")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket182: finished child records purge after the 24h retention window", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-182-retention-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory)
  await seed.saveNativeSubagent({
    childSessionID: "child_old",
    parentSessionID: "session_parent",
    workspaceID: "w",
    instruction: "old work",
    state: "replied",
    startedAt: 1,
    finishedAt: 1,
    source: "session-created",
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    const snapshot = await service.handlers().snapshot({ directory })
    assert.equal(snapshot.state.nativeSubagents.child_old, undefined, "24h finished retention purges the record")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket182: instructions stay out of logs and diagnostics but remain in the durable record", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-182-privacy-"))
  const { ctx, emitEvent } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedNativeParent(seed, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  service.registerLocalRunForTest({
    id: "run_parent",
    subtaskID: "task_parent",
    workspaceID: "w",
    agentID: "a",
    sessionID: "session_parent",
    status: "running",
    startedAt: 1,
  } as any)
  const secret = "PRIVATE watch the CI pipeline"
  try {
    emitEvent({
      id: "evt_privacy_create",
      created: 50,
      type: "session.created",
      data: { sessionID: "child_private", parentID: "session_parent", agent: "build", title: "CI watcher" },
    })
    emitEvent({
      id: "evt_privacy_input",
      created: 51,
      type: "session.tool.input.started",
      data: { sessionID: "session_parent", assistantMessageID: "message_parent", id: "call_private", name: "task" },
    })
    emitEvent({
      id: "evt_privacy_called",
      created: 52,
      type: "session.tool.called",
      data: {
        sessionID: "session_parent",
        assistantMessageID: "message_parent",
        id: "call_private",
        input: { description: secret },
      },
    })
    await waitFor(async () => (await handlers.snapshot({ directory })).state.nativeSubagents.child_private?.instruction === secret)
    const snapshot = await handlers.snapshot({ directory })
    assert.equal(snapshot.state.nativeSubagents.child_private!.instruction, secret, "the display record keeps the instruction")

    const diagnostic = await (handlers as any).diagnostic({ directory })
    assert.ok(!JSON.stringify(diagnostic).includes(secret), "diagnostics never carry the instruction")
    assert.ok(!JSON.stringify(diagnostic).includes("CI watcher"), "diagnostics never carry the fallback instruction")
    assert.equal(diagnostic.state.nativeSubagents.child_private.state, "working", "diagnostics still carry the structured lifecycle record")
    assert.equal(diagnostic.state.nativeSubagents.child_private.instruction, "", "the diagnostic projection blanks the display instruction")

    for (const event of ["native.subagent.created", "native.subagent.updated", "native.subagent.finished"]) {
      const logs = await (handlers as any)["logs.recent"]({ directory, event, limit: 50 })
      assert.ok(!JSON.stringify(logs.entries).includes(secret), `${event} never logs the instruction`)
      assert.ok(!JSON.stringify(logs.entries).includes("CI watcher"), `${event} never logs the fallback`)
    }
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket182: a tool instruction seen before its child session is applied when the child arrives", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-182-pending-instruction-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedNativeParent(seed, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  service.registerLocalRunForTest({
    id: "run_parent",
    subtaskID: "task_parent",
    workspaceID: "w",
    agentID: "a",
    sessionID: "session_parent",
    status: "running",
    startedAt: 1,
  } as any)
  try {
    await service.handleHostEvent({
      id: "evt_pending_input_direct",
      created: 60,
      type: "session.tool.input.started",
      data: { sessionID: "session_parent", assistantMessageID: "message_parent", id: "call_pending", name: "subagent" },
    }, ctx)
    await service.handleHostEvent({
      id: "evt_pending_called_direct",
      created: 61,
      type: "session.tool.called",
      data: {
        sessionID: "session_parent",
        assistantMessageID: "message_parent",
        id: "call_pending",
        input: { instruction: "inspect the pending child" },
      },
    }, ctx)
    assert.deepEqual(Object.keys((await handlers.snapshot({ directory })).state.nativeSubagents), [], "no child record exists yet")
    await service.handleHostEvent({
      id: "evt_pending_created_direct",
      created: 62,
      type: "session.created",
      data: { sessionID: "child_pending", parentID: "session_parent", agent: "build", title: "fallback" },
    }, ctx)
    await waitFor(async () => (await handlers.snapshot({ directory })).state.nativeSubagents.child_pending?.instruction === "inspect the pending child")
    const run = (await handlers.snapshot({ directory })).state.nativeSubagents.child_pending!
    assert.equal(run.instruction, "inspect the pending child")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})
