/**
 * Coalesce high-frequency stream updates into one client apply (ticket #139).
 *
 * Workspace live text arrives as accumulated ephemeral snapshots and direct
 * chats absorb native deltas locally; both feed this one primitive so a burst
 * touches the visible row once per window instead of once per chunk. Each key
 * keeps its final pending value, so duplicate or reordered delivery inside a
 * window collapses to the newest text.
 */
export type StreamCoalescer<T> = {
  push: (key: string, update: (previous: T | undefined) => T) => void
  /** Apply pending updates now. Safe to call with nothing pending. */
  flush: () => void
  /** Drop pending updates without applying them (settle, surface switch). */
  clear: () => void
  dispose: () => void
}

export const STREAM_COALESCE_MS = 32

export function createStreamCoalescer<T>(
  apply: (updates: Map<string, T>) => void,
  delayMs = STREAM_COALESCE_MS,
): StreamCoalescer<T> {
  let pending = new Map<string, T>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const cancel = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const flush = () => {
    cancel()
    if (pending.size === 0) return
    const updates = pending
    pending = new Map()
    apply(updates)
  }

  const schedule = () => {
    if (disposed || timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      flush()
    }, delayMs)
    timer.unref?.()
  }

  return {
    push: (key, update) => {
      if (disposed) return
      pending.set(key, update(pending.get(key)))
      schedule()
    },
    flush,
    clear: () => {
      cancel()
      pending = new Map()
    },
    dispose: () => {
      disposed = true
      cancel()
      pending = new Map()
    },
  }
}
