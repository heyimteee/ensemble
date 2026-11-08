import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { EnsembleV2Service } from "./service.ts"
import { startServiceForTest } from "./test-service.ts"
import { V2Store } from "./store.ts"

type Handlers = {
  snapshot: (input: unknown) => Promise<any>
  invoke: (input: unknown) => Promise<any>
}

function fakeContext() {
  const values = new Map<string, unknown>()
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

// Ticket #71: a non-leader turn that ends without an explicit handoff cannot
// finish silently — the server hands the finished content to the leader and
// the group shows `Handed to $Leader`. No second delegate is queued.
test("non-leader completion auto-handoffs to the leader with finished content", async () => {
  const directory = mkdtempSync(tmpdir() + "/ensemble-completion-")
  const { ctx, tools } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const { nova, sage, workspace } = await setupPair(directory, handlers)
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "Coordinate" } })
    const novaSession = await bindingSessionID(handlers, directory, nova.id)
    const delegated = await tools.get("delegate").execute({ assignee: "Sage", title: "Do research", instruction: "Check" }, { sessionID: novaSession })
    assert.match(delegated.content, /Delegated to Sage/)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some(
        // Synthesis reassigns the finished turn to the leader, so match the
        // turn by title/kind instead of the original assignee.
        (task: any) => task.title === "Do research" && task.workKind === "delegation" && task.state === "replied",
      )
    })
    const after = await handlers.snapshot({ directory })
    const completions = Object.values(after.state.subtasks).filter(
      (task: any) => task.workKind === "handoff" && task.handoff?.completion === true && task.handoff?.batch !== true,
    ) as any[]
    assert.equal(completions.length, 1)
    const hop = completions[0]
    assert.equal(hop.assigneeID, nova.id)
    assert.equal(hop.handoff?.recipientID, nova.id)
    assert.equal(hop.handoff?.senderID, sage.id)
    assert.ok(hop.queueKey.startsWith("completion:"))
    assert.ok(hop.instruction.includes("Finished the work."))
    // Ticket #73: the leader receives review work — sender, title, outcome —
    // not a verbatim forward of the finished title and reply.
    assert.equal(hop.title, "Do research")
    assert.match(hop.instruction, /Review/)
    assert.ok(hop.instruction.includes("$Sage"))
    assert.ok(!hop.instruction.startsWith("Do research\n\nFinished"))
    const texts = ((after.state.messages[workspace.id] ?? []) as any[]).map((message) => message.text)
    assert.ok(texts.some((text) => text.includes("Handed to $Nova")))
    // Ticket #73: concise system ack — no policy text, no ref, no agent bubble.
    const ack = ((after.state.messages[workspace.id] ?? []) as any[]).find((message: any) => message.text.includes("Handed to $Nova"))
    assert.ok(ack)
    assert.equal(ack.author, "system")
    assert.equal(ack.text, "Handed to $Nova · Do research")
    for (const message of (after.state.messages[workspace.id] ?? []) as any[]) {
      assert.ok(!message.text.includes("do not call ensemble_delegate"))
    }
    for (const text of texts) assert.ok(!text.includes("@Nova") && !text.includes("@Sage"))
    // Mandatory handoff never double-queues: no delegate child, one hop only.
    const delegations = Object.values(after.state.subtasks).filter((task: any) => task.workKind === "delegation")
    assert.equal(delegations.length, 2)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

// Ticket #71: an explicit handoff satisfies the obligation — no automatic
// hop is queued on top of it.
test("explicit handoff satisfies the end-of-turn obligation", async () => {
  const directory = mkdtempSync(tmpdir() + "/ensemble-completion-")
  const { ctx, tools } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const { nova, sage, workspace } = await setupPair(directory, handlers)
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "Coordinate" } })
    // Let the leader's root turn finish first so the delegation below is a
    // root task (asking depth 0): an explicit handoff from inside it is
    // allowed, which is exactly the obligation being tested.
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.state === "replied")
    })
    // Slow every native wait so Sage's run stays observable while the
    // explicit handoff is issued from inside it.
    ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 2500)) }
    const novaSession = await bindingSessionID(handlers, directory, nova.id)
    const delegated = await tools.get("delegate").execute({ assignee: "Sage", title: "Do research", instruction: "Check" }, { sessionID: novaSession })
    assert.match(delegated.content, /Delegated to Sage/)
    // Sage hands off explicitly from inside the run before it finishes.
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.runs ?? {}).some((run: any) => {
        const task = (next.state.subtasks as any)[run.subtaskID]
        return task?.assigneeID === sage.id && run.status === "running"
      })
    })
    const sageSession = await bindingSessionID(handlers, directory, sage.id)
    const { mkdirSync, writeFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    mkdirSync(join(directory, ".ensemble", "handoffs"), { recursive: true })
    writeFileSync(join(directory, ".ensemble", "handoffs", "ask.md"), "---\nensemble: handoff\ntask: Follow up\n---\n# Handoff\n")
    const asked = await tools.get("handoff").execute(
      { task: "Follow up", summary: "", path: ".ensemble/handoffs/ask.md", to: "Nova" },
      { sessionID: sageSession },
    )
    assert.match(asked.content, /Handed to \$Nova/)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some(
        // Synthesis reassigns the finished turn to the leader, so match the
        // turn by title/kind instead of the original assignee.
        (task: any) => task.title === "Do research" && task.workKind === "delegation" && task.state === "replied",
      )
    }, 25000)
    const after = await handlers.snapshot({ directory })
    const completions = Object.values(after.state.subtasks).filter(
      (task: any) => task.workKind === "handoff" && task.handoff?.completion === true && task.handoff?.batch !== true,
    )
    assert.equal(completions.length, 0)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

// Ticket #71: leader turns may end normally — no automatic handoff is forced.
test("leader turns terminate without a forced handoff", async () => {
  const directory = mkdtempSync(tmpdir() + "/ensemble-completion-")
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const { workspace } = await setupPair(directory, handlers)
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "Coordinate" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.state === "replied")
    })
    // Completions consolidate after the quiet window; a lone leader turn
    // must still show no completion hop afterwards.
    await new Promise((resolve) => setTimeout(resolve, 1400))
    const after = await handlers.snapshot({ directory })
    const completions = Object.values(after.state.subtasks).filter(
      (task: any) => task.workKind === "handoff" && task.handoff?.completion === true,
    )
    assert.equal(completions.length, 0)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

// Ticket #71: multiple pending completions for one recipient coalesce into a
// single consolidated review turn listing sender, title, outcome, and path
// per item; the leader decides each item and the batch closes only when all
// are decided.
test("two completions produce one batch review with per-item decisions", async () => {
  const directory = mkdtempSync(tmpdir() + "/ensemble-completion-")
  const { ctx, tools } = fakeContext()
  // Keep the leader's run live while the test issues its three direct tool
  // calls so every delegation inherits the command's dispatch group. Child
  // runs finish quickly; only the leader needs a long turn.
  ;(ctx.session as any).wait = async ({ sessionID }: any) => {
    await new Promise((resolve) => setTimeout(resolve, String(sessionID).includes("Nova") ? 2_000 : 5))
  }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const { nova, sage } = await setupPair(directory, handlers)
    const kim = (await handlers.invoke({ directory, action: "agent.create", payload: { name: "Kim" } })).result
    mkdirSync(`${directory}/second`, { recursive: true })
    const created = await handlers.invoke({
      directory,
      action: "workspace.create",
      payload: { name: "second", directory: `${directory}/second`, memberIDs: [nova.id, sage.id, kim.id], leaderID: nova.id },
    })
    const workspaceID = created.result.id
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID, text: "Coordinate" } })
    let novaSession = ""
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const binding = Object.values(next.state.bindings).find(
        (item: any) => item.agentID === nova.id && (item.workspaceID === workspaceID || item.workspaceID === workspaceID),
      ) as any
      if (!binding) return false
      novaSession = binding.sessionID
      return true
    })
    for (const [assignee, title] of [["Sage", "First work"], ["Kim", "Second work"], ["Sage", "Third work"]] as const) {
      const delegated = await tools.get("delegate").execute({ assignee, title, instruction: "Check" }, { sessionID: novaSession })
      assert.match(delegated.content, new RegExp(`Delegated to ${assignee}`))
    }
    let batch: any
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      batch = Object.values(next.state.subtasks).find((task: any) => task.workKind === "handoff" && task.handoff?.batch === true)
      return batch?.handoff?.itemIDs?.length === 3
    }, 15000)
    assert.equal(batch.assigneeID, nova.id)
    assert.equal(batch.title, "Review 3 completions")
    assert.ok(batch.dispatchGroupID, "a completion batch carries its dispatch group")
    assert.ok(batch.instruction.includes("$Sage"))
    assert.ok(batch.instruction.includes("$Kim"))
    assert.ok(batch.instruction.includes("First work"))
    assert.ok(batch.instruction.includes("ensemble_review"))
    for (const text of [batch.instruction]) assert.ok(!text.includes("@Sage") && !text.includes("@Kim"))
    const grouped = await handlers.snapshot({ directory })
    const items = batch.handoff.itemIDs.map((itemID: string) => (grouped.state.subtasks as any)[itemID])
    assert.equal(items.length, 3)
    for (const item of items) {
      assert.equal(item.parentID, batch.id)
      assert.equal(item.handoff?.batchedIn, batch.id)
      assert.equal(item.dispatchGroupID, batch.dispatchGroupID)
    }
    // Grouped completions never race the batch as direct hops: the batch
    // presentation parks in awaitingChildren while the items stay pending.
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return (next.state.subtasks as any)[batch.id]?.awaitingChildren === true
    })
    const parked = await handlers.snapshot({ directory })
    for (const item of batch.handoff.itemIDs) {
      assert.equal((parked.state.subtasks as any)[item].state, "pending")
    }
    // Partial disposition keeps the batch open; full disposition closes it.
    const [first, secondItem, third] = batch.handoff.itemIDs
    const partial = await tools.get("review").execute(
      { batch: batch.id, decisions: [{ item: first, action: "end" }] },
      { sessionID: novaSession },
    )
    assert.match(partial.content, /ended/)
    assert.match(partial.content, /Batch stays open: 1 of 3 decided/)
    let open = await handlers.snapshot({ directory })
    assert.notEqual((open.state.subtasks as any)[batch.id].state, "replied")
    const full = await tools.get("review").execute(
      {
        batch: batch.id,
        decisions: [
          { item: secondItem, action: "dismiss" },
          { item: third, action: "delegate", assignee: "Kim", note: "Take it from here" },
        ],
      },
      { sessionID: novaSession },
    )
    assert.match(full.content, /dismissed/)
    assert.match(full.content, /delegated to \$Kim/)
    assert.match(full.content, /Batch closed: every item decided/)
    const after = await handlers.snapshot({ directory })
    const rows = after.state.subtasks as any
    assert.equal(rows[first].state, "replied")
    assert.equal(rows[secondItem].handoff?.decided, "dismissed")
    assert.ok(rows[secondItem].stoppedAt !== undefined)
    assert.equal(rows[third].handoff?.decided, "delegated")
    assert.equal(rows[batch.id].state, "replied")
    const delegation = Object.values(rows).find((task: any) => task.workKind === "delegation" && task.title === rows[third].title && task.assigneeID === kim.id)
    assert.ok(delegation)
    // A review follow-up is part of the same dispatch: the delegated task
    // inherits the batch's group instead of starting a phantom dispatch.
    assert.equal((delegation as any).dispatchGroupID, batch.dispatchGroupID)
    const texts = ((after.state.messages[workspaceID] ?? []) as any[]).map((message) => message.text)
    assert.ok(texts.some((text) => text.includes("Handed to $Nova")))
    assert.ok(texts.some((text) => text.includes("Review closed: Review 3 completions")))
    for (const text of texts) assert.ok(!text.includes("@Sage") && !text.includes("@Kim") && !text.includes("@Nova"))
    // Ticket #73: every handoff ack in the transcript is a concise system
    // line — no policy text, no correlation ref, no agent bubble.
    for (const message of (after.state.messages[workspaceID] ?? []) as any[]) {
      if (!message.text.includes("Handed to $")) continue
      assert.equal(message.author, "system")
      assert.ok(!message.text.includes("do not call ensemble_delegate"))
      assert.ok(!message.text.includes("(ref handoff_"))
    }
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

// Ticket #71: a non-leader batch recipient cannot end the batch silently —
// full disposition hands it onward (default leader). Delegate stays
// leader-only, so review never smuggles in delegate-after-handoff.
test("non-leader batch review hands onward to the leader on full disposition", async () => {
  const directory = mkdtempSync(tmpdir() + "/ensemble-completion-")
  const { ctx, tools } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  for (const [id, name] of [["nova", "Nova"], ["sage", "Sage"]] as const) {
    await seed.saveAgent({ id, name, title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  }
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "nova", memberIDs: ["nova", "sage"], synthesis: true, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1 })
  await seed.saveBinding({ workspaceID: "w", agentID: "sage", sessionID: "sess_sage", kind: "workspace", directory, agentVersion: 1, updatedAt: 1 })
  await seed.saveSubtask({
    id: "batch-1", workspaceID: "w", creatorType: "agent", creatorAgentID: "nova", assigneeID: "sage",
    title: "Review 2 completions", instruction: "Review 2 completions", mode: "research", state: "pending",
    stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: true,
    attempts: 0, createdAt: 1, workKind: "handoff", queueKey: "batch:w:sage:seed", dispatchGroupID: "dispatch_batch",
    handoff: { correlationID: "batch_seed", senderID: "nova", recipientID: "sage", depth: 1, completion: true, batch: true, chain: ["nova"], itemIDs: ["i1", "i2"] },
  })
  for (const [id, title] of [["i1", "First work"], ["i2", "Second work"]] as const) {
    await seed.saveSubtask({
      id, workspaceID: "w", parentID: "batch-1", creatorType: "agent", creatorAgentID: "sage", assigneeID: "sage",
      title, instruction: title, mode: "research", state: "pending",
      stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
      attempts: 0, createdAt: 1, workKind: "handoff", queueKey: `completion:w:fin:${id}`, dispatchGroupID: "dispatch_batch",
      handoff: { correlationID: `corr_${id}`, senderID: "nova", recipientID: "sage", depth: 1, parentID: "batch-1", completion: true, chain: ["nova"], batchedIn: "batch-1" },
    })
  }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    // Delegate is leader-only: the refusal leaves the item undecided and the
    // batch open — never delegate-after-handoff by another name.
    const refused = await tools.get("review").execute(
      { batch: "batch-1", decisions: [{ item: "i1", action: "delegate", assignee: "Nova" }] },
      { sessionID: "sess_sage" },
    )
    assert.match(refused.content, /only the workspace leader/)
    assert.match(refused.content, /Batch stays open: 0 of 2 decided/)
    let mid = await handlers.snapshot({ directory })
    assert.notEqual((mid.state.subtasks as any)["batch-1"].state, "replied")
    assert.equal((mid.state.subtasks as any)["i1"].handoff?.decided, undefined)
    // Full disposition by a non-leader hands the batch onward to the leader.
    const done = await tools.get("review").execute(
      { batch: "batch-1", decisions: [{ item: "i1", action: "end" }, { item: "i2", action: "dismiss" }] },
      { sessionID: "sess_sage" },
    )
    assert.match(done.content, /Batch handed to \$Nova/)
    const after = await handlers.snapshot({ directory })
    const rows = after.state.subtasks as any
    assert.equal(rows["batch-1"].state, "replied")
    const onward = Object.values(rows).find(
      (task: any) => task.workKind === "handoff" && task.handoff?.completion === true && task.handoff?.batch !== true && task.assigneeID === "nova" && task.parentID === "batch-1",
    ) as any
    assert.ok(onward)
    assert.ok(onward.queueKey.startsWith("completion:"))
    assert.ok(onward.instruction.includes("Decided by $Sage"))
    // The onward completion hop stays inside the batch's dispatch group.
    assert.equal(onward.dispatchGroupID, "dispatch_batch")
    const texts = ((after.state.messages.w ?? []) as any[]).map((message: any) => message.text)
    assert.ok(texts.some((text) => text.includes("Handed to $Nova")))
    for (const text of texts) assert.ok(!text.includes("@Sage") && !text.includes("@Nova"))
    // Ticket #73: the onward ack is a concise system line — no policy text,
    // no correlation ref, no agent bubble.
    const onwardAck = ((after.state.messages.w ?? []) as any[]).find((message: any) => message.text.includes("Handed to $Nova"))
    assert.ok(onwardAck)
    assert.equal(onwardAck.author, "system")
    assert.ok(!onwardAck.text.includes("do not call ensemble_delegate"))
    assert.ok(!onwardAck.text.includes("(ref handoff_"))
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

// Ticket #71: loop guards force a termination fallback at the cap — a batch
// whose chain is already full closes with a visible notice and queues no
// onward hop, so mandatory handoff cannot loop forever or duplicate work.
test("onward handoff terminates at the chain depth cap", async () => {
  const directory = mkdtempSync(tmpdir() + "/ensemble-completion-")
  const { ctx, tools } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  for (const [id, name] of [["nova", "Nova"], ["sage", "Sage"]] as const) {
    await seed.saveAgent({ id, name, title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  }
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "nova", memberIDs: ["nova", "sage"], synthesis: true, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1 })
  await seed.saveBinding({ workspaceID: "w", agentID: "sage", sessionID: "sess_sage", kind: "workspace", directory, agentVersion: 1, updatedAt: 1 })
  await seed.saveSubtask({
    id: "batch-9", workspaceID: "w", creatorType: "agent", creatorAgentID: "nova", assigneeID: "sage",
    title: "Review 1 completion", instruction: "Review 1 completion", mode: "research", state: "pending",
    stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: true,
    attempts: 0, createdAt: 1, workKind: "handoff", queueKey: "batch:w:sage:cap",
    handoff: { correlationID: "batch_cap", senderID: "nova", recipientID: "sage", depth: 3, completion: true, batch: true, chain: ["nova", "kim", "ari"], itemIDs: ["i9"] },
  })
  await seed.saveSubtask({
    id: "i9", workspaceID: "w", parentID: "batch-9", creatorType: "agent", creatorAgentID: "sage", assigneeID: "sage",
    title: "Capped work", instruction: "Capped work", mode: "research", state: "pending",
    stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 0, createdAt: 1, workKind: "handoff", queueKey: "completion:w:fin:i9",
    handoff: { correlationID: "corr_i9", senderID: "nova", recipientID: "sage", depth: 3, parentID: "batch-9", completion: true, chain: ["nova", "kim", "ari"], batchedIn: "batch-9" },
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const done = await tools.get("review").execute(
      { batch: "batch-9", decisions: [{ item: "i9", action: "end" }] },
      { sessionID: "sess_sage" },
    )
    assert.match(done.content, /depth cap/)
    const after = await handlers.snapshot({ directory })
    const rows = after.state.subtasks as any
    assert.equal(rows["batch-9"].state, "replied")
    const onward = Object.values(rows).filter(
      (task: any) => task.workKind === "handoff" && task.handoff?.completion === true && task.handoff?.batch !== true && task.handoff?.batchedIn === undefined && task.parentID === "batch-9",
    )
    assert.equal(onward.length, 0)
    const texts = ((after.state.messages.w ?? []) as any[]).map((message: any) => message.text)
    assert.ok(texts.some((text) => text.includes("Completion closed for $Sage")))
    for (const text of texts) assert.ok(!text.includes("@Sage") && !text.includes("@Nova"))
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})
