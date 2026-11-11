import test from "node:test"
import assert from "node:assert/strict"
import { completionDecision } from "./completion-decision.ts"

/**
 * Ticket #237: the completion hop exists for work the leader did not ask for.
 * When the leader was the parent, the peer turn's asker, or the handoff's
 * sender, the parent turn's synthesis already delivers the result — a second
 * completion turn would only make the leader answer twice.
 */

test("ticket237: a delegation under the leader's own task skips the completion hop", () => {
  const child = { id: "child", parentID: "parent" }
  const parent = { id: "parent", assigneeID: "leo" }
  assert.deepEqual(completionDecision({ task: child, parent, leaderID: "leo" }), {
    decision: "skip",
    reason: "parent-is-leader",
    taskID: "child",
    parentID: "parent",
    leaderID: "leo",
  })
})

test("ticket237: a peer turn the leader asked skips the completion hop", () => {
  const turn = {
    id: "turn",
    parentID: "leader_turn",
    turn: { correlationID: "peer_1", askerKind: "agent" as const, askerID: "leo" },
  }
  // Even with a missing parent record, the asker attribution alone is enough.
  assert.deepEqual(completionDecision({ task: turn, leaderID: "leo" }), {
    decision: "skip",
    reason: "asker-is-leader",
    taskID: "turn",
    parentID: "leader_turn",
    leaderID: "leo",
  })
})

test("ticket237: a handoff the leader sent skips the completion hop", () => {
  const hop = {
    id: "hop",
    parentID: "leader_task",
    handoff: { correlationID: "handoff_1", senderID: "leo", recipientID: "sage", depth: 1 },
  }
  assert.deepEqual(completionDecision({ task: hop, leaderID: "leo" }), {
    decision: "skip",
    reason: "sender-is-leader",
    taskID: "hop",
    parentID: "leader_task",
    leaderID: "leo",
  })
})

test("ticket237: work the leader did not ask still reaches the leader for review", () => {
  const parent = { id: "parent", assigneeID: "kim" }
  // A delegation under another member's task.
  assert.deepEqual(completionDecision({ task: { id: "child", parentID: "parent" }, parent, leaderID: "leo" }), { decision: "deliver" })
  // A peer turn another member asked.
  const peerTurn = { id: "turn", turn: { correlationID: "peer_2", askerKind: "agent" as const, askerID: "kim" } }
  assert.deepEqual(completionDecision({ task: peerTurn, leaderID: "leo" }), { decision: "deliver" })
  // A peer turn the user asked: no agent asker, so the leader reviews it.
  const userTurn = { id: "turn", turn: { correlationID: "peer_3", askerKind: "user" as const } }
  assert.deepEqual(completionDecision({ task: userTurn, leaderID: "leo" }), { decision: "deliver" })
  // A handoff another member sent.
  const handoff = { id: "hop", handoff: { correlationID: "handoff_2", senderID: "kim", recipientID: "sage", depth: 1 } }
  assert.deepEqual(completionDecision({ task: handoff, leaderID: "leo" }), { decision: "deliver" })
})

test("ticket237: the sender and asker forms win over the generic parent form", () => {
  const hop = {
    id: "hop",
    parentID: "leader_task",
    handoff: { correlationID: "handoff_3", senderID: "leo", recipientID: "sage", depth: 1 },
  }
  const parent = { id: "leader_task", assigneeID: "leo" }
  const decision = completionDecision({ task: hop, parent, leaderID: "leo" })
  assert.equal(decision.decision, "skip")
  if (decision.decision === "skip") assert.equal(decision.reason, "sender-is-leader")
})

test("ticket237: no leader means no skip", () => {
  assert.deepEqual(completionDecision({ task: { id: "child", parentID: "parent" }, leaderID: "" }), { decision: "deliver" })
})
