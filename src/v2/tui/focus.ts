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

/** Move a list cursor by half a page, clamped to the available rows. */
export function halfPageCursor(cursor: number, total: number, direction: 1 | -1, pageSize: number): number {
  if (total <= 0) return 0
  const clamped = Math.max(0, Math.min(total - 1, Math.trunc(cursor)))
  const step = Math.max(1, Math.floor(Math.max(0, pageSize) / 2))
  return Math.max(0, Math.min(total - 1, clamped + direction * step))
}
