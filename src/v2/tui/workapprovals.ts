import type { Approval } from "../types.ts"
import { chromeJoin } from "./separators.ts"

/**
 * Ticket #173/#185: approvals are the right column's second surface.
 *
 * In split mode a small summary sits at the bottom of the Work pane; `v` or
 * Enter opens the full-height inbox over Work. The full pane reuses the same
 * pending memo and cursor as the old inline section, so there is exactly one
 * approval surface and one resolution flow.
 */

export const MAX_INLINE_APPROVALS = 3

/** The three right-column modes; closed is owned by the #183 column switch. */
export type ApprovalsColumnMode = "closed" | "split" | "full"

/** The only durable approval-mode bit: whether the inbox is opened over Work. */
export type ApprovalsModeState = { full: boolean }

/** `v` opens the full inbox; the right column is opened first by the caller. */
export function openFullApprovals(state: ApprovalsModeState): ApprovalsModeState {
  return state.full ? state : { full: true }
}

/** Esc closes the inbox back to split mode; the small summary remains. */
export function closeFullApprovals(_state: ApprovalsModeState): ApprovalsModeState {
  return { full: false }
}

/** Derive the rendered mode from the explicit bit and the durable column switch. */
export function approvalsColumnMode(state: ApprovalsModeState, rightVisible: boolean): ApprovalsColumnMode {
  if (!rightVisible) return "closed"
  return state.full ? "full" : "split"
}

/**
 * Ticket #185: the right column is workspace-scoped. Rows carrying another
 * workspace never enter this inbox; unattributed rows are kept only when no
 * workspace is in view (the legacy/no-workspace case).
 */
export function approvalsForWorkspace(
  approvals: Readonly<Record<string, Approval>>,
  workspaceID: string | undefined,
): Approval[] {
  return Object.values(approvals).filter((approval) =>
    approval.workspaceID === undefined ? workspaceID === undefined : approval.workspaceID === workspaceID,
  )
}

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
  /** Pending approvals the small section cannot show. */
  overflow: number
  /** The focused row's pending index; undefined when the list is empty. */
  cursor: number | undefined
}

/** One clamp for inline rows, shared by body-height sizing and the window. */
function inlineApprovalRows(limit: number): number {
  return Math.max(1, Math.min(MAX_INLINE_APPROVALS, Math.floor(limit) || 1))
}

/**
 * Rows available to the sticky section. The header always takes one row, and
 * a tiny body still shows one approval rather than hiding the decision.
 */
export function workApprovalLimit(bodyHeight: number): number {
  const body = Math.max(0, Math.floor(bodyHeight))
  return inlineApprovalRows(body - 1 || 1)
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
  const rows = inlineApprovalRows(limit)
  const selected = Math.max(0, Math.min(total - 1, Math.floor(cursor) || 0))
  const start = rows >= total ? 0 : Math.max(0, Math.min(total - rows, selected - Math.floor(rows / 2)))
  return {
    total,
    rows: approvals.slice(start, start + rows).map((approval, offset) => ({ approval, index: start + offset })),
    overflow: Math.max(0, total - rows),
    cursor: selected,
  }
}

/**
 * The full inbox spends two rows per approval (title and detail), so its
 * window is smaller than the raw body row count. One row stays reserved for
 * the empty line and the scroll margin.
 */
export function fullApprovalLimit(bodyHeight: number): number {
  const body = Math.max(2, Math.floor(bodyHeight) || 2)
  return Math.max(1, Math.floor((body - 1) / 2))
}

/** The full inbox window: same pending list and cursor, a taller limit. */
export function fullApprovalsSection(
  approvals: readonly Approval[],
  cursor: number,
  bodyHeight: number,
): WorkApprovalSection {
  return workApprovalSection(approvals, cursor, fullApprovalLimit(bodyHeight))
}

export type ApprovalsPaneLayout = {
  /** Work body rows; zero in full mode because the inbox covers the column. */
  workBodyHeight: number
  /** Pending rows the approval pane can show. */
  approvalRows: number
}

/**
 * One layout for both modes. Split reserves the small pane's rows (header and
 * border are the +2) from Work; full gives the whole body to the inbox and
 * leaves Work with no rows. An empty list never reserves a small pane.
 */
export function approvalsPaneLayout(
  mode: "split" | "full",
  bodyHeight: number,
  pending: number,
): ApprovalsPaneLayout {
  const body = Math.max(2, Math.floor(bodyHeight) || 2)
  if (mode === "full") return { workBodyHeight: 0, approvalRows: fullApprovalLimit(body) }
  const total = Math.max(0, Math.floor(pending) || 0)
  if (total === 0) return { workBodyHeight: body, approvalRows: 0 }
  const rows = workApprovalLimit(body)
  return { workBodyHeight: Math.max(2, body - rows - 2), approvalRows: rows }
}

/** Small-header: count, `+N more`, and the key that opens the inbox. */
export function workApprovalsHeader(
  section: Pick<WorkApprovalSection, "total" | "overflow">,
  focused: boolean,
): string {
  const count = `${Math.max(0, Math.floor(section.total))} pending`
  const parts = [`APPROVALS ${count}`]
  if (section.overflow > 0) parts.push(`+${section.overflow} more`)
  parts.push(focused ? "enter open" : "v open")
  return chromeJoin(parts)
}

/** Full-header: the inbox grammar; Esc returns to split mode. */
export function fullApprovalsHeader(section: Pick<WorkApprovalSection, "total" | "cursor">): string {
  const total = Math.max(0, Math.floor(section.total))
  const parts = [`APPROVALS ${total} pending`]
  if (total > 0) parts.push(`${Math.max(0, Math.min(total - 1, Math.floor(section.cursor ?? 0))) + 1}/${total}`)
  parts.push("j/k move", "enter resolve", "esc split")
  return chromeJoin(parts)
}
