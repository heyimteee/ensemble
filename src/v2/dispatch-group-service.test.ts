import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { EnsembleV2Service } from "./service.ts"
import { seedLegacySettings, startServiceForTest } from "./test-service.ts"
import { V2Store } from "./store.ts"
import { legacyDispatchGroupID } from "./dispatch-group.ts"

type Handlers = {
  snapshot: (input: unknown) => Promise<any>
  invoke: (input: unknown) => Promise<any>
}

function fakeContext() {
  const values = new Map<string, unknown>()
  seedLegacySettings(values)
  const tools = new Map<string, any>()
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
      create: async ({ title }: any) => ({ data: { id: `session_${title}_${Math.random().toString(36).slice(2, 8)}`, title } }),
      instructions: { entry: { put: async () => undefined } },
      switchModel: async () => undefined,
      prompt: async () => undefined,
      wait: async () => { await new Promise((resolve) => setTimeout(resolve, 5)) },
      context: async () => ({
        data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "Finished the work." }] }],
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
        handlers.invoke = value.invoke
        return { events: { emit: async () => undefined } }
      },
    },
    model: {
      list: async () => [{ providerID: "probe", id: "probe-model", name: "Probe", variants: [] }],
    },
    skill: { list: async () => [] },
    event: {
      subscribe: async function* () {
        while (true) await new Promise<void>(() => undefined)
      },
    },
  }
  const handlers: Partial<Handlers> = {}
  return { ctx, handlers: handlers as Handlers, tools }
}

async function waitFor(check: () => Promise<boolean>, timeout = 8000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for condition")
}

async function setupPair(directory: string, handlers: Handlers) {
  const nova = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Nova" } })
  const sage = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Sage" } })
  const workspace = await handlers.invoke({
    directory,
    action: "workspace.create",
    payload: { name: "site", directory, memberIDs: [nova.result.id, sage.result.id], leaderID: nova.result.id },
  })
  return { nova: nova.result, sage: sage.result, workspace: workspace.result }
}

async function bindingSessionID(handlers: Handlers, directory: string, agentID: string): Promise<string> {
  let sessionID = ""
  await waitFor(async () => {
    const next = await handlers.snapshot({ directory })
    const binding = Object.values(next.state.bindings).find((item: any) => item.agentID === agentID) as any
    if (!binding) return false
    sessionID = binding.sessionID
    return true
  })
  return sessionID
}

const handoffFile = (directory: string, name: string, body: string): string => {
  mkdirSync(join(directory, ".ensemble", "handoffs"), { recursive: true })
  writeFileSync(join(directory, ".ensemble", "handoffs", name), body)
  return `.ensemble/handoffs/${name}`
}

test("ticket160: a user command creates a root ledger group with the default caps", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-group-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const { workspace } = await setupPair(directory, handlers)
    const sent = await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "Coordinate" } })
    assert.equal(sent.ok, true)
    const snapshot = await handlers.snapshot({ directory })
    const task = Object.values(snapshot.state.subtasks).find((item: any) => item.creatorType === "user") as any
    assert.ok(task.dispatchGroupID)
    const group = snapshot.state.dispatchGroups[task.dispatchGroupID]
    assert.ok(group, "the command group is in the snapshot")
    assert.equal(group.rootID, group.id)
    assert.equal(group.continuationIndex, 0)
    assert.equal(group.maxHops, 8)
    assert.equal(group.commandMaxHops, 24)
    assert.equal(group.depthMax, 8)
    assert.equal(group.maxContinuations, 2)
    assert.equal(group.usedHops, 0, "a user command and its initial recipients consume nothing")
    assert.equal(group.commandUsedHops, 0)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket160: settings changes apply to new commands only and reject an invalid tier", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-group-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const { workspace } = await setupPair(directory, handlers)
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "First" } })
    let snapshot = await handlers.snapshot({ directory })
    const first = Object.values(snapshot.state.subtasks).find((item: any) => item.title === "First") as any
    const firstGroup = snapshot.state.dispatchGroups[first.dispatchGroupID]
    assert.equal(firstGroup.maxHops, 8)

    const invalid = await handlers.invoke({ directory, action: "settings.update", payload: { dispatchGroupMaxHops: 16, dispatchCommandMaxHops: 8 } })
    assert.equal(invalid.ok, false)
    assert.equal(invalid.error?.code, "invalid_settings")
    assert.match(invalid.error?.message ?? "", /Command hops \(8\) must be at least group hops \(16\)/)

    const saved = await handlers.invoke({
      directory,
      action: "settings.update",
      payload: { dispatchGroupMaxHops: 16, dispatchCommandMaxHops: 32, dispatchDepth: 4, dispatchContinuations: 1 },
    })
    assert.equal(saved.ok, true)
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "Second" } })
    snapshot = await handlers.snapshot({ directory })
    assert.equal(snapshot.state.settings.dispatchGroupMaxHops, 16)
    assert.equal(snapshot.state.settings.dispatchCommandMaxHops, 32)
    assert.equal(snapshot.state.settings.dispatchDepth, 4)
    assert.equal(snapshot.state.settings.dispatchContinuations, 1)
    assert.equal(snapshot.state.dispatchGroups[first.dispatchGroupID].maxHops, 8, "the live group keeps its captured cap")
    const second = Object.values(snapshot.state.subtasks).find((item: any) => item.title === "Second") as any
    const secondGroup = snapshot.state.dispatchGroups[second.dispatchGroupID]
    assert.equal(secondGroup.maxHops, 16)
    assert.equal(secondGroup.commandMaxHops, 32)
    assert.equal(secondGroup.depthMax, 4)
    assert.equal(secondGroup.maxContinuations, 1)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket160: agent delegation and handoff consume hops; completion and batch review stay exempt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-group-"))
  const { ctx, tools } = fakeContext()
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 300)) }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const { nova, sage, workspace } = await setupPair(directory, handlers)
    const kim = (await handlers.invoke({ directory, action: "agent.create", payload: { name: "Kim" } })).result
    await handlers.invoke({ directory, action: "workspace.update", payload: { id: workspace.id, memberIDs: [nova.id, sage.id, kim.id] } })
    // One user command addressed to two non-leader members: their completion
    // hops and the consolidated batch review arrive in that command's group
    // and never spend a hop.
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "$Sage and $Kim take this" } })
    let exemptGroupID = ""
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const turns = Object.values(next.state.subtasks).filter((task: any) => task.workKind === "turn") as any[]
      if (turns.length < 2 || !turns[0].dispatchGroupID) return false
      exemptGroupID = turns[0].dispatchGroupID
      return true
    })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const batch = Object.values(next.state.subtasks).find(
        (task: any) => task.handoff?.batch === true && task.dispatchGroupID === exemptGroupID,
      ) as any
      return batch?.handoff?.itemIDs?.length === 2
    }, 15000)
    const exempt = await handlers.snapshot({ directory })
    assert.equal(exempt.state.dispatchGroups[exemptGroupID].usedHops, 0, "completion and batch review spend no hop")
    assert.equal(exempt.state.dispatchGroups[exemptGroupID].commandUsedHops, 0)
    // The leader's own command still spends a hop per agent dispatch.
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "Coordinate" } })
    const novaSession = await bindingSessionID(handlers, directory, nova.id)
    let groupID = ""
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const root = Object.values(next.state.subtasks).find((task: any) => task.creatorType === "user" && task.title === "Coordinate") as any
      if (!root?.dispatchGroupID) return false
      groupID = root.dispatchGroupID
      return Object.values(next.state.runs ?? {}).some((run: any) => run.subtaskID === root.id && run.status === "running")
    })
    assert.equal((await handlers.snapshot({ directory })).state.dispatchGroups[groupID].usedHops, 0)
    const delegated = await tools.get("delegate").execute({ maxHops: 1, assignee: "Sage", title: "Child work", instruction: "Check" }, { sessionID: novaSession })
    assert.match(delegated.content, /Delegated to Sage/)
    const path = handoffFile(directory, "ask.md", "---\nensemble: handoff\ntask: Hand work\n---\n# Handoff\n")
    await tools.get("handoff").execute({ maxHops: 1, task: "Hand work", summary: "", path, to: "Sage" }, { sessionID: novaSession })
    let mid = await handlers.snapshot({ directory })
    assert.equal(mid.state.dispatchGroups[groupID].usedHops, 2, "two agent dispatches consumed two hops")
    assert.equal(mid.state.dispatchGroups[groupID].commandUsedHops, 2)
    // Ticket #237: the leader asked for both dispatches, so their finished
    // turns hand back to the parent/sender instead of queueing a completion.
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const child = Object.values(next.state.subtasks).find((task: any) => task.title === "Child work") as any
      return child?.state === "replied"
    }, 15000)
    mid = await handlers.snapshot({ directory })
    assert.equal(mid.state.dispatchGroups[groupID].usedHops, 2)
    const finishedChild = Object.values(mid.state.subtasks).find((task: any) => task.title === "Child work") as any
    assert.equal(
      Object.values(mid.state.subtasks).some((task: any) => task.parentID === finishedChild?.id && task.handoff?.completion === true),
      false,
      "no redundant completion hop for leader-asked work",
    )
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("one user command fan-out shares one dispatch group and a second command mints another", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-group-"))
  const { ctx } = fakeContext()
  // Keep the first dispatch active while the second command lands.
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 150)) }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const { nova, sage, workspace } = await setupPair(directory, handlers)
    const kim = (await handlers.invoke({ directory, action: "agent.create", payload: { name: "Kim" } })).result
    await handlers.invoke({ directory, action: "workspace.update", payload: { id: workspace.id, memberIDs: [nova.id, sage.id, kim.id] } })
    const first = await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "$Sage and $Kim take this" } })
    assert.equal(first.ok, true)
    const firstSnapshot = await handlers.snapshot({ directory })
    const firstTurns = Object.values(firstSnapshot.state.subtasks).filter((task: any) => task.workKind === "turn") as any[]
    assert.equal(firstTurns.length, 2)
    const firstGroup = firstTurns[0].dispatchGroupID
    assert.ok(firstGroup)
    assert.equal(firstTurns[1].dispatchGroupID, firstGroup)
    // The same command sent again is a new dispatch, not a duplicate: a
    // retained row must not suppress a future user command.
    const second = await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "$Sage and $Kim take this" } })
    assert.equal(second.ok, true)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).filter((task: any) => task.workKind === "turn").length === 4
    })
    const secondSnapshot = await handlers.snapshot({ directory })
    const turns = Object.values(secondSnapshot.state.subtasks).filter((task: any) => task.workKind === "turn") as any[]
    const groups = [...new Set(turns.map((task) => task.dispatchGroupID))]
    assert.equal(groups.length, 2)
    assert.ok(groups.includes(firstGroup))
    for (const group of groups) {
      assert.equal(turns.filter((task) => task.dispatchGroupID === group).length, 2)
    }
    // The explicit recipient fan-out path also mints exactly one group for
    // its command, distinct from the mention commands above.
    const board = await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "Board fan-out", recipientIDs: [sage.id, kim.id] } })
    assert.equal(board.ok, true)
    const boardSnapshot = await handlers.snapshot({ directory })
    const delegations = Object.values(boardSnapshot.state.subtasks).filter((task: any) => task.workKind === "delegation" && task.title === "Board fan-out") as any[]
    assert.equal(delegations.length, 2)
    assert.ok(delegations[0].dispatchGroupID)
    assert.equal(delegations[1].dispatchGroupID, delegations[0].dispatchGroupID)
    assert.ok(!groups.includes(delegations[0].dispatchGroupID))
    // The mandatory completion handoffs caused by those turns inherit the
    // turn's group instead of starting a third dispatch.
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).filter((task: any) => task.handoff?.completion === true).length >= 4
    })
    const completed = await handlers.snapshot({ directory })
    const allowedGroups = new Set([...groups, delegations[0].dispatchGroupID])
    for (const task of Object.values(completed.state.subtasks) as any[]) {
      if (task.handoff?.completion !== true) continue
      assert.ok(allowedGroups.has(task.dispatchGroupID), `completion hop ${task.id} left its dispatch group`)
    }
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("delegation, handoff, completion batch, and synthesis inherit the command group", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-group-"))
  const { ctx, tools } = fakeContext()
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 300)) }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const { nova, sage, workspace } = await setupPair(directory, handlers)
    const kim = (await handlers.invoke({ directory, action: "agent.create", payload: { name: "Kim" } })).result
    await handlers.invoke({ directory, action: "workspace.update", payload: { id: workspace.id, memberIDs: [nova.id, sage.id, kim.id] } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "Coordinate" } })
    const novaSession = await bindingSessionID(handlers, directory, nova.id)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const root = Object.values(next.state.subtasks).find((task: any) => task.creatorType === "user" && task.title === "Coordinate") as any
      if (!root) return false
      return Object.values(next.state.runs ?? {}).some((run: any) => run.subtaskID === root.id && run.status === "running")
    })
    const before = await handlers.snapshot({ directory })
    const root = Object.values(before.state.subtasks).find((task: any) => task.creatorType === "user" && task.title === "Coordinate") as any
    assert.ok(root.dispatchGroupID)
    const groupID = root.dispatchGroupID
    const delegated = await tools.get("delegate").execute({ maxHops: 1, assignee: "Sage", title: "Child work", instruction: "Check" }, { sessionID: novaSession })
    assert.match(delegated.content, /Delegated to Sage/)
    const path = handoffFile(directory, "ask.md", "---\nensemble: handoff\ntask: Hand work\n---\n# Handoff\n")
    const asked = await tools.get("handoff").execute({ maxHops: 1, task: "Hand work", summary: "", path, to: "Sage" }, { sessionID: novaSession })
    assert.match(asked.content, /Handed to \$Sage/)
    const created = await handlers.snapshot({ directory })
    const child = Object.values(created.state.subtasks).find((task: any) => task.title === "Child work") as any
    const hop = Object.values(created.state.subtasks).find((task: any) => task.workKind === "handoff" && task.handoff?.completion !== true) as any
    assert.equal(child.dispatchGroupID, groupID)
    assert.equal(hop.dispatchGroupID, groupID)
    // Ticket #237: the leader-asked child and handoff finish without a
    // completion hop, so the batch that proves group inheritance comes from a
    // separate user command addressed to non-leader members.
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "$Sage and $Kim carry on" } })
    let batch: any
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      batch = Object.values(next.state.subtasks).find(
        (task: any) => task.handoff?.batch === true && task.dispatchGroupID !== groupID,
      ) as any
      return batch?.handoff?.itemIDs?.length === 2
    }, 15000)
    assert.ok(batch.dispatchGroupID, "a completion batch inherits its own command group")
    assert.notEqual(batch.dispatchGroupID, groupID)
    const batched = await handlers.snapshot({ directory })
    for (const itemID of batch.handoff.itemIDs) {
      assert.equal((batched.state.subtasks as any)[itemID].dispatchGroupID, batch.dispatchGroupID)
    }
    // Synthesis reuses the root row, so the group survives the leader's
    // synthesis turn unchanged.
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const current = (next.state.subtasks as any)[root.id]
      return current?.stage === "synthesis" || current?.state === "replied"
    }, 15000)
    const after = await handlers.snapshot({ directory })
    assert.equal((after.state.subtasks as any)[root.id].dispatchGroupID, groupID)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("approval-created handoffs and delegations carry the parent dispatch group", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-group-"))
  const { ctx, tools } = fakeContext()
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 1000)) }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const { nova, workspace } = await setupPair(directory, handlers)
    const echo = (await handlers.invoke({ directory, action: "agent.create", payload: { name: "Echo" } })).result
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "Coordinate" } })
    const novaSession = await bindingSessionID(handlers, directory, nova.id)
    let groupID = ""
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const root = Object.values(next.state.subtasks).find((task: any) => task.creatorType === "user" && task.title === "Coordinate") as any
      if (!root?.dispatchGroupID) return false
      groupID = root.dispatchGroupID
      return Object.values(next.state.runs ?? {}).some((run: any) => run.subtaskID === root.id && run.status === "running")
    })
    const path = handoffFile(directory, "outside.md", "---\nensemble: handoff\ntask: Outside help\n---\n# Handoff\n")
    const asked = await tools.get("handoff").execute({ maxHops: 1, task: "Outside help", summary: "", path, to: "Echo" }, { sessionID: novaSession })
    assert.match(asked.content, /Approval required/)
    const delegated = await tools.get("delegate").execute({ maxHops: 1, assignee: "Echo", title: "Outside child", instruction: "Help" }, { sessionID: novaSession })
    assert.match(delegated.content, /Approval required/)
    const posted = await tools.get("send_message").execute({ kind: "workspace", text: "$Echo please advise" }, { sessionID: novaSession })
    assert.match(posted.content, /Approval required/)
    const pending = await handlers.snapshot({ directory })
    const approvals = Object.values(pending.state.approvals) as any[]
    assert.equal(approvals.length, 3)
    for (const approval of approvals) assert.equal(approval.payload?.dispatchGroupID, groupID)
    for (const approval of approvals) {
      const resolved = await handlers.invoke({ directory, action: "approval.resolve", payload: { id: approval.id, approve: true } })
      assert.equal(resolved.ok, true)
    }
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.assigneeID === echo.id)
    })
    const after = await handlers.snapshot({ directory })
    const outside = Object.values(after.state.subtasks).filter((task: any) => task.assigneeID === echo.id) as any[]
    assert.ok(outside.length >= 1)
    for (const task of outside) assert.equal(task.dispatchGroupID, groupID)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("retry, restart, reassign, and cancel preserve dispatch group identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-group-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  for (const [id, name] of [["nova", "Nova"], ["sage", "Sage"]] as const) {
    await seed.saveAgent({ id, name, title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  }
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "nova", memberIDs: ["nova", "sage"], synthesis: false, archived: false, paused: true, nextSeq: 1, createdAt: 1, lastActiveAt: 1 })
  const seedTask = async (id: string) => {
    await seed.saveSubtask({
      id, workspaceID: "w", creatorType: "agent", creatorAgentID: "nova", assigneeID: "sage",
      title: id, instruction: id, mode: "research", state: "pending", stage: "initial", outcome: "pending",
      interrupted: false, awaitingChildren: false, attempts: 0, createdAt: 1, dispatchGroupID: "dispatch_preserved",
      workKind: "delegation", queueKey: `work:w:delegation:root:${id}`,
    })
  }
  for (const id of ["retry-me", "restart-me", "reassign-me", "cancel-me"]) await seedTask(id)
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const actions: Array<[string, any]> = [
      ["task.retry", { id: "retry-me" }],
      ["task.restart", { id: "restart-me" }],
      ["task.reassign", { id: "reassign-me", assigneeID: "nova" }],
      ["task.cancel", { id: "cancel-me" }],
    ]
    for (const [action, payload] of actions) {
      const result = await handlers.invoke({ directory, action, payload })
      assert.equal(result.ok, true)
    }
    const after = await handlers.snapshot({ directory })
    for (const id of ["retry-me", "restart-me", "reassign-me", "cancel-me"]) {
      assert.equal((after.state.subtasks as any)[id].dispatchGroupID, "dispatch_preserved")
    }
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("legacy rows resolve one deterministic root group after service load", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-group-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "nova", memberIDs: ["nova"], synthesis: false, archived: false, paused: true, nextSeq: 1, createdAt: 1, lastActiveAt: 1 })
  const base = {
    workspaceID: "w", creatorType: "user" as const, mode: "research" as const, state: "replied" as const,
    stage: "initial" as const, outcome: "succeeded" as const, interrupted: false, awaitingChildren: false,
    attempts: 1, createdAt: 1, finishedAt: Date.now(), repliedAt: Date.now(), workKind: "delegation" as const,
  }
  await seed.saveSubtask({ ...base, id: "legacy-root", assigneeID: "nova", title: "Root", instruction: "Root", queueKey: "work:w:delegation:user:root" })
  await seed.saveSubtask({
    ...base,
    id: "legacy-child",
    parentID: "legacy-root",
    creatorType: "agent",
    creatorAgentID: "nova",
    assigneeID: "nova",
    title: "Child",
    instruction: "Child",
    queueKey: "work:w:delegation:agent:child",
    state: "pending",
    outcome: "pending",
    repliedAt: undefined,
    finishedAt: undefined,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const snapshot = await handlers.snapshot({ directory })
    const expected = legacyDispatchGroupID("legacy-root")
    assert.equal((snapshot.state.subtasks as any)["legacy-root"].dispatchGroupID, expected)
    assert.equal((snapshot.state.subtasks as any)["legacy-child"].dispatchGroupID, expected)
    const group = snapshot.state.dispatchGroups[expected]
    assert.ok(group, "legacy work is reconciled into a ledger record")
    assert.equal(group.reconciled, true)
    assert.equal(group.usedHops, 1, "one non-completion legacy delegation is one hop")
    assert.ok(group.maxHops >= group.usedHops)
    assert.ok((group.commandMaxHops ?? 0) >= (group.commandUsedHops ?? 0))
    assert.equal(group.commandUsedHops, 1)
    // Live legacy work receives the remaining group budget, and nothing is
    // retroactively refused.
    const remaining = group.maxHops - group.usedHops
    for (const id of ["legacy-root", "legacy-child"]) {
      const task = (snapshot.state.subtasks as any)[id]
      if (task.state !== "replied") assert.equal(task.taskMaxHops, remaining)
    }
    assert.ok(ctx.storage, "the seeded store used the fake host storage")
    assert.ok((await handlers.snapshot({ directory })).state.dispatchGroups[expected], "reconciliation persists across snapshots")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("completion batches consolidate only within one dispatch group", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-group-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const { nova, sage, workspace } = await setupPair(directory, handlers)
    const kim = (await handlers.invoke({ directory, action: "agent.create", payload: { name: "Kim" } })).result
    await handlers.invoke({ directory, action: "workspace.update", payload: { id: workspace.id, memberIDs: [nova.id, sage.id, kim.id] } })
    const first = await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "First dispatch", recipientIDs: [sage.id, kim.id] } })
    assert.equal(first.ok, true)
    const second = await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "Second dispatch", recipientIDs: [sage.id, kim.id] } })
    assert.equal(second.ok, true)
    const groups = new Set<string>()
    let batches: any[] = []
    let lastSnapshot: any
    try {
      await waitFor(async () => {
        const next = await handlers.snapshot({ directory })
        lastSnapshot = next
        batches = Object.values(next.state.subtasks).filter((task: any) => task.handoff?.batch === true) as any[]
        if (batches.length !== 2) return false
        if (!batches.every((batch) => batch.handoff?.itemIDs?.length === 2)) return false
        for (const batch of batches) {
          groups.add(batch.dispatchGroupID)
          for (const itemID of batch.handoff.itemIDs) {
            if ((next.state.subtasks as any)[itemID]?.dispatchGroupID !== batch.dispatchGroupID) return false
          }
        }
        return true
      }, 15000)
    } catch {
      const summary = Object.values(lastSnapshot?.state?.subtasks ?? {}).map((task: any) => ({
        id: task.id,
        title: task.title,
        state: task.state,
        group: task.dispatchGroupID,
        completion: task.handoff?.completion,
        batch: task.handoff?.batch,
        batchedIn: task.handoff?.batchedIn,
        items: task.handoff?.itemIDs,
      }))
      assert.fail(`completion batches did not group correctly: ${JSON.stringify(summary)}`)
    }
    assert.equal(groups.size, 2)
    for (const group of groups) assert.ok(group)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})
