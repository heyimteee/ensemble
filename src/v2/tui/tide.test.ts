import test from "node:test"
import assert from "node:assert/strict"
import {
  TIDE_ASSIGNMENT_RETENTION_MS,
  TIDE_GLYPHS,
  TIDE_MAX_COLUMNS,
  TIDE_MIN_COLUMNS,
  TIDE_VARIANTS,
  createTideAssignments,
  currentTideLevels,
  currentTideStrip,
  flatTideLevels,
  flatTideStrip,
  pruneTideAssignments,
  tideAssignmentFor,
  tideColumns,
  tideLevel,
  tideLevels,
  tideStrip,
  tideTickForCard,
  tideTone,
  tideVariantFor,
} from "./tide.ts"

test("ticket115: tide columns follow content width and clamp to the approved range", () => {
  assert.equal(tideColumns(40), 20)
  assert.equal(tideColumns(41), 20)
  assert.equal(tideColumns(12), TIDE_MIN_COLUMNS)
  assert.equal(tideColumns(400), TIDE_MAX_COLUMNS)
  assert.equal(TIDE_MIN_COLUMNS, 8)
  assert.equal(TIDE_MAX_COLUMNS, 64)
})

test("ticket115: one tide glyph covers two cells and the strip spans the card width", () => {
  const strip = currentTideStrip(40, 0)
  assert.equal(strip.length, 40)
  for (let index = 0; index < strip.length; index += 2) {
    assert.equal(strip[index], strip[index + 1], "each tide column renders the same glyph twice")
  }
  const cells = [...strip]
  assert.ok(cells.every((cell) => (TIDE_GLYPHS as readonly string[]).includes(cell)))
})

test("ticket115: the current tide ramps through eight block levels", () => {
  assert.deepEqual([...TIDE_GLYPHS], ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"])
  const levels = currentTideLevels(24, 0)
  assert.equal(levels.length, 24)
  assert.ok(levels.every((level) => level >= 0 && level < TIDE_GLYPHS.length))
  assert.ok(new Set(levels).size >= 4, "the strip is a ramp, not one flat level")
})

test("ticket115: the current tide advances with the tick and pins under reduced motion", () => {
  assert.notEqual(currentTideStrip(40, 0), currentTideStrip(40, 1))
  assert.notEqual(currentTideStrip(40, 1), currentTideStrip(40, 2))
  assert.equal(currentTideStrip(40, 5, { ENSEMBLE_REDUCED_MOTION: "1" }), currentTideStrip(40, 0))
  assert.equal(currentTideStrip(40, 7, { NO_COLOR: "1" }), currentTideStrip(40, 0))
})

test("ticket115: tide levels map onto faint, muted, and text theme roles", () => {
  assert.equal(tideTone(0), "faint")
  assert.equal(tideTone(2), "faint")
  assert.equal(tideTone(3), "muted")
  assert.equal(tideTone(5), "muted")
  assert.equal(tideTone(6), "text")
  assert.equal(tideTone(7), "text")
})

test("ticket117: the settled tide stays flat at the shared card width", () => {
  assert.equal(flatTideStrip(40), TIDE_GLYPHS[0].repeat(40))
  assert.equal(flatTideStrip(12), TIDE_GLYPHS[0].repeat(16), "the strip honours the minimum column clamp")
  assert.deepEqual(flatTideLevels(20), new Array(20).fill(0))
})

test("ticket116: each approved motion has a fixed formula over column, width, and tick", () => {
  const expectedAtTickZero: Record<(typeof TIDE_VARIANTS)[number], number[]> = {
    current: [0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6],
    ripple: [1, 4, 6, 6, 4, 1, 1, 4, 6, 6, 4, 1],
    travel: [7, 5, 4, 2, 0, 0, 0, 0, 0, 0, 0, 0],
    interference: [0, 1, 3, 4, 6, 6, 5, 4, 2, 3, 3, 3],
    inbound: [0, 2, 5, 7, 5, 2, 2, 5, 7, 5, 2, 0],
    echo: [7, 5, 3, 0, 0, 0, 3, 2, 1, 0, 0, 0],
  }
  const expectedAtTickTwo: Record<(typeof TIDE_VARIANTS)[number], number[]> = {
    current: [1, 2, 2, 3, 4, 4, 5, 5, 6, 6, 7, 6],
    ripple: [6, 6, 4, 1, 1, 4, 4, 1, 1, 4, 6, 6],
    travel: [0, 0, 7, 5, 4, 2, 0, 0, 0, 0, 0, 0],
    interference: [2, 2, 3, 4, 6, 6, 5, 4, 2, 1, 1, 2],
    inbound: [5, 2, 0, 2, 5, 7, 7, 5, 2, 0, 2, 5],
    echo: [0, 0, 7, 5, 3, 0, 0, 0, 3, 2, 1, 0],
  }
  for (const variant of TIDE_VARIANTS) {
    const atZero = Array.from({ length: 12 }, (_, column) => tideLevel(variant, column, 12, 0))
    const atTwo = Array.from({ length: 12 }, (_, column) => tideLevel(variant, column, 12, 2))
    assert.deepEqual(atZero, expectedAtTickZero[variant], `${variant} at tick 0`)
    assert.deepEqual(atTwo, expectedAtTickTwo[variant], `${variant} at tick 2`)
  }
})

test("ticket116: all six motions produce distinct fixed-width one-row strips", () => {
  const strips = TIDE_VARIANTS.map((variant) => tideStrip(variant, 48, 3))
  assert.equal(new Set(strips).size, TIDE_VARIANTS.length)
  for (const strip of strips) {
    assert.equal(strip.length, 48)
    const cells = [...strip]
    assert.ok(cells.every((cell) => (TIDE_GLYPHS as readonly string[]).includes(cell)))
    for (let index = 0; index < strip.length; index += 2) {
      assert.equal(strip[index], strip[index + 1], "each tide sample still covers two cells")
    }
  }
})

test("ticket116: every motion clamps columns to 8-64 and keeps one row", () => {
  for (const variant of TIDE_VARIANTS) {
    assert.equal(tideLevels(variant, 2, 0).length, TIDE_MIN_COLUMNS)
    assert.equal(tideLevels(variant, 500, 0).length, TIDE_MAX_COLUMNS)
    const even = tideStrip(variant, 40, 0)
    const odd = tideStrip(variant, 41, 0)
    assert.equal(even.length, 40)
    assert.equal(odd.length, 40, "odd content widths lose at most one trailing cell")
    assert.equal([...even].filter((cell) => cell === "\n").length, 0)
  }
})

test("ticket116: reduced motion freezes every motion to its deterministic still frame", () => {
  for (const variant of TIDE_VARIANTS) {
    assert.equal(
      tideStrip(variant, 40, 9, { ENSEMBLE_REDUCED_MOTION: "1" }),
      tideStrip(variant, 40, 0),
      `${variant} freezes under ENSEMBLE_REDUCED_MOTION`,
    )
    assert.equal(
      tideStrip(variant, 40, 9, { NO_COLOR: "1" }),
      tideStrip(variant, 40, 0),
      `${variant} freezes under NO_COLOR`,
    )
  }
})

test("ticket116: terminal cards settle to a flat strip", () => {
  assert.deepEqual(flatTideLevels(20), Array.from({ length: 20 }, () => 0))
  assert.equal(flatTideStrip(40), TIDE_GLYPHS[0].repeat(40))
  assert.equal(flatTideStrip(40).length, 40)
})

test("ticket116: only working, unblocked cards advance the tide", () => {
  assert.equal(tideTickForCard("working", false, 7, {}), 7)
  assert.equal(tideTickForCard("working", true, 7, {}), 0, "needs-you freezes")
  assert.equal(tideTickForCard("working", false, 7, { ENSEMBLE_REDUCED_MOTION: "1" }), 0)
  assert.equal(tideTickForCard("working", false, 7, { NO_COLOR: "1" }), 0)
  assert.equal(tideTickForCard("pending", false, 7, {}), 0)
  assert.equal(tideTickForCard("retrying", false, 7, {}), 0)
  assert.equal(tideTickForCard("replied", false, 7, {}), 0)
  assert.equal(tideTickForCard("failed", false, 7, {}), 0)
  assert.equal(tideTickForCard("cancelled", false, 7, {}), 0)
})

function seeded(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0
    return value / 0x1_0000_0000
  }
}

test("ticket116: a shuffled deck uses all six variants before any repeat", () => {
  for (const seed of [1, 2, 3, 42, 999]) {
    const state = createTideAssignments(seeded(seed))
    const firstDeck = Array.from({ length: TIDE_VARIANTS.length }, (_, index) =>
      tideVariantFor(state, `task-${index}`, 0),
    )
    assert.equal(new Set(firstDeck).size, TIDE_VARIANTS.length, `seed ${seed} covers the deck`)
    const nextDeck = Array.from({ length: TIDE_VARIANTS.length }, (_, index) =>
      tideVariantFor(state, `task-${TIDE_VARIANTS.length + index}`, 0),
    )
    assert.equal(new Set(nextDeck).size, TIDE_VARIANTS.length, `seed ${seed} reshuffles a full deck`)
    assert.notEqual(nextDeck[0], firstDeck[firstDeck.length - 1], "the deck boundary never repeats back-to-back")
  }
})

test("ticket116: assignment is stable across snapshot refreshes", () => {
  const state = createTideAssignments(seeded(7))
  const assigned = new Map(["a", "b", "c"].map((id) => [id, tideVariantFor(state, id, 0)] as const))
  for (let poll = 1; poll <= 20; poll++) {
    for (const [id, variant] of assigned) {
      assert.equal(tideVariantFor(state, id, poll * 250), variant, `${id} keeps its variant on poll ${poll}`)
    }
  }
})

test("ticket116: assignments survive the recent-card window then prune", () => {
  const state = createTideAssignments(seeded(11))
  const doneVariant = tideVariantFor(state, "done", 0)
  const liveVariant = tideVariantFor(state, "live", 5_000)
  pruneTideAssignments(state, TIDE_ASSIGNMENT_RETENTION_MS)
  assert.equal(tideAssignmentFor(state, "done"), doneVariant)
  assert.equal(tideAssignmentFor(state, "live"), liveVariant)
  pruneTideAssignments(state, TIDE_ASSIGNMENT_RETENTION_MS + 1)
  assert.equal(tideAssignmentFor(state, "done"), undefined)
  assert.equal(tideAssignmentFor(state, "live"), liveVariant)
})
