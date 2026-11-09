import test from "node:test"
import assert from "node:assert/strict"
import {
  NATIVE_SUBAGENT_ACTIVE_LIMIT,
  NATIVE_SUBAGENT_INSTRUCTION_LIMIT,
  boundNativeSubagentInstruction,
  nativeLateFollowUps,
  nativeSubagentChildID,
  nativeSubagentFallbackInstruction,
  nativeSubagentInstructionFromInput,
  nativeSubagentNextState,
  nativeSubagentToolName,
  rememberNativeSubagentActive,
} from "./native-subagents.ts"

test("native subagent instruction bounding keeps one safe line", () => {
  assert.equal(boundNativeSubagentInstruction("  watch\r\n\tthe   CI  "), "watch the CI")
  assert.equal(boundNativeSubagentInstruction(""), "")
  assert.equal(boundNativeSubagentInstruction(undefined), "")
  assert.equal(boundNativeSubagentInstruction(42), "")

  const long = "a".repeat(NATIVE_SUBAGENT_INSTRUCTION_LIMIT + 40)
  const bounded = boundNativeSubagentInstruction(long)
  assert.equal([...bounded].length, NATIVE_SUBAGENT_INSTRUCTION_LIMIT)
  assert.ok(bounded.endsWith("…"))
  assert.ok(!bounded.includes("\n"))
})

test("native subagent tool input selects a short description before a long prompt", () => {
  assert.equal(
    nativeSubagentInstructionFromInput({ description: "watch CI", prompt: "very long prompt text" }),
    "watch CI",
  )
  assert.equal(
    nativeSubagentInstructionFromInput({ prompt: "review\nthe patch" }),
    "review the patch",
  )
  assert.equal(nativeSubagentInstructionFromInput({ childSessionID: "child_1" }), "")
  assert.equal(nativeSubagentInstructionFromInput(null), "")
})

test("native subagent tool names are exact task or subagent names", () => {
  assert.equal(nativeSubagentToolName("task"), "task")
  assert.equal(nativeSubagentToolName(" SubAgent "), "subagent")
  assert.equal(nativeSubagentToolName("task_status"), undefined)
  assert.equal(nativeSubagentToolName(undefined), undefined)
})

test("native subagent child id accepts only the documented host fields", () => {
  assert.equal(nativeSubagentChildID({ childSessionID: "child_1" }), "child_1")
  assert.equal(nativeSubagentChildID({ session_id: "child_2" }), "child_2")
  assert.equal(nativeSubagentChildID({ sessionID: "" }), undefined)
  assert.equal(nativeSubagentChildID({ description: "not an id" }), undefined)
})

test("native subagent fallback uses the child title, then agent, then a stable word", () => {
  assert.equal(nativeSubagentFallbackInstruction({ title: "CI watcher", agent: "build" }), "CI watcher")
  assert.equal(nativeSubagentFallbackInstruction({ agent: "build" }), "build")
  assert.equal(nativeSubagentFallbackInstruction({}), "subagent")
})

test("native subagent state transitions are first-terminal, except an explicit reopen", () => {
  assert.equal(nativeSubagentNextState("working", "replied"), "replied")
  assert.equal(nativeSubagentNextState("working", "failed"), "failed")
  assert.equal(nativeSubagentNextState("replied", "working"), "working")
  assert.equal(nativeSubagentNextState("failed", "working"), "working")
  assert.equal(nativeSubagentNextState("cancelled", "working"), "cancelled")
  assert.equal(nativeSubagentNextState("replied", "cancelled"), "replied")
})

test("native subagent active map is bounded and evicts the oldest child", () => {
  const active = new Map<string, number>()
  for (let index = 0; index < NATIVE_SUBAGENT_ACTIVE_LIMIT + 3; index++) {
    rememberNativeSubagentActive(active, `child_${index}`, index)
  }
  assert.equal(active.size, NATIVE_SUBAGENT_ACTIVE_LIMIT)
  assert.equal(active.has("child_0"), false)
  assert.equal(active.has(`child_${NATIVE_SUBAGENT_ACTIVE_LIMIT + 2}`), true)
  rememberNativeSubagentActive(active, "child_5", 999)
  assert.equal([...active.keys()].at(-1), "child_5", "a reused child moves to newest")
})

test("ticket199: only late assistant text after the cutoff is a native follow-up", () => {
  const messages = [
    { id: "m0", type: "assistant", time: { created: 100 }, content: [{ type: "text", text: "PRE-CHILD" }] },
    { id: "m1", type: "user", time: { created: 110 }, content: [{ type: "text", text: "user text is never mirrored" }] },
    { id: "m2", type: "assistant", time: { created: 120 }, content: [{ type: "text", text: "LATE ONE" }, { type: "tool", name: "x" }] },
    { id: "m3", type: "assistant", time: { created: 130 }, content: [{ type: "reasoning", text: "hidden" }, { type: "text", text: "LATE TWO" }] },
    { id: "m4", type: "assistant", time: { created: 140 }, content: [{ type: "text", text: "   " }] },
    { id: "m5", type: "assistant", time: { created: new Date(150) }, content: [{ type: "text", text: "LATE THREE" }] },
  ]
  assert.deepEqual(nativeLateFollowUps(messages, 115, new Set(["m3"])), [
    { messageID: "m2", createdAt: 120, text: "LATE ONE" },
    { messageID: "m5", createdAt: 150, text: "LATE THREE" },
  ])
  assert.deepEqual(nativeLateFollowUps(messages, 120), [
    { messageID: "m3", createdAt: 130, text: "LATE TWO" },
    { messageID: "m5", createdAt: 150, text: "LATE THREE" },
  ], "a message exactly at the cutoff is not a late follow-up")
  assert.deepEqual(nativeLateFollowUps(messages, 150), [])
})

test("ticket199: a host without message ids gets a deterministic late follow-up identity", () => {
  const messages = [
    { type: "assistant", time: { created: 200 }, content: [{ type: "text", text: "NO HOST ID" }] },
    { type: "assistant", time: { created: 200 }, content: [{ type: "text", text: "NO HOST ID" }] },
  ]
  const first = nativeLateFollowUps(messages, 150)
  const second = nativeLateFollowUps(messages, 150)
  assert.equal(first.length, 2)
  assert.equal(first[0]!.messageID, second[0]!.messageID, "the fallback identity is stable across reads")
  assert.equal(first[0]!.messageID.length > 0, true)
  assert.deepEqual(
    nativeLateFollowUps(messages, 150, new Set([first[0]!.messageID])),
    [],
    "identical unidentifiable messages collapse to one durable identity",
  )
})
