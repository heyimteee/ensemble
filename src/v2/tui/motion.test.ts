import test from "node:test"
import assert from "node:assert/strict"
import {
  EMPTY_MARK,
  STREAMING_FRAMES,
  THINKING_FRAMES,
  TOOL_FRAMES,
  WAITING_FRAMES,
  WORKING_FRAMES,
  effectiveTick,
  isReducedMotion,
  motionActive,
  queuedFrame,
  shouldRunMotion,
  streamingFrame,
  thinkingFrame,
  toolFrame,
  waitingFrame,
  workingFrame,
} from "./motion.ts"

const idle = { busy: false, live: false, composerActive: false }

test("named frame sets match the brief's normative glyphs", () => {
  assert.deepEqual([...WORKING_FRAMES], ["◐", "◑", "◒", "◓"])
  assert.deepEqual([...WAITING_FRAMES], ["○", "◌"])
  assert.deepEqual([...TOOL_FRAMES], ["▸", "▹"])
  assert.deepEqual([...THINKING_FRAMES], ["·  ", "˙  ", " ⋮ ", "·  "])
  assert.equal(queuedFrame(), "○")
  // Legacy alias keeps compiling and resolves to the working set.
  assert.deepEqual([...STREAMING_FRAMES], [...WORKING_FRAMES])
})

test("each frame set is constant-width (no reflow)", () => {
  for (const frames of [WORKING_FRAMES, WAITING_FRAMES, TOOL_FRAMES, THINKING_FRAMES]) {
    const widths = new Set(frames.map((frame) => [...frame].length))
    assert.equal(widths.size, 1, `frames vary in width: ${JSON.stringify(frames)}`)
  }
})

test("frames cycle deterministically with modular wrap", () => {
  assert.equal(workingFrame(0), "◐")
  assert.equal(workingFrame(1), "◑")
  assert.equal(workingFrame(2), "◒")
  assert.equal(workingFrame(3), "◓")
  assert.equal(workingFrame(4), "◐")
  assert.equal(workingFrame(7), "◓")
  assert.equal(workingFrame(-1), "◓")
  assert.equal(waitingFrame(0), "○")
  assert.equal(waitingFrame(1), "◌")
  assert.equal(waitingFrame(2), "○")
  assert.equal(waitingFrame(-1), "◌")
  assert.equal(toolFrame(0), "▸")
  assert.equal(toolFrame(1), "▹")
  assert.equal(toolFrame(2), "▸")
  assert.equal(toolFrame(-1), "▹")
  assert.equal(thinkingFrame(0), "·  ")
  assert.equal(thinkingFrame(4), thinkingFrame(0))
  assert.equal(streamingFrame(1), workingFrame(1))
})

test("tick 120 is a still frame for every animated set", () => {
  assert.equal(workingFrame(0), WORKING_FRAMES[0])
  assert.equal(workingFrame(120), WORKING_FRAMES[0])
  assert.equal(waitingFrame(120), WAITING_FRAMES[0])
  assert.equal(toolFrame(120), TOOL_FRAMES[0])
  assert.equal(thinkingFrame(120), THINKING_FRAMES[0])
})

test("queued frame is static across ticks", () => {
  for (let tick = 0; tick < 8; tick++) assert.equal(queuedFrame(), "○")
})

test("motion is active only while busy, live, or composing", () => {
  assert.equal(motionActive(idle), false)
  assert.equal(motionActive({ busy: true, live: false, composerActive: false }), true)
  assert.equal(motionActive({ busy: false, live: true, composerActive: false }), true)
  assert.equal(motionActive({ busy: false, live: false, composerActive: true }), true)
})

test("reduced-motion gate honors ENSEMBLE_REDUCED_MOTION and NO_COLOR", () => {
  assert.equal(isReducedMotion({}), false)
  assert.equal(isReducedMotion({ ENSEMBLE_REDUCED_MOTION: "1" }), true)
  assert.equal(isReducedMotion({ ENSEMBLE_REDUCED_MOTION: "true" }), true)
  assert.equal(isReducedMotion({ ENSEMBLE_REDUCED_MOTION: "TRUE" }), true)
  assert.equal(isReducedMotion({ ENSEMBLE_REDUCED_MOTION: "0" }), false)
  assert.equal(isReducedMotion({ NO_COLOR: "" }), true)
  assert.equal(isReducedMotion({ NO_COLOR: "1" }), true)
})

test("effective tick pins to frame 0 under reduced motion", () => {
  assert.equal(effectiveTick(5, {}), 5)
  assert.equal(effectiveTick(5, { ENSEMBLE_REDUCED_MOTION: "1" }), 0)
  assert.equal(effectiveTick(5, { NO_COLOR: "1" }), 0)
  assert.equal(workingFrame(effectiveTick(3, { ENSEMBLE_REDUCED_MOTION: "1" })), "◐")
  assert.equal(waitingFrame(effectiveTick(1, { NO_COLOR: "1" })), "○")
  assert.equal(toolFrame(effectiveTick(1, { ENSEMBLE_REDUCED_MOTION: "1" })), "▸")
})

test("motion clock runs only while active and never under reduced motion", () => {
  assert.equal(shouldRunMotion(idle, {}), false)
  assert.equal(shouldRunMotion({ busy: true, live: false, composerActive: false }, {}), true)
  assert.equal(shouldRunMotion({ busy: false, live: true, composerActive: false }, {}), true)
  assert.equal(shouldRunMotion({ busy: false, live: false, composerActive: true }, {}), true)
  assert.equal(shouldRunMotion({ busy: true, live: true, composerActive: true }, { ENSEMBLE_REDUCED_MOTION: "1" }), false)
  assert.equal(shouldRunMotion({ busy: true, live: false, composerActive: false }, { NO_COLOR: "1" }), false)
  // Idle-quiescence: no active/live/composing means no interval, even animated.
  assert.equal(shouldRunMotion(idle, { ENSEMBLE_REDUCED_MOTION: "1" }), false)
})

test("empty states show a one-shot static mark", () => {
  assert.equal(EMPTY_MARK, "○───○───○")
})
