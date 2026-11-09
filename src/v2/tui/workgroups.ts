import { dispatchBudgetLabel, dispatchGroupContinued } from "../dispatch-budget.ts"
import { workFinishedAt, type WorkGroup } from "../work-groups.ts"

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

/** The latest terminal finish in a history group, with the recorded hold origin as fallback. */
export function workHistoryFinishedAt(
  group: Pick<WorkGroup, "tasks" | "latestTerminalAt" | "createdAt"> & { native?: WorkGroup["native"] },
): number {
  let latest: number | undefined
  for (const task of group.tasks) {
    const finished = workFinishedAt(task)
    if (finished !== undefined && (latest === undefined || finished > latest)) latest = finished
  }
  // Ticket #187: a finished native subagent ages the same as a task card.
  for (const run of group.native ?? []) {
    const finished = run.finishedAt ?? run.startedAt
    if (latest === undefined || finished > latest) latest = finished
  }
  return latest ?? group.latestTerminalAt ?? group.createdAt
}

/**
 * Ticket #184: the one-line grammar for a rolled-up history group. Done count
 * first, active count only while the group still has live work, then age. The
 * caller computes the age once from the canonical finish timestamp.
 */
export function workHistoryRollupLabel(
  group: Pick<WorkGroup, "active" | "done">,
  ordinal: number,
  age: string,
): string {
  const parts = [`GROUP ${Math.max(1, Math.floor(ordinal))}`, `${Math.max(0, group.done)} done`]
  if (group.active > 0) parts.push(`${group.active} active`)
  parts.push(age)
  return parts.join(" · ")
}
