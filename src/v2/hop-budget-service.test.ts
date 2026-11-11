import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { EnsembleV2Service } from "./service.ts"
import { seedLegacySettings, startServiceForTest } from "./test-service.ts"
import type { LogEntry } from "./logging.ts"

type Handlers = {
  snapshot: (input: unknown) => Promise<any>
  invoke: (input: unknown) => Promise<any>
  "logs.recent": (input: unknown) => Promise<{ entries: LogEntry[] }>
}

function fakeContext() {
  const values = new Map<string, unknown>()
  seedLegacySettings(values)
  const tools = new Map<string, any>()
  const instructions: Array<{ sessionID: string; key: string; value: string }> = []
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
      create: async ({ title }: any) => ({ data: { id: `session_${title}_${Math.random().toString(36).slice(2, 8)}`, title } }),
      instructions: { entry: { put: async (input: any) => { instructions.push(input) } } },
      switchModel: async () => undefined,
      prompt: async () => undefined,
      wait: async () => { await new Promise((resolve) => setTimeout(resolve, 1500)) },
      context: async () => ({
        data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "Finished the work." }] }],
      }),
      update: async () => undefined,
      interrupt: async () => undefined,
      remove: async () => undefined,
      move: async ({ sessionID, directory }: any) => ({ data: { id: sessionID, directory } }),
      command: async () => ({ data: {} }),
    },
    tool: { transform: async (factory: any) => factory({ namespace() {}, add(tool: any) { tools.set(tool.name, tool) } }) },
    rpc: {
      register: async (_schema: unknown, value: any) => {
        handlers.snapshot = value.snapshot
        handlers.invoke = value.invoke
        handlers["logs.recent"] = value["logs.recent"]
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
  return { ctx, handlers: handlers as Handlers, tools, instructions }
}

async function waitFor(check: () => Promise<boolean>, timeout = 8000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for condition")
}

const handoffFile = (directory: string, name: string, task: string): string => {
  mkdirSync(join(directory, ".ensemble", "handoffs"), { recursive: true })
  writeFileSync(join(directory, ".ensemble", "handoffs", name), `---\nensemble: handoff\ntask: ${task}\n---\n# Handoff\n`)
  return `.ensemble/handoffs/${name}`
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

/** Start a command and wait until the leader's run is live in its group. */
async function liveCommand(directory: string, handlers: Handlers, workspaceID: string, leaderID: string, text: string): Promise<{ sessionID: string; groupID: string }> {
  await handlers.invoke({ directory, action: "message.send", payload: { workspaceID, text } })
  let sessionID = ""
  let groupID = ""
  await waitFor(async () => {
    const next = await handlers.snapshot({ directory })
    const binding = Object.values(next.state.bindings).find((item: any) => item.workspaceID === workspaceID && item.agentID === leaderID) as any
    if (!binding) return false
    sessionID = binding.sessionID
    const root = Object.values(next.state.subtasks).find((task: any) => task.title === text) as any
    if (!root?.dispatchGroupID) return false
    groupID = root.dispatchGroupID
    return Object.values(next.state.runs ?? {}).some((run: any) => run.subtaskID === root.id && run.status === "running")
  })
  return { sessionID, groupID }
}

async function groupUsed(handlers: Handlers, directory: string, groupID: string): Promise<{ used: number; commandUsed: number }> {
  const next = await handlers.snapshot({ directory })
  const group = next.state.dispatchGroups[groupID]
  return { used: group.usedHops, commandUsed: group.commandUsedHops }
}

test("ticket161: a five-hop relay completes inside the default 8-hop group", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-hops-"))
  const { ctx, handlers, tools } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    const { nova, sage, workspace } = await setupPair(directory, handlers)
    const { groupID } = await liveCommand(directory, handlers, workspace.id, nova.id, "Relay")
    const names: Record<string, string> = { [nova.id]: "Nova", [sage.id]: "Sage" }
    let senderID = nova.id
    for (let index = 0; index < 5; index++) {
      const recipient = senderID === nova.id ? sage.id : nova.id
      const task = `Scene ${index + 1}`
      const path = handoffFile(directory, `relay-${index}.md`, task)
      const senderSession = await bindingSessionID(handlers, directory, senderID)
      const result = await tools.get("handoff").execute({ task, summary: "", path, to: names[recipient], maxHops: 1 }, { sessionID: senderSession })
      assert.match(result.content, /Handed to \$/, `hop ${index + 1}: ${result.content}`)
      assert.match(result.content, /Remaining — task .* group .* command .* depth /, "successful results show remaining budgets")
      // Let the recipient's run for this hop become live before the next
      // leg: the task budget is local to that work item.
      let hopID = ""
      await waitFor(async () => {
        const next = await handlers.snapshot({ directory })
        const hop = Object.values(next.state.subtasks).find((item: any) => item.title === task && item.workKind === "handoff") as any
        if (!hop) return false
        hopID = hop.id
        return Object.values(next.state.runs ?? {}).some((run: any) => run.subtaskID === hopID && run.status === "running")
      })
      senderID = recipient
    }
    const after = await handlers.snapshot({ directory })
    const explicit = Object.values(after.state.subtasks).filter((task: any) => task.workKind === "handoff" && task.handoff?.completion !== true) as any[]
    assert.equal(explicit.length, 5, "five relay hops landed")
    assert.equal(after.state.dispatchGroups[groupID].usedHops, 5)
    assert.equal(after.state.dispatchGroups[groupID].commandUsedHops, 5)
    for (const hop of explicit) {
      assert.equal(hop.dispatchGroupID, groupID, "every relay hop stays in the command group")
      assert.equal(hop.taskMaxHops, 1, "each sender granted the next recipient one dispatch")
      assert.ok(hop.dispatchDepth >= 1, "every hop records its unified depth")
    }
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket161: zero task budget answers and completes but cannot create new work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-hops-"))
  const { ctx, handlers, tools } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    const { nova, sage, workspace } = await setupPair(directory, handlers)
    const { sessionID: novaSession, groupID } = await liveCommand(directory, handlers, workspace.id, nova.id, "One shot")
    const delegated = await tools.get("delegate").execute({ assignee: "Sage", title: "Answer only", instruction: "Check", maxHops: 0 }, { sessionID: novaSession })
    assert.match(delegated.content, /Delegated to Sage/)
    const before = await handlers.snapshot({ directory })
    const child = Object.values(before.state.subtasks).find((task: any) => task.title === "Answer only") as any
    assert.equal(child.taskMaxHops, 0)
    const sageSession = await bindingSessionID(handlers, directory, sage.id)
    const path = handoffFile(directory, "deeper.md", "Deeper work")
    const refused = await tools.get("handoff").execute({ task: "Deeper work", summary: "", path, to: "Nova", maxHops: 1 }, { sessionID: sageSession })
    assert.match(refused.content, /Handoff refused: your task budget is exhausted \(0\/0 direct dispatches\)/)
    assert.match(refused.content, /Return your result to the leader/)
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.dispatchGroups[groupID].usedHops, 1, "the refused dispatch spends nothing")
    assert.equal(Object.values(after.state.subtasks).filter((task: any) => task.workKind === "handoff" && task.handoff?.completion !== true).length, 0)
    // The zero-budget recipient still finishes its turn. The leader asked for
    // it, so the parent turn's synthesis is the delivery: ticket #237 skips
    // the redundant completion hop and the task budget is untouched.
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const child = Object.values(next.state.subtasks).find((task: any) => task.title === "Answer only") as any
      return child?.state === "replied"
    }, 15_000)
    const completed = await handlers.snapshot({ directory })
    assert.equal(completed.state.dispatchGroups[groupID].usedHops, 1, "the finished turn spends no completion hop")
    assert.equal(
      Object.values(completed.state.subtasks).filter((task: any) => task.handoff?.completion === true && task.handoff?.senderID === sage.id).length,
      0,
      "leader-asked work skips the completion hop",
    )
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket161: missing and invalid maxHops fail with actionable copy and no work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-hops-"))
  const { ctx, handlers, tools } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    const { nova, workspace } = await setupPair(directory, handlers)
    const { sessionID, groupID } = await liveCommand(directory, handlers, workspace.id, nova.id, "Validate")
    const missing = await tools.get("delegate").execute({ assignee: "Sage", title: "No budget", instruction: "Check" }, { sessionID })
    assert.match(missing.content, /ensemble_delegate requires maxHops/)
    assert.match(missing.content, /maxHops: 0/)
    const path = handoffFile(directory, "invalid.md", "Invalid budget")
    const invalid = await tools.get("handoff").execute({ task: "Invalid budget", summary: "", path, to: "Sage", maxHops: -1 }, { sessionID })
    assert.match(invalid.content, /ensemble_handoff maxHops must be a non-negative integer/)
    assert.match(invalid.content, /maxHops: 0/)
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.dispatchGroups[groupID].usedHops, 0)
    assert.equal(Object.values(after.state.subtasks).filter((task: any) => task.title === "No budget" || task.title === "Invalid budget").length, 0)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket161: idempotent replay, retries, restarts, and cancellation never spend or refund a hop", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-hops-"))
  const { ctx, handlers, tools } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    const { nova, workspace } = await setupPair(directory, handlers)
    const { sessionID, groupID } = await liveCommand(directory, handlers, workspace.id, nova.id, "Replay")
    const first = await tools.get("delegate").execute({ assignee: "Sage", title: "Once", instruction: "Check", maxHops: 1 }, { sessionID })
    assert.match(first.content, /Delegated to Sage/)
    const replay = await tools.get("delegate").execute({ assignee: "Sage", title: "Once", instruction: "Check", maxHops: 1 }, { sessionID })
    assert.match(replay.content, /Already delegated to Sage/)
    let after = await handlers.snapshot({ directory })
    assert.equal(after.state.dispatchGroups[groupID].usedHops, 1, "an idempotent replay consumes nothing")
    const task = Object.values(after.state.subtasks).find((item: any) => item.title === "Once") as any
    assert.ok(task)
    await handlers.invoke({ directory, action: "task.retry", payload: { id: task.id } })
    await handlers.invoke({ directory, action: "task.restart", payload: { id: task.id } })
    await handlers.invoke({ directory, action: "task.cancel", payload: { id: task.id } })
    after = await handlers.snapshot({ directory })
    assert.equal(after.state.dispatchGroups[groupID].usedHops, 1, "retry/restart/cancel never spend or refund")
    assert.equal(after.state.dispatchGroups[groupID].commandUsedHops, 1)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket161: two concurrent dispatches at one remaining hop produce exactly one work item", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-hops-"))
  const { ctx, handlers, tools } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    const { nova, workspace } = await setupPair(directory, handlers)
    const { sessionID, groupID } = await liveCommand(directory, handlers, workspace.id, nova.id, "Concurrent")
    for (let index = 0; index < 7; index++) {
      const warmed = await tools.get("delegate").execute({ assignee: "Sage", title: `Warm ${index}`, instruction: "Check", maxHops: 0 }, { sessionID })
      assert.match(warmed.content, /Delegated to Sage/)
    }
    assert.deepEqual(await groupUsed(handlers, directory, groupID), { used: 7, commandUsed: 7 })
    const [left, right] = await Promise.all([
      tools.get("delegate").execute({ assignee: "Sage", title: "Left", instruction: "Check", maxHops: 0 }, { sessionID }),
      tools.get("delegate").execute({ assignee: "Sage", title: "Right", instruction: "Check", maxHops: 0 }, { sessionID }),
    ])
    const accepted = [left, right].filter((result) => result.content.includes("Delegated to Sage"))
    const refused = [left, right].filter((result) => result.content.includes("Delegation refused"))
    assert.equal(accepted.length, 1, "exactly one concurrent dispatch wins the last hop")
    assert.equal(refused.length, 1)
    assert.match(refused[0]!.content, /(task budget|dispatch group) is exhausted \(8\/8/)
    assert.match(refused[0]!.content, /Return your result to the leader/)
    assert.deepEqual(await groupUsed(handlers, directory, groupID), { used: 8, commandUsed: 8 })
    const after = await handlers.snapshot({ directory })
    const winners = ["Left", "Right"].filter((title) => Object.values(after.state.subtasks).some((task: any) => task.title === title && task.creatorType === "agent"))
    assert.equal(winners.length, 1, "exactly one work item was created")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket161: a pending approval whose group is exhausted is refused visibly without work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-hops-"))
  const { ctx, handlers, tools } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    const { nova, workspace } = await setupPair(directory, handlers)
    const echo = (await handlers.invoke({ directory, action: "agent.create", payload: { name: "Echo" } })).result
    const { sessionID, groupID } = await liveCommand(directory, handlers, workspace.id, nova.id, "Approval")
    const path = handoffFile(directory, "outside.md", "Outside help")
    const asked = await tools.get("handoff").execute({ task: "Outside help", summary: "", path, to: "Echo", maxHops: 1 }, { sessionID })
    assert.match(asked.content, /Approval required/)
    const pending = await handlers.snapshot({ directory })
    const approval = Object.values(pending.state.approvals)[0] as any
    assert.equal(approval.payload.maxHops, 1, "the approval carries the granted task budget")
    for (let index = 0; index < 8; index++) {
      const warmed = await tools.get("delegate").execute({ assignee: "Sage", title: `Fill ${index}`, instruction: "Check", maxHops: 0 }, { sessionID })
      assert.match(warmed.content, /Delegated to Sage/, warmed.content)
    }
    assert.deepEqual(await groupUsed(handlers, directory, groupID), { used: 8, commandUsed: 8 })
    const resolved = await handlers.invoke({ directory, action: "approval.resolve", payload: { id: approval.id, approve: true } })
    assert.equal(resolved.ok, true)
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.approvals[approval.id].status, "approved")
    const outside = Object.values(after.state.subtasks).filter((task: any) => task.assigneeID === echo.id)
    assert.equal(outside.length, 0, "an unaffordable approval creates no work")
    const messages = (after.state.messages[workspace.id] ?? []) as any[]
    assert.ok(messages.some((message) => message.author === "system" && message.text.startsWith("Handoff refused: the dispatch group is exhausted (8/8 hops)")))
    assert.equal(after.state.dispatchGroups[groupID].usedHops, 8, "the refusal spends no hop")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket161: turn context shows group, command, task, and depth budgets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-hops-"))
  const { ctx, handlers, instructions } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    const { workspace } = await setupPair(directory, handlers)
    await liveCommand(directory, handlers, workspace.id, (await handlers.snapshot({ directory })).state.workspaces[workspace.id].leaderID, "Context")
    const context = instructions.filter((entry) => entry.key === "ensemble.v2.context").map((entry) => entry.value).find((value) => value.includes("<ensemble_dispatch_budget"))
    assert.ok(context, "the run context carries a dispatch budget block")
    assert.match(context!, /group_used="0"/)
    assert.match(context!, /group_max="8"/)
    assert.match(context!, /command_remaining="24"/)
    assert.match(context!, /task_used="0"/)
    assert.match(context!, /depth_max="8"/)
    assert.match(context!, /continuation="0"/)
    assert.match(context!, /requires maxHops/)
    assert.match(context!, /maxHops: 0/)
    assert.match(context!, /cannot raise these ceilings/i)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket161: hop consumption and refusal log IDs, counts, and reason codes without content", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-hops-"))
  const { ctx, handlers, tools } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    const { nova, sage, workspace } = await setupPair(directory, handlers)
    const { sessionID, groupID } = await liveCommand(directory, handlers, workspace.id, nova.id, "Logging")
    const secretTitle = "SECRET_TITLE_9f1"
    const secretInstruction = "SECRET_INSTRUCTION_9f1"
    await tools.get("delegate").execute({ assignee: "Sage", title: secretTitle, instruction: secretInstruction, maxHops: 0 }, { sessionID })
    const consumed = await handlers["logs.recent"]({ directory, cat: "dispatch", event: "dispatch.hop.consumed", limit: 20 })
    const row = consumed.entries.find((entry) => entry.dispatchGroupID === groupID) as any
    assert.ok(row, "a consumed hop is logged")
    assert.equal(row.level, "info")
    assert.equal(row.usedHops, 1)
    assert.equal(row.maxHops, 8)
    assert.equal(row.groupRemaining, 7)
    assert.equal(row.commandUsedHops, 1)
    assert.equal(row.commandMaxHops, 24)
    assert.equal(row.taskMaxHops, 0)
    assert.equal(row.dispatchDepth, 1)
    assert.ok(row.taskID)
    assert.ok(row.recipientID)
    assert.ok(row.actorID)
    assert.equal(row.workKind, "delegation")
    for (const forbidden of ["title", "instruction", "path", "content", "text"] as const) {
      assert.equal(forbidden in row, false, `dispatch events carry no ${forbidden}`)
    }
    const serialized = JSON.stringify(consumed.entries)
    assert.ok(!serialized.includes(secretTitle), "task titles never enter dispatch events")
    assert.ok(!serialized.includes(secretInstruction), "instructions never enter dispatch events")

    const sageSession = await bindingSessionID(handlers, directory, sage.id)
    const refusedPath = handoffFile(directory, "refused.md", "SECRET_REFUSED")
    const refused = await tools.get("handoff").execute({ task: "SECRET_REFUSED", summary: "", path: refusedPath, to: "Nova", maxHops: 7 }, { sessionID: sageSession })
    assert.match(refused.content, /task budget is exhausted/)
    const refusals = await handlers["logs.recent"]({ directory, cat: "dispatch", event: "dispatch.hop.refused", limit: 20 })
    const refusal = refusals.entries.find((entry) => entry.dispatchGroupID === groupID) as any
    assert.ok(refusal, "a refused hop is logged")
    assert.equal(refusal.level, "warn")
    assert.equal(refusal.reason, "task-exhausted")
    assert.equal(refusal.refusedLayer, "task")
    assert.equal(refusal.refusedUsed, 0)
    assert.ok(!JSON.stringify(refusals.entries).includes("SECRET_REFUSED"))
    const failureRows = await handlers["logs.recent"]({ directory, cat: "failure", limit: 20 })
    assert.equal(
      failureRows.entries.some((entry: any) => entry.dispatchGroupID === groupID),
      false,
      "a controlled budget refusal is not a generic task failure",
    )
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket159: concurrent identical delegates create one work item and consume one hop", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-hops-"))
  const { ctx, handlers, tools } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    const { nova, workspace } = await setupPair(directory, handlers)
    const { sessionID, groupID } = await liveCommand(directory, handlers, workspace.id, nova.id, "Concurrent command")
    const input = { assignee: "Sage", title: "Concurrent ask", instruction: "Check", maxHops: 0 }
    const [first, second] = await Promise.all([
      tools.get("delegate").execute(input, { sessionID }),
      tools.get("delegate").execute(input, { sessionID }),
    ])
    assert.match(first.content, /Delegated to Sage|Already delegated to Sage/)
    assert.match(second.content, /Delegated to Sage|Already delegated to Sage/)

    const snapshot = await handlers.snapshot({ directory })
    const rows = Object.values(snapshot.state.subtasks).filter((task: any) => task.title === "Concurrent ask")
    assert.equal(rows.length, 1, "the serialized queue-key admission created one work item")
    assert.equal(snapshot.state.dispatchGroups[groupID].usedHops, 1)
    assert.equal(snapshot.state.dispatchGroups[groupID].commandUsedHops, 1)
    const consumed = await handlers["logs.recent"]({ directory, cat: "dispatch", event: "dispatch.hop.consumed", limit: 20 })
    assert.equal(consumed.entries.filter((entry: any) => entry.dispatchGroupID === groupID).length, 1, "one consumed hop row")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket161: peer turns and synthesis do not consume hops", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-hops-"))
  const { ctx, handlers, tools } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    const { nova, workspace } = await setupPair(directory, handlers)
    const { sessionID, groupID } = await liveCommand(directory, handlers, workspace.id, nova.id, "Chatter")
    const posted = await tools.get("send_message").execute({ kind: "workspace", text: "$Sage quick question" }, { sessionID })
    assert.match(posted.content, /Asked \$Sage|Posted/)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.workKind === "turn" && task.dispatchGroupID === groupID)
    })
    let after = await handlers.snapshot({ directory })
    assert.equal(after.state.dispatchGroups[groupID].usedHops, 0, "a peer turn is outside the hop budget")
    await tools.get("delegate").execute({ assignee: "Sage", title: "Consume one", instruction: "Check", maxHops: 0 }, { sessionID })
    after = await handlers.snapshot({ directory })
    assert.equal(after.state.dispatchGroups[groupID].usedHops, 1)
    // Synthesis reuses the root row and never spends a hop.
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const root = Object.values(next.state.subtasks).find((task: any) => task.title === "Chatter") as any
      return root?.stage === "synthesis" || root?.state === "replied"
    }, 15_000)
    const synthesized = await handlers.snapshot({ directory })
    assert.equal(synthesized.state.dispatchGroups[groupID].usedHops, 1)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})
