import test from "node:test"
import assert from "node:assert/strict"
import { buildFailureRecord, classifyFailure } from "./failure-record.ts"
import type { Message, Subtask } from "./types.ts"

const task = (patch: Partial<Subtask> = {}): Subtask => ({
  id: "t1", workspaceID: "w1", creatorType: "user", title: "Fix the parser", instruction: "Secret instruction",
  constraints: "Secret constraints", expected: "Secret expected", mode: "edit", state: "replied", stage: "initial",
  outcome: "failed", interrupted: false, awaitingChildren: false, attempts: 3, dispatchGroupID: "g1",
  assigneeID: "a1", deadlineAt: 9_999, createdAt: 1, ...patch,
})

const messages = (): Message[] => [
  { id: "m1", workspaceID: "w1", seq: 1, author: "user", text: "Please fix it", kind: "text", createdAt: 1 },
  { id: "m2", workspaceID: "w1", seq: 2, author: "agent", agentID: "a1", text: "Working on it", kind: "text", taskID: "t1", createdAt: 2 },
]

test("failure classification separates provider, timeout, and tool errors", () => {
  assert.equal(classifyFailure({ type: "provider.internal", message: "boom" }), "provider")
  assert.equal(classifyFailure({ code: "ETIMEDOUT", message: "timed out" }), "timeout")
  assert.equal(classifyFailure({ message: "tool execution failed" }), "tool")
  assert.equal(classifyFailure({ message: "odd" }, "uncertain"), "uncertain")
})

test("a failure record is self-contained without conversation content", () => {
  const error = Object.assign(new Error("provider exploded"), { code: "E_PROVIDER" })
  const record: any = buildFailureRecord({
    event: "failure.terminal",
    level: "error",
    incidentID: "failure_1",
    failureClass: "provider",
    task: task(),
    error,
    decision: { type: "terminal", reason: "attempts-exhausted", attempt: 3, maxAttempts: 3 },
    runID: "run_1",
    sessionID: "ses_1",
    providerID: "openai",
    modelID: "gpt",
    variant: "fast",
    startedAt: 10,
    durationMs: 90,
    toolOutcomes: [{ name: "bash", status: "failed", error: "exit 1", code: "E_TOOL" }],
    lastMessages: messages(),
    version: 12,
    epoch: 3,
    content: false,
  })

  assert.equal(record.event, "failure.terminal")
  assert.equal(record.cat, "failure")
  assert.equal(record.incidentID, "failure_1")
  assert.equal(record.failureClass, "provider")
  assert.equal(record.taskID, "t1")
  assert.equal(record.dispatchGroupID, "g1")
  assert.equal(record.title, "Fix the parser")
  assert.equal(record.attempts, 3)
  assert.equal(record.runID, "run_1")
  assert.equal(record.sessionID, "ses_1")
  assert.equal(record.model.providerID, "openai")
  assert.equal(record.error.name, "Error")
  assert.match(record.error.stack, /provider exploded/)
  assert.equal(record.toolOutcomes[0].name, "bash")
  assert.equal(record.lastMessages.length, 2)
  assert.equal(record.lastMessages[0].chars, 13)
  assert.equal("text" in record.lastMessages[0], false)
  assert.equal(record.decision.type, "terminal")
  assert.equal(record.version, 12)
  assert.equal(record.epoch, 3)
  assert.equal(record.content, undefined)
})

test("a restart recovery record carries the previous claim and lease expiry", () => {
  const record: any = buildFailureRecord({
    event: "failure.attempt",
    level: "warn",
    incidentID: "failure_restart",
    failureClass: "restart",
    task: task({ state: "pending", outcome: "pending", error: "Recovered after an expired lease; retrying." }),
    error: "The work lease expired before the run finished.",
    decision: { type: "retry", attempt: 3, maxAttempts: 5, delayMs: 0, retryAt: 40, reason: "lease-expired" },
    previousClaim: "run_dead",
    leaseExpiredAt: 30,
  })

  assert.equal(record.failureClass, "restart")
  assert.equal(record.previousClaim, "run_dead")
  assert.equal(record.leaseExpiredAt, 30)
  assert.equal(record.reason, "lease-expired")
  assert.equal(record.decision.type, "retry")
  assert.equal(record.decision.reason, "lease-expired")
  assert.equal(record.decision.attempt, 3)
  assert.equal(record.decision.maxAttempts, 5)
  assert.equal(record.decision.delayMs, 0)
})

test("content logging attaches instruction and message text only when enabled", () => {
  const record: any = buildFailureRecord({
    event: "failure.attempt",
    level: "warn",
    incidentID: "failure_2",
    failureClass: "empty-reply",
    task: task(),
    error: "The agent produced no answer.",
    decision: { type: "retry", attempt: 1, maxAttempts: 3, delayMs: 5_000, retryAt: 20 },
    lastMessages: messages(),
    content: true,
  })

  assert.equal(record.content.instruction, "Secret instruction")
  assert.equal(record.content.constraints, "Secret constraints")
  assert.equal(record.content.expected, "Secret expected")
  assert.equal(record.lastMessages[1].text, "Working on it")
})

test("ticket163: a controlled budget stop needs structured evidence, not refusal copy", () => {
  const copy = new Error("the dispatch group is exhausted (8/8 hops); Return your result to the leader in the group chat.")
  assert.equal(classifyFailure(copy), "internal", "refusal copy alone is user-facing text, not a reason code")
  const structured = { code: "dispatch_budget_exhausted", layer: "task", used: 0, max: 0, message: "denied" }
  assert.equal(classifyFailure(structured), "budget")
  assert.equal(classifyFailure({ type: "provider.internal", message: "provider down" }), "provider", "ordinary failures keep their class")

  const record: any = buildFailureRecord({
    event: "failure.terminal",
    level: "warn",
    incidentID: "failure_budget",
    failureClass: classifyFailure(structured),
    task: task(),
    error: structured,
    decision: { type: "terminal", reason: "budget-exhausted", attempt: 1, maxAttempts: 1 },
    content: false,
  })

  assert.equal(record.failureClass, "budget")
  assert.equal(record.reasonCode, "budget-exhausted")
  assert.deepEqual(record.budget, { layer: "task", used: 0, max: 0 })
  assert.equal(record.content, undefined)
  const serialized = JSON.stringify({ reasonCode: record.reasonCode, budget: record.budget })
  assert.equal(serialized.includes("Secret instruction"), false)
  assert.equal(serialized.includes("Fix the parser"), false)
})

test("ticket163: a structured budget refusal keeps its layer and counts", () => {
  const error = Object.assign(new Error("no dispatch budget"), {
    code: "dispatch_budget_exhausted",
    layer: "command",
    used: 24,
    max: 24,
  })
  const record: any = buildFailureRecord({
    event: "failure.terminal",
    level: "warn",
    incidentID: "failure_budget_command",
    failureClass: classifyFailure(error),
    task: task(),
    error,
    decision: { type: "terminal", reason: "budget-exhausted", attempt: 1, maxAttempts: 1 },
  })

  assert.equal(record.failureClass, "budget")
  assert.equal(record.reasonCode, "budget-exhausted")
  assert.deepEqual(record.budget, { layer: "command", used: 24, max: 24 })
})
