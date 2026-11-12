import test from "node:test"
import assert from "node:assert/strict"
import { NATIVE_INBOX_ORDER_LIMIT, NativeIngestionState } from "./native-state.ts"
import { nativeFinalText } from "./native-turn.ts"

/**
 * Ticket #231: the per-session native state machine. One table case per host
 * event family, so every transition that a family relies on has a named
 * behavioral expectation. These cases exercise the state seam directly; the
 * service suites remain the end-to-end safety net.
 */
type StateCase = {
  family: string
  name: string
  run: (state: NativeIngestionState) => void
  check: (state: NativeIngestionState) => void
}

const cases: StateCase[] = [
  {
    family: "session.inbox.enqueued",
    name: "keeps host order, pending inboxes, and duplicate enqueues",
    run: (state) => {
      state.enqueue("s", { inboxID: "m1", turn: true, pending: true })
      state.enqueue("s", { inboxID: "m0", turn: false })
      state.enqueue("s", { inboxID: "m1", turn: true, pending: true })
    },
    check: (state) => {
      assert.deepEqual(
        state.session("s").order.map((item) => [item.inboxID, item.turn]),
        [["m1", true], ["m0", false]],
      )
      assert.deepEqual(state.session("s").pending, ["m1"])
    },
  },
  {
    family: "session.inbox.enqueued",
    name: "bounds the host order to the newest entries",
    run: (state) => {
      for (let index = 0; index < NATIVE_INBOX_ORDER_LIMIT + 3; index++) {
        state.enqueue("s", { inboxID: `m${index}`, turn: true })
      }
    },
    check: (state) => {
      const order = state.session("s").order
      assert.equal(order.length, NATIVE_INBOX_ORDER_LIMIT)
      assert.equal(order[0]!.inboxID, "m3")
      assert.equal(order.at(-1)!.inboxID, `m${NATIVE_INBOX_ORDER_LIMIT + 2}`)
    },
  },
  {
    family: "session.inbox.enqueued",
    name: "a reordered execution start waits for its enqueue",
    run: (state) => {
      state.waitForExecution("s")
      state.waitForExecution("s")
      assert.equal(state.takePendingExecution("s"), true)
      assert.equal(state.takePendingExecution("s"), true)
      assert.equal(state.takePendingExecution("s"), false)
    },
    check: (state) => {
      assert.equal(state.session("s").pendingExecutions, 0)
    },
  },
  {
    family: "session.inbox.delivered",
    name: "records delivery and queues one steered inbox per delivery",
    run: (state) => {
      state.deliver("s", "m2", "delivered")
      state.steer("s", "m2")
      state.steer("s", "m2")
    },
    check: (state) => {
      assert.equal(state.session("s").delivery.get("m2"), "delivered")
      assert.deepEqual(state.session("s").steered, ["m2"])
      assert.equal(state.takeSteer("s"), "m2")
      assert.equal(state.takeSteer("s"), undefined)
    },
  },
  {
    family: "session.inbox.delivered",
    name: "delivery.changed updates the recorded delivery only",
    run: (state) => {
      state.deliver("s", "m2", "delivered")
      state.deliver("s", "m2", "consumed")
    },
    check: (state) => {
      assert.equal(state.session("s").delivery.get("m2"), "consumed")
      assert.deepEqual(state.session("s").steered, [])
    },
  },
  {
    family: "session.inbox.cancelled",
    name: "settling a cancelled inbox clears its pending slot and order entry",
    run: (state) => {
      state.enqueue("s", { inboxID: "m1", turn: true, pending: true })
      state.enqueue("s", { inboxID: "m2", turn: true, pending: true })
      state.consume("s", "m2")
      state.settle("s", { turnID: "t2", inboxID: "m2" })
    },
    check: (state) => {
      assert.deepEqual(state.session("s").pending, [])
      assert.deepEqual(state.session("s").order.map((item) => item.inboxID), ["m1"])
    },
  },
  {
    family: "session.text.started/delta/ended",
    name: "accumulates text parts and maps every assistant message to its turn",
    run: (state) => {
      state.answer("s", { turnID: "t1", assistantID: "a1", ordinal: 0, type: "started" })
      state.answer("s", { turnID: "t1", assistantID: "a1", ordinal: 0, type: "delta", text: "Hel" })
      state.answer("s", { turnID: "t1", assistantID: "a1", ordinal: 0, type: "delta", text: "lo" })
      state.answer("s", { turnID: "t1", assistantID: "a1", ordinal: 1, type: "ended", text: "second" })
      state.answer("s", { turnID: "t1", assistantID: "a1", ordinal: 0, type: "ended", text: "Hello" })
    },
    check: (state) => {
      assert.equal(state.session("s").assistantTurns.get("a1"), "t1")
      assert.equal(state.displayText("s", "t1"), "Hello\nsecond")
      const text = state.textState("s", "t1")
      assert.ok(text)
      assert.deepEqual(nativeFinalText(text), { text: "Hello\nsecond", complete: true })
    },
  },
  {
    family: "session.text.started/delta/ended",
    name: "a missing ended part is incomplete and keeps the streamed text",
    run: (state) => {
      state.answer("s", { turnID: "t1", assistantID: "a1", ordinal: 0, type: "started" })
      state.answer("s", { turnID: "t1", assistantID: "a1", ordinal: 0, type: "delta", text: "partial" })
    },
    check: (state) => {
      assert.equal(state.displayText("s", "t1"), "partial")
      const text = state.textState("s", "t1")
      assert.ok(text)
      assert.deepEqual(nativeFinalText(text), { text: "", complete: false })
    },
  },
  {
    family: "session.retry.scheduled",
    name: "a retry touch resets the watchdog passes and activity",
    run: (state) => {
      state.touchWatchdog("s", "t1", 10)
      assert.equal(state.beginWatchdogPass("s", "t1", 20), 1)
      assert.equal(state.beginWatchdogPass("s", "t1", 30), 2)
      state.touchWatchdog("s", "t1", 40)
    },
    check: (state) => {
      assert.deepEqual(state.watchdog("s", "t1"), { lastActivityAt: 40, passes: 0 })
    },
  },
  {
    family: "session.execution.started",
    name: "a start opens the execution with its turn and clears steering",
    run: (state) => {
      state.enqueue("s", { inboxID: "m1", turn: true, pending: true })
      state.steer("s", "m2")
      state.start("s", { owner: "turn", turnID: "t1" })
    },
    check: (state) => {
      assert.equal(state.session("s").owner, "turn")
      assert.deepEqual(state.session("s").executionTurns, ["t1"])
      assert.deepEqual(state.session("s").steered, [])
    },
  },
  {
    family: "session.execution.started",
    name: "a repeated start joins an open execution and preserves steering",
    run: (state) => {
      state.start("s", { owner: "turn", turnID: "t1" })
      state.steer("s", "m2")
      state.start("s", { owner: "turn", turnID: "t2", join: true })
    },
    check: (state) => {
      assert.deepEqual(state.session("s").executionTurns, ["t1", "t2"])
      assert.deepEqual(state.session("s").steered, ["m2"])
    },
  },
  {
    family: "session.execution.started",
    name: "a skipped service prompt owns the execution without a turn",
    run: (state) => {
      state.start("s", { owner: "skip" })
    },
    check: (state) => {
      assert.equal(state.session("s").owner, "skip")
      assert.deepEqual(state.session("s").executionTurns, [])
    },
  },
  {
    family: "session.execution.succeeded/failed/interrupted",
    name: "a terminal execution clears participants before per-turn settlement",
    run: (state) => {
      state.start("s", { owner: "turn", turnID: "t1" })
      state.steer("s", "m2")
      state.settle("s", { execution: true })
      assert.equal(state.session("s").owner, "turn", "execution settlement leaves ownership to the turns")
      state.settle("s", { turnID: "t1", inboxID: "m1" })
    },
    check: (state) => {
      assert.equal(state.session("s").owner, undefined)
      assert.deepEqual(state.session("s").executionTurns, [])
      assert.deepEqual(state.session("s").steered, [])
    },
  },
  {
    family: "session.execution.succeeded/failed/interrupted",
    name: "a skipped terminal clears the owner and execution bookkeeping",
    run: (state) => {
      state.start("s", { owner: "skip" })
      state.markRunSettled("s", "run_1")
      state.start("s", {})
    },
    check: (state) => {
      assert.equal(state.session("s").owner, undefined)
      assert.equal(state.session("s").runSettled, "run_1")
      assert.deepEqual(state.session("s").executionTurns, [])
    },
  },
  {
    family: "session.execution.started",
    name: "the active turn and pending execution count are explicit",
    run: (state) => {
      state.setActiveTurn("s", "t1")
      state.waitForExecution("s")
    },
    check: (state) => {
      assert.equal(state.session("s").activeTurn, "t1")
      assert.equal(state.session("s").pendingExecutions, 1)
      state.clearActiveTurn("s")
      assert.equal(state.session("s").activeTurn, undefined)
    },
  },
  {
    family: "reconcile/adoption",
    name: "adoption re-queues the inbox and re-arms its watchdog",
    run: (state) => {
      state.reconcile("s", { inboxID: "m1", turnID: "t1", at: 10 })
    },
    check: (state) => {
      assert.deepEqual(state.session("s").order.map((item) => item.inboxID), ["m1"])
      assert.deepEqual(state.session("s").pending, ["m1"])
      assert.ok(state.watchdog("s", "t1"))
    },
  },
  {
    family: "reconcile/adoption",
    name: "a transcript answer replaces every partial text part",
    run: (state) => {
      state.answer("s", { turnID: "t1", assistantID: "a1", ordinal: 0, type: "delta", text: "partial" })
      state.seedAnswer("s", "t1", "a2", "Recovered answer")
    },
    check: (state) => {
      const text = state.textState("s", "t1")
      assert.ok(text)
      assert.deepEqual(nativeFinalText(text), { text: "Recovered answer", complete: true })
      assert.deepEqual(state.displayText("s", "t1"), "Recovered answer")
    },
  },
  {
    family: "turn deletion",
    name: "deleteTurn releases text, row, watchdog, deferred settlement, and mappings",
    run: (state) => {
      state.start("s", { owner: "turn", turnID: "t1" })
      state.answer("s", { turnID: "t1", assistantID: "a1", ordinal: 0, type: "ended", text: "answer" })
      state.touchWatchdog("s", "t1", 10)
      state.setRow("s", "t1", { message: { id: "row" } as any, channel: "w", lastSave: 1 })
      state.defer("s", "t1", { target: {} as any, at: 1, deadline: 2 })
      state.deleteTurn("s", "t1")
    },
    check: (state) => {
      assert.equal(state.textState("s", "t1"), undefined)
      assert.equal(state.row("s", "t1"), undefined)
      assert.equal(state.watchdog("s", "t1"), undefined)
      assert.equal(state.deferred("s", "t1"), undefined)
      assert.deepEqual(state.session("s").executionTurns, [])
      assert.equal(state.session("s").assistantTurns.size, 0)
    },
  },
  {
    family: "session deletion",
    name: "deleteSession drops the whole per-session value",
    run: (state) => {
      state.enqueue("s", { inboxID: "m1", turn: true, pending: true })
      state.deleteSession("s")
    },
    check: (state) => {
      assert.equal(state.peek("s"), undefined)
    },
  },
]

for (const entry of cases) {
  test(`ticket231 native state: ${entry.family} — ${entry.name}`, () => {
    const state = new NativeIngestionState()
    entry.run(state)
    entry.check(state)
  })
}

test("ticket231 native state: sessions are isolated", () => {
  const state = new NativeIngestionState()
  state.enqueue("a", { inboxID: "m1", turn: true, pending: true })
  state.start("a", { owner: "turn", turnID: "t1" })
  state.enqueue("b", { inboxID: "m2", turn: true, pending: true })
  assert.deepEqual(state.session("a").pending, ["m1"])
  assert.deepEqual(state.session("b").pending, ["m2"])
  assert.deepEqual(state.session("a").executionTurns, ["t1"])
  assert.deepEqual(state.session("b").executionTurns, [])
  state.deleteSession("a")
  assert.equal(state.peek("a"), undefined)
  assert.ok(state.peek("b"))
})
