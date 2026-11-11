import test from "node:test"
import assert from "node:assert/strict"
import { collectBranchResults, formatBranchDigest, hasPendingDescendant } from "./branch-digest.ts"
import type { Agent, Message, Subtask } from "./types.ts"

const agent = (id: string, name: string): Agent => ({
  id,
  name,
  title: "",
  role: "",
  mainModel: { providerID: "p", modelID: "m" },
  backupModels: [],
  skillbox: [],
  color: "cyan",
  archived: false,
  pendingSettings: false,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
})

const task = (patch: Partial<Subtask> & { id: string }): Subtask => ({
  workspaceID: "w",
  creatorType: "agent",
  assigneeID: "a",
  title: "Task",
  instruction: "Do",
  mode: "research",
  state: "replied",
  stage: "initial",
  outcome: "succeeded",
  interrupted: false,
  awaitingChildren: false,
  attempts: 0,
  createdAt: 1,
  ...patch,
})

const message = (id: string, text: string): Message => ({
  id,
  workspaceID: "w",
  seq: 1,
  author: "agent",
  agentID: "a",
  text,
  kind: "text",
  createdAt: 1,
})

const agents = {
  a: agent("a", "Nova"),
  b: agent("b", "Sage"),
  c: agent("c", "Iris"),
  d: agent("d", "Fern"),
}

test("a relay digest uses the terminal leaf result, never an intermediate parent result", () => {
  const tasks = {
    root: task({ id: "root", assigneeID: "a", resultMessageID: "m_root" }),
    b: task({ id: "b", parentID: "root", assigneeID: "b", resultMessageID: "m_b" }),
    c: task({ id: "c", parentID: "b", assigneeID: "c", resultMessageID: "m_c" }),
    d: task({ id: "d", parentID: "c", assigneeID: "d", resultMessageID: "m_d" }),
  }
  const messages = [
    message("m_root", "Root intermediate"),
    message("m_b", "Sage intermediate"),
    message("m_c", "Iris intermediate"),
    message("m_d", "Fern final answer"),
  ]
  const branches = collectBranchResults({ rootID: "root", subtasks: tasks, messages })
  assert.equal(branches.length, 1)
  assert.deepEqual(branches[0].path, ["a", "b", "c", "d"])
  assert.equal(branches[0].taskID, "d")
  assert.equal(branches[0].outcome, "succeeded")
  assert.equal(branches[0].result, "Fern final answer")
  const digest = formatBranchDigest(branches, agents)
  assert.match(digest, /^- \$Nova → \$Sage → \$Iris → \$Fern: Fern final answer$/m)
  assert.doesNotMatch(digest, /Sage intermediate|Iris intermediate|Root intermediate/)
})

test("a fan-out digest keeps failed and cancelled branches visible", () => {
  const tasks = {
    root: task({ id: "root", assigneeID: "a" }),
    b: task({ id: "b", parentID: "root", assigneeID: "b", state: "replied", outcome: "failed", error: "boom" }),
    c: task({ id: "c", parentID: "root", assigneeID: "c", state: "replied", outcome: "failed", stoppedAt: 5, error: "Cancelled by user." }),
    d: task({ id: "d", parentID: "root", assigneeID: "d", resultMessageID: "m_d" }),
  }
  const branches = collectBranchResults({ rootID: "root", subtasks: tasks, messages: [message("m_d", "Done")] })
  assert.deepEqual(branches.map((branch) => branch.outcome), ["failed", "cancelled", "succeeded"])
  const digest = formatBranchDigest(branches, agents)
  assert.match(digest, /^- \$Nova → \$Sage: \(failed\) boom$/m)
  assert.match(digest, /^- \$Nova → \$Iris: \(cancelled\) Cancelled by user\.$/m)
  assert.match(digest, /^- \$Nova → \$Fern: Done$/m)
})

test("completion hops are review deliveries, not work branches", () => {
  const tasks = {
    root: task({ id: "root", assigneeID: "a" }),
    b: task({ id: "b", parentID: "root", assigneeID: "b", resultMessageID: "m_b" }),
    review: task({ id: "review", parentID: "b", assigneeID: "a", resultMessageID: "m_review", handoff: { correlationID: "c", senderID: "b", recipientID: "a", depth: 1, completion: true } }),
  }
  const branches = collectBranchResults({
    rootID: "root",
    subtasks: tasks,
    messages: [message("m_b", "Worker answer"), message("m_review", "Review answer")],
  })
  assert.equal(branches.length, 1)
  assert.equal(branches[0].taskID, "b")
  assert.equal(branches[0].result, "Worker answer")
})

test("ticket251: a terminal child with a pending descendant keeps the subtree open", () => {
  const tasks = {
    root: task({ id: "root", assigneeID: "a", state: "working", outcome: "pending", awaitingChildren: true }),
    b: task({ id: "b", parentID: "root", assigneeID: "b", state: "replied", outcome: "succeeded" }),
    c: task({ id: "c", parentID: "b", assigneeID: "c", state: "pending", outcome: "pending" }),
  }
  const terminal = (item: Subtask) => item.state === "replied"
  assert.equal(hasPendingDescendant({ parentID: "root", subtasks: tasks, isTerminal: terminal }), true, "a pending grandchild keeps the root open")
  assert.equal(hasPendingDescendant({ parentID: "b", subtasks: tasks, isTerminal: terminal }), true, "a pending child keeps the intermediate parent open")
  tasks.c.state = "replied"
  tasks.c.outcome = "succeeded"
  assert.equal(hasPendingDescendant({ parentID: "root", subtasks: tasks, isTerminal: terminal }), false, "the whole subtree is terminal")
})

test("ticket251: a completion hop never keeps a subtree open", () => {
  const tasks = {
    root: task({ id: "root", assigneeID: "a", state: "working", outcome: "pending", awaitingChildren: true }),
    b: task({ id: "b", parentID: "root", assigneeID: "b", state: "replied", outcome: "succeeded" }),
    review: task({
      id: "review",
      parentID: "b",
      assigneeID: "a",
      state: "pending",
      outcome: "pending",
      handoff: { correlationID: "c", senderID: "b", recipientID: "a", depth: 1, completion: true },
    }),
  }
  assert.equal(
    hasPendingDescendant({ parentID: "root", subtasks: tasks, isTerminal: (item) => item.state === "replied" }),
    false,
    "completion deliveries are not work branches",
  )
})

test("ticket251: the digest follows the canonical work status for stalled and native branches", () => {
  const tasks = {
    root: task({ id: "root", assigneeID: "a" }),
    stalled: task({
      id: "stalled",
      parentID: "root",
      assigneeID: "b",
      state: "replied",
      outcome: "failed",
      error: "lease expired",
      failure: { kind: "lease", reason: "lease-expired" },
      createdAt: 1,
    }),
    nativePending: task({
      id: "nativePending",
      parentID: "root",
      assigneeID: "c",
      state: "pending",
      outcome: "pending",
      origin: "native",
      native: { sessionID: "s", assistantMessageIDs: [], phase: "queued" },
      createdAt: 2,
    }),
    nativeFailed: task({
      id: "nativeFailed",
      parentID: "root",
      assigneeID: "d",
      state: "replied",
      outcome: "failed",
      error: "provider failed",
      origin: "native",
      native: { sessionID: "s", assistantMessageIDs: [], phase: "failed" },
      createdAt: 3,
    }),
  }
  const branches = collectBranchResults({ rootID: "root", subtasks: tasks, messages: [] })
  assert.deepEqual(branches.map((branch) => [branch.taskID, branch.outcome]), [
    ["stalled", "stalled"],
    ["nativePending", "pending"],
    ["nativeFailed", "failed"],
  ])
  const digest = formatBranchDigest(branches, agents)
  assert.match(digest, /^- \$Nova → \$Sage: \(stalled\) lease expired$/m)
  assert.match(digest, /^- \$Nova → \$Iris: \(pending\)$/m)
  assert.match(digest, /^- \$Nova → \$Fern: \(failed\) provider failed$/m)
})

test("the digest is bounded by branch count and result length", () => {
  const tasks: Record<string, Subtask> = { root: task({ id: "root", assigneeID: "a" }) }
  const messages: Message[] = []
  for (let index = 0; index < 5; index++) {
    const id = `child${index}`
    tasks[id] = task({ id, parentID: "root", assigneeID: "b", resultMessageID: `m${index}` })
    messages.push(message(`m${index}`, `result-${index}-${"x".repeat(100)}`))
  }
  const branches = collectBranchResults({ rootID: "root", subtasks: tasks, messages })
  const digest = formatBranchDigest(branches, agents, { maxBranches: 3, maxResultChars: 12 })
  assert.equal(digest.split("\n").length, 4)
  assert.match(digest, /\(\+2 more branches\)/)
  assert.match(digest, /result-0-xxx…$/m)
})
