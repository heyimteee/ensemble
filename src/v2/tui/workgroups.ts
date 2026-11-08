import { dispatchBudgetLabel, dispatchGroupContinued } from "../dispatch-budget.ts"
import type { WorkGroup } from "../work-groups.ts"

/**
 * Ticket #136: dispatch-group labels shared by the Work pane and its compact
 * fallback. Group membership, visibility, and the shared completion hold live
 * in `../work-groups.ts`; the pane layout lives in `workpane.ts`. This module
 * keeps only the header grammar, so the retired chat-column layout cannot
 * drift back in.
 */

export {
  nextWorkInvalidation,
  orderedGroupTasks,
  workFinishedAt,
  workGroupCounts,
  workGroupsForTasks,
} from "../work-groups.ts"
export type { WorkGroup, WorkGroupOptions } from "../work-groups.ts"

/**
 * A subtle label shown only when more than one group is visible. Ticket #160
 * adds the ledger budget; ticket #162 adds continuation lineage and the
 * exhausted/continued controlled-stop words. The renderer truncates the line,
 * and the status counts stay after it so a narrow width still names the
 * group's work.
 */
export function workGroupLabel(
  group: Pick<WorkGroup, "active" | "done" | "budget" | "continuationIndex" | "parentContinuationIndex" | "exhausted" | "closeReason">,
  ordinal: number,
): string {
  const parts = [`GROUP ${Math.max(1, Math.floor(ordinal))}`]
  const continuation = group.continuationIndex ?? 0
  if (continuation > 0) {
    parts.push(`CONT ${continuation}`)
    if (group.parentContinuationIndex !== undefined) {
      parts.push(`from ${group.parentContinuationIndex === 0 ? "root" : `CONT ${group.parentContinuationIndex}`}`)
    }
  }
  if (group.exhausted) parts.push("EXHAUSTED")
  if (dispatchGroupContinued(group)) parts.push("CONTINUED")
  // Status first, budget detail last: the old `GROUP n · X active · Y done`
  // prefix stays stable for readers and live anchors.
  parts.push(`${group.active} active`, `${group.done} done`)
  if (group.budget) parts.push(dispatchBudgetLabel(group.budget, "full"))
  return parts.join(" · ")
}
