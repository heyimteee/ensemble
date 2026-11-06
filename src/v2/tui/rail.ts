/**
 * Ticket #121 Rail scene attention transitions.
 *
 * The rail is a roster, not a beacon: unread growth, a new pending-approval
 * count, and a newly arrived row each produce one short one-shot signal. The
 * pure transition helpers here compare successive snapshots and emit pulses;
 * they never loop and they never keep state alive after the one-shot window.
 *
 * Reduced motion is a render concern too, but the transition layer refuses to
 * emit pulses under `ENSEMBLE_REDUCED_MOTION`/`NO_COLOR` so a still screen can
 * never start a timer. The existing Braille busy mark is unchanged: it keeps
 * frame 0 through `effectiveTick` in motion.ts.
 */

import { isReducedMotion } from "./motion.ts"

/** One-shot attention pulse for an unread or approval-count increase. */
export const RAIL_PULSE_MS = 640

/** Quiet arrival settle for a row that appeared after the first observation. */
export const RAIL_ARRIVAL_MS = 900

/** Sampling cadence for the one-shot pulse timer (it stops when idle). */
export const RAIL_PULSE_STEP_MS = 100

/** Stable id for the approval-count pulse; the count lives in the rail footer. */
export const RAIL_APPROVAL_ID = "approvals"

export type RailAttentionSnapshot = {
  /** Current unread count per workspace id. Rows without an entry read as 0. */
  unread: Readonly<Record<string, number>>
  /** Current pending-approval count. */
  approvals: number
  /** Rail row keys in render order (`agent:<id>` / `workspace:<id>`). */
  rows: readonly string[]
}

export type RailAttentionState = {
  unread: Readonly<Record<string, number>>
  approvals: number
  seenRows: ReadonlySet<string>
}

export type RailPulseKind = "unread" | "approval" | "arrival"

export type RailPulse = {
  kind: RailPulseKind
  /** Workspace id for unread, `RAIL_APPROVAL_ID` for approvals, row key for arrival. */
  id: string
}

/** Row key shared by the app transition input and the Rail renderer. */
export function railRowKey(kind: "agent" | "workspace", id: string): string {
  return `${kind}:${id}`
}

/** Active pulse start recorded by the app; `railEmphasisAt` resolves it. */
export type RailPulseStart = {
  pulse: RailPulse
  startedAt: number
}

/** The three emphasis sets the Rail renderer reads. Empty means no emphasis. */
export type RailEmphasis = {
  unread: ReadonlySet<string>
  approval: boolean
  arrivals: ReadonlySet<string>
}

/** Fresh empty emphasis; callers never mutate a shared instance. */
export function emptyRailEmphasis(): RailEmphasis {
  return { unread: new Set<string>(), approval: false, arrivals: new Set<string>() }
}

/**
 * True while a one-shot attention pulse is in its short window. Reduced
 * motion has no pulse at all; a deadline read settles immediately and a later
 * read can never restart it.
 */
export function railPulseActive(elapsedMs: number, env: NodeJS.ProcessEnv = process.env): boolean {
  if (isReducedMotion(env)) return false
  return Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < RAIL_PULSE_MS
}

/** True while a newly arrived row is in its quiet, motionless settle window. */
export function railArrivalActive(elapsedMs: number, env: NodeJS.ProcessEnv = process.env): boolean {
  if (isReducedMotion(env)) return false
  return Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < RAIL_ARRIVAL_MS
}

/**
 * Resolve the active one-shot emphasis at `now`. Unread and approval pulses
 * share the short pulse window; arrivals keep a slightly longer quiet settle.
 * Expired starts contribute nothing, so the rail returns to its normal tone.
 */
export function railEmphasisAt(
  starts: readonly RailPulseStart[],
  now: number,
  env: NodeJS.ProcessEnv = process.env,
): RailEmphasis {
  const unread = new Set<string>()
  const arrivals = new Set<string>()
  let approval = false
  for (const start of starts) {
    const elapsed = now - start.startedAt
    if (start.pulse.kind === "unread" && railPulseActive(elapsed, env)) unread.add(start.pulse.id)
    else if (start.pulse.kind === "approval" && railPulseActive(elapsed, env)) approval = true
    else if (start.pulse.kind === "arrival" && railArrivalActive(elapsed, env)) arrivals.add(start.pulse.id)
  }
  return { unread, approval, arrivals }
}

/**
 * Compare one snapshot with the previous baseline. The first observation (or
 * a caller passing `createRailAttentionState()`) is the baseline and never
 * pulses. Afterwards:
 *
 * - a workspace whose unread count grew pulses once;
 * - an increased pending-approval count pulses once;
 * - an unseen row key pulses once as a quiet arrival.
 *
 * Repeated snapshots with the same values emit nothing, so a poll can never
 * restart a pulse. Decreases and resolution are silent. The returned state is
 * new, leaving the previous baseline unusable for further transitions only by
 * the caller's choice (the helper itself is pure).
 */
export function observeRailAttention(
  previous: RailAttentionState | null,
  snapshot: RailAttentionSnapshot,
): { state: RailAttentionState; pulses: RailPulse[] } {
  if (previous === null) {
    return {
      state: {
        unread: { ...snapshot.unread },
        approvals: snapshot.approvals,
        seenRows: new Set(snapshot.rows),
      },
      pulses: [],
    }
  }

  const pulses: RailPulse[] = []
  for (const [id, count] of Object.entries(snapshot.unread)) {
    if (count > (previous.unread[id] ?? 0)) pulses.push({ kind: "unread", id })
  }
  if (snapshot.approvals > previous.approvals) pulses.push({ kind: "approval", id: RAIL_APPROVAL_ID })
  for (const row of snapshot.rows) {
    if (!previous.seenRows.has(row)) pulses.push({ kind: "arrival", id: row })
  }

  return {
    state: {
      unread: { ...snapshot.unread },
      approvals: snapshot.approvals,
      seenRows: new Set([...previous.seenRows, ...snapshot.rows]),
    },
    pulses,
  }
}
