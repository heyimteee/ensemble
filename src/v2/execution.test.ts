import test from "node:test"
import assert from "node:assert/strict"
import { assistantResult, contextForTask, FALLBACK_REPLIES, isFallbackReply, promptForTask, recentGroupMessages } from "./execution.ts"
import { createInitialState } from "./defaults.ts"
import type { Agent, Message, Subtask, Workspace } from "./types.ts"

const testAgent = (id: string, name: string): Agent => ({
  id, name, title: "", role: "Engineer.", mainModel: { providerID: "p", modelID: "m" },
  backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1,
  createdAt: 1, updatedAt: 1,
})

const testWorkspace = (): Workspace => ({
  id: "w", name: "site", directory: "/tmp/site", leaderID: "a", memberIDs: ["a", "b", "c"],
  synthesis: true, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1,
})

const testSubtask = (patch: Partial<Subtask> & { id: string }): Subtask => ({
  workspaceID: "w", creatorType: "agent", assigneeID: "a", title: "Task", instruction: "Do the work",
  mode: "research", state: "pending", stage: "initial", outcome: "pending", interrupted: false,
  awaitingChildren: false, attempts: 0, createdAt: 1, ...patch,
})

const testMessage = (id: string, text: string, seq: number): Message => ({
  id, workspaceID: "w", author: "agent", agentID: "a", text, kind: "text", seq, createdAt: seq, updatedAt: seq,
})

test("internal fallback replies live in one fallback set", () => {
  assert.deepEqual(
    [...FALLBACK_REPLIES].sort(),
    ["Reply completed.", "Reply interrupted.", "Reply interrupted before completion."].sort(),
  )
  for (const fallback of FALLBACK_REPLIES) {
    assert.equal(isFallbackReply(fallback), true)
    assert.equal(isFallbackReply(`  ${fallback}\n`), true, "surrounding whitespace never makes a fallback substantive")
  }
  assert.equal(isFallbackReply("Reply completed. Extra detail"), false)
  assert.equal(isFallbackReply("OK"), false)
  assert.equal(isFallbackReply(undefined), false)
})

test("ticket225: a delegated prompt keeps the bounded last-20 group transcript", () => {
  const state = createInitialState()
  const agent = {
    id: "a", name: "Nova", title: "", role: "Frontend.", mainModel: { providerID: "p", modelID: "m" },
    backupModels: [], skillbox: [], color: "cyan", archived: false, pendingSettings: false, version: 1,
    createdAt: 1, updatedAt: 1,
  } satisfies Agent
  const peer = { ...agent, id: "b", name: "Sage" }
  const workspace = {
    id: "w", name: "site", directory: "/tmp/site", leaderID: "a", memberIDs: ["a", "b"],
    synthesis: false, archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1,
  } satisfies Workspace
  const task = {
    id: "t", workspaceID: "w", creatorType: "agent", assigneeID: "b", title: "Review",
    instruction: "Review the transcript", mode: "research", state: "pending", stage: "initial",
    outcome: "pending", interrupted: false, awaitingChildren: false, attempts: 0, createdAt: 1,
    workKind: "delegation",
  } satisfies Subtask
  const messages = Array.from({ length: 25 }, (_, index) => ({
    id: `m${index + 1}`,
    workspaceID: "w",
    author: index % 2 === 0 ? "user" as const : "agent" as const,
    agentID: "a",
    text: `message ${index + 1}`,
    kind: "text" as const,
    seq: index + 1,
    createdAt: index + 1,
    updatedAt: index + 1,
  }))
  const context = contextForTask({ ...state, agents: { a: agent, b: peer }, workspaces: { w: workspace }, messages: { w: messages } }, task, workspace, peer)
  assert.match(context, /<ensemble_turn /, "the compact roster is still present")
  assert.match(context, /<ensemble_recent_messages>/)
  assert.doesNotMatch(context, /message 5\n/, "the block is bounded to the newest 20 rows")
  assert.match(context, /message 6\n/)
  assert.match(context, /message 25/)
  assert.equal(recentGroupMessages({ ...state, agents: { a: agent }, messages: { w: messages } }, workspace).split("\n").length, 20)
})

test("ticket249: a synthesis context carries the root request and branch digest, not the recent transcript", () => {
  const state = createInitialState()
  const agents = { a: testAgent("a", "Nova"), b: testAgent("b", "Sage"), c: testAgent("c", "Iris") }
  const workspace = testWorkspace()
  const root = testSubtask({
    id: "root", creatorType: "user", assigneeID: "a", title: "Ship the release",
    instruction: "Ship the release and report blockers.", stage: "synthesis", workKind: "delegation",
  })
  const tasks = {
    root,
    b1: testSubtask({ id: "b1", parentID: "root", assigneeID: "b", state: "replied", outcome: "succeeded", resultMessageID: "m1" }),
    b2: testSubtask({ id: "b2", parentID: "root", assigneeID: "c", state: "replied", outcome: "failed", error: "boom" }),
  }
  const messages = Array.from({ length: 25 }, (_, index) => testMessage(`recent${index + 1}`, `message ${index + 1}`, index + 1))
  const context = contextForTask(
    { ...state, agents, workspaces: { w: workspace }, messages: { w: [...messages, testMessage("m1", "Worker answer.", 30)] }, subtasks: tasks },
    root,
    workspace,
    agents.a,
  )
  assert.doesNotMatch(context, /<ensemble_recent_messages>/, "the recent transcript is not injected into synthesis")
  assert.doesNotMatch(context, /message 25/, "no recent group message text leaks in")
  assert.match(context, /<ensemble_root_request>\nShip the release and report blockers\.\n<\/ensemble_root_request>/)
  assert.match(context, /<ensemble_branch_results>\n/)
  assert.match(context, /^- \$Nova → \$Sage: Worker answer\.$/m)
  assert.match(context, /^- \$Nova → \$Iris: \(failed\) boom$/m)
})

test("ticket249: the synthesis digest is bounded by branch count and result length", () => {
  const state = createInitialState()
  const agents = { a: testAgent("a", "Nova"), b: testAgent("b", "Sage") }
  const workspace = testWorkspace()
  const root = testSubtask({ id: "root", creatorType: "user", assigneeID: "a", instruction: "Review every area.", stage: "synthesis" })
  const tasks: Record<string, Subtask> = { root }
  const messages: Message[] = []
  for (let index = 0; index < 25; index++) {
    tasks[`b${index}`] = testSubtask({
      id: `b${index}`, parentID: "root", assigneeID: "b", state: "replied", outcome: "succeeded", resultMessageID: `m${index}`,
    })
    messages.push(testMessage(`m${index}`, `result-${index}-${"x".repeat(1000)}`, index + 1))
  }
  const context = contextForTask(
    { ...state, agents, workspaces: { w: workspace }, messages: { w: messages }, subtasks: tasks },
    root,
    workspace,
    agents.a,
  )
  const block = context.match(/<ensemble_branch_results>\n([\s\S]*?)\n<\/ensemble_branch_results>/)?.[1] ?? ""
  const lines = block.split("\n")
  assert.equal(lines.filter((line) => line.startsWith("- $Nova → $Sage:")).length, 20, "at most 20 branches are shown")
  assert.match(block, /^- \(\+5 more branches\)$/m)
  for (const line of lines.filter((item) => item.startsWith("- $Nova → $Sage:"))) {
    const result = line.slice("- $Nova → $Sage: ".length)
    assert.ok(result.length <= 601, `one branch result stays bounded to 600 chars plus the ellipsis: ${result.length}`)
    assert.match(result, /…$/)
  }
})

test("ticket249: the synthesis prompt asks for one concise summary and makes mentions references", () => {
  const root = testSubtask({ id: "root", instruction: "Ship the release and report blockers.", stage: "synthesis" })
  const prompt = promptForTask(root)
  assert.match(prompt, /^Synthesize\b/, "the synthesis prompt keeps its recognisable opening")
  assert.match(prompt, /one concise group summary/i)
  assert.match(prompt, /mentions are references/i)
  assert.match(prompt, /Original request: Ship the release and report blockers\./)
  const worker = promptForTask(testSubtask({ id: "w", instruction: "Do the work", constraints: "Keep it small" }))
  assert.match(worker, /Do the work\n\nConstraints: Keep it small/)
  assert.doesNotMatch(worker, /one concise group summary/i, "worker prompts keep the ordinary instruction shape")
})

test("assistantResult ignores native text from before the attempt started", () => {
  // The recovered request-23 shape: the native session still holds the old
  // assistant answer, but the new attempt produced no assistant text.
  const result = assistantResult(
    [{ type: "assistant", time: { created: 1 }, content: [{ type: "text", text: "Previous answer" }] }],
    100,
  )
  assert.equal(result.text, "")
})
