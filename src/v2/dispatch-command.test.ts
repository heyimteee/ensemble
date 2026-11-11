import test from "node:test"
import assert from "node:assert/strict"
import {
  dispatchCommandKey,
  dispatchCommandRefusalText,
  dispatchCommandStartedForTurn,
  pendingDispatchCommandRoot,
  preflightDispatchCommand,
} from "./dispatch-command.ts"
import type { DispatchGroup } from "./types.ts"

const assignments = [
  { assignee: "Sage", title: "Review the notes", instruction: "Review the release notes.", maxHops: 1 },
  { assignee: "Echo", title: "Run the tests", instruction: "Run the test suite.", maxHops: 0 },
] as const

function rootGroup(patch: Partial<DispatchGroup> = {}): DispatchGroup {
  return {
    id: "dispatch_next",
    workspaceID: "w",
    rootID: "dispatch_next",
    continuationIndex: 0,
    maxHops: 8,
    usedHops: 0,
    depthMax: 8,
    commandMaxHops: 24,
    commandUsedHops: 0,
    maxContinuations: 2,
    continuationsUsed: 0,
    createdAt: 1,
    ...patch,
  }
}

test("ticket250: the dispatch key is stable and scoped to the terminal turn", () => {
  const input = { workspaceID: "w", originTaskID: "review", title: "Next ticket", instruction: "Do the next ticket.", assignments }
  const first = dispatchCommandKey(input)
  assert.deepEqual(dispatchCommandKey(input), first, "the same command and batch produce the same key")
  assert.equal(first.rootKey, `${first.prefix}${first.setHash}:root`)
  assert.deepEqual(first.assignmentKeys, [`${first.prefix}${first.setHash}:assign:0`, `${first.prefix}${first.setHash}:assign:1`])
  assert.notEqual(dispatchCommandKey({ ...input, originTaskID: "other" }).rootKey, first.rootKey, "a different terminal turn is a different command")
  assert.notEqual(dispatchCommandKey({ ...input, assignments: [assignments[0]] }).rootKey, first.rootKey, "a different assignment set is a different command")
  assert.notEqual(dispatchCommandKey({ ...input, title: "Other" }).rootKey, first.rootKey, "the command title is part of the batch identity")
})

test("ticket250: the dispatch key ignores incidental whitespace and assignment order is meaningful", () => {
  const input = { workspaceID: "w", originTaskID: "review", title: "Next ticket", instruction: "Do the next ticket.", assignments }
  const spaced = dispatchCommandKey({
    ...input,
    title: "  Next ticket  ",
    assignments: assignments.map((assignment) => ({ ...assignment, title: ` ${assignment.title} ` })),
  })
  assert.equal(spaced.rootKey, dispatchCommandKey(input).rootKey)
  const reversed = dispatchCommandKey({ ...input, assignments: [...assignments].reverse() })
  assert.notEqual(reversed.rootKey, dispatchCommandKey(input).rootKey)
})

test("ticket250: a dispatch turn is detected from the durable root queue key", () => {
  const key = dispatchCommandKey({ workspaceID: "w", originTaskID: "review", title: "Next", instruction: "Do next.", assignments })
  const tasks = {
    root: { queueKey: key.rootKey },
    assignment: { queueKey: key.assignmentKeys[0] },
  }
  assert.equal(dispatchCommandStartedForTurn(tasks, "w", "review"), true)
  assert.equal(dispatchCommandStartedForTurn(tasks, "w", "other"), false)
  assert.equal(dispatchCommandStartedForTurn({ assignment: { queueKey: key.assignmentKeys[0] } }, "w", "review"), false, "an assignment alone is not a started command")
  assert.equal(dispatchCommandStartedForTurn({ root: { queueKey: "work:w:delegation:leader:root" } }, "w", "review"), false)
})

test("ticket250: a command root waits for its batch during the write window only", () => {
  const key = dispatchCommandKey({ workspaceID: "w", originTaskID: "review", title: "Next", instruction: "Do next.", assignments })
  assert.equal(pendingDispatchCommandRoot({ queueKey: key.rootKey, createdAt: 1_000 }, 1_100, 5_000), true)
  assert.equal(pendingDispatchCommandRoot({ queueKey: key.rootKey, createdAt: 1_000 }, 6_100, 5_000), false, "the grace bound releases a crashed batch")
  assert.equal(pendingDispatchCommandRoot({ queueKey: key.assignmentKeys[0], createdAt: 1_000 }, 1_100, 5_000), false)
  assert.equal(pendingDispatchCommandRoot({ queueKey: "work:w:delegation:leader:root", createdAt: 1_000 }, 1_100, 5_000), false)
})

test("ticket250: the batch preflight checks command, group, depth, and fan-out", () => {
  assert.equal(preflightDispatchCommand({ assignmentCount: 8, group: rootGroup(), maxDelegations: 10, nextDepth: 1 }), undefined)
  assert.deepEqual(
    preflightDispatchCommand({ assignmentCount: 9, group: rootGroup(), maxDelegations: 10, nextDepth: 1 }),
    { layer: "group", used: 9, max: 8 },
  )
  assert.deepEqual(
    preflightDispatchCommand({ assignmentCount: 9, group: rootGroup({ maxHops: 24, commandMaxHops: 8 }), maxDelegations: 10, nextDepth: 1 }),
    { layer: "command", used: 9, max: 8 },
    "the user command ceiling is the outer batch bound",
  )
  assert.deepEqual(
    preflightDispatchCommand({ assignmentCount: 2, group: rootGroup({ depthMax: 0 }), maxDelegations: 10, nextDepth: 1 }),
    { layer: "depth", used: 1, max: 0 },
  )
  assert.deepEqual(
    preflightDispatchCommand({ assignmentCount: 3, group: rootGroup(), maxDelegations: 2, nextDepth: 1 }),
    { layer: "fanout", used: 3, max: 2 },
  )
})

test("ticket251: a command-cap refusal is batch-too-large, not a request for a new command", () => {
  const command = dispatchCommandRefusalText({ layer: "command", used: 25, max: 24 })
  assert.match(command, /new command is limited to 24 hops/)
  assert.match(command, /reduce the batch or split it across commands/)
  assert.doesNotMatch(command, /Ask the user/)
  assert.match(dispatchCommandRefusalText({ layer: "group", used: 9, max: 8 }), /reduce the batch or split it/)
  assert.match(dispatchCommandRefusalText({ layer: "depth", used: 2, max: 1 }), /depth limit is 1/)
  assert.match(dispatchCommandRefusalText({ layer: "fanout", used: 3, max: 2 }), /assignment limit is 2/)
})
