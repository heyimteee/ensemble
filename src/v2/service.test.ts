import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { EnsembleV2Service, streamFinalization } from "./service.ts"
import { seedLegacySettings, startServiceForTest } from "./test-service.ts"
import { SharedEnsemble } from "./shared-service.ts"
import { deriveWorkStatus, workKey } from "./queue.ts"
import { projectVisibleWork } from "./scoped-read.ts"
import { allWorkGroupsForTasks } from "./work-groups.ts"
import { V2Store } from "./store.ts"
import { chatLineFromMessage, directMessageChannel, isDirectMessageChannel, projectDirectLines } from "./message-channel.ts"
import { nativeAssistantMessageID, nativeTurnGroupID, nativeTurnID, nativeUserMessageID } from "./native-turn.ts"
import type { Agent, Workspace } from "./types.ts"
import { INIT_PROGRESS_TEXT, INIT_START_TEXT, SYSTEM_AGENT_NAME, initJobPhase } from "./system-agent.ts"
import { ENSEMBLE_BLOCK_VERSION, ensembleBlock } from "./init-block.ts"
import { SHARED_SERVICE_VERSION } from "./shared-version.ts"
import { FALLBACK_REPLIES } from "./execution.ts"
import { stripEnsembleBlock } from "./workspace-config.ts"
import { getGlobalLogger } from "./logging.ts"

type Handlers = {
  snapshot: (input: unknown) => Promise<any>
  revision: (input: unknown) => Promise<any>
  "changes.since": (input: unknown) => Promise<any>
  invoke: (input: unknown) => Promise<any>
}

function fakeContext(sharedValues?: Map<string, unknown>) {
  const values = sharedValues ?? new Map<string, unknown>()
  // Ticket #240: the broad service suite exercises the explicit legacy tools.
  // It opts into `off`; the default-on path has dedicated tests below.
  if (!sharedValues) seedLegacySettings(values)
  const removedSessions: string[] = []
  const interruptedSessions: string[] = []
  const movedSessions: Array<{ sessionID: string; directory: string }> = []
  const commands: Array<{ sessionID: string; name: string; text?: string }> = []
  const prompts: any[] = []
  const permissionUpdates: Array<{ sessionID: string; permissions: any[] }> = []
  const instructions: Array<{ sessionID: string; key: string; value: string }> = []
  const modelSwitches: Array<{ sessionID: string; model: any }> = []
  const createdSessionIDs: string[] = []
  const createdSessionInputs: any[] = []
  const nativeSessions = new Map<string, any>()
  const synthetic: any[] = []
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
      create: async ({ title, ...input }: any) => {
        const id = `session_${++sessions}`
        createdSessionIDs.push(id)
        createdSessionInputs.push({ ...input, title })
        nativeSessions.set(id, { id, title })
        return { data: { id, title } }
      },
      get: async ({ sessionID }: any) => {
        const found = nativeSessions.get(sessionID)
        if (!found) throw Object.assign(new Error("Session not found."), { code: "session_not_found" })
        return { data: found }
      },
      instructions: { entry: { put: async (input: any) => { instructions.push(input) } } },
      switchModel: async (input: any) => { modelSwitches.push({ sessionID: String(input.sessionID), model: input.model }) },
      prompt: async (input: any) => { prompts.push({ ...input }) },
      synthetic: async (input: any) => { synthetic.push({ ...input }); return { id: `synthetic_${synthetic.length}` } },
      update: async (input: any) => { permissionUpdates.push({ sessionID: String(input.sessionID), permissions: input.permissions }) },
      wait: async () => { await new Promise((resolve) => setTimeout(resolve, 5)) },
      context: async () => ({
        data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "OK" }] }],
      }),
      interrupt: async ({ sessionID }: any) => { interruptedSessions.push(sessionID) },
      remove: async ({ sessionID }: any) => { removedSessions.push(sessionID); nativeSessions.delete(sessionID) },
      move: async ({ sessionID, directory }: any) => { movedSessions.push({ sessionID, directory }); return { data: { id: sessionID, directory } } },
      command: async ({ sessionID, name, text }: any) => { commands.push({ sessionID, name, text }); return { data: {} } },
    },
    tool: {
      transform: async (factory: any) => {
        const next = new Map<string, any>()
        factory({ namespace() {}, add(tool: any) { next.set(tool.name, tool) } })
        // A host transform replaces the toolset; mirror that so a surface
        // change does not leave the previous registration behind in tests.
        tools.clear()
        for (const [name, tool] of next) tools.set(name, tool)
        return { dispose: async () => { if (tools.size === next.size) tools.clear() } }
      },
    },
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
  return { ctx, handlers: handlers as Handlers, values, removedSessions, interruptedSessions, movedSessions, commands, prompts, synthetic, permissionUpdates, instructions, modelSwitches, createdSessionIDs, createdSessionInputs, nativeSessions, tools, emitted, emitEvent }
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

async function seedRebindBinding(
  ctx: any,
  directory: string,
  binding: { workspaceID: string; sessionID: string; history?: string[]; kind?: "workspace" | "home" | "direct" },
  nativeSessions?: Map<string, any>,
): Promise<void> {
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed, { role: "Rebind private role" })
  await seedWorkspace(seed, directory)
  await seed.saveBinding({
    workspaceID: binding.workspaceID,
    agentID: "a",
    sessionID: binding.sessionID,
    history: binding.history ?? [],
    kind: binding.kind ?? "workspace",
    directory,
    agentVersion: 1,
    updatedAt: 1,
  })
  for (const sessionID of new Set([binding.sessionID, ...(binding.history ?? [])])) {
    nativeSessions?.set(sessionID, { id: sessionID })
  }
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

test("native-session deletion covers current and historical sessions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx, removedSessions, nativeSessions } = fakeContext()
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
    const first = await handlers.snapshot({ directory })
    const bound = Object.values(first.state.bindings)[0] as any
    // The native session disappears outside Ensemble. The next task replaces
    // it and keeps the retired id for native-session deletion.
    nativeSessions.delete(bound.sessionID)
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Second" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).filter((task: any) => task.state === "replied").length >= 2
    })
    const before = await handlers.snapshot({ directory })
    const binding = Object.values(before.state.bindings)[0] as any
    assert.notEqual(binding.sessionID, bound.sessionID)
    assert.deepEqual(binding.history, [bound.sessionID])
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
    await (service as any).store.saveBinding({
      workspaceID: workspace.result.id,
      agentID: nova.result.id,
      sessionID: "s_direct_delete",
      kind: "direct",
      agentVersion: 1,
      updatedAt: 2,
    })
    const deleted = await handlers.invoke({ directory, action: "agent.delete", payload: { id: nova.result.id, replacementLeaderID: sage.result.id, deleteNativeSessions: true } })
    assert.equal(deleted.ok, true)
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.agents[nova.result.id], undefined)
    assert.equal(after.state.workspaces[workspace.result.id].leaderID, sage.result.id)
    assert.deepEqual(after.state.workspaces[workspace.result.id].memberIDs, [sage.result.id])
    assert.ok(removedSessions.includes(binding.sessionID))
    assert.ok(removedSessions.includes("s_direct_delete"), "deletion removes the direct session too")
    assert.equal(
      Object.values(after.state.bindings).some((candidate: any) => candidate.agentID === nova.result.id),
      false,
      "no conversation binding survives agent deletion, including direct",
    )
    const memory = Object.values(after.state.memories).find((item: any) => item.text === "Keep") as any
    assert.ok(memory.deletedAt)
  } finally {
    await stop()
  }
})

test("ticket225: native-first registers the decision toolset and the setting rolls the legacy surface back", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const values = new Map<string, unknown>([["v2/meta", { version: 1, settings: { nativeFirst: "on" } }]])
  const { ctx, tools } = fakeContext(values)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    assert.deepEqual([...tools.keys()], ["task_status", "review", "ask_person", "remember", "share"])
    const invalid = await handlers.invoke({ directory, action: "settings.update", payload: { toolSurface: "sometimes" } })
    assert.equal(invalid.ok, false)
    assert.equal(invalid.error?.code, "invalid_settings")
    const rollback = await handlers.invoke({ directory, action: "settings.update", payload: { toolSurface: "legacy" } })
    assert.equal(rollback.ok, true)
    assert.ok(tools.has("send_message"), "the one-release rollback restores send_message")
    assert.ok(tools.has("workspace_info"), "the one-release rollback restores read-only roster tools")
    assert.ok(tools.has("delegate") && tools.has("handoff"), "explicit dispatch stays behind the legacy flag")
    const cutover = await handlers.invoke({ directory, action: "settings.update", payload: { toolSurface: "native" } })
    assert.equal(cutover.ok, true)
    assert.equal(tools.has("send_message"), false)
    assert.deepEqual([...tools.keys()], ["task_status", "review", "ask_person", "remember", "share"])
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket240: service start persists native-first on and logs the effective mode", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-240-default-"))
  const values = new Map<string, unknown>([["v2/meta", { version: 4, updatedAt: 1, settings: { maxActiveRuns: 2 }, ui: {} }]])
  const { ctx, tools } = fakeContext(values)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    const snap = await service.handlers().snapshot({ directory })
    assert.equal(snap.state.settings.nativeFirst, "on", "the absent persisted mode resolves to on")
    const stored = values.get("v2/meta") as any
    assert.equal(stored.settings.nativeFirst, "on", "the first start persists the default")
    assert.deepEqual([...tools.keys()], ["task_status", "review", "ask_person", "remember", "share"])

    const entry = getGlobalLogger()?.recent({ event: "native.mode" }).at(-1)
    assert.ok(entry, "the service logs the effective native mode")
    assert.equal(entry.mode, "on")
    assert.equal(entry.toolSurface, "native")
    assert.equal(entry.migrated, true)
    assert.equal("directory" in entry, false, "the migration log carries no paths")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket240: service start respects an explicit off mode and logs no migration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-240-explicit-off-"))
  const values = new Map<string, unknown>([["v2/meta", { version: 4, updatedAt: 1, settings: { nativeFirst: "off" }, ui: {} }]])
  const { ctx, tools } = fakeContext(values)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    const snap = await service.handlers().snapshot({ directory })
    assert.equal(snap.state.settings.nativeFirst, "off")
    assert.equal((values.get("v2/meta") as any).settings.nativeFirst, "off", "an explicit choice is never rewritten")
    assert.ok(tools.has("send_message"), "off keeps the legacy surface")

    const entry = getGlobalLogger()?.recent({ event: "native.mode" }).at(-1)
    assert.ok(entry)
    assert.equal(entry.mode, "off")
    assert.equal(entry.toolSurface, "legacy")
    assert.equal(entry.migrated, false)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket240: the default native surface rolls back to legacy tools and restores", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-240-rollback-"))
  const values = new Map<string, unknown>()
  const { ctx, tools } = fakeContext(values)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    assert.deepEqual([...tools.keys()], ["task_status", "review", "ask_person", "remember", "share"])

    // `:native-first off`: explicit off always selects the legacy surface.
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "off" } })
    assert.ok(tools.has("send_message"))
    assert.ok(tools.has("delegate") && tools.has("handoff"))

    // `:native-first on`: the command also clears the legacy surface override.
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on", toolSurface: "native" } })
    assert.equal(tools.has("send_message"), false)

    // `:tools legacy` keeps native ingestion but restores the old tools.
    await handlers.invoke({ directory, action: "settings.update", payload: { toolSurface: "legacy" } })
    assert.ok(tools.has("workspace_info") && tools.has("delegate"))

    // `shadow` keeps the legacy surface even with a stale native tool setting.
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "shadow", toolSurface: "native" } })
    assert.ok(tools.has("send_message"))
    const snap = await handlers.snapshot({ directory })
    assert.equal(snap.state.settings.nativeFirst, "shadow")

    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on", toolSurface: "native" } })
    assert.deepEqual([...tools.keys()], ["task_status", "review", "ask_person", "remember", "share"])
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
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

test("ticket189: a behavior version bump reuses the workspace session and applies settings in place", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-189-reuse-"))
  const { ctx, createdSessionIDs, instructions, permissionUpdates, modelSwitches } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova", role: "First role" } })
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
    const first = await handlers.snapshot({ directory })
    const binding = Object.values(first.state.bindings)[0] as any
    const instructionMark = instructions.length
    const permissionMark = permissionUpdates.length
    const switchMark = modelSwitches.length
    assert.equal(createdSessionIDs.length, 1)

    await handlers.invoke({
      directory,
      action: "agent.update",
      payload: { id: agent.result.id, role: "Second role", skillbox: ["alpha"] },
    })
    const pending = await handlers.snapshot({ directory })
    assert.equal(pending.state.agents[agent.result.id].pendingSettings, true)

    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Second" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).filter((task: any) => task.state === "replied").length >= 2
    })
    const after = await handlers.snapshot({ directory })
    const next = Object.values(after.state.bindings)[0] as any
    assert.equal(createdSessionIDs.length, 1, "the behavior bump does not create a session")
    assert.equal(next.sessionID, binding.sessionID, "the bound session is reused")
    assert.deepEqual(next.history ?? [], [], "the version bump appends no history")
    assert.equal(next.agentVersion, 2)
    assert.equal(after.state.agents[agent.result.id].pendingSettings, false)

    const identity = instructions
      .slice(instructionMark)
      .filter((entry) => entry.sessionID === binding.sessionID && entry.key === "ensemble.v2.identity")
    assert.ok(identity.some((entry) => entry.value.includes("Second role")), "the new role is applied to the bound session")
    const switched = modelSwitches.slice(switchMark).filter((entry) => entry.sessionID === binding.sessionID)
    assert.ok(switched.length > 0, "the main model is applied to the bound session")
    assert.deepEqual(switched[0].model, { providerID: "probe", id: "probe-model" })
    const permissions = permissionUpdates.slice(permissionMark).filter((entry) => entry.sessionID === binding.sessionID)
    assert.ok(
      permissions.some((entry) => entry.permissions.some((rule: any) => rule.action === "skill" && rule.resource === "alpha" && rule.effect === "allow")),
      "the Skillbox baseline is applied to the bound session",
    )
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket189: a behavior version bump refreshes the direct session in place", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-189-dm-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-189-dm-home-"))
  const { ctx, createdSessionIDs, instructions, permissionUpdates, modelSwitches } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seed.saveAgent({
    id: "a", name: "Nova", title: "", role: "First role", mainModel: { providerID: "probe", modelID: "probe-model" },
    backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1,
    homeDirectory: home, createdAt: 1, updatedAt: 1,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a" } })
    const before = await handlers.snapshot({ directory })
    const binding = (Object.values(before.state.bindings)[0] as any)
    const instructionMark = instructions.length
    const permissionMark = permissionUpdates.length
    const switchMark = modelSwitches.length

    await handlers.invoke({ directory, action: "agent.update", payload: { id: "a", role: "Direct role", skillbox: ["alpha"] } })
    await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a" } })

    const after = await handlers.snapshot({ directory })
    const next = Object.values(after.state.bindings)[0] as any
    assert.equal(createdSessionIDs.length, 1, "a direct chat keeps its native session")
    assert.equal(next.sessionID, binding.sessionID)
    assert.equal(next.agentVersion, 2)
    assert.equal(after.state.agents.a.pendingSettings, false)
    assert.ok(
      instructions.slice(instructionMark).some((entry) => entry.sessionID === binding.sessionID && entry.value.includes("Direct role")),
      "the new identity is applied to the direct session",
    )
    assert.ok(modelSwitches.slice(switchMark).some((entry) => entry.sessionID === binding.sessionID), "the model is switched in place")
    assert.ok(
      permissionUpdates
        .slice(permissionMark)
        .some((entry) => entry.sessionID === binding.sessionID && entry.permissions.some((rule: any) => rule.resource === "alpha" && rule.effect === "allow")),
      "the Skillbox baseline is applied to the direct session",
    )
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket189: a running task cannot resurrect pendingSettings or clobber a concurrent update", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-189-stale-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  let waits = 0
  ctx.session.wait = async () => { waits++; await gate }
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova", role: "First role" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id },
    })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "First" } })
    await waitFor(async () => waits === 1)
    await handlers.invoke({ directory, action: "agent.update", payload: { id: agent.result.id, role: "Mid-run role" } })
    release?.()
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.state === "replied")
    })
    const during = await handlers.snapshot({ directory })
    assert.equal(during.state.agents[agent.result.id].version, 2, "the run's stale save does not clobber the update")
    assert.equal(during.state.agents[agent.result.id].role, "Mid-run role")
    assert.equal(during.state.agents[agent.result.id].pendingSettings, true, "the update still awaits its next message")

    ctx.session.wait = async () => { await new Promise((resolve) => setTimeout(resolve, 5)) }
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Second" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).filter((task: any) => task.state === "replied").length >= 2
    })
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.agents[agent.result.id].version, 2)
    assert.equal(after.state.agents[agent.result.id].pendingSettings, false, "the next message applies and clears the flag")
  } finally {
    release?.()
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket189 review: a failed behavior apply keeps the session and retries on the next message", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-189-apply-retry-"))
  const { ctx, createdSessionIDs } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  const originalUpdate = ctx.session.update
  let updateCalls = 0
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova", role: "First role" } })
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
    const first = await handlers.snapshot({ directory })
    const binding = Object.values(first.state.bindings)[0] as any

    await handlers.invoke({ directory, action: "agent.update", payload: { id: agent.result.id, role: "Second role" } })
    ctx.session.update = async (input: any) => {
      updateCalls += 1
      if (updateCalls === 1) throw new Error("host refused the permission update")
      return originalUpdate(input)
    }
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Second" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).filter((task: any) => task.state === "replied").length >= 2
    })
    const failed = await handlers.snapshot({ directory })
    const failedBinding = Object.values(failed.state.bindings)[0] as any
    assert.equal(createdSessionIDs.length, 1, "a failed apply never creates a session")
    assert.equal(failedBinding.sessionID, binding.sessionID, "the same native session is kept")
    assert.equal(failedBinding.agentVersion, 1, "a failed apply does not advance the binding version")
    assert.equal(failed.state.agents[agent.result.id].pendingSettings, true, "the next message still owns the apply")
    assert.equal(updateCalls, 1)

    ctx.session.update = originalUpdate
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Third" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).filter((task: any) => task.state === "replied").length >= 3
    })
    const retried = await handlers.snapshot({ directory })
    const retriedBinding = Object.values(retried.state.bindings)[0] as any
    assert.equal(createdSessionIDs.length, 1, "the retry still reuses the session")
    assert.equal(retriedBinding.sessionID, binding.sessionID)
    assert.equal(retriedBinding.agentVersion, 2, "the next message applies the version")
    assert.equal(retried.state.agents[agent.result.id].pendingSettings, false)
    assert.equal(updateCalls, 1, "the successful retry used the restored host update")
  } finally {
    ctx.session.update = originalUpdate
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket189: agent updates audit changed field names without content", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-189-audit-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const role = "CLASSIFIED ROLE TEXT"
    const skill = "covert-skill"
    await handlers.invoke({
      directory,
      action: "agent.update",
      payload: { id: agent.result.id, name: "Nova Prime", title: "Lead", role, skillbox: [skill], color: "magenta", backupModels: [agent.result.mainModel] },
    })
    const logs = await (handlers as any)["logs.recent"]({ directory, event: "agent.updated", limit: 20 })
    assert.equal(logs.entries.length, 1)
    const entry = logs.entries[0]
    assert.equal(entry.agentID, agent.result.id)
    assert.equal(entry.version, 2)
    assert.deepEqual(
      [...entry.changed].sort(),
      ["backupModels", "color", "name", "role", "skillbox", "title"],
    )
    const serialized = JSON.stringify(logs.entries)
    assert.ok(!serialized.includes(role), "the audit never carries role text")
    assert.ok(!serialized.includes(skill), "the audit never carries skill names")
    assert.ok(!serialized.includes("probe-model"), "the audit never carries model values")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})


test("ticket189: agent.rebindSession moves a workspace binding to a history entry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-189-rebind-"))
  const { ctx, nativeSessions, modelSwitches, permissionUpdates, instructions } = fakeContext()
  await seedRebindBinding(ctx, directory, { workspaceID: "w", sessionID: "session_current", history: ["session_old1", "session_old2"] }, nativeSessions)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const toFirst = await handlers.invoke({
      directory,
      action: "agent.rebindSession",
      payload: { agentID: "a", workspaceID: "w", sessionID: "session_old1" },
    })
    assert.equal(toFirst.ok, true)
    assert.equal(toFirst.result.binding.sessionID, "session_old1")
    assert.deepEqual(toFirst.result.binding.history, ["session_current", "session_old2"])
    assert.equal(toFirst.result.binding.agentVersion, 1)
    assert.equal(typeof toFirst.result.binding.updatedAt, "number")
    assert.ok(modelSwitches.some((entry) => entry.sessionID === "session_old1"), "the rebound session receives the current model")
    assert.ok(
      permissionUpdates.some((entry) => entry.sessionID === "session_old1" && entry.permissions.some((rule: any) => rule.action === "skill" && rule.effect === "deny")),
      "the rebound session receives the current Skillbox baseline",
    )
    assert.ok(
      instructions.some((entry) => entry.sessionID === "session_old1" && entry.key === "ensemble.v2.identity"),
      "the rebound session receives the current identity",
    )

    const toSecond = await handlers.invoke({
      directory,
      action: "agent.rebindSession",
      payload: { agentID: "a", workspaceID: "w", sessionID: "session_old2" },
    })
    assert.equal(toSecond.ok, true)
    assert.equal(toSecond.result.binding.sessionID, "session_old2")
    assert.deepEqual(toSecond.result.binding.history, ["session_old1", "session_current"])

    const back = await handlers.invoke({
      directory,
      action: "agent.rebindSession",
      payload: { agentID: "a", workspaceID: "w", sessionID: "session_current" },
    })
    assert.equal(back.ok, true)
    assert.equal(back.result.binding.sessionID, "session_current")
    assert.deepEqual(back.result.binding.history, ["session_old2", "session_old1"], "the newest retired session leads history")

    const snap = await handlers.snapshot({ directory })
    const binding = Object.values(snap.state.bindings)[0] as any
    assert.equal(binding.sessionID, "session_current")
    assert.deepEqual(binding.history, ["session_old2", "session_old1"])

    const logs = await (handlers as any)["logs.recent"]({ directory, event: "agent.session.rebound", limit: 20 })
    assert.equal(logs.entries.length, 3)
    const latest = logs.entries.at(-1)
    assert.equal(latest.agentID, "a")
    assert.equal(latest.workspaceID, "w")
    assert.equal(latest.sessionID, "session_current")
    assert.equal(latest.fromSessionID, "session_old2")
    assert.ok(!JSON.stringify(logs.entries).includes("Rebind private role"), "rebind logs carry ids only")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket189: agent.rebindSession to the current session is a no-op", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-189-rebind-noop-"))
  const { ctx, nativeSessions, modelSwitches, permissionUpdates, instructions } = fakeContext()
  await seedRebindBinding(ctx, directory, { workspaceID: "w", sessionID: "session_current", history: ["session_old"] }, nativeSessions)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const before = await handlers.snapshot({ directory })
    const beforeBinding = Object.values(before.state.bindings)[0] as any
    const result = await handlers.invoke({
      directory,
      action: "agent.rebindSession",
      payload: { agentID: "a", workspaceID: "w", sessionID: "session_current" },
    })
    assert.equal(result.ok, true)
    assert.equal(result.result.binding.sessionID, "session_current")
    const after = await handlers.snapshot({ directory })
    const afterBinding = Object.values(after.state.bindings)[0] as any
    assert.deepEqual(afterBinding, beforeBinding, "the binding is returned and stored unchanged")
    assert.deepEqual(afterBinding.history, ["session_old"], "the current session is not added to its own history")
    assert.equal(afterBinding.updatedAt, 1)
    assert.equal(modelSwitches.length, 0, "a no-op does not switch models")
    assert.equal(permissionUpdates.length, 0, "a no-op does not apply permissions")
    assert.equal(instructions.length, 0, "a no-op does not write identity")
    const logs = await (handlers as any)["logs.recent"]({ directory, event: "agent.session.rebound", limit: 20 })
    assert.equal(logs.entries.length, 0, "a no-op writes no rebind audit row")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket189: agent.rebindSession rejects a history session that no longer exists", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-189-rebind-missing-"))
  const { ctx, nativeSessions, modelSwitches, permissionUpdates, instructions } = fakeContext()
  await seedRebindBinding(ctx, directory, { workspaceID: "w", sessionID: "session_current", history: ["session_old"] }, nativeSessions)
  nativeSessions.delete("session_old")
  ;(ctx.session as any).get = async ({ sessionID }: any) => nativeSessions.get(sessionID)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const before = await handlers.snapshot({ directory })
    const beforeBinding = Object.values(before.state.bindings)[0] as any
    const result = await handlers.invoke({
      directory,
      action: "agent.rebindSession",
      payload: { agentID: "a", workspaceID: "w", sessionID: "session_old" },
    })
    assert.equal(result.ok, false)
    assert.equal(result.error?.code, "invalid_session")
    const after = await handlers.snapshot({ directory })
    const afterBinding = Object.values(after.state.bindings)[0] as any
    assert.deepEqual(afterBinding, beforeBinding, "a missing target leaves the binding untouched")
    assert.equal(modelSwitches.length, 0)
    assert.equal(permissionUpdates.length, 0)
    assert.equal(instructions.length, 0)
    const logs = await (handlers as any)["logs.recent"]({ directory, event: "agent.session.rebound", limit: 20 })
    assert.equal(logs.entries.length, 0, "a rejected rebind writes no audit row")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket189: agent.rebindSession rejects an unknown target or missing binding", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-189-rebind-"))
  const { ctx } = fakeContext()
  await seedRebindBinding(ctx, directory, { workspaceID: "w", sessionID: "session_current", history: ["session_old"] })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const unknown = await handlers.invoke({
      directory,
      action: "agent.rebindSession",
      payload: { agentID: "a", workspaceID: "w", sessionID: "session_ghost" },
    })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error?.code, "invalid_session")
    const missing = await handlers.invoke({
      directory,
      action: "agent.rebindSession",
      payload: { agentID: "a", workspaceID: "missing", sessionID: "session_current" },
    })
    assert.equal(missing.ok, false)
    assert.equal(missing.error?.code, "not_found")
    const after = await handlers.snapshot({ directory })
    const binding = Object.values(after.state.bindings)[0] as any
    assert.equal(binding.sessionID, "session_current", "a rejected action leaves the binding untouched")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket189: agent.rebindSession rejects a busy current session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-189-rebind-"))
  const { ctx } = fakeContext()
  await seedRebindBinding(ctx, directory, { workspaceID: "w", sessionID: "session_current", history: ["session_old"] })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    ;(service as any).activeRuns.set("run_busy", {
      id: "run_busy", subtaskID: "t", workspaceID: "w", agentID: "a", sessionID: "session_current", status: "running", startedAt: 1,
    })
    const busy = await handlers.invoke({
      directory,
      action: "agent.rebindSession",
      payload: { agentID: "a", workspaceID: "w", sessionID: "session_old" },
    })
    assert.equal(busy.ok, false)
    assert.equal(busy.error?.code, "session_busy")
    ;(service as any).activeRuns.clear()
    ;(service as any).directBusy.add("session_current")
    const direct = await handlers.invoke({
      directory,
      action: "agent.rebindSession",
      payload: { agentID: "a", workspaceID: "w", sessionID: "session_old" },
    })
    assert.equal(direct.ok, false)
    assert.equal(direct.error?.code, "session_busy")
    const after = await handlers.snapshot({ directory })
    const binding = Object.values(after.state.bindings)[0] as any
    assert.equal(binding.sessionID, "session_current")
  } finally {
    ;(service as any).directBusy.clear()
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket189 review: agent.rebindSession rejects when the behavior apply fails", async () => {
  for (const surface of ["switchModel", "update"] as const) {
    const directory = mkdtempSync(join(tmpdir(), "ensemble-189-rebind-apply-"))
    const { ctx, nativeSessions } = fakeContext()
    await seedRebindBinding(ctx, directory, { workspaceID: "w", sessionID: "session_current", history: ["session_old"] }, nativeSessions)
    const service = new EnsembleV2Service(ctx)
    const stop = await startServiceForTest(service, service.ctx)
    const handlers = service.handlers()
    const original = ctx.session[surface]
    ctx.session[surface] = async () => { throw new Error(`host refused ${surface}`) }
    try {
      const result = await handlers.invoke({
        directory,
        action: "agent.rebindSession",
        payload: { agentID: "a", workspaceID: "w", sessionID: "session_old" },
      })
      assert.equal(result.ok, false, `${surface}: the rebind is rejected`)
      assert.equal(result.error?.code, "session_apply_failed", `${surface}: the rejection names the failed apply`)
      const after = await handlers.snapshot({ directory })
      const binding = Object.values(after.state.bindings)[0] as any
      assert.equal(binding.sessionID, "session_current", `${surface}: the binding keeps its session`)
      assert.deepEqual(binding.history, ["session_old"], `${surface}: the history is unchanged`)
      assert.equal(binding.agentVersion, 1, `${surface}: the version is unchanged`)
      const logs = await (handlers as any)["logs.recent"]({ directory, event: "agent.session.rebound", limit: 20 })
      assert.equal(logs.entries.length, 0, `${surface}: a rejected rebind writes no audit row`)
    } finally {
      ctx.session[surface] = original
      await stop()
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

test("ticket189: agent.rebindSession rebinds the home binding when workspaceID is omitted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-189-rebind-home-"))
  const { ctx, nativeSessions } = fakeContext()
  await seedRebindBinding(ctx, directory, { workspaceID: "home", sessionID: "session_home_current", history: ["session_home_old"], kind: "home" }, nativeSessions)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const result = await handlers.invoke({
      directory,
      action: "agent.rebindSession",
      payload: { agentID: "a", sessionID: "session_home_old" },
    })
    assert.equal(result.ok, true)
    assert.equal(result.result.binding.workspaceID, "home")
    assert.equal(result.result.binding.sessionID, "session_home_old")
    assert.deepEqual(result.result.binding.history, ["session_home_current"])
    const logs = await (handlers as any)["logs.recent"]({ directory, event: "agent.session.rebound", limit: 20 })
    assert.equal(logs.entries.length, 1)
    assert.equal(logs.entries[0].workspaceID, "home")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket226: rebinding a direct session leaves the unified channel intact", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-226-rebind-"))
  const { ctx, nativeSessions } = fakeContext()
  await seedRebindBinding(ctx, directory, { workspaceID: "w", sessionID: "session_current", history: ["session_old"], kind: "direct" }, nativeSessions)
  const seed = new V2Store(ctx)
  await seed.load()
  await seed.updateSettings({ nativeFirst: "on" })
  await seed.saveDirectMessage("w", "a", { id: "dm_1", role: "user", author: "You", text: "Direct history", createdAt: 5 })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const result = await handlers.invoke({
      directory,
      action: "agent.rebindSession",
      payload: { agentID: "a", workspaceID: "w", conversation: "direct", sessionID: "session_old" },
    })
    assert.equal(result.ok, true)
    assert.equal(result.result.binding.sessionID, "session_old")
    const snapshot = await handlers.snapshot({ directory })
    assert.deepEqual(snapshot.state.messages[directMessageChannel("a", "w")].map((row: any) => row.text), ["Direct history"])
    const context = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a", workspaceID: "w" } })
    assert.equal(context.result.conversation.kind, "direct")
    assert.deepEqual(
      (context.result.messages as any[]).filter((line) => line.role === "user").map((line) => line.text),
      ["Direct history"],
    )
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket226: archiving an agent preserves its direct channel until deletion", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-226-archive-agent-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    await handlers.invoke({ directory, action: "chat.send", payload: { agentID: agent.result.id, text: "Keep this" } })
    const channel = directMessageChannel(agent.result.id)
    const archived = await handlers.invoke({ directory, action: "agent.archive", payload: { id: agent.result.id } })
    assert.equal(archived.ok, true)
    const snapshot = await handlers.snapshot({ directory })
    assert.equal(snapshot.state.agents[agent.result.id].archived, true)
    assert.deepEqual(snapshot.state.messages[channel].map((row: any) => row.text), ["Keep this"], "archiving keeps conversation history")
    const deleted = await handlers.invoke({ directory, action: "agent.delete", payload: { id: agent.result.id } })
    assert.equal(deleted.ok, true)
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.messages[channel], undefined, "deletion prunes the direct channel")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket226: archiving a workspace preserves its direct channel and deletion prunes it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-226-archive-workspace-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    await handlers.invoke({ directory, action: "chat.send", payload: { agentID: agent.result.id, workspaceID: workspace.result.id, text: "Workspace direct" } })
    const channel = directMessageChannel(agent.result.id, workspace.result.id)
    const archived = await handlers.invoke({ directory, action: "workspace.archive", payload: { id: workspace.result.id } })
    assert.equal(archived.ok, true)
    const snapshot = await handlers.snapshot({ directory })
    assert.deepEqual(snapshot.state.messages[channel].map((row: any) => row.text), ["Workspace direct"], "archiving keeps the workspace direct history")
    const deleted = await handlers.invoke({ directory, action: "workspace.delete", payload: { id: workspace.result.id } })
    assert.equal(deleted.ok, true)
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.messages[channel], undefined, "workspace deletion prunes the direct channel")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket226: moving a home session into a workspace relocates its direct channel", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-226-move-home-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-226-move-home-dir-"))
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
    await handlers.invoke({ directory, action: "chat.send", payload: { agentID: "a", text: "Home history" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: ["a"], leaderID: "a" } })
    const moved = await handlers.invoke({ directory, action: "agent.moveHome", payload: { agentID: "a", workspaceID: workspace.result.id } })
    assert.equal(moved.result.moved, true)
    const snapshot = await handlers.snapshot({ directory })
    assert.equal(snapshot.state.messages[directMessageChannel("a")], undefined, "the home channel is moved, not copied")
    assert.deepEqual(snapshot.state.messages[directMessageChannel("a", workspace.result.id)].map((row: any) => row.text), ["Home history"])
    const context = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a", workspaceID: workspace.result.id } })
    assert.deepEqual(
      (context.result.messages as any[]).filter((line) => line.role === "user").map((line) => line.text),
      ["Home history"],
    )
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
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

test("ticket238: the AGENTS roster refreshes on membership and leader changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-roster-workspace-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const nova = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova", title: "Lead" } })
    const sage = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Sage" } })
    const echo = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Echo" } })
    const workspace = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "site", directory, memberIDs: [nova.result.id, sage.result.id], leaderID: nova.result.id },
    })
    const seeded = await handlers.snapshot({ directory })
    const block = ensembleBlock({ leaderID: nova.result.id, memberIDs: [nova.result.id, sage.result.id], agents: seeded.state.agents })
    writeFileSync(join(directory, "AGENTS.md"), `${block}\n\n# Project\n\nKeep me.\n`)
    writeFileSync(join(directory, ".ensemble", "init.json"), `${JSON.stringify({ version: ENSEMBLE_BLOCK_VERSION }, null, 2)}\n`)

    await handlers.invoke({
      directory,
      action: "workspace.update",
      payload: { id: workspace.result.id, memberIDs: [nova.result.id, sage.result.id, echo.result.id] },
    })
    let content = readFileSync(join(directory, "AGENTS.md"), "utf8")
    assert.match(content, /^\| \*\*Nova\*\* \(leader\) \| Lead \|/m)
    assert.match(content, /^\| Sage \|/m)
    assert.match(content, /^\| Echo \|/m)
    assert.ok(content.indexOf("Nova") < content.indexOf("Sage") && content.indexOf("Sage") < content.indexOf("Echo"))

    await handlers.invoke({ directory, action: "workspace.update", payload: { id: workspace.result.id, leaderID: echo.result.id } })
    content = readFileSync(join(directory, "AGENTS.md"), "utf8")
    assert.match(content, /^\| \*\*Echo\*\* \(leader\) \|/m)
    assert.ok(content.indexOf("**Echo**") < content.indexOf("Nova"))
    assert.equal(stripEnsembleBlock(content).trim(), "# Project\n\nKeep me.", "project-owned content survives refresh")
  } finally {
    await stop()
  }
})

test("ticket238: the AGENTS roster refreshes on agent name, title, and role changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-roster-agent-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const nova = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const sage = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Sage", title: "Researcher", role: "Own research." } })
    await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "site", directory, memberIDs: [nova.result.id, sage.result.id], leaderID: nova.result.id },
    })
    const seeded = await handlers.snapshot({ directory })
    writeFileSync(
      join(directory, "AGENTS.md"),
      `${ensembleBlock({ leaderID: nova.result.id, memberIDs: [nova.result.id, sage.result.id], agents: seeded.state.agents })}\n`,
    )
    writeFileSync(join(directory, ".ensemble", "init.json"), `${JSON.stringify({ version: ENSEMBLE_BLOCK_VERSION }, null, 2)}\n`)

    await handlers.invoke({
      directory,
      action: "agent.update",
      payload: { id: sage.result.id, name: "Sage Prime", title: "Research | Lead", role: "Line one.\nLine two." },
    })
    const content = readFileSync(join(directory, "AGENTS.md"), "utf8")
    assert.match(content, /^\| Sage Prime \| Research \\\| Lead \| Line one\.<br>Line two\. \|$/m)
    assert.doesNotMatch(content, /^\| Sage \|/m)
  } finally {
    await stop()
  }
})

test("ticket238: archived and deleted agents leave the AGENTS roster", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-roster-lifecycle-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const nova = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const sage = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Sage" } })
    const echo = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Echo" } })
    await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "site", directory, memberIDs: [nova.result.id, sage.result.id, echo.result.id], leaderID: nova.result.id },
    })
    const seeded = await handlers.snapshot({ directory })
    writeFileSync(
      join(directory, "AGENTS.md"),
      `# Project\n\nKeep me.\n\n${ensembleBlock({ leaderID: nova.result.id, memberIDs: [nova.result.id, sage.result.id, echo.result.id], agents: seeded.state.agents })}\n`,
    )
    writeFileSync(join(directory, ".ensemble", "init.json"), `${JSON.stringify({ version: ENSEMBLE_BLOCK_VERSION }, null, 2)}\n`)

    await handlers.invoke({ directory, action: "agent.archive", payload: { id: echo.result.id } })
    let content = readFileSync(join(directory, "AGENTS.md"), "utf8")
    assert.doesNotMatch(content, /^\| Echo \|/m)
    assert.match(content, /^\| Sage \|/m)

    await handlers.invoke({ directory, action: "agent.delete", payload: { id: sage.result.id } })
    content = readFileSync(join(directory, "AGENTS.md"), "utf8")
    assert.doesNotMatch(content, /^\| Sage \|/m)
    assert.match(content, /^\| \*\*Nova\*\* \(leader\) \|/m)
    assert.equal(stripEnsembleBlock(content).trim(), "# Project\n\nKeep me.", "project-owned content survives refresh")
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
    assert.ok(content.startsWith(`<!-- ensemble:start v${ENSEMBLE_BLOCK_VERSION} -->`))
    assert.ok(content.includes("# Repo"))
    assert.equal((content.match(/<!-- ensemble:start/g) ?? []).length, 1)
    const metadata = JSON.parse(readFileSync(join(directory, ".ensemble", "init.json"), "utf8"))
    assert.equal(metadata.version, ENSEMBLE_BLOCK_VERSION)
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

test("ticket226: service start migrates pre-channel direct lines before serving the direct chat", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-226-migrate-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-226-migrate-home-"))
  const values = new Map<string, unknown>()
  const seedCtx = fakeContext(values).ctx
  const seed = new V2Store(seedCtx)
  await seed.load()
  await seed.saveAgent({
    id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" },
    backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1,
    homeDirectory: home, createdAt: 1, updatedAt: 1,
  })
  values.set("v2/dm/home/a/dm_1", {
    id: "dm_1", role: "user", author: "You", text: "before channels", createdAt: 10, queued: true, bindingKey: "home:a",
  })
  values.set("v2/dm/home/a/dm_2", {
    id: "dm_2", role: "user", author: "You", text: "with attachment", createdAt: 20, bindingKey: "home:a",
    attachments: [{ id: "att_1", name: "notes.txt", mime: "text/plain", size: 8, kind: "file" }],
  })
  values.set("v2/dm/home/a/dm_3", {
    id: "dm_3", role: "user", author: "You", text: "", createdAt: 30, bindingKey: "home:a",
    attachments: [{ id: "att_2", name: "shot.png", mime: "image/png", size: 16, kind: "image" }],
  })
  values.set("v2/dmqueue/dm_1", {
    id: "dm_1", agentID: "a", directory: home, text: "before channels", status: "queued", createdAt: 10,
  })

  const first = fakeContext(values)
  const service = new EnsembleV2Service(first.ctx)
  const stop = await startServiceForTest(service, service.ctx)
  let snapshot: any
  try {
    const context = await service.handlers().invoke({ directory, action: "chat.context", payload: { agentID: "a" } })
    const lines = (context.result.messages as any[]).filter((line) => line.role === "user")
    assert.deepEqual(lines.map((line) => line.text), ["before channels", "with attachment", ""])
    assert.equal(lines[0].queued, true, "the queued state comes from the surviving direct queue entry")
    assert.deepEqual(lines[1].attachments, [{ id: "att_1", name: "notes.txt", mime: "text/plain", size: 8, kind: "file" }])
    assert.deepEqual(lines[2].attachments, [{ id: "att_2", name: "shot.png", mime: "image/png", size: 16, kind: "image" }], "an attachment-only line survives the migration")
    snapshot = await service.handlers().snapshot({ directory })
    assert.deepEqual(snapshot.state.messages[directMessageChannel("a")].map((row: any) => row.text), ["before channels", "with attachment", ""])
    assert.equal("dmTranscripts" in snapshot.state, false, "the snapshot no longer carries the legacy store")
    assert.equal(JSON.stringify(snapshot).includes("dmTranscripts"), false)
    assert.equal((await (first.ctx.storage.scan({ prefix: "v2/dm/" }) as any)).entries.length, 0, "the migrated legacy rows are removed")
  } finally {
    await stop()
  }

  const second = fakeContext(values)
  const reloaded = new EnsembleV2Service(second.ctx)
  const stopReloaded = await startServiceForTest(reloaded, reloaded.ctx)
  try {
    const context = await reloaded.handlers().invoke({ directory, action: "chat.context", payload: { agentID: "a" } })
    assert.deepEqual(
      (context.result.messages as any[]).filter((line) => line.role === "user").map((line) => line.text),
      ["before channels", "with attachment", ""],
      "a reload reads the unified channel and never re-migrates a duplicate",
    )
    const again = await reloaded.handlers().snapshot({ directory })
    assert.equal(again.state.messages[directMessageChannel("a")].length, 3)
  } finally {
    await stopReloaded()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket226: direct chat reads the unified channel before the native-first cutover", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-dm-channel-"))
  const values = new Map<string, unknown>()
  const first = fakeContext(values)
  const service = new EnsembleV2Service(first.ctx)
  const stop = await startServiceForTest(service, service.ctx)
  let agentID = ""
  try {
    const agent = await service.handlers().invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    agentID = agent.result.id
    await service.handlers().invoke({ directory, action: "chat.send", payload: { agentID, text: "Dual line" } })
    const store = (service as any).store as V2Store
    await store.appendChannelMessage(directMessageChannel(agentID), {
      id: "dm_durable_only",
      workspaceID: "home",
      author: "user",
      text: "Durable only",
      kind: "text",
      createdAt: Date.now() + 1,
    })
    const context = await service.handlers().invoke({ directory, action: "chat.context", payload: { agentID } })
    assert.deepEqual(
      (context.result.messages as any[]).filter((line) => line.role === "user").map((line) => line.text),
      ["Dual line", "Durable only"],
      "the flag-off path now reads the durable channel",
    )
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket226: rollback to the previous release's channel-read flag sees every migrated line", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-dm-rollback-"))
  const values = new Map<string, unknown>()
  const first = fakeContext(values)
  const seedCtx = first.ctx
  const seed = new V2Store(seedCtx)
  await seed.load()
  await seed.saveAgent({
    id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" },
    backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1,
    createdAt: 1, updatedAt: 1,
  })
  values.set("v2/dm/home/a/dm_legacy", {
    id: "dm_legacy", role: "user", author: "You", text: "Before migration", createdAt: 1, bindingKey: "home:a",
  })
  const service = new EnsembleV2Service(first.ctx)
  const stop = await startServiceForTest(service, service.ctx)
  let agentID = "a"
  try {
    const sent = await service.handlers().invoke({ directory, action: "chat.send", payload: { agentID, text: "After migration" } })
    assert.equal(sent.ok, true)
    const patches = first.emitted.filter((event) => event.name === "patches").map((event) => event.data)
    assert.equal(patches.some((batch) => batch.reset === true), false, "a direct message never resets the feed")
    assert.ok(
      patches.some((batch) => batch.entries.some((entry: any) =>
        (entry.entities ?? []).some((change: any) =>
          change.entity === "message"
          && change.op === "upsert"
          && change.message.channel === directMessageChannel(agentID),
        ),
      )),
      "the direct message travels as a durable message patch",
    )
  } finally {
    await stop()
  }
  // The previous release (ticket #212) reads durable channel rows when its
  // ENSEMBLE_DM_CHANNEL_READS flag is on and merges an empty legacy list after
  // this migration. This projection is that rollback read contract.
  const previous = new V2Store(fakeContext(values).ctx)
  await previous.load()
  const rows = previous.messages(directMessageChannel(agentID))
  const rollback = projectDirectLines(rows.map((row) => chatLineFromMessage(row, "Nova")), [])
  assert.deepEqual(rollback.filter((line) => line.role === "user").map((line) => line.text), [
    "Before migration",
    "After migration",
  ])
  const resumed = new EnsembleV2Service(fakeContext(values).ctx)
  const stopResumed = await startServiceForTest(resumed, resumed.ctx)
  try {
    const context = await resumed.handlers().invoke({ directory, action: "chat.context", payload: { agentID } })
    assert.deepEqual(
      (context.result.messages as any[]).filter((line) => line.role === "user").map((line) => line.text),
      ["Before migration", "After migration"],
      "the current release reads the same rows without duplication",
    )
  } finally {
    await stopResumed()
    rmSync(directory, { recursive: true, force: true })
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
  seedLegacySettings(values)
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
  // Simulate a restart where the stored channel carries a timestamp ahead of
  // the wall clock (e.g. previous clock skew or a future-dated seed).
  const future = Date.now() + 60_000
  for (const [key, value] of [...values.entries()]) {
    if (key.startsWith(`v2/message/${directMessageChannel(agentID)}/`) && value && typeof value === "object") {
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

test("ticket226: a sent direct queue entry never renders the channel line queued", async () => {
  // Ticket #77 root cause of permanently-grey sent lines: chatContext used to
  // OR a stored line's own `queued` bit. The queue entry is the single source
  // of truth; a sent entry must leave the durable channel row unqueued.
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
    await store.saveDmQueueEntry({
      id: sent.result.id, agentID: "a", directory: home, text: "Sent already", status: "sent", createdAt: 1,
    })
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

test("ticket237: a leader's delegation reply skips the completion hop", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-237-delegation-"))
  const { ctx, prompts } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seed.saveAgent(novaAgent({ id: "b", name: "Sage" }))
  await seedWorkspace(seed, directory, { memberIDs: ["a", "b"] })
  // The leader's parent turn already synthesized: its reply stands as the
  // delivery, so the child must not bounce the same result back as a second
  // leader turn.
  await seed.saveSubtask({
    id: "parent", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Parent", instruction: "Do parent",
    mode: "research", state: "replied", stage: "initial", outcome: "succeeded", interrupted: false, awaitingChildren: false,
    attempts: 1, createdAt: 1, repliedAt: Date.now(), finishedAt: Date.now(),
  })
  await seed.saveSubtask({
    id: "child", workspaceID: "w", parentID: "parent", creatorType: "agent", creatorAgentID: "a", assigneeID: "b",
    title: "Child", instruction: "Do child", mode: "research", state: "pending", stage: "initial", outcome: "pending",
    interrupted: false, awaitingChildren: false, attempts: 0, createdAt: 2,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks.child as any)?.state === "replied"
    })
    const after = await handlers.snapshot({ directory })
    const subtasks = Object.values(after.state.subtasks) as any[]
    assert.equal(subtasks.some((task) => task.id !== "child" && task.parentID === "child" && task.handoff?.completion === true), false, "no completion hop")
    assert.equal(subtasks.filter((task) => task.assigneeID === "a").length, 1, "no leader review card or model turn")
    const messages = (after.state.messages.w ?? []) as any[]
    assert.equal(messages.some((message) => message.text.startsWith("Handed to $Nova")), false, "no leader completion message")
    assert.equal(prompts.length, 1, "only the delegated worker ran")
    const logs = await handlers["logs.recent"]({ directory, event: "completion.skipped", limit: 20 })
    assert.equal(logs.entries.length, 1)
    const entry = logs.entries[0]
    assert.equal(entry.taskID, "child")
    assert.equal(entry.parentID, "parent")
    assert.equal(entry.leaderID, "a")
    assert.equal(entry.reason, "parent-is-leader")
    assert.equal(entry.title, undefined, "no conversation content in the log")
    assert.equal(entry.instruction, undefined)
    assert.equal(entry.text, undefined)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket237: a peer turn the leader asked skips the completion hop", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-237-peer-turn-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seed.saveAgent(novaAgent({ id: "b", name: "Sage" }))
  await seedWorkspace(seed, directory, { memberIDs: ["a", "b"] })
  await seed.saveSubtask({
    id: "turn", workspaceID: "w", creatorType: "agent", creatorAgentID: "a", assigneeID: "b",
    title: "Answer the leader", instruction: "Answer the leader", mode: "research", state: "pending",
    stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false, attempts: 0, createdAt: 2,
    workKind: "turn", turn: { correlationID: "peer_237", askerKind: "agent", askerID: "a" },
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks.turn as any)?.state === "replied"
    })
    const after = await handlers.snapshot({ directory })
    const subtasks = Object.values(after.state.subtasks) as any[]
    assert.equal(subtasks.some((task) => task.parentID === "turn" && task.handoff?.completion === true), false)
    assert.equal(subtasks.filter((task) => task.assigneeID === "a").length, 0)
    const logs = await handlers["logs.recent"]({ directory, event: "completion.skipped", limit: 20 })
    assert.equal(logs.entries.length, 1)
    assert.equal(logs.entries[0].taskID, "turn")
    assert.equal(logs.entries[0].leaderID, "a")
    assert.equal(logs.entries[0].reason, "asker-is-leader")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket237: a handoff the leader sent skips the completion hop", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-237-handoff-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seed.saveAgent(novaAgent({ id: "b", name: "Sage" }))
  await seedWorkspace(seed, directory, { memberIDs: ["a", "b"] })
  await seed.saveSubtask({
    id: "hop", workspaceID: "w", creatorType: "agent", creatorAgentID: "a", assigneeID: "b",
    title: "Leader handoff", instruction: "Do the handoff", mode: "research", state: "pending",
    stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false, attempts: 0, createdAt: 2,
    workKind: "handoff", handoff: { correlationID: "handoff_237", senderID: "a", recipientID: "b", depth: 1 },
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks.hop as any)?.state === "replied"
    })
    const after = await handlers.snapshot({ directory })
    const subtasks = Object.values(after.state.subtasks) as any[]
    assert.equal(subtasks.some((task) => task.parentID === "hop" && task.handoff?.completion === true), false)
    assert.equal(subtasks.filter((task) => task.assigneeID === "a").length, 0)
    const logs = await handlers["logs.recent"]({ directory, event: "completion.skipped", limit: 20 })
    assert.equal(logs.entries.length, 1)
    assert.equal(logs.entries[0].taskID, "hop")
    assert.equal(logs.entries[0].leaderID, "a")
    assert.equal(logs.entries[0].reason, "sender-is-leader")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket237: a worker the leader did not ask still reaches the leader for review", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-237-review-"))
  const { ctx, prompts } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seed.saveAgent(novaAgent({ id: "b", name: "Sage" }))
  await seedWorkspace(seed, directory, { memberIDs: ["a", "b"] })
  await seed.saveSubtask({
    id: "turn", workspaceID: "w", creatorType: "user", assigneeID: "b",
    title: "User asks Sage", instruction: "User asks Sage", mode: "research", state: "pending",
    stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false, attempts: 0, createdAt: 2,
    workKind: "turn", turn: { correlationID: "peer_237_user", askerKind: "user" },
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.parentID === "turn" && task.handoff?.completion === true && task.state === "replied")
    }, 5000)
    const after = await handlers.snapshot({ directory })
    const completion = Object.values(after.state.subtasks).find((task: any) => task.parentID === "turn" && task.handoff?.completion === true) as any
    assert.ok(completion, "the leader reviews work they did not ask for")
    assert.equal(completion.assigneeID, "a")
    assert.match(completion.instruction, /finished/)
    assert.ok(prompts.some((prompt) => prompt.text?.includes("finished")), "the leader received a model turn")
    const logs = await handlers["logs.recent"]({ directory, event: "completion.skipped", taskID: "turn", limit: 20 })
    assert.equal(logs.entries.length, 0)
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
    const directChannel = directMessageChannel("nova", "w")
    assert.deepEqual(next.state.messages[directChannel] ?? [], [], "rejected direct messages never persist a line")
    const assigned = await handlers.invoke({ directory, action: "chat.send", payload: { agentID: "nova", workspaceID: "w", text: "/review direct-check" } })
    assert.equal(assigned.ok, true, JSON.stringify(assigned.error))
    next = await handlers.snapshot({ directory })
    assert.ok((next.state.messages[directChannel] ?? []).some((line: any) => line.text === "/review direct-check"))
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
          assert.deepEqual(
            Object.entries(next.state.messages).filter(([channel]) => isDirectMessageChannel(channel)).flatMap(([, lines]) => lines),
            [],
            `${item.name} appends no direct line`,
          )
          return
        }
        assert.equal(response.ok, true, `${item.name}: ${JSON.stringify(response.error)}`)
        if (item.expects.recipients) assert.deepEqual(response.result.recipients, item.expects.recipients, item.name)
        const referenceBlock = item.files?.length
          ? `\n\nReferenced files:\n${item.files.map((file) => `- ${file}`).join("\n")}`
          : ""
        if (item.action === "chat.send") {
          const lines = Object.entries(next.state.messages)
            .filter(([channel]) => isDirectMessageChannel(channel))
            .flatMap(([, messages]) => messages) as any[]
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

test("ticket188: reset aborts the barrier instead of waiting for its bound", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-188-barrier-reset-"))
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
  let resetStarted = false
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
    const binding = Object.values(claimed.state.bindings)[0] as any
    emitEvent({
      id: "evt_188_reset_child",
      created: Date.now(),
      type: "session.created",
      data: { sessionID: "child_188_reset", parentID: binding.sessionID, agent: "explore", title: "Watch the CI pipeline" },
    })
    await waitFor(async () => (await handlers.snapshot({ directory })).state.nativeSubagents.child_188_reset?.state === "working")
    releaseWait?.()
    await new Promise((resolve) => setTimeout(resolve, 120))
    resetStarted = true
    let timer: NodeJS.Timeout | undefined
    const tooSlow = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("ensemble.reset waited for the barrier bound")), 1_500)
      timer.unref?.()
    })
    try {
      const reset = await Promise.race([
        handlers.invoke({ directory, action: "ensemble.reset", payload: { confirmation: "RESET" } }),
        tooSlow,
      ])
      assert.equal(reset.ok, true)
    } finally {
      if (timer) clearTimeout(timer)
    }
    const after = await handlers.snapshot({ directory })
    assert.deepEqual(Object.values(after.state.workspaces), [])
    assert.deepEqual(Object.values(after.state.subtasks), [])
    assert.deepEqual(Object.values(after.state.nativeSubagents), [])
  } finally {
    if (resetStarted) {
      const live = (await handlers.snapshot({ directory }).catch(() => undefined))?.state.nativeSubagents.child_188_reset
      if (live?.state === "working") {
        emitEvent({
          id: "evt_188_reset_cleanup",
          created: Date.now(),
          type: "session.execution.succeeded",
          data: { sessionID: "child_188_reset" },
        })
      }
    }
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

test("ticket191: releasing a terminal run claim clears queue and retry fields", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-191-claim-"))
  const at = Date.now() - 1000
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory)
  await seed.saveSubtask({
    id: "t_terminal",
    workspaceID: "w",
    creatorType: "user",
    assigneeID: "a",
    title: "Terminal",
    instruction: "Do",
    mode: "research",
    state: "replied",
    stage: "initial",
    outcome: "succeeded",
    interrupted: false,
    awaitingChildren: false,
    attempts: 1,
    repliedAt: at,
    finishedAt: at,
    claimedBy: "run_1",
    activeRunID: "run_1",
    leaseUntil: at + 60_000,
    retryAfter: at + 1,
    createdAt: at,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    await (service as any).releaseClaim("t_terminal", "run_1")
    const task = (service as any).store.subtask("t_terminal")
    assert.equal(task.claimedBy, undefined)
    assert.equal(task.leaseUntil, undefined)
    assert.equal(task.activeRunID, undefined)
    assert.equal(task.retryAfter, undefined)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket191: shutdown release clears terminal retry fields", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-191-shutdown-"))
  const at = Date.now() - 1000
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory)
  await seed.saveSubtask({
    id: "t_terminal",
    workspaceID: "w",
    creatorType: "user",
    assigneeID: "a",
    title: "Terminal",
    instruction: "Do",
    mode: "research",
    state: "replied",
    stage: "initial",
    outcome: "succeeded",
    interrupted: false,
    awaitingChildren: false,
    attempts: 1,
    repliedAt: at,
    finishedAt: at,
    claimedBy: "run_1",
    activeRunID: "run_1",
    leaseUntil: at + 60_000,
    retryAfter: at + 1,
    createdAt: at,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    await (service as any).releaseLocalClaims(new Set(["run_1"]))
    const task = (service as any).store.subtask("t_terminal")
    assert.equal(task.claimedBy, undefined)
    assert.equal(task.leaseUntil, undefined)
    assert.equal(task.activeRunID, undefined)
    assert.equal(task.retryAfter, undefined)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

/** Ticket #213: one agent with a group, workspace-direct, and home-direct binding. */
async function seedConversationBindings(ctx: any, directory: string): Promise<void> {
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory)
  await seed.saveBinding({
    workspaceID: "w", agentID: "a", sessionID: "s_group", kind: "workspace",
    directory, agentVersion: 1, updatedAt: 1,
  })
  await seed.saveBinding({
    workspaceID: "w", agentID: "a", sessionID: "s_direct", kind: "direct",
    directory, agentVersion: 1, updatedAt: 1,
  })
  await seed.saveBinding({
    workspaceID: "home", agentID: "a", sessionID: "s_home", kind: "home",
    directory: "/home/a", agentVersion: 1, updatedAt: 1,
  })
}

test("ticket213: agent.sessionBinding resolves group, workspace-direct, and home-direct conversations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-213-bindings-"))
  const { ctx, nativeSessions } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  nativeSessions.set("s_direct", { id: "s_direct" })
  nativeSessions.set("s_home", { id: "s_home" })
  await seedConversationBindings(ctx, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const group = await handlers.invoke({ directory, action: "agent.sessionBinding", payload: { agentID: "a", conversation: "workspace", workspaceID: "w" } })
    const direct = await handlers.invoke({ directory, action: "agent.sessionBinding", payload: { agentID: "a", conversation: "direct", workspaceID: "w" } })
    const home = await handlers.invoke({ directory, action: "agent.sessionBinding", payload: { agentID: "a", conversation: "home" } })
    assert.equal(group.ok, true)
    assert.equal(group.result.state, "bound")
    assert.equal(group.result.mode, "off")
    assert.equal(group.result.binding.sessionID, "s_group")
    assert.equal(direct.result.binding.sessionID, "s_direct")
    assert.equal(home.result.binding.sessionID, "s_home")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket213: resolution reports missing and archived native sessions without dropping the binding", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-213-session-state-"))
  const { ctx, nativeSessions } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  nativeSessions.set("s_home", { id: "s_home", time: { archived: 5 } })
  await seedConversationBindings(ctx, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const missing = await handlers.invoke({ directory, action: "agent.sessionBinding", payload: { agentID: "a", conversation: "direct", workspaceID: "w" } })
    const archived = await handlers.invoke({ directory, action: "agent.sessionBinding", payload: { agentID: "a", conversation: "home" } })
    assert.equal(missing.result.state, "missing")
    assert.equal(missing.result.binding.sessionID, "s_direct", "the durable binding is retained")
    assert.equal(archived.result.state, "session_archived")
    assert.equal(archived.result.binding.sessionID, "s_home")
    const snap = await handlers.snapshot({ directory })
    assert.equal(Object.keys(snap.state.bindings).length, 3, "resolution is read-only")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket213: an old binding without kind resolves as the workspace group", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-213-old-binding-"))
  const { ctx, nativeSessions } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory)
  await seed.saveBinding({ workspaceID: "w", agentID: "a", sessionID: "s_old", directory, agentVersion: 1, updatedAt: 1 })
  nativeSessions.set("s_old", { id: "s_old" })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const resolved = await handlers.invoke({ directory, action: "agent.sessionBinding", payload: { agentID: "a", conversation: "workspace", workspaceID: "w" } })
    assert.equal(resolved.result.state, "bound")
    assert.equal(resolved.result.conversation.kind, "workspace")
    assert.equal(resolved.result.binding.sessionID, "s_old")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket213: workspace group selection is unchanged with the flag off and a direct binding present", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-213-flag-off-"))
  const { ctx, nativeSessions } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  nativeSessions.set("s_direct", { id: "s_direct" })
  nativeSessions.set("s_home", { id: "s_home" })
  await seedConversationBindings(ctx, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const context = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a", workspaceID: "w" } })
    assert.equal(context.result.sessionID, "s_group", "direct and home bindings never displace the group session")

    const saved = await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "shadow" } })
    assert.equal(saved.result.nativeFirst, "shadow")
    const shadow = await handlers.invoke({ directory, action: "agent.sessionBinding", payload: { agentID: "a", conversation: "direct", workspaceID: "w" } })
    assert.equal(shadow.result.mode, "shadow")
    const invalid = await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "sometimes" } })
    assert.equal(invalid.ok, false)
    assert.equal(invalid.error!.code, "invalid_settings")
    const snap = await handlers.snapshot({ directory })
    assert.equal(snap.state.settings.nativeFirst, "shadow")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket213: a direct rebind moves the reverse index and keeps the retired session in history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-213-direct-rebind-"))
  const { ctx, nativeSessions } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  await seedWorkspace(seed, directory)
  await seed.saveBinding({ workspaceID: "w", agentID: "a", sessionID: "s_group", kind: "workspace", directory, agentVersion: 1, updatedAt: 1 })
  await seed.saveBinding({ workspaceID: "w", agentID: "a", sessionID: "s_direct", history: ["s_direct_old"], kind: "direct", directory, agentVersion: 1, updatedAt: 1 })
  for (const sessionID of ["s_group", "s_direct", "s_direct_old"]) nativeSessions.set(sessionID, { id: sessionID })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const before = await handlers.snapshot({ directory })
    const rebound = await handlers.invoke({
      directory,
      action: "agent.rebindSession",
      payload: { agentID: "a", conversation: "direct", workspaceID: "w", sessionID: "s_direct_old" },
    })
    assert.equal(rebound.ok, true)
    assert.equal(rebound.result.binding.sessionID, "s_direct_old")
    assert.deepEqual(rebound.result.binding.history, ["s_direct"])
    const feed = await handlers["changes.since"]({ directory, epoch: before.epoch, version: before.state.version })
    assert.equal(feed.reset, false)
    const bindingChange = feed.entries
      .flatMap((entry: any) => entry.entities ?? entry.changes)
      .find((change: any) => change.entity === "binding" && change.op === "upsert" && change.binding.sessionID === "s_direct_old")
    assert.ok(bindingChange, "the rebind is observable through the patch feed")
    assert.equal(bindingChange.binding.kind, "direct")
    const resolved = await handlers.invoke({ directory, action: "agent.sessionBinding", payload: { agentID: "a", conversation: "direct", workspaceID: "w" } })
    assert.equal(resolved.result.binding.sessionID, "s_direct_old")
    const group = await handlers.invoke({ directory, action: "agent.sessionBinding", payload: { agentID: "a", conversation: "workspace", workspaceID: "w" } })
    assert.equal(group.result.binding.sessionID, "s_group", "the group binding is untouched")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

/** Ticket #214: a workspace member with a group and home session but no direct binding yet. */
async function seedDirectChat(
  ctx: any,
  directory: string,
  homeDirectory: string,
): Promise<void> {
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed, { homeDirectory })
  await seedWorkspace(seed, directory)
  await seed.saveBinding({
    workspaceID: "w", agentID: "a", sessionID: "s_group", kind: "workspace",
    directory, agentVersion: 1, updatedAt: 1,
  })
}

test("ticket214: workspace direct chat owns a session in the workspace directory, distinct from the group session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-214-workspace-direct-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-214-home-"))
  const { ctx, nativeSessions, createdSessionInputs } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  await seedDirectChat(ctx, directory, home)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    const context = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a", workspaceID: "w" } })
    assert.equal(context.ok, true)
    assert.notEqual(context.result.sessionID, "s_group", "direct chat never borrows the group session")
    assert.equal(context.result.directory, directory, "the direct session keeps workspace file access")
    assert.equal(context.result.conversation.kind, "direct")
    assert.equal(context.result.conversation.context, "workspace")
    assert.equal(context.result.conversation.workspaceName, "site")
    assert.equal(context.result.conversation.sharedSession, false)

    const created = createdSessionInputs.at(-1)
    assert.equal(created?.location?.directory, directory, "the host session is created in the workspace directory")

    const snapshot = await handlers.snapshot({ directory })
    assert.equal(snapshot.state.bindings["w:a"].sessionID, "s_group", "the group binding is untouched")
    const direct = snapshot.state.bindings["dm:a:w"]
    assert.equal(direct.kind, "direct")
    assert.equal(direct.sessionID, context.result.sessionID)
    assert.equal(direct.directory, directory)

    const again = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a", workspaceID: "w" } })
    assert.equal(again.result.sessionID, context.result.sessionID, "reopening direct chat reuses its own session")
    assert.equal(createdSessionInputs.length, 1, "one direct session for one conversation")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket214: direct chat outside a workspace uses the home-direct session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-214-home-direct-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-214-home-dir-"))
  const { ctx, prompts } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed, { homeDirectory: home })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    const context = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a" } })
    assert.equal(context.result.directory, home)
    assert.equal(context.result.conversation.kind, "home")
    assert.equal(context.result.conversation.context, "home")
    assert.equal(context.result.conversation.workspaceID, undefined)
    assert.equal(context.result.conversation.sharedSession, false)

    const snapshot = await handlers.snapshot({ directory })
    assert.deepEqual(Object.keys(snapshot.state.bindings), ["home:a"])
    assert.equal(snapshot.state.bindings["home:a"].kind, "home")

    const sent = await handlers.invoke({ directory, action: "chat.send", payload: { agentID: "a", text: "Private note" } })
    assert.equal(sent.result.queued, false)
    assert.equal(prompts.at(-1).sessionID, context.result.sessionID)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket214: membership changes switch direct context without moving or reusing either session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-214-membership-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-214-membership-home-"))
  const { ctx, nativeSessions, movedSessions } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed, { homeDirectory: home })
  await seed.saveAgent({ ...novaAgent(), id: "b", name: "Bob", homeDirectory: home })
  await seed.saveWorkspace({ ...siteWorkspace(directory), memberIDs: ["a", "b"], leaderID: "b" })
  await seed.saveBinding({
    workspaceID: "w", agentID: "a", sessionID: "s_group", kind: "workspace",
    directory, agentVersion: 1, updatedAt: 1,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    const joined = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a", workspaceID: "w" } })
    assert.equal(joined.result.conversation.kind, "direct")
    const directSession = joined.result.sessionID

    await handlers.invoke({ directory, action: "workspace.update", payload: { id: "w", memberIDs: ["b"] } })
    const left = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a", workspaceID: "w" } })
    assert.equal(left.result.conversation.kind, "home", "a former member falls back to the home context")
    assert.equal(left.result.directory, home)
    assert.notEqual(left.result.sessionID, directSession)
    assert.notEqual(left.result.sessionID, "s_group")

    const afterLeave = await handlers.snapshot({ directory })
    assert.equal(afterLeave.state.bindings["dm:a:w"].sessionID, directSession, "the workspace-direct session is never retargeted")
    assert.equal(afterLeave.state.bindings["w:a"].sessionID, "s_group", "the group session survives the membership change")

    await handlers.invoke({ directory, action: "workspace.update", payload: { id: "w", memberIDs: ["a", "b"] } })
    const rejoined = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a", workspaceID: "w" } })
    assert.equal(rejoined.result.conversation.kind, "direct")
    assert.equal(rejoined.result.sessionID, directSession, "rejoining reuses the conversation's own session")
    assert.deepEqual(movedSessions, [], "switching conversations never moves a session")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket214: group and direct conversations keep separate sessions, messages, and work state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-214-isolation-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-214-isolation-home-"))
  const { ctx, nativeSessions, prompts } = fakeContext()
  for (const sessionID of ["s_group", "s_direct", "s_home"]) nativeSessions.set(sessionID, { id: sessionID })
  ;(ctx.session as any).context = async ({ sessionID }: any) => ({
    data: [{ type: "assistant", time: { created: 1 }, content: [{ type: "text", text: sessionID === "s_group" ? "GROUP NATIVE" : "DIRECT NATIVE" }] }],
  })
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed, { homeDirectory: home })
  await seedWorkspace(seed, directory)
  await seed.saveBinding({ workspaceID: "w", agentID: "a", sessionID: "s_group", kind: "workspace", directory, agentVersion: 1, updatedAt: 1 })
  await seed.saveBinding({ workspaceID: "w", agentID: "a", sessionID: "s_direct", kind: "direct", directory, agentVersion: 1, updatedAt: 1 })
  await seed.saveBinding({ workspaceID: "home", agentID: "a", sessionID: "s_home", kind: "home", directory: home, agentVersion: 1, updatedAt: 1 })
  await seed.appendMessage("w", { id: "m_group", author: "user", text: "GROUP CHANNEL", kind: "text", createdAt: 10 })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    const context = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a", workspaceID: "w" } })
    assert.equal(context.result.sessionID, "s_direct")
    assert.equal(context.result.conversation.durable, true, "native-first direct chat reads its durable channel")
    assert.equal(context.result.conversation.channel, "dm:a:w")
    const texts = (context.result.messages as any[]).map((message) => message.text)
    assert.ok(!texts.includes("DIRECT NATIVE"), "ticket #215 stops polling the native direct transcript")
    assert.ok(!texts.includes("GROUP NATIVE"), "group native context never leaks into direct chat")
    assert.ok(!texts.includes("GROUP CHANNEL"), "group messages never leak into direct chat")

    const sent = await handlers.invoke({ directory, action: "chat.send", payload: { agentID: "a", workspaceID: "w", text: "DIRECT LINE" } })
    assert.equal(sent.result.queued, false)
    assert.equal(prompts.at(-1).sessionID, "s_direct", "direct prompts target the direct session")

    const snapshot = await handlers.snapshot({ directory })
    assert.deepEqual(snapshot.state.messages["w"].map((message: any) => message.text), ["GROUP CHANNEL"])
    assert.ok(snapshot.state.messages["dm:a:w"].some((message: any) => message.text === "DIRECT LINE"))
    assert.deepEqual(Object.keys(snapshot.state.subtasks), [], "a direct message mints no group turn")
    assert.equal(snapshot.state.bindings["w:a"].sessionID, "s_group")
    assert.equal(snapshot.state.bindings["home:a"].sessionID, "s_home")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket214: a busy group turn does not block or queue direct chat", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-214-group-busy-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-214-group-busy-home-"))
  const { ctx, nativeSessions, prompts } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 300)) }
  await seedDirectChat(ctx, directory, home)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: "w", text: "Group work" } })
    await waitFor(async () => prompts.some((prompt) => prompt.sessionID === "s_group"))

    const sent = await handlers.invoke({ directory, action: "chat.send", payload: { agentID: "a", workspaceID: "w", text: "Private work" } })
    assert.equal(sent.result.queued, false, "the group turn holds only the group session")
    const directPrompt = prompts.at(-1)
    assert.notEqual(directPrompt.sessionID, "s_group")
    const snapshot = await handlers.snapshot({ directory })
    assert.deepEqual(Object.keys(snapshot.state.dmQueue), [], "nothing is parked behind the group turn")
    const context = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a", workspaceID: "w" } })
    assert.equal(context.result.busy, true, "the direct turn is busy on its own session")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket214: workspace direct queueing, send, and flush stay on the direct session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-214-direct-busy-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-214-direct-busy-home-"))
  const { ctx, nativeSessions, prompts } = fakeContext()
  for (const sessionID of ["s_group", "s_direct"]) nativeSessions.set(sessionID, { id: sessionID })
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 200)) }
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed, { homeDirectory: home })
  await seedWorkspace(seed, directory)
  await seed.saveBinding({ workspaceID: "w", agentID: "a", sessionID: "s_group", kind: "workspace", directory, agentVersion: 1, updatedAt: 1 })
  await seed.saveBinding({ workspaceID: "w", agentID: "a", sessionID: "s_direct", kind: "direct", directory, agentVersion: 1, updatedAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    const first = await handlers.invoke({ directory, action: "chat.send", payload: { agentID: "a", workspaceID: "w", text: "First" } })
    assert.equal(first.result.queued, false)
    const queued = await handlers.invoke({ directory, action: "chat.send", payload: { agentID: "a", workspaceID: "w", text: "While busy" } })
    assert.equal(queued.result.queued, true)
    const during = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a", workspaceID: "w" } })
    assert.equal(during.result.sessionID, "s_direct")
    assert.equal(during.result.busy, true)
    assert.equal(during.result.queued, 1)
    const visible = (during.result.messages as any[]).filter((message) => message.role === "user")
    assert.deepEqual(visible.map((message) => message.text), ["First", "While busy"])
    assert.equal(visible[1].queued, true)

    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.dmQueue).every((entry: any) => entry.status === "sent")
    }, 4000)
    const sentPrompts = prompts.filter((prompt) => prompt.sessionID === "s_direct")
    assert.deepEqual(sentPrompts.map((prompt) => prompt.text), ["First", "While busy"], "flush targets the direct session")
    assert.deepEqual(prompts.filter((prompt) => prompt.sessionID === "s_group"), [], "the group session never receives direct text")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket214: a group turn settling never flushes the direct queue into a busy direct session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-214-flush-guard-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-214-flush-guard-home-"))
  const { ctx, nativeSessions, prompts } = fakeContext()
  for (const sessionID of ["s_group", "s_direct"]) nativeSessions.set(sessionID, { id: sessionID })
  ;(ctx.session as any).wait = async ({ sessionID }: any) => {
    await new Promise((resolve) => setTimeout(resolve, sessionID === "s_group" ? 5 : 300))
  }
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed, { homeDirectory: home })
  await seedWorkspace(seed, directory)
  await seed.saveBinding({ workspaceID: "w", agentID: "a", sessionID: "s_group", kind: "workspace", directory, agentVersion: 1, updatedAt: 1 })
  await seed.saveBinding({ workspaceID: "w", agentID: "a", sessionID: "s_direct", kind: "direct", directory, agentVersion: 1, updatedAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    await handlers.invoke({ directory, action: "chat.send", payload: { agentID: "a", workspaceID: "w", text: "First" } })
    const queued = await handlers.invoke({ directory, action: "chat.send", payload: { agentID: "a", workspaceID: "w", text: "While busy" } })
    assert.equal(queued.result.queued, true)

    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: "w", text: "Group work" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.state === "replied")
    })
    const during = await handlers.snapshot({ directory })
    assert.equal(during.state.dmQueue[queued.result.id].status, "queued", "the direct session still owns its queue")
    assert.deepEqual(prompts.filter((prompt) => prompt.sessionID === "s_direct").map((prompt) => prompt.text), ["First"])

    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return next.state.dmQueue[queued.result.id]?.status === "sent"
    }, 4000)
    assert.deepEqual(prompts.filter((prompt) => prompt.sessionID === "s_direct").map((prompt) => prompt.text), ["First", "While busy"])
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket214: nativeFirst off and shadow keep the old direct selection and on rolls back cleanly", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-214-flag-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-214-flag-home-"))
  const { ctx, nativeSessions, prompts, createdSessionIDs } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  await seedDirectChat(ctx, directory, home)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const legacy = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a", workspaceID: "w" } })
    assert.equal(legacy.result.sessionID, "s_group", "off keeps the pre-cutover selection")
    assert.equal(legacy.result.conversation.kind, "workspace")
    assert.equal(legacy.result.conversation.sharedSession, true, "the label reports the shared rollback session")
    await handlers.invoke({ directory, action: "chat.send", payload: { agentID: "a", workspaceID: "w", text: "Off path" } })
    assert.equal(prompts.at(-1).sessionID, "s_group")

    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "shadow" } })
    const shadow = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a", workspaceID: "w" } })
    assert.equal(shadow.result.sessionID, "s_group", "shadow does not change the visible path")
    assert.equal(createdSessionIDs.length, 0)

    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    const cut = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a", workspaceID: "w" } })
    assert.notEqual(cut.result.sessionID, "s_group")
    assert.equal(cut.result.conversation.kind, "direct")
    assert.equal(cut.result.conversation.sharedSession, false)
    assert.equal(createdSessionIDs.length, 1)
    await handlers.invoke({ directory, action: "chat.send", payload: { agentID: "a", workspaceID: "w", text: "On path" } })
    assert.equal(prompts.at(-1).sessionID, cut.result.sessionID)

    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "off" } })
    const rolledBack = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a", workspaceID: "w" } })
    assert.equal(rolledBack.result.sessionID, "s_group", "rollback returns to the old selection")
    await waitFor(async () => !(await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a", workspaceID: "w" } })).result.busy)
    await handlers.invoke({ directory, action: "chat.send", payload: { agentID: "a", workspaceID: "w", text: "Rolled back" } })
    assert.equal(prompts.at(-1).sessionID, "s_group")
    const stored = await handlers.snapshot({ directory })
    assert.equal(stored.state.bindings["dm:a:w"].sessionID, cut.result.sessionID, "rollback never deletes the direct binding")

    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    const resumed = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a", workspaceID: "w" } })
    assert.equal(resumed.result.sessionID, cut.result.sessionID, "re-enabling reuses the direct session")
    assert.equal(createdSessionIDs.length, 1, "rollback and resume never fork the direct session")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket214: a permission on the direct session never posts into the group conversation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-214-permission-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-214-permission-home-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  for (const sessionID of ["s_group", "s_direct"]) nativeSessions.set(sessionID, { id: sessionID })
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed, { homeDirectory: home })
  await seedWorkspace(seed, directory)
  await seed.saveBinding({ workspaceID: "w", agentID: "a", sessionID: "s_group", kind: "workspace", directory, agentVersion: 1, updatedAt: 1 })
  await seed.saveBinding({ workspaceID: "w", agentID: "a", sessionID: "s_direct", kind: "direct", directory, agentVersion: 1, updatedAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    emitEvent({ type: "permission.asked", data: { sessionID: "s_direct", id: "perm_direct", action: "read", resources: ["notes.txt"] } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.approvals).some((approval: any) => approval.status === "pending" && approval.kind === "native")
    })
    const snapshot = await handlers.snapshot({ directory })
    assert.deepEqual(snapshot.state.messages["w"] ?? [], [], "direct-session activity stays out of the group transcript")
    const approval = Object.values(snapshot.state.approvals).find((row: any) => row.kind === "native") as any
    assert.equal(approval.workspaceID, undefined, "the approval carries no group channel")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket214: moving a home direct session into a workspace targets the direct conversation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-214-move-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-214-move-home-"))
  const { ctx, nativeSessions, movedSessions } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed, { homeDirectory: home })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    const homeChat = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a" } })
    const homeSession = homeChat.result.sessionID
    nativeSessions.set(homeSession, { id: homeSession })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: ["a"], leaderID: "a" } })

    const moved = await handlers.invoke({ directory, action: "agent.moveHome", payload: { agentID: "a", workspaceID: workspace.result.id } })
    assert.equal(moved.result.moved, true)
    assert.equal(movedSessions.length, 1)
    assert.equal(movedSessions[0]!.sessionID, homeSession)
    assert.equal(movedSessions[0]!.directory, directory)

    const afterMove = await handlers.snapshot({ directory })
    assert.equal(afterMove.state.bindings["home:a"], undefined)
    assert.equal(afterMove.state.bindings[`${workspace.result.id}:a`], undefined, "the group conversation gains no binding")
    const direct = afterMove.state.bindings[`dm:a:${workspace.result.id}`]
    assert.equal(direct.kind, "direct")
    assert.equal(direct.sessionID, homeSession)

    const directChat = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a", workspaceID: workspace.result.id } })
    assert.equal(directChat.result.conversation.kind, "direct")
    assert.equal(directChat.result.sessionID, homeSession)

    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.result.id, text: "Group work" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Boolean(next.state.bindings[`${workspace.result.id}:a`]?.sessionID)
    })
    const grouped = await handlers.snapshot({ directory })
    assert.notEqual(grouped.state.bindings[`${workspace.result.id}:a`].sessionID, homeSession, "group chat creates its own session")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket214: a busy home direct session is never moved into a workspace", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-214-move-busy-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-214-move-busy-home-"))
  const { ctx, nativeSessions, movedSessions } = fakeContext()
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 300)) }
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed, { homeDirectory: home })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    const homeChat = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a" } })
    nativeSessions.set(homeChat.result.sessionID, { id: homeChat.result.sessionID })
    await handlers.invoke({ directory, action: "chat.send", payload: { agentID: "a", text: "Hold the session" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: ["a"], leaderID: "a" } })
    const moved = await handlers.invoke({ directory, action: "agent.moveHome", payload: { agentID: "a", workspaceID: workspace.result.id } })
    assert.equal(moved.ok, false)
    assert.equal(moved.error?.code, "session_busy")
    assert.deepEqual(movedSessions, [])
    const snapshot = await handlers.snapshot({ directory })
    assert.equal(snapshot.state.bindings["home:a"].sessionID, homeChat.result.sessionID)
    assert.equal(snapshot.state.bindings[`dm:a:${workspace.result.id}`], undefined)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket214: parallel workspace direct opens create only one direct session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-214-parallel-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-214-parallel-home-"))
  const { ctx, nativeSessions, createdSessionIDs } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  await seedDirectChat(ctx, directory, home)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    await Promise.all([
      handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a", workspaceID: "w" } }),
      handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a", workspaceID: "w" } }),
      handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a", workspaceID: "w" } }),
    ])
    assert.equal(createdSessionIDs.length, 1)
    const after = await handlers.snapshot({ directory })
    assert.equal(Object.keys(after.state.bindings).sort().join(","), "dm:a:w,w:a")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("a direct attachment reaches the agent prompt and the transcript as metadata only", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-attachments-"))
  const { ctx, prompts } = fakeContext()
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
    const workspaceID = workspace.result.id
    const source = join(directory, "review-notes.md")
    writeFileSync(source, "private attachment body")
    const added = await handlers.invoke({
      directory,
      action: "attachment.add",
      payload: { workspaceID, agentID: agent.result.id, path: source },
    })
    assert.equal(added.ok, true)
    assert.equal(added.result.mime, "text/markdown")
    assert.equal(added.result.size, "private attachment body".length)
    assert.equal(JSON.stringify(added.result).includes(directory), false, "the add result carries no store path")

    const sent = await handlers.invoke({
      directory,
      action: "chat.send",
      payload: { workspaceID, agentID: agent.result.id, text: "Review the notes", attachments: [added.result.id] },
    })
    assert.equal(sent.ok, true)

    const prompt = prompts.find((entry) => Array.isArray(entry.files) && entry.files.length > 0)
    assert.ok(prompt, "the direct prompt carries the file attachment")
    assert.equal(prompt.files[0].name, "review-notes.md")
    assert.match(prompt.files[0].uri, /^file:\/\//)
    assert.match(prompt.files[0].description, /text\/markdown/)
    assert.equal(prompt.files[0].uri.includes("private attachment body"), false)

    const context = await handlers.invoke({ directory, action: "chat.context", payload: { workspaceID, agentID: agent.result.id } })
    const user = context.result.messages.find((message: any) => message.role === "user" && message.text === "Review the notes")
    if (!user?.attachments) throw new Error("the direct transcript did not store the user line with attachments")
    assert.deepEqual(user.attachments.map(({ name, mime, size, kind }: any) => ({ name, mime, size, kind })), [
      { name: "review-notes.md", mime: "text/markdown", size: 23, kind: "file" },
    ])

    const snapshot = await handlers.snapshot({ directory })
    const serialized = JSON.stringify(snapshot.state)
    assert.equal(serialized.includes("private attachment body"), false)
    assert.equal(serialized.includes(".ensemble/attachments"), false)
    assert.equal(serialized.includes("review-notes.md"), true, "the display name survives")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a group attachment reaches group prompts and transcript chips", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-attachments-"))
  const { ctx, prompts } = fakeContext()
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
    const workspaceID = workspace.result.id
    const source = join(directory, "diagram.png")
    writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]))
    const added = await handlers.invoke({ directory, action: "attachment.add", payload: { workspaceID, path: source } })
    assert.equal(added.ok, true)
    assert.equal(added.result.kind, "image")

    const sent = await handlers.invoke({
      directory,
      action: "message.send",
      payload: { workspaceID, text: "Look at this", attachments: [added.result.id] },
    })
    assert.equal(sent.ok, true)
    await waitFor(() => Promise.resolve(prompts.some((entry) => Array.isArray(entry.files) && entry.files.length > 0)))
    const prompt = prompts.find((entry) => Array.isArray(entry.files) && entry.files.length > 0)
    assert.equal(prompt.files[0].name, "diagram.png")
    assert.match(prompt.files[0].uri, /^file:\/\//)

    const snapshot = await handlers.snapshot({ directory })
    const user = snapshot.state.messages[workspaceID].find((message: any) => message.author === "user")
    if (!user?.attachments) throw new Error("the group transcript did not store attachment metadata")
    assert.deepEqual(user.attachments.map(({ name, mime, size, kind }: any) => ({ name, mime, size, kind })), [
      { name: "diagram.png", mime: "image/png", size: 9, kind: "image" },
    ])
    const task = Object.values(snapshot.state.subtasks)[0] as any
    assert.deepEqual(task.attachments.map(({ name }: any) => name), ["diagram.png"])
    assert.equal(JSON.stringify(snapshot.state).includes("private attachment body"), false)
    assert.equal(JSON.stringify(snapshot.state).includes(".ensemble/attachments"), false)

    const deleted = await handlers.invoke({ directory, action: "workspace.delete", payload: { id: workspaceID } })
    assert.equal(deleted.ok, true)
    assert.equal(existsSync(join(directory, ".ensemble", "attachments")), false, "conversation cleanup removes the store")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("oversized and too-many attachments are rejected before a prompt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-attachments-"))
  const { ctx, prompts } = fakeContext()
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
    const workspaceID = workspace.result.id
    const big = join(directory, "too-big.bin")
    writeFileSync(big, Buffer.alloc(10 * 1024 * 1024 + 1))
    const oversized = await handlers.invoke({ directory, action: "attachment.add", payload: { workspaceID, path: big } })
    assert.equal(oversized.ok, false)
    assert.ok(oversized.error)
    assert.match(oversized.error.message, /too-big\.bin/)
    assert.match(oversized.error.message, /limit is 10\.0 MB per file/)

    const ids: string[] = []
    for (let index = 0; index < 9; index += 1) {
      const source = join(directory, `note-${index}.txt`)
      writeFileSync(source, `note ${index}`)
      const added = await handlers.invoke({ directory, action: "attachment.add", payload: { workspaceID, path: source } })
      assert.equal(added.ok, true)
      ids.push(added.result.id)
    }
    const tooMany = await handlers.invoke({
      directory,
      action: "message.send",
      payload: { workspaceID, text: "Too many", attachments: ids },
    })
    assert.equal(tooMany.ok, false)
    assert.ok(tooMany.error)
    assert.match(tooMany.error.message, /Up to 8 files per message/)
    assert.equal(prompts.length, 0, "rejection happens before any prompt")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("an attachment-only message can send a clipboard image without text", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-attachments-"))
  const { ctx, prompts } = fakeContext()
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
    const workspaceID = workspace.result.id
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02])
    const added = await handlers.invoke({
      directory,
      action: "attachment.add",
      payload: { workspaceID, data: png.toString("base64"), mime: "image/png", name: "pasted.png" },
    })
    assert.equal(added.ok, true)
    assert.equal(added.result.name, "pasted.png")
    assert.equal(added.result.kind, "image")

    const sent = await handlers.invoke({
      directory,
      action: "message.send",
      payload: { workspaceID, text: "", attachments: [added.result.id] },
    })
    assert.equal(sent.ok, true)
    await waitFor(() => Promise.resolve(prompts.some((entry) => Array.isArray(entry.files) && entry.files.length > 0)))
    const prompt = prompts.find((entry) => Array.isArray(entry.files) && entry.files.length > 0)
    assert.equal(prompt.files[0].name, "pasted.png")
    const snapshot = await handlers.snapshot({ directory })
    const user = snapshot.state.messages[workspaceID].find((message: any) => message.author === "user")
    if (!user?.attachments) throw new Error("the attachment-only send did not store metadata")
    assert.equal(user.text, "")
    assert.equal(user.attachments[0].kind, "image")
    const task = Object.values(snapshot.state.subtasks)[0] as any
    assert.match(task.title, /Attachment: pasted\.png/)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

// ---- Ticket #215: direct native turn ingestion ----

async function seedNativeDirect(ctx: any, directory: string, homeDirectory: string): Promise<void> {
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed, { homeDirectory })
  await seedWorkspace(seed, directory)
  await seed.saveBinding({
    workspaceID: "w",
    agentID: "a",
    sessionID: "s_direct",
    kind: "direct",
    directory,
    agentVersion: 1,
    updatedAt: 1,
  })
}

async function seedNativeFirstOn(ctx: any): Promise<void> {
  const seed = new V2Store(ctx)
  await seed.load()
  await seed.updateSettings({ nativeFirst: "on" })
}

function nativeEvent(type: string, data: Record<string, unknown>, patch: Record<string, unknown> = {}): any {
  return { type, data, ...patch }
}

async function snapshotFor(handlers: Handlers, directory: string): Promise<any> {
  return (await handlers.snapshot({ directory })).state
}

test("ticket215: a slow session's ingest never blocks another session's events", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-215-parallel-"))
  const { ctx } = fakeContext()
  await seedNativeFirstOn(ctx)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  let releaseFirst!: () => void
  try {
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let firstStarted!: () => void
    const started = new Promise<void>((resolve) => { firstStarted = resolve })
    const processed: string[] = []
    ;(service as any).handleNativeIngestEvent = async (event: any) => {
      const sessionID = event?.data?.sessionID
      if (sessionID === "s_slow") {
        processed.push("slow-start")
        firstStarted()
        await firstGate
        processed.push("slow-done")
        return
      }
      if (sessionID === "s_fast") processed.push("fast")
    }
    const first = service.handleHostEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_slow",
      inboxID: "m_slow",
      item: { type: "user", delivery: "steer", payload: { text: "slow" } },
    }, { id: "evt_parallel_slow", created: 1 }))
    await started
    const second = service.handleHostEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_fast",
      inboxID: "m_fast",
      item: { type: "user", delivery: "steer", payload: { text: "fast" } },
    }, { id: "evt_parallel_fast", created: 2 }))
    await waitFor(async () => processed.includes("fast"))
    assert.deepEqual(processed, ["slow-start", "fast"], "the second session ingests while the first is still settling")
    releaseFirst()
    await Promise.all([first, second])
    assert.deepEqual(processed, ["slow-start", "fast", "slow-done"])
  } finally {
    releaseFirst()
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket215: a native direct turn becomes one durable user row, one exact agent row, and a Work card", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-215-direct-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-215-home-"))
  const { ctx, nativeSessions, emitted, emitEvent, prompts } = fakeContext()
  nativeSessions.set("s_direct", { id: "s_direct" })
  await seedNativeDirect(ctx, directory, home)
  let contextCalls = 0
  const contextRead = (ctx.session as any).context as (input: any) => Promise<any>
  ;(ctx.session as any).context = async (input: any) => {
    contextCalls++
    return contextRead(input)
  }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })

    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_direct",
      inboxID: "m1",
      item: {
        type: "user",
        delivery: "steer",
        payload: {
          text: "Fix the build",
          files: [{ name: "note.txt", mime: "text/plain", dataLength: 12 }],
        },
      },
    }, { id: "evt_215_enqueue", created: 100 }))

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      return (state.messages["dm:a:w"] ?? []).length === 1
    })
    const queued = await snapshotFor(handlers, directory)
    const user = queued.messages["dm:a:w"][0]
    assert.equal(user.author, "user")
    assert.equal(user.text, "Fix the build")
    assert.equal(user.channel, "dm:a:w")
    assert.equal(user.native.inboxID, "m1")
    assert.equal(user.attachments[0].name, "note.txt")
    assert.equal(JSON.stringify(queued).includes("Fix the build") === false, false)
    const turn = Object.values(queued.subtasks).find((task: any) => task.origin === "native") as any
    assert.ok(turn, "enqueue opens the durable native turn immediately")
    assert.equal(turn.adopted, undefined, "a native turn is not an adoption record")
    assert.equal(turn.workKind, "turn")
    assert.equal(turn.conversationID, "dm:a:w")
    assert.equal(turn.workspaceID, "dm:a:w")
    assert.equal(turn.native.phase, "queued")
    assert.equal(turn.native.inboxID, "m1")
    assert.deepEqual(turn.native.events?.map((event: any) => event.type), ["session.inbox.enqueued"], "the queued turn carries its identity timeline")
    assert.equal(deriveWorkStatus(turn, Date.now()), "pending")
    assert.ok(projectVisibleWork(queued, Date.now())[turn.id], "the queued turn is a visible Work card")

    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_direct" }, { id: "evt_215_start", created: 101 }))
    emitEvent(nativeEvent("session.inbox.delivered", { sessionID: "s_direct", inboxID: "m1" }, { id: "evt_215_delivered", created: 102 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0 }, { id: "evt_215_text_started", created: 103 }))
    emitEvent(nativeEvent("session.text.delta", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0, delta: "Fixed" }, { id: "evt_215_delta_1", created: 104 }))

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      const row = (state.messages["dm:a:w"] ?? []).find((message: any) => message.author === "agent")
      return row?.streaming === true && row?.text === "Fixed"
    })
    const live = await snapshotFor(handlers, directory)
    const liveTurn = Object.values(live.subtasks).find((task: any) => task.origin === "native") as any
    assert.equal(liveTurn.native.phase, "working")
    assert.equal(deriveWorkStatus(liveTurn, Date.now()), "working")
    assert.equal(live.messages["dm:a:w"].length, 2, "the stream reuses one durable agent row")

    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0, text: "Fixed the build." }, { id: "evt_215_text_ended", created: 105 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_direct" }, { id: "evt_215_succeeded", created: 106 }))

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      const row = (state.messages["dm:a:w"] ?? []).find((message: any) => message.author === "agent")
      return row?.streaming === false && row?.text === "Fixed the build."
    })
    const settled = await snapshotFor(handlers, directory)
    const rows = settled.messages["dm:a:w"]
    assert.equal(rows.length, 2, "one durable user row and one durable agent row")
    const answer = rows.find((message: any) => message.author === "agent")
    const settledTurn = Object.values(settled.subtasks).find((task: any) => task.origin === "native") as any
    assert.equal(answer.taskID, settledTurn.id, "the answer is linked to the turn")
    assert.equal(answer.native.assistantMessageID, "m2")
    assert.equal(settledTurn.native.phase, "replied")
    assert.equal(settledTurn.state, "replied")
    assert.equal(settledTurn.outcome, "succeeded")
    assert.equal(settledTurn.resultMessageID, answer.id)
    assert.equal(deriveWorkStatus(settledTurn, Date.now()), "replied")
    const eventTypes = settledTurn.native.events?.map((event: any) => event.type) ?? []
    assert.deepEqual(
      eventTypes,
      ["session.inbox.enqueued", "session.execution.started", "session.inbox.delivered", "session.text.started", "session.execution.succeeded"],
      "the turn keeps an identity-only host event timeline",
    )
    assert.ok(
      projectVisibleWork(settled, (settledTurn.finishedAt ?? Date.now()) + 500)[settledTurn.id],
      "the Work card persists through the completion hold",
    )

    assert.equal(contextCalls, 0, "a complete text.ended turn never reads the native transcript")
    const context = await handlers.invoke({ directory, action: "chat.context", payload: { agentID: "a", workspaceID: "w" } })
    assert.equal(context.ok, true)
    assert.equal(context.result.conversation.durable, true)
    assert.equal(context.result.conversation.channel, "dm:a:w")
    assert.deepEqual(context.result.messages.map((message: any) => [message.role, message.text]), [
      ["user", "Fix the build"],
      ["assistant", "Fixed the build."],
    ])
    assert.equal(contextCalls, 0, "the durable direct read does not poll the native transcript")
    assert.ok(emitted.some((event) => event.name === "patches"), "durable rows publish patches")
    assert.ok(!emitted.some((event) => event.name === "snapshot"), "a normal turn never pushes a full snapshot")

    await handlers.invoke({ directory, action: "chat.send", payload: { agentID: "a", workspaceID: "w", text: "Composer prompt" } })
    assert.equal(prompts.at(-1).metadata?.["ensemble.internal"], true, "service prompts carry the internal marker")
    assert.ok(prompts.at(-1).metadata?.["ensemble.messageID"], "the prompt names the durable user row it attaches to")
    // The composer already wrote its user row; the host enqueue for the same
    // prompt attaches a turn and mirrors the answer without a second user row.
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_direct",
      inboxID: "m3",
      item: { type: "user", delivery: "queue", payload: { text: "Composer prompt", metadata: { "ensemble.internal": true } } },
    }, { id: "evt_215_composer_enqueue", created: 200 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_direct" }, { id: "evt_215_composer_start", created: 201 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_direct", assistantMessageID: "m4", ordinal: 0 }, { id: "evt_215_composer_text", created: 202 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_direct", assistantMessageID: "m4", ordinal: 0, text: "Composer answer." }, { id: "evt_215_composer_ended", created: 203 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_direct" }, { id: "evt_215_composer_done", created: 204 }))
    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      return (state.messages["dm:a:w"] ?? []).some((message: any) => message.text === "Composer answer.")
    })
    const composerRows = (await snapshotFor(handlers, directory)).messages["dm:a:w"]
    assert.equal(composerRows.filter((message: any) => message.author === "user" && message.text === "Composer prompt").length, 1)
    assert.equal(composerRows.filter((message: any) => message.author === "agent").length, 2)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket215: duplicate, repeated, and reordered native events never duplicate rows or turns", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-215-dupes-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-215-dupes-home-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_direct", { id: "s_direct" })
  await seedNativeDirect(ctx, directory, home)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    const enqueue = nativeEvent("session.inbox.enqueued", {
      sessionID: "s_direct",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Check it" } },
    })
    emitEvent({ ...enqueue, id: "evt_dup_enqueue", created: 10 })
    emitEvent({ ...enqueue, id: "evt_dup_enqueue_again", created: 10 })
    emitEvent({ ...enqueue, id: "evt_dup_enqueue", created: 10 })
    // Reordered text: a delta before its started event still lands in one row.
    emitEvent(nativeEvent("session.text.delta", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0, delta: "Check" }, { id: "evt_dup_delta", created: 12 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0 }, { id: "evt_dup_started", created: 11 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0, text: "Checked." }, { id: "evt_dup_ended", created: 13 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0, text: "Checked." }, { id: "evt_dup_ended_again", created: 13 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_direct" }, { id: "evt_dup_exec_start", created: 14 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_direct" }, { id: "evt_dup_exec_start_again", created: 14 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_direct" }, { id: "evt_dup_exec_done", created: 15 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_direct" }, { id: "evt_dup_exec_done_again", created: 15 }))
    emitEvent(nativeEvent("session.inbox.delivered", { sessionID: "s_direct", inboxID: "m1" }, { id: "evt_dup_delivered", created: 16 }))
    emitEvent(nativeEvent("session.inbox.delivered", { sessionID: "s_direct", inboxID: "m1" }, { id: "evt_dup_delivered_again", created: 16 }))

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      const turn = Object.values(state.subtasks).find((task: any) => task.origin === "native") as any
      return turn?.native?.phase === "replied"
    })
    const state = await snapshotFor(handlers, directory)
    assert.equal(state.messages["dm:a:w"].length, 2, "duplicate enqueue/settle events did not add rows")
    assert.equal(Object.values(state.subtasks).filter((task: any) => task.origin === "native").length, 1)
    const answer = state.messages["dm:a:w"].find((message: any) => message.author === "agent")
    assert.equal(answer.text, "Checked.")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket215: a missing text.ended part falls back to one native context read without a row gap", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-215-fallback-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-215-fallback-home-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_direct", { id: "s_direct" })
  await seedNativeDirect(ctx, directory, home)
  let contextCalls = 0
  ;(ctx.session as any).context = async () => {
    contextCalls++
    return {
      data: [
        { id: "m1", type: "user", content: [{ type: "text", text: "Fix it" }], time: { created: 1 } },
        { id: "m2", type: "assistant", content: [{ type: "text", text: "Recovered exact answer" }], time: { created: 2 } },
        { id: "m3", type: "idle" },
      ],
    }
  }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_direct",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Fix it" } },
    }, { id: "evt_fb_enqueue", created: 10 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_direct" }, { id: "evt_fb_start", created: 11 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0 }, { id: "evt_fb_text", created: 12 }))
    emitEvent(nativeEvent("session.text.delta", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0, delta: "Recovered" }, { id: "evt_fb_delta", created: 13 }))
    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      return (state.messages["dm:a:w"] ?? []).some((message: any) => message.author === "agent" && message.streaming === true)
    })
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_direct" }, { id: "evt_fb_done", created: 14 }))
    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      const row = (state.messages["dm:a:w"] ?? []).find((message: any) => message.author === "agent")
      return row?.streaming === false && row?.text === "Recovered exact answer"
    })
    assert.equal(contextCalls, 1, "exactly one fallback read for the missing part")
    const state = await snapshotFor(handlers, directory)
    const turn = Object.values(state.subtasks).find((task: any) => task.origin === "native") as any
    assert.equal(turn.native.phase, "replied")
    assert.equal(turn.resultMessageID, state.messages["dm:a:w"].find((message: any) => message.author === "agent").id)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket215: internal service prompts are not mirrored as user messages", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-215-internal-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-215-internal-home-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_direct", { id: "s_direct" })
  await seedNativeDirect(ctx, directory, home)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_direct",
      inboxID: "m9",
      item: {
        type: "user",
        delivery: "steer",
        payload: { text: "hidden identity prompt", metadata: { "ensemble.internal": true } },
      },
    }, { id: "evt_internal_enqueue", created: 10 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_direct" }, { id: "evt_internal_start", created: 11 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_direct", assistantMessageID: "m10", ordinal: 0 }, { id: "evt_internal_text", created: 12 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_direct", assistantMessageID: "m10", ordinal: 0, text: "Visible answer." }, { id: "evt_internal_ended", created: 13 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_direct" }, { id: "evt_internal_done", created: 14 }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    const state = await snapshotFor(handlers, directory)
    assert.equal(state.messages["dm:a:w"], undefined, "an internal-only prompt mirrors nothing")
    assert.equal(Object.values(state.subtasks).filter((task: any) => task.origin === "native").length, 0)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket215: restart recovers the answer or marks the turn interrupted honestly", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-215-restart-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-215-restart-home-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_direct", { id: "s_direct" })
  await seedNativeDirect(ctx, directory, home)
  const first = new EnsembleV2Service(ctx)
  const stopFirst = await startServiceForTest(first, first.ctx)
  try {
    await first.handlers().invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_direct",
      inboxID: "m20",
      item: { type: "user", delivery: "steer", payload: { text: "Survive restart" } },
    }, { id: "evt_restart_enqueue", created: 10 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_direct" }, { id: "evt_restart_start", created: 11 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_direct", assistantMessageID: "m21", ordinal: 0 }, { id: "evt_restart_text", created: 12 }))
    emitEvent(nativeEvent("session.text.delta", { sessionID: "s_direct", assistantMessageID: "m21", ordinal: 0, delta: "Partial" }, { id: "evt_restart_delta", created: 13 }))
    await waitFor(async () => {
      const state = await snapshotFor(first.handlers(), directory)
      const turn = Object.values(state.subtasks).find((task: any) => task.origin === "native") as any
      return turn?.native?.phase === "working" && (state.messages["dm:a:w"] ?? []).some((message: any) => message.streaming)
    })
  } finally {
    await stopFirst()
  }

  ;(ctx.session as any).context = async () => ({
    data: [
      { id: "m20", type: "user", content: [{ type: "text", text: "Survive restart" }], time: { created: 1 } },
      { id: "m21", type: "assistant", content: [{ type: "text", text: "Recovered after restart" }], time: { created: 2 } },
      { id: "m22", type: "idle" },
    ],
  })
  const second = new EnsembleV2Service(ctx)
  const stopSecond = await startServiceForTest(second, second.ctx)
  try {
    await waitFor(async () => {
      const state = await snapshotFor(second.handlers(), directory)
      const turn = Object.values(state.subtasks).find((task: any) => task.origin === "native") as any
      return turn?.native?.phase === "replied"
    })
    const recovered = await snapshotFor(second.handlers(), directory)
    const turn = Object.values(recovered.subtasks).find((task: any) => task.origin === "native") as any
    const row = (recovered.messages["dm:a:w"] ?? []).find((message: any) => message.author === "agent")
    assert.equal(row.text, "Recovered after restart")
    assert.equal(row.streaming, false)
    assert.equal(row.interrupted, false)
    assert.equal(turn.state, "replied")
    assert.equal(turn.native.phase, "replied")
    assert.equal(turn.resultMessageID, row.id)
  } finally {
    await stopSecond()
  }

  // Seed a second, still-working turn with only a streaming partial row.
  const seed = new V2Store(ctx)
  await seed.load()
  await seed.saveSubtask({
    id: "task_native_restart_missing",
    workspaceID: "dm:a:w",
    creatorType: "user",
    assigneeID: "a",
    title: "Interrupted turn",
    instruction: "Interrupted turn",
    mode: "research",
    state: "working",
    stage: "initial",
    outcome: "pending",
    interrupted: false,
    awaitingChildren: false,
    attempts: 0,
    createdAt: 20,
    workKind: "turn",
    origin: "native",
    adopted: true,
    conversationID: "dm:a:w",
    dispatchGroupID: "group_native_restart_missing",
    native: { sessionID: "s_direct", inboxID: "m40", assistantMessageIDs: ["m41"], phase: "working" },
  })
  await seed.saveChannelMessage("dm:a:w", {
    id: nativeAssistantMessageID("task_native_restart_missing"),
    author: "agent",
    agentID: "a",
    text: "Partial before restart",
    kind: "text",
    taskID: "task_native_restart_missing",
    streaming: true,
    createdAt: 21,
    updatedAt: 21,
    native: { sessionID: "s_direct", inboxID: "m40", assistantMessageID: "m41", turnID: "task_native_restart_missing" },
  })
  ;(ctx.session as any).context = async () => ({
    data: [
      { id: "m40", type: "user", content: [{ type: "text", text: "Interrupted turn" }], time: { created: 20 } },
      { id: "m42", type: "idle" },
    ],
  })
  const third = new EnsembleV2Service(ctx)
  const stopThird = await startServiceForTest(third, third.ctx)
  try {
    await waitFor(async () => {
      const state = await snapshotFor(third.handlers(), directory)
      return state.subtasks["task_native_restart_missing"]?.native?.phase === "interrupted"
    })
    const state = await snapshotFor(third.handlers(), directory)
    const turn = state.subtasks["task_native_restart_missing"]
    assert.equal(turn.interrupted, true)
    assert.equal(deriveWorkStatus(turn, Date.now()), "needs_you")
    const row = (state.messages["dm:a:w"] ?? []).find((message: any) => message.native?.inboxID === "m40")
    assert.equal(row.text, "Partial before restart", "an interrupted turn preserves its durable partial text")
    assert.equal(row.streaming, false)
    assert.equal(row.interrupted, true)
  } finally {
    await stopThird()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket215: native ingestion is off unless nativeFirst is on", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-215-off-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-215-off-home-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_direct", { id: "s_direct" })
  await seedNativeDirect(ctx, directory, home)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_direct",
      inboxID: "m30",
      item: { type: "user", delivery: "steer", payload: { text: "Old path" } },
    }, { id: "evt_off_enqueue", created: 10 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_direct" }, { id: "evt_off_start", created: 11 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_direct", assistantMessageID: "m31", ordinal: 0 }, { id: "evt_off_text", created: 12 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_direct", assistantMessageID: "m31", ordinal: 0, text: "Old answer." }, { id: "evt_off_ended", created: 13 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_direct" }, { id: "evt_off_done", created: 14 }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    const state = await snapshotFor(handlers, directory)
    assert.equal(state.messages["dm:a:w"], undefined)
    assert.equal(Object.values(state.subtasks).filter((task: any) => task.origin === "native").length, 0)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

// ---- Ticket #216: workspace native turn ingestion ----

async function seedNativeWorkspace(
  ctx: any,
  directory: string,
  sessions: Record<string, string> = { a: "s_group" },
): Promise<void> {
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed)
  for (const agentID of Object.keys(sessions)) {
    if (agentID !== "a") await seedAgent(seed, { id: agentID, name: agentID.toUpperCase() })
  }
  await seedWorkspace(seed, directory, { memberIDs: Object.keys(sessions) })
  for (const [agentID, sessionID] of Object.entries(sessions)) {
    await seed.saveBinding({
      workspaceID: "w",
      agentID,
      sessionID,
      kind: "workspace",
      directory,
      agentVersion: 1,
      updatedAt: 1,
    })
  }
}

function nativeTurnIn(state: any, phase?: string): any | undefined {
  return Object.values(state.subtasks).find(
    (task: any) => task.origin === "native" && (phase === undefined || task.native?.phase === phase),
  ) as any
}

function nativeSubagentState(state: any, childSessionID: string): string | undefined {
  return state.nativeSubagents?.[childSessionID]?.state
}

test("ticket216: a native workspace turn becomes a durable group user row, one exact agent row, and a normal Work card", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-216-workspace-"))
  const { ctx, nativeSessions, emitted, emitEvent } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  await seedNativeWorkspace(ctx, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })

    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Ship the release" } },
    }, { id: "evt_216_enqueue", created: 100 }))

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      return (state.messages["w"] ?? []).length === 1
    })
    const queued = await snapshotFor(handlers, directory)
    const user = queued.messages["w"][0]
    assert.equal(user.author, "user")
    assert.equal(user.text, "Ship the release")
    assert.equal(user.workspaceID, "w")
    assert.equal(user.channel, "w", "the group conversation uses the workspace channel")
    assert.equal(user.native.inboxID, "m1")
    const turn = nativeTurnIn(queued)
    assert.ok(turn, "enqueue opens the durable native turn immediately")
    assert.equal(turn.adopted, undefined, "a native turn is not an adoption record")
    assert.equal(turn.workKind, "turn")
    assert.equal(turn.assigneeID, "a")
    assert.equal(turn.workspaceID, "w", "the group Work pane filters by workspace id")
    assert.equal(turn.conversationID, "w")
    assert.equal(turn.native.sessionID, "s_group")
    assert.equal(turn.native.phase, "queued")
    assert.equal(deriveWorkStatus(turn, Date.now()), "pending")
    assert.ok(projectVisibleWork(queued, Date.now())[turn.id], "the queued turn is a visible Work card")
    const groups = allWorkGroupsForTasks(Object.values(queued.subtasks), queued.subtasks, { now: Date.now() })
    const group = groups.find((candidate) => candidate.id === turn.dispatchGroupID)
    assert.ok(group, "the native turn is its own normal dispatch group")
    assert.deepEqual(group.tasks.map((task) => task.id), [turn.id])
    assert.equal(group.active, 1)

    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group" }, { id: "evt_216_start", created: 101 }))
    emitEvent(nativeEvent("session.inbox.delivered", { sessionID: "s_group", inboxID: "m1" }, { id: "evt_216_delivered", created: 102 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_group", assistantMessageID: "m2", ordinal: 0 }, { id: "evt_216_text", created: 103 }))
    emitEvent(nativeEvent("session.text.delta", { sessionID: "s_group", assistantMessageID: "m2", ordinal: 0, delta: "Shipped" }, { id: "evt_216_delta", created: 104 }))

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      const row = (state.messages["w"] ?? []).find((message: any) => message.author === "agent")
      return row?.streaming === true && row?.text === "Shipped"
    })
    const live = await snapshotFor(handlers, directory)
    assert.equal(nativeTurnIn(live).native.phase, "working")
    assert.equal(deriveWorkStatus(nativeTurnIn(live), Date.now()), "working")
    assert.equal(live.messages["w"].length, 2, "the stream reuses one durable agent row")

    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_group", assistantMessageID: "m2", ordinal: 0, text: "Shipped the release." }, { id: "evt_216_ended", created: 105 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_group" }, { id: "evt_216_done", created: 106 }))

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      const row = (state.messages["w"] ?? []).find((message: any) => message.author === "agent")
      return row?.streaming === false && row?.text === "Shipped the release."
    })
    const settled = await snapshotFor(handlers, directory)
    const rows = settled.messages["w"]
    assert.equal(rows.length, 2, "one durable user row and one durable agent row")
    const answer = rows.find((message: any) => message.author === "agent")
    const settledTurn = nativeTurnIn(settled)
    assert.equal(answer.taskID, settledTurn.id)
    assert.equal(answer.native.assistantMessageID, "m2")
    assert.equal(settledTurn.native.phase, "replied")
    assert.equal(settledTurn.outcome, "succeeded")
    assert.equal(settledTurn.resultMessageID, answer.id)
    assert.equal(deriveWorkStatus(settledTurn, Date.now()), "replied")
    assert.equal(settled.messages["dm:a:w"], undefined, "workspace ingestion never writes the direct channel")
    assert.ok(emitted.some((event) => event.name === "patches"), "durable rows publish patches")
    assert.ok(!emitted.some((event) => event.name === "snapshot"), "a normal turn never pushes a full snapshot")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket216: the session agent is the implicit addressee and no self-turn is created", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-216-addressee-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group_a", { id: "s_group_a" })
  nativeSessions.set("s_group_b", { id: "s_group_b" })
  await seedNativeWorkspace(ctx, directory, { a: "s_group_a", b: "s_group_b" })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group_a",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Review the release notes" } },
    }, { id: "evt_216_addressee", created: 100 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory))))
    const state = await snapshotFor(handlers, directory)
    const turn = nativeTurnIn(state)
    assert.equal(turn.assigneeID, "a", "the session's own agent is addressed implicitly")
    assert.equal(turn.creatorType, "user")
    assert.equal(turn.parentID, undefined, "no self-turn is created")
    assert.equal(Object.values(state.subtasks).length, 1, "one native prompt mints exactly one turn")
    assert.equal(Object.values(state.subtasks).filter((task: any) => task.origin === "native").length, 1)
    assert.equal((state.messages["w"] ?? []).filter((message: any) => message.author === "user").length, 1)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket225: a native workspace turn injects compact roster, conversation, and budget context", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-225-context-"))
  const { ctx, nativeSessions, instructions, emitEvent } = fakeContext()
  nativeSessions.set("s_group_a", { id: "s_group_a" })
  nativeSessions.set("s_group_b", { id: "s_group_b" })
  await seedNativeWorkspace(ctx, directory, { a: "s_group_a", b: "s_group_b" })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group_a",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Review the release notes" } },
    }, { id: "evt_225_context_enqueue", created: 100 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group_a" }, { id: "evt_225_context_start", created: 101 }))
    await waitFor(async () => instructions.some((entry) => entry.key === "ensemble.v2.context" && entry.value.includes("<ensemble_turn")))
    const context = instructions.filter((entry) => entry.key === "ensemble.v2.context" && entry.sessionID === "s_group_a").at(-1)!.value
    assert.match(context, /agent="Nova"|agent="A"/)
    assert.match(context, /conversation="group"/)
    assert.match(context, /workspace="site"/)
    assert.match(context, /Leader: Nova/)
    assert.match(context, /Members: Nova, B/)
    assert.match(context, /Budget: group 0\/8 \(8 left\)/)
    assert.match(context, /Final text is the group message/)
    assert.ok(context.length < 700, `the injected turn context is compact: ${context.length}`)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket216: direct and workspace native conversations stay isolated", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-216-isolation-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-216-isolation-home-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_direct", { id: "s_direct" })
  nativeSessions.set("s_group", { id: "s_group" })
  const seed = new V2Store(ctx)
  await seed.load()
  await seedAgent(seed, { homeDirectory: home })
  await seedWorkspace(seed, directory)
  await seed.saveBinding({ workspaceID: "w", agentID: "a", sessionID: "s_direct", kind: "direct", directory, agentVersion: 1, updatedAt: 1 })
  await seed.saveBinding({ workspaceID: "w", agentID: "a", sessionID: "s_group", kind: "workspace", directory, agentVersion: 1, updatedAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "mg1",
      item: { type: "user", delivery: "steer", payload: { text: "Group task" } },
    }, { id: "evt_216_iso_group", created: 100 }))
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_direct",
      inboxID: "md1",
      item: { type: "user", delivery: "steer", payload: { text: "Direct task" } },
    }, { id: "evt_216_iso_direct", created: 101 }))
    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      return (state.messages["w"] ?? []).length === 1 && (state.messages["dm:a:w"] ?? []).length === 1
    })

    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group" }, { id: "evt_216_iso_group_start", created: 102 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_group", assistantMessageID: "mg2", ordinal: 0 }, { id: "evt_216_iso_group_text", created: 103 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_group", assistantMessageID: "mg2", ordinal: 0, text: "Group answer." }, { id: "evt_216_iso_group_end", created: 104 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_group" }, { id: "evt_216_iso_group_done", created: 105 }))
    await waitFor(async () => nativeTurnIn(await snapshotFor(handlers, directory), "replied")?.native.inboxID === "mg1")

    const midway = await snapshotFor(handlers, directory)
    const groupTurn = nativeTurnIn(midway, "replied")
    assert.equal(groupTurn.workspaceID, "w")
    assert.equal(groupTurn.conversationID, "w")
    const directTurn = Object.values(midway.subtasks).find((task: any) => task.native?.inboxID === "md1") as any
    assert.equal(directTurn.native.phase, "queued", "the group answer never settles the direct turn")
    assert.deepEqual((midway.messages["w"] ?? []).map((message: any) => [message.author, message.text]), [
      ["user", "Group task"],
      ["agent", "Group answer."],
    ])
    assert.deepEqual((midway.messages["dm:a:w"] ?? []).map((message: any) => [message.author, message.text]), [
      ["user", "Direct task"],
    ])

    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_direct" }, { id: "evt_216_iso_direct_start", created: 106 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_direct", assistantMessageID: "md2", ordinal: 0 }, { id: "evt_216_iso_direct_text", created: 107 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_direct", assistantMessageID: "md2", ordinal: 0, text: "Direct answer." }, { id: "evt_216_iso_direct_end", created: 108 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_direct" }, { id: "evt_216_iso_direct_done", created: 109 }))
    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      const direct = Object.values(state.subtasks).find((task: any) => task.native?.inboxID === "md1") as any
      return direct?.native?.phase === "replied"
    })

    const settled = await snapshotFor(handlers, directory)
    assert.deepEqual((settled.messages["dm:a:w"] ?? []).map((message: any) => [message.author, message.text]), [
      ["user", "Direct task"],
      ["agent", "Direct answer."],
    ])
    assert.deepEqual((settled.messages["w"] ?? []).map((message: any) => [message.author, message.text]), [
      ["user", "Group task"],
      ["agent", "Group answer."],
    ])
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket216: native subagent child sessions stay under the parent turn and create no turn of their own", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-216-subagent-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  await seedNativeWorkspace(ctx, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Run the review" } },
    }, { id: "evt_216_sub_enqueue", created: 100 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group" }, { id: "evt_216_sub_start", created: 101 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_group", assistantMessageID: "m2", ordinal: 0 }, { id: "evt_216_sub_text", created: 102 }))
    emitEvent(nativeEvent("session.text.delta", { sessionID: "s_group", assistantMessageID: "m2", ordinal: 0, delta: "Reviewing" }, { id: "evt_216_sub_delta", created: 103 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "working")))

    emitEvent(nativeEvent("session.created", { sessionID: "child_216", parentID: "s_group", title: "Check the diff" }, { id: "evt_216_child_created", created: 104 }))
    await waitFor(async () => Boolean((await snapshotFor(handlers, directory)).nativeSubagents.child_216))
    const parent = nativeTurnIn(await snapshotFor(handlers, directory), "working")
    const child = (await snapshotFor(handlers, directory)).nativeSubagents.child_216
    assert.equal(child.parentSessionID, "s_group")
    assert.equal(child.parentTaskID, parent.id, "the child belongs to the parent turn")
    assert.equal(child.dispatchGroupID, parent.dispatchGroupID, "the child renders under the parent dispatch group")
    assert.equal(child.workspaceID, "w")

    emitEvent(nativeEvent("session.execution.started", { sessionID: "child_216" }, { id: "evt_216_child_start", created: 105 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "child_216", assistantMessageID: "c2", ordinal: 0 }, { id: "evt_216_child_text", created: 106 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "child_216", assistantMessageID: "c2", ordinal: 0, text: "Child answer." }, { id: "evt_216_child_end", created: 107 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "child_216" }, { id: "evt_216_child_done", created: 108 }))
    await waitFor(async () => (await snapshotFor(handlers, directory)).nativeSubagents.child_216?.state === "replied")

    const state = await snapshotFor(handlers, directory)
    assert.equal(Object.values(state.subtasks).filter((task: any) => task.origin === "native").length, 1, "the child creates no native turn")
    assert.equal((state.messages["w"] ?? []).length, 2, "the child creates no group message rows")
    assert.equal(state.nativeSubagents.child_216.parentTaskID, parent.id)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket216: internal service prompts are skipped in a workspace session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-216-internal-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  await seedNativeWorkspace(ctx, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "m9",
      item: {
        type: "user",
        delivery: "steer",
        payload: { text: "hidden task prompt", metadata: { "ensemble.internal": true, "ensemble.mirror": false } },
      },
    }, { id: "evt_216_internal_enqueue", created: 100 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group" }, { id: "evt_216_internal_start", created: 101 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_group", assistantMessageID: "m10", ordinal: 0 }, { id: "evt_216_internal_text", created: 102 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_group", assistantMessageID: "m10", ordinal: 0, text: "Task output." }, { id: "evt_216_internal_end", created: 103 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_group" }, { id: "evt_216_internal_done", created: 104 }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    const state = await snapshotFor(handlers, directory)
    assert.equal(state.messages["w"], undefined, "an internal prompt mirrors nothing")
    assert.equal(Object.values(state.subtasks).filter((task: any) => task.origin === "native").length, 0)

    // A real user prompt after the internal turn still becomes exactly one turn.
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "m11",
      item: { type: "user", delivery: "steer", payload: { text: "Real question" } },
    }, { id: "evt_216_real_enqueue", created: 105 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory))))
    assert.equal((await snapshotFor(handlers, directory)).messages["w"].length, 1)
    assert.equal(nativeTurnIn(await snapshotFor(handlers, directory)).native.phase, "queued", "a skipped internal execution never starts the next user turn")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket216: a delegated task run on the group session never settles a queued native turn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-216-run-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  await seedNativeWorkspace(ctx, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    service.registerLocalRunForTest({
      id: "run_216",
      subtaskID: "task_delegated_216",
      workspaceID: "w",
      agentID: "a",
      sessionID: "s_group",
      status: "running",
      startedAt: 1,
    })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "m1",
      item: { type: "user", delivery: "queue", payload: { text: "Queued user prompt" } },
    }, { id: "evt_216_run_enqueue", created: 100 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory))))

    // The delegated run's own execution events carry no inbox identity.
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group" }, { id: "evt_216_run_start", created: 101 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_group", assistantMessageID: "m2", ordinal: 0 }, { id: "evt_216_run_text", created: 102 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_group", assistantMessageID: "m2", ordinal: 0, text: "Delegated answer." }, { id: "evt_216_run_end", created: 103 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_group" }, { id: "evt_216_run_done", created: 104 }))
    await new Promise((resolve) => setTimeout(resolve, 100))

    const state = await snapshotFor(handlers, directory)
    const turn = nativeTurnIn(state)
    assert.equal(turn.native.phase, "queued", "the delegated run never claims the queued native turn")
    assert.equal((state.messages["w"] ?? []).filter((message: any) => message.author === "user").length, 1)
    assert.equal((state.messages["w"] ?? []).some((message: any) => message.author === "agent"), false)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket216: a user turn queued during a delegated run starts after the run settles", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-216-run-queued-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  await seedNativeWorkspace(ctx, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    service.registerLocalRunForTest({
      id: "run_216a",
      subtaskID: "task_delegated_216a",
      workspaceID: "w",
      agentID: "a",
      sessionID: "s_group",
      status: "running",
      startedAt: 1,
    })
    // The run's service prompt is skipped but still occupies host order.
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "m_run_a",
      item: { type: "user", delivery: "steer", payload: { text: "run prompt", metadata: { "ensemble.internal": true, "ensemble.mirror": false } } },
    }, { id: "evt_216_run_a_enqueue", created: 100 }))
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "m_user_a",
      item: { type: "user", delivery: "queue", payload: { text: "User prompt" } },
    }, { id: "evt_216_run_a_user", created: 101 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory))))

    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group" }, { id: "evt_216_run_a_start", created: 102 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_group", assistantMessageID: "mr2a", ordinal: 0 }, { id: "evt_216_run_a_text", created: 103 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_group", assistantMessageID: "mr2a", ordinal: 0, text: "Run answer." }, { id: "evt_216_run_a_end", created: 104 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_group" }, { id: "evt_216_run_a_done", created: 105 }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(nativeTurnIn(await snapshotFor(handlers, directory)).native.phase, "queued")

    // Model the run's finally block releasing the session before the queued
    // host prompt starts.
    ;(service as any).activeRuns.delete("run_216a")
    ;(service as any).runBySession.delete("s_group")

    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group" }, { id: "evt_216_run_a_user_start", created: 106 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_group", assistantMessageID: "mu2a", ordinal: 0 }, { id: "evt_216_run_a_user_text", created: 107 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_group", assistantMessageID: "mu2a", ordinal: 0, text: "User answer." }, { id: "evt_216_run_a_user_end", created: 108 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_group" }, { id: "evt_216_run_a_user_done", created: 109 }))

    await waitFor(async () => nativeTurnIn(await snapshotFor(handlers, directory), "replied") !== undefined)
    const state = await snapshotFor(handlers, directory)
    const row = (state.messages["w"] ?? []).find((message: any) => message.author === "agent")
    assert.equal(row.text, "User answer.", "the queued user turn is not blocked by the run's skipped inbox")
    assert.equal(Object.values(state.subtasks).filter((task: any) => task.origin === "native").length, 1)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket216: the first user turn after a completed delegated run still starts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-216-run-after-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  await seedNativeWorkspace(ctx, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    service.registerLocalRunForTest({
      id: "run_216b",
      subtaskID: "task_delegated_216b",
      workspaceID: "w",
      agentID: "a",
      sessionID: "s_group",
      status: "running",
      startedAt: 1,
    })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "m_run_b",
      item: { type: "user", delivery: "steer", payload: { text: "run prompt", metadata: { "ensemble.internal": true, "ensemble.mirror": false } } },
    }, { id: "evt_216_run_b_enqueue", created: 100 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group" }, { id: "evt_216_run_b_start", created: 101 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_group", assistantMessageID: "mr2b", ordinal: 0 }, { id: "evt_216_run_b_text", created: 102 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_group", assistantMessageID: "mr2b", ordinal: 0, text: "Run answer." }, { id: "evt_216_run_b_end", created: 103 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_group" }, { id: "evt_216_run_b_done", created: 104 }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    ;(service as any).activeRuns.delete("run_216b")
    ;(service as any).runBySession.delete("s_group")

    // The run has fully completed; the next composer prompt is the first turn.
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "m_user_b",
      item: { type: "user", delivery: "steer", payload: { text: "User prompt" } },
    }, { id: "evt_216_run_b_user", created: 105 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory))))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group" }, { id: "evt_216_run_b_user_start", created: 106 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_group", assistantMessageID: "mu2b", ordinal: 0 }, { id: "evt_216_run_b_user_text", created: 107 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_group", assistantMessageID: "mu2b", ordinal: 0, text: "User answer." }, { id: "evt_216_run_b_user_end", created: 108 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_group" }, { id: "evt_216_run_b_user_done", created: 109 }))

    await waitFor(async () => nativeTurnIn(await snapshotFor(handlers, directory), "replied") !== undefined)
    const state = await snapshotFor(handlers, directory)
    const row = (state.messages["w"] ?? []).find((message: any) => message.author === "agent")
    assert.equal(row.text, "User answer.", "the completed run's skipped inbox does not swallow the next turn")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket216: workspace restart recovery settles from the transcript on the group channel", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-216-restart-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  await seedNativeWorkspace(ctx, directory)
  const first = new EnsembleV2Service(ctx)
  const stopFirst = await startServiceForTest(first, first.ctx)
  try {
    await first.handlers().invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "m20",
      item: { type: "user", delivery: "steer", payload: { text: "Survive restart" } },
    }, { id: "evt_216_restart_enqueue", created: 100 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group" }, { id: "evt_216_restart_start", created: 101 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_group", assistantMessageID: "m21", ordinal: 0 }, { id: "evt_216_restart_text", created: 102 }))
    emitEvent(nativeEvent("session.text.delta", { sessionID: "s_group", assistantMessageID: "m21", ordinal: 0, delta: "Partial" }, { id: "evt_216_restart_delta", created: 103 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(first.handlers(), directory), "working")))
  } finally {
    await stopFirst()
  }

  ;(ctx.session as any).context = async () => ({
    data: [
      { id: "m20", type: "user", content: [{ type: "text", text: "Survive restart" }], time: { created: 1 } },
      { id: "m21", type: "assistant", content: [{ type: "text", text: "Recovered workspace answer" }], time: { created: 2 } },
      { id: "m22", type: "idle" },
    ],
  })
  const second = new EnsembleV2Service(ctx)
  const stopSecond = await startServiceForTest(second, second.ctx)
  try {
    await waitFor(async () => nativeTurnIn(await snapshotFor(second.handlers(), directory), "replied") !== undefined)
    const state = await snapshotFor(second.handlers(), directory)
    const turn = nativeTurnIn(state, "replied")
    assert.equal(turn.conversationID, "w")
    const row = (state.messages["w"] ?? []).find((message: any) => message.author === "agent")
    assert.equal(row.text, "Recovered workspace answer")
    assert.equal(row.streaming, false)
    assert.equal(turn.resultMessageID, row.id)
    assert.equal(state.messages["dm:a:w"], undefined)
  } finally {
    await stopSecond()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket216: workspace native ingestion requires nativeFirst on", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-216-off-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  await seedNativeWorkspace(ctx, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "m30",
      item: { type: "user", delivery: "steer", payload: { text: "Old path" } },
    }, { id: "evt_216_off_enqueue", created: 100 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group" }, { id: "evt_216_off_start", created: 101 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_group", assistantMessageID: "m31", ordinal: 0 }, { id: "evt_216_off_text", created: 102 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_group", assistantMessageID: "m31", ordinal: 0, text: "Old answer." }, { id: "evt_216_off_end", created: 103 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_group" }, { id: "evt_216_off_done", created: 104 }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    const off = await snapshotFor(handlers, directory)
    assert.equal(off.messages["w"], undefined)
    assert.equal(Object.values(off.subtasks).filter((task: any) => task.origin === "native").length, 0)

    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "m32",
      item: { type: "user", delivery: "steer", payload: { text: "Live path" } },
    }, { id: "evt_216_on_enqueue", created: 105 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory))))
    const on = await snapshotFor(handlers, directory)
    assert.equal(nativeTurnIn(on).native.inboxID, "m32", "turning the flag on ingests the next prompt")
    assert.equal((on.messages["w"] ?? []).length, 1)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket216: an internal execution terminal never settles a user turn queued behind it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-216-order-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  await seedNativeWorkspace(ctx, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "m_internal",
      item: {
        type: "user",
        delivery: "steer",
        payload: { text: "identity prompt", metadata: { "ensemble.internal": true, "ensemble.mirror": false } },
      },
    }, { id: "evt_216_order_internal", created: 100 }))
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "m_user",
      item: { type: "user", delivery: "queue", payload: { text: "User prompt" } },
    }, { id: "evt_216_order_user", created: 101 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory))))

    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group" }, { id: "evt_216_order_internal_start", created: 102 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_group", assistantMessageID: "int1", ordinal: 0 }, { id: "evt_216_order_internal_text", created: 103 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_group", assistantMessageID: "int1", ordinal: 0, text: "Internal output." }, { id: "evt_216_order_internal_end", created: 104 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_group" }, { id: "evt_216_order_internal_done", created: 105 }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    const midway = await snapshotFor(handlers, directory)
    assert.equal(nativeTurnIn(midway)?.native.phase, "queued", "the internal terminal leaves the user turn queued")
    assert.equal((midway.messages["w"] ?? []).some((message: any) => message.author === "agent"), false)

    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group" }, { id: "evt_216_order_user_start", created: 106 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_group", assistantMessageID: "u2", ordinal: 0 }, { id: "evt_216_order_user_text", created: 107 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_group", assistantMessageID: "u2", ordinal: 0, text: "User answer." }, { id: "evt_216_order_user_end", created: 108 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_group" }, { id: "evt_216_order_user_done", created: 109 }))
    await waitFor(async () => nativeTurnIn(await snapshotFor(handlers, directory), "replied")?.native.inboxID === "m_user")
    const state = await snapshotFor(handlers, directory)
    const row = state.messages["w"].find((message: any) => message.author === "agent")
    assert.equal(row.text, "User answer.")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket216: a cancelled unknown inbox never cancels a live user turn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-216-cancel-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  await seedNativeWorkspace(ctx, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Keep working" } },
    }, { id: "evt_216_cancel_enqueue", created: 100 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group" }, { id: "evt_216_cancel_start", created: 101 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_group", assistantMessageID: "m2", ordinal: 0 }, { id: "evt_216_cancel_text", created: 102 }))
    emitEvent(nativeEvent("session.text.delta", { sessionID: "s_group", assistantMessageID: "m2", ordinal: 0, delta: "Partial" }, { id: "evt_216_cancel_delta", created: 103 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "working")))

    // An internal/onboarding inbox was never ingested; its cancellation must
    // never fall back to the session's unrelated live user turn.
    emitEvent(nativeEvent("session.inbox.cancelled", { sessionID: "s_group", inboxID: "m_internal" }, { id: "evt_216_cancel_other", created: 104 }))
    await new Promise((resolve) => setTimeout(resolve, 60))
    const active = await snapshotFor(handlers, directory)
    assert.equal(nativeTurnIn(active).native.phase, "working", "the live user turn keeps running")
    assert.equal((active.messages["w"] ?? []).find((message: any) => message.author === "agent")?.streaming, true)

    // With no inbox id the host means the session's active turn; that fallback
    // still settles it honestly.
    emitEvent(nativeEvent("session.inbox.cancelled", { sessionID: "s_group" }, { id: "evt_216_cancel_active", created: 105 }))
    await waitFor(async () => nativeTurnIn(await snapshotFor(handlers, directory), "cancelled") !== undefined)
    const cancelled = await snapshotFor(handlers, directory)
    assert.equal(deriveWorkStatus(nativeTurnIn(cancelled), Date.now()), "cancelled")
    assert.equal(cancelled.messages["w"].find((message: any) => message.author === "agent").streaming, false)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket216: late text for a settled turn never affects the next turn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-216-late-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  await seedNativeWorkspace(ctx, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "First question" } },
    }, { id: "evt_216_late_enqueue_1", created: 100 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group" }, { id: "evt_216_late_start_1", created: 101 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_group", assistantMessageID: "m2", ordinal: 0 }, { id: "evt_216_late_text_1", created: 102 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_group", assistantMessageID: "m2", ordinal: 0, text: "First answer" }, { id: "evt_216_late_end_1", created: 103 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_group" }, { id: "evt_216_late_done_1", created: 104 }))
    await waitFor(async () => nativeTurnIn(await snapshotFor(handlers, directory), "replied") !== undefined)

    // A late delta for the settled assistant message must not re-arm the
    // session's active-turn marker.
    emitEvent(nativeEvent("session.text.delta", { sessionID: "s_group", assistantMessageID: "m2", ordinal: 0, delta: " late" }, { id: "evt_216_late_delta", created: 105 }))

    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "m3",
      item: { type: "user", delivery: "steer", payload: { text: "Second question" } },
    }, { id: "evt_216_late_enqueue_2", created: 106 }))
    // Reordered text arrives before the next execution.started.
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_group", assistantMessageID: "m4", ordinal: 0 }, { id: "evt_216_late_text_2", created: 107 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_group", assistantMessageID: "m4", ordinal: 0, text: "Second answer" }, { id: "evt_216_late_end_2", created: 108 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group" }, { id: "evt_216_late_start_2", created: 109 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_group" }, { id: "evt_216_late_done_2", created: 110 }))

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      return Object.values(state.subtasks).filter((task: any) => task.origin === "native" && task.native?.phase === "replied").length === 2
    })
    const state = await snapshotFor(handlers, directory)
    const turns = Object.values(state.subtasks).filter((task: any) => task.origin === "native") as any[]
    assert.equal(turns.length, 2)
    const second = turns.find((task) => task.native.inboxID === "m3")!
    const secondAnswer = state.messages["w"].find((message: any) => message.id === second.resultMessageID)
    assert.ok(secondAnswer, "the second turn owns its answer row")
    assert.equal(secondAnswer.text, "Second answer", "reordered text for the second turn is not dropped")
    assert.equal(state.messages["w"].find((message: any) => message.native?.inboxID === "m1" && message.author === "user").text, "First question")
    assert.equal(state.messages["w"].find((message: any) => message.id === turns.find((task) => task.native.inboxID === "m1")!.resultMessageID).text, "First answer")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket216: native stream text checkpoints are bounded, not one durable write per delta", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-216-checkpoints-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  await seedNativeWorkspace(ctx, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Stream a lot" } },
    }, { id: "evt_216_ckpt_enqueue", created: 100 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group" }, { id: "evt_216_ckpt_start", created: 101 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_group", assistantMessageID: "m2", ordinal: 0 }, { id: "evt_216_ckpt_text", created: 102 }))
    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      return (state.messages["w"] ?? []).some((message: any) => message.author === "agent" && message.streaming === true)
    })

    const originalSet = ctx.storage.set
    let messageWrites = 0
    ctx.storage.set = async (key: string, value: unknown) => {
      if (key.startsWith("v2/message/")) messageWrites++
      return originalSet(key, value)
    }
    const deltas = 80
    for (let index = 0; index < deltas; index++) {
      emitEvent(nativeEvent("session.text.delta", {
        sessionID: "s_group",
        assistantMessageID: "m2",
        ordinal: 0,
        delta: "x",
      }, { id: `evt_216_ckpt_delta_${index}`, created: 103 + index }))
    }
    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      const row = (state.messages["w"] ?? []).find((message: any) => message.author === "agent")
      return row?.text?.length === deltas
    })
    assert.ok(messageWrites > 0, "the stream still checkpoints durable crash recovery text")
    assert.ok(messageWrites <= 10, `expected bounded checkpoints, saw ${messageWrites} writes for ${deltas} deltas`)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

// ---- Ticket #217: retry and interruption semantics ----

test("ticket217: a user interruption settles cancelled on the same row and card, preserving partial text", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-217-user-interrupt-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-217-user-interrupt-home-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_direct", { id: "s_direct" })
  await seedNativeDirect(ctx, directory, home)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_direct",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Try the change" } },
    }, { id: "evt_217_ui_enqueue", created: 100 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_direct" }, { id: "evt_217_ui_start", created: 101 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0 }, { id: "evt_217_ui_text", created: 102 }))
    emitEvent(nativeEvent("session.text.delta", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0, delta: "Half" }, { id: "evt_217_ui_delta", created: 103 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0, text: "Half done" }, { id: "evt_217_ui_ended", created: 104 }))
    emitEvent(nativeEvent("session.execution.interrupted", { sessionID: "s_direct", reason: "user" }, { id: "evt_217_ui_interrupt", created: 105 }))

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      const turn = Object.values(state.subtasks).find((task: any) => task.origin === "native") as any
      return turn?.native?.phase === "cancelled"
    })
    const state = await snapshotFor(handlers, directory)
    const turn = Object.values(state.subtasks).find((task: any) => task.origin === "native") as any
    assert.equal(deriveWorkStatus(turn, Date.now()), "cancelled")
    assert.equal(turn.interrupted, false)
    assert.ok(turn.stoppedAt, "cancellation is structural")
    const rows = state.messages["dm:a:w"]
    assert.equal(rows.length, 2, "one user row and one agent row")
    const answer = rows.find((message: any) => message.author === "agent")
    assert.equal(answer.id, nativeAssistantMessageID(turn.id), "the partial row is the same row")
    assert.equal(answer.streaming, false)
    assert.equal(answer.interrupted, false)
    assert.equal(answer.text, "Half done", "the partial text is preserved, never invented")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket217: a scheduled retry stays retrying on the same row and card and never creates an interrupted row", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-217-retry-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-217-retry-home-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_direct", { id: "s_direct" })
  await seedNativeDirect(ctx, directory, home)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_direct",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Fetch the report" } },
    }, { id: "evt_217_retry_enqueue", created: 100 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_direct" }, { id: "evt_217_retry_start", created: 101 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0 }, { id: "evt_217_retry_text", created: 102 }))
    emitEvent(nativeEvent("session.text.delta", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0, delta: "Working" }, { id: "evt_217_retry_delta", created: 103 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "working")))
    const before = await snapshotFor(handlers, directory)
    const rowID = nativeAssistantMessageID(nativeTurnIn(before).id)

    emitEvent(nativeEvent("session.retry.scheduled", {
      sessionID: "s_direct",
      assistantMessageID: "m2",
      attempt: 2,
      error: { type: "provider.rate-limit", status: 429, retryAfterMs: 0 },
    }, { id: "evt_217_retry_scheduled", created: 104 }))

    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "retrying")))
    const retrying = await snapshotFor(handlers, directory)
    const turn = nativeTurnIn(retrying, "retrying")
    assert.equal(deriveWorkStatus(turn, Date.now()), "retrying")
    assert.equal(retrying.messages["dm:a:w"].length, 2, "no interrupted or retry row is appended")
    const live = retrying.messages["dm:a:w"].find((message: any) => message.author === "agent")
    assert.equal(live.id, rowID, "the retry reuses the same message row")
    assert.equal(live.streaming, true)
    assert.equal(live.interrupted, undefined)
    assert.equal(live.text, "Working")

    // The retry attempt reuses the same assistant message id and settles once.
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0 }, { id: "evt_217_retry_text_2", created: 105 }))
    emitEvent(nativeEvent("session.text.delta", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0, delta: " again" }, { id: "evt_217_retry_delta_2", created: 106 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0, text: "Working again" }, { id: "evt_217_retry_ended", created: 107 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_direct" }, { id: "evt_217_retry_done", created: 108 }))

    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "replied")))
    const settled = await snapshotFor(handlers, directory)
    assert.equal(settled.messages["dm:a:w"].length, 2, "one turn, one agent row")
    const answer = settled.messages["dm:a:w"].find((message: any) => message.author === "agent")
    assert.equal(answer.id, rowID, "the answer is the same row the retry held")
    assert.equal(answer.text, "Working again")
    assert.equal(answer.streaming, false)
    assert.equal(answer.interrupted, false)
    assert.equal(nativeTurnIn(settled, "replied").native.phase, "replied")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket217: a terminal execution failure without a retry settles failed with a structured reason", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-217-failure-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-217-failure-home-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_direct", { id: "s_direct" })
  await seedNativeDirect(ctx, directory, home)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_direct",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Use the provider" } },
    }, { id: "evt_217_fail_enqueue", created: 100 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_direct" }, { id: "evt_217_fail_start", created: 101 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0 }, { id: "evt_217_fail_text", created: 102 }))
    emitEvent(nativeEvent("session.text.delta", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0, delta: "Partial" }, { id: "evt_217_fail_delta", created: 103 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "working")))
    emitEvent(nativeEvent("session.execution.failed", {
      sessionID: "s_direct",
      error: { type: "provider.unavailable", message: "upstream unavailable", status: 503 },
    }, { id: "evt_217_fail_terminal", created: 104 }))

    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "failed")))
    const state = await snapshotFor(handlers, directory)
    const turn = nativeTurnIn(state, "failed")
    assert.deepEqual(turn.failure, { kind: "native", reason: "provider.unavailable" })
    assert.equal(turn.native.errorCode, "provider.unavailable")
    assert.equal(deriveWorkStatus(turn, Date.now()), "failed")
    const answer = state.messages["dm:a:w"].find((message: any) => message.author === "agent")
    assert.equal(answer.text, "Partial", "the partial text is preserved")
    assert.equal(answer.streaming, false)
    assert.equal(answer.interrupted, false)
    assert.equal(state.messages["dm:a:w"].length, 2, "a terminal failure does not append a second agent row")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket217: a shutdown interruption settles needs_you and preserves partial text", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-217-shutdown-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-217-shutdown-home-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_direct", { id: "s_direct" })
  await seedNativeDirect(ctx, directory, home)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_direct",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Long job" } },
    }, { id: "evt_217_shutdown_enqueue", created: 100 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_direct" }, { id: "evt_217_shutdown_start", created: 101 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0 }, { id: "evt_217_shutdown_text", created: 102 }))
    emitEvent(nativeEvent("session.text.delta", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0, delta: "Half" }, { id: "evt_217_shutdown_delta", created: 103 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0, text: "Half a write-up" }, { id: "evt_217_shutdown_ended", created: 104 }))
    emitEvent(nativeEvent("session.execution.interrupted", { sessionID: "s_direct", reason: "shutdown" }, { id: "evt_217_shutdown_interrupt", created: 105 }))

    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "interrupted")))
    const state = await snapshotFor(handlers, directory)
    const turn = nativeTurnIn(state, "interrupted")
    assert.equal(turn.interrupted, true)
    assert.equal(deriveWorkStatus(turn, Date.now()), "needs_you")
    const answer = state.messages["dm:a:w"].find((message: any) => message.author === "agent")
    assert.equal(answer.text, "Half a write-up", "partial text survives a shutdown interruption")
    assert.equal(answer.streaming, false)
    assert.equal(answer.interrupted, true)
    assert.equal(state.messages["dm:a:w"].length, 2, "an interruption does not mint a new row")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket217: session.idle alone never settles an active native turn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-217-idle-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-217-idle-home-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_direct", { id: "s_direct" })
  await seedNativeDirect(ctx, directory, home)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_direct",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Keep going" } },
    }, { id: "evt_217_idle_enqueue", created: 100 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_direct" }, { id: "evt_217_idle_start", created: 101 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0 }, { id: "evt_217_idle_text", created: 102 }))
    emitEvent(nativeEvent("session.text.delta", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0, delta: "Still" }, { id: "evt_217_idle_delta", created: 103 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "working")))

    emitEvent(nativeEvent("session.idle", { sessionID: "s_direct" }, { id: "evt_217_idle_event", created: 104 }))
    emitEvent(nativeEvent("session.status", { sessionID: "s_direct", status: { type: "idle" } }, { id: "evt_217_status_event", created: 105 }))
    await new Promise((resolve) => setTimeout(resolve, 80))

    const state = await snapshotFor(handlers, directory)
    const turn = nativeTurnIn(state)
    assert.equal(turn.native.phase, "working", "idle is a reconciliation hint, never a settlement signal")
    assert.equal(deriveWorkStatus(turn, Date.now()), "working")
    const answer = state.messages["dm:a:w"].find((message: any) => message.author === "agent")
    assert.equal(answer.streaming, true, "the live row is still streaming")
    assert.equal(answer.interrupted, undefined)

    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_direct" }, { id: "evt_217_idle_done", created: 106 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0, text: "Still here" }, { id: "evt_217_idle_ended", created: 107 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "replied")))
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket217: the bounded watchdog recovers a missed terminal event from one transcript read", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-217-watchdog-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-217-watchdog-home-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_direct", { id: "s_direct" })
  await seedNativeDirect(ctx, directory, home)
  let contextCalls = 0
  ;(ctx.session as any).context = async () => {
    contextCalls++
    return {
      data: [
        { id: "m1", type: "user", content: [{ type: "text", text: "Watch me" }], time: { created: 1 } },
        { id: "m2", type: "assistant", content: [{ type: "text", text: "Recovered after a lost terminal" }], time: { created: 2 } },
        { id: "m3", type: "idle" },
      ],
    }
  }
  const service = new EnsembleV2Service(ctx, { nativeTurnWatchdogMs: 20 })
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_direct",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Watch me" } },
    }, { id: "evt_217_wd_enqueue", created: 100 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_direct" }, { id: "evt_217_wd_start", created: 101 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0 }, { id: "evt_217_wd_text", created: 102 }))
    emitEvent(nativeEvent("session.text.delta", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0, delta: "Partial" }, { id: "evt_217_wd_delta", created: 103 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "working")))
    const before = await snapshotFor(handlers, directory)
    const turn = nativeTurnIn(before)
    const rowID = nativeAssistantMessageID(turn.id)
    assert.equal(contextCalls, 0, "ingestion never polls")

    // Not stale yet: one maintenance pass reads nothing.
    await (service as any).maintain()
    assert.equal(contextCalls, 0, "the watchdog waits for its bound")
    assert.equal(nativeTurnIn(await snapshotFor(handlers, directory)).native.phase, "working")

    await new Promise((resolve) => setTimeout(resolve, 30))
    await (service as any).maintain()
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "replied")))

    const state = await snapshotFor(handlers, directory)
    const settled = nativeTurnIn(state, "replied")
    assert.equal(contextCalls, 1, "one bounded reconciliation read, not a poll")
    const answer = state.messages["dm:a:w"].find((message: any) => message.author === "agent")
    assert.equal(answer.id, rowID, "the watchdog settles the existing row")
    assert.equal(answer.text, "Recovered after a lost terminal")
    assert.equal(answer.streaming, false)
    assert.equal(settled.resultMessageID, rowID)
    assert.equal(state.messages["dm:a:w"].length, 2)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket217: the watchdog never guesses an interruption and stops after its read bound", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-217-watchdog-no-guess-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-217-watchdog-no-guess-home-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_direct", { id: "s_direct" })
  await seedNativeDirect(ctx, directory, home)
  let contextCalls = 0
  ;(ctx.session as any).context = async () => {
    contextCalls++
    // The turn's user row is present but there is no answer and no idle
    // marker: the execution may still be running, so nothing is settled.
    return {
      data: [
        { id: "m1", type: "user", content: [{ type: "text", text: "Still running" }], time: { created: 1 } },
      ],
    }
  }
  const service = new EnsembleV2Service(ctx, { nativeTurnWatchdogMs: 15, nativeTurnWatchdogMaxPasses: 2 })
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_direct",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Still running" } },
    }, { id: "evt_217_wdng_enqueue", created: 100 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_direct" }, { id: "evt_217_wdng_start", created: 101 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0 }, { id: "evt_217_wdng_text", created: 102 }))
    emitEvent(nativeEvent("session.text.delta", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0, delta: "Still" }, { id: "evt_217_wdng_delta", created: 103 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "working")))

    for (let pass = 0; pass < 4; pass++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      await (service as any).maintain()
    }
    const state = await snapshotFor(handlers, directory)
    const turn = nativeTurnIn(state)
    assert.equal(turn.native.phase, "working", "time alone is not an interruption")
    assert.equal(turn.interrupted, false)
    assert.equal(deriveWorkStatus(turn, Date.now()), "working")
    assert.equal(contextCalls, 2, `the watchdog reads at most its pass bound (saw ${contextCalls})`)
    const answer = state.messages["dm:a:w"].find((message: any) => message.author === "agent")
    assert.equal(answer.streaming, true, "the partial row stays live")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket217: the watchdog marks a confirmed answerless turn needs_you only from an idle marker", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-217-watchdog-idle-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-217-watchdog-idle-home-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_direct", { id: "s_direct" })
  await seedNativeDirect(ctx, directory, home)
  ;(ctx.session as any).context = async () => ({
    data: [
      { id: "m1", type: "user", content: [{ type: "text", text: "Lost answer" }], time: { created: 1 } },
      { id: "m9", type: "idle" },
    ],
  })
  const service = new EnsembleV2Service(ctx, { nativeTurnWatchdogMs: 15 })
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_direct",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Lost answer" } },
    }, { id: "evt_217_wdi_enqueue", created: 100 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_direct" }, { id: "evt_217_wdi_start", created: 101 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0 }, { id: "evt_217_wdi_text", created: 102 }))
    emitEvent(nativeEvent("session.text.delta", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0, delta: "Partial" }, { id: "evt_217_wdi_delta", created: 103 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "working")))

    await new Promise((resolve) => setTimeout(resolve, 20))
    await (service as any).maintain()
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "interrupted")))
    const state = await snapshotFor(handlers, directory)
    const turn = nativeTurnIn(state, "interrupted")
    assert.equal(turn.interrupted, true)
    assert.equal(deriveWorkStatus(turn, Date.now()), "needs_you")
    const answer = state.messages["dm:a:w"].find((message: any) => message.author === "agent")
    assert.equal(answer.text, "Partial", "the durable partial text is preserved")
    assert.equal(answer.streaming, false)
    assert.equal(answer.interrupted, true)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket217: a background native subagent keeps the parent turn working until the child terminates, then the synthetic turn is a new card", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-217-subagent-hold-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  await seedNativeWorkspace(ctx, directory)
  const service = new EnsembleV2Service(ctx, { nativeSubagentBarrierMs: 2_000 })
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Review the diff" } },
    }, { id: "evt_217_hold_enqueue", created: 100 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group" }, { id: "evt_217_hold_start", created: 101 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_group", assistantMessageID: "m2", ordinal: 0 }, { id: "evt_217_hold_text", created: 102 }))
    emitEvent(nativeEvent("session.text.delta", { sessionID: "s_group", assistantMessageID: "m2", ordinal: 0, delta: "Reviewing" }, { id: "evt_217_hold_delta", created: 103 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "working")))

    emitEvent(nativeEvent("session.created", { sessionID: "child_217", parentID: "s_group", title: "Check the diff" }, { id: "evt_217_hold_child", created: 104 }))
    await waitFor(async () => (await snapshotFor(handlers, directory)).nativeSubagents.child_217?.state === "working")
    const parent = nativeTurnIn(await snapshotFor(handlers, directory), "working")
    assert.equal((await snapshotFor(handlers, directory)).nativeSubagents.child_217.parentTaskID, parent.id)

    // The parent's own execution succeeds while the background child still
    // runs. The card must stay working, not settle replied yet.
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_group", assistantMessageID: "m2", ordinal: 0, text: "Parent answer." }, { id: "evt_217_hold_ended", created: 105 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_group" }, { id: "evt_217_hold_done", created: 106 }))
    await new Promise((resolve) => setTimeout(resolve, 80))
    const during = await snapshotFor(handlers, directory)
    const held = nativeTurnIn(during, "working")
    assert.equal(held.id, parent.id)
    assert.equal(deriveWorkStatus(held, Date.now()), "working", "the parent card stays working while the child runs")
    const liveRow = during.messages["w"].find((message: any) => message.author === "agent")
    assert.equal(liveRow.streaming, true, "the durable row stays streaming until the child barrier releases")

    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "child_217" }, { id: "evt_217_hold_child_done", created: 107 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "replied")))
    const released = await snapshotFor(handlers, directory)
    assert.equal(nativeTurnIn(released, "replied").id, parent.id)
    assert.equal((released.messages["w"] ?? []).find((message: any) => message.author === "agent").text, "Parent answer.")
    assert.equal(nativeSubagentState(released, "child_217"), "replied")

    // The host's synthetic completion is a second parent turn and a new card.
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "m3",
      item: {
        type: "synthetic",
        delivery: "steer",
        payload: { text: "subagent completed", metadata: { source: "subagent", childID: "child_217" } },
      },
    }, { id: "evt_217_hold_synthetic", created: 108 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group" }, { id: "evt_217_hold_synthetic_start", created: 109 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_group", assistantMessageID: "m4", ordinal: 0 }, { id: "evt_217_hold_synthetic_text", created: 110 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_group", assistantMessageID: "m4", ordinal: 0, text: "Synthetic answer." }, { id: "evt_217_hold_synthetic_end", created: 111 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_group" }, { id: "evt_217_hold_synthetic_done", created: 112 }))

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      return Object.values(state.subtasks).filter((task: any) => task.origin === "native" && task.native?.phase === "replied").length === 2
    })
    const state = await snapshotFor(handlers, directory)
    const turns = Object.values(state.subtasks).filter((task: any) => task.origin === "native") as any[]
    assert.equal(turns.length, 2, "the synthetic completion mints a second turn, not a second row on the first")
    assert.deepEqual(
      state.messages["w"].filter((message: any) => message.author === "agent").map((message: any) => message.text).sort(),
      ["Parent answer.", "Synthetic answer."],
    )
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket217: the background-subagent barrier releases the parent turn when its bound expires", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-217-subagent-timeout-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  await seedNativeWorkspace(ctx, directory)
  const service = new EnsembleV2Service(ctx, { nativeSubagentBarrierMs: 60 })
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Wait on the child" } },
    }, { id: "evt_217_bt_enqueue", created: 100 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group" }, { id: "evt_217_bt_start", created: 101 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_group", assistantMessageID: "m2", ordinal: 0 }, { id: "evt_217_bt_text", created: 102 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_group", assistantMessageID: "m2", ordinal: 0, text: "Parent answer." }, { id: "evt_217_bt_ended", created: 103 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "working")))
    emitEvent(nativeEvent("session.created", { sessionID: "child_217_timeout", parentID: "s_group", title: "Never finishes" }, { id: "evt_217_bt_child", created: 104 }))
    await waitFor(async () => (await snapshotFor(handlers, directory)).nativeSubagents.child_217_timeout?.state === "working")
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_group" }, { id: "evt_217_bt_done", created: 105 }))

    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(nativeTurnIn(await snapshotFor(handlers, directory), "working")?.id !== undefined, true, "still held before the bound")
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "replied")), 2_000)
    const state = await snapshotFor(handlers, directory)
    assert.equal(deriveWorkStatus(nativeTurnIn(state, "replied"), Date.now()), "replied")
    assert.equal(nativeSubagentState(state, "child_217_timeout"), "cancelled", "a timed-out barrier closes the live child record")
    const logs = await (handlers as any)["logs.recent"]({ directory, event: "native.turn.barrier.timeout", limit: 20 })
    assert.equal(logs.entries.length, 1)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket217: a cancelled internal prompt never falls back to a live user turn; only a missing inbox id does", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-217-cancel-identity-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  await seedNativeWorkspace(ctx, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Live user turn" } },
    }, { id: "evt_217_ci_enqueue", created: 100 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group" }, { id: "evt_217_ci_start", created: 101 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_group", assistantMessageID: "m2", ordinal: 0 }, { id: "evt_217_ci_text", created: 102 }))
    emitEvent(nativeEvent("session.text.delta", { sessionID: "s_group", assistantMessageID: "m2", ordinal: 0, delta: "Partial" }, { id: "evt_217_ci_delta", created: 103 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "working")))

    // An internal/onboarding prompt is enqueued behind the live turn. It has
    // no durable turn, so its cancellation names an inbox the service skipped.
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "m_internal",
      item: {
        type: "user",
        delivery: "queue",
        payload: { text: "onboarding", metadata: { "ensemble.internal": true, "ensemble.mirror": false } },
      },
    }, { id: "evt_217_ci_internal", created: 104 }))
    emitEvent(nativeEvent("session.inbox.cancelled", { sessionID: "s_group", inboxID: "m_internal" }, { id: "evt_217_ci_cancel_internal", created: 105 }))
    await new Promise((resolve) => setTimeout(resolve, 60))
    const active = await snapshotFor(handlers, directory)
    assert.equal(nativeTurnIn(active).native.phase, "working", "the unrelated live user turn keeps running")
    assert.equal(nativeTurnIn(active).interrupted, false)
    assert.equal((active.messages["w"] ?? []).find((message: any) => message.author === "agent")?.streaming, true)

    // No inbox identity means the session's active turn; that fallback still
    // settles the live turn honestly.
    emitEvent(nativeEvent("session.inbox.cancelled", { sessionID: "s_group" }, { id: "evt_217_ci_cancel_active", created: 106 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "cancelled")))
    const cancelled = await snapshotFor(handlers, directory)
    assert.equal(deriveWorkStatus(nativeTurnIn(cancelled), Date.now()), "cancelled")
    assert.equal(cancelled.messages["w"].find((message: any) => message.author === "agent").streaming, false)
    assert.equal(Object.values(cancelled.subtasks).filter((task: any) => task.origin === "native").length, 1, "the skipped prompt never minted a turn")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket217: a retry stream checkpoints at a bound instead of one durable write per delta", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-217-retry-checkpoints-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-217-retry-checkpoints-home-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_direct", { id: "s_direct" })
  await seedNativeDirect(ctx, directory, home)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_direct",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Stream after retry" } },
    }, { id: "evt_217_rc_enqueue", created: 100 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_direct" }, { id: "evt_217_rc_start", created: 101 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_direct", assistantMessageID: "m2", ordinal: 0 }, { id: "evt_217_rc_text", created: 102 }))
    emitEvent(nativeEvent("session.retry.scheduled", {
      sessionID: "s_direct",
      assistantMessageID: "m2",
      attempt: 2,
      error: { type: "provider.rate-limit", status: 429, retryAfterMs: 0 },
    }, { id: "evt_217_rc_retry", created: 103 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "retrying")))

    const originalSet = ctx.storage.set
    let messageWrites = 0
    ctx.storage.set = async (key: string, value: unknown) => {
      if (key.startsWith("v2/message/")) messageWrites++
      return originalSet(key, value)
    }
    const deltas = 60
    for (let index = 0; index < deltas; index++) {
      emitEvent(nativeEvent("session.text.delta", {
        sessionID: "s_direct",
        assistantMessageID: "m2",
        ordinal: 0,
        delta: "x",
      }, { id: `evt_217_rc_delta_${index}`, created: 104 + index }))
    }
    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      const row = (state.messages["dm:a:w"] ?? []).find((message: any) => message.author === "agent")
      return row?.text?.length === deltas
    })
    assert.ok(messageWrites > 0, "the retry stream still checkpoints crash-recovery text")
    assert.ok(messageWrites <= 10, `expected bounded checkpoints, saw ${messageWrites} writes for ${deltas} deltas`)
    const state = await snapshotFor(handlers, directory)
    assert.equal(state.messages["dm:a:w"].length, 2, "the retry stream never opens a second row")
    assert.equal(nativeTurnIn(state, "retrying").native.phase, "retrying")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

// ---- Ticket #220: native workspace user-message mention routing ----

type NativeMentionSeed = {
  id: string
  name: string
  sessionID?: string
  /** Defaults to a workspace member. */
  member?: boolean
  archived?: boolean
  directSessionID?: string
}

/** Seed a workspace team and its workspace group / direct native bindings. */
async function seedNativeMentionTeam(
  ctx: any,
  directory: string,
  specs: NativeMentionSeed[],
): Promise<void> {
  const seed = new V2Store(ctx)
  await seed.load()
  for (const spec of specs) {
    await seed.saveAgent(novaAgent({ id: spec.id, name: spec.name, archived: spec.archived ?? false }))
  }
  await seed.saveWorkspace(siteWorkspace(directory, {
    leaderID: specs[0]!.id,
    memberIDs: specs.filter((spec) => spec.member !== false).map((spec) => spec.id),
  }))
  for (const spec of specs) {
    if (spec.member === false) continue
    if (spec.sessionID) {
      await seed.saveBinding({ workspaceID: "w", agentID: spec.id, sessionID: spec.sessionID, kind: "workspace", directory, agentVersion: 1, updatedAt: 1 })
    }
    if (spec.directSessionID) {
      await seed.saveBinding({ workspaceID: "w", agentID: spec.id, sessionID: spec.directSessionID, kind: "direct", directory, agentVersion: 1, updatedAt: 1 })
    }
  }
}

function routeChildren(state: any, parentID: string): any[] {
  return Object.values(state.subtasks).filter((task: any) => task.parentID === parentID) as any[]
}

function nativeSystemMessages(state: any, channel = "w"): string[] {
  return (state.messages[channel] ?? [])
    .filter((message: any) => message.author === "system" && message.kind === "system")
    .map((message: any) => String(message.text))
}

/** Refusal notices only; peer-turn completion may add unrelated system lines. */
function nativeRefusalMessages(state: any, channel = "w"): string[] {
  return nativeSystemMessages(state, channel).filter((text) => text.startsWith("Peer turn refused:"))
}

test("ticket220: a native workspace mention creates one peer turn under the native turn in its dispatch group", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-220-single-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group_a", { id: "s_group_a" })
  nativeSessions.set("s_group_b", { id: "s_group_b" })
  await seedNativeMentionTeam(ctx, directory, [
    { id: "a", name: "Nova", sessionID: "s_group_a" },
    { id: "b", name: "Sage", sessionID: "s_group_b" },
  ])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group_a",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Pair with $Sage on the release." } },
    }, { id: "evt_220_single_enqueue", created: 100 }))

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      const turn = nativeTurnIn(state)
      return Boolean(turn) && routeChildren(state, turn.id).length === 1
    })
    const state = await snapshotFor(handlers, directory)
    const turn = nativeTurnIn(state)
    assert.ok(turn, "the native message is still its own turn")
    assert.equal(turn.assigneeID, "a", "the session agent remains the implicit addressee")
    const children = routeChildren(state, turn.id)
    assert.equal(children.length, 1, "one mention creates one peer turn")
    const child = children[0]
    assert.equal(child.assigneeID, "b")
    assert.equal(child.workKind, "turn")
    assert.equal(child.creatorType, "user")
    assert.equal(child.instruction, "Pair with $Sage on the release.", "the original native text is the instruction")
    assert.equal(child.dispatchGroupID, turn.dispatchGroupID, "routed work shares the native turn's dispatch group")
    assert.equal(child.dispatchDepth, 1, "the routed turn is one level under the native turn")

    const group = allWorkGroupsForTasks(Object.values(state.subtasks), state.subtasks, { now: Date.now() })
      .find((candidate) => candidate.id === turn.dispatchGroupID)
    assert.ok(group, "the native turn's group contains the routed work")
    const groupIDs = new Set(group.tasks.map((task) => task.id))
    assert.ok(groupIDs.has(turn.id) && groupIDs.has(child.id), "the routed turn shares the native turn's group")
    assert.ok(group.tasks.every((task) => task.dispatchGroupID === turn.dispatchGroupID))
    const ledger = state.dispatchGroups[turn.dispatchGroupID]
    assert.ok(ledger, "the native turn opens a normal root ledger")
    assert.equal(ledger.rootID, turn.dispatchGroupID)
    assert.equal(ledger.usedHops, 0, "a routed peer turn consumes no hop")
    assert.ok(state.messages["w"].some((message: any) => message.kind === "task" && message.taskID === child.id), "the route posts its assignment under the turn")
    assert.deepEqual(nativeRefusalMessages(state), [], "a valid route needs no refusal")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket220: routed child completion never synthesizes or reassigns the native turn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-220-synthesis-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group_b", { id: "s_group_b" })
  nativeSessions.set("s_group_c", { id: "s_group_c" })
  await seedNativeMentionTeam(ctx, directory, [
    { id: "a", name: "Nova" },
    { id: "b", name: "Sage", sessionID: "s_group_b" },
    { id: "c", name: "Echo", sessionID: "s_group_c" },
  ])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group_b",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Ask $Echo for the result" } },
    }, { id: "evt_220_synthesis_enqueue", created: 100 }))

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      const turn = nativeTurnIn(state)
      const child = turn ? routeChildren(state, turn.id)[0] : undefined
      return Boolean(child) && deriveWorkStatus(child, Date.now()) === "replied"
    })
    const state = await snapshotFor(handlers, directory)
    const turn = nativeTurnIn(state)
    assert.equal(turn.assigneeID, "b", "the session agent stays the native turn's assignee")
    assert.equal(turn.stage, "initial", "a routed child never turns the native turn into synthesis")
    assert.equal(turn.outcome, "pending", "the native turn waits for its own host answer")
    assert.ok(
      !nativeSystemMessages(state).some((text) => text.includes("Delegated subtasks completed")),
      "a routed child does not settle the native turn",
    )
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket220: multiple mentions fan out once each within the cap", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-220-fanout-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  for (const sessionID of ["s_group_a", "s_group_b", "s_group_c"]) nativeSessions.set(sessionID, { id: sessionID })
  await seedNativeMentionTeam(ctx, directory, [
    { id: "a", name: "Nova", sessionID: "s_group_a" },
    { id: "b", name: "Sage", sessionID: "s_group_b" },
    { id: "c", name: "Echo", sessionID: "s_group_c" },
  ])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group_a",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "$Sage $Echo then $Sage and $Echo" } },
    }, { id: "evt_220_fanout_enqueue", created: 100 }))

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      const turn = nativeTurnIn(state)
      return Boolean(turn) && routeChildren(state, turn.id).length === 2
    })
    const state = await snapshotFor(handlers, directory)
    const turn = nativeTurnIn(state)
    const assignees = routeChildren(state, turn.id).map((task) => task.assigneeID).sort()
    assert.deepEqual(assignees, ["b", "c"], "each unique recipient gets one peer turn")
    assert.deepEqual(nativeRefusalMessages(state), [], "duplicates are suppressed without a refusal")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket220: the session agent is the implicit addressee and self-mentions are skipped", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-220-self-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group_a", { id: "s_group_a" })
  nativeSessions.set("s_group_b", { id: "s_group_b" })
  await seedNativeMentionTeam(ctx, directory, [
    { id: "a", name: "Nova", sessionID: "s_group_a" },
    { id: "b", name: "Sage", sessionID: "s_group_b" },
  ])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group_a",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "$Nova please ask $Sage" } },
    }, { id: "evt_220_self_enqueue", created: 100 }))

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      const turn = nativeTurnIn(state)
      return Boolean(turn) && routeChildren(state, turn.id).length === 1
    })
    const state = await snapshotFor(handlers, directory)
    const turn = nativeTurnIn(state)
    assert.deepEqual(routeChildren(state, turn.id).map((task) => task.assigneeID), ["b"])
    assert.ok(!nativeRefusalMessages(state).some((text) => text.includes("$Nova")), "a self-mention is not a refusal")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket220: a direct conversation never routes mentions and explains why", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-220-direct-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group_a", { id: "s_group_a" })
  nativeSessions.set("s_direct_a", { id: "s_direct_a" })
  nativeSessions.set("s_group_b", { id: "s_group_b" })
  await seedNativeMentionTeam(ctx, directory, [
    { id: "a", name: "Nova", sessionID: "s_group_a", directSessionID: "s_direct_a" },
    { id: "b", name: "Sage", sessionID: "s_group_b" },
  ])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_direct_a",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Privately ask $Sage" } },
    }, { id: "evt_220_direct_enqueue", created: 100 }))

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      const turn = nativeTurnIn(state)
      return Boolean(turn) && (state.messages["dm:a:w"] ?? []).some((message: any) => message.author === "system")
    })
    const state = await snapshotFor(handlers, directory)
    const turn = nativeTurnIn(state)
    assert.equal(routeChildren(state, turn.id).length, 0, "a direct conversation creates no peer turn")
    assert.equal(state.messages["w"], undefined, "a direct message never leaks into the workspace channel")
    assert.ok(
      nativeRefusalMessages(state, "dm:a:w").some((text) => text.includes("$Sage") && text.includes("direct conversations stay one-to-one")),
      "the direct conversation explains why the mention did not route",
    )
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket220: duplicate enqueues and duplicate recipients never duplicate routed work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-220-duplicate-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group_a", { id: "s_group_a" })
  nativeSessions.set("s_group_b", { id: "s_group_b" })
  await seedNativeMentionTeam(ctx, directory, [
    { id: "a", name: "Nova", sessionID: "s_group_a" },
    { id: "b", name: "Sage", sessionID: "s_group_b" },
  ])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    const enqueue = (eventID: string) => emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group_a",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Ask $Sage and $Sage again" } },
    }, { id: eventID, created: 100 }))
    enqueue("evt_220_dup_enqueue_1")
    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      const turn = nativeTurnIn(state)
      return Boolean(turn) && routeChildren(state, turn.id).length === 1
    })
    enqueue("evt_220_dup_enqueue_2")
    await new Promise((resolve) => setTimeout(resolve, 50))
    const state = await snapshotFor(handlers, directory)
    const turn = nativeTurnIn(state)
    assert.equal(routeChildren(state, turn.id).length, 1, "a replayed enqueue creates no second peer turn")
    assert.equal(Object.values(state.subtasks).filter((task: any) => task.origin === "native").length, 1, "the replay reuses the native turn")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket220: the per-message cap refuses extras visibly and creates no extra work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-220-cap-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group_a", { id: "s_group_a" })
  nativeSessions.set("s_group_b", { id: "s_group_b" })
  nativeSessions.set("s_group_c", { id: "s_group_c" })
  await seedNativeMentionTeam(ctx, directory, [
    { id: "a", name: "Nova", sessionID: "s_group_a" },
    { id: "b", name: "Sage", sessionID: "s_group_b" },
    { id: "c", name: "Echo", sessionID: "s_group_c" },
  ])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on", maxDelegations: 1 } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group_a",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "$Sage then $Echo" } },
    }, { id: "evt_220_cap_enqueue", created: 100 }))

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      const turn = nativeTurnIn(state)
      return Boolean(turn) && nativeRefusalMessages(state).length === 1
    })
    const state = await snapshotFor(handlers, directory)
    const turn = nativeTurnIn(state)
    assert.deepEqual(routeChildren(state, turn.id).map((task) => task.assigneeID), ["b"], "the first recipient is admitted")
    const refusals = nativeRefusalMessages(state)
    assert.equal(refusals.length, 1)
    assert.match(refusals[0]!, /\$Echo/)
    assert.match(refusals[0]!, /delegation limit is 1/)
    assert.equal(Object.values(state.subtasks).filter((task: any) => task.assigneeID === "c").length, 0, "the over-cap recipient creates no work")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket220: unknown, archived, and outside-roster mentions are refused visibly without work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-220-roster-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group_a", { id: "s_group_a" })
  nativeSessions.set("s_group_b", { id: "s_group_b" })
  await seedNativeMentionTeam(ctx, directory, [
    { id: "a", name: "Nova", sessionID: "s_group_a" },
    { id: "b", name: "Sage", sessionID: "s_group_b" },
    { id: "c", name: "Old", member: true, archived: true },
    { id: "d", name: "Outside", member: false },
  ])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group_a",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "$Ghost $Old $Outside then $Sage" } },
    }, { id: "evt_220_roster_enqueue", created: 100 }))

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      const turn = nativeTurnIn(state)
      return Boolean(turn) && routeChildren(state, turn.id).length === 1 && nativeRefusalMessages(state).length === 3
    })
    const state = await snapshotFor(handlers, directory)
    const turn = nativeTurnIn(state)
    assert.deepEqual(routeChildren(state, turn.id).map((task) => task.assigneeID), ["b"], "the valid recipient still routes")
    const refusals = nativeRefusalMessages(state)
    assert.ok(refusals.some((text) => text.includes("$Ghost") && text.includes("no workspace member matches")), "unknown names are refused")
    assert.ok(refusals.some((text) => text.includes("$Old") && text.includes("archived")), "archived agents are refused")
    assert.ok(refusals.some((text) => text.includes("$Outside") && text.includes("not a workspace member")), "outside-roster agents are refused")
    assert.equal(Object.values(state.subtasks).filter((task: any) => task.assigneeID === "c" || task.assigneeID === "d").length, 0)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket220: an exhausted dispatch group refuses the route visibly and creates no work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-220-budget-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group_a", { id: "s_group_a" })
  nativeSessions.set("s_group_b", { id: "s_group_b" })
  await seedNativeMentionTeam(ctx, directory, [
    { id: "a", name: "Nova", sessionID: "s_group_a" },
    { id: "b", name: "Sage", sessionID: "s_group_b" },
  ])
  const turnID = nativeTurnID("s_group_a", "m1")
  const groupID = nativeTurnGroupID(turnID)
  const seed = new V2Store(ctx)
  await seed.load()
  await seed.saveDispatchGroup({
    id: groupID,
    workspaceID: "w",
    rootID: groupID,
    continuationIndex: 0,
    maxHops: 8,
    usedHops: 8,
    depthMax: 8,
    commandMaxHops: 24,
    commandUsedHops: 8,
    maxContinuations: 2,
    continuationsUsed: 0,
    createdAt: 1,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group_a",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Route this to $Sage" } },
    }, { id: "evt_220_budget_enqueue", created: 100 }))

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      return Boolean(nativeTurnIn(state)) && nativeRefusalMessages(state).length === 1
    })
    const state = await snapshotFor(handlers, directory)
    const turn = nativeTurnIn(state)
    assert.equal(routeChildren(state, turn.id).length, 0, "budget exhaustion creates no peer turn")
    const refusal = nativeRefusalMessages(state)[0]!
    assert.match(refusal, /\$Sage/)
    assert.match(refusal, /dispatch group is exhausted \(8\/8 hops\)/)
    assert.equal(Object.values(state.subtasks).filter((task: any) => task.assigneeID === "b").length, 0)
    assert.equal(state.messages["w"].filter((message: any) => message.author === "user").length, 1, "the native message still posts")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket220: the kill switch turns routing off with a visible notice and no work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-220-kill-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group_a", { id: "s_group_a" })
  nativeSessions.set("s_group_b", { id: "s_group_b" })
  await seedNativeMentionTeam(ctx, directory, [
    { id: "a", name: "Nova", sessionID: "s_group_a" },
    { id: "b", name: "Sage", sessionID: "s_group_b" },
  ])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on", nativeMentionRouting: false } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group_a",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Ask $Sage anyway" } },
    }, { id: "evt_220_kill_enqueue", created: 100 }))

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      return Boolean(nativeTurnIn(state)) && nativeRefusalMessages(state).length === 1
    })
    const state = await snapshotFor(handlers, directory)
    const turn = nativeTurnIn(state)
    assert.equal(routeChildren(state, turn.id).length, 0, "the kill switch creates no peer turn")
    const refusal = nativeRefusalMessages(state)[0]!
    assert.match(refusal, /\$Sage/)
    assert.match(refusal, /native mention routing is off/)
    assert.equal(Object.values(state.subtasks).filter((task: any) => task.assigneeID === "b").length, 0)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket220: routing parses sanitized prose from the original native text", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-220-sanitize-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group_a", { id: "s_group_a" })
  nativeSessions.set("s_group_b", { id: "s_group_b" })
  nativeSessions.set("s_group_c", { id: "s_group_c" })
  await seedNativeMentionTeam(ctx, directory, [
    { id: "a", name: "Nova", sessionID: "s_group_a" },
    { id: "b", name: "Sage", sessionID: "s_group_b" },
    { id: "c", name: "Echo", sessionID: "s_group_c" },
  ])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    const text = "Run `$Echo` and open src/$Echo.ts, then $Sage."
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group_a",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text } },
    }, { id: "evt_220_sanitize_enqueue", created: 100 }))

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      const turn = nativeTurnIn(state)
      return Boolean(turn) && routeChildren(state, turn.id).length === 1
    })
    const state = await snapshotFor(handlers, directory)
    const turn = nativeTurnIn(state)
    assert.deepEqual(routeChildren(state, turn.id).map((task) => task.assigneeID), ["b"], "code and paths never route")
    assert.equal(state.messages["w"].find((message: any) => message.native?.inboxID === "m1").text, text, "the original text is preserved")
    assert.deepEqual(nativeRefusalMessages(state), [])
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

// ---- Ticket #236: native turn ownership and contact ledger ----

test("ticket236: a delegation from a native turn joins the turn and its dispatch group", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-236-delegate-"))
  const { ctx, nativeSessions, emitEvent, tools } = fakeContext()
  nativeSessions.set("s_group_a", { id: "s_group_a" })
  nativeSessions.set("s_group_b", { id: "s_group_b" })
  await seedNativeMentionTeam(ctx, directory, [
    { id: "a", name: "Nova", sessionID: "s_group_a" },
    { id: "b", name: "Sage", sessionID: "s_group_b" },
  ])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on", toolSurface: "legacy" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group_a",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Plan the release" } },
    }, { id: "evt_236_delegate_enqueue", created: Date.now() }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group_a" }, { id: "evt_236_delegate_start", created: Date.now() + 1 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "working")))
    const turn = nativeTurnIn(await snapshotFor(handlers, directory), "working")

    const delegated = await tools.get("delegate").execute(
      { maxHops: 1, assignee: "Sage", title: "Release notes", instruction: "Draft the release notes." },
      { sessionID: "s_group_a" },
    )
    assert.match(delegated.content, /Delegated to Sage/)

    const after = await snapshotFor(handlers, directory)
    const child = Object.values(after.subtasks).find((task: any) => task.title === "Release notes") as any
    assert.ok(child, "the delegation created its child")
    assert.equal(child.parentID, turn.id, "the native turn is the parent, not an absent run")
    assert.equal(child.dispatchGroupID, turn.dispatchGroupID, "the delegation joins the turn's group")
    assert.equal(child.dispatchDepth, (turn.dispatchDepth ?? 0) + 1, "the delegation sits one level under the turn")
    assert.equal(child.taskMaxHops, 1, "the granted task budget is stored on the child")
    assert.deepEqual(after.subtasks[turn.id].native.contacted, ["b"], "the turn records the contacted recipient")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket236: a handoff from a native turn anchors to the turn, never an unrelated open task", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-236-handoff-"))
  const { ctx, nativeSessions, emitEvent, tools } = fakeContext()
  nativeSessions.set("s_group_a", { id: "s_group_a" })
  nativeSessions.set("s_group_b", { id: "s_group_b" })
  await seedNativeMentionTeam(ctx, directory, [
    { id: "a", name: "Nova", sessionID: "s_group_a" },
    { id: "b", name: "Sage", sessionID: "s_group_b" },
  ])
  // A newer open task of the same sender in another group: the old heuristic
  // would hand off under it. The live native turn must win.
  const seed = new V2Store(ctx)
  await seed.load()
  await seed.saveSubtask({
    id: "t_unrelated",
    workspaceID: "w",
    creatorType: "user",
    assigneeID: "a",
    title: "Older unrelated work",
    instruction: "Leave this open.",
    mode: "research",
    state: "working",
    stage: "initial",
    outcome: "pending",
    interrupted: false,
    awaitingChildren: false,
    attempts: 1,
    createdAt: 500,
    claimedBy: "run_foreign",
    activeRunID: "run_foreign",
    leaseUntil: Date.now() + 60_000,
    dispatchGroupID: "group_unrelated",
  })
  mkdirSync(join(directory, ".ensemble", "handoffs"), { recursive: true })
  writeFileSync(join(directory, ".ensemble", "handoffs", "task-nova-sage-236.md"), "---\nensemble: handoff\ntask: Review the release notes\n---\n# Handoff\n")
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on", toolSurface: "legacy" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group_a",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Plan the release" } },
    }, { id: "evt_236_handoff_enqueue", created: 100 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group_a" }, { id: "evt_236_handoff_start", created: 101 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "working")))
    const turn = nativeTurnIn(await snapshotFor(handlers, directory), "working")

    const handed = await tools.get("handoff").execute(
      { task: "Review the release notes", summary: "Review", path: ".ensemble/handoffs/task-nova-sage-236.md", to: "Sage", maxHops: 0 },
      { sessionID: "s_group_a" },
    )
    assert.match(handed.content, /Handed to \$Sage/)

    const after = await snapshotFor(handlers, directory)
    const hop = Object.values(after.subtasks).find((task: any) => task.workKind === "handoff") as any
    assert.ok(hop, "the handoff created its hop")
    assert.equal(hop.parentID, turn.id, "the native turn wins over the newer unrelated open task")
    assert.equal(hop.dispatchGroupID, turn.dispatchGroupID, "the hop joins the turn's group")
    assert.equal(hop.dispatchDepth, (turn.dispatchDepth ?? 0) + 1)
    assert.equal(hop.handoff.parentID, turn.id)
    assert.deepEqual(after.subtasks[turn.id].native.contacted, ["b"])
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket236: an ask-person from a native turn links the approval to the turn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-236-ask-"))
  const { ctx, nativeSessions, emitEvent, tools } = fakeContext()
  nativeSessions.set("s_group_a", { id: "s_group_a" })
  await seedNativeMentionTeam(ctx, directory, [
    { id: "a", name: "Nova", sessionID: "s_group_a" },
  ])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on", toolSurface: "legacy" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group_a",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Prepare the release" } },
    }, { id: "evt_236_ask_enqueue", created: 100 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group_a" }, { id: "evt_236_ask_start", created: 101 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "working")))
    const turn = nativeTurnIn(await snapshotFor(handlers, directory), "working")

    const asked = await tools.get("ask_person").execute({ question: "Which channel should ship first?" }, { sessionID: "s_group_a" })
    assert.match(asked.content, /approval inbox/)

    const after = await snapshotFor(handlers, directory)
    const approval = Object.values(after.approvals).find((item: any) => item.kind === "ask_person") as any
    assert.ok(approval, "the question creates its approval")
    assert.equal(approval.subtaskID, turn.id, "the approval belongs to the native turn")
    assert.equal(after.subtasks[turn.id].approvalID, approval.id, "the turn points at the question")
    assert.equal(Object.keys(after.dispatchGroups).filter((groupID) => groupID !== turn.dispatchGroupID).length, 0, "no unrelated group is created")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket236: a group post from a native turn keeps its row and route under the turn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-236-post-"))
  const { ctx, nativeSessions, emitEvent, tools } = fakeContext()
  nativeSessions.set("s_group_a", { id: "s_group_a" })
  nativeSessions.set("s_group_b", { id: "s_group_b" })
  await seedNativeMentionTeam(ctx, directory, [
    { id: "a", name: "Nova", sessionID: "s_group_a" },
    { id: "b", name: "Sage", sessionID: "s_group_b" },
  ])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on", toolSurface: "legacy" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group_a",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Coordinate the release" } },
    }, { id: "evt_236_post_enqueue", created: 100 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group_a" }, { id: "evt_236_post_start", created: 101 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "working")))
    const turn = nativeTurnIn(await snapshotFor(handlers, directory), "working")

    const posted = await tools.get("send_message").execute({ kind: "workspace", text: "Please review the notes, $Sage." }, { sessionID: "s_group_a" })
    assert.match(posted.content, /Posted/)

    const after = await snapshotFor(handlers, directory)
    const post = agentTextMessages(after, turn.id)[0]
    assert.ok(post, "the post is recorded on the native turn")
    const children = routeChildren(after, turn.id)
    assert.equal(children.length, 1, "the post's mention creates one routed turn")
    assert.equal(children[0].assigneeID, "b")
    assert.equal(children[0].dispatchGroupID, turn.dispatchGroupID, "the route stays in the turn's group")
    assert.deepEqual(after.subtasks[turn.id].native.contacted, ["b"], "the post records the contacted recipient")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket236: a user route is not routed again by the agent's final text", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-236-user-route-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group_a", { id: "s_group_a" })
  nativeSessions.set("s_group_b", { id: "s_group_b" })
  await seedNativeMentionTeam(ctx, directory, [
    { id: "a", name: "Nova", sessionID: "s_group_a" },
    { id: "b", name: "Sage", sessionID: "s_group_b" },
  ])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group_a",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Ask $Sage to review the notes." } },
    }, { id: "evt_236_user_route_enqueue", created: Date.now() }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group_a" }, { id: "evt_236_user_route_start", created: Date.now() + 1 }))
    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      const turn = nativeTurnIn(state)
      return Boolean(turn) && routeChildren(state, turn.id).length === 1
    })
    const turn = nativeTurnIn(await snapshotFor(handlers, directory))
    assert.deepEqual(turn.native.contacted, ["b"], "the user route records its recipient before the agent replies")

    succeedNativeTurn(emitEvent, {
      sessionID: "s_group_a",
      assistantMessageID: "m2",
      text: "Reviewed. $Sage please confirm the final copy.",
      prefix: "evt_236_user_route",
    })
    await waitFor(async () => nativeTurnIn(await snapshotFor(handlers, directory), "replied") !== undefined)

    const after = await snapshotFor(handlers, directory)
    const replied = nativeTurnIn(after, "replied")
    assert.equal(routeChildren(after, replied.id).length, 1, "the final text creates no second turn for the same recipient")
    assert.deepEqual(replied.native.contacted, ["b"], "the ledger stays one entry per recipient")
    const suppressed = await (handlers as any)["logs.recent"]({ directory, event: "native.route.suppressed", limit: 20 })
    assert.ok(
      suppressed.entries.some((entry: any) => entry.agentID === "b" && entry.reason === "already-routed" && entry.source === "agent-final"),
      "the suppression is observable with a distinct reason",
    )
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket236: an explicit delegation is not routed again by the leader's final text", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-236-delegate-dedupe-"))
  const { ctx, nativeSessions, emitEvent, tools } = fakeContext()
  nativeSessions.set("s_group_a", { id: "s_group_a" })
  nativeSessions.set("s_group_b", { id: "s_group_b" })
  await seedNativeMentionTeam(ctx, directory, [
    { id: "a", name: "Nova", sessionID: "s_group_a" },
    { id: "b", name: "Sage", sessionID: "s_group_b" },
  ])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on", toolSurface: "legacy" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group_a",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Plan the release" } },
    }, { id: "evt_236_delegate_dedupe_enqueue", created: Date.now() }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group_a" }, { id: "evt_236_delegate_dedupe_start", created: Date.now() + 1 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "working")))

    const delegated = await tools.get("delegate").execute(
      { maxHops: 0, assignee: "Sage", title: "Write the notes", instruction: "Write the release notes." },
      { sessionID: "s_group_a" },
    )
    assert.match(delegated.content, /Delegated to Sage/)

    succeedNativeTurn(emitEvent, {
      sessionID: "s_group_a",
      assistantMessageID: "m2",
      text: "Ownership is set. $Sage has the notes.",
      prefix: "evt_236_delegate_dedupe",
    })
    await waitFor(async () => nativeTurnIn(await snapshotFor(handlers, directory), "replied") !== undefined)

    const after = await snapshotFor(handlers, directory)
    const replied = nativeTurnIn(after, "replied")
    assert.equal(
      Object.values(after.subtasks).filter((task: any) => task.workKind === "delegation" && task.assigneeID === "b").length,
      1,
      "the explicit delegation is the only work for Sage",
    )
    assert.equal(
      Object.values(after.subtasks).filter((task: any) => task.workKind === "turn" && task.assigneeID === "b").length,
      0,
      "the final text creates no peer turn for the already delegated recipient",
    )
    assert.deepEqual(replied.native.contacted, ["b"])
    const suppressed = await (handlers as any)["logs.recent"]({ directory, event: "native.route.suppressed", limit: 20 })
    assert.ok(suppressed.entries.some((entry: any) => entry.agentID === "b" && entry.reason === "already-routed"))
    assert.equal(routeChildren(after, replied.id).filter((child: any) => child.assigneeID === "b").length, 1, "the delegation remains the one child")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket236: the native contact ledger survives restart and replay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-236-restart-"))
  const values = new Map<string, unknown>()
  const first = fakeContext(values)
  first.nativeSessions.set("s_group_a", { id: "s_group_a" })
  first.nativeSessions.set("s_group_b", { id: "s_group_b" })
  await seedNativeMentionTeam(first.ctx, directory, [
    { id: "a", name: "Nova", sessionID: "s_group_a" },
    { id: "b", name: "Sage", sessionID: "s_group_b" },
  ])
  const service = new EnsembleV2Service(first.ctx)
  const stop = await startServiceForTest(service, service.ctx)
  let turnID = ""
  try {
    await service.handlers().invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    first.emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group_a",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Ask $Sage to review." } },
    }, { id: "evt_236_restart_enqueue", created: Date.now() }))
    first.emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group_a" }, { id: "evt_236_restart_start", created: Date.now() + 1 }))
    await waitFor(async () => {
      const state = await snapshotFor(service.handlers(), directory)
      const turn = nativeTurnIn(state)
      if (!turn) return false
      turnID = turn.id
      return routeChildren(state, turn.id).length === 1
    })
    const routed = await snapshotFor(service.handlers(), directory)
    assert.deepEqual(routed.subtasks[turnID].native.contacted, ["b"])
  } finally {
    await stop()
  }

  const second = fakeContext(values)
  second.nativeSessions.set("s_group_a", { id: "s_group_a" })
  second.nativeSessions.set("s_group_b", { id: "s_group_b" })
  // Restart reconciliation reads the host transcript once. Give it the real
  // turn identity plus the settled answer and idle marker.
  ;(second.ctx.session as any).context = async () => ({
    data: [
      { type: "user", id: "m1", time: { created: Date.now() - 10 }, content: [{ type: "text", text: "Ask $Sage to review." }] },
      { type: "assistant", time: { created: Date.now() - 5 }, content: [{ type: "text", text: "Done." }] },
      { type: "idle", time: { created: Date.now() } },
    ],
  })
  const restarted = new EnsembleV2Service(second.ctx)
  const stopRestarted = await startServiceForTest(restarted, restarted.ctx)
  try {
    await waitFor(async () => {
      const state = await snapshotFor(restarted.handlers(), directory)
      const turn = state.subtasks[turnID]
      return Boolean(turn) && (turn.native?.phase === "replied" || turn.native?.phase === "interrupted")
    })
    const recovered = await snapshotFor(restarted.handlers(), directory)
    assert.deepEqual(recovered.subtasks[turnID].native.contacted, ["b"], "the ledger survives restart")
    assert.equal(routeChildren(recovered, turnID).length, 1, "restart recovery never duplicates the routed work")

    // Replaying the original enqueue after restart must not re-route either.
    second.emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group_a",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Ask $Sage to review." } },
    }, { id: "evt_236_restart_replay", created: Date.now() }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    const replayed = await snapshotFor(restarted.handlers(), directory)
    assert.deepEqual(replayed.subtasks[turnID].native.contacted, ["b"], "replay keeps one ledger entry")
    assert.equal(routeChildren(replayed, turnID).length, 1, "replay creates no second route")
  } finally {
    await stopRestarted()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket236: an outside-roster approval is not requested twice by the final text", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-236-outside-"))
  const { ctx, nativeSessions, emitEvent, tools } = fakeContext()
  nativeSessions.set("s_group_a", { id: "s_group_a" })
  nativeSessions.set("s_group_b", { id: "s_group_b" })
  await seedNativeMentionTeam(ctx, directory, [
    { id: "a", name: "Nova", sessionID: "s_group_a" },
    { id: "b", name: "Sage", sessionID: "s_group_b" },
    { id: "e", name: "Echo", member: false },
  ])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on", toolSurface: "legacy" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group_a",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Coordinate the release" } },
    }, { id: "evt_236_outside_enqueue", created: Date.now() }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group_a" }, { id: "evt_236_outside_start", created: Date.now() + 1 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "working")))

    const posted = await tools.get("send_message").execute({ kind: "workspace", text: "Loop in $Echo for the audit." }, { sessionID: "s_group_a" })
    assert.match(posted.content, /Approval required/)

    succeedNativeTurn(emitEvent, {
      sessionID: "s_group_a",
      assistantMessageID: "m2",
      text: "The plan is set. $Echo please review.",
      prefix: "evt_236_outside",
    })
    await waitFor(async () => nativeTurnIn(await snapshotFor(handlers, directory), "replied") !== undefined)

    const after = await snapshotFor(handlers, directory)
    const replied = nativeTurnIn(after, "replied")
    assert.equal(
      Object.values(after.approvals).filter((approval: any) => approval.kind === "outside_roster" && approval.payload?.assigneeID === "e").length,
      1,
      "one outside-roster approval per recipient",
    )
    assert.deepEqual(replied.native.contacted, ["e"])
    const suppressed = await (handlers as any)["logs.recent"]({ directory, event: "native.route.suppressed", limit: 20 })
    assert.ok(suppressed.entries.some((entry: any) => entry.agentID === "e" && entry.reason === "already-routed"))
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

// ---- Ticket #221: native agent final-text mention routing ----

/** Emit one native turn's text and terminal success in host order. */
function succeedNativeTurn(
  emitEvent: (value: any) => void,
  input: { sessionID: string; assistantMessageID: string; text: string; prefix: string; created?: number },
): void {
  const at = input.created ?? Date.now()
  emitEvent(nativeEvent("session.text.started", {
    sessionID: input.sessionID,
    assistantMessageID: input.assistantMessageID,
    ordinal: 0,
  }, { id: `${input.prefix}_text_start`, created: at }))
  emitEvent(nativeEvent("session.text.ended", {
    sessionID: input.sessionID,
    assistantMessageID: input.assistantMessageID,
    ordinal: 0,
    text: input.text,
  }, { id: `${input.prefix}_text_end`, created: at + 1 }))
  emitEvent(nativeEvent("session.execution.succeeded", {
    sessionID: input.sessionID,
  }, { id: `${input.prefix}_done`, created: at + 2 }))
}

function agentTextMessages(state: any, taskID: string, channel = "w"): any[] {
  return (state.messages[channel] ?? []).filter(
    (message: any) => message.author === "agent" && message.kind === "text" && message.taskID === taskID,
  )
}

test("ticket221: a native turn's final $Name creates one child peer turn in its group with server-assigned budgets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-221-final-single-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group_a", { id: "s_group_a" })
  nativeSessions.set("s_group_b", { id: "s_group_b" })
  await seedNativeMentionTeam(ctx, directory, [
    { id: "a", name: "Nova", sessionID: "s_group_a" },
    { id: "b", name: "Sage", sessionID: "s_group_b" },
  ])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group_a",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Plan the release" } },
    }, { id: "evt_221_single_enqueue", created: Date.now() }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group_a" }, { id: "evt_221_single_start", created: Date.now() + 1 }))
    const finalText = "The plan is ready. Handing the review to $Sage."
    succeedNativeTurn(emitEvent, { sessionID: "s_group_a", assistantMessageID: "m2", text: finalText, prefix: "evt_221_single" })

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      const turn = nativeTurnIn(state, "replied")
      return Boolean(turn) && routeChildren(state, turn.id).length === 1
    })
    const state = await snapshotFor(handlers, directory)
    const turn = nativeTurnIn(state, "replied")
    assert.ok(turn, "the native turn still settles from its own execution")
    assert.equal(agentTextMessages(state, turn.id).length, 1, "the final text is the one group message")
    assert.equal(agentTextMessages(state, turn.id)[0].text, finalText, "the exact final native text posts")
    const child = routeChildren(state, turn.id)[0]
    assert.equal(child.assigneeID, "b", "the mention creates the named peer turn")
    assert.equal(child.parentID, turn.id, "the routed turn is anchored to the native turn")
    assert.equal(child.dispatchGroupID, turn.dispatchGroupID, "the route lives in the native turn's group")
    assert.equal(child.workKind, "turn")
    assert.equal(child.creatorType, "agent", "the final text is an agent-authored route")
    assert.equal(child.creatorAgentID, "a")
    assert.equal(child.turn?.askerKind, "agent")
    assert.equal(child.turn?.askerID, "a")
    assert.equal(child.instruction, finalText, "the original final text is the child instruction")
    assert.equal(child.taskMaxHops, undefined, "the agent authors no task budget on the native route")
    const ledger = state.dispatchGroups[turn.dispatchGroupID]
    assert.ok(ledger, "the native turn opens a normal root ledger")
    assert.equal(ledger.usedHops, 0, "a routed peer turn consumes no hop")
    assert.deepEqual(nativeRefusalMessages(state), [], "a valid route needs no refusal")
    const logs = await (handlers as any)["logs.recent"]({ directory, event: "native.route.created", limit: 20 })
    assert.equal(logs.entries.length, 1)
    assert.equal(logs.entries[0].turnID, turn.id)
    assert.equal(logs.entries[0].recipientID, "b")
    assert.equal(logs.entries[0].source, "agent-final")
    const planned = await (handlers as any)["logs.recent"]({ directory, event: "native.route.planned", limit: 20 })
    assert.equal(planned.entries.length, 1)
    assert.equal(planned.entries[0].groupRemaining, 8, "the server sees the root group's remaining budget")
    assert.equal(planned.entries[0].delegationTaskMaxHops, 8, "the server derives the delegation budget from the ledger")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket221: agent final text suppresses self, repeated recipients, and code, URL, or path mentions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-221-final-guards-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  for (const sessionID of ["s_group_a", "s_group_b", "s_group_c"]) nativeSessions.set(sessionID, { id: sessionID })
  await seedNativeMentionTeam(ctx, directory, [
    { id: "a", name: "Nova", sessionID: "s_group_a" },
    { id: "b", name: "Sage", sessionID: "s_group_b" },
    { id: "c", name: "Echo", sessionID: "s_group_c" },
  ])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on", maxDelegations: 1 } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group_a",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Guard the final answer" } },
    }, { id: "evt_221_guards_enqueue", created: Date.now() }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group_a" }, { id: "evt_221_guards_start", created: Date.now() + 1 }))
    const finalText = "$Nova keep this. $Sage please check `$Echo`, open src/$Echo.ts, read https://example.com/$Echo, then $Sage again and $Echo too."
    succeedNativeTurn(emitEvent, { sessionID: "s_group_a", assistantMessageID: "m2", text: finalText, prefix: "evt_221_guards" })

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      const turn = nativeTurnIn(state, "replied")
      return Boolean(turn) && routeChildren(state, turn.id).length === 1 && nativeRefusalMessages(state).length === 1
    })
    const state = await snapshotFor(handlers, directory)
    const turn = nativeTurnIn(state, "replied")
    const children = routeChildren(state, turn.id)
    assert.deepEqual(children.map((task) => task.assigneeID), ["b"], "only the first prose recipient is admitted")
    assert.equal(children[0].instruction, finalText, "the child receives the original final text")
    assert.equal(Object.values(state.subtasks).filter((task: any) => task.assigneeID === "c").length, 0, "code, URL, path, and over-cap mentions create no work")
    const refusals = nativeRefusalMessages(state)
    assert.equal(refusals.length, 1)
    assert.match(refusals[0]!, /\$Echo/)
    assert.match(refusals[0]!, /delegation limit is 1/, "the fan-out cap is visible")

    const suppressed = await (handlers as any)["logs.recent"]({ directory, event: "native.route.suppressed", limit: 20 })
    assert.deepEqual(suppressed.entries.map((entry: any) => entry.reason).sort(), ["duplicate", "self"])
    assert.ok(suppressed.entries.every((entry: any) => entry.turnID === turn.id && entry.source === "agent-final"))
    const refused = await (handlers as any)["logs.recent"]({ directory, event: "native.route.refused", limit: 20 })
    assert.equal(refused.entries.length, 1)
    assert.equal(refused.entries[0].reason, "fan-out")
    assert.equal(refused.entries[0].agentID, "c")
    const planned = await (handlers as any)["logs.recent"]({ directory, event: "native.route.planned", limit: 20 })
    assert.equal(planned.entries.length, 1)
    assert.equal(planned.entries[0].routes, 1)
    assert.equal(planned.entries[0].suppressed, 2)
    assert.equal(planned.entries[0].refusals, 1)
    assert.equal(planned.entries[0].excluded["inline-code"], 1)
    assert.ok(planned.entries[0].excluded.url >= 1, "the URL span is excluded")
    assert.ok(planned.entries[0].excluded["file-path"] >= 1, "the path span is excluded")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket221: a task run routes final $Name, suppresses a reply to its sender, and refuses a cycle", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-221-final-loop-"))
  const { ctx, nativeSessions } = fakeContext()
  for (const sessionID of ["s_group_a", "s_group_b", "s_group_c"]) nativeSessions.set(sessionID, { id: sessionID })
  await seedNativeMentionTeam(ctx, directory, [
    { id: "a", name: "Nova", sessionID: "s_group_a" },
    { id: "b", name: "Sage", sessionID: "s_group_b" },
    { id: "c", name: "Echo", sessionID: "s_group_c" },
  ])
  const replies: Record<string, string> = {
    s_group_a: "Starting the review. $Sage please take it.",
    s_group_b: "$Echo you are next.",
    s_group_c: "$Sage thanks. $Nova final check.",
  }
  ;(ctx.session as any).context = async ({ sessionID }: any) => ({
    data: [{
      type: "assistant",
      time: { created: Date.now() },
      content: [{ type: "text", text: replies[sessionID] ?? "OK" }],
    }],
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: "w", text: "Coordinate the release" } })

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      return nativeRefusalMessages(state).some((text) => text.includes("$Nova") && text.includes("close a cycle"))
    })
    const state = await snapshotFor(handlers, directory)
    const tasks = Object.values(state.subtasks) as any[]
    const root = tasks.find((task) => task.creatorType === "user" && task.title === "Coordinate the release")
    assert.ok(root, "the user command is the root work")
    const toSage = tasks.filter((task) => task.parentID === root.id && task.workKind === "turn")
    assert.deepEqual(toSage.map((task) => task.assigneeID), ["b"], "the leader's final text routes a peer turn once")
    assert.equal(toSage[0].turn?.askerID, "a")
    assert.equal(toSage[0].dispatchGroupID, root.dispatchGroupID, "the peer turn shares the root dispatch group")
    const sageTask = toSage[0]
    const toEcho = tasks.filter((task) => task.parentID === sageTask.id && task.workKind === "turn")
    assert.deepEqual(toEcho.map((task) => task.assigneeID), ["c"], "a routed peer's final text routes the next peer")
    const echoTask = toEcho[0]
    assert.equal(echoTask.turn?.askerID, "b")
    assert.equal(echoTask.dispatchGroupID, root.dispatchGroupID, "the next peer turn stays in the same group")
    assert.equal(
      tasks.filter((task) => task.parentID === echoTask.id && task.workKind === "turn").length,
      0,
      "a sender echo and a deeper ancestor mention create no work",
    )
    const refusals = nativeRefusalMessages(state)
    assert.ok(refusals.some((text) => text.includes("$Nova") && text.includes("close a cycle")), "the cycle is refused visibly")
    assert.ok(!refusals.some((text) => text.includes("$Sage")), "the reply-to-sender echo is suppressed without refusal")
    const suppressed = await (handlers as any)["logs.recent"]({ directory, event: "native.route.suppressed", limit: 20 })
    assert.ok(suppressed.entries.some((entry: any) => entry.reason === "reply-to-sender" && entry.agentID === "b"), "the loop guard is observable")
    const refused = await (handlers as any)["logs.recent"]({ directory, event: "native.route.refused", limit: 20 })
    assert.ok(refused.entries.some((entry: any) => entry.reason === "cycle" && entry.agentID === "a"), "the cycle refusal is observable")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket221: an exhausted group refuses a final-text route visibly and creates no work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-221-final-budget-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group_a", { id: "s_group_a" })
  nativeSessions.set("s_group_b", { id: "s_group_b" })
  await seedNativeMentionTeam(ctx, directory, [
    { id: "a", name: "Nova", sessionID: "s_group_a" },
    { id: "b", name: "Sage", sessionID: "s_group_b" },
  ])
  const turnID = nativeTurnID("s_group_a", "m1")
  const groupID = nativeTurnGroupID(turnID)
  const seed = new V2Store(ctx)
  await seed.load()
  await seed.saveDispatchGroup({
    id: groupID,
    workspaceID: "w",
    rootID: groupID,
    continuationIndex: 0,
    maxHops: 8,
    usedHops: 8,
    depthMax: 8,
    commandMaxHops: 24,
    commandUsedHops: 8,
    maxContinuations: 2,
    continuationsUsed: 0,
    createdAt: 1,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group_a",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Answer, then route" } },
    }, { id: "evt_221_budget_enqueue", created: Date.now() }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group_a" }, { id: "evt_221_budget_start", created: Date.now() + 1 }))
    const finalText = "Here is the answer. $Sage please pick it up."
    succeedNativeTurn(emitEvent, { sessionID: "s_group_a", assistantMessageID: "m2", text: finalText, prefix: "evt_221_budget" })

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      return Boolean(nativeTurnIn(state, "replied")) && nativeRefusalMessages(state).length === 1
    })
    const state = await snapshotFor(handlers, directory)
    const turn = nativeTurnIn(state, "replied")
    assert.equal(agentTextMessages(state, turn.id)[0].text, finalText, "the final message still posts")
    assert.equal(routeChildren(state, turn.id).length, 0, "budget exhaustion creates no peer turn")
    const refusal = nativeRefusalMessages(state)[0]!
    assert.match(refusal, /\$Sage/)
    assert.match(refusal, /dispatch group is exhausted \(8\/8 hops\)/)
    assert.equal(Object.values(state.subtasks).filter((task: any) => task.assigneeID === "b").length, 0)
    const refused = await (handlers as any)["logs.recent"]({ directory, event: "native.route.refused", limit: 20 })
    assert.equal(refused.entries.length, 1)
    assert.equal(refused.entries[0].reason, "budget")
    assert.equal(refused.entries[0].layer, "group")
    assert.equal(refused.entries[0].used, 8)
    assert.equal(refused.entries[0].max, 8)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket221: the kill switch alone restores the explicit send_message path", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-221-final-kill-"))

  const { ctx, nativeSessions, emitEvent, tools } = fakeContext()
  nativeSessions.set("s_group_a", { id: "s_group_a" })
  nativeSessions.set("s_group_b", { id: "s_group_b" })
  await seedNativeMentionTeam(ctx, directory, [
    { id: "a", name: "Nova", sessionID: "s_group_a" },
    { id: "b", name: "Sage", sessionID: "s_group_b" },
  ])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on", nativeMentionRouting: false } })
    assert.equal(tools.has("send_message"), true, "the kill switch selects the explicit tool surface")
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group_a",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Answer without routing" } },
    }, { id: "evt_221_kill_enqueue", created: Date.now() }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group_a" }, { id: "evt_221_kill_start", created: Date.now() + 1 }))
    succeedNativeTurn(emitEvent, { sessionID: "s_group_a", assistantMessageID: "m2", text: "Native offline ask to $Sage.", prefix: "evt_221_kill" })

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      const turn = nativeTurnIn(state, "replied")
      return Boolean(turn) && nativeRefusalMessages(state).length === 1
    })
    const blocked = await snapshotFor(handlers, directory)
    const turn = nativeTurnIn(blocked, "replied")
    assert.equal(routeChildren(blocked, turn.id).length, 0, "the kill switch creates no final-text work")
    const refusal = nativeRefusalMessages(blocked)[0]!
    assert.match(refusal, /\$Sage/)
    assert.match(refusal, /native mention routing is off/)
    assert.equal(Object.values(blocked.subtasks).filter((task: any) => task.assigneeID === "b").length, 0)

    const posted = await tools.get("send_message").execute({ kind: "workspace", text: "Explicit ask to $Sage." }, { sessionID: "s_group_a" })
    assert.match(posted.content, /Posted/)
    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      return Object.values(state.subtasks).some((task: any) => task.assigneeID === "b" && task.workKind === "turn")
    })
    const explicit = await snapshotFor(handlers, directory)
    assert.equal(
      Object.values(explicit.subtasks).filter((task: any) => task.assigneeID === "b" && task.workKind === "turn").length,
      1,
      "the explicit send_message path still routes",
    )
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket225: native final text routes the same peer work as the send_message shim", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-225-equivalence-"))
  const { ctx, nativeSessions, emitEvent, tools } = fakeContext()
  nativeSessions.set("s_group_a", { id: "s_group_a" })
  nativeSessions.set("s_group_b", { id: "s_group_b" })
  await seedNativeMentionTeam(ctx, directory, [
    { id: "a", name: "Nova", sessionID: "s_group_a" },
    { id: "b", name: "Sage", sessionID: "s_group_b" },
  ])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  const text = "Ask $Sage to review the release notes."
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on", toolSurface: "legacy" } })

    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group_a",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "First turn" } },
    }, { id: "evt_225_equiv_enqueue_1", created: Date.now() }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group_a" }, { id: "evt_225_equiv_start_1", created: Date.now() + 1 }))
    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "working")))
    const first = nativeTurnIn(await snapshotFor(handlers, directory), "working")
    const posted = await tools.get("send_message").execute({ kind: "workspace", text }, { sessionID: "s_group_a" })
    assert.match(posted.content, /Posted/)
    await waitFor(async () => routeChildren(await snapshotFor(handlers, directory), first.id).length === 1)
    const firstChild = routeChildren(await snapshotFor(handlers, directory), first.id)[0]
    succeedNativeTurn(emitEvent, { sessionID: "s_group_a", assistantMessageID: "m2", text: "Done.", prefix: "evt_225_equiv" })
    await waitFor(async () => nativeTurnIn(await snapshotFor(handlers, directory), "replied") !== undefined)

    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group_a",
      inboxID: "m3",
      item: { type: "user", delivery: "steer", payload: { text: "Second turn" } },
    }, { id: "evt_225_equiv_enqueue_2", created: Date.now() + 10 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group_a" }, { id: "evt_225_equiv_start_2", created: Date.now() + 11 }))
    await waitFor(async () => Object.values((await snapshotFor(handlers, directory)).subtasks).filter((task: any) => task.origin === "native" && task.native?.phase === "working").length === 1)
    const second = Object.values((await snapshotFor(handlers, directory)).subtasks).find((task: any) => task.origin === "native" && task.native?.phase === "working") as any
    succeedNativeTurn(emitEvent, { sessionID: "s_group_a", assistantMessageID: "m4", text, prefix: "evt_225_equiv_final" })
    await waitFor(async () => routeChildren(await snapshotFor(handlers, directory), second.id).length === 1)
    const secondChild = routeChildren(await snapshotFor(handlers, directory), second.id)[0]

    for (const key of ["assigneeID", "workKind", "mode", "instruction", "creatorType", "askerKind", "askerID"]) {
      assert.equal(secondChild[key], firstChild[key], `final text and the shim agree on ${key}`)
    }
    assert.equal(firstChild.parentID, first.id)
    assert.equal(secondChild.parentID, second.id)
    assert.equal(firstChild.dispatchGroupID, first.dispatchGroupID)
    assert.equal(secondChild.dispatchGroupID, second.dispatchGroupID)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket221: a direct conversation never routes an agent final text", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-221-final-direct-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group_a", { id: "s_group_a" })
  nativeSessions.set("s_direct_a", { id: "s_direct_a" })
  nativeSessions.set("s_group_b", { id: "s_group_b" })
  await seedNativeMentionTeam(ctx, directory, [
    { id: "a", name: "Nova", sessionID: "s_group_a", directSessionID: "s_direct_a" },
    { id: "b", name: "Sage", sessionID: "s_group_b" },
  ])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_direct_a",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Keep this private" } },
    }, { id: "evt_221_direct_enqueue", created: Date.now() }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_direct_a" }, { id: "evt_221_direct_start", created: Date.now() + 1 }))
    succeedNativeTurn(emitEvent, { sessionID: "s_direct_a", assistantMessageID: "m2", text: "Privately mentioning $Sage.", prefix: "evt_221_direct" })

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      const turn = nativeTurnIn(state, "replied")
      return Boolean(turn) && (state.messages["dm:a:w"] ?? []).some((message: any) => message.author === "system")
    })
    const state = await snapshotFor(handlers, directory)
    const turn = nativeTurnIn(state, "replied")
    assert.equal(routeChildren(state, turn.id).length, 0, "a direct conversation creates no peer turn")
    assert.equal(state.messages["w"], undefined, "the direct final text never leaks into the workspace channel")
    assert.ok(
      nativeRefusalMessages(state, "dm:a:w").some((text) => text.includes("$Sage") && text.includes("direct conversations stay one-to-one")),
      "the direct conversation explains why the mention did not route",
    )
    const refused = await (handlers as any)["logs.recent"]({ directory, event: "native.route.refused", limit: 20 })
    assert.ok(refused.entries.some((entry: any) => entry.reason === "direct-conversation" && entry.source === "agent-final"))
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket221: a final text identical to a send_message post from the same turn dedupes to one row and one route set", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-221-final-dedupe-"))
  const { ctx, nativeSessions, emitEvent, tools } = fakeContext()
  nativeSessions.set("s_group_a", { id: "s_group_a" })
  nativeSessions.set("s_group_b", { id: "s_group_b" })
  await seedNativeMentionTeam(ctx, directory, [
    { id: "a", name: "Nova", sessionID: "s_group_a" },
    { id: "b", name: "Sage", sessionID: "s_group_b" },
  ])
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on", toolSurface: "legacy" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group_a",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Coordinate the handoff" } },
    }, { id: "evt_221_dedupe_enqueue", created: Date.now() }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group_a" }, { id: "evt_221_dedupe_start", created: Date.now() + 1 }))
    emitEvent(nativeEvent("session.text.started", {
      sessionID: "s_group_a",
      assistantMessageID: "m2",
      ordinal: 0,
    }, { id: "evt_221_dedupe_text_start", created: Date.now() + 2 }))
    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      return Boolean(nativeTurnIn(state, "working"))
    })
    const turn = nativeTurnIn(await snapshotFor(handlers, directory), "working")

    const postText = "Passing the review to $Sage now."
    const posted = await tools.get("send_message").execute({ kind: "workspace", text: postText }, { sessionID: "s_group_a" })
    assert.match(posted.content, /Posted/)
    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      return routeChildren(state, turn.id).length === 1
    })
    const routed = await snapshotFor(handlers, directory)
    const routedChild = routeChildren(routed, turn.id)[0]
    assert.equal(routedChild.assigneeID, "b", "the explicit tool post routes through the native turn")
    assert.equal(routedChild.dispatchGroupID, turn.dispatchGroupID, "the tool post joins the native turn's group")
    const postRow = agentTextMessages(routed, turn.id).find((message: any) => message.text === postText)
    assert.ok(postRow, "the tool post is linked to the native turn")

    emitEvent(nativeEvent("session.text.ended", {
      sessionID: "s_group_a",
      assistantMessageID: "m2",
      ordinal: 0,
      text: postText,
    }, { id: "evt_221_dedupe_text_end", created: Date.now() + 3 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_group_a" }, { id: "evt_221_dedupe_done", created: Date.now() + 4 }))

    await waitFor(async () => Boolean(nativeTurnIn(await snapshotFor(handlers, directory), "replied")))
    const state = await snapshotFor(handlers, directory)
    const settled = nativeTurnIn(state, "replied")
    const rows = (state.messages["w"] ?? []).filter((message: any) => message.author === "agent" && message.text === postText)
    assert.equal(rows.length, 1, "the tool post and final text are one transcript row")
    assert.equal(rows[0].id, settled.native?.resultMessageID, "the finalized native row is the remaining row")
    assert.equal(routeChildren(state, settled.id).length, 1, "the dedupe keeps one route set")
    assert.equal(
      Object.values(state.subtasks).filter((task: any) => task.assigneeID === "b" && task.workKind === "turn").length,
      1,
      "the matching final text creates no second peer turn",
    )
    const deduped = await (handlers as any)["logs.recent"]({ directory, event: "native.route.deduped", limit: 20 })
    assert.equal(deduped.entries.length, 1)
    assert.equal(deduped.entries[0].turnID, settled.id)
    assert.equal(deduped.entries[0].recipients, 1)
    const planned = await (handlers as any)["logs.recent"]({ directory, event: "native.route.planned", limit: 20 })
    assert.equal(planned.entries.filter((entry: any) => entry.turnID === settled.id).length, 0, "the deduped final text is not routed again")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket221: task-run routing uses the original final text, not the display-normalized reply", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-221-final-original-"))
  const { ctx, nativeSessions } = fakeContext()
  nativeSessions.set("s_group_a", { id: "s_group_a" })
  nativeSessions.set("s_group_b", { id: "s_group_b" })
  await seedNativeMentionTeam(ctx, directory, [
    { id: "a", name: "Nova", sessionID: "s_group_a" },
    { id: "b", name: "Sage", sessionID: "s_group_b" },
  ])
  const leaderReplies = ["@Sage please review the draft.", "$Sage please review the draft."]
  ;(ctx.session as any).context = async ({ sessionID }: any) => ({
    data: [{
      type: "assistant",
      time: { created: Date.now() },
      content: [{ type: "text", text: sessionID === "s_group_a" ? (leaderReplies.shift() ?? "Done.") : "OK" }],
    }],
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: "w", text: "First draft" } })
    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      return (state.messages["w"] ?? []).some((message: any) => message.author === "agent" && message.text === "$Sage please review the draft.")
    })
    const first = await snapshotFor(handlers, directory)
    assert.equal(
      Object.values(first.subtasks).filter((task: any) => task.assigneeID === "b" && task.workKind === "turn").length,
      0,
      "the original @ mention is a file reference and creates no work",
    )
    assert.ok(
      (first.messages["w"] ?? []).some((message: any) => message.author === "system" && String(message.text).includes("Chat mentions do not assign work")),
      "the display normalization still explains itself",
    )

    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: "w", text: "Second draft" } })
    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      return Object.values(state.subtasks).some((task: any) => task.assigneeID === "b" && task.workKind === "turn")
    })
    const second = await snapshotFor(handlers, directory)
    const routed = Object.values(second.subtasks).find((task: any) => task.assigneeID === "b" && task.workKind === "turn") as any
    assert.ok(routed, "the original $ mention routes")
    assert.equal(routed.instruction, "$Sage please review the draft.", "the original text is the routed instruction")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

// ---- Ticket #218: native reconciliation and support visibility ----

function nativeTurnsIn(state: any): any[] {
  return Object.values(state.subtasks).filter((task: any) => task.origin === "native") as any[]
}

test("ticket218: service start reconciles a bound session once and recovers a missing turn and rows", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-218-start-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-218-start-home-"))
  const { ctx, nativeSessions } = fakeContext()
  nativeSessions.set("s_direct", { id: "s_direct" })
  await seedNativeDirect(ctx, directory, home)
  await seedNativeFirstOn(ctx)
  let contextCalls = 0
  ;(ctx.session as any).context = async () => {
    contextCalls += 1
    return {
      data: [
        { id: "m1", type: "user", content: [{ type: "text", text: "Recovered question" }], time: { created: 100 } },
        { id: "m2", type: "assistant", content: [{ type: "text", text: "Recovered answer" }], time: { created: 101 } },
        { type: "idle", time: { created: 102 } },
      ],
    }
  }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    const state = await snapshotFor(service.handlers(), directory)
    const turns = nativeTurnsIn(state)
    assert.equal(turns.length, 1, "one transcript turn creates one durable turn")
    const turn = turns[0]
    assert.equal(turn.native.phase, "replied")
    assert.equal(turn.state, "replied")
    assert.equal(turn.native.inboxID, "m1")
    assert.deepEqual(turn.native.assistantMessageIDs, ["m2"])
    const rows = state.messages["dm:a:w"] ?? []
    const user = rows.find((message: any) => message.author === "user")
    const agent = rows.find((message: any) => message.author === "agent")
    assert.equal(user.id, nativeUserMessageID("m1"))
    assert.equal(user.text, "Recovered question")
    assert.equal(agent.text, "Recovered answer")
    assert.equal(agent.streaming, false)
    assert.equal(agent.native.assistantMessageID, "m2")
    assert.equal(turn.resultMessageID, agent.id)
    assert.equal(deriveWorkStatus(turn, Date.now()), "replied")
    assert.equal(contextCalls, 1, "a bound session reconciles once on start")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket218: a reconnect reconciles once, recovers a gap, and never polls in steady state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-218-reconnect-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-218-reconnect-home-"))
  const { ctx, nativeSessions } = fakeContext()
  nativeSessions.set("s_direct", { id: "s_direct" })
  await seedNativeDirect(ctx, directory, home)
  await seedNativeFirstOn(ctx)
  let contextCalls = 0
  let contextData: any[] = []
  ;(ctx.session as any).context = async () => {
    contextCalls += 1
    return { data: contextData }
  }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    assert.equal(contextCalls, 1, "start reads the bound session once")
    await new Promise((resolve) => setTimeout(resolve, 25))
    contextData = [
      { id: "m7", type: "user", content: [{ type: "text", text: "Missed question" }], time: { created: 200 } },
      { id: "m8", type: "assistant", content: [{ type: "text", text: "Missed answer" }], time: { created: 201 } },
      { type: "idle", time: { created: 202 } },
    ]
    // A plugin re-attach is the reconnect path; it reconciles the location's
    // bound session once without reading on a timer.
    service.trackLocation({}, process.cwd())
    // Reconnect reconciliation is deliberately off the event path; give the
    // async pass its bounded turn before asserting the durable result.
    await new Promise((resolve) => setTimeout(resolve, 50))
    await waitFor(async () => nativeTurnsIn(await snapshotFor(handlers, directory)).length === 1)
    const recovered = await snapshotFor(handlers, directory)
    const turn = nativeTurnsIn(recovered)[0]
    assert.equal(contextCalls, 2, "a reconnect reads the session once")
    assert.equal(turn.native.phase, "replied")
    assert.equal(recovered.messages["dm:a:w"].find((message: any) => message.author === "user").text, "Missed question")
    assert.equal(recovered.messages["dm:a:w"].find((message: any) => message.author === "agent").text, "Missed answer")

    // A repeated reconnect renders the same context to the same identities.
    await service.handleHostEvent(nativeEvent("session.created", { sessionID: "s_direct" }, { id: "evt_218_reconnect_again", created: 301 }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    await waitFor(async () => contextCalls === 3)
    const repeated = await snapshotFor(handlers, directory)
    assert.equal(nativeTurnsIn(repeated).length, 1, "duplicate reconciliation never duplicates a turn")
    assert.equal(repeated.messages["dm:a:w"].length, 2, "duplicate reconciliation never duplicates rows")

    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(contextCalls, 3, "the heartbeat and steady state never poll the native transcript")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket218: reconciliation repairs a terminal turn whose result row is missing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-218-result-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-218-result-home-"))
  const { ctx, nativeSessions } = fakeContext()
  nativeSessions.set("s_direct", { id: "s_direct" })
  await seedNativeDirect(ctx, directory, home)
  await seedNativeFirstOn(ctx)
  const seed = new V2Store(ctx)
  await seed.load()
  const turnID = nativeTurnID("s_direct", "m10")
  const base = Date.now() - 1_000
  await seed.saveSubtask({
    id: turnID,
    workspaceID: "dm:a:w",
    creatorType: "user",
    assigneeID: "a",
    title: "Native turn",
    instruction: "Repair me",
    mode: "research",
    state: "replied",
    stage: "initial",
    outcome: "succeeded",
    interrupted: false,
    awaitingChildren: false,
    attempts: 0,
    createdAt: base,
    repliedAt: base + 10,
    finishedAt: base + 10,
    workKind: "turn",
    origin: "native",
    adopted: true,
    conversationID: "dm:a:w",
    dispatchGroupID: nativeTurnGroupID(turnID),
    native: { sessionID: "s_direct", inboxID: "m10", assistantMessageIDs: ["m11"], phase: "replied" },
  })
  ;(ctx.session as any).context = async () => ({
    data: [
      { id: "m10", type: "user", content: [{ type: "text", text: "Repair me" }], time: { created: base } },
      { id: "m11", type: "assistant", content: [{ type: "text", text: "Exact repaired answer" }], time: { created: base + 5 } },
      { type: "idle", time: { created: base + 10 } },
    ],
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    const state = await snapshotFor(service.handlers(), directory)
    const turn = state.subtasks[turnID]
    const rows = state.messages["dm:a:w"] ?? []
    assert.equal(nativeTurnsIn(state).length, 1, "the terminal turn is not duplicated")
    const result = rows.find((message: any) => message.id === nativeAssistantMessageID(turnID))
    assert.ok(result, "the missing result row is restored")
    assert.equal(result.text, "Exact repaired answer")
    assert.equal(result.streaming, false)
    assert.equal(turn.resultMessageID, result.id)
    assert.equal(turn.native.resultMessageID, result.id)
    assert.equal(turn.native.phase, "replied")
    assert.equal(rows.find((message: any) => message.author === "user").id, nativeUserMessageID("m10"), "a missing user row is recovered too")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket218: a working turn is interrupted only after the transcript confirms no answer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-218-noanswer-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-218-noanswer-home-"))
  const { ctx, nativeSessions } = fakeContext()
  nativeSessions.set("s_direct", { id: "s_direct" })
  await seedNativeDirect(ctx, directory, home)
  await seedNativeFirstOn(ctx)
  const seed = new V2Store(ctx)
  await seed.load()
  const confirmedID = nativeTurnID("s_direct", "m20")
  const unconfirmedID = nativeTurnID("s_direct", "m30")
  for (const [taskID, inboxID, createdAt] of [[confirmedID, "m20", 500], [unconfirmedID, "m30", 510]] as const) {
    await seed.saveSubtask({
      id: taskID,
      workspaceID: "dm:a:w",
      creatorType: "user",
      assigneeID: "a",
      title: "Native turn",
      instruction: "Waiting",
      mode: "research",
      state: "working",
      stage: "initial",
      outcome: "pending",
      interrupted: false,
      awaitingChildren: false,
      attempts: 0,
      createdAt,
      workKind: "turn",
      origin: "native",
      adopted: true,
      conversationID: "dm:a:w",
      dispatchGroupID: nativeTurnGroupID(taskID),
      native: { sessionID: "s_direct", inboxID, assistantMessageIDs: [], phase: "working", startedAt: createdAt },
    })
  }
  ;(ctx.session as any).context = async () => ({
    data: [
      { id: "m20", type: "user", content: [{ type: "text", text: "Settled with no answer" }], time: { created: 500 } },
      { type: "idle", time: { created: 501 } },
      { id: "m30", type: "user", content: [{ type: "text", text: "Still running" }], time: { created: 510 } },
    ],
  })
  let contextCalls = 0
  const contextRead = (ctx.session as any).context as () => Promise<any>
  ;(ctx.session as any).context = async () => {
    contextCalls += 1
    return contextRead()
  }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    const state = await snapshotFor(service.handlers(), directory)
    const confirmed = state.subtasks[confirmedID]
    const unconfirmed = state.subtasks[unconfirmedID]
    assert.equal(confirmed.native.phase, "interrupted", "the idle marker confirms the answerless turn")
    assert.equal(confirmed.interrupted, true)
    assert.equal(deriveWorkStatus(confirmed, Date.now()), "needs_you")
    assert.equal(unconfirmed.native.phase, "working", "no terminal evidence leaves the turn alone")
    assert.equal(unconfirmed.interrupted, false)
    assert.equal(contextCalls, 1, "one transcript read serves the whole session")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket218: late text for a settled turn cannot attach to the next active turn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-218-late-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  await seedNativeWorkspace(ctx, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "First question" } },
    }, { id: "evt_218_late_enqueue_1", created: 100 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group" }, { id: "evt_218_late_start_1", created: 101 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_group", assistantMessageID: "m2", ordinal: 0 }, { id: "evt_218_late_text_1", created: 102 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_group", assistantMessageID: "m2", ordinal: 0, text: "First answer" }, { id: "evt_218_late_end_1", created: 103 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_group" }, { id: "evt_218_late_done_1", created: 104 }))
    await waitFor(async () => nativeTurnIn(await snapshotFor(handlers, directory), "replied") !== undefined)

    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "m3",
      item: { type: "user", delivery: "steer", payload: { text: "Second question" } },
    }, { id: "evt_218_late_enqueue_2", created: 105 }))
    // The second turn is visibly active before the late text for the first
    // turn arrives. Identity must win over the active marker.
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_group", assistantMessageID: "m4", ordinal: 0 }, { id: "evt_218_late_text_2", created: 106 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_group", assistantMessageID: "m4", ordinal: 0, text: "Second answer" }, { id: "evt_218_late_end_2", created: 107 }))
    emitEvent(nativeEvent("session.text.delta", { sessionID: "s_group", assistantMessageID: "m2", ordinal: 0, delta: " late" }, { id: "evt_218_late_delta", created: 108 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group" }, { id: "evt_218_late_start_2", created: 109 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_group" }, { id: "evt_218_late_done_2", created: 110 }))

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      return nativeTurnsIn(state).filter((task) => task.native.phase === "replied").length === 2
    })
    const state = await snapshotFor(handlers, directory)
    const turns = nativeTurnsIn(state)
    const first = turns.find((task) => task.native.inboxID === "m1")!
    const second = turns.find((task) => task.native.inboxID === "m3")!
    assert.equal(state.messages["w"].find((message: any) => message.id === first.resultMessageID).text, "First answer")
    assert.equal(
      state.messages["w"].find((message: any) => message.id === second.resultMessageID).text,
      "Second answer",
      "a late delta never joins the next turn's final text",
    )
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket223: a missed enqueue with a file recovers the prompt together with its attachment chip", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-223-recover-file-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-223-recover-file-home-"))
  const { ctx, nativeSessions } = fakeContext()
  nativeSessions.set("s_direct", { id: "s_direct" })
  await seedNativeDirect(ctx, directory, home)
  await seedNativeFirstOn(ctx)
  ;(ctx.session as any).context = async () => ({
    data: [
      {
        id: "m1",
        type: "user",
        content: [{ type: "text", text: "Review the notes" }],
        files: [{ name: "notes.md", mime: "text/markdown", dataLength: 42 }],
        time: { created: 1 },
      },
      { id: "m2", type: "assistant", content: [{ type: "text", text: "Reviewed." }], time: { created: 2 } },
      { type: "idle", time: { created: 3 } },
    ],
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      return (state.messages["dm:a:w"] ?? []).some((message: any) => message.native?.inboxID === "m1" && message.author === "user")
    })
    const state = await snapshotFor(handlers, directory)
    const user = (state.messages["dm:a:w"] ?? []).find((message: any) => message.native?.inboxID === "m1" && message.author === "user")
    assert.equal(user.text, "Review the notes")
    const chip = user.attachments?.[0]
    assert.ok(chip, "the recovered user row keeps the prompt file as a chip")
    assert.deepEqual({ name: chip.name, mime: chip.mime, size: chip.size, kind: chip.kind }, {
      name: "notes.md",
      mime: "text/markdown",
      size: 42,
      kind: "file",
    })
    const turn = Object.values(state.subtasks).find((task: any) => task.native?.inboxID === "m1") as any
    assert.ok(turn, "the recovered turn exists")
    assert.equal(turn.attachments?.[0]?.name, "notes.md", "the recovered Work row keeps the same attachment metadata")
    assert.equal(JSON.stringify(state).includes("dataLength"), false, "the chip carries size, never the host file payload")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket218: native reconciliation logs ids and reason codes without content or paths", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-218-logs-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-218-logs-home-"))
  const { ctx, nativeSessions } = fakeContext()
  nativeSessions.set("s_direct", { id: "s_direct" })
  await seedNativeDirect(ctx, directory, home)
  await seedNativeFirstOn(ctx)
  ;(ctx.session as any).context = async () => ({
    data: [
      { id: "m1", type: "user", content: [{ type: "text", text: "PRIVATE-NATIVE-QUESTION-218" }], time: { created: 600 } },
      { id: "m2", type: "assistant", content: [{ type: "text", text: "PRIVATE-NATIVE-ANSWER-218" }], time: { created: 601 } },
      { type: "idle", time: { created: 602 } },
    ],
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    const handlers = service.handlers() as any
    const nativeLogs = await handlers["logs.recent"]({ directory, cat: "native", limit: 500 })
    const taskLogs = await handlers["logs.recent"]({ directory, cat: "task", limit: 500 })
    const serialized = JSON.stringify([...nativeLogs.entries, ...taskLogs.entries])
    assert.ok(nativeLogs.entries.length > 0, "reconciliation emits native support logs")
    assert.equal(serialized.includes("PRIVATE-NATIVE-QUESTION-218"), false, "logs never carry user content")
    assert.equal(serialized.includes("PRIVATE-NATIVE-ANSWER-218"), false, "logs never carry assistant content")
    assert.equal(serialized.includes(directory), false, "logs never carry a location path")
    assert.ok(nativeLogs.entries.some((entry: any) => entry.turnID && entry.sessionID), "native logs carry turn and session ids")
    assert.ok(nativeLogs.entries.some((entry: any) => entry.inboxID === "m1"), "native logs carry the inbox id")
    assert.ok(
      nativeLogs.entries.some((entry: any) => entry.event === "native.turn.recovered" && entry.reason === "missing-enqueue"),
      "the recovery log carries a reason code",
    )
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("ticket218: native sync reports degraded on a failed read and returns to live after a repair", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-218-sync-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-218-sync-home-"))
  const { ctx, nativeSessions } = fakeContext()
  nativeSessions.set("s_direct", { id: "s_direct" })
  await seedNativeDirect(ctx, directory, home)
  await seedNativeFirstOn(ctx)
  ;(ctx.session as any).context = async () => {
    throw Object.assign(new Error("PRIVATE-HOST-ERROR-218"), { code: "context_unavailable" })
  }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const degraded = await handlers.snapshot({ directory })
    assert.equal(degraded.nativeSync?.state, "degraded")
    assert.equal((await handlers.revision({ directory })).nativeSync?.state, "degraded")
    const logs = await (handlers as any)["logs.recent"]({ directory, cat: "native", limit: 200 })
    const sync = logs.entries.find((entry: any) => entry.event === "native.sync" && entry.state === "degraded")
    assert.equal(sync?.reason, "context-read")
    assert.equal(JSON.stringify(logs.entries).includes("PRIVATE-HOST-ERROR-218"), false, "a host error message never enters a log")

    ;(ctx.session as any).context = async () => ({ data: [] })
    await service.handleHostEvent(nativeEvent("session.created", { sessionID: "s_direct" }, { id: "evt_218_sync_repair", created: 700 }))
    await waitFor(async () => (await handlers.revision({ directory })).nativeSync?.state === "live")
    assert.equal((await handlers.snapshot({ directory })).nativeSync?.state, "live", "a successful read clears the degraded label")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

// ---- Ticket #224: adoption during an in-flight reconcile -----------------

test("ticket224: adoption during an in-flight reconcile recovers into the new conversation only", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-224-adopt-race-"))
  const { ctx, nativeSessions } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group", location: { directory }, time: { created: 1, updated: 1 } })
  nativeSessions.set("s_adopted", { id: "s_adopted", location: { directory }, time: { created: 2, updated: 2 } })
  await seedNativeWorkspace(ctx, directory)
  await seedNativeFirstOn(ctx)

  let releaseRead!: () => void
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve })
  let readStarted!: () => void
  const started = new Promise<void>((resolve) => { readStarted = resolve })
  let adoptedReads = 0
  ;(ctx.session as any).context = async ({ sessionID }: any) => {
    if (sessionID !== "s_adopted") return { data: [] }
    adoptedReads++
    if (adoptedReads === 1) {
      readStarted()
      await readGate
    }
    return {
      data: [
        { id: "m_race", type: "user", content: [{ type: "text", text: "Recovered race prompt" }], time: { created: 10 } },
        { id: "a_race", type: "assistant", content: [{ type: "text", text: "Recovered race answer" }], time: { created: 11 } },
        { type: "idle", time: { created: 12 } },
      ],
    }
  }

  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    // Bind the session to the group first, then let a start-style reconcile
    // hang inside its transcript read while adoption moves it to direct.
    const store = (service as any).store as V2Store
    await store.saveBinding({
      workspaceID: "w",
      agentID: "a",
      sessionID: "s_adopted",
      kind: "workspace",
      directory,
      agentVersion: 1,
      updatedAt: 2,
    })
    await service.handleHostEvent(nativeEvent("session.created", { sessionID: "s_adopted" }, { id: "evt_224_race_created", created: 20 }))
    await started

    const adoption = handlers.invoke({
      directory,
      action: "session.adopt",
      payload: { agentID: "a", workspaceID: "w", conversation: "direct", sessionID: "s_adopted", reassign: true },
    })
    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      return Object.values(state.bindings).some((binding: any) => binding.sessionID === "s_adopted" && binding.kind === "direct")
    })
    releaseRead()
    const result = await adoption
    assert.equal(result.ok, true, JSON.stringify(result.error))
    assert.equal(result.result.adopted, true)

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      return (state.messages["dm:a:w"] ?? []).some((message: any) => message.native?.inboxID === "m_race")
    })
    const state = await snapshotFor(handlers, directory)
    const directTurn = Object.values(state.subtasks).find((task: any) => task.native?.inboxID === "m_race") as any
    assert.ok(directTurn, "the adopted conversation recovers the missed turn")
    assert.equal(directTurn.conversationID, "dm:a:w")
    assert.equal(directTurn.workspaceID, "dm:a:w")
    assert.equal(
      (state.messages["w"] ?? []).some((message: any) => message.native?.inboxID === "m_race"),
      false,
      "the old group conversation receives no post-adoption recovery row",
    )
    assert.equal(
      (state.messages["dm:a:w"] ?? []).some((message: any) => message.author === "agent" && message.text === "Recovered race answer"),
      true,
      "the new conversation recovers the final answer",
    )
  } finally {
    releaseRead()
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

// ---- Ticket #229: immediate prompt after adoption ------------------------

test("ticket229: a prompt sent immediately after adoption settles as its own native turn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-229-adoption-"))
  const { ctx, nativeSessions, synthetic, emitEvent } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group", location: { directory }, time: { created: 1, updated: 1 } })
  nativeSessions.set("s_adopted", { id: "s_adopted", location: { directory }, time: { created: 2, updated: 2 } })
  await seedNativeWorkspace(ctx, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    const adopted = await handlers.invoke({
      directory,
      action: "session.adopt",
      payload: { agentID: "a", workspaceID: "w", conversation: "workspace", sessionID: "s_adopted" },
    })
    assert.equal(adopted.ok, true)
    assert.equal(adopted.result.adopted, true)
    assert.equal(adopted.result.headsUp, true)
    assert.equal(synthetic.length, 1, "adoption writes the synthetic heads-up")

    // Measured host order for an immediate prompt: the synthetic heads-up
    // starts one execution, the prompt is enqueued while it runs and is
    // delivered into the same execution. That execution produces two assistant
    // messages and one terminal event.
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_adopted",
      inboxID: "m_headsup",
      item: { type: "synthetic", delivery: "steer", payload: { text: "Ensemble: this session now serves the group chat." } },
    }, { id: "evt_229_headsup_enqueue", created: 1000 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_adopted" }, { id: "evt_229_exec_start", created: 1001 }))
    emitEvent(nativeEvent("session.inbox.delivered", { sessionID: "s_adopted", inboxID: "m_headsup" }, { id: "evt_229_headsup_delivered", created: 1002 }))
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_adopted",
      inboxID: "m_prompt",
      item: { type: "user", delivery: "steer", payload: { text: "Immediate prompt" } },
    }, { id: "evt_229_prompt_enqueue", created: 1003 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_adopted", assistantMessageID: "a_headsup", ordinal: 0 }, { id: "evt_229_headsup_text", created: 1004 }))
    emitEvent(nativeEvent("session.text.delta", { sessionID: "s_adopted", assistantMessageID: "a_headsup", ordinal: 0, delta: "Heads" }, { id: "evt_229_headsup_delta", created: 1005 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_adopted", assistantMessageID: "a_headsup", ordinal: 0, text: "Heads-up answer." }, { id: "evt_229_headsup_end", created: 1006 }))
    emitEvent(nativeEvent("session.inbox.delivered", { sessionID: "s_adopted", inboxID: "m_prompt" }, { id: "evt_229_prompt_delivered", created: 1007 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_adopted", assistantMessageID: "a_prompt", ordinal: 0 }, { id: "evt_229_prompt_text", created: 1008 }))
    emitEvent(nativeEvent("session.text.delta", { sessionID: "s_adopted", assistantMessageID: "a_prompt", ordinal: 0, delta: "Prompt" }, { id: "evt_229_prompt_delta", created: 1009 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_adopted", assistantMessageID: "a_prompt", ordinal: 0, text: "Prompt answer." }, { id: "evt_229_prompt_end", created: 1010 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_adopted" }, { id: "evt_229_exec_done", created: 1011 }))

    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      const prompt = Object.values(state.subtasks).find(
        (task: any) => task.origin === "native" && task.native?.inboxID === "m_prompt",
      ) as any
      return prompt?.native?.phase === "replied" && Boolean(prompt.resultMessageID)
    })
    const state = await snapshotFor(handlers, directory)
    const turns = Object.values(state.subtasks).filter(
      (task: any) => task.origin === "native" && task.native?.sessionID === "s_adopted",
    ) as any[]
    const headsUp = turns.find((task) => task.native.inboxID === "m_headsup")!
    const prompt = turns.find((task) => task.native.inboxID === "m_prompt")!
    assert.equal(headsUp.native.phase, "replied")
    assert.equal(prompt.native.phase, "replied", "the immediate prompt never remains queued")
    assert.equal(prompt.native.assistantMessageIDs.length, 1)
    assert.equal(prompt.native.assistantMessageIDs[0], "a_prompt")
    assert.equal(headsUp.native.assistantMessageIDs.length, 1, "the heads-up keeps only its own answer")
    assert.equal(headsUp.native.assistantMessageIDs[0], "a_headsup")

    const rows = state.messages["w"] ?? []
    const userRows = rows.filter((message: any) => message.author === "user")
    const agentRows = rows.filter((message: any) => message.author === "agent")
    assert.equal(userRows.length, 1, "one durable user row for the prompt")
    assert.equal(userRows[0].taskID, prompt.id)
    assert.equal(agentRows.length, 2, "each turn owns one exact agent row")
    const headsUpRow = rows.find((message: any) => message.id === headsUp.resultMessageID)
    const promptRow = rows.find((message: any) => message.id === prompt.resultMessageID)
    assert.equal(headsUpRow?.text, "Heads-up answer.")
    assert.equal(promptRow?.text, "Prompt answer.")
    assert.equal(headsUpRow?.taskID, headsUp.id)
    assert.equal(promptRow?.taskID, prompt.id)
    assert.notEqual(headsUpRow?.id, promptRow?.id)
    assert.equal(deriveWorkStatus(prompt, Date.now()), "replied")
    assert.equal(deriveWorkStatus(headsUp, Date.now()), "replied")
    assert.ok(
      projectVisibleWork(state, (prompt.finishedAt ?? Date.now()) + 500)[prompt.id],
      "the settled prompt is a visible Work card",
    )
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket228: a native prompt file with only inline data gets a positive bounded chip size", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-228-direct-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-228-home-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_direct", { id: "s_direct" })
  await seedNativeDirect(ctx, directory, home)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    const content = "ticket 228 native attachment fixture"
    const data = Buffer.from(content).toString("base64")
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_direct",
      inboxID: "m228",
      item: {
        type: "user",
        delivery: "steer",
        payload: {
          text: "Review the fixture",
          files: [{ name: "fixture.txt", mime: "text/plain", description: "fixture", data }],
        },
      },
    }, { id: "evt_228_enqueue", created: 200 }))

    await waitFor(async () => ((await snapshotFor(handlers, directory)).messages["dm:a:w"] ?? []).length === 1)
    const state = await snapshotFor(handlers, directory)
    const user = state.messages["dm:a:w"][0]
    const chip = user.attachments?.[0]
    assert.ok(chip, "the durable user row carries the native prompt attachment")
    assert.deepEqual({ name: chip.name, mime: chip.mime, kind: chip.kind }, {
      name: "fixture.txt",
      mime: "text/plain",
      kind: "file",
    })
    assert.ok(chip.size > 0, "the chip size is derived from the inline data payload")
    assert.equal(chip.size, Buffer.byteLength(content))
    const serialized = JSON.stringify(user)
    assert.equal(serialized.includes(data), false, "the durable row never carries the base64 payload")
    assert.equal(serialized.includes(content), false, "the durable row never carries file bytes")
    assert.equal(serialized.includes(".ensemble/attachments"), false)
    assert.equal(serialized.includes(directory), false, "the durable row never carries a source or store path")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test("privacy: the per-agent native mirror defaults on, stops native rows, and re-enables", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-privacy-direct-"))
  const home = mkdtempSync(join(tmpdir(), "ensemble-privacy-home-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_direct", { id: "s_direct" })
  await seedNativeDirect(ctx, directory, home)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers() as any
  const channel = "dm:a:w"
  const answer = (prefix: string) => {
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_direct" }, { id: `evt_${prefix}_start`, created: 2 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_direct", assistantMessageID: `a_${prefix}`, ordinal: 0 }, { id: `evt_${prefix}_text`, created: 3 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_direct", assistantMessageID: `a_${prefix}`, ordinal: 0, text: `answer ${prefix}` }, { id: `evt_${prefix}_end`, created: 4 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_direct" }, { id: `evt_${prefix}_done`, created: 5 }))
  }
  const prompt = (prefix: string) => emitEvent(nativeEvent("session.inbox.enqueued", {
    sessionID: "s_direct",
    inboxID: `m_${prefix}`,
    item: { type: "user", delivery: "steer", payload: { text: `native ${prefix}` } },
  }, { id: `evt_${prefix}_enqueue`, created: 1 }))
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    // No setting at all: the default mirrors the native turn.
    prompt("default")
    answer("default")
    await waitFor(async () => ((await snapshotFor(handlers, directory)).messages[channel] ?? []).length === 2)

    const off = await handlers.invoke({ directory, action: "agent.update", payload: { id: "a", nativeMirror: false } })
    assert.equal(off.result.nativeMirror, false)
    prompt("private")
    answer("private")

    // Managed service work stays visible: the composer row already exists and
    // its final answer still mirrors while the native session is private.
    const sent = (await handlers.invoke({ directory, action: "chat.send", payload: { agentID: "a", workspaceID: "w", text: "Managed request" } })).result
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_direct",
      inboxID: "m_managed",
      item: {
        type: "user",
        delivery: "queue",
        payload: {
          text: "Managed request",
          metadata: { "ensemble.internal": true, "ensemble.messageID": sent.id },
        },
      },
    }, { id: "evt_managed_enqueue", created: 10 }))
    answer("managed")
    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      return (state.messages[channel] ?? []).some((message: any) => message.author === "agent" && message.text === "answer managed")
    })

    const on = await handlers.invoke({ directory, action: "agent.update", payload: { id: "a", nativeMirror: true } })
    assert.equal(on.result.nativeMirror, true)
    prompt("resumed")
    answer("resumed")
    await waitFor(async () => {
      const state = await snapshotFor(handlers, directory)
      return (state.messages[channel] ?? []).some((message: any) => message.author === "user" && message.text === "native resumed")
    })
    const final = await snapshotFor(handlers, directory)
    assert.equal(
      (final.messages[channel] ?? []).some((message: any) => message.text === "native private" || message.text === "answer private"),
      false,
      "a private native prompt adds no user or final row",
    )
    assert.equal(
      Object.values(final.subtasks).filter((task: any) => task.native?.inboxID === "m_private").length,
      0,
      "a private prompt creates no Work row",
    )
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

// ---- Ticket #230: nativeFirst shadow ingestion and comparison ----

test("ticket230: shadow ingests invisibly, publishes nothing, and records a content-free comparison", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-230-shadow-"))
  const { ctx, nativeSessions, emitted, emitEvent } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  await seedNativeWorkspace(ctx, directory)
  ;(ctx.session as any).context = async ({ sessionID }: any) => ({
    data: sessionID === "s_group"
      ? [
          { id: "m1", type: "user", content: [{ type: "text", text: "Shadow fixture" }], time: { created: 1 } },
          { id: "m2", type: "assistant", content: [{ type: "text", text: "Shadow final answer." }], time: { created: 2 } },
          { id: "m3", type: "idle" },
        ]
      : [],
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  const diagnostic = async () => service.handlers().diagnostic({ directory })
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "shadow" } })
    const emittedBefore = emitted.length

    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "m1",
      item: { type: "user", delivery: "steer", payload: { text: "Shadow fixture" } },
    }, { id: "evt_230_enqueue", created: 100 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group" }, { id: "evt_230_start", created: 101 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_group", assistantMessageID: "m2", ordinal: 0 }, { id: "evt_230_text", created: 102 }))
    emitEvent(nativeEvent("session.text.delta", { sessionID: "s_group", assistantMessageID: "m2", ordinal: 0, delta: "Shadow final" }, { id: "evt_230_delta", created: 103 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_group", assistantMessageID: "m2", ordinal: 0, text: "Shadow final answer." }, { id: "evt_230_ended", created: 104 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_group" }, { id: "evt_230_done", created: 105 }))

    await waitFor(async () => (await diagnostic()).native.shadow.comparisons === 1)
    const diag = await diagnostic()
    const row = diag.native.shadow.last[0]
    assert.equal(diag.native.shadow.activeTurns, 0, "the shadow turn is cleared at settle")
    assert.equal(diag.native.shadow.activeSessions, 0, "the shadow session is cleared at settle")
    assert.equal(row.sessionID, "s_group")
    assert.equal(row.inboxID, "m1")
    assert.equal(row.conversationID, "w")
    assert.equal(row.channelKind, "workspace")
    assert.equal(row.phase, "replied")
    assert.equal(row.expectedPhase, "replied")
    assert.equal(row.phaseMatch, true)
    assert.equal(row.textLength, "Shadow final answer.".length)
    assert.match(row.textDigest, /^[a-f0-9]{32}$/)
    assert.equal(row.visibleTextLength, "Shadow final answer.".length)
    assert.equal(row.visibleTextDigest, row.textDigest)
    assert.equal(row.textMatch, true)
    assert.equal(row.visibleHasTurn, false)
    assert.equal(row.plannedRoutes, 0)
    assert.equal(row.visibleRoutes, 0)
    assert.equal(row.routingMatch, true)
    assert.equal(JSON.stringify(diag.native.shadow.last).includes("Shadow final answer."), false, "comparison rows carry no content")

    const state = await snapshotFor(handlers, directory)
    assert.equal(state.messages["w"], undefined, "shadow writes no visible message")
    assert.equal(Object.keys(state.subtasks).length, 0, "shadow creates no visible turn")
    const newEvents = emitted.slice(emittedBefore)
    const entityChanges = newEvents
      .filter((event) => event.name === "patches")
      .flatMap((event) => Array.isArray(event.data?.entries) ? event.data.entries : [])
    assert.equal(entityChanges.length, 0, "shadow publishes no durable entity patches")
    assert.equal(newEvents.some((event) => event.name === "stream"), false, "shadow publishes no stream frames")

    const logs = await service.handlers()["logs.recent"]({ directory, event: "native.shadow.compare", limit: 20 })
    const entry = logs.entries.find((candidate: any) => candidate.inboxID === "m1") as any
    assert.ok(entry, "the comparison is logged")
    assert.equal(entry.cat, "native")
    assert.equal(entry.phase, "replied")
    assert.equal(entry.textLength, "Shadow final answer.".length)
    assert.equal(typeof entry.text, "undefined")
    assert.equal(JSON.stringify(entry).includes("Shadow final answer."), false)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket230: off does nothing, shadow compares invisibly, and on still cuts over", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-230-modes-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  await seedNativeWorkspace(ctx, directory)
  ;(ctx.session as any).context = async () => ({
    data: [
      { id: "m20", type: "user", content: [{ type: "text", text: "Modes" }], time: { created: 1 } },
      { id: "m21", type: "assistant", content: [{ type: "text", text: "Mode answer." }], time: { created: 2 } },
      { id: "m22", type: "idle" },
    ],
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  const diagnostic = async () => service.handlers().diagnostic({ directory })
  const emitTurn = (n: number) => {
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: `m${n}`,
      item: { type: "user", delivery: "steer", payload: { text: `Modes ${n}` } },
    }, { id: `evt_230_modes_enqueue_${n}`, created: n * 10 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group" }, { id: `evt_230_modes_start_${n}`, created: n * 10 + 1 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_group", assistantMessageID: `a${n}`, ordinal: 0 }, { id: `evt_230_modes_text_${n}`, created: n * 10 + 2 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_group", assistantMessageID: `a${n}`, ordinal: 0, text: "Mode answer." }, { id: `evt_230_modes_ended_${n}`, created: n * 10 + 3 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_group" }, { id: `evt_230_modes_done_${n}`, created: n * 10 + 4 }))
  }
  try {
    emitTurn(30)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal((await diagnostic()).native.shadow.comparisons, 0, "off never shadow-ingests")
    let state = await snapshotFor(handlers, directory)
    assert.equal(state.messages["w"], undefined)
    assert.equal(Object.keys(state.subtasks).length, 0)

    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "shadow" } })
    emitTurn(31)
    await waitFor(async () => (await diagnostic()).native.shadow.comparisons === 1)
    state = await snapshotFor(handlers, directory)
    assert.equal(state.messages["w"], undefined, "shadow still writes no visible rows")
    assert.equal(Object.keys(state.subtasks).length, 0)

    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "on" } })
    emitTurn(32)
    await waitFor(async () => {
      const next = await snapshotFor(handlers, directory)
      return (next.messages["w"] ?? []).some((message: any) => message.author === "agent")
    })
    state = await snapshotFor(handlers, directory)
    assert.equal(state.messages["w"].length, 2, "on still produces the durable turn")
    assert.equal(Object.values(state.subtasks).filter((task: any) => task.origin === "native").length, 1)
    assert.equal((await diagnostic()).native.shadow.comparisons, 1, "shadow comparisons are bounded history, not visible state")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket230: shadow counts planned routes without creating peer work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-230-routes-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  nativeSessions.set("s_b", { id: "s_b" })
  await seedNativeWorkspace(ctx, directory, { a: "s_group", b: "s_b" })
  ;(ctx.session as any).context = async () => ({
    data: [
      { id: "m40", type: "user", content: [{ type: "text", text: "Route to $B" }], time: { created: 1 } },
      { id: "m41", type: "assistant", content: [{ type: "text", text: "Done $B" }], time: { created: 2 } },
      { id: "m42", type: "idle" },
    ],
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  const diagnostic = async () => service.handlers().diagnostic({ directory })
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "shadow" } })
    const enqueue = nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "m40",
      item: { type: "user", delivery: "steer", payload: { text: "Route to $B" } },
    })
    emitEvent({ ...enqueue, id: "evt_230_route_enqueue", created: 100 })
    emitEvent({ ...enqueue, id: "evt_230_route_enqueue_dup", created: 100 })
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group" }, { id: "evt_230_route_start", created: 101 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_group", assistantMessageID: "m41", ordinal: 0 }, { id: "evt_230_route_text", created: 102 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_group", assistantMessageID: "m41", ordinal: 0, text: "Done $B" }, { id: "evt_230_route_ended", created: 103 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_group" }, { id: "evt_230_route_done", created: 104 }))

    await waitFor(async () => (await diagnostic()).native.shadow.comparisons === 1)
    const row = (await diagnostic()).native.shadow.last[0]
    assert.equal(row.plannedUserRoutes, 1)
    assert.equal(row.plannedFinalRoutes, 1)
    assert.equal(row.plannedRoutes, 2, "the planner would route both the user and final mentions")
    assert.equal(row.visibleRoutes, 0)
    assert.equal(row.routingDelta, 2, "the planned route delta is data, not a mismatch")
    assert.equal(row.routingMatch, true, "the visible path cannot route a native turn")
    const state = await snapshotFor(handlers, directory)
    assert.equal(Object.keys(state.subtasks).length, 0, "shadow routes no peer turns")
    assert.equal(state.messages["w"], undefined)
    const logs = await service.handlers()["logs.recent"]({ directory, event: "native.route.created", limit: 20 })
    assert.equal(logs.entries.length, 0, "shadow never admits a route")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket230: shadow state clears on settle, stop, and restart while comparisons stay bounded", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-230-shadow-lifecycle-"))
  const { ctx, values, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  await seedNativeWorkspace(ctx, directory)
  ;(ctx.session as any).context = async () => ({
    data: [
      { id: "m50", type: "user", content: [{ type: "text", text: "Lifecycle" }], time: { created: 1 } },
      { id: "m51", type: "assistant", content: [{ type: "text", text: "Lifecycle answer." }], time: { created: 2 } },
      { id: "m52", type: "idle" },
    ],
  })
  const first = new EnsembleV2Service(ctx)
  const stopFirst = await startServiceForTest(first, first.ctx)
  let comparisons = 0
  try {
    await first.handlers().invoke({ directory, action: "settings.update", payload: { nativeFirst: "shadow" } })
    for (let index = 0; index < 40; index++) {
      const n = 100 + index
      emitEvent(nativeEvent("session.inbox.enqueued", {
        sessionID: "s_group",
        inboxID: `m${n}`,
        item: { type: "user", delivery: "steer", payload: { text: `Lifecycle ${n}` } },
      }, { id: `evt_230_life_enqueue_${n}`, created: n }))
      emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group" }, { id: `evt_230_life_start_${n}`, created: n }))
      emitEvent(nativeEvent("session.text.started", { sessionID: "s_group", assistantMessageID: `a${n}`, ordinal: 0 }, { id: `evt_230_life_text_${n}`, created: n }))
      emitEvent(nativeEvent("session.text.ended", { sessionID: "s_group", assistantMessageID: `a${n}`, ordinal: 0, text: "Lifecycle answer." }, { id: `evt_230_life_ended_${n}`, created: n }))
      emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_group" }, { id: `evt_230_life_done_${n}`, created: n }))
    }
    await waitFor(async () => (await first.handlers().diagnostic({ directory })).native.shadow.comparisons >= 40)
    const diag = await first.handlers().diagnostic({ directory })
    comparisons = diag.native.shadow.comparisons
    assert.equal(comparisons, 40)
    assert.equal(diag.native.shadow.activeTurns, 0)
    assert.equal(diag.native.shadow.activeSessions, 0)
    assert.ok(diag.native.shadow.last.length <= 32, "comparison history is bounded")
  } finally {
    await stopFirst()
  }

  const second = new EnsembleV2Service(ctx)
  const stopSecond = await startServiceForTest(second, second.ctx)
  try {
    const restarted = await second.handlers().diagnostic({ directory })
    assert.equal(restarted.state.settings.nativeFirst, "shadow")
    assert.equal(restarted.native.shadow.comparisons, 0, "restart clears shadow comparisons")
    assert.equal(restarted.native.shadow.activeTurns, 0)
    assert.equal(restarted.native.shadow.activeSessions, 0)
    assert.equal(Object.values(restarted.state.subtasks).filter((task: any) => task.origin === "native").length, 0)
    void values
  } finally {
    await stopSecond()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket230: shadow skips internal service prompts instead of comparing them", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-230-shadow-internal-"))
  const { ctx, nativeSessions, emitEvent } = fakeContext()
  nativeSessions.set("s_group", { id: "s_group" })
  await seedNativeWorkspace(ctx, directory)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  const diagnostic = async () => service.handlers().diagnostic({ directory })
  try {
    await handlers.invoke({ directory, action: "settings.update", payload: { nativeFirst: "shadow" } })
    emitEvent(nativeEvent("session.inbox.enqueued", {
      sessionID: "s_group",
      inboxID: "m60",
      item: { type: "user", delivery: "steer", payload: { text: "internal prompt", metadata: { "ensemble.internal": true } } },
    }, { id: "evt_230_internal_enqueue", created: 100 }))
    emitEvent(nativeEvent("session.execution.started", { sessionID: "s_group" }, { id: "evt_230_internal_start", created: 101 }))
    emitEvent(nativeEvent("session.text.started", { sessionID: "s_group", assistantMessageID: "m61", ordinal: 0 }, { id: "evt_230_internal_text", created: 102 }))
    emitEvent(nativeEvent("session.text.ended", { sessionID: "s_group", assistantMessageID: "m61", ordinal: 0, text: "internal answer" }, { id: "evt_230_internal_ended", created: 103 }))
    emitEvent(nativeEvent("session.execution.succeeded", { sessionID: "s_group" }, { id: "evt_230_internal_done", created: 104 }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    const diag = await diagnostic()
    assert.equal(diag.native.shadow.comparisons, 0)
    assert.equal(diag.native.shadow.activeTurns, 0)
    assert.equal(diag.native.shadow.activeSessions, 0)
    const state = await snapshotFor(handlers, directory)
    assert.equal(state.messages["w"], undefined)
    assert.equal(Object.keys(state.subtasks).length, 0)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})
