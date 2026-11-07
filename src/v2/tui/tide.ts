/**
 * Ticket #115/#116: the Work-card liveness strip. Six approved tide motions
 * (`current`, `ripple`, `travel`, `interference`, `inbound`, `echo`) are pure
 * functions over column, total columns, and tick. Each subtask keeps one
 * variant for its active lifetime via a shuffled deck, so concurrent cards
 * vary without re-rolling on every snapshot poll. Terminal cards keep the
 * same flat settled frame while their dispatch group holds.
 *
 * The strip is one row of block glyphs. Each sample is one glyph plus one
 * deliberate blank cell, so the approved Sub-Cell Tide gap is visible across
 * the card. `tideColumns` derives the sampled column count from the card
 * content width (clamped 8–64). Reduced motion pins every motion to its tick-0
 * frame, needs-you freezes the assigned variant, and terminal cards settle to
 * a flat strip.
 */
import type { DerivedWorkStatus } from "../queue.ts"
import { effectiveTick } from "./motion.ts"
import { TIDE_ASSIGNMENT_RETENTION_MS } from "./work-constants.ts"

/** Eight block levels, low to high. */
export const TIDE_GLYPHS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const

export const TIDE_MIN_COLUMNS = 8
export const TIDE_MAX_COLUMNS = 64

/** One tide sample covers two terminal cells. */
export const TIDE_CELLS_PER_GLYPH = 2

/** The six approved motions, in deck order. */
export const TIDE_VARIANTS = ["current", "ripple", "travel", "interference", "inbound", "echo"] as const

export type TideVariant = (typeof TIDE_VARIANTS)[number]

/** Assignment retention is presentation-only and independent of Work visibility (#136). */
export { TIDE_ASSIGNMENT_RETENTION_MS }

/** One source of truth for the approved 8–64 sampled-column range. */
function clampedColumns(columns: number): number {
  if (!Number.isFinite(columns)) return TIDE_MIN_COLUMNS
  return Math.max(TIDE_MIN_COLUMNS, Math.min(TIDE_MAX_COLUMNS, Math.floor(columns)))
}

/** Card content width → sampled tide columns, clamped to the approved range. */
export function tideColumns(contentWidth: number): number {
  if (!Number.isFinite(contentWidth)) return TIDE_MIN_COLUMNS
  return clampedColumns(Math.max(0, contentWidth) / TIDE_CELLS_PER_GLYPH)
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor
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

/** Levels for an already-clamped width; the single sampling primitive. */
function levelsForWidth(variant: TideVariant, width: number, frame: number): number[] {
  return Array.from({ length: width }, (_, column) => tideLevel(variant, column, width, frame))
}

/** One level per sampled column, clamped to the approved 8–64 column range. */
export function tideLevels(
  variant: TideVariant,
  columns: number,
  tick: number,
  env: NodeJS.ProcessEnv = process.env,
): number[] {
  return levelsForWidth(variant, clampedColumns(columns), effectiveTick(tick, env))
}

/** The rendered one-row strip: each sampled level becomes two identical cells. */
export function tideStrip(
  variant: TideVariant,
  contentWidth: number,
  tick: number,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return levelsForWidth(variant, tideColumns(contentWidth), effectiveTick(tick, env))
    .map((level) => `${TIDE_GLYPHS[level]} `)
    .join("")
}

/** Terminal cards settle to the lowest block, one glyph plus one blank per cell. */
export function flatTideLevels(columns: number): number[] {
  return Array.from({ length: clampedColumns(columns) }, () => 0)
}

export function flatTideStrip(contentWidth: number): string {
  return `${TIDE_GLYPHS[0]} `.repeat(tideColumns(contentWidth))
}

/**
 * UI-local freeze frames for cards that started waiting on the user. A card
 * that blocks while working keeps the tide frame it had at that moment; the
 * entry is released as soon as the card stops needing the user.
 */
export type TideFreezeState = {
  frozen: Map<string, { tick: number; seenAt: number }>
}

export function createTideFreezeState(): TideFreezeState {
  return { frozen: new Map() }
}

/**
 * Tide frame for one card: only a working card that is not waiting on the
 * user advances. A needs-you working card freezes on the tick where it first
 * blocked, then holds that frame until the block clears; pending, retrying,
 * and terminal cards hold the deterministic still frame. Reduced motion pins
 * every card to tick 0.
 */
export function tideTickForCard(
  status: DerivedWorkStatus,
  needsYou: boolean,
  tick: number,
  env: NodeJS.ProcessEnv = process.env,
  freeze?: { state: TideFreezeState; id: string; now: number },
): number {
  if (needsYou) {
    // Without a freeze record (or for a card that never animated) the tick-0
    // frame remains the honest deterministic still.
    if (!freeze || status !== "working") return 0
    const existing = freeze.state.frozen.get(freeze.id)
    if (existing) {
      existing.seenAt = freeze.now
      return existing.tick
    }
    const frozen = effectiveTick(tick, env)
    freeze.state.frozen.set(freeze.id, { tick: frozen, seenAt: freeze.now })
    return frozen
  }
  freeze?.state.frozen.delete(freeze.id)
  if (status !== "working") return 0
  return effectiveTick(tick, env)
}

/** Drop freeze frames for cards outside the independent presentation-retention window. */
export function pruneTideFreezes(
  state: TideFreezeState,
  now: number = Date.now(),
  retentionMs: number = TIDE_ASSIGNMENT_RETENTION_MS,
): string[] {
  const removed: string[] = []
  for (const [id, entry] of state.frozen) {
    if (now - entry.seenAt > retentionMs) {
      state.frozen.delete(id)
      removed.push(id)
    }
  }
  return removed
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
 * Drop assignments outside the independent presentation-retention window. Returns the pruned
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
