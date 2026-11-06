import test from "node:test"
import assert from "node:assert/strict"
import {
  TIDE_GLYPHS,
  TIDE_MAX_COLUMNS,
  TIDE_MIN_COLUMNS,
  currentTideLevels,
  currentTideStrip,
  settledTideLevels,
  settledTideStrip,
  tideColumns,
  tideTone,
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

test("ticket117: the settled tide is flat, width-stable, and needs no tick", () => {
  assert.equal(settledTideStrip(40), TIDE_GLYPHS[0].repeat(40))
  assert.equal(settledTideStrip(12), TIDE_GLYPHS[0].repeat(16), "the strip honours the minimum column clamp")
  assert.deepEqual(settledTideLevels(20), new Array(20).fill(0))
  assert.deepEqual(settledTideLevels(20), settledTideLevels(20), "the settled frame is deterministic")
})
