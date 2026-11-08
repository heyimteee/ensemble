import test from "node:test"
import assert from "node:assert/strict"
import { isSubstantiveReply, planLateSuccessRepair, settlementText, shouldInterruptSettledReply } from "./stream-settlement.ts"
import type { Message } from "./types.ts"

const message = (patch: Partial<Message> = {}): Message => ({
  id: "m",
  workspaceID: "w",
  seq: 1,
  author: "agent",
  agentID: "a",
  text: "",
  kind: "text",
  createdAt: 1,
  ...patch,
})

test("ticket169: substantive text never counts as an internal fallback", () => {
  assert.equal(isSubstantiveReply("The final answer."), true)
  assert.equal(isSubstantiveReply("  The final answer.  "), true)
  assert.equal(isSubstantiveReply(""), false)
  assert.equal(isSubstantiveReply("   "), false)
  assert.equal(isSubstantiveReply("Reply interrupted."), false)
  assert.equal(isSubstantiveReply("Reply completed."), false)
  assert.equal(isSubstantiveReply("Reply interrupted before completion."), false)
  assert.equal(isSubstantiveReply(undefined), false)
})

test("ticket169: only an empty stream settles to the interruption placeholder", () => {
  assert.equal(settlementText(""), "Reply interrupted.")
  assert.equal(settlementText("   "), "Reply interrupted.")
  assert.equal(settlementText("A real answer."), "A real answer.")
  assert.equal(settlementText("Reply interrupted."), "Reply interrupted.")
})

test("ticket169: deadline, lease, queue, and stall states never interrupt a non-empty stream", () => {
  for (const status of ["pending", "working", "waiting", "retrying", "stalled", "replied"] as const) {
    assert.equal(
      shouldInterruptSettledReply({ text: "A real answer.", status }),
      false,
      `${status} must preserve a substantive reply`,
    )
  }
  for (const kind of ["delivery", "lease", "attempts"] as const) {
    assert.equal(
      shouldInterruptSettledReply({ text: "A real answer.", status: "stalled", failureKind: kind }),
      false,
      `${kind} is a queue cause, never a false interruption`,
    )
  }
})

test("ticket169: empty and internal-fallback streams stay interrupted", () => {
  assert.equal(shouldInterruptSettledReply({ text: "", status: "replied" }), true)
  assert.equal(shouldInterruptSettledReply({ text: "   ", status: "replied" }), true)
  assert.equal(shouldInterruptSettledReply({ text: "Reply completed.", status: "replied" }), true)
  assert.equal(shouldInterruptSettledReply({ text: "Reply interrupted.", status: "stalled" }), true)
})

test("ticket169: a genuine host interruption or native failure still interrupts a substantive reply", () => {
  assert.equal(shouldInterruptSettledReply({ text: "A real answer.", status: "cancelled", stopped: true }), true)
  assert.equal(shouldInterruptSettledReply({ text: "A real answer.", status: "needs_you" }), true)
  assert.equal(shouldInterruptSettledReply({ text: "A real answer.", status: "failed", failureKind: "native" }), true)
})

test("ticket169: a settled substantive reply survives even without a structured native cause", () => {
  assert.equal(
    shouldInterruptSettledReply({ text: "A real answer.", status: "failed" }),
    false,
    "missing legacy evidence never overrides a real answer",
  )
})

test("ticket169: a late success repairs an interrupted placeholder with the final text", () => {
  const plan = planLateSuccessRepair({
    messages: [
      message({ id: "system", author: "system", kind: "system", text: "Delegated subtasks completed." }),
      message({ id: "placeholder", taskID: "t", text: "Reply interrupted.", interrupted: true }),
    ],
    taskID: "t",
    lateText: "The real answer, delivered late.",
  })
  assert.deepEqual(plan, { action: "repair", messageID: "placeholder", text: "The real answer, delivered late." })
})

test("ticket169: a still-streaming row is finalized in place with the late text", () => {
  const plan = planLateSuccessRepair({
    messages: [message({ id: "live", taskID: "t", text: "partial", streaming: true })],
    taskID: "t",
    lateText: "The complete answer.",
  })
  assert.deepEqual(plan, { action: "repair", messageID: "live", text: "The complete answer." })
})

test("ticket169: a late result with no new text reuses the already-recorded answer", () => {
  const plan = planLateSuccessRepair({
    messages: [
      message({ id: "answer", taskID: "t", text: "The recorded answer.", seq: 2 }),
      message({ id: "placeholder", taskID: "t", text: "Reply interrupted.", interrupted: true, seq: 3 }),
    ],
    taskID: "t",
    lateText: "",
  })
  assert.deepEqual(plan, { action: "repair", messageID: "placeholder", text: "The recorded answer." })
})

test("ticket169: a settled substantive row is reused when no placeholder exists", () => {
  const plan = planLateSuccessRepair({
    messages: [message({ id: "answer", taskID: "t", text: "The recorded answer.", seq: 2 })],
    taskID: "t",
    lateText: "",
  })
  assert.deepEqual(plan, { action: "reuse", messageID: "answer", text: "The recorded answer." })
})

test("ticket169: a late substantive answer with no row creates a durable message", () => {
  const plan = planLateSuccessRepair({ messages: [], taskID: "t", lateText: "A late answer." })
  assert.deepEqual(plan, { action: "create", text: "A late answer." })
})

test("ticket169: no substantive text anywhere is not a late success", () => {
  assert.deepEqual(
    planLateSuccessRepair({ messages: [message({ id: "placeholder", taskID: "t", text: "Reply interrupted.", interrupted: true })], taskID: "t", lateText: "" }),
    { action: "none", reason: "no-substantive-text" },
  )
  assert.deepEqual(
    planLateSuccessRepair({ messages: [], taskID: "t", lateText: "Reply completed." }),
    { action: "none", reason: "no-substantive-text" },
  )
})

test("ticket169: repair ignores other tasks and non-agent rows", () => {
  const plan = planLateSuccessRepair({
    messages: [
      message({ id: "other-task", taskID: "other", text: "Reply interrupted.", interrupted: true }),
      message({ id: "user", author: "user", text: "user question" }),
      message({ id: "system", author: "system", kind: "system", text: "system line" }),
    ],
    taskID: "t",
    lateText: "The real answer.",
  })
  assert.deepEqual(plan, { action: "create", text: "The real answer." })
})
