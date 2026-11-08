import type { LogLevel } from "../logging.ts"

/**
 * Ticket #150 follow-up: feed-gap bookkeeping is diagnostic, not a failure
 * signal. Every gap is counted, but a burst collapses into one line per window:
 * a debug `feed.gap.recovered` when `changes.since` caught up, and a warn
 * `feed.gap` only when recovery needed a full snapshot or exhausted its passes.
 */
export type FeedGapObservation = {
  reason: string
  epoch?: number
  from?: number
  version?: number
  entries?: number
  reset?: boolean
}

export type FeedGapOutcome = "recovered" | "full" | "exhausted"

export type FeedGapReporterOptions = {
  emit: (level: Extract<LogLevel, "debug" | "warn">, event: string, fields: Record<string, unknown>) => void
  /** Called once per observed gap so diagnostics keep the true rate. */
  count?: () => void
  /** Trailing aggregation window; default 10 s. */
  windowMs?: number
  now?: () => number
}

export type FeedGapReporter = {
  /** Record one gap and increment the diagnostic counter. */
  record: (observation: FeedGapObservation) => void
  /** Record what the recovery for the current window actually did. */
  settle: (outcome: FeedGapOutcome) => void
  /** Emit the pending window now (tests, teardown). */
  flush: () => void
  dispose: () => void
}

type WindowState = {
  start: number
  gaps: number
  reasons: Set<string>
  last: FeedGapObservation
  fallbacks: number
  full: boolean
  exhausted: boolean
  timer?: ReturnType<typeof setTimeout>
}

/**
 * A trailing-edge summary gives one truthful line per burst instead of one
 * warning per skipped version. Recovery outcomes that arrive after the window
 * closed still produce a warning, so a fallback is never hidden.
 */
export function createFeedGapReporter(options: FeedGapReporterOptions): FeedGapReporter {
  const windowMs = Math.max(1, options.windowMs ?? 10_000)
  const now = options.now ?? Date.now
  let state: WindowState | undefined
  let disposed = false

  const emitSummary = () => {
    const current = state
    if (!current) return
    state = undefined
    if (current.timer !== undefined) {
      clearTimeout(current.timer)
      current.timer = undefined
    }
    if (current.gaps === 0 && current.fallbacks === 0) return
    const warning = current.full || current.exhausted
    const fields: Record<string, unknown> = {
      gaps: current.gaps,
      reasons: [...current.reasons],
      reason: current.last.reason,
      fallbacks: current.fallbacks,
      ...(current.last.epoch !== undefined ? { epoch: current.last.epoch } : {}),
      ...(current.last.from !== undefined ? { from: current.last.from } : {}),
      ...(current.last.version !== undefined ? { version: current.last.version } : {}),
      ...(current.last.entries !== undefined ? { entries: current.last.entries } : {}),
      ...(current.last.reset !== undefined ? { reset: current.last.reset } : {}),
      ...(current.full ? { fullSnapshot: true } : {}),
      ...(current.exhausted ? { exhausted: true } : {}),
    }
    options.emit(warning ? "warn" : "debug", warning ? "feed.gap" : "feed.gap.recovered", fields)
  }

  const schedule = (current: WindowState) => {
    if (current.timer !== undefined) return
    const delay = Math.max(1, current.start + windowMs - now())
    current.timer = setTimeout(() => {
      current.timer = undefined
      emitSummary()
    }, delay)
    current.timer.unref?.()
  }

  const ensureWindow = (last: FeedGapObservation): WindowState => {
    if (!state) {
      state = {
        start: now(),
        gaps: 0,
        reasons: new Set(),
        last,
        fallbacks: 0,
        full: false,
        exhausted: false,
      }
    }
    return state
  }

  return {
    record(observation: FeedGapObservation): void {
      if (disposed) return
      const current = ensureWindow(observation)
      current.gaps += 1
      current.reasons.add(observation.reason)
      current.last = observation
      options.count?.()
    },
    settle(outcome: FeedGapOutcome): void {
      if (disposed) return
      if (!state) {
        // A fallback that was not preceded by a recorded gap still deserves a
        // warning; recovered outcomes without a gap need no line.
        if (outcome === "recovered") return
        ensureWindow({ reason: outcome === "exhausted" ? "exhausted" : "full-snapshot" })
      }
      const current = state!
      if (outcome !== "recovered") {
        current.fallbacks += 1
        if (outcome === "full") current.full = true
        if (outcome === "exhausted") current.exhausted = true
      }
      schedule(current)
    },
    flush(): void {
      emitSummary()
    },
    dispose(): void {
      if (disposed) return
      emitSummary()
      disposed = true
    },
  }
}
