import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { decideTurnFinalization, type TurnFinalizationFacts } from "./turn-finalization.ts"

function facts(patch: Partial<TurnFinalizationFacts> = {}): TurnFinalizationFacts {
  return {
    task: {
      taskID: "task_1",
      workKind: "delegation",
      completion: false,
      batch: false,
      leader: false,
      explicitHandoff: false,
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
 * Ticket #194: the single turn-finalization policy must decide every managed
 * turn shape. This ticket wires only the accept path, so the matrix pins the
 * current decision for each shape; #197/#198/#200 extend the same seam rather
 * than adding parallel finalization checks.
 */
const matrix: Array<{ name: string; input: TurnFinalizationFacts }> = [
  {
    name: "normal delegated turn",
    input: facts(),
  },
  {
    name: "leader turn",
    input: facts({ task: { taskID: "task_1", workKind: "delegation", completion: false, batch: false, leader: true, explicitHandoff: false } }),
  },
  {
    name: "explicit handoff hop",
    input: facts({ task: { taskID: "task_1", workKind: "handoff", completion: false, batch: false, leader: false, explicitHandoff: true } }),
  },
  {
    name: "completion delivery",
    input: facts({ task: { taskID: "task_1", workKind: "handoff", completion: true, batch: false, leader: false, explicitHandoff: false } }),
  },
  {
    name: "peer turn",
    input: facts({ task: { taskID: "task_1", workKind: "turn", completion: false, batch: false, leader: false, explicitHandoff: false } }),
  },
  {
    name: "batch review with undecided items",
    input: facts({
      task: { taskID: "task_1", workKind: "handoff", completion: true, batch: true, leader: true, explicitHandoff: false },
      batchItems: [
        { id: "task_a" },
        { id: "task_b", decided: "ended" },
        { id: "task_c", decided: "dismissed" },
      ],
    }),
  },
  {
    name: "native-subagent parent",
    input: facts({
      nativeChildren: [
        { childSessionID: "child_1", parentTaskID: "task_1", state: "working", startedAt: 10 },
        { childSessionID: "child_2", parentTaskID: "task_1", state: "replied", startedAt: 10, finishedAt: 20 },
      ],
    }),
  },
  {
    name: "mention-bearing answer with no created work",
    input: facts({
      finalText: { text: "Done. $Sage can pick this up next.", mentionedMemberIDs: ["agent_sage"] },
    }),
  },
  {
    name: "mention-bearing answer backed by created work",
    input: facts({
      finalText: { text: "Done. $Sage has the follow-up.", mentionedMemberIDs: ["agent_sage"] },
      createdWork: [{ workID: "task_child", workKind: "handoff", assigneeID: "agent_sage" }],
    }),
  },
  {
    name: "mention-bearing answer backed by a peer turn",
    input: facts({
      finalText: { text: "Done. $Sage is answering in the group.", mentionedMemberIDs: ["agent_sage"] },
      createdWork: [{ workID: "task_peer", workKind: "turn", assigneeID: "agent_sage" }],
    }),
  },
]

test("ticket194: the turn-finalization decision matrix accepts every managed turn shape", async (t) => {
  for (const scenario of matrix) {
    await t.test(scenario.name, () => {
      assert.deepEqual(decideTurnFinalization(scenario.input), { action: "accept" })
    })
  }
})

test("ticket194: the policy reads its facts without mutating them", () => {
  const input = deepFreeze(facts({
    task: { taskID: "task_1", workKind: "handoff", completion: true, batch: true, leader: false, explicitHandoff: false },
    nativeChildren: [{ childSessionID: "child_1", parentTaskID: "task_1", state: "working", startedAt: 10 }],
    batchItems: [{ id: "task_a" }, { id: "task_b", decided: "started" }],
    finalText: { text: "$Sage please review.", mentionedMemberIDs: ["agent_sage"] },
    createdWork: [{ workID: "task_child", workKind: "handoff", assigneeID: "agent_sage" }],
  }))
  assert.deepEqual(decideTurnFinalization(input), { action: "accept" })
})

test("ticket194: the service consults the policy once at the terminal-write boundary", () => {
  // Narrow wiring guard: the policy matrix above proves the decision; this
  // only pins that the one seam is called on the success path before the
  // completion handoff and the terminal save.
  const source = readFileSync(new URL("./service.ts", import.meta.url), "utf8")
  const calls = source.match(/decideTurnFinalization\(/g) ?? []
  assert.equal(calls.length, 1)
  const decisionAt = source.indexOf("decideTurnFinalization(")
  const handoffAt = source.indexOf("await this.ensureCompletionHandoff(", decisionAt)
  const terminalAt = source.indexOf('currentTask.state = "replied"', decisionAt)
  assert.ok(decisionAt > 0)
  assert.ok(handoffAt > decisionAt)
  assert.ok(terminalAt > decisionAt)
})
