import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

/**
 * Ticket #210: the committed native host contract fixture.
 *
 * This suite replays the recorded OpenCode 2.2.6 event stream and asserts the
 * contract native-first ingestion depends on. It needs no model, host, network,
 * or credentials. `npm run test:live:probe` runs the same assertions against a
 * fresh live record through `ENSEMBLE_NATIVE_HOST_FIXTURE`.
 */

type Row = Record<string, any>
type EventRow = Row & {
  kind: "event"
  case: string
  seq: number
  source: "plugin" | "http"
  type: string
  data: Record<string, any>
}

const fixtureUrl = process.env.ENSEMBLE_NATIVE_HOST_FIXTURE
  ? pathToFileURL(process.env.ENSEMBLE_NATIVE_HOST_FIXTURE)
  : new URL("./fixtures/native-host-contract.jsonl", import.meta.url)

const rows: Row[] = readFileSync(fixtureUrl, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))

const REQUIRED_CASES = [
  "direct",
  "workspace",
  "retry",
  "interrupt",
  "attachment",
  "synthetic",
  "subagent",
  "delivery",
  "move",
  "session-list",
  "idle",
]

function caseRows(name: string): Row[] {
  return rows.filter((row) => row.case === name)
}
function events(name: string): EventRow[] {
  return caseRows(name).filter((row) => row.kind === "event") as EventRow[]
}
function finding(name: string, id: string): Row {
  const row = caseRows(name).find((entry) => entry.kind === "finding" && entry.id === id)
  assert.ok(row, `missing finding ${name}/${id}`)
  return row
}
function api(name: string, action: string): Row {
  const row = caseRows(name).find((entry) => entry.kind === "api" && entry.action === action)
  assert.ok(row, `missing api ${name}/${action}`)
  return row
}
function context(name: string, session: string): Row {
  const row = caseRows(name).find((entry) => entry.kind === "context" && entry.session === session)
  assert.ok(row, `missing context ${name}/${session}`)
  return row
}
function contextMessages(name: string, session: string): Row[] {
  return context(name, session).messages as Row[]
}
function indexOf(sequence: EventRow[], type: string, predicate: (event: EventRow) => boolean = () => true): number {
  return sequence.findIndex((event) => event.type === type && predicate(event))
}
function eventSequence(name: string): string[] {
  return events(name).map((event) => event.type)
}
function assertTrueFinding(name: string, id: string): Row {
  const row = finding(name, id)
  assert.equal(row.value, true, `${name}/${id} should be true`)
  return row
}
function assertFalseFinding(name: string, id: string): Row {
  const row = finding(name, id)
  assert.equal(row.value, false, `${name}/${id} should be false`)
  return row
}

/**
 * Replay one native turn from the fixture alone. This is the shape #212+ can
 * feed without a host: identity comes from inbox/assistant IDs, settlement from
 * execution events, and final text from ended parts.
 */
function replayTurn(turnEvents: EventRow[], turnContext: Row[]) {
  const enqueued = turnEvents.find((event) => event.type === "session.inbox.enqueued")
  const terminal = turnEvents.find((event) =>
    ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(event.type),
  )
  const phase =
    terminal?.type === "session.execution.succeeded"
      ? "replied"
      : terminal?.type === "session.execution.failed"
        ? "failed"
        : terminal?.type === "session.execution.interrupted"
          ? "cancelled"
          : "working"
  const assistantIDs = new Set(
    turnEvents
      .filter((event) => event.type === "session.text.started" || event.type === "session.text.ended")
      .map((event) => event.data.assistantMessageID),
  )
  const ended = turnEvents.filter((event) => event.type === "session.text.ended")
  const finalTextLength = ended.reduce((total, event) => total + (event.data.text?.length ?? 0), 0)
  const userMessage = turnContext.find((message) => message.type === "user")
  const assistantMessage = [...turnContext].reverse().find((message) => message.type === "assistant")
  return {
    turnID: enqueued?.data.inboxID,
    phase,
    assistantIDs: [...assistantIDs],
    finalTextLength,
    userMessageID: userMessage?.id,
    contextAssistantID: assistantMessage?.id,
  }
}

test("fixture names the verified host versions and contains no private data", () => {
  const meta = rows.find((row) => row.kind === "meta")
  assert.ok(meta, "missing meta record")
  assert.equal(meta.schema, "ensemble.native-host-contract")
  assert.equal(meta.version, 1)
  assert.match(meta.versions.node, /^26\./)
  assert.equal(meta.versions.opencode, "2.2.6")
  assert.ok(typeof meta.versions.tmux === "string" && meta.versions.tmux.length > 0)
  assert.match(meta.versions.provider, /ensemble-fake/)
  assert.match(meta.declaredTypes, /@opencode\/plugin 2\.2\.1/)
  assert.ok(rows.some((row) => row.kind === "done"))

  for (const row of rows) {
    const serialized = JSON.stringify(row)
    assert.doesNotMatch(serialized, /\/home\/|\/tmp\/|\/Users\/|[A-Za-z]:\\\\/, `private path in ${serialized.slice(0, 120)}`)
    assert.doesNotMatch(serialized, /"(?:ses|msg|evt)_[A-Za-z0-9]+"/, `raw host id in ${serialized.slice(0, 120)}`)
    assert.doesNotMatch(serialized, /data:[A-Za-z0-9+/=]{40,}/, "inline file payload")
  }
})

test("every required scenario has ordered case markers and unique event sequences", () => {
  const cases = rows.filter((row) => row.kind === "case.start").map((row) => row.case)
  for (const required of REQUIRED_CASES) {
    assert.ok(cases.includes(required), `missing case ${required}`)
    assert.ok(rows.some((row) => row.kind === "case.start" && row.case === required), `${required} start`)
    assert.ok(rows.some((row) => row.kind === "case.end" && row.case === required), `${required} end`)
    const sequence = events(required).map((event) => event.seq)
    assert.deepEqual(sequence, sequence.map((_, index) => index), `${required} seq is contiguous`)
  }
})

test("a native direct turn exposes inbox, text, and execution identities", () => {
  const direct = events("direct")
  const sequence = eventSequence("direct")
  const created = indexOf(direct, "session.created")
  const enqueued = indexOf(direct, "session.inbox.enqueued")
  const started = indexOf(direct, "session.execution.started")
  const delivered = indexOf(direct, "session.inbox.delivered")
  const textStarted = indexOf(direct, "session.text.started")
  const textDelta = indexOf(direct, "session.text.delta")
  const textEnded = indexOf(direct, "session.text.ended")
  const succeeded = indexOf(direct, "session.execution.succeeded")
  assert.ok(created >= 0 && enqueued > created, `order: ${sequence.join(" > ")}`)
  assert.ok(started > enqueued, `execution starts after enqueue: ${sequence.join(" > ")}`)
  assert.ok(delivered > started, `2.2.6 delivers after execution starts: ${sequence.join(" > ")}`)
  assert.ok(textStarted > delivered, `text starts after delivery: ${sequence.join(" > ")}`)
  assert.ok(textDelta > textStarted && textEnded > textDelta, `text delta/end order: ${sequence.join(" > ")}`)
  assert.ok(succeeded > textEnded, `execution settles after text ends: ${sequence.join(" > ")}`)

  const enqueue = direct[enqueued]
  assert.equal(enqueue.data.item.type, "user")
  assert.equal(enqueue.data.item.delivery, "steer")
  assert.deepEqual(enqueue.data.item.payload.metadata, { "ensemble.probe": "direct" })
  assert.equal(enqueue.data.item.payload.text.length, "probe-direct-turn".length)

  const context_ = context("direct", "s1")
  assertTrueFinding("direct", "inbox-id-equals-context-user-id")
  assertTrueFinding("direct", "inbox-delivered-inbox-id-equals-prompt")
  assertTrueFinding("direct", "inbox-text-equals-context-user-text")
  assertTrueFinding("direct", "text-started-id-equals-context-assistant-id")
  assertTrueFinding("direct", "text-ended-id-equals-context-assistant-id")
  assertTrueFinding("direct", "ended-text-parts-match-context-assistant-text")
  assertTrueFinding("direct", "context-includes-idle-marker")
  assertTrueFinding("direct", "execution-started-precedes-inbox-delivered")
  assertTrueFinding("direct", "text-delta-precedes-text-ended")
  assert.equal(context_.messages[0].metadata["ensemble.probe"], "direct")

  const replay = replayTurn(direct, context_.messages)
  assert.equal(replay.phase, "replied")
  assert.equal(replay.turnID, replay.userMessageID)
  assert.deepEqual(replay.assistantIDs, [replay.contextAssistantID])
  assert.equal(replay.finalTextLength, 33)
})

test("a workspace-directory turn uses the same contract with a separate location", () => {
  const workspace = events("workspace")
  const created = workspace.find((event) => event.type === "session.created")
  assert.equal(created?.data.location.directory, "<workspace>")
  assertTrueFinding("workspace", "inbox-id-equals-context-user-id")
  assertTrueFinding("workspace", "text-started-id-equals-context-assistant-id")
  assertTrueFinding("workspace", "text-ended-id-equals-context-assistant-id")
  assertTrueFinding("workspace", "workspace-events-observed-through-plugin-context")
  assert.equal(finding("workspace", "workspace-events-observed-through-plugin-context").pluginReadyForWorkspace, true)

  const replay = replayTurn(workspace, contextMessages("workspace", "s2"))
  assert.equal(replay.phase, "replied")
  assert.equal(replay.turnID, replay.userMessageID)
})

test("a host retry is scheduled after a 429 and reuses one assistant message", () => {
  const retry = events("retry")
  const scheduled = retry.find((event) => event.type === "session.retry.scheduled")
  assert.ok(scheduled, "missing retry.scheduled")
  assert.equal(scheduled.data.attempt, 2)
  assert.equal(scheduled.data.error.type, "provider.rate-limit")
  assert.equal(scheduled.data.error.status, 429)
  assert.equal(scheduled.data.error.retryAfterMs, 0)
  assert.equal(scheduled.data.error.hasMessage, true)
  assert.ok(typeof scheduled.data.delayMs === "number" && scheduled.data.delayMs >= 0)

  const retryIndex = retry.findIndex((event) => event.type === "session.retry.scheduled")
  const succeededIndex = retry.findIndex((event) => event.type === "session.execution.succeeded")
  const endedIndex = retry.findIndex((event) => event.type === "session.text.ended")
  assert.ok(retryIndex > 0 && retryIndex < endedIndex && endedIndex < succeededIndex)
  assert.equal(retry.some((event) => event.type === "session.execution.interrupted"), false)
  assert.equal(
    new Set(retry.filter((event) => event.type === "session.text.started").map((event) => event.data.assistantMessageID)).size,
    1,
    "a retry reuses one assistant message",
  )
  assertFalseFinding("retry", "retry-status-event-observed")
  assert.equal(finding("retry", "retry-scheduled-shape").attempt, 2)
})

test("a user interruption preserves partial text and settles as interrupted", () => {
  const interrupt = events("interrupt")
  const interrupted = interrupt.find((event) => event.type === "session.execution.interrupted")
  assert.ok(interrupted)
  assert.equal(interrupted.data.reason, "user")
  assert.equal(interrupt.some((event) => event.type === "session.execution.succeeded"), false)
  const partial = assertTrueFinding("interrupt", "interrupt-preserves-partial-text")
  assert.ok(partial.endedLength > 0 && partial.endedLength < 500)
  const ended = interrupt.find((event) => event.type === "session.text.ended")
  assert.ok(ended)
  assert.equal(ended.data.assistantMessageID, contextMessages("interrupt", "s4").find((message: Row) => message.type === "assistant")?.id)
  assert.equal(replayTurn(interrupt, contextMessages("interrupt", "s4")).phase, "cancelled")
})

test("an attachment prompt carries inline file data, not the original uri", () => {
  const attachment = events("attachment")
  const enqueued = attachment.find((event) => event.type === "session.inbox.enqueued")
  assert.ok(enqueued)
  const file = enqueued.data.item.payload.files[0]
  assert.equal(file.name, "probe-attachment.txt")
  assert.equal(file.mime, "text/plain")
  assert.ok(file.dataLength > 0)
  assert.equal(file.sourceType, "uri")
  assert.equal(file.uri, undefined)
  assertFalseFinding("attachment", "attachment-enqueued-file-has-uri")
  assertTrueFinding("attachment", "attachment-context-file-matches-enqueued")

  const user = contextMessages("attachment", "s5").find((message: Row) => message.type === "user")
  assert.ok(user)
  assert.equal(user.files[0].dataLength, file.dataLength)
  assert.equal(typeof user.files[0].data, "undefined")
})

test("a synthetic message starts a real turn and appears in the transcript", () => {
  const synthetic = events("synthetic")
  const enqueued = synthetic.find((event) => event.type === "session.inbox.enqueued")
  assert.equal(enqueued?.data.item.type, "synthetic")
  assert.equal(enqueued?.data.item.payload.description, "probe synthetic")
  assert.equal(synthetic.some((event) => event.type === "session.synthetic"), false)
  assertFalseFinding("synthetic", "synthetic-event-observed")
  assert.ok(synthetic.some((event) => event.type === "session.execution.started"))
  assertTrueFinding("synthetic", "synthetic-starts-execution")
  assertTrueFinding("synthetic", "context-has-synthetic-message")

  const messages = contextMessages("synthetic", "s6")
  assert.ok(messages.some((message) => message.type === "synthetic"))
  assert.ok(messages.some((message) => message.type === "assistant" && message.content?.some((part: Row) => part.type === "text")))
})

test("a background subagent creates a child session and injects a parent synthetic turn", () => {
  const subagent = events("subagent")
  const childCreated = subagent.find((event) => event.type === "session.created" && event.data.parentID)
  assert.ok(childCreated, "child session.created")
  const childID = childCreated.data.sessionID
  assert.match(childID, /^s\d+$/)

  assertTrueFinding("subagent", "child-session-observed")
  assertTrueFinding("subagent", "parent-execution-settles-before-child")
  assertTrueFinding("subagent", "subagent-completion-injects-synthetic-parent-turn")

  const parentSucceeded = subagent.findIndex((event) => event.type === "session.execution.succeeded" && event.data.sessionID === "s7")
  const childSucceeded = subagent.findIndex((event) => event.type === "session.execution.succeeded" && event.data.sessionID === childID)
  assert.ok(parentSucceeded >= 0 && childSucceeded > parentSucceeded)

  const synthetic = subagent.find(
    (event) => event.type === "session.inbox.enqueued" && event.data.item.type === "synthetic",
  )
  assert.ok(synthetic)
  assert.equal(synthetic.data.sessionID, "s7")
  assert.deepEqual(Object.keys(synthetic.data.item.payload.metadata).sort(), ["agent", "childID", "source", "state"])
  assert.equal(synthetic.data.item.payload.metadata.childID, childID)

  const parentContext = contextMessages("subagent", "s7")
  const syntheticMessage = parentContext.find((message) => message.type === "synthetic")
  assert.ok(syntheticMessage)
  assert.equal(syntheticMessage.metadata.childID, childID)
  assert.ok(parentContext.some((message) => message.type === "assistant" && message.content?.some((part: Row) => part.type === "text")))
  const childContext = contextMessages("subagent", childID)
  assert.ok(childContext.some((message) => message.type === "assistant"))
  assert.ok(childContext.some((message) => message.type === "idle"))
})

test("queued delivery, cancellation, and delivery change are observable", () => {
  const delivery = events("delivery")
  const deliveryChanged = delivery.find((event) => event.type === "session.inbox.delivery.changed")
  assert.ok(deliveryChanged)
  assert.equal(deliveryChanged.data.delivery, "steer")
  const cancelled = delivery.find((event) => event.type === "session.inbox.cancelled")
  assert.ok(cancelled)
  assert.equal(api("delivery", "session.inbox.list").result.count, 2)
  assert.equal(api("delivery", "session.inbox.list:after").result.count, 1)
  assert.equal(api("delivery", "session.inbox.list:after").result.items[0].delivery, "steer")
  assert.ok(delivery.some((event) => event.type === "session.execution.interrupted" && event.data.reason === "user"))
  assert.equal(api("delivery", "session.interrupt").result.interrupted, true)
  assertTrueFinding("delivery", "idle-interrupt-shape")
})

test("a move is an inbox item and a busy move is queued rather than refused", () => {
  const delivery = events("delivery")
  const busyMove = delivery.find((event) => event.type === "session.inbox.enqueued" && event.data.item.type === "move")
  assert.ok(busyMove)
  assert.equal(busyMove.data.item.delivery, "steer")
  assertFalseFinding("delivery", "busy-session-move-refused")
  assertTrueFinding("delivery", "busy-move-enqueues-move-item")
  assertTrueFinding("delivery", "busy-move-keeps-location")
  assert.equal(api("delivery", "session.get").result.location.directory, "<project>")

  const move = events("move")
  const moveItem = move.find((event) => event.type === "session.inbox.enqueued" && event.data.item.type === "move")
  assert.ok(moveItem)
  const moved = move.find((event) => event.type === "session.moved")
  assert.ok(moved)
  assert.equal(moved.data.location.directory, "<workspace>")
  assertTrueFinding("move", "move-enqueues-inbox-item")
  assertTrueFinding("move", "moved-session-location")
  assertTrueFinding("move", "move-to-missing-directory")
  const moveCalls = caseRows("move").filter((row) => row.kind === "api" && row.action === "session.move")
  assert.equal(moveCalls.filter((row) => row.result?.ok === true).length, 1)
  assert.equal(moveCalls.filter((row) => row.result?.ok === false).length, 1)
})

test("session list scopes filter by location, root, child, archive, and search", () => {
  const project = api("session-list", "session.list:project").result
  const workspace = api("session-list", "session.list:workspace").result
  const all = api("session-list", "session.list:default").result
  const roots = api("session-list", "session.list:project-roots").result
  const children = api("session-list", "session.list:subagent-children").result
  const archived = api("session-list", "session.list:project-archived").result
  const archivedAfter = api("session-list", "session.list:project-archived-after").result
  const unarchivedAfter = api("session-list", "session.list:project-unarchived-after").result
  const search = api("session-list", "session.list:project-search-probe").result

  assert.ok(project.sessions.includes("s1"))
  assert.ok(!project.sessions.includes("s2"), "workspace session is not in the project scope")
  assert.ok(!project.sessions.includes("s10"), "moved session left the project scope")
  assert.ok(workspace.sessions.includes("s2"))
  assert.ok(workspace.sessions.includes("s10"))
  assert.ok(!workspace.sessions.includes("s1"))
  assert.ok(all.sessions.includes("s1") && all.sessions.includes("s2") && all.sessions.includes("s10"))
  assert.ok(!roots.sessions.includes("s8"), "child session is not a root")
  assert.deepEqual(children.sessions, ["s8"])
  assert.equal(archived.count, 0)
  assert.deepEqual(archivedAfter.sessions, ["s1"])
  assert.ok(!unarchivedAfter.sessions.includes("s1"))
  assert.deepEqual(search.sessions, ["s1"])
})

test("2.2.6 did not emit session.idle or session.status in this headless run", () => {
  assertFalseFinding("idle", "session-idle-observed")
  assert.ok(finding("idle", "session-idle-observed").waitedMs >= 10_000)
  assertFalseFinding("idle", "session-status-events-observed")
  for (const name of ["direct", "workspace", "retry", "interrupt", "attachment", "subagent", "delivery", "move"]) {
    const row = finding(name, "idle-emitted-after-terminal")
    assert.equal(row.value, false, `${name} should not have an idle event`)
  }
  assert.equal(rows.some((row) => row.kind === "event" && row.type === "session.idle"), false)
  assert.equal(rows.some((row) => row.kind === "event" && row.type === "session.status"), false)
})

test("context order is chronological even though message ids are not monotonic", () => {
  const messages = contextMessages("subagent", "s7")
  const times = messages.map((message) => message.created)
  assert.deepEqual(times, [...times].sort((left, right) => left - right))
  const ids = messages.map((message) => Number(message.id.slice(1)))
  assert.notDeepEqual(ids, [...ids].sort((left, right) => left - right), "ids are allocation order, not transcript order")
})
