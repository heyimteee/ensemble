import test from "node:test"
import assert from "node:assert/strict"
import { deriveWorkStatus } from "./queue.ts"
import type { Subtask } from "./types.ts"
import {
  NATIVE_INTERNAL_PROMPT_METADATA,
  nativeAssistantMessageID,
  nativeContextAnswer,
  nativeFinalText,
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
