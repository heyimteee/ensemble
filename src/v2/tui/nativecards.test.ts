import test from "node:test"
import assert from "node:assert/strict"
import type { NativeSubagentRun } from "../types.ts"
import {
  NATIVE_SUBAGENT_FOCUS_PREFIX,
  nativeSubagentFocusChild,
  nativeSubagentFocusID,
  nativeSubagentTitle,
  nativeSubagentWorkStatus,
} from "./nativecards.ts"

const run = (patch: Partial<NativeSubagentRun> = {}): NativeSubagentRun => ({
  childSessionID: "ses_child",
  parentSessionID: "ses_parent",
  parentTaskID: "task_1",
  dispatchGroupID: "dispatch_1",
  workspaceID: "w",
  parentAgentID: "kakiko",
  parentAgent: "Kakiko",
  instruction: "Watch the CI",
  state: "working",
  startedAt: 1,
  source: "session-created",
  ...patch,
})

test("ticket187: native subagent states map onto the shared Work status grammar", () => {
  assert.equal(nativeSubagentWorkStatus("working"), "working")
  assert.equal(nativeSubagentWorkStatus("replied"), "replied")
  assert.equal(nativeSubagentWorkStatus("failed"), "failed")
  assert.equal(nativeSubagentWorkStatus("cancelled"), "cancelled")
})

test("ticket187: the card title names the parent's subagent work", () => {
  assert.equal(nativeSubagentTitle(run()), "Subagents: Watch the CI")
  assert.equal(nativeSubagentTitle(run({ instruction: "   " })), "Subagents: subagent")
  assert.equal(nativeSubagentTitle(run({ instruction: "watch\u001b[31m\r\nthe CI" })), "Subagents: watch [31m the CI")
})

test("ticket187: a long instruction truncates safely to the card width", () => {
  const instruction = "Watch the CI ".repeat(20)
  const title = nativeSubagentTitle(run({ instruction }), 24)
  assert.ok(title.length <= 24, "the title never exceeds the card content width")
  assert.ok(title.startsWith("Subagents: "))
  assert.ok(title.endsWith("…"), "a truncation is visible")
  const emoji = nativeSubagentTitle(run({ instruction: "🧪".repeat(40) }), 16)
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji), "a truncation never leaves a lone surrogate")
  assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emoji))
})

test("ticket187: focus ids namespace child sessions and round-trip", () => {
  const id = nativeSubagentFocusID("ses_child")
  assert.equal(id, `${NATIVE_SUBAGENT_FOCUS_PREFIX}ses_child`)
  assert.equal(nativeSubagentFocusChild(id), "ses_child")
  assert.equal(nativeSubagentFocusChild("task_1"), undefined)
  assert.equal(nativeSubagentFocusChild(undefined), undefined)
})
