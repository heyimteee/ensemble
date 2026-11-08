import test from "node:test"
import assert from "node:assert/strict"
import {
  DISPATCH_COMMAND_TIERS,
  DISPATCH_DEPTH_MAX,
  DISPATCH_GROUP_TIERS,
  DISPATCH_LIMIT_DEFAULTS,
  continuationDispatchLedger,
  continuationRefusalText,
  dispatchAdmissionRefusal,
  dispatchBudgetContext,
  dispatchBudgetLine,
  dispatchBudgetState,
  dispatchBudgetSummary,
  dispatchChildDepth,
  dispatchCommandRemaining,
  dispatchDepthFor,
  dispatchFanOutCount,
  dispatchGroupExhausted,
  dispatchGroupRemaining,
  dispatchGroupState,
  dispatchHopCount,
  dispatchRefusalText,
  dispatchTargetGroup,
  dispatchTaskHopCount,
  dispatchesHop,
  dispatchLimitSettings,
  dispatchLimits,
  newContinuationDispatchGroup,
  newRootDispatchGroup,
  reconcileLegacyDispatchGroup,
  reconcileLegacyTaskBudgets,
  stepDispatchLimit,
  validateContinuation,
  validateDispatchLimits,
  validateTaskMaxHops,
} from "./dispatch-budget.ts"
import type { DispatchGroup, Settings, Subtask } from "./types.ts"

const settings = (patch: Partial<Settings> = {}): Settings => ({
  maxActiveRuns: 3,
  maxDelegations: 10,
  maxDepth: 5,
  synthesis: true,
  ...dispatchLimitSettings(DISPATCH_LIMIT_DEFAULTS),
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

test("ticket160: default limits are the one exported product set", () => {
  assert.deepEqual(dispatchLimits(settings()), DISPATCH_LIMIT_DEFAULTS)
  assert.deepEqual(dispatchLimits({}), DISPATCH_LIMIT_DEFAULTS)
  assert.deepEqual(dispatchLimitSettings(dispatchLimits(settings())), dispatchLimitSettings(DISPATCH_LIMIT_DEFAULTS))
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
  assert.equal(dispatchGroupState({ ...used, closedAt: 5, closeReason: "continued" }), "closed")
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

test("ticket161: maxHops is required, non-negative, and zero is a valid one-shot ask", () => {
  const missing = validateTaskMaxHops("ensemble_delegate", undefined)
  assert.equal(missing.ok, false)
  assert.match(missing.ok ? "" : missing.reason, /ensemble_delegate requires maxHops/)
  assert.match(missing.ok ? "" : missing.reason, /maxHops: 0/)
  assert.match(missing.ok ? "" : missing.reason, /one-shot ask/)

  for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "2"]) {
    const result = validateTaskMaxHops("ensemble_handoff", invalid)
    assert.equal(result.ok, false, `${String(invalid)} must fail`)
    assert.match(result.ok ? "" : result.reason, /ensemble_handoff maxHops must be a non-negative integer/)
    assert.match(result.ok ? "" : result.reason, /maxHops: 0/)
  }
  assert.deepEqual(validateTaskMaxHops("ensemble_delegate", 0), { ok: true, maxHops: 0 })
  assert.deepEqual(validateTaskMaxHops("ensemble_delegate", 5), { ok: true, maxHops: 5 })
})

test("ticket161: task usage counts only consuming direct dispatches", () => {
  const asking = task({ id: "ask", taskMaxHops: 2 })
  const tasks = [
    asking,
    task({ id: "hop-1", parentID: "ask" }),
    task({ id: "hop-2", parentID: "ask", workKind: "handoff", handoff: { correlationID: "c", senderID: "a", recipientID: "b", depth: 1 } }),
    task({ id: "turn", parentID: "ask", workKind: "turn" }),
    task({ id: "completion", parentID: "ask", workKind: "handoff", handoff: { correlationID: "c", senderID: "a", recipientID: "b", depth: 1, completion: true } }),
    task({ id: "batch", parentID: "ask", workKind: "handoff", handoff: { correlationID: "c", senderID: "a", recipientID: "b", depth: 1, batch: true } }),
    task({ id: "grand", parentID: "hop-1" }),
  ]
  const byID = Object.fromEntries(tasks.map((item) => [item.id, item]))
  assert.equal(dispatchTaskHopCount("ask", byID), 2, "user/turn/completion/batch work never spends the task budget")
  assert.equal(dispatchFanOutCount("ask", byID), 5)
  assert.equal(dispatchFanOutCount("ask", byID, "handoff"), 3)
  assert.equal(dispatchDepthFor(asking, byID), 0, "a user-command recipient starts at depth 0")
  assert.equal(dispatchDepthFor(byID["hop-1"]!, byID), 1, "the parent chain derives legacy depth")
  assert.equal(dispatchDepthFor({ ...byID["hop-1"]!, dispatchDepth: 4 }, byID), 4, "a stored unified depth wins")
})

test("ticket161: refusal order is task, group, depth, command, then per-run fan-out", () => {
  const group = { ...newRootDispatchGroup({ id: "dispatch_root", workspaceID: "w", settings: settings(), now: 1 }), usedHops: 8, commandUsedHops: 24 }
  const asking = task({ id: "ask", taskMaxHops: 0 })
  const budget = dispatchBudgetState({ group, groups: { [group.id]: group }, task: asking, subtasks: { ask: asking }, nextDepth: 99 })
  assert.deepEqual(dispatchAdmissionRefusal({ state: budget, maxPerRun: 0, fanOutUsed: 9 }), { layer: "task", used: 0, max: 0 })

  const halfway = { ...group, usedHops: 8, commandUsedHops: 8 }
  const noTaskBudget = { ...asking, taskMaxHops: undefined }
  const overDepth = dispatchBudgetState({ group: halfway, groups: { [halfway.id]: halfway }, task: noTaskBudget, subtasks: { ask: noTaskBudget }, nextDepth: 9 })
  assert.equal(dispatchAdmissionRefusal({ state: overDepth, maxPerRun: 0, fanOutUsed: 9 })?.layer, "group")

  const depthGroup = { ...group, usedHops: 1, commandUsedHops: 24 }
  const depthState = dispatchBudgetState({ group: depthGroup, groups: { [depthGroup.id]: depthGroup }, task: noTaskBudget, subtasks: { ask: noTaskBudget }, nextDepth: 9 })
  assert.deepEqual(dispatchAdmissionRefusal({ state: depthState, maxPerRun: 0, fanOutUsed: 9 }), { layer: "depth", used: 9, max: 8 })

  const commandGroup = { ...group, usedHops: 1, commandUsedHops: 24 }
  const commandState = dispatchBudgetState({ group: commandGroup, groups: { [commandGroup.id]: commandGroup }, task: noTaskBudget, subtasks: { ask: noTaskBudget }, nextDepth: 2 })
  assert.deepEqual(dispatchAdmissionRefusal({ state: commandState, maxPerRun: 0, fanOutUsed: 9 }), { layer: "command", used: 24, max: 24 })

  const fanOutState = dispatchBudgetState({ group: { ...group, usedHops: 1, commandUsedHops: 1 }, groups: { [group.id]: { ...group, usedHops: 1, commandUsedHops: 1 } }, task: noTaskBudget, subtasks: { ask: noTaskBudget }, nextDepth: 2 })
  assert.deepEqual(dispatchAdmissionRefusal({ state: fanOutState, maxPerRun: 3, fanOutUsed: 3 }), { layer: "fanout", used: 3, max: 3 })
  assert.equal(dispatchAdmissionRefusal({ state: fanOutState, maxPerRun: 3, fanOutUsed: 2 }), undefined)
})

test("ticket161: budget boundaries allow the last hop and the exact depth", () => {
  const group = { ...newRootDispatchGroup({ id: "dispatch_root", workspaceID: "w", settings: settings(), now: 1 }), usedHops: 7, commandUsedHops: 23 }
  const asking = task({ id: "ask", taskMaxHops: 2 })
  const atEdge = dispatchBudgetState({ group, groups: { [group.id]: group }, task: asking, subtasks: { ask: asking }, nextDepth: 8 })
  assert.equal(atEdge.groupRemaining, 1)
  assert.equal(atEdge.commandRemaining, 1)
  assert.equal(atEdge.taskRemaining, 2)
  assert.equal(atEdge.depth, 8)
  assert.equal(dispatchAdmissionRefusal({ state: atEdge, maxPerRun: 3, fanOutUsed: 0 }), undefined, "the last hop and exact depth are allowed")

  const past = { ...atEdge, depth: 9 }
  assert.equal(dispatchAdmissionRefusal({ state: past })?.layer, "depth")
})

test("ticket161: refusal copy names the layer and the next action", () => {
  assert.match(dispatchRefusalText("delegation", { layer: "task", used: 1, max: 1 }), /task budget is exhausted .*Return your result to the leader/)
  assert.match(dispatchRefusalText("handoff", { layer: "group", used: 8, max: 8 }), /dispatch group is exhausted .*Return your result to the leader/)
  assert.match(dispatchRefusalText("handoff", { layer: "depth", used: 9, max: 8 }), /dispatch depth limit is 8 .*Return your result to the leader/)
  assert.match(dispatchRefusalText("delegation", { layer: "command", used: 24, max: 24 }), /command budget is exhausted .*Ask the user to start a new command/)
  assert.match(dispatchRefusalText("handoff", { layer: "fanout", used: 3, max: 3 }), /the handoff limit is 3 per run/)
  assert.doesNotMatch(dispatchRefusalText("handoff", { layer: "group", used: 8, max: 8 }), /task budget/)
})

test("ticket161: turn context and tool results show used and remaining budgets", () => {
  const group = { ...newRootDispatchGroup({ id: "dispatch_root", workspaceID: "w", settings: settings(), now: 1 }), usedHops: 3, commandUsedHops: 5 }
  const asking = task({ id: "ask", taskMaxHops: 4 })
  const children = [
    task({ id: "hop-1", parentID: "ask" }),
    task({ id: "hop-2", parentID: "ask" }),
  ]
  const subtasks = Object.fromEntries([asking, ...children].map((item) => [item.id, item]))
  const budget = dispatchBudgetState({ group, groups: { [group.id]: group }, task: asking, subtasks, nextDepth: 2 })
  const line = dispatchBudgetLine(budget)
  assert.match(line, /task 2 of 4 dispatches/)
  assert.match(line, /group 5 of 8 hops/)
  assert.match(line, /command 19 of 24 hops/)
  assert.match(line, /depth 2 of 8/)
  assert.match(line, /cannot raise these ceilings/i)

  const context = dispatchBudgetContext(budget, { id: "ask" })
  assert.match(context, /<ensemble_dispatch_budget /)
  assert.match(context, /group_used="3"/)
  assert.match(context, /group_remaining="5"/)
  assert.match(context, /command_remaining="19"/)
  assert.match(context, /task_used="2"/)
  assert.match(context, /task_remaining="2"/)
  assert.match(context, /depth="2"/)
  assert.match(context, /continuation="0"/)
  assert.match(context, /ensemble_delegate and ensemble_handoff call requires maxHops/)
  assert.match(context, /maxHops: 0/)
  assert.match(context, /do not consume/)
  assert.match(context, /cannot raise these ceilings/i)
  assert.ok(!context.includes("secret"), "context carries numbers, never task content")
})

/* ------------------------------------------------------------------------- *
 * Ticket #162: exhaustion and continuation groups.
 * ------------------------------------------------------------------------- */

const exhaustedRoot = (patch: Partial<DispatchGroup> = {}) => ({
  ...newRootDispatchGroup({ id: "dispatch_root", workspaceID: "w", settings: settings(), now: 1 }),
  usedHops: 8,
  commandUsedHops: 8,
  ...patch,
})

test("ticket162: continuation requires an exhausted latest group and a fitting tier", () => {
  const root = exhaustedRoot()
  const groups = { [root.id]: root }
  const base = { groups, workspaceID: "w", isLeader: true } as const
  assert.deepEqual(validateContinuation({ ...base, continuationOf: root.id, groupMaxHops: 8 }), {
    ok: true,
    root,
    parent: root,
    maxHops: 8,
  })
  const refusal = (input: { continuationOf?: unknown; groupMaxHops?: unknown; groups?: any; isLeader?: boolean }) => {
    const result = validateContinuation({ ...base, ...input } as any)
    return result.ok ? undefined : result.refusal
  }
  assert.equal(refusal({ continuationOf: root.id, groupMaxHops: 8, isLeader: false })?.reason, "not-leader")
  assert.equal(refusal({ continuationOf: "missing", groupMaxHops: 8 })?.reason, "unknown-group")
  assert.equal(refusal({ continuationOf: root.id, groupMaxHops: 12 })?.reason, "invalid-group-budget")
  assert.equal(refusal({ continuationOf: root.id })?.reason, "invalid-group-budget")
  const active = { ...root, usedHops: 7, commandUsedHops: 7 }
  assert.deepEqual(refusal({ continuationOf: root.id, groupMaxHops: 8, groups: { [root.id]: active } }), {
    reason: "group-active",
    groupID: root.id,
    rootID: root.id,
    used: 7,
    max: 8,
    remaining: 1,
  })
  const commandClosed = { ...root, commandUsedHops: 24 }
  assert.equal(refusal({ continuationOf: root.id, groupMaxHops: 8, groups: { [root.id]: commandClosed } })?.reason, "command-exhausted")
  const shortCommand = { ...root, commandUsedHops: 20 }
  assert.deepEqual(refusal({ continuationOf: root.id, groupMaxHops: 8, groups: { [root.id]: shortCommand } }), {
    reason: "command-insufficient",
    groupID: root.id,
    rootID: root.id,
    remaining: 4,
    requested: 8,
  })
  const spentContinuationsRoot = { ...root, continuationsUsed: 2 }
  const spentParent = {
    ...newContinuationDispatchGroup({ id: "dispatch_c2", root: spentContinuationsRoot, parentID: root.id, maxHops: 8, continuationIndex: 2, now: 2 }),
    usedHops: 8,
  }
  assert.equal(refusal({ continuationOf: spentParent.id, groupMaxHops: 8, groups: { [root.id]: spentContinuationsRoot, [spentParent.id]: spentParent } })?.reason, "continuations-exhausted")
})

test("ticket162: closed and superseded groups cannot be continued again", () => {
  const root = exhaustedRoot({ continuationsUsed: 1, closedAt: 9, closeReason: "continued" })
  const first = {
    ...newContinuationDispatchGroup({ id: "dispatch_c1", root: { ...root, continuationsUsed: 0 }, parentID: root.id, maxHops: 8, now: 2 }),
    usedHops: 8,
    closedAt: 9,
    closeReason: "continued" as const,
  }
  const second = newContinuationDispatchGroup({ id: "dispatch_c2", root: { ...root, continuationsUsed: 2 }, parentID: first.id, maxHops: 8, now: 3 })
  const groups = { [root.id]: root, [first.id]: first, [second.id]: second }
  const closed = validateContinuation({ continuationOf: root.id, groupMaxHops: 8, groups, workspaceID: "w", isLeader: true })
  assert.equal(closed.ok ? "" : closed.refusal.reason, "group-closed")
  const older = validateContinuation({ continuationOf: first.id, groupMaxHops: 8, groups, workspaceID: "w", isLeader: true })
  assert.equal(older.ok ? "" : older.refusal.reason, "group-closed")
})

test("ticket162: continuation ledger links parent and root, resets the segment, and keeps command counters", () => {
  const root = exhaustedRoot()
  const first = continuationDispatchLedger({ id: "dispatch_c1", root, parent: root, maxHops: 8, now: 10 })
  assert.equal(first.root.rootID, root.id)
  assert.equal(first.root.continuationsUsed, 1)
  assert.equal(first.root.closedAt, 10)
  assert.equal(first.root.closeReason, "continued")
  assert.equal(first.root.commandUsedHops, 8, "the command ledger is unchanged")
  assert.equal(first.root.commandMaxHops, 24)
  assert.equal(first.parent, first.root, "a root parent closes with the same record")
  assert.equal(first.group.id, "dispatch_c1")
  assert.equal(first.group.rootID, root.id)
  assert.equal(first.group.parentID, root.id)
  assert.equal(first.group.continuationIndex, 1)
  assert.equal(first.group.maxHops, 8)
  assert.equal(first.group.usedHops, 0)
  assert.equal(first.group.depthMax, root.depthMax)
  assert.equal(first.group.commandMaxHops, undefined, "command counters stay root-only")

  const second = continuationDispatchLedger({ id: "dispatch_c2", root: first.root, parent: first.group, maxHops: 16, now: 20 })
  assert.equal(second.root.continuationsUsed, 2)
  assert.equal(second.group.continuationIndex, 2)
  assert.equal(second.parent.id, first.group.id)
  assert.equal(second.parent.closedAt, 20)
  assert.equal(second.parent.closeReason, "continued")
  assert.equal(second.group.rootID, root.id)
})

test("ticket162: depth resets when work crosses into a continuation segment", () => {
  const rootTask = task({ id: "root", dispatchGroupID: "dispatch_root", dispatchDepth: 0 })
  const deep = task({ id: "deep", parentID: "root", dispatchGroupID: "dispatch_root", dispatchDepth: 6 })
  const byID = { root: rootTask, deep }
  assert.equal(dispatchChildDepth(rootTask, "dispatch_root", byID), 1)
  assert.equal(dispatchChildDepth(deep, "dispatch_root", byID), 7)
  assert.equal(dispatchChildDepth(deep, "dispatch_c1", byID), 0, "a continuation starts a fresh depth segment")
  assert.equal(dispatchChildDepth(undefined, "dispatch_c1", byID), 0)
})

test("ticket162: exhaustion and closed states derive consistently and closed groups refuse work", () => {
  const root = exhaustedRoot({ closedAt: 10, closeReason: "continued" })
  const continuation = newContinuationDispatchGroup({ id: "dispatch_c1", root: { ...root, continuationsUsed: 0 }, parentID: root.id, maxHops: 8, now: 11 })
  const groups = { [root.id]: root, [continuation.id]: continuation }
  assert.equal(dispatchGroupState(root, groups), "closed")
  assert.equal(dispatchGroupExhausted(root, groups), true)
  assert.equal(dispatchGroupState(continuation, groups), "active")
  assert.equal(dispatchGroupExhausted(continuation, groups), false)

  const current = { ...continuation, usedHops: 2 }
  assert.equal(dispatchTargetGroup(root, { ...groups, [continuation.id]: current })?.id, continuation.id, "the newest active continuation owns new work")
  assert.equal(dispatchTargetGroup(continuation, groups)?.id, continuation.id)
  assert.equal(dispatchTargetGroup({ ...root, closedAt: undefined }, { [root.id]: { ...root, closedAt: undefined } })?.id, root.id)

  const asking = task({ id: "ask", dispatchGroupID: root.id, taskMaxHops: 1 })
  const budget = dispatchBudgetState({ group: { ...root, closedAt: 10 }, groups, task: asking, subtasks: { ask: asking }, nextDepth: 1 })
  assert.deepEqual(dispatchAdmissionRefusal({ state: budget }), { layer: "closed", used: 8, max: 8 })

  const commandSpent = { ...continuation, usedHops: 1 }
  const commandRoot = { ...root, commandUsedHops: 24 }
  assert.equal(dispatchGroupExhausted(commandSpent, { ...groups, [root.id]: commandRoot }), true, "a continuation is exhausted when the command is")
})

test("ticket162: continuation refusals name the layer and the next action", () => {
  assert.match(continuationRefusalText({ reason: "not-leader" }), /only the workspace leader .*return your result to the leader/i)
  assert.match(continuationRefusalText({ reason: "group-active", used: 3, max: 8, remaining: 5 }), /still has 5 of 8 hops; dispatch into it/i)
  assert.match(continuationRefusalText({ reason: "command-exhausted", used: 24, max: 24 }), /command budget is exhausted .*start a new command/i)
  assert.match(continuationRefusalText({ reason: "command-insufficient", remaining: 4, requested: 8 }), /4 hops left, .*start a new command/i)
  assert.match(continuationRefusalText({ reason: "continuations-exhausted", continuationsUsed: 2, maxContinuations: 2 }), /continuation limit .*start a new command/i)
  assert.match(continuationRefusalText({ reason: "group-closed" }), /closed; continue the newest active group/i)
  assert.match(continuationRefusalText({ reason: "invalid-group-budget", requested: 12 }), /groupMaxHops must be one of 8, 16, 24/)
  assert.match(continuationRefusalText({ reason: "invalid-group-budget" }), /groupMaxHops is required with continuationOf/)
  assert.match(continuationRefusalText({ reason: "group-superseded" }), /already continued; continue the newest group, or ask the user to start a new command/i)
})
