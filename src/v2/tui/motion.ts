/**
 * Slice B motion language (brief §4, normative frame sets).
 *
 * Terminal translation of the OpenBot shimmer (notes §1j/§5): no gradient,
 * no layout animation — every animated indicator is a pure function over an
 * integer tick, advancing at 4 fps only while motion is active and resetting
 * to tick 0 (the still frame) otherwise. Glyph/fg changes only, never
 * width/height/padding (no reflow). Stillness is the default: idle screens
 * run no motion timers at all.
 *
 * Named sets (all constant-width within their set; modular wrap incl.
 * negatives; tick 120 is a still frame for every set):
 *
 * - working `◐ ◑ ◒ ◓` (4f, 250 ms/step) — WORK rows for running work, live
 *   activity lines. This is the app's signature spinner (kept).
 * - waiting `○ ◌` (2f alternating, 500 ms/step) — pending WORK rows. Calm,
 *   distinct from working.
 * - tool `▸ ▹` (2f chevron nudge) — tool-kind activity verbs
 *   (reading/searching/running/writing); folds to `▸` when done.
 * - thinking `·   / ˙   /  ⋮  / ·  ` (4f textual shimmer on the activity
 *   verb) — the terminal reduction of OpenBot's shimmer sweep.
 * - queued `○` (static — NEVER animated; queued is parked, not live).
 * - done `● / ✕ / ⊘` (static final frames, announced once, no animation).
 *
 * Reduced motion: `ENSEMBLE_REDUCED_MOTION=1` (or `true`) or `NO_COLOR`
 * present pins every animated cell to its frame-0 glyph via `effectiveTick`
 * and stops the clock via `shouldRunMotion`. Stagger is off (lines appear
 * full), functional state words (`working`, `queued`, `● finished`, …)
 * remain — only decorative movement is removed.
 */

export const WORKING_FRAMES = ["◐", "◑", "◒", "◓"] as const

/** Legacy alias: the pre-slice-B generic name for the working frames. Kept so older anchors keep compiling; new code uses the named sets below. */
export const STREAMING_FRAMES = WORKING_FRAMES

export const WAITING_FRAMES = ["○", "◌"] as const

export const TOOL_FRAMES = ["▸", "▹"] as const

/** Textual shimmer cells: each frame is exactly 3 cells wide, no reflow. */
export const THINKING_FRAMES = ["·  ", "˙  ", " ⋮ ", "·  "] as const

/** Queued agents are parked, never animated. */
export const QUEUED_FRAME = "○"

function cycle<const F extends readonly string[]>(frames: F, tick: number): F[number] {
  const index = ((tick % frames.length) + frames.length) % frames.length
  return frames[index]
}

/** Working/live spinner frame for a tick. Pure, modular, constant-width. */
export function workingFrame(tick: number): string {
  return cycle(WORKING_FRAMES, tick)
}

/** Pre-slice-B name for {@link workingFrame}. */
export function streamingFrame(tick: number): string {
  return workingFrame(tick)
}

/** Pending-work alternation frame for a tick. Pure, modular, constant-width. */
export function waitingFrame(tick: number): string {
  return cycle(WAITING_FRAMES, tick)
}

/** Tool-activity chevron nudge for a tick. Pure, modular, constant-width. */
export function toolFrame(tick: number): string {
  return cycle(TOOL_FRAMES, tick)
}

/** Thinking-verb shimmer cell for a tick. Pure, modular, constant-width. */
export function thinkingFrame(tick: number): string {
  return cycle(THINKING_FRAMES, tick)
}

/** Queued agents always render this static mark, regardless of tick. */
export function queuedFrame(): string {
  return QUEUED_FRAME
}

export type MotionState = { busy: boolean; live: boolean; composerActive: boolean }

/** Motion runs only while something is in flight or being composed. */
export function motionActive(state: MotionState): boolean {
  return state.busy || state.live || state.composerActive
}

/**
 * Reduced-motion gate: `ENSEMBLE_REDUCED_MOTION=1` (or `true`,
 * case-insensitive) or `NO_COLOR` present (any value — presence is the
 * signal per the NO_COLOR convention). Color suppression stays a separate
 * concern; this gate only freezes decorative movement.
 */
export function isReducedMotion(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.ENSEMBLE_REDUCED_MOTION
  if (flag === "1" || flag?.toLowerCase() === "true") return true
  return env.NO_COLOR !== undefined
}

/**
 * Tick to render: frame 0 (the still frame) under reduced motion, otherwise
 * the live tick. Callers pass `effectiveTick(tick)` into the frame helpers
 * so a reduced-motion run is statically frame-0 across all sets.
 */
export function effectiveTick(tick: number, env: NodeJS.ProcessEnv = process.env): number {
  return isReducedMotion(env) ? 0 : tick
}

/**
 * Idle-quiescence predicate for the 4 fps clock: run an interval only while
 * motion is active AND reduced motion is off. Idle, finalized, unmounted, or
 * route-left screens hold tick 0 with no timers. The 250 ms snapshot poll is
 * data invalidation, not motion, and is unaffected by this gate.
 */
export function shouldRunMotion(state: MotionState, env: NodeJS.ProcessEnv = process.env): boolean {
  return motionActive(state) && !isReducedMotion(env)
}

/** One-shot static mark for empty states; rendered once, never animated. */
export const EMPTY_MARK = "○───○───○"
