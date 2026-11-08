import test from "node:test"
import assert from "node:assert/strict"

import {
  TIDE_ASSIGNMENT_RETENTION_MS,
  TIDE_GLYPHS,
  TIDE_MAX_COLUMNS,
  TIDE_MIN_COLUMNS,
  TIDE_VARIANTS,
  createTideAssignments,
  createTideFreezeState,
  flatTideLevels,
  flatTideStrip,
  pruneTideAssignments,
  pruneTideFreezes,
  retainTideFreezes,
  tideAssignmentFor,
  tideColumns,
  tideLevel,
  tideLevels,
  tideRowParts,
  tideRowText,
  tideStrip,
  tideTickForCard,
  tideTone,
  tideVariantFor,
} from "./tide.ts"

test("ticket115: tide columns follow content width and clamp to the approved range", () => {
  assert.equal(tideColumns(40), 20)
  assert.equal(tideColumns(41), 21, "odd widths take ceil(width / 2) samples")
  assert.equal(tideColumns(12), TIDE_MIN_COLUMNS)
  assert.equal(tideColumns(400), TIDE_MAX_COLUMNS)
  assert.equal(TIDE_MIN_COLUMNS, 8)
  assert.equal(TIDE_MAX_COLUMNS, 64)
})

test("ticket115: one tide glyph covers two cells and the strip spans the card width", () => {
  const even = tideStrip("current", 40, 0)
  assert.equal(even.length, 40)
  assert.equal(even[0], " ", "an even row starts with the padding blank")
  for (let index = 1; index < even.length; index++) {
    assert.equal(even[index] === " ", index % 2 === 0, "cells alternate glyph and the deliberate gap")
  }
  assert.ok((TIDE_GLYPHS as readonly string[]).includes(even.at(-1) as string), "the row ends on its last glyph")

  const odd = tideStrip("current", 41, 0)
  assert.equal(odd.length, 41)
  assert.ok((TIDE_GLYPHS as readonly string[]).includes(odd[0] as string), "an odd row starts on its first glyph")
  for (let index = 0; index < odd.length; index++) {
    assert.equal(odd[index] === " ", index % 2 === 1, "cells alternate glyph and the deliberate gap")
  }
  const cells = [...odd].filter((cell) => cell !== " ")
  assert.ok(cells.every((cell) => (TIDE_GLYPHS as readonly string[]).includes(cell)))
})

test("ticket156: tide row parts keep the exact content width and end on the last glyph", () => {
  const even = tideRowParts([1, 2], 4)
  assert.equal(tideRowText(even), " ▂ ▃", "even widths pad one leading blank and drop the final sample blank")
  assert.equal(even[0]?.level, undefined, "the padding cell carries no level")
  assert.equal(even.at(-1)?.text, TIDE_GLYPHS[2], "the final sample is the glyph only")

  const odd = tideRowParts([1, 2, 3], 5)
  assert.equal(tideRowText(odd), "▂ ▃ ▄", "odd widths need no padding")
  assert.equal(odd.length, 3)
  assert.equal(odd.at(-1)?.text, TIDE_GLYPHS[3])

  assert.equal(tideRowText(tideRowParts(flatTideLevels(tideColumns(16)), 16)), " ▁".repeat(8))
})

test("ticket156: every content width from 16 to 120 keeps the exact row and right edge", () => {
  const glyphs = TIDE_GLYPHS as readonly string[]
  for (let width = 16; width <= 120; width++) {
    for (const variant of TIDE_VARIANTS) {
      const strip = tideStrip(variant, width, 3, {})
      assert.equal(strip.length, width, `${variant} at width ${width}`)
      const offset = width % 2 === 0 ? 1 : 0
      for (let index = 0; index < width; index++) {
        if (index < offset) {
          assert.equal(strip[index], " ", `${variant} at width ${width} pads only the first cell`)
        } else if ((index - offset) % 2 === 0) {
          assert.ok(glyphs.includes(strip[index] as string), `${variant} at width ${width} cell ${index} is a glyph`)
        } else {
          assert.equal(strip[index], " ", `${variant} at width ${width} cell ${index} is the deliberate gap`)
        }
      }
      assert.ok(glyphs.includes(strip.at(-1) as string), `${variant} at width ${width} ends on a glyph`)
    }

    assert.equal(flatTideStrip(width).length, width, `flat strip at width ${width}`)
    assert.ok(glyphs.includes(flatTideStrip(width).at(-1) as string), `flat strip at width ${width} ends on a glyph`)

    const levels = tideLevels("current", tideColumns(width), 0, {})
    assert.equal(levels.length, Math.ceil(width / 2), `sampled columns at width ${width}`)
    const parts = tideRowParts(levels, width)
    assert.equal(tideRowText(parts).length, width)
    assert.equal(tideRowText(parts), tideStrip("current", width, 0, {}))
    assert.equal(parts.at(-1)?.text, glyphs[levels.at(-1) as number], "the last part is the glyph-only final sample")
    assert.equal(parts.at(-1)?.text.length, 1)
    if (width % 2 === 0) {
      assert.equal(parts[0]?.text, " ")
      assert.equal(parts[0]?.level, undefined, "even widths take exactly one padding blank")
      assert.equal(parts.length, Math.ceil(width / 2) + 1)
    } else {
      assert.equal(parts.length, Math.ceil(width / 2), "odd widths need no padding part")
      assert.notEqual(parts[0]?.level, undefined)
    }
  }
})

test("ticket115: the current tide ramps through eight block levels", () => {
  assert.deepEqual([...TIDE_GLYPHS], ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"])
  const levels = tideLevels("current", 24, 0)
  assert.equal(levels.length, 24)
  assert.ok(levels.every((level) => level >= 0 && level < TIDE_GLYPHS.length))
  assert.ok(new Set(levels).size >= 4, "the strip is a ramp, not one flat level")
})

test("ticket115: the current tide advances with the tick and pins under reduced motion", () => {
  assert.notEqual(tideStrip("current", 40, 0), tideStrip("current", 40, 1))
  assert.notEqual(tideStrip("current", 40, 1), tideStrip("current", 40, 2))
  assert.equal(tideStrip("current", 40, 5, { ENSEMBLE_REDUCED_MOTION: "1" }), tideStrip("current", 40, 0))
  assert.equal(tideStrip("current", 40, 7, { NO_COLOR: "1" }), tideStrip("current", 40, 0))
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
  assert.equal(flatTideStrip(40), " ▁".repeat(20))
  assert.equal(flatTideStrip(12), " ▁".repeat(6), "the strip fills the exact requested content width")
  assert.equal(tideColumns(12), TIDE_MIN_COLUMNS, "the sampling clamp still applies")
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
    assert.equal(strip[0], " ", "an even row starts with the padding blank")
    assert.ok((TIDE_GLYPHS as readonly string[]).includes(strip.at(-1) as string), "the row ends on its last glyph")
    const cells = [...strip]
    assert.ok(cells.filter((cell) => cell !== " ").every((cell) => (TIDE_GLYPHS as readonly string[]).includes(cell)))
    for (let index = 1; index < strip.length; index++) {
      assert.equal(strip[index] === " ", index % 2 === 0, "glyphs keep one deliberate blank gap")
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
    assert.equal(odd.length, 41, "odd content widths keep the exact width too")
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
  assert.equal(flatTideStrip(40), " ▁".repeat(20))
  assert.equal(flatTideStrip(40).length, 40)
})

test("ticket116: only working, unblocked cards advance the tide", () => {
  assert.equal(tideTickForCard("working", false, 7, {}), 7)
  assert.equal(tideTickForCard("working", true, 7, {}), 0, "a needs-you still frame is deterministic without assignment state")
  assert.equal(tideTickForCard("working", false, 7, { ENSEMBLE_REDUCED_MOTION: "1" }), 0)
  assert.equal(tideTickForCard("working", false, 7, { NO_COLOR: "1" }), 0)
  assert.equal(tideTickForCard("pending", false, 7, {}), 0)
  assert.equal(tideTickForCard("retrying", false, 7, {}), 0)
  assert.equal(tideTickForCard("replied", false, 7, {}), 0)
  assert.equal(tideTickForCard("failed", false, 7, {}), 0)
  assert.equal(tideTickForCard("cancelled", false, 7, {}), 0)
})

test("ticket116: needs-you freezes at the tick it became blocked and releases when unblocked", () => {
  const freeze = createTideFreezeState()
  const at = (status: "working", needsYou: boolean, tick: number, now: number) =>
    tideTickForCard(status, needsYou, tick, {}, { state: freeze, id: "task", now })
  assert.equal(at("working", false, 7, 0), 7, "the card animates before it blocks")
  assert.equal(at("working", true, 12, 100), 12, "the first blocked observation is the freeze frame")
  assert.equal(at("working", true, 40, 200), 12, "later ticks keep the frozen frame")
  assert.equal(at("working", false, 41, 300), 41, "resolving the block lets the tide advance again")
  assert.equal(freeze.frozen.size, 0, "an unblocked card leaves no freeze entry")
})

test("ticket116: idle freeze assignments prune after the independent tide retention window", () => {
  const freeze = createTideFreezeState()
  tideTickForCard("working", true, 12, {}, { state: freeze, id: "gone", now: 1_000 })
  tideTickForCard("working", true, 12, {}, { state: freeze, id: "live", now: 5_000 })
  assert.deepEqual(pruneTideFreezes(freeze, 1_000 + TIDE_ASSIGNMENT_RETENTION_MS), [], "the boundary still belongs to the window")
  assert.deepEqual(pruneTideFreezes(freeze, 1_000 + TIDE_ASSIGNMENT_RETENTION_MS + 1), ["gone"])
  assert.equal(freeze.frozen.has("live"), true, "a still-observed freeze survives")
})

test("ticket142: visible waiting cards refresh their freeze without a work-clock tick", () => {
  const freeze = createTideFreezeState()
  tideTickForCard("working", true, 12, {}, { state: freeze, id: "waiting", now: 1_000 })
  retainTideFreezes(freeze, new Set(["waiting"]), 9_000)
  assert.deepEqual(pruneTideFreezes(freeze, 9_001), [], "a visible waiting card keeps its frame")
  assert.equal(freeze.frozen.get("waiting")?.tick, 12, "retention refreshes the timestamp, never the frame")
  retainTideFreezes(freeze, new Set(), 30_000)
  assert.deepEqual(pruneTideFreezes(freeze, 30_001), ["waiting"], "an off-screen freeze still ages out")
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

test("ticket116: assignments survive the independent retention window then prune", () => {
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
