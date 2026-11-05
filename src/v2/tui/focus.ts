/**
 * v5.6 T11: editor focus has to be synchronous once the renderable exists.
 *
 * `i` used to queue the composer focus in a microtask while the Insert hint
 * rendered immediately. A fast key could land in that gap and reach the old
 * surface instead of the textarea, which made the parked-message live probe
 * flaky. Focus the current ref now; only a first mount (ref still null) - or a
 * focus call that races the mount - waits for one microtask.
 */

export type FocusTarget = { focus?: () => void } | null | undefined

export type FocusQueue = (callback: () => void) => void

function tryFocus(target: FocusTarget): boolean {
  if (!target?.focus) return false
  try {
    target.focus()
    return true
  } catch {
    return false
  }
}

export function focusWhenReady(
  read: () => FocusTarget,
  queue: FocusQueue = queueMicrotask,
): boolean {
  if (tryFocus(read())) return true
  queue(() => { tryFocus(read()) })
  return false
}

/** Focus zones reachable with Tab/Shift+Tab; the composer is entered with i/Enter. */
export type FocusZone = "rail" | "chat" | "work"

/**
 * Forward order is rail -> chat -> work (when mounted) -> chat. Reverse
 * mirrors it: work and the transcript return to chat, chat returns to the
 * rail, and the rail reaches the work zone directly when it exists.
 */
export function nextFocusZone(current: FocusZone, direction: 1 | -1, hasWork: boolean): FocusZone {
  if (direction === 1) {
    if (current === "rail") return "chat"
    if (current === "work") return "chat"
    return hasWork ? "work" : "rail"
  }
  if (current === "work") return "chat"
  if (current === "chat") return "rail"
  return hasWork ? "work" : "chat"
}

/** Move a list cursor by half a page, clamped to the available rows. */
export function halfPageCursor(cursor: number, total: number, direction: 1 | -1, pageSize: number): number {
  if (total <= 0) return 0
  const clamped = Math.max(0, Math.min(total - 1, Math.trunc(cursor)))
  const step = Math.max(1, Math.floor(Math.max(0, pageSize) / 2))
  return Math.max(0, Math.min(total - 1, clamped + direction * step))
}
