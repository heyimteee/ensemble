import test from "node:test"
import assert from "node:assert/strict"
import type { Subtask } from "../types.ts"
import {
  ACTIVITY_DEFAULT_VERB,
  MAX_VISIBLE_ACTIVITY,
  NEEDS_YOU_MARK,
  activityDetailForTask,
  activityFrameForKind,
  activityLine,
  activityVerb,
  hasActiveWork,
  isNeedsYouTask,
  needsYouSuffix,
  orderedWorkItems,
  pendingWorkLabel,
  queuedActivityFrame,
  selectActivityAgents,
  splitActivityGroups,
  splitLiveFinalized,
  terminalAnnouncement,
  terminalAnnouncements,
  workGlyph,
  workRowFrame,
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
  assert.equal(workGlyph("pending"), "▫")
  assert.equal(workGlyph("working"), "⠋")
  assert.equal(workGlyph("retrying"), "⠋")
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
    "⠋ Check the build │ Nova │ working",
  )
  assert.equal(
    workRowText(task({ state: "replied", outcome: "succeeded" }), "Nova", 1000),
    "● Check the build │ Nova │ replied",
  )
  assert.equal(
    workRowText(task({ state: "replied", outcome: "failed", error: "boom" }), "Sage", 1000),
    "✕ Check the build │ Sage │ failed",
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
  assert.equal(activityLine("Clark", ACTIVITY_DEFAULT_VERB, "⠋"), "⠋ Clark │ checking the details…")
  assert.equal(ACTIVITY_DEFAULT_VERB, "checking the details…")
  assert.equal(activityVerb("running", "tests"), "running tests…")
  assert.equal(activityVerb("reading", "notes.md"), "reading notes.md…")
  assert.equal(activityVerb("waiting", "Ana"), "waiting on Ana…")
  assert.equal(activityVerb("wrapping"), "wrapping up…")
  assert.equal(activityVerb("reading"), ACTIVITY_DEFAULT_VERB)
})

test("activity selection dedups agents oldest-first and caps with overflow", () => {
  const entries = [
    { key: "b", label: "Ana", createdAt: 2, verb: ACTIVITY_DEFAULT_VERB, kind: "checking" as const },
    { key: "a", label: "Clark", createdAt: 1, verb: ACTIVITY_DEFAULT_VERB, kind: "checking" as const },
    { key: "b", label: "Ana", createdAt: 3, verb: ACTIVITY_DEFAULT_VERB, kind: "checking" as const },
    { key: "c", label: "Bo", createdAt: 4, verb: ACTIVITY_DEFAULT_VERB, kind: "checking" as const },
    { key: "d", label: "Dee", createdAt: 5, verb: ACTIVITY_DEFAULT_VERB, kind: "checking" as const },
    { key: "e", label: "Eli", createdAt: 6, verb: ACTIVITY_DEFAULT_VERB, kind: "checking" as const },
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

test("activity groups mark in-flight peer turns with the asking variant", () => {
  const keyFor = (item: Subtask) => item.assigneeID ?? "unassigned"
  const labelFor = (item: Subtask) => (item.assigneeID === "a" ? "Clark" : "Ana")
  const items = [
    task({ id: "turn", workKind: "turn", assigneeID: "a", state: "working", claimedBy: "r", leaseUntil: 9999, attempts: 1, createdAt: 2, turn: { correlationID: "c1", askerKind: "user" } }),
    task({ id: "delegation", workKind: "delegation", assigneeID: "b", state: "working", claimedBy: "r", leaseUntil: 9999, attempts: 1, createdAt: 1 }),
  ]
  const groups = splitActivityGroups(items, keyFor, labelFor, 1000)
  assert.equal(groups.live.find((entry) => entry.label === "Clark")?.verb, "Asking $Clark…")
  assert.equal(groups.live.find((entry) => entry.label === "Clark")?.kind, "asking")
  // Ticket #70: live delegation work names itself instead of hiding behind
  // the generic checking default (reserved for genuinely unknown activity).
  assert.equal(groups.live.find((entry) => entry.label === "Ana")?.verb, "working…")
  assert.equal(groups.live.find((entry) => entry.label === "Ana")?.kind, "working")
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

test("work row frames use the named sets per status, not one generic frame", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((tick) => workRowFrame("working", tick)),
    ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  )
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((tick) => workRowFrame("retrying", tick)),
    ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  )
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 7].map((tick) => workRowFrame("pending", tick)),
    ["▫", "▪", "▫", "▪", "▫", "▪", "▫", "▪"],
  )
  // Terminal rows are static final glyphs, never animation frames.
  assert.equal(workRowFrame("replied", 3), "●")
  assert.equal(workRowFrame("failed", 3), "✕")
  assert.equal(workRowFrame("cancelled", 3), "⊘")
})

test("work row frames are constant-width and pin to frame 0 under reduced motion", () => {
  for (let tick = 0; tick < 10; tick++) {
    assert.equal([...workRowFrame("working", tick)].length, 1)
    assert.equal([...workRowFrame("pending", tick)].length, 1)
  }
  assert.equal(workRowFrame("working", 3, { ENSEMBLE_REDUCED_MOTION: "1" }), "⠋")
  assert.equal(workRowFrame("pending", 1, { NO_COLOR: "1" }), "▫")
})

test("activity frames route verb kinds to the named sets", () => {
  assert.equal(activityFrameForKind("checking", 0), "⠋")
  assert.equal(activityFrameForKind("checking", 1), "⠙")
  assert.equal(activityFrameForKind("wrapping", 2), "⠹")
  assert.equal(activityFrameForKind("waiting", 0), "▫")
  assert.equal(activityFrameForKind("waiting", 1), "▪")
  assert.equal(activityFrameForKind("reading", 0), "▸")
  assert.equal(activityFrameForKind("searching", 1), "▹")
  assert.equal(activityFrameForKind("running", 0), "▸")
  assert.equal(activityFrameForKind("writing", 1), "▹")
  assert.equal(activityFrameForKind("running", 3, { ENSEMBLE_REDUCED_MOTION: "1" }), "▸")
  assert.equal(activityFrameForKind("waiting", 1, { NO_COLOR: "1" }), "▫")
})

test("slice C asking and thinking verbs use their named frames", () => {
  assert.equal(activityFrameForKind("asking", 0), "⠋")
  assert.equal(activityFrameForKind("asking", 1), "⠙")
  assert.equal(activityFrameForKind("asking", 2, { ENSEMBLE_REDUCED_MOTION: "1" }), "⠋")
  assert.equal(activityFrameForKind("thinking", 0), "·  ")
  assert.equal(activityFrameForKind("thinking", 1), "˙  ")
  assert.equal(activityFrameForKind("thinking", 0, { ENSEMBLE_REDUCED_MOTION: "1" }), "·  ")
  assert.equal(activityDetailForTask(task({ workKind: "turn", assigneeID: "a" }), "Nova").verb, "Asking $Nova…")
  assert.equal(activityDetailForTask(task({ workKind: "turn", assigneeID: "a" }), "Nova").kind, "asking")
  assert.equal(activityDetailForTask(task({ workKind: "handoff", assigneeID: "a" }), "Nova").kind, "asking")
  assert.equal(activityDetailForTask(task({ workKind: "delegation", assigneeID: "a" }), "Nova").verb, ACTIVITY_DEFAULT_VERB)
  assert.equal(activityDetailForTask(task({ workKind: "delegation", assigneeID: "a" }), "Nova").kind, "checking")
})

test("queued activity lines stay static across ticks", () => {
  for (let tick = 0; tick < 8; tick++) assert.equal(queuedActivityFrame(), "▫")
})

test("review fix: interim work labels name the in-flight action", () => {
  assert.equal(pendingWorkLabel("stop"), "Stopping…")
  assert.equal(pendingWorkLabel("cancel"), "Cancelling…")
  assert.equal(pendingWorkLabel("retry"), "Retrying…")
  assert.equal(pendingWorkLabel("restart"), "Restarting…")
})

test("review fix: pending work rows show the interim label until terminal", () => {
  const running = task({ state: "working", claimedBy: "run", leaseUntil: 9000, attempts: 1 })
  assert.equal(
    workRowText(running, "Nova", 1000, { pending: "cancel" }),
    "⠋ Check the build │ Nova │ Cancelling…",
  )
  assert.equal(
    workRowText(running, "Nova", 1000, { pending: "stop" }),
    "⠋ Check the build │ Nova │ Stopping…",
  )
  assert.equal(
    workRowText(task({ state: "pending" }), "Nova", 1000, { pending: "retry" }),
    "▫ Check the build │ Nova │ Retrying…",
  )
  // No pending action: the derived status renders as before.
  assert.equal(workRowText(running, "Nova", 1000), "⠋ Check the build │ Nova │ working")
  assert.equal(workRowText(running, "Nova", 1000, { pending: null }), "⠋ Check the build │ Nova │ working")
})

test("review fix: needs-you rows carry a distinct marker, never plain waiting", () => {
  const running = task({ state: "working", claimedBy: "run", leaseUntil: 9000, attempts: 1 })
  assert.equal(
    workRowText(running, "Nova", 1000, { needsYou: true }),
    `◆ ⠋ Check the build │ Nova │ working${needsYouSuffix()}`,
  )
  assert.ok(workRowText(running, "Nova", 1000, { needsYou: true }).includes("needs you"))
  assert.ok(workRowText(running, "Nova", 1000, { needsYou: true }).includes("v to resolve"))
  assert.ok(!workRowText(running, "Nova", 1000).includes(NEEDS_YOU_MARK))
  // Interim + needs-you compose: the marker survives while stopping.
  assert.ok(workRowText(running, "Nova", 1000, { needsYou: true, pending: "stop" }).includes("Stopping…"))
})

test("review fix: needs-you derives from existing interruption/approval state", () => {
  const pending = task({ approvalID: "ap" })
  assert.equal(isNeedsYouTask(task({ interrupted: true }), new Set()), true)
  assert.equal(isNeedsYouTask(pending, new Set(["ap"])), true)
  assert.equal(isNeedsYouTask(pending, new Set(["other"])), false)
  assert.equal(isNeedsYouTask(task({}), new Set()), false)
  assert.equal(isNeedsYouTask(task({ approvalID: "ap" }), new Set()), false)
})

test("work summary counts active work only and names the empty state", () => {
  assert.equal(workSummary([], 1000), "WORK │ none yet")
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

test("ticket68: native-blocked tasks read as needs-you without an approvalID", async () => {
  const { isNeedsYouTask } = await import("./workrows.ts")
  const plain = { id: "t", interrupted: false } as any
  assert.equal(isNeedsYouTask(plain, new Set(), new Set(["t"])), true)
  assert.equal(isNeedsYouTask(plain, new Set(), new Set(["other"])), false)
  assert.equal(isNeedsYouTask(plain, new Set(["ap"]), new Set(["t"])), true)
})
