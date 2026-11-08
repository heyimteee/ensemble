import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { EnsembleV2Service } from "./service.ts"
import { startServiceForTest } from "./test-service.ts"
import { V2Store } from "./store.ts"
import type { LogEntry } from "./logging.ts"

type Handlers = {
  snapshot: (input: unknown) => Promise<any>
  diagnostic: (input: unknown) => Promise<any>
  invoke: (input: unknown) => Promise<any>
  "logs.recent": (input: unknown) => Promise<{ entries: LogEntry[] }>
}

function fakeContext() {
  const values = new Map<string, unknown>()
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
      wait: async () => { await new Promise((resolve) => setTimeout(resolve, 300)) },
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
        handlers.diagnostic = value.diagnostic
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

async function waitFor(check: () => Promise<boolean>, timeout = 10_000): Promise<void> {
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

/** Start a command and wait until the leader's run is live in its root group. */
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

/** One explicit handoff leg; waits until the recipient's run is live. */
async function relayLeg(
  directory: string,
  handlers: Handlers,
  tools: Map<string, any>,
  senderID: string,
  recipientName: string,
  task: string,
  file: string,
): Promise<void> {
  const senderSession = await bindingSessionID(handlers, directory, senderID)
  const path = handoffFile(directory, file, task)
  const result = await tools.get("handoff").execute({ task, summary: "", path, to: recipientName, maxHops: 1 }, { sessionID: senderSession })
  assert.match(result.content, /Handed to \$/, `${task}: ${result.content}`)
  await waitFor(async () => {
    const next = await handlers.snapshot({ directory })
    const hop = Object.values(next.state.subtasks).find((item: any) => item.title === task && item.workKind === "handoff") as any
    if (!hop) return false
    return Object.values(next.state.runs ?? {}).some((run: any) => run.subtaskID === hop.id && run.status === "running")
  })
}

async function relay(
  directory: string,
  handlers: Handlers,
  tools: Map<string, any>,
  participants: Array<{ id: string; name: string }>,
  startAgentID: string,
  count: number,
  prefix: string,
): Promise<string> {
  let index = participants.findIndex((agent) => agent.id === startAgentID)
  if (index < 0) throw new Error("relay sender is not a participant")
  for (let hop = 0; hop < count; hop++) {
    const sender = participants[index]!
    const recipient = participants[(index + 1) % participants.length]!
    const task = `${prefix} ${hop + 1}`
    await relayLeg(directory, handlers, tools, sender.id, recipient.name, task, `${prefix.replaceAll(" ", "-").toLowerCase()}-${hop}.md`)
    index = (index + 1) % participants.length
  }
  return participants[index]!.id
}

function groupOf(snapshot: any, groupID: string): any {
  return snapshot.state.dispatchGroups[groupID]
}

async function waitForTaskRun(directory: string, handlers: Handlers, title: string): Promise<string> {
  let taskID = ""
  await waitFor(async () => {
    const next = await handlers.snapshot({ directory })
    const task = Object.values(next.state.subtasks).find((item: any) => item.title === title) as any
    if (!task) return false
    taskID = task.id
    return Object.values(next.state.runs ?? {}).some((run: any) => run.subtaskID === taskID && run.status === "running")
  })
  return taskID
}

function continuationGroups(snapshot: any, rootID: string): any[] {
  return Object.values(snapshot.state.dispatchGroups).filter((group: any) => group.rootID === rootID && group.id !== rootID) as any[]
}

test("ticket162: a nine-hop relay crosses the exhausted root into one continuation group", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-continuation-"))
  const { ctx, handlers, tools } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    const { nova, sage, workspace } = await setupPair(directory, handlers)
    const { groupID } = await liveCommand(directory, handlers, workspace.id, nova.id, "Nine hop relay")
    const lastSender = await relay(directory, handlers, tools, [{ id: nova.id, name: "Nova" }, { id: sage.id, name: "Sage" }], nova.id, 8, "Relay")
    assert.equal(lastSender, nova.id)
    let snapshot = await handlers.snapshot({ directory })
    const root = groupOf(snapshot, groupID)
    assert.equal(root.usedHops, 8)
    assert.equal(root.commandUsedHops, 8)
    assert.equal(root.continuationsUsed, 0)
    assert.equal(root.closedAt, undefined, "an exhausted group stays open until the leader continues it")

    const novaSession = await bindingSessionID(handlers, directory, nova.id)
    const secretTitle = "Scene 9 SECRET_A1"
    const continued = await tools.get("delegate").execute(
      { continuationOf: groupID, groupMaxHops: 8, maxHops: 1, assignee: "Sage", title: secretTitle, instruction: "SECRET_INSTRUCTION_B2" },
      { sessionID: novaSession },
    )
    assert.match(continued.content, /Continuation group opened|Delegated to Sage/, continued.content)
    assert.match(continued.content, /Remaining — task/)
    snapshot = await handlers.snapshot({ directory })
    const afterRoot = groupOf(snapshot, groupID)
    assert.equal(afterRoot.usedHops, 8, "the exhausted root spends no more hops")
    assert.equal(afterRoot.commandUsedHops, 9, "the continuation keeps the same command ledger")
    assert.equal(afterRoot.continuationsUsed, 1)
    assert.equal(afterRoot.closedAt !== undefined, true)
    assert.equal(afterRoot.closeReason, "continued")
    const groups = continuationGroups(snapshot, groupID)
    assert.equal(groups.length, 1)
    const continuation = groups[0]!
    assert.equal(continuation.rootID, groupID)
    assert.equal(continuation.parentID, groupID)
    assert.equal(continuation.continuationIndex, 1)
    assert.equal(continuation.maxHops, 8)
    assert.equal(continuation.usedHops, 1)
    assert.equal(continuation.depthMax, 8)
    const ninth = Object.values(snapshot.state.subtasks).find((task: any) => task.title === secretTitle) as any
    assert.ok(ninth)
    assert.equal(ninth.dispatchGroupID, continuation.id)
    assert.equal(ninth.dispatchDepth, 0, "the continuation starts a fresh depth segment")
    assert.equal(ninth.taskMaxHops, 1)
    await waitFor(async () => {
      const next = await handlers.snapshot({ directory })
      const task = Object.values(next.state.subtasks).find((item: any) => item.title === secretTitle) as any
      return task?.state === "replied"
    }, 15_000)
    const finished = await handlers.snapshot({ directory })
    assert.equal(groupOf(finished, groupID).commandUsedHops, 9, "the nine-hop relay completes with nine command hops")
    const explicit = Object.values(snapshot.state.subtasks).filter((task: any) => task.workKind === "handoff" && task.handoff?.completion !== true) as any[]
    assert.equal(explicit.length, 8, "eight relay hops stayed in the root")
    assert.ok(explicit.every((task) => task.dispatchGroupID === groupID))

    const texts = ((snapshot.state.messages[workspace.id] ?? []) as any[]).map((message) => message.text)
    assert.ok(texts.some((text) => text.includes("Dispatch group exhausted")), "the root exhaustion is visible")
    assert.ok(texts.some((text) => text.includes("Continuation group opened")), "the continuation is visible")
    assert.equal(texts.filter((text) => text.includes("Continuation group opened")).length, 1, "routine hops never add continuation lines")

    const exhausted = await handlers["logs.recent"]({ directory, cat: "dispatch", event: "dispatch.group.exhausted", limit: 20 })
    const exhaustion = exhausted.entries.find((entry: any) => entry.dispatchGroupID === groupID) as any
    assert.ok(exhaustion)
    assert.equal(exhaustion.level, "warn")
    assert.equal(exhaustion.reason, "group-exhausted")
    assert.equal(exhaustion.usedHops, 8)
    assert.equal(exhaustion.maxHops, 8)
    assert.equal(exhaustion.commandUsedHops, 8)
    assert.equal(exhaustion.commandMaxHops, 24)
    const continuedLogs = await handlers["logs.recent"]({ directory, cat: "dispatch", event: "dispatch.group.continued", limit: 20 })
    const continuationEvent = continuedLogs.entries.find((entry: any) => entry.dispatchGroupID === continuation.id) as any
    assert.ok(continuationEvent)
    assert.equal(continuationEvent.level, "info")
    assert.equal(continuationEvent.parentID, groupID)
    assert.equal(continuationEvent.rootID, groupID)
    assert.equal(continuationEvent.continuationIndex, 1)
    assert.equal(continuationEvent.usedHops, 0, "creation consumes nothing")
    assert.equal(continuationEvent.maxHops, 8)
    assert.equal(continuationEvent.commandMaxHops, 24)
    const serialized = JSON.stringify([...exhausted.entries, ...continuedLogs.entries])
    assert.ok(!serialized.includes(secretTitle))
    assert.ok(!serialized.includes("SECRET_INSTRUCTION_B2"))
    for (const forbidden of ["title", "instruction", "path", "content", "text"] as const) {
      assert.equal(forbidden in exhaustion, false, `dispatch events carry no ${forbidden}`)
      assert.equal(forbidden in continuationEvent, false, `dispatch events carry no ${forbidden}`)
    }

    const closedLogs = await handlers["logs.recent"]({ directory, cat: "dispatch", event: "dispatch.group.closed", limit: 20 })
    const closedEvent = closedLogs.entries.find((entry: any) => entry.dispatchGroupID === groupID) as any
    assert.ok(closedEvent, "sealing the continued parent emits one closed event")
    assert.equal(closedEvent.level, "info")
    assert.equal(closedEvent.rootID, groupID)
    assert.equal(closedEvent.closeReason, "continued")
    assert.equal(closedEvent.usedHops, 8)
    assert.equal(closedEvent.maxHops, 8)
    assert.equal(typeof closedEvent.durationMs, "number")

    const diagnostic = await handlers.diagnostic({ directory })
    assert.ok(diagnostic.state.dispatchGroups[groupID], "the diagnostic keeps full group records")
    assert.equal(diagnostic.dispatch.summary.groups, 2)
    assert.equal(diagnostic.dispatch.summary.roots, 1)
    assert.equal(diagnostic.dispatch.summary.continuations, 1)
    assert.equal(diagnostic.dispatch.summary.closedGroups, 1)
    assert.equal(diagnostic.dispatch.summary.activeGroups, 1)
    assert.equal(diagnostic.dispatch.summary.groupsAtLimit, 1)
    assert.equal(diagnostic.dispatch.summary.usedHops, 9)
    assert.equal(diagnostic.dispatch.summary.commandUsedHops, 9)
    assert.equal(diagnostic.dispatch.summary.commandMaxHops, 24)
    assert.equal(diagnostic.dispatch.summary.continuationsUsed, 1)
    assert.equal(diagnostic.dispatch.groups.length, 2)
    const dispatchJson = JSON.stringify(diagnostic.dispatch)
    assert.ok(!dispatchJson.includes(secretTitle), "diagnostic groups carry no task titles")
    assert.ok(!dispatchJson.includes("SECRET_INSTRUCTION_B2"), "diagnostic groups carry no instructions")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket162: the command cap refuses further continuation and tells the user to start a new command", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-continuation-"))
  const { ctx, handlers, tools } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    const { nova, sage, workspace } = await setupPair(directory, handlers)
    // Root 8 hops exactly fills an 8-hop command with no continuation allowance.
    const changed = await handlers.invoke({
      directory,
      action: "settings.update",
      payload: { dispatchGroupMaxHops: 8, dispatchCommandMaxHops: 8, dispatchDepth: 8, dispatchContinuations: 0 },
    })
    assert.equal(changed.ok, true)
    const { groupID } = await liveCommand(directory, handlers, workspace.id, nova.id, "Cap relay")
    await relay(directory, handlers, tools, [{ id: nova.id, name: "Nova" }, { id: sage.id, name: "Sage" }], nova.id, 8, "Cap root")
    const novaSession = await bindingSessionID(handlers, directory, nova.id)
    const refused = await tools.get("delegate").execute(
      { continuationOf: groupID, groupMaxHops: 8, maxHops: 1, assignee: "Sage", title: "Cap continuation", instruction: "Continue" },
      { sessionID: novaSession },
    )
    assert.match(refused.content, /Continuation refused: the command budget is exhausted \(8\/8 hops\)/)
    assert.match(refused.content, /start a new command for a fresh budget/)
    const snapshot = await handlers.snapshot({ directory })
    const texts = ((snapshot.state.messages[workspace.id] ?? []) as any[]).map((message) => message.text)
    assert.ok(texts.some((text) => text.startsWith("Continuation refused: the command budget is exhausted")))
    assert.ok(texts.some((text) => text.startsWith("Command budget exhausted (8/8 hops). Ask the user to start a new command")), "the final root hop announces the command stop")
    const exhausted = await handlers["logs.recent"]({ directory, cat: "dispatch", event: "dispatch.group.exhausted", limit: 20 })
    const exhaustion = exhausted.entries.find((entry: any) => entry.dispatchGroupID === groupID) as any
    assert.equal(exhaustion?.reason, "command-exhausted")
    assert.equal(exhaustion?.commandRemaining, 0)
    assert.equal(continuationGroups(snapshot, groupID).length, 0, "the command cap opens no continuation")
    assert.equal(Object.values(snapshot.state.subtasks).some((task: any) => task.title === "Cap continuation"), false)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket162: the continuation count refuses another segment and points at a new command", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-continuation-"))
  const { ctx, handlers, tools } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    const { nova, sage, workspace } = await setupPair(directory, handlers)
    const changed = await handlers.invoke({
      directory,
      action: "settings.update",
      payload: { dispatchGroupMaxHops: 8, dispatchCommandMaxHops: 24, dispatchDepth: 8, dispatchContinuations: 0 },
    })
    assert.equal(changed.ok, true)
    const { groupID } = await liveCommand(directory, handlers, workspace.id, nova.id, "Count cap")
    await relay(directory, handlers, tools, [{ id: nova.id, name: "Nova" }, { id: sage.id, name: "Sage" }], nova.id, 8, "Count root")
    const novaSession = await bindingSessionID(handlers, directory, nova.id)
    const refused = await tools.get("delegate").execute(
      { continuationOf: groupID, groupMaxHops: 8, maxHops: 1, assignee: "Sage", title: "Count continuation", instruction: "Continue" },
      { sessionID: novaSession },
    )
    assert.match(refused.content, /Continuation refused: the continuation limit is reached \(0\/0\)/)
    assert.match(refused.content, /start a new command for a fresh budget/)
    const snapshot = await handlers.snapshot({ directory })
    const texts = ((snapshot.state.messages[workspace.id] ?? []) as any[]).map((message) => message.text)
    assert.ok(texts.some((text) => text.startsWith("Dispatch group exhausted") && text.includes("0 continuations remaining") && text.includes("start a new command")), "the exhaustion stop names the remaining continuation budget")
    assert.equal(continuationGroups(snapshot, groupID).length, 0)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket162: a closed group refuses a peer handoff and keeps the parent spent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-continuation-"))
  const { ctx, handlers, tools } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  for (const [id, name] of [["nova", "Nova"], ["sage", "Sage"]] as const) {
    await seed.saveAgent({ id, name, title: "", role: "", mainModel: { providerID: "probe", modelID: "probe-model" }, backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1, createdAt: 1, updatedAt: 1 })
  }
  await seed.saveWorkspace({ id: "w", name: "site", directory, leaderID: "nova", memberIDs: ["nova", "sage"], synthesis: false, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1 })
  await seed.saveBinding({ workspaceID: "w", agentID: "sage", sessionID: "sess_closed", kind: "workspace", directory, agentVersion: 1, updatedAt: 1 })
  const at = Date.now()
  await seed.saveDispatchGroup({
    id: "dispatch_closed_root", workspaceID: "w", rootID: "dispatch_closed_root", continuationIndex: 0,
    maxHops: 8, usedHops: 8, depthMax: 8, commandMaxHops: 24, commandUsedHops: 8,
    maxContinuations: 2, continuationsUsed: 1, createdAt: at - 1_000, closedAt: at - 500, closeReason: "continued",
  })
  await seed.saveDispatchGroup({
    id: "dispatch_closed_cont", workspaceID: "w", rootID: "dispatch_closed_root", parentID: "dispatch_closed_root",
    continuationIndex: 1, maxHops: 8, usedHops: 1, depthMax: 8, createdAt: at - 400,
  })
  await seed.saveSubtask({
    id: "closed-peer-task", workspaceID: "w", creatorType: "agent", creatorAgentID: "nova", assigneeID: "sage",
    title: "Closed peer work", instruction: "Check", mode: "research", state: "working", stage: "initial",
    outcome: "pending", interrupted: false, awaitingChildren: false, attempts: 1, createdAt: at - 300,
    workKind: "delegation", queueKey: "work:w:delegation:closed-peer", dispatchGroupID: "dispatch_closed_root",
    taskMaxHops: 2, dispatchDepth: 1, claimedBy: "seed-run", leaseUntil: at + 60_000, deadlineAt: at + 60_000,
  })
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    const path = handoffFile(directory, "closed-refusal.md", "Closed refusal")
    const refused = await tools.get("handoff").execute({ task: "Closed refusal", summary: "", path, to: "Nova", maxHops: 1 }, { sessionID: "sess_closed" })
    assert.match(refused.content, /Handoff refused: the dispatch group is closed/)
    assert.match(refused.content, /Return your result to the leader/)
    const snapshot = await handlers.snapshot({ directory })
    assert.equal(snapshot.state.dispatchGroups.dispatch_closed_root.usedHops, 8)
    assert.equal(snapshot.state.subtasks["closed-peer-task"].taskMaxHops, 2, "a refused handoff spends no task budget")
    const texts = ((snapshot.state.messages.w ?? []) as any[]).map((message) => message.text)
    assert.ok(texts.some((text) => text.startsWith("Handoff refused: the dispatch group is closed")))
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket162: a continuation is refused while the referenced group still has hops", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-continuation-"))
  const { ctx, handlers, tools } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    const { nova, workspace } = await setupPair(directory, handlers)
    const { sessionID, groupID } = await liveCommand(directory, handlers, workspace.id, nova.id, "Early")
    const first = await tools.get("delegate").execute({ assignee: "Sage", title: "First hop", instruction: "Check", maxHops: 0 }, { sessionID })
    assert.match(first.content, /Delegated to Sage/)
    const refused = await tools.get("delegate").execute(
      { continuationOf: groupID, groupMaxHops: 8, maxHops: 0, assignee: "Sage", title: "Too early", instruction: "Check" },
      { sessionID },
    )
    assert.match(refused.content, /Continuation refused: the dispatch group still has 7 of 8 hops; dispatch into it/)
    const snapshot = await handlers.snapshot({ directory })
    assert.equal(groupOf(snapshot, groupID).usedHops, 1, "a refusal spends no hop")
    assert.equal(groupOf(snapshot, groupID).continuationsUsed, 0)
    assert.equal(continuationGroups(snapshot, groupID).length, 0)
    const texts = ((snapshot.state.messages[workspace.id] ?? []) as any[]).map((message) => message.text)
    assert.ok(texts.some((text) => text.startsWith("Continuation refused: the dispatch group still has")))
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket162: only the leader can open a continuation group", async () => {  const directory = mkdtempSync(join(tmpdir(), "ensemble-continuation-"))
  const { ctx, handlers, tools } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    const { nova, sage, workspace } = await setupPair(directory, handlers)
    const { groupID } = await liveCommand(directory, handlers, workspace.id, workspace.leaderID, "Leader only")
    // Create a live binding for the non-leader by giving Sage one direct ask.
    const novaSession = await bindingSessionID(handlers, directory, nova.id)
    const ask = await tools.get("delegate").execute({ assignee: "Sage", title: "Binding ask", instruction: "Check", maxHops: 0 }, { sessionID: novaSession })
    assert.match(ask.content, /Delegated to Sage/)
    const sageSession = await bindingSessionID(handlers, directory, sage.id)
    const refused = await tools.get("delegate").execute(
      { continuationOf: groupID, groupMaxHops: 8, maxHops: 0, assignee: "Nova", title: "Peer continuation", instruction: "Check" },
      { sessionID: sageSession },
    )
    assert.match(refused.content, /Continuation refused: only the workspace leader/)
    assert.match(refused.content, /return your result to the leader/)
    const snapshot = await handlers.snapshot({ directory })
    assert.equal(groupOf(snapshot, groupID).continuationsUsed, 0)
    assert.equal(continuationGroups(snapshot, groupID).length, 0)
    const texts = ((snapshot.state.messages[workspace.id] ?? []) as any[]).map((message) => message.text)
    assert.ok(texts.some((text) => text.startsWith("Continuation refused: only the workspace leader")))
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket162: the leader can dispatch multiple children into the new continuation without falling back", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-continuation-"))
  const { ctx, handlers, tools } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    const { nova, sage, workspace } = await setupPair(directory, handlers)
    const { groupID } = await liveCommand(directory, handlers, workspace.id, nova.id, "Multi child")
    await relay(directory, handlers, tools, [{ id: nova.id, name: "Nova" }, { id: sage.id, name: "Sage" }], nova.id, 8, "Multi root")
    const novaSession = await bindingSessionID(handlers, directory, nova.id)
    const first = await tools.get("delegate").execute(
      { continuationOf: groupID, groupMaxHops: 8, maxHops: 7, assignee: "Nova", title: "Continuation child one", instruction: "Check" },
      { sessionID: novaSession },
    )
    assert.match(first.content, /Continuation group opened|Delegated to Nova/)
    await waitForTaskRun(directory, handlers, "Continuation child one")
    const second = await tools.get("delegate").execute({ assignee: "Sage", title: "Continuation child two", instruction: "Check", maxHops: 0 }, { sessionID: novaSession })
    assert.match(second.content, /Delegated to Sage/)
    const third = await tools.get("delegate").execute(
      { continuationOf: groupID, groupMaxHops: 8, maxHops: 0, assignee: "Sage", title: "Continuation child three", instruction: "Check" },
      { sessionID: novaSession },
    )
    assert.match(third.content, /Delegated to Sage/)
    const snapshot = await handlers.snapshot({ directory })
    const groups = continuationGroups(snapshot, groupID)
    assert.equal(groups.length, 1, "the exhausted root is never reopened or duplicated")
    const continuation = groups[0]!
    assert.equal(groupOf(snapshot, groupID).usedHops, 8, "children never fall back into the exhausted root")
    assert.equal(continuation.usedHops, 3)
    const children = Object.values(snapshot.state.subtasks).filter((task: any) =>
      ["Continuation child one", "Continuation child two", "Continuation child three"].includes(task.title)
    ) as any[]
    assert.equal(children.length, 3)
    for (const child of children) {
      assert.equal(child.dispatchGroupID, continuation.id)
    }
    assert.equal(children.find((child) => child.title === "Continuation child one")!.dispatchDepth, 0, "the segment starts fresh")
    for (const child of children.filter((child) => child.title !== "Continuation child one")) {
      assert.equal(child.dispatchDepth, 1, "children of the new segment count only in-segment ancestors")
    }
    const texts = ((snapshot.state.messages[workspace.id] ?? []) as any[]).map((message) => message.text)
    assert.equal(texts.filter((text) => text.includes("Continuation group opened")).length, 1, "routed children add no continuation lines")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket162: a closed group refuses new work and routes the leader to the active continuation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-continuation-"))
  const { ctx, handlers, tools } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    const { nova, sage, workspace } = await setupPair(directory, handlers)
    const { groupID } = await liveCommand(directory, handlers, workspace.id, nova.id, "Closed")
    await relay(directory, handlers, tools, [{ id: nova.id, name: "Nova" }, { id: sage.id, name: "Sage" }], nova.id, 8, "Closed root")
    const novaSession = await bindingSessionID(handlers, directory, nova.id)
    await tools.get("delegate").execute(
      { continuationOf: groupID, groupMaxHops: 8, maxHops: 7, assignee: "Nova", title: "Closed continuation", instruction: "Check" },
      { sessionID: novaSession },
    )
    await waitForTaskRun(directory, handlers, "Closed continuation")
    const routed = await tools.get("delegate").execute(
      { continuationOf: groupID, groupMaxHops: 8, maxHops: 1, assignee: "Sage", title: "Closed routed child", instruction: "Check" },
      { sessionID: novaSession },
    )
    assert.match(routed.content, /Delegated to Sage/)
    const snapshot = await handlers.snapshot({ directory })
    const continuation = continuationGroups(snapshot, groupID)[0]!
    assert.equal(continuationGroups(snapshot, groupID).length, 1, "a closed parent is not continued twice")
    const routedTask = Object.values(snapshot.state.subtasks).find((task: any) => task.title === "Closed routed child") as any
    assert.equal(routedTask.dispatchGroupID, continuation.id)
    assert.equal(groupOf(snapshot, groupID).usedHops, 8)
    assert.equal(groupOf(snapshot, groupID).continuationsUsed, 1)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket163: invalid dispatch limits log one warn event with setting names, never task content", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-continuation-"))
  const { ctx, handlers } = fakeContext()
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    await setupPair(directory, handlers)
    const invalid = await handlers.invoke({
      directory,
      action: "settings.update",
      payload: { dispatchGroupMaxHops: 24, dispatchCommandMaxHops: 8, dispatchDepth: 8, dispatchContinuations: 2 },
    })
    assert.equal(invalid.ok, false, "the impossible limit set is rejected")
    const logs = await handlers["logs.recent"]({ directory, cat: "dispatch", event: "dispatch.settings.invalid", limit: 20 })
    assert.equal(logs.entries.length, 1)
    const entry = logs.entries[0] as any
    assert.equal(entry.level, "warn")
    assert.equal(entry.reason, "invalid-dispatch-limits")
    assert.ok(Array.isArray(entry.fields))
    assert.ok(entry.fields.includes("dispatchCommandMaxHops"))
    assert.ok(entry.errorCount >= 1)
    assert.ok(Array.isArray(entry.errors) && entry.errors.length > 0)
    for (const forbidden of ["title", "instruction", "path", "content", "text"] as const) {
      assert.equal(forbidden in entry, false, `invalid settings events carry no ${forbidden}`)
    }
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})
