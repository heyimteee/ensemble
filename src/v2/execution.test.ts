import test from "node:test"
import assert from "node:assert/strict"
import { assistantResult, contextForTask, FALLBACK_REPLIES, isFallbackReply, recentGroupMessages } from "./execution.ts"
import { createInitialState } from "./defaults.ts"
import type { Agent, Subtask, Workspace } from "./types.ts"

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

test("assistantResult ignores native text from before the attempt started", () => {
  // The recovered request-23 shape: the native session still holds the old
  // assistant answer, but the new attempt produced no assistant text.
  const result = assistantResult(
    [{ type: "assistant", time: { created: 1 }, content: [{ type: "text", text: "Previous answer" }] }],
    100,
  )
  assert.equal(result.text, "")
})
