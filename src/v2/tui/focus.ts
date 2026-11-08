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
export type FocusZone = "rail" | "chat" | "work" | "approvals"

/**
 * Ticket #173: forward order is rail -> chat -> work -> approvals, skipping
 * empty zones and wrapping to the rail. Reverse mirrors it. Approvals live in
 * the Work pane but are their own keyboard zone; a pane with pending
 * approvals remains reachable even when it has no cards.
 */
export function nextFocusZone(
  current: FocusZone,
  direction: 1 | -1,
  hasWork: boolean,
  hasApprovals: boolean = false,
): FocusZone {
  const zones: FocusZone[] = ["rail", "chat"]
  if (hasWork) zones.push("work")
  if (hasApprovals) zones.push("approvals")
  const index = zones.indexOf(current)
  if (index >= 0) return zones[(index + direction + zones.length) % zones.length]!
  // The current zone vanished between frames: move to the logical neighbour.
  if (current === "work") return direction === 1 ? (hasApprovals ? "approvals" : "rail") : "chat"
  if (current === "approvals") return direction === 1 ? "rail" : hasWork ? "work" : "chat"
  return direction === 1 ? zones[1] ?? "rail" : zones[zones.length - 1] ?? "rail"
}

/** Move a list cursor by half a page, clamped to the available rows. */
export function halfPageCursor(cursor: number, total: number, direction: 1 | -1, pageSize: number): number {
  if (total <= 0) return 0
  const clamped = Math.max(0, Math.min(total - 1, Math.trunc(cursor)))
  const step = Math.max(1, Math.floor(Math.max(0, pageSize) / 2))
  return Math.max(0, Math.min(total - 1, clamped + direction * step))
}
