/**
 * Ticket #115: the Work-card liveness strip. The six-motion family lands in
 * #116; this module carries the fixed `current` tide so cards can animate
 * deterministically now without committing to the later assignment model.
 * Ticket #117 adds the flat settled frame for recently finished cards.
 *
 * The strip is one row of block glyphs, one glyph per two terminal cells.
 * `tideColumns` derives the sampled column count from the card content width
 * (clamped 8–64); `currentTideStrip` doubles each sample so the rendered row
 * spans the full card width. Every helper is pure, and reduced motion pins the
 * strip to its tick-0 frame.
 */
import { effectiveTick } from "./motion.ts"

/** Eight block levels, low to high. */
export const TIDE_GLYPHS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const

export const TIDE_MIN_COLUMNS = 8
export const TIDE_MAX_COLUMNS = 64

/** One tide sample covers two terminal cells. */
export const TIDE_CELLS_PER_GLYPH = 2

/** Card content width → sampled tide columns, clamped to the approved range. */
export function tideColumns(contentWidth: number): number {
  if (!Number.isFinite(contentWidth)) return TIDE_MIN_COLUMNS
  const columns = Math.floor(Math.max(0, contentWidth) / TIDE_CELLS_PER_GLYPH)
  return Math.max(TIDE_MIN_COLUMNS, Math.min(TIDE_MAX_COLUMNS, columns))
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor
}

/**
 * One `current` tide level per column. A triangular swell travels left to
 * right across the card; `tick` shifts the crest, so each frame is a visible
 * movement while every frame keeps the same column count.
 */
export function currentTideLevels(columns: number, tick: number, env: NodeJS.ProcessEnv = process.env): number[] {
  const width = Math.max(1, Math.floor(columns))
  const frame = effectiveTick(tick, env)
  const cycle = width * 2
  const levels: number[] = []
  for (let column = 0; column < width; column++) {
    const phase = modulo(column + frame, cycle)
    const triangle = phase <= width ? phase : cycle - phase
    levels.push(Math.round((triangle / width) * (TIDE_GLYPHS.length - 1)))
  }
  return levels
}

/** The rendered one-row strip: each sampled level becomes two identical cells. */
export function currentTideStrip(contentWidth: number, tick: number, env: NodeJS.ProcessEnv = process.env): string {
  const columns = tideColumns(contentWidth)
  return currentTideLevels(columns, tick, env)
    .map((level) => TIDE_GLYPHS[level].repeat(TIDE_CELLS_PER_GLYPH))
    .join("")
}

/**
 * Ticket #117: the flat settled frame for terminal/recent cards. Every sample
 * sits on the lowest level, so a finished card stops moving without changing
 * its width or introducing a second motion language.
 */
export function settledTideLevels(columns: number): number[] {
  return new Array(Math.max(1, Math.floor(columns))).fill(0)
}

/** Rendered flat settled strip at the same full card width as the live tide. */
export function settledTideStrip(contentWidth: number): string {
  return settledTideLevels(tideColumns(contentWidth))
    .map((level) => TIDE_GLYPHS[level].repeat(TIDE_CELLS_PER_GLYPH))
    .join("")
}

/** Theme role for a tide level: the strip stays grey, never an accent rainbow. */
export function tideTone(level: number): "faint" | "muted" | "text" {
  if (level <= 2) return "faint"
  if (level <= 5) return "muted"
  return "text"
}
