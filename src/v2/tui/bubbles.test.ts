import test from "node:test"
import assert from "node:assert/strict"
import type { Subtask } from "../types.ts"
import { CLIENT_MESSAGE_LIMIT } from "../scoped-read.ts"
import { SYSTEM_AGENT_NAME } from "../system-agent.ts"
import { agentColor } from "./format.ts"
import {
  accumulateCompletions,
  BUBBLE_CHROME,
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
  stabilizeMergedRows,
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

test("bubble chrome accounts for rounded padding plus full border", () => {
  // Ticket #72: padding={1} (2 horizontal) + full border (2 horizontal).
  assert.equal(BUBBLE_CHROME, 4)
  assert.equal(bubbleContentWidth(100), bubbleWidth(100) - BUBBLE_CHROME)
  assert.equal(bubbleContentWidth(160), bubbleWidth(160) - BUBBLE_CHROME)
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
  const colors = { accent: "#accent", muted: "#muted", good: "#good", info: "#info" }
  const agents = { a: agent() } as Record<string, ReturnType<typeof agent> | undefined>
  const roster = [agent()]
  const byID = unifiedAuthorColor({ agentID: "a", author: "Nova", role: "agent" }, agents, roster as any, colors, [])
  const byName = unifiedAuthorColor({ author: "Nova", role: "agent" }, agents, roster as any, colors, [])
  assert.equal(byID, byName)
  assert.equal(byID, agentColor(agent() as any, "#accent", 0, []))
  assert.equal(unifiedAuthorColor({ author: "You", role: "user" }, agents, roster as any, colors, []), "#good")
  assert.equal(unifiedAuthorColor({ author: "Ensemble", role: "system" }, agents, roster as any, colors, []), "#muted")
  // Ticket #100: the System Agent is a non-roster display author and reads
  // in the information color, never as an unknown roster agent.
  assert.equal(
    unifiedAuthorColor({ author: SYSTEM_AGENT_NAME, role: "agent" }, agents, roster as any, colors, []),
    "#info",
  )
  // Ticket #77: a system-authored line that still carries a real agentID
  // resolves the agent color — "Handed to $Nova" names are never grey.
  assert.equal(
    unifiedAuthorColor({ agentID: "a", author: "Ensemble", role: "system" }, agents, roster as any, colors, []),
    agentColor(agent() as any, "#accent", 0, []),
  )
  // Unknown agents fall back to the accent without throwing.
  assert.equal(unifiedAuthorColor({ agentID: "zzz", author: "Ghost", role: "agent" }, {}, [], colors, []), "#accent")
})

test("completion entries carry finish time and stable done: IDs", () => {
  const done = completionEntry(
    task({ id: "t1", state: "replied", outcome: "succeeded", createdAt: 5, repliedAt: 9, finishedAt: 10 }),
    "Nova",
    100,
  )
  assert.deepEqual(done, { id: "done:t1", text: "● Nova finished: Check the build", at: 10, tone: "success" as const })
  assert.equal(completionEntry(task({ state: "working", claimedBy: "r", leaseUntil: 9999, attempts: 1 }), "Nova", 100), undefined)
})

test("failed and cancelled completion entries carry the error emphasis tone", () => {
  const failed = completionEntry(
    task({ id: "t1", state: "replied", outcome: "failed", error: "boom", createdAt: 5, finishedAt: 10 }),
    "Nova",
    100,
  )
  assert.equal(failed?.tone, "error")
  assert.equal(failed?.text, "✕ Nova failed: boom")
  const cancelled = completionEntry(
    task({ id: "t2", state: "replied", outcome: "failed", stoppedAt: 9, createdAt: 5, finishedAt: 10 }),
    "Nova",
    100,
  )
  assert.equal(cancelled?.tone, "error")
  assert.match(cancelled?.text ?? "", /⊘ .* cancelled/)
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

test("a long session bounds the completion map to the newest outcomes", () => {
  const labelFor = () => "Nova"
  const outcomes = Array.from({ length: CLIENT_MESSAGE_LIMIT + 20 }, (_, index) =>
    task({
      id: `t${index + 1}`,
      state: "replied",
      outcome: "succeeded",
      createdAt: index + 1,
      repliedAt: index + 1,
      finishedAt: index + 1,
    }),
  )
  const map = accumulateCompletions(new Map(), outcomes, labelFor, 10_000)
  assert.equal(map.size, CLIENT_MESSAGE_LIMIT, "completion memory stays bounded in a long session")
  assert.equal(map.has("t1"), false, "the oldest outcome is dropped first")
  assert.equal(map.has(`t${CLIENT_MESSAGE_LIMIT + 20}`), true, "the newest outcome is retained")
})

test("merged transcript orders completions at their finish position in one window", () => {
  const messages = [
    { id: "m1", createdAt: 5 },
    { id: "m2", createdAt: 15 },
    { id: "m3", createdAt: 25 },
  ]
  const completions = [{ id: "done:t1", text: "● Nova finished: alpha", at: 10, tone: "success" as const }]
  const merged = mergeTranscriptRows(messages, completions, 40)
  assert.deepEqual(merged.map((row) => row.id), ["m1", "done:t1", "m2", "m3"])
  assert.equal(merged[1].completion?.text, "● Nova finished: alpha")
  assert.equal(merged[0].message?.id, "m1")
  // Exactly one row per ID even when a completion collides with a message timestamp.
  const clash = mergeTranscriptRows(
    [{ id: "m1", createdAt: 10 }],
    [{ id: "done:t1", text: "x", at: 10, tone: "success" as const }],
    40,
  )
  assert.equal(clash.length, 2)
  // Ticket #77 ordering: at an equal timestamp a message row sorts before a
  // completion row, so an answer is never displaced by its own handoff ack.
  assert.deepEqual(mergeTranscriptRows(
    [{ id: "z-message", createdAt: 10 }],
    [{ id: "done:a-task", text: "x", at: 10, tone: "success" as const }],
    40,
  ).map((row) => row.id), ["z-message", "done:a-task"])
  // The shared window drops the oldest rows first.
  const windowed = mergeTranscriptRows(messages, completions, 2)
  assert.deepEqual(windowed.map((row) => row.id), ["m2", "m3"])
})

test("stabilized merged rows keep identity across idle polls", () => {
  // Ticket #72: idle 250ms polls rebuild wrappers via mergeTranscriptRows;
  // stabilization must reuse the previous wrapper so Solid's <For> mounts
  // nothing when nothing changed.
  const m1 = { id: "m1", createdAt: 5 }
  const m2 = { id: "m2", createdAt: 15 }
  const completions = [{ id: "done:t1", text: "● Nova finished: alpha", at: 10, tone: "success" as const }]
  const first = stabilizeMergedRows([], mergeTranscriptRows([m1, m2], completions, 40))
  // A second poll over the same message refs yields identical wrappers.
  const second = stabilizeMergedRows(first, mergeTranscriptRows([m1, m2], completions, 40))
  assert.equal(second.length, first.length)
  for (let i = 0; i < first.length; i++) assert.equal(second[i], first[i])
  // Completion ordering is untouched by stabilization.
  assert.deepEqual(second.map((row) => row.id), ["m1", "done:t1", "m2"])
  // A new message mounts one fresh wrapper; unchanged rows stay stable.
  const m3 = { id: "m3", createdAt: 25 }
  const third = stabilizeMergedRows(second, mergeTranscriptRows([m1, m2, m3], completions, 40))
  assert.deepEqual(third.map((row) => row.id), ["m1", "done:t1", "m2", "m3"])
  assert.equal(third[0], second[0])
  assert.equal(third[1], second[1])
  assert.equal(third[2], second[2])
  // A changed message ref (edited text upstream) remounts only that row.
  const m1Edited = { id: "m1", createdAt: 5 }
  const fourth = stabilizeMergedRows(third, mergeTranscriptRows([m1Edited, m2, m3], completions, 40))
  assert.notEqual(fourth[0], third[0])
  assert.equal(fourth[1], third[1])
  assert.equal(fourth[2], third[2])
  assert.equal(fourth[3], third[3])
  // A changed completion payload remounts only the completion row.
  const changed = [{ id: "done:t1", text: "● Nova finished: beta", at: 10, tone: "success" as const }]
  const fifth = stabilizeMergedRows(fourth, mergeTranscriptRows([m1Edited, m2, m3], changed, 40))
  assert.equal(fifth[0], fourth[0])
  assert.notEqual(fifth[1], fourth[1])
  assert.equal(fifth[2], fourth[2])
  assert.equal(fifth[3], fourth[3])
  // Ticket #122: an emphasis-tone change is part of the completion payload.
  const retoned = [{ id: "done:t1", text: "● Nova finished: beta", at: 10, tone: "error" as const }]
  const sixth = stabilizeMergedRows(fifth, mergeTranscriptRows([m1Edited, m2, m3], retoned, 40))
  assert.notEqual(sixth[1], fifth[1])
})
