import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { initMetadataPath, workspaceConfigPath, CONFIG_VERSION, writeWorkspaceConfigValue, type WorkspaceConfig } from "./workspace-config.ts"
import { stableHash } from "./queue.ts"
import type { Agent, Id, Workspace } from "./types.ts"

/**
 * Ticket #273: one durable backup document for Ensemble plugin state and
 * workspace config.
 *
 * The document is a versioned, self-contained export of the host storage rows
 * the service owns (`v2/` entities plus the meta row) and the derived
 * `.ensemble/config.json` files those rows name. It is deliberately built on
 * the public `ctx.storage` surface (get/set/remove/scan) rather than a host
 * file format, so it works for every OpenCode storage backend and for tests.
 *
 * Scope boundaries:
 * - Conversation attachment bytes, handoff files, and `AGENTS.md` are project
 *   files, not plugin state; they are not copied.
 * - Retention, deletion, and user-facing data export policy belong to #272.
 *   This module is the recovery path. A future export can reuse the envelope
 *   and `collectBackup` without adding a second state serialization.
 * - Logs and errors carry counts and reason codes only; never conversation
 *   text, credentials, or absolute paths.
 */

export const BACKUP_FORMAT = "ensemble.backup"
export const BACKUP_FORMAT_VERSION = 1
/** One pre-restore copy so a failed apply is recoverable without a file. */
export const BACKUP_ROLLBACK_KEY = "v2/backup/rollback"
const META_KEY = "v2/meta"
/** Pre-v2 migration source; restored exactly so stale agents cannot return. */
const LEGACY_KEY = "ensemble.state"
/** Restored stores are bounded so one document cannot exhaust the host. */
export const BACKUP_MAX_ENTRIES = 200_000

const ENTITY_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["v2/agent/", "agents"],
  ["v2/workspace/", "workspaces"],
  ["v2/message/", "messages"],
  ["v2/subtask/", "subtasks"],
  ["v2/dispatchgroup/", "dispatchGroups"],
  ["v2/init/", "initJobs"],
  ["v2/native-subagent/", "nativeSubagents"],
  ["v2/binding/", "bindings"],
  ["v2/memory/", "memories"],
  ["v2/approval/", "approvals"],
  ["v2/dmqueue/", "dmQueue"],
  ["v2/dm/", "legacyDirect"],
]

/** Every durable prefix a restore replaces. Order is stable for tests. */
export const BACKUP_PREFIXES: readonly string[] = ENTITY_PREFIXES.map(([prefix]) => prefix)

/** The narrow storage slice the plugin context provides. */
export type BackupStorage = {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  remove: (key: string) => Promise<void>
  scan: (options: { prefix: string; after?: string; limit?: number }) => Promise<{
    entries?: Array<{ key: string; value: unknown }>
    next?: string
  }>
}

export type BackupCounts = Record<string, number>

export type BackupMeta = {
  version: number
  updatedAt: number
  settings: Record<string, unknown>
  ui: Record<string, unknown>
}

export type BackupEntry = { key: string; value: unknown }

/**
 * The derived project file for one workspace, captured for export and
 * inspection. `workspaceID` is the join key; the directory lives on the
 * durable workspace row and is never duplicated here.
 */
export type BackupWorkspaceConfig = {
  workspaceID: Id
  config?: WorkspaceConfig
  init?: { version?: number; installedAt?: number }
}

export type EnsembleBackup = {
  format: typeof BACKUP_FORMAT
  formatVersion: number
  createdAt: number
  /** Snapshot/protocol version of the exporting service. */
  protocol: number
  /** AGENTS.md contract version of the exporting release. */
  contractVersion: number
  counts: BackupCounts
  /** `stableHash` of the canonical payload; detects truncation or edits. */
  digest: string
  payload: {
    meta: BackupMeta | null
    entries: BackupEntry[]
    workspaceConfigs: BackupWorkspaceConfig[]
    /** Pre-v2 `ensemble.state`, captured so a restore can replace or clear it. */
    legacy?: unknown
  }
}

export type BackupApplyReport = {
  formatVersion: number
  createdAt: number
  /** Coordination version written to the restored meta row. */
  version: number
  counts: BackupCounts
  workspaces: { restored: number; skipped: number; removed: number }
  rollbackSlot: { written: boolean }
}

export type BackupSlotStatus =
  | { present: false }
  | { present: true; valid: true; formatVersion: number; createdAt: number; version: number; counts: BackupCounts }
  | { present: true; valid: false; reason: string }

export type BackupApplyOptions = {
  protocol: number
  contractVersion: number
  /**
   * Current coordination version in the running service. The restored meta
   * version never moves backwards, so a client cursor stays attributable.
   */
  versionFloor?: number
  now?: number
  /** Write the pre-apply state to the rollback slot (default true). */
  rollbackSlot?: boolean
}

export class BackupError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "BackupError"
    this.code = code
  }
}

type Captured = {
  meta: BackupMeta | null
  entries: BackupEntry[]
  legacy?: unknown
}

type ConfigCapture = {
  workspaceID: Id
  directory: string
  configPath: string
  text?: string
}

function invalid(message: string): never {
  throw new BackupError("invalid_backup", message)
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/**
 * Match the RPC envelope's JSON projection so a document's digest is stable
 * across `invoke`/file round trips: object keys with `undefined` disappear.
 */
function normalizeJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item)) as T
  if (isRecord(value)) {
    const next: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || typeof item === "function" || typeof item === "symbol") continue
      next[key] = normalizeJson(item)
    }
    return next as T
  }
  return value
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`
}

function digestOf(input: {
  format: string
  formatVersion: number
  createdAt: number
  protocol: number
  contractVersion: number
  payload: EnsembleBackup["payload"]
}): string {
  return stableHash(canonicalJson({
    format: input.format,
    formatVersion: input.formatVersion,
    createdAt: input.createdAt,
    protocol: input.protocol,
    contractVersion: input.contractVersion,
    payload: input.payload,
  }))
}

/** Normalize the stored meta row the way `V2Store.load` reads it. */
function normalizeMeta(value: unknown, now: number): BackupMeta | null {
  if (!isRecord(value)) return null
  return {
    version: finite(value.version) ? Math.max(0, Math.floor(value.version)) : 0,
    updatedAt: finite(value.updatedAt) ? value.updatedAt : now,
    settings: isRecord(value.settings) ? { ...value.settings } : {},
    ui: isRecord(value.ui) ? { ...value.ui } : {},
  }
}

function entityName(key: string): string | undefined {
  return ENTITY_PREFIXES.find(([prefix]) => key.startsWith(prefix))?.[1]
}

async function scanAll(storage: BackupStorage, prefix: string): Promise<BackupEntry[]> {
  const entries: BackupEntry[] = []
  let cursor: string | undefined
  do {
    const page = await storage.scan({ prefix, ...(cursor ? { after: cursor } : {}), limit: 500 })
    entries.push(...(page.entries ?? []).map((entry) => ({ key: entry.key, value: entry.value })))
    cursor = page.next
  } while (cursor)
  return entries
}

function compareKeys(a: BackupEntry, b: BackupEntry): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

function countEntries(entries: readonly BackupEntry[]): BackupCounts {
  const counts: BackupCounts = Object.fromEntries(ENTITY_PREFIXES.map(([, name]) => [name, 0]))
  for (const entry of entries) {
    const name = entityName(entry.key)
    if (name) counts[name] += 1
  }
  return counts
}

function workspaceRows(entries: readonly BackupEntry[]): Workspace[] {
  const workspaces: Workspace[] = []
  for (const entry of entries) {
    if (entityName(entry.key) !== "workspaces") continue
    const value = entry.value
    if (!isRecord(value) || typeof value.id !== "string") continue
    workspaces.push(value as Workspace)
  }
  return workspaces.sort((a, b) => a.id.localeCompare(b.id))
}

function agentRows(entries: readonly BackupEntry[]): Record<Id, Agent> {
  const agents: Record<Id, Agent> = {}
  for (const entry of entries) {
    if (entityName(entry.key) !== "agents") continue
    const value = entry.value
    if (isRecord(value) && typeof value.id === "string") agents[value.id] = value as Agent
  }
  return agents
}

function directoryExists(directory: string): boolean {
  try {
    return statSync(directory).isDirectory()
  } catch {
    return false
  }
}

/** Capture the derived workspace files for export and rollback. */
function captureWorkspaceConfigs(entries: readonly BackupEntry[]): {
  backups: BackupWorkspaceConfig[]
  files: ConfigCapture[]
} {
  const backups: BackupWorkspaceConfig[] = []
  const files: ConfigCapture[] = []
  for (const workspace of workspaceRows(entries)) {
    if (workspace.archived) continue
    const backup: BackupWorkspaceConfig = { workspaceID: workspace.id }
    if (typeof workspace.directory === "string" && directoryExists(workspace.directory)) {
      const path = workspaceConfigPath(workspace.directory)
      try {
        const value = JSON.parse(readFileSync(path, "utf8"))
        if (isRecord(value) && value.version === CONFIG_VERSION && typeof value.name === "string") {
          backup.config = {
            version: CONFIG_VERSION,
            id: typeof value.id === "string" ? value.id : undefined,
            name: value.name,
            leader: String(value.leader ?? ""),
            members: Array.isArray(value.members) ? value.members.map(String) : [],
            synthesis: value.synthesis !== false,
            paused: value.paused === true,
          }
        }
      } catch {}
      try {
        const init = JSON.parse(readFileSync(initMetadataPath(workspace.directory), "utf8"))
        if (isRecord(init)) {
          backup.init = {
            ...(finite(init.version) ? { version: init.version } : {}),
            ...(finite(init.installedAt) ? { installedAt: init.installedAt } : {}),
          }
        }
      } catch {}
      if (existsSync(path)) {
        try {
          files.push({ workspaceID: workspace.id, directory: workspace.directory, configPath: path, text: readFileSync(path, "utf8") })
        } catch {
          files.push({ workspaceID: workspace.id, directory: workspace.directory, configPath: path })
        }
      } else {
        files.push({ workspaceID: workspace.id, directory: workspace.directory, configPath: path })
      }
    }
    if (backup.config || backup.init) backups.push(backup)
  }
  return { backups, files }
}

async function capture(storage: BackupStorage, now: number): Promise<Captured> {
  const entries: BackupEntry[] = []
  for (const prefix of BACKUP_PREFIXES) entries.push(...(await scanAll(storage, prefix)))
  entries.sort(compareKeys)
  const meta = normalizeMeta(await storage.get(META_KEY), now)
  const legacy = await storage.get(LEGACY_KEY)
  return { meta, entries, ...(isRecord(legacy) ? { legacy } : {}) }
}

function buildDocument(input: {
  meta: BackupMeta | null
  entries: BackupEntry[]
  workspaceConfigs: BackupWorkspaceConfig[]
  legacy?: unknown
  createdAt: number
  protocol: number
  contractVersion: number
}): EnsembleBackup {
  const entries = normalizeJson([...input.entries].sort(compareKeys))
  const legacy = normalizeJson(input.legacy)
  const payload: EnsembleBackup["payload"] = {
    meta: normalizeJson(input.meta),
    entries,
    workspaceConfigs: normalizeJson(input.workspaceConfigs),
    ...(legacy === undefined ? {} : { legacy }),
  }
  const header = {
    format: BACKUP_FORMAT as typeof BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: input.createdAt,
    protocol: input.protocol,
    contractVersion: input.contractVersion,
  }
  return {
    ...header,
    counts: countEntries(entries),
    digest: digestOf({ ...header, payload }),
    payload,
  }
}

/** Recompute counts and digest after a deliberate document edit (CLI/tools). */
export function sealBackup(document: Omit<EnsembleBackup, "counts" | "digest">): EnsembleBackup {
  return buildDocument({
    meta: document.payload.meta,
    entries: document.payload.entries,
    workspaceConfigs: document.payload.workspaceConfigs,
    legacy: document.payload.legacy,
    createdAt: document.createdAt,
    protocol: document.protocol,
    contractVersion: document.contractVersion,
  })
}

/** Read the current durable state into one portable document. */
export async function collectBackup(
  storage: BackupStorage,
  options: { protocol: number; contractVersion: number; now?: number },
): Promise<EnsembleBackup> {
  const now = options.now ?? Date.now()
  const captured = await capture(storage, now)
  return buildDocument({
    meta: captured.meta,
    entries: captured.entries,
    workspaceConfigs: captureWorkspaceConfigs(captured.entries).backups,
    legacy: captured.legacy,
    createdAt: now,
    protocol: options.protocol,
    contractVersion: options.contractVersion,
  })
}

function validateKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || key.length === 0) invalid("A backup entry has no key.")
  if (!entityName(key)) invalid("A backup entry uses an unknown storage prefix.")
  if (key.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    invalid("A backup entry uses an invalid storage key.")
  }
}

function requireString(value: unknown, field: string): void {
  if (typeof value !== "string") invalid(`A backed-up entity is missing ${field}.`)
}

function requireFinite(value: unknown, field: string): void {
  if (!finite(value)) invalid(`A backed-up entity is missing ${field}.`)
}

function requireBoolean(value: unknown, field: string): void {
  if (typeof value !== "boolean") invalid(`A backed-up entity is missing ${field}.`)
}

/**
 * Validate exactly what the store's load path indexes and what doctor reads.
 * Older additive fields are preserved untouched; a row that cannot be loaded
 * or diagnosed is rejected before storage changes.
 */
function validateEntity(prefix: string, value: unknown): void {
  if (!isRecord(value)) invalid("A backed-up entity is not an object.")
  const name = entityName(prefix)
  switch (name) {
    case "agents":
      requireString(value.id, "id")
      requireString(value.name, "name")
      requireBoolean(value.archived, "archived")
      return
    case "workspaces":
      requireString(value.id, "id")
      requireString(value.name, "name")
      requireString(value.directory, "directory")
      requireString(value.leaderID, "leaderID")
      if (!Array.isArray(value.memberIDs) || value.memberIDs.some((member: unknown) => typeof member !== "string")) {
        invalid("A backed-up workspace has invalid members.")
      }
      requireBoolean(value.archived, "archived")
      requireBoolean(value.synthesis, "synthesis")
      requireBoolean(value.paused, "paused")
      requireFinite(value.nextSeq, "nextSeq")
      return
    case "messages":
      requireString(value.id, "id")
      requireString(value.workspaceID, "workspaceID")
      requireFinite(value.seq, "seq")
      requireFinite(value.createdAt, "createdAt")
      return
    case "subtasks":
      requireString(value.id, "id")
      requireString(value.workspaceID, "workspaceID")
      requireFinite(value.createdAt, "createdAt")
      return
    case "dispatchGroups":
      requireString(value.id, "id")
      requireString(value.workspaceID, "workspaceID")
      requireString(value.rootID, "rootID")
      requireFinite(value.maxHops, "maxHops")
      requireFinite(value.usedHops, "usedHops")
      requireFinite(value.depthMax, "depthMax")
      requireFinite(value.createdAt, "createdAt")
      return
    case "initJobs":
      requireString(value.id, "id")
      requireString(value.workspaceID, "workspaceID")
      requireString(value.messageID, "messageID")
      requireString(value.state, "state")
      requireFinite(value.startedAt, "startedAt")
      return
    case "nativeSubagents":
      requireString(value.childSessionID, "childSessionID")
      requireString(value.parentSessionID, "parentSessionID")
      requireString(value.state, "state")
      return
    case "bindings":
      requireString(value.workspaceID, "workspaceID")
      requireString(value.agentID, "agentID")
      requireString(value.sessionID, "sessionID")
      requireFinite(value.agentVersion, "agentVersion")
      return
    case "memories":
      requireString(value.id, "id")
      requireString(value.scope, "scope")
      requireString(value.text, "text")
      requireString(value.source, "source")
      requireFinite(value.createdAt, "createdAt")
      requireFinite(value.updatedAt, "updatedAt")
      if (!Array.isArray(value.history)) invalid("A backed-up memory has invalid history.")
      return
    case "approvals":
      requireString(value.id, "id")
      requireString(value.kind, "kind")
      requireString(value.title, "title")
      requireString(value.detail, "detail")
      requireString(value.status, "status")
      requireFinite(value.createdAt, "createdAt")
      return
    case "dmQueue":
      requireString(value.id, "id")
      requireString(value.agentID, "agentID")
      requireString(value.text, "text")
      requireString(value.status, "status")
      requireFinite(value.createdAt, "createdAt")
      return
    case "legacyDirect":
      requireString(value.id, "id")
      requireString(value.role, "role")
      requireString(value.author, "author")
      requireString(value.text, "text")
      requireFinite(value.createdAt, "createdAt")
      return
    default:
      invalid("A backup entry uses an unknown storage prefix.")
  }
}

function validateWorkspaceConfig(value: unknown): void {
  if (!isRecord(value)) invalid("A backed-up workspace config is not an object.")
  if (value.version !== CONFIG_VERSION) invalid("A backed-up workspace config uses an unsupported version.")
  if (typeof value.name !== "string" || !value.name.trim()) invalid("A backed-up workspace config has no name.")
  if (typeof value.leader !== "string" || !value.leader.trim()) invalid("A backed-up workspace config has no leader.")
  if (!Array.isArray(value.members) || value.members.some((member: unknown) => typeof member !== "string")) {
    invalid("A backed-up workspace config has invalid members.")
  }
}

/** Validate a document before any storage write; throws `BackupError`. */
export function validateBackup(input: unknown): EnsembleBackup {
  if (!isRecord(input)) invalid("The backup is not an object.")
  if (input.format !== BACKUP_FORMAT) invalid("The file is not an Ensemble backup.")
  if (input.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new BackupError("unsupported_backup", "The backup format version is not supported by this release.")
  }
  if (!finite(input.createdAt) || input.createdAt <= 0) invalid("The backup has no created time.")
  if (!finite(input.protocol) || input.protocol <= 0) invalid("The backup has no protocol version.")
  if (!finite(input.contractVersion) || input.contractVersion <= 0) invalid("The backup has no contract version.")
  if (typeof input.digest !== "string" || !isRecord(input.payload)) invalid("The backup has no payload digest.")
  const payload = normalizeJson(input.payload) as EnsembleBackup["payload"]
  if (!("meta" in payload)) invalid("The backup has no meta row.")
  if (payload.meta !== null) {
    if (!isRecord(payload.meta)) invalid("The backup meta row is not an object.")
    if (!finite(payload.meta.version) || payload.meta.version < 0) invalid("The backup meta row has no version.")
    if (!finite(payload.meta.updatedAt)) invalid("The backup meta row has no updated time.")
    if (!isRecord(payload.meta.settings) || !isRecord(payload.meta.ui)) invalid("The backup meta row has invalid settings.")
  }
  if (!Array.isArray(payload.entries)) invalid("The backup has no entries.")
  if (payload.entries.length > BACKUP_MAX_ENTRIES) invalid("The backup has too many entries.")
  const seen = new Set<string>()
  for (const entry of payload.entries) {
    if (!isRecord(entry)) invalid("The backup has an invalid entry.")
    validateKey(entry.key)
    if (seen.has(entry.key)) invalid("The backup repeats a storage key.")
    seen.add(entry.key)
    validateEntity(entry.key, entry.value)
  }
  if (payload.legacy !== undefined && !isRecord(payload.legacy)) invalid("The backup legacy state is not an object.")
  if (!Array.isArray(payload.workspaceConfigs)) invalid("The backup has no workspace config list.")
  const configWorkspaces = new Set<string>()
  for (const item of payload.workspaceConfigs) {
    if (!isRecord(item) || typeof item.workspaceID !== "string" || !item.workspaceID) {
      invalid("The backup has an invalid workspace config entry.")
    }
    if (configWorkspaces.has(item.workspaceID)) invalid("The backup repeats a workspace config.")
    configWorkspaces.add(item.workspaceID)
    if (item.config !== undefined) validateWorkspaceConfig(item.config)
    if (item.init !== undefined) {
      if (!isRecord(item.init)) invalid("A backed-up init record is not an object.")
      if (item.init.version !== undefined && !finite(item.init.version)) invalid("A backed-up init record has no version.")
      if (item.init.installedAt !== undefined && !finite(item.init.installedAt)) invalid("A backed-up init record has no installed time.")
    }
  }
  const counts = countEntries(payload.entries)
  if (!isRecord(input.counts)) invalid("The backup has no counts.")
  for (const [name, value] of Object.entries(counts)) {
    if (input.counts[name] !== value) invalid("The backup counts do not match its entries.")
  }
  const document = { ...(input as EnsembleBackup), payload }
  const digest = digestOf({
    format: document.format,
    formatVersion: document.formatVersion,
    createdAt: document.createdAt,
    protocol: document.protocol,
    contractVersion: document.contractVersion,
    payload: document.payload,
  })
  if (digest !== document.digest) {
    throw new BackupError("backup_corrupt", "The backup failed its integrity check.")
  }
  return document
}

/** Replace every durable prefix and the meta row with the document values. */
async function replaceStorage(storage: BackupStorage, input: {
  meta: BackupMeta | null
  entries: readonly BackupEntry[]
  legacy?: unknown
  now: number
  version: number
  updatedAt?: number
}): Promise<void> {
  for (const prefix of BACKUP_PREFIXES) {
    for (const entry of await scanAll(storage, prefix)) await storage.remove(entry.key)
  }
  for (const entry of input.entries) await storage.set(entry.key, entry.value)
  if (input.legacy === undefined) await storage.remove(LEGACY_KEY)
  else await storage.set(LEGACY_KEY, input.legacy)
  await storage.set(META_KEY, {
    version: input.version,
    updatedAt: input.updatedAt ?? input.now,
    settings: input.meta?.settings ?? {},
    ui: input.meta?.ui ?? {},
  })
}

type ConfigPlan = {
  workspace: Workspace
  config: WorkspaceConfig
}

function planWorkspaceConfigs(document: EnsembleBackup, entries: readonly BackupEntry[]): ConfigPlan[] {
  const agents = agentRows(entries)
  const captured = new Map(document.payload.workspaceConfigs.map((item) => [item.workspaceID, item.config]))
  const plans: ConfigPlan[] = []
  for (const workspace of workspaceRows(entries)) {
    if (workspace.archived) continue
    if (!directoryExists(workspace.directory)) continue
    const config = captured.get(workspace.id)
    plans.push({
      workspace,
      config: config ?? {
        version: CONFIG_VERSION,
        id: workspace.id,
        name: workspace.name,
        leader: agents[workspace.leaderID]?.name ?? workspace.leaderID,
        members: workspace.memberIDs.map((memberID) => agents[memberID]?.name ?? memberID),
        synthesis: workspace.synthesis,
        paused: workspace.paused,
      },
    })
  }
  return plans
}

/** Apply the planned configs; never throws for a missing directory. */
function applyWorkspaceConfigs(plans: readonly ConfigPlan[], written: string[]): { restored: number; skipped: number } {
  let restored = 0
  let skipped = 0
  for (const plan of plans) {
    if (!directoryExists(plan.workspace.directory)) {
      skipped += 1
      continue
    }
    writeWorkspaceConfigValue(plan.workspace.directory, plan.config)
    written.push(plan.workspace.directory)
    restored += 1
  }
  return { restored, skipped }
}

/** Remove configs for workspaces that the restored state no longer has. */
function removeStaleWorkspaceConfigs(prior: readonly ConfigCapture[], target: readonly ConfigPlan[]): number {
  const targetIDs = new Set(target.map((plan) => plan.workspace.id))
  const targetDirectories = new Set(target.map((plan) => plan.workspace.directory))
  let removed = 0
  for (const file of prior) {
    if (targetIDs.has(file.workspaceID)) continue
    if (targetDirectories.has(file.directory)) continue
    const current = readWorkspaceConfigID(file.directory)
    if (current !== file.workspaceID) continue
    try {
      unlinkSync(file.configPath)
      removed += 1
    } catch {}
  }
  return removed
}

function readWorkspaceConfigID(directory: string): string | undefined {
  try {
    const value = JSON.parse(readFileSync(workspaceConfigPath(directory), "utf8"))
    return isRecord(value) && typeof value.id === "string" ? value.id : undefined
  } catch {
    return undefined
  }
}

function restorePriorConfigs(prior: readonly ConfigCapture[], written: readonly string[]): void {
  const priorDirectories = new Set(prior.map((file) => file.directory))
  for (const directory of written) {
    if (priorDirectories.has(directory)) continue
    try {
      unlinkSync(workspaceConfigPath(directory))
    } catch {}
  }
  for (const file of prior) {
    try {
      if (file.text === undefined) unlinkSync(file.configPath)
      else writeFileSync(file.configPath, file.text)
    } catch {}
  }
}

async function applyValidated(
  storage: BackupStorage,
  document: EnsembleBackup,
  options: BackupApplyOptions,
): Promise<BackupApplyReport> {
  const now = options.now ?? Date.now()
  const prior = await capture(storage, now)
  const priorConfigs = captureWorkspaceConfigs(prior.entries)
  const version = Math.max(document.payload.meta?.version ?? 0, options.versionFloor ?? 0) + 1

  if (options.rollbackSlot !== false) {
    const slot = buildDocument({
      meta: prior.meta,
      entries: prior.entries,
      workspaceConfigs: priorConfigs.backups,
      legacy: prior.legacy,
      createdAt: now,
      protocol: options.protocol,
      contractVersion: options.contractVersion,
    })
    await storage.set(BACKUP_ROLLBACK_KEY, slot)
  }

  const plans = planWorkspaceConfigs(document, document.payload.entries)
  const targetIDs = new Set(plans.map((plan) => plan.workspace.id))
  const entries = document.payload.entries.map((entry) => {
    const name = entityName(entry.key)
    const value = entry.value
    if (name !== "workspaces" || !isRecord(value) || typeof value.id !== "string") return entry
    if (!targetIDs.has(value.id)) return entry
    const plan = plans.find((item) => item.workspace.id === value.id)
    if (!plan) return entry
    return { key: entry.key, value: { ...value, configVersion: plan.config.version } }
  })

  const written: string[] = []
  try {
    await replaceStorage(storage, { meta: document.payload.meta, entries, legacy: document.payload.legacy, now, version })
    const applied = applyWorkspaceConfigs(plans, written)
    const removed = removeStaleWorkspaceConfigs(priorConfigs.files, plans)
    return {
      formatVersion: document.formatVersion,
      createdAt: document.createdAt,
      version,
      counts: countEntries(entries),
      workspaces: { restored: applied.restored, skipped: applied.skipped, removed },
      rollbackSlot: { written: options.rollbackSlot !== false },
    }
  } catch {
    let recovered = false
    try {
      await replaceStorage(storage, {
        meta: prior.meta,
        entries: prior.entries,
        legacy: prior.legacy,
        now,
        // The automatic recovery restores the previous content exactly; no
        // client observed the failed attempt, so its version is still valid.
        version: prior.meta?.version ?? 0,
        updatedAt: prior.meta?.updatedAt ?? now,
      })
      restorePriorConfigs(priorConfigs.files, written)
      recovered = true
    } catch {}
    if (recovered) {
      throw new BackupError("restore_failed_rolled_back", "The restore failed; the previous state was recovered. Check the backup and retry.")
    }
    throw new BackupError("restore_failed", "The restore failed and the automatic rollback also failed. Apply the rollback slot or restore the previous release.")
  }
}

/** Restore a validated document and report what was written. */
export async function applyBackup(
  storage: BackupStorage,
  input: unknown,
  options: BackupApplyOptions,
): Promise<BackupApplyReport> {
  return applyValidated(storage, validateBackup(input), options)
}

/** Re-apply the pre-restore slot. A failed rollback keeps the slot intact. */
export async function rollbackBackup(storage: BackupStorage, options: BackupApplyOptions): Promise<BackupApplyReport> {
  let raw: unknown
  try {
    raw = await storage.get(BACKUP_ROLLBACK_KEY)
  } catch {
    throw new BackupError("no_rollback", "No rollback slot could be read.")
  }
  if (raw === undefined || raw === null) throw new BackupError("no_rollback", "No rollback slot is stored.")
  return applyValidated(storage, validateBackup(raw), { ...options, rollbackSlot: false })
}

/** Read-only slot status for the operator CLI and support reads. */
export async function readRollbackStatus(storage: BackupStorage): Promise<BackupSlotStatus> {
  let raw: unknown
  try {
    raw = await storage.get(BACKUP_ROLLBACK_KEY)
  } catch {
    return { present: false }
  }
  if (raw === undefined || raw === null) return { present: false }
  try {
    const document = validateBackup(raw)
    return {
      present: true,
      valid: true,
      formatVersion: document.formatVersion,
      createdAt: document.createdAt,
      version: document.payload.meta?.version ?? 0,
      counts: document.counts,
    }
  } catch (error: any) {
    return { present: true, valid: false, reason: error?.code ?? "invalid_backup" }
  }
}
