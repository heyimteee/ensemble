import test from "node:test"
import assert from "node:assert/strict"
import {
  EMPTY_MARK,
  STAGGER_CAP,
  STAGGER_STEP_MS,
  THINKING_FRAMES,
  TOOL_FRAMES,
  WAITING_FRAMES,
  WORKING_FRAMES,
  WORK_CLOCK_INTERVAL_MS,
  createStaggerState,
  effectiveTick,
  isReducedMotion,
  motionActive,
  queuedFrame,
  shouldRunMotion,
  shouldRunWorkClock,
  staggerDelayMs,
  thinkingFrame,
  toolFrame,
  updateStagger,
  waitingFrame,
  workingFrame,
} from "./motion.ts"

const idle = { busy: false, live: false, composerActive: false }

test("named frame sets match the brief's normative glyphs", () => {
  assert.deepEqual([...WORKING_FRAMES], ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"])
  assert.deepEqual([...WAITING_FRAMES], ["▫", "▪"])
  assert.deepEqual([...TOOL_FRAMES], ["▸", "▹"])
  assert.deepEqual([...THINKING_FRAMES], ["·  ", "˙  ", " ⋮ ", "·  "])
  assert.equal(queuedFrame(), "▫")
})

test("working frames are ten distinct one-cell Braille glyphs", () => {
  assert.equal(WORKING_FRAMES.length, 10)
  assert.equal(new Set(WORKING_FRAMES).size, 10)
  for (const frame of WORKING_FRAMES) {
    assert.equal([...frame].length, 1, `${frame} is one cell wide`)
    assert.match(frame, /^[\u2800-\u28ff]$/)
  }
})

test("each frame set is constant-width (no reflow)", () => {
  for (const frames of [WORKING_FRAMES, WAITING_FRAMES, TOOL_FRAMES, THINKING_FRAMES]) {
    const widths = new Set(frames.map((frame) => [...frame].length))
    assert.equal(widths.size, 1, `frames vary in width: ${JSON.stringify(frames)}`)
  }
})

test("frames cycle deterministically with modular wrap", () => {
  assert.equal(workingFrame(0), "⠋")
  assert.equal(workingFrame(1), "⠙")
  assert.equal(workingFrame(2), "⠹")
  assert.equal(workingFrame(3), "⠸")
  assert.equal(workingFrame(4), "⠼")
  assert.equal(workingFrame(5), "⠴")
  assert.equal(workingFrame(6), "⠦")
  assert.equal(workingFrame(7), "⠧")
  assert.equal(workingFrame(8), "⠇")
  assert.equal(workingFrame(9), "⠏")
  assert.equal(workingFrame(10), "⠋")
  assert.equal(workingFrame(17), "⠧")
  assert.equal(workingFrame(-1), "⠏")
  assert.equal(waitingFrame(0), "▫")
  assert.equal(waitingFrame(1), "▪")
  assert.equal(waitingFrame(2), "▫")
  assert.equal(waitingFrame(-1), "▪")
  assert.equal(toolFrame(0), "▸")
  assert.equal(toolFrame(1), "▹")
  assert.equal(toolFrame(2), "▸")
  assert.equal(toolFrame(-1), "▹")
  assert.equal(thinkingFrame(0), "·  ")
  assert.equal(thinkingFrame(4), thinkingFrame(0))
})

test("tick 120 is a still frame for every animated set", () => {
  assert.equal(workingFrame(0), WORKING_FRAMES[0])
  assert.equal(workingFrame(120), WORKING_FRAMES[0])
  assert.equal(waitingFrame(120), WAITING_FRAMES[0])
  assert.equal(toolFrame(120), TOOL_FRAMES[0])
  assert.equal(thinkingFrame(120), THINKING_FRAMES[0])
})

test("queued frame is static across ticks", () => {
  for (let tick = 0; tick < 8; tick++) assert.equal(queuedFrame(), "▫")
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
  assert.equal(workingFrame(effectiveTick(3, { ENSEMBLE_REDUCED_MOTION: "1" })), "⠋")
  assert.equal(waitingFrame(effectiveTick(1, { NO_COLOR: "1" })), "▫")
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

test("ticket116: the 10 fps work clock runs only while a working card exists", () => {
  assert.equal(WORK_CLOCK_INTERVAL_MS, 100)
  const working = { workingCards: 1, routeActive: true, modalOpen: false }
  assert.equal(shouldRunWorkClock(working, {}), true)
  assert.equal(shouldRunWorkClock({ ...working, workingCards: 0 }, {}), false)
  assert.equal(shouldRunWorkClock({ ...working, routeActive: false }, {}), false)
  assert.equal(shouldRunWorkClock({ ...working, modalOpen: true }, {}), false)
  assert.equal(shouldRunWorkClock(working, { ENSEMBLE_REDUCED_MOTION: "1" }), false)
  assert.equal(shouldRunWorkClock(working, { NO_COLOR: "1" }), false)
})

test("empty states show a one-shot static mark", () => {
  assert.equal(EMPTY_MARK, "○───○───○")
})

test("review fix: first-paint stagger budget is capped at 6 lines x 40ms", () => {
  assert.equal(STAGGER_CAP, 6)
  assert.equal(STAGGER_STEP_MS, 40)
  assert.equal(staggerDelayMs(0, {}), 0)
  assert.equal(staggerDelayMs(1, {}), 40)
  assert.equal(staggerDelayMs(5, {}), 200)
  assert.equal(staggerDelayMs(6, {}), 200)
  assert.equal(staggerDelayMs(39, {}), 200)
  assert.equal(staggerDelayMs(-1, {}), 0)
  assert.equal(staggerDelayMs(3, { ENSEMBLE_REDUCED_MOTION: "1" }), 0)
  assert.equal(staggerDelayMs(3, { NO_COLOR: "1" }), 0)
})

test("review fix: stagger animates only on mount, capped, never per poll or chunk", () => {
  const state = createStaggerState()
  // First paint of three new rows: all stagger, in order.
  const first = updateStagger(state, ["a", "b", "c"], 7, true, {})
  assert.deepEqual([...first], ["a", "b", "c"])
  // Same tick re-evaluation (snapshot poll / streaming chunk): no re-trigger,
  // same set still staggering — the animation continues, never restarts.
  const repoll = updateStagger(state, ["a", "b", "c"], 7, true, {})
  assert.deepEqual([...repoll], ["a", "b", "c"])
  // Next tick: the entrance is over, rows render full.
  assert.deepEqual([...updateStagger(state, ["a", "b", "c"], 8, true, {})], [])
  // Re-mounted later (same tick or not): never re-animates.
  assert.deepEqual([...updateStagger(state, ["a", "b", "c"], 9, true, {})], [])
  // Cap: only the first 6 of a 10-row burst stagger; the rest mount full.
  const burst = createStaggerState()
  const staggered = updateStagger(burst, ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9"], 1, true, {})
  assert.deepEqual([...staggered], ["r0", "r1", "r2", "r3", "r4", "r5"])
  // Departed rows are pruned so the guard stays bounded by the window.
  assert.deepEqual([...updateStagger(burst, ["r9"], 2, true, {})], [])
})

test("review fix: stagger is static when motion is off or reduced", () => {
  const idle = createStaggerState()
  assert.deepEqual([...updateStagger(idle, ["a", "b"], 3, false, {})], [])
  // Idle rows are still marked seen: a later live tick does not stagger them.
  assert.deepEqual([...updateStagger(idle, ["a", "b"], 4, true, {})], [])
  const reduced = createStaggerState()
  assert.deepEqual([...updateStagger(reduced, ["a", "b"], 3, true, { ENSEMBLE_REDUCED_MOTION: "1" })], [])
  assert.deepEqual([...updateStagger(reduced, ["a", "b"], 4, true, {})], [])
})
