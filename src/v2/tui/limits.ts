import {
  DISPATCH_COMMAND_TIERS,
  DISPATCH_CONTINUATIONS_MAX,
  DISPATCH_CONTINUATIONS_MIN,
  DISPATCH_DEPTH_MAX,
  DISPATCH_DEPTH_MIN,
  DISPATCH_GROUP_TIERS,
  DISPATCH_MIN_GROUP_HOPS,
  dispatchLimitSettings,
  stepDispatchLimit,
  validateDispatchLimits,
  type DispatchLimitField,
  type DispatchLimits,
} from "../dispatch-budget.ts"
import type { Settings } from "../types.ts"

/**
 * Pure row model for the workspace-level dispatch Limits panel (ticket #160).
 * The panel edits the four user ceilings in their allowed tiers; the service
 * validates the same set again on `settings.update`, so the UI is a teaching
 * surface, never the only guard.
 */

export type LimitsRowID = "group" | "command" | "depth" | "continuations"

export const LIMITS_ROW_IDS: readonly LimitsRowID[] = ["group", "command", "depth", "continuations"]

const ROW_FIELDS: Record<LimitsRowID, DispatchLimitField> = {
  group: "groupMaxHops",
  command: "commandMaxHops",
  depth: "depth",
  continuations: "continuations",
}

const ROW_LABELS: Record<LimitsRowID, string> = {
  group: "Group hops",
  command: "Command hops",
  depth: "Depth",
  continuations: "Continuations",
}

const ROW_DETAIL: Record<LimitsRowID, string> = {
  group: DISPATCH_GROUP_TIERS.join(" · "),
  command: DISPATCH_COMMAND_TIERS.join(" · "),
  depth: `${DISPATCH_DEPTH_MIN}–${DISPATCH_DEPTH_MAX}`,
  continuations: `${DISPATCH_CONTINUATIONS_MIN}–${DISPATCH_CONTINUATIONS_MAX} · ${DISPATCH_MIN_GROUP_HOPS}-hop groups`,
}

export const LIMITS_LABEL_WIDTH = 16

export function limitsRowField(row: LimitsRowID): DispatchLimitField {
  return ROW_FIELDS[row]
}

export function limitsRowValue(limits: DispatchLimits, row: LimitsRowID): number {
  return limits[ROW_FIELDS[row]]
}

/** Cycle one row. Group/command move through their tiers; depth/continuations step by one. */
export function cycleLimitsValue(limits: DispatchLimits, row: LimitsRowID, delta: number): DispatchLimits {
  const field = ROW_FIELDS[row]
  return { ...limits, [field]: stepDispatchLimit(field, limits[field], delta) }
}

export type LimitsPanelRow = {
  id: LimitsRowID
  label: string
  value: string
  detail: string
  selected: boolean
  /** Full rendered row, exact grammar shared by the component and tests. */
  text: string
}

export function limitsPanelRows(limits: DispatchLimits, cursor: number): LimitsPanelRow[] {
  const clamped = Math.max(0, Math.min(LIMITS_ROW_IDS.length - 1, Math.trunc(cursor)))
  return LIMITS_ROW_IDS.map((id, index) => {
    const label = ROW_LABELS[id]
    const value = String(limitsRowValue(limits, id))
    const selected = index === clamped
    // An invalid value keeps its marker so the user sees exactly which row
    // the error names; error text lives on its own line below the rows.
    const mark = selected ? "› " : "  "
    return {
      id,
      label,
      value,
      detail: ROW_DETAIL[id],
      selected,
      text: `${mark}${label.padEnd(LIMITS_LABEL_WIDTH)}${value.padEnd(4)}${ROW_DETAIL[id]}`,
    }
  })
}

export function limitsPanelTitle(workspaceName?: string): string {
  return `Dispatch limits${workspaceName ? ` — #${workspaceName}` : ""}`
}

export function limitsPanelSubtitle(): string {
  return "Applies to new commands only; running groups keep their captured caps."
}

export function limitsPanelFooter(): string {
  return "j/k select · h/l change · enter save · esc cancel"
}

export type LimitsSave =
  | { ok: true; patch: Pick<Settings, "dispatchGroupMaxHops" | "dispatchCommandMaxHops" | "dispatchDepth" | "dispatchContinuations"> }
  | { ok: false; error: string }

/** Validate the panel draft into the exact `settings.update` patch. */
export function limitsSave(limits: DispatchLimits): LimitsSave {
  const result = validateDispatchLimits(limits)
  if (!result.ok) return { ok: false, error: result.errors[0]! }
  return { ok: true, patch: dispatchLimitSettings(result.limits) }
}

export function limitsSavedMessage(limits: DispatchLimits): string {
  return `Saved dispatch limits: group ${limits.groupMaxHops} · command ${limits.commandMaxHops} · depth ${limits.depth} · continuations ${limits.continuations}.`
}
