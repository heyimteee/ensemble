import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { decideTurnFinalization, type TurnFinalizationFacts } from "./turn-finalization.ts"

function facts(
  patch: Partial<Omit<TurnFinalizationFacts, "task">> & { task?: Partial<TurnFinalizationFacts["task"]> } = {},
): TurnFinalizationFacts {
  return {
    task: {
      taskID: "task_1",
      workKind: "delegation",
      completion: false,
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
 * Ticket #194/#198/#200: the single turn-finalization policy must decide every
 * managed turn shape. #194 wired the accept path, #198 added the batch-review
 * contract, and #200 adds unbacked member mentions, so the matrix pins the
 * decision for each shape rather than growing parallel finalization checks.
 */
const matrix: Array<{ name: string; input: TurnFinalizationFacts; expected: ReturnType<typeof decideTurnFinalization> }> = [
  {
    name: "normal delegated turn",
    input: facts(),
    expected: { action: "accept" },
  },
  {
    name: "leader turn",
    input: facts({ task: { taskID: "task_1", workKind: "delegation", completion: false, batch: false, leader: true, explicitHandoff: false, batchCorrectionSent: false } }),
    expected: { action: "accept" },
  },
  {
    name: "explicit handoff hop",
    input: facts({ task: { taskID: "task_1", workKind: "handoff", completion: false, batch: false, leader: false, explicitHandoff: true, batchCorrectionSent: false } }),
    expected: { action: "accept" },
  },
  {
    name: "completion delivery",
    input: facts({ task: { taskID: "task_1", workKind: "handoff", completion: true, batch: false, leader: false, explicitHandoff: false, batchCorrectionSent: false } }),
    expected: { action: "accept" },
  },
  {
    name: "peer turn",
    input: facts({ task: { taskID: "task_1", workKind: "turn", completion: false, batch: false, leader: false, explicitHandoff: false, batchCorrectionSent: false } }),
    expected: { action: "accept" },
  },
  {
    name: "batch review with undecided items",
    input: facts({
      task: { taskID: "task_1", workKind: "handoff", completion: true, batch: true, leader: true, explicitHandoff: false, batchCorrectionSent: false },
      batchItems: [
        { id: "task_a" },
        { id: "task_b", decided: "ended" },
        { id: "task_c", decided: "dismissed" },
      ],
    }),
    expected: { action: "correct", reason: "review-incomplete", remainingIDs: ["task_a"] },
  },
  {
    name: "batch review after its one correction",
    input: facts({
      task: { taskID: "task_1", workKind: "handoff", completion: true, batch: true, leader: true, explicitHandoff: false, batchCorrectionSent: true },
      batchItems: [
        { id: "task_a" },
        { id: "task_b", decided: "ended" },
      ],
    }),
    expected: { action: "warn", reason: "review-incomplete", remainingIDs: ["task_a"] },
  },
  {
    name: "fully decided batch review",
    input: facts({
      task: { taskID: "task_1", workKind: "handoff", completion: true, batch: true, leader: true, explicitHandoff: false, batchCorrectionSent: false },
      batchItems: [
        { id: "task_a", decided: "ended" },
        { id: "task_b", decided: "dismissed" },
      ],
    }),
    expected: { action: "accept" },
  },
  {
    name: "native-subagent parent",
    input: facts({
      nativeChildren: [
        { childSessionID: "child_1", parentTaskID: "task_1", state: "working", startedAt: 10 },
        { childSessionID: "child_2", parentTaskID: "task_1", state: "replied", startedAt: 10, finishedAt: 20 },
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
]

test("ticket194: the turn-finalization decision matrix covers every managed turn shape", async (t) => {
  for (const scenario of matrix) {
    await t.test(scenario.name, () => {
      assert.deepEqual(decideTurnFinalization(scenario.input), scenario.expected)
    })
  }
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
    task: { taskID: "task_1", workKind: "handoff", completion: true, batch: true, leader: true, explicitHandoff: false, batchCorrectionSent: false },
    batchItems: [{ id: "task_a" }, { id: "task_b" }, { id: "task_c", decided: "started" }],
  })
  assert.deepEqual(decideTurnFinalization(undecided), {
    action: "correct",
    reason: "review-incomplete",
    remainingIDs: ["task_a", "task_b"],
  })
  const corrected = facts({
    task: { taskID: "task_1", workKind: "handoff", completion: true, batch: true, leader: true, explicitHandoff: false, batchCorrectionSent: true },
    batchItems: [{ id: "task_a" }, { id: "task_b" }],
  })
  assert.deepEqual(decideTurnFinalization(corrected), {
    action: "warn",
    reason: "review-incomplete",
    remainingIDs: ["task_a", "task_b"],
  })
})

test("ticket194: the policy reads its facts without mutating them", () => {
  const input = deepFreeze(facts({
    task: { taskID: "task_1", workKind: "handoff", completion: true, batch: true, leader: false, explicitHandoff: false, batchCorrectionSent: false },
    nativeChildren: [{ childSessionID: "child_1", parentTaskID: "task_1", state: "working", startedAt: 10 }],
    batchItems: [{ id: "task_a" }, { id: "task_b", decided: "started" }],
    finalText: { text: "$Sage please review.", mentionedMemberIDs: ["agent_sage"] },
    createdWork: [{ workID: "task_child", workKind: "handoff", assigneeID: "agent_sage" }],
  }))
  assert.deepEqual(decideTurnFinalization(input), {
    action: "correct",
    reason: "review-incomplete",
    remainingIDs: ["task_a"],
  })
})

test("ticket194: the service consults the policy at the terminal-write boundary", () => {
  // Narrow wiring guard: the policy matrix above proves the decision; this
  // only pins that the one seam is called on the success path before the
  // completion handoff and the terminal save. Ticket #198 may consult it a
  // second time after a correction; both answers stay ahead of the write.
  const source = readFileSync(new URL("./service.ts", import.meta.url), "utf8")
  const calls = source.match(/decideTurnFinalization\(/g) ?? []
  assert.ok(calls.length >= 1, "the service uses the one policy seam")
  const decisionAt = source.indexOf("decideTurnFinalization(")
  const lastDecisionAt = source.lastIndexOf("decideTurnFinalization(")
  const handoffAt = source.indexOf("await this.ensureCompletionHandoff(", lastDecisionAt)
  const terminalAt = source.indexOf('currentTask.state = "replied"', lastDecisionAt)
  assert.ok(decisionAt > 0)
  assert.ok(handoffAt > lastDecisionAt)
  assert.ok(terminalAt > lastDecisionAt)
})
