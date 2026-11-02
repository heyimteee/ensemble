import test from "node:test"
import assert from "node:assert/strict"
import type { Subtask } from "../types.ts"
import {
  ACTIVITY_DEFAULT_VERB,
  MAX_VISIBLE_ACTIVITY,
  activityLine,
  activityVerb,
  hasActiveWork,
  orderedWorkItems,
  selectActivityAgents,
  splitActivityGroups,
  splitLiveFinalized,
  terminalAnnouncement,
  terminalAnnouncements,
  workGlyph,
  workRowText,
  workStatusLabel,
  workSummary,
} from "./workrows.ts"

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

test("work block mounts only while active work exists", () => {
  assert.equal(hasActiveWork([], 1000), false)
  assert.equal(hasActiveWork([task({ state: "pending" })], 1000), true)
  assert.equal(
    hasActiveWork([task({ state: "working", claimedBy: "r", leaseUntil: 9999, attempts: 1 })], 1000),
    true,
  )
  assert.equal(hasActiveWork([task({ state: "replied", outcome: "succeeded" })], 1000), false)
  assert.equal(hasActiveWork([task({ state: "replied", outcome: "failed", error: "boom" })], 1000), false)
})

test("ordered work shows active only, never terminal rows", () => {
  const items = [
    task({ id: "old-terminal", state: "replied", outcome: "succeeded", repliedAt: 10, finishedAt: 10, createdAt: 1 }),
    task({ id: "pending", state: "pending", createdAt: 3 }),
    task({ id: "working", state: "working", claimedBy: "r", leaseUntil: 9999, attempts: 1, createdAt: 2 }),
    task({ id: "failed", state: "replied", outcome: "failed", error: "boom", repliedAt: 30, finishedAt: 30, createdAt: 4 }),
    task({ id: "cancelled", state: "replied", outcome: "succeeded", stoppedAt: 40, repliedAt: 40, finishedAt: 40, createdAt: 5 }),
  ]
  const ordered = orderedWorkItems(items, 1000).map((item) => item.id)
  assert.deepEqual(ordered, ["working", "pending"])
})

test("terminal outcomes announce exactly once as transcript system lines", () => {
  const agentOf = (item: Subtask) => (item.assigneeID === "a" ? "Nova" : "Sage")
  assert.equal(
    terminalAnnouncement(task({ state: "replied", outcome: "succeeded", title: "Check the build" }), "Nova", 1000),
    "● Nova finished: Check the build",
  )
  assert.equal(
    terminalAnnouncement(task({ state: "replied", outcome: "failed", error: "boom" }), "Sage", 1000),
    "✕ Sage failed: boom",
  )
  assert.equal(
    terminalAnnouncement(
      task({ state: "replied", outcome: "succeeded", stoppedAt: 50, title: "Old job" }),
      "Nova",
      1000,
    ),
    "⊘ Old job cancelled",
  )
  assert.equal(terminalAnnouncement(task({ state: "pending" }), "Nova", 1000), undefined)
  assert.equal(
    terminalAnnouncement(task({ state: "working", claimedBy: "r", leaseUntil: 9999, attempts: 1 }), "Nova", 1000),
    undefined,
  )
})

test("terminal announcements truncate long titles and reasons", () => {
  const longTitle = `t${"i".repeat(100)}`
  const announced = terminalAnnouncement(task({ state: "replied", outcome: "succeeded", title: longTitle }), "Nova", 1000)
  assert.ok(announced?.startsWith("● Nova finished: "))
  assert.ok((announced?.length ?? 0) <= "● Nova finished: ".length + 60)
  const longError = `e${"r".repeat(120)}`
  const failed = terminalAnnouncement(task({ state: "replied", outcome: "failed", error: longError }), "Sage", 1000)
  assert.ok(failed?.startsWith("✕ Sage failed: "))
  assert.ok((failed?.length ?? 0) <= "✕ Sage failed: ".length + 80)
})

test("terminal announcements order oldest-first with one line per task", () => {
  const items = [
    task({ id: "new", state: "replied", outcome: "succeeded", title: "New", repliedAt: 30, finishedAt: 30, createdAt: 4 }),
    task({ id: "live", state: "pending", title: "Live", createdAt: 1 }),
    task({ id: "old", state: "replied", outcome: "failed", error: "boom", title: "Old", repliedAt: 10, finishedAt: 10, createdAt: 2 }),
  ]
  const lines = terminalAnnouncements(items, () => "Nova", 1000)
  assert.deepEqual(lines.map((line) => line.id), ["old", "new"])
  assert.ok(lines[0].text.startsWith("✕ "))
  assert.ok(lines[1].text.startsWith("● "))
  const ids = lines.map((line) => line.id)
  assert.deepEqual([...new Set(ids)], ids)
})

test("activity lines name the agent with the default verb", () => {
  assert.equal(activityLine("Clark", ACTIVITY_DEFAULT_VERB, "◐"), "◐ Clark · checking the details…")
  assert.equal(ACTIVITY_DEFAULT_VERB, "checking the details…")
  assert.equal(activityVerb("running", "tests"), "running tests…")
  assert.equal(activityVerb("reading", "notes.md"), "reading notes.md…")
  assert.equal(activityVerb("waiting", "Ana"), "waiting on Ana…")
  assert.equal(activityVerb("wrapping"), "wrapping up…")
  assert.equal(activityVerb("reading"), ACTIVITY_DEFAULT_VERB)
})

test("activity selection dedups agents oldest-first and caps with overflow", () => {
  const entries = [
    { key: "b", label: "Ana", createdAt: 2 },
    { key: "a", label: "Clark", createdAt: 1 },
    { key: "b", label: "Ana", createdAt: 3 },
    { key: "c", label: "Bo", createdAt: 4 },
    { key: "d", label: "Dee", createdAt: 5 },
    { key: "e", label: "Eli", createdAt: 6 },
  ]
  const selected = selectActivityAgents(entries, MAX_VISIBLE_ACTIVITY)
  assert.deepEqual(selected.shown, ["Clark", "Ana", "Bo"])
  assert.equal(selected.overflow, 2)
  const tight = selectActivityAgents(entries.slice(0, 2), MAX_VISIBLE_ACTIVITY)
  assert.deepEqual(tight.shown, ["Clark", "Ana"])
  assert.equal(tight.overflow, 0)
})

test("activity groups split live agents from queued-only agents", () => {
  const keyFor = (item: Subtask) => item.assigneeID ?? "unassigned"
  const labelFor = (item: Subtask) => (item.assigneeID === "a" ? "Clark" : "Ana")
  const items = [
    task({ id: "w", assigneeID: "a", state: "working", claimedBy: "r", leaseUntil: 9999, attempts: 1, createdAt: 2 }),
    task({ id: "p1", assigneeID: "a", state: "pending", createdAt: 3 }),
    task({ id: "p2", assigneeID: "b", state: "pending", createdAt: 1 }),
    task({ id: "done", assigneeID: "b", state: "replied", outcome: "succeeded", repliedAt: 4, finishedAt: 4, createdAt: 0 }),
  ]
  const groups = splitActivityGroups(items, keyFor, labelFor, 1000)
  assert.deepEqual(groups.live.map((entry) => entry.label), ["Clark"])
  assert.deepEqual(groups.queued.map((entry) => entry.label), ["Ana"])
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

test("work summary counts active work only and names the empty state", () => {
  assert.equal(workSummary([], 1000), "WORK · none yet")
  const summary = workSummary(
    [
      task({ id: "a", state: "working", claimedBy: "r", leaseUntil: 9999, attempts: 1 }),
      task({ id: "b", state: "pending" }),
      task({ id: "c", state: "replied", outcome: "succeeded" }),
      task({ id: "d", state: "replied", outcome: "failed", error: "boom" }),
    ],
    1000,
  )
  assert.ok(summary.includes("1 working"))
  assert.ok(summary.includes("1 pending"))
  assert.ok(!summary.includes("replied"))
  assert.ok(!summary.includes("failed"))
})
