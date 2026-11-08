import test from "node:test"
import assert from "node:assert/strict"
import type { Subtask } from "../types.ts"
import { TIDE_GLYPHS, createTideFreezeState, type TideFreezeState } from "./tide.ts"
import {
  ACTIVITY_DEFAULT_VERB,
  MAX_VISIBLE_ACTIVITY,
  NEEDS_YOU_MARK,
  activityDetailForTask,
  activityFrameForKind,
  activityLine,
  activityVerb,
  createWorkCardCache,
  hasActiveWork,
  isNeedsYouTask,
  mergeStreamingActivity,
  needsYouSuffix,
  orderedWorkItems,
  pendingWorkLabel,
  queuedActivityFrame,
  selectActivityAgents,
  splitActivityGroups,
  splitLiveFinalized,
  suppressCardedActivity,
  terminalAnnouncement,
  terminalAnnouncements,
  retryCardDetail,
  workCardDetail,
  workCardForTask,
  workCardForTaskCached,
  workCardGlyph,
  workCardHeader,
  workCardHeaderText,
  workCardMotion,
  workCardStateWord,
  workCardTide,
  workCardTones,
  workCompactRow,
  workCompactRowText,
  workCardsForTasks,
  workGlyph,
  workRowFrame,
  workRowText,
  workStatusLabel,
  type WorkCard,
  type WorkCardMotion,
  type WorkCardOptions,
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

/**
 * Ticket #142: pre-split assertions are about the rendered card, so tests
 * compose the static identity data with its animated cells here. Production
 * rendering passes the two pieces separately; only this helper rebuilds the
 * legacy full view model.
 */
function cardWithMotion(
  item: Subtask,
  agentLabel: string,
  options: WorkCardOptions & {
    tick?: number
    tideTick?: number
    env?: NodeJS.ProcessEnv
    freezeState?: TideFreezeState
  },
): WorkCard & WorkCardMotion & { header: WorkCard["header"] & { glyph: string } } {
  const { tick = 0, tideTick, env, freezeState, ...staticOptions } = options
  const card = workCardForTask(item, agentLabel, staticOptions)
  const motion = workCardMotion(card, { tick, tideTick, env, freezeState, now: options.now })
  return { ...card, ...motion, header: { ...card.header, glyph: motion.glyph } }
}

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

test("ticket68: native-blocked tasks read as needs-you without an approvalID", async () => {
  const { isNeedsYouTask } = await import("./workrows.ts")
  const plain = { id: "t", interrupted: false } as any
  assert.equal(isNeedsYouTask(plain, new Set(), new Set(["t"])), true)
  assert.equal(isNeedsYouTask(plain, new Set(), new Set(["other"])), false)
  assert.equal(isNeedsYouTask(plain, new Set(["ap"]), new Set(["t"])), true)
})

test("ticket115: work cards map agent, glyph, state, title, detail, and a full-width tide", () => {
  const card = cardWithMotion(
    task({ state: "working", claimedBy: "run", leaseUntil: 9000, attempts: 1 }),
    "Nova",
    {
      now: 1000,
      tick: 2,
      width: 40,
      detailFor: () => "reading src/auth.ts",
    },
  )
  assert.equal(card.header.name, "NOVA")
  assert.equal(card.header.glyph, "⠹")
  assert.equal(card.header.status, "WORKING")
  assert.equal(card.status, "working")
  assert.equal(card.title, "Check the build")
  assert.equal(card.detail, "reading src/auth.ts")
  assert.equal(card.tide.length, 40)
  assert.equal(card.tideLevels.length, 20)
  assert.ok(!JSON.stringify(card).includes("%"), "cards never invent a percentage")
})

test("ticket156: card headers and tide rows share the exact width and right edge", () => {
  const glyphs = TIDE_GLYPHS as readonly string[]
  for (let width = 16; width <= 120; width++) {
    const card = cardWithMotion(
      task({ state: "working", claimedBy: "run", leaseUntil: 9000, attempts: 1 }),
      "Nova",
      { now: 1000, tick: 2, tideTick: 3, width, variant: "current", env: {} },
    )
    const header = workCardHeaderText(card.header)
    assert.equal(header.length, width, `header width ${width}`)
    assert.equal(card.tide.length, width, `tide width ${width}`)
    assert.equal(card.tideLevels.length, Math.ceil(width / 2), `sampled columns ${width}`)
    assert.ok(header.endsWith(`${card.header.glyph} ${card.header.status}`), "the status word owns the right edge")
    assert.equal(header.lastIndexOf(card.header.status) + card.header.status.length, width)
    assert.equal(header.trimEnd().length, width, "the header never trails a blank")
    assert.equal(card.tide.at(-1), glyphs[card.tideLevels.at(-1) as number], "the last tide cell is its final glyph")
    assert.equal(card.tide.trimEnd().length, width, "the tide never trails a blank")
  }
})

test("ticket156: terminal flat strips and compact rows keep the same exact right edge", () => {
  const glyphs = TIDE_GLYPHS as readonly string[]
  for (let width = 16; width <= 120; width++) {
    const terminal = cardWithMotion(
      task({ state: "replied", outcome: "succeeded", repliedAt: 10, finishedAt: 10 }),
      "Nova",
      { now: 2000, tick: 5, tideTick: 7, width, variant: "inbound", env: {} },
    )
    const header = workCardHeaderText(terminal.header)
    assert.equal(header.length, width, `terminal header width ${width}`)
    assert.equal(terminal.tide.length, width, `flat tide width ${width}`)
    assert.equal(terminal.tideLevels.length, Math.ceil(width / 2), `flat sampled columns ${width}`)
    assert.ok(terminal.tideLevels.every((level) => level === 0))
    assert.equal(terminal.tide.at(-1), glyphs[0], "the flat strip ends on a block glyph")
    assert.equal(terminal.tide.trimEnd().length, width, "the flat strip never trails a blank")

    const row = workCompactRow("Nova", "Check the build", "⠋", "WORKING", width)
    const rowText = workCompactRowText(row)
    assert.equal(rowText.length, width, `compact width ${width}`)
    assert.equal(rowText.lastIndexOf(row.status) + row.status.length, width)
    assert.equal(rowText.trimEnd().length, width, "the compact row never trails a blank")
  }

  const minHeader = workCardHeader("SIZEAGENT1", "◆", "NEEDS YOU", 16)
  assert.equal(workCardHeaderText(minHeader).length, 16, "the minimum card width still fits the widest status")
  assert.equal(workCompactRowText(workCompactRow("SIZEAGENT1", "a very long title", "◆", "NEEDS YOU", 16)).length, 16)
})

test("ticket115: contract details are honest for queued, retrying, and stopped work", () => {
  const pend = cardWithMotion(task({ state: "pending" }), "Nova", { now: 1000, tick: 0, width: 40 })
  assert.equal(pend.header.status, "QUEUED")
  assert.equal(pend.header.glyph, "▫")
  assert.equal(pend.detail, "queued")

  const retrying = cardWithMotion(
    task({ state: "pending", attempts: 1, error: "boom", retryAfter: 1500 }),
    "Nova",
    { now: 1000, tick: 0, width: 40 },
  )
  assert.equal(retrying.header.status, "RETRYING")
  assert.equal(retrying.detail, "retry 1s · 2/5")

  const stopping = cardWithMotion(
    task({ state: "working", claimedBy: "run", leaseUntil: 9000, attempts: 1 }),
    "Nova",
    { now: 1000, tick: 0, width: 40, pendingFor: (item) => (item.id === "t" ? "cancel" : null) },
  )
  assert.equal(stopping.header.status, "WORKING")
  assert.equal(stopping.detail, "Cancelling…")
})

test("ticket144: retrying detail counts down, names the attempt, and yields to needs-you", () => {
  assert.equal(retryCardDetail(61_000, 1, 1_000, 40), "retry 60s · 2/5")
  assert.equal(retryCardDetail(61_000, 3, 1_000, 40), "retry 60s · 4/5")
  assert.equal(retryCardDetail(1_500, 1, 1_500, 40), "retry due · r now")
  assert.equal(retryCardDetail(1_500, 1, 1_600, 17), "retry due · r now")
  assert.equal(retryCardDetail(undefined, 1, 1_000, 40), "retrying…")
  assert.ok(retryCardDetail(61_000, 1, 1_000, 15).length <= 15)
  const blocked = cardWithMotion(task({ state: "pending", attempts: 1, error: "boom", retryAfter: 61_000, interrupted: true }), "Nova", {
    now: 1_000,
    tick: 0,
    width: 40,
  })
  assert.equal(blocked.header.status, "NEEDS YOU")
  assert.equal(blocked.detail, "waiting for you…")
})

test("ticket115: needs-you cards carry the static marker and waiting detail", () => {
  const card = cardWithMotion(task({ interrupted: true }), "Nova", { now: 1000, tick: 3, width: 40 })
  assert.equal(card.header.glyph, NEEDS_YOU_MARK)
  assert.equal(card.header.status, "NEEDS YOU")
  assert.equal(card.detail, "waiting for you…")
  assert.equal(card.needsYou, true)
})

test("ticket115: card titles truncate to the content width instead of wrapping", () => {
  const longTitle = `t${"i".repeat(100)}`
  const card = cardWithMotion(task({ title: longTitle }), "Nova", { now: 1000, tick: 0, width: 20 })
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
  const cards = workCardsForTasks(items, () => "Nova", { now: 1000, width: 40 })
  assert.deepEqual(cards.map((card) => card.id), ["working-old", "working-new", "pending-old", "pending-new"])
})

test("ticket115: card detail defaults stay honest", () => {
  assert.equal(workCardDetail("working"), "working…")
  assert.equal(workCardDetail("pending"), "queued")
  assert.equal(workCardDetail("retrying"), "retrying…")
  assert.equal(workCardDetail("working", { activity: "running tests…" }), "running tests…")
  assert.equal(workCardDetail("working", { pending: "stop" }), "Stopping…")
  assert.equal(workCardDetail("pending", { needsYou: true }), "waiting for you…")
})

test("ticket136: terminal cards keep their final glyph, state word, and a flat settled strip", () => {
  const cases: Array<[Partial<Subtask>, string, string]> = [
    [{ state: "replied", outcome: "succeeded", finishedAt: 1_000, repliedAt: 1_000 }, "●", "replied"],
    [{ state: "replied", outcome: "failed", error: "boom", finishedAt: 1_000, repliedAt: 1_000 }, "✕", "failed"],
    [{ state: "replied", outcome: "succeeded", stoppedAt: 1_000, finishedAt: 1_000, repliedAt: 1_000 }, "⊘", "cancelled"],
  ]
  for (const [patch, glyph, state] of cases) {
    const card = cardWithMotion(task({ ...patch, title: `Old ${state}` }), "Nova", {
      now: 1_500,
      tick: 7,
      tideTick: 7,
      width: 40,
      variant: "travel",
      pendingFor: () => "stop",
      detailFor: () => "should not appear",
      pendingApprovalIDs: new Set(["ap"]),
    })
    assert.equal(card.terminal, true)
    assert.equal(card.needsYou, false, "a terminal card without a pending decision keeps its final state")
    assert.equal(card.detail, state, "terminal details ignore pending/activity callbacks")
    assert.equal(card.header.glyph, glyph)
    assert.equal(card.header.status, state.toUpperCase())
    assert.equal(card.tideVariant, "travel", "the active assignment carries into the terminal card")
    assert.ok(card.tideLevels.every((level) => level === 0), "terminal cards stay settled flat")
    assert.equal(card.tide, " ▁".repeat(20))
  }
  assert.equal(cardWithMotion(task({ state: "pending" }), "Nova", { now: 1_000, tick: 0, width: 40 }).terminal, false)
})

test("ticket136: a terminal card with a still-pending approval keeps the NEEDS YOU treatment", () => {
  const card = cardWithMotion(
    task({ state: "replied", outcome: "succeeded", approvalID: "ap", finishedAt: 1_000, repliedAt: 1_000 }),
    "Nova",
    { now: 1_500, tick: 2, width: 40, pendingApprovalIDs: new Set(["ap"]) },
  )
  assert.equal(card.terminal, true, "the card stays display-only")
  assert.equal(card.needsYou, true, "a terminal task with a pending decision still needs the user")
  assert.equal(card.header.status, "NEEDS YOU")
  assert.equal(card.header.glyph, NEEDS_YOU_MARK)
  assert.deepEqual(card.tones, { glyph: "warn", status: "warn", bar: "warn" })
  assert.equal(card.detail, "waiting for you…")
})

test("ticket68: a terminal card blocked by a native approval mirror also keeps NEEDS YOU", () => {
  const card = cardWithMotion(
    task({ state: "replied", outcome: "succeeded", finishedAt: 1_000, repliedAt: 1_000 }),
    "Nova",
    { now: 1_500, tick: 2, width: 40, nativeBlockedSubtaskIDs: new Set(["t"]) },
  )
  assert.equal(card.needsYou, true)
  assert.equal(card.header.status, "NEEDS YOU")
})

test("ticket116: a working card keeps its assigned variant and advances the strip", () => {
  const working = task({ state: "working", claimedBy: "run", leaseUntil: 9000, attempts: 1 })
  const first = cardWithMotion(working, "Nova", { now: 1000, tick: 3, width: 40, variant: "ripple" })
  const later = cardWithMotion(working, "Nova", { now: 1000, tick: 9, width: 40, variant: "ripple" })
  assert.equal(first.tideVariant, "ripple")
  assert.equal(later.tideVariant, "ripple")
  assert.equal(first.tide.length, 40)
  assert.notEqual(first.tide, later.tide, "working cards animate at the work tick")
})

test("ticket116: needs-you freezes the card's current variant", () => {
  const blocked = task({ state: "working", claimedBy: "run", leaseUntil: 9000, attempts: 1, interrupted: true })
  const first = cardWithMotion(blocked, "Nova", { now: 1000, tick: 3, width: 40, variant: "echo" })
  const later = cardWithMotion(blocked, "Nova", { now: 1000, tick: 9, width: 40, variant: "echo" })
  assert.equal(first.tideVariant, "echo")
  assert.equal(first.needsYou, true)
  assert.equal(first.tide, later.tide, "the strip does not advance while waiting for the user")
})

test("ticket116: needs-you keeps the tide frame from when the card blocked, not tick 0", () => {
  const blocked = task({ state: "working", claimedBy: "run", leaseUntil: 9000, attempts: 1, interrupted: true })
  const freezeState = createTideFreezeState()
  const atBlock = cardWithMotion(blocked, "Nova", { now: 1000, tick: 12, width: 40, variant: "echo", freezeState })
  const later = cardWithMotion(blocked, "Nova", { now: 2000, tick: 30, width: 40, variant: "echo", freezeState })
  assert.equal(atBlock.tide, later.tide, "the blocked card holds one frame")
  assert.notEqual(atBlock.tide, cardWithMotion(blocked, "Nova", { now: 1000, tick: 0, width: 40, variant: "echo" }).tide, "the freeze is not the deterministic tick-0 still")
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
  const render = () =>
    workCardsForTasks(items, () => "Nova", {
      now: 1000,
      width: 40,
      variantFor: (item) => assigned.get(item.id) ?? "current",
    })
  assert.deepEqual(render().map((card) => card.tideVariant), ["echo", "travel"])
  assert.deepEqual(render().map((card) => card.tideVariant), ["echo", "travel"])
})

test("ticket137: work-card tones reserve green for replied and state colors for the bar", () => {
  assert.deepEqual(workCardTones("pending", false), { glyph: "faint", status: "muted", bar: "faint" })
  assert.deepEqual(workCardTones("working", false), { glyph: "warn", status: "muted", bar: "warn" })
  assert.deepEqual(workCardTones("retrying", false), { glyph: "warn", status: "muted", bar: "warn" })
  assert.deepEqual(workCardTones("replied", false), { glyph: "good", status: "good", bar: "good" })
  assert.deepEqual(workCardTones("failed", false), { glyph: "bad", status: "bad", bar: "bad" })
  assert.deepEqual(workCardTones("cancelled", false), { glyph: "faint", status: "faint", bar: "faint" })
  assert.deepEqual(workCardTones("working", true), { glyph: "warn", status: "warn", bar: "warn" })
  assert.deepEqual(workCardTones("pending", true), { glyph: "warn", status: "warn", bar: "warn" })
})

test("ticket137: state words are uppercase and queued never reads as pending", () => {
  assert.equal(workCardStateWord("pending", false), "QUEUED")
  assert.equal(workCardStateWord("working", false), "WORKING")
  assert.equal(workCardStateWord("retrying", false), "RETRYING")
  assert.equal(workCardStateWord("replied", false), "REPLIED")
  assert.equal(workCardStateWord("failed", false), "FAILED")
  assert.equal(workCardStateWord("cancelled", false), "CANCELLED")
  assert.equal(workCardStateWord("working", true), "NEEDS YOU")
})

test("ticket137: the header is name, spacer, glyph, then the right-aligned status", () => {
  const header = workCardHeader("NOVA", "⠋", "WORKING", 19)
  assert.equal(header.name, "NOVA")
  assert.equal(header.glyph, "⠋")
  assert.equal(header.status, "WORKING")
  assert.equal(workCardHeaderText(header), "NOVA      ⠋ WORKING")
  assert.equal(workCardHeaderText(header).length, 19, "the status sits at the right edge")
  assert.ok(workCardHeaderText(header).endsWith("⠋ WORKING"))
})

test("ticket137: the name truncates first and the status never truncates", () => {
  const wide = workCardHeader("SIZEAGENT1", "⠋", "WORKING", 19)
  assert.equal(wide.name, "SIZEAGEN…")
  assert.equal(workCardHeaderText(wide), "SIZEAGEN… ⠋ WORKING")
  assert.ok(wide.name.endsWith("…"))

  const narrow = workCardHeader("SIZEAGENT1", "◆", "NEEDS YOU", 12)
  assert.equal(narrow.name, "", "the name yields before the status")
  assert.ok(workCardHeaderText(narrow).endsWith("◆ NEEDS YOU"))

  const impossible = workCardHeader("SIZEAGENT1", "◆", "NEEDS YOU", 6)
  assert.ok(workCardHeaderText(impossible).endsWith("◆ NEEDS YOU"), "the status word is never cut")
})

test("ticket137: card headers carry the state word, tones, and reduced-motion final glyphs", () => {
  const working = cardWithMotion(
    task({ state: "working", claimedBy: "run", leaseUntil: 9000, attempts: 1 }),
    "Nova",
    { now: 1000, tick: 9, width: 19, env: { ENSEMBLE_REDUCED_MOTION: "1" } },
  )
  assert.equal(working.header.name, "NOVA")
  assert.equal(working.header.glyph, "⠋")
  assert.equal(working.header.status, "WORKING")
  assert.deepEqual(working.tones, { glyph: "warn", status: "muted", bar: "warn" })

  const noColor = cardWithMotion(
    task({ state: "replied", outcome: "succeeded", finishedAt: 1000, repliedAt: 1000 }),
    "Nova",
    { now: 1500, tick: 9, width: 40, env: { NO_COLOR: "1" } },
  )
  assert.equal(noColor.header.glyph, "●")
  assert.equal(noColor.header.status, "REPLIED")
  assert.deepEqual(noColor.tones, { glyph: "good", status: "good", bar: "good" })

  const queued = cardWithMotion(task({ state: "pending" }), "Nova", { now: 1000, tick: 3, width: 40 })
  assert.equal(queued.header.status, "QUEUED")
  assert.equal(queued.tones.status, "muted")
  assert.equal(queued.tones.bar, "faint")

  const needsYou = cardWithMotion(task({ interrupted: true }), "Nova", { now: 1000, tick: 3, width: 40 })
  assert.equal(needsYou.header.glyph, NEEDS_YOU_MARK)
  assert.equal(needsYou.header.status, "NEEDS YOU")
  assert.deepEqual(needsYou.tones, { glyph: "warn", status: "warn", bar: "warn" })
})

test("ticket137: compact rows keep the name left, status right, and never truncate the status", () => {
  const row = workCompactRow("SizeAgent1", "fake-queue-hold", "▫", "WORKING", 38)
  assert.equal(row.name, "SizeAgent1")
  assert.equal(row.separator, " │ ")
  assert.equal(row.title, "fake-queue-hold")
  assert.equal(row.glyph, "▫")
  assert.equal(row.status, "WORKING")
  assert.equal(workCompactRowText(row), "SizeAgent1 │ fake-queue-hold ▫ WORKING")
  assert.equal(workCompactRowText(row).length, 38)

  const needsYou = workCompactRow("SizeAgent1", "a very long queued title", "◆", "NEEDS YOU", 28)
  assert.equal(needsYou.name, "SizeAgent1")
  assert.equal(workCompactRowText(needsYou).endsWith("◆ NEEDS YOU"), true, "the status word survives the tight row")
  assert.ok(needsYou.title.endsWith("…"), "the title truncates before the status")

  const narrow = workCompactRow("AReallyLongAgentName", "long title", "⠋", "RETRYING", 12)
  assert.equal(narrow.name.endsWith("…"), true)
  assert.equal(workCompactRowText(narrow).endsWith("⠋ RETRYING"), true)
})

test("ticket116: queued cards stay still and terminal cards settle flat", () => {
  const queued = cardWithMotion(task({ state: "pending" }), "Nova", { now: 1000, tick: 3, width: 40, variant: "travel" })
  const queuedLater = cardWithMotion(task({ state: "pending" }), "Nova", { now: 1000, tick: 9, width: 40, variant: "travel" })
  assert.equal(queued.tide, queuedLater.tide, "parked work never animates")

  for (const patch of [
    { state: "replied" as const, outcome: "succeeded" as const, repliedAt: 10, finishedAt: 10 },
    { state: "replied" as const, outcome: "failed" as const, repliedAt: 10, finishedAt: 10 },
    { state: "replied" as const, outcome: "succeeded" as const, repliedAt: 10, finishedAt: 10, stoppedAt: 10 },
  ]) {
    const card = cardWithMotion(task(patch), "Nova", { now: 2000, tick: 5, width: 40, variant: "inbound" })
    assert.ok(card.tideLevels.every((level) => level === 0), `${card.status} settles flat`)
    assert.equal(card.tide, " ▁".repeat(20))
  }
})

test("ticket142: static card data keeps identity across animation ticks", () => {
  const working = task({ state: "working", claimedBy: "run", leaseUntil: 9000, attempts: 1 })
  const cache = createWorkCardCache()
  const options = { now: 1000, width: 40, variant: "current" as const }
  const first = workCardForTaskCached(cache, working, "Nova", options)
  const frames = [0, 1, 2, 3].map((tick) => ({
    card: workCardForTaskCached(cache, working, "Nova", options),
    motion: workCardMotion(first, { tick, tideTick: tick, env: {} }),
  }))

  for (const frame of frames) assert.equal(frame.card, first, "the static card object is reused across ticks")
  assert.equal(frames[0].card.title, "Check the build")
  assert.equal(frames[0].card.detail, "working…")
  assert.equal(frames[0].card.header.name, "NOVA")
  assert.equal(frames[0].card.header.status, "WORKING")
  assert.deepEqual(frames[0].card.tones, { glyph: "warn", status: "muted", bar: "warn" })
  assert.equal(frames[0].card.tideVariant, "current")
  assert.equal(new Set(frames.map((frame) => frame.motion.tide)).size > 1, true, "the tide still animates")
  assert.equal(new Set(frames.map((frame) => frame.motion.glyph)).size > 1, true, "the glyph still animates")
  assert.equal("tide" in first, false, "identity data carries no animated strip")
  assert.equal("glyph" in first.header, false, "identity data carries no animated glyph")
})

test("ticket142: static cards rebuild only when the task, approval, or layout changes", () => {
  const cache = createWorkCardCache()
  const base = { now: 1000, width: 40, variant: "ripple" as const }
  const working = task({ state: "working", claimedBy: "run", leaseUntil: 9000, attempts: 1 })
  const card = workCardForTaskCached(cache, working, "Nova", base)

  assert.equal(workCardForTaskCached(cache, working, "Nova", { ...base }), card, "an identical poll reuses the card")

  const finished = task({
    ...working,
    state: "replied",
    outcome: "succeeded",
    repliedAt: 1000,
    finishedAt: 1000,
  })
  const replied = workCardForTaskCached(cache, finished, "Nova", base)
  assert.notEqual(replied, card, "a task transition rebuilds the card")
  assert.equal(replied.header.status, "REPLIED")

  const gated = task({ ...working, approvalID: "ap" })
  const blocked = workCardForTaskCached(cache, gated, "Nova", {
    ...base,
    pendingApprovalIDs: new Set(["ap"]),
  })
  assert.notEqual(blocked, card, "a pending approval rebuilds needs-you data")
  assert.equal(blocked.needsYou, true)
  assert.equal(blocked.header.status, "NEEDS YOU")

  const narrow = workCardForTaskCached(cache, working, "Nova", { ...base, width: 20 })
  assert.notEqual(narrow, card, "a width change rebuilds the truncated layout")
  assert.notEqual(narrow.header.gap, card.header.gap)

  const renamed = workCardForTaskCached(cache, working, "Sage", base)
  assert.notEqual(renamed, card, "an agent label change rebuilds the header")

  const active = workCardForTaskCached(cache, working, "Nova", {
    ...base,
    detailFor: () => "running tests…",
  })
  assert.notEqual(active, card, "an activity detail change rebuilds the detail line")
  assert.equal(active.detail, "running tests…")

  const variant = workCardForTaskCached(cache, working, "Nova", { ...base, variant: "travel" })
  assert.notEqual(variant, card, "a tide variant change rebuilds the static variant")
  assert.equal(variant.tideVariant, "travel")
})

test("ticket142: only the glyph and tide cells read their animation clocks", () => {
  const working = task({ state: "working", claimedBy: "run", leaseUntil: 9000, attempts: 1 })
  const card = workCardForTask(working, "Nova", { now: 1000, width: 40, variant: "current" })
  const base = workCardMotion(card, { tick: 1, tideTick: 3, env: {} })
  const glyphTick = workCardMotion(card, { tick: 2, tideTick: 3, env: {} })
  const tideTick = workCardMotion(card, { tick: 1, tideTick: 4, env: {} })

  assert.notEqual(glyphTick.glyph, base.glyph, "the glyph advances on the 8 fps tick")
  assert.equal(glyphTick.tide, base.tide, "the 8 fps tick does not rebuild the tide")
  assert.equal(tideTick.glyph, base.glyph, "the 15 fps tick does not rebuild the glyph")
  assert.notEqual(tideTick.tide, base.tide, "the tide advances on the 15 fps tick")
  assert.equal(workCardGlyph(card, 1, {}), "⠙")
  assert.equal(workCardTide(card, { tideTick: 3, env: {} }).tide, base.tide)
})

test("ticket142: reduced motion pins the glyph and tide to frame zero", () => {
  const working = task({ state: "working", claimedBy: "run", leaseUntil: 9000, attempts: 1 })
  const card = workCardForTask(working, "Nova", { now: 1000, width: 40, variant: "current" })
  const still = workCardMotion(card, { tick: 0, tideTick: 0, env: {} })
  const reduced = workCardMotion(card, { tick: 9, tideTick: 9, env: { ENSEMBLE_REDUCED_MOTION: "1" } })

  assert.equal(reduced.glyph, still.glyph)
  assert.equal(reduced.glyph, "⠋")
  assert.equal(reduced.tide, still.tide)
  assert.deepEqual(reduced.tideLevels, still.tideLevels)
})
