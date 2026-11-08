import { dispatchGroupState, dispatchHopCount, dispatchLedgerSummary, isRootGroup, type DispatchLedgerSummary } from "./dispatch-budget.ts"
import { DEADLINE_MS, deriveWorkStatus, isDerivedWorkStatus, type DerivedWorkStatus } from "./queue.ts"
import type { DispatchGroup, SubtaskOutcome, SubtaskState, WorkFailureKind, WorkKind } from "./types.ts"
import type { WorkspaceConfig } from "./workspace-config.ts"

export type ServiceIdentity = {
  id: string | null
  pid: number | null
  version: string | null
}

export type DoctorAgent = {
  id: string
  name: string
  archived: boolean
}

export type DoctorWorkspace = {
  id: string
  name: string
  directory: string
  leaderID: string
  memberIDs: string[]
  archived: boolean
  synthesis: boolean
  paused: boolean
  configVersion?: number
}

export type DoctorBinding = {
  key: string
  workspaceID: string
  agentID: string
  sessionID: string
  kind?: "workspace" | "home"
  directory?: string
  agentVersion: number
}

export type DoctorSubtask = {
  id: string
  workspaceID?: string
  parentID?: string
  dispatchGroupID?: string
  /** Missing legacy values are treated as user-created (never consuming). */
  creatorType: "user" | "agent"
  workKind?: WorkKind
  handoff?: { completion?: boolean; batch?: boolean }
  /**
   * Ticket #170 lifecycle facts. The service overlay already derives `status`;
   * the doctor repeats the canonical derivation when it is absent and uses the
   * durable queue timestamps for freshness checks. Titles and instructions
   * never travel through this seam.
   */
  state?: SubtaskState
  outcome?: SubtaskOutcome
  status?: DerivedWorkStatus
  interrupted?: boolean
  approvalID?: string
  awaitingChildren?: boolean
  attempts?: number
  createdAt?: number
  deadlineAt?: number
  claimedBy?: string
  leaseUntil?: number
  activeRunID?: string
  retryAfter?: number
  finishedAt?: number
  repliedAt?: number
  stoppedAt?: number
  failure?: { kind: WorkFailureKind; reason?: string }
}

/** One `task.recovered` audit row projected for the doctor (IDs and codes only). */
export type DoctorRecovery = {
  taskID: string
  from?: string
  to?: string
  reason?: string
  /** Wall-clock time of the recovery event, when the sink supplied it. */
  at?: number
}

export type DoctorSnapshot = {
  agents: Record<string, DoctorAgent>
  workspaces: Record<string, DoctorWorkspace>
  bindings: Record<string, DoctorBinding>
  /** Ticket #163 ledger records; absent on pre-ledger services. */
  dispatchGroups?: Record<string, DispatchGroup>
  /** The work rows the ledger counters must agree with. */
  subtasks?: Record<string, DoctorSubtask>
  /** Recent `task.recovered` audit rows (ticket #170); absent on older services. */
  recoveries?: DoctorRecovery[]
}

export type DoctorConfigRead =
  | { present: false }
  | { present: true; valid: false; reason: string }
  | { present: true; valid: true; config: WorkspaceConfig }

export type DoctorLocationInput = {
  directory: string
  configPath?: string
  service: ServiceIdentity
  snapshot: DoctorSnapshot
  config: DoctorConfigRead
  /** Diagnostic clock for deterministic operator checks; defaults to now. */
  now?: number
}

export type ConfigMemberStatus = "resolved" | "unknown" | "ambiguous" | "archived"

export type ConfigMemberResolution = {
  name: string
  status: ConfigMemberStatus
  id?: string
  matches: string[]
}

export type DoctorConfigReport = {
  path?: string
  present: boolean
  valid: boolean
  status: "missing" | "invalid" | "valid"
  reason?: string
  version?: number
  id?: string
  name?: string
  leader?: string
  members?: string[]
  synthesis?: boolean
  paused?: boolean
  membership?: {
    leader: ConfigMemberResolution
    members: ConfigMemberResolution[]
  }
}

export type DoctorLocationReport = {
  directory: string
  service: ServiceIdentity
  agents: DoctorAgent[]
  workspaces: Array<
    DoctorWorkspace & {
      leaderName: string | null
      memberNames: Array<string | null>
    }
  >
  bindings: Array<
    DoctorBinding & {
      agentName: string | null
    }
  >
  config: DoctorConfigReport
  /** Compact dispatch-ledger view (ticket #163); zeroed when no ledger exists. */
  dispatch: DispatchLedgerSummary
  mismatches: DoctorMismatch[]
}

export type DoctorMismatch = {
  code: string
  scope: "config" | "storage" | "cross-location"
  message: string
  remediation: string
  locations: string[]
  details: Record<string, unknown>
}

export type DoctorReport = {
  ok: boolean
  caveats: string[]
  locations: DoctorLocationReport[]
  mismatches: DoctorMismatch[]
  summary: {
    locations: number
    services: number
    mismatchCount: number
    byCode: Record<string, number>
    crossLocation: boolean
    crossService: boolean
  }
}

function resolveName(name: string, agents: DoctorAgent[]): ConfigMemberResolution {
  const matches = agents.filter((agent) => agent.name.toLowerCase() === name.toLowerCase())
  const active = matches.filter((agent) => !agent.archived)
  if (active.length === 1) return { name, status: "resolved", id: active[0].id, matches: matches.map((agent) => agent.id) }
  if (active.length > 1) return { name, status: "ambiguous", matches: active.map((agent) => agent.id) }
  if (matches.length > 0) return { name, status: "archived", matches: matches.map((agent) => agent.id) }
  return { name, status: "unknown", matches: [] }
}

function configReport(input: DoctorLocationInput): DoctorConfigReport {
  const base = { path: input.configPath, present: input.config.present }
  if (!input.config.present) return { ...base, valid: false, status: "missing" }
  if (!input.config.valid) return { ...base, valid: false, status: "invalid", reason: input.config.reason }
  const config = input.config.config
  const agents = Object.values(input.snapshot.agents).sort((a, b) => a.id.localeCompare(b.id))
  return {
    ...base,
    valid: true,
    status: "valid",
    version: config.version,
    id: config.id,
    name: config.name,
    leader: config.leader,
    members: config.members,
    synthesis: config.synthesis,
    paused: config.paused,
    membership: {
      leader: resolveName(config.leader, agents),
      members: config.members.map((name) => resolveName(name, agents)),
    },
  }
}

function sortedWorkspaceReport(input: DoctorLocationInput) {
  return Object.values(input.snapshot.workspaces)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((workspace) => ({
      ...workspace,
      leaderName: input.snapshot.agents[workspace.leaderID]?.name ?? null,
      memberNames: workspace.memberIDs.map((memberID) => input.snapshot.agents[memberID]?.name ?? null),
    }))
}

function sortedBindings(input: DoctorLocationInput) {
  return Object.values(input.snapshot.bindings)
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((binding) => ({
      ...binding,
      agentName: input.snapshot.agents[binding.agentID]?.name ?? null,
    }))
}

function serviceKey(service: ServiceIdentity): string {
  if (service.id) return `id:${service.id}`
  if (service.pid !== null) return `pid:${service.pid}`
  return "unknown"
}

const remediation: Record<string, string> = {
  config_storage_members_differ:
    "The stored workspace and .ensemble/config.json disagree about members. Confirm the intended members, then open the workspace in Ensemble so config reconciliation updates storage; do not hand-edit OpenCode storage.",
  config_unknown_member:
    "Rename the agent or the .ensemble/config.json entry so every configured member and leader matches exactly one non-archived Ensemble agent name.",
  config_ambiguous_member:
    "Rename or archive duplicate agents so each name in .ensemble/config.json matches exactly one non-archived agent.",
  config_archived_member:
    "Restore the archived agent or remove/rename it in .ensemble/config.json; archived agents cannot be active workspace members.",
  config_leader_not_member:
    "Add the configured leader to the members list or choose a member as the leader in .ensemble/config.json.",
  config_storage_leader_differ:
    "The stored leader and .ensemble/config.json disagree. Confirm the intended leader, then open the workspace in Ensemble so reconciliation updates storage.",
  config_storage_name_differ:
    "The stored workspace name and .ensemble/config.json disagree. Rename the workspace from Ensemble or correct the config name, then reopen it so reconciliation runs.",
  config_storage_synthesis_differ:
    "The stored synthesis setting and .ensemble/config.json disagree. Toggle synthesis from the workspace UI or correct the config, then reopen the workspace.",
  config_storage_paused_differ:
    "The stored paused setting and .ensemble/config.json disagree. Pause/resume from the workspace UI or correct the config, then reopen the workspace.",
  config_storage_version_differ:
    "The stored config version does not match .ensemble/config.json. Reopen the workspace in Ensemble so reconciliation rewrites the stored version; do not hand-edit OpenCode storage.",
  config_invalid:
    "Fix .ensemble/config.json to the version 1 workspace schema (name, leader, members, synthesis, paused), then reopen the workspace in Ensemble so reconciliation can run.",
  workspace_config_missing:
    "Open this location in OpenCode and open /ensemble so Ensemble writes .ensemble/config.json, or restore the file from version control. Do not hand-edit OpenCode storage.",
  config_workspace_missing:
    "Open this location in Ensemble once so config discovery creates its workspace, or remove .ensemble/config.json if this directory is no longer an Ensemble workspace.",
  storage_member_missing_agent:
    "The stored workspace references an agent ID that no longer exists. Restore the agent or update workspace membership from .ensemble/config.json, then reopen the workspace.",
  storage_member_archived:
    "Remove the archived agent from workspace membership or restore the agent, then reopen the workspace so its config is rewritten.",
  storage_leader_not_member:
    "Choose an existing workspace member as leader, then reopen the workspace so storage and .ensemble/config.json agree.",
  dispatch_group_over_budget:
    "A dispatch group recorded more hops than its captured cap. Restore the ledger record from a consistent backup or start a new command; never edit caps on a live group.",
  dispatch_command_over_budget:
    "The command ledger recorded more hops than the user's cap. Restore the ledger from a consistent backup or ask the user to start a new command; do not raise a live ceiling.",
  dispatch_group_counter_mismatch:
    "The ledger's hop counter is lower than the counted agent delegation and handoff rows in the group. Restore the ledger record from a consistent backup before relying on the budget; do not delete the extra work rows.",
  dispatch_command_counter_mismatch:
    "The command's hop counter disagrees with the sum of its groups. Restore the affected ledger records from a consistent backup before relying on the command budget.",
  dispatch_continuation_orphan:
    "A continuation group names a parent that does not exist. Restore the missing parent ledger record or mark the continuation closed; do not re-point it at an unrelated command.",
  dispatch_group_unreachable:
    "A dispatch group cannot walk to its declared root (missing parent, cycle, or mismatched root id). Restore the missing ledger records or close the group so support can trust the lineage.",
  dispatch_continuation_empty:
    "An active continuation group holds no work. Dispatch its first work item, close it, or start a new command so an idle segment cannot quietly consume the continuation allowance.",
  work_pending_overdue:
    "Queued work has waited past the delivery window. Check the service queue and active-run slots; retry or cancel the row only after confirming no run owns it. Never delete the work row to hide a backlog.",
  work_lease_expired:
    "A claimed work row has an expired or missing heartbeat lease. Let the service reaper requeue it, or restart the service if the owner is gone; do not steal or hand-edit a live claim.",
  work_terminal_contradiction:
    "A terminal work row carries fields from another lifecycle state. Compare the durable failure, timestamps, and claim fields, then let the service reconcile the row; never rewrite a genuine native failure into a stall.",
  work_failed_timeout:
    "A failed row carries a structured delivery, lease, timeout, or queue cause. It should read stalled, not failed; repair the classification from the structured cause and keep a genuine native error failed.",
  work_recovery_mismatch:
    "A task.recovered audit row disagrees with the current durable task. Reconcile the card and transcript from the durable answer; keep the recovery event, and never replace a real answer with a failure placeholder.",
  binding_unknown_workspace:
    "A session binding points at a workspace that no longer exists. Remove or repair the orphaned binding by recreating the workspace; do not hand-edit OpenCode storage.",
  binding_unknown_agent:
    "A session binding points at an agent that no longer exists. Restore the agent or remove the orphaned binding; do not hand-edit OpenCode storage.",
  binding_key_mismatch:
    "A binding key disagrees with its workspace/agent fields. Reopen the workspace in Ensemble so the binding is recreated; do not hand-edit OpenCode storage.",
  binding_field_mismatch:
    "A binding field disagrees with its workspace or kind. Reopen the workspace in Ensemble so the binding is recreated.",
  cross_location_agent_missing:
    "The queried service reports agents differently across the compared locations. Confirm the canonical roster and reopen the affected locations; only restart a stale process if you have verified it from the reported service id/pid.",
  cross_location_agent_name_differ:
    "The queried service reports different agent names across locations. Reopen the affected locations so state converges; only restart a stale process if you have verified it from the reported service id/pid.",
  cross_location_agent_archived_differ:
    "The queried service disagrees about whether an agent is archived across locations. Reopen the affected locations so state converges; only restart a stale process if you have verified it from the reported service id/pid.",
  cross_location_workspace_missing:
    "The queried service reports different workspaces across locations. Reopen the affected locations; only restart a stale process if you have verified it from the reported service id/pid.",
  cross_location_workspace_name_differ:
    "The queried service reports different workspace names across locations. Correct names via the workspace UI or .ensemble/config.json and reopen the affected locations; only restart a stale process if verified.",
  cross_location_workspace_directory_differ:
    "The queried service binds the workspace to different directories across locations. Confirm the canonical directory, then reopen the workspace so storage and config agree.",
  cross_location_workspace_members_differ:
    "The queried service reports different workspace members across locations. Reconcile .ensemble/config.json or membership in Ensemble and reopen the affected locations.",
  cross_location_workspace_leader_differ:
    "The queried service reports different workspace leaders across locations. Reconcile the leader in Ensemble or .ensemble/config.json and reopen the affected locations.",
  cross_location_workspace_archived_differ:
    "The queried service disagrees about whether a workspace is archived across locations. Reopen the affected locations so state converges.",
  cross_location_binding_missing:
    "The queried service disagrees about session bindings across locations. Reopen the agent in this workspace so the missing native session binding is created, then rerun the doctor.",
  cross_location_binding_session_differ:
    "The queried service reports different session IDs for the same binding across locations. Reopen the affected locations so bindings converge; only restart a stale process if you have verified it from the reported service id/pid.",
  cross_location_binding_field_differ:
    "The queried service reports different binding fields across locations. Reopen the affected locations so bindings converge; only restart a stale process if you have verified it from the reported service id/pid.",
}

const membershipCodes = {
  unknown: "config_unknown_member",
  ambiguous: "config_ambiguous_member",
  archived: "config_archived_member",
} as const

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "undefined"
}

type PendingMismatch = {
  code: string
  scope: DoctorMismatch["scope"]
  message: string
  details: Record<string, unknown>
  indexes: Set<number>
}

function locationWorkspace(input: DoctorLocationInput): DoctorWorkspace | undefined {
  return Object.values(input.snapshot.workspaces).find((workspace) => !workspace.archived && workspace.directory === input.directory)
}

const TIMEOUT_REASON_CODES: ReadonlySet<string> = new Set([
  "deadline-exceeded",
  "lease-expired",
  "timed-out",
  "timeout",
])

/** The canonical derived status, falling back to the durable fields when a legacy service omits the overlay. */
function doctorWorkStatus(task: DoctorSubtask, now: number): DerivedWorkStatus | undefined {
  if (task.status !== undefined && isDerivedWorkStatus(task.status)) return task.status
  if (task.state === undefined || task.outcome === undefined) return undefined
  return deriveWorkStatus({
    id: task.id,
    state: task.state,
    outcome: task.outcome,
    interrupted: task.interrupted === true,
    awaitingChildren: task.awaitingChildren === true,
    attempts: task.attempts ?? 0,
    ...(task.approvalID !== undefined ? { approvalID: task.approvalID } : {}),
    ...(task.claimedBy !== undefined ? { claimedBy: task.claimedBy } : {}),
    ...(task.leaseUntil !== undefined ? { leaseUntil: task.leaseUntil } : {}),
    ...(task.activeRunID !== undefined ? { activeRunID: task.activeRunID } : {}),
    ...(task.retryAfter !== undefined ? { retryAfter: task.retryAfter } : {}),
    ...(task.failure !== undefined ? { failure: task.failure } : {}),
  }, now)
}

/**
 * Ticket #170 operator invariants over durable work rows. Checks are based on
 * structured fields only: no title, instruction, error copy, or answer text is
 * read. Overdue queue wait is skipped for a paused workspace because the queue
 * is intentionally not draining there.
 */
function checkWorkRows(input: DoctorLocationInput, add: (
  indexes: number[],
  code: string,
  details: Record<string, unknown>,
  message: string,
  scope?: DoctorMismatch["scope"],
) => void, index: number): void {
  const tasks = input.snapshot.subtasks ?? {}
  const now = input.now ?? Date.now()
  for (const task of Object.values(tasks).sort((a, b) => a.id.localeCompare(b.id))) {
    const status = doctorWorkStatus(task, now)
    if (!status) continue
    const workspaceID = task.workspaceID
    const owner = workspaceID ? input.snapshot.workspaces[workspaceID] : undefined
    const base = { workspaceID, taskID: task.id }
    if (status === "pending" && owner?.paused !== true) {
      const dueAt = task.deadlineAt ?? (task.createdAt !== undefined ? task.createdAt + DEADLINE_MS : undefined)
      if (dueAt !== undefined && now > dueAt && task.createdAt !== undefined) {
        const ageMs = Math.max(0, now - task.createdAt)
        add(
          [index],
          "work_pending_overdue",
          { ...base, ageMs },
          `Task ${task.id} has been queued for ${Math.round(ageMs / 1_000)}s without a claim past its delivery window.`,
          "storage",
        )
      }
    }
    if (task.claimedBy !== undefined && task.state !== "replied") {
      const liveLease = task.leaseUntil !== undefined && task.leaseUntil > now
      const activeWithoutLease = task.leaseUntil === undefined
        && task.activeRunID !== undefined
        && task.activeRunID === task.claimedBy
      if (!liveLease && !activeWithoutLease) {
        add(
          [index],
          "work_lease_expired",
          {
            ...base,
            claimedBy: task.claimedBy,
            ...(task.leaseUntil !== undefined ? { leaseUntil: task.leaseUntil } : {}),
            reason: task.leaseUntil === undefined ? "missing" : "expired",
          },
          `Task ${task.id} is claimed by ${task.claimedBy} without a live heartbeat lease.`,
          "storage",
        )
      }
    }
    if (task.state !== undefined && task.outcome !== undefined) {
      const terminal = task.state === "replied"
      const problems: string[] = []
      if (terminal && task.outcome === "succeeded" && task.failure !== undefined) problems.push("succeeded-with-failure")
      if (terminal && task.outcome === "failed" && task.stoppedAt !== undefined && task.failure !== undefined) problems.push("cancelled-with-failure")
      if (!terminal && (task.repliedAt !== undefined || task.finishedAt !== undefined)) problems.push("non-terminal-with-finish")
      if (!terminal && task.outcome !== "pending") problems.push("non-terminal-nonpending-outcome")
      if (terminal && (task.claimedBy !== undefined || task.activeRunID !== undefined || task.retryAfter !== undefined)) problems.push("terminal-with-queue-fields")
      if (terminal && task.outcome === "pending") problems.push("terminal-pending-outcome")
      if (problems.length > 0) {
        add(
          [index],
          "work_terminal_contradiction",
          { ...base, state: task.state, outcome: task.outcome, status, problems },
          `Task ${task.id} has contradictory terminal fields: ${problems.join(", ")}.`,
          "storage",
        )
      }
    }
    if (status === "failed" && task.outcome === "failed" && task.failure !== undefined) {
      const timeoutReason = task.failure.reason !== undefined && TIMEOUT_REASON_CODES.has(task.failure.reason)
      if (task.failure.kind !== "native" || timeoutReason) {
        add(
          [index],
          "work_failed_timeout",
          { ...base, failureKind: task.failure.kind, reason: task.failure.reason, status },
          `Task ${task.id} derives failed with a ${task.failure.kind}${task.failure.reason ? ` (${task.failure.reason})` : ""} cause.`,
          "storage",
        )
      }
    }
  }
  for (const recovery of input.snapshot.recoveries ?? []) {
    if (recovery.to !== undefined && recovery.to !== "replied") {
      add(
        [index],
        "work_recovery_mismatch",
        { workspaceID: tasks[recovery.taskID]?.workspaceID, taskID: recovery.taskID, recoveredTo: recovery.to, problem: "invalid-target" },
        `Recovery ${recovery.taskID} targets ${recovery.to}, not replied.`,
        "storage",
      )
      continue
    }
    const task = tasks[recovery.taskID]
    if (!task || task.state !== "replied") continue
    const status = doctorWorkStatus(task, now)
    if (status === "replied" && task.failure === undefined && task.stoppedAt === undefined) continue
    const finished = task.finishedAt ?? task.repliedAt
    // A later terminal event is a new outcome, not a recovery contradiction.
    if (finished !== undefined && recovery.at !== undefined && finished > recovery.at) continue
    add(
      [index],
      "work_recovery_mismatch",
      {
        workspaceID: task.workspaceID,
        taskID: task.id,
        recoveredFrom: recovery.from,
        recoveredTo: recovery.to,
        status,
        failureKind: task.failure?.kind,
        ...(finished !== undefined ? { finishedAt: finished } : {}),
        ...(recovery.at !== undefined ? { recoveredAt: recovery.at } : {}),
      },
      `Task ${task.id} was recovered to replied but its durable row still reads ${status}.`,
      "storage",
    )
  }
}

/**
 * Walk the parent chain from one group to the root it declares. Returns a
 * reason code when the chain is broken; IDs only, no task content.
 */
function dispatchReachability(
  group: DispatchGroup,
  groups: Record<string, DispatchGroup>,
): "missing-parent" | "cycle" | "root-mismatch" | undefined {
  const seen = new Set<string>()
  let current: DispatchGroup | undefined = group
  while (current) {
    if (seen.has(current.id)) return "cycle"
    seen.add(current.id)
    if (current.id === group.rootID) {
      return current.rootID === current.id ? undefined : "root-mismatch"
    }
    if (!current.parentID) return "missing-parent"
    const parent: DispatchGroup | undefined = groups[current.parentID]
    if (!parent) return "missing-parent"
    if (parent.rootID !== group.rootID) return "root-mismatch"
    current = parent
  }
  return "missing-parent"
}

export function diagnoseLocations(inputs: DoctorLocationInput[]): DoctorReport {
  const pending = new Map<string, PendingMismatch>()
  const add = (indexes: number[], code: string, details: Record<string, unknown>, message: string, scope: DoctorMismatch["scope"] = "config") => {
    const key = `${code}\0${stableValue(details)}`
    const existing = pending.get(key)
    if (existing) {
      for (const index of indexes) existing.indexes.add(index)
      return
    }
    pending.set(key, { code, scope, message, details, indexes: new Set(indexes) })
  }

  const reports: DoctorLocationReport[] = inputs.map((input, index) => {
    const config = configReport(input)
    const workspace = locationWorkspace(input)
    if (config.status === "valid" && config.membership) {
      const entries = [
        { role: "leader", resolution: config.membership.leader },
        ...config.membership.members.map((resolution) => ({ role: "member", resolution })),
      ]
      for (const { role, resolution } of entries) {
        if (resolution.status === "resolved") continue
        const code = membershipCodes[resolution.status]
        add(
          [index],
          code,
          { directory: input.directory, role, name: resolution.name, matches: resolution.matches },
          `Config ${role} "${resolution.name}" is ${resolution.status} among Ensemble agents.`,
        )
      }
      const configuredMembers = new Set(config.members?.map((member) => member.toLowerCase()) ?? [])
      if (config.leader && !configuredMembers.has(config.leader.toLowerCase())) {
        add(
          [index],
          "config_leader_not_member",
          { directory: input.directory, leader: config.leader, members: config.members ?? [] },
          `Config leader "${config.leader}" is not listed in config members.`,
        )
      }
    }
    if (config.status === "valid" && workspace && config.membership) {
      const resolved = config.membership.members.flatMap((member) => (member.status === "resolved" && member.id ? [member.id] : []))
      if (resolved.length === config.membership.members.length) {
        const expected = [...new Set(resolved)].sort()
        const stored = [...new Set(workspace.memberIDs)].sort()
        if (expected.join("\0") !== stored.join("\0")) {
          add(
            [index],
            "config_storage_members_differ",
            { directory: input.directory, workspaceID: workspace.id, configMemberIDs: expected, storageMemberIDs: stored },
            `Workspace "${workspace.name}" stores members [${stored.join(", ")}], but .ensemble/config.json resolves to [${expected.join(", ")}].`,
          )
        }
      }
      if (config.name !== workspace.name) {
        add(
          [index],
          "config_storage_name_differ",
          { directory: input.directory, workspaceID: workspace.id, configName: config.name, storageName: workspace.name },
          `Workspace "${workspace.name}" does not match config name "${config.name}".`,
        )
      }
      if (config.membership.leader.status === "resolved" && config.membership.leader.id !== workspace.leaderID) {
        add(
          [index],
          "config_storage_leader_differ",
          { directory: input.directory, workspaceID: workspace.id, configLeaderID: config.membership.leader.id, storageLeaderID: workspace.leaderID },
          `Workspace leader ${workspace.leaderID} does not match config leader ${config.membership.leader.id}.`,
        )
      }
      if (config.synthesis !== undefined && config.synthesis !== workspace.synthesis) {
        add(
          [index],
          "config_storage_synthesis_differ",
          { directory: input.directory, workspaceID: workspace.id, configValue: config.synthesis, storageValue: workspace.synthesis },
          `Workspace synthesis is ${workspace.synthesis}, but .ensemble/config.json says ${config.synthesis}.`,
        )
      }
      if (config.paused !== undefined && config.paused !== workspace.paused) {
        add(
          [index],
          "config_storage_paused_differ",
          { directory: input.directory, workspaceID: workspace.id, configValue: config.paused, storageValue: workspace.paused },
          `Workspace paused is ${workspace.paused}, but .ensemble/config.json says ${config.paused}.`,
        )
      }
      if (config.version !== undefined && workspace.configVersion !== config.version) {
        add(
          [index],
          "config_storage_version_differ",
          { directory: input.directory, workspaceID: workspace.id, configVersion: config.version, storageVersion: workspace.configVersion ?? null },
          `Workspace config version is ${workspace.configVersion ?? "missing"}, but .ensemble/config.json is version ${config.version}.`,
        )
      }
    }
    if (config.status === "invalid") {
      add(
        [index],
        "config_invalid",
        { directory: input.directory, reason: config.reason ?? "invalid config" },
        `Invalid .ensemble/config.json: ${config.reason ?? "unknown validation error"}.`,
      )
    } else if (config.status === "missing" && workspace) {
      add(
        [index],
        "workspace_config_missing",
        { directory: input.directory, workspaceID: workspace.id, workspaceName: workspace.name },
        `Workspace "${workspace.name}" has no .ensemble/config.json.`,
      )
    } else if (config.status === "valid" && !workspace) {
      add(
        [index],
        "config_workspace_missing",
        { directory: input.directory, configName: config.name ?? null, configID: config.id ?? null },
        `.ensemble/config.json describes workspace "${config.name ?? "unknown"}", but no active stored workspace exists for this directory.`,
      )
    }

    const activeWorkspaces = Object.values(input.snapshot.workspaces)
      .filter((item) => !item.archived)
      .sort((a, b) => a.id.localeCompare(b.id))
    for (const item of activeWorkspaces) {
      for (const memberID of [...new Set(item.memberIDs)].sort()) {
        const member = input.snapshot.agents[memberID]
        if (!member) {
          add(
            [index],
            "storage_member_missing_agent",
            { workspaceID: item.id, memberID },
            `Workspace "${item.name}" lists member ${memberID}, but no agent has that ID.`,
            "storage",
          )
        } else if (member.archived) {
          add(
            [index],
            "storage_member_archived",
            { workspaceID: item.id, memberID, agentName: member.name },
            `Workspace "${item.name}" lists archived agent ${member.name} (${memberID}).`,
            "storage",
          )
        }
      }
      if (!item.memberIDs.includes(item.leaderID)) {
        add(
          [index],
          "storage_leader_not_member",
          { workspaceID: item.id, workspaceName: item.name, leaderID: item.leaderID, memberIDs: item.memberIDs },
          `Workspace "${item.name}" leader ${item.leaderID} is not in its member list.`,
          "storage",
        )
      }
      // Native sessions are created lazily, not when membership is assigned.
    }

    // Ticket #163: ledger invariants. Counters are derived facts, so the
    // doctor compares them to the work rows that actually spent hops and to
    // the parent/root lineage. A closed group may still hold exempt
    // completion, batch, turn, and synthesis rows; those never count.
    const dispatchGroups = input.snapshot.dispatchGroups ?? {}
    const dispatchTasks = input.snapshot.subtasks ?? {}
    const dispatchTasksByGroup = new Map<string, DoctorSubtask[]>()
    for (const task of Object.values(dispatchTasks)) {
      if (!task.dispatchGroupID) continue
      const bucket = dispatchTasksByGroup.get(task.dispatchGroupID)
      if (bucket) bucket.push(task)
      else dispatchTasksByGroup.set(task.dispatchGroupID, [task])
    }
    for (const group of Object.values(dispatchGroups).sort((a, b) => a.id.localeCompare(b.id))) {
      if (group.usedHops > group.maxHops) {
        add(
          [index],
          "dispatch_group_over_budget",
          { groupID: group.id, workspaceID: group.workspaceID, usedHops: group.usedHops, maxHops: group.maxHops },
          `Dispatch group ${group.id} used ${group.usedHops} of ${group.maxHops} hops.`,
          "storage",
        )
      }
      const countedHops = dispatchHopCount(dispatchTasksByGroup.get(group.id) ?? [])
      // Purged terminal rows may leave the counter higher; that only tightens
      // the budget. A counter below the visible counted work is the unsafe
      // direction because it would admit extra dispatches.
      if (countedHops > group.usedHops) {
        add(
          [index],
          "dispatch_group_counter_mismatch",
          { groupID: group.id, workspaceID: group.workspaceID, usedHops: group.usedHops, countedHops },
          `Dispatch group ${group.id} records ${group.usedHops} hops but ${countedHops} counted delegation/handoff rows reference it.`,
          "storage",
        )
      }
      if (isRootGroup(group)) {
        if (group.commandUsedHops !== undefined && group.commandMaxHops !== undefined && group.commandUsedHops > group.commandMaxHops) {
          add(
            [index],
            "dispatch_command_over_budget",
            { rootID: group.id, workspaceID: group.workspaceID, commandUsedHops: group.commandUsedHops, commandMaxHops: group.commandMaxHops },
            `Command ${group.id} used ${group.commandUsedHops} of ${group.commandMaxHops} hops.`,
            "storage",
          )
        }
        const familyUsedHops = Object.values(dispatchGroups)
          .filter((item) => item.rootID === group.id)
          .reduce((total, item) => total + item.usedHops, 0)
        if (group.commandUsedHops !== undefined && familyUsedHops !== group.commandUsedHops) {
          add(
            [index],
            "dispatch_command_counter_mismatch",
            { rootID: group.id, workspaceID: group.workspaceID, commandUsedHops: group.commandUsedHops, groupUsedHops: familyUsedHops },
            `Command ${group.id} records ${group.commandUsedHops} hops but its groups sum to ${familyUsedHops}.`,
            "storage",
          )
        }
        continue
      }
      const orphan = !group.parentID || !dispatchGroups[group.parentID]
      if (orphan) {
        add(
          [index],
          "dispatch_continuation_orphan",
          { groupID: group.id, workspaceID: group.workspaceID, parentID: group.parentID ?? null, rootID: group.rootID },
          `Continuation group ${group.id} names parent ${group.parentID ?? "(none)"}, which does not exist.`,
          "storage",
        )
      } else {
        const reason = dispatchReachability(group, dispatchGroups)
        if (reason) {
          add(
            [index],
            "dispatch_group_unreachable",
            { groupID: group.id, workspaceID: group.workspaceID, rootID: group.rootID, reason },
            `Dispatch group ${group.id} cannot reach root ${group.rootID} (${reason}).`,
            "storage",
          )
        }
      }
      if (
        dispatchGroupState(group, dispatchGroups) === "active" &&
        group.usedHops === 0 &&
        (dispatchTasksByGroup.get(group.id)?.length ?? 0) === 0
      ) {
        add(
          [index],
          "dispatch_continuation_empty",
          { groupID: group.id, workspaceID: group.workspaceID, rootID: group.rootID, continuationIndex: group.continuationIndex },
          `Continuation group ${group.id} is active with no work and no spent hops.`,
          "storage",
        )
      }
    }

    // Ticket #170: work-lifecycle invariants. Durable timestamps, claim
    // fields, structured failure causes, and recovery audit rows only.
    checkWorkRows(input, add, index)

    for (const item of Object.values(input.snapshot.bindings).sort((a, b) => a.key.localeCompare(b.key))) {
      const expectedKey = `${item.workspaceID}:${item.agentID}`
      if (item.key !== expectedKey) {
        add(
          [index],
          "binding_key_mismatch",
          { key: item.key, expectedKey, workspaceID: item.workspaceID, agentID: item.agentID },
          `Binding key "${item.key}" does not match workspace/agent fields (expected "${expectedKey}").`,
          "storage",
        )
      }
      const agent = input.snapshot.agents[item.agentID]
      if (item.workspaceID === "home") {
        if (!agent) {
          add(
            [index],
            "binding_unknown_agent",
            { key: item.key, workspaceID: item.workspaceID, agentID: item.agentID },
            `Home binding "${item.key}" points at missing agent ${item.agentID}.`,
            "storage",
          )
        }
        if (item.kind && item.kind !== "home") {
          add(
            [index],
            "binding_field_mismatch",
            { key: item.key, field: "kind", expected: "home", actual: item.kind },
            `Home binding "${item.key}" has kind "${item.kind}".`,
            "storage",
          )
        }
        continue
      }
      const owner = input.snapshot.workspaces[item.workspaceID]
      if (!owner) {
        add(
          [index],
          "binding_unknown_workspace",
          { key: item.key, workspaceID: item.workspaceID, agentID: item.agentID },
          `Binding "${item.key}" points at missing workspace ${item.workspaceID}.`,
          "storage",
        )
      }
      if (!agent) {
        add(
          [index],
          "binding_unknown_agent",
          { key: item.key, workspaceID: item.workspaceID, agentID: item.agentID },
          `Binding "${item.key}" points at missing agent ${item.agentID}.`,
          "storage",
        )
      }
      // Membership edits retain session bindings for former members.
      if (item.kind && item.kind !== "workspace") {
        add(
          [index],
          "binding_field_mismatch",
          { key: item.key, field: "kind", expected: "workspace", actual: item.kind },
          `Workspace binding "${item.key}" has kind "${item.kind}".`,
          "storage",
        )
      }
      if (owner && item.directory && item.directory !== owner.directory) {
        add(
          [index],
          "binding_field_mismatch",
          { key: item.key, field: "directory", expected: owner.directory, actual: item.directory },
          `Binding "${item.key}" points at directory ${item.directory}, but workspace "${owner.name}" is ${owner.directory}.`,
          "storage",
        )
      }
    }
    return {
      directory: input.directory,
      service: input.service,
      agents: Object.values(input.snapshot.agents).sort((a, b) => a.id.localeCompare(b.id)),
      workspaces: sortedWorkspaceReport(input),
      bindings: sortedBindings(input),
      config,
      dispatch: dispatchLedgerSummary(dispatchGroups),
      mismatches: [],
    }
  })

  if (inputs.length > 1) {
    const allIndexes = inputs.map((_, index) => index)
    const valueList = <T>(entries: Array<[number, T]>) => entries.map(([index, value]) => ({ directory: inputs[index].directory, value }))
    const missingIn = (present: Set<number>) => allIndexes.filter((index) => !present.has(index)).map((index) => inputs[index].directory)

    const agents = new Map<string, Map<number, DoctorAgent>>()
    for (let index = 0; index < reports.length; index++) {
      for (const item of reports[index].agents) {
        const seen = agents.get(item.id) ?? new Map<number, DoctorAgent>()
        seen.set(index, item)
        agents.set(item.id, seen)
      }
    }
    for (const [agentID, seen] of [...agents].sort(([a], [b]) => a.localeCompare(b))) {
      if (seen.size !== reports.length) {
        const missing = missingIn(new Set(seen.keys()))
        add(
          allIndexes,
          "cross_location_agent_missing",
          { agentID, agentName: [...seen.values()][0]?.name ?? null, missingIn: missing },
          `Agent ${[...seen.values()][0]?.name ?? agentID} (${agentID}) is missing from ${missing.join(", ")}.`,
          "cross-location",
        )
      }
      const entries = [...seen.entries()]
      if (entries.length < 2) continue
      const names = [...new Set(entries.map(([, item]) => item.name))]
      if (names.length > 1) {
        add(
          entries.map(([index]) => index),
          "cross_location_agent_name_differ",
          { agentID, values: valueList(entries.map(([index, item]) => [index, item.name])) },
          `Agent ${agentID} has different names across locations: ${names.join(", ")}.`,
          "cross-location",
        )
      }
      const archived = [...new Set(entries.map(([, item]) => item.archived))]
      if (archived.length > 1) {
        add(
          entries.map(([index]) => index),
          "cross_location_agent_archived_differ",
          { agentID, values: valueList(entries.map(([index, item]) => [index, item.archived])) },
          `Agent ${agentID} is archived in some locations but not others.`,
          "cross-location",
        )
      }
    }

    const workspaces = new Map<string, Map<number, DoctorWorkspace>>()
    for (let index = 0; index < reports.length; index++) {
      for (const item of reports[index].workspaces) {
        const seen = workspaces.get(item.id) ?? new Map<number, DoctorWorkspace>()
        seen.set(index, item)
        workspaces.set(item.id, seen)
      }
    }
    for (const [workspaceID, seen] of [...workspaces].sort(([a], [b]) => a.localeCompare(b))) {
      if (seen.size !== reports.length) {
        const missing = missingIn(new Set(seen.keys()))
        add(
          allIndexes,
          "cross_location_workspace_missing",
          { workspaceID, workspaceName: [...seen.values()][0]?.name ?? null, missingIn: missing },
          `Workspace ${[...seen.values()][0]?.name ?? workspaceID} (${workspaceID}) is missing from ${missing.join(", ")}.`,
          "cross-location",
        )
      }
      const entries = [...seen.entries()]
      if (entries.length < 2) continue
      const fields: Array<[string, string, (item: DoctorWorkspace) => unknown]> = [
        ["cross_location_workspace_name_differ", "name", (item) => item.name],
        ["cross_location_workspace_directory_differ", "directory", (item) => item.directory],
        ["cross_location_workspace_leader_differ", "leader", (item) => item.leaderID],
        ["cross_location_workspace_members_differ", "members", (item) => [...new Set(item.memberIDs)].sort()],
        ["cross_location_workspace_archived_differ", "archived", (item) => item.archived],
      ]
      for (const [code, field, read] of fields) {
        const entriesWithValue = entries.map(([index, item]) => [index, read(item)] as [number, unknown])
        if (new Set(entriesWithValue.map(([, value]) => stableValue(value))).size < 2) continue
        const name = entries[0][1].name
        add(
          entries.map(([index]) => index),
          code,
          { workspaceID, field, values: valueList(entriesWithValue) },
          `Workspace "${name}" (${workspaceID}) has different ${field} across locations.`,
          "cross-location",
        )
      }
    }

    const bindings = new Map<string, Map<number, DoctorBinding>>()
    for (let index = 0; index < reports.length; index++) {
      for (const item of reports[index].bindings) {
        const seen = bindings.get(item.key) ?? new Map<number, DoctorBinding>()
        seen.set(index, item)
        bindings.set(item.key, seen)
      }
    }
    for (const [key, seen] of [...bindings].sort(([a], [b]) => a.localeCompare(b))) {
      if (seen.size !== reports.length) {
        const missing = missingIn(new Set(seen.keys()))
        const first = [...seen.values()][0]
        add(
          allIndexes,
          "cross_location_binding_missing",
          { key, workspaceID: first.workspaceID, agentID: first.agentID, missingIn: missing },
          `Binding "${key}" is missing from ${missing.join(", ")}.`,
          "cross-location",
        )
      }
      const entries = [...seen.entries()]
      if (entries.length < 2) continue
      const sessions = [...new Set(entries.map(([, item]) => item.sessionID))]
      if (sessions.length > 1) {
        const first = entries[0][1]
        add(
          entries.map(([index]) => index),
          "cross_location_binding_session_differ",
          { key, workspaceID: first.workspaceID, agentID: first.agentID, values: valueList(entries.map(([index, item]) => [index, item.sessionID])) },
          `Binding "${key}" has different session IDs across locations.`,
          "cross-location",
        )
      }
      const fields: Array<[string, (item: DoctorBinding) => unknown]> = [
        ["workspaceID", (item) => item.workspaceID],
        ["agentID", (item) => item.agentID],
        ["kind", (item) => item.kind ?? null],
        ["directory", (item) => item.directory ?? null],
        ["agentVersion", (item) => item.agentVersion],
      ]
      for (const [field, read] of fields) {
        const entriesWithValue = entries.map(([index, item]) => [index, read(item)] as [number, unknown])
        if (new Set(entriesWithValue.map(([, value]) => stableValue(value))).size < 2) continue
        const first = entries[0][1]
        add(
          entries.map(([index]) => index),
          "cross_location_binding_field_differ",
          { key, workspaceID: first.workspaceID, agentID: first.agentID, field, values: valueList(entriesWithValue) },
          `Binding "${key}" has different ${field} across locations.`,
          "cross-location",
        )
      }
    }
  }

  const mismatches: DoctorMismatch[] = [...pending.values()]
    .map((item) => ({
      code: item.code,
      scope: item.scope,
      message: item.message,
      remediation: remediation[item.code] ?? "Review this mismatch and restore agreement before relying on this location.",
      locations: [...item.indexes].sort((a, b) => a - b).map((index) => inputs[index].directory),
      details: item.details,
    }))
    .sort((a, b) => a.code.localeCompare(b.code) || a.message.localeCompare(b.message))
  for (const [key, item] of pending) {
    const value = mismatches.find((mismatch) => mismatch.code === item.code && `${mismatch.code}\0${stableValue(mismatch.details)}` === key)
    if (!value) continue
    for (const index of item.indexes) reports[index].mismatches.push(value)
  }
  const byCode: Record<string, number> = {}
  for (const mismatch of mismatches) byCode[mismatch.code] = (byCode[mismatch.code] ?? 0) + 1
  const serviceKeys = new Set(inputs.map((input) => serviceKey(input.service)))
  return {
    ok: mismatches.length === 0,
    caveats: [
      "Read-only diagnostic: the doctor calls only the diagnostic RPC and never calls invoke, snapshot, or mutating methods; it never writes files.",
      "Diagnostic reads do not trigger workspace discovery or config reconciliation. Reads are sequential, not atomic. One selected service is queried for every directory; this does not discover separate service processes.",
      "Session bindings are lazy and may be retained for former members; their absence alone is not a defect.",
      "Dispatch counters may exceed visible counted work rows after terminal retention. The doctor flags only a counter below counted delegation/handoff work, a command whose counters disagree with its groups, and lineage or cap violations.",
      "Work checks read structured lifecycle fields only. An overdue pending row in a paused workspace is not flagged because that queue is intentionally idle; a later terminal event after a recovery is not a contradiction.",
    ],
    locations: reports,
    mismatches,
    summary: {
      locations: reports.length,
      services: serviceKeys.size,
      mismatchCount: mismatches.length,
      byCode,
      crossLocation: reports.length > 1,
      crossService: serviceKeys.size > 1,
    },
  }
}
