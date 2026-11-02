import test from "node:test"
import assert from "node:assert/strict"
import type { Subtask } from "../types.ts"
import { agentColor } from "./format.ts"
import {
  accumulateCompletions,
  BUBBLE_WIDTH_RATIO,
  bubbleContentWidth,
  bubbleHead,
  bubbleSide,
  bubbleWidth,
  completionEntry,
  isBubbledRole,
  mergeTranscriptRows,
  relayHeader,
  relayPartiesForTask,
  unifiedAuthorColor,
} from "./bubbles.ts"

const task = (patch: Partial<Subtask> = {}): Subtask => ({
  id: "t",
  workspaceID: "w",
  creatorType: "user",
  assigneeID: "a",
  title: "Check the build",
  instruction: "do",
  mode: "research",
  state: "pending",
  stage: "initial",
  outcome: "pending",
  interrupted: false,
  awaitingChildren: false,
  attempts: 0,
  createdAt: 1,
  ...patch,
})

const agent = (patch: Record<string, unknown> = {}) => ({
  id: "a",
  name: "Nova",
  title: "",
  role: "",
  mainModel: { providerID: "p", modelID: "m" },
  backupModels: [],
  skillbox: [],
  color: "cyan",
  archived: false,
  pendingSettings: false,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
})

test("bubbles bound width to ~72% of the chat column", () => {
  assert.equal(BUBBLE_WIDTH_RATIO, 0.72)
  assert.equal(bubbleWidth(100), 72)
  assert.equal(bubbleWidth(160), 115)
  // Never degenerate on narrow panes.
  assert.ok(bubbleWidth(10) >= 20)
  assert.ok(bubbleContentWidth(100) < bubbleWidth(100))
  assert.ok(bubbleContentWidth(10) >= 16)
})

test("bubble sides put agents left, users right, system full-width", () => {
  assert.equal(bubbleSide("agent"), "left")
  assert.equal(bubbleSide("user"), "right")
  assert.equal(bubbleSide("system"), "full")
  assert.equal(isBubbledRole("agent"), true)
  assert.equal(isBubbledRole("user"), true)
  assert.equal(isBubbledRole("system"), false)
})

test("relay headers name both answerer and asker with mention grammar", () => {
  assert.equal(
    relayHeader({ answerer: "Nova", asker: "Sage", askerIsUser: false }),
    "Answer from $Nova · for $Sage",
  )
  assert.equal(
    relayHeader({ answerer: "Nova", asker: null, askerIsUser: true }),
    "Answer from $Nova · for you",
  )
  assert.equal(bubbleHead("Nova", undefined), "Nova")
  assert.equal(
    bubbleHead("Nova", { answerer: "Nova", asker: "Sage", askerIsUser: false }),
    "Answer from $Nova · for $Sage",
  )
})

test("relay parties resolve answerer and asker for turns and handoffs", () => {
  const names = (id?: string) => (id === "a" ? "Nova" : id === "b" ? "Sage" : "Unassigned")
  const turn = task({
    workKind: "turn",
    turn: { correlationID: "c1", askerKind: "user", answeredByID: "a" },
  })
  assert.deepEqual(relayPartiesForTask(turn, names), { answerer: "Nova", asker: null, askerIsUser: true })
  const agentTurn = task({
    workKind: "turn",
    assigneeID: "a",
    turn: { correlationID: "c2", askerKind: "agent", askerID: "b", answeredByID: "a" },
  })
  assert.deepEqual(relayPartiesForTask(agentTurn, names), { answerer: "Nova", asker: "Sage", askerIsUser: false })
  const handoff = task({
    workKind: "handoff",
    assigneeID: "a",
    handoff: { correlationID: "c3", senderID: "b", recipientID: "a", depth: 1, answeredByID: "a" },
  })
  assert.deepEqual(relayPartiesForTask(handoff, names), { answerer: "Nova", asker: "Sage", askerIsUser: false })
  assert.equal(relayPartiesForTask(task({}), names), undefined)
})

test("one author color serves transcript rows and activity labels alike", () => {
  const colors = { accent: "#accent", muted: "#muted", good: "#good" }
  const agents = { a: agent() } as Record<string, ReturnType<typeof agent> | undefined>
  const roster = [agent()]
  const byID = unifiedAuthorColor({ agentID: "a", author: "Nova", role: "agent" }, agents, roster as any, colors, [])
  const byName = unifiedAuthorColor({ author: "Nova", role: "agent" }, agents, roster as any, colors, [])
  assert.equal(byID, byName)
  assert.equal(byID, agentColor(agent() as any, "#accent", 0, []))
  assert.equal(unifiedAuthorColor({ author: "You", role: "user" }, agents, roster as any, colors, []), "#good")
  assert.equal(unifiedAuthorColor({ author: "Ensemble", role: "system" }, agents, roster as any, colors, []), "#muted")
  // Unknown agents fall back to the accent without throwing.
  assert.equal(unifiedAuthorColor({ agentID: "zzz", author: "Ghost", role: "agent" }, {}, [], colors, []), "#accent")
})

test("completion entries carry finish time and stable done: IDs", () => {
  const done = completionEntry(
    task({ id: "t1", state: "replied", outcome: "succeeded", createdAt: 5, repliedAt: 9, finishedAt: 10 }),
    "Nova",
    100,
  )
  assert.deepEqual(done, { id: "done:t1", text: "● Nova finished: Check the build", at: 10 })
  assert.equal(completionEntry(task({ state: "working", claimedBy: "r", leaseUntil: 9999, attempts: 1 }), "Nova", 100), undefined)
})

test("completion accumulator persists one line per outcome and never regenerates", () => {
  const labelFor = () => "Nova"
  const terminal = task({ id: "t1", state: "replied", outcome: "succeeded", createdAt: 5, repliedAt: 9, finishedAt: 10 })
  const live = task({ id: "t2", state: "working", claimedBy: "r", leaseUntil: 9999, attempts: 1, createdAt: 6 })
  const empty = new Map()
  const first = accumulateCompletions(empty, [terminal, live], labelFor, 100)
  assert.equal(first.size, 1)
  assert.ok(first.get("t1"))
  // A second poll with the same snapshot returns the identical map: no regeneration.
  const second = accumulateCompletions(first, [terminal, live], labelFor, 200)
  assert.equal(second, first)
  // Newly finished work folds in alongside the persisted entry.
  const later = task({ id: "t2", state: "replied", outcome: "succeeded", createdAt: 6, repliedAt: 20, finishedAt: 21 })
  const third = accumulateCompletions(second, [terminal, later], labelFor, 300)
  assert.equal(third.size, 2)
  assert.equal(second.size, 1)
  assert.ok(third.get("t1"))
  assert.equal(third.get("t2")?.at, 21)
})

test("merged transcript orders completions at their finish position in one window", () => {
  const messages = [
    { id: "m1", createdAt: 5 },
    { id: "m2", createdAt: 15 },
    { id: "m3", createdAt: 25 },
  ]
  const completions = [{ id: "done:t1", text: "● Nova finished: alpha", at: 10 }]
  const merged = mergeTranscriptRows(messages, completions, 40)
  assert.deepEqual(merged.map((row) => row.id), ["m1", "done:t1", "m2", "m3"])
  assert.equal(merged[1].completion?.text, "● Nova finished: alpha")
  assert.equal(merged[0].message?.id, "m1")
  // Exactly one row per ID even when a completion collides with a message timestamp.
  const clash = mergeTranscriptRows(
    [{ id: "m1", createdAt: 10 }],
    [{ id: "done:t1", text: "x", at: 10 }],
    40,
  )
  assert.equal(clash.length, 2)
  // The shared window drops the oldest rows first.
  const windowed = mergeTranscriptRows(messages, completions, 2)
  assert.deepEqual(windowed.map((row) => row.id), ["m2", "m3"])
})
