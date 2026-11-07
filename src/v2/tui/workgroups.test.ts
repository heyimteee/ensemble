import test from "node:test"
import assert from "node:assert/strict"
import type { Subtask } from "../types.ts"
import { WORK_GROUP_HOLD_MS } from "./work-constants.ts"
import {
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
  assert.equal(WORK_GROUP_HOLD_MS, 1_200)
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

test("ticket136: a needs-you member keeps a complete group visible after the hold, then clears on resolution", () => {
  const items = [
    replied({ id: "done", dispatchGroupID: "dispatch_1", finishedAt: 1_000, repliedAt: 1_000 }),
    replied({ id: "gated", dispatchGroupID: "dispatch_1", approvalID: "ap", finishedAt: 1_000, repliedAt: 1_000 }),
  ]
  const subtasks = record(...items)
  const blocked = workGroupsForTasks(items, subtasks, { now: 9_999_999, pendingApprovalIDs: new Set(["ap"]) })
  assert.equal(blocked.length, 1, "no timer hides a pending decision")
  assert.equal(blocked[0].needsYou, true)
  assert.equal(blocked[0].complete, false)
  const resolved = workGroupsForTasks(items, subtasks, { now: 9_999_999 })
  assert.equal(resolved.length, 0, "resolving the last gate completes the group normally")
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
