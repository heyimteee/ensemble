import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { EnsembleV2Service } from "./service.ts"
import { startServiceForTest } from "./test-service.ts"
import { V2Store } from "./store.ts"
import { directMessageChannel } from "./message-channel.ts"

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
        data: [{ type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "Relayed answer." }] }],
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

const handoffFile = (directory: string, name: string, body: string): string => {
  mkdirSync(join(directory, ".ensemble", "handoffs"), { recursive: true })
  writeFileSync(join(directory, ".ensemble", "handoffs", name), body)
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

test("handoff relay lands the answer in the asking conversation exactly once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-handoff-"))
  const { ctx, tools } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const { nova, sage, workspace } = await setupPair(directory, handlers)
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "Coordinate" } })
    const sessionID = await bindingSessionID(handlers, directory, nova.id)
    const path = handoffFile(directory, "ask.md", "---\nensemble: handoff\ntask: Summarize the deploy\n---\n# Handoff\n")
    const asked = await tools.get("handoff").execute({ maxHops: 1, task: "Summarize the deploy", summary: "Short version", path, to: "Sage" }, { sessionID })
    assert.match(asked.content, /Handed to \$Sage/)
    // Ticket #73: the waiting policy stays in the tool result for the
    // calling model — it never renders as an agent bubble.
    assert.match(asked.content, /stays open/)
    assert.match(asked.content, /do not call ensemble_delegate/)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.workKind === "handoff" && task.state === "replied")
    })
    const after = await handlers.snapshot({ directory })
    // Explicit hops only: the recipient's mandatory completion handoff to
    // the leader (ticket #71) is a separate terminal delivery.
    const hops = Object.values(after.state.subtasks).filter((task: any) => task.workKind === "handoff" && task.handoff?.completion !== true)
    assert.equal(hops.length, 1)
    const hop = hops[0] as any
    assert.equal(hop.assigneeID, sage.id)
    assert.equal(hop.creatorAgentID, nova.id)
    assert.equal(hop.outcome, "succeeded")
    assert.ok(hop.handoff?.correlationID)
    assert.equal(hop.handoff?.senderID, nova.id)
    assert.equal(hop.handoff?.recipientID, sage.id)
    assert.equal(hop.handoff?.answeredByID, sage.id)
    const messages = (after.state.messages[workspace.id] ?? []) as any[]
    // Ticket #73: the group ack is a concise system line — no policy
    // sentence, no correlation ref, no agent bubble.
    const ack = messages.find((message) => message.text.includes("Handed to $Sage"))
    assert.ok(ack)
    assert.equal(ack.author, "system")
    assert.equal(ack.text, "Handed to $Sage · Short version")
    for (const message of messages) {
      assert.ok(!message.text.includes("do not call ensemble_delegate"), `policy text leaked into the group transcript: ${message.text}`)
      assert.ok(!message.text.includes("(ref handoff_"), `correlation ref leaked into the group transcript: ${message.text}`)
    }
    const relayed = messages.filter((message) => message.agentID === sage.id && message.kind === "text" && !message.streaming && message.text === "Relayed answer.")
    assert.equal(relayed.length, 1)
    assert.equal(relayed[0].correlationID, hop.handoff.correlationID)
    for (const message of messages) assert.ok(!message.text.includes("@Sage"), `agent mention must use $Name syntax: ${message.text}`)
    // Resubmission after delivery still dedupes: one execution, not two.
    const again = await tools.get("handoff").execute({ maxHops: 1, task: "Summarize the deploy", summary: "Short version", path, to: "Sage" }, { sessionID })
    assert.match(again.content, /Already handed to \$Sage/)
    const terminal = await handlers.snapshot({ directory })
    assert.equal(Object.values(terminal.state.subtasks).filter((task: any) => task.workKind === "handoff" && task.handoff?.completion !== true).length, 1)
    // task_status exposes the typed handoff record and the derived status.
    const status = await tools.get("task_status").execute({}, { sessionID })
    const rows = JSON.parse(status.content)
    const row = rows.find((item: any) => item.workKind === "handoff")
    assert.ok(row)
    assert.equal(row.status, "replied")
    assert.equal(row.handoff?.correlationID, hop.handoff.correlationID)
    assert.equal(row.handoff?.recipientID, sage.id)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

// Ticket #73: the sender's self-authored instruction reaches the recipient
// as the work item instruction under a short display title — never the
// user's verbatim words. A distinct brief is a distinct unit of work, and
// tool-passed constraints/expected travel with the hop.
test("handoff carries a tailored instruction distinct from the user text", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-handoff-"))
  const { ctx, tools } = fakeContext()
  // Slow the native wait so both hops are observable before either replies.
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 2000)) }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const { nova, sage, workspace } = await setupPair(directory, handlers)
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "Please rewrite the deploy summary from scratch for the exec team" } })
    const sessionID = await bindingSessionID(handlers, directory, nova.id)
    const path = handoffFile(directory, "ask.md", "---\nensemble: handoff\ntask: Deploy summary\n---\n# Handoff\n")
    const tailored = "Condense the deploy notes into three exec-ready bullets; flag rollout risks."
    const first = await tools.get("handoff").execute(
      { maxHops: 1, task: "Deploy summary", instruction: tailored, summary: "Exec-ready bullets", path, to: "Sage", constraints: "Keep it under 100 words", expected: "Three bullets" },
      { sessionID },
    )
    assert.match(first.content, /Handed to \$Sage/)
    const afterFirst = await handlers.snapshot({ directory })
    const hops = Object.values(afterFirst.state.subtasks).filter((task: any) => task.workKind === "handoff") as any[]
    assert.equal(hops.length, 1)
    assert.equal(hops[0].title, "Deploy summary")
    assert.equal(hops[0].assigneeID, sage.id)
    assert.ok(hops[0].instruction.includes(tailored))
    assert.ok(!hops[0].instruction.includes("Please rewrite the deploy summary from scratch for the exec team"))
    assert.equal(hops[0].constraints, "Keep it under 100 words")
    assert.equal(hops[0].expected, "Three bullets")
    // Same title, distinct brief: a distinct unit of work, not a duplicate.
    const retitled = await tools.get("handoff").execute(
      { maxHops: 1, task: "Deploy summary", instruction: "Now also cover the rollback plan.", summary: "Exec-ready bullets", path, to: "Sage" },
      { sessionID },
    )
    assert.match(retitled.content, /Handed to \$Sage/)
    assert.ok(!retitled.content.includes("Already handed"))
    const afterSecond = await handlers.snapshot({ directory })
    assert.equal(Object.values(afterSecond.state.subtasks).filter((task: any) => task.workKind === "handoff").length, 2)
    // Resubmission with the same brief still dedupes.
    const again = await tools.get("handoff").execute(
      { maxHops: 1, task: "Deploy summary", instruction: tailored, summary: "Exec-ready bullets", path, to: "Sage", constraints: "Keep it under 100 words", expected: "Three bullets" },
      { sessionID },
    )
    assert.match(again.content, /Already handed to \$Sage/)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("malformed, unknown, and missing-recipient handoffs are refused visibly", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-handoff-"))
  const { ctx, tools } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const { nova, workspace } = await setupPair(directory, handlers)
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "Coordinate" } })
    const sessionID = await bindingSessionID(handlers, directory, nova.id)
    const bad = handoffFile(directory, "bad.md", "Just prose mentioning ensemble: handoff without structure.\n")
    const malformed = await tools.get("handoff").execute({ maxHops: 1, task: "T", summary: "S", path: bad, to: "Sage" }, { sessionID })
    assert.match(malformed.content, /frontmatter/)
    const missingTask = handoffFile(directory, "no-task.md", "---\nensemble: handoff\n---\n# Handoff\n")
    const noTask = await tools.get("handoff").execute({ maxHops: 1, task: "", summary: "", path: missingTask, to: "Sage" }, { sessionID })
    assert.match(noTask.content, /non-empty task/)
    const withTask = handoffFile(directory, "with-task.md", "---\nensemble: handoff\ntask: Help\n---\n# Handoff\n")
    const unknown = await tools.get("handoff").execute({ maxHops: 1, task: "Help", summary: "", path: withTask, to: "Nope" }, { sessionID })
    assert.match(unknown.content, /No agent matches/)
    const noRecipient = await tools.get("handoff").execute({ maxHops: 1, task: "Help", summary: "", path: withTask }, { sessionID })
    assert.match(noRecipient.content, /must name a recipient/)
    const after = await handlers.snapshot({ directory })
    assert.equal(Object.values(after.state.subtasks).filter((task: any) => task.workKind === "handoff").length, 0)
    const texts = ((after.state.messages[workspace.id] ?? []) as any[]).map((message) => message.text)
    assert.ok(texts.some((text) => text.includes("Handoff refused")))
    for (const text of texts) assert.ok(!text.includes("@Sage") && !text.includes("@Nope"))
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("exhausted handoffs stall with a notice; queue age never fails a handoff", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-handoff-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  await seed.saveAgent({ id: "nova", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  await seed.saveAgent({ id: "sage", name: "Sage", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "nova", memberIDs: ["nova", "sage"], synthesis: true, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1 })
  await seed.saveSubtask({
    id: "hop-tired", workspaceID: "w", creatorType: "agent", creatorAgentID: "nova", assigneeID: "sage",
    title: "Summarize", instruction: "Summarize", mode: "research", state: "pending", stage: "initial",
    outcome: "pending", interrupted: false, awaitingChildren: false, attempts: 5, error: "boom", createdAt: 1,
    workKind: "handoff", queueKey: "handoff:w:abc", deadlineAt: Date.now() + 60_000,
    handoff: { correlationID: "handoff_exhausted", senderID: "nova", recipientID: "sage", depth: 1 },
  })
  await seed.saveSubtask({
    id: "hop-late", workspaceID: "w", creatorType: "agent", creatorAgentID: "nova", assigneeID: "sage",
    title: "Late work", instruction: "Late", mode: "research", state: "pending", stage: "initial",
    outcome: "pending", interrupted: false, awaitingChildren: false, attempts: 0, createdAt: 1,
    workKind: "handoff", queueKey: "handoff:w:late", deadlineAt: 2,
    handoff: { correlationID: "handoff_overdue", senderID: "nova", recipientID: "sage", depth: 1 },
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const tired = (next.state.subtasks as any)["hop-tired"]
      const late = (next.state.subtasks as any)["hop-late"]
      return tired?.state === "replied" && late?.state === "replied" && late?.outcome === "succeeded"
    })
    const after = await handlers.snapshot({ directory })
    assert.equal(after.state.subtasks["hop-tired"].outcome, "failed")
    assert.equal((after.state.subtasks["hop-tired"] as any).status, "stalled", "exhausted delivery retries stall, not fail")
    assert.equal(after.state.subtasks["hop-tired"].error, "boom")
    assert.equal(after.state.subtasks["hop-late"].outcome, "succeeded", "an old queue timestamp never fails a handoff")
    assert.equal((after.state.subtasks["hop-late"] as any).status, "replied")
    const texts = ((after.state.messages.w ?? []) as any[]).map((message) => message.text)
    assert.ok(texts.some((text) => text.includes("Handoff to $Sage failed: boom (ref handoff_exhausted)")))
    assert.ok(!texts.some((text) => text.includes("handoff_overdue")), "the overdue handoff delivered, so it has no failure notice")
    for (const text of texts) assert.ok(!text.includes("@Sage"))
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a handoff hop that cannot start delivers a failure notice in the asking conversation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-handoff-"))
  const { ctx, tools } = fakeContext()
  ;(ctx.session as any).create = async () => ({ data: {} })
  const seed = new V2Store(ctx)
  await seed.load()
  await seed.saveAgent({ id: "nova", name: "Nova", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  await seed.saveAgent({ id: "sage", name: "Sage", title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "nova", memberIDs: ["nova", "sage"], synthesis: true, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1 })
  await seed.saveBinding({ workspaceID: "w", agentID: "nova", sessionID: "sess_nova", kind: "workspace", directory, agentVersion: 1, updatedAt: 1 })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const path = handoffFile(directory, "ask.md", "---\nensemble: handoff\ntask: Summarize\n---\n# Handoff\n")
    const asked = await tools.get("handoff").execute({ maxHops: 1, task: "Summarize", summary: "", path, to: "Sage" }, { sessionID: "sess_nova" })
    assert.match(asked.content, /Handed to \$Sage/)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.workKind === "handoff" && task.state === "replied")
    })
    const after = await handlers.snapshot({ directory })
    const hop = Object.values(after.state.subtasks).find((task: any) => task.workKind === "handoff") as any
    assert.equal(hop.outcome, "failed")
    const texts = ((after.state.messages.w ?? []) as any[]).map((message) => message.text)
    assert.ok(texts.some((text) => text.includes(`Handoff to $Sage failed: Could not create a native session. (ref ${hop.handoff.correlationID})`)))
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("handoff depth and per-run caps are refused visibly", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-handoff-"))
  const { ctx, tools } = fakeContext()
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 2000)) }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const { nova, sage, workspace } = await setupPair(directory, handlers)
    await handlers.invoke({ directory, action: "settings.update", payload: { dispatchDepth: 1 } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "Coordinate" } })
    const novaSession = await bindingSessionID(handlers, directory, nova.id)
    // The store binding lands before the run registers its session: wait for
    // the parent run itself, otherwise the handoff would read no asking run.
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const parent = Object.values(next.state.subtasks).find((task: any) => task.title === "Coordinate") as any
      if (!parent) return false
      return Object.values(next.state.runs ?? {}).some((run: any) => run.subtaskID === parent.id && run.status === "running")
    })
    // Handoff-specific caps (not the generic delegation settings): one run
    // fans out at most three hops. The first three asks from the top-level
    // run land; the fourth is refused without queueing.
    for (const [index, task] of ["First work", "Second work", "Third work"].entries()) {
      const path = handoffFile(directory, `ask-${index}.md`, `---\nensemble: handoff\ntask: ${task}\n---\n# Handoff\n`)
      const asked = await tools.get("handoff").execute({ maxHops: 1, task, summary: "", path, to: "Sage" }, { sessionID: novaSession })
      assert.match(asked.content, /Handed to \$Sage/)
    }
    const cappedPath = handoffFile(directory, "ask-capped.md", "---\nensemble: handoff\ntask: Fourth work\n---\n# Handoff\n")
    const capped = await tools.get("handoff").execute({ maxHops: 1, task: "Fourth work", summary: "", path: cappedPath, to: "Sage" }, { sessionID: novaSession })
    assert.match(capped.content, /the handoff limit is 3 per run/)
    // Depth: chains stop after one hop. Delegate a child, then ask from
    // inside it (asking depth 1): refused without queueing.
    const delegated = await tools.get("delegate").execute({ maxHops: 1, assignee: "Sage", title: "Child", instruction: "Check" }, { sessionID: novaSession })
    assert.match(delegated.content, /Delegated to Sage/)
    const sageSession = await bindingSessionID(handlers, directory, sage.id)
    let childID = ""
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const child = Object.values(next.state.subtasks).find((task: any) => task.title === "Child") as any
      if (!child) return false
      childID = child.id
      return Object.values(next.state.runs ?? {}).some((run: any) => run.subtaskID === childID && run.status === "running")
    }, 15_000)
    const deepPath = handoffFile(directory, "deep.md", "---\nensemble: handoff\ntask: Deep work\n---\n# Handoff\n")
    const deep = await tools.get("handoff").execute({ maxHops: 1, task: "Deep work", summary: "", path: deepPath, to: "Nova" }, { sessionID: sageSession })
    assert.match(deep.content, /the dispatch depth limit is 1/)
    const after = await handlers.snapshot({ directory })
    // Explicit hops only: completion handoffs (ticket #71) are separate
    // terminal deliveries, never extra fan-out under the per-run budget.
    assert.equal(Object.values(after.state.subtasks).filter((task: any) => task.workKind === "handoff" && task.handoff?.completion !== true).length, 3)
    const texts = ((after.state.messages[workspace.id] ?? []) as any[]).map((message) => message.text)
    assert.ok(texts.some((text) => text.includes("Handoff refused")))
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("cancelling a handoff hop records a terminal cancelled state with correlation intact", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-handoff-"))
  const { ctx, tools } = fakeContext()
  ;(ctx.session as any).wait = async () => { await new Promise((resolve) => setTimeout(resolve, 2000)) }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const { nova, workspace } = await setupPair(directory, handlers)
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "Coordinate" } })
    const sessionID = await bindingSessionID(handlers, directory, nova.id)
    const path = handoffFile(directory, "stop.md", "---\nensemble: handoff\ntask: Long work\n---\n# Handoff\n")
    const asked = await tools.get("handoff").execute({ maxHops: 1, task: "Long work", summary: "", path, to: "Sage" }, { sessionID })
    assert.match(asked.content, /Handed to \$Sage/)
    let hopID = ""
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const hop = Object.values(next.state.subtasks).find((task: any) => task.workKind === "handoff") as any
      if (!hop) return false
      hopID = hop.id
      return true
    })
    await handlers.invoke({ directory, action: "task.cancel", payload: { id: hopID } })
    const status = await tools.get("task_status").execute({}, { sessionID })
    const rows = JSON.parse(status.content)
    const row = rows.find((item: any) => item.id === hopID)
    assert.ok(row)
    assert.equal(row.status, "cancelled")
    assert.ok(row.handoff?.correlationID)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("direct messages carry an envelope and cross-boundary contact needs approval", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-handoff-"))
  const { ctx, tools } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const { nova, workspace } = await setupPair(directory, handlers)
    const echo = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Echo" } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "Coordinate" } })
    const sessionID = await bindingSessionID(handlers, directory, nova.id)
    const unknown = await tools.get("send_message").execute({ kind: "agent", id: "Nobody", text: "Hi" }, { sessionID })
    assert.match(unknown.content, /Agent not found/)
    const outside = await tools.get("send_message").execute({ kind: "agent", id: "Echo", text: "Hello outside" }, { sessionID })
    assert.match(outside.content, /Approval required before contacting Echo/)
    const pending = await handlers.snapshot({ directory })
    const approvals = Object.values(pending.state.approvals) as any[]
    assert.equal(approvals.length, 1)
    assert.equal(approvals[0].kind, "outside_roster")
    assert.ok(approvals[0].payload?.correlationID)
    assert.ok(((pending.state.messages[workspace.id] ?? []) as any[]).some((message: any) => message.text === "Approval needed: contact $Echo"))
    // Member DMs stay direct and carry the envelope correlation.
    const direct = await tools.get("send_message").execute({ kind: "agent", id: "Sage", text: "Hello member" }, { sessionID })
    assert.match(direct.content, /\(ref handoff_/)
    // Approving the outside-roster request delivers the queued message once.
    const resolved = await handlers.invoke({ directory, action: "approval.resolve", payload: { id: approvals[0].id, approve: true } })
    assert.equal(resolved.ok, true)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.dmQueue).some((entry: any) => entry.agentID === echo.result.id)
        || Boolean((next.state.messages[directMessageChannel(echo.result.id)] as any[] | undefined)?.some((line: any) => line.text === "Hello outside"))
    }, 8000)
    const after = await handlers.snapshot({ directory })
    const delivered = [
      ...Object.values(after.state.dmQueue),
      ...((after.state.messages[directMessageChannel(echo.result.id)] as any[]) ?? []),
    ] as any[]
    const matches = delivered.filter((item: any) => item.text === "Hello outside" || item.correlationID === approvals[0].payload.correlationID)
    assert.ok(matches.length >= 1)
    assert.ok(matches.every((item: any) => !item.text || !item.text.includes("@")))
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("approved cross-boundary handoffs create a typed hop through the queue", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-handoff-"))
  const { ctx, tools } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  const handlers = service.handlers()
  try {
    const { nova, workspace } = await setupPair(directory, handlers)
    const echo = await handlers.invoke({ directory, action: "agent.create", payload: { name: "Echo" } })
    await handlers.invoke({ directory, action: "message.send", payload: { workspaceID: workspace.id, text: "Coordinate" } })
    const sessionID = await bindingSessionID(handlers, directory, nova.id)
    const path = handoffFile(directory, "outside.md", "---\nensemble: handoff\ntask: Outside help\n---\n# Handoff\n")
    const asked = await tools.get("handoff").execute({ maxHops: 1, task: "Outside help", summary: "", path, to: "Echo" }, { sessionID })
    assert.match(asked.content, /Approval required before contacting Echo/)
    const pending = await handlers.snapshot({ directory })
    const approval = (Object.values(pending.state.approvals) as any[])[0]
    assert.equal(approval.kind, "outside_roster")
    assert.equal(approval.payload?.handoff, true)
    const resolved = await handlers.invoke({ directory, action: "approval.resolve", payload: { id: approval.id, approve: true } })
    assert.equal(resolved.ok, true)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      return Object.values(next.state.subtasks).some((task: any) => task.workKind === "handoff" && task.assigneeID === echo.result.id)
    })
    const after = await handlers.snapshot({ directory })
    const hop = Object.values(after.state.subtasks).find((task: any) => task.workKind === "handoff") as any
    assert.equal(hop.handoff?.correlationID, approval.payload.correlationID)
    assert.equal(hop.handoff?.senderID, nova.id)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})
