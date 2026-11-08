import test from "node:test"
import assert from "node:assert/strict"
import type { Subtask } from "../types.ts"
import {
  nextWorkInvalidation,
  workGroupCounts,
  workGroupLabel,
  workGroupLayout,
  workGroupsForTasks,
  workSummaryCounts,
} from "./workgroups.ts"

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

test("ticket136: header counts name groups, active, and done instead of recent", () => {
  assert.equal(workSummaryCounts(0, 0, 0), "WORK │ none yet")
  assert.equal(workSummaryCounts(1, 3, 0), "WORK 1 group · 3 active · 0 done")
  assert.equal(workSummaryCounts(2, 1, 4), "WORK 2 groups · 1 active · 4 done")
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
  assert.equal(workGroupLabel(groups[0], 1), "GROUP 1 · hops 3/8 · cmd 21 left · 1 active · 1 done")
  const without = workGroupsForTasks(items, record(...items), { now: 5_000 })
  assert.equal(without[0].budget, undefined)
  assert.equal(workGroupLabel(without[0], 1), "GROUP 1 · 1 active · 1 done")
})

test("ticket136: group labels appear only when more than one group is visible", () => {
  const group = { id: "g1", active: 2, done: 1 } as any
  assert.equal(workGroupLabel(group, 1), "GROUP 1 · 2 active · 1 done")
  assert.equal(workGroupLabel(group, 2), "GROUP 2 · 2 active · 1 done")
})

test("ticket136: two groups each get one card row at 120x40 and render chronologically", () => {
  const items = [
    working({ id: "a1", dispatchGroupID: "dispatch_1", assigneeID: "a", createdAt: 1 }),
    working({ id: "a2", dispatchGroupID: "dispatch_1", assigneeID: "b", createdAt: 2 }),
    working({ id: "a3", dispatchGroupID: "dispatch_1", assigneeID: "c", createdAt: 3 }),
    working({ id: "b1", dispatchGroupID: "dispatch_2", assigneeID: "a", createdAt: 4 }),
    working({ id: "b2", dispatchGroupID: "dispatch_2", assigneeID: "b", createdAt: 5 }),
    working({ id: "b3", dispatchGroupID: "dispatch_2", assigneeID: "c", createdAt: 6 }),
  ]
  const groups = workGroupsForTasks(items, record(...items), { now: 5_000 })
  const layout = workGroupLayout(groups, 76, 40)
  assert.equal(layout.mode, "cards")
  assert.equal(layout.columns, 3)
  assert.equal(layout.sections.length, 2)
  assert.deepEqual(layout.sections.map((section) => section.mode), ["cards", "cards"])
  assert.deepEqual(layout.sections.map((section) => section.label), [
    "GROUP 1 · 3 active · 0 done",
    "GROUP 2 · 3 active · 0 done",
  ])
  assert.deepEqual(layout.sections.map((section) => section.tasks.map((item) => item.id)), [
    ["a1", "a2", "a3"],
    ["b1", "b2", "b3"],
  ])
  assert.equal(layout.hiddenGroups, 0)
  assert.equal(layout.height, 17, "header + hints + two labeled card rows + one gap")
  assert.deepEqual(layout.selectableTasks.map((item) => item.id), ["a1", "a2", "a3", "b1", "b2", "b3"])
})

test("ticket136: newest-group priority gives a constrained 100x30 the new cards and summarizes the old group", () => {
  const items = [
    working({ id: "a1", dispatchGroupID: "dispatch_1", createdAt: 1 }),
    working({ id: "a2", dispatchGroupID: "dispatch_1", createdAt: 2 }),
    working({ id: "a3", dispatchGroupID: "dispatch_1", createdAt: 3 }),
    working({ id: "b1", dispatchGroupID: "dispatch_2", createdAt: 4 }),
  ]
  const groups = workGroupsForTasks(items, record(...items), { now: 5_000 })
  const layout = workGroupLayout(groups, 60, 30)
  assert.equal(layout.mode, "cards")
  assert.equal(layout.columns, 2)
  assert.deepEqual(layout.sections.map((section) => section.mode), ["summary", "cards"])
  assert.equal(layout.sections[0].label, "GROUP 1 · 3 active · 0 done")
  assert.equal(layout.sections[0].tasks.length, 0)
  assert.equal(layout.sections[1].label, "GROUP 2 · 1 active · 0 done")
  assert.deepEqual(layout.sections[1].tasks.map((item) => item.id), ["b1"])
  assert.deepEqual(layout.selectableTasks.map((item) => item.id), ["b1"], "older summarized work never owns the cursor")
  assert.ok(layout.height + 13 + 4 <= 30, "the constrained layout keeps transcript reserve")
})

test("ticket136: card mode supports two card groups; older groups become compact group rows", () => {
  const items = [
    working({ id: "a1", dispatchGroupID: "dispatch_1", createdAt: 1 }),
    working({ id: "b1", dispatchGroupID: "dispatch_2", createdAt: 2 }),
    working({ id: "c1", dispatchGroupID: "dispatch_3", createdAt: 3 }),
  ]
  const groups = workGroupsForTasks(items, record(...items), { now: 5_000 })
  const layout = workGroupLayout(groups, 76, 40)
  assert.equal(layout.mode, "cards")
  assert.deepEqual(layout.sections.map((section) => section.mode), ["summary", "cards", "cards"])
  assert.equal(layout.sections[0].label, "GROUP 1 · 1 active · 0 done")
  assert.deepEqual(layout.selectableTasks.map((item) => item.id), ["b1", "c1"])
})

test("ticket136: compact mode keeps the newest group's active rows and summarizes older groups", () => {
  const items = [
    working({ id: "a1", dispatchGroupID: "dispatch_1", createdAt: 1 }),
    working({ id: "a2", dispatchGroupID: "dispatch_1", createdAt: 2 }),
    working({ id: "a3", dispatchGroupID: "dispatch_1", createdAt: 3 }),
    working({ id: "b1", dispatchGroupID: "dispatch_2", createdAt: 4 }),
  ]
  const groups = workGroupsForTasks(items, record(...items), { now: 5_000 })
  const layout = workGroupLayout(groups, 40, 24)
  assert.equal(layout.mode, "compact")
  assert.equal(layout.columns, 0)
  assert.deepEqual(layout.sections.map((section) => section.mode), ["summary", "rows"])
  assert.equal(layout.sections[0].label, "GROUP 1 · 3 active · 0 done")
  assert.equal(layout.sections[1].label, "GROUP 2 · 1 active · 0 done")
  assert.deepEqual(layout.selectableTasks.map((item) => item.id), ["b1"])
  assert.equal(layout.height, 4, "header + old group label + newest label + newest row")
})

test("ticket136: compact complete hold groups summarize by count instead of occupying task rows", () => {
  const items = [
    replied({ id: "new-done", dispatchGroupID: "dispatch_2", createdAt: 2, finishedAt: 4_900, repliedAt: 4_900 }),
    working({ id: "old-live", dispatchGroupID: "dispatch_1", createdAt: 1 }),
  ]
  const groups = workGroupsForTasks(items, record(...items), { now: 5_000 })
  assert.deepEqual(groups.map((group) => group.id), ["dispatch_1", "dispatch_2"])
  const layout = workGroupLayout(groups, 40, 24)
  assert.equal(layout.mode, "compact")
  assert.deepEqual(layout.sections.map((section) => section.mode), ["rows", "summary"])
  assert.deepEqual(layout.selectableTasks.map((item) => item.id), ["old-live"], "hold rows never take the cursor or the newest task budget")
})

test("ticket136: a single complete hold group summarizes in the header without claiming a hidden group", () => {
  const items = [replied({ id: "done", dispatchGroupID: "dispatch_1", finishedAt: 4_900, repliedAt: 4_900 })]
  const groups = workGroupsForTasks(items, record(...items), { now: 5_000 })
  const layout = workGroupLayout(groups, 40, 24)
  assert.equal(layout.sections.length, 0)
  assert.equal(layout.hiddenGroups, 0)
  assert.equal(layout.selectableTasks.length, 0)
  assert.equal(layout.height, 1)
})

test("ticket136: compact single-group overflow stays in the header and the visible active prefix is selectable", () => {
  const items = [
    working({ id: "a1", dispatchGroupID: "dispatch_1", createdAt: 1 }),
    working({ id: "a2", dispatchGroupID: "dispatch_1", createdAt: 2 }),
    working({ id: "a3", dispatchGroupID: "dispatch_1", createdAt: 3 }),
  ]
  const groups = workGroupsForTasks(items, record(...items), { now: 5_000 })
  const layout = workGroupLayout(groups, 40, 24)
  assert.equal(layout.mode, "compact")
  assert.equal(layout.sections.length, 1)
  assert.equal(layout.sections[0].label, null, "a single group needs no label")
  assert.deepEqual(layout.sections[0].tasks.map((item) => item.id), ["a1"])
  assert.equal(layout.overflow, 2)
  assert.deepEqual(layout.selectableTasks.map((item) => item.id), ["a1"])
  assert.equal(layout.height, 2)
})

test("ticket136: terminal cards are display-only and overflow is never selectable", () => {
  const items = [
    working({ id: "live-1", dispatchGroupID: "dispatch_1", createdAt: 1 }),
    replied({ id: "done", dispatchGroupID: "dispatch_1", createdAt: 2 }),
    working({ id: "live-2", dispatchGroupID: "dispatch_1", createdAt: 3 }),
    working({ id: "live-3", dispatchGroupID: "dispatch_1", createdAt: 4 }),
  ]
  const groups = workGroupsForTasks(items, record(...items), { now: 5_000 })
  const layout = workGroupLayout(groups, 60, 40)
  assert.equal(layout.mode, "cards")
  assert.equal(layout.columns, 2)
  assert.deepEqual(layout.sections[0].tasks.map((item) => item.id), ["live-1", "live-2"])
  assert.equal(layout.sections[0].overflow, 2)
  assert.deepEqual(layout.selectableTasks.map((item) => item.id), ["live-1", "live-2"])
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
    "GROUP 1 · EXHAUSTED · CONTINUED · hops 8/8 · cmd 16 left · 1 active · 0 done",
  )
  assert.equal(
    workGroupLabel(groups[1]!, 2),
    "GROUP 2 · CONT 1 · from root · hops 3/8 · cmd 16 left · 1 active · 0 done",
  )
  assert.equal(workSummaryCounts(2, 2, 0, 1), "WORK 2 groups · 2 active · 0 done · 1 exhausted")

  const compact = workGroupLayout(groups, 40, 28)
  assert.equal(compact.mode, "compact")
  assert.deepEqual(compact.sections.map((section) => section.label), [workGroupLabel(groups[0]!, 1), workGroupLabel(groups[1]!, 2)])
  assert.deepEqual(compact.sections.map((section) => section.tone), ["warn", "faint"], "exhaustion is a warning stop, not failure")
  assert.ok((compact.sections[0]!.label ?? "").slice(0, 40).includes("EXHAUSTED"), "the narrow label keeps the controlled stop")
  assert.ok((compact.sections[1]!.label ?? "").slice(0, 40).includes("CONT 1 · from root"), "the narrow label keeps the lineage")

  const cards = workGroupLayout(groups, 76, 40)
  assert.equal(cards.mode, "cards")
  assert.ok(cards.sections.every((section) => section.label !== null), "both groups label their lineage")
  assert.ok(cards.sections.some((section) => (section.label ?? "").includes("EXHAUSTED")))
  assert.ok(cards.sections.some((section) => (section.label ?? "").includes("CONT 1 · from root")))
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
  const layout = workGroupLayout(groups, 40, 24)
  assert.equal(layout.sections[0]?.tone, "warn")
  assert.ok((layout.sections[0]?.label ?? "").includes("EXHAUSTED"), "a lone exhausted group still names its controlled stop")
})
