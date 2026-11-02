/**
 * Idle-quiescent motion primitives. Every animated indicator is a pure frame
 * function over an integer tick: the TUI advances the tick at a low frame
 * rate only while motion is active (busy, live, or composing) and resets to
 * tick 0 — the still frame — otherwise. No perpetual loops, no marquees.
 */

/** Working/streaming spinner frames; the literal "streaming…" anchor stays. */
export const STREAMING_FRAMES = ["◐", "◑", "◒", "◓"] as const

export function streamingFrame(tick: number): string {
  const index = ((tick % STREAMING_FRAMES.length) + STREAMING_FRAMES.length) % STREAMING_FRAMES.length
  return STREAMING_FRAMES[index]
}

/** Composer caret: blinks only while focused, constant width either way. */
export function composerCaret(focused: boolean, tick: number): string {
  if (!focused) return " "
  return tick % 2 === 0 ? "▌" : " "
}

/**
 * Motion correction (ticket #56): the only animated indicators are the
 * working/streaming frames and the composer caret. The rail leader pulse and
 * the one-shot new-message reveal were removed as decorative motion.
 *
 * Screenshot-unavailable assumption: the screenshots identifying the
 * decorative animations were unavailable during research, so the removal set
 * is interpreted as the rail leader pulse (`leaderGlyph` here) and the
 * newest-message reveal highlight (the `recentID` tint in app.tsx). Confirm
 * the target set before changing any other motion; functional motion
 * (working frames, composer caret, status transitions) is kept regardless.
 */

export type MotionState = { busy: boolean; live: boolean; composerActive: boolean }

/** Motion runs only while something is in flight or being composed. */
export function motionActive(state: MotionState): boolean {
  return state.busy || state.live || state.composerActive
}

/** One-shot static mark for empty states; rendered once, never animated. */
export const EMPTY_MARK = "○───○───○"
