/**
 * Shared Work-pane lifetimes. Ticket #136 removed the per-task recent-card
 * window: a complete dispatch group now clears as one unit after a short
 * shared hold, so the final green or red states stay perceptible.
 */

/** A complete dispatch group stays mounted for this long after its latest terminal task. */
export const WORK_GROUP_HOLD_MS = 1_200

/** Tide assignments are presentation state and keep their own independent retention. */
export const TIDE_ASSIGNMENT_RETENTION_MS = 8_000
