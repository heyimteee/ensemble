import test from "node:test"
import assert from "node:assert/strict"
import {
  RAIL_APPROVAL_ID,
  RAIL_ARRIVAL_MS,
  RAIL_PULSE_MS,
  observeRailAttention,
  railArrivalActive,
  railEmphasisAt,
  railPulseActive,
  railRowKey,
  type RailPulseStart,
} from "./rail.ts"

const snapshot = (patch: { unread?: Record<string, number>; approvals?: number; rows?: string[] } = {}) => ({
  unread: patch.unread ?? {},
  approvals: patch.approvals ?? 0,
  rows: patch.rows ?? [],
})

test("rail attention baselines the first observation without pulsing", () => {
  const first = observeRailAttention(null, snapshot({
    unread: { w1: 2 },
    approvals: 1,
    rows: [railRowKey("workspace", "w1"), railRowKey("agent", "a1")],
  }))
  assert.deepEqual(first.pulses, [])
  assert.equal(first.state.approvals, 1)
})

test("rail unread pulses once when a workspace count grows", () => {
  const baseline = observeRailAttention(null, snapshot({ unread: { w1: 1 }, rows: [railRowKey("workspace", "w1")] }))
  const grown = observeRailAttention(baseline.state, snapshot({ unread: { w1: 2 }, rows: [railRowKey("workspace", "w1")] }))
  assert.deepEqual(grown.pulses, [{ kind: "unread", id: "w1" }])

  const unchanged = observeRailAttention(grown.state, snapshot({ unread: { w1: 2 }, rows: [railRowKey("workspace", "w1")] }))
  assert.deepEqual(unchanged.pulses, [], "a repeated snapshot never restarts the pulse")

  const shrunk = observeRailAttention(unchanged.state, snapshot({ unread: { w1: 0 }, rows: [railRowKey("workspace", "w1")] }))
  assert.deepEqual(shrunk.pulses, [], "reading a workspace never pulses")
})

test("rail approval count pulses once when pending approvals grow", () => {
  const baseline = observeRailAttention(null, snapshot({ approvals: 1 }))
  const grown = observeRailAttention(baseline.state, snapshot({ approvals: 2 }))
  assert.deepEqual(grown.pulses, [{ kind: "approval", id: RAIL_APPROVAL_ID }])

  const unchanged = observeRailAttention(grown.state, snapshot({ approvals: 2 }))
  assert.deepEqual(unchanged.pulses, [])

  const resolved = observeRailAttention(unchanged.state, snapshot({ approvals: 1 }))
  assert.deepEqual(resolved.pulses, [], "resolving an approval never pulses")
})

test("rail arrival marks only rows that appear after the baseline", () => {
  const baseline = observeRailAttention(null, snapshot({ rows: [railRowKey("workspace", "w1")] }))
  const added = observeRailAttention(baseline.state, snapshot({
    rows: [railRowKey("workspace", "w1"), railRowKey("agent", "a1")],
  }))
  assert.deepEqual(added.pulses, [{ kind: "arrival", id: railRowKey("agent", "a1") }])

  const again = observeRailAttention(added.state, snapshot({
    rows: [railRowKey("workspace", "w1"), railRowKey("agent", "a1")],
  }))
  assert.deepEqual(again.pulses, [], "a row settles after its one arrival")
})

test("rail pulses are one-shot windows that settle and never loop", () => {
  assert.ok(RAIL_PULSE_MS > 0 && RAIL_PULSE_MS <= 1_000, "an attention pulse stays short")
  assert.ok(RAIL_ARRIVAL_MS > RAIL_PULSE_MS, "a quiet arrival settles a little longer than an attention pulse")

  assert.equal(railPulseActive(0, {}), true)
  assert.equal(railPulseActive(RAIL_PULSE_MS - 1, {}), true)
  assert.equal(railPulseActive(RAIL_PULSE_MS, {}), false, "the pulse settles at its deadline")
  assert.equal(railPulseActive(RAIL_PULSE_MS * 10, {}), false, "later reads never restart the pulse")

  assert.equal(railArrivalActive(0, {}), true)
  assert.equal(railArrivalActive(RAIL_ARRIVAL_MS - 1, {}), true)
  assert.equal(railArrivalActive(RAIL_ARRIVAL_MS, {}), false)
  assert.equal(railArrivalActive(RAIL_ARRIVAL_MS * 10, {}), false)
})

test("reduced motion suppresses rail pulses and mounts arrivals settled", () => {
  const reduced = { ENSEMBLE_REDUCED_MOTION: "1" }
  const noColor = { NO_COLOR: "1" }
  assert.equal(railPulseActive(0, reduced), false)
  assert.equal(railArrivalActive(0, reduced), false)
  assert.equal(railPulseActive(0, noColor), false)
  assert.equal(railArrivalActive(0, noColor), false)
  assert.equal(railPulseActive(0, { ENSEMBLE_REDUCED_MOTION: "0" }), true)

  const starts: RailPulseStart[] = [
    { pulse: { kind: "unread", id: "w1" }, startedAt: 1_000 },
    { pulse: { kind: "approval", id: RAIL_APPROVAL_ID }, startedAt: 1_000 },
    { pulse: { kind: "arrival", id: railRowKey("agent", "a1") }, startedAt: 1_000 },
  ]
  const emphasis = railEmphasisAt(starts, 1_100, reduced)
  assert.deepEqual([...emphasis.unread], [])
  assert.equal(emphasis.approval, false)
  assert.deepEqual([...emphasis.arrivals], [], "arrivals mount at their final tone, never in a dim state")
})

test("rail emphasis maps active starts to unread, approval, and arrival sets", () => {
  const starts: RailPulseStart[] = [
    { pulse: { kind: "unread", id: "w1" }, startedAt: 1_000 },
    { pulse: { kind: "approval", id: RAIL_APPROVAL_ID }, startedAt: 1_000 },
    { pulse: { kind: "arrival", id: railRowKey("agent", "a1") }, startedAt: 1_000 },
  ]
  const early = railEmphasisAt(starts, 1_100, {})
  assert.deepEqual([...early.unread], ["w1"])
  assert.equal(early.approval, true)
  assert.deepEqual([...early.arrivals], [railRowKey("agent", "a1")])

  const settledPulse = railEmphasisAt(starts, 1_000 + RAIL_PULSE_MS, {})
  assert.deepEqual([...settledPulse.unread], [], "the unread pulse ended")
  assert.equal(settledPulse.approval, false, "the approval pulse ended")
  assert.deepEqual([...settledPulse.arrivals], [railRowKey("agent", "a1")], "arrival still settling is quiet, not moving")

  const allSettled = railEmphasisAt(starts, 1_000 + RAIL_ARRIVAL_MS, {})
  assert.deepEqual([...allSettled.unread], [])
  assert.equal(allSettled.approval, false)
  assert.deepEqual([...allSettled.arrivals], [])
})
