import test from "node:test"
import assert from "node:assert/strict"
import type { Subtask } from "../types.ts"
import {
  nextWorkInvalidation,
  workGroupCounts,
  workGroupLabel,
  workGroupsForTasks,
  workHistoryRollupLabel,
} from "./workgroups.ts"
import { paginateWorkGroups, workViewGroups } from "./workpane.ts"

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

const record = (...tasks: Subtask[]): Record<string, Subtask> =>
  Object.fromEntries(tasks.map((item) => [item.id, item]))

const working = (patch: Partial<Subtask> = {}): Subtask =>
  task({ state: "working", claimedBy: "run", leaseUntil: 99_000, attempts: 1, ...patch })

const replied = (patch: Partial<Subtask> = {}): Subtask =>
  task({ state: "replied", outcome: "succeeded", finishedAt: 1_000, repliedAt: 1_000, ...patch })

const failed = (patch: Partial<Subtask> = {}): Subtask =>
  task({ state: "replied", outcome: "failed", error: "boom", finishedAt: 1_000, repliedAt: 1_000, ...patch })

const cancelled = (patch: Partial<Subtask> = {}): Subtask =>
  task({ state: "replied", outcome: "failed", stoppedAt: 1_000, error: "Cancelled by user.", finishedAt: 1_000, repliedAt: 1_000, ...patch })

test("ticket136: one command fan-out is one group and stays visible while any member is active", () => {
  const items = [
    working({ id: "a", dispatchGroupID: "dispatch_1", createdAt: 1 }),
    replied({ id: "b", dispatchGroupID: "dispatch_1", createdAt: 2 }),
  ]
  const groups = workGroupsForTasks(items, record(...items), { now: 5_000 })
  assert.equal(groups.length, 1)
  assert.equal(groups[0].id, "dispatch_1")
  assert.equal(groups[0].active, 1)
  assert.equal(groups[0].done, 1)
  assert.equal(groups[0].complete, false)
  assert.deepEqual(groups[0].tasks.map((item) => item.id), ["a", "b"], "active members render before terminal members")
})

test("ticket136: a complete group holds for 1.2 seconds from its latest terminal timestamp", () => {
  const items = [
    replied({ id: "a", dispatchGroupID: "dispatch_1", finishedAt: 1_000, repliedAt: 1_000 }),
    failed({ id: "b", dispatchGroupID: "dispatch_1", finishedAt: 1_400, repliedAt: 1_400 }),
  ]
  const subtasks = record(...items)
  assert.equal(workGroupsForTasks(items, subtasks, { now: 2_599 }).length, 1, "visible just before the hold closes")
  assert.equal(workGroupsForTasks(items, subtasks, { now: 2_600 }).length, 0, "the group clears as one unit at the boundary")
})

test("ticket136: reload during the hold reconstructs the remaining time from timestamps", () => {
  const items = [
    replied({ id: "a", dispatchGroupID: "dispatch_1", finishedAt: 10_000, repliedAt: 10_000 }),
    failed({ id: "b", dispatchGroupID: "dispatch_1", finishedAt: 11_000, repliedAt: 11_000 }),
  ]
  const subtasks = record(...items)
  const reloaded = workGroupsForTasks(items, subtasks, { now: 12_000 })
  assert.equal(reloaded.length, 1, "a fresh process sees the group and derives the remaining hold")
  assert.equal(reloaded[0].latestTerminalAt, 11_000)
  assert.equal(workGroupsForTasks(items, subtasks, { now: 12_200 }).length, 0)
})

test("ticket136: failed and cancelled members remain until their group completes", () => {
  const items = [
    working({ id: "live", dispatchGroupID: "dispatch_1" }),
    failed({ id: "bad", dispatchGroupID: "dispatch_1" }),
    cancelled({ id: "stopped", dispatchGroupID: "dispatch_1" }),
  ]
  const groups = workGroupsForTasks(items, record(...items), { now: 9_999_999 })
  assert.equal(groups.length, 1)
  assert.equal(groups[0].active, 1)
  assert.equal(groups[0].done, 2)
  assert.deepEqual(groups[0].tasks.map((item) => item.id), ["live", "bad", "stopped"])
})

test("ticket136: a needs-you member keeps a complete group visible after the hold, then completes after its decision", () => {
  const items = [
    replied({ id: "done", dispatchGroupID: "dispatch_1", finishedAt: 1_000, repliedAt: 1_000 }),
    replied({ id: "gated", dispatchGroupID: "dispatch_1", approvalID: "ap", finishedAt: 1_000, repliedAt: 1_000 }),
  ]
  const subtasks = record(...items)
  const blocked = workGroupsForTasks(items, subtasks, { now: 9_999_999, pendingApprovalIDs: new Set(["ap"]) })
  assert.equal(blocked.length, 1, "no timer hides a pending decision")
  assert.equal(blocked[0].needsYou, true)
  assert.equal(blocked[0].complete, false)
  // Review fix: the last approval resolution starts a fresh shared hold, so
  // the final task states stay perceptible instead of clearing instantly.
  const resolvedAtForTask = (item: Subtask) => (item.approvalID === "ap" ? 9_999_999 : undefined)
  const holding = workGroupsForTasks(items, subtasks, { now: 10_000_500, resolvedAtForTask })
  assert.equal(holding.length, 1, "the group holds after the last decision")
  assert.equal(holding[0].needsYou, false)
  assert.equal(holding[0].latestTerminalAt, 9_999_999, "the hold origin is the resolution time")
  const resolved = workGroupsForTasks(items, subtasks, { now: 10_001_200, resolvedAtForTask })
  assert.equal(resolved.length, 0, "the group completes normally after the shared hold")
})

test("ticket136: a second command appends a group; the first clears without disturbing it", () => {
  const items = [
    replied({ id: "first", dispatchGroupID: "dispatch_1", finishedAt: 1_000, repliedAt: 1_000 }),
    working({ id: "second", dispatchGroupID: "dispatch_2", createdAt: 2_000 }),
  ]
  const subtasks = record(...items)
  const both = workGroupsForTasks(items, subtasks, { now: 2_100 })
  assert.deepEqual(both.map((group) => group.id), ["dispatch_1", "dispatch_2"], "rendering stays chronological")
  const afterHold = workGroupsForTasks(items, subtasks, { now: 2_200 })
  assert.deepEqual(afterHold.map((group) => group.id), ["dispatch_2"])
  assert.equal(afterHold[0].active, 1)
})

test("ticket136: legacy tasks derive one sensible root group", () => {
  const root = task({ id: "root", createdAt: 1 })
  const child = working({ id: "child", parentID: "root", createdAt: 2 })
  const sibling = replied({ id: "sibling", parentID: "root", createdAt: 3 })
  const items = [root, child, sibling]
  const groups = workGroupsForTasks(items, record(...items), { now: 9_999_999 })
  assert.equal(groups.length, 1)
  assert.match(groups[0].id, /^dispatch_legacy_/)
})

test("ticket136: retried work reopens its existing group instead of minting a new one", () => {
  const items = [
    replied({ id: "settled", dispatchGroupID: "dispatch_1", finishedAt: 1_000, repliedAt: 1_000 }),
    task({ id: "retried", dispatchGroupID: "dispatch_1", state: "pending", outcome: "pending", createdAt: 2 }),
  ]
  const groups = workGroupsForTasks(items, record(...items), { now: 9_999_999 })
  assert.equal(groups.length, 1)
  assert.equal(groups[0].id, "dispatch_1")
  assert.equal(groups[0].active, 1)
  assert.equal(groups[0].done, 1)
})

test("ticket136: group counts name groups, active, and done instead of recent", () => {
  const counts = workGroupCounts([
    { id: "g1", active: 2, done: 1 },
    { id: "g2", active: 0, done: 3 },
  ] as any)
  assert.deepEqual(counts, { groups: 2, active: 2, done: 4 })
})

test("ticket160: a group carries its ledger budget into the label", () => {
  const items = [
    working({ id: "a", dispatchGroupID: "dispatch_1", createdAt: 1 }),
    replied({ id: "b", dispatchGroupID: "dispatch_1", createdAt: 2 }),
  ]
  const ledger = {
    dispatch_1: {
      id: "dispatch_1",
      workspaceID: "w",
      rootID: "dispatch_1",
      continuationIndex: 0,
      maxHops: 8,
      usedHops: 3,
      depthMax: 8,
      commandMaxHops: 24,
      commandUsedHops: 3,
      maxContinuations: 2,
      continuationsUsed: 0,
      createdAt: 1,
    },
  }
  const groups = workGroupsForTasks(items, record(...items), { now: 5_000, dispatchGroups: ledger })
  assert.deepEqual(groups[0].budget, { usedHops: 3, maxHops: 8, commandRemaining: 21, commandMaxHops: 24 })
  assert.equal(workGroupLabel(groups[0], 1), "GROUP 1 · 1 active · 1 done · hops 3/8 · cmd 21 left")
  const without = workGroupsForTasks(items, record(...items), { now: 5_000 })
  assert.equal(without[0].budget, undefined)
  assert.equal(workGroupLabel(without[0], 1), "GROUP 1 · 1 active · 1 done")
})

test("ticket136: group labels appear only when more than one group is visible", () => {
  const group = { id: "g1", active: 2, done: 1 } as any
  assert.equal(workGroupLabel(group, 1), "GROUP 1 · 2 active · 1 done")
  assert.equal(workGroupLabel(group, 2), "GROUP 2 · 2 active · 1 done")
})

test("ticket184: a history row names done, active when relevant, and the age", () => {
  const items = [
    working({ id: "live", dispatchGroupID: "dispatch_1", createdAt: 1 }),
    replied({ id: "done", dispatchGroupID: "dispatch_1", createdAt: 2, finishedAt: 1_000, repliedAt: 1_000 }),
  ]
  const groups = workGroupsForTasks(items, record(...items), { now: 6_000, holdMs: 60_000 })
  assert.equal(workHistoryRollupLabel(groups[0], 1, "5s"), "GROUP 1 · 1 done · 1 active · 5s")
  const finished = replied({ id: "done", dispatchGroupID: "dispatch_1", finishedAt: 1_000, repliedAt: 1_000 })
  const doneOnly = workGroupsForTasks(
    [finished],
    record(finished),
    { now: 3_601_000, holdMs: 4_000_000 },
  )
  assert.equal(workHistoryRollupLabel(doneOnly[0], 2, "1h"), "GROUP 2 · 1 done · 1h", "an inactive group omits the active count")
})

test("ticket142: Work invalidation targets status and group-hold expiry without an animation clock", () => {
  const soon = working({ id: "soon", leaseUntil: 6_000 })
  const deadline = task({ id: "deadline", deadlineAt: 7_000 })
  const done = replied({ id: "done", finishedAt: 2_000, repliedAt: 2_000 })
  const items = [soon, deadline, done]
  const groups = workGroupsForTasks(items, record(...items), { now: 1_500 })

  assert.equal(nextWorkInvalidation(items, groups, 1_500), 3_200, "the shared group hold closes first")
  assert.equal(nextWorkInvalidation(items, groups, 3_200), 6_000, "then the working lease expires")
  assert.equal(nextWorkInvalidation([soon, deadline], [], 5_000), 6_000)
  assert.equal(nextWorkInvalidation([deadline], [], 7_000), undefined, "an expired deadline needs no reschedule")
  assert.equal(
    nextWorkInvalidation([replied({ id: "late" })], [], 5_000),
    undefined,
    "terminal work with no visible hold needs no timer",
  )
})

test("ticket144: a retry countdown refreshes every second and stops at the ETA", () => {
  const retrying = task({ id: "retry", state: "pending", attempts: 1, error: "boom", retryAfter: 5_500 })
  assert.equal(nextWorkInvalidation([retrying], [], 1_500), 2_500, "the next second boundary comes first")
  assert.equal(nextWorkInvalidation([retrying], [], 5_000), 5_500, "the ETA comes before the next second")
  assert.equal(nextWorkInvalidation([retrying], [], 6_000), 7_000, "a due retry keeps refreshing until claimed")
})

test("ticket162: Work shows continuation lineage and exhausted groups as a controlled stop", () => {
  const items = [
    working({ id: "root-live", dispatchGroupID: "dispatch_root", createdAt: 1 }),
    working({ id: "cont-live", dispatchGroupID: "dispatch_cont", createdAt: 2 }),
  ]
  const ledger = {
    dispatch_root: {
      id: "dispatch_root",
      workspaceID: "w",
      rootID: "dispatch_root",
      continuationIndex: 0,
      maxHops: 8,
      usedHops: 8,
      depthMax: 8,
      commandMaxHops: 24,
      commandUsedHops: 8,
      maxContinuations: 2,
      continuationsUsed: 1,
      createdAt: 1,
      closedAt: 10,
      closeReason: "continued" as const,
    },
    dispatch_cont: {
      id: "dispatch_cont",
      workspaceID: "w",
      rootID: "dispatch_root",
      parentID: "dispatch_root",
      continuationIndex: 1,
      maxHops: 8,
      usedHops: 3,
      depthMax: 8,
      createdAt: 2,
    },
  }
  const groups = workGroupsForTasks(items, record(...items), { now: 5_000, dispatchGroups: ledger })
  assert.equal(groups.length, 2)
  assert.equal(groups[0].state, "closed")
  assert.equal(groups[0].exhausted, true)
  assert.equal(groups[0].closeReason, "continued")
  assert.equal(groups[0].continuationIndex, 0)
  assert.equal(groups[0].rootID, "dispatch_root")
  assert.equal(groups[1].state, "active")
  assert.equal(groups[1].exhausted, false)
  assert.equal(groups[1].continuationIndex, 1)
  assert.equal(groups[1].parentContinuationIndex, 0)
  assert.equal(groups[1].parentID, "dispatch_root")
  assert.equal(groups[1].rootID, "dispatch_root")
  assert.equal(
    workGroupLabel(groups[0]!, 1),
    "GROUP 1 · EXHAUSTED · CONTINUED · 1 active · 0 done · hops 8/8 · cmd 16 left",
  )
  assert.equal(
    workGroupLabel(groups[1]!, 2),
    "GROUP 2 · CONT 1 · from root · 1 active · 0 done · hops 3/8 · cmd 16 left",
  )

  const compact = paginateWorkGroups(groups, 40, 28, 5_000)
  assert.equal(compact.mode, "compact")
  const compactSections = compact.pages.flatMap((page) => page.sections)
  assert.deepEqual(compactSections.map((section) => section.label), [workGroupLabel(groups[0]!, 1), workGroupLabel(groups[1]!, 2)])
  assert.deepEqual(compactSections.map((section) => section.tone), ["warn", "faint"], "exhaustion is a warning stop, not failure")

  const cards = paginateWorkGroups(groups, 76, 40, 5_000)
  assert.equal(cards.mode, "cards")
  const cardSections = cards.pages.flatMap((page) => page.sections)
  assert.ok(cardSections.every((section) => section.label !== null), "both groups label their lineage")
  assert.ok(cardSections.some((section) => (section.label ?? "").includes("EXHAUSTED")))
  assert.ok(cardSections.some((section) => (section.label ?? "").includes("CONT 1 · from root")))
})

test("ticket162: a just-exhausted group reads as a stop, not a failure", () => {
  const items = [working({ id: "spent-live", dispatchGroupID: "dispatch_spent", createdAt: 1 })]
  const ledger = {
    dispatch_spent: {
      id: "dispatch_spent",
      workspaceID: "w",
      rootID: "dispatch_spent",
      continuationIndex: 0,
      maxHops: 8,
      usedHops: 8,
      depthMax: 8,
      commandMaxHops: 24,
      commandUsedHops: 8,
      maxContinuations: 2,
      continuationsUsed: 0,
      createdAt: 1,
    },
  }
  const groups = workGroupsForTasks(items, record(...items), { now: 5_000, dispatchGroups: ledger })
  assert.equal(groups[0]?.state, "exhausted")
  assert.equal(groups[0]?.exhausted, true)
  const label = workGroupLabel(groups[0]!, 1)
  assert.match(label, /EXHAUSTED/)
  assert.doesNotMatch(label, /CONTINUED/)
  assert.doesNotMatch(label, /FAILED/)
  const compact = paginateWorkGroups(groups, 40, 24, 5_000)
  assert.equal(compact.pages[0]?.sections[0]?.tone, "warn")
  assert.ok((compact.pages[0]?.sections[0]?.label ?? "").includes("EXHAUSTED"), "a lone exhausted group still names its controlled stop")
})

test("ticket170: non-terminal cards never start the completion hold", () => {
  const stalled = (patch: Partial<Subtask> = {}): Subtask =>
    task({
      state: "replied",
      outcome: "failed",
      attempts: 5,
      failure: { kind: "attempts", reason: "attempts-exhausted" },
      finishedAt: 1_000,
      repliedAt: 1_000,
      ...patch,
    })
  const items = [
    task({ id: "queued", dispatchGroupID: "dispatch_1", createdAt: 1 }),
    working({ id: "live", dispatchGroupID: "dispatch_1", deadlineAt: 1, leaseUntil: 10_000_000 }),
    task({ id: "waiting", dispatchGroupID: "dispatch_1", state: "working", awaitingChildren: true, attempts: 1 }),
    task({ id: "retrying", dispatchGroupID: "dispatch_1", state: "pending", attempts: 1, retryAfter: 9_500_000 }),
    task({ id: "needs-you", dispatchGroupID: "dispatch_1", interrupted: true }),
    stalled({ id: "stalled", dispatchGroupID: "dispatch_1" }),
  ]
  const groups = workGroupsForTasks(items, record(...items), { now: 9_999_999 })
  assert.equal(groups.length, 1, "the whole group stays mounted")
  assert.equal(groups[0]?.active, 6)
  assert.equal(groups[0]?.done, 0)
  assert.equal(groups[0]?.complete, false, "a non-terminal member never starts the hold")
  assert.equal(groups[0]?.latestTerminalAt, undefined)
})

test("ticket170: a live lease stays mounted past the old delivery deadline", () => {
  const live = working({ id: "live", dispatchGroupID: "dispatch_1", deadlineAt: 1, leaseUntil: 9_000_000 })
  const items = [live]
  const subtasks = record(live)
  const early = workGroupsForTasks(items, subtasks, { now: 100_000 })
  const late = workGroupsForTasks(items, subtasks, { now: 8_999_999 })
  assert.equal(early.length, 1)
  assert.equal(late.length, 1, "a heartbeat lease outlives the delivery window")
  assert.equal(late[0]?.active, 1)
  assert.equal(late[0]?.complete, false)
})

test("ticket170: a stalled card stays mounted until retry, cancel, or dismissal", () => {
  const stalledTask = task({
    id: "t",
    dispatchGroupID: "dispatch_1",
    state: "replied",
    outcome: "failed",
    attempts: 5,
    failure: { kind: "attempts", reason: "attempts-exhausted" },
    finishedAt: 1_000,
    repliedAt: 1_000,
    createdAt: 1,
  })
  const atStall = workGroupsForTasks([stalledTask], record(stalledTask), { now: 1_000_000 })
  assert.equal(atStall.length, 1, "the stalled card is not discarded by the completion hold")
  assert.equal(atStall[0]?.active, 1)
  assert.equal(atStall[0]?.complete, false)
  const retried = task({ ...stalledTask, state: "pending", outcome: "pending", attempts: 0, failure: undefined, retryAfter: undefined })
  const afterRetry = workGroupsForTasks([retried], record(retried), { now: 1_000_000 })
  assert.equal(afterRetry.length, 1)
  assert.equal(afterRetry[0]?.active, 1, "an explicit retry reopens the same card")
  const cancelled = task({ ...stalledTask, stoppedAt: 1_000_001, finishedAt: 1_000_001, repliedAt: 1_000_001, error: "Cancelled by user." })
  const holding = workGroupsForTasks([cancelled], record(cancelled), { now: 1_000_600 })
  assert.equal(holding.length, 1, "an explicit cancel still holds briefly before history")
  assert.equal(workGroupsForTasks([cancelled], record(cancelled), { now: 1_002_201 }).length, 0)
})

test("ticket170: a stalled member keeps an otherwise complete group mounted past the hold", () => {
  const items = [
    replied({ id: "done", dispatchGroupID: "dispatch_1", finishedAt: 1_000, repliedAt: 1_000 }),
    task({
      id: "stalled",
      dispatchGroupID: "dispatch_1",
      state: "replied",
      outcome: "failed",
      attempts: 5,
      failure: { kind: "delivery", reason: "deadline-exceeded" },
      finishedAt: 1_000,
      repliedAt: 1_000,
    }),
  ]
  const groups = workGroupsForTasks(items, record(...items), { now: 9_999_999 })
  assert.equal(groups.length, 1)
  assert.equal(groups[0]?.active, 1)
  assert.equal(groups[0]?.done, 1)
  assert.equal(groups[0]?.complete, false, "a terminal sibling cannot start the hold while a stall is live")
})

test("ticket170: pending and stalled cards schedule no completion timer", () => {
  const queued = task({ id: "queued", retryAfter: undefined })
  const stalled = task({
    id: "stalled",
    state: "replied",
    outcome: "failed",
    attempts: 5,
    failure: { kind: "attempts", reason: "attempts-exhausted" },
  })
  assert.equal(nextWorkInvalidation([queued, stalled], [], 1_000), undefined)
  const live = working({ id: "live", leaseUntil: 6_000 })
  assert.equal(nextWorkInvalidation([live], [], 1_000), 6_000)
})

test("ticket170: stalled cards are selectable and use the warning tone", () => {
  const stalled = task({
    id: "stalled",
    dispatchGroupID: "dispatch_1",
    state: "replied",
    outcome: "failed",
    attempts: 5,
    failure: { kind: "lease", reason: "lease-expired" },
  })
  const waiting = task({ id: "waiting", dispatchGroupID: "dispatch_2", state: "working", awaitingChildren: true, attempts: 1 })
  const items = [stalled, waiting]
  const views = workViewGroups(items, record(...items), { now: 5_000 })
  const layout = paginateWorkGroups(views.active, 120, 40, 5_000)
  assert.deepEqual(layout.tasks.map((item) => item.id).sort(), ["stalled", "waiting"], "retry/cancel targets include stalls")
  assert.deepEqual(layout.pages.flatMap((page) => page.sections).map((section) => section.tone), ["warn", "faint"], "a stall is a queue warning, not FAILED")
})
