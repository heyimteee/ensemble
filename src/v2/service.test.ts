import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { EnsembleV2Service } from "./service.ts"
import { SharedEnsemble } from "./shared-service.ts"
import { workKey } from "./queue.ts"
import { V2Store } from "./store.ts"

type Handlers = {
  snapshot: (input: unknown) => Promise<any>
  invoke: (input: unknown) => Promise<any>
}

function fakeContext(sharedValues?: Map<string, unknown>) {
  const values = sharedValues ?? new Map<string, unknown>()
  const removedSessions: string[] = []
  const interruptedSessions: string[] = []
  const movedSessions: Array<{ sessionID: string; directory: string }> = []
  const commands: Array<{ sessionID: string; name: string }> = []
  const createdSessionIDs: string[] = []
  let sessions = 0
  const handlers: Partial<Handlers> = {}
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
      instructions: { entry: { put: async () => undefined } },
      switchModel: async () => undefined,
      prompt: async () => undefined,
      wait: async () => { await new Promise((resolve) => setTimeout(resolve, 5)) },
      context: async () => ({
        data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "OK" }] }],
      }),
      interrupt: async ({ sessionID }: any) => { interruptedSessions.push(sessionID) },
      remove: async ({ sessionID }: any) => { removedSessions.push(sessionID) },
      move: async ({ sessionID, directory }: any) => { movedSessions.push({ sessionID, directory }); return { data: { id: sessionID, directory } } },
      command: async ({ sessionID, name }: any) => { commands.push({ sessionID, name }); return { data: {} } },
    },
    tool: { transform: async (factory: any) => factory({ namespace() {}, add(tool: any) { tools.set(tool.name, tool) } }) },
    rpc: {
      register: async (_schema: unknown, value: Handlers) => {
        handlers.snapshot = value.snapshot
        handlers.invoke = value.invoke
        return { events: { emit: async () => undefined } }
      },
    },
    model: {
      list: async () => [{ providerID: "probe", id: "probe-model", name: "Probe", variants: [] }],
    },
    skill: { list: async () => [] },
    event,
  }
  return { ctx, handlers: handlers as Handlers, values, removedSessions, interruptedSessions, movedSessions, commands, createdSessionIDs, tools, emitEvent }
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
    assert.ok(after.state.messages[workspace.result.id].some((message: any) => message.text.includes("Subtask failed")))
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
    const imported = await handlers.snapshot({ directory })
    const workspace = Object.values(imported.state.workspaces)[0] as any
    assert.equal(workspace.name, "Manual")
    assert.equal(workspace.leaderID, sage.result.id)
    assert.deepEqual(workspace.memberIDs, [nova.result.id, sage.result.id])
    assert.equal(workspace.synthesis, false)
    assert.equal(workspace.paused, true)
    writeFileSync(join(directory, ".ensemble", "config.json"), JSON.stringify({ version: 1, name: "Edited", leader: "Nova", members: ["Nova"], synthesis: true, paused: false }))
    const edited = await handlers.snapshot({ directory })
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

test("init runs native /init then places the versioned block at the top", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx, commands } = fakeContext()
  ;(ctx.session as any).command = async ({ sessionID, name }: any) => {
    commands.push({ sessionID, name })
    writeFileSync(join(directory, "AGENTS.md"), "# Repo\n\nExisting.\n")
    return { data: {} }
  }
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    const init = await handlers.invoke({ directory, action: "workspace.init", payload: { id: workspace.result.id } })
    assert.equal(init.ok, true)
    assert.ok(commands.some((entry) => entry.name === "init"))
    const content = readFileSync(join(directory, "AGENTS.md"), "utf8")
    assert.ok(content.startsWith("<!-- ensemble:start v2 -->"))
    assert.ok(content.includes("# Repo"))
    assert.equal((content.match(/<!-- ensemble:start/g) ?? []).length, 1)
  } finally {
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

test("failed init leaves no AGENTS.md block", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-service-"))
  const { ctx } = fakeContext()
  ;(ctx.session as any).wait = async () => { throw new Error("agent failed") }
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
  const handlers = service.handlers()
  try {
    const agent = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
    const workspace = await handlers.invoke({ directory, action: "workspace.create", payload: { name: "site", directory, memberIDs: [agent.result.id], leaderID: agent.result.id } })
    const init = await handlers.invoke({ directory, action: "workspace.init", payload: { id: workspace.result.id } })
    assert.equal(init.ok, false)
    assert.equal(init.error?.code, "init_failed")
    assert.equal(existsSync(join(directory, "AGENTS.md")), false)
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
    const next = await handlers.snapshot({ directory })
    const restored = next.state.workspaces[workspace.result.id]
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

test("terminal rows still suppress resubmission until retention expires, with retry as the explicit re-ask", async () => {
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
    // The same ask dedupes against the retained terminal row: one row, no
    // second execution. The user line is still posted, so nothing is silent.
    const sent = await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: "w", text: "Coordinate" } })
    assert.deepEqual(sent.result.recipients, ["n"])
    const after = await handlers.snapshot({ directory })
    assert.equal(Object.values(after.state.subtasks).filter((task: any) => task.title === "Coordinate").length, 1)
    assert.equal((after.state.subtasks as any).t?.outcome, "succeeded")
    // Intentional re-asks stay explicit: task.retry re-queues the same row,
    // which then runs exactly once through the normal queue path.
    const retried = await handlers.invoke({ directory, action: "task.retry", payload: { id: "t" } })
    assert.equal(retried.result.id, "t")
    assert.equal(retried.result.state, "pending")
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks as any).t?.state === "replied" && (next.state.subtasks as any).t?.attempts === 2
    })
    const rerun = await handlers.snapshot({ directory })
    assert.equal(Object.values(rerun.state.subtasks).filter((task: any) => task.title === "Coordinate").length, 1)
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
    assert.ok((after.state.messages.w as any[]).some((message) => message.text.includes("Subtask failed")))
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
    assert.ok((after.state.messages[workspace.result.id] as any[]).some((message: any) => message.text.includes("Handed to $Sage")))
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
  const { ctx, tools, emitEvent } = fakeContext()
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
