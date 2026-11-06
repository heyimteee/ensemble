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
 * - working `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏` (10f Braille) — WORK rows for running
 *   work, rail busy counts, live activity lines, and resolving approvals.
 *   This is the app's signature liveness mark.
 * - waiting `▫ ▪` (2f alternating, 500 ms/step) — pending WORK rows and
 *   queued/backoff activity. Calm, distinct from working and never a circle.
 * - tool `▸ ▹` (2f chevron nudge) — tool-kind activity verbs
 *   (reading/searching/running/writing); folds to `▸` when done.
 * - thinking `·   / ˙   /  ⋮  / ·  ` (4f textual shimmer on the activity
 *   verb) — the terminal reduction of OpenBot's shimmer sweep.
 * - queued `▫` (static — NEVER animated; queued is parked, not live).
 * - done `● / ✕ / ⊘` (static final frames, announced once, no animation).
 *
 * Reduced motion: `ENSEMBLE_REDUCED_MOTION=1` (or `true`) or `NO_COLOR`
 * present pins every animated cell to its frame-0 glyph via `effectiveTick`
 * (so the working frame is `⠋`) and stops the clock via `shouldRunMotion`.
 * Stagger is off (lines appear full), functional state words (`working`,
 * `queued`, `● finished`, …) remain — only decorative movement is removed.
 */

export const WORKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

export const WAITING_FRAMES = ["▫", "▪"] as const

export const TOOL_FRAMES = ["▸", "▹"] as const

/** Textual shimmer cells: each frame is exactly 3 cells wide, no reflow. */
export const THINKING_FRAMES = ["·  ", "˙  ", " ⋮ ", "·  "] as const

/** Queued agents are parked, never animated. */
export const QUEUED_FRAME = "▫"

function cycle<const F extends readonly string[]>(frames: F, tick: number): F[number] {
  const index = ((tick % frames.length) + frames.length) % frames.length
  return frames[index]
}

/** Working/live Braille frame for a tick. Pure, modular, constant-width. */
export function workingFrame(tick: number): string {
  return cycle(WORKING_FRAMES, tick)
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

/**
 * First-paint stagger budget (brief §4, review finding 4): newly arrived
 * transcript rows enter over at most 6 lines × 40 ms (~240 ms, about one
 * motion tick). Only the first `STAGGER_CAP` new ids per paint stagger; the
 * rest mount full. Glyph/color only, no reflow; scroll position and
 * finalization are unaffected (identity stays id-keyed, the scrollbox keeps
 * its stable identity).
 */
export const STAGGER_CAP = 6

/** Per-row stagger step. Total entrance ≈ (STAGGER_CAP - 1) × STEP ≈ 200 ms. */
export const STAGGER_STEP_MS = 40

/**
 * Entrance delay for the index-th newly arrived row (oldest first). Pure.
 * Under reduced motion every row mounts static (0 ms); negative indices and
 * rows past the cap mount full (capped delay).
 */
export function staggerDelayMs(index: number, env: NodeJS.ProcessEnv = process.env): number {
  if (isReducedMotion(env)) return 0
  if (index < 0) return 0
  return Math.min(index, STAGGER_CAP - 1) * STAGGER_STEP_MS
}

/**
 * Mount-once stagger tracker (review findings 4–5). One instance lives with
 * the transcript: `seen` marks every id that has painted at least once, so a
 * row animates only on mount and never re-animates per streaming chunk or
 * snapshot poll; `mountedAt` records the motion tick of first paint so the
 * entrance lasts exactly one tick. Rows that leave the window are pruned, so
 * the guard stays bounded by the transcript window — the documented limit is
 * that a burst larger than the window re-staggers only ids it has never seen.
 */
export type StaggerState = { seen: Set<string>; mountedAt: Map<string, number> }

export function createStaggerState(): StaggerState {
  return { seen: new Set<string>(), mountedAt: new Map<string, number>() }
}

/**
 * Compute the ids staggering on this paint, oldest first, capped. Marks
 * every id seen (idle/reduced-motion rows mount full but are still marked,
 * so a later live tick never staggers them). Mutates only the passed-in
 * state; callers pass the current transcript ids in order.
 */
export function updateStagger(
  state: StaggerState,
  idsInOrder: readonly string[],
  tick: number,
  motion: boolean,
  env: NodeJS.ProcessEnv = process.env,
  cap: number = STAGGER_CAP,
): Set<string> {
  const staggering = new Set<string>()
  const live = new Set(idsInOrder)
  for (const id of state.seen) {
    if (!live.has(id)) {
      state.seen.delete(id)
      state.mountedAt.delete(id)
    }
  }
  if (!motion || isReducedMotion(env)) {
    for (const id of idsInOrder) state.seen.add(id)
    return staggering
  }
  // Rows already staggering from this tick count toward the cap, so a burst
  // split across two paints in one tick still staggers at most `cap` rows.
  let tickStaggering = 0
  for (const id of idsInOrder) if (state.mountedAt.get(id) === tick) tickStaggering++
  for (const id of idsInOrder) {
    if (state.seen.has(id)) {
      if (state.mountedAt.get(id) === tick) staggering.add(id)
      continue
    }
    state.seen.add(id)
    if (tickStaggering >= cap) continue
    state.mountedAt.set(id, tick)
    staggering.add(id)
    tickStaggering++
  }
  return staggering
}
