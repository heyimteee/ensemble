import { alignedDetailRows, fuzzyMatch } from "./format.ts"
import { chromeJoin } from "./separators.ts"

export function toggleSelected(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

export function pickerWindow(cursor: number, length: number, max = 8): { start: number; end: number } {
  const start = Math.max(0, Math.min(cursor - Math.floor(max / 2), Math.max(0, length - max)))
  return { start, end: Math.min(length, start + max) }
}

/** Value shape of one picker candidate. Detail joins the aligned cell. */
export type PickerCandidate = { id: string; label: string; detail?: string }

/** Value shape of one picker/overlay row (mirrors PickerItem in components.tsx). */
export type PickRow = { id: string; label: string; selected: boolean }

/**
 * Anti-jank identity for picker/overlay rows (review finding 5): return the
 * previous array when every row value-compares equal, so Solid keeps row
 * identity across snapshot polls and picker rows do not re-render.
 * Attachment rows need no equivalent — attachments are refused visibly and
 * never queued, so no attachment list renders in the TUI.
 *
 * Documented limit: comparison is shallow over id/label/selected in order;
 * callers must pass rows in stable order (they do — filtered candidates keep
 * catalog order). Pure.
 */
export function stablePickerItems(previous: readonly PickRow[], next: readonly PickRow[]): readonly PickRow[] {
  if (previous.length !== next.length) return next
  for (let index = 0; index < next.length; index++) {
    const a = previous[index]
    const b = next[index]
    if (a.id !== b.id || a.label !== b.label || a.selected !== b.selected) return next
  }
  return previous
}

/** Ticket #174: one workspace member ranked for the group-chat selector. */
export type NativePickerMember = {
  id: string
  name: string
  /** Role title, the same label the rail and member wizard show. */
  title: string
  leader: boolean
  busy: boolean
}

/**
 * Ticket #174: workspace-member candidates for the group-chat native picker.
 * The name is the aligned label; role, leader state, and busy state form the
 * detail cell every row shares. Pure; the adapter only reads agents.
 */
export function nativePickerCandidates(members: readonly NativePickerMember[], separator?: string): PickerCandidate[] {
  return members.map((member) => ({
    id: member.id,
    label: member.name,
    detail: chromeJoin([
      member.title.trim() || "no title",
      member.leader ? "leader" : "member",
      member.busy ? "busy" : "idle",
    ], separator),
  }))
}

/**
 * Ticket #174: the existing picker filter owns the grammar. A query matches
 * the name or any visible detail field, so `engineering`, `leader`, and
 * `busy` all narrow the workspace-member selector.
 */
export function filterPickerCandidates(candidates: readonly PickerCandidate[], query: string): readonly PickerCandidate[] {
  const needle = query.trim()
  if (!needle) return candidates
  return candidates.filter((candidate) =>
    fuzzyMatch(needle, candidate.label) || (candidate.detail ? fuzzyMatch(needle, candidate.detail) : false),
  )
}

/**
 * Ticket #174: the visible picker rows with one aligned name column. Filtering
 * first means the column is computed for the rows the user can actually see,
 * and a query change can never leave a stale separator position. Pure.
 */
export function pickerCandidateRows(
  candidates: readonly PickerCandidate[],
  query: string,
  options: { maxWidth?: number; separator?: string } = {},
): Array<{ id: string; label: string }> {
  const visible = filterPickerCandidates(candidates, query)
  const labels = alignedDetailRows(visible, options)
  return visible.map((candidate, index) => ({ id: candidate.id, label: labels[index] ?? candidate.label }))
}

export type SessionBindingLike = { sessionID: string }

/** Ticket #174: the workspace + agent key the binding map uses. */
export function boundSessionID(
  bindings: Readonly<Record<string, SessionBindingLike | undefined>>,
  workspaceID: string,
  agentID: string,
): string | undefined {
  return bindings[`${workspaceID}:${agentID}`]?.sessionID
}

/** Ticket #174: one clear missing-session message for every `o` surface. */
export function missingNativeSessionMessage(agentName?: string): string {
  return agentName
    ? `No native session for ${agentName} yet — send a message first.`
    : "No native session yet — send a message first."
}

export type NativeRouteSurface =
  | { kind: "agent"; sessionID?: string; agentName?: string }
  | { kind: "workspace" }
  | null

export type NativeRouteInput = {
  surface: NativeRouteSurface
  /** Interaction focus, so Work keeps its focused card one key away. */
  focus: string
  /** The focused Work card's assignee, when Work focus has a card. */
  assignee?: { id: string; name: string }
  /** Workspace binding lookup; undefined means the agent has no session yet. */
  bindingFor?: (agentID: string) => SessionBindingLike | undefined
}

export type NativeRoute =
  | { kind: "navigate"; sessionID: string }
  | { kind: "picker" }
  | { kind: "missing"; message: string }

/**
 * Ticket #174: the single `o` decision.
 *
 * A Direct conversation keeps its agent direct. A group chat asks which
 * workspace member unless Work focus already names the assignee. The leader
 * menu passes the same input, so it follows the current surface instead of
 * keeping a second grammar. Every dead end returns an explicit message; the
 * adapter turns it into a toast and never navigates silently.
 */
export function nativeSessionRoute(input: NativeRouteInput): NativeRoute {
  const { surface } = input
  if (!surface) return { kind: "missing", message: "Open a workspace or agent first." }
  if (surface.kind === "agent") {
    if (surface.sessionID) return { kind: "navigate", sessionID: surface.sessionID }
    return { kind: "missing", message: missingNativeSessionMessage(surface.agentName) }
  }
  if (input.focus === "work") {
    if (!input.assignee) return { kind: "missing", message: "No focused Work card. Select a card first." }
    const binding = input.bindingFor?.(input.assignee.id)
    if (!binding?.sessionID) return { kind: "missing", message: missingNativeSessionMessage(input.assignee.name) }
    return { kind: "navigate", sessionID: binding.sessionID }
  }
  return { kind: "picker" }
}
