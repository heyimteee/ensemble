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
