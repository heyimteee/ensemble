import test from "node:test"
import assert from "node:assert/strict"
import { createInitialState } from "./defaults.ts"
import {
  TIER3_MESSAGE_THRESHOLD,
  TIER3_SNAPSHOT_BYTES,
  TIER3_TASK_THRESHOLD,
  mergeRetainedWork,
  projectRetainedWork,
  projectVisibleWork,
  scopesToResync,
  tier3Gate,
  transcriptWindow,
  workspaceCounts,
} from "./scoped-read.ts"
import { FINISHED_RETENTION_MS } from "./queue.ts"
import type { Message, Subtask, Workspace } from "./types.ts"

const workspace = (patch: Partial<Workspace> = {}): Workspace => ({
  id: "w",
  name: "site",
  directory: "/repo",
  leaderID: "a",
  memberIDs: ["a"],
  synthesis: true,
  archived: false,
  paused: false,
  nextSeq: 1,
  createdAt: 1,
  lastActiveAt: 10,
  ...patch,
})

const task = (patch: Partial<Subtask> = {}): Subtask => ({
  id: "t",
  workspaceID: "w",
  creatorType: "user",
  assigneeID: "a",
  title: "Task",
  instruction: "Do",
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

const working = (patch: Partial<Subtask> = {}): Subtask =>
  task({ state: "working", claimedBy: "run", leaseUntil: 99_000, attempts: 1, ...patch })

const replied = (patch: Partial<Subtask> = {}): Subtask =>
  task({ state: "replied", outcome: "succeeded", finishedAt: 1_000, repliedAt: 1_000, ...patch })

const message = (seq: number, patch: Partial<Message> = {}): Message => ({
  id: `m${seq}`,
  workspaceID: "w",
  seq,
  author: "agent",
  text: `message ${seq}`,
  kind: "text",
  createdAt: seq,
  ...patch,
})

test("the Tier 3 gate engages only for measured history, payload, or latency pressure", () => {
  const small = tier3Gate({ messageCount: 12, taskCount: 2 })
  assert.equal(small.enabled, false)
  assert.equal(small.reason, "small-history")

  const history = tier3Gate({ messageCount: TIER3_MESSAGE_THRESHOLD, taskCount: 2 })
  assert.equal(history.enabled, true)
  assert.equal(history.reason, "history")

  const tasks = tier3Gate({ messageCount: 2, taskCount: TIER3_TASK_THRESHOLD })
  assert.equal(tasks.enabled, true)
  assert.equal(tasks.reason, "history")

  const payload = tier3Gate({ messageCount: 2, taskCount: 2, snapshotBytes: TIER3_SNAPSHOT_BYTES })
  assert.equal(payload.enabled, true)
  assert.equal(payload.reason, "payload")

  const latency = tier3Gate({ messageCount: 2, taskCount: 2, snapshotMs: 121 })
  assert.equal(latency.enabled, true)
  assert.equal(latency.reason, "latency")
})

test("a Work projection keeps active, needs-you, and hold groups but drops long-retained terminal rows", () => {
  const state = createInitialState()
  state.workspaces.w = workspace()
  state.agents.a = {
    id: "a",
    name: "Nova",
    title: "",
    role: "",
    mainModel: { providerID: "p", modelID: "m" },
    backupModels: [],
    skillbox: [],
    color: "cyan",
    archived: false,
    pendingSettings: false,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  }
  // Active group with a terminal sibling.
  state.subtasks.live = working({ id: "live", dispatchGroupID: "dispatch_live", createdAt: 1 })
  state.subtasks.doneSibling = replied({ id: "doneSibling", dispatchGroupID: "dispatch_live", createdAt: 2 })
  // Needs-you group whose members are all terminal.
  state.subtasks.gated = replied({ id: "gated", dispatchGroupID: "dispatch_gated", approvalID: "ap", createdAt: 3 })
  state.approvals.ap = {
    id: "ap",
    workspaceID: "w",
    kind: "ask_person",
    title: "Ask",
    detail: "?",
    status: "pending",
    createdAt: 3,
  }
  // Complete group still inside its shared hold.
  state.subtasks.holding = replied({ id: "holding", dispatchGroupID: "dispatch_hold", createdAt: 4, finishedAt: 10_000, repliedAt: 10_000 })
  // Long-retained terminal rows with no visible group.
  for (let index = 0; index < 50; index++) {
    const id = `old${index}`
    state.subtasks[id] = replied({
      id,
      dispatchGroupID: `dispatch_old_${index}`,
      createdAt: 5 + index,
      finishedAt: 1_000,
      repliedAt: 1_000,
    })
  }

  const projected = projectVisibleWork(state, 10_500)
  assert.deepEqual(Object.keys(projected).sort(), ["doneSibling", "gated", "holding", "live"])
  assert.equal(projected.old0, undefined, "a long-retained terminal row is not in the projection")

  const afterHold = projectVisibleWork(state, 12_000)
  assert.deepEqual(Object.keys(afterHold).sort(), ["doneSibling", "gated", "live"])
})

test("a terminal needs-you group holds for 1.2 s after its last approval resolves", () => {
  const state = createInitialState()
  state.workspaces.w = workspace()
  state.subtasks.gated = replied({ id: "gated", dispatchGroupID: "dispatch_gated", approvalID: "ap", createdAt: 3, finishedAt: 1_000, repliedAt: 1_000 })
  state.approvals.ap = {
    id: "ap",
    workspaceID: "w",
    kind: "ask_person",
    title: "Ask",
    detail: "?",
    status: "approved",
    createdAt: 3,
    resolvedAt: 10_000,
  }
  // The task finished long before the decision; the shared hold starts at the
  // resolution instead of clearing the group the instant it resolves.
  assert.deepEqual(Object.keys(projectVisibleWork(state, 11_000)), ["gated"])
  assert.deepEqual(Object.keys(projectVisibleWork(state, 11_200)), [])
})

test("transcript windows paginate by sequence and report whether older rows remain", () => {
  const messages = Array.from({ length: 100 }, (_, index) => message(index + 1))
  const latest = transcriptWindow(messages, { limit: 40 })
  assert.equal(latest.messages.length, 40)
  assert.equal(latest.messages[0]?.seq, 61)
  assert.equal(latest.messages.at(-1)?.seq, 100)
  assert.equal(latest.oldestSeq, 61)
  assert.equal(latest.newestSeq, 100)
  assert.equal(latest.hasMoreOlder, true)

  const previous = transcriptWindow(messages, { beforeSeq: latest.oldestSeq, limit: 40 })
  assert.equal(previous.messages[0]?.seq, 21)
  assert.equal(previous.messages.at(-1)?.seq, 60)
  assert.equal(previous.hasMoreOlder, true)

  const oldest = transcriptWindow(messages, { beforeSeq: previous.oldestSeq, limit: 40 })
  assert.equal(oldest.messages[0]?.seq, 1)
  assert.equal(oldest.messages.at(-1)?.seq, 20)
  assert.equal(oldest.hasMoreOlder, false)

  const empty = transcriptWindow([], { limit: 40 })
  assert.deepEqual(empty.messages, [])
  assert.equal(empty.hasMoreOlder, false)
})

test("unread and busy counts are server-derived from durable rows", () => {
  const state = createInitialState()
  state.workspaces.w = workspace({ lastActiveAt: 10 })
  state.messages.w = [
    message(1, { createdAt: 4, author: "agent" }),
    message(2, { createdAt: 11, author: "agent" }),
    message(3, { createdAt: 12, author: "user" }),
    message(4, { createdAt: 13, author: "system" }),
  ]
  state.subtasks.working = working({ id: "working" })
  state.subtasks.waiting = task({ id: "waiting" })
  state.subtasks.done = replied({ id: "done" })

  assert.deepEqual(workspaceCounts(state), { w: { unread: 2, busy: 1 } })
})

test("a gap names only the scopes whose durable state changed after the cursor", () => {
  assert.deepEqual(scopesToResync(4, { shell: 4, work: 8, transcript: 5 }), ["work", "transcript"])
  assert.deepEqual(scopesToResync(8, { shell: 4, work: 8, transcript: 5 }), [])
  assert.deepEqual(scopesToResync(undefined, { shell: 4, work: 8, transcript: 5 }), ["shell", "work", "transcript"])
  assert.deepEqual(scopesToResync(4, undefined), ["shell", "work", "transcript"])
})

/**
 * Ticket #172: the Work pane's HISTORY reads retained finished rows. The
 * scoped Work projection stays bounded, but the client keeps terminal rows
 * for the same 24 h the durable store already retains, so a patch or a Work
 * resync cannot erase history.
 */
test("ticket172: retained work keeps finished rows inside the existing retention", () => {
  const now = 10_000_000
  const state = createInitialState()
  state.workspaces.w = workspace()
  state.subtasks.live = working({ id: "live", dispatchGroupID: "dispatch_live", leaseUntil: now + 90_000 })
  state.subtasks.recent = replied({
    id: "recent",
    dispatchGroupID: "dispatch_recent",
    finishedAt: now - 5_000,
    repliedAt: now - 5_000,
  })
  state.subtasks.old = replied({
    id: "old",
    dispatchGroupID: "dispatch_old",
    finishedAt: now - FINISHED_RETENTION_MS - 1,
    repliedAt: now - FINISHED_RETENTION_MS - 1,
  })
  const retained = projectRetainedWork(state, now)
  assert.deepEqual(Object.keys(retained).sort(), ["live", "recent"])
  assert.deepEqual(Object.keys(projectVisibleWork(state, now)), ["live"], "the scoped payload stays bounded")
})

test("ticket172: a Work resync merges retained history instead of replacing it", () => {
  const now = 10_000_000
  const previous = {
    recent: replied({ id: "recent", finishedAt: now - 10, repliedAt: now - 10 }),
    old: replied({ id: "old", finishedAt: now - FINISHED_RETENTION_MS - 1, repliedAt: now - FINISHED_RETENTION_MS - 1 }),
    stale: task({ id: "stale" }),
  }
  const projected = { fresh: working({ id: "fresh" }) }
  const merged = mergeRetainedWork(projected, previous, now)
  assert.deepEqual(Object.keys(merged).sort(), ["fresh", "recent"], "a non-terminal row from the old projection is not resurrected")
})
