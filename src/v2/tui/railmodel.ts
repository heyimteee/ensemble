/**
 * Ticket #171: pure rail model for the split Agents / Workspaces panes.
 *
 * The rail is one cursor over a flattened list of visible rows. The Agents
 * pane contributes one header per primary workspace followed by that group's
 * agent rows; the Workspaces pane contributes the workspace rows. Collapse is
 * durable UI input: a collapsed group keeps its counted header and drops its
 * agents from the visible rows, so `j`/`k` skip them without touching the
 * group's membership.
 *
 * The model owns grouping, ordering, filtering, and display labels. The XML
 * renderer and the app adapter only map rows and read the shared cursor.
 */

import { workspaceGroupLabel } from "./format.ts"
import { railGroupLine } from "./settings.ts"

/** Stable group id for agents outside every available workspace. */
export const HOMELESS_RAIL_GROUP = "homeless"

/** Collapse glyphs shared by the header text and its tests. */
export const RAIL_EXPANDED_MARK = "▾"
export const RAIL_COLLAPSED_MARK = "▸"

export type RailAgentInput = {
  id: string
  name: string
  title: string
}

export type RailWorkspaceInput = {
  id: string
  name: string
  directory: string
  leaderID: string
  memberIDs: readonly string[]
  paused: boolean
  lastActiveAt: number
  unread: number
  busy: number
}

export type RailModelInput = {
  agents: readonly RailAgentInput[]
  /** Available (non-archived) workspaces; the model orders them by recency. */
  workspaces: readonly RailWorkspaceInput[]
  activeWorkspaceID?: string | null
  /** Durable collapsed group ids. */
  collapsed?: readonly string[]
  /** Roster filter query; an active query reveals matches inside collapsed groups. */
  query?: string
}

export type RailGroupRow = {
  kind: "group"
  section: "agents"
  /** Workspace id, or HOMELESS_RAIL_GROUP. */
  id: string
  title: string
  count: number
  collapsed: boolean
}

export type RailAgentRow = {
  kind: "agent"
  section: "agents"
  id: string
  title: string
  /** Role title only; the workspace lives on the group header. */
  role: string
  leader: boolean
  guest: boolean
  groupID: string
}

export type RailWorkspaceRow = {
  kind: "workspace"
  section: "workspaces"
  id: string
  title: string
  /** Compact directory label for the workspace row. */
  group: string
  paused: boolean
  unread: number
  busy: number
  active: boolean
}

export type RailRow = RailGroupRow | RailAgentRow | RailWorkspaceRow

export type RailSection = {
  id: "agents" | "workspaces"
  heading: string
  count: number
  rows: RailRow[]
}

export type RailModel = {
  sections: readonly [RailSection, RailSection]
  /** One cursor walks this list: section headings are not rows. */
  visibleRows: RailRow[]
}

/** Header line: collapse state, workspace name, and the group's agent count. */
export function railGroupHeading(group: Pick<RailGroupRow, "title" | "count" | "collapsed">): string {
  return `${group.collapsed ? RAIL_COLLAPSED_MARK : RAIL_EXPANDED_MARK} ${group.title} (${group.count})`
}

function agentNameOrder(left: RailAgentInput, right: RailAgentInput): number {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
}

function workspaceRecencyOrder(left: RailWorkspaceInput, right: RailWorkspaceInput): number {
  return right.lastActiveAt - left.lastActiveAt || left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
}

function matchesQuery(value: string, query: string): boolean {
  return !query || value.toLowerCase().includes(query)
}

/** Add or remove one group id without disturbing the rest of the durable set. */
export function toggleCollapsedRailGroup(collapsed: readonly string[], groupID: string): string[] {
  return collapsed.includes(groupID)
    ? collapsed.filter((id) => id !== groupID)
    : [...collapsed, groupID]
}

/** The group a `z` binding should toggle: the header under the cursor, or an agent's group. */
export function railCollapseTarget(rows: readonly RailRow[], cursor: number): string | undefined {
  const row = rows[cursor]
  if (!row) return undefined
  if (row.kind === "group") return row.id
  if (row.kind === "agent") return row.groupID
  return undefined
}

/** Keep one cursor inside the visible rows (zero when the rail is empty). */
export function clampRailCursor(cursor: number, visibleRows: number): number {
  if (visibleRows <= 0) return 0
  return Math.max(0, Math.min(visibleRows - 1, Math.trunc(cursor)))
}

/**
 * Initial placement: the first agent or workspace, skipping leading group
 * headers. The rail keeps its old "first target is selected" behavior while
 * headers stay reachable with `k` (or a click) for `z`.
 */
export function firstSelectableRailRow(rows: readonly RailRow[]): number {
  const index = rows.findIndex((row) => row.kind !== "group")
  return index >= 0 ? index : 0
}

/** Match count for the roster filter: headers are chrome, not matches. */
export function railSelectableCount(rows: readonly RailRow[]): number {
  return rows.filter((row) => row.kind !== "group").length
}

export function buildRailModel(input: RailModelInput): RailModel {
  const query = (input.query ?? "").trim().toLowerCase()
  const collapsed = new Set(input.collapsed ?? [])

  // Deduplicate by id before grouping so no input can duplicate a row.
  const agents = [...new Map(input.agents.map((agent) => [agent.id, agent])).values()].sort(agentNameOrder)
  const workspaces = [...new Map(input.workspaces.map((workspace) => [workspace.id, workspace])).values()]
    .sort(workspaceRecencyOrder)
  const workspacesByID = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
  const active = input.activeWorkspaceID ? workspacesByID.get(input.activeWorkspaceID) : undefined
  const visibleAgents = agents.filter((agent) => matchesQuery(agent.name, query))

  // Primary workspace: the active workspace when the agent is a member,
  // otherwise the most recently active membership, otherwise Homeless.
  const primaryByAgent = new Map<string, string>()
  for (const agent of visibleAgents) {
    const primary = active?.memberIDs.includes(agent.id)
      ? active
      : workspaces.find((workspace) => workspace.memberIDs.includes(agent.id))
    primaryByAgent.set(agent.id, primary?.id ?? HOMELESS_RAIL_GROUP)
  }

  const grouped = new Map<string, RailAgentInput[]>()
  for (const agent of visibleAgents) {
    const groupID = primaryByAgent.get(agent.id)!
    const members = grouped.get(groupID) ?? []
    members.push(agent)
    grouped.set(groupID, members)
  }

  // Group order: active workspace first, then membership recency, then Homeless.
  const groupOrder: string[] = []
  if (active && grouped.has(active.id)) groupOrder.push(active.id)
  for (const workspace of workspaces) {
    if (workspace.id !== active?.id && grouped.has(workspace.id)) groupOrder.push(workspace.id)
  }
  if (grouped.has(HOMELESS_RAIL_GROUP)) groupOrder.push(HOMELESS_RAIL_GROUP)

  const agentRows: RailRow[] = []
  for (const groupID of groupOrder) {
    const members = grouped.get(groupID) ?? []
    const workspace = workspacesByID.get(groupID)
    // A filter is an explicit search: show its matches even inside a group
    // whose durable state is collapsed.
    const isCollapsed = !query && collapsed.has(groupID)
    agentRows.push({
      kind: "group",
      section: "agents",
      id: groupID,
      title: workspace ? `#${workspace.name}` : "Homeless",
      count: members.length,
      collapsed: isCollapsed,
    })
    if (isCollapsed) continue
    for (const agent of members) {
      agentRows.push({
        kind: "agent",
        section: "agents",
        id: agent.id,
        title: agent.name,
        role: agent.title,
        leader: workspace?.leaderID === agent.id,
        guest: Boolean(active && !active.memberIDs.includes(agent.id)),
        groupID,
      })
    }
  }

  const workspaceRows: RailRow[] = workspaces
    .filter((workspace) => matchesQuery(workspace.name, query) || matchesQuery(workspace.directory, query))
    .map((workspace) => ({
      kind: "workspace" as const,
      section: "workspaces" as const,
      id: workspace.id,
      title: workspace.name,
      group: workspaceGroupLabel(workspace.directory),
      paused: workspace.paused,
      unread: workspace.unread,
      busy: workspace.busy,
      active: workspace.id === active?.id,
    }))

  const sections: readonly [RailSection, RailSection] = [
    {
      id: "agents",
      heading: railGroupLine("agent", visibleAgents.length),
      count: visibleAgents.length,
      rows: agentRows,
    },
    {
      id: "workspaces",
      heading: railGroupLine("workspace", workspaceRows.length),
      count: workspaceRows.length,
      rows: workspaceRows,
    },
  ]

  return { sections, visibleRows: [...agentRows, ...workspaceRows] }
}
