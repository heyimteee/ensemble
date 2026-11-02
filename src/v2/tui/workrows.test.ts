import test from "node:test"
import assert from "node:assert/strict"
import type { Subtask } from "../types.ts"
import { orderedWorkItems, splitLiveFinalized, workGlyph, workRowText, workStatusLabel, workSummary } from "./workrows.ts"

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

test("work glyphs are distinct per terminal state", () => {
  assert.equal(workGlyph("pending"), "○")
  assert.equal(workGlyph("replied"), "●")
  assert.notEqual(workGlyph("failed"), workGlyph("replied"))
  assert.notEqual(workGlyph("cancelled"), workGlyph("replied"))
  assert.notEqual(workGlyph("failed"), workGlyph("cancelled"))
})

test("work status labels name the visible lifecycle", () => {
  assert.equal(workStatusLabel("pending"), "pending")
  assert.equal(workStatusLabel("working"), "working")
  assert.equal(workStatusLabel("retrying"), "retrying")
  assert.equal(workStatusLabel("replied"), "replied")
  assert.equal(workStatusLabel("failed"), "failed")
  assert.equal(workStatusLabel("cancelled"), "cancelled")
})

test("work rows show the assigned agent and derived state", () => {
  assert.equal(
    workRowText(task({ state: "working", claimedBy: "run", leaseUntil: 9000, attempts: 1 }), "Nova", 1000),
    "◐ Check the build · Nova · working",
  )
  assert.equal(
    workRowText(task({ state: "replied", outcome: "succeeded" }), "Nova", 1000),
    "● Check the build · Nova · replied",
  )
  assert.equal(
    workRowText(task({ state: "replied", outcome: "failed", error: "boom" }), "Sage", 1000),
    "✕ Check the build · Sage · failed",
  )
})

test("work rows keep unassigned work visible", () => {
  assert.ok(workRowText(task({ assigneeID: undefined }), "Unassigned", 1000).includes("Unassigned"))
})

test("ordered work puts active first, then recent terminal, capped", () => {
  const items = [
    task({ id: "old-terminal", state: "replied", outcome: "succeeded", repliedAt: 10, finishedAt: 10, createdAt: 1 }),
    task({ id: "pending", state: "pending", createdAt: 3 }),
    task({ id: "working", state: "working", claimedBy: "r", leaseUntil: 9999, attempts: 1, createdAt: 2 }),
    task({ id: "new-terminal", state: "replied", outcome: "succeeded", repliedAt: 30, finishedAt: 30, createdAt: 4 }),
  ]
  const ordered = orderedWorkItems(items, 1000, 1).map((item) => item.id)
  assert.deepEqual(ordered, ["working", "pending", "new-terminal"])
})

test("live/finalized split keeps concurrent live rows distinct and folds finalize in place", () => {
  const line = (id: string, streaming?: boolean) => ({ id, streaming })
  const live = splitLiveFinalized([line("a"), line("b", true), line("c", true)])
  assert.deepEqual(live.finalized.map((item) => item.id), ["a"])
  assert.deepEqual(live.live.map((item) => item.id), ["b", "c"])
  const folded = splitLiveFinalized([line("a"), line("b"), line("c")])
  assert.deepEqual(folded.live, [])
  assert.deepEqual(folded.finalized.map((item) => item.id), ["a", "b", "c"])
  const ids = [...folded.finalized, ...folded.live].map((item) => item.id)
  assert.deepEqual([...new Set(ids)], ids)
})

test("work summary counts sensibly and names the empty state", () => {
  assert.equal(workSummary([], 1000), "WORK · none yet")
  const summary = workSummary(
    [
      task({ id: "a", state: "working", claimedBy: "r", leaseUntil: 9999, attempts: 1 }),
      task({ id: "b", state: "pending" }),
      task({ id: "c", state: "replied", outcome: "succeeded" }),
    ],
    1000,
  )
  assert.ok(summary.includes("1 working"))
  assert.ok(summary.includes("1 pending"))
  assert.ok(summary.includes("1 replied"))
})
