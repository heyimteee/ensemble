import test from "node:test"
import assert from "node:assert/strict"
import { diagnoseLocations, type DoctorBinding, type DoctorConfigRead, type DoctorLocationInput, type DoctorSnapshot, type DoctorWorkspace } from "./doctor.ts"

const service = { id: "svc-1", pid: 100, version: "2.2.3" }

function agent(id: string, name: string, archived = false) {
  return { id, name, archived }
}

function workspace(input: Partial<DoctorWorkspace> & Pick<DoctorWorkspace, "id" | "directory" | "leaderID" | "memberIDs">): DoctorWorkspace {
  return {
    name: "site",
    archived: false,
    synthesis: true,
    paused: false,
    configVersion: 1,
    ...input,
  }
}

function binding(workspaceID: string, agentID: string, sessionID = `ses_${agentID}`, extra: Partial<DoctorBinding> = {}): DoctorBinding {
  return {
    key: `${workspaceID}:${agentID}`,
    workspaceID,
    agentID,
    sessionID,
    kind: workspaceID === "home" ? "home" : "workspace",
    agentVersion: 1,
    ...extra,
  }
}

function snapshot(input: {
  agents: ReturnType<typeof agent>[]
  workspaces?: DoctorWorkspace[]
  bindings?: DoctorBinding[]
}): DoctorSnapshot {
  return {
    agents: Object.fromEntries(input.agents.map((item) => [item.id, item])),
    workspaces: Object.fromEntries((input.workspaces ?? []).map((item) => [item.id, item])),
    bindings: Object.fromEntries((input.bindings ?? []).map((item) => [item.key, item])),
  }
}

function validConfig(input: { name?: string; leader?: string; members?: string[]; synthesis?: boolean; paused?: boolean; id?: string } = {}): DoctorConfigRead {
  return {
    present: true,
    valid: true,
    config: {
      version: 1,
      id: input.id,
      name: input.name ?? "site",
      leader: input.leader ?? "Clark",
      members: input.members ?? ["Clark", "Jessy"],
      synthesis: input.synthesis ?? true,
      paused: input.paused ?? false,
    },
  }
}

function location(directory: string, snap: DoctorSnapshot, config: DoctorConfigRead = { present: false }): DoctorLocationInput {
  return { directory, service, snapshot: snap, config }
}

const clark = agent("agent_clark", "Clark")
const jessy = agent("agent_jessy", "Jessy")
const site = workspace({ id: "workspace_site", directory: "/projects/site", leaderID: clark.id, memberIDs: [clark.id, jessy.id] })
const agreed = snapshot({
  agents: [clark, jessy],
  workspaces: [site],
  bindings: [binding(site.id, clark.id), binding(site.id, jessy.id), binding("home", clark.id), binding("home", jessy.id)],
})

test("agreement reports one matching location with no mismatches", () => {
  const report = diagnoseLocations([location(site.directory, agreed, validConfig())])
  assert.equal(report.ok, true)
  assert.deepEqual(report.mismatches, [])
  assert.equal(report.summary.locations, 1)
  assert.equal(report.summary.services, 1)
  assert.equal(report.summary.mismatchCount, 0)
  assert.equal(report.locations[0].agents.length, 2)
  assert.equal(report.locations[0].workspaces[0].leaderName, "Clark")
  assert.deepEqual(report.locations[0].workspaces[0].memberNames, ["Clark", "Jessy"])
  assert.equal(report.locations[0].config.status, "valid")
  assert.deepEqual(report.locations[0].config.membership?.members.map((member) => member.status), ["resolved", "resolved"])
})

test("config/storage member divergence is reported as a mismatch", () => {
  const stale = workspace({ id: "workspace_site", directory: "/projects/site", leaderID: clark.id, memberIDs: [clark.id] })
  const snap = snapshot({
    agents: [clark, jessy],
    workspaces: [stale],
    bindings: [binding(stale.id, clark.id), binding("home", clark.id), binding("home", jessy.id)],
  })
  const report = diagnoseLocations([location(stale.directory, snap, validConfig({ members: ["Clark", "Jessy"] }))])
  assert.equal(report.ok, false)
  assert.equal(report.summary.mismatchCount, 1)
  assert.equal(report.mismatches[0].code, "config_storage_members_differ")
  assert.equal(report.mismatches[0].scope, "config")
  assert.deepEqual(report.mismatches[0].locations, [stale.directory])
  assert.equal(report.locations[0].mismatches[0].code, "config_storage_members_differ")
})

test("config membership reports unknown, ambiguous and archived member names", () => {
  const ghost = agent("agent_ghost", "Ghost", true)
  const twinA = agent("agent_twin_a", "Twin")
  const twinB = agent("agent_twin_b", "Twin")
  const workspaceRow = workspace({ id: "workspace_site", directory: "/projects/site", leaderID: clark.id, memberIDs: [clark.id] })
  const snap = snapshot({
    agents: [clark, ghost, twinA, twinB],
    workspaces: [workspaceRow],
    bindings: [binding(workspaceRow.id, clark.id)],
  })
  const report = diagnoseLocations([
    location(workspaceRow.directory, snap, validConfig({ leader: "Clark", members: ["Clark", "Ghost", "Twin", "Missing"] })),
  ])
  assert.equal(report.ok, false)
  assert.deepEqual(report.mismatches.map((mismatch) => mismatch.code).sort(), [
    "config_ambiguous_member",
    "config_archived_member",
    "config_unknown_member",
  ])
  assert.deepEqual(
    report.locations[0].config.membership?.members.map((member) => member.status),
    ["resolved", "archived", "ambiguous", "unknown"],
  )
  assert.ok(report.mismatches.every((mismatch) => mismatch.remediation.length > 0))
})

test("config/storage divergence covers name, leader, flags and config version", () => {
  const stored = workspace({
    id: "workspace_site",
    name: "stale name",
    directory: "/projects/site",
    leaderID: jessy.id,
    memberIDs: [clark.id, jessy.id],
    synthesis: false,
    paused: true,
    configVersion: 2,
  })
  const snap = snapshot({
    agents: [clark, jessy],
    workspaces: [stored],
    bindings: [binding(stored.id, clark.id), binding(stored.id, jessy.id)],
  })
  const report = diagnoseLocations([location(stored.directory, snap, validConfig())])
  assert.deepEqual(report.mismatches.map((mismatch) => mismatch.code).sort(), [
    "config_storage_leader_differ",
    "config_storage_name_differ",
    "config_storage_paused_differ",
    "config_storage_synthesis_differ",
    "config_storage_version_differ",
  ])
  assert.ok(report.mismatches.every((mismatch) => mismatch.remediation.length > 0))
})

test("config presence problems are classified as missing, invalid or workspace missing", () => {
  const withWorkspace = snapshot({
    agents: [clark, jessy],
    workspaces: [site],
    bindings: [binding(site.id, clark.id), binding(site.id, jessy.id)],
  })
  const missing = diagnoseLocations([location(site.directory, withWorkspace, { present: false })])
  assert.deepEqual(missing.mismatches.map((mismatch) => mismatch.code), ["workspace_config_missing"])
  assert.equal(missing.locations[0].config.status, "missing")

  const invalid = diagnoseLocations([
    location(site.directory, withWorkspace, { present: true, valid: false, reason: "version must be 1" }),
  ])
  assert.deepEqual(invalid.mismatches.map((mismatch) => mismatch.code), ["config_invalid"])
  assert.equal(invalid.locations[0].config.status, "invalid")
  assert.equal(invalid.locations[0].config.reason, "version must be 1")

  const absent = diagnoseLocations([location("/projects/empty", snapshot({ agents: [clark, jessy] }), validConfig())])
  assert.deepEqual(absent.mismatches.map((mismatch) => mismatch.code), ["config_workspace_missing"])
  assert.equal(absent.locations[0].mismatches[0].scope, "config")
})

test("config leader outside members is reported without flagging lazy bindings", () => {
  const workspaceRow = workspace({ id: "workspace_site", directory: "/projects/site", leaderID: clark.id, memberIDs: [clark.id, jessy.id] })
  const snap = snapshot({
    agents: [clark, jessy],
    workspaces: [workspaceRow],
    bindings: [binding(workspaceRow.id, clark.id), binding("home", clark.id)],
  })
  const report = diagnoseLocations([
    location(workspaceRow.directory, snap, validConfig({ leader: "Jessy", members: ["Clark"] })),
  ])
  assert.ok(report.mismatches.some((mismatch) => mismatch.code === "config_leader_not_member"))
  assert.ok(report.mismatches.some((mismatch) => mismatch.code === "config_storage_leader_differ"))
  assert.equal(report.mismatches.some((mismatch) => mismatch.code === "binding_missing"), false)
  assert.equal(report.locations[0].mismatches.length, report.mismatches.length)
})

test("storage integrity reports missing or archived members and bad bindings", () => {
  const other = agent("agent_other", "Other")
  const archived = agent("agent_archived", "Retired", true)
  const owner = workspace({
    id: "workspace_site",
    directory: "/projects/site",
    leaderID: "agent_leader_absent",
    memberIDs: [clark.id, "agent_missing", archived.id],
  })
  const orphan = {
    ...binding(owner.id, clark.id),
    key: "wrong-key",
    kind: "workspace" as const,
  }
  const badKind = { ...binding(owner.id, clark.id, "ses_kind"), kind: "home" as const }
  const badDirectory = { ...binding(owner.id, clark.id, "ses_dir"), directory: "/elsewhere" }
  const snap = snapshot({
    agents: [clark, other, archived],
    workspaces: [owner],
    bindings: [
      orphan,
      badKind,
      badDirectory,
      binding("workspace_missing", clark.id),
      binding(owner.id, "agent_missing_agent"),
      binding(owner.id, other.id),
    ],
  })
  const report = diagnoseLocations([location(owner.directory, snap, { present: false })])
  const codes = report.mismatches.map((mismatch) => mismatch.code)
  assert.ok(codes.includes("storage_member_missing_agent"))
  assert.ok(codes.includes("storage_member_archived"))
  assert.ok(codes.includes("storage_leader_not_member"))
  assert.ok(codes.includes("binding_key_mismatch"))
  assert.ok(codes.includes("binding_unknown_workspace"))
  assert.ok(codes.includes("binding_unknown_agent"))
  assert.equal(codes.includes("binding_agent_not_member"), false)
  assert.ok(codes.includes("binding_field_mismatch"))
  assert.ok(report.mismatches.filter((mismatch) => mismatch.scope === "storage").length >= 7)
})

test("lazy bindings and retained sessions for former members are healthy", () => {
  const former = agent("former", "Former")
  const snap = snapshot({ agents: [clark, jessy, former], workspaces: [site], bindings: [binding(site.id, former.id)] })
  const before = structuredClone(snap)
  const report = diagnoseLocations([location(site.directory, snap, validConfig())])
  assert.equal(report.ok, true)
  assert.equal(report.locations[0].bindings.length, 1)
  assert.deepEqual(snap, before)
})

test("cross-location divergence compares rosters, workspaces and bindings across services", () => {
  const directoryA = "/projects/a"
  const directoryB = "/projects/b"
  const workspaceA = workspace({ id: "workspace_team", directory: directoryA, leaderID: clark.id, memberIDs: [clark.id, jessy.id] })
  const workspaceB = workspace({ id: "workspace_team", directory: directoryB, leaderID: clark.id, memberIDs: [clark.id] })
  const report = diagnoseLocations([
    {
      directory: directoryA,
      service,
      snapshot: snapshot({
        agents: [clark, jessy],
        workspaces: [workspaceA],
        bindings: [binding(workspaceA.id, clark.id), binding(workspaceA.id, jessy.id)],
      }),
      config: validConfig({ members: ["Clark", "Jessy"] }),
    },
    {
      directory: directoryB,
      service: { id: "svc-2", pid: 200, version: "2.2.3" },
      snapshot: snapshot({
        agents: [clark],
        workspaces: [workspaceB],
        bindings: [binding(workspaceB.id, clark.id)],
      }),
      config: validConfig({ members: ["Clark"] }),
    },
  ])
  const codes = report.mismatches.map((mismatch) => mismatch.code)
  assert.equal(report.summary.services, 2)
  assert.equal(report.summary.crossService, true)
  assert.ok(codes.includes("cross_location_agent_missing"))
  assert.ok(codes.includes("cross_location_workspace_members_differ"))
  assert.ok(codes.includes("cross_location_workspace_directory_differ"))
  assert.ok(codes.includes("cross_location_binding_missing"))
  const missing = report.mismatches.find((mismatch) => mismatch.code === "cross_location_agent_missing")
  assert.equal(missing?.scope, "cross-location")
  assert.deepEqual(missing?.locations.sort(), [directoryA, directoryB])
  assert.ok(missing?.remediation.length)
})

test("the same service across multiple locations agrees when snapshots match", () => {
  const report = diagnoseLocations([
    location(site.directory, agreed, validConfig()),
    location("/projects/empty", agreed, { present: false }),
  ])
  assert.equal(report.ok, true)
  assert.equal(report.summary.locations, 2)
  assert.equal(report.summary.services, 1)
  assert.equal(report.summary.crossLocation, true)
  assert.equal(report.summary.crossService, false)
  assert.deepEqual(report.mismatches, [])
})

test("empty input produces an empty agreeing report", () => {
  const report = diagnoseLocations([])
  assert.equal(report.ok, true)
  assert.deepEqual(report.locations, [])
  assert.deepEqual(report.mismatches, [])
  assert.equal(report.summary.locations, 0)
  assert.equal(report.summary.mismatchCount, 0)
  assert.equal(report.summary.crossLocation, false)
})
