import test from "node:test"
import assert from "node:assert/strict"
import {
  HANDOFF_MARKER,
  completionReviewInstruction,
  handoffAckText,
  handoffDuplicateText,
  handoffFailureText,
  handoffFileContent,
  handoffGroupAckText,
  handoffWorkKey,
  inlineHandoffFileName,
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

// Ticket #195: inline handoffs generate their own file. The name is one flat
// basename so no task, recipient, or nonce value can traverse out of the
// handoff directory.
test("generated handoff filenames are safe, flat, and unique", () => {
  const base = { task: "../../etc/passwd", from: "../Nova", to: "a/b\\c", at: 1700000000000, nonce: "../x/y" }
  const name = inlineHandoffFileName(base)
  assert.match(name, /^[a-z0-9-]+\.md$/)
  assert.ok(!name.includes("/"))
  assert.ok(!name.includes("\\"))
  assert.ok(!name.includes(".."))
  assert.notEqual(name, inlineHandoffFileName({ ...base, nonce: "z9" }))
  assert.notEqual(name, inlineHandoffFileName({ ...base, at: 1700000000001 }))
})

// Ticket #195: the service-written record must be a valid handoff file with
// the typed fields, including a multi-line instruction kept in the body.
test("generated handoff content parses back to the typed record", () => {
  const content = handoffFileContent({
    task: "Deploy summary",
    instruction: "Read src/deploy.ts.\nList the rollout risks.",
    summary: "Exec-ready bullets",
    constraints: "Under 100 words",
    expected: "Three bullets",
    from: "Nova",
    to: "Sage",
    correlationID: "handoff_abc",
    createdAt: 1700000000000,
  })
  const parsed = parseHandoffFile(content)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.ok && parsed.data.task, "Deploy summary")
  assert.equal(parsed.ok && parsed.data.instruction, "Read src/deploy.ts. List the rollout risks.")
  assert.equal(parsed.ok && parsed.data.summary, "Exec-ready bullets")
  assert.equal(parsed.ok && parsed.data.constraints, "Under 100 words")
  assert.equal(parsed.ok && parsed.data.expected, "Three bullets")
  assert.equal(parsed.ok && parsed.data.to, "Sage")
  assert.equal(parsed.ok && parsed.data.correlationID, "handoff_abc")
  assert.match(content, /## Instruction\n\nRead src\/deploy\.ts\.\nList the rollout risks\./)
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
  assert.equal(resolveHandoffRecipient(state, "sage").status, "ok")
  assert.equal(resolveHandoffRecipient(state, "SAGE").status, "ok")
  assert.equal(resolveHandoffRecipient(state, "Nope").status, "unknown")
  assert.equal(resolveHandoffRecipient(state, "Retired").status, "archived")
  assert.equal(resolveHandoffRecipient(state, "").status, "unknown")
})

test("bare prose never resolves to a recipient", () => {
  const state = stateWithAgents()
  const result = resolveHandoffRecipient(state, "please ask sage to help")
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

// Ticket #73: the handoff file carries a recipient-facing instruction
// distinct from the short display title.
test("handoff file parses an instruction distinct from the task title", () => {
  const parsed = parseHandoffFile(
    "---\nensemble: handoff\ntask: Summarize the deploy\ninstruction: Read src/deploy.ts and list the three riskiest rollout steps for Sage to verify.\n---\n# Handoff\n",
  )
  assert.equal(parsed.ok, true)
  assert.equal(parsed.ok && parsed.data.task, "Summarize the deploy")
  assert.equal(
    parsed.ok && parsed.data.instruction,
    "Read src/deploy.ts and list the three riskiest rollout steps for Sage to verify.",
  )
  assert.notEqual(parsed.ok && parsed.data.instruction, parsed.ok && parsed.data.task)
  // Instruction stays optional: legacy files without one still parse.
  const legacy = parseHandoffFile("---\nensemble: handoff\ntask: Summarize the deploy\n---\n# Handoff\n")
  assert.equal(legacy.ok, true)
  assert.equal(legacy.ok && legacy.data.instruction, undefined)
})

// Ticket #73: distinct tailored briefs are distinct units of work.
test("handoff idempotency key includes the tailored instruction", () => {
  const base = { actor: "nova", workspaceID: "w", recipientID: "sage", task: "Summarize", instruction: "List the three risks." }
  const first = handoffWorkKey(base)
  assert.equal(first, handoffWorkKey(base))
  assert.notEqual(first, handoffWorkKey({ ...base, instruction: "List the five risks." }))
  // Legacy hops without an instruction keep a stable key shape.
  assert.equal(
    handoffWorkKey({ actor: "nova", workspaceID: "w", recipientID: "sage", task: "Summarize" }),
    handoffWorkKey({ actor: "nova", workspaceID: "w", recipientID: "sage", task: "Summarize" }),
  )
})

// Ticket #73: the group ack is a concise system line — no policy sentence,
// no correlation ref. Policy and the ref stay in the tool result.
test("group ack is concise with $Name syntax and no internal text", () => {
  const ack = handoffGroupAckText("Sage", "Summarize the deploy")
  assert.equal(ack, "Handed to $Sage · Summarize the deploy")
  assert.ok(!ack.includes("@Sage"))
  assert.ok(!ack.includes("handoff_"))
  assert.ok(!ack.includes("do not call ensemble_delegate"))
  assert.ok(!ack.includes("stays open"))
})

// Ticket #73: a single completion hands the leader review work — sender,
// title, outcome, and path — never a verbatim forward of the request.
test("completion review instruction frames the finished turn for review", () => {
  const text = completionReviewInstruction({
    finisherName: "Sage",
    title: "Do research",
    content: "Finished the work.",
    path: ".ensemble/handoffs/done.md",
  })
  assert.match(text, /\$Sage/)
  assert.match(text, /Do research/)
  assert.match(text, /Finished the work\./)
  assert.match(text, /Review/)
  assert.match(text, /@\.ensemble\/handoffs\/done\.md/)
  assert.ok(!text.includes("@Sage"))
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
