import test from "node:test"
import assert from "node:assert/strict"
import { V2Store } from "./store.ts"
import { createLogger } from "./logging.ts"
import { createStoreObserver } from "./log-events.ts"
import type { Approval, Subtask, Workspace } from "./types.ts"

function fakeContext() {
  const values = new Map<string, unknown>()
  return {
    storage: {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: unknown) => { values.set(key, value) },
      remove: async (key: string) => { values.delete(key) },
      scan: async ({ prefix, after, limit }: any) => {
        const entries = [...values.entries()]
          .filter(([key]) => key.startsWith(prefix) && (!after || key > after))
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, limit ?? 500)
          .map(([key, value]) => ({ key, value }))
        return { entries, next: entries.length === (limit ?? 500) ? entries.at(-1)?.key : undefined }
      },
    },
  }
}

const logger = () => createLogger({ role: "service", dir: null, level: "debug", ringSize: 200 })

const workspace = (): Workspace => ({
  id: "w", name: "site", directory: "/repo", leaderID: "a", memberIDs: ["a"], synthesis: true,
  archived: false, paused: false, nextSeq: 1, createdAt: 1, lastActiveAt: 1,
})

const subtask = (patch: Partial<Subtask> = {}): Subtask => ({
  id: "t", workspaceID: "w", creatorType: "user", title: "Task", instruction: "Do", mode: "research",
  state: "pending", stage: "initial", outcome: "pending", interrupted: false, awaitingChildren: false, attempts: 0, createdAt: 1, ...patch,
})

function setup() {
  const log = logger()
  const store = new V2Store(fakeContext(), undefined, { observer: createStoreObserver(log) })
  return { log, store }
}

test("task observer logs created, transition, completion, and ignores lease heartbeats", async () => {
  const { log, store } = setup()
  await store.saveWorkspace(workspace())
  await store.saveSubtask(subtask())
  await store.saveSubtask(subtask({ state: "working", claimedBy: "run_1", leaseUntil: 100 }))
  await store.saveSubtask(subtask({ state: "working", claimedBy: "run_1", leaseUntil: 200 }))
  await store.saveSubtask(subtask({ state: "replied", outcome: "succeeded", resultMessageID: "m1", runSummary: "no tool calls" }))

  const events = log.recent().map((entry) => entry.event)
  assert.deepEqual(events, ["task.created", "task.transition", "task.completed"])
  assert.equal(log.recent({ event: "task.transition" }).length, 1)
  const transition = log.recent({ event: "task.transition" })[0] as any
  assert.equal(transition.fromState, "pending")
  assert.equal(transition.toState, "working")
  assert.equal(transition.attempts, 0)
})

test("task observer keeps failure and cancellation distinct", async () => {
  const { log, store } = setup()
  await store.saveWorkspace(workspace())
  await store.saveSubtask(subtask({ id: "fail", state: "working" }))
  await store.saveSubtask(subtask({ id: "fail", state: "replied", outcome: "failed", error: "provider exploded" }))
  await store.saveSubtask(subtask({ id: "cancel", state: "working" }))
  await store.saveSubtask(subtask({ id: "cancel", state: "replied", outcome: "failed", stoppedAt: 5, error: "Cancelled by user." }))

  assert.equal(log.recent({ event: "task.failed" })[0]?.level, "error")
  assert.equal(log.recent({ event: "task.cancelled" }).length, 1)
  assert.equal((log.recent({ event: "task.cancelled" })[0] as any).reason, "Cancelled by user.")
})

test("message observer logs append and finalize, and skips same-length streaming churn", async () => {
  const { log, store } = setup()
  await store.saveWorkspace(workspace())
  const stream = await store.appendMessage("w", { id: "m1", author: "agent", text: "", kind: "text", streaming: true, createdAt: 1 })
  await store.saveMessage({ ...stream, text: "answer", streaming: false, updatedAt: 1 })

  assert.deepEqual(log.recent().map((entry) => entry.event), ["message.appended", "message.finalized"])
  const appended = log.recent()[0] as any
  assert.equal(appended.messageID, "m1")
  assert.equal(appended.chars, 0)
  assert.equal(appended.streaming, true)
  const finalized = log.recent()[1] as any
  assert.equal(finalized.chars, 6)
  assert.equal(finalized.interrupted, false)
})

test("approval observer logs request and resolution", async () => {
  const { log, store } = setup()
  await store.saveWorkspace(workspace())
  const pending: Approval = { id: "ap", workspaceID: "w", kind: "ask_person", title: "Ask", detail: "?", status: "pending", createdAt: 1 }
  await store.saveApproval(pending)
  await store.saveApproval({ ...pending, status: "approved", resolvedAt: 2, resolution: "Approved by user." })

  assert.deepEqual(log.recent().map((entry) => entry.event), ["approval.requested", "approval.resolved"])
  assert.equal((log.recent()[1] as any).fromStatus, "pending")
  assert.equal((log.recent()[1] as any).status, "approved")
})
