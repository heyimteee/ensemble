import test from "node:test"
import assert from "node:assert/strict"
import { FINISHED_RETENTION_MS } from "./queue.ts"
import {
  WORK_HISTORY_PAGE,
  WORK_HISTORY_PAGE_MAX,
  selectWorkHistory,
  workConversationID,
  workDetailFor,
  workDetailText,
  workHistoryGroups,
  workHistoryLimit,
} from "./work-history.ts"
import type { DispatchGroup, Subtask } from "./types.ts"

const now = 1_000_000

const task = (id: string, patch: Partial<Subtask> = {}): Subtask => ({
  id,
  workspaceID: "w",
  creatorType: "user",
  assigneeID: "a",
  title: "Native turn",
  instruction: "do",
  mode: "research",
  state: "replied",
  stage: "initial",
  outcome: "succeeded",
  interrupted: false,
  awaitingChildren: false,
  attempts: 0,
  createdAt: 1,
  workKind: "turn",
  origin: "native",
  adopted: true,
  conversationID: "w",
  ...patch,
})

const done = (id: string, finishedAt: number, patch: Partial<Subtask> = {}): Subtask =>
  task(id, {
    dispatchGroupID: `dispatch_${id}`,
    finishedAt,
    repliedAt: finishedAt,
    native: {
      sessionID: "s1",
      inboxID: `inbox_${id}`,
      assistantMessageIDs: [`msg_${id}`],
      phase: "replied",
      settledAt: finishedAt,
      resultMessageID: `result_${id}`,
    },
    ...patch,
  })

const group = (id: string, patch: Partial<DispatchGroup> = {}): DispatchGroup => ({
  id,
  workspaceID: "w",
  rootID: id,
  continuationIndex: 0,
  maxHops: 8,
  usedHops: 2,
  depthMax: 8,
  commandMaxHops: 24,
  commandUsedHops: 2,
  maxContinuations: 2,
  continuationsUsed: 0,
  createdAt: 1,
  ...patch,
})

test("ticket222: history selects terminal Work for one conversation and pages newest first", () => {
  const tasks = [
    done("newest", now - 1_000),
    done("middle", now - 2_000),
    done("oldest", now - 3_000),
    task("live", {
      id: "live",
      state: "working",
      outcome: "pending",
      native: { sessionID: "s1", inboxID: "inbox_live", assistantMessageIDs: [], phase: "working" },
    }),
    done("other-workspace", now - 500, { workspaceID: "w2", conversationID: "w2" }),
    done("other-direct", now - 400, { workspaceID: "dm:a:w", conversationID: "dm:a:w" }),
    done("expired", now - FINISHED_RETENTION_MS - 1),
  ]

  const first = selectWorkHistory(tasks, { conversationID: "w", now, limit: 2 })
  assert.deepEqual(first.tasks.map((row) => row.id), ["newest", "middle"])
  assert.equal(first.hasMore, true)
  assert.ok(first.next)
  assert.equal(first.limit, 2)

  const second = selectWorkHistory(tasks, { conversationID: "w", now, before: first.next, limit: 2 })
  assert.deepEqual(second.tasks.map((row) => row.id), ["oldest"])
  assert.equal(second.hasMore, false)
  assert.equal(second.next, undefined)

  const direct = selectWorkHistory(tasks, { conversationID: "dm:a:w", now, limit: 10 })
  assert.deepEqual(direct.tasks.map((row) => row.id), ["other-direct"])
})

test("ticket222: history is stable on equal finishes and an unknown cursor heals to the newest page", () => {
  const tasks = [
    done("b", now - 1_000, { createdAt: 2 }),
    done("a", now - 1_000, { createdAt: 2 }),
    done("c", now - 1_000, { createdAt: 3 }),
  ]
  const all = selectWorkHistory(tasks, { conversationID: "w", now, limit: 10 })
  assert.deepEqual(all.tasks.map((row) => row.id), ["c", "a", "b"])

  const healed = selectWorkHistory(tasks, { conversationID: "w", now, before: "not-a-cursor", limit: 1 })
  assert.deepEqual(healed.tasks.map((row) => row.id), ["c"])
  assert.equal(healed.hasMore, true)
})

test("ticket222: page size is bounded", () => {
  assert.equal(workHistoryLimit(undefined), WORK_HISTORY_PAGE)
  assert.equal(workHistoryLimit(0), 1)
  assert.equal(workHistoryLimit(10_000), WORK_HISTORY_PAGE_MAX)
  assert.equal(workHistoryLimit(Number.NaN), WORK_HISTORY_PAGE)
})

test("ticket222: a conversation key is the durable channel, with a workspace fallback", () => {
  assert.equal(workConversationID({ workspaceID: "w" }), "w")
  assert.equal(workConversationID({ workspaceID: "dm:a:w", conversationID: "dm:a:w" }), "dm:a:w")
})

test("ticket222: history carries the dispatch ledgers its page names", () => {
  const rows = [done("one", now - 1_000), done("two", now - 2_000)]
  const groups = { dispatch_one: group("dispatch_one"), dispatch_two: group("dispatch_two", { rootID: "dispatch_root" }), dispatch_root: group("dispatch_root", { commandMaxHops: 24 }) }
  const selected = workHistoryGroups(rows, groups)
  assert.deepEqual(Object.keys(selected).sort(), ["dispatch_one", "dispatch_root", "dispatch_two"])
})

test("ticket222: why-this-card reports origin, session, inbox, events, routes, and budget by id", () => {
  const child = task("child", {
    id: "child",
    parentID: "turn",
    assigneeID: "b",
    conversationID: "w",
    createdAt: 5,
    state: "working",
    outcome: "pending",
    native: { sessionID: "s1", inboxID: "inbox_child", assistantMessageIDs: [], phase: "working" },
  })
  const turn = done("turn", now - 10, {
    id: "turn",
    title: "private title",
    instruction: "private instruction",
    dispatchGroupID: "dispatch_turn",
    native: {
      sessionID: "session_1",
      inboxID: "inbox_1",
      assistantMessageIDs: ["assistant_1"],
      phase: "replied",
      settledAt: now - 10,
      resultMessageID: "result_1",
      events: [
        { type: "session.inbox.enqueued", at: 1, phase: "queued" },
        { type: "session.execution.started", at: 2, phase: "working", delivery: "delivered" },
        { type: "session.execution.succeeded", at: now - 10, phase: "replied" },
      ],
    },
  })
  const detail = workDetailFor(turn, {
    subtasks: { turn, child },
    dispatchGroups: { dispatch_turn: group("dispatch_turn") },
    now,
  })
  const text = workDetailText(detail)
  assert.equal(detail.status, "replied")
  assert.match(text, /Origin │ native · turn · adopted/)
  assert.match(text, /Conversation │ w/)
  assert.match(text, /Session │ session_1/)
  assert.match(text, /Inbox │ inbox_1/)
  assert.match(text, /session\.inbox\.enqueued/)
  assert.match(text, /session\.execution\.succeeded/)
  assert.match(text, /child │ b · working/)
  assert.match(text, /dispatch_turn │ hops 2\/8 · cmd 22 left · depth 8/)
  assert.doesNotMatch(text, /private title|private instruction/, "the detail never includes conversation content")
})
