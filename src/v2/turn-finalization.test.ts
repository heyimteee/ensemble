import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { decideTurnFinalization, type TurnFinalizationFacts } from "./turn-finalization.ts"
import { REVIEW_INCOMPLETE_REASON } from "./types.ts"

function facts(
  patch: Partial<Omit<TurnFinalizationFacts, "task">> & { task?: Partial<TurnFinalizationFacts["task"]> } = {},
): TurnFinalizationFacts {
  return {
    task: {
      batch: false,
      leader: false,
      explicitHandoff: false,
      batchCorrectionSent: false,
      mentionCorrectionSent: false,
      ...patch.task,
    },
    nativeChildren: patch.nativeChildren ?? [],
    batchItems: patch.batchItems ?? [],
    finalText: {
      text: "Finished the work.",
      mentionedMemberIDs: [],
      ...patch.finalText,
    },
    createdWork: patch.createdWork ?? [],
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

/**
 * Ticket #194/#197/#198/#200: the single turn-finalization policy must decide
 * every managed turn shape. #194 wired the accept path, #197 adds the native
 * child hold, #198 the batch-review contract, and #200 unbacked member
 * mentions, so the matrix pins the decision for each shape rather than growing
 * parallel finalization checks.
 */
const matrix: Array<{ name: string; input: TurnFinalizationFacts; expected: ReturnType<typeof decideTurnFinalization> }> = [
  {
    name: "normal delegated turn",
    input: facts(),
    expected: { action: "accept" },
  },
  {
    name: "leader turn",
    input: facts({ task: { leader: true } }),
    expected: { action: "accept" },
  },
  {
    name: "explicit handoff hop",
    input: facts({ task: { explicitHandoff: true } }),
    expected: { action: "accept" },
  },
  {
    name: "completion delivery",
    input: facts(),
    expected: { action: "accept" },
  },
  {
    name: "peer turn",
    input: facts(),
    expected: { action: "accept" },
  },
  {
    name: "native-subagent parent with a live child",
    input: facts({
      nativeChildren: [
        { childSessionID: "child_1", parentTaskID: "task_1", state: "working", startedAt: 10 },
        { childSessionID: "child_2", parentTaskID: "task_1", state: "replied", startedAt: 10, finishedAt: 20 },
      ],
    }),
    expected: { action: "wait", reason: "native-child-active" },
  },
  {
    name: "native-subagent parent after the child finished",
    input: facts({
      nativeChildren: [
        { childSessionID: "child_2", parentTaskID: "task_1", state: "replied", startedAt: 10, finishedAt: 20 },
      ],
    }),
    expected: { action: "accept" },
  },
  {
    name: "batch review with undecided items",
    input: facts({
      task: { batch: true, leader: true },
      batchItems: [
        { id: "task_a" },
        { id: "task_b", decided: "ended" },
        { id: "task_c", decided: "dismissed" },
      ],
    }),
    expected: { action: "correct", reason: REVIEW_INCOMPLETE_REASON, remainingIDs: ["task_a"] },
  },
  {
    name: "batch review after its one correction",
    input: facts({
      task: { batch: true, leader: true, batchCorrectionSent: true },
      batchItems: [
        { id: "task_a" },
        { id: "task_b", decided: "ended" },
      ],
    }),
    expected: { action: "warn", reason: REVIEW_INCOMPLETE_REASON, remainingIDs: ["task_a"] },
  },
  {
    name: "fully decided batch review",
    input: facts({
      task: { batch: true, leader: true },
      batchItems: [
        { id: "task_a", decided: "ended" },
        { id: "task_b", decided: "dismissed" },
      ],
    }),
    expected: { action: "accept" },
  },
  {
    name: "mention-bearing answer with no created work",
    input: facts({
      finalText: { text: "Done. $Sage can pick this up next.", mentionedMemberIDs: ["agent_sage"] },
    }),
    expected: { action: "correct", reason: "mention-unbacked", unbackedMemberIDs: ["agent_sage"] },
  },
  {
    name: "mention-bearing answer after its one correction",
    input: facts({
      task: { mentionCorrectionSent: true },
      finalText: { text: "Done. $Sage can pick this up next.", mentionedMemberIDs: ["agent_sage"] },
    }),
    expected: { action: "warn", reason: "mention-unbacked", unbackedMemberIDs: ["agent_sage"] },
  },
  {
    name: "mention-bearing answer backed by created work",
    input: facts({
      finalText: { text: "Done. $Sage has the follow-up.", mentionedMemberIDs: ["agent_sage"] },
      createdWork: [{ workID: "task_child", workKind: "handoff", assigneeID: "agent_sage" }],
    }),
    expected: { action: "accept" },
  },
  {
    name: "mention-bearing answer backed by a peer turn",
    input: facts({
      finalText: { text: "Done. $Sage is answering in the group.", mentionedMemberIDs: ["agent_sage"] },
      createdWork: [{ workID: "task_peer", workKind: "turn", assigneeID: "agent_sage" }],
    }),
    expected: { action: "accept" },
  },
  {
    name: "partly backed mentions only correct the unbacked member",
    input: facts({
      finalText: { text: "Done. $Sage has work; $Echo should too.", mentionedMemberIDs: ["agent_sage", "agent_echo"] },
      createdWork: [{ workID: "task_child", workKind: "handoff", assigneeID: "agent_sage" }],
    }),
    expected: { action: "correct", reason: "mention-unbacked", unbackedMemberIDs: ["agent_echo"] },
  },
  {
    name: "leader mention backed by the mandatory completion delivery",
    input: facts({
      task: { leaderMemberID: "agent_leader" },
      finalText: { text: "$Leader, please review.", mentionedMemberIDs: ["agent_leader"] },
    }),
    expected: { action: "accept" },
  },
  {
    name: "leader mention without a mandatory completion delivery",
    input: facts({
      task: { leaderMemberID: "agent_leader", explicitHandoff: true },
      finalText: { text: "$Leader, please review.", mentionedMemberIDs: ["agent_leader"] },
    }),
    expected: { action: "correct", reason: "mention-unbacked", unbackedMemberIDs: ["agent_leader"] },
  },
  {
    name: "leader mention in a batch review",
    input: facts({
      task: { batch: true, leader: true, leaderMemberID: "agent_leader" },
      batchItems: [{ id: "task_a", decided: "ended" }],
      finalText: { text: "$Leader, please review.", mentionedMemberIDs: ["agent_leader"] },
    }),
    expected: { action: "correct", reason: "mention-unbacked", unbackedMemberIDs: ["agent_leader"] },
  },
  {
    name: "leader mention when the finisher is the leader",
    input: facts({
      task: { leader: true, leaderMemberID: "agent_leader" },
      finalText: { text: "$Leader, please review.", mentionedMemberIDs: ["agent_leader"] },
    }),
    expected: { action: "correct", reason: "mention-unbacked", unbackedMemberIDs: ["agent_leader"] },
  },
]

test("ticket194: the turn-finalization decision matrix covers every managed turn shape", async (t) => {
  for (const scenario of matrix) {
    await t.test(scenario.name, () => {
      assert.deepEqual(decideTurnFinalization(scenario.input), scenario.expected)
    })
  }
})

test("ticket197: a live native child holds the turn before any correction", () => {
  const input = facts({
    nativeChildren: [{ childSessionID: "child_1", parentTaskID: "task_1", state: "working", startedAt: 10 }],
    task: { batch: true, leader: true, batchCorrectionSent: true },
    batchItems: [{ id: "task_a" }],
    finalText: { text: "$Sage can take this.", mentionedMemberIDs: ["agent_sage"] },
  })
  assert.deepEqual(decideTurnFinalization(input), { action: "wait", reason: "native-child-active" })
})

test("ticket200: an unbacked mention gets exactly one correction before an honest warning", () => {
  const first = facts({
    finalText: { text: "Done. $Sage can pick this up next.", mentionedMemberIDs: ["agent_sage"] },
  })
  assert.deepEqual(decideTurnFinalization(first), {
    action: "correct",
    reason: "mention-unbacked",
    unbackedMemberIDs: ["agent_sage"],
  })
  const corrected = facts({
    task: { mentionCorrectionSent: true },
    finalText: { text: "Done. $Sage can pick this up next.", mentionedMemberIDs: ["agent_sage"] },
  })
  assert.deepEqual(decideTurnFinalization(corrected), {
    action: "warn",
    reason: "mention-unbacked",
    unbackedMemberIDs: ["agent_sage"],
  })
})

test("ticket198: a batch review gets exactly one correction before an honest warning", () => {
  const undecided = facts({
    task: { batch: true, leader: true },
    batchItems: [{ id: "task_a" }, { id: "task_b" }, { id: "task_c", decided: "started" }],
  })
  assert.deepEqual(decideTurnFinalization(undecided), {
    action: "correct",
    reason: REVIEW_INCOMPLETE_REASON,
    remainingIDs: ["task_a", "task_b"],
  })
  const corrected = facts({
    task: { batch: true, leader: true, batchCorrectionSent: true },
    batchItems: [{ id: "task_a" }, { id: "task_b" }],
  })
  assert.deepEqual(decideTurnFinalization(corrected), {
    action: "warn",
    reason: REVIEW_INCOMPLETE_REASON,
    remainingIDs: ["task_a", "task_b"],
  })
})

test("ticket194: the policy reads its facts without mutating them", () => {
  const input = deepFreeze(facts({
    task: { batch: true, leader: false, leaderMemberID: "agent_leader", explicitHandoff: false },
    nativeChildren: [{ childSessionID: "child_1", parentTaskID: "task_1", state: "replied", startedAt: 10, finishedAt: 20 }],
    batchItems: [{ id: "task_a" }, { id: "task_b", decided: "started" }],
    finalText: { text: "$Sage please review.", mentionedMemberIDs: ["agent_sage"] },
    createdWork: [{ workID: "task_child", workKind: "handoff", assigneeID: "agent_sage" }],
  }))
  assert.deepEqual(decideTurnFinalization(input), {
    action: "correct",
    reason: REVIEW_INCOMPLETE_REASON,
    remainingIDs: ["task_a"],
  })
})

test("ticket194: the service consults the one policy seam inside runTask", () => {
  // Narrow wiring guard: the policy matrix above and the service behavior
  // tests prove every decision; this pins only that runTask is the single
  // owner of the policy call, so a parallel finalization check cannot creep
  // into another service method.
  const source = readFileSync(new URL("./service.ts", import.meta.url), "utf8")
  const runTaskAt = source.indexOf("private async runTask(")
  assert.ok(runTaskAt > 0, "runTask owns the terminal-write boundary")
  const nextMethodAt = source.indexOf("\n  private ", runTaskAt + 1)
  assert.ok(nextMethodAt > runTaskAt)
  const runTask = source.slice(runTaskAt, nextMethodAt)
  assert.ok((runTask.match(/decideTurnFinalization\(/g) ?? []).length >= 1)
  const outside = `${source.slice(0, runTaskAt)}${source.slice(nextMethodAt)}`
  assert.equal((outside.match(/decideTurnFinalization\(/g) ?? []).length, 0, "no other method consults the policy")
})
