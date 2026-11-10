import test from "node:test"
import assert from "node:assert/strict"
import { directNativeWorkRow, nativeDirectChannel, nativeDirectChatLines } from "./native-direct.ts"
import type { Message, Subtask } from "../types.ts"

const message = (patch: Partial<Message> = {}): Message => ({
  id: "m1",
  workspaceID: "dm:a:w",
  channel: "dm:a:w",
  seq: 1,
  author: "user",
  text: "Hello",
  kind: "text",
  createdAt: 1,
  ...patch,
})

const task = (patch: Partial<Subtask> = {}): Subtask => ({
  id: "task_native_1",
  workspaceID: "dm:a:w",
  creatorType: "user",
  assigneeID: "a",
  title: "Fix the build",
  instruction: "Fix the build",
  mode: "research",
  state: "working",
  stage: "initial",
  outcome: "pending",
  interrupted: false,
  awaitingChildren: false,
  attempts: 0,
  createdAt: 1,
  workKind: "turn",
  origin: "native",
  adopted: true,
  conversationID: "dm:a:w",
  native: { sessionID: "s1", inboxID: "m1", assistantMessageIDs: [], phase: "working" },
  ...patch,
})

test("ticket215: a native direct surface uses only the durable conversation channel", () => {
  assert.equal(nativeDirectChannel(undefined), undefined)
  assert.equal(nativeDirectChannel({ kind: "direct", workspaceID: "w", context: "workspace", sessionID: "s", sharedSession: false }), undefined)
  assert.equal(nativeDirectChannel({ kind: "direct", workspaceID: "w", context: "workspace", sessionID: "s", sharedSession: false, durable: true, channel: "dm:a:w" }), "dm:a:w")
})

test("ticket215: durable direct rows keep roles, text, attachments, and streaming", () => {
  const lines = nativeDirectChatLines([
    message(),
    message({
      id: "m2",
      seq: 2,
      author: "agent",
      agentID: "a",
      text: "Working",
      streaming: true,
    }),
  ], "Nova", 10)
  assert.deepEqual(lines.map((line) => [line.role, line.author, line.text]), [
    ["user", "You", "Hello"],
    ["agent", "Nova", "Working"],
  ])
  assert.equal(lines[1].streaming, true)
  const withAttachment = nativeDirectChatLines([message({ text: "", attachments: [{ id: "att", name: "note.txt", mime: "text/plain", size: 4, kind: "file" }] })], "Nova", 10)
  assert.equal(withAttachment[0].attachments?.[0].name, "note.txt")
})

test("ticket215: the direct Work row follows the canonical vocabulary for this channel", () => {
  const working = directNativeWorkRow([
    task(),
    task({ id: "task_other", conversationID: "dm:a:other", workspaceID: "dm:a:other" }),
    task({ id: "task_group", workspaceID: "w", conversationID: undefined, origin: undefined, native: undefined, workKind: "delegation" }),
    task({ id: "task_group_native", workspaceID: "w", conversationID: "w" }),
  ], "dm:a:w", 10)
  assert.ok(working)
  assert.equal(working.state, "WORKING")
  assert.equal(working.title, "Fix the build")

  const replied = directNativeWorkRow([
    task({ state: "replied", outcome: "succeeded", native: { sessionID: "s1", inboxID: "m1", assistantMessageIDs: ["m2"], phase: "replied" }, finishedAt: 20 }),
  ], "dm:a:w", 30)
  assert.equal(replied?.state, "REPLIED")

  const interrupted = directNativeWorkRow([
    task({ interrupted: true, native: { sessionID: "s1", inboxID: "m1", assistantMessageIDs: [], phase: "interrupted" } }),
  ], "dm:a:w", 30)
  assert.equal(interrupted?.state, "NEEDS YOU")
  assert.equal(interrupted?.needsYou, true)

  assert.equal(directNativeWorkRow([task()], undefined, 30), undefined)
  assert.equal(directNativeWorkRow([task()], "dm:other", 30), undefined)
})

test("ticket222: the direct active row keeps a working turn ahead of a newer queued follow-up", () => {
  const working = task({
    id: "task_working",
    createdAt: 10,
    state: "working",
    native: { sessionID: "s1", inboxID: "m_working", assistantMessageIDs: [], phase: "working" },
  })
  const queued = task({
    id: "task_queued",
    createdAt: 20,
    state: "pending",
    native: { sessionID: "s1", inboxID: "m_queued", assistantMessageIDs: [], phase: "queued" },
  })
  const row = directNativeWorkRow([working, queued], "dm:a:w", 30)
  assert.equal(row?.id, "task_working")
  assert.equal(row?.state, "WORKING")

  const retrying = task({
    id: "task_retrying",
    createdAt: 5,
    state: "working",
    native: { sessionID: "s1", inboxID: "m_retrying", assistantMessageIDs: [], phase: "retrying" },
  })
  assert.equal(directNativeWorkRow([queued, working, retrying], "dm:a:w", 30)?.id, "task_working", "newest priority turn wins")

  const needsYou = task({
    id: "task_needs_you",
    createdAt: 1,
    interrupted: true,
    native: { sessionID: "s1", inboxID: "m_needs", assistantMessageIDs: [], phase: "interrupted" },
  })
  assert.equal(directNativeWorkRow([needsYou, working, queued], "dm:a:w", 30)?.id, "task_needs_you", "needs-you outranks a running turn")

  const settled = task({
    id: "task_settled",
    createdAt: 1,
    state: "replied",
    outcome: "succeeded",
    finishedAt: 9,
    repliedAt: 9,
    native: { sessionID: "s1", inboxID: "m_done", assistantMessageIDs: ["m2"], phase: "replied" },
  })
  assert.equal(directNativeWorkRow([settled, queued], "dm:a:w", 30)?.id, "task_queued", "active work still wins over a settled turn")
  assert.equal(directNativeWorkRow([settled], "dm:a:w", 30)?.id, "task_settled", "the settled turn stays available to history")
})
