import test from "node:test"
import assert from "node:assert/strict"
import { deriveWorkStatus } from "./queue.ts"
import type { Subtask } from "./types.ts"
import {
  NATIVE_INTERNAL_PROMPT_METADATA,
  nativeAssistantMessageID,
  nativeContextAnswer,
  nativeContextAnswerExact,
  nativeContextTurnAnswer,
  nativeContextTurnGroups,
  nativeContextTurnSettled,
  nativeFinalText,
  nativeInterruptionSettlement,
  nativePromptIsInternal,
  nativePromptSkipsTurn,
  nativePhaseOpen,
  nativeTextForParts,
  nativeTurnGroupID,
  nativeTurnID,
  nativeTurnTitle,
  nativeUserMessageID,
  type NativeTextState,
} from "./native-turn.ts"

test("ticket215: native ids are deterministic and distinct", () => {
  const first = nativeTurnID("s1", "m1")
  assert.equal(first, nativeTurnID("s1", "m1"))
  assert.notEqual(first, nativeTurnID("s2", "m1"))
  assert.notEqual(first, nativeTurnID("s1", "m2"))
  assert.notEqual(nativeUserMessageID("m1"), nativeUserMessageID("m2"))
  assert.notEqual(nativeAssistantMessageID(first), nativeUserMessageID("m1"))
  assert.notEqual(nativeTurnGroupID(first), first)
  assert.match(first, /^task_native_[a-f0-9]{32}$/)
})

test("ticket215: service prompts carry internal metadata and skip mirroring", () => {
  assert.equal(nativePromptIsInternal({ metadata: { [NATIVE_INTERNAL_PROMPT_METADATA]: true } }), true)
  assert.equal(nativePromptIsInternal({ metadata: { [NATIVE_INTERNAL_PROMPT_METADATA]: "true" } }), true)
  assert.equal(nativePromptIsInternal({ metadata: {} }), false)
  assert.equal(nativePromptIsInternal({}), false)
  assert.equal(nativePromptSkipsTurn({ metadata: { "ensemble.mirror": false } }), true)
  assert.equal(nativePromptSkipsTurn({ metadata: { "ensemble.mirror": "false" } }), true)
  assert.equal(nativePromptSkipsTurn({ metadata: { "ensemble.mirror": true } }), false)
})

test("ticket215: a live stream joins ended parts and falls back to deltas", () => {
  const state: NativeTextState = {
    m1: {
      started: [0, 1],
      deltas: { 0: "Match the ", 1: "live " },
      ended: { 0: "Match the final" },
    },
  }
  assert.equal(nativeTextForParts(state), "Match the final\nlive ")
  assert.deepEqual(nativeFinalText(state), { text: "Match the final", complete: false })
})

test("ticket215: the final text is exact only when every started part ended", () => {
  const state: NativeTextState = {
    m1: {
      started: [0, 1],
      deltas: { 0: "ignored" },
      ended: { 0: "First part", 1: "Second part" },
    },
  }
  assert.equal(nativeTextForParts(state), "First part\nSecond part")
  assert.deepEqual(nativeFinalText(state), { text: "First part\nSecond part", complete: true })
})

test("ticket215: context reconciliation prefers recorded assistant ids", () => {
  const messages = [
    { id: "m1", type: "user", content: [{ type: "text", text: "question" }] },
    { id: "m2", type: "assistant", content: [{ type: "text", text: "first answer" }] },
    { id: "m3", type: "assistant", content: [{ type: "text", text: "second answer" }] },
    { id: "m4", type: "idle" },
  ]
  assert.equal(nativeContextAnswer(messages, { inboxID: "m1", assistantMessageIDs: ["m3"] }), "second answer")
  assert.equal(nativeContextAnswer(messages, { inboxID: "m1" }), "first answer")
  assert.equal(nativeContextAnswer(messages, {}), "second answer")
  assert.equal(nativeContextAnswer([{ id: "m1", type: "idle" }]), undefined)
})

test("ticket230: exact context comparison preserves trailing host whitespace", () => {
  const messages = [
    { id: "m1", type: "user", content: [{ type: "text", text: "question" }] },
    { id: "m2", type: "assistant", content: [{ type: "text", text: "answer\n" }] },
  ]
  assert.equal(nativeContextAnswer(messages, { inboxID: "m1" }), "answer")
  assert.equal(nativeContextAnswerExact(messages, { inboxID: "m1" }), "answer\n")
})

test("ticket217: interruption reasons distinguish cancellation from needs-you", () => {
  assert.equal(nativeInterruptionSettlement("user"), "cancelled")
  for (const reason of ["shutdown", "inactivity", "superseded", "", undefined, "future-reason"]) {
    assert.equal(nativeInterruptionSettlement(reason), "interrupted", `${String(reason)} asks the user`)
  }
})

test("ticket217: strict context recovery never attributes an unrelated answer or guesses settlement", () => {
  const messages = [
    { id: "m1", type: "user", content: [{ type: "text", text: "older question" }] },
    { id: "m2", type: "assistant", content: [{ type: "text", text: "older answer" }] },
    { id: "m3", type: "idle" },
    { id: "m4", type: "user", content: [{ type: "text", text: "current question" }] },
  ]
  assert.equal(nativeContextTurnAnswer(messages, { inboxID: "m4" }), undefined, "an older answer is not this turn's")
  assert.equal(nativeContextAnswer(messages, { inboxID: "m4" }), "older answer", "the legacy fallback is unchanged")
  assert.equal(nativeContextTurnSettled(messages, "m4"), false, "no idle marker after this turn")
  assert.equal(nativeContextTurnSettled(messages, "m1"), true, "the idle marker follows the older turn")
  assert.equal(nativeContextTurnSettled(messages, "missing"), false)
})

test("ticket215: a Work title is one bounded line and never empty", () => {
  assert.equal(nativeTurnTitle("  Fix the\nbuild  "), "Fix the build")
  assert.equal(nativeTurnTitle(""), "Native turn")
  assert.equal(nativeTurnTitle("x".repeat(200)).length, 80)
})

const nativeTask = (phase: NonNullable<Subtask["native"]>["phase"], patch: Partial<Subtask> = {}): Subtask => ({
  id: "task_native",
  workspaceID: "dm:a:w",
  creatorType: "user",
  assigneeID: "a",
  title: "Native turn",
  instruction: "do",
  mode: "research",
  state: "working",
  stage: "initial",
  outcome: "pending",
  interrupted: false,
  awaitingChildren: false,
  attempts: 0,
  createdAt: 1,
  origin: "native",
  adopted: true,
  conversationID: "dm:a:w",
  native: { sessionID: "s1", inboxID: "m1", assistantMessageIDs: [], phase },
  ...patch,
})

test("ticket216: only queued, working, and retrying native phases accept turn events", () => {
  assert.equal(nativePhaseOpen("queued"), true)
  assert.equal(nativePhaseOpen("working"), true)
  assert.equal(nativePhaseOpen("retrying"), true)
  for (const settled of ["replied", "failed", "cancelled", "interrupted"] as const) {
    assert.equal(nativePhaseOpen(settled), false, `${settled} is settled`)
  }
  assert.equal(nativePhaseOpen(undefined), false)
})

test("ticket215: native turns use the canonical Work status vocabulary", () => {
  assert.equal(deriveWorkStatus(nativeTask("queued"), 10), "pending")
  assert.equal(deriveWorkStatus(nativeTask("working"), 10), "working")
  assert.equal(deriveWorkStatus(nativeTask("retrying"), 10), "retrying")
  assert.equal(deriveWorkStatus(nativeTask("replied", { state: "replied", outcome: "succeeded" }), 10), "replied")
  assert.equal(
    deriveWorkStatus(nativeTask("failed", { state: "replied", outcome: "failed", failure: { kind: "native" } }), 10),
    "failed",
  )
  assert.equal(
    deriveWorkStatus(nativeTask("cancelled", { state: "replied", outcome: "failed", stoppedAt: 9 }), 10),
    "cancelled",
  )
  assert.equal(
    deriveWorkStatus(nativeTask("interrupted", { interrupted: true }), 10),
    "needs_you",
    "an honest interruption asks the user instead of disappearing",
  )
  assert.equal(
    deriveWorkStatus(nativeTask("replied", { state: "replied", outcome: "succeeded", interrupted: false }), 10),
    "replied",
    "a recovered answer clears an earlier interruption",
  )
})

test("ticket218: context grouping is identity-based and stops at the next opener", () => {
  const messages = [
    { id: "m1", type: "user", content: [{ type: "text", text: "first" }], time: { created: 10 } },
    { id: "m2", type: "assistant", content: [{ type: "text", text: "part one" }] },
    { id: "m3", type: "assistant", content: [{ type: "text", text: "part two" }] },
    { type: "idle" },
    { id: "m4", type: "synthetic", content: [{ type: "text", text: "child finished" }], metadata: { childID: "c1" } },
    { id: "m5", type: "assistant", content: [{ type: "text", text: "synthetic answer" }] },
  ]
  const turns = nativeContextTurnGroups(messages)
  assert.equal(turns.length, 2)
  assert.deepEqual(turns[0], {
    inboxID: "m1",
    itemType: "user",
    text: "first",
    createdAt: 10,
    assistantMessageIDs: ["m2", "m3"],
    assistantText: "part one\npart two",
    hasAssistant: true,
    settled: true,
  })
  assert.equal(turns[1]?.inboxID, "m4")
  assert.equal(turns[1]?.itemType, "synthetic")
  assert.deepEqual(turns[1]?.metadata, { childID: "c1" })
  assert.equal(turns[1]?.settled, false)
  assert.equal(turns[1]?.text, "child finished")
})

test("ticket218: toolkit-only and duplicate context entries stay bounded to one turn", () => {
  const messages = [
    { id: "m1", type: "user", content: [] },
    { id: "m2", type: "assistant", content: [{ type: "tool", name: "read" }] },
    { id: "m1", type: "user", content: [{ type: "text", text: "duplicate" }] },
    { id: "m3", type: "assistant", content: [{ type: "text", text: "ignored duplicate answer" }] },
  ]
  const turns = nativeContextTurnGroups(messages)
  assert.equal(turns.length, 1)
  assert.equal(turns[0]?.hasAssistant, true)
  assert.equal(turns[0]?.assistantText, "")
  assert.equal(turns[0]?.metadata, undefined)
})

test("ticket218: prompt metadata survives context reconciliation for internal/skip decisions", () => {
  const messages = [
    { id: "m1", type: "user", metadata: { "ensemble.internal": true, "ensemble.messageID": "msg_1" }, content: [{ type: "text", text: "composer" }] },
    { id: "m2", type: "user", metadata: { "ensemble.mirror": false }, content: [{ type: "text", text: "onboarding" }] },
  ]
  const turns = nativeContextTurnGroups(messages)
  assert.equal(nativePromptIsInternal({ metadata: turns[0]?.metadata }), true)
  assert.equal(nativePromptSkipsTurn({ metadata: turns[1]?.metadata }), true)
})
