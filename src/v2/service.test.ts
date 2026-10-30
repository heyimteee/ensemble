import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { EnsembleV2Service } from "./service.ts"
import { V2Store } from "./store.ts"

type Handlers = {
  snapshot: (input: { directory: string }) => Promise<any>
  invoke: (input: { directory: string; action: string; payload?: any }) => Promise<any>
}

function fakeContext() {
  const values = new Map<string, unknown>()
  const removedSessions: string[] = []
  const interruptedSessions: string[] = []
  let sessions = 0
  const handlers: Partial<Handlers> = {}
  const ctx = {
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
      create: async ({ title }: any) => ({ data: { id: `session_${++sessions}`, title } }),
      instructions: { entry: { put: async () => undefined } },
      switchModel: async () => undefined,
      prompt: async () => undefined,
      wait: async () => { await new Promise((resolve) => setTimeout(resolve, 5)) },
      context: async () => ({
        data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "OK" }] }],
      }),
      interrupt: async ({ sessionID }: any) => { interruptedSessions.push(sessionID) },
      remove: async ({ sessionID }: any) => { removedSessions.push(sessionID) },
    },
    tool: { transform: async (factory: any) => factory({ namespace() {}, add() {} }) },
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
    event: { subscribe: async function* () {} },
  }
  return { ctx, handlers: handlers as Handlers, values, removedSessions, interruptedSessions }
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
    assert.equal(response.error.code, "unknown_member")
    assert.match(response.error.message, /\$Ghost/)
  } finally {
    await stop()
  }
})

test("interrupted work waits for an explicit resume approval", async () => {
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
    const snapshot = await handlers.snapshot({ directory })
    const task = snapshot.state.subtasks.t
    assert.equal(task.state, "pending")
    assert.equal(task.interrupted, true)
    const approvals = Object.values(snapshot.state.approvals) as any[]
    assert.equal(approvals.length, 1)
    assert.equal(approvals[0].kind, "interrupted")
    await new Promise((resolve) => setTimeout(resolve, 50))
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.subtasks.t.attempts, 1)
    assert.equal(after.state.subtasks.t.state, "pending")
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
    assert.equal(conflict.error.code, "already_resolved")
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
    assert.equal(agentMessages.at(-1).agentID, sage.result.id)
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
    color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1,
  })
  await seed.saveWorkspace({
    id: "w", name: "site", directory, leaderID: "a", memberIDs: ["a"], synthesis: true,
    archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1,
  })
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "a", title: "Interrupted", instruction: "Do work",
    mode: "research", state: "working", stage: "initial", outcome: "pending", interrupted: false,
    awaitingChildren: false, attempts: 1, createdAt: 1,
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
    assert.equal(paused.error.code, "workspace_paused")
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
    assert.equal(refused.error.code, "leader_replacement_required")
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
