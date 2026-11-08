import type { Approval } from "../types.ts"
import { chromeJoin } from "./separators.ts"

/**
 * Ticket #173: approvals are a sticky bottom section of the Work pane.
 *
 * The section is a view over the existing pending memo: a short window of
 * rows, a bounded overflow count, and a header that teaches the inline grammar.
 * The full inbox stays available with `V` only when the inline rows overflow.
 */

export const MAX_INLINE_APPROVALS = 3

export type InlineApprovalRow = {
  approval: Approval
  /** Index in the full pending list, so `j/k` and `Enter` share one cursor. */
  index: number
}

export type WorkApprovalSection = {
  /** Pending approvals in the workspace, before the window. */
  total: number
  /** The visible window, in pending order. */
  rows: InlineApprovalRow[]
  /** Pending approvals the inline section cannot show. */
  overflow: number
  /** The focused row's pending index; undefined when the list is empty. */
  cursor: number | undefined
}

/**
 * Rows available to the sticky section. The header always takes one row, and
 * a tiny body still shows one approval rather than hiding the decision.
 */
export function workApprovalLimit(bodyHeight: number): number {
  const body = Math.max(0, Math.floor(bodyHeight))
  return Math.max(1, Math.min(MAX_INLINE_APPROVALS, body - 1 || 1))
}

/**
 * Window the pending approvals around the cursor. The header carries the
 * total and the overflow count, so the section never needs a second
 * out-of-band overflow scan.
 */
export function workApprovalSection(
  approvals: readonly Approval[],
  cursor: number,
  limit: number = MAX_INLINE_APPROVALS,
): WorkApprovalSection {
  const total = approvals.length
  if (total === 0) return { total: 0, rows: [], overflow: 0, cursor: undefined }
  const rows = Math.max(1, Math.min(MAX_INLINE_APPROVALS, Math.floor(limit) || 1))
  const selected = Math.max(0, Math.min(total - 1, Math.floor(cursor) || 0))
  const start = rows >= total ? 0 : Math.max(0, Math.min(total - rows, selected - Math.floor(rows / 2)))
  return {
    total,
    rows: approvals.slice(start, start + rows).map((approval, offset) => ({ approval, index: start + offset })),
    overflow: Math.max(0, total - rows),
    cursor: selected,
  }
}

/** Sticky header: count, overflow, the V-only inbox, and the focused grammar. */
export function workApprovalsHeader(
  section: Pick<WorkApprovalSection, "total" | "overflow">,
  focused: boolean,
): string {
  const count = `${Math.max(0, Math.floor(section.total))} pending`
  const parts = [`APPROVALS ${count}`]
  if (section.overflow > 0) {
    parts.push(`${section.overflow} more`, "V inbox")
  }
  parts.push(...(focused ? ["j/k select", "enter resolve", "esc work"] : ["v focus"]))
  return chromeJoin(parts)
}
