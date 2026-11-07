import test from "node:test"
import assert from "node:assert/strict"
import {
  COMPLETION_CHAIN_MAX,
  COMPLETION_QUIET_WINDOW_MS,
  REVIEW_ACTIONS,
  batchReviewText,
  batchReviewTitle,
  batchAllDecided,
  checkCompletionRoute,
  completionWorkKey,
  groupCompletionCandidates,
  parseReviewDecisions,
} from "./handoff.ts"

// Ticket #71: loop guards force a leader/termination fallback at the cap and
// never invent agent syntax — `$Name`, `@` file-only.

test("completion chain terminates at the depth cap", () => {
  assert.equal(COMPLETION_CHAIN_MAX, 3)
  assert.equal(COMPLETION_QUIET_WINDOW_MS, 1_000)
  const routed = checkCompletionRoute({ chain: [], senderID: "sage", candidateID: "nova", leaderID: "nova" })
  assert.deepEqual(routed, { decision: "route", to: "nova" })
  const capped = checkCompletionRoute({ chain: ["a", "b", "c"], senderID: "sage", candidateID: "nova", leaderID: "nova" })
  assert.deepEqual(capped, { decision: "terminate", reason: "depth-cap" })
})

test("immediate back-and-forth reroutes to the leader", () => {
  const pingpong = checkCompletionRoute({ chain: ["sage"], senderID: "nova", candidateID: "sage", leaderID: "leo" })
  assert.deepEqual(pingpong, { decision: "reroute", to: "leo", reason: "ping-pong" })
  // The default route home to the leader is never a ping-pong refusal.
  const home = checkCompletionRoute({ chain: ["nova"], senderID: "sage", candidateID: "nova", leaderID: "nova" })
  assert.deepEqual(home, { decision: "route", to: "nova" })
})

test("repeated recipients reroute to the leader", () => {
  const repeated = checkCompletionRoute({ chain: ["kim", "sage"], senderID: "ari", candidateID: "kim", leaderID: "leo" })
  assert.deepEqual(repeated, { decision: "reroute", to: "leo", reason: "repeated-recipient" })
  // The leader stays the accountable end of the line even when already seen.
  const leaderAgain = checkCompletionRoute({ chain: ["leo", "sage"], senderID: "ari", candidateID: "leo", leaderID: "leo" })
  assert.deepEqual(leaderAgain, { decision: "route", to: "leo" })
})

test("completion keys scope one hop per finished task and recipient", () => {
  const first = completionWorkKey({ workspaceID: "w", finishedTaskID: "t1", recipientID: "nova" })
  assert.ok(first.startsWith("completion:"))
  assert.notEqual(first, completionWorkKey({ workspaceID: "w", finishedTaskID: "t2", recipientID: "nova" }))
  assert.notEqual(first, completionWorkKey({ workspaceID: "w", finishedTaskID: "t1", recipientID: "sage" }))
  assert.equal(first, completionWorkKey({ workspaceID: "w", finishedTaskID: "t1", recipientID: "nova" }))
})

test("batch grouping collects pending unbatched completions per recipient", () => {
  const tasks = [
    { id: "c1", workspaceID: "w", state: "pending", workKind: "handoff", assigneeID: "nova", createdAt: 2, handoff: { completion: true } },
    { id: "c2", workspaceID: "w", state: "pending", workKind: "handoff", assigneeID: "nova", createdAt: 1, handoff: { completion: true } },
    { id: "done", workspaceID: "w", state: "replied", workKind: "handoff", assigneeID: "nova", createdAt: 0, handoff: { completion: true } },
    { id: "batched", workspaceID: "w", state: "pending", workKind: "handoff", assigneeID: "nova", createdAt: 0, handoff: { completion: true, batchedIn: "b1" } },
    { id: "plain", workspaceID: "w", state: "pending", workKind: "handoff", assigneeID: "nova", createdAt: 0, handoff: {} },
    { id: "other", workspaceID: "w", state: "pending", workKind: "handoff", assigneeID: "sage", createdAt: 0, handoff: { completion: true } },
  ] as any[]
  assert.deepEqual(groupCompletionCandidates(tasks, "w", "nova"), ["c2", "c1"])
  assert.deepEqual(groupCompletionCandidates(tasks, "w", "sage"), ["other"])
  assert.deepEqual(groupCompletionCandidates(tasks, "w", "nobody"), [])
})

test("batch grouping never consolidates completions across dispatch groups", () => {
  const tasks = [
    { id: "g1a", workspaceID: "w", state: "pending", workKind: "handoff", assigneeID: "nova", createdAt: 1, dispatchGroupID: "dispatch_1", handoff: { completion: true } },
    { id: "g2a", workspaceID: "w", state: "pending", workKind: "handoff", assigneeID: "nova", createdAt: 2, dispatchGroupID: "dispatch_2", handoff: { completion: true } },
    { id: "g1b", workspaceID: "w", state: "pending", workKind: "handoff", assigneeID: "nova", createdAt: 3, dispatchGroupID: "dispatch_1", handoff: { completion: true } },
  ] as any[]
  assert.deepEqual(groupCompletionCandidates(tasks, "w", "nova", "dispatch_1"), ["g1a", "g1b"])
  assert.deepEqual(groupCompletionCandidates(tasks, "w", "nova", "dispatch_2"), ["g2a"])
  assert.deepEqual(groupCompletionCandidates(tasks, "w", "nova", "dispatch_3"), [])
  // Without a group filter the pure helper still lists every live candidate;
  // the service passes one resolved group per consolidation pass.
  assert.deepEqual(groupCompletionCandidates(tasks, "w", "nova"), ["g1a", "g2a", "g1b"])
})

test("batch review copy lists sender, title, outcome, and path with $Name grammar", () => {
  assert.equal(batchReviewTitle(2), "Review 2 completions")
  const text = batchReviewText(
    [
      { id: "c1", senderName: "Sage", title: "Summarize the deploy", outcome: "succeeded", path: ".ensemble/handoffs/a.md" },
      { id: "c2", senderName: "Kim", title: "Draft notes", outcome: "succeeded" },
    ],
    "Nova",
  )
  assert.match(text, /\$Sage/)
  assert.match(text, /Summarize the deploy/)
  assert.match(text, /succeeded/)
  assert.match(text, /@\.ensemble\/handoffs\/a\.md/)
  assert.ok(!text.includes("@Sage") && !text.includes("@Kim") && !text.includes("@Nova"))
  for (const action of ["delegate", "start", "end", "dismiss"]) assert.ok(text.includes(action))
})

test("batch review copy has one closing grammar with no empty-branch artifact", () => {
  const text = batchReviewText(
    [{ id: "c1", senderName: "Sage", title: "Summarize the deploy", outcome: "succeeded" }],
    "Nova",
  )
  assert.ok(text.endsWith("The batch closes only when every item is acted on or dismissed."))
  assert.ok(!text.includes("${") && !text.includes("  "))
  // Empty batches never form (the scheduler only mints a batch for pending
  // completions), so the copy carries no special empty branch — it just
  // names the zero count with the same closing grammar.
  const empty = batchReviewText([], "Nova")
  assert.ok(empty.includes("review 0 completions"))
  assert.ok(empty.endsWith("The batch closes only when every item is acted on or dismissed."))
})

test("review decisions parse per-item actions and refuse bad input", () => {
  assert.deepEqual(REVIEW_ACTIONS, ["delegate", "start", "end", "dismiss"])
  const parsed = parseReviewDecisions({
    decisions: [
      { item: "c1", action: "delegate", assignee: "Kim", note: "Follow up" },
      { item: "c2", action: "end" },
    ],
  })
  assert.equal(parsed.ok, true)
  if (parsed.ok) {
    assert.equal(parsed.decisions.length, 2)
    assert.equal(parsed.decisions[0].assignee, "Kim")
  }
  for (const bad of [
    {},
    { decisions: [] },
    { decisions: [{ item: "", action: "end" }] },
    { decisions: [{ item: "c1", action: "delete" }] },
    { decisions: [{ item: "c1", action: "delegate" }] },
    { decisions: [{ item: "c1", action: "end" }, { item: "c1", action: "dismiss" }] },
  ]) {
    const refused = parseReviewDecisions(bad)
    assert.equal(refused.ok, false)
    if (!refused.ok) assert.ok(refused.reason.length > 0)
  }
})

test("batch closure needs every item decided", () => {
  assert.equal(batchAllDecided(["c1", "c2"], { c1: "ended" }), false)
  assert.equal(batchAllDecided(["c1", "c2"], { c1: "ended", c2: "dismissed" }), true)
  assert.equal(batchAllDecided([], {}), true)
})
