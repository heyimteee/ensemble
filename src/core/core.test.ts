import test from "node:test"
import assert from "node:assert/strict"
import { createInitialState, EnsembleStore } from "./store.ts"
import { parseMentions, routeChannelMessage, resolveCheckoutKey, validateModelSelection, variantSupported } from "./routing.ts"
import { resolve } from "node:path"
import { selectRunnable, nextQueueOrder } from "./scheduler.ts"
import { createMemoryEntry, visibleMemories } from "./memory.ts"
import { archiveAgent, deleteAgent, deleteChannel } from "./lifecycle.ts"
import { createApproval, pendingApprovals, resolveApproval } from "./approvals.ts"
import type { AgentProfile, Channel, ModelOption, WorkItem } from "./types.ts"

function agent(id: string, name: string): AgentProfile {
  return {
    id,
    name,
    instructions: "",
    mainModel: { providerID: "p", modelID: "m" },
    backupModels: [],
    skillbox: [],
    archived: false,
    pendingSettings: false,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  }
}

function makeChannel(id: string, leaderID: string, memberIDs: string[]): Channel {
  return {
    id,
    name: id,
    projectDirectory: "/repo",
    memberIDs,
    leaderID,
    messages: [],
    archived: false,
    paused: false,
    chainIDs: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

function work(id: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    kind: "direct",
    agentID: "a",
    conversationID: "c",
    prompt: "hello",
    mode: "research",
    status: "queued",
    queueOrder: 0,
    createdAt: 1,
    ...overrides,
  }
}

test("store serializes mutations and persists each version", async () => {
  const persisted: number[] = []
  const store = new EnsembleStore({
    initial: createInitialState(),
    persist: async (state) => {
      persisted.push(state.version)
    },
  })
  await Promise.all([
    store.mutate((draft) => {
      draft.settings.chainLimit = 4
    }),
    store.mutate((draft) => {
      draft.settings.maxConcurrentTurns = 2
    }),
  ])
  const snapshot = store.snapshot()
  assert.equal(snapshot.settings.chainLimit, 4)
  assert.equal(snapshot.settings.maxConcurrentTurns, 2)
  assert.deepEqual(persisted, [2, 3])
})

test("mentions select members and unaddressed messages route only to the leader", () => {
  const agents = { a: agent("a", "Nova"), b: agent("b", "Sage") }
  const testChannel = makeChannel("c", "a", ["a", "b"])
  assert.deepEqual(parseMentions("!Sage please review", Object.values(agents), testChannel.memberIDs), ["b"])
  assert.deepEqual(parseMentions("!Nova !Sage both", Object.values(agents), testChannel.memberIDs), ["a", "b"])
  assert.deepEqual(parseMentions("just an exclamation!", Object.values(agents), testChannel.memberIDs), [])
  assert.deepEqual(routeChannelMessage("no mention", testChannel, Object.values(agents)), ["a"])
  assert.deepEqual(routeChannelMessage("!Sage please review", testChannel, Object.values(agents)), ["b"])
})

test("mentions use the longest matching name and stable ids", () => {
  const agents = { a: agent("a", "Nova"), b: agent("b", "Nova Prime") }
  const members = ["a", "b"]
  assert.deepEqual(parseMentions("!Nova Prime and !Nova", Object.values(agents), members), ["b", "a"])
  assert.deepEqual(parseMentions("!Nova Prime", Object.values(agents), members), ["b"])
  assert.deepEqual(parseMentions("!b", Object.values(agents), members), ["b"])
})

test("model selection rejects unknown variants and unavailable models", () => {
  const models: ModelOption[] = [{ providerID: "p", modelID: "m", name: "M", variants: ["low", "high"] }]
  assert.equal(validateModelSelection({ providerID: "p", modelID: "m", variant: "high" }, models), undefined)
  assert.match(validateModelSelection({ providerID: "p", modelID: "m", variant: "bogus" }, models) ?? "", /not supported/)
  assert.match(validateModelSelection({ providerID: "x", modelID: "m" }, models) ?? "", /not available/)
  assert.equal(variantSupported(models[0], undefined), true)
})

test("checkout keys normalize equivalent directory spellings", () => {
  assert.equal(resolveCheckoutKey("/repo/app/"), "/repo/app")
  assert.equal(resolveCheckoutKey("/repo//app"), "/repo/app")
  assert.equal(resolveCheckoutKey("repo/app"), resolve("repo/app"))
})

test("scheduler respects the team limit and edit lock", () => {
  const state = createInitialState({ maxConcurrentTurns: 2 })
  state.agents.a = agent("a", "A")
  state.agents.b = agent("b", "B")
  state.work.w1 = work("w1", { mode: "edit", checkoutKey: "/repo" })
  state.work.w2 = work("w2", { mode: "edit", checkoutKey: "/repo", queueOrder: 1 })
  state.work.w3 = work("w3", { mode: "research", queueOrder: 2, conversationID: "c3", checkoutKey: "/other" })
  const first = selectRunnable(state)
  assert.deepEqual(first.map((item) => item.id), ["w1", "w3"])
  state.work.w1.status = "running"
  state.work.w3.status = "running"
  assert.deepEqual(selectRunnable(state), [])
  state.work.w3.status = "completed"
  assert.deepEqual(selectRunnable(state).map((item) => item.id), [])
  state.work.w1.status = "completed"
  assert.deepEqual(selectRunnable(state).map((item) => item.id), ["w2"])
})

test("scheduler allows distinct checkouts and one active turn per conversation", () => {
  const state = createInitialState({ maxConcurrentTurns: 3 })
  state.agents.a = agent("a", "A")
  state.work.w1 = work("w1", { mode: "edit", checkoutKey: "/one", conversationID: "c1" })
  state.work.w2 = work("w2", { mode: "edit", checkoutKey: "/two", conversationID: "c2", queueOrder: 1 })
  state.work.w3 = work("w3", { mode: "research", conversationID: "c1", queueOrder: 2 })
  assert.deepEqual(selectRunnable(state).map((item) => item.id), ["w1", "w2"])
  state.work.w1.status = "running"
  state.work.w2.status = "running"
  assert.deepEqual(selectRunnable(state).map((item) => item.id), [])
  state.work.w1.status = "completed"
  assert.deepEqual(selectRunnable(state).map((item) => item.id), ["w3"])
})

test("queue reordering returns a stable order", () => {
  const state = createInitialState()
  state.agents.a = agent("a", "A")
  state.work.w1 = work("w1", { queueOrder: 0 })
  state.work.w2 = work("w2", { queueOrder: 1 })
  assert.deepEqual(nextQueueOrder(state, "w2", "up"), ["w2", "w1"])
  assert.deepEqual(nextQueueOrder(state, "w1", "down"), ["w2", "w1"])
})

test("memory visibility separates project, global, and channel knowledge", () => {
  const state = createInitialState()
  state.memories.project = createMemoryEntry({
    id: "project",
    text: "project secret",
    scope: "project",
    origin: "automatic",
    source: "agent:a",
    agentID: "a",
    projectDirectory: "/repo/one",
  })
  state.memories.global = createMemoryEntry({
    id: "global",
    text: "prefers concise answers",
    scope: "global",
    origin: "manual",
    source: "user",
    agentID: "a",
  })
  state.memories.channel = createMemoryEntry({
    id: "channel",
    text: "release is Friday",
    scope: "channel",
    origin: "manual",
    source: "user",
    channelID: "c",
  })
  const one = visibleMemories(state, { agentID: "a", projectDirectory: "/repo/one", channelID: "c" })
  const two = visibleMemories(state, { agentID: "a", projectDirectory: "/repo/two" })
  assert.deepEqual(one.map((entry) => entry.id).sort(), ["channel", "global", "project"])
  assert.deepEqual(two.map((entry) => entry.id), ["global"])
})

test("archiving an agent pauses a channel it leads; deleting requires a replacement", () => {
  const state = createInitialState()
  state.agents.leader = agent("leader", "Leader")
  state.agents.member = agent("member", "Member")
  state.channels.c = makeChannel("c", "leader", ["leader", "member"])
  assert.equal(archiveAgent(state, "leader").ok, false)
  assert.equal(state.channels.c.paused, false)
  assert.equal(archiveAgent(state, "leader", "member").ok, true)
  assert.equal(state.channels.c.leaderID, "member")
  assert.deepEqual(state.channels.c.memberIDs, ["member"])

  const deletion = createInitialState()
  deletion.agents.leader = agent("leader", "Leader")
  deletion.agents.member = agent("member", "Member")
  deletion.channels.c = makeChannel("c", "leader", ["leader", "member"])
  const blocked = deleteAgent(deletion, "leader")
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, "leader_replacement_required")
  const deleted = deleteAgent(deletion, "leader", "member")
  assert.equal(deleted.ok, true)
  assert.equal(deletion.channels.c.leaderID, "member")
  assert.deepEqual(deletion.channels.c.memberIDs, ["member"])
})

test("archiving an agent cancels its work, handoffs, and pending approvals", () => {
  const state = createInitialState()
  state.agents.a = agent("a", "A")
  state.work.w = work("w")
  state.approvals.a = createApproval(state, { kind: "outside_roster", title: "Ask", detail: "details", agentID: "a" })
  state.handoffs.h = {
    id: "h",
    channelID: "c",
    chainID: "chain",
    fromAgentID: "a",
    toAgentID: "b",
    request: "review",
    status: "queued",
    createdAt: 1,
    updatedAt: 1,
  }
  assert.equal(archiveAgent(state, "a").ok, true)
  assert.equal(state.work.w.status, "cancelled")
  assert.equal(state.handoffs.h.status, "cancelled")
  assert.equal(state.approvals.a.status, "rejected")
})

test("deleting a channel removes its conversations and channel memory", () => {
  const state = createInitialState()
  state.channels.c = makeChannel("c", "a", ["a"])
  state.conversations["channel:c:a"] = {
    id: "channel:c:a",
    kind: "channel",
    agentID: "a",
    channelID: "c",
    projectDirectory: "/repo",
    agentVersion: 1,
    sessionIDs: [],
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  }
  state.memories.m = createMemoryEntry({ id: "m", text: "x", scope: "channel", origin: "manual", source: "user", channelID: "c" })
  assert.equal(deleteChannel(state, "c").ok, true)
  assert.equal(state.channels.c, undefined)
  assert.equal(state.conversations["channel:c:a"], undefined)
  assert.equal(state.memories.m, undefined)
})

test("approvals are pending until resolved once", () => {
  const state = createInitialState()
  const approval = createApproval(state, { kind: "promote_memory", title: "Promote", detail: "fact" })
  assert.deepEqual(pendingApprovals(state).map((item) => item.id), [approval.id])
  assert.equal(resolveApproval(state, approval.id, "approved")?.status, "approved")
  assert.equal(resolveApproval(state, approval.id, "rejected"), undefined)
  assert.deepEqual(pendingApprovals(state), [])
})
