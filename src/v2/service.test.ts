import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { EnsembleV2Service } from "./service.ts"
import { SharedEnsemble } from "./shared-service.ts"
import { workKey } from "./queue.ts"
import { V2Store, bindingKey } from "./store.ts"
import type { Agent, Workspace } from "./types.ts"
import { INIT_PROGRESS_TEXT, INIT_START_TEXT, SYSTEM_AGENT_NAME, initJobPhase } from "./system-agent.ts"

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

async function waitFor(check: () => Promise<boolean>, timeout = 2000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for condition")
}

test("service routes group messages, persists sequence, and restores the active workspace", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  await seed.saveAgent({ id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "a", memberIDs: ["a"], synthesis: true, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1 })
  // Already promoted: a second pending promote decision is moot.
  await seed.saveMemory({ id: "mem-done", agentID: "a", workspaceID: "w", scope: "global", text: "Keep", origin: "manual", source: "user", createdAt: 1, updatedAt: 1, history: [{ at: 1, action: "created", by: "user" }] })
  await seed.saveApproval({ id: "ap-stale", workspaceID: "w", agentID: "a", kind: "promote_memory", title: "Promote", detail: "Keep", payload: { memoryID: "mem-done" }, status: "pending", createdAt: 1 })
  // Deleted memory: there is nothing left to promote.
  await seed.saveApproval({ id: "ap-gone", workspaceID: "w", agentID: "a", kind: "promote_memory", title: "Promote", detail: "Gone", payload: { memoryID: "mem-missing" }, status: "pending", createdAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
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
  const stop = await service.start()
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
  await seed.saveAgent({ id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  await seed.saveAgent({ id: "b", name: "Echo", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "a", memberIDs: ["a"], synthesis: true, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1 })
  await seed.saveSubtask({ id: "parent", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Parent", instruction: "Parent", mode: "research", state: "working", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false, attempts: 1, createdAt: 1 })
  await seed.saveApproval({ id: "ap", workspaceID: "w", subtaskID: "parent", agentID: "a", kind: "outside_roster", title: "Contact Echo", detail: "Check", payload: { assigneeID: "b", title: "Child", instruction: "Check" }, status: "pending", createdAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
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
  await seed.saveAgent({ id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "a", memberIDs: ["a"], synthesis: true, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1 })
  await seed.saveApproval({ id: "ap", workspaceID: "w", agentID: "a", kind: "cross_project", title: "Share", detail: "Shared note", payload: { text: "Shared note" }, status: "pending", createdAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
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
  await seed.saveAgent({ id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "a", memberIDs: ["a"], synthesis: true, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1 })
  await seed.saveSubtask({ id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Interrupted", instruction: "Do", mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: true, approvalID: "ap", awaitingChildren: false, attempts: 1, createdAt: 1 })
  await seed.saveApproval({ id: "ap", workspaceID: "w", subtaskID: "t", agentID: "a", kind: "interrupted", source: "workspace", title: "Resume interrupted work: Interrupted", detail: "The run stopped before it could reply.", payload: { subtaskID: "t" }, status: "pending", createdAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
  const handlers = service.handlers()
  try {
    const before = await handlers.snapshot({ directory })
    const approval = Object.values(before.state.approvals)[0] as any
    await handlers.invoke({ directory, action: "approval.resolve", payload: { id: approval.id, approve: false } })
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.subtasks.t.state, "replied")
    assert.equal(after.state.subtasks.t.outcome, "failed")
    assert.equal(after.state.subtasks.t.attempts, 1)
  } finally {
    await stop()
  }
})

test("file references in messages are attached to the task instruction", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  writeFileSync(join(directory, "notes.md"), "hello")
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
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
  const stop = await service.start()
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    await handlers.invoke({ directory, action: "settings.update", payload: { maxDepth: 1 } })
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
  const stop = await service.start()
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
  const stop = await service.start()
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
    const delegated = await tools.get("delegate").execute({ assignee: "Sage", title: "Child", instruction: "Check" }, toolContext)
    assert.match(delegated.content, /Delegated to Sage/)
    const outside = await tools.get("delegate").execute({ assignee: "Echo", title: "Outside", instruction: "Check" }, toolContext)
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
    const handoff = await tools.get("handoff").execute({ task: "task", summary: "summary", path: ".ensemble/handoffs/task-nova-sage-1.md", to: "Sage" }, toolContext)
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
    await tools.get("delegate").execute({ assignee: "Sage", title: "Child", instruction: "Check" }, { sessionID })
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
  await seed.saveAgent({ id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "a", memberIDs: ["a"], synthesis: true, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1 })
  await seed.saveApproval({ id: "ap", workspaceID: "w", subtaskID: "t", agentID: "a", kind: "ask_person", title: "Need input", detail: "Which?", status: "pending", createdAt: 1 })
  await seed.saveSubtask({ id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Waiting", instruction: "Do", mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: false, approvalID: "ap", awaitingChildren: false, attempts: 1, createdAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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

test("agent names are unique and config names must resolve uniquely", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
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
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "a", memberIDs: ["a"], synthesis: true, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1 })
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 250)) }
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
    assert.ok(content.startsWith("<!-- ensemble:start v2 -->"))
    assert.ok(content.includes("# Repo"))
    assert.equal((content.match(/<!-- ensemble:start/g) ?? []).length, 1)
    const metadata = JSON.parse(readFileSync(join(directory, ".ensemble", "init.json"), "utf8"))
    assert.equal(metadata.version, 2)
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  await seed.saveAgent({ id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, homeDirectory: home, createdAt: 1, updatedAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
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
  const stop = await service.start()
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
  await seed.saveAgent({ id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, homeDirectory: home, createdAt: 1, updatedAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
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
  const stop = await service.start()
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
  await seed.saveAgent({ id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, homeDirectory: home, createdAt: 1, updatedAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  await seed.saveAgent({ id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "a", memberIDs: ["a"], synthesis: true, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1 })
  await seed.saveMessage({ id: "m", workspaceID: "w", seq: 1, author: "agent", displayAuthor: SYSTEM_AGENT_NAME, text: "Initializing workspace…", kind: "text", streaming: true, createdAt: 1, updatedAt: 1 })
  await seed.saveMessage({ id: "other", workspaceID: "w", seq: 2, author: "agent", displayAuthor: SYSTEM_AGENT_NAME, text: INIT_START_TEXT, kind: "text", createdAt: 2 })
  await seed.saveInitJob({ id: "init_1", workspaceID: "w", messageID: "m", sessionID: "old_session", state: "running", phases: ["starting", "running"], previousAgentsMD: previous, startedAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
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
  const stop = await service.start()
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
    const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
    const delegated = await tools.get("delegate").execute({ assignee: "Kaluna", title: "Child", instruction: "Check" }, { sessionID })
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
  const stop = await service.start()
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
    const refused = await tools.get("delegate").execute({ assignee: "Nova", title: "Sneaky", instruction: "Check" }, { sessionID })
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
  const stop = await service.start()
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
    const first = await tools.get("delegate").execute({ assignee: "Sage", title: "Child", instruction: "Check" }, { sessionID })
    assert.match(first.content, /Delegated to Sage/)
    const second = await tools.get("delegate").execute({ assignee: "Sage", title: "Child", instruction: "Check" }, { sessionID })
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
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "n", memberIDs: ["n", "s"], synthesis: false, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1 })
  // A retained terminal row for the exact work the user path would create.
  const at = Date.now()
  const retainedKey = workKey({ actor: "user", workspaceID: "w", kind: "delegation", parentID: undefined, assigneeID: "n", title: "Coordinate", instruction: "Coordinate" })
  await seed.saveSubtask({ id: "t", workspaceID: "w", creatorType: "user", assigneeID: "n", title: "Coordinate", instruction: "Coordinate", mode: "research", state: "replied", stage: "initial", outcome: "succeeded", interrupted: false, awaitingChildren: false, attempts: 1, createdAt: 1, repliedAt: at, finishedAt: at, queueKey: retainedKey, workKind: "delegation" })
  const { ctx } = fakeContext(shared)
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
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
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "n", memberIDs: ["n", "s"], synthesis: false, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1 })
  await seed.saveSubtask({ id: "t", workspaceID: "w", creatorType: "agent", creatorAgentID: "n", assigneeID: "s", title: "Child", instruction: "Check", mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false, attempts: 2, createdAt: 1, claimedBy: "run_old", leaseUntil: 1, queueKey: "work:w:delegation:root:seed", workKind: "delegation" })
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
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

test("exhausted attempts fail with the reason preserved", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-queue-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seed.saveAgent({ id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "a", memberIDs: ["a"], synthesis: true, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1 })
  await seed.saveSubtask({ id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Tired", instruction: "Do", mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false, attempts: 5, error: "boom", createdAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks as any).t?.state === "replied"
    })
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.subtasks.t.outcome, "failed")
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
  const stop = await service.start()
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
    const input = { task: "task", summary: "summary", path: ".ensemble/handoffs/task-nova-sage-1.md", to: "Sage" }
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
  const stop = await service.start()
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
    await tools.get("delegate").execute({ assignee: "Sage", title: "Child", instruction: "Check" }, { sessionID })
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
  const stop = await service.start()
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
  await seed.saveAgent({ id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "a", memberIDs: ["a"], synthesis: true, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1 })
  await seed.saveSubtask({ id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Stale", instruction: "Do work", mode: "research", state: "working", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false, attempts: 1, createdAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
      return true
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
  await seed.saveAgent({ id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "a", memberIDs: ["a"], synthesis: true, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1 })
  await seed.saveSubtask({ id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Work", instruction: "Do", mode: "research", state: "working", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false, attempts: 0, createdAt: 1 })
  await seed.saveApproval({ id: "out", workspaceID: "w", subtaskID: "t", agentID: "a", kind: "outside_roster", title: "Contact", detail: "Check", status: "pending", createdAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
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
  await seed.saveAgent({ id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "a", memberIDs: ["a"], synthesis: true, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
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
  await seed.saveAgent({ id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "a", memberIDs: ["a"], synthesis: true, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1 })
  const retryAt = Date.now() + 1_500
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Wake retry", instruction: "Do",
    mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 1, error: "boom", retryAfter: retryAt, createdAt: 1,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
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
  await seed.saveAgent({ id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "a", memberIDs: ["a"], synthesis: true, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
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
  await seed.saveAgent({ id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "a", memberIDs: ["a"], synthesis: true, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1 })
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Terminal", instruction: "Do",
    mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 4, dispatchGroupID: "g1", createdAt: 1,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return next.state.subtasks.t?.state === "replied" && next.state.subtasks.t?.outcome === "failed"
    }, 5_000)
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
  await seed.saveAgent({ id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "a", memberIDs: ["a"], synthesis: true, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
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
  await seed.saveAgent({ id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "a", memberIDs: ["a"], synthesis: true, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1 })
  await seed.saveSubtask({ id: "parent", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Parent", instruction: "Do parent", mode: "research", state: "working", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: true, attempts: 1, createdAt: 1 })
  await seed.saveSubtask({ id: "child", workspaceID: "w", parentID: "parent", creatorType: "agent", creatorAgentID: "a", assigneeID: "a", title: "Child", instruction: "Do child", mode: "research", state: "replied", stage: "initial", outcome: "succeeded", interrupted: false, awaitingChildren: false, attempts: 1, createdAt: 2, repliedAt: 3, finishedAt: 3 })
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
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
  await seed.saveAgent({ id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "a", memberIDs: ["a"], synthesis: true, archived: false, paused: false, nextSeq: 2, createdAt: 1, lastActiveAt: 1 })
  await seed.saveSubtask({ id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Done", instruction: "Do", mode: "research", state: "replied", stage: "initial", outcome: "succeeded", interrupted: false, awaitingChildren: false, attempts: 1, createdAt: 1, repliedAt: 2, finishedAt: 2 })
  await seed.saveMessage({ id: "m", workspaceID: "w", seq: 1, author: "agent", agentID: "a", taskID: "t", text: "partial reply", kind: "text", streaming: true, createdAt: 2 })
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
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

test("ticket76: sequential user tasks settle in order with no stuck work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-76-seq-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
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
  const stop = await service.start()
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
    await tools.get("delegate").execute({ assignee: "Sage", title: "child", instruction: "check" }, { sessionID })
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
    const delegated = await tools.get("delegate").execute({ assignee: "Sage", title: "Research follow-up", instruction: guidance }, { sessionID: leaderSession })
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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
      const stop = await service.start()
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
  const stop = await service.start()
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
  const stop = await service.start()
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

test("shell actions publish incremental patches and an approval resolution reaches the feed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-shell-feed-"))
  const { ctx } = fakeContext()
  const emitted: Array<{ name: string; data: any }> = []
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
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
  const stop = await service.start()
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
