import test from "node:test"
import assert from "node:assert/strict"
import {
  DISPATCH_COMMAND_TIERS,
  DISPATCH_DEPTH_MAX,
  DISPATCH_GROUP_TIERS,
  dispatchBudgetSummary,
  dispatchCommandRemaining,
  dispatchGroupRemaining,
  dispatchGroupState,
  dispatchHopCount,
  dispatchesHop,
  dispatchLimitSettings,
  dispatchLimits,
  newContinuationDispatchGroup,
  newRootDispatchGroup,
  reconcileLegacyDispatchGroup,
  reconcileLegacyTaskBudgets,
  stepDispatchLimit,
  validateDispatchLimits,
} from "./dispatch-budget.ts"
import type { Settings, Subtask } from "./types.ts"

const settings = (patch: Partial<Settings> = {}): Settings => ({
  maxActiveRuns: 3,
  maxDelegations: 10,
  maxDepth: 5,
  synthesis: true,
  dispatchGroupMaxHops: 8,
  dispatchCommandMaxHops: 24,
  dispatchDepth: 8,
  dispatchContinuations: 2,
  ...patch,
})

const task = (patch: Partial<Subtask> = {}): Subtask => ({
  id: "t",
  workspaceID: "w",
  creatorType: "agent",
  assigneeID: "b",
  title: "work",
  instruction: "do",
  mode: "research",
  state: "pending",
  stage: "initial",
  outcome: "pending",
  interrupted: false,
  awaitingChildren: false,
  attempts: 0,
  createdAt: 1,
  workKind: "delegation",
  ...patch,
})

test("ticket160: default limits are the 8/24/8/2 product tiers", () => {
  assert.deepEqual(dispatchLimits(settings()), { groupMaxHops: 8, commandMaxHops: 24, depth: 8, continuations: 2 })
  assert.deepEqual(dispatchLimits({}), { groupMaxHops: 8, commandMaxHops: 24, depth: 8, continuations: 2 })
  assert.deepEqual(dispatchLimitSettings(dispatchLimits(settings())), {
    dispatchGroupMaxHops: 8,
    dispatchCommandMaxHops: 24,
    dispatchDepth: 8,
    dispatchContinuations: 2,
  })
})

test("ticket160: every allowed tier validates and command never falls below group", () => {
  for (const group of DISPATCH_GROUP_TIERS) {
    for (const command of DISPATCH_COMMAND_TIERS) {
      const result = validateDispatchLimits({ groupMaxHops: group, commandMaxHops: command, depth: 8, continuations: 0 })
      if (command < group) {
        assert.equal(result.ok, false, `${group}/${command} must fail`)
        assert.match(result.ok ? "" : result.errors[0]!, /at least group hops/)
      } else {
        assert.equal(result.ok, true, `${group}/${command} must pass`)
      }
    }
  }
})

test("ticket160: limits reject unknown tiers, out-of-range depth, and continuations", () => {
  const cases: Array<[Record<string, number>, RegExp]> = [
    [{ groupMaxHops: 12, commandMaxHops: 24, depth: 8, continuations: 0 }, /Group hops must be one of/],
    [{ groupMaxHops: 8, commandMaxHops: 20, depth: 8, continuations: 0 }, /Command hops must be one of/],
    [{ groupMaxHops: 8, commandMaxHops: 24, depth: 0, continuations: 0 }, /Depth must be between 1 and 16/],
    [{ groupMaxHops: 8, commandMaxHops: 24, depth: DISPATCH_DEPTH_MAX + 1, continuations: 0 }, /Depth must be between/],
    [{ groupMaxHops: 8, commandMaxHops: 24, depth: 8, continuations: 6 }, /Continuations must be between 0 and 5/],
  ]
  for (const [input, pattern] of cases) {
    const result = validateDispatchLimits(input)
    assert.equal(result.ok, false)
    assert.match(result.ok ? "" : result.errors.join("\n"), pattern)
  }
})

test("ticket160: continuations must fit at the smallest group size", () => {
  // 8 + 2 * 8 = 24 fits the default command budget.
  assert.equal(validateDispatchLimits({ groupMaxHops: 8, commandMaxHops: 24, depth: 8, continuations: 2 }).ok, true)
  // 16 + 2 * 8 = 32 does not fit a 24-hop command.
  const result = validateDispatchLimits({ groupMaxHops: 16, commandMaxHops: 24, depth: 8, continuations: 2 })
  assert.equal(result.ok, false)
  assert.match(result.ok ? "" : result.errors[0]!, /need at least 32 command hops/)
  assert.equal(validateDispatchLimits({ groupMaxHops: 24, commandMaxHops: 24, depth: 8, continuations: 0 }).ok, true)
})

test("ticket160: stepping limits cycles tiers and clamps numeric bounds", () => {
  assert.equal(stepDispatchLimit("groupMaxHops", 8, 1), 16)
  assert.equal(stepDispatchLimit("groupMaxHops", 24, 1), 24)
  assert.equal(stepDispatchLimit("groupMaxHops", 12, 1), 8, "an unknown current value recovers to a tier")
  assert.equal(stepDispatchLimit("commandMaxHops", 24, -1), 16)
  assert.equal(stepDispatchLimit("depth", 1, -1), 1)
  assert.equal(stepDispatchLimit("depth", 16, 1), 16)
  assert.equal(stepDispatchLimit("continuations", 2, 1), 3)
  assert.equal(stepDispatchLimit("continuations", 5, 1), 5)
})

test("ticket160: a new root group captures the current settings and starts empty", () => {
  const group = newRootDispatchGroup({
    id: "dispatch_root",
    workspaceID: "w",
    settings: settings({ dispatchGroupMaxHops: 16, dispatchCommandMaxHops: 32, dispatchDepth: 4, dispatchContinuations: 1 }),
    now: 100,
  })
  assert.equal(group.rootID, group.id)
  assert.equal(group.continuationIndex, 0)
  assert.equal(group.maxHops, 16)
  assert.equal(group.usedHops, 0)
  assert.equal(group.depthMax, 4)
  assert.equal(group.commandMaxHops, 32)
  assert.equal(group.commandUsedHops, 0)
  assert.equal(group.maxContinuations, 1)
  assert.equal(group.continuationsUsed, 0)
  assert.equal(group.createdAt, 100)
})

test("ticket160: budget state and remaining values derive from the counters", () => {
  const root = newRootDispatchGroup({ id: "dispatch_root", workspaceID: "w", settings: settings(), now: 1 })
  assert.equal(dispatchGroupState(root), "active")
  assert.equal(dispatchGroupRemaining(root), 8)
  const used = { ...root, usedHops: 3, commandUsedHops: 5 }
  assert.equal(dispatchGroupState(used), "active")
  assert.equal(dispatchGroupRemaining(used), 5)
  assert.deepEqual(dispatchBudgetSummary(used, { [used.id]: used }), {
    usedHops: 3,
    maxHops: 8,
    commandRemaining: 19,
    commandMaxHops: 24,
  })
  assert.equal(dispatchGroupState({ ...used, usedHops: 8 }), "exhausted")
  assert.equal(dispatchGroupState({ ...used, usedHops: 2, commandUsedHops: 24 }), "exhausted")
  assert.equal(dispatchGroupState({ ...used, closedAt: 5, closeReason: "continuation" }), "closed")
})

test("ticket160: continuation groups carry lineage and resolve root command budget", () => {
  const root = { ...newRootDispatchGroup({ id: "dispatch_root", workspaceID: "w", settings: settings(), now: 1 }), usedHops: 8, commandUsedHops: 8, continuationsUsed: 1 }
  const continuation = newContinuationDispatchGroup({ id: "dispatch_child", root, parentID: root.id, maxHops: 8, now: 2 })
  assert.equal(continuation.rootID, root.id)
  assert.equal(continuation.parentID, root.id)
  assert.equal(continuation.continuationIndex, 2)
  assert.equal(continuation.maxHops, 8)
  assert.equal(continuation.commandMaxHops, undefined, "command counters stay root-only")
  assert.equal(dispatchCommandRemaining(continuation, { [root.id]: root, [continuation.id]: continuation }), 16)
  assert.equal(dispatchCommandRemaining(undefined, {}), undefined)
})

test("ticket160: only agent-created non-completion delegation and handoff hops count", () => {
  assert.equal(dispatchesHop(task()), true)
  assert.equal(dispatchesHop(task({ workKind: "handoff", handoff: { correlationID: "c", senderID: "a", recipientID: "b", depth: 1 } })), true)
  assert.equal(dispatchesHop(task({ creatorType: "user" })), false, "user command recipients consume nothing")
  assert.equal(dispatchesHop(task({ workKind: "turn" })), false, "peer turns never consume")
  assert.equal(dispatchesHop(task({ workKind: "handoff", handoff: { correlationID: "c", senderID: "a", recipientID: "b", depth: 1, completion: true } })), false)
  assert.equal(dispatchesHop(task({ workKind: "handoff", handoff: { correlationID: "c", senderID: "a", recipientID: "b", depth: 1, batch: true } })), false)
  assert.equal(dispatchHopCount([task(), task({ id: "2", workKind: "turn" }), task({ id: "3" })]), 2)
})

test("ticket160: legacy reconciliation raises maximums to observed usage and keeps live work admitted", () => {
  const tasks = [
    task({ id: "root", creatorType: "user", parentID: undefined, createdAt: 1 }),
    task({ id: "child", parentID: "root", createdAt: 2 }),
    task({ id: "grand", parentID: "child", createdAt: 3 }),
    task({ id: "turn", workKind: "turn", parentID: "root", createdAt: 4 }),
  ]
  const all = Object.fromEntries(tasks.map((item) => [item.id, item]))
  const group = reconcileLegacyDispatchGroup({
    id: "dispatch_legacy",
    workspaceID: "w",
    tasks,
    allTasks: all,
    settings: settings({ dispatchGroupMaxHops: 8, dispatchCommandMaxHops: 24, dispatchDepth: 2 }),
    now: 50,
  })
  assert.equal(group.reconciled, true)
  assert.equal(group.usedHops, 2, "the user command root and peer turn do not count")
  assert.equal(group.maxHops, 8)
  assert.equal(group.depthMax, 2)
  assert.equal(group.commandMaxHops, 24)
  assert.equal(group.commandUsedHops, 2)
  assert.equal(group.createdAt, 1)

  const heavy = Array.from({ length: 12 }, (_, index) => task({ id: `hop${index}`, createdAt: index + 1 }))
  const heavyGroup = reconcileLegacyDispatchGroup({
    id: "dispatch_heavy",
    workspaceID: "w",
    tasks: heavy,
    allTasks: Object.fromEntries(heavy.map((item) => [item.id, item])),
    settings: settings(),
    now: 5,
  })
  assert.equal(heavyGroup.usedHops, 12)
  assert.equal(heavyGroup.maxHops, 12, "the maximum is at least observed usage")
  assert.equal(heavyGroup.commandMaxHops, 24, "the command maximum keeps the configured ceiling when it is larger")
  assert.equal(dispatchGroupState(heavyGroup), "exhausted")
  assert.equal(dispatchGroupRemaining(heavyGroup), 0)
})

test("ticket160: reconciliation grants live legacy tasks the remaining group budget", () => {
  const tasks = [
    task({ id: "live", createdAt: 1, taskMaxHops: undefined }),
    task({ id: "done", state: "replied", outcome: "succeeded", createdAt: 2 }),
    task({ id: "granted", createdAt: 3, taskMaxHops: 1 }),
  ]
  const group = reconcileLegacyDispatchGroup({
    id: "dispatch_legacy",
    workspaceID: "w",
    tasks,
    allTasks: Object.fromEntries(tasks.map((item) => [item.id, item])),
    settings: settings(),
    now: 10,
  })
  const granted = reconcileLegacyTaskBudgets(group, tasks)
  assert.deepEqual(granted.map((item) => [item.id, item.taskMaxHops]), [["live", group.maxHops - group.usedHops]])
})
