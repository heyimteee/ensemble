import test from "node:test"
import assert from "node:assert/strict"
import { resolveActiveTurnAnchor } from "./turn-anchor.ts"
import type { Subtask } from "./types.ts"

/**
 * Ticket #236: one active-turn anchor.
 *
 * Resolution order: a live managed run wins, then the session's open native
 * turn, and only when neither exists does the legacy newest-open-sender-task
 * fallback apply. Everything a tool needs to join that ownership (parent,
 * dispatch group, depth, and the anchor's granted task budget) comes from the
 * returned record, so a tool call cannot create parentless work or an
 * unrelated dispatch group while an open turn exists.
 */

function task(id: string, input: Partial<Subtask> = {}): Subtask {
  return {
    id,
    workspaceID: "w",
    creatorType: "user",
    assigneeID: "a",
    title: id,
    instruction: id,
    mode: "research",
    state: "working",
    stage: "initial",
    outcome: "pending",
    interrupted: false,
    awaitingChildren: false,
    attempts: 1,
    createdAt: 1,
    ...input,
  }
}

test("ticket236: a managed run wins over an open native turn and the fallback", () => {
  const runTask = task("t_run", { dispatchGroupID: "g_run", dispatchDepth: 2, taskMaxHops: 3 })
  const nativeTurn = task("t_native", { origin: "native", native: { sessionID: "s", assistantMessageIDs: [], phase: "working" } })
  const fallback = task("t_fallback")
  const anchor = resolveActiveTurnAnchor({
    runTask,
    nativeTurn,
    fallbackTask: fallback,
    subtasks: { t_run: runTask, t_native: nativeTurn, t_fallback: fallback },
  })
  assert.ok(anchor)
  assert.equal(anchor.source, "run")
  assert.equal(anchor.task.id, "t_run")
  assert.equal(anchor.parentID, "t_run", "work created by the call is parented to the anchor")
  assert.equal(anchor.dispatchGroupID, "g_run")
  assert.equal(anchor.depth, 2)
  assert.equal(anchor.taskMaxHops, 3)
  assert.deepEqual(anchor.contacted, [])
})

test("ticket236: the open native turn wins over the fallback and carries its ledger", () => {
  const nativeTurn = task("t_native", {
    origin: "native",
    dispatchGroupID: "g_native",
    native: { sessionID: "s", assistantMessageIDs: [], phase: "working", contacted: ["b", "c"] },
  })
  const fallback = task("t_fallback", { dispatchGroupID: "g_old" })
  const anchor = resolveActiveTurnAnchor({
    nativeTurn,
    fallbackTask: fallback,
    subtasks: { t_native: nativeTurn, t_fallback: fallback },
  })
  assert.ok(anchor)
  assert.equal(anchor.source, "native")
  assert.equal(anchor.task.id, "t_native")
  assert.equal(anchor.parentID, "t_native")
  assert.equal(anchor.dispatchGroupID, "g_native")
  assert.deepEqual([...anchor.contacted], ["b", "c"])
})

test("ticket236: the sender's newest open task is the last resort only", () => {
  const fallback = task("t_open", { dispatchGroupID: "g_open", dispatchDepth: 1 })
  const anchor = resolveActiveTurnAnchor({ fallbackTask: fallback, subtasks: { t_open: fallback } })
  assert.ok(anchor)
  assert.equal(anchor.source, "fallback")
  assert.equal(anchor.task.id, "t_open")
  assert.equal(anchor.dispatchGroupID, "g_open")
  assert.equal(anchor.depth, 1)
})

test("ticket236: no run, turn, or open task resolves no anchor instead of inventing one", () => {
  assert.equal(resolveActiveTurnAnchor({ subtasks: {} }), undefined)
})

test("ticket236: a legacy task without a stored group resolves one deterministic group, never a fresh root", () => {
  const legacy = task("t_legacy")
  const first = resolveActiveTurnAnchor({ runTask: legacy, subtasks: { t_legacy: legacy } })
  const second = resolveActiveTurnAnchor({ runTask: legacy, subtasks: { t_legacy: legacy } })
  assert.ok(first && second)
  assert.ok(first.dispatchGroupID, "legacy rows resolve a deterministic group from their root")
  assert.equal(first.dispatchGroupID, second.dispatchGroupID, "replayed resolution never mints a new group")
  assert.equal(first.depth, 0)
  assert.deepEqual(first.contacted, [])
  assert.equal(first.taskMaxHops, undefined)
})
