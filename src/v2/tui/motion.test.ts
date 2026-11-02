import test from "node:test"
import assert from "node:assert/strict"
import { EMPTY_MARK, LEADER_FRAMES, STREAMING_FRAMES, composerCaret, leaderGlyph, motionActive, streamingFrame } from "./motion.ts"

test("streaming frames cycle deterministically through a fixed sequence", () => {
  assert.deepEqual([...STREAMING_FRAMES], ["◐", "◑", "◒", "◓"])
  assert.equal(streamingFrame(0), "◐")
  assert.equal(streamingFrame(1), "◑")
  assert.equal(streamingFrame(2), "◒")
  assert.equal(streamingFrame(3), "◓")
  assert.equal(streamingFrame(4), "◐")
  assert.equal(streamingFrame(7), "◓")
})

test("streaming frames settle on a still frame when the tick resets", () => {
  assert.equal(streamingFrame(0), STREAMING_FRAMES[0])
  assert.equal(streamingFrame(120), STREAMING_FRAMES[0])
})

test("composer caret blinks only while focused and keeps a constant width", () => {
  assert.equal(composerCaret(true, 0), "▌")
  assert.equal(composerCaret(true, 1), " ")
  assert.equal(composerCaret(true, 2), "▌")
  assert.equal(composerCaret(false, 0), " ")
  assert.equal(composerCaret(false, 1), " ")
  assert.equal(composerCaret(false, 0).length, composerCaret(true, 0).length)
})

test("leader marker pulses while active and rests on a still frame when idle", () => {
  assert.deepEqual([...LEADER_FRAMES], ["●", "○"])
  assert.equal(leaderGlyph(true, 0), "●")
  assert.equal(leaderGlyph(true, 1), "○")
  assert.equal(leaderGlyph(true, 2), "●")
  assert.equal(leaderGlyph(false, 0), "○")
  assert.equal(leaderGlyph(false, 99), "○")
})

test("motion is active only while busy, live, or composing", () => {
  assert.equal(motionActive({ busy: false, live: false, composerActive: false }), false)
  assert.equal(motionActive({ busy: true, live: false, composerActive: false }), true)
  assert.equal(motionActive({ busy: false, live: true, composerActive: false }), true)
  assert.equal(motionActive({ busy: false, live: false, composerActive: true }), true)
})

test("empty states show a one-shot static mark", () => {
  assert.equal(EMPTY_MARK, "○───○───○")
})
