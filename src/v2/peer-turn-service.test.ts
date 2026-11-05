import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { EnsembleV2Service } from "./service.ts"
import { V2Store } from "./store.ts"

type Handlers = {
  snapshot: (input: unknown) => Promise<any>
  invoke: (input: unknown) => Promise<any>
}

function fakeContext(sharedValues?: Map<string, unknown>) {
  const values = sharedValues ?? new Map<string, unknown>()
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

async function waitFor(check: () => Promise<boolean>, timeout = 5000): Promise<void> {
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

test("a $mention peer turn runs to completed with asking/answered attribution and one reply", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-peer-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
  const handlers = service.handlers()
  try {
    const { nova, sage, workspace } = await setupPair(directory, handlers)
    const sent = await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "$Sage please summarize" } })
    assert.equal(sent.ok, true)
    assert.deepEqual(sent.result.recipients, [sage.id])
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.workKind === "turn" && task.state === "replied")
    })
    const after = await handlers.snapshot({ directory })
    const turns = Object.values(after.state.subtasks).filter((task: any) => task.workKind === "turn") as any[]
    assert.equal(turns.length, 1)
    const turn = turns[0]
    assert.equal(turn.assigneeID, sage.id)
    assert.equal(turn.creatorType, "user")
    assert.equal(turn.outcome, "succeeded")
    assert.equal(turn.turn?.askerKind, "user")
    assert.ok(turn.turn?.correlationID)
    assert.equal(turn.turn?.answeredByID, sage.id)
    // No leader fallback for the turn itself: Nova never takes over a $Sage
    // mention — the only leader work is the mandatory completion handoff
    // (ticket #71) carrying Sage's finished reply.
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.assigneeID === nova.id && task.handoff?.completion === true)
    })
    const completed = await handlers.snapshot({ directory })
    assert.ok(!Object.values(completed.state.subtasks).some((task: any) => task.assigneeID === nova.id && task.handoff?.completion !== true))
    const completion = Object.values(completed.state.subtasks).find((task: any) => task.assigneeID === nova.id && task.handoff?.completion === true) as any
    assert.ok(completion)
    assert.ok(completion.instruction.includes("OK"))
    const messages = (after.state.messages[workspace.id] ?? []) as any[]
    const texts = messages.map((message) => message.text)
    assert.ok(texts.includes("$Sage please summarize"))
    const askLine = messages.find((message) => message.taskID === turn.id)
    assert.ok(askLine)
    assert.equal(askLine.correlationID, turn.turn.correlationID)
    const replies = messages.filter((message) => message.correlationID === turn.turn.correlationID && message.agentID === sage.id)
    // The recipient's reply is the relay: exactly one answer row, no second leg.
    assert.equal(replies.length, 1)
    assert.equal(replies[0].text, "OK")
    assert.ok(!texts.some((text) => text.includes("@Sage") || text.includes("@sage")))
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("unmentioned messages still go only to the leader", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-peer-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
  const handlers = service.handlers()
  try {
    const { nova, sage, workspace } = await setupPair(directory, handlers)
    const sent = await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "hello all" } })
    assert.equal(sent.ok, true)
    assert.deepEqual(sent.result.recipients, [nova.id])
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.state === "replied")
    })
    const after = await handlers.snapshot({ directory })
    assert.ok(!Object.values(after.state.subtasks).some((task: any) => task.assigneeID === sage.id))
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("an unknown mention beside a valid one refuses loudly without aborting the peer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-peer-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
  const handlers = service.handlers()
  try {
    const { sage, workspace } = await setupPair(directory, handlers)
    const sent = await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "$Sage and $Ghost go" } })
    assert.equal(sent.ok, true)
    assert.deepEqual(sent.result.recipients, [sage.id])
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.workKind === "turn" && task.state === "replied")
    })
    const after = await handlers.snapshot({ directory })
    assert.equal(Object.values(after.state.subtasks).filter((task: any) => task.workKind === "turn").length, 1)
    const texts = ((after.state.messages[workspace.id] ?? []) as any[]).map((message) => message.text)
    assert.ok(texts.some((text) => text.includes("Peer turn refused: $Ghost")))
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a purely unknown mention fails loudly with a visible refusal and no leader fallback", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-peer-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
  const handlers = service.handlers()
  try {
    const { workspace } = await setupPair(directory, handlers)
    const response = await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "$Ghost take a look" } })
    assert.equal(response.ok, false)
    assert.equal(response.error?.code, "unknown_member")
    assert.match(response.error?.message ?? "", /\$Ghost/)
    const after = await handlers.snapshot({ directory })
    assert.equal(Object.values(after.state.subtasks).length, 0)
    const texts = ((after.state.messages[workspace.id] ?? []) as any[]).map((message) => message.text)
    assert.ok(texts.some((text) => text.includes("Peer turn refused: $Ghost")))
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("an archived member mention fails loudly instead of routing to the leader", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-peer-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
  const handlers = service.handlers()
  try {
    const { nova, sage, workspace } = await setupPair(directory, handlers)
    const archived = await handlers.invoke({ directory, action: "agent.archive", payload: { id: sage.id } })
    assert.equal(archived.ok, true)
    const response = await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "$Sage take a look" } })
    assert.equal(response.ok, false)
    assert.equal(response.error?.code, "unknown_member")
    const after = await handlers.snapshot({ directory })
    assert.ok(!Object.values(after.state.subtasks).some((task: any) => task.assigneeID === nova.id))
    const texts = ((after.state.messages[workspace.id] ?? []) as any[]).map((message) => message.text)
    assert.ok(texts.some((text) => text.includes("Peer turn refused: $Sage") && text.includes("archived")))
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a user mention of an outside-roster agent fails loudly with no leader fallback and no approval", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-peer-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
  const handlers = service.handlers()
  try {
    const { nova, workspace } = await setupPair(directory, handlers)
    const echo = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Echo" } })
    assert.equal(echo.ok, true)
    // The user is the authorizer: a user post naming a roster agent outside
    // the workspace fails loudly (never a silent drop, never a leader
    // fallback, never an approval round-trip).
    const response = await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "$Echo please advise" } })
    assert.equal(response.ok, false)
    assert.equal(response.error?.code, "unknown_member")
    assert.match(response.error?.message ?? "", /\$Echo/)
    const after = await handlers.snapshot({ directory })
    assert.equal(Object.values(after.state.subtasks).length, 0)
    assert.ok(!Object.values(after.state.subtasks).some((task: any) => task.assigneeID === nova.id))
    assert.equal(Object.values(after.state.approvals).length, 0)
    const texts = ((after.state.messages[workspace.id] ?? []) as any[]).map((message) => message.text)
    assert.ok(texts.some((text) => text.includes("Peer turn refused: $Echo") && text.includes("not a workspace member")))
    void nova
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("per-agent serialization holds under parallel user peer turns", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-peer-"))
  const { ctx } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
  const handlers = service.handlers()
  try {
    const { sage, workspace } = await setupPair(directory, handlers)
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "$Sage first job" } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "$Sage second job" } })
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).filter((task: any) => task.workKind === "turn" && task.state === "replied").length === 2
    })
    const after = await handlers.snapshot({ directory })
    const turns = Object.values(after.state.subtasks).filter((task: any) => task.workKind === "turn") as any[]
    assert.equal(turns.length, 2)
    for (const turn of turns) assert.equal(turn.attempts, 1)
    const ordered = [...turns].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    // One agent never talks over itself: the second turn starts after the
    // first finishes.
    assert.ok((ordered[1].startedAt ?? 0) >= (ordered[0].repliedAt ?? 0))
    void sage
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("restart recovery resumes a peer turn without an approval gate", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-peer-"))
  const shared = new Map<string, unknown>()
  const first = fakeContext(shared)
  const seed = new V2Store(first.ctx)
  await seed.load()
  await seed.saveAgent({ id: "a", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 } as any)
  await seed.saveAgent({ id: "s", name: "Sage", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 } as any)
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "a", memberIDs: ["a", "s"], synthesis: true, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1 } as any)
  await seed.saveSubtask({
    id: "t", workspaceID: "w", creatorType: "user", assigneeID: "s", title: "$Sage resume me", instruction: "Resume me",
    mode: "research", state: "working", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false,
    attempts: 2, createdAt: 1, claimedBy: "run_old", leaseUntil: 1, queueKey: "work:w:turn:root:seed",
    workKind: "turn", deadlineAt: Date.now() + 60_000,
    turn: { correlationID: "peer_seed", askerKind: "user" },
  } as any)
  const service = new EnsembleV2Service(first.ctx)
  const stop = await service.start()
  const handlers = service.handlers()
  try {
    const loaded = await handlers.snapshot({ directory })
    assert.ok(loaded.state.subtasks.t.attempts >= 2)
    assert.equal(loaded.state.subtasks.t.turn?.correlationID, "peer_seed")
    assert.equal(Object.values(loaded.state.approvals).filter((approval: any) => approval.status === "pending").length, 0)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return next.state.subtasks.t.state === "replied"
    })
    const after = await handlers.snapshot({ directory })
    assert.equal(Object.values(after.state.subtasks).filter((task: any) => task.workKind === "turn").length, 1)
    assert.equal(after.state.subtasks.t.attempts, 3)
    assert.equal(after.state.subtasks.t.turn?.answeredByID, "s")
    const replies = ((after.state.messages.w ?? []) as any[]).filter((message: any) => message.correlationID === "peer_seed" && message.agentID === "s")
    assert.equal(replies.length, 1)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("cancelling a peer turn records a terminal state with correlation intact", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-peer-"))
  const { ctx } = fakeContext()
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 2000)) }
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
  const handlers = service.handlers()
  try {
    const { workspace } = await setupPair(directory, handlers)
    const sent = await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "$Sage long job" } })
    assert.equal(sent.ok, true)
    let turnID = ""
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const turn = Object.values(next.state.subtasks).find((task: any) => task.workKind === "turn") as any
      if (!turn) return false
      turnID = turn.id
      return true
    })
    const before = await handlers.snapshot({ directory })
    const correlationID = before.state.subtasks[turnID].turn?.correlationID
    assert.ok(correlationID)
    await handlers.invoke({ directory, action: "task.cancel", payload: { id: turnID } })
    const after = await handlers.snapshot({ directory })
    const turn = after.state.subtasks[turnID]
    assert.equal(turn.state, "replied")
    assert.equal(turn.outcome, "failed")
    assert.match(turn.error ?? "", /Cancelled by user/)
    assert.equal(turn.turn?.correlationID, correlationID)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("an agent group-chat $mention creates a peer turn with asker attribution and one answer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-peer-"))
  const { ctx, tools } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
  const handlers = service.handlers()
  try {
    const { nova, sage, workspace } = await setupPair(directory, handlers)
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "Coordinate" } })
    const sessionID = await bindingSessionID(handlers, directory, nova.id)
    const posted = await tools.get("send_message").execute({ kind: "workspace", text: "$Sage please help with this" }, { sessionID })
    assert.match(posted.content, /Posted to #site/)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.workKind === "turn" && task.state === "replied" && task.turn?.askerKind === "agent")
    })
    const after = await handlers.snapshot({ directory })
    const turns = Object.values(after.state.subtasks).filter((task: any) => task.workKind === "turn" && task.turn?.askerKind === "agent") as any[]
    assert.equal(turns.length, 1)
    const turn = turns[0]
    assert.equal(turn.turn?.askerID, nova.id)
    assert.equal(turn.assigneeID, sage.id)
    assert.equal(turn.turn?.answeredByID, sage.id)
    const messages = (after.state.messages[workspace.id] ?? []) as any[]
    const ask = messages.find((message) => message.agentID === nova.id && message.text.includes("$Sage please help"))
    assert.ok(ask)
    const answers = messages.filter((message) => message.correlationID === turn.turn.correlationID && message.agentID === sage.id)
    // The answering agent's reply is the relay: one answer row, no second leg.
    assert.equal(answers.length, 1)
    assert.ok(!messages.some((message) => message.text.includes("Relayed answer")))
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("agent mention depth and per-run caps refuse visibly without queueing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-peer-"))
  const { ctx, tools } = fakeContext()
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 2000)) }
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
  const handlers = service.handlers()
  try {
    const { nova, sage, workspace } = await setupPair(directory, handlers)
    await handlers.invoke({ directory, action: "settings.update", payload: { maxDepth: 1, maxDelegations: 1 } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "Coordinate" } })
    const novaSession = await bindingSessionID(handlers, directory, nova.id)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const parent = Object.values(next.state.subtasks).find((task: any) => task.title === "Coordinate") as any
      if (!parent) return false
      return Object.values(next.state.runs ?? {}).some((run: any) => run.subtaskID === parent.id && run.status === "running")
    })
    const delegated = await tools.get("delegate").execute({ assignee: "Sage", title: "Child", instruction: "Check" }, { sessionID: novaSession })
    assert.match(delegated.content, /Delegated to Sage/)
    const sageSession = await bindingSessionID(handlers, directory, sage.id)
    let childID = ""
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const child = Object.values(next.state.subtasks).find((task: any) => task.title === "Child") as any
      if (!child) return false
      childID = child.id
      return Object.values(next.state.runs ?? {}).some((run: any) => run.subtaskID === childID && run.status === "running")
    })
    // Sage asks from depth 1 with maxDepth 1: refused, never queued.
    const deep = await tools.get("send_message").execute({ kind: "workspace", text: "$Nova go deeper" }, { sessionID: sageSession })
    assert.match(deep.content, /delegation depth limit/)
    // Nova already has one child: the per-run cap refuses a second peer.
    const capped = await tools.get("send_message").execute({ kind: "workspace", text: "$Sage another job" }, { sessionID: novaSession })
    assert.match(capped.content, /delegation limit is 1/)
    const after = await handlers.snapshot({ directory })
    assert.equal(Object.values(after.state.subtasks).filter((task: any) => task.workKind === "turn").length, 0)
    const texts = ((after.state.messages[workspace.id] ?? []) as any[]).map((message) => message.text)
    assert.equal(texts.filter((text) => text.includes("Peer turn refused")).length, 2)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("an agent self-mention never creates a self turn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-peer-"))
  const { ctx, tools } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
  const handlers = service.handlers()
  try {
    const { nova, workspace } = await setupPair(directory, handlers)
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "Coordinate" } })
    const sessionID = await bindingSessionID(handlers, directory, nova.id)
    const posted = await tools.get("send_message").execute({ kind: "workspace", text: "$Nova do it myself" }, { sessionID })
    assert.match(posted.content, /Posted to #site/)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const after = await handlers.snapshot({ directory })
    assert.equal(Object.values(after.state.subtasks).filter((task: any) => task.workKind === "turn" && task.turn?.askerKind === "agent").length, 0)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("an agent mention of an outside-roster agent needs approval, then runs once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-peer-"))
  const { ctx, tools } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await service.start()
  const handlers = service.handlers()
  try {
    const { nova, workspace } = await setupPair(directory, handlers)
    const echo = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Echo" } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "Coordinate" } })
    const sessionID = await bindingSessionID(handlers, directory, nova.id)
    const asked = await tools.get("send_message").execute({ kind: "workspace", text: "$Echo please advise" }, { sessionID })
    assert.match(asked.content, /Approval required before contacting \$Echo/)
    const pending = await handlers.snapshot({ directory })
    const approvals = Object.values(pending.state.approvals) as any[]
    assert.equal(approvals.length, 1)
    assert.equal(approvals[0].kind, "outside_roster")
    assert.equal(approvals[0].payload?.peerTurn, true)
    assert.ok(approvals[0].payload?.correlationID)
    assert.ok(((pending.state.messages[workspace.id] ?? []) as any[]).some((message: any) => message.text === "Approval needed: contact $Echo"))
    const resolved = await handlers.invoke({ directory, action: "approval.resolve", payload: { id: approvals[0].id, approve: true } })
    assert.equal(resolved.ok, true)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.workKind === "turn" && task.assigneeID === echo.result.id && task.state === "replied")
    })
    const after = await handlers.snapshot({ directory })
    const turns = Object.values(after.state.subtasks).filter((task: any) => task.workKind === "turn" && task.assigneeID === echo.result.id) as any[]
    assert.equal(turns.length, 1)
    assert.equal(turns[0].turn?.correlationID, approvals[0].payload.correlationID)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})
