import test from "node:test"
import assert from "node:assert/strict"
import { deriveWorkStatus } from "./queue.ts"
import { peerTurnStatus, isPeerTurn, peerRefusalText, archivedMentionRefs, bareMentionToken, outsideMentionRefs } from "./peer-turn.ts"
import type { Subtask } from "./types.ts"

const base = (patch: Partial<Subtask> = {}): Subtask => ({
  id: "t",
  workspaceID: "w",
  creatorType: "user",
  title: "Task",
  instruction: "Do",
  mode: "research",
  state: "pending",
  stage: "initial",
  outcome: "pending",
  interrupted: false,
  awaitingChildren: false,
  attempts: 0,
  createdAt: 1,
  workKind: "turn",
  ...patch,
})

test("peer-turn group states map onto the derived work lifecycle", () => {
  assert.equal(peerTurnStatus(base(), 1000), "queued")
  assert.equal(peerTurnStatus(base({ state: "working", attempts: 1, claimedBy: "run_1", leaseUntil: 2000 }), 1000), "running")
  assert.equal(peerTurnStatus(base({ state: "working", attempts: 1, claimedBy: "run_1", leaseUntil: 500 }), 1000), "waiting")
  assert.equal(peerTurnStatus(base({ attempts: 1 }), 1000), "queued")
  assert.equal(peerTurnStatus(base({ retryAfter: 2000 }), 1000), "queued", "a legacy zero-attempt delivery is queued")
  assert.equal(peerTurnStatus(base({ attempts: 1, retryAfter: 2000 }), 1000), "waiting")
  assert.equal(peerTurnStatus(base({ awaitingChildren: true }), 1000), "waiting")
  assert.equal(peerTurnStatus(base({ interrupted: true }), 1000), "waiting")
  assert.equal(peerTurnStatus(base({ attempts: 5 }), 1000), "stalled")
  assert.equal(peerTurnStatus(base({ state: "replied", outcome: "succeeded", repliedAt: 900 }), 1000), "completed")
  assert.equal(peerTurnStatus(base({ state: "replied", outcome: "failed", error: "boom" }), 1000), "failed")
  assert.equal(
    peerTurnStatus(base({ state: "replied", outcome: "failed", failure: { kind: "delivery", reason: "deadline-exceeded" } }), 1000),
    "stalled",
  )
})

test("cancelled peer turns stay cancelled on the group surface", () => {
  const task = base({ state: "replied", outcome: "failed", error: "Cancelled by user.", stoppedAt: 900 })
  assert.equal(deriveWorkStatus(task, 1000), "cancelled")
  assert.equal(peerTurnStatus(task, 1000), "cancelled")
})

test("only workKind turn rows count as peer turns", () => {
  assert.equal(isPeerTurn(base()), true)
  assert.equal(isPeerTurn(base({ workKind: "delegation" })), false)
  assert.equal(isPeerTurn(base({ workKind: "handoff" })), false)
  assert.equal(isPeerTurn(base({ workKind: undefined })), false)
})

test("peer refusal copy uses $Name and never @Name", () => {
  const text = peerRefusalText("Sage", "the delegation limit is 3.")
  assert.match(text, /\$Sage/)
  assert.ok(!text.includes("@"))
  assert.match(text, /the delegation limit is 3/)
})

test("archived mentions resolve to the archived agent, never silently", () => {
  const agents = {
    sage: { id: "sage", name: "Sage", archived: false },
    retired: { id: "retired", name: "Retired", archived: true },
  } as any
  assert.deepEqual(archivedMentionRefs("$Retired take a look", agents).map((agent) => agent.id), ["retired"])
  assert.deepEqual(archivedMentionRefs("!retired take a look", agents).map((agent) => agent.id), ["retired"])
  assert.deepEqual(archivedMentionRefs("$Sage take a look", agents), [])
  assert.deepEqual(archivedMentionRefs("Retired take a look", agents), [])
  assert.deepEqual(archivedMentionRefs("hello team", agents), [])
})

test("bare mention tokens strip the sigil", () => {
  assert.equal(bareMentionToken("$Ghost"), "Ghost")
  assert.equal(bareMentionToken("!Ghost"), "Ghost")
})

test("outside mentions resolve to non-member roster agents only", () => {
  const agents = {
    nova: { id: "nova", name: "Nova", archived: false },
    echo: { id: "echo", name: "Echo", archived: false },
    retired: { id: "retired", name: "Retired", archived: true },
  } as any
  assert.deepEqual(outsideMentionRefs("$Echo help", agents, ["nova"], "nova").map((agent) => agent.id), ["echo"])
  assert.deepEqual(outsideMentionRefs("$Nova help", agents, ["echo"], "echo").map((agent) => agent.id), ["nova"])
  assert.deepEqual(outsideMentionRefs("$Echo help", agents, ["nova"], "echo"), [])
  assert.deepEqual(outsideMentionRefs("$Retired help", agents, ["nova"], "nova"), [])
  assert.deepEqual(outsideMentionRefs("hello team", agents, ["nova"], "nova"), [])
})
