/**
 * Ticket #126 approvals inbox motion. The inbox is a view over durable
 * approval rows, so motion is derived from transitions: a newly pending
 * approval carries one short emphasis, and a pending row that resolves
 * settles once before it leaves the pending list. Both windows stop; neither
 * is a loop, and reduced motion mounts the final tone without emphasis.
 */

import type { Approval } from "../types.ts"
import { isReducedMotion } from "./motion.ts"

/** One-shot emphasis on a newly arrived pending approval. */
export const APPROVAL_EMPHASIS_MS = 600

/** How long a resolved approval stays as a display-only settle row. */
export const APPROVAL_RESOLVE_SETTLE_MS = 1_200

/** The resolution's confirmation tone holds this long, then settles muted. */
export const APPROVAL_RESOLVE_EMPHASIS_MS = 300

/** App cadence while an emphasis or resolution settle is active. */
export const APPROVAL_MOTION_STEP_MS = 100

/** Keep the inbox bounded when several approvals resolve together. */
export const APPROVAL_RESOLVE_LIMIT = 3

export type ApprovalInboxTrack = {
  initialized: boolean
  /** Pending rows from the previous snapshot, kept for their title on resolve. */
  pending: Map<string, Approval>
  /** First observation time for genuinely new pending ids only. */
  arrivals: Map<string, number>
  /** Display-only resolution settles, oldest first. */
  resolved: Map<string, { approval: Approval; at: number }>
}

export type ApprovalResolvedSettle = {
  approval: Approval
  ageMs: number
}

export type ApprovalInboxMotion = {
  /** Pending approval ids inside their one-shot arrival emphasis. */
  emphasized: Set<string>
  /** Recently resolved approvals, oldest resolution first. */
  resolved: ApprovalResolvedSettle[]
  /** True while an emphasis or resolution settle still needs repainting. */
  active: boolean
}

export function createApprovalInboxTrack(): ApprovalInboxTrack {
  return {
    initialized: false,
    pending: new Map(),
    arrivals: new Map(),
    resolved: new Map(),
  }
}

/**
 * Observe the durable approval rows and return the inbox's motion view. The
 * first observation is a baseline: approvals already pending when the app
 * mounts never flash as arrivals. A pending row that disappears without a
 * resolved status (workspace pruning) is not shown as a resolution.
 */
export function updateApprovalInboxMotion(
  track: ApprovalInboxTrack,
  approvals: readonly Approval[],
  now: number,
  env: NodeJS.ProcessEnv = process.env,
): ApprovalInboxMotion {
  const byID = new Map(approvals.map((approval) => [approval.id, approval]))
  const pendingIDs = new Set(approvals.filter((approval) => approval.status === "pending").map((approval) => approval.id))

  if (!track.initialized) {
    track.initialized = true
    for (const id of pendingIDs) {
      const approval = byID.get(id)
      if (approval) track.pending.set(id, approval)
    }
  } else {
    for (const id of pendingIDs) {
      const approval = byID.get(id)
      if (!approval) continue
      if (!track.pending.has(id)) {
        track.arrivals.set(id, now)
        track.resolved.delete(id)
      }
      track.pending.set(id, approval)
    }
    for (const [id, previous] of [...track.pending]) {
      if (pendingIDs.has(id)) continue
      track.pending.delete(id)
      track.arrivals.delete(id)
      const current = byID.get(id) ?? previous
      if (current.status === "pending") continue
      track.resolved.set(id, { approval: current, at: now })
    }
  }

  for (const [id, entry] of track.resolved) {
    if (settleAge(entry.at, now) >= APPROVAL_RESOLVE_SETTLE_MS) track.resolved.delete(id)
  }

  const emphasized = new Set<string>()
  if (!isReducedMotion(env)) {
    for (const id of pendingIDs) {
      const arrivedAt = track.arrivals.get(id)
      if (arrivedAt === undefined) continue
      if (settleAge(arrivedAt, now) < APPROVAL_EMPHASIS_MS) emphasized.add(id)
    }
  }

  const resolved = [...track.resolved.values()]
    .slice(-APPROVAL_RESOLVE_LIMIT)
    .map((entry) => ({ approval: entry.approval, ageMs: settleAge(entry.at, now) }))

  return { emphasized, resolved, active: emphasized.size > 0 || resolved.length > 0 }
}

/** Resolution tone: a short confirmation, then the quiet final tone. */
export function approvalResolvedTone(ageMs: number, env: NodeJS.ProcessEnv = process.env): "good" | "muted" {
  if (isReducedMotion(env)) return "muted"
  return settleAge(0, ageMs) < APPROVAL_RESOLVE_EMPHASIS_MS ? "good" : "muted"
}

/** Age clamped at zero so clock skew or an early read never expires a settle. */
function settleAge(at: number, now: number): number {
  if (!Number.isFinite(at) || !Number.isFinite(now)) return Number.POSITIVE_INFINITY
  return Math.max(0, now - at)
}
