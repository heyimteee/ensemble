/**
 * Ticket #122: one-shot transcript completion and error emphasis.
 *
 * The transcript scene acknowledges a finalized agent message with one brief
 * brighter border/background settle, and a failed/cancelled outcome with one
 * brief error emphasis. This module is the pure transition seam behind those
 * effects: callers feed it the rows observed in the current snapshot and get
 * back only the rows that should start a one-shot beat now.
 *
 * Rules:
 * - Finalizing means a row was observed streaming and is now finalized. A row
 *   that is already finalized when first observed (history) never flashes, and
 *   every later snapshot poll of the same row stays silent.
 * - A failed/cancelled completion row or an interrupted agent row emphasizes
 *   once, on first observation. Repeats never restart the beat.
 * - A streaming row that finalizes interrupted emits only the error beat, not
 *   a normal settle followed by an error beat.
 * - Reduced motion still advances the guard (rows become settled/emphasized)
 *   but emits nothing, so the final state holds with no later flash.
 *
 * Pure: no timers, rendering, or host state. The app owns the short-lived
 * emphasis signal and clears it after `TRANSCRIPT_EMPHASIS_MS`.
 */

/** One brief beat for a completion settle or an error emphasis. */
export const TRANSCRIPT_EMPHASIS_MS = 500

export type TranscriptEmphasisKind = "finalized" | "error"

export type TranscriptRowSignal = {
  id: string
  /** True while this row is still streaming. */
  streaming?: boolean
  /**
   * The caller observed this row enter finalized immediately after a live
   * row ended (direct conversations carry no persisted streaming flag).
   */
  entering?: boolean
  /** True for a failed/cancelled outcome or an interrupted agent message. */
  error?: boolean
}

export type TranscriptMotionState = {
  /** Rows observed streaming at least once and not yet finalized. */
  streaming: Set<string>
  /** Rows that already received their finalization settle. */
  settled: Set<string>
  /** Rows that already received their error emphasis. */
  emphasized: Set<string>
}

export type TranscriptEmphasisEvent = {
  id: string
  kind: TranscriptEmphasisKind
}

export function createTranscriptMotionState(): TranscriptMotionState {
  return { streaming: new Set<string>(), settled: new Set<string>(), emphasized: new Set<string>() }
}

/**
 * Observe one snapshot of transcript rows and return the one-shot emphasis
 * events that begin now. Mutates only the passed-in state. Duplicate ids in a
 * batch collapse to one event because the first pass marks the guard.
 */
export function observeTranscriptMotion(
  state: TranscriptMotionState,
  rows: readonly TranscriptRowSignal[],
  options: { enabled?: boolean } = {},
): TranscriptEmphasisEvent[] {
  const enabled = options.enabled ?? true
  const events: TranscriptEmphasisEvent[] = []
  for (const row of rows) {
    if (row.streaming) {
      state.streaming.add(row.id)
      continue
    }
    // A row settles once whether we watched it stream or observed it enter
    // finalized directly (direct conversations carry no streaming flag).
    const wasStreaming = state.streaming.delete(row.id)
    if ((wasStreaming || row.entering) && !state.settled.has(row.id)) {
      // Exactly one beat per completed row, even when the outcome is an error.
      state.settled.add(row.id)
      state.emphasized.add(row.id)
      if (enabled) events.push({ id: row.id, kind: row.error ? "error" : "finalized" })
      continue
    }
    if (row.error && !state.emphasized.has(row.id)) {
      state.emphasized.add(row.id)
      if (enabled) events.push({ id: row.id, kind: "error" })
    }
  }
  return events
}
