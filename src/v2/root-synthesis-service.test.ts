import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { EnsembleV2Service } from "./service.ts"
import { seedLegacySettings, startServiceForTest } from "./test-service.ts"
import { V2Store } from "./store.ts"
import { getGlobalLogger } from "./logging.ts"
import type { Agent, Subtask, Workspace } from "./types.ts"

type Handlers = {
  snapshot: (input: unknown) => Promise<any>
  invoke: (input: unknown) => Promise<any>
}

function fakeContext() {
  const values = new Map<string, unknown>()
  seedLegacySettings(values)
  const tools = new Map<string, any>()
  const instructions: Array<{ sessionID: string; key: string; value: string }> = []
  const prompts: Array<{ sessionID: string; text?: string }> = []
  const lastPrompt = new Map<string, string>()
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
      prompt: async (input: any) => {
        prompts.push({ sessionID: String(input.sessionID), text: input.text })
        lastPrompt.set(String(input.sessionID), String(input.text ?? ""))
      },
      wait: async () => { await new Promise((resolve) => setTimeout(resolve, 5)) },
      context: async ({ sessionID }: any) => ({
        data: [{
          type: "assistant",
          time: { created: Date.now() },
          content: [{ type: "text", text: lastPrompt.get(String(sessionID))?.startsWith("Synthesize") ? "One synthesis." : "Worker final answer." }],
        }],
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
  return { ctx, handlers: handlers as Handlers, tools, instructions, prompts }
}

async function waitFor(check: () => Promise<boolean>, timeout = 8000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for condition")
}

const agent = (id: string, name: string): Agent => ({
  id,
  name,
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

const workspace = (directory: string, memberIDs: string[]): Workspace => ({
  id: "w",
  name: "site",
  directory,
  leaderID: "a",
  memberIDs,
  synthesis: true,
  archived: false,
  paused: false,
  nextSeq: 1,
  createdAt: 1,
  lastActiveAt: 1,
})

const task = (patch: Partial<Subtask> & { id: string }): Subtask => ({
  workspaceID: "w",
  creatorType: "agent",
  assigneeID: "a",
  title: "Task",
  instruction: "Do the work",
  mode: "research",
  state: "pending",
  stage: "initial",
  outcome: "pending",
  interrupted: false,
  awaitingChildren: false,
  attempts: 0,
  createdAt: 1,
  ...patch,
})

const handoff = (senderID: string, recipientID: string) => ({
  correlationID: `handoff_${senderID}_${recipientID}`,
  senderID,
  recipientID,
  depth: 1,
})

const branchBlock = (context: string): string => {
  const match = context.match(/<ensemble_branch_results>\n([\s\S]*?)\n<\/ensemble_branch_results>/)
  return match?.[1] ?? ""
}

test("ticket246: a five-hop relay promotes only the command root and relays every intermediate parent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-246-relay-"))
  const { ctx, instructions } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  const ids = ["a", "b", "c", "d", "e", "f"]
  const names = ["Nova", "Sage", "Iris", "Fern", "Ash", "Wren"]
  for (const [index, id] of ids.entries()) await seed.saveAgent(agent(id, names[index]))
  await seed.saveWorkspace(workspace(directory, ids))
  for (const [id, text] of [["m_a", "Sage intermediate"], ["m_b", "Iris intermediate"], ["m_c", "Fern intermediate"], ["m_d", "Ash intermediate"]]) {
    await seed.saveChannelMessage("w", { id, author: "agent", agentID: "b", text, kind: "text", createdAt: 1 })
  }
  await seed.saveSubtask(task({ id: "root", assigneeID: "a", state: "working", awaitingChildren: true, workKind: "delegation" }))
  await seed.saveSubtask(task({ id: "a1", parentID: "root", assigneeID: "b", state: "working", awaitingChildren: true, workKind: "handoff", handoff: handoff("a", "b"), resultMessageID: "m_a" }))
  await seed.saveSubtask(task({ id: "a2", parentID: "a1", assigneeID: "c", state: "working", awaitingChildren: true, workKind: "handoff", handoff: handoff("b", "c"), resultMessageID: "m_b" }))
  await seed.saveSubtask(task({ id: "a3", parentID: "a2", assigneeID: "d", state: "working", awaitingChildren: true, workKind: "handoff", handoff: handoff("c", "d"), resultMessageID: "m_c" }))
  await seed.saveSubtask(task({ id: "a4", parentID: "a3", assigneeID: "e", state: "working", awaitingChildren: true, workKind: "handoff", handoff: handoff("d", "e"), resultMessageID: "m_d" }))
  await seed.saveSubtask(task({ id: "a5", parentID: "a4", assigneeID: "f", workKind: "handoff", handoff: handoff("e", "f"), taskMaxHops: 0 }))
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    await waitFor(async () => {
      const next = await service.handlers().snapshot({ directory })
      const root = next.state.subtasks.root
      return root?.stage === "synthesis" && root.state === "replied"
    })
    const state = (await service.handlers().snapshot({ directory })).state
    const synthesis = Object.values(state.subtasks).filter((item: any) => item.stage === "synthesis")
    assert.equal(synthesis.length, 1, "exactly one synthesis task")
    assert.equal((synthesis[0] as any).id, "root")
    const leaderMessages = ((state.messages.w ?? []) as any[]).filter((message) => message.taskID === "root" && message.author === "agent" && !message.streaming)
    assert.equal(leaderMessages.length, 1, "exactly one leader synthesis message")
    assert.equal(leaderMessages[0].text, "One synthesis.")
    for (const id of ["a1", "a2", "a3", "a4"]) {
      const parent = state.subtasks[id]
      assert.equal(parent.state, "replied", `${id} settled`)
      assert.equal(parent.outcome, "succeeded")
      assert.equal(parent.awaitingChildren, false)
      assert.notEqual(parent.stage, "synthesis")
    }
    assert.equal(state.subtasks.a1.resultMessageID, "m_a", "an intermediate parent keeps its own worker answer")
    assert.equal(state.subtasks.a2.resultMessageID, "m_b")
    assert.equal(state.subtasks.a3.resultMessageID, "m_c")
    assert.equal(state.subtasks.a4.resultMessageID, "m_d")
    const synthesisContext = instructions.map((entry) => entry.value).find((value) => value.includes("<ensemble_branch_results>")) ?? ""
    const digest = branchBlock(synthesisContext)
    assert.match(digest, /^- \$Nova → \$Sage → \$Iris → \$Fern → \$Ash → \$Wren: Worker final answer\.$/m)
    assert.doesNotMatch(digest, /intermediate/)
    const relayLogs = (getGlobalLogger()?.recent({ event: "task.relay.settled" }) ?? []).filter((entry) => ["a1", "a2", "a3", "a4"].includes(String(entry.taskID)))
    assert.equal(relayLogs.length, 4, "each intermediate parent logs one relay settlement")
    for (const entry of relayLogs) {
      assert.ok(entry.taskID)
      assert.ok(entry.parentID)
      assert.ok(entry.childID)
      assert.equal(entry.reason, "children-terminal")
      assert.equal(JSON.stringify(entry).includes("Worker final answer"), false, "relay logs carry IDs only")
    }
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket251: a relay parent keeps its own result while the root digest reports the leaf", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-251-relay-result-"))
  const { ctx, instructions } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  for (const [id, name] of [["a", "Nova"], ["b", "Sage"], ["c", "Iris"]] as const) await seed.saveAgent(agent(id, name))
  await seed.saveWorkspace(workspace(directory, ["a", "b", "c"]))
  await seed.saveChannelMessage("w", { id: "m_parent", author: "agent", agentID: "b", text: "Parent worker answer", kind: "text", createdAt: 1 })
  await seed.saveChannelMessage("w", { id: "m_leaf", author: "agent", agentID: "c", text: "Leaf final answer", kind: "text", createdAt: 2 })
  await seed.saveSubtask(task({ id: "root", assigneeID: "a", state: "working", awaitingChildren: true, workKind: "delegation" }))
  await seed.saveSubtask(task({
    id: "relay",
    parentID: "root",
    assigneeID: "b",
    state: "working",
    awaitingChildren: true,
    workKind: "handoff",
    handoff: handoff("a", "b"),
    resultMessageID: "m_parent",
  }))
  await seed.saveSubtask(task({
    id: "leaf",
    parentID: "relay",
    assigneeID: "c",
    state: "replied",
    outcome: "succeeded",
    workKind: "handoff",
    handoff: handoff("b", "c"),
    resultMessageID: "m_leaf",
    taskMaxHops: 0,
  }))
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    await waitFor(async () => {
      const next = await service.handlers().snapshot({ directory })
      return next.state.subtasks.root?.stage === "synthesis" && next.state.subtasks.root?.state === "replied"
    })
    const state = (await service.handlers().snapshot({ directory })).state
    assert.equal(state.subtasks.relay.resultMessageID, "m_parent", "the relay parent keeps its own worker result")
    const synthesisContext = instructions.map((entry) => entry.value).find((value) => value.includes("<ensemble_branch_results>")) ?? ""
    const digest = branchBlock(synthesisContext)
    assert.match(digest, /Leaf final answer/)
    assert.doesNotMatch(digest, /Parent worker answer/, "the root digest reports the terminal leaf, not the relay parent")
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket246: a five-way fan-out synthesizes once after every branch is terminal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-246-fanout-"))
  const { ctx, instructions } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  const ids = ["a", "b", "c", "d", "e", "f"]
  const names = ["Nova", "Sage", "Iris", "Fern", "Ash", "Wren"]
  for (const [index, id] of ids.entries()) await seed.saveAgent(agent(id, names[index]))
  await seed.saveWorkspace(workspace(directory, ids))
  const results: Array<[string, string]> = [
    ["m_b", "Result B"],
    ["m_e", "Result E"],
  ]
  for (const [id, text] of results) await seed.saveChannelMessage("w", { id, author: "agent", agentID: "b", text, kind: "text", createdAt: 1 })
  await seed.saveSubtask(task({ id: "root", assigneeID: "a", state: "working", awaitingChildren: true, workKind: "delegation" }))
  await seed.saveSubtask(task({ id: "b1", parentID: "root", assigneeID: "b", workKind: "handoff", handoff: handoff("a", "b"), state: "replied", outcome: "succeeded", resultMessageID: "m_b" }))
  await seed.saveSubtask(task({ id: "b2", parentID: "root", assigneeID: "c", workKind: "handoff", handoff: handoff("a", "c"), state: "replied", outcome: "failed", error: "branch failed" }))
  await seed.saveSubtask(task({ id: "b3", parentID: "root", assigneeID: "d", workKind: "handoff", handoff: handoff("a", "d"), state: "replied", outcome: "failed", stoppedAt: 5, error: "Cancelled by user." }))
  await seed.saveSubtask(task({ id: "b4", parentID: "root", assigneeID: "e", workKind: "handoff", handoff: handoff("a", "e"), state: "replied", outcome: "succeeded", resultMessageID: "m_e" }))
  await seed.saveSubtask(task({ id: "b5", parentID: "root", assigneeID: "f", workKind: "handoff", handoff: handoff("a", "f"), taskMaxHops: 0 }))
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    await waitFor(async () => {
      const next = await service.handlers().snapshot({ directory })
      const root = next.state.subtasks.root
      return root?.stage === "synthesis" && root.state === "replied"
    })
    const state = (await service.handlers().snapshot({ directory })).state
    const synthesis = Object.values(state.subtasks).filter((item: any) => item.stage === "synthesis")
    assert.equal(synthesis.length, 1, "exactly one root synthesis")
    assert.equal((synthesis[0] as any).id, "root")
    const leaderMessages = ((state.messages.w ?? []) as any[]).filter((message) => message.taskID === "root" && message.author === "agent" && !message.streaming)
    assert.equal(leaderMessages.length, 1, "exactly one leader synthesis message")
    const synthesisContext = instructions.map((entry) => entry.value).find((value) => value.includes("<ensemble_branch_results>")) ?? ""
    assert.doesNotMatch(synthesisContext, /<ensemble_recent_messages>/, "ticket249: synthesis carries no recent transcript")
    assert.match(synthesisContext, /<ensemble_root_request>\nDo the work\n<\/ensemble_root_request>/, "ticket249: synthesis carries the original request")
    const digest = branchBlock(synthesisContext)
    assert.match(digest, /^- \$Nova → \$Sage: Result B$/m)
    assert.match(digest, /^- \$Nova → \$Iris: \(failed\) branch failed$/m)
    assert.match(digest, /^- \$Nova → \$Fern: \(cancelled\) Cancelled by user\.$/m)
    assert.match(digest, /^- \$Nova → \$Ash: Result E$/m)
    assert.match(digest, /^- \$Nova → \$Wren: Worker final answer\.$/m)
    assert.equal(digest.split("\n").filter((line) => line.startsWith("- ")).length, 5)
  } finally {
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("ticket251: the root synthesis waits for a pending descendant routed by a replied child", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-251-subtree-"))
  const { ctx } = fakeContext()
  const seed = new V2Store(ctx)
  await seed.load()
  const ids = ["a", "b", "c", "d", "e"]
  const names = ["Nova", "Sage", "Iris", "Fern", "Ash"]
  for (const [index, id] of ids.entries()) await seed.saveAgent(agent(id, names[index]))
  await seed.saveWorkspace(workspace(directory, ids))
  await seed.saveChannelMessage("w", { id: "m_b", author: "agent", agentID: "c", text: "Intermediate answer", kind: "text", createdAt: 1 })
  await seed.saveSubtask(task({ id: "root", assigneeID: "a", state: "working", awaitingChildren: true, workKind: "delegation" }))
  await seed.saveSubtask(task({ id: "a1", parentID: "root", assigneeID: "b", state: "working", awaitingChildren: true, workKind: "delegation" }))
  await seed.saveSubtask(task({ id: "b1", parentID: "a1", assigneeID: "c", state: "replied", outcome: "succeeded", resultMessageID: "m_b", workKind: "delegation" }))
  await seed.saveSubtask(task({ id: "c1", parentID: "b1", assigneeID: "d", instruction: "Leaf pending work", workKind: "delegation" }))
  await seed.saveSubtask(task({ id: "d1", parentID: "a1", assigneeID: "e", instruction: "Sibling work", workKind: "delegation" }))
  let releaseLeaf!: () => void
  const leafGate = new Promise<void>((resolve) => { releaseLeaf = resolve })
  const realPrompt = (ctx.session as any).prompt
  ;(ctx.session as any).prompt = async (input: any) => {
    if (String(input.text ?? "").includes("Leaf pending work")) await leafGate
    return realPrompt(input)
  }
  const service = new EnsembleV2Service(ctx)
  const stop = await startServiceForTest(service, service.ctx)
  try {
    await waitFor(async () => {
      const next = await service.handlers().snapshot({ directory })
      return next.state.subtasks.d1?.state === "replied"
    })
    const waiting = (await service.handlers().snapshot({ directory })).state
    assert.equal(waiting.subtasks.a1.state, "working", "the intermediate parent stays open")
    assert.notEqual(waiting.subtasks.root.stage, "synthesis", "the root does not synthesize over a pending descendant")
    assert.notEqual(waiting.subtasks.c1.state, "replied", "the routed descendant is still active")
    releaseLeaf()
    await waitFor(async () => {
      const next = await service.handlers().snapshot({ directory })
      return next.state.subtasks.root?.stage === "synthesis" && next.state.subtasks.root?.state === "replied"
    })
    const after = (await service.handlers().snapshot({ directory })).state
    assert.equal(after.subtasks.c1.state, "replied", "the routed descendant finished before synthesis")
    const synthesis = Object.values(after.subtasks).filter((item: any) => item.stage === "synthesis")
    assert.equal(synthesis.length, 1, "exactly one root synthesis")
    assert.equal((synthesis[0] as any).id, "root")
  } finally {
    releaseLeaf()
    await stop()
    rmSync(directory, { recursive: true, force: true })
  }
})
