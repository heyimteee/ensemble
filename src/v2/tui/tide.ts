/**
 * Ticket #115/#116: the Work-card liveness strip. Six approved tide motions
 * (`current`, `ripple`, `travel`, `interference`, `inbound`, `echo`) are pure
 * functions over column, total columns, and tick. Each subtask keeps one
 * variant for its active lifetime via a shuffled deck, so concurrent cards
 * vary without re-rolling on every snapshot poll.
 *
 * The strip is one row of block glyphs, one glyph per two terminal cells.
 * `tideColumns` derives the sampled column count from the card content width
 * (clamped 8–64); the strip helpers double each sample so the rendered row
 * spans the full card width. Reduced motion pins every motion to its tick-0
 * frame, needs-you freezes the assigned variant, and terminal cards settle to
 * a flat strip.
 */
import type { DerivedWorkStatus } from "../queue.ts"
import { effectiveTick } from "./motion.ts"

/** Eight block levels, low to high. */
export const TIDE_GLYPHS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const

export const TIDE_MIN_COLUMNS = 8
export const TIDE_MAX_COLUMNS = 64

/** One tide sample covers two terminal cells. */
export const TIDE_CELLS_PER_GLYPH = 2

/** The six approved motions, in deck order. */
export const TIDE_VARIANTS = ["current", "ripple", "travel", "interference", "inbound", "echo"] as const

export type TideVariant = (typeof TIDE_VARIANTS)[number]

/** Assignment retention matches the recent-card window (#117). */
export const TIDE_ASSIGNMENT_RETENTION_MS = 8_000

/** Card content width → sampled tide columns, clamped to the approved range. */
export function tideColumns(contentWidth: number): number {
  if (!Number.isFinite(contentWidth)) return TIDE_MIN_COLUMNS
  const columns = Math.floor(Math.max(0, contentWidth) / TIDE_CELLS_PER_GLYPH)
  return Math.max(TIDE_MIN_COLUMNS, Math.min(TIDE_MAX_COLUMNS, columns))
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor
}

function clampedColumns(columns: number): number {
  if (!Number.isFinite(columns)) return TIDE_MIN_COLUMNS
  return Math.max(TIDE_MIN_COLUMNS, Math.min(TIDE_MAX_COLUMNS, Math.floor(columns)))
}

/** Triangle wave in 0…1 over one period; phase wraps modularly. */
function triangleWave(phase: number, period: number): number {
  const wrapped = modulo(phase, period)
  const half = period / 2
  return wrapped <= half ? wrapped / half : (period - wrapped) / half
}

/**
 * One tide level (0–7) for a column. Pure: the six motions each have a fixed
 * formula over the column index, total sampled columns, and tick. `tick` is
 * already reduced-motion-normalized by the strip helpers.
 */
export function tideLevel(variant: TideVariant, column: number, totalColumns: number, tick: number): number {
  const width = Math.max(1, Math.floor(totalColumns))
  const col = Math.floor(column)
  switch (variant) {
    case "current": {
      // Triangular swell travelling left to right.
      const cycle = width * 2
      const phase = modulo(col + tick, cycle)
      const triangle = phase <= width ? phase : cycle - phase
      return Math.round((triangle / width) * (TIDE_GLYPHS.length - 1))
    }
    case "ripple": {
      // Mirrored rings expanding out from the centre.
      const centre = (width - 1) / 2
      const distance = Math.abs(col - centre)
      return Math.round(triangleWave(distance * 2 - tick * 2, width) * (TIDE_GLYPHS.length - 1))
    }
    case "travel": {
      // A narrow crest with a short tail moving left to right.
      const head = modulo(tick, width)
      const trail = Math.max(2, Math.floor(width / 3))
      const distance = modulo(col - head, width)
      if (distance >= trail) return 0
      return Math.round((1 - distance / trail) * (TIDE_GLYPHS.length - 1))
    }
    case "interference": {
      // Two waves at different spatial frequencies crossing in opposite directions.
      const first = triangleWave(col * 2 + tick * 2, width * 2)
      const second = triangleWave(col * 3 - tick * 2, width * 2)
      return Math.round(((first + second) / 2) * (TIDE_GLYPHS.length - 1))
    }
    case "inbound": {
      // Crests entering from both edges and moving toward the centre.
      const edge = Math.min(col, width - 1 - col)
      const span = Math.max(2, Math.floor(width / 2))
      return Math.round(triangleWave(edge - tick, span) * (TIDE_GLYPHS.length - 1))
    }
    case "echo": {
      // A primary pulse followed by one fainter ghost pulse.
      const period = width
      const head = modulo(col - tick, period)
      const ghost = modulo(col - tick - Math.floor(width / 2), period)
      const pulse = head < 3 ? 7 - head * 2 : 0
      const echo = ghost < 3 ? 3 - ghost : 0
      return Math.max(0, Math.min(TIDE_GLYPHS.length - 1, Math.max(pulse, echo)))
    }
  }
}

/** One level per sampled column, clamped to the approved 8–64 column range. */
export function tideLevels(
  variant: TideVariant,
  columns: number,
  tick: number,
  env: NodeJS.ProcessEnv = process.env,
): number[] {
  const width = clampedColumns(columns)
  const frame = effectiveTick(tick, env)
  return Array.from({ length: width }, (_, column) => tideLevel(variant, column, width, frame))
}

/** The rendered one-row strip: each sampled level becomes two identical cells. */
export function tideStrip(
  variant: TideVariant,
  contentWidth: number,
  tick: number,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return tideLevels(variant, tideColumns(contentWidth), tick, env)
    .map((level) => TIDE_GLYPHS[level].repeat(TIDE_CELLS_PER_GLYPH))
    .join("")
}

/** The pre-#116 `current` motion, kept as the default variant. */
export function currentTideLevels(columns: number, tick: number, env: NodeJS.ProcessEnv = process.env): number[] {
  return tideLevels("current", columns, tick, env)
}

export function currentTideStrip(contentWidth: number, tick: number, env: NodeJS.ProcessEnv = process.env): string {
  return tideStrip("current", contentWidth, tick, env)
}

/** Terminal cards settle to the lowest block, one glyph per two cells. */
export function flatTideLevels(columns: number): number[] {
  return Array.from({ length: clampedColumns(columns) }, () => 0)
}

export function flatTideStrip(contentWidth: number): string {
  return TIDE_GLYPHS[0].repeat(tideColumns(contentWidth) * TIDE_CELLS_PER_GLYPH)
}

/**
 * Tide frame for one card: only a working card that is not waiting on the
 * user advances. Needs-you, pending, retrying, and terminal cards hold the
 * deterministic still frame; reduced motion pins every card to tick 0.
 */
export function tideTickForCard(
  status: DerivedWorkStatus,
  needsYou: boolean,
  tick: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (needsYou || status !== "working") return 0
  return effectiveTick(tick, env)
}

export type TideAssignmentState = {
  assignments: Map<string, { variant: TideVariant; seenAt: number }>
  deck: TideVariant[]
  random: () => number
  lastDrawn?: TideVariant
}

export function createTideAssignments(random: () => number = Math.random): TideAssignmentState {
  return { assignments: new Map(), deck: [], random }
}

/** Fisher–Yates shuffle of one full deck. Pure given the injected random source. */
export function shuffleTideDeck(random: () => number = Math.random): TideVariant[] {
  const deck = [...TIDE_VARIANTS]
  for (let index = deck.length - 1; index > 0; index--) {
    const roll = random()
    const bounded = Number.isFinite(roll) ? Math.max(0, Math.min(1, roll)) : 0
    const swap = Math.min(index, Math.floor(bounded * (index + 1)))
    const value = deck[index]
    deck[index] = deck[swap]
    deck[swap] = value
  }
  return deck
}

function refillDeck(state: TideAssignmentState): void {
  state.deck = shuffleTideDeck(state.random)
  if (state.lastDrawn === undefined) return
  const top = state.deck.length - 1
  if (state.deck[top] !== state.lastDrawn) return
  // A deck boundary should not repeat back-to-back; rotate a different
  // variant to the top while keeping the full deck intact.
  const swap = state.deck.findIndex((variant) => variant !== state.lastDrawn)
  if (swap >= 0) {
    state.deck[top] = state.deck[swap]
    state.deck[swap] = state.lastDrawn
  }
}

/**
 * Stable variant for one subtask: assigns on first sight, refreshes its
 * retention timestamp on every poll, and draws from a shuffled deck. Pure
 * state transitions; callers own the state object.
 */
export function tideVariantFor(state: TideAssignmentState, id: string, now: number = Date.now()): TideVariant {
  const existing = state.assignments.get(id)
  if (existing) {
    existing.seenAt = now
    return existing.variant
  }
  if (state.deck.length === 0) refillDeck(state)
  const variant = state.deck.pop()!
  state.lastDrawn = variant
  state.assignments.set(id, { variant, seenAt: now })
  return variant
}

/** Current assignment for an id without touching its retention timestamp. */
export function tideAssignmentFor(state: TideAssignmentState, id: string): TideVariant | undefined {
  return state.assignments.get(id)?.variant
}

/**
 * Drop assignments whose card left the recent-card window. Returns the pruned
 * ids so callers can assert bounded state; active ids are refreshed by
 * `tideVariantFor` on every poll.
 */
export function pruneTideAssignments(
  state: TideAssignmentState,
  now: number = Date.now(),
  retentionMs: number = TIDE_ASSIGNMENT_RETENTION_MS,
): string[] {
  const removed: string[] = []
  for (const [id, entry] of state.assignments) {
    if (now - entry.seenAt > retentionMs) {
      state.assignments.delete(id)
      removed.push(id)
    }
  }
  return removed
}

/** Theme role for a tide level: the strip stays grey, never an accent rainbow. */
export function tideTone(level: number): "faint" | "muted" | "text" {
  if (level <= 2) return "faint"
  if (level <= 5) return "muted"
  return "text"
}
