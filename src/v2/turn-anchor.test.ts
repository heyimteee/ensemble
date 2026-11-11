import test from "node:test"
import assert from "node:assert/strict"
import { resolveActiveTurnAnchor } from "./turn-anchor.ts"
import type { Subtask } from "./types.ts"

/**
 * Ticket #236: one active-turn anchor.
 *
 * Resolution order: a live managed run wins, then the session's open native
 * turn, and only when neither exists does the legacy newest-open-sender-task
 * fallback apply. Every candidate is validated against the workspace and agent
 * that made the call, so a stale or foreign turn can never own the work.
 * Parent, dispatch group, depth, and the contact ledger all come from the
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

function anchorFor(input: {
  runTask?: Subtask
  nativeTurn?: Subtask
  fallbackTask?: Subtask
  subtasks: Record<string, Subtask>
  workspaceID?: string
  agentID?: string
}) {
  return resolveActiveTurnAnchor({
    workspaceID: input.workspaceID ?? "w",
    agentID: input.agentID ?? "a",
    ...input,
  })
}

test("ticket236: a managed run wins over an open native turn and the fallback", () => {
  const runTask = task("t_run", { dispatchGroupID: "g_run", dispatchDepth: 2 })
  const nativeTurn = task("t_native", { origin: "native", native: { sessionID: "s", assistantMessageIDs: [], phase: "working" } })
  const fallback = task("t_fallback")
  const anchor = anchorFor({
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
  assert.deepEqual(anchor.contacted, [])
})

test("ticket236: the open native turn wins over the fallback and carries its ledger", () => {
  const nativeTurn = task("t_native", {
    origin: "native",
    dispatchGroupID: "g_native",
    native: { sessionID: "s", assistantMessageIDs: [], phase: "working", contacted: ["b", "c"] },
  })
  const fallback = task("t_fallback", { dispatchGroupID: "g_old" })
  const anchor = anchorFor({
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
  const anchor = anchorFor({ fallbackTask: fallback, subtasks: { t_open: fallback } })
  assert.ok(anchor)
  assert.equal(anchor.source, "fallback")
  assert.equal(anchor.task.id, "t_open")
  assert.equal(anchor.dispatchGroupID, "g_open")
  assert.equal(anchor.depth, 1)
})

test("ticket236: no run, turn, or open task resolves no anchor instead of inventing one", () => {
  assert.equal(anchorFor({ subtasks: {} }), undefined)
})

test("ticket236: a turn from another workspace or another agent never owns the call", () => {
  const foreignWorkspace = task("t_foreign_workspace", {
    origin: "native",
    workspaceID: "other",
    native: { sessionID: "s", assistantMessageIDs: [], phase: "working" },
  })
  const foreignAgent = task("t_foreign_agent", {
    origin: "native",
    assigneeID: "z",
    native: { sessionID: "s", assistantMessageIDs: [], phase: "working" },
  })
  const subtasks = { t_foreign_workspace: foreignWorkspace, t_foreign_agent: foreignAgent }
  assert.equal(anchorFor({ nativeTurn: foreignWorkspace, subtasks }), undefined, "a wrong-workspace turn is ignored")
  assert.equal(anchorFor({ nativeTurn: foreignAgent, subtasks }), undefined, "a wrong-agent turn is ignored")
  assert.equal(anchorFor({ runTask: foreignAgent, subtasks }), undefined, "a wrong-agent managed run is ignored")
})

test("ticket236: a workspace direct turn belongs to its workspace; a home direct turn does not", () => {
  const direct = task("t_direct", {
    origin: "native",
    workspaceID: "dm:a:w",
    conversationID: "dm:a:w",
    dispatchGroupID: "g_direct",
    native: { sessionID: "s", assistantMessageIDs: [], phase: "working" },
  })
  const home = task("t_home", {
    origin: "native",
    workspaceID: "dm:a",
    conversationID: "dm:a",
    native: { sessionID: "s", assistantMessageIDs: [], phase: "working" },
  })
  const subtasks = { t_direct: direct, t_home: home }
  const anchor = anchorFor({ nativeTurn: direct, subtasks })
  assert.ok(anchor)
  assert.equal(anchor.source, "native")
  assert.equal(anchor.task.id, "t_direct", "a workspace DM turn anchors work for its own workspace")
  assert.equal(anchor.dispatchGroupID, "g_direct")
  assert.equal(anchorFor({ nativeTurn: home, subtasks }), undefined, "a home DM turn has no workspace ownership")
})

test("ticket236: a legacy task without a stored group resolves one deterministic group, never a fresh root", () => {
  const legacy = task("t_legacy")
  const first = anchorFor({ runTask: legacy, subtasks: { t_legacy: legacy } })
  const second = anchorFor({ runTask: legacy, subtasks: { t_legacy: legacy } })
  assert.ok(first && second)
  assert.ok(first.dispatchGroupID, "legacy rows resolve a deterministic group from their root")
  assert.equal(first.dispatchGroupID, second.dispatchGroupID, "replayed resolution never mints a new group")
  assert.equal(first.depth, 0)
  assert.deepEqual(first.contacted, [])
})
