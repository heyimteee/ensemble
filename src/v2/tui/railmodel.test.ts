import test from "node:test"
import assert from "node:assert/strict"
import {
  HOMELESS_RAIL_GROUP,
  buildRailModel,
  clampRailCursor,
  firstSelectableRailRow,
  railCollapseTarget,
  railGroupHeading,
  railSelectableCount,
  toggleCollapsedRailGroup,
  type RailAgentInput,
  type RailModelInput,
  type RailWorkspaceInput,
} from "./railmodel.ts"

const agent = (patch: Partial<RailAgentInput> = {}): RailAgentInput => ({
  id: "a1",
  name: "Nova",
  title: "Engineer",
  ...patch,
})

const workspace = (patch: Partial<RailWorkspaceInput> = {}): RailWorkspaceInput => ({
  id: "w1",
  name: "Core",
  directory: "/tmp/core",
  leaderID: "a1",
  memberIDs: ["a1"],
  paused: false,
  lastActiveAt: 10,
  unread: 0,
  busy: 0,
  ...patch,
})

const build = (patch: Partial<RailModelInput> = {}) =>
  buildRailModel({ agents: [agent()], workspaces: [workspace()], ...patch })

const rowsOf = (model: ReturnType<typeof build>, section: "agents" | "workspaces") =>
  model.sections.find((entry) => entry.id === section)!.rows

test("the rail model splits Agents and Workspaces into headed sections", () => {
  const model = build({
    agents: [agent(), agent({ id: "a2", name: "Echo", title: "Designer" })],
    workspaces: [workspace({ memberIDs: ["a1", "a2"] })],
  })
  assert.deepEqual(model.sections.map((section) => section.id), ["agents", "workspaces"])
  assert.deepEqual(model.sections.map((section) => section.heading), ["AGENTS (2)", "WORKSPACES (1)"])
  assert.deepEqual(model.sections.map((section) => section.count), [2, 1])
  assert.deepEqual(model.visibleRows.map((row) => `${row.kind}:${row.id}`), [
    "group:w1",
    "agent:a2",
    "agent:a1",
    "workspace:w1",
  ])
})

test("an agent appears once, grouped under the active workspace when it is a member", () => {
  const older = workspace({ id: "w1", name: "Older", lastActiveAt: 5, memberIDs: ["a1"] })
  const newer = workspace({ id: "w2", name: "Newer", lastActiveAt: 20, memberIDs: ["a1"], leaderID: "a1" })
  const model = build({ workspaces: [older, newer], activeWorkspaceID: "w1" })

  const rows = rowsOf(model, "agents")
  assert.deepEqual(rows.map((row) => `${row.kind}:${row.id}`), ["group:w1", "agent:a1"])
  assert.equal(rows.filter((row) => row.kind === "agent").length, 1, "multiple memberships never duplicate a row")
  const group = rows[0]
  assert.equal(group.kind, "group")
  if (group.kind === "group") assert.equal(group.title, "#Older")
})

test("without the active workspace an agent groups under its most recent membership", () => {
  const older = workspace({ id: "w1", name: "Older", lastActiveAt: 10, memberIDs: ["a1"] })
  const newer = workspace({ id: "w2", name: "Newer", lastActiveAt: 30, memberIDs: ["a1"] })
  const other = workspace({ id: "w3", name: "Other", lastActiveAt: 20, memberIDs: ["a9"], leaderID: "a9" })
  const model = build({
    agents: [agent(), agent({ id: "a9", name: "Zed" })],
    workspaces: [older, other, newer],
    activeWorkspaceID: "w3",
  })

  const groups = rowsOf(model, "agents").filter((row) => row.kind === "group")
  assert.deepEqual(groups.map((group) => group.id), ["w3", "w2"], "the active group leads, then recency decides")
  const nova = rowsOf(model, "agents").find((row) => row.kind === "agent" && row.id === "a1")
  assert.equal(nova?.kind, "agent")
  if (nova?.kind === "agent") assert.equal(nova.groupID, "w2")
})

test("agents with no workspace group under Homeless after every workspace group", () => {
  const model = build({
    agents: [
      agent({ id: "a0", name: "Aria" }),
      agent(),
      agent({ id: "a2", name: "Echo", title: "Ops" }),
    ],
    workspaces: [
      workspace({ id: "w1", memberIDs: ["a1"] }),
      workspace({ id: "w2", name: "Second", lastActiveAt: 5, memberIDs: ["a2"], leaderID: "a2" }),
    ],
  })

  const groups = rowsOf(model, "agents").filter((row) => row.kind === "group")
  assert.deepEqual(groups.map((group) => group.id), ["w1", "w2", HOMELESS_RAIL_GROUP])
  assert.deepEqual(groups.map((group) => group.title), ["#Core", "#Second", "Homeless"])
  assert.equal(groups.at(-1)?.count, 1)
})

test("a collapsed group keeps its counted header and hides only its agent rows", () => {
  const model = build({
    agents: [agent(), agent({ id: "a2", name: "Echo", title: "Designer" })],
    workspaces: [workspace({ memberIDs: ["a1", "a2"] })],
    collapsed: ["w1"],
  })

  const rows = rowsOf(model, "agents")
  assert.deepEqual(rows.map((row) => `${row.kind}:${row.id}`), ["group:w1"])
  const group = rows[0]
  assert.equal(group.kind, "group")
  if (group.kind === "group") {
    assert.equal(group.count, 2)
    assert.equal(group.collapsed, true)
    assert.equal(railGroupHeading(group), "▸ #Core (2)")
  }
  assert.deepEqual(model.visibleRows.map((row) => `${row.kind}:${row.id}`), ["group:w1", "workspace:w1"])
  assert.equal(railSelectableCount(model.visibleRows), 1, "the header is a row; its agents are not")
  assert.equal(railGroupHeading({ title: "#Core", count: 2, collapsed: false }), "▾ #Core (2)")
})

test("toggling a group preserves the rest of the durable collapse set", () => {
  assert.deepEqual(toggleCollapsedRailGroup([], "w1"), ["w1"])
  assert.deepEqual(toggleCollapsedRailGroup(["w2", "w1"], "w1"), ["w2"])
  assert.deepEqual(toggleCollapsedRailGroup(["w2"], "w1"), ["w2", "w1"])
})

test("a filter reveals matches inside a collapsed group and narrows the section counts", () => {
  const model = build({
    agents: [agent(), agent({ id: "a2", name: "Echo", title: "Designer" })],
    workspaces: [workspace({ memberIDs: ["a1", "a2"] })],
    collapsed: ["w1"],
    query: "ech",
  })

  assert.equal(model.sections[0]?.heading, "AGENTS (1)")
  const rows = rowsOf(model, "agents")
  assert.deepEqual(rows.map((row) => `${row.kind}:${row.id}`), ["group:w1", "agent:a2"])
  const group = rows[0]
  assert.equal(group.kind, "group")
  if (group.kind === "group") assert.equal(group.collapsed, false)
})

test("collapse targets a selected group header or the group around a selected agent", () => {
  const model = build()
  assert.equal(railCollapseTarget(model.visibleRows, 0), "w1")
  assert.equal(railCollapseTarget(model.visibleRows, 1), "w1")
  assert.equal(railCollapseTarget(model.visibleRows, 2), undefined)
  assert.equal(railCollapseTarget(model.visibleRows, 99), undefined)
})

test("workspace rows keep the directory label, counts, paused marker, and active selection", () => {
  const model = build({
    workspaces: [
      workspace({ id: "w2", name: "Second", lastActiveAt: 5, directory: "/tmp/second", leaderID: "a9" }),
      workspace({ id: "w1", name: "Core", directory: "/tmp/core", paused: true, unread: 3, busy: 2 }),
    ],
    activeWorkspaceID: "w1",
  })

  const rows = rowsOf(model, "workspaces")
  assert.deepEqual(rows.map((row) => row.id), ["w1", "w2"], "recency order is preserved")
  const active = rows[0]
  assert.equal(active.kind, "workspace")
  if (active.kind === "workspace") {
    assert.equal(active.title, "Core")
    assert.equal(active.group, "tmp/core")
    assert.equal(active.paused, true)
    assert.equal(active.unread, 3)
    assert.equal(active.busy, 2)
    assert.equal(active.active, true)
  }
  const inactive = rows[1]
  assert.equal(inactive.kind, "workspace")
  if (inactive.kind === "workspace") assert.equal(inactive.active, false)
})

test("agent rows carry role-only detail plus the leader and guest tags", () => {
  const home = workspace({ id: "w1", name: "Home", lastActiveAt: 10, memberIDs: ["a1"], leaderID: "a1" })
  const active = workspace({ id: "w2", name: "Active", lastActiveAt: 20, memberIDs: ["a2"], leaderID: "a2" })
  const model = build({
    agents: [agent({ id: "a1", name: "Nova", title: "Engineer" }), agent({ id: "a2", name: "Echo", title: "Ops" })],
    workspaces: [home, active],
    activeWorkspaceID: "w2",
  })

  const agents = rowsOf(model, "agents").filter((row) => row.kind === "agent")
  const nova = agents.find((row) => row.id === "a1")
  assert.equal(nova?.kind, "agent")
  if (nova?.kind === "agent") {
    assert.equal(nova.role, "Engineer")
    assert.equal(nova.leader, true)
    assert.equal(nova.guest, true)
  }
  const echo = agents.find((row) => row.id === "a2")
  assert.equal(echo?.kind, "agent")
  if (echo?.kind === "agent") {
    assert.equal(echo.role, "Ops")
    assert.equal(echo.guest, false)
  }
})

test("the rail cursor clamps to the visible row count", () => {
  assert.equal(clampRailCursor(5, 3), 2)
  assert.equal(clampRailCursor(-2, 3), 0)
  assert.equal(clampRailCursor(1, 0), 0)
  assert.equal(clampRailCursor(1, 4), 1)
})

test("initial placement selects the first target and skips leading group headers", () => {
  const model = build()
  assert.equal(firstSelectableRailRow(model.visibleRows), 1, "the first agent is index 1 behind its group header")
  assert.equal(firstSelectableRailRow(model.sections[1]!.rows), 0, "a workspaces-only rail starts on its first row")
  assert.equal(firstSelectableRailRow([]), 0)
  assert.equal(firstSelectableRailRow(model.visibleRows.slice(0, 1)), 0, "a header-only rail still gets a cursor")
})
