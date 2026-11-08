import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { canonicalDirectory } from "./paths.ts"
import { isDerivedWorkStatus } from "./queue.ts"
import { workspaceConfigPath, CONFIG_VERSION, type WorkspaceConfig } from "./workspace-config.ts"
import { diagnoseLocations, type DoctorConfigRead, type DoctorLocationInput, type DoctorReport, type DoctorSnapshot, type ServiceIdentity } from "./doctor.ts"

export type DoctorOptions = {
  json: boolean
  server?: string
  serviceFile?: string
  directories: string[]
  help: boolean
}

export class DoctorError extends Error {
  readonly code: string
  readonly exitCode: number

  constructor(code: string, message: string, exitCode = 2) {
    super(message)
    this.name = "DoctorError"
    this.code = code
    this.exitCode = exitCode
  }
}

export function parseDoctorArgs(argv: string[]): DoctorOptions {
  let json = false
  let server: string | undefined
  let serviceFile: string | undefined
  let help = false
  let endOfOptions = false
  const directories: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (endOfOptions) {
      directories.push(argument)
      continue
    }
    if (argument === "--") {
      endOfOptions = true
      continue
    }
    if (argument === "--json") {
      json = true
      continue
    }
    if (argument === "--help" || argument === "-h") {
      help = true
      continue
    }
    if (argument === "--server") {
      const value = argv[++index]
      if (!value) throw new DoctorError("usage", "--server needs a URL.")
      server = value
      continue
    }
    if (argument.startsWith("--server=")) {
      server = argument.slice("--server=".length)
      if (!server) throw new DoctorError("usage", "--server needs a URL.")
      continue
    }
    if (argument === "--service-file") {
      const value = argv[++index]
      if (!value) throw new DoctorError("usage", "--service-file needs a path.")
      serviceFile = value
      continue
    }
    if (argument.startsWith("--service-file=")) {
      serviceFile = argument.slice("--service-file=".length)
      if (!serviceFile) throw new DoctorError("usage", "--service-file needs a path.")
      continue
    }
    if (argument.startsWith("-")) throw new DoctorError("usage", "Unknown option. Use --help for usage.")
    directories.push(argument)
  }
  if (!help && directories.length === 0) {
    throw new DoctorError("usage", "At least one directory is required.")
  }
  return { json, server, serviceFile, directories, help }
}

export function readLocationConfig(directory: string): DoctorConfigRead {
  const path = workspaceConfigPath(directory)
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error: any) {
    if (error?.code === "ENOENT") return { present: false }
    throw new DoctorError("config_read_failed", `Could not read ${path}.`)
  }
  let value: any
  try {
    value = JSON.parse(text)
  } catch {
    return { present: true, valid: false, reason: "invalid JSON" }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { present: true, valid: false, reason: "config must be a JSON object" }
  if (value.version !== CONFIG_VERSION) return { present: true, valid: false, reason: `version must be ${CONFIG_VERSION}` }
  if (typeof value.name !== "string" || !value.name.trim()) return { present: true, valid: false, reason: "name must be a non-empty string" }
  if (typeof value.leader !== "string" || !value.leader.trim()) return { present: true, valid: false, reason: "leader must be a non-empty string" }
  if (!Array.isArray(value.members) || value.members.some((member: unknown) => typeof member !== "string")) {
    return { present: true, valid: false, reason: "members must be an array of strings" }
  }
  if (new Set(value.members.map((member: string) => member.toLowerCase())).size !== value.members.length) {
    return { present: true, valid: false, reason: "members contains duplicate names" }
  }
  const config: WorkspaceConfig = {
    version: CONFIG_VERSION,
    id: typeof value.id === "string" ? value.id : undefined,
    name: value.name.trim(),
    leader: value.leader.trim(),
    members: value.members.map((member: string) => member.trim()).filter(Boolean),
    synthesis: value.synthesis !== false,
    paused: value.paused === true,
  }
  return { present: true, valid: true, config }
}

export type ServiceDescriptor = {
  id?: string
  version?: string
  url: string
  pid?: number
  password?: string
}

export function defaultServiceDescriptorPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "opencode", "service.json")
}

export function readServiceDescriptor(path: string): ServiceDescriptor {
  let value: any
  try {
    value = JSON.parse(readFileSync(path, "utf8"))
  } catch (error: any) {
    if (error?.code === "ENOENT") throw new DoctorError("service_descriptor_missing", `Service descriptor not found: ${path}`)
    if (error instanceof SyntaxError) throw new DoctorError("service_descriptor_invalid", `Service descriptor is not valid JSON: ${path}`)
    throw new DoctorError("service_descriptor_invalid", `Could not read service descriptor: ${path}`)
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DoctorError("service_descriptor_invalid", `Service descriptor must be a JSON object: ${path}`)
  }
  if (typeof value.url !== "string" || !value.url.trim()) {
    throw new DoctorError("service_descriptor_invalid", `Service descriptor is missing a URL: ${path}`)
  }
  if (value.id !== undefined && typeof value.id !== "string") throw new DoctorError("service_descriptor_invalid", "Service descriptor id must be a string.")
  if (value.version !== undefined && typeof value.version !== "string") throw new DoctorError("service_descriptor_invalid", "Service descriptor version must be a string.")
  if (value.pid !== undefined && (!Number.isInteger(value.pid) || value.pid <= 0)) throw new DoctorError("service_descriptor_invalid", "Service descriptor pid must be a positive integer.")
  if (value.password !== undefined && typeof value.password !== "string") throw new DoctorError("service_descriptor_invalid", "Service descriptor password must be a string.")
  return { id: value.id, version: value.version, url: value.url.trim(), pid: value.pid, password: value.password }
}

function serviceIdentity(descriptor: ServiceDescriptor | undefined): ServiceIdentity {
  return {
    id: descriptor?.id ?? null,
    pid: descriptor?.pid ?? null,
    version: descriptor?.version ?? null,
  }
}

const unknownIdentity: ServiceIdentity = { id: null, pid: null, version: null }

export function validateServerUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new DoctorError("usage", "--server must be a valid http(s) URL.")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new DoctorError("usage", "--server must be a valid http(s) URL.")
  if (url.username || url.password) throw new DoctorError("usage", "--server must not contain credentials; set OPENCODE_PASSWORD instead.")
  return value.replace(/\/+$/, "")
}

function normalizeSnapshot(output: unknown, directory: string): DoctorSnapshot {
  const state = (output as any)?.state
  if (!state || typeof state !== "object") throw new DoctorError("snapshot_invalid", `Snapshot for ${directory} has no state object.`)
  if (!state.agents || typeof state.agents !== "object" || Array.isArray(state.agents)) throw new DoctorError("snapshot_invalid", `Snapshot for ${directory} has no agents map.`)
  if (!state.workspaces || typeof state.workspaces !== "object" || Array.isArray(state.workspaces)) throw new DoctorError("snapshot_invalid", `Snapshot for ${directory} has no workspaces map.`)
  if (!state.bindings || typeof state.bindings !== "object" || Array.isArray(state.bindings)) throw new DoctorError("snapshot_invalid", `Snapshot for ${directory} has no bindings map.`)
  const agents: DoctorSnapshot["agents"] = {}
  for (const [id, raw] of Object.entries<any>(state.agents)) {
    if (!raw || typeof raw.id !== "string" || typeof raw.name !== "string" || typeof raw.archived !== "boolean") {
      throw new DoctorError("snapshot_invalid", `Snapshot for ${directory} has an invalid agent entry: ${id}`)
    }
    agents[id] = { id: raw.id, name: raw.name, archived: raw.archived }
  }
  const workspaces: DoctorSnapshot["workspaces"] = {}
  for (const [id, raw] of Object.entries<any>(state.workspaces)) {
    if (
      !raw ||
      typeof raw.id !== "string" ||
      typeof raw.name !== "string" ||
      typeof raw.directory !== "string" ||
      typeof raw.leaderID !== "string" ||
      !Array.isArray(raw.memberIDs) ||
      raw.memberIDs.some((memberID: unknown) => typeof memberID !== "string") ||
      typeof raw.archived !== "boolean" ||
      typeof raw.synthesis !== "boolean" ||
      typeof raw.paused !== "boolean"
    ) {
      throw new DoctorError("snapshot_invalid", `Snapshot for ${directory} has an invalid workspace entry: ${id}`)
    }
    workspaces[id] = {
      id: raw.id,
      name: raw.name,
      directory: raw.directory,
      leaderID: raw.leaderID,
      memberIDs: raw.memberIDs,
      archived: raw.archived,
      synthesis: raw.synthesis,
      paused: raw.paused,
      configVersion: typeof raw.configVersion === "number" ? raw.configVersion : undefined,
    }
  }
  const bindings: DoctorSnapshot["bindings"] = {}
  for (const [key, raw] of Object.entries<any>(state.bindings)) {
    if (
      !raw ||
      typeof raw.workspaceID !== "string" ||
      typeof raw.agentID !== "string" ||
      typeof raw.sessionID !== "string" ||
      typeof raw.agentVersion !== "number"
    ) {
      throw new DoctorError("snapshot_invalid", `Snapshot for ${directory} has an invalid binding entry: ${key}`)
    }
    if (raw.kind !== undefined && raw.kind !== "workspace" && raw.kind !== "home") {
      throw new DoctorError("snapshot_invalid", `Snapshot for ${directory} has an invalid binding kind: ${key}`)
    }
    if (raw.directory !== undefined && typeof raw.directory !== "string") {
      throw new DoctorError("snapshot_invalid", `Snapshot for ${directory} has an invalid binding directory: ${key}`)
    }
    bindings[key] = {
      key,
      workspaceID: raw.workspaceID,
      agentID: raw.agentID,
      sessionID: raw.sessionID,
      kind: raw.kind,
      directory: raw.directory,
      agentVersion: raw.agentVersion,
    }
  }
  // Ticket #163: ledger records are optional so a pre-ledger service still
  // produces a usable report. Task rows are reduced to the fields hop counting
  // needs; titles, instructions, and conversation text never travel.
  let dispatchGroups: DoctorSnapshot["dispatchGroups"]
  if (state.dispatchGroups !== undefined) {
    if (!state.dispatchGroups || typeof state.dispatchGroups !== "object" || Array.isArray(state.dispatchGroups)) {
      throw new DoctorError("snapshot_invalid", `Snapshot for ${directory} has an invalid dispatchGroups map.`)
    }
    dispatchGroups = {}
    for (const [id, raw] of Object.entries<any>(state.dispatchGroups)) {
      if (
        !raw ||
        typeof raw.id !== "string" ||
        typeof raw.workspaceID !== "string" ||
        typeof raw.rootID !== "string" ||
        typeof raw.continuationIndex !== "number" ||
        typeof raw.maxHops !== "number" ||
        typeof raw.usedHops !== "number" ||
        typeof raw.depthMax !== "number" ||
        typeof raw.createdAt !== "number"
      ) {
        throw new DoctorError("snapshot_invalid", `Snapshot for ${directory} has an invalid dispatch group entry: ${id}`)
      }
      dispatchGroups[id] = {
        id: raw.id,
        workspaceID: raw.workspaceID,
        rootID: raw.rootID,
        ...(typeof raw.parentID === "string" ? { parentID: raw.parentID } : {}),
        continuationIndex: raw.continuationIndex,
        maxHops: raw.maxHops,
        usedHops: raw.usedHops,
        depthMax: raw.depthMax,
        ...(typeof raw.commandMaxHops === "number" ? { commandMaxHops: raw.commandMaxHops } : {}),
        ...(typeof raw.commandUsedHops === "number" ? { commandUsedHops: raw.commandUsedHops } : {}),
        ...(typeof raw.maxContinuations === "number" ? { maxContinuations: raw.maxContinuations } : {}),
        ...(typeof raw.continuationsUsed === "number" ? { continuationsUsed: raw.continuationsUsed } : {}),
        createdAt: raw.createdAt,
        ...(typeof raw.closedAt === "number" ? { closedAt: raw.closedAt } : {}),
        ...(raw.closeReason === "continued" ? { closeReason: "continued" as const } : {}),
        ...(raw.reconciled === true ? { reconciled: true } : {}),
      }
    }
  }
  let subtasks: DoctorSnapshot["subtasks"]
  if (state.subtasks !== undefined) {
    if (!state.subtasks || typeof state.subtasks !== "object" || Array.isArray(state.subtasks)) {
      throw new DoctorError("snapshot_invalid", `Snapshot for ${directory} has an invalid subtasks map.`)
    }
    subtasks = {}
    for (const [id, raw] of Object.entries<any>(state.subtasks)) {
      if (!raw || typeof raw.id !== "string") {
        throw new DoctorError("snapshot_invalid", `Snapshot for ${directory} has an invalid subtask entry: ${id}`)
      }
      const workKind = raw.workKind === "delegation" || raw.workKind === "handoff" || raw.workKind === "turn" ? raw.workKind : undefined
      const stateValue = raw.state === "pending" || raw.state === "working" || raw.state === "replied" ? raw.state : undefined
      const outcomeValue = raw.outcome === "pending" || raw.outcome === "succeeded" || raw.outcome === "failed" ? raw.outcome : undefined
      const statusValue = isDerivedWorkStatus(raw.status) ? raw.status : undefined
      const failureKind = raw.failure?.kind === "native" || raw.failure?.kind === "delivery" || raw.failure?.kind === "lease" || raw.failure?.kind === "attempts"
        ? raw.failure.kind
        : undefined
      const failure = failureKind
        ? { kind: failureKind, ...(typeof raw.failure.reason === "string" ? { reason: raw.failure.reason } : {}) }
        : undefined
      const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined
      subtasks[id] = {
        id: raw.id,
        ...(typeof raw.workspaceID === "string" ? { workspaceID: raw.workspaceID } : {}),
        ...(typeof raw.parentID === "string" ? { parentID: raw.parentID } : {}),
        ...(typeof raw.dispatchGroupID === "string" ? { dispatchGroupID: raw.dispatchGroupID } : {}),
        creatorType: raw.creatorType === "agent" ? "agent" : "user",
        ...(workKind ? { workKind } : {}),
        ...(raw.handoff && typeof raw.handoff === "object"
          ? {
              handoff: {
                ...(typeof raw.handoff.completion === "boolean" ? { completion: raw.handoff.completion } : {}),
                ...(typeof raw.handoff.batch === "boolean" ? { batch: raw.handoff.batch } : {}),
              },
            }
          : {}),
        ...(stateValue ? { state: stateValue } : {}),
        ...(outcomeValue ? { outcome: outcomeValue } : {}),
        ...(statusValue ? { status: statusValue } : {}),
        ...(typeof raw.interrupted === "boolean" ? { interrupted: raw.interrupted } : {}),
        ...(typeof raw.approvalID === "string" ? { approvalID: raw.approvalID } : {}),
        ...(typeof raw.awaitingChildren === "boolean" ? { awaitingChildren: raw.awaitingChildren } : {}),
        ...(number(raw.attempts) !== undefined ? { attempts: number(raw.attempts) } : {}),
        ...(number(raw.createdAt) !== undefined ? { createdAt: number(raw.createdAt) } : {}),
        ...(number(raw.deadlineAt) !== undefined ? { deadlineAt: number(raw.deadlineAt) } : {}),
        ...(typeof raw.claimedBy === "string" ? { claimedBy: raw.claimedBy } : {}),
        ...(number(raw.leaseUntil) !== undefined ? { leaseUntil: number(raw.leaseUntil) } : {}),
        ...(typeof raw.activeRunID === "string" ? { activeRunID: raw.activeRunID } : {}),
        ...(number(raw.retryAfter) !== undefined ? { retryAfter: number(raw.retryAfter) } : {}),
        ...(number(raw.finishedAt) !== undefined ? { finishedAt: number(raw.finishedAt) } : {}),
        ...(number(raw.repliedAt) !== undefined ? { repliedAt: number(raw.repliedAt) } : {}),
        ...(number(raw.stoppedAt) !== undefined ? { stoppedAt: number(raw.stoppedAt) } : {}),
        ...(failure ? { failure } : {}),
      }
    }
  }
  let recoveries: DoctorSnapshot["recoveries"]
  const rawRecoveries = (output as any)?.recoveries
  if (rawRecoveries !== undefined) {
    if (!Array.isArray(rawRecoveries)) {
      throw new DoctorError("snapshot_invalid", `Snapshot for ${directory} has an invalid recoveries list.`)
    }
    recoveries = []
    for (const raw of rawRecoveries) {
      if (!raw || typeof raw.taskID !== "string") continue
      recoveries.push({
        taskID: raw.taskID,
        ...(typeof raw.from === "string" ? { from: raw.from } : {}),
        ...(typeof raw.to === "string" ? { to: raw.to } : {}),
        ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
        ...(typeof raw.at === "number" && Number.isFinite(raw.at) ? { at: raw.at } : {}),
      })
    }
  }
  return {
    agents,
    workspaces,
    bindings,
    ...(dispatchGroups ? { dispatchGroups } : {}),
    ...(subtasks ? { subtasks } : {}),
    ...(recoveries ? { recoveries } : {}),
  }
}

async function fetchDiagnostic(url: string, password: string | undefined, directory: string, fetchImpl: typeof fetch): Promise<DoctorSnapshot> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (password) headers.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  const target = `${url}/api/rpc/ensemble.v2/diagnostic?location%5Bdirectory%5D=${encodeURIComponent(directory)}`
  let response: Response
  try {
    response = await fetchImpl(target, {
      method: "POST",
      redirect: "error",
      headers,
      body: JSON.stringify({ input: { directory } }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new DoctorError("snapshot_failed", `Could not reach the OpenCode service for ${directory}.`)
  }
  if (!response.ok) {
    throw new DoctorError("snapshot_failed", `Diagnostic request for ${directory} failed with HTTP ${response.status}.`)
  }
  let body: any
  try {
    body = await response.json()
  } catch {
    throw new DoctorError("snapshot_invalid", `Diagnostic response for ${directory} was not JSON.`)
  }
  return normalizeSnapshot(body?.output, directory)
}

export type DoctorRunOptions = {
  env?: NodeJS.ProcessEnv
  home?: string
  fetchImpl?: typeof fetch
  stdout?: (text: string) => void
  stderr?: (text: string) => void
}

export async function runDoctor(argv: string[], options: DoctorRunOptions = {}): Promise<number> {
  const env = options.env ?? process.env
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text))
  const fetchImpl = options.fetchImpl ?? fetch
  const args = parseDoctorArgs(argv)
  if (args.help) {
    stdout(helpText())
    return 0
  }
  const descriptorPath = args.serviceFile ?? defaultServiceDescriptorPath(env, options.home ?? homedir())
  let descriptor: ServiceDescriptor | undefined
  if (args.serviceFile || !args.server) {
    descriptor = readServiceDescriptor(descriptorPath)
  }
  const descriptorUrl = descriptor ? validateServerUrl(descriptor.url) : undefined
  const url = validateServerUrl(args.server ?? descriptorUrl ?? "")
  const password = env.OPENCODE_PASSWORD ?? descriptor?.password
  const identity = descriptor && (args.serviceFile || !args.server || descriptorUrl === url) ? serviceIdentity(descriptor) : unknownIdentity
  const directories = [...new Set(args.directories.map((directory) => {
    try {
      return canonicalDirectory(directory)
    } catch {
      throw new DoctorError("invalid_directory", `Not a directory: ${directory}`)
    }
  }))]
  const locations: DoctorLocationInput[] = []
  for (const directory of directories) {
    const snapshot = await fetchDiagnostic(url, password, directory, fetchImpl)
    const config = readLocationConfig(directory)
    locations.push({
      directory,
      configPath: workspaceConfigPath(directory),
      service: identity,
      snapshot,
      config,
    })
  }
  const report = diagnoseLocations(locations)
  if (args.json) stdout(`${JSON.stringify(report, null, 2)}\n`)
  else stdout(renderHuman(report))
  return report.ok ? 0 : 1
}

function helpText(): string {
  return `Ensemble doctor: read-only multi-location diagnosis

Usage:
  npm run doctor -- [--json] [--server <url>] [--service-file <path>] <directory> [<directory> ...]

Options:
  --json                 Emit one machine-readable report (no credentials).
  --server <url>         Override the service URL.
  --service-file <path>  Override the OpenCode service descriptor path.
  --help                 Show this help.

Service resolution:
   The default descriptor is $XDG_STATE_HOME/opencode/service.json, or
   ~/.local/state/opencode/service.json when XDG_STATE_HOME is unset. --service-file overrides the path and --server
  overrides the URL. OPENCODE_PASSWORD takes precedence over the descriptor password.
   --server alone does not read the default descriptor or reuse its credentials;
   set OPENCODE_PASSWORD. Combine --service-file and --server only when they describe
   the same service. Descriptor identities are not verified against the running host.
   Credentials are never printed.

Read-only:
  The doctor calls only the read-only diagnostic RPC for each directory. It never calls invoke,
  snapshot, or any mutating method, and it never writes storage or .ensemble/config.json.
  The diagnostic read does not trigger workspace discovery or config reconciliation.

Cross-location comparison:
   Every directory is queried on the one selected service. This does not discover or
   compare separate processes. Reads are sequential, not atomic; differences may
   reflect concurrent activity. Bindings are lazy and retained for former members.

Exit codes:
  0  All requested locations agree.
  1  Divergence found.
  2  Usage, connection, snapshot, or config-read failure.
`
}

function renderHuman(report: DoctorReport): string {
  const lines: string[] = ["Ensemble doctor", ""]
  for (const caveat of report.caveats) lines.push(`Note: ${caveat}`)
  lines.push("")
  for (const location of report.locations) {
    lines.push(`Location: ${location.directory}`)
    lines.push(`  Service: id=${location.service.id ?? "unknown"} pid=${location.service.pid ?? "unknown"} version=${location.service.version ?? "unknown"}`)
    lines.push(`  Agents (${location.agents.length}):`)
    if (location.agents.length === 0) lines.push("    none")
    for (const agent of location.agents) lines.push(`    - ${agent.name} (${agent.id})${agent.archived ? " [archived]" : ""}`)
    lines.push(`  Workspaces (${location.workspaces.length}):`)
    if (location.workspaces.length === 0) lines.push("    none")
    for (const workspace of location.workspaces) {
      const own = workspace.directory === location.directory ? " [this location]" : " [other location]"
      lines.push(`    - ${workspace.name} (${workspace.id}) directory=${workspace.directory}${own}`)
      lines.push(`      leader: ${workspace.leaderName ?? "unknown"} (${workspace.leaderID})`)
      lines.push(`      members: ${workspace.memberIDs.map((memberID, index) => `${workspace.memberNames[index] ?? "unknown"} (${memberID})`).join(", ") || "none"}`)
      lines.push(`      configVersion: ${workspace.configVersion ?? "missing"}; synthesis=${workspace.synthesis}; paused=${workspace.paused}; archived=${workspace.archived}`)
    }
    lines.push(`  Dispatch: groups=${location.dispatch.groups} roots=${location.dispatch.roots} continuations=${location.dispatch.continuations} active=${location.dispatch.activeGroups} exhausted=${location.dispatch.exhaustedGroups} closed=${location.dispatch.closedGroups} hops=${location.dispatch.usedHops}/${location.dispatch.maxHops} command=${location.dispatch.commandUsedHops}/${location.dispatch.commandMaxHops}`)
    lines.push(`  Bindings (${location.bindings.length}):`)
    if (location.bindings.length === 0) lines.push("    none")
    for (const binding of location.bindings) {
      lines.push(`    - ${binding.key} -> ${binding.sessionID} (${binding.kind ?? "unspecified"}${binding.directory ? `, ${binding.directory}` : ""}) agent=${binding.agentName ?? binding.agentID}`)
    }
    lines.push(`  Config: ${configLabel(location.config)}`)
    if (location.config.status === "valid") {
      lines.push(`    name: ${location.config.name ?? "unknown"}; leader: ${location.config.leader ?? "unknown"}; members: ${(location.config.members ?? []).join(", ") || "none"}; synthesis=${location.config.synthesis}; paused=${location.config.paused}; version=${location.config.version}`)
      const membership = location.config.membership
      if (membership) {
        const described = (member: typeof membership.leader) => `${member.name} -> ${member.status === "resolved" ? member.id : member.status}`
        lines.push(`    membership: leader: ${described(membership.leader)}; members: ${membership.members.map(described).join(", ") || "none"}`)
      }
    }
    lines.push(`  Mismatches: ${location.mismatches.length === 0 ? "none" : location.mismatches.map((mismatch) => mismatch.code).join(", ")}`)
    lines.push("")
  }
  if (report.locations.length <= 1) {
    lines.push("Cross-location: skipped (one location requested).")
  } else if (report.summary.crossService) {
    lines.push(`Cross-location: checked ${report.summary.locations} locations across ${report.summary.services} service instances.`)
  } else {
    lines.push(`Cross-location: checked ${report.summary.locations} locations served by one service instance (differences can still appear if its snapshots changed between requests).`)
  }
  lines.push(`Summary: ${report.summary.mismatchCount} mismatch${report.summary.mismatchCount === 1 ? "" : "es"} across ${report.summary.locations} location${report.summary.locations === 1 ? "" : "s"}.`)
  if (report.mismatches.length > 0) {
    lines.push("", "Mismatches:")
    for (const mismatch of report.mismatches) lines.push(`  - [${mismatch.code}] ${mismatch.message} (${mismatch.locations.join(", ")})`)
    lines.push("", "Remediation:")
    const codes = [...new Set(report.mismatches.map((mismatch) => mismatch.code))].sort()
    for (const code of codes) {
      const item = report.mismatches.find((mismatch) => mismatch.code === code)
      if (item) lines.push(`  - ${code}: ${item.remediation}`)
    }
  } else {
    lines.push("Result: all requested locations agree.")
  }
  return `${lines.join("\n")}\n`
}

function configLabel(config: DoctorReport["locations"][number]["config"]): string {
  if (config.status === "missing") return `missing (${config.path ?? "no path"})`
  if (config.status === "invalid") return `invalid: ${config.reason ?? "unknown reason"}`
  return `valid (${config.path ?? "no path"})`
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  try {
    process.exitCode = await runDoctor(argv)
  } catch (error: any) {
    const report = {
      ok: false,
      locations: [],
      mismatches: [],
      summary: { locations: 0, services: 0, mismatchCount: 0, byCode: {}, crossLocation: false, crossService: false },
      error: { code: error?.code ?? "doctor_failed", message: error?.message ?? "Doctor failed." },
    }
    if (argv.includes("--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    else process.stderr.write(`doctor: ${error?.message ?? error}\n`)
    process.exitCode = 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
