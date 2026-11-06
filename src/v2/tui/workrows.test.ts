import test from "node:test"
import assert from "node:assert/strict"
import { deriveWorkStatus } from "../queue.ts"
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
  mergeStreamingActivity,
  needsYouSuffix,
  orderedWorkItems,
  pendingWorkLabel,
  queuedActivityFrame,
  recentWorkCardsForTasks,
  recentWorkItems,
  hasRecentWork,
  RECENT_WORK_TTL_MS,
  selectActivityAgents,
  splitActivityGroups,
  splitLiveFinalized,
  suppressCardedActivity,
  terminalAnnouncement,
  terminalAnnouncements,
  workCardDetail,
  workCardForTask,
  workCardLayout,
  workCardsForTasks,
  workGlyph,
  workRowFrame,
  workRowText,
  workStatusLabel,
  workSummary,
  WORK_BASE_ROWS,
  WORK_CARD_ROWS,
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

test("ticket115: carded tasks suppress their duplicate activity line, uncarded work stays", () => {
  const keyFor = (item: Subtask) => item.assigneeID ?? "unassigned"
  const labelFor = (item: Subtask) => item.id
  const items = [
    task({ id: "carded-live", workKind: "turn", assigneeID: "a", state: "working", claimedBy: "r", leaseUntil: 9999, attempts: 1, createdAt: 1, turn: { correlationID: "c1", askerKind: "user" } }),
    task({ id: "uncarded-live", assigneeID: "b", state: "working", claimedBy: "r", leaseUntil: 9999, attempts: 1, createdAt: 2 }),
    task({ id: "carded-queued", assigneeID: "c", state: "pending", createdAt: 3 }),
    task({ id: "uncarded-queued", assigneeID: "d", state: "pending", createdAt: 4 }),
  ]
  const groups = splitActivityGroups(items, keyFor, labelFor, 1000)
  assert.deepEqual(groups.live.map((entry) => entry.taskID), ["carded-live", "uncarded-live"])
  assert.deepEqual(groups.queued.map((entry) => entry.taskID), ["carded-queued", "uncarded-queued"])

  // Ticket #115 follow-up: merge before suppressing. The task-backed entry
  // keeps its agent key during the merge, so the streaming row cannot replace
  // the suppressed card detail. A stream-only agent with no card survives.
  const merged = mergeStreamingActivity(
    groups.live,
    [
      { agentID: "a", author: "CardedAgent", createdAt: 5 },
      { agentID: "stream", author: "StreamAgent", createdAt: 10 },
    ],
    1000,
  )
  assert.equal(merged.filter((entry) => entry.agentID === "a").length, 1, "no streaming duplicate for a carded agent")
  const visible = suppressCardedActivity({ live: merged, queued: groups.queued }, new Set(["carded-live", "carded-queued"]))
  assert.deepEqual(visible.live.map((entry) => entry.taskID), ["uncarded-live", undefined])
  assert.ok(visible.live.some((entry) => entry.agentID === "stream"), "streaming-only activity without a card stays visible")
  assert.deepEqual(visible.queued.map((entry) => entry.taskID), ["uncarded-queued"])
  assert.deepEqual(
    suppressCardedActivity(groups, new Set()).live.map((entry) => entry.taskID),
    groups.live.map((entry) => entry.taskID),
  )
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

test("work summary counts active and recent work and names the empty state", () => {
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
  assert.equal(summary, "WORK 2 active · 0 recent", "legacy terminal rows without a finish time add no recent count")
})

test("ticket68: native-blocked tasks read as needs-you without an approvalID", async () => {
  const { isNeedsYouTask } = await import("./workrows.ts")
  const plain = { id: "t", interrupted: false } as any
  assert.equal(isNeedsYouTask(plain, new Set(), new Set(["t"])), true)
  assert.equal(isNeedsYouTask(plain, new Set(), new Set(["other"])), false)
  assert.equal(isNeedsYouTask(plain, new Set(["ap"]), new Set(["t"])), true)
})

test("ticket115: work cards map agent, glyph, state, title, detail, and a full-width tide", () => {
  const card = workCardForTask(
    task({ state: "working", claimedBy: "run", leaseUntil: 9000, attempts: 1 }),
    "Nova",
    {
      now: 1000,
      tick: 2,
      width: 40,
      detailFor: () => "reading src/auth.ts",
    },
  )
  assert.equal(card.agent, "Nova")
  assert.equal(card.glyph, "⠹")
  assert.equal(card.state, "working")
  assert.equal(card.status, "working")
  assert.equal(card.title, "Check the build")
  assert.equal(card.detail, "reading src/auth.ts")
  assert.equal(card.tide.length, 40)
  assert.equal(card.tideLevels.length, 20)
  assert.ok(!JSON.stringify(card).includes("%"), "cards never invent a percentage")
})

test("ticket115: contract details are honest for queued, retrying, and stopped work", () => {
  const pend = workCardForTask(task({ state: "pending" }), "Nova", { now: 1000, tick: 0, width: 40 })
  assert.equal(pend.state, "pending")
  assert.equal(pend.glyph, "▫")
  assert.equal(pend.detail, "queued")

  const retrying = workCardForTask(
    task({ state: "working", attempts: 1, retryAfter: 1500 }),
    "Nova",
    { now: 1000, tick: 0, width: 40, detailFor: () => "retrying…" },
  )
  assert.equal(retrying.state, "retrying")
  assert.equal(retrying.detail, "retrying…")

  const stopping = workCardForTask(
    task({ state: "working", claimedBy: "run", leaseUntil: 9000, attempts: 1 }),
    "Nova",
    { now: 1000, tick: 0, width: 40, pendingFor: (item) => (item.id === "t" ? "cancel" : null) },
  )
  assert.equal(stopping.state, "working")
  assert.equal(stopping.detail, "Cancelling…")
})

test("ticket115: needs-you cards carry the static marker and waiting detail", () => {
  const card = workCardForTask(task({ interrupted: true }), "Nova", { now: 1000, tick: 3, width: 40 })
  assert.equal(card.glyph, NEEDS_YOU_MARK)
  assert.equal(card.state, "needs you")
  assert.equal(card.detail, "waiting for you…")
  assert.equal(card.needsYou, true)
})

test("ticket115: card titles truncate to the content width instead of wrapping", () => {
  const longTitle = `t${"i".repeat(100)}`
  const card = workCardForTask(task({ title: longTitle }), "Nova", { now: 1000, tick: 0, width: 20 })
  assert.ok(card.title.length <= 18)
  assert.ok(card.title.endsWith("…"))
  assert.ok(card.detail.length <= 18)
})

test("ticket115: card ordering keeps active work only, working first and oldest-first", () => {
  const items = [
    task({ id: "terminal", state: "replied", outcome: "succeeded", repliedAt: 10, finishedAt: 10, createdAt: 0 }),
    task({ id: "pending-old", state: "pending", createdAt: 1 }),
    task({ id: "working-new", state: "working", claimedBy: "r", leaseUntil: 9000, attempts: 1, createdAt: 5 }),
    task({ id: "working-old", state: "working", claimedBy: "r", leaseUntil: 9000, attempts: 1, createdAt: 2 }),
    task({ id: "pending-new", state: "pending", createdAt: 6 }),
  ]
  const cards = workCardsForTasks(items, () => "Nova", { now: 1000, tick: 0, width: 40 })
  assert.deepEqual(cards.map((card) => card.id), ["working-old", "working-new", "pending-old", "pending-new"])
})

test("ticket115: card height fits three, two, or one and falls back to compact rows", () => {
  const wide = workCardLayout(40, 5)
  assert.deepEqual(wide, { mode: "cards", limit: 3, overflow: 2, rows: 17 })
  assert.deepEqual(workCardLayout(40, 2), { mode: "cards", limit: 2, overflow: 0, rows: 11 })
  assert.deepEqual(workCardLayout(34, 2), { mode: "cards", limit: 2, overflow: 0, rows: 11 })
  assert.deepEqual(workCardLayout(33, 2), { mode: "cards", limit: 1, overflow: 1, rows: 7 })
  assert.deepEqual(workCardLayout(30, 2), { mode: "cards", limit: 1, overflow: 1, rows: 7 })
  assert.deepEqual(workCardLayout(29, 1), { mode: "cards", limit: 1, overflow: 0, rows: 6 })
  assert.deepEqual(workCardLayout(24, 3), { mode: "compact", limit: 1, overflow: 2, rows: 2 })
  assert.deepEqual(workCardLayout(27, 3), { mode: "compact", limit: 2, overflow: 1, rows: 3 })
  assert.deepEqual(workCardLayout(50, 1), { mode: "cards", limit: 1, overflow: 0, rows: 6 })
})

test("ticket115: card layouts leave transcript rows at the reference and compact sizes", () => {
  const tall = workCardLayout(40, 5)
  assert.ok(40 - WORK_BASE_ROWS - tall.rows >= 4, "120x40 keeps at least four transcript rows")
  const short = workCardLayout(24, 3)
  assert.ok(24 - WORK_BASE_ROWS - short.rows >= 3, "80x24 keeps at least three transcript rows")
  assert.ok(WORK_CARD_ROWS >= 4, "a card is tall enough for header, title, detail, and tide")
})

test("ticket115: card detail defaults stay honest", () => {
  assert.equal(workCardDetail("working"), "working…")
  assert.equal(workCardDetail("pending"), "queued")
  assert.equal(workCardDetail("retrying"), "retrying…")
  assert.equal(workCardDetail("working", { activity: "running tests…" }), "running tests…")
  assert.equal(workCardDetail("working", { pending: "stop" }), "Stopping…")
  assert.equal(workCardDetail("pending", { needsYou: true }), "waiting for you…")
})

test("ticket117: terminal work stays recent for eight seconds after it finishes", () => {
  const finished = task({
    id: "done",
    state: "replied",
    outcome: "succeeded",
    repliedAt: 10_000,
    finishedAt: 10_000,
  })
  assert.equal(RECENT_WORK_TTL_MS, 8_000)
  assert.deepEqual(recentWorkItems([finished], 10_001).map((item) => item.id), ["done"])
  assert.deepEqual(recentWorkItems([finished], 17_999).map((item) => item.id), ["done"], "visible just before the window closes")
  assert.deepEqual(recentWorkItems([finished], 18_000), [], "gone at the eight-second boundary")
  assert.equal(hasRecentWork([finished], 17_999), true)
  assert.equal(hasRecentWork([finished], 18_000), false)
})

test("ticket117: all three terminal outcomes are recent and active work never is", () => {
  const now = 40_000
  const items = [
    task({ id: "working", state: "working", claimedBy: "run", leaseUntil: 99_000, attempts: 1, createdAt: 1 }),
    task({ id: "failed", state: "replied", outcome: "failed", error: "boom", repliedAt: 35_000, finishedAt: 35_000 }),
    task({ id: "stopped", state: "replied", outcome: "succeeded", stoppedAt: 36_000, repliedAt: 36_000, finishedAt: 36_000 }),
    task({ id: "replied", state: "replied", outcome: "succeeded", repliedAt: 37_000, finishedAt: 37_000 }),
    task({ id: "old", state: "replied", outcome: "succeeded", repliedAt: 20_000, finishedAt: 20_000 }),
  ]
  assert.deepEqual(recentWorkItems(items, now).map((item) => item.id), ["failed", "stopped", "replied"])
  assert.deepEqual(recentWorkItems(items, now).map((item) => deriveWorkStatus(item, now)), ["failed", "cancelled", "replied"])
})

test("ticket117: recent ordering follows finish time, not creation or snapshot order", () => {
  const items = [
    task({ id: "newer-finished", state: "replied", outcome: "succeeded", createdAt: 1, repliedAt: 30, finishedAt: 30 }),
    task({ id: "older-finished", state: "replied", outcome: "succeeded", createdAt: 20, repliedAt: 10, finishedAt: 10 }),
  ]
  assert.deepEqual(recentWorkItems(items, 40).map((item) => item.id), ["older-finished", "newer-finished"])
})

test("ticket117: terminal rows without a finish timestamp invent no recency", () => {
  const legacy = task({ state: "replied", outcome: "succeeded", createdAt: 100 })
  assert.deepEqual(recentWorkItems([legacy], 200), [], "there is no honest finish time to measure from")
  assert.equal(hasRecentWork([legacy], 200), false)
})

test("ticket117: recent cards settle flat and keep the terminal state word", () => {
  const items = [
    task({ id: "failed", state: "replied", outcome: "failed", error: "boom", repliedAt: 1_000, finishedAt: 1_000, title: "Old fail" }),
    task({ id: "stopped", state: "replied", outcome: "succeeded", stoppedAt: 1_100, repliedAt: 1_100, finishedAt: 1_100, title: "Old stop" }),
    task({ id: "working", state: "working", claimedBy: "run", leaseUntil: 9_000, attempts: 1, createdAt: 1 }),
  ]
  const cards = recentWorkCardsForTasks(items, () => "Nova", { now: 1_500, tick: 7, width: 40 })
  assert.deepEqual(cards.map((card) => card.id), ["failed", "stopped"])
  const failed = cards[0]
  const stopped = cards[1]
  assert.equal(failed.recent, true)
  assert.equal(failed.status, "failed")
  assert.equal(failed.glyph, "✕")
  assert.equal(failed.state, "failed")
  assert.equal(failed.detail, "failed")
  assert.equal(stopped.glyph, "⊘")
  assert.equal(stopped.state, "cancelled")
  for (const card of cards) {
    assert.equal(new Set([...card.tide]).size, 1, "the settled strip is flat")
    assert.ok(card.tideLevels.every((level) => level === 0), "every settled sample sits at the same level")
    assert.equal(card.tide.length, 40)
    assert.equal(card.tideLevels.length, 20)
    assert.ok(!JSON.stringify(card).includes("%"), "recent cards never invent a percentage")
  }
})

test("ticket117: recent cards are display-only and never carry needs-you", () => {
  const interrupted = task({
    id: "interrupted",
    state: "replied",
    outcome: "succeeded",
    interrupted: true,
    repliedAt: 1_000,
    finishedAt: 1_000,
  })
  const card = recentWorkCardsForTasks([interrupted], () => "Nova", { now: 1_500, tick: 2, width: 40 })[0]
  assert.equal(card.recent, true)
  assert.equal(card.needsYou, false)
  assert.equal(card.glyph, "●")
  assert.equal(card.state, "replied")
  assert.equal(workCardForTask(task({ state: "pending" }), "Nova", { now: 1_000, tick: 0, width: 40 }).recent, false)
})

test("ticket117: active and recent card sets stay separate", () => {
  const items = [
    task({ id: "active", state: "pending", createdAt: 1 }),
    task({ id: "recent", state: "replied", outcome: "succeeded", repliedAt: 10, finishedAt: 10, createdAt: 2 }),
  ]
  const options = { now: 20, tick: 0, width: 40 }
  assert.deepEqual(workCardsForTasks(items, () => "Nova", options).map((card) => card.id), ["active"])
  assert.deepEqual(recentWorkCardsForTasks(items, () => "Nova", options).map((card) => card.id), ["recent"])
})

test("ticket117: the Work header distinguishes active and recent counts", () => {
  const now = 20_000
  const recent = task({ id: "recent", state: "replied", outcome: "succeeded", repliedAt: 15_000, finishedAt: 15_000 })
  const active = task({ id: "active", state: "working", claimedBy: "run", leaseUntil: 99_000, attempts: 1 })
  assert.equal(workSummary([active, recent], now), "WORK 1 active · 1 recent")
  assert.equal(workSummary([active], now), "WORK 1 active · 0 recent")
  assert.equal(workSummary([recent], now), "WORK 0 active · 1 recent")
  assert.equal(workSummary([recent], 15_000 + RECENT_WORK_TTL_MS), "WORK │ none yet")
})

test("ticket117: recent cards share the height budget after active cards", () => {
  assert.deepEqual(workCardLayout(40, 1, 1), { mode: "cards", limit: 2, overflow: 0, rows: 11 })
  assert.deepEqual(workCardLayout(40, 1, 3), { mode: "cards", limit: 3, overflow: 1, rows: 17 })
  assert.deepEqual(workCardLayout(40, 0, 2), { mode: "cards", limit: 2, overflow: 0, rows: 11 })
  assert.deepEqual(workCardLayout(24, 0, 2), { mode: "compact", limit: 1, overflow: 1, rows: 2 })
  assert.deepEqual(workCardLayout(24, 1, 1), { mode: "compact", limit: 1, overflow: 1, rows: 2 })
  assert.deepEqual(workCardLayout(24, 0, 0), { mode: "compact", limit: 0, overflow: 0, rows: 0 })
})

test("ticket117: compact fallback keeps transcript and composer at 80x24", () => {
  const layout = workCardLayout(24, 0, 3)
  assert.equal(layout.mode, "compact")
  assert.ok(24 - WORK_BASE_ROWS - layout.rows >= 3, "80x24 keeps at least three transcript rows")
})

test("ticket116: a working card keeps its assigned variant and advances the strip", () => {
  const working = task({ state: "working", claimedBy: "run", leaseUntil: 9000, attempts: 1 })
  const first = workCardForTask(working, "Nova", { now: 1000, tick: 3, width: 40, variant: "ripple" })
  const later = workCardForTask(working, "Nova", { now: 1000, tick: 9, width: 40, variant: "ripple" })
  assert.equal(first.tideVariant, "ripple")
  assert.equal(later.tideVariant, "ripple")
  assert.equal(first.tide.length, 40)
  assert.notEqual(first.tide, later.tide, "working cards animate at the work tick")
})

test("ticket116: needs-you freezes the card's current variant", () => {
  const blocked = task({ state: "working", claimedBy: "run", leaseUntil: 9000, attempts: 1, interrupted: true })
  const first = workCardForTask(blocked, "Nova", { now: 1000, tick: 3, width: 40, variant: "echo" })
  const later = workCardForTask(blocked, "Nova", { now: 1000, tick: 9, width: 40, variant: "echo" })
  assert.equal(first.tideVariant, "echo")
  assert.equal(first.needsYou, true)
  assert.equal(first.tide, later.tide, "the strip does not advance while waiting for the user")
})

test("ticket116: card mapping keeps one stable variant per subtask across polls", () => {
  const items = [
    task({ id: "one", state: "working", claimedBy: "run", leaseUntil: 9000, attempts: 1 }),
    task({ id: "two", state: "pending" }),
  ]
  const assigned = new Map([
    ["one", "echo" as const],
    ["two", "travel" as const],
  ])
  const render = (tick: number) =>
    workCardsForTasks(items, () => "Nova", {
      now: 1000,
      tick,
      tideTick: tick,
      width: 40,
      variantFor: (item) => assigned.get(item.id) ?? "current",
    })
  assert.deepEqual(render(1).map((card) => card.tideVariant), ["echo", "travel"])
  assert.deepEqual(render(9).map((card) => card.tideVariant), ["echo", "travel"])
})

test("ticket116: queued cards stay still and terminal cards settle flat", () => {
  const queued = workCardForTask(task({ state: "pending" }), "Nova", { now: 1000, tick: 3, width: 40, variant: "travel" })
  const queuedLater = workCardForTask(task({ state: "pending" }), "Nova", { now: 1000, tick: 9, width: 40, variant: "travel" })
  assert.equal(queued.tide, queuedLater.tide, "parked work never animates")

  for (const patch of [
    { state: "replied" as const, outcome: "succeeded" as const, repliedAt: 10, finishedAt: 10 },
    { state: "replied" as const, outcome: "failed" as const, repliedAt: 10, finishedAt: 10 },
    { state: "replied" as const, outcome: "succeeded" as const, repliedAt: 10, finishedAt: 10, stoppedAt: 10 },
  ]) {
    const card = workCardForTask(task(patch), "Nova", { now: 2000, tick: 5, width: 40, variant: "inbound" })
    assert.ok(card.tideLevels.every((level) => level === 0), `${card.status} settles flat`)
    assert.equal(card.tide, "▁".repeat(40))
  }
})
