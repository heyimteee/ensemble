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

/** Leader marker: pulses while active, rests on the still frame when idle. */
export const LEADER_FRAMES = ["●", "○"] as const

export function leaderGlyph(active: boolean, tick: number): string {
  if (!active) return LEADER_FRAMES[1]
  return tick % 2 === 0 ? LEADER_FRAMES[0] : LEADER_FRAMES[1]
}

export type MotionState = { busy: boolean; live: boolean; composerActive: boolean }

/** Motion runs only while something is in flight or being composed. */
export function motionActive(state: MotionState): boolean {
  return state.busy || state.live || state.composerActive
}

/** One-shot static mark for empty states; rendered once, never animated. */
export const EMPTY_MARK = "○───○───○"
