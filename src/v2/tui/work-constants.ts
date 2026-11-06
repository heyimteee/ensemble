/**
 * Shared Work-card lifetimes. The recent-card window and the tide-assignment
 * retention are the same eight seconds: an assignment may only outlive the
 * card it belongs to. Keeping the literal in one module stops the two clocks
 * from drifting apart.
 */

/** Recently finished Work cards stay visible, and tide state stays assigned, for this window. */
export const RECENT_WORK_TTL_MS = 8_000
