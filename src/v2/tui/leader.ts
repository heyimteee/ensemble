/**
 * v5.6 Leader which-key timing.
 *
 * The leader mode (and every leader key action) begins on `Space`; only the
 * which-key popup waits a short beat, so a fast `Space q` never waits for a
 * render and the menu still appears for a user who pauses. This module keeps
 * the delay policy pure so the popup timing can be tested without timers.
 */

export const LEADER_POPUP_DELAY_MS = 250

/** True once the short post-leader delay has elapsed. */
export function leaderPopupVisible(openedAt: number | null, now: number, delayMs: number = LEADER_POPUP_DELAY_MS): boolean {
  if (openedAt === null) return false
  return now - openedAt >= Math.max(0, delayMs)
}
