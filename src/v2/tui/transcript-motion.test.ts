import test from "node:test"
import assert from "node:assert/strict"
import {
  TRANSCRIPT_EMPHASIS_MS,
  createTranscriptMotionState,
  observeTranscriptMotion,
} from "./transcript-motion.ts"

test("a streaming agent message settles exactly once when it finalizes", () => {
  const state = createTranscriptMotionState()
  assert.deepEqual(observeTranscriptMotion(state, [{ id: "m1", streaming: true }]), [])
  assert.deepEqual(observeTranscriptMotion(state, [{ id: "m1" }]), [{ id: "m1", kind: "finalized" }])
  // Every later snapshot poll observes the same finalized row.
  assert.deepEqual(observeTranscriptMotion(state, [{ id: "m1" }]), [])
  assert.deepEqual(observeTranscriptMotion(state, [{ id: "m1" }]), [])
})

test("finalized history that was never observed streaming does not flash", () => {
  const state = createTranscriptMotionState()
  assert.deepEqual(observeTranscriptMotion(state, [{ id: "old" }]), [])
  assert.deepEqual(observeTranscriptMotion(state, [{ id: "old" }]), [])
})

test("a final row that explicitly enters after a live row settles once", () => {
  // Direct conversations have no streaming flag on the persisted chat line;
  // the app marks the finalized row that follows a live DM stream.
  const state = createTranscriptMotionState()
  assert.deepEqual(
    observeTranscriptMotion(state, [{ id: "dm-final", entering: true }]),
    [{ id: "dm-final", kind: "finalized" }],
  )
  assert.deepEqual(observeTranscriptMotion(state, [{ id: "dm-final", entering: true }]), [])
})

test("failed and cancelled outcomes emphasize once", () => {
  const state = createTranscriptMotionState()
  assert.deepEqual(
    observeTranscriptMotion(state, [
      { id: "done:failed", error: true },
      { id: "done:cancelled", error: true },
    ]),
    [
      { id: "done:failed", kind: "error" },
      { id: "done:cancelled", kind: "error" },
    ],
  )
  // Snapshot polls repeat both rows; neither emphasis restarts.
  assert.deepEqual(
    observeTranscriptMotion(state, [
      { id: "done:failed", error: true },
      { id: "done:cancelled", error: true },
    ]),
    [],
  )
})

test("an interrupted finalize emits one error emphasis instead of a settle", () => {
  const state = createTranscriptMotionState()
  assert.deepEqual(observeTranscriptMotion(state, [{ id: "m1", streaming: true, error: true }]), [])
  assert.deepEqual(observeTranscriptMotion(state, [{ id: "m1", error: true }]), [{ id: "m1", kind: "error" }])
  assert.deepEqual(observeTranscriptMotion(state, [{ id: "m1", error: true }]), [])
})

test("reduced motion records final state without emitting a later flash", () => {
  const state = createTranscriptMotionState()
  assert.deepEqual(observeTranscriptMotion(state, [{ id: "m1", streaming: true }], { enabled: false }), [])
  assert.deepEqual(observeTranscriptMotion(state, [{ id: "m1" }], { enabled: false }), [])
  assert.deepEqual(observeTranscriptMotion(state, [{ id: "done:failed", error: true }], { enabled: false }), [])
  // Turning the gate back on never replays a missed flash.
  assert.deepEqual(observeTranscriptMotion(state, [{ id: "m1" }, { id: "done:failed", error: true }]), [])
})

test("the emphasis beat is brief", () => {
  assert.ok(TRANSCRIPT_EMPHASIS_MS > 0)
  assert.ok(TRANSCRIPT_EMPHASIS_MS <= 1000)
})
