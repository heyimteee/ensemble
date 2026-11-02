import test from "node:test"
import assert from "node:assert/strict"
import {
  HANDOFF_MARKER,
  handoffAckText,
  handoffDuplicateText,
  handoffFailureText,
  handoffWorkKey,
  newDirectEnvelope,
  parseHandoffFile,
  resolveHandoffRecipient,
} from "./handoff.ts"

const validFile = `---\nensemble: handoff\ntask: Summarize the deploy\nconstraints: Keep it short\nexpected: A paragraph\nto: Sage\n---\n# Handoff\n`

test("handoff marker constant never uses @Name syntax", () => {
  assert.ok(!HANDOFF_MARKER.includes("@"))
})

test("valid handoff file parses to a typed record", () => {
  const parsed = parseHandoffFile(validFile)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.ok && parsed.data.task, "Summarize the deploy")
  assert.equal(parsed.ok && parsed.data.constraints, "Keep it short")
  assert.equal(parsed.ok && parsed.data.expected, "A paragraph")
  assert.equal(parsed.ok && parsed.data.to, "Sage")
})

test("substring-only marker without frontmatter structure is refused", () => {
  const parsed = parseHandoffFile(`# Notes\nThis mentions ${HANDOFF_MARKER} in prose but has no frontmatter.\n`)
  assert.equal(parsed.ok, false)
})

test("wrong ensemble value is refused", () => {
  const parsed = parseHandoffFile(`---\nensemble: notes\ntask: Something\n---\n`)
  assert.equal(parsed.ok, false)
  assert.match(parsed.ok === false ? parsed.reason : "", /ensemble: handoff/)
})

test("missing task is refused with a clear reason", () => {
  const parsed = parseHandoffFile(`---\nensemble: handoff\nconstraints: None\n---\n`)
  assert.equal(parsed.ok, false)
  assert.match(parsed.ok === false ? parsed.reason : "", /task/)
})

test("missing frontmatter markers are refused", () => {
  const parsed = parseHandoffFile(`ensemble: handoff\ntask: Something\n`)
  assert.equal(parsed.ok, false)
})

test("handoff idempotency key scopes actor, run prefix, and recipient", () => {
  const base = { actor: "nova", workspaceID: "w", recipientID: "sage", task: "Summarize", constraints: "Short", expected: "Para" }
  const first = handoffWorkKey(base)
  const second = handoffWorkKey(base)
  assert.equal(first, second)
  assert.ok(first.startsWith("handoff:w:"))
  assert.ok(!first.includes("parent"))
  const otherTask = handoffWorkKey({ ...base, task: "Different" })
  assert.notEqual(first, otherTask)
  const otherRecipient = handoffWorkKey({ ...base, recipientID: "nova" })
  assert.notEqual(first, otherRecipient)
  // The asking run scopes the key as a hash, never raw: a resubmission from
  // the same run dedupes, while a different run is a different unit of work.
  const fromRun = handoffWorkKey({ ...base, parentID: "task_parent" })
  assert.notEqual(first, fromRun)
  assert.equal(fromRun, handoffWorkKey({ ...base, parentID: "task_parent" }))
  assert.ok(!fromRun.includes("task_parent"))
})

function stateWithAgents() {
  const agents: any = {
    sage: { id: "sage", name: "Sage", archived: false },
    nova: { id: "nova", name: "Nova", archived: false },
    retired: { id: "retired", name: "Retired", archived: true },
  }
  return { agents, workspaces: { w: { id: "w", name: "site" } } } as any
}

test("recipient resolution prefers id, then unique name, and refuses archived", () => {
  const state = stateWithAgents()
  const workspace = state.workspaces.w
  assert.equal(resolveHandoffRecipient(state, workspace, "sage").status, "ok")
  assert.equal(resolveHandoffRecipient(state, workspace, "SAGE").status, "ok")
  assert.equal(resolveHandoffRecipient(state, workspace, "Nope").status, "unknown")
  assert.equal(resolveHandoffRecipient(state, workspace, "Retired").status, "archived")
  assert.equal(resolveHandoffRecipient(state, workspace, "").status, "unknown")
})

test("bare prose never resolves to a recipient", () => {
  const state = stateWithAgents()
  const workspace = state.workspaces.w
  const result = resolveHandoffRecipient(state, workspace, "please ask sage to help")
  assert.equal(result.status, "unknown")
})

test("handoff copy uses $Name syntax and carries correlation", () => {
  const ack = handoffAckText("Sage", "Summarize", "handoff_abc")
  assert.match(ack, /\$Sage/)
  assert.ok(!ack.includes("@Sage"))
  assert.match(ack, /handoff_abc/)
  const duplicate = handoffDuplicateText("Sage", "Summarize")
  assert.match(duplicate, /\$Sage/)
  assert.ok(!duplicate.includes("@"))
  const failure = handoffFailureText("Sage", "boom", "handoff_abc")
  assert.match(failure, /\$Sage/)
  assert.match(failure, /boom/)
  assert.ok(!failure.includes("@"))
})

test("direct envelope carries addressing, correlation, ordering, and delivery state", () => {
  const envelope = newDirectEnvelope({ messageID: "dm_1", fromID: "nova", toID: "sage", workspaceID: "w", text: "Hello", status: "queued", createdAt: 7 })
  assert.equal(envelope.fromID, "nova")
  assert.equal(envelope.toID, "sage")
  assert.equal(envelope.workspaceID, "w")
  assert.equal(envelope.status, "queued")
  assert.equal(envelope.createdAt, 7)
  assert.ok(envelope.correlationID.length > 0)
  const second = newDirectEnvelope({ messageID: "dm_2", fromID: "nova", toID: "sage", text: "Later", createdAt: 8 })
  assert.ok(second.createdAt > envelope.createdAt)
})
