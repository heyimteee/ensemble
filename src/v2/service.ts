import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import { canonicalDirectory, workspaceFileReferences } from "./paths.ts"
import { ensureEnsembleDirectory, handoffDirectory, readWorkspaceConfig, writeAgentsBlock, writeInitMetadata, writeWorkspaceConfig, workspaceConfigPath } from "./workspace-config.ts"
import { ENSEMBLE_BLOCK_VERSION, ensembleBlock, initInstructions, onboardingPrompt } from "./init-block.ts"
import { INIT_COMMAND, INIT_START_TEXT, SYSTEM_AGENT_NAME, initCancelReport, initComposerIssue, initFailureReport, initInterruptedReport, initPhaseText, initSuccessReport } from "./system-agent.ts"
import { Catalog } from "./catalog.ts"
import { anyToolCall, assistantResult, availabilityFailure, contextForTask, isFallbackReply, promptForTask, REPLY_INTERRUPTED, skillPermissions } from "./execution.ts"
import { normalizeAgentMentions, parseMentions, unknownMentions, visibleRecipients } from "./routing.ts"
import { DEADLINE_MS, FINISHED_RETENTION_MS, HEARTBEAT_MS, LEASE_MS, MAX_ATTEMPTS, claimWon, correlationIDForKey, deriveWorkStatus, parseWorkKind, stableHash, workKey } from "./queue.ts"
import { inheritDispatchGroupID, newDispatchGroupID, resolveDispatchGroupID } from "./dispatch-group.ts"
import { archivedMentionRefs, bareMentionToken, outsideMentionRefs, peerRefusalText } from "./peer-turn.ts"
import { COMPLETION_CHAIN_MAX, COMPLETION_QUIET_WINDOW_MS, HANDOFF_MAX_DEPTH, HANDOFF_MAX_PER_RUN, batchAllDecided, batchReviewText, batchReviewTitle, checkCompletionRoute, completionClosedText, completionReviewInstruction, completionWorkKey, groupCompletionCandidates, handoffDuplicateText, handoffFailureText, handoffGroupAckText, handoffWorkKey, newCorrelationID, parseHandoffFile, parseReviewDecisions, resolveHandoffRecipient, type ReviewDecision } from "./handoff.ts"
import { mapNativeChat, mergeDmTranscript } from "./dm.ts"
import { registerLiveSlot, type LiveSlot } from "./live-slot.ts"
import { nextRetryAttempt, retryDelayMs } from "./retry.ts"
import { planSkillInvocation, directSkillIssue, skillWorkTitle } from "./skill-invocation.ts"
import { projectVisibleWork, tier3Gate, transcriptWindow as deriveTranscriptWindow, workspaceCounts } from "./scoped-read.ts"
import { V2Store, bindingKey, cloneDebugEnabled, cloneStats, streamKey } from "./store.ts"
import { STREAM_COALESCE_MS } from "./stream-coalescer.ts"
import { createLogger, setGlobalLogger, type EnsembleLogger, type LogEntry } from "./logging.ts"
import { createStoreObserver } from "./log-events.ts"
import { buildFailureRecord, classifyFailure, type FailureClass, type FailureDecision, type ToolOutcome } from "./failure-record.ts"
import type {
  Agent,
  Approval,
  ChangesSince,
  DmQueueEntry,
  FeedMeta,
  InitJob,
  InitPhase,
  Memory,
  MemoryScope,
  Message,
  MessageStream,
  ModelRef,
  PatchBatch,
  Revision,
  ScopeName,
  ScopedResync,
  Settings,
  Snapshot,
  Run,
  SessionBinding,
  SnapshotState,
  Subtask,
  Tier3Gate,
  WorkKind,
  Workspace,
} from "./types.ts"

type Ctx = any
type Json = Record<string, any>

/**
 * Protocol version advertised by the snapshot and the revision heartbeat.
 * v2 adds the versioned full-entity patch feed (`patches` + `changes.since`).
 * v3 adds shell entities and version-neutral catalog/config metadata (#140).
 * v4 adds the gated Tier 3 scoped reads: bootstrap, Work projection,
 * transcript windows, on-demand messages, and per-scope gap resync (#141).
 */
export const ENSEMBLE_PROTOCOL_VERSION = 4
let bootEpochSeq = 0

function invalidInput(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "invalid_input" })
}

/** Per-run evidence carried into failure records (ticket #145). */
type TaskFailureContext = {
  runID?: string
  sessionID?: string
  providerID?: string
  modelID?: string
  variant?: string
  startedAt?: number
  toolOutcomes?: ToolOutcome[]
  cause?: unknown
}

type RpcInput = {
  directory: string
  action?: string
  payload?: Json
  epoch?: number
  version?: number
  workspaceID?: string
  beforeSeq?: number
  limit?: number
  messageID?: string
  scopes?: string[]
  level?: string
  cat?: string
  event?: string
  taskID?: string
}

function rpcInput(value: unknown): RpcInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput("RPC input must be an object.")
  const input = value as Record<string, unknown>
  if (typeof input.directory !== "string" || input.directory.length === 0) throw invalidInput("directory must be a non-empty string.")
  if (input.action !== undefined && typeof input.action !== "string") throw invalidInput("action must be a string.")
  if (input.payload !== undefined && (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload))) {
    throw invalidInput("payload must be an object.")
  }
  if (input.epoch !== undefined && typeof input.epoch !== "number") throw invalidInput("epoch must be a number.")
  if (input.version !== undefined && typeof input.version !== "number") throw invalidInput("version must be a number.")
  if (input.workspaceID !== undefined && typeof input.workspaceID !== "string") throw invalidInput("workspaceID must be a string.")
  if (input.messageID !== undefined && typeof input.messageID !== "string") throw invalidInput("messageID must be a string.")
  if (input.beforeSeq !== undefined && typeof input.beforeSeq !== "number") throw invalidInput("beforeSeq must be a number.")
  if (input.limit !== undefined && typeof input.limit !== "number") throw invalidInput("limit must be a number.")
  if (input.scopes !== undefined && !Array.isArray(input.scopes)) throw invalidInput("scopes must be a list.")
  for (const field of ["level", "cat", "event", "taskID"] as const) {
    if (input[field] !== undefined && typeof input[field] !== "string") throw invalidInput(`${field} must be a string.`)
  }
  return {
    directory: input.directory,
    action: input.action as string | undefined,
    payload: input.payload as Json | undefined,
    epoch: input.epoch as number | undefined,
    version: input.version as number | undefined,
    workspaceID: input.workspaceID as string | undefined,
    beforeSeq: input.beforeSeq as number | undefined,
    limit: input.limit as number | undefined,
    messageID: input.messageID as string | undefined,
    scopes: input.scopes as string[] | undefined,
    level: input.level as string | undefined,
    cat: input.cat as string | undefined,
    event: input.event as string | undefined,
    taskID: input.taskID as string | undefined,
  }
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw invalidInput(`${field} must be a list of strings.`)
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== "string") throw invalidInput(`${field} must be a list of strings.`)
    items.push(item)
  }
  return [...new Set(items)]
}

function errorResult(error: any): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code: error?.code ?? "error", message: error?.message ?? String(error) } }
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`
}

function now(): number {
  return Date.now()
}

/**
 * Ticket #134: maintenance is timer-driven and serialized, never a snapshot
 * side effect. Config discovery is additionally throttled because it reads
 * each workspace's `.ensemble/config.json` from disk.
 */
const MAINTENANCE_INTERVAL_MS = 1_000
const CONFIG_DISCOVERY_MS = 1_000
/** Live-text crash checkpoints; no coordination version or patch is written. */
const STREAM_CHECKPOINT_MS = 250

function unwrap<T>(value: any): T {
  return (value && typeof value === "object" && "data" in value ? value.data : value) as T
}

function listData(value: any): any[] {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.data)) return value.data
  return []
}

function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function sameModel(a: ModelRef, b: ModelRef): boolean {
  return a.providerID === b.providerID && a.modelID === b.modelID && (a.variant ?? "") === (b.variant ?? "")
}

function sameModels(a: ModelRef[], b: ModelRef[]): boolean {
  return a.length === b.length && a.every((model, index) => sameModel(model, b[index]))
}

/**
 * Record one init stage without duplicating consecutive entries or dropping
 * history. `phases` is the single stored source: the current stage is read
 * from its last entry, never written as a mirror field. A pre-#118 job that
 * only carries `phase` is migrated into the history on its first advance.
 */
function recordInitPhase(job: InitJob, phase: InitPhase): void {
  const existing = job.phases ?? []
  const legacy = (job as { phase?: InitPhase }).phase
  const phases = existing.length > 0 ? [...existing] : legacy ? [legacy] : []
  if (phases[phases.length - 1] !== phase) phases.push(phase)
  job.phases = phases
}

/**
 * Settle a streaming transcript row: clear the live flag, record the final
 * text, and stamp the last write so staleness runs on heartbeat time.
 * Ticket #74: finalization races must settle through this helper even when
 * the epoch guard rejects the content update — otherwise the stored row
 * keeps `streaming: true` and wedges the activity line until the age
 * filter. Pure over the caller's message object.
 */
export function settleStreamMessage(message: Message, text: string, interrupted: boolean): Message {
  message.text = text
  message.streaming = false
  message.interrupted = interrupted
  message.updatedAt = now()
  return message
}

/**
 * Newest still-open task assigned to the sender in the workspace, if any.
 * Ticket #70 parentless-hop anchor: a handoff issued from a session with
 * no live run parents its hop here so the sender's turn stays in
 * `awaitingChildren` until the hop is delivered/answered. Pure.
 */
export function newestOpenSenderTaskID(state: SnapshotState, workspaceID: string, senderID: string): string | undefined {
  const open = Object.values(state.subtasks).filter(
    (task) =>
      task.workspaceID === workspaceID &&
      task.assigneeID === senderID &&
      task.state !== "replied" &&
      // Completion deliveries are inbound work, not the sender's own turn:
      // anchoring a new hop to one would apply the wrong depth and can refuse
      // a legitimate parentless handoff.
      task.handoff?.completion !== true,
  )
  open.sort((a, b) => b.createdAt - a.createdAt)
  return open[0]?.id
}

export class EnsembleV2Service {
  readonly ctx: Ctx
  private store!: V2Store
  private readonly registrations = new Set<any>()
  private retryRegistration: any
  private stopped = false
  private pumping = false
  private repump = false
  private maintaining = false
  private maintenanceQueued = false
  private maintenanceRun: Promise<void> | undefined
  private maintenanceTimer: ReturnType<typeof setInterval> | undefined
  private maintenanceWaiters: Array<() => void> = []
  private viewDirectory: string | undefined
  private configDirty = true
  private lastConfigPassAt = 0
  private readonly running = new Set<Promise<void>>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly runBySession = new Map<string, string>()
  private readonly activeRuns = new Map<string, Run>()
  private readonly directBusy = new Set<string>()
  /** Last identity text version written per native session (chat polls must not rewrite it). */
  private readonly identityVersions = new Map<string, number>()
  private readonly homeBindingPromises = new Map<string, Promise<{ sessionID: string; directory: string }>>()
  private readonly bindingPromises = new Map<string, Promise<{ sessionID: string } | undefined>>()
  private readonly workspaceEpoch = new Map<string, number>()
  private lastDmAt = 0
  private dmNow(): number {
    this.lastDmAt = Math.max(now(), this.lastDmAt + 1)
    return this.lastDmAt
  }
  /**
   * The DM clock is in-memory only, so it must be re-seeded from the maximum
   * stored DM `createdAt` whenever transcripts (re)load. Otherwise a restart
   * could mint a `createdAt` that ties with a stored row and fall back to id
   * order. The clock never moves backwards: pruning only removes rows.
   */
  private refreshDmClock(): void {
    this.lastDmAt = Math.max(this.lastDmAt, this.store.dmMaxCreatedAt())
  }
  private readonly liveBySession = new Map<string, LiveSlot>()
  /** Coalesced ephemeral live text, keyed by workspace + message id. */
  private readonly pendingStreams = new Map<string, MessageStream>()
  private streamTimer: ReturnType<typeof setTimeout> | undefined
  private readonly initRuns = new Map<string, { jobID: string; sessionID?: string; cancelled: boolean; promise: Promise<void> }>()
  private globalEpoch = 0
  /**
   * Boot identity for the versioned feed. The sub-millisecond counter keeps
   * two in-process restarts distinct even when `Date.now()` ties.
   */
  private epochValue = Date.now() * 1000 + (bootEpochSeq++ % 1000)
  private lastConfigError: string | undefined
  private readonly catalog: Catalog
  private catalogAbort: AbortController | undefined
  /** Last catalog/config metadata published as a version-neutral batch. */
  private lastPublishedCatalogRevision = -1
  private lastPublishedConfig: { directory?: string; revision?: number; error?: string } = {}
  private lastLoggedCatalogError: string | undefined
  /** Ticket #141 Tier 3 gate inputs, measured only at the snapshot boundary. */
  private lastSnapshotBytes: number | undefined
  private lastSnapshotMs: number | undefined
  /** Ticket #145: operational logger; owns the service log files. */
  private logger: EnsembleLogger | undefined
  private startedAtMs = now()

  constructor(ctx: Ctx) {
    this.ctx = ctx
    this.catalog = new Catalog(ctx, () => {
      this.publishFeedMetaIfChanged()
    })
  }

  async start(): Promise<() => Promise<void>> {
    this.startedAtMs = now()
    this.logger = createLogger({ role: "service" })
    setGlobalLogger(this.logger)
    this.logger.event("info", "service", "service.start", {
      protocol: ENSEMBLE_PROTOCOL_VERSION,
      directory: process.cwd(),
      epoch: this.epochValue,
      pid: process.pid,
      logFiles: this.logger.stats(),
    })
    this.store = new V2Store(this.ctx, (version) => {
      this.emitChanged(version)
    }, {
      epoch: this.epochValue,
      onPatch: (batch) => this.emitPatches(this.withReadMeta(batch)),
      observer: createStoreObserver(this.logger),
    })
    await this.store.load()
    this.refreshDmClock()
    await this.reconcileInitJobs()
    // Ticket #148: restart recovery is lease-safe. Load leaves `working` rows
    // untouched; reapAndRetire() requeues only an expired/missing lease with
    // no live local run, and reconcileWaitingWork() repairs a working row
    // with no claim at all. Attempts are preserved until the next claim and
    // no approval is ever synthesized for dead work.
    this.retryRegistration = await this.ctx.session.hook("retry", (event: any) => {
      if (!this.profileForSession(event.sessionID)) return
      if (availabilityFailure(event.error)) event.decision = { retry: false }
    })
    await this.installTools()
    await this.migrateV1()
    void this.catalog.refresh()
    this.catalogAbort = new AbortController()
    void (async () => {
      try {
        for await (const event of this.ctx.event.subscribe({ types: ["skill.updated", "model.updated", "provider.updated"], signal: this.catalogAbort!.signal })) {
          if (event.type) void this.catalog.refresh()
        }
      } catch {}
    })()
    void (async () => {
      try {
        for await (const event of this.ctx.event.subscribe({ types: ["session.text.delta", "session.idle"], signal: this.catalogAbort!.signal })) {
          await this.handleStreamEvent(event as any)
        }
      } catch {}
    })()
    // Native permission mirror (ticket #68): project `permission.asked`
    // blocks on Ensemble-bound sessions into `native` approvals and resolve
    // `permission.replied` outcomes locally. User resolution replies on the
    // host so the run is genuinely gated. Unknown sessions fail open.
    void (async () => {
      try {
        for await (const event of this.ctx.event.subscribe({ types: ["permission.asked", "permission.replied"], signal: this.catalogAbort!.signal })) {
          await this.handlePermissionEvent(event as any)
        }
      } catch {}
    })()
    // Ticket #134: react to host-exposed config changes instead of polling
    // `.ensemble/config.json` on every read. `config.updated` covers host
    // config; `file.edited` covers a direct edit of the workspace config.
    void (async () => {
      try {
        for await (const event of this.ctx.event.subscribe({ types: ["config.updated", "file.edited"], signal: this.catalogAbort!.signal })) {
          if (!this.isConfigEvent(event as any)) continue
          this.configDirty = true
          void this.maintain()
        }
      } catch {}
    })()
    await this.maintain()
    this.maintenanceTimer = setInterval(() => {
      // Repairs are not enough: a repaired claim or a due retry must be
      // claimed without waiting for an unrelated user action. The pump guard
      // coalesces this with an in-flight pass.
      void this.maintain().then(() => this.pump(false)).catch(() => undefined)
    }, MAINTENANCE_INTERVAL_MS)
    if (typeof (this.maintenanceTimer as unknown as { unref?: () => void }).unref === "function") {
      ;(this.maintenanceTimer as unknown as { unref: () => void }).unref()
    }
    this.pump(false)
    return async () => {
      this.stopped = true
      // Capture owned run ids before waiting: each run's finally releases its
      // own claim, and any claim still held by these ids after settle is a
      // clean-shutdown release. Foreign claims must survive.
      const localRunIDs = new Set(this.activeRuns.keys())
      this.catalogAbort?.abort()
      if (this.maintenanceTimer) clearInterval(this.maintenanceTimer)
      this.maintenanceTimer = undefined
      if (this.streamTimer) clearTimeout(this.streamTimer)
      this.streamTimer = undefined
      this.pendingStreams.clear()
      for (const timer of this.timers) clearTimeout(timer)
      this.timers.clear()
      await this.maintenanceRun?.catch(() => undefined)
      await this.retryRegistration?.dispose?.().catch(() => undefined)
      await Promise.allSettled([...this.running])
      await this.releaseLocalClaims(localRunIDs).catch(() => undefined)
      this.logger?.event("info", "service", "service.stop", {
        uptimeMs: now() - this.startedAtMs,
        activeRuns: this.activeRuns.size,
        pendingWork: Object.values(this.store.subtasks()).filter((task) => task.state === "pending").length,
      })
      await this.logger?.close().catch(() => undefined)
      setGlobalLogger(undefined)
      this.logger = undefined
    }
  }

  handlers(): {
    snapshot: (input: unknown) => Promise<Snapshot>
    bootstrap: (input: unknown) => Promise<Snapshot>
    revision: (input: unknown) => Promise<Revision>
    "changes.since": (input: unknown) => Promise<ChangesSince>
    "work.project": (input: unknown) => Promise<any>
    "transcript.window": (input: unknown) => Promise<any>
    "message.get": (input: unknown) => Promise<any>
    "logs.recent": (input: unknown) => Promise<any>
    resync: (input: unknown) => Promise<ScopedResync>
    diagnostic: (input: unknown) => Promise<{ state: SnapshotState; directory: string; logs?: unknown }>
    invoke: (input: unknown) => Promise<{ ok: boolean; result?: any; error?: { code: string; message: string } }>
  } {
    return {
      snapshot: async (input) => this.snapshot(rpcInput(input).directory),
      bootstrap: async (input) => {
        const request = rpcInput(input)
        return this.bootstrap(request.directory, request.workspaceID)
      },
      revision: async (input) => this.revision(rpcInput(input).directory),
      "changes.since": async (input) => this.changesSince(rpcInput(input)),
      "work.project": async (input) => this.workProject(rpcInput(input).directory),
      "transcript.window": async (input) => {
        const request = rpcInput(input)
        return this.transcriptWindow(request.directory, request.workspaceID, request.beforeSeq, request.limit)
      },
      "message.get": async (input) => {
        const request = rpcInput(input)
        return this.messageGet(request.directory, request.workspaceID, request.messageID)
      },
      "logs.recent": async (input) => this.logsRecent(rpcInput(input)),
      resync: async (input) => {
        const request = rpcInput(input)
        return this.resync(request.directory, request.workspaceID, request.scopes)
      },
      diagnostic: async (input) => this.diagnostic(rpcInput(input).directory),
      invoke: async (input) => {
        try {
          const request = rpcInput(input)
          if (!request.action) throw invalidInput("action is required.")
          return await this.invoke(request.directory, request.action, request.payload ?? {})
        } catch (error: any) {
          this.logger?.event("error", "service", "service.rpc.error", {
            method: "invoke",
            action: input && typeof input === "object" ? (input as any).action : undefined,
            error,
          })
          return errorResult(error)
        }
      },
    }
  }

  attach(registration: any): void {
    if (registration) this.registrations.add(registration)
  }

  detach(registration: any): void {
    if (registration) this.registrations.delete(registration)
  }

  private emitChanged(
    version: number,
    scope?: { workspaceID?: string; subtaskID?: string; correlationID?: string; kind?: string },
  ): void {
    for (const registration of this.registrations) {
      void registration?.events?.emit?.("changed", { version, ...scope })?.catch?.(() => undefined)
    }
  }

  /** Batched durable patches for clients that negotiated protocol v2. */
  private emitPatches(batch: PatchBatch): void {
    this.logger?.event("debug", "feed", "feed.batch", {
      epoch: batch.epoch,
      from: batch.from,
      version: batch.version,
      entries: batch.entries.length,
      reset: batch.reset === true,
      meta: batch.meta !== undefined,
    })
    for (const registration of this.registrations) {
      void registration?.events?.emit?.("patches", batch)?.catch?.(() => undefined)
    }
  }

  /**
   * Ticket #141: per-scope versions ride beside every patch so a later gap can
   * name the scopes that actually moved. Unread/busy counts are derived on the
   * revision heartbeat, bootstrap, and scoped resync instead of on every
   * patch: a 5k-task burst must stay linear, not scan the whole store per
   * entity write.
   */
  private withReadMeta(batch: PatchBatch): PatchBatch {
    return {
      ...batch,
      scopeVersions: this.store.scopeVersions(),
    }
  }

  /** Server-derived unread/busy counts for the durable store. */
  private counts(): Record<string, { unread: number; busy: number }> {
    return workspaceCounts(this.store.read())
  }

  /**
   * Queue accumulated live text for one row. The window collapses a delta
   * burst into one event with the full current text, so duplicate/reordered
   * delivery inside the window is harmless and the event is idempotent. This
   * path never advances the coordination version or enters the change ring.
   */
  private queueStream(message: Message): void {
    this.pendingStreams.set(streamKey(message.workspaceID, message.id), {
      epoch: this.epochValue,
      workspaceID: message.workspaceID,
      id: message.id,
      text: message.text,
      updatedAt: message.updatedAt ?? now(),
    })
    if (this.streamTimer !== undefined) return
    this.streamTimer = setTimeout(() => {
      this.streamTimer = undefined
      this.flushStreams()
    }, STREAM_COALESCE_MS)
    this.streamTimer.unref?.()
  }

  private flushStreams(): void {
    if (this.pendingStreams.size === 0) return
    const updates = [...this.pendingStreams.values()]
    this.pendingStreams.clear()
    for (const update of updates) {
      for (const registration of this.registrations) {
        void registration?.events?.emit?.("stream", update)?.catch?.(() => undefined)
      }
    }
  }

  private dropStream(message: Message): void {
    this.pendingStreams.delete(streamKey(message.workspaceID, message.id))
  }

  /**
   * Catalog/model-skill and config-error metadata do not change entity state,
   * so they travel beside the versioned feed and never bump the coordination
   * version. The same metadata is attached to every `changes.since` response,
   * so a missed metadata event recovers through the heartbeat.
   */
  private feedMeta(): FeedMeta {
    const directory = this.viewDirectory
    const configRevision = directory && this.store
      ? this.configFingerprint(directory, this.store.revisionInfo().workspaceDirectories)
      : undefined
    return {
      catalogRevision: this.catalog.revision,
      models: this.catalog.modelOptions,
      skills: this.catalog.skillOptions,
      ...(this.catalog.lastError ? { modelsError: this.catalog.lastError } : {}),
      ...(directory && configRevision !== undefined ? { directory, configRevision } : {}),
      ...(this.lastConfigError ? { configError: this.lastConfigError } : {}),
    }
  }

  /** Publish a revision-only batch when catalog or config metadata changed. */
  private publishFeedMetaIfChanged(): void {
    if (!this.store) return
    const directory = this.viewDirectory
    const revision = directory ? this.configFingerprint(directory, this.store.revisionInfo().workspaceDirectories) : undefined
    const error = this.lastConfigError
    const catalogChanged = this.catalog.revision !== this.lastPublishedCatalogRevision
    const configChanged = this.lastPublishedConfig.directory !== directory
      || this.lastPublishedConfig.revision !== revision
      || this.lastPublishedConfig.error !== error
    const catalogError = this.catalog.lastError
    if (catalogError !== this.lastLoggedCatalogError) {
      if (catalogError) this.logger?.event("error", "service", "service.catalog.error", { error: catalogError })
      else this.lastLoggedCatalogError && this.logger?.event("info", "service", "service.catalog.recovered", {})
      this.lastLoggedCatalogError = catalogError
    }
    if (!catalogChanged && !configChanged) return
    this.lastPublishedCatalogRevision = this.catalog.revision
    this.lastPublishedConfig = { directory, revision, error }
    // Use the last fully published version: a metadata event must never
    // advance the cursor past an entity patch that is still mid-write.
    const version = this.store.publishedVersion()
    this.emitPatches({
      epoch: this.epochValue,
      from: version,
      version,
      entries: [],
      meta: this.feedMeta(),
    })
    // Legacy clients still get the metadata-change notification; the
    // heartbeat's catalog/config revision check remains their fallback.
    this.emitChanged(version)
  }

  /**
   * Cursor recovery for a client that missed a `patches` event. Foreign writes
   * are hydrated first so the ring can answer honestly (a foreign version is a
   * reset, never a fabricated patch); the read path itself writes nothing.
   */
  private async changesSince(input: { directory: string; epoch?: number; version?: number }): Promise<ChangesSince> {
    await this.store.sync().catch(() => false)
    // The host RPC output validator rejects explicit undefined values in a
    // full-entity patch (for example a message's absent agentID). Strip them
    // at this boundary exactly as snapshot/bootstrap do; otherwise a gap
    // recovery request fails with a 500 and falls back to a full snapshot.
    const result = this.store.changesSince(input.epoch ?? -1, input.version ?? -1)
    if (result.reset) {
      this.logger?.event("warn", "feed", "feed.reset", {
        requestedEpoch: input.epoch,
        requestedVersion: input.version,
        epoch: result.epoch,
        version: result.version,
      })
    }
    this.logger?.event("debug", "feed", "feed.changes", {
      requestedVersion: input.version,
      version: result.version,
      entries: result.entries.length,
      reset: result.reset === true,
    })
    return jsonSafe({
      ...result,
      meta: this.feedMeta(),
      scopeVersions: this.store.scopeVersions(),
      counts: this.counts(),
    })
  }

  /**
   * Scoped change notification for work-lifecycle transitions. The TUI
   * subscribes to the `changed` event and refreshes; the payload carries the
   * affected scope (workspace, subtask, correlation, kind) so the UI can tell
   * a work transition apart from an unrelated write. The 250ms snapshot poll
   * remains as a fallback.
   */
  private noteWorkChanged(task: Subtask): void {
    // Ticket #138: publish the durable task patch before any pump starts, so a
    // handoff/delegation card never waits for a full snapshot or for a claim.
    this.store.publishPending()
    this.emitChanged(this.store.version(), {
      workspaceID: task.workspaceID,
      subtaskID: task.id,
      correlationID: task.handoff?.correlationID ?? task.turn?.correlationID,
      kind: task.workKind,
    })
  }

  private async migrateV1(): Promise<void> {
    const old = await this.ctx.storage.get("ensemble.state").catch(() => undefined)
    if (!old || typeof old !== "object" || !old.agents) return
    for (const legacy of Object.values(old.agents as Record<string, any>)) {
      if (!legacy?.id || !legacy?.name) continue
      if (this.store.agent(legacy.id)) continue
      const model = legacy.mainModel ?? { providerID: "opencode", modelID: "unknown" }
      const agent: Agent = {
        id: legacy.id,
        name: legacy.name,
        title: "",
        role: String(legacy.instructions ?? ""),
        mainModel: { providerID: model.providerID, modelID: model.modelID ?? model.id ?? "unknown", variant: model.variant },
        backupModels: Array.isArray(legacy.backupModels) ? legacy.backupModels : [],
        skillbox: Array.isArray(legacy.skillbox) ? legacy.skillbox : [],
        color: "cyan",
        archived: Boolean(legacy.archived),
        pendingSettings: false,
        version: Number(legacy.version ?? 1),
        createdAt: Number(legacy.createdAt ?? now()),
        updatedAt: now(),
      }
      await this.store.saveAgent(agent)
    }
  }

  /**
   * Mirror of the host permission lifecycle for Ensemble-bound sessions.
   *
   * Supported plugin API surface (verified against installed
   * `@opencode/plugin@2.2.1` + `@opencode/client` promise types):
   * - events `permission.asked` (`data`: `sessionID`, `id`, `action`,
   *   `resources`, `source?`, `message?`) and `permission.replied` (`data`:
   *   `sessionID`, `requestID`, `reply: once|always|reject`) via
   *   `ctx.event.subscribe({ types: [...] })`;
   * - `ctx.permission.reply({ sessionID, requestID, decision, message? })`
   *   with `decision: once|always|reject` (PermissionReplyInput). The user
   *   resolve path always offers `once` (least privilege) or `reject`.
   * `ctx.permission.list/get` exist but are not needed: the mirror is purely
   * event-driven, so a restart never resurrects an already-answered host
   * request as a phantom approval.
   */
  private async handlePermissionEvent(event: any): Promise<void> {
    const data = event?.data ?? event
    if (event?.type === "permission.asked") {
      const sessionID = String(data?.sessionID ?? "")
      const permissionID = String(data?.id ?? "")
      const action = String(data?.action ?? "permission")
      if (!sessionID || !permissionID) return
      const owner = this.ownerForSession(sessionID)
      if (!owner) return
      const state = this.store.read()
      const duplicate = Object.values(state.approvals).some(
        (approval) => approval.status === "pending" && approval.kind === "native" && approval.payload?.permissionID === permissionID,
      )
      if (duplicate) return
      const resources = Array.isArray(data?.resources) ? data.resources.map(String) : []
      const approval: Approval = {
        id: id("approval"),
        workspaceID: owner.workspaceID,
        subtaskID: owner.subtaskID,
        agentID: owner.agentID,
        kind: "native",
        source: "native",
        title: `Native permission: ${action}`,
        detail: resources.length > 0 ? `${action} ${resources.join(" ")}`.slice(0, 280) : String(data?.message ?? action),
        payload: { permissionID, sessionID, action, resources },
        status: "pending",
        createdAt: now(),
      }
      await this.store.saveApproval(approval)
      const workspace = owner.workspaceID ? state.workspaces[owner.workspaceID] : undefined
      // Native approvals deliberately do NOT set subtask.approvalID: the host
      // already blocks the live session, and pump gating below holds future
      // runs. The row is the inbox mirror plus the host-reply path.
      if (workspace) await this.appendMessage(workspace, { author: "system", text: `Native permission needs a decision: ${action}`, kind: "approval", taskID: owner.subtaskID })
      return
    }
    if (event?.type === "permission.replied") {
      const requestID = String(data?.requestID ?? "")
      if (!requestID) return
      const found = this.store.approvals().find(
        (item) => item.status === "pending" && item.kind === "native" && item.payload?.permissionID === requestID,
      )
      if (!found) return
      const approval = this.store.cloneApproval(found.id)
      if (!approval) return
      const reply = String(data?.reply ?? "")
      approval.status = reply === "reject" ? "rejected" : "approved"
      approval.resolvedAt = now()
      approval.resolution = `Host permission ${reply}.`
      await this.store.saveApproval(approval)
      this.schedule()
    }
  }

  /**
   * Resolve the Ensemble owner of a native session: the live run first,
   * then any stored binding (current or historical). Unknown sessions fail
   * open — no approval is minted for sessions Ensemble does not own.
   */
  private ownerForSession(sessionID: string): { workspaceID?: string; agentID?: string; subtaskID?: string } | undefined {
    const run = this.runForSession(this.store.read(), sessionID)
    if (run) return { workspaceID: run.workspaceID, agentID: run.agentID, subtaskID: run.subtaskID }
    const binding = this.store.bindingForSession(sessionID)
    if (!binding) return undefined
    return { workspaceID: binding.workspaceID, agentID: binding.agentID }
  }

  /** True while the host waits on a user decision for this session. */
  private pendingNativeForSession(sessionID: string): boolean {
    return this.store.approvals().some(
      (approval) => approval.status === "pending" && approval.kind === "native" && approval.payload?.sessionID === sessionID,
    )
  }

  /** Drop native mirrors for a session that no longer exists (binding replaced/removed). */
  private async settleNativeForSession(sessionID: string, reason: string): Promise<void> {
    for (const found of this.store.approvals()) {
      if (found.status !== "pending" || found.kind !== "native" || found.payload?.sessionID !== sessionID) continue
      const approval = this.store.cloneApproval(found.id)
      if (!approval) continue
      approval.status = "rejected"
      approval.resolution = reason
      approval.resolvedAt = now()
      await this.store.saveApproval(approval)
    }
  }

  /** Reply on the host permission request. Fail-open: a gone request still resolves locally. */
  private async replyNativePermission(sessionID: string, requestID: string, decision: "once" | "reject", message?: string): Promise<void> {
    const reply = this.ctx?.permission?.reply
    if (typeof reply !== "function") return
    await reply.call(this.ctx.permission, { sessionID, requestID, decision, ...(message ? { message } : {}) })
  }

  private defer(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (!this.stopped) fn()
    }, ms)
    if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
      ;(timer as unknown as { unref: () => void }).unref()
    }
    this.timers.add(timer)
  }

  /** Host config events that can change Ensemble workspace config. */
  private isConfigEvent(event: any): boolean {
    if (event?.type === "config.updated") return true
    if (event?.type !== "file.edited") return false
    const file = String(event?.data?.file ?? event?.file ?? "").replaceAll("\\", "/")
    return file === ".ensemble/config.json" || file.endsWith("/.ensemble/config.json")
  }

  /** Remember the location a client is viewing; a change forces discovery. */
  private noteViewDirectory(directory: string): void {
    if (this.viewDirectory === directory) return
    this.viewDirectory = directory
    this.configDirty = true
  }

  /**
   * Serialized maintenance entry point. A request that lands mid-pass is
   * coalesced into one follow-up pass; every caller resolves after a pass that
   * includes its request has finished. Maintenance never runs from a read.
   */
  private maintain(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.maintenanceWaiters.push(resolve)
      this.maintenanceQueued = true
      this.drainMaintenance()
    })
  }

  private drainMaintenance(): void {
    if (this.maintaining) return
    this.maintaining = true
    const run = (async () => {
      try {
        while (this.maintenanceQueued && !this.stopped) {
          this.maintenanceQueued = false
          const waiters = this.maintenanceWaiters
          this.maintenanceWaiters = []
          try {
            await this.performMaintenance()
          } catch {
            // Maintenance is best-effort: one failed pass must not stop the
            // timer or strand callers waiting for a settled state.
          }
          for (const resolve of waiters) resolve()
        }
      } finally {
        this.maintaining = false
        const pending = this.maintenanceWaiters
        this.maintenanceWaiters = []
        for (const resolve of pending) resolve()
      }
    })()
    this.maintenanceRun = run
  }

  private async performMaintenance(): Promise<void> {
    await this.store.sync().catch(() => false)
    this.refreshDmClock()
    const at = now()
    if (this.configDirty || at - this.lastConfigPassAt >= CONFIG_DISCOVERY_MS) {
      this.configDirty = false
      this.lastConfigPassAt = at
      await this.maintainConfigs()
    }
    await this.reapAndRetire()
    await this.reconcileWaitingWork()
    await this.settleTerminalStreams()
  }

  private async maintainConfigs(): Promise<void> {
    if (this.viewDirectory) {
      try {
        await this.discoverWorkspace(this.viewDirectory)
        if (this.lastConfigError !== undefined) {
          this.logger?.event("info", "service", "service.config.recovered", { directory: this.viewDirectory })
        }
        this.lastConfigError = undefined
      } catch (error: any) {
        const message = error?.message ?? String(error)
        if (message !== this.lastConfigError) {
          this.logger?.event("error", "service", "service.config.error", { directory: this.viewDirectory, error: message })
        }
        this.lastConfigError = message
      }
    }
    await this.reconcileWorkspaceConfigs()
    this.publishFeedMetaIfChanged()
  }

  /**
   * Schedule work after every mutation that creates or changes it. Agent
   * tool calls (`ensemble_delegate`, handoff registration, agent-to-agent
   * sends) bypass the RPC `invoke` path, so they must schedule explicitly —
   * otherwise agent-created work sits pending until an unrelated user action
   * happens to pump the queue.
   */
  private schedule(): void {
    this.pump()
  }

  /**
   * Cheap metadata revision for the TUI heartbeat. It reads the local version
   * (plus the stored version so a foreign write is noticed), the catalog
   * revision, and config file stats. It never discovers, reconciles, or
   * hydrates the full state; the snapshot RPC remains the discovery path.
   */
  private async revision(directory: string): Promise<Revision> {
    await this.store.settled()
    const local = this.store.revisionInfo()
    const stored = await this.store.storedVersion()
    const state = this.store.read()
    return {
      version: Math.max(local.version, stored),
      catalogRevision: this.catalog.revision,
      configRevision: this.configFingerprint(directory, local.workspaceDirectories),
      protocol: ENSEMBLE_PROTOCOL_VERSION,
      epoch: this.epochValue,
      counts: workspaceCounts(state),
      scopeVersions: this.store.scopeVersions(),
      gate: this.tier3Gate(state),
    }
  }

  private configFingerprint(directory: string, workspaceDirectories: string[]): number {
    const paths = new Set([
      workspaceConfigPath(canonicalDirectory(directory)),
      ...workspaceDirectories.map((item) => workspaceConfigPath(item)),
    ])
    let hash = 2166136261
    const mix = (value: string) => {
      for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index)
        hash = Math.imul(hash, 16777619)
      }
    }
    for (const path of [...paths].sort()) {
      mix(path)
      try {
        const stat = statSync(path)
        mix(`${stat.mtimeMs}:${stat.size}`)
      } catch {
        mix("missing")
      }
    }
    if (this.lastConfigError) mix(`error:${this.lastConfigError}`)
    return hash >>> 0
  }

  /**
   * Common preamble for durable read handlers: flush foreign/local writes,
   * settle the queue, refresh the DM clock, and remember the view directory.
   * Reads never discover, reconcile, or write.
   */
  private async beginRead(
    directory: string,
    options: { dmClock?: boolean; refreshCatalog?: boolean } = {},
  ): Promise<void> {
    await this.store.sync()
    await this.store.settled()
    if (options.dmClock !== false) this.refreshDmClock()
    this.noteViewDirectory(directory)
    if (options.refreshCatalog && Date.now() - this.catalog.lastRefreshedAt > 10_000) void this.catalog.refresh()
  }

  private activeWorkspaceDirectories(state: SnapshotState): string[] {
    return Object.values(state.workspaces)
      .filter((workspace) => !workspace.archived)
      .map((workspace) => workspace.directory)
  }

  /** Catalog/config/epoch metadata shared by snapshots and scoped bootstrap. */
  private viewEnvelope(
    directory: string,
    state: SnapshotState,
  ): Omit<Snapshot, "state" | "counts" | "window" | "gate" | "scoped"> {
    const payload: Omit<Snapshot, "state" | "counts" | "window" | "gate" | "scoped"> = {
      models: this.catalog.modelOptions,
      skills: this.catalog.skillOptions,
      directory,
      catalogRevision: this.catalog.revision,
      configRevision: this.configFingerprint(directory, this.activeWorkspaceDirectories(state)),
      protocol: ENSEMBLE_PROTOCOL_VERSION,
      epoch: this.epochValue,
    }
    if (this.lastConfigError) payload.configError = this.lastConfigError
    if (this.catalog.lastError) payload.modelsError = this.catalog.lastError
    return payload
  }

  /**
   * Ticket #134: the snapshot boundary is pure. It may merge foreign storage
   * (a read) but performs no writes, discovery, reconciliation, reaping,
   * stream settling, or purging; those run on the maintenance timer and
   * before pump work.
   */
  private async snapshot(directory: string): Promise<Snapshot> {
    const started = performance.now()
    await this.beginRead(directory, { refreshCatalog: true })
    const state = this.store.snapshot()
    state.runs = Object.fromEntries(this.activeRuns)
    this.overlayWorkStatus(state)
    const payload: Snapshot = {
      state,
      ...this.viewEnvelope(directory, state),
      counts: workspaceCounts(state),
    }
    // The host RPC output validator rejects explicit undefined anywhere in a
    // durable entity (live checks fail on `state.messages` as soon as the
    // first message exists). Sanitize once at the explicit snapshot boundary;
    // hot read paths never take this copy. This restores the pre-#131 contract
    // while keeping #131's no-hot-path-clone goal.
    const safe = jsonSafe(payload)
    // Ticket #141: the measured full-snapshot boundary feeds the Tier 3 gate.
    this.lastSnapshotBytes = Buffer.byteLength(JSON.stringify(safe))
    this.lastSnapshotMs = performance.now() - started
    this.logger?.event("debug", "refresh", "snapshot.build", {
      durationMs: this.lastSnapshotMs,
      bytes: this.lastSnapshotBytes,
      messages: Object.values(state.messages).reduce((total, list) => total + list.length, 0),
      tasks: Object.keys(state.subtasks).length,
      workspaces: Object.keys(state.workspaces).length,
    })
    return safe
  }

  /** Pick the read workspace: explicit, then UI-active, then directory, then newest. */
  private readWorkspaceID(state: SnapshotState, directory: string, requested?: string): string | undefined {
    if (requested && state.workspaces[requested]) return requested
    const active = state.ui.activeWorkspaceID
    if (active && state.workspaces[active] && !state.workspaces[active]!.archived) return active
    let canonical: string | undefined
    try {
      canonical = canonicalDirectory(directory)
    } catch {}
    const byDirectory = canonical === undefined
      ? undefined
      : Object.values(state.workspaces).find((workspace) => {
        if (workspace.archived) return false
        try {
          return canonicalDirectory(workspace.directory) === canonical
        } catch {
          return false
        }
      })
    if (byDirectory) return byDirectory.id
    return Object.values(state.workspaces)
      .filter((workspace) => !workspace.archived)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.id
  }

  /** Ticket #141 gate input from durable counts plus the last measured snapshot. */
  private tier3Gate(state: SnapshotState): Tier3Gate {
    return tier3Gate({
      messageCount: Object.values(state.messages).reduce((total, messages) => total + messages.length, 0),
      taskCount: Object.keys(state.subtasks).length,
      ...(this.lastSnapshotBytes !== undefined ? { snapshotBytes: this.lastSnapshotBytes } : {}),
      ...(this.lastSnapshotMs !== undefined ? { snapshotMs: this.lastSnapshotMs } : {}),
    })
  }

  /** Work tasks with the derived lifecycle overlay the Work pane reads. */
  private projectedTasks(state: SnapshotState, at: number): Record<string, Subtask> {
    const projected = projectVisibleWork(state, at)
    const tasks: Record<string, Subtask> = {}
    for (const [id, task] of Object.entries(projected)) {
      tasks[id] = { ...task, status: deriveWorkStatus(task, at) } as Subtask
    }
    return tasks
  }

  /** Shell entities with Work/transcript branches supplied by the caller. */
  private shellState(state: SnapshotState, subtasks: Record<string, Subtask>): SnapshotState {
    return {
      ...state,
      messages: {},
      // Direct-chat transcripts are native-session detail and unread by the
      // TUI; scoped reads never carry that unbounded history.
      dmTranscripts: {},
      subtasks,
      runs: Object.fromEntries(this.activeRuns),
    }
  }

  private async workProject(directory: string): Promise<any> {
    await this.beginRead(directory)
    const state = this.store.read()
    const at = Date.now()
    return jsonSafe({
      version: state.version,
      epoch: this.epochValue,
      counts: workspaceCounts(state),
      tasks: this.projectedTasks(state, at),
    })
  }

  private async transcriptWindow(
    directory: string,
    workspaceID?: string,
    beforeSeq?: number,
    limit?: number,
  ): Promise<any> {
    await this.beginRead(directory, { dmClock: false })
    const state = this.store.read()
    const target = this.readWorkspaceID(state, directory, workspaceID)
    if (!target) throw Object.assign(new Error("Workspace not found."), { code: "not_found" })
    const window = deriveTranscriptWindow(state.messages[target] ?? [], {
      ...(beforeSeq !== undefined ? { beforeSeq } : {}),
      ...(limit !== undefined ? { limit } : {}),
    })
    return jsonSafe({
      version: state.version,
      epoch: this.epochValue,
      workspaceID: target,
      ...window,
    })
  }

  private async messageGet(directory: string, workspaceID?: string, messageID?: string): Promise<any> {
    if (!messageID) throw invalidInput("messageID is required.")
    await this.beginRead(directory, { dmClock: false })
    const state = this.store.read()
    const target = this.readWorkspaceID(state, directory, workspaceID)
    if (!target) throw Object.assign(new Error("Workspace not found."), { code: "not_found" })
    const message = this.store.message(target, messageID)
    return jsonSafe(message ? { found: true, message } : { found: false })
  }

  /**
   * Gated scoped bootstrap: large workspaces get shell metadata, the visible
   * Work projection, one transcript window, and server-derived counts. Small
   * workspaces keep the full snapshot path. Every branch comes from the
   * durable store; the projection/window are disposable read models.
   */
  private async bootstrap(directory: string, workspaceID?: string): Promise<Snapshot> {
    const started = performance.now()
    await this.beginRead(directory, { refreshCatalog: true })
    const state = this.store.read()
    const gate = this.tier3Gate(state)
    const counts = workspaceCounts(state)
    if (!gate.enabled) {
      // Review fix: a disabled gate keeps the full snapshot path, but that
      // snapshot is also the measurement that can upgrade a borderline
      // workspace for its next steady-state read.
      const full = await this.snapshot(directory)
      this.logger?.event("debug", "refresh", "bootstrap", {
        scoped: false,
        gateReason: gate.reason,
        durationMs: performance.now() - started,
        bytes: this.lastSnapshotBytes,
        workspaceID: full.state.ui.activeWorkspaceID,
      })
      return { ...full, scoped: false, counts, gate: this.tier3Gate(state) }
    }
    const at = Date.now()
    const target = this.readWorkspaceID(state, directory, workspaceID)
    const window = target
      ? { ...deriveTranscriptWindow(state.messages[target] ?? [], {}), workspaceID: target }
      : undefined
    const subtasks = this.projectedTasks(state, at)
    const scopedState: SnapshotState = {
      ...this.shellState(state, subtasks),
      messages: target && window ? { [target]: window.messages } : {},
    }
    const payload: Snapshot = {
      state: scopedState,
      ...this.viewEnvelope(directory, state),
      scoped: true,
      ...(window ? { window: {
        ...(window.oldestSeq !== undefined ? { oldestSeq: window.oldestSeq } : {}),
        ...(window.newestSeq !== undefined ? { newestSeq: window.newestSeq } : {}),
        hasMoreOlder: window.hasMoreOlder,
        limit: window.limit,
      } } : {}),
      counts,
      gate,
    }
    const safe = jsonSafe(payload)
    this.logger?.event("debug", "refresh", "bootstrap", {
      scoped: true,
      gateReason: gate.reason,
      durationMs: performance.now() - started,
      bytes: Buffer.byteLength(JSON.stringify(safe)),
      workspaceID: target,
      windowRows: window?.messages.length ?? 0,
      hasMoreOlder: window?.hasMoreOlder,
    })
    return safe
  }

  /**
   * Scoped gap recovery. The caller names the stale scopes (from per-scope
   * versions); unchanged scopes are not read or transported.
   */
  private async resync(directory: string, workspaceID?: string, requested?: string[]): Promise<ScopedResync> {
    const allowed: ScopeName[] = ["shell", "work", "transcript"]
    const scopes = requested === undefined
      ? allowed
      : [...new Set(requested)].filter((scope): scope is ScopeName => (allowed as string[]).includes(scope))
    if (requested !== undefined && scopes.length !== requested.length) throw invalidInput("scopes must contain shell, work, or transcript.")
    await this.beginRead(directory)
    const state = this.store.read()
    const gate = this.tier3Gate(state)
    const payload: ScopedResync = {
      epoch: this.epochValue,
      version: state.version,
      scopeVersions: this.store.scopeVersions(),
      counts: workspaceCounts(state),
      gate,
      meta: this.feedMeta(),
    }
    // Review fix: a disabled gate means the caller keeps the snapshot path.
    if (!gate.enabled) return jsonSafe(payload)
    const target = this.readWorkspaceID(state, directory, workspaceID)
    if (scopes.includes("work")) payload.work = this.projectedTasks(state, Date.now())
    if (scopes.includes("shell")) payload.shell = this.shellState(state, {})
    if (scopes.includes("transcript") && target) {
      payload.transcript = { ...deriveTranscriptWindow(state.messages[target] ?? [], {}), workspaceID: target }
    }
    this.logger?.event("debug", "feed", "feed.resync", {
      scopes,
      gateReason: gate.reason,
      version: payload.version,
      workspaceID: target,
      tasks: payload.work ? Object.keys(payload.work).length : 0,
      windowRows: payload.transcript?.messages.length,
    })
    return jsonSafe(payload)
  }

  private async diagnostic(directory: string): Promise<{ state: SnapshotState; directory: string; clones?: ReturnType<typeof cloneStats>; logs?: unknown }> {
    await this.store.sync()
    this.refreshDmClock()
    this.noteViewDirectory(directory)
    const state = this.store.snapshot()
    state.runs = Object.fromEntries(this.activeRuns)
    this.overlayWorkStatus(state)
    // Same host RPC output constraint as snapshot(); diagnostic is also an
    // explicit full-state boundary, never a hot path.
    return jsonSafe({
      state,
      directory,
      ...(cloneDebugEnabled() ? { clones: cloneStats() } : {}),
      ...(this.logger ? { logs: this.logger.stats() } : {}),
    })
  }

  /** Recent service log entries for the TUI viewer and doctor. */
  private logsRecent(input: RpcInput): { entries: LogEntry[]; stats: unknown } {
    const logger = this.logger
    if (!logger) return { entries: [], stats: { enabled: false } }
    const levels = ["error", "warn", "info", "debug", "trace"]
    const categories = ["service", "task", "retry", "approval", "message", "feed", "refresh", "tui", "host", "failure"]
    if (input.level && !levels.includes(input.level)) throw invalidInput(`level must be one of ${levels.join(", ")}.`)
    if (input.cat && !categories.includes(input.cat)) throw invalidInput(`cat must be one of ${categories.join(", ")}.`)
    const entries = logger.recent({
      limit: input.limit,
      level: input.level as any,
      cat: input.cat as any,
      event: input.event,
      taskID: input.taskID,
    })
    return jsonSafe({ entries, stats: logger.stats() })
  }

  /**
   * Expose the derived lifecycle facts the work-row UI (ticket #56) needs on
   * every subtask in the snapshot representation. Additive only: stored
   * `state`/`outcome` are untouched.
   */
  private overlayWorkStatus(state: SnapshotState): void {
    const at = Date.now()
    for (const task of Object.values(state.subtasks)) {
      ;(task as Subtask & { status?: string }).status = deriveWorkStatus(task, at)
    }
  }

  private async invoke(directory: string, action: string, payload: Json): Promise<{ ok: boolean; result?: any; error?: { code: string; message: string } }> {
    await this.store.sync()
    this.refreshDmClock()
    this.noteViewDirectory(directory)
    try {
      const result = await this.dispatch(directory, action, payload)
      this.pump()
      return { ok: true, result: jsonSafe(result) }
    } catch (error: any) {
      return errorResult(error)
    }
  }

  private async dispatch(directory: string, action: string, payload: Json): Promise<any> {
    switch (action) {
      case "agent.create": return this.createAgent(payload)
      case "agent.update": return this.updateAgent(payload)
      case "agent.archive": return this.archiveAgent(payload.id, payload.replacementLeaderID)
      case "agent.delete": return this.deleteAgent(payload.id, payload.replacementLeaderID, Boolean(payload.deleteNativeSessions))
      case "agent.moveHome": return this.moveHomeSession(payload.agentID, payload.workspaceID)
      case "chat.context": return this.chatContext(payload.agentID, payload.workspaceID)
      case "chat.send": return this.chatSend(payload.agentID, payload.workspaceID, payload.text)
      case "chat.removeQueued": return this.removeQueuedDm(payload.agentID, payload.workspaceID, payload.id)
      case "workspace.create": return this.createWorkspace(directory, payload)
      case "workspace.update": return this.updateWorkspace(payload)
      case "workspace.activate": return this.activateWorkspace(payload.id)
      case "ui.save": return this.saveUiState(payload)
      case "workspace.init": return this.initWorkspace(payload)
      case "workspace.pause": return this.pauseWorkspace(payload.id, true)
      case "workspace.resume": return this.pauseWorkspace(payload.id, false)
      case "workspace.archive": return this.archiveWorkspace(payload.id)
      case "workspace.delete": return this.deleteWorkspace(payload.id, Boolean(payload.deleteNativeSessions))
      case "message.send": return this.sendMessage(payload)
      case "skill.send": return this.sendMessage(payload)
      case "task.delegate": return this.delegateFromUser(payload)
      case "task.retry": return this.retryTask(payload.id)
      case "task.restart": return this.restartTask(payload.id)
      case "task.cancel": return this.cancelTask(payload.id)
      case "task.reassign": return this.reassignTask(payload.id, payload.assigneeID)
      case "approval.resolve": return this.resolveApproval(payload)
      case "memory.add": return this.addMemory(payload)
      case "memory.update": return this.updateMemory(payload)
      case "memory.delete": return this.deleteMemory(payload)
      case "memory.promote": return this.promoteMemory(payload)
      case "settings.update": return this.updateSettings(payload)
      case "ensemble.reset": return this.resetEnsemble(Boolean(payload.deleteHandoffs), String(payload.confirmation ?? ""))
      default: throw Object.assign(new Error(`Unknown Ensemble v2 action: ${action}`), { code: "unknown_action" })
    }
  }

  private identityForAgent(agent: Agent): string {
    return [
      `<ensemble_persona name="${agent.name}">`,
      agent.role || "You are a focused teammate.",
      "</ensemble_persona>",
      "You are one member of an Ensemble team, not a standalone assistant. Reply as a colleague in a group chat: direct, specific, and readable. Use Markdown.",
      "For handoffs, write a Markdown file under .ensemble/handoffs with frontmatter (ensemble: handoff plus a task, a self-authored instruction for the recipient, and optional constraints, expected, and to) and call ensemble_handoff with its path and recipient. The instruction is delegation: tell the recipient what to do, with what context, and what good looks like — in your own words, never a copy of the user's message; task stays the short display title. The hop is already queued — do not call ensemble_delegate after it (leader-only; would double-queue). Keep the chat reply short; your turn stays open until the answer arrives back in the group chat, so do not treat the ack as delivery.",
      "Answer first: write your own answer in the group chat before handing off. A handoff forwards a completed result or clearly scoped work; it is never a substitute for answering your assignment.",
      "A `/skill` token in a user message is a deliberate skill request. When it applies to your part, load that skill with the native skill tool rather than treating it as prose.",
      "When a user message addresses multiple agents, handle only the part addressed to you. Do not delegate or duplicate another addressed agent's part; use ensemble_task_status and ensemble_workspace_info when you need coordination state.",
      "End-of-turn handoff (mandatory): every non-leader turn must end with a handoff to another member — hand off explicitly with ensemble_handoff, or the server hands your finished turn to the workspace leader automatically and the group shows `Handed to $Name`. The leader may end turns normally or hand off voluntarily. A batch review turn lists every pending completion: decide each item with ensemble_review (delegate, start, end, or dismiss) — the batch closes only when every item is decided; non-leaders hand it onward to the leader.",
      "Use ensemble_workspace_info and ensemble_list_agents to see your teammates and workspace.",
      "",
      ensembleBlock(),
    ].join("\n")
  }

  private async ensureHomeBinding(agent: Agent): Promise<{ sessionID: string; directory: string }> {
    const existing = this.store.binding("home", agent.id)
    if (existing?.kind === "home") return { sessionID: existing.sessionID, directory: existing.directory ?? agent.homeDirectory ?? homedir() }
    const inFlight = this.homeBindingPromises.get(agent.id)
    if (inFlight) return inFlight
    const promise = this.createHomeBinding(agent)
    this.homeBindingPromises.set(agent.id, promise)
    try { return await promise } finally { this.homeBindingPromises.delete(agent.id) }
  }

  private async createHomeBinding(agent: Agent): Promise<{ sessionID: string; directory: string }> {
    const directory = agent.homeDirectory ?? join(homedir(), ".ensemble", "agents", agent.id)
    mkdirSync(directory, { recursive: true })
    const created = unwrap<any>(await this.ctx.session.create({
      title: `${agent.name} · direct`,
      agent: "build",
      model: { providerID: agent.mainModel.providerID, id: agent.mainModel.modelID, ...(agent.mainModel.variant ? { variant: agent.mainModel.variant } : {}) },
      permissions: skillPermissions(agent.skillbox),
      location: { directory },
    }))
    if (!created?.id) throw Object.assign(new Error("Could not create a native session."), { code: "session_error" })
    const binding = { workspaceID: "home", agentID: agent.id, sessionID: created.id, kind: "home" as const, directory, agentVersion: agent.version, updatedAt: now() }
    await this.store.saveBinding(binding)
    await this.ctx.session.instructions.entry.put({ sessionID: created.id, key: "ensemble.v2.identity", value: this.identityForAgent(agent) }).catch(() => undefined)
    const current = this.store.cloneAgent(agent.id)
    if (current) {
      current.homeSessionID = created.id
      current.homeDirectory = directory
      await this.store.saveAgent(current)
    }
    return { sessionID: created.id, directory }
  }

  private chatSession(agent: Agent, workspaceID?: string): { workspace?: Workspace; sessionID: string; directory: string; bindingKeyID: string; bindingVersion?: number } {
    const workspace = workspaceID ? this.store.workspace(workspaceID) : undefined
    if (workspace && workspace.memberIDs.includes(agent.id)) {
      const binding = this.store.binding(workspace.id, agent.id)
      if (binding) return { workspace, sessionID: binding.sessionID, directory: workspace.directory, bindingKeyID: workspace.id, bindingVersion: binding.agentVersion }
      return { workspace, sessionID: "", directory: workspace.directory, bindingKeyID: workspace.id }
    }
    const home = this.store.binding("home", agent.id)
    if (home) return { workspace: workspace && workspace.memberIDs.includes(agent.id) ? workspace : undefined, sessionID: home.sessionID, directory: home.directory ?? agent.homeDirectory ?? homedir(), bindingKeyID: "home", bindingVersion: home.agentVersion }
    return { workspace, sessionID: "", directory: workspace && workspace.memberIDs.includes(agent.id) ? workspace.directory : agent.homeDirectory ?? homedir(), bindingKeyID: workspace && workspace.memberIDs.includes(agent.id) ? workspace.id : "home" }
  }

  /**
   * Write the identity instruction only when the agent version changed. The
   * direct-chat poll used to rewrite it on every 250 ms refresh; the map also
   * covers a stale workspace binding until a run replaces that session.
   */
  private async ensureIdentity(sessionID: string, agent: Agent, bindingVersion?: number): Promise<void> {
    if (this.identityVersions.get(sessionID) === agent.version) return
    if (this.identityVersions.get(sessionID) === undefined && bindingVersion === agent.version) {
      this.identityVersions.set(sessionID, agent.version)
      return
    }
    try {
      await this.ctx.session.instructions.entry.put({ sessionID, key: "ensemble.v2.identity", value: this.identityForAgent(agent) })
      this.identityVersions.set(sessionID, agent.version)
    } catch {
      // Leave the version unwritten so the next poll can retry.
    }
  }

  private async ensureChatSession(agent: Agent, workspaceID?: string): Promise<{ workspace?: Workspace; sessionID: string; directory: string; bindingKeyID: string; bindingVersion?: number }> {
    const target = this.chatSession(agent, workspaceID)
    if (target.sessionID) {
      await this.ensureIdentity(target.sessionID, agent, target.bindingVersion)
      return target
    }
    if (target.workspace) {
      const binding = await this.ensureBinding(target.workspace, agent)
      if (!binding) throw Object.assign(new Error("Could not create a native session."), { code: "session_error" })
      const stored = this.store.binding(target.workspace.id, agent.id)
      await this.ensureIdentity(binding.sessionID, agent, stored?.agentVersion)
      return { ...target, sessionID: binding.sessionID, bindingKeyID: target.workspace.id, bindingVersion: stored?.agentVersion }
    }
    const home = await this.ensureHomeBinding(agent)
    const binding = this.store.binding("home", agent.id)
    await this.ensureIdentity(home.sessionID, agent, binding?.agentVersion)
    return { workspace: undefined, sessionID: home.sessionID, directory: home.directory, bindingKeyID: "home", bindingVersion: binding?.agentVersion }
  }

  private async chatContext(agentID: string, workspaceID?: string): Promise<any> {
    const agent = this.store.agent(agentID)
    if (!agent) throw Object.assign(new Error("Agent not found."), { code: "not_found" })
    const target = await this.ensureChatSession(agent, workspaceID)
    const queuedIDs = new Set(
      this.store.dmQueue()
        .filter((entry) => entry.id && entry.agentID === agent.id && entry.status === "queued" && (entry.workspaceID ?? "home") === (target.bindingKeyID === "home" ? "home" : target.bindingKeyID))
        .map((entry) => entry.id),
    )
    // Ticket #77 root cause of permanently-grey sent lines: the stored DM
    // line keeps `queued: true` after it was flushed, and `|| message.queued`
    // made that stale bit outrank the queue's own truth. The queue entry is
    // authoritative: a line is queued exactly while its entry is still
    // `queued`; sent/failed/removed entries mean the line renders as sent.
    const stored = this.store.dmTranscript(target.bindingKeyID, agent.id).map((message) => ({ ...message, queued: queuedIDs.has(message.id) }))
    const native = mapNativeChat(listData(await this.ctx.session.context({ sessionID: target.sessionID })), agent.name)
    const messages = mergeDmTranscript(stored, native)
    const busy = [...this.activeRuns.values()].some((run) => run.sessionID === target.sessionID) || this.directBusy.has(target.sessionID)
    const queued = this.store.dmQueue().filter((entry) => entry.agentID === agent.id && entry.status === "queued" && (entry.workspaceID ?? "home") === (target.bindingKeyID === "home" ? "home" : target.bindingKeyID)).length
    return { agentID: agent.id, workspaceID: target.workspace?.id, sessionID: target.sessionID, directory: target.directory, busy, messages, queued }
  }

  private async chatSend(agentID: string, workspaceID: string | undefined, text: string, envelope?: { fromID?: string; correlationID?: string }): Promise<any> {
    const value = String(text ?? "").trim()
    if (!value) throw Object.assign(new Error("Message is empty."), { code: "empty" })
    const state = this.store.read()
    const agent = state.agents[agentID]
    if (!agent) throw Object.assign(new Error("Agent not found."), { code: "not_found" })
    // Ticket #103: direct conversations have no leader triage. General
    // skills are rejected before a DM line or prompt is created; the DM
    // agent's own assigned skills pass through unchanged.
    if (!envelope?.fromID) {
      const issue = directSkillIssue({
        text: value,
        agent,
        workspace: workspaceID ? state.workspaces[workspaceID] : undefined,
        agents: state.agents,
        skills: this.catalog.skillOptions,
      })
      if (issue) throw Object.assign(new Error(issue.message), { code: issue.code })
    }
    const target = await this.ensureChatSession(agent, workspaceID)
    const workspaceKey = target.bindingKeyID
    const busy = [...this.activeRuns.values()].some((run) => run.sessionID === target.sessionID) || this.directBusy.has(target.sessionID)
    const correlationID = envelope?.correlationID ?? newCorrelationID()
    const line = { id: id("dm"), role: "user" as const, author: "You", text: value, createdAt: this.dmNow(), queued: busy, correlationID }
    await this.store.saveDmMessage(workspaceKey, agent.id, line)
    if (busy) {
      const entry: DmQueueEntry = {
        id: line.id,
        agentID,
        workspaceID: workspaceKey === "home" ? undefined : workspaceKey,
        directory: target.directory,
        text: value,
        status: "queued",
        createdAt: line.createdAt,
        fromID: envelope?.fromID,
        correlationID,
      }
      await this.store.saveDmQueueEntry(entry)
      return { queued: true, id: entry.id, correlationID }
    }
    this.directBusy.add(target.sessionID)
    try {
      await this.ctx.session.prompt({ sessionID: target.sessionID, text: value, delivery: "queue" })
    } catch (error) {
      this.directBusy.delete(target.sessionID)
      throw error
    }
    void this.ctx.session.wait({ sessionID: target.sessionID }).catch(() => undefined).finally(() => {
      this.directBusy.delete(target.sessionID)
      void this.flushDmQueue(agent.id, workspaceKey === "home" ? undefined : workspaceKey)
    })
    return { queued: false, id: line.id, correlationID }
  }

  /**
   * Slice C queued-line removal (ticket #59): drops a parked user-owned DM
   * queue entry by key plus its queued transcript line, so the `· queued ·
   * [x remove]` affordance has a working key behind it. Removing the oldest
   * queued entry when no id is given keeps the keybinding total.
   */
  private async removeQueuedDm(agentID: string, workspaceID?: string, id?: string): Promise<any> {
    const agent = this.store.agent(agentID)
    if (!agent) throw Object.assign(new Error("Agent not found."), { code: "not_found" })
    const target = await this.ensureChatSession(agent, workspaceID)
    const workspaceKey = target.bindingKeyID
    const queued = this.store.dmQueue()
      .filter((entry) => entry.agentID === agent.id && entry.status === "queued" && (entry.workspaceID ?? "home") === (workspaceKey === "home" ? "home" : workspaceKey))
      .sort((a, b) => a.createdAt - b.createdAt)
    const targets = id ? queued.filter((entry) => entry.id === id) : queued.slice(0, 1)
    for (const entry of targets) {
      await this.store.removeDmQueueEntry(entry.id)
      await this.store.removeDmMessage(workspaceKey, agent.id, entry.id)
    }
    return { removed: targets.length }
  }

  private async moveHomeSession(agentID: string, workspaceID: string): Promise<any> {
    const agent = this.store.cloneAgent(agentID)
    const workspace = this.store.workspace(workspaceID)
    if (!agent || !workspace) throw Object.assign(new Error("Agent or workspace not found."), { code: "not_found" })
    if (!workspace.memberIDs.includes(agent.id)) throw Object.assign(new Error("The agent is not a member."), { code: "not_member" })
    if (this.store.binding(workspace.id, agent.id)) return { moved: false }
    const home = this.store.binding("home", agent.id)
    if (!home) return { moved: false }
    await this.ctx.session.move({ sessionID: home.sessionID, directory: workspace.directory })
    await this.store.removeBinding("home", agent.id)
    await this.store.moveDmTranscript("home", agent.id, workspace.id)
    this.refreshDmClock()
    await this.store.saveBinding({ workspaceID: workspace.id, agentID: agent.id, sessionID: home.sessionID, kind: "workspace", directory: workspace.directory, agentVersion: agent.version, updatedAt: now() })
    agent.homeSessionID = undefined
    await this.store.saveAgent(agent)
    return { moved: true }
  }

  private async flushDmQueue(agentID: string, workspaceID?: string): Promise<void> {
    if (workspaceID && !this.store.workspace(workspaceID)) return
    const workspaceKey = workspaceID ?? "home"
    const candidates = this.store.dmQueue()
      .filter((entry) => entry.agentID === agentID && entry.status === "queued" && (entry.workspaceID ?? "home") === workspaceKey)
      .sort((a, b) => a.createdAt - b.createdAt)
    for (const candidate of candidates) {
      const entry = this.store.cloneDmQueueEntry(candidate.id)
      if (!entry) continue
      try {
        const agent = this.store.agent(agentID)
        if (!agent) throw new Error("Agent not found.")
        const target = await this.ensureChatSession(agent, workspaceID)
        this.directBusy.add(target.sessionID)
        try {
          await this.ctx.session.prompt({ sessionID: target.sessionID, text: entry.text, delivery: "queue" })
        } catch (error) {
          this.directBusy.delete(target.sessionID)
          throw error
        }
        void this.ctx.session.wait({ sessionID: target.sessionID }).catch(() => undefined).finally(() => this.directBusy.delete(target.sessionID))
        entry.status = "sent"
      } catch {
        entry.status = "failed"
      }
      await this.store.saveDmQueueEntry(entry)
      const stored = this.store.dmTranscript(workspaceKey, agentID).find((message) => message.id === entry.id)
      if (stored) await this.store.saveDmMessage(workspaceKey, agentID, { ...stored, queued: false })
    }
  }

  private async createAgent(payload: Json): Promise<Agent> {
    const models = await this.catalog.ensureModels()
    const mainModel = payload.mainModel ?? (models[0] ? { providerID: models[0].providerID, modelID: models[0].modelID, variant: models[0].variants[0] } : undefined)
    if (!mainModel) throw Object.assign(new Error("No model is available."), { code: "no_model" })
    this.catalog.validate(mainModel)
    const backupModels = Array.isArray(payload.backupModels) ? payload.backupModels : []
    for (const model of backupModels) this.catalog.validate(model)
    const name = String(payload.name ?? "").trim()
    if (!name) throw Object.assign(new Error("Agent name is required."), { code: "invalid_name" })
    const state = this.store.read()
    if (Object.values(state.agents).some((agent) => !agent.archived && agent.name.toLowerCase() === name.toLowerCase())) {
      throw Object.assign(new Error(`Agent name already exists: ${name}`), { code: "duplicate_name" })
    }
    const at = now()
    const agent: Agent = {
      id: id("agent"),
      name,
      title: String(payload.title ?? ""),
      role: String(payload.role ?? payload.instructions ?? ""),
      mainModel,
      backupModels,
      skillbox: Array.isArray(payload.skillbox) ? [...new Set(payload.skillbox.map(String))] : [],
      color: String(payload.color ?? "cyan"),
      archived: false,
      pendingSettings: false,
      version: 1,
      createdAt: at,
      updatedAt: at,
    }
    agent.homeDirectory = join(homedir(), ".ensemble", "agents", agent.id)
    await this.store.saveAgent(agent)
    if (this.ctx.onboarding !== false) void this.onboardAgent(agent).catch(() => undefined)
    return agent
  }

  private async onboardAgent(agent: Agent): Promise<void> {
    const current = this.store.agent(agent.id)
    if (!current || current.archived) return
    const home = await this.ensureHomeBinding(agent)
    const latest = this.store.agent(agent.id)
    if (!latest || latest.archived) return
    await this.ctx.session.prompt({ sessionID: home.sessionID, text: onboardingPrompt(agent), delivery: "steer" })
  }

  private async updateAgent(payload: Json): Promise<Agent> {
    await this.catalog.ensureModels()
    const state = this.store.read()
    const agent = this.store.cloneAgent(payload.id)
    if (!agent) throw Object.assign(new Error("Agent not found."), { code: "not_found" })
    let behavioral = false
    if (payload.name !== undefined) {
      const nextName = String(payload.name).trim() || agent.name
      if (Object.values(state.agents).some((item) => item.id !== agent.id && !item.archived && item.name.toLowerCase() === nextName.toLowerCase())) {
        throw Object.assign(new Error(`Agent name already exists: ${nextName}`), { code: "duplicate_name" })
      }
      agent.name = nextName
    }
    if (payload.title !== undefined) agent.title = String(payload.title)
    if (payload.role !== undefined && String(payload.role) !== agent.role) { agent.role = String(payload.role); behavioral = true }
    if (payload.color !== undefined) agent.color = String(payload.color)
    if (payload.mainModel !== undefined) {
      this.catalog.validate(payload.mainModel)
      if (!sameModel(agent.mainModel, payload.mainModel)) behavioral = true
      agent.mainModel = payload.mainModel
    }
    if (payload.backupModels !== undefined) {
      for (const model of payload.backupModels) this.catalog.validate(model)
      if (!sameModels(agent.backupModels, payload.backupModels)) behavioral = true
      agent.backupModels = payload.backupModels
    }
    if (payload.skillbox !== undefined) {
      const next = stringList(payload.skillbox, "skillbox")
      if (next.length !== agent.skillbox.length || next.some((skill) => !agent.skillbox.includes(skill))) behavioral = true
      agent.skillbox = next
    }
    if (behavioral) {
      agent.version++
      agent.pendingSettings = true
    }
    agent.updatedAt = now()
    await this.store.saveAgent(agent)
    const synced = this.store.read()
    for (const workspace of Object.values(synced.workspaces)) {
      if (workspace.memberIDs.includes(agent.id)) writeWorkspaceConfig(workspace, synced.agents)
    }
    return agent
  }

  private async archiveAgent(agentID: string, replacementLeaderID?: string): Promise<any> {
    const agent = this.store.cloneAgent(agentID)
    if (!agent) throw Object.assign(new Error("Agent not found."), { code: "not_found" })
    const workspaces = this.store.workspaces()
    const led = workspaces.filter((workspace) => !workspace.archived && workspace.leaderID === agentID)
    if (led.length > 0 && !replacementLeaderID) throw Object.assign(new Error("Choose a replacement leader before archiving this agent."), { code: "leader_replacement_required" })
    if (replacementLeaderID) {
      for (const candidate of led) {
        if (!candidate.memberIDs.includes(replacementLeaderID)) throw Object.assign(new Error("The replacement leader must be a member."), { code: "leader_replacement_required" })
        const workspace = this.store.cloneWorkspace(candidate.id)
        if (!workspace) continue
        workspace.leaderID = replacementLeaderID
        await this.store.saveWorkspace(workspace)
      }
    }
    for (const run of this.activeRuns.values()) {
      if (run.agentID === agentID) await this.ctx.session.interrupt({ sessionID: run.sessionID, resume: false }).catch(() => undefined)
    }
    agent.archived = true
    agent.version++
    agent.updatedAt = now()
    await this.store.saveAgent(agent)
    for (const candidate of workspaces) {
      if (candidate.memberIDs.includes(agentID)) {
        const workspace = this.store.cloneWorkspace(candidate.id)
        if (!workspace) continue
        workspace.memberIDs = workspace.memberIDs.filter((member) => member !== agentID)
        await this.store.saveWorkspace(workspace)
        writeWorkspaceConfig(workspace, this.store.read().agents)
      }
    }
    await this.cancelAgentSubtasks(agentID, "Agent archived.")
    return { ok: true }
  }

  private async deleteAgent(agentID: string, replacementLeaderID?: string, deleteNativeSessions = false): Promise<any> {
    const agent = this.store.cloneAgent(agentID)
    if (!agent) throw Object.assign(new Error("Agent not found."), { code: "not_found" })
    const workspaces = this.store.workspaces()
    const led = workspaces.filter((workspace) => !workspace.archived && workspace.leaderID === agentID)
    if (led.length > 0 && !replacementLeaderID) throw Object.assign(new Error("Choose a replacement leader before deleting this agent."), { code: "leader_replacement_required" })
    if (replacementLeaderID) {
      for (const candidate of led) {
        if (!candidate.memberIDs.includes(replacementLeaderID)) throw Object.assign(new Error("The replacement leader must be a member."), { code: "leader_replacement_required" })
        const workspace = this.store.cloneWorkspace(candidate.id)
        if (!workspace) continue
        workspace.leaderID = replacementLeaderID
        await this.store.saveWorkspace(workspace)
      }
    }
    for (const run of this.activeRuns.values()) {
      if (run.agentID === agentID) await this.ctx.session.interrupt({ sessionID: run.sessionID, resume: false }).catch(() => undefined)
    }
    await this.cancelAgentSubtasks(agentID, "Agent deleted.")
    await this.store.pruneDmForAgent(agentID)
    for (const candidate of workspaces) {
      if (candidate.memberIDs.includes(agentID)) {
        const workspace = this.store.cloneWorkspace(candidate.id)
        if (!workspace) continue
        workspace.memberIDs = workspace.memberIDs.filter((member) => member !== agentID)
        await this.store.saveWorkspace(workspace)
        writeWorkspaceConfig(workspace, this.store.read().agents)
      }
      const binding = this.store.binding(candidate.id, agentID)
      if (binding) {
        if (deleteNativeSessions) {
          for (const sessionID of [...(binding.history ?? []), binding.sessionID]) await this.ctx.session.remove({ sessionID }).catch(() => undefined)
        }
        await this.store.removeBinding(candidate.id, agentID)
      }
    }
    const home = this.store.binding("home", agentID)
    if (home) {
      if (deleteNativeSessions) await this.ctx.session.remove({ sessionID: home.sessionID }).catch(() => undefined)
      await this.store.removeBinding("home", agentID)
    }
    for (const memory of this.store.memories()) {
      if (memory.agentID === agentID) {
        const stored = this.store.cloneMemory(memory.id)
        if (!stored) continue
        stored.deletedAt = now()
        await this.store.saveMemory(stored)
      }
    }
    await this.store.removeAgent(agentID)
    return { ok: true }
  }

  private resolveAgentNames(names: string[], agents: Record<string, Agent>): string[] {
    const resolved: string[] = []
    for (const name of names) {
      const matches = Object.values(agents).filter((agent) => !agent.archived && agent.name.toLowerCase() === name.toLowerCase())
      if (matches.length !== 1) throw Object.assign(new Error(`Agent name is unknown or ambiguous: ${name}`), { code: "invalid_config" })
      resolved.push(matches[0].id)
    }
    return [...new Set(resolved)]
  }

  private async reconcileWorkspaceConfigs(): Promise<void> {
    const state = this.store.read()
    for (const candidate of Object.values(state.workspaces)) {
      if (candidate.archived) continue
      const config = readWorkspaceConfig(candidate.directory)
      if (!config) continue
      try {
        const members = this.resolveAgentNames(config.members, state.agents)
        const leaderID = this.resolveAgentNames([config.leader], state.agents)[0]
        if (!members.includes(leaderID)) continue
        const changed = candidate.name !== config.name || candidate.leaderID !== leaderID || candidate.synthesis !== config.synthesis || candidate.paused !== config.paused || candidate.memberIDs.join("\0") !== members.join("\0") || candidate.configVersion !== config.version
        if (!changed) continue
        const workspace = this.store.cloneWorkspace(candidate.id)
        if (!workspace) continue
        workspace.name = config.name
        workspace.leaderID = leaderID
        workspace.memberIDs = members
        workspace.synthesis = config.synthesis
        workspace.paused = config.paused
        workspace.configVersion = config.version
        workspace.lastActiveAt = now()
        await this.store.saveWorkspace(workspace)
      } catch {
        // Keep the last good state for workspaces whose config names cannot be resolved.
      }
    }
  }

  private async discoverWorkspace(directory: string): Promise<Workspace | undefined> {
    const config = readWorkspaceConfig(directory)
    if (!config) return undefined
    const state = this.store.read()
    const canonical = canonicalDirectory(directory)
    let found = Object.values(state.workspaces).find((item) => item.directory === canonical && !item.archived)
    if (!found) {
      const members = this.resolveAgentNames(config.members, state.agents)
      const leaderID = this.resolveAgentNames([config.leader], state.agents)[0]
      if (!members.includes(leaderID)) throw Object.assign(new Error("The configured leader is not a member."), { code: "invalid_config" })
      const at = now()
      const configID = config.id && (!state.workspaces[config.id] || state.workspaces[config.id].directory === canonical) ? config.id : undefined
      const workspace: Workspace = {
        id: configID ?? id("workspace"),
        name: config.name,
        directory: canonical,
        leaderID,
        memberIDs: members,
        synthesis: config.synthesis,
        archived: false,
        paused: config.paused,
        configVersion: config.version,
        nextSeq: 1,
        createdAt: at,
        lastActiveAt: at,
      }
      await this.store.saveWorkspace(workspace)
      ensureEnsembleDirectory(canonical)
      writeWorkspaceConfig(workspace, state.agents)
      return workspace
    }
    const members = this.resolveAgentNames(config.members, state.agents)
    const leaderID = this.resolveAgentNames([config.leader], state.agents)[0]
    if (!members.includes(leaderID)) throw Object.assign(new Error("The configured leader is not a member."), { code: "invalid_config" })
    const changed = found.name !== config.name || found.leaderID !== leaderID || found.synthesis !== config.synthesis || found.paused !== config.paused || found.memberIDs.join("\0") !== members.join("\0") || found.configVersion !== config.version
    if (changed) {
      const workspace = this.store.cloneWorkspace(found.id)
      if (!workspace) return found
      workspace.name = config.name
      workspace.leaderID = leaderID
      workspace.memberIDs = members
      workspace.synthesis = config.synthesis
      workspace.paused = config.paused
      workspace.configVersion = config.version
      workspace.lastActiveAt = now()
      await this.store.saveWorkspace(workspace)
      return workspace
    }
    return found
  }

  private async createWorkspace(directory: string, payload: Json): Promise<Workspace> {
    const canonical = canonicalDirectory(String(payload.directory ?? directory))
    const state = this.store.read()
    const existing = Object.values(state.workspaces).find((workspace) => !workspace.archived && workspace.directory === canonical)
    if (existing) throw Object.assign(new Error(`A workspace already exists for this directory: ${existing.name}`), { code: "workspace_exists" })
    const name = String(payload.name ?? "").trim()
    if (!name) throw Object.assign(new Error("Workspace name is required."), { code: "invalid_name" })
    const memberIDs = Array.isArray(payload.memberIDs) ? [...new Set(payload.memberIDs.map(String))] : []
    const leaderID = String(payload.leaderID ?? "")
    if (memberIDs.length === 0) throw Object.assign(new Error("Choose at least one member."), { code: "invalid_members" })
    if (!memberIDs.includes(leaderID)) throw Object.assign(new Error("The leader must be a member."), { code: "invalid_leader" })
    for (const memberID of memberIDs) {
      const agent = state.agents[memberID]
      if (!agent || agent.archived) throw Object.assign(new Error("A selected agent is unavailable."), { code: "invalid_members" })
    }
    const at = now()
    const workspace: Workspace = {
      id: id("workspace"),
      name,
      directory: canonical,
      leaderID,
      memberIDs,
      synthesis: payload.synthesis !== false,
      archived: false,
      paused: false,
      nextSeq: 1,
      createdAt: at,
      lastActiveAt: at,
    }
    await this.store.saveWorkspace(workspace)
    ensureEnsembleDirectory(workspace.directory)
    writeWorkspaceConfig(workspace, state.agents)
    return workspace
  }

  private async updateWorkspace(payload: Json): Promise<Workspace> {
    const workspace = this.store.cloneWorkspace(payload.id)
    if (!workspace) throw Object.assign(new Error("Workspace not found."), { code: "not_found" })
    if (payload.name !== undefined) workspace.name = String(payload.name).trim() || workspace.name
    if (payload.memberIDs !== undefined) {
      const members = stringList(payload.memberIDs, "memberIDs")
      if (members.length === 0) throw Object.assign(new Error("Choose at least one member."), { code: "invalid_members" })
      workspace.memberIDs = members
    }
    if (payload.leaderID !== undefined) workspace.leaderID = String(payload.leaderID)
    if (!workspace.memberIDs.includes(workspace.leaderID)) throw Object.assign(new Error("The leader must be a member."), { code: "invalid_leader" })
    if (payload.synthesis !== undefined) workspace.synthesis = Boolean(payload.synthesis)
    workspace.lastActiveAt = now()
    await this.store.saveWorkspace(workspace)
    writeWorkspaceConfig(workspace, this.store.read().agents)
    return workspace
  }

  private async saveUiState(payload: Json): Promise<any> {
    const ui = { ...this.store.ui(), ...(payload ?? {}) }
    await this.store.saveUi(ui)
    return { ok: true }
  }

  private async activateWorkspace(workspaceID: string): Promise<any> {
    const workspace = this.store.cloneWorkspace(workspaceID)
    if (!workspace) throw Object.assign(new Error("Workspace not found."), { code: "not_found" })
    workspace.lastActiveAt = now()
    await this.store.saveWorkspace(workspace)
    await this.store.saveUi({ ...this.store.ui(), activeWorkspaceID: workspaceID })
    return { ok: true }
  }

  private async initWorkspace(payload: Json): Promise<any> {
    const state = this.store.read()
    const workspace = state.workspaces[payload.id]
    if (!workspace) throw Object.assign(new Error("Workspace not found."), { code: "not_found" })
    if (workspace.archived) throw Object.assign(new Error("This workspace is archived."), { code: "workspace_archived" })
    if (payload.direct === true) throw Object.assign(new Error("Init is workspace-only. Open a workspace and rerun /init."), { code: "init_workspace_only" })
    if (payload.text !== undefined) {
      const issue = initComposerIssue(String(payload.text))
      if (issue) throw Object.assign(new Error(issue), { code: "init_solo" })
    }
    const leader = state.agents[workspace.leaderID]
    if (!leader || leader.archived || !workspace.memberIDs.includes(leader.id)) {
      throw Object.assign(new Error("The workspace leader is missing or archived."), { code: "invalid_leader" })
    }
    const active = Object.values(state.initJobs).find((job) => job.workspaceID === workspace.id && job.state === "running")
    if (active) throw Object.assign(new Error("An init is already running for this workspace. Wait for it to finish."), { code: "init_running" })
    const agentsPath = join(workspace.directory, "AGENTS.md")
    const previousAgentsMD = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : null
    await this.appendMessage(workspace, { author: "user", text: INIT_COMMAND, kind: "text" })
    const message = await this.appendMessage(workspace, {
      author: "agent",
      displayAuthor: SYSTEM_AGENT_NAME,
      text: INIT_START_TEXT,
      kind: "text",
      streaming: true,
      updatedAt: now(),
    })
    const job: InitJob = {
      id: id("init"),
      workspaceID: workspace.id,
      messageID: message.id,
      state: "running",
      phases: ["starting"],
      previousAgentsMD,
      startedAt: now(),
    }
    await this.store.saveInitJob(job)
    const run = { jobID: job.id, cancelled: false, promise: Promise.resolve() }
    this.initRuns.set(job.id, run)
    run.promise = this.runInit(job.id).finally(() => {
      this.initRuns.delete(job.id)
    })
    void run.promise
    return { ok: true, jobID: job.id, messageID: message.id, directory: workspace.directory }
  }

  /**
   * Restart reconciliation: a running job cannot keep its native session
   * across a service restart. Restore the captured AGENTS.md, settle the
   * System Agent row with an explicit rerun instruction, and remove the dead
   * temporary session if the host still knows it.
   */
  private async reconcileInitJobs(): Promise<void> {
    for (const candidate of this.store.initJobs()) {
      if (candidate.state !== "running") continue
      const job = this.store.cloneInitJob(candidate.id)
      if (!job) continue
      const workspace = this.store.workspace(job.workspaceID)
      if (workspace) this.restoreAgentsFile(workspace.directory, job)
      recordInitPhase(job, "reporting")
      const report = initInterruptedReport(job.previousAgentsMD !== null)
      const found = this.initMessage(job)
      const message = found ? this.store.cloneMessage(job.workspaceID, found.id) : undefined
      if (message) {
        settleStreamMessage(message, report, true)
        await this.store.saveMessage(message)
      }
      job.state = "interrupted"
      job.error = "Ensemble restarted while init was running."
      job.report = report
      job.finishedAt = now()
      await this.store.saveInitJob(job)
      if (job.sessionID) await this.ctx.session.remove({ sessionID: job.sessionID }).catch(() => undefined)
    }
  }

  private initMessage(job: InitJob): Message | undefined {
    return this.store.message(job.workspaceID, job.messageID)
  }

  private restoreAgentsFile(directory: string, job: InitJob): void {
    const path = join(directory, "AGENTS.md")
    try {
      if (job.previousAgentsMD === null) {
        if (existsSync(path)) unlinkSync(path)
      } else {
        writeFileSync(path, job.previousAgentsMD)
      }
    } catch {
      // Best-effort rollback: the failure report still names the intended
      // state. A read-only checkout cannot be repaired by the service.
    }
  }

  /** Move a live init job to a stage and persist it before doing that stage's work. */
  private async advanceInitPhase(jobID: string, phase: InitPhase): Promise<InitJob | undefined> {
    const job = this.store.cloneInitJob(jobID)
    if (!job || job.state !== "running") return undefined
    recordInitPhase(job, phase)
    await this.store.saveInitJob(job)
    return job
  }

  /** Replace the live System Agent row text for a stage; the job owns liveness. */
  private async updateInitRow(job: InitJob, text: string): Promise<void> {
    const found = this.initMessage(job)
    if (!found) return
    const message = this.store.cloneMessage(job.workspaceID, found.id)
    if (!message) return
    message.text = text
    message.streaming = true
    message.updatedAt = now()
    await this.store.saveMessage(message)
  }

  private async runInit(jobID: string): Promise<void> {
    const run = this.initRuns.get(jobID)
    const job = this.store.initJob(jobID)
    if (!run || !job || job.state !== "running") return
    const workspace = this.store.workspace(job.workspaceID)
    if (!workspace) {
      await this.failInit(jobID, "Workspace not found.")
      return
    }
    const globalEpoch = this.globalEpoch
    const workspaceEpoch = this.workspaceEpoch.get(job.workspaceID) ?? 0
    let sessionID = ""
    try {
      const created = unwrap<any>(await this.ctx.session.create({
        title: `Ensemble init · ${workspace.name}`,
        agent: "build",
        location: { directory: workspace.directory },
      }))
      sessionID = created?.id
      if (!sessionID) throw new Error("Could not create an init session.")
      run.sessionID = sessionID
      if (run.cancelled) {
        await this.ctx.session.remove({ sessionID }).catch(() => undefined)
        return
      }
      const claimed = this.store.cloneInitJob(jobID)
      if (!claimed || claimed.state !== "running") {
        await this.ctx.session.remove({ sessionID }).catch(() => undefined)
        return
      }
      claimed.sessionID = sessionID
      recordInitPhase(claimed, "running")
      await this.store.saveInitJob(claimed)
      const foundMessage = this.initMessage(claimed)
      const message = foundMessage ? this.store.cloneMessage(claimed.workspaceID, foundMessage.id) : undefined
      const registration = registerLiveSlot(this.liveBySession, sessionID, now())
      if (registration.orphaned) {
        await this.finalizeStream(registration.orphaned.message, registration.orphaned.buffer || REPLY_INTERRUPTED, true, globalEpoch, workspaceEpoch, workspace.id)
      }
      const progress = initPhaseText("running")
      if (message) {
        message.text = progress
        message.streaming = true
        message.updatedAt = now()
        await this.store.saveMessage(message)
      }
      registration.slot.message = message
      registration.slot.buffer = `${progress}\n\n`
      await this.ctx.session.command({ sessionID, name: "init", text: initInstructions() })
      await this.ctx.session.wait({ sessionID })
      if (run.cancelled) return
      const result = assistantResult(listData(await this.ctx.session.context({ sessionID })), job.startedAt)
      if (result.failure) throw new Error(result.failure.message ?? "Native init failed.")
      if (run.cancelled) return
      const current = this.store.read()
      const currentJob = current.initJobs[jobID]
      const currentWorkspace = current.workspaces[claimed.workspaceID]
      if (!currentJob || currentJob.state !== "running" || !currentWorkspace) return
      if (this.globalEpoch !== globalEpoch || (this.workspaceEpoch.get(claimed.workspaceID) ?? 0) !== workspaceEpoch) return
      const writing = await this.advanceInitPhase(jobID, "writing")
      if (!writing) return
      await this.updateInitRow(writing, initPhaseText("writing"))
      if (run.cancelled) {
        this.restoreAgentsFile(currentWorkspace.directory, writing)
        return
      }
      writeAgentsBlock(currentWorkspace.directory, ensembleBlock())
      writeInitMetadata(currentWorkspace.directory, ENSEMBLE_BLOCK_VERSION)
      if (run.cancelled) {
        this.restoreAgentsFile(currentWorkspace.directory, writing)
        return
      }
      const reporting = await this.advanceInitPhase(jobID, "reporting")
      if (!reporting) return
      await this.updateInitRow(reporting, initPhaseText("reporting"))
      if (run.cancelled) {
        this.restoreAgentsFile(currentWorkspace.directory, reporting)
        return
      }
      const report = initSuccessReport(currentWorkspace.directory, result.text)
      reporting.state = "succeeded"
      reporting.report = report
      reporting.finishedAt = now()
      reporting.error = undefined
      // Mark the job terminal before awaiting storage so a concurrent delete
      // or archive sees a finished job and cannot half-cancel the write.
      await this.store.saveInitJob(reporting)
      const foundNow = this.initMessage(reporting)
      const messageNow = foundNow ? this.store.cloneMessage(reporting.workspaceID, foundNow.id) : undefined
      if (messageNow) {
        settleStreamMessage(messageNow, report, false)
        await this.store.saveMessage(messageNow)
      }
    } catch (error: any) {
      if (!run.cancelled) await this.failInit(jobID, error?.message ?? String(error))
    } finally {
      this.liveBySession.delete(sessionID)
      if (sessionID) await this.ctx.session.remove({ sessionID }).catch(() => undefined)
    }
  }

  private async failInit(jobID: string, message: string): Promise<void> {
    const job = this.store.cloneInitJob(jobID)
    if (!job || job.state !== "running") return
    const workspace = this.store.workspace(job.workspaceID)
    if (workspace) this.restoreAgentsFile(workspace.directory, job)
    recordInitPhase(job, "reporting")
    const report = initFailureReport(message, job.previousAgentsMD !== null)
    job.state = "failed"
    job.error = message
    job.report = report
    job.finishedAt = now()
    // Terminal first: a cancellation that arrives while the message save
    // yields must observe the finished job rather than restoring twice.
    await this.store.saveInitJob(job)
    this.logger?.failure({
      level: "error",
      cat: "failure",
      event: "failure.terminal",
      incidentID: id("failure"),
      failureClass: "init",
      workspaceID: job.workspaceID,
      initJobID: job.id,
      messageID: job.messageID,
      sessionID: job.sessionID,
      error: { name: "InitError", message },
      decision: { type: "terminal", reason: "init-failed" },
      version: this.store.read().version,
      epoch: this.epochValue,
    })
    const found = this.initMessage(job)
    const row = found ? this.store.cloneMessage(job.workspaceID, found.id) : undefined
    if (row) {
      settleStreamMessage(row, report, true)
      await this.store.saveMessage(row)
    }
  }

  private async cancelInitJob(job: InitJob, reason: string): Promise<void> {
    const current = this.store.cloneInitJob(job.id)
    if (!current || current.state !== "running") return
    const run = this.initRuns.get(job.id)
    if (run) run.cancelled = true
    const sessionID = current.sessionID ?? run?.sessionID
    const workspace = this.store.workspace(current.workspaceID)
    if (workspace) this.restoreAgentsFile(workspace.directory, current)
    recordInitPhase(current, "reporting")
    const report = initCancelReport(reason, current.previousAgentsMD !== null)
    current.state = "cancelled"
    current.error = reason
    current.report = report
    current.finishedAt = now()
    await this.store.saveInitJob(current)
    const found = this.initMessage(current)
    const row = found ? this.store.cloneMessage(current.workspaceID, found.id) : undefined
    if (row) {
      settleStreamMessage(row, report, true)
      await this.store.saveMessage(row)
    }
    if (sessionID) {
      await this.ctx.session.interrupt({ sessionID, resume: false }).catch(() => undefined)
      this.liveBySession.delete(sessionID)
      await this.ctx.session.remove({ sessionID }).catch(() => undefined)
    }
  }

  private async cancelActiveInitJobs(workspaceID: string | undefined, reason: string): Promise<void> {
    const jobs = this.store.initJobs()
      .filter((job) => job.state === "running" && (!workspaceID || job.workspaceID === workspaceID))
    for (const job of jobs) await this.cancelInitJob(job, reason)
  }

  private async waitForInitRuns(): Promise<void> {
    const promises = [...this.initRuns.values()].map((run) => run.promise)
    if (promises.length === 0) return
    await Promise.race([Promise.allSettled(promises), new Promise<void>((resolve) => setTimeout(resolve, 2000))])
  }

  private async scanStorage(prefix: string): Promise<Array<{ key: string; value: any }>> {
    const entries: Array<{ key: string; value: any }> = []
    let cursor: string | undefined
    do {
      const page = await this.ctx.storage.scan({ prefix, ...(cursor ? { after: cursor } : {}), limit: 500 })
      entries.push(...(page.entries ?? []))
      cursor = page.next
    } while (cursor)
    return entries
  }

  private async waitForRuns(): Promise<void> {
    if (this.running.size === 0) return
    await Promise.race([Promise.allSettled([...this.running]), new Promise<void>((resolve) => setTimeout(resolve, 2000))])
  }

  private async resetEnsemble(deleteHandoffs: boolean, confirmation: string): Promise<any> {
    if (confirmation !== "RESET") throw Object.assign(new Error('Type RESET to confirm.'), { code: "confirmation_required" })
    this.globalEpoch++
    this.epochValue++
    this.workspaceEpoch.clear()
    await this.cancelActiveInitJobs(undefined, "Ensemble was reset.")
    await this.waitForInitRuns()
    for (const run of this.activeRuns.values()) await this.ctx.session.interrupt({ sessionID: run.sessionID, resume: false }).catch(() => undefined)
    await this.waitForRuns()
    const bindings = await this.scanStorage("v2/binding/")
    for (const entry of bindings) {
      const binding = entry.value as SessionBinding
      for (const sessionID of [...(binding.history ?? []), binding.sessionID]) await this.ctx.session.remove({ sessionID }).catch(() => undefined)
    }
    const workspaces = await this.scanStorage("v2/workspace/")
    for (const entry of workspaces) {
      const workspace = entry.value as Workspace
      try { unlinkSync(workspaceConfigPath(workspace.directory)) } catch {}
      try { unlinkSync(join(workspace.directory, ".ensemble", "init.json")) } catch {}
      if (deleteHandoffs) {
        try { rmSync(join(workspace.directory, ".ensemble", "handoffs"), { recursive: true, force: true }) } catch {}
      }
    }
    for (const entry of await this.scanStorage("v2/")) await this.ctx.storage.remove(entry.key).catch(() => undefined)
    await this.ctx.storage.remove("v2/meta").catch(() => undefined)
    await this.ctx.storage.remove("ensemble.state").catch(() => undefined)
    await this.store.reset()
    this.refreshDmClock()
    return { ok: true }
  }

  private async pauseWorkspace(workspaceID: string, paused: boolean): Promise<Workspace> {
    const workspace = this.store.cloneWorkspace(workspaceID)
    if (!workspace) throw Object.assign(new Error("Workspace not found."), { code: "not_found" })
    workspace.paused = paused
    workspace.lastActiveAt = now()
    await this.store.saveWorkspace(workspace)
    writeWorkspaceConfig(workspace, this.store.read().agents)
    return workspace
  }

  private async archiveWorkspace(workspaceID: string): Promise<any> {
    const workspace = this.store.cloneWorkspace(workspaceID)
    if (!workspace) throw Object.assign(new Error("Workspace not found."), { code: "not_found" })
    workspace.archived = true
    workspace.lastActiveAt = now()
    this.workspaceEpoch.set(workspaceID, (this.workspaceEpoch.get(workspaceID) ?? 0) + 1)
    await this.cancelActiveInitJobs(workspaceID, "Workspace archived.")
    await this.store.saveWorkspace(workspace)
    try { unlinkSync(workspaceConfigPath(workspace.directory)) } catch {}
    const ui = this.store.ui()
    if (ui.activeWorkspaceID === workspaceID) await this.store.saveUi({ ...ui, activeWorkspaceID: undefined })
    for (const run of this.activeRuns.values()) {
      if (run.workspaceID === workspaceID) await this.ctx.session.interrupt({ sessionID: run.sessionID, resume: false }).catch(() => undefined)
    }
    await this.cancelWorkspaceSubtasks(workspaceID, "Workspace archived.")
    return { ok: true }
  }

  private async deleteWorkspace(workspaceID: string, deleteNativeSessions = false): Promise<any> {
    const workspace = this.store.workspace(workspaceID)
    if (!workspace) throw Object.assign(new Error("Workspace not found."), { code: "not_found" })
    this.workspaceEpoch.set(workspaceID, (this.workspaceEpoch.get(workspaceID) ?? 0) + 1)
    await this.cancelActiveInitJobs(workspaceID, "Workspace deleted.")
    await this.cancelWorkspaceSubtasks(workspaceID, "Workspace deleted.")
    for (const run of this.activeRuns.values()) {
      if (run.workspaceID === workspaceID) await this.ctx.session.interrupt({ sessionID: run.sessionID, resume: false }).catch(() => undefined)
    }
    await this.waitForRuns()
    if (deleteNativeSessions) {
      for (const binding of this.store.bindings()) {
        if (binding.workspaceID !== workspaceID) continue
        for (const sessionID of [...(binding.history ?? []), binding.sessionID]) await this.ctx.session.remove({ sessionID }).catch(() => undefined)
      }
    }
    try { unlinkSync(workspaceConfigPath(workspace.directory)) } catch {}
    const ui = this.store.ui()
    if (ui.activeWorkspaceID === workspaceID) await this.store.saveUi({ ...ui, activeWorkspaceID: undefined })
    await this.store.pruneWorkspace(workspaceID)
    return { ok: true }
  }

  private async cancelSubtasks(matches: (subtask: Subtask) => boolean, reason: string): Promise<void> {
    const at = now()
    for (const candidate of this.store.subtasks()) {
      if (!matches(candidate)) continue
      if (candidate.state !== "pending" && candidate.state !== "working") continue
      const subtask = this.store.cloneSubtask(candidate.id)
      if (!subtask) continue
      subtask.state = "replied"
      subtask.outcome = "failed"
      subtask.error = reason
      subtask.activeRunID = undefined
      subtask.approvalID = undefined
      subtask.claimedBy = undefined
      subtask.leaseUntil = undefined
      subtask.retryAfter = undefined
      subtask.repliedAt = at
      subtask.finishedAt = at
      subtask.stoppedAt = at
      await this.store.saveSubtask(subtask)
      this.noteWorkChanged(subtask)
      await this.settlePendingApprovals(subtask.id, reason)
    }
  }

  /**
   * Settle every pending approval tied to finished work. Used on explicit
   * user transitions (cancel/retry/reassign/reap): the decision is moot, so
   * nothing lingers — including `outside_roster` and `cross_project` rows,
   * which previously went stale.
   */
  private async settlePendingApprovals(subtaskID: string, resolution: string): Promise<void> {
    await this.settleLinkedApprovals(subtaskID, resolution, new Set())
  }

  /**
   * Settle pending approvals tied to one subtask, except kinds in `exclude`.
   * Terminal run paths use this with native excluded: only the host (via
   * `permission.replied`) or an explicit user resolve settles a native
   * mirror, since the host request may still be live after our run ends.
   */
  private async settleLinkedApprovals(subtaskID: string, resolution: string, exclude: ReadonlySet<Approval["kind"]>): Promise<void> {
    for (const candidate of this.store.approvals()) {
      if (candidate.status !== "pending" || candidate.subtaskID !== subtaskID) continue
      if (exclude.has(candidate.kind)) continue
      const approval = this.store.cloneApproval(candidate.id)
      if (!approval) continue
      approval.status = "rejected"
      approval.resolution = resolution
      approval.resolvedAt = now()
      await this.store.saveApproval(approval)
    }
  }

  private async cancelAgentSubtasks(agentID: string, reason: string): Promise<void> {
    await this.cancelSubtasks((subtask) => subtask.assigneeID === agentID, reason)
    for (const candidate of this.store.approvals()) {
      if (candidate.agentID === agentID && candidate.status === "pending") {
        const approval = this.store.cloneApproval(candidate.id)
        if (!approval) continue
        approval.status = "rejected"
        approval.resolution = reason
        await this.store.saveApproval(approval)
      }
    }
  }

  private async cancelWorkspaceSubtasks(workspaceID: string, reason: string): Promise<void> {
    await this.cancelSubtasks((subtask) => subtask.workspaceID === workspaceID, reason)
    for (const candidate of this.store.approvals()) {
      if (candidate.workspaceID === workspaceID && candidate.status === "pending") {
        const approval = this.store.cloneApproval(candidate.id)
        if (!approval) continue
        approval.status = "rejected"
        approval.resolution = reason
        await this.store.saveApproval(approval)
      }
    }
  }

  private async sendMessage(payload: Json): Promise<any> {
    const state = this.store.read()
    const workspace = state.workspaces[payload.workspaceID]
    if (!workspace || workspace.archived) throw Object.assign(new Error("Workspace not found."), { code: "not_found" })
    if (workspace.paused) throw Object.assign(new Error("This workspace is paused. Resume it before sending work."), { code: "workspace_paused" })
    const text = String(payload.text ?? "").trim()
    if (!text) throw Object.assign(new Error("Message is empty."), { code: "empty" })
    // Ticket #101: the server re-runs the shared planner against authoritative
    // workspace state before touching the transcript or the queue. Any invalid
    // skill/owner pair rejects the whole message atomically. Ticket #103 adds
    // General-skill leader triage and owner-picker resolutions.
    const ownerSelections = payload.ownerSelections && typeof payload.ownerSelections === "object"
      ? Object.fromEntries(Object.entries(payload.ownerSelections as Record<string, unknown>).map(([key, value]) => [String(key), String(value)]))
      : undefined
    const plan = planSkillInvocation({
      text,
      workspace,
      agents: state.agents,
      skills: this.catalog.skillOptions,
      maxSkills: Math.min(state.settings.maxDelegations, 8),
      ownerSelections,
    })
    const planError = plan.errors[0]
    if (planError) throw Object.assign(new Error(planError.message), { code: planError.code })
    if (plan.kind === "init") {
      throw Object.assign(new Error("Init runs through the System Agent. Use /init from the workspace composer."), { code: "init_command" })
    }
    const ownerChoice = plan.ownerChoices?.[0]
    if (ownerChoice) {
      const owners = ownerChoice.ownerIDs.map((ownerID) => `$${state.agents[ownerID]?.name ?? ownerID}`).join(", ")
      throw Object.assign(new Error(`Skill /${ownerChoice.skillID} is assigned to ${owners}. Choose an owner before sending.`), { code: "owner_choice_required" })
    }
    // Ticket #102: every planner recipient is one unique prompt for this
    // message. Skill recipients carry their grouped skill list; a normal-only
    // anchor is an ordinary peer turn for that agent.
    const skillRecipients = plan.kind === "skills" ? plan.recipients : []
    const skillRecipient = new Map(skillRecipients.map((recipient) => [recipient.agentID, recipient]))
    const explicitIDs = Array.isArray(payload.recipientIDs) ? [...new Set(payload.recipientIDs.map(String))] : []
    const references = workspaceFileReferences(text, workspace.directory)
    // Deliberate skill delivery keeps the exact user text as the instruction;
    // the planner has already validated every addressed skill/owner pair.
    // File references are context for every prompt, including skill prompts.
    const instruction = references.length === 0 ? text : `${text}\n\nReferenced files:\n${references.map((file) => `- ${file}`).join("\n")}`
    // One user command mints exactly one dispatch group; every recipient in
    // this fan-out (and every descendant hop) inherits it. A second command
    // mints a second group even while the first is still active.
    const dispatchGroupID = newDispatchGroupID()
    if (plan.kind === "skills" && explicitIDs.length > 0) {
      const expected = skillRecipients.map((recipient) => recipient.agentID).sort()
      const requested = [...explicitIDs].sort()
      if (expected.length !== requested.length || expected.some((agentID, index) => agentID !== requested[index])) {
        const names = (ids: string[]) => ids.map((agentID) => `$${state.agents[agentID]?.name ?? agentID}`).join(", ")
        throw Object.assign(
          new Error(`Skill routing resolves to ${names(expected) || "no addressed agent"}. Explicit recipient ids (${names(requested)}) cannot override the addressed anchors or Skillbox owners.`),
          { code: "skill_recipient_mismatch" },
        )
      }
    }
    if (explicitIDs.length > 0) {
      const valid: string[] = []
      await this.appendMessage(workspace, { author: "user", text, kind: "text" })
      for (const agentID of explicitIDs) {
        const agent = state.agents[agentID]
        if (agent && !agent.archived && workspace.memberIDs.includes(agentID)) {
          valid.push(agentID)
          continue
        }
        const reason = agent?.archived
          ? `${agent.name} is archived and cannot take turns.`
          : agent
            ? `${agent.name} is not a workspace member; add them to the workspace before mentioning.`
            : "no workspace member matches that ID."
        await this.appendMessage(workspace, { author: "system", text: peerRefusalText(agent?.name ?? agentID, reason), kind: "system" })
      }
      if (valid.length === 0) {
        const available = workspace.memberIDs.map((memberID) => state.agents[memberID]?.name).filter(Boolean).join(", ")
        throw Object.assign(new Error(`Unknown workspace member${explicitIDs.length > 1 ? "s" : ""}: ${explicitIDs.join(", ")}. Members: ${available}`), { code: "unknown_member" })
      }
      for (const agentID of valid) {
        const recipient = skillRecipient.get(agentID)
        await this.createSubtask({
          workspace,
          assigneeID: agentID,
          creatorType: "user",
          title: recipient ? skillWorkTitle(text, recipient) : text.slice(0, 80),
          instruction,
          mode: payload.mode === "edit" ? "edit" : "research",
          skillGrants: recipient?.generalSkills,
          dispatchGroupID,
        })
      }
      this.schedule()
      const current = this.store.cloneWorkspace(workspace.id)
      if (current) {
        current.lastActiveAt = now()
        await this.store.saveWorkspace(current)
      }
      return { recipients: valid }
    }
    // Group-chat peer turns: explicit `$Name`/`!Name` mentions name the
    // recipients and replace the default leader routing. One refused peer
    // never aborts the rest; only a message with no valid addressee fails.
    // Deliberate product rule: the user is the authorizer, so a user post
    // naming a roster agent outside the workspace fails loudly with a clear
    // message and no leader fallback. Agent posts follow the existing
    // approval model instead (contact needs user consent; see toolSendMessage
    // and the handoff path).
    const mentioned = parseMentions(text, workspace, state.agents).filter((agentID) => {
      const agent = state.agents[agentID]
      return agent && !agent.archived && workspace.memberIDs.includes(agentID)
    })
    const archivedRefs = archivedMentionRefs(text, state.agents)
    const archivedTokens = new Set(archivedRefs.flatMap((agent) => [`$${agent.name}`.toLowerCase(), `!${agent.name}`.toLowerCase(), `$${agent.id}`.toLowerCase(), `!${agent.id}`.toLowerCase()]))
    const outsideRefs = outsideMentionRefs(text, state.agents, workspace.memberIDs, "")
    const outsideTokens = new Set(outsideRefs.flatMap((agent) => [`$${agent.name}`.toLowerCase(), `!${agent.name}`.toLowerCase(), `$${agent.id}`.toLowerCase(), `!${agent.id}`.toLowerCase()]))
    const unknown = unknownMentions(text, workspace, state.agents).filter((token) => !archivedTokens.has(token.toLowerCase()) && !outsideTokens.has(token.toLowerCase()))
    if (mentioned.length === 0 && archivedRefs.length === 0 && unknown.length === 0 && outsideRefs.length === 0 && skillRecipients.length === 0) {
      // No addressee named: the leader takes the turn, exactly as before.
      const recipients = visibleRecipients(text, workspace, state.agents)
      await this.appendMessage(workspace, { author: "user", text, kind: "text" })
      for (const agentID of recipients) {
        await this.createSubtask({
          workspace,
          assigneeID: agentID,
          creatorType: "user",
          title: text.slice(0, 80),
          instruction,
          mode: payload.mode === "edit" ? "edit" : "research",
          dispatchGroupID,
        })
      }
      this.schedule()
      const current = this.store.cloneWorkspace(workspace.id)
      if (current) {
        current.lastActiveAt = now()
        await this.store.saveWorkspace(current)
      }
      return { recipients }
    }
    await this.appendMessage(workspace, { author: "user", text, kind: "text" })
    for (const agent of archivedRefs) {
      await this.appendMessage(workspace, { author: "system", text: peerRefusalText(agent.name, `${agent.name} is archived and cannot take turns.`), kind: "system" })
    }
    for (const token of unknown) {
      await this.appendMessage(workspace, { author: "system", text: peerRefusalText(bareMentionToken(token), "no workspace member matches."), kind: "system" })
    }
    for (const agent of outsideRefs) {
      await this.appendMessage(workspace, { author: "system", text: peerRefusalText(agent.name, `${agent.name} is not a workspace member; add them to the workspace before mentioning.`), kind: "system" })
    }
    const addressed = [...mentioned]
    for (const recipient of skillRecipients) {
      if (!addressed.includes(recipient.agentID)) addressed.push(recipient.agentID)
    }
    if (addressed.length === 0) {
      const bad = [...archivedRefs.map((agent) => `$${agent.name}`), ...unknown, ...outsideRefs.map((agent) => `$${agent.name}`)]
      const available = workspace.memberIDs.map((memberID) => state.agents[memberID]?.name).filter(Boolean).join(", ")
      throw Object.assign(new Error(`Unknown workspace member${bad.length > 1 ? "s" : ""}: ${bad.join(", ") || "no valid recipient"}. Members: ${available}`), { code: "unknown_member" })
    }
    // Per-message fan-out stays inside the per-run cap (handoff maxPerRun
    // parity): extras are refused visibly, never queued silently.
    const cap = state.settings.maxDelegations
    const accepted = addressed.slice(0, Math.max(1, cap))
    for (const agentID of addressed.slice(accepted.length)) {
      const agent = state.agents[agentID]
      await this.appendMessage(workspace, { author: "system", text: peerRefusalText(agent?.name ?? agentID, `the delegation limit is ${cap}.`), kind: "system" })
    }
    for (const agentID of accepted) {
      const recipient = skillRecipient.get(agentID)
      await this.createPeerTurn({
        workspace,
        assigneeID: agentID,
        askerKind: "user",
        title: recipient ? skillWorkTitle(text, recipient) : text.slice(0, 80),
        instruction,
        mode: payload.mode === "edit" ? "edit" : "research",
        skillGrants: recipient?.generalSkills,
        dispatchGroupID,
      })
    }
    this.schedule()
    const current = this.store.cloneWorkspace(workspace.id)
    if (current) {
      current.lastActiveAt = now()
      await this.store.saveWorkspace(current)
    }
    return { recipients: accepted }
  }

  /**
   * Idempotency lookup for one unit of work. Suppression honors the row
   * lifetime: matching run-scoped work suppresses resubmission while it is
   * retained (live or terminal; finished rows purge after 24h retention).
   * Root user work hashes its dispatch group, so a repeated command is a new
   * unit of work. Intentional re-asks stay explicit — `task.retry`/
   * `task.restart` re-queue the same row, and asking from a different
   * parent/run hashes a different key.
   */
  private findWorkByKey(workspaceID: string, key: string): Subtask | undefined {
    return this.store.subtasks().find(
      (task) => task.workspaceID === workspaceID && task.queueKey === key,
    )
  }

  private async createWorkItem(input: {
    workspace: Workspace
    parentID?: string
    assigneeID: string
    creatorType: "user" | "agent"
    creatorAgentID?: string
    title: string
    instruction: string
    constraints?: string
    expected?: string
    mode?: "research" | "edit"
    stage?: "initial" | "synthesis"
    kind?: string
    skillGrants?: string[]
    turn?: { correlationID?: string; askerKind: "user" | "agent"; askerID?: string }
    dispatchGroupID?: string
  }): Promise<{ subtask: Subtask; deduped: boolean }> {
    const kind: WorkKind = parseWorkKind(input.kind ?? "delegation") ?? (() => { throw invalidInput(`Unknown work kind: ${String(input.kind)}.`) })()
    // Central propagation: explicit group (a user command fan-out or an
    // approval payload) wins, then the parent/run group, then a new group.
    // Retry/restart/reassign/cancel never pass through here, so they keep the
    // row's existing identity.
    const state = this.store.read()
    const parent = input.parentID ? state.subtasks[input.parentID] : undefined
    const dispatchGroupID = inheritDispatchGroupID({
      explicit: input.dispatchGroupID,
      parent,
      subtasks: state.subtasks,
    })
    const key = workKey({
      actor: input.creatorAgentID ?? input.creatorType,
      workspaceID: input.workspace.id,
      kind,
      parentID: input.parentID,
      dispatchGroupID,
      assigneeID: input.assigneeID,
      title: input.title,
      instruction: input.instruction,
      constraints: input.constraints,
      expected: input.expected,
    })
    // Idempotency: resubmitting the same run-scoped work returns the existing
    // item instead of executing twice — while its row is retained, live or
    // terminal. Root work also hashes its dispatch group, so a repeated user
    // command is a new dispatch. Retention expiry ends suppression naturally.
    const existing = this.findWorkByKey(input.workspace.id, key)
    if (existing) return { subtask: existing, deduped: true }
    const at = now()
    const subtask: Subtask = {
      id: id("task"),
      workspaceID: input.workspace.id,
      parentID: input.parentID,
      creatorType: input.creatorType,
      creatorAgentID: input.creatorAgentID,
      assigneeID: input.assigneeID,
      title: input.title,
      instruction: input.instruction,
      constraints: input.constraints,
      expected: input.expected,
      mode: input.mode ?? "research",
      state: "pending",
      stage: input.stage ?? "initial",
      outcome: "pending",
      interrupted: false,
      awaitingChildren: false,
      attempts: 0,
      createdAt: at,
      workKind: kind,
      queueKey: key,
      dispatchGroupID,
      deadlineAt: at + DEADLINE_MS,
      ...(input.skillGrants && input.skillGrants.length > 0 ? { skillGrants: [...new Set(input.skillGrants)] } : {}),
    }
    if (input.turn) {
      // The turn correlation derives from the work key (outside the fan-out
      // prefix) unless the caller approves an explicit one: control legs
      // trace back to the hop without consuming the run's budget.
      const correlationID = input.turn.correlationID ?? correlationIDForKey("turn", key)
      subtask.turn = { correlationID, askerKind: input.turn.askerKind, askerID: input.turn.askerID }
    }
    await this.store.saveSubtask(subtask)
    this.noteWorkChanged(subtask)
    await this.appendMessage(input.workspace, {
      author: "system",
      // Slice C assignment event (ticket #59, brief §2.2 — verbatim): one
      // system line per assignment, naming the owning agent. Idempotent
      // resubmits return the existing row above without appending again.
      text: `→ Assigned to $${this.agentName(subtask.assigneeID)}: ${subtask.title}`,
      kind: "task",
      taskID: subtask.id,
      correlationID: subtask.turn?.correlationID,
    })
    return { subtask, deduped: false }
  }

  /**
   * One group-chat peer turn: a durable work item through the same queue,
   * lease, retry, and recovery machinery as delegations. The recipient's
   * reply in the asking transcript IS the relay — no second leg is queued —
   * attributed via the message agentID and linked by correlationID.
   */
  private async createPeerTurn(input: {
    workspace: Workspace
    parentID?: string
    assigneeID: string
    askerKind: "user" | "agent"
    askerID?: string
    creatorType?: "user" | "agent"
    correlationID?: string
    title: string
    instruction: string
    constraints?: string
    expected?: string
    mode?: "research" | "edit"
    skillGrants?: string[]
    dispatchGroupID?: string
  }): Promise<{ subtask: Subtask; deduped: boolean }> {
    return this.createWorkItem({
      workspace: input.workspace,
      parentID: input.parentID,
      assigneeID: input.assigneeID,
      creatorType: input.creatorType ?? (input.askerKind === "agent" ? "agent" : "user"),
      creatorAgentID: input.askerID,
      title: input.title,
      instruction: input.instruction,
      constraints: input.constraints,
      expected: input.expected,
      mode: input.mode,
      kind: "turn",
      skillGrants: input.skillGrants,
      dispatchGroupID: input.dispatchGroupID,
      turn: { correlationID: input.correlationID, askerKind: input.askerKind, askerID: input.askerID },
    })
  }

  private async createSubtask(input: {
    workspace: Workspace
    parentID?: string
    assigneeID: string
    creatorType: "user" | "agent"
    creatorAgentID?: string
    title: string
    instruction: string
    constraints?: string
    expected?: string
    mode?: "research" | "edit"
    stage?: "initial" | "synthesis"
    skillGrants?: string[]
    dispatchGroupID?: string
  }): Promise<Subtask> {
    return (await this.createWorkItem(input)).subtask
  }

  private async appendMessage(workspace: Workspace, input: { author: Message["author"]; agentID?: string; displayAuthor?: string; text: string; kind: Message["kind"]; taskID?: string; streaming?: boolean; interrupted?: boolean; correlationID?: string; updatedAt?: number }): Promise<Message> {
    return this.store.appendMessage(workspace.id, {
      id: id("msg"),
      author: input.author,
      agentID: input.agentID,
      displayAuthor: input.displayAuthor,
      text: input.text,
      kind: input.kind,
      taskID: input.taskID,
      streaming: input.streaming,
      interrupted: input.interrupted,
      correlationID: input.correlationID,
      createdAt: now(),
      ...(input.updatedAt !== undefined ? { updatedAt: input.updatedAt } : {}),
    })
  }

  /** Leader triage is derived from the one-run General-skill grant. */
  private isTriageTask(subtask: Subtask): boolean {
    return (subtask.skillGrants?.length ?? 0) > 0
  }

  private delegationDepth(state: SnapshotState, subtaskID: string): number {
    let depth = 0
    let current = state.subtasks[subtaskID]
    while (current?.parentID && depth < 100) {
      depth++
      current = state.subtasks[current.parentID]
    }
    return depth
  }

  private agentName(agentID: string | undefined): string {
    if (!agentID) return "Unassigned"
    return this.store.agent(agentID)?.name ?? "Unknown agent"
  }

  /**
   * Approval-created work inherits the group captured in the approval payload
   * (written when the request was raised), then the parent task's group, then
   * a fresh group for an approval raised outside any dispatch.
   */
  private approvalDispatchGroupID(approval: Approval, parentID?: string): string {
    const stored = typeof approval.payload?.dispatchGroupID === "string" ? approval.payload.dispatchGroupID.trim() : ""
    if (stored) return stored
    const parent = parentID ? this.store.subtask(parentID) : undefined
    if (!parent) return newDispatchGroupID()
    return resolveDispatchGroupID(parent, this.store.read().subtasks) ?? newDispatchGroupID()
  }

  private async delegateFromUser(payload: Json): Promise<Subtask> {
    const state = this.store.read()
    const workspace = state.workspaces[payload.workspaceID]
    if (!workspace) throw Object.assign(new Error("Workspace not found."), { code: "not_found" })
    if (workspace.paused) throw Object.assign(new Error("This workspace is paused. Resume it before delegating work."), { code: "workspace_paused" })
    if (!workspace.memberIDs.includes(payload.assigneeID)) throw Object.assign(new Error("That agent is not a workspace member."), { code: "not_member" })
    const parent = payload.parentID ? state.subtasks[payload.parentID] : undefined
    if (parent && parent.workspaceID !== workspace.id) throw Object.assign(new Error("The parent subtask belongs to another workspace."), { code: "invalid_parent" })
    if (parent && this.isTriageTask(parent)) {
      throw Object.assign(new Error("A leader triage task cannot be delegated from; the leader must use the skill or delegate its own guidance."), { code: "triage_no_delegate" })
    }
    if (parent && this.delegationDepth(state, parent.id) >= state.settings.maxDepth) throw Object.assign(new Error(`The delegation depth limit is ${state.settings.maxDepth}.`), { code: "delegation_depth" })
    // A user-initiated delegation from inside a task joins that task's group;
    // a root delegation is its own one-task dispatch.
    const dispatchGroupID = parent ? resolveDispatchGroupID(parent, state.subtasks) : newDispatchGroupID()
    const subtask = await this.createSubtask({
      workspace,
      parentID: parent?.id,
      assigneeID: payload.assigneeID,
      creatorType: "user",
      title: String(payload.title ?? "Delegated task"),
      instruction: String(payload.instruction ?? ""),
      constraints: payload.constraints,
      expected: payload.expected,
      mode: payload.mode === "edit" ? "edit" : "research",
      dispatchGroupID,
    })
    return subtask
  }

  private async stopSubtaskRun(subtask: Subtask): Promise<void> {
    const runID = subtask.activeRunID ?? [...this.activeRuns.values()].find((run) => run.subtaskID === subtask.id)?.id
    if (!runID) {
      subtask.activeRunID = undefined
      return
    }
    const run = this.activeRuns.get(runID)
    if (run) {
      await this.ctx.session.interrupt({ sessionID: run.sessionID, resume: false }).catch(() => undefined)
      this.activeRuns.delete(runID)
      this.runBySession.delete(run.sessionID)
    }
    subtask.activeRunID = undefined
  }

  private async claimForRetry(subtask: Subtask): Promise<void> {
    await this.stopSubtaskRun(subtask)
    await this.settlePendingApprovals(subtask.id, "Subtask retried by the user.")
    subtask.state = "pending"
    subtask.outcome = "pending"
    subtask.error = undefined
    subtask.interrupted = false
    subtask.approvalID = undefined
    subtask.activeRunID = undefined
    subtask.claimedBy = undefined
    subtask.leaseUntil = undefined
    subtask.retryAfter = undefined
    subtask.repliedAt = undefined
    subtask.finishedAt = undefined
    subtask.stoppedAt = undefined
    subtask.deadlineAt = now() + DEADLINE_MS
    await this.store.saveSubtask(subtask)
    this.noteWorkChanged(subtask)
  }

  private async retryTask(subtaskID: string): Promise<Subtask> {
    const subtask = this.store.cloneSubtask(subtaskID)
    if (!subtask) throw Object.assign(new Error("Subtask not found."), { code: "not_found" })
    await this.claimForRetry(subtask)
    return subtask
  }

  private async restartTask(subtaskID: string): Promise<Subtask> {
    const subtask = this.store.cloneSubtask(subtaskID)
    if (!subtask) throw Object.assign(new Error("Subtask not found."), { code: "not_found" })
    await this.claimForRetry(subtask)
    const workspace = this.store.workspace(subtask.workspaceID)
    if (workspace) await this.appendMessage(workspace, { author: "system", text: `Restarting work: ${subtask.title}`, kind: "system", taskID: subtask.id })
    return subtask
  }

  private async cancelTask(subtaskID: string): Promise<Subtask> {
    const subtask = this.store.cloneSubtask(subtaskID)
    if (!subtask) throw Object.assign(new Error("Subtask not found."), { code: "not_found" })
    await this.stopSubtaskRun(subtask)
    await this.settlePendingApprovals(subtask.id, "Subtask cancelled by the user.")
    const at = now()
    subtask.state = "replied"
    subtask.outcome = "failed"
    subtask.error = "Cancelled by user."
    subtask.activeRunID = undefined
    subtask.approvalID = undefined
    subtask.claimedBy = undefined
    subtask.leaseUntil = undefined
    subtask.retryAfter = undefined
    subtask.repliedAt = at
    subtask.finishedAt = at
    subtask.stoppedAt = at
    await this.store.saveSubtask(subtask)
    this.noteWorkChanged(subtask)
    return subtask
  }

  private async reassignTask(subtaskID: string, assigneeID: string): Promise<Subtask> {
    const subtask = this.store.cloneSubtask(subtaskID)
    const workspace = subtask ? this.store.workspace(subtask.workspaceID) : undefined
    if (!subtask || !workspace) throw Object.assign(new Error("Subtask not found."), { code: "not_found" })
    if (this.isTriageTask(subtask) && assigneeID !== workspace.leaderID) {
      throw Object.assign(new Error("A leader triage task can only be reassigned to the workspace leader."), { code: "triage_leader_only" })
    }
    if (!workspace.memberIDs.includes(assigneeID)) throw Object.assign(new Error("That agent is not a workspace member."), { code: "not_member" })
    await this.stopSubtaskRun(subtask)
    await this.settlePendingApprovals(subtask.id, "Subtask reassigned by the user.")
    subtask.assigneeID = assigneeID
    subtask.state = "pending"
    subtask.outcome = "pending"
    subtask.error = undefined
    subtask.interrupted = false
    subtask.approvalID = undefined
    subtask.activeRunID = undefined
    subtask.claimedBy = undefined
    subtask.leaseUntil = undefined
    subtask.retryAfter = undefined
    subtask.repliedAt = undefined
    subtask.finishedAt = undefined
    subtask.stoppedAt = undefined
    subtask.deadlineAt = now() + DEADLINE_MS
    await this.store.saveSubtask(subtask)
    return subtask
  }

  private async resolveApproval(payload: Json): Promise<Approval> {
    const approval = this.store.cloneApproval(payload.id)
    if (!approval) throw Object.assign(new Error("Approval not found."), { code: "not_found" })
    const requested = payload.approve ? "approved" : "rejected"
    if (approval.status !== "pending") {
      if (approval.status === requested) return approval
      throw Object.assign(new Error("Approval was already resolved differently."), { code: "already_resolved" })
    }
    if (approval.subtaskID && (approval.kind === "ask_person" || approval.kind === "interrupted" || approval.kind === "outside_roster" || approval.kind === "cross_project" || approval.kind === "promote_memory")) {
      const subtask = this.store.subtask(approval.subtaskID)
      if (!subtask || subtask.state === "replied") {
        approval.status = "rejected"
        approval.resolvedAt = now()
        approval.resolution = "Subtask is no longer waiting for this decision."
        await this.store.saveApproval(approval)
        return approval
      }
    }
    // Promote rows carry no subtask: they go stale when the memory is
    // already promoted or gone, so resolving must not re-apply.
    if (approval.kind === "promote_memory") {
      const memory = approval.payload?.memoryID ? this.store.memory(String(approval.payload.memoryID)) : undefined
      if (!memory || memory.deletedAt || memory.scope === "global") {
        approval.status = "rejected"
        approval.resolvedAt = now()
        approval.resolution = "Memory is no longer waiting for this decision."
        await this.store.saveApproval(approval)
        return approval
      }
    }
    // Native mirrors are never stale-guarded: the host request may still be
    // live after our run ended, so an explicit resolve always replies.
    if (approval.kind === "native") {
      const sessionID = String(approval.payload?.sessionID ?? "")
      const requestID = String(approval.payload?.permissionID ?? approval.payload?.requestID ?? "")
      approval.status = requested
      approval.resolvedAt = now()
      approval.resolution = payload.resolution
      await this.store.saveApproval(approval)
      // Least privilege: approve grants once; reject denies. Fail-open when
      // the host already dropped the request — the row still resolves.
      if (sessionID && requestID) {
        await this.replyNativePermission(sessionID, requestID, payload.approve ? "once" : "reject", typeof payload.resolution === "string" ? payload.resolution : undefined).catch(() => undefined)
      }
      this.schedule()
      return approval
    }
    approval.status = requested
    approval.resolvedAt = now()
    approval.resolution = payload.resolution
    await this.store.saveApproval(approval)
    if (!payload.approve) {
      if (approval.kind === "interrupted" && approval.subtaskID) {
        const subtask = this.store.cloneSubtask(approval.subtaskID)
        if (subtask) {
          const at = now()
          subtask.state = "replied"
          subtask.outcome = "failed"
          subtask.error = "Interrupted work discarded by the user."
          subtask.interrupted = false
          subtask.approvalID = undefined
          subtask.claimedBy = undefined
          subtask.leaseUntil = undefined
          subtask.retryAfter = undefined
          subtask.repliedAt = at
          subtask.finishedAt = at
          subtask.stoppedAt = at
          await this.store.saveSubtask(subtask)
        }
      }
      if (approval.kind === "ask_person" && approval.subtaskID) {
        const subtask = this.store.cloneSubtask(approval.subtaskID)
        if (subtask) {
          const at = now()
          subtask.state = "replied"
          subtask.outcome = "failed"
          subtask.error = "User rejected the request."
          subtask.approvalID = undefined
          subtask.claimedBy = undefined
          subtask.leaseUntil = undefined
          subtask.retryAfter = undefined
          subtask.repliedAt = at
          subtask.finishedAt = at
          await this.store.saveSubtask(subtask)
        }
      }
      return approval
    }
    if (approval.kind === "interrupted" && approval.subtaskID) {
      const subtask = this.store.cloneSubtask(approval.subtaskID)
      if (subtask) await this.claimForRetry(subtask)
    }
    if (approval.kind === "ask_person" && approval.subtaskID) {
      const subtask = this.store.cloneSubtask(approval.subtaskID)
      if (subtask) {
        subtask.state = "pending"
        subtask.outcome = "pending"
        subtask.approvalID = undefined
        subtask.interrupted = false
        subtask.activeRunID = undefined
        subtask.claimedBy = undefined
        subtask.leaseUntil = undefined
        subtask.retryAfter = undefined
        subtask.finishedAt = undefined
        subtask.stoppedAt = undefined
        subtask.deadlineAt = now() + DEADLINE_MS
        subtask.instruction += `\n\nUser answer: ${approval.resolution ?? "Approved."}`
        await this.store.saveSubtask(subtask)
      }
    }
    if (approval.kind === "outside_roster" && approval.payload) {
      const workspace = approval.workspaceID ? this.store.workspace(approval.workspaceID) : undefined
      if (workspace) {
        if (approval.payload.peerTurn) {
          // Approved cross-boundary peer turn: the turn is the effect. It
          // runs through the same queue, lease, and retry machinery as any
          // member turn, with the approved correlation carried through.
          const recipientID = String(approval.payload.assigneeID ?? "")
          const turnTitle = String(approval.payload.title ?? approval.detail)
          const parentID = typeof approval.payload.parentID === "string" ? String(approval.payload.parentID) : approval.subtaskID
          const dispatchGroupID = this.approvalDispatchGroupID(approval, parentID)
          const turnKey = workKey({
            actor: approval.agentID ?? "agent",
            workspaceID: workspace.id,
            kind: "turn",
            parentID,
            dispatchGroupID,
            assigneeID: recipientID,
            title: turnTitle,
            instruction: String(approval.payload.instruction ?? approval.detail),
            constraints: approval.payload.constraints ? String(approval.payload.constraints) : undefined,
            expected: approval.payload.expected ? String(approval.payload.expected) : undefined,
          })
          const correlationID = typeof approval.payload.correlationID === "string" && approval.payload.correlationID ? String(approval.payload.correlationID) : correlationIDForKey("turn", turnKey)
          if (!this.findWorkByKey(workspace.id, turnKey)) {
            const at = now()
            const turn: Subtask = {
              id: id("task"),
              workspaceID: workspace.id,
              parentID,
              creatorType: "agent",
              creatorAgentID: approval.agentID,
              assigneeID: recipientID,
              title: turnTitle,
              instruction: String(approval.payload.instruction ?? approval.detail),
              constraints: approval.payload.constraints ? String(approval.payload.constraints) : undefined,
              expected: approval.payload.expected ? String(approval.payload.expected) : undefined,
              mode: "research",
              state: "pending",
              stage: "initial",
              outcome: "pending",
              interrupted: false,
              awaitingChildren: false,
              attempts: 0,
              createdAt: at,
              workKind: "turn",
              queueKey: turnKey,
              dispatchGroupID,
              deadlineAt: at + DEADLINE_MS,
              turn: { correlationID, askerKind: "agent", askerID: approval.agentID },
            }
            await this.store.saveSubtask(turn)
            this.noteWorkChanged(turn)
            await this.appendMessage(workspace, {
              author: "system",
              text: `→ ${this.agentName(recipientID)}: ${turnTitle}`,
              kind: "task",
              taskID: turn.id,
              correlationID,
            })
            this.schedule()
          }
        } else if (approval.payload.handoff) {
          // Approved cross-boundary handoff: the hop is the effect. It runs
          // through the same queue, lease, and retry machinery as any hop.
          const recipientID = String(approval.payload.assigneeID ?? "")
          const hopTask = String(approval.payload.title ?? approval.detail ?? "Handoff")
          const hopParentID = typeof approval.payload.parentID === "string" ? String(approval.payload.parentID) : approval.subtaskID
          const hopSenderID = typeof approval.payload.senderID === "string" ? String(approval.payload.senderID) : (approval.agentID ?? "")
          const dispatchGroupID = this.approvalDispatchGroupID(approval, hopParentID)
          const hopKey = handoffWorkKey({
            actor: hopSenderID,
            workspaceID: workspace.id,
            parentID: hopParentID,
            recipientID,
            task: hopTask,
            instruction: typeof approval.payload.instruction === "string" ? approval.payload.instruction : undefined,
            constraints: approval.payload.constraints ? String(approval.payload.constraints) : undefined,
            expected: approval.payload.expected ? String(approval.payload.expected) : undefined,
          })
          const correlationID = typeof approval.payload.correlationID === "string" && approval.payload.correlationID ? String(approval.payload.correlationID) : correlationIDForKey("handoff", hopKey)
          if (!this.findWorkByKey(workspace.id, hopKey)) {
            const at = now()
            const hop: Subtask = {
              id: id("task"),
              workspaceID: workspace.id,
              parentID: typeof approval.payload.parentID === "string" ? String(approval.payload.parentID) : approval.subtaskID,
              creatorType: "agent",
              creatorAgentID: approval.agentID,
              assigneeID: recipientID,
              title: hopTask,
              instruction: String(approval.payload.instruction ?? approval.detail),
              constraints: approval.payload.constraints ? String(approval.payload.constraints) : undefined,
              expected: approval.payload.expected ? String(approval.payload.expected) : undefined,
              mode: "research",
              state: "pending",
              stage: "initial",
              outcome: "pending",
              interrupted: false,
              awaitingChildren: false,
              attempts: 0,
              createdAt: at,
              workKind: "handoff",
              queueKey: hopKey,
              dispatchGroupID,
              deadlineAt: at + DEADLINE_MS,
              handoff: {
                correlationID,
                senderID: typeof approval.payload.senderID === "string" ? String(approval.payload.senderID) : (approval.agentID ?? ""),
                recipientID,
                depth: typeof approval.payload.depth === "number" ? approval.payload.depth : 1,
                parentID: typeof approval.payload.parentID === "string" ? String(approval.payload.parentID) : approval.subtaskID,
                path: typeof approval.payload.path === "string" ? String(approval.payload.path) : undefined,
              },
            }
            await this.store.saveSubtask(hop)
            this.noteWorkChanged(hop)
            const recipientName = this.store.agent(recipientID)?.name ?? recipientID
            // Ticket #73: concise system ack — no policy sentence, no ref, no agent bubble.
            await this.appendMessage(workspace, {
              author: "system",
              text: handoffGroupAckText(recipientName, hopTask),
              kind: "system",
              taskID: hop.id,
              correlationID,
            })
            this.schedule()
          }
        } else if (approval.payload.assigneeID) {
          const parentID = typeof approval.payload.parentID === "string" ? String(approval.payload.parentID) : approval.subtaskID
          await this.createSubtask({
            workspace,
            assigneeID: String(approval.payload.assigneeID ?? ""),
            creatorType: "agent",
            creatorAgentID: approval.agentID,
            title: String(approval.payload.title ?? "Outside-roster task"),
            instruction: String(approval.payload.instruction ?? approval.detail),
            constraints: approval.payload.constraints ? String(approval.payload.constraints) : undefined,
            expected: approval.payload.expected ? String(approval.payload.expected) : undefined,
            mode: approval.payload.mode === "edit" ? "edit" : "research",
            dispatchGroupID: this.approvalDispatchGroupID(approval, parentID),
          })
        } else if (approval.payload.agentID && approval.payload.text) {
          // Approved cross-boundary direct message: send once with the
          // envelope correlation approved by the user.
          await this.chatSend(String(approval.payload.agentID), undefined, String(approval.payload.text), {
            fromID: approval.agentID,
            correlationID: typeof approval.payload.correlationID === "string" && approval.payload.correlationID ? String(approval.payload.correlationID) : undefined,
          })
        }
      }
    }
    if (approval.kind === "promote_memory" && approval.payload?.memoryID) {
      const memory = this.store.cloneMemory(String(approval.payload.memoryID))
      if (memory) {
        memory.scope = "global"
        memory.updatedAt = now()
        memory.history.push({ at: now(), action: "promoted", by: "user" })
        await this.store.saveMemory(memory)
      }
    }
    if (approval.kind === "cross_project" && approval.payload?.text) {
      const memory: Memory = {
        id: id("mem"),
        agentID: approval.agentID,
        workspaceID: approval.workspaceID,
        scope: "global",
        text: String(approval.payload.text),
        origin: "manual",
        source: `approved-share:${approval.agentID ?? "agent"}`,
        createdAt: now(),
        updatedAt: now(),
        history: [{ at: now(), action: "shared", by: "user" }],
      }
      await this.store.saveMemory(memory)
    }
    return approval
  }

  private async addMemory(payload: Json): Promise<Memory> {
    const text = String(payload.text ?? "").trim()
    if (!text) throw Object.assign(new Error("Memory text is required."), { code: "empty" })
    const scope = (payload.scope ?? "project") as MemoryScope
    const at = now()
    const memory: Memory = {
      id: id("mem"),
      agentID: payload.agentID,
      workspaceID: payload.workspaceID,
      scope,
      text,
      origin: "manual",
      source: String(payload.source ?? "user"),
      createdAt: at,
      updatedAt: at,
      history: [{ at, action: "created", by: "user" }],
    }
    await this.store.saveMemory(memory)
    return memory
  }

  private async updateMemory(payload: Json): Promise<Memory> {
    const memory = this.store.cloneMemory(payload.id)
    if (!memory || memory.deletedAt) throw Object.assign(new Error("Memory not found."), { code: "not_found" })
    const text = String(payload.text ?? memory.text).trim()
    if (!text) throw Object.assign(new Error("Memory text is required."), { code: "empty" })
    memory.text = text
    memory.updatedAt = now()
    memory.history.push({ at: now(), action: "edited", by: "user" })
    await this.store.saveMemory(memory)
    return memory
  }

  private async deleteMemory(payload: Json): Promise<any> {
    const memory = this.store.cloneMemory(payload.id)
    if (!memory || memory.deletedAt) throw Object.assign(new Error("Memory not found."), { code: "not_found" })
    memory.deletedAt = now()
    memory.updatedAt = now()
    memory.history.push({ at: now(), action: "deleted", by: "user" })
    await this.store.saveMemory(memory)
    return { deleted: true, note: "Existing native transcripts are not erased." }
  }

  private async promoteMemory(payload: Json): Promise<any> {
    const memory = this.store.memory(payload.id)
    if (!memory || memory.deletedAt) throw Object.assign(new Error("Memory not found."), { code: "not_found" })
    if (memory.scope === "global") return { alreadyGlobal: true }
    const approval: Approval = {
      id: id("approval"),
      workspaceID: memory.workspaceID,
      agentID: memory.agentID,
      kind: "promote_memory",
      source: "memory",
      title: `Promote memory for ${this.agentName(memory.agentID)}`,
      detail: memory.text,
      payload: { memoryID: memory.id },
      status: "pending",
      createdAt: now(),
    }
    await this.store.saveApproval(approval)
    return approval
  }

  private async updateSettings(payload: Json): Promise<Settings> {
    const patch: Partial<Settings> = {}
    if (payload.maxActiveRuns !== undefined) patch.maxActiveRuns = Math.max(1, Number(payload.maxActiveRuns))
    if (payload.maxDelegations !== undefined) patch.maxDelegations = Math.max(1, Number(payload.maxDelegations))
    if (payload.maxDepth !== undefined) patch.maxDepth = Math.max(1, Number(payload.maxDepth))
    if (payload.synthesis !== undefined) patch.synthesis = Boolean(payload.synthesis)
    return this.store.updateSettings(patch)
  }

  private toolSession(state: SnapshotState, sessionID: string): { workspace?: Workspace; agent?: Agent } {
    const run = this.runForSession(state, sessionID)
    if (run) return { workspace: state.workspaces[run.workspaceID], agent: state.agents[run.agentID] }
    const binding = Object.values(state.bindings).find((item) => item.sessionID === sessionID)
    if (!binding) return {}
    return {
      workspace: binding.kind === "home" ? undefined : state.workspaces[binding.workspaceID],
      agent: state.agents[binding.agentID],
    }
  }

  private requireToolSession(state: SnapshotState, sessionID: string): { workspace: Workspace; agent: Agent } | undefined {
    const found = this.toolSession(state, sessionID)
    return found.workspace && found.agent ? { workspace: found.workspace, agent: found.agent } : undefined
  }

  private async installTools(): Promise<void> {
    await this.ctx.tool.transform((editor: any) => {
      editor.namespace({ name: "ensemble", description: "Ensemble workspace collaboration." })
      editor.add({
        name: "workspace_info",
        options: { namespace: "ensemble", codemode: false },
        description: "Show the current Ensemble workspace, directory, leader, members, and paused state.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_input: Json, context: any) => this.toolWorkspaceInfo(context),
      })
      editor.add({
        name: "list_workspaces",
        options: { namespace: "ensemble", codemode: false },
        description: "List Ensemble workspaces and their directories, leaders, and members.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => this.toolListWorkspaces(),
      })
      editor.add({
        name: "list_agents",
        options: { namespace: "ensemble", codemode: false },
        description: "List the Ensemble roster, workspace membership, and busy state.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => this.toolListAgents(),
      })
      editor.add({
        name: "task_status",
        options: { namespace: "ensemble", codemode: false },
        description: "List pending, working, and replied Ensemble subtasks.",
        input: { type: "object", properties: { workspaceID: { type: "string" } }, additionalProperties: false },
        execute: async (input: Json, context: any) => this.toolTaskStatus(input, context),
      })
      editor.add({
        name: "send_message",
        options: { namespace: "ensemble", codemode: false },
        description: "Post a message to the group chat or queue a direct message to an agent.",
        input: {
          type: "object",
          properties: { kind: { type: "string", enum: ["workspace", "agent"] }, id: { type: "string" }, text: { type: "string" } },
          required: ["kind", "text"],
          additionalProperties: false,
        },
        execute: async (input: Json, context: any) => this.toolSendMessage(input, context),
      })
      editor.add({
        name: "handoff",
        options: { namespace: "ensemble", codemode: false },
        description: "Queue a typed hop to a teammate; the answer is relayed back here. The asking turn stays open until it lands — never follow a handoff with ensemble_delegate. Write a self-authored instruction for the recipient (what to do, context, expected output) — never paste the user's message verbatim; task stays the short display title.",
        input: {
          type: "object",
          properties: { task: { type: "string" }, instruction: { type: "string" }, summary: { type: "string" }, path: { type: "string" }, to: { type: "string" }, constraints: { type: "string" }, expected: { type: "string" } },
          required: ["task", "summary", "path"],
          additionalProperties: false,
        },
        execute: async (input: Json, context: any) => this.toolHandoff(input, context),
      })
      editor.add({
        name: "delegate",
        options: { namespace: "ensemble", codemode: false },
        description: "Delegate a typed subtask to another workspace member and record it on the board. Ensemble leader only — peers hand off with ensemble_handoff, which already queues the hop.",
        input: {
          type: "object",
          properties: {
            assignee: { type: "string" },
            title: { type: "string" },
            instruction: { type: "string" },
            constraints: { type: "string" },
            expected: { type: "string" },
            mode: { type: "string", enum: ["research", "edit"] },
          },
          required: ["assignee", "title", "instruction"],
          additionalProperties: false,
        },
        execute: async (input: Json, context: any) => this.toolDelegate(input, context),
      })
      editor.add({
        name: "review",
        options: { namespace: "ensemble", codemode: false },
        description: "Decide each item in a batch review turn (delegate, start, end, or dismiss). The batch closes only when every item is decided; non-leader reviewers hand it onward to the leader.",
        input: {
          type: "object",
          properties: {
            batch: { type: "string" },
            decisions: {
              type: "array",
              items: {
                type: "object",
                properties: { item: { type: "string" }, action: { type: "string" }, assignee: { type: "string" }, note: { type: "string" } },
                required: ["item", "action"],
                additionalProperties: false,
              },
            },
            hand_to: { type: "string" },
          },
          required: ["batch", "decisions"],
          additionalProperties: false,
        },
        execute: async (input: Json, context: any) => this.toolReview(input, context),
      })
      editor.add({
        name: "ask_person",
        options: { namespace: "ensemble", codemode: false },
        description: "Ask the user for a judgment call and pause this subtask until they answer.",
        input: { type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false },
        execute: async (input: Json, context: any) => this.toolAsk(input, context),
      })
      editor.add({
        name: "remember",
        options: { namespace: "ensemble", codemode: false },
        description: "Save durable project, workspace, or cross-project knowledge. Cross-project knowledge needs approval.",
        input: {
          type: "object",
          properties: { text: { type: "string" }, scope: { type: "string", enum: ["project", "workspace", "global"] } },
          required: ["text", "scope"],
          additionalProperties: false,
        },
        execute: async (input: Json, context: any) => this.toolRemember(input, context),
      })
      editor.add({
        name: "share",
        options: { namespace: "ensemble", codemode: false },
        description: "Request authorization before cross-project or private-transcript disclosure.",
        input: {
          type: "object",
          properties: { text: { type: "string" }, scope: { type: "string", enum: ["cross_project", "private_transcript"] } },
          required: ["text", "scope"],
          additionalProperties: false,
        },
        execute: async (input: Json, context: any) => this.toolShare(input, context),
      })
    })
  }

  private async toolWorkspaceInfo(context: any): Promise<{ content: string }> {
    await this.store.refreshBindings()
    const state = this.store.read()
    const found = this.toolSession(state, context.sessionID)
    if (!found.workspace) return { content: "This session is not bound to an Ensemble workspace." }
    const leader = state.agents[found.workspace.leaderID]
    return {
      content: JSON.stringify({
        workspace: found.workspace.name,
        directory: found.workspace.directory,
        leader: { id: found.workspace.leaderID, name: leader?.name ?? found.workspace.leaderID },
        members: found.workspace.memberIDs.map((memberID) => ({ id: memberID, name: state.agents[memberID]?.name ?? memberID })),
        paused: found.workspace.paused,
        synthesis: found.workspace.synthesis,
      }),
    }
  }

  private async toolListWorkspaces(): Promise<{ content: string }> {
    await this.store.refreshBindings()
    const state = this.store.read()
    return {
      content: JSON.stringify(
        Object.values(state.workspaces).map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          directory: workspace.directory,
          leader: { id: workspace.leaderID, name: state.agents[workspace.leaderID]?.name ?? workspace.leaderID },
          members: workspace.memberIDs.map((memberID) => ({ id: memberID, name: state.agents[memberID]?.name ?? memberID })),
          paused: workspace.paused,
        })),
      ),
    }
  }

  private async toolListAgents(): Promise<{ content: string }> {
    await this.store.refreshBindings()
    const state = this.store.read()
    return { content: JSON.stringify(Object.values(state.agents).filter((agent) => !agent.archived).map((agent) => ({ id: agent.id, name: agent.name, title: agent.title, busy: [...this.activeRuns.values()].some((run) => run.agentID === agent.id), home: agent.homeDirectory }))) }
  }

  private async toolTaskStatus(input: Json, context: any): Promise<{ content: string }> {
    await this.store.refreshBindings()
    const state = this.store.read()
    const found = this.toolSession(state, context.sessionID)
    if (input.workspaceID && found.workspace && input.workspaceID !== found.workspace.id) return { content: "Cross-workspace reads require ensemble_share approval." }
    const workspaceID = found.workspace?.id ?? input.workspaceID
    const at = Date.now()
    const tasks = Object.values(state.subtasks).filter((task) => !workspaceID || task.workspaceID === workspaceID)
    return { content: JSON.stringify(tasks.map((task) => ({ id: task.id, title: task.title, state: task.state, status: deriveWorkStatus(task, at), outcome: task.outcome, attempts: task.attempts, queueKey: task.queueKey, leaseUntil: task.leaseUntil, deadlineAt: task.deadlineAt, assignee: task.assigneeID, parent: task.parentID, dispatchGroupID: task.dispatchGroupID, resultMessageID: task.resultMessageID, workKind: task.workKind, handoff: task.handoff, turn: task.turn }))) }
  }

  private async toolSendMessage(input: Json, context: any): Promise<{ content: string }> {
    await this.store.refreshBindings()
    const state = this.store.read()
    const found = this.requireToolSession(state, context.sessionID)
    if (!found) return { content: "This session is not bound to an Ensemble workspace." }
    const text = String(input.text ?? "").trim()
    if (!text) return { content: "Message text is empty." }
    if (input.kind === "workspace") {
      const workspace = input.id ? state.workspaces[String(input.id)] : found.workspace
      if (!workspace) return { content: "Workspace not found." }
      if (workspace.id !== found.workspace.id) return { content: "Cross-workspace posts require ensemble_share approval." }
      await this.appendMessage(workspace, { author: "agent", agentID: found.agent.id, text, kind: "text" })
      // Agent-to-agent asks from the group chat: `$Name`/`!Name` mentions in
      // an agent post create peer turns through the same queue, caps, and
      // approvals as user mentions. Reply text alone never creates turns, so
      // answers cannot fan out into loops. Self-mentions are skipped.
      const mentionIDs = parseMentions(text, workspace, state.agents).filter((agentID) => {
        const agent = state.agents[agentID]
        return agent && !agent.archived && workspace.memberIDs.includes(agentID) && agentID !== found.agent.id
      })
      const archivedRefs = archivedMentionRefs(text, state.agents).filter((agent) => agent.id !== found.agent.id)
      const outsideRefs = outsideMentionRefs(text, state.agents, workspace.memberIDs, found.agent.id)
      const excludedTokens = new Set([
        ...archivedRefs.flatMap((agent) => [`$${agent.name}`.toLowerCase(), `!${agent.name}`.toLowerCase(), `$${agent.id}`.toLowerCase(), `!${agent.id}`.toLowerCase()]),
        ...outsideRefs.flatMap((agent) => [`$${agent.name}`.toLowerCase(), `!${agent.name}`.toLowerCase(), `$${agent.id}`.toLowerCase(), `!${agent.id}`.toLowerCase()]),
      ])
      const unknown = unknownMentions(text, workspace, state.agents).filter((token) => !excludedTokens.has(token.toLowerCase()))
      for (const agent of archivedRefs) {
        await this.appendMessage(workspace, { author: "system", text: peerRefusalText(agent.name, `${agent.name} is archived and cannot take turns.`), kind: "system" })
      }
      for (const token of unknown) {
        await this.appendMessage(workspace, { author: "system", text: peerRefusalText(bareMentionToken(token), "no workspace member matches."), kind: "system" })
      }
      const run = this.runForSession(state, context.sessionID)
      const runTask = run ? state.subtasks[run.subtaskID] : undefined
      // One agent post is one dispatch: its mentions and approvals share one
      // group even when the post comes from outside a live run.
      const dispatchGroupID = runTask ? resolveDispatchGroupID(runTask, state.subtasks) : newDispatchGroupID()
      const askingDepth = run ? this.delegationDepth(state, run.subtaskID) : 0
      // Outside-roster contact follows the existing approval model: the user
      // consents first, then the approved turn runs through the same queue.
      for (const agent of outsideRefs) {
        const correlationID = newCorrelationID()
        const approval: Approval = {
          id: id("approval"),
          workspaceID: workspace.id,
          subtaskID: run?.subtaskID,
          agentID: found.agent.id,
          kind: "outside_roster",
          source: "workspace",
          title: `${found.agent.name} wants to ask ${agent.name} in the group chat`,
          detail: text,
          payload: {
            peerTurn: true,
            assigneeID: agent.id,
            title: text.slice(0, 80),
            instruction: text,
            mode: "research",
            correlationID,
            parentID: run?.subtaskID,
            senderID: found.agent.id,
            depth: askingDepth + 1,
            dispatchGroupID,
          },
          status: "pending",
          createdAt: now(),
        }
        await this.store.saveApproval(approval)
        await this.appendMessage(workspace, { author: "system", text: `Approval needed: contact $${agent.name}`, kind: "approval", taskID: run?.subtaskID })
      }
      const created: string[] = []
      const refused: string[] = []
      const refusalNotes: string[] = []
      const noteRefusal = (name: string, reason: string): void => {
        refused.push(name)
        refusalNotes.push(peerRefusalText(name, reason))
      }
      for (const agent of archivedRefs) noteRefusal(agent.name, `${agent.name} is archived and cannot take turns.`)
      for (const token of unknown) noteRefusal(bareMentionToken(token), "no workspace member matches.")
      for (const agent of outsideRefs) refused.push(agent.name)
      for (const agentID of mentionIDs) {
        const agent = state.agents[agentID]
        if (!agent) continue
        if (askingDepth >= state.settings.maxDepth) {
          const reason = `the delegation depth limit is ${state.settings.maxDepth}.`
          await this.appendMessage(workspace, { author: "system", text: peerRefusalText(agent.name, reason), kind: "system" })
          noteRefusal(agent.name, reason)
          continue
        }
        if (run) {
          const siblings = this.store.subtasks().filter((item) => item.parentID === run.subtaskID)
          if (siblings.length >= state.settings.maxDelegations) {
            const reason = `the delegation limit is ${state.settings.maxDelegations}.`
            await this.appendMessage(workspace, { author: "system", text: peerRefusalText(agent.name, reason), kind: "system" })
            noteRefusal(agent.name, reason)
            continue
          }
        }
        const { deduped } = await this.createPeerTurn({
          workspace,
          parentID: run?.subtaskID,
          assigneeID: agentID,
          askerKind: "agent",
          askerID: found.agent.id,
          title: text.slice(0, 80),
          instruction: text,
          mode: "research",
          dispatchGroupID,
        })
        created.push(agent.name)
        void deduped
      }
      this.schedule()
      if (created.length === 0 && outsideRefs.length === 0) {
        const detail = refusalNotes.length > 0 ? ` ${refusalNotes[0]}` : ""
        return { content: refused.length > 0 ? `Posted to #${workspace.name}. No peer turns created (${refused.length} refused).${detail}` : `Posted to #${workspace.name}.` }
      }
      const asked = created.length > 0 ? ` Asked $${created.join(", $")}; the answer will arrive here.` : ""
      const pendingNote = outsideRefs.length > 0 ? ` Approval required before contacting $${outsideRefs.map((agent) => agent.name).join(", $")}.` : ""
      return { content: `Posted to #${workspace.name}.${asked}${pendingNote}` }
    }
    if (input.kind === "agent") {
      const rawID = String(input.id ?? "").trim()
      if (!rawID) return { content: "Agent not found." }
      const target = state.agents[rawID] ?? Object.values(state.agents).find((agent) => agent.name.toLowerCase() === rawID.toLowerCase())
      if (!target || target.archived) return { content: "Agent not found." }
      const correlationID = typeof input.correlationID === "string" && input.correlationID.trim() ? String(input.correlationID).trim().slice(0, 80) : newCorrelationID()
      // Cross-boundary contact follows the existing approval model: reaching
      // an agent outside the workspace roster needs user consent, exactly
      // like delegate's outside_roster path. Member DMs stay direct.
      if (target.id !== found.agent.id && !found.workspace.memberIDs.includes(target.id)) {
        const run = this.runForSession(state, context.sessionID)
        const approval: Approval = {
          id: id("approval"),
          workspaceID: found.workspace.id,
          subtaskID: run?.subtaskID,
          agentID: found.agent.id,
          kind: "outside_roster",
          source: "workspace",
          title: `${found.agent.name} wants to contact ${target.name}`,
          detail: text,
          payload: { agentID: target.id, text, correlationID },
          status: "pending",
          createdAt: now(),
        }
        await this.store.saveApproval(approval)
        await this.appendMessage(found.workspace, { author: "system", text: `Approval needed: contact $${target.name}`, kind: "approval", taskID: run?.subtaskID })
        return { content: `Approval required before contacting ${target.name}.` }
      }
      const workspaceID = found.workspace.memberIDs.includes(target.id) ? found.workspace.id : undefined
      const result = await this.chatSend(target.id, workspaceID, text, { fromID: found.agent.id, correlationID })
      this.schedule()
      if (result.queued) return { content: `Queued a direct message for ${target.name} (ref ${correlationID}).` }
      return { content: `Sent a direct message to ${target.name} (ref ${correlationID}).` }
    }
    return { content: "kind must be workspace or agent." }
  }

  private async toolHandoff(input: Json, context: any): Promise<{ content: string }> {
    await this.store.refreshBindings()
    const state = this.store.read()
    const found = this.requireToolSession(state, context.sessionID)
    if (!found) return { content: "This session is not bound to an Ensemble workspace." }
    const { workspace, agent: sender } = found
    const fail = async (reason: string): Promise<{ content: string }> => {
      await this.appendMessage(workspace, { author: "system", text: `Handoff refused: ${reason}`, kind: "system" })
      return { content: reason }
    }
    if (workspace.paused) return fail(`workspace ${workspace.name} is paused.`)
    const rawPath = String(input.path ?? "")
    const absolute = resolve(workspace.directory, rawPath)
    const handoffs = resolve(handoffDirectory(workspace.directory))
    if (absolute !== handoffs && !absolute.startsWith(`${handoffs}${sep}`)) {
      return fail("The handoff path must be inside .ensemble/handoffs/.")
    }
    if (!existsSync(absolute) || !statSync(absolute).isFile()) return fail("The handoff file does not exist.")
    const content = readFileSync(absolute, "utf8")
    const parsed = parseHandoffFile(content)
    if (!parsed.ok) return fail(parsed.reason)
    const task = parsed.data.task || String(input.task ?? "").trim()
    if (!task) return fail("The handoff file must include a non-empty task field.")
    const summary = parsed.data.summary ?? (typeof input.summary === "string" ? input.summary.trim() : "") ?? ""
    const constraints = parsed.data.constraints ?? (typeof input.constraints === "string" ? input.constraints.trim() || undefined : undefined)
    const expected = parsed.data.expected ?? (typeof input.expected === "string" ? input.expected.trim() || undefined : undefined)
    // Ticket #73 instruction contract: the recipient-facing brief is the
    // sender's self-authored instruction (file frontmatter wins, tool arg
    // is the fallback), distinct from the short display title. Legacy
    // callers without one keep the title+summary brief for compat.
    const tailored = parsed.data.instruction ?? (typeof input.instruction === "string" ? input.instruction.trim() || undefined : undefined)
    const brief = tailored ?? (summary ? `${task}\n\n${summary}` : task)
    const recipientRef = (typeof input.to === "string" && input.to.trim()) || parsed.data.to || ""
    if (!recipientRef) return fail("The handoff must name a recipient; no recipient was given.")
    const resolved = resolveHandoffRecipient(state, recipientRef)
    if (resolved.status === "unknown") return fail(`No agent matches "${resolved.ref}".`)
    if (resolved.status === "ambiguous") return fail(`"${resolved.ref}" matches more than one agent; name one explicitly.`)
    if (resolved.status === "archived") return fail(`${resolved.agent.name} is archived and cannot receive handoffs.`)
    const recipient = resolved.agent
    const path = relative(workspace.directory, absolute)
    const hopInstruction = `${brief} (${path})`
    if (!workspace.memberIDs.includes(recipient.id)) {
      const run = this.runForSession(state, context.sessionID)
      const runTask = run ? state.subtasks[run.subtaskID] : undefined
      const dispatchGroupID = runTask ? resolveDispatchGroupID(runTask, state.subtasks) : newDispatchGroupID()
      const correlationID = parsed.data.correlationID || newCorrelationID()
      const approval: Approval = {
        id: id("approval"),
        workspaceID: workspace.id,
        subtaskID: run?.subtaskID,
        agentID: sender.id,
        kind: "outside_roster",
        source: "workspace",
        title: `${sender.name} wants to hand off to ${recipient.name}`,
        detail: task,
        payload: { assigneeID: recipient.id, title: task, instruction: hopInstruction, constraints, expected, mode: "research", handoff: true, correlationID, path, depth: (run ? this.delegationDepth(state, run.subtaskID) : 0) + 1, parentID: run?.subtaskID, senderID: sender.id, dispatchGroupID },
        status: "pending",
        createdAt: now(),
      }
      await this.store.saveApproval(approval)
      await this.appendMessage(workspace, { author: "system", text: `Approval needed: contact $${recipient.name}`, kind: "approval", taskID: run?.subtaskID })
      return { content: `Approval required before contacting ${recipient.name}.` }
    }
    const run = this.runForSession(state, context.sessionID)
    // Parentless-hop hole (ticket #70): a handoff called from a session
    // with no live run would orphan the hop (parentID undefined), so the
    // sender's turn could finalize before the answer arrives. Anchor the
    // hop to the sender's newest open task in the workspace instead — the
    // runTask children check then holds the sender in `awaitingChildren`
    // with a visible `Waiting for $Name…` line until the hop is
    // delivered/answered. No second delegate is needed (leader-only;
    // would double-queue under a separate key).
    const askingSubtaskID = run?.subtaskID ?? newestOpenSenderTaskID(state, workspace.id, sender.id)
    const askingTask = askingSubtaskID ? state.subtasks[askingSubtaskID] : undefined
    const dispatchGroupID = askingTask ? resolveDispatchGroupID(askingTask, state.subtasks) : newDispatchGroupID()
    const askingDepth = askingSubtaskID ? this.delegationDepth(state, askingSubtaskID) : 0
    // Idempotency spans terminal rows for the row's lifetime: the handoff hop
    // is the effect, so a retried or resubmitted handoff from the same run
    // returns the existing record instead of executing twice. Checked before
    // the depth/per-run caps so an idempotent replay never turns into a cap
    // refusal. When the original run has already finished, the anchor can be a
    // newer open row (for example an inbound completion hop); fall back to the
    // same logical ask so anchor drift cannot duplicate the hop either.
    const key = handoffWorkKey({ actor: sender.id, workspaceID: workspace.id, parentID: askingSubtaskID, recipientID: recipient.id, task, instruction: brief, constraints, expected })
    const duplicate = this.findWorkByKey(workspace.id, key) ?? (!run ? Object.values(state.subtasks).find((item) =>
      item.workspaceID === workspace.id &&
      item.workKind === "handoff" &&
      item.handoff?.completion !== true &&
      item.handoff?.senderID === sender.id &&
      item.handoff?.recipientID === recipient.id &&
      item.title === task &&
      item.instruction === hopInstruction &&
      (item.constraints ?? "") === (constraints ?? "") &&
      (item.expected ?? "") === (expected ?? "")
    ) : undefined)
    if (duplicate) return { content: handoffDuplicateText(recipient.name, task) }
    // Handoff-specific caps (spec #53): chains stop after one hop, and one
    // run fans out at most HANDOFF_MAX_PER_RUN hops. Only handoff hops count
    // toward the per-run budget — relay/failure-notice legs are messages,
    // not work rows, so control legs never consume it.
    if (askingDepth >= HANDOFF_MAX_DEPTH) {
      return fail(`the handoff depth limit is ${HANDOFF_MAX_DEPTH}.`)
    }
    if (askingSubtaskID) {
      const hops = Object.values(state.subtasks).filter((item) => item.parentID === askingSubtaskID && item.workKind === "handoff")
      if (hops.length >= HANDOFF_MAX_PER_RUN) {
        return fail(`the handoff limit is ${HANDOFF_MAX_PER_RUN} per run.`)
      }
    }
    const at = now()
    const correlationID = parsed.data.correlationID || correlationIDForKey("handoff", key)
    const hop: Subtask = {
      id: id("task"),
      workspaceID: workspace.id,
      parentID: askingSubtaskID,
      creatorType: "agent",
      creatorAgentID: sender.id,
      assigneeID: recipient.id,
      title: task,
      instruction: hopInstruction,
      constraints,
      expected,
      mode: "research",
      state: "pending",
      stage: "initial",
      outcome: "pending",
      interrupted: false,
      awaitingChildren: false,
      attempts: 0,
      createdAt: at,
      workKind: "handoff",
      queueKey: key,
      dispatchGroupID,
      deadlineAt: at + DEADLINE_MS,
      handoff: {
        correlationID,
        senderID: sender.id,
        recipientID: recipient.id,
        depth: askingDepth + 1,
        parentID: askingSubtaskID,
        path,
      },
    }
    await this.store.saveSubtask(hop)
    this.noteWorkChanged(hop)
    // Ticket #73: the group sees only a concise system line. The policy
    // sentence and correlation ref stay in the tool result below, which is
    // the calling model's audience — never an agent bubble.
    await this.appendMessage(workspace, {
      author: "system",
      text: handoffGroupAckText(recipient.name, summary || task),
      kind: "system",
      taskID: hop.id,
      correlationID,
    })
    this.schedule()
    return { content: `Handed to $${recipient.name} for ${task} (ref ${correlationID}). Your turn stays open until the answer arrives here — do not call ensemble_delegate after a handoff (leader-only; would double-queue).` }
  }

  /**
   * Ticket #71 mandatory completion handoff (server-enforced). A non-leader
   * turn that reaches its success finalize without an explicit handoff hop
   * cannot finish silently: the server queues one completion hop carrying
   * the finished content to the workspace leader, and the group shows
   * `Handed to $Leader`. Leader turns may end normally; completion and batch
   * hops never re-handoff (they are terminal deliveries, so chains cannot
   * duplicate work); an explicit handoff satisfies the obligation.
   * Returns the queued hop, or undefined when no hop was needed.
   */
  private async ensureCompletionHandoff(
    finished: Subtask,
    replyText: string,
    children: Subtask[],
  ): Promise<Subtask | undefined> {
    const state = this.store.read()
    const workspace = state.workspaces[finished.workspaceID]
    if (!workspace || workspace.archived || workspace.paused) return undefined
    const finisherID = finished.assigneeID
    if (!finisherID || finisherID === workspace.leaderID) return undefined
    if (finished.handoff?.completion === true || finished.handoff?.batch === true) return undefined
    if (children.some((child) => child.workKind === "handoff" && child.handoff?.completion !== true)) return undefined
    const leader = state.agents[workspace.leaderID]
    if (!leader || leader.archived || !workspace.memberIDs.includes(leader.id)) return undefined
    const finisher = state.agents[finisherID]
    const prior = finished.handoff?.chain ?? (finished.handoff ? [finished.handoff.senderID] : [])
    const route = checkCompletionRoute({ chain: prior, senderID: finisherID, candidateID: leader.id, leaderID: leader.id })
    if (route.decision === "terminate") {
      await this.appendMessage(workspace, {
        author: "system",
        text: completionClosedText(finisher?.name ?? finisherID, finished.title, `the completion chain depth limit is ${COMPLETION_CHAIN_MAX}`),
        kind: "system",
        taskID: finished.id,
      })
      return undefined
    }
    const recipient = state.agents[route.to] ?? leader
    const dispatchGroupID = resolveDispatchGroupID(finished, state.subtasks)
    const key = completionWorkKey({ workspaceID: workspace.id, finishedTaskID: finished.id, recipientID: recipient.id })
    const duplicate = this.findWorkByKey(workspace.id, key)
    if (duplicate) return duplicate
    const at = now()
    const correlationID = correlationIDForKey("handoff", key)
    const content = replyText.trim() || "Work completed."
    const chain = [...prior, finisherID]
    // Ticket #73: the leader receives review work — who finished what with
    // what outcome — not a verbatim forward of the finished title and reply.
    const reviewBrief = completionReviewInstruction({
      finisherName: finisher?.name ?? finisherID,
      title: finished.title,
      content,
      path: finished.handoff?.path,
    })
    // Ticket #71 quiet window: park the delivery briefly so completions for
    // one recipient consolidate into a single batch review instead of racing
    // it. Ticket #77: the parked hop is queued work and the activity surface
    // shows the recipient immediately (queued labels are no longer hidden
    // behind a live row).
    const hop: Subtask = {
      id: id("task"),
      workspaceID: workspace.id,
      parentID: finished.id,
      creatorType: "agent",
      creatorAgentID: finisherID,
      assigneeID: recipient.id,
      title: finished.title,
      instruction: reviewBrief,
      mode: finished.mode,
      state: "pending",
      stage: "initial",
      outcome: "pending",
      interrupted: false,
      awaitingChildren: false,
      attempts: 0,
      createdAt: at,
      workKind: "handoff",
      queueKey: key,
      dispatchGroupID,
      deadlineAt: at + DEADLINE_MS,
      retryAfter: at + COMPLETION_QUIET_WINDOW_MS,
      handoff: {
        correlationID,
        senderID: finisherID,
        recipientID: recipient.id,
        depth: chain.length,
        parentID: finished.id,
        completion: true,
        chain,
      },
    }
    await this.store.saveSubtask(hop)
    this.noteWorkChanged(hop)
    // Ticket #73: concise system ack — no policy sentence, no ref, no agent bubble.
    await this.appendMessage(workspace, {
      author: "system",
      text: handoffGroupAckText(recipient.name, finished.title),
      kind: "system",
      taskID: hop.id,
      correlationID,
    })
    this.defer(COMPLETION_QUIET_WINDOW_MS, () => {
      void this.maybeConsolidateCompletionBatch(workspace.id, recipient.id, dispatchGroupID).finally(() => this.schedule())
    })
    this.schedule()
    return hop
  }

  /**
   * Ticket #71 batched review. Pending completion handoffs for one recipient
   * coalesce into a single consolidated review turn after the quiet window
   * (or a later trigger when the recipient is free — the batch itself runs
   * through the normal queue). The review lists sender, task title, outcome,
   * and handoff path per item; grouped items wait for the batch and never
   * race it as direct hops. A second trigger with new arrivals extends the
   * open batch instead of opening another.
   *
   * Ticket #135: consolidation is group-scoped. Each dispatch group owns its
   * own review batch, so one command's completion can never keep another
   * command's group alive or merge unrelated outcomes into one review.
   */
  private async maybeConsolidateCompletionBatch(workspaceID: string, recipientID: string, dispatchGroupID?: string): Promise<void> {
    const state = this.store.read()
    const workspace = state.workspaces[workspaceID]
    const recipient = state.agents[recipientID]
    if (!workspace || workspace.archived || workspace.paused || !recipient || recipient.archived) return
    if (!workspace.memberIDs.includes(recipientID)) return
    const resolved = Object.values(state.subtasks).map((task) => ({
      ...task,
      dispatchGroupID: resolveDispatchGroupID(task, state.subtasks) ?? task.dispatchGroupID,
    }))
    if (!dispatchGroupID) {
      const groups = new Map(resolved.map((task) => [task.id, task.dispatchGroupID]))
      const groupsWithCandidates = new Set(
        groupCompletionCandidates(resolved, workspaceID, recipientID)
          .map((itemID) => groups.get(itemID))
          .filter((group): group is string => Boolean(group)),
      )
      for (const group of groupsWithCandidates) {
        await this.maybeConsolidateCompletionBatch(workspaceID, recipientID, group)
      }
      return
    }
    const ids = groupCompletionCandidates(resolved, workspaceID, recipientID, dispatchGroupID)
    if (ids.length === 0) return
    // A quiet-window batch may still be waiting to run when one more completion
    // lands. Extend that pending batch even for a single late item; once it has
    // started it can no longer absorb review items.
    const openBatch = this.store.subtasks().find(
      (task) =>
        task.workspaceID === workspaceID &&
        task.workKind === "handoff" &&
        task.assigneeID === recipientID &&
        task.handoff?.batch === true &&
        task.state === "pending" &&
        resolveDispatchGroupID(task, state.subtasks) === dispatchGroupID,
    )
    if (openBatch?.handoff) {
      const batch = this.store.cloneSubtask(openBatch.id)
      if (!batch?.handoff) return
      const merged = [...(batch.handoff.itemIDs ?? [])]
      for (const itemID of ids) {
        const item = this.store.cloneSubtask(itemID)
        if (!item) continue
        item.parentID = batch.id
        if (item.handoff) item.handoff.batchedIn = batch.id
        await this.store.saveSubtask(item)
        if (!merged.includes(item.id)) merged.push(item.id)
      }
      batch.handoff.itemIDs = merged
      batch.title = batchReviewTitle(merged.length)
      // Never run a review before the newest item's quiet window; early
      // consolidation may have grouped an item that is still parked.
      for (const itemID of ids) {
        const item = this.store.subtask(itemID)
        if (item?.retryAfter !== undefined) batch.retryAfter = Math.max(batch.retryAfter ?? 0, item.retryAfter)
      }
      await this.store.saveSubtask(batch)
      this.noteWorkChanged(batch)
      this.schedule()
      return
    }
    if (ids.length < 2) return
    const live = this.store.read()
    const items = ids.map((itemID) => this.store.cloneSubtask(itemID)).filter((item): item is Subtask => Boolean(item))
    if (items.length < 2) return
    const at = now()
    const correlationID = newCorrelationID()
    const chain = [...new Set(items.flatMap((item) => item.handoff?.chain ?? []))]
    const listing = items.map((item) => ({
      id: item.id,
      senderName: live.agents[item.handoff?.senderID ?? ""]?.name ?? "Unknown agent",
      title: item.title,
      outcome: item.outcome,
      path: item.handoff?.path,
    }))
    const batch: Subtask = {
      id: id("task"),
      workspaceID,
      creatorType: "agent",
      creatorAgentID: items[0]?.handoff?.senderID,
      assigneeID: recipientID,
      title: batchReviewTitle(ids.length),
      instruction: batchReviewText(listing, recipient.name),
      mode: "research",
      state: "pending",
      stage: "initial",
      outcome: "pending",
      interrupted: false,
      awaitingChildren: false,
      attempts: 0,
      createdAt: at,
      workKind: "handoff",
      queueKey: `batch:${workspaceID}:${recipientID}:${stableHash(`${dispatchGroupID}\0${ids.join("\0")}`)}`,
      dispatchGroupID,
      deadlineAt: at + DEADLINE_MS,
      // Early consolidation can group an item that is still inside its quiet
      // window; the review itself waits for the newest item.
      retryAfter: Math.max(at, ...items.map((item) => item.retryAfter ?? at)),
      handoff: {
        correlationID,
        senderID: items[0]?.handoff?.senderID ?? recipientID,
        recipientID,
        depth: chain.length + 1,
        completion: true,
        batch: true,
        chain,
        itemIDs: [...ids],
      },
    }
    await this.store.saveSubtask(batch)
    for (const item of items) {
      item.parentID = batch.id
      if (item.handoff) item.handoff.batchedIn = batch.id
      await this.store.saveSubtask(item)
    }
    this.noteWorkChanged(batch)
    await this.appendMessage(workspace, {
      author: "system",
      text: `→ Assigned to $${recipient.name}: ${batch.title}`,
      kind: "task",
      taskID: batch.id,
      correlationID,
    })
    this.schedule()
  }

  /** Grouped completions wait for their open batch review — never race it. */
  private batchBlocked(state: SnapshotState, task: Subtask): boolean {
    const batchedIn = task.handoff?.batchedIn
    if (!batchedIn) return false
    const batch = state.subtasks[batchedIn]
    return !!batch && batch.state !== "replied"
  }

  /**
   * Consolidate every dispatch group that has at least two claimable
   * completion hops for the same recipient. Runs inside the serialized pump
   * before work is claimed, so grouping wins over the quiet-window boundary.
   */
  private async consolidateDueCompletionBatches(): Promise<void> {
    const state = this.store.read()
    const groups = new Map<string, { workspaceID: string; recipientID: string; dispatchGroupID: string; count: number }>()
    for (const task of Object.values(state.subtasks)) {
      if (task.state !== "pending" || task.workKind !== "handoff" || task.handoff?.completion !== true) continue
      if (task.handoff?.batch === true || task.handoff?.batchedIn || !task.assigneeID) continue
      // Ticket #138 follow-through: count siblings that are still inside their
      // quiet window too. If two completions already exist, batching wins over
      // the eligibility boundary; otherwise a pump that runs between two
      // near-simultaneous retryAfter values claims the older hop alone and the
      // group can never form a batch.
      const dispatchGroupID = resolveDispatchGroupID(task, state.subtasks)
      if (!dispatchGroupID) continue
      const key = `${task.workspaceID}\0${task.assigneeID}\0${dispatchGroupID}`
      const current = groups.get(key) ?? { workspaceID: task.workspaceID, recipientID: task.assigneeID, dispatchGroupID, count: 0 }
      current.count++
      groups.set(key, current)
    }
    for (const group of groups.values()) {
      if (group.count < 2) continue
      await this.maybeConsolidateCompletionBatch(group.workspaceID, group.recipientID, group.dispatchGroupID)
    }
  }

  /**
   * Ticket #71 structured per-item review. The batch recipient acts per item
   * (`delegate`, `start`, `end`, `dismiss`); `delegate` stays leader-only so
   * mandatory handoff never becomes delegate-after-handoff by another name.
   * The batch closes only when every item is acted on or dismissed: the
   * leader ends it, a non-leader hands it onward (default leader).
   */
  private async toolReview(input: Json, context: any): Promise<{ content: string }> {
    await this.store.refreshBindings()
    const state = this.store.read()
    const found = this.requireToolSession(state, context.sessionID)
    if (!found) return { content: "This session is not bound to an Ensemble workspace." }
    const { workspace, agent: reviewer } = found
    const batchID = typeof input.batch === "string" ? input.batch.trim() : ""
    const batch = batchID ? state.subtasks[batchID] : undefined
    if (!batch || batch.workspaceID !== workspace.id || batch.workKind !== "handoff" || batch.handoff?.batch !== true) {
      return { content: "That batch review was not found in this workspace." }
    }
    if (batch.state === "replied") return { content: "That batch review is already closed." }
    if (batch.assigneeID !== reviewer.id) {
      const owner = batch.assigneeID ? this.agentName(batch.assigneeID) : "its recipient"
      return { content: `Only $${owner} can review this batch.` }
    }
    const parsed = parseReviewDecisions(input)
    if (!parsed.ok) return { content: parsed.reason }
    const itemIDs = batch.handoff.itemIDs ?? []
    const lines: string[] = []
    for (const decision of parsed.decisions) {
      if (!itemIDs.includes(decision.item)) {
        lines.push(`${decision.item}: refused — not part of this batch.`)
        continue
      }
      const item = this.store.cloneSubtask(decision.item)
      if (!item || item.handoff?.batchedIn !== batch.id || item.handoff?.decided !== undefined) {
        lines.push(`${decision.item}: refused — already decided or no longer in this batch.`)
        continue
      }
      lines.push(await this.applyReviewDecision(workspace, batch, item, reviewer, decision))
    }
    const latest = this.store.read()
    const current = this.store.cloneSubtask(batch.id)
    const decidedBy: Record<string, string | undefined> = {}
    for (const itemID of current?.handoff?.itemIDs ?? []) {
      decidedBy[itemID] = latest.subtasks[itemID]?.handoff?.decided
    }
    if (current && batchAllDecided(current.handoff?.itemIDs ?? [], decidedBy)) {
      lines.push(await this.closeBatchReview(workspace, current, reviewer, typeof input.hand_to === "string" ? input.hand_to : undefined))
    } else {
      const decided = Object.values(decidedBy).filter((value) => value !== undefined).length
      lines.push(`Batch stays open: ${decided} of ${itemIDs.length} decided.`)
    }
    return { content: lines.join("\n") }
  }

  private async applyReviewDecision(
    workspace: Workspace,
    batch: Subtask,
    item: Subtask,
    reviewer: Agent,
    decision: ReviewDecision,
  ): Promise<string> {
    const at = now()
    const note = decision.note ? ` (note: ${decision.note})` : ""
    if (decision.action === "delegate") {
      // Delegate stays leader-only: a non-leader review cannot assign work
      // to a third agent, so mandatory handoff never smuggles in
      // delegate-after-handoff.
      if (reviewer.id !== workspace.leaderID) {
        return `${item.id} (${item.title}): refused — only the workspace leader ($${this.agentName(workspace.leaderID)}) can delegate subtasks.`
      }
      const ref = (decision.assignee ?? "").trim()
      const target = this.store.agents().find((agent) => agent.id === ref || agent.name.toLowerCase() === ref.toLowerCase())
      if (!target || target.archived || !workspace.memberIDs.includes(target.id)) {
        return `${item.id} (${item.title}): refused — ${ref || "no assignee"} is not available.`
      }
      const created = await this.createWorkItem({
        workspace,
        parentID: batch.id,
        assigneeID: target.id,
        creatorType: "agent",
        creatorAgentID: reviewer.id,
        title: item.title,
        instruction: item.instruction,
        constraints: item.constraints,
        expected: decision.note ?? item.expected,
      })
      item.state = "replied"
      item.outcome = "succeeded"
      item.repliedAt = at
      item.finishedAt = at
      if (item.handoff) {
        item.handoff.decided = "delegated"
        item.handoff.answeredByID = reviewer.id
      }
      await this.store.saveSubtask(item)
      this.noteWorkChanged(item)
      this.schedule()
      return `${item.id} (${item.title}): delegated to $${target.name}${note}${created.deduped ? " (already queued)" : ""}.`
    }
    if (decision.action === "start") {
      item.assigneeID = reviewer.id
      item.state = "pending"
      item.outcome = "pending"
      item.error = undefined
      item.retryAfter = undefined
      item.activeRunID = undefined
      item.claimedBy = undefined
      item.leaseUntil = undefined
      if (item.handoff) {
        item.handoff.decided = "started"
        item.handoff.batchedIn = undefined
      }
      await this.store.saveSubtask(item)
      this.noteWorkChanged(item)
      this.schedule()
      return `${item.id} (${item.title}): started — assigned to $${reviewer.name}${note}.`
    }
    item.state = "replied"
    item.repliedAt = at
    item.finishedAt = at
    if (item.handoff) {
      item.handoff.answeredByID = reviewer.id
      item.handoff.decided = decision.action === "dismiss" ? "dismissed" : "ended"
    }
    if (decision.action === "dismiss") {
      item.outcome = "succeeded"
      item.stoppedAt = at
    } else {
      item.outcome = "succeeded"
    }
    await this.store.saveSubtask(item)
    this.noteWorkChanged(item)
    return `${item.id} (${item.title}): ${decision.action === "dismiss" ? "dismissed" : "ended"}${note}.`
  }

  /**
   * Batch closure: only when every item is acted on or dismissed. The leader
   * ends the batch; a non-leader hands it onward (default leader) under the
   * same loop guards, so mandatory handoff cannot loop forever.
   */
  private async closeBatchReview(workspace: Workspace, batch: Subtask, reviewer: Agent, handTo?: string): Promise<string> {
    const itemIDs = batch.handoff?.itemIDs ?? []
    if (reviewer.id === workspace.leaderID) {
      const at = now()
      batch.state = "replied"
      batch.outcome = "succeeded"
      batch.awaitingChildren = false
      batch.repliedAt = at
      batch.finishedAt = at
      await this.store.saveSubtask(batch)
      this.noteWorkChanged(batch)
      await this.appendMessage(workspace, {
        author: "system",
        text: `Review closed: ${batch.title} — ${itemIDs.length} decided.`,
        kind: "system",
        taskID: batch.id,
      })
      if (batch.parentID) await this.maybeSynthesize(batch.parentID)
      return "Batch closed: every item decided."
    }
    let candidateID = workspace.leaderID
    const ref = (handTo ?? "").trim()
    if (ref) {
      const target = this.store.agents().find((agent) => agent.id === ref || agent.name.toLowerCase() === ref.toLowerCase())
      if (target && !target.archived && workspace.memberIDs.includes(target.id)) candidateID = target.id
    }
    const prior = batch.handoff?.chain ?? []
    const route = checkCompletionRoute({ chain: prior, senderID: reviewer.id, candidateID, leaderID: workspace.leaderID })
    const at = now()
    batch.state = "replied"
    batch.outcome = "succeeded"
    batch.awaitingChildren = false
    batch.repliedAt = at
    batch.finishedAt = at
    await this.store.saveSubtask(batch)
    this.noteWorkChanged(batch)
    if (route.decision === "terminate") {
      await this.appendMessage(workspace, {
        author: "system",
        text: completionClosedText(reviewer.name, batch.title, `the completion chain depth limit is ${COMPLETION_CHAIN_MAX}`),
        kind: "system",
        taskID: batch.id,
      })
      if (batch.parentID) await this.maybeSynthesize(batch.parentID)
      return "Batch closed: the onward chain reached its depth cap, so the batch ends here."
    }
    const target = this.store.agent(route.to)
    const summary = itemIDs
      .map((itemID) => {
        const item = this.store.subtask(itemID)
        return item ? `- ${item.title} (${item.handoff?.decided ?? "undecided"})` : undefined
      })
      .filter(Boolean)
      .join("\n")
    const chain = [...prior, reviewer.id]
    const dispatchGroupID = resolveDispatchGroupID(batch, this.store.read().subtasks)
    const key = completionWorkKey({ workspaceID: workspace.id, finishedTaskID: batch.id, recipientID: route.to })
    if (!this.findWorkByKey(workspace.id, key)) {
      const correlationID = correlationIDForKey("handoff", key)
      const hop: Subtask = {
        id: id("task"),
        workspaceID: workspace.id,
        parentID: batch.id,
        creatorType: "agent",
        creatorAgentID: reviewer.id,
        assigneeID: route.to,
        title: `Review follow-up: ${batch.title}`,
        instruction: `Review follow-up: ${batch.title}\n\nDecided by $${reviewer.name}:\n${summary}`,
        mode: "research",
        state: "pending",
        stage: "initial",
        outcome: "pending",
        interrupted: false,
        awaitingChildren: false,
        attempts: 0,
        createdAt: at,
        workKind: "handoff",
        queueKey: key,
        dispatchGroupID,
        deadlineAt: at + DEADLINE_MS,
        retryAfter: at + COMPLETION_QUIET_WINDOW_MS,
        handoff: {
          correlationID,
          senderID: reviewer.id,
          recipientID: route.to,
          depth: chain.length,
          parentID: batch.id,
          completion: true,
          chain,
        },
      }
      await this.store.saveSubtask(hop)
      this.noteWorkChanged(hop)
      // Ticket #73: concise system ack — no policy sentence, no ref, no agent bubble.
      await this.appendMessage(workspace, {
        author: "system",
        text: handoffGroupAckText(target?.name ?? route.to, batch.title),
        kind: "system",
        taskID: hop.id,
        correlationID,
      })
      this.defer(COMPLETION_QUIET_WINDOW_MS, () => {
        void this.maybeConsolidateCompletionBatch(workspace.id, route.to, dispatchGroupID).finally(() => this.schedule())
      })
      this.schedule()
    }
    if (batch.parentID) await this.maybeSynthesize(batch.parentID)
    return `Batch handed to $${target?.name ?? route.to}: every item decided.`
  }

  private async toolDelegate(input: Json, context: any): Promise<{ content: string }> {
    await this.store.refreshBindings()
    const state = this.store.read()
    const found = this.requireToolSession(state, context.sessionID)
    if (!found) return { content: "This session is not bound to an Ensemble workspace." }
    const { workspace, agent } = found
    const run = this.runForSession(state, context.sessionID)
    const subtask = run ? state.subtasks[run.subtaskID] : undefined
    const dispatchGroupID = subtask ? resolveDispatchGroupID(subtask, state.subtasks) : newDispatchGroupID()
    // Every refusal below is posted to the group chat as well as returned to
    // the caller: a tool-result string alone is invisible from the board's
    // perspective, which read as silently missing delegation state.
    if (workspace.paused) {
      await this.appendMessage(workspace, { author: "system", text: `Delegation refused: workspace ${workspace.name} is paused.`, kind: "system" })
      return { content: "This workspace is paused." }
    }
    if (workspace.leaderID !== agent.id) {
      await this.appendMessage(workspace, { author: "system", text: `Delegation refused: only the workspace leader (${this.agentName(workspace.leaderID)}) can delegate subtasks.`, kind: "system" })
      return { content: "Only the workspace leader can delegate subtasks." }
    }
    const target = Object.values(state.agents).find((item) => item.name.toLowerCase() === String(input.assignee).toLowerCase() || item.id === input.assignee)
    if (!target || target.archived) {
      await this.appendMessage(workspace, { author: "system", text: `Delegation refused: ${String(input.assignee)} is not available.`, kind: "system" })
      return { content: "That agent is unavailable." }
    }
    if (subtask && this.delegationDepth(state, subtask.id) >= state.settings.maxDepth) {
      await this.appendMessage(workspace, { author: "system", text: `Delegation refused: the delegation depth limit is ${state.settings.maxDepth}.`, kind: "system" })
      return { content: `The delegation depth limit is ${state.settings.maxDepth}.` }
    }
    if (subtask) {
      const children = Object.values(state.subtasks).filter((item) => item.parentID === subtask.id)
      if (children.length >= state.settings.maxDelegations) {
        await this.appendMessage(workspace, { author: "system", text: `Delegation refused: the delegation limit is ${state.settings.maxDelegations}.`, kind: "system" })
        return { content: `The delegation limit is ${state.settings.maxDelegations}.` }
      }
    }
    if (!workspace.memberIDs.includes(target.id)) {
      const approval: Approval = {
        id: id("approval"),
        workspaceID: workspace.id,
        subtaskID: subtask?.id,
        agentID: agent.id,
        kind: "outside_roster",
        source: "workspace",
        title: `${agent.name} wants to contact ${target.name}`,
        detail: String(input.instruction),
        payload: { assigneeID: target.id, title: input.title, instruction: input.instruction, constraints: input.constraints, expected: input.expected, mode: input.mode, parentID: subtask?.id, dispatchGroupID },
        status: "pending",
        createdAt: now(),
      }
      await this.store.saveApproval(approval)
      await this.appendMessage(workspace, { author: "system", text: `Approval needed: contact ${target.name}`, kind: "approval", taskID: subtask?.id })
      return { content: `Approval required before contacting ${target.name}.` }
    }
    const { deduped } = await this.createWorkItem({
      workspace,
      parentID: subtask?.id,
      assigneeID: target.id,
      creatorType: "agent",
      creatorAgentID: agent.id,
      title: String(input.title),
      instruction: String(input.instruction),
      constraints: input.constraints ? String(input.constraints) : undefined,
      expected: input.expected ? String(input.expected) : undefined,
      mode: input.mode === "edit" ? "edit" : "research",
      dispatchGroupID,
    })
    this.schedule()
    if (deduped) return { content: `Already delegated to ${target.name}; the reply will arrive in the group chat.` }
    return { content: `Delegated to ${target.name}. The reply will arrive in the group chat.` }
  }

  private async toolAsk(input: Json, context: any): Promise<{ content: string }> {
    await this.store.refreshBindings()
    const state = this.store.read()
    const found = this.requireToolSession(state, context.sessionID)
    if (!found) return { content: "This session is not bound to an Ensemble workspace." }
    const run = this.runForSession(state, context.sessionID)
    const subtask = run ? state.subtasks[run.subtaskID] : undefined
    const approval: Approval = {
      id: id("approval"),
      workspaceID: found.workspace.id,
      subtaskID: subtask?.id,
      agentID: found.agent.id,
      kind: "ask_person",
      source: "agent",
      title: `${found.agent.name} needs your input`,
      detail: String(input.question),
      status: "pending",
      createdAt: now(),
    }
    await this.store.saveApproval(approval)
    if (subtask) {
      const claimed = this.store.cloneSubtask(subtask.id)
      if (claimed) {
        claimed.approvalID = approval.id
        await this.store.saveSubtask(claimed)
      }
    }
    await this.appendMessage(found.workspace, { author: "system", text: `Approval needed: ${input.question}`, kind: "approval", taskID: subtask?.id })
    this.schedule()
    return { content: "Waiting for the user's answer in the approval inbox." }
  }

  private async toolRemember(input: Json, context: any): Promise<{ content: string }> {
    await this.store.refreshBindings()
    const state = this.store.read()
    const found = this.requireToolSession(state, context.sessionID)
    if (!found) return { content: "This session is not bound to an Ensemble workspace." }
    const workspace = found.workspace
    const scope = input.scope as MemoryScope
    const text = String(input.text ?? "").trim()
    if (!text) return { content: "Memory text is empty." }
    const at = now()
    const effectiveScope: MemoryScope = scope === "global" ? "project" : scope
    const memory: Memory = {
      id: id("mem"),
      agentID: found.agent.id,
      workspaceID: workspace.id,
      scope: effectiveScope,
      text,
      origin: "automatic",
      source: `agent:${found.agent.id}`,
      createdAt: at,
      updatedAt: at,
      history: [{ at, action: "created", by: "agent" }],
    }
    await this.store.saveMemory(memory)
    if (scope === "global") {
      const approval: Approval = {
        id: id("approval"),
        workspaceID: workspace.id,
        agentID: found.agent.id,
        kind: "promote_memory",
        source: "memory",
        title: `Promote learned knowledge for ${this.agentName(found.agent.id)}`,
        detail: text,
        payload: { memoryID: memory.id },
        status: "pending",
        createdAt: now(),
      }
      await this.store.saveApproval(approval)
      return { content: `Cross-project memory needs approval: ${approval.id}` }
    }
    return { content: `Saved ${effectiveScope} memory.` }
  }

  private async toolShare(input: Json, context: any): Promise<{ content: string }> {
    await this.store.refreshBindings()
    const state = this.store.read()
    const found = this.requireToolSession(state, context.sessionID)
    if (!found) return { content: "This session is not bound to an Ensemble workspace." }
    const run = this.runForSession(state, context.sessionID)
    const approval: Approval = {
      id: id("approval"),
      workspaceID: found.workspace.id,
      subtaskID: run?.subtaskID,
      agentID: found.agent.id,
      kind: "cross_project",
      source: "workspace",
      title: input.scope === "private_transcript" ? "Share private transcript content" : "Share knowledge across projects",
      detail: String(input.text),
      payload: { text: input.text, scope: input.scope },
      status: "pending",
      createdAt: now(),
    }
    await this.store.saveApproval(approval)
    const workspace = approval.workspaceID ? state.workspaces[approval.workspaceID] : undefined
    if (workspace) await this.appendMessage(workspace, { author: "system", text: `Approval needed: ${approval.title}`, kind: "approval", taskID: approval.subtaskID })
    return { content: `Sharing needs user authorization: ${approval.id}` }
  }

  private runForSession(_state: SnapshotState, sessionID: string): { subtaskID: string; agentID: string; workspaceID: string } | undefined {
    const runID = this.runBySession.get(sessionID)
    if (!runID) return undefined
    const run = this.activeRuns.get(runID)
    return run ? { subtaskID: run.subtaskID, agentID: run.agentID, workspaceID: run.workspaceID } : undefined
  }

  private profileForSession(sessionID: string): string | undefined {
    return this.runForSession(this.store.read(), sessionID)?.agentID
  }

  /**
   * Reap stale leases, retire exhausted work, and purge long-finished rows
   * (ticket #134). Runs on the serialized maintenance timer and before pump
   * work, never on a snapshot read. Never spawns runs — starting work happens
   * only in pump().
   */
  private async reapAndRetire(): Promise<void> {
    const at = now()
    for (const candidate of this.store.subtasks()) {
      if (candidate.state === "replied") continue
      if (candidate.attempts >= MAX_ATTEMPTS || (candidate.deadlineAt !== undefined && at >= candidate.deadlineAt)) {
        const task = this.store.cloneSubtask(candidate.id)
        if (!task) continue
        // Ticket #149: a recovery retire is a real terminal event and must
        // reach the failure sink. Attempt exhaustion and a dead lease are
        // distinct reasons; the row's short error keeps the user-facing text.
        const reason = candidate.attempts >= MAX_ATTEMPTS ? "attempts-exhausted" : "lease-expired"
        task.state = "replied"
        task.outcome = "failed"
        task.error ??= task.attempts >= MAX_ATTEMPTS
          ? `Gave up after ${task.attempts} attempts.`
          : "The work deadline passed before it could finish."
        task.activeRunID = undefined
        task.approvalID = undefined
        task.claimedBy = undefined
        task.leaseUntil = undefined
        task.retryAfter = undefined
        task.repliedAt = at
        task.finishedAt = at
        await this.store.saveSubtask(task)
        this.recordTaskFailure({
          event: "failure.terminal",
          level: "error",
          failureClass: "restart",
          task,
          error: task.error,
          decision: { type: "terminal", reason, attempt: task.attempts, maxAttempts: MAX_ATTEMPTS },
          previousClaim: candidate.claimedBy,
          leaseExpiredAt: candidate.leaseUntil,
          reason,
        })
        this.noteWorkChanged(task)
        await this.settlePendingApprovals(task.id, task.error)
        const workspace = this.store.workspace(task.workspaceID)
        if (workspace && task.workKind === "handoff" && task.handoff) {
          const recipientName = this.store.agent(task.handoff.recipientID)?.name ?? "Unknown agent"
          await this.appendMessage(workspace, { author: "system", text: handoffFailureText(recipientName, task.error ?? "the work could not be delivered.", task.handoff.correlationID), kind: "system", taskID: task.id, correlationID: task.handoff.correlationID })
        } else if (workspace && task.workKind === "turn" && task.turn) {
          const recipientName = this.store.agent(task.assigneeID ?? "")?.name ?? "Unknown agent"
          await this.appendMessage(workspace, { author: "system", text: `Peer turn for $${recipientName} failed: ${task.error ?? "the work could not be delivered."} (ref ${task.turn.correlationID}).`, kind: "system", taskID: task.id, correlationID: task.turn.correlationID })
        }
        // Ticket #136: plain failed work has one canonical terminal event,
        // symmetric with success (the TUI derives it from the task row). The
        // old generic "Subtask failed" line was a duplicate. Correlation-
        // specific handoff/turn notices above remain their own leg.
        continue
      }
      // A claim whose lease expired without a live owner goes back to the
      // queue with its attempt budget intact. Claims held by a live run in
      // this process are never reaped — the run's heartbeat owns them.
      // Ticket #148: a foreign claim with a live lease is deferred, never
      // stolen; only expiry (or a missing lease) proves the owner is gone.
      if (!candidate.claimedBy || this.activeRuns.has(candidate.claimedBy)) continue
      if (candidate.leaseUntil !== undefined && candidate.leaseUntil > at) {
        this.logger?.event("debug", "task", "task.recovery.deferred", {
          workspaceID: candidate.workspaceID,
          taskID: candidate.id,
          dispatchGroupID: candidate.dispatchGroupID,
          claimedBy: candidate.claimedBy,
          leaseUntil: candidate.leaseUntil,
          remainingMs: candidate.leaseUntil - at,
          attempts: candidate.attempts,
        })
        continue
      }
      const previousClaim = candidate.claimedBy
      const leaseExpiredAt = candidate.leaseUntil
      const task = this.store.cloneSubtask(candidate.id)
      if (!task) continue
      task.claimedBy = undefined
      task.leaseUntil = undefined
      task.activeRunID = undefined
      if (task.state === "working") task.state = "pending"
      // Ticket #149: recovery is a failed attempt with its own truth. The row
      // keeps a short transient reason until a successful run clears it.
      task.error = "Recovered after an expired lease; retrying."
      await this.store.saveSubtask(task)
      this.recordTaskFailure({
        event: "failure.attempt",
        level: "warn",
        failureClass: "restart",
        task,
        error: "The work lease expired before the run finished.",
        decision: {
          type: "retry",
          attempt: nextRetryAttempt(task.attempts, MAX_ATTEMPTS),
          maxAttempts: MAX_ATTEMPTS,
          delayMs: 0,
          retryAt: at,
          reason: "lease-expired",
        },
        previousClaim,
        leaseExpiredAt,
        reason: "lease-expired",
      })
      this.logger?.event("warn", "task", "task.recovery.requeued", {
        workspaceID: task.workspaceID,
        taskID: task.id,
        dispatchGroupID: task.dispatchGroupID,
        claimedBy: previousClaim,
        leaseUntil: candidate.leaseUntil,
        attempts: task.attempts,
        state: task.state,
      })
    }
    await this.purgeFinishedWork(at)
  }

  private async purgeFinishedWork(at: number): Promise<void> {
    for (const task of this.store.subtasks()) {
      if (task.state !== "replied") continue
      // Only rows with a known terminal timestamp are eligible. Legacy rows
      // without one are never purged on age suspicion alone.
      const finished = task.finishedAt ?? task.repliedAt
      if (finished === undefined || at - finished < FINISHED_RETENTION_MS) continue
      await this.store.removeSubtask(task.id)
    }
  }

  /**
   * A message whose task is already terminal must never remain `streaming`:
   * a late run result or a cancelled/approval-settled run can leave the row
   * live, and the activity surface would then show a finished task as
   * working. Iterates the store's active streaming-id index, never the whole
   * transcript (ticket #134).
   *
   * Ticket #148: load no longer settles streams, so this is also the lease
   * path. A row survives only while its task holds a live lease; a missing or
   * expired lease means no run is producing text for it. A row with no task
   * link settles once it is older than a full lease window.
   */
  private async settleTerminalStreams(): Promise<void> {
    const at = now()
    for (const { workspaceID, messageID } of this.store.streamingMessages()) {
      const candidate = this.store.message(workspaceID, messageID)
      if (!candidate?.streaming) continue
      const task = candidate.taskID ? this.store.subtask(candidate.taskID) : undefined
      let interrupted: boolean
      if (task) {
        const terminal = task.state === "replied"
        const liveLease = task.leaseUntil !== undefined && task.leaseUntil > at
        if (!terminal && liveLease) continue
        interrupted = terminal ? task.outcome !== "succeeded" : true
      } else {
        if (at - (candidate.updatedAt ?? candidate.createdAt) < LEASE_MS) continue
        interrupted = true
      }
      const message = this.store.cloneMessage(workspaceID, candidate.id)
      if (!message) continue
      // Ticket #149: an empty terminal stream has no answer, and an internal
      // fallback is not one either. Settle both as interrupted even when the
      // task outcome was success; a fallback must never look like a result.
      if (!message.text.trim() || isFallbackReply(message.text)) interrupted = true
      settleStreamMessage(message, message.text || REPLY_INTERRUPTED, interrupted)
      await this.store.saveMessage(message)
    }
  }

  /**
   * Reconcile waiting/stale rows before every schedule pass. Fast child
   * replies and auto completion hops can leave a parent `awaitingChildren`
   * after all real children are terminal, or leave a `working` row whose run
   * is gone; either state wedges the activity surface forever. Completion
   * deliveries are excluded from the wait set. Pure state repair: no run is
   * started here; the normal pump does that.
   *
   * Ticket #134: children are indexed by parent in one pass, so a 5k-task
   * queue is O(n) instead of O(n²).
   */
  private async reconcileWaitingWork(): Promise<void> {
    const tasks = this.store.subtasks()
    const childrenByParent = new Map<string, Subtask[]>()
    for (const task of tasks) {
      if (!task.parentID || task.handoff?.completion === true) continue
      const children = childrenByParent.get(task.parentID)
      if (children) children.push(task)
      else childrenByParent.set(task.parentID, [task])
    }
    for (const candidate of tasks) {
      if (candidate.state === "replied") continue
      // Batch reviews close only through ensemble_review.
      if (candidate.handoff?.batch === true) continue
      const children = childrenByParent.get(candidate.id) ?? []
      if (candidate.awaitingChildren && !children.some((child) => child.state !== "replied")) {
        const task = this.store.cloneSubtask(candidate.id)
        if (!task) continue
        task.awaitingChildren = false
        if (children.length === 0) {
          task.state = "replied"
          task.outcome = "succeeded"
          task.repliedAt = now()
          task.finishedAt = task.repliedAt
          task.activeRunID = undefined
          task.claimedBy = undefined
          task.leaseUntil = undefined
          await this.store.saveSubtask(task)
          this.noteWorkChanged(task)
          continue
        }
        await this.store.saveSubtask(task)
        await this.maybeSynthesize(task.id)
        const latest = this.store.cloneSubtask(task.id)
        if (latest && latest.state !== "replied" && latest.stage === "synthesis" && latest.state === "working" && !latest.activeRunID) {
          latest.state = "pending"
          latest.outcome = "pending"
          latest.awaitingChildren = false
          await this.store.saveSubtask(latest)
          this.noteWorkChanged(latest)
        }
        continue
      }
      const staleRun = candidate.activeRunID !== undefined && !this.activeRuns.has(candidate.activeRunID)
      if (candidate.state === "working" && !candidate.awaitingChildren && !candidate.approvalID && !candidate.claimedBy && (candidate.activeRunID === undefined || staleRun)) {
        const task = this.store.cloneSubtask(candidate.id)
        if (!task) continue
        task.state = "pending"
        task.outcome = "pending"
        task.activeRunID = undefined
        task.retryAfter = undefined
        await this.store.saveSubtask(task)
        this.noteWorkChanged(task)
      }
    }
  }

  private pump(maintainFirst = true): void {
    // A schedule request that lands mid-pass must not be dropped: atomic
    // claim means the in-flight pass already snapshotted state, so re-run
    // after it instead of losing the new work.
    if (this.stopped || this.pumping) {
      this.repump = true
      return
    }
    this.pumping = true
    void (async () => {
      try {
        // Ticket #134: maintenance (config, reap/retire, waiting-work repair,
        // terminal-stream settling) runs before pump work, serialized with the
        // timer. The maintenance timer already ran its repair pass, so it calls
        // pump(false) to claim the work it just repaired.
        if (maintainFirst) await this.maintain()
        // Ticket #135: consolidate eligible completion hops before claiming
        // any of them. Otherwise a pump that fires exactly at the quiet-window
        // boundary can run two grouped completions as separate direct hops and
        // the group-scoped batch never forms.
        await this.consolidateDueCompletionBatches()
        const state = this.store.read()
        const at = now()
        const running = [...this.activeRuns.values()].filter((run) => run.status === "running")
        let slots = state.settings.maxActiveRuns - running.length
        if (slots <= 0) return
        const busyAgents = new Set(running.map((run) => bindingKey(run.workspaceID, run.agentID)))
        // A run that has claimed its row but has not reached the active-run map
        // yet (binding/session setup) still owns its agent. Include claims so a
        // second pump pass cannot start a parallel run for the same agent.
        for (const task of Object.values(state.subtasks)) {
          if (!task.claimedBy || !task.assigneeID || task.state === "replied") continue
          busyAgents.add(bindingKey(task.workspaceID, task.assigneeID))
        }
        const busyEditDirs = new Set(
          running
            .map((run) => state.subtasks[run.subtaskID])
            .filter((task) => task?.mode === "edit")
            .map((task) => state.workspaces[task!.workspaceID]?.directory)
            .filter(Boolean) as string[],
        )
        for (const task of Object.values(state.subtasks)) {
          if (!task.claimedBy || task.mode !== "edit" || task.state === "replied") continue
          const directory = state.workspaces[task.workspaceID]?.directory
          if (directory) busyEditDirs.add(directory)
        }
        const pending = Object.values(state.subtasks)
          .filter((task) => task.state === "pending" && task.assigneeID && !task.approvalID && !task.interrupted && !task.activeRunID && (task.retryAfter === undefined || task.retryAfter <= at) && !this.batchBlocked(state, task))
          .sort((a, b) => a.createdAt - b.createdAt)
        const skipped = (task: Subtask, reason: string, extra: Record<string, unknown> = {}) => {
          if (task.retryAfter === undefined) return
          this.logger?.event("debug", "retry", "retry.skipped", {
            workspaceID: task.workspaceID,
            taskID: task.id,
            dispatchGroupID: task.dispatchGroupID,
            attempt: task.attempts,
            retryAfter: task.retryAfter,
            reason,
            ...extra,
          })
        }
        for (let index = 0; index < pending.length; index++) {
          const task = pending[index]
          if (slots <= 0) {
            this.logger?.event("debug", "retry", "retry.skipped", {
              reason: "slot_full",
              pending: pending.length - index,
              activeSlots: running.length,
              maxActiveRuns: state.settings.maxActiveRuns,
            })
            break
          }
          const workspace = state.workspaces[task.workspaceID]
          const agent = task.assigneeID ? state.agents[task.assigneeID] : undefined
          if (!workspace || workspace.archived || workspace.paused || !agent || agent.archived) {
            skipped(task, workspace?.archived ? "workspace_archived" : workspace?.paused ? "workspace_paused" : "assignee_unavailable")
            continue
          }
          if (busyAgents.has(bindingKey(task.workspaceID, task.assigneeID!))) {
            skipped(task, "agent_busy")
            continue
          }
          const existingBinding = this.store.binding(task.workspaceID, task.assigneeID!)
          if (existingBinding && this.directBusy.has(existingBinding.sessionID)) {
            skipped(task, "direct_busy")
            continue
          }
          // A session with an unresolved native permission holds its agent:
          // never start new work behind a host block.
          if (existingBinding && this.pendingNativeForSession(existingBinding.sessionID)) {
            skipped(task, "native_permission_pending")
            continue
          }
          if (task.mode === "edit" && busyEditDirs.has(workspace.directory)) {
            skipped(task, "edit_directory_busy", { directory: workspace.directory })
            continue
          }
          busyAgents.add(bindingKey(task.workspaceID, task.assigneeID!))
          if (task.mode === "edit") busyEditDirs.add(workspace.directory)
          slots--
          const promise = this.runTask(task.id).finally(() => {
            this.running.delete(promise)
            this.pump()
          })
          this.running.add(promise)
        }
      } finally {
        this.pumping = false
        if (this.repump) {
          this.repump = false
          this.pump()
        }
      }
    })()
  }

  private async handleStreamEvent(event: any): Promise<void> {
    if (event?.type !== "session.text.delta") return
    const data = event.data ?? event
    const live = this.liveBySession.get(String(data.sessionID ?? ""))
    if (!live) return
    const delta = String(data.delta ?? "")
    if (!delta) return
    live.buffer += delta
    // The opening row is persisted just after registration; a delta that
    // lands in between stays buffered and is flushed below, never dropped.
    if (!live.message) return
    // A late native delta after finalization must never resurrect a settled
    // row or overwrite the exact final text.
    if (!live.message.streaming || !this.store.isStreaming(live.message.workspaceID, live.message.id)) return
    live.message.text = live.buffer
    live.message.streaming = true
    live.message.updatedAt = now()
    // Smoothness travels on the coalesced ephemeral event; correctness stays
    // on the durable final patch. A missed event is repaired by that patch.
    this.queueStream(live.message)
    if (now() - live.lastSave > STREAM_CHECKPOINT_MS) {
      live.lastSave = now()
      live.message.updatedAt = live.lastSave
      // Crash recovery checkpoint: durable text, no version, no change ring,
      // no published patch, so checkpoints never cause snapshot churn.
      await this.store.checkpointMessage(live.message).catch(() => undefined)
    }
  }

  private async finalizeStream(message: Message | undefined, text: string, interrupted = false, epoch = 0, workspaceEpoch = 0, workspaceID = ""): Promise<Message | undefined> {
    if (!message) return undefined
    // Ticket #149: an internal fallback (or a blank reply) is never a
    // successful answer. Force it interrupted and hand back no message so a
    // caller can never stamp `resultMessageID` onto placeholder text.
    const fallback = isFallbackReply(text)
    const hasText = text.trim().length > 0
    const settledInterrupted = interrupted || fallback || !hasText
    // Ticket #74: the epoch guard rejects stale content, but the row must
    // still settle — returning before clearing `streaming` left orphaned
    // live rows until the 120 s age filter. Settle and persist on both
    // paths; only the return value signals staleness.
    const current = this.globalEpoch === epoch && (!workspaceID || (this.workspaceEpoch.get(workspaceID) ?? 0) === workspaceEpoch)
    // Drop queued live text before the durable final upsert so a late
    // ephemeral event can never chase the exact final row.
    this.dropStream(message)
    const settledText = !hasText || (fallback && !interrupted) ? REPLY_INTERRUPTED : text
    settleStreamMessage(message, settledText, settledInterrupted)
    await this.store.saveMessage(message)
    return current && !settledInterrupted ? message : undefined
  }

  private async runTask(taskID: string): Promise<void> {
    const task = this.store.cloneSubtask(taskID)
    if (!task || task.state !== "pending" || !task.assigneeID || task.interrupted || task.activeRunID) return
    // Do not run work the queue has retired: the next reapAndRetire pass (or
    // the current one) records the terminal state with its reason preserved.
    if (task.attempts >= MAX_ATTEMPTS) return
    if (task.deadlineAt !== undefined && now() >= task.deadlineAt) return
    if (task.retryAfter !== undefined && now() < task.retryAfter) return
    const workspace = this.store.workspace(task.workspaceID)
    const agent = this.store.agent(task.assigneeID)
    if (!workspace || !agent) return
    const runID = id("run")
    const globalEpoch = this.globalEpoch
    const workspaceEpoch = this.workspaceEpoch.get(task.workspaceID) ?? 0
    const at = now()
    task.state = "working"
    task.outcome = "pending"
    task.attempts++
    task.startedAt = at
    task.interrupted = false
    task.activeRunID = runID
    task.claimedBy = runID
    task.leaseUntil = at + LEASE_MS
    task.deadlineAt ??= at + DEADLINE_MS
    task.retryAfter = undefined
    await this.store.saveSubtask(task)
    // Claim fencing: the claim is only real if the stored row still names
    // this run. A racing writer overwrote it (or the row is gone), so stand
    // down instead of double-running the work. Single-process deployment
    // makes this a last-resort guard; see the sync() claim boundary.
    if (!claimWon(await this.store.readSubtask(task.id), runID)) return
    this.noteWorkChanged(task)
    this.logger?.event("info", "task", "task.claimed", {
      workspaceID: task.workspaceID,
      taskID: task.id,
      dispatchGroupID: task.dispatchGroupID,
      assigneeID: task.assigneeID,
      workKind: task.workKind ?? "delegation",
      mode: task.mode,
      attempt: task.attempts,
      maxAttempts: MAX_ATTEMPTS,
      runID,
      deadlineAt: task.deadlineAt,
    })
    // Heartbeat: renew the lease while this run owns the claim. If the
    // process dies, the lease expires and another pass re-queues the work;
    // if the claim was reaped, renewal stops touching the row.
    const heartbeat = setInterval(() => {
      const stored = this.store.subtask(task.id)
      if (!stored || stored.claimedBy !== runID) return
      const current = this.store.cloneSubtask(task.id)
      if (!current) return
      current.leaseUntil = now() + LEASE_MS
      void this.store.saveSubtask(current)
    }, HEARTBEAT_MS)
    if (typeof (heartbeat as unknown as { unref?: () => void }).unref === "function") {
      ;(heartbeat as unknown as { unref: () => void }).unref()
    }
    const failureContext: TaskFailureContext = { runID }
    const binding = await this.ensureBinding(workspace, agent)
    if (!binding) {
      clearInterval(heartbeat)
      await this.failTask(task, "Could not create a native session.", { context: failureContext, failureClass: "session", reason: "session-unavailable" })
      return
    }
    failureContext.sessionID = binding.sessionID
    if (this.pendingNativeForSession(binding.sessionID)) {
      // The host waits on a user decision for this session: do not pile
      // another prompt behind it. Requeue with a short backoff; the
      // permission reply (host event or user resolve) reschedules.
      clearInterval(heartbeat)
      task.state = "pending"
      task.outcome = "pending"
      task.error = "Waiting for a native permission decision."
      task.activeRunID = undefined
      task.claimedBy = undefined
      task.leaseUntil = undefined
      task.retryAfter = now() + 10_000
      await this.store.saveSubtask(task)
      this.logger?.event("warn", "retry", "retry.scheduled", {
        workspaceID: task.workspaceID,
        taskID: task.id,
        dispatchGroupID: task.dispatchGroupID,
        attempt: task.attempts,
        maxAttempts: MAX_ATTEMPTS,
        delayMs: 10_000,
        retryAfter: task.retryAfter,
        reason: "native-permission-pending",
      })
      this.defer(10_000, () => this.schedule())
      return
    }
    if (this.globalEpoch !== globalEpoch || (this.workspaceEpoch.get(task.workspaceID) ?? 0) !== workspaceEpoch) {
      await this.ctx.session.remove({ sessionID: binding.sessionID }).catch(() => undefined)
      await this.store.removeBinding(task.workspaceID, agent.id).catch(() => undefined)
      return
    }
    const run: Run = { id: runID, subtaskID: task.id, workspaceID: task.workspaceID, agentID: task.assigneeID, sessionID: binding.sessionID, status: "running", startedAt: now() }
    this.activeRuns.set(runID, run)
    this.runBySession.set(binding.sessionID, runID)
    // Register the live slot before the persistence awaits below so a
    // streaming delta that lands in between is buffered, not dropped. The
    // opening row fills the slot in just after it persists. Single occupancy
    // holds by construction (per-agent serialization: one session runs one
    // run at a time); a leftover opening row is finalized as interrupted
    // instead of leaking a stuck streaming row.
    const registration = registerLiveSlot(this.liveBySession, binding.sessionID, now())
    if (registration.orphaned) {
      await this.finalizeStream(registration.orphaned.message, registration.orphaned.buffer || registration.orphaned.message.text || REPLY_INTERRUPTED, true, globalEpoch, workspaceEpoch, task.workspaceID)
    }
    await this.store.saveAgent(agent)
    let live: Message | undefined
    let attemptStartedAt = now()
    let granted = false
    try {
      await this.ctx.session.instructions.entry.put({ sessionID: binding.sessionID, key: "ensemble.v2.identity", value: this.identityForAgent(agent) }).catch(() => undefined)
      live = await this.appendMessage(workspace, { author: "agent", agentID: agent.id, text: "", kind: "text", taskID: task.id, streaming: true, correlationID: task.handoff?.correlationID ?? task.turn?.correlationID, updatedAt: now() })
      const slot = this.liveBySession.get(binding.sessionID)
      if (slot) {
        slot.message = live
        if (slot.buffer) {
          live.text = slot.buffer
          slot.lastSave = now()
          await this.store.saveMessage(live).catch(() => undefined)
        }
      } else {
        this.liveBySession.set(binding.sessionID, { message: live, lastSave: 0, buffer: "" })
      }
      await this.ctx.session.instructions.entry.put({
        sessionID: binding.sessionID,
        key: "ensemble.v2.context",
        value: contextForTask(this.store.read(), task, workspace, agent),
      }).catch(() => undefined)
      // Ticket #103: General skills are a one-run leader grant. Apply the
      // extra allow rules before the prompt; the finally block restores the
      // Skillbox-permission baseline after the turn.
      if (task.skillGrants && task.skillGrants.length > 0) {
        await this.ctx.session.update({
          sessionID: binding.sessionID,
          permissions: skillPermissions([...agent.skillbox, ...task.skillGrants]),
        })
        granted = true
      }
      const models = [agent.mainModel, ...agent.backupModels]
      let result: { text: string; tools: string[]; toolOutcomes: ToolOutcome[]; failure?: any } | undefined
      for (let index = 0; index < models.length; index++) {
        const model = models[index]
        failureContext.providerID = model.providerID
        failureContext.modelID = model.modelID
        failureContext.variant = model.variant
        failureContext.toolOutcomes = undefined
        failureContext.cause = undefined
        if (index > 0) {
          await this.appendMessage(workspace, { author: "system", text: `Model unavailable; switched to ${model.providerID}/${model.modelID}${model.variant ? `#${model.variant}` : ""}.`, kind: "system", taskID: task.id })
          this.logger?.event("warn", "task", "task.model.fallback", {
            workspaceID: task.workspaceID,
            taskID: task.id,
            attempt: task.attempts,
            fallbackIndex: index,
            providerID: model.providerID,
            modelID: model.modelID,
            variant: model.variant,
          })
          if (live) { live.text = ""; this.liveBySession.get(binding.sessionID)!.buffer = ""; this.dropStream(live); await this.store.saveMessage(live) }
        }
        await this.ctx.session.switchModel({ sessionID: binding.sessionID, model: { providerID: model.providerID, id: model.modelID, ...(model.variant ? { variant: model.variant } : {}) } }).catch(() => undefined)
        attemptStartedAt = now()
        failureContext.startedAt = attemptStartedAt
        await this.ctx.session.prompt({ sessionID: binding.sessionID, text: promptForTask(task, task.handoff ? this.agentName(task.handoff.senderID) : task.turn?.askerID ? this.agentName(task.turn.askerID) : undefined), delivery: "steer" })
        await this.ctx.session.wait({ sessionID: binding.sessionID }).catch(() => undefined)
        const messages = listData(await this.ctx.session.context({ sessionID: binding.sessionID }))
        result = assistantResult(messages, attemptStartedAt)
        failureContext.toolOutcomes = result.toolOutcomes
        failureContext.cause = result.failure
        if (!result.failure) break
        if (!availabilityFailure(result.failure) || anyToolCall(messages, attemptStartedAt) || index === models.length - 1) break
      }
      const current = this.store.read()
      const currentTask = this.store.cloneSubtask(task.id)
      // A terminal state always wins over a late run result: a rejection (or
      // any other settle) that landed while the native session was finishing
      // must not be clobbered by the leftover reply.
      if (!currentTask || currentTask.activeRunID !== runID || currentTask.state === "replied") return
      if (result?.failure) {
        // No shadow approvals: a failed native run is retried inside its
        // attempt budget (backoff, no approval) or fails terminally. Only a
        // proven host block — the native permission mirror — ever gates.
        const uncertain = result.tools.length > 0
        const errorText = uncertain ? "A tool outcome is uncertain. Review the native session before retrying." : result.failure.message ?? "All models failed."
        const linked = currentTask.approvalID ? current.approvals[currentTask.approvalID] : undefined
        currentTask.activeRunID = undefined
        currentTask.claimedBy = undefined
        currentTask.leaseUntil = undefined
        if (linked?.status === "pending") {
          // A decision is still owed: park the run, keep the question open.
          this.recordTaskFailure({
            event: "failure.parked",
            level: "warn",
            failureClass: "approval",
            task: currentTask,
            error: errorText,
            decision: { type: "park", reason: "decision-pending", approvalID: linked.id },
            context: failureContext,
          })
          this.logger?.event("warn", "retry", "task.approval.parked", {
            workspaceID: currentTask.workspaceID,
            taskID: currentTask.id,
            dispatchGroupID: currentTask.dispatchGroupID,
            approvalID: linked.id,
            attempt: currentTask.attempts,
            reason: errorText,
          })
          await this.finalizeStream(live, "Paused — waiting for your answer in the approvals inbox.", true, globalEpoch, workspaceEpoch, task.workspaceID)
          await this.store.saveSubtask(currentTask)
          return
        }
        if (uncertain) {
          await this.parkUncertain({
            task: currentTask,
            error: errorText,
            live,
            globalEpoch,
            workspaceEpoch,
            workspaceID: task.workspaceID,
            context: failureContext,
          })
          return
        }
        if (currentTask.attempts < MAX_ATTEMPTS && (currentTask.deadlineAt === undefined || now() < currentTask.deadlineAt)) {
          await this.retryLater({
            task: currentTask,
            error: errorText,
            live,
            globalEpoch,
            workspaceEpoch,
            workspaceID: task.workspaceID,
            context: failureContext,
          })
          return
        }
        await this.failTask(currentTask, errorText, { context: failureContext, reason: "attempts-exhausted" })
        await this.finalizeStream(live, errorText, true, globalEpoch, workspaceEpoch, task.workspaceID)
        return
      }
      const mention = normalizeAgentMentions(result?.text ?? "", workspace.memberIDs.map((id) => current.agents[id]).filter((item): item is Agent => Boolean(item)))
      // An empty/whitespace assistant turn is not an answer. It must never
      // finalize as success or be handed off as completed work; retry inside
      // the budget, then fail visibly. Ticket #149: an internal fallback
      // string is not an answer either.
      const reply = isFallbackReply(mention.text) ? "" : mention.text.trim()
      if (mention.changed) await this.appendMessage(workspace, { author: "system", text: `Mention syntax normalized: ${mention.names.map((name) => `@${name} → $${name}`).join(", ")}. Chat mentions do not assign work; leaders assign with ensemble_delegate, peers with ensemble_handoff.`, kind: "system", taskID: task.id })
      if (currentTask.approvalID) {
        const linked = current.approvals[currentTask.approvalID]
        if (linked?.status === "pending") {
          // A product decision is still owed: park the run WITHOUT
          // finalizing the partial output as the answer. The reply lands
          // only after the user answers and the re-queued run completes.
          await this.finalizeStream(live, "Paused — waiting for your answer in the approvals inbox.", true, globalEpoch, workspaceEpoch, task.workspaceID)
          currentTask.activeRunID = undefined
          currentTask.claimedBy = undefined
          currentTask.leaseUntil = undefined
          await this.store.saveSubtask(currentTask)
          return
        }
        // Resolved meanwhile: drop the stale link and finish normally.
        currentTask.approvalID = undefined
      }
      if (!reply) {
        const errorText = "The agent produced no answer."
        if (currentTask.attempts < MAX_ATTEMPTS && (currentTask.deadlineAt === undefined || now() < currentTask.deadlineAt)) {
          await this.retryLater({
            task: currentTask,
            error: errorText,
            live,
            globalEpoch,
            workspaceEpoch,
            workspaceID: task.workspaceID,
            streamText: "No answer produced — retrying.",
            failureClass: "empty-reply",
            context: failureContext,
          })
          return
        }
        await this.failTask(currentTask, errorText, { context: failureContext, failureClass: "empty-reply", reason: "empty-reply" })
        await this.finalizeStream(live, errorText, true, globalEpoch, workspaceEpoch, task.workspaceID)
        return
      }
      const children = this.store.subtasks().filter((item) => item.parentID === currentTask.id)
      currentTask.activeRunID = undefined
      currentTask.claimedBy = undefined
      currentTask.leaseUntil = undefined
      // Ticket #71 mandatory completion handoff: a non-leader turn that ends
      // without an explicit handoff cannot finish silently — the server hands
      // the finished content onward (default: the workspace leader) as the
      // turn finalizes. An explicit handoff satisfies the obligation;
      // completion and batch hops never re-handoff. The auto hop is a
      // post-turn delivery, not a wait: only explicit children hold the turn
      // in `awaitingChildren` (ticket #70), so a grouped completion can never
      // wedge its finisher while it waits for batch review.
      await this.ensureCompletionHandoff(currentTask, reply, children)
      if (children.length > 0 && currentTask.stage === "initial") {
        currentTask.awaitingChildren = true
        currentTask.state = "working"
        currentTask.error = undefined
        await this.store.saveSubtask(currentTask)
        await this.finalizeStream(live, reply, false, globalEpoch, workspaceEpoch, task.workspaceID)
        await this.maybeSynthesize(currentTask.id)
        return
      }
      const finishedAt = now()
      currentTask.state = "replied"
      currentTask.outcome = "succeeded"
      // Ticket #149: success clears any transient/restart reason before the
      // terminal save, so a recovered task never keeps its recovery error.
      currentTask.error = undefined
      currentTask.runSummary = result?.tools.length ? `${result.tools.length} tool call${result.tools.length === 1 ? "" : "s"}` : "no tool calls"
      currentTask.repliedAt = finishedAt
      currentTask.finishedAt = finishedAt
      // The recipient's finalized reply in the asking workspace transcript IS
      // the relay: it is attributed via the message agentID and linked by
      // correlation. Record who answered for task_status observability.
      if (currentTask.workKind === "handoff" && currentTask.handoff) {
        currentTask.handoff.answeredByID = currentTask.assigneeID
      }
      if (currentTask.workKind === "turn" && currentTask.turn) {
        currentTask.turn.answeredByID = currentTask.assigneeID
      }
      const message = await this.finalizeStream(live, reply, false, globalEpoch, workspaceEpoch, task.workspaceID)
      currentTask.resultMessageID = message && !isFallbackReply(message.text) ? message.id : undefined
      await this.store.saveSubtask(currentTask)
      this.noteWorkChanged(currentTask)
      // Dependent product decisions that outlived the work are superseded —
      // nothing may linger while an answer is already visible. Native
      // mirrors are excluded: only the host or an explicit resolve settles
      // them, since the host request may still be live after our run ends.
      await this.settleLinkedApprovals(currentTask.id, "Superseded: the linked work finished.", new Set(["native"]))
      if (currentTask.parentID) await this.maybeSynthesize(currentTask.parentID)
    } catch (error: any) {
      const currentTask = this.store.cloneSubtask(task.id)
      const failureText = error?.message ?? String(error)
      if (currentTask?.activeRunID === runID) {
        failureContext.cause = error
        // Transient failure: retry inside the attempt budget and deadline
        // with backoff (fast first retry, slower later ones). Exhausted or
        // overdue work fails with its reason preserved.
        if (currentTask.attempts < MAX_ATTEMPTS && (currentTask.deadlineAt === undefined || now() < currentTask.deadlineAt)) {
          await this.retryLater({
            task: currentTask,
            error: failureText,
            live,
            globalEpoch,
            workspaceEpoch,
            workspaceID: task.workspaceID,
            failureClass: classifyFailure(error, "internal"),
            context: failureContext,
          })
        } else {
          await this.failTask(currentTask, failureText, { context: failureContext, failureClass: classifyFailure(error, "internal"), reason: "attempts-exhausted" })
          await this.finalizeStream(live, failureText, true, globalEpoch, workspaceEpoch, task.workspaceID)
        }
      } else {
        await this.finalizeStream(live, failureText, true, globalEpoch, workspaceEpoch, task.workspaceID)
      }
    } finally {
      if (granted) {
        await this.ctx.session.update({
          sessionID: binding.sessionID,
          permissions: skillPermissions(agent.skillbox),
        }).catch(() => undefined)
      }
      clearInterval(heartbeat)
      this.liveBySession.delete(binding.sessionID)
      if (live?.streaming) await this.finalizeStream(live, live.text || REPLY_INTERRUPTED, true, globalEpoch, workspaceEpoch, task.workspaceID)
      await this.releaseClaim(task.id, runID)
      run.status = "completed"
      this.activeRuns.delete(runID)
      this.runBySession.delete(binding.sessionID)
      await this.flushDmQueue(agent.id, task.workspaceID).catch(() => undefined)
    }
  }

  private async ensureBinding(workspace: Workspace, agent: Agent): Promise<{ sessionID: string } | undefined> {
    const existing = this.store.binding(workspace.id, agent.id)
    if (existing && existing.agentVersion === agent.version) {
      if (existing.kind !== "workspace" || existing.directory !== workspace.directory) {
        await this.store.saveBinding({
          ...existing,
          kind: "workspace",
          directory: workspace.directory,
          updatedAt: now(),
        })
      }
      return { sessionID: existing.sessionID }
    }
    const key = bindingKey(workspace.id, agent.id)
    const inFlight = this.bindingPromises.get(key)
    if (inFlight) return inFlight
    const promise = this.createWorkspaceBinding(workspace, agent)
    this.bindingPromises.set(key, promise)
    try { return await promise } finally { this.bindingPromises.delete(key) }
  }

  private async createWorkspaceBinding(workspace: Workspace, agent: Agent): Promise<{ sessionID: string } | undefined> {
    const existing = this.store.binding(workspace.id, agent.id)
    const created = unwrap<any>(await this.ctx.session.create({
      title: `${agent.name} · ${workspace.name}`,
      agent: "build",
      model: { providerID: agent.mainModel.providerID, id: agent.mainModel.modelID, ...(agent.mainModel.variant ? { variant: agent.mainModel.variant } : {}) },
      permissions: skillPermissions(agent.skillbox),
      location: { directory: workspace.directory },
    }))
    if (!created?.id) return undefined
    const binding = {
      workspaceID: workspace.id,
      agentID: agent.id,
      sessionID: created.id,
      history: existing ? [...(existing.history ?? []), existing.sessionID] : [],
      kind: "workspace" as const,
      directory: workspace.directory,
      agentVersion: agent.version,
      updatedAt: now(),
    }
    await this.store.saveBinding(binding)
    // The replaced session is gone: any native mirror for it can never be
    // answered by the host, so settle it instead of lingering.
    if (existing && existing.sessionID !== created.id) await this.settleNativeForSession(existing.sessionID, "Session ended before the permission was answered.")
    await this.ctx.session.instructions.entry.put({ sessionID: created.id, key: "ensemble.v2.identity", value: this.identityForAgent(agent) }).catch(() => undefined)
    const current = this.store.cloneAgent(agent.id)
    if (current?.pendingSettings) {
      current.pendingSettings = false
      await this.store.saveAgent(current)
    }
    return { sessionID: created.id }
  }

  private async releaseClaim(taskID: string, runID: string): Promise<void> {
    const current = this.store.cloneSubtask(taskID)
    if (current && current.claimedBy === runID) {
      current.claimedBy = undefined
      current.leaseUntil = undefined
      await this.store.saveSubtask(current)
    }
  }

  /**
   * Clean shutdown (ticket #148): release only claims whose owner is one of
   * this service's run ids. A foreign claim belongs to another live service
   * and must survive; a crash (no stop path) leaves the lease to expire.
   */
  private async releaseLocalClaims(runIDs: ReadonlySet<string>): Promise<void> {
    if (runIDs.size === 0) return
    for (const candidate of this.store.subtasks()) {
      if (!candidate.claimedBy || !runIDs.has(candidate.claimedBy)) continue
      const task = this.store.cloneSubtask(candidate.id)
      if (!task) continue
      task.claimedBy = undefined
      task.leaseUntil = undefined
      if (task.activeRunID !== undefined && runIDs.has(task.activeRunID)) task.activeRunID = undefined
      await this.store.saveSubtask(task)
    }
  }

  /**
   * Record one self-contained failure event. Best-effort: a failure while
   * formatting evidence must never change the retry/terminal decision.
   */
  private recordTaskFailure(input: {
    event: "failure.attempt" | "failure.parked" | "failure.terminal"
    level: "warn" | "error"
    failureClass: FailureClass
    task: Subtask
    error: unknown
    decision: FailureDecision
    context?: TaskFailureContext
    /** Restart/lease recovery evidence (ticket #149). */
    previousClaim?: string
    leaseExpiredAt?: number
    reason?: string
  }): void {
    const logger = this.logger
    if (!logger) return
    try {
      const state = this.store.read()
      const agent = input.task.assigneeID ? state.agents[input.task.assigneeID] : undefined
      const messages = (state.messages[input.task.workspaceID] ?? []).slice(-8)
      const context = input.context
      const startedAt = context?.startedAt
      const record = buildFailureRecord({
        event: input.event,
        level: input.level,
        incidentID: id("failure"),
        failureClass: input.failureClass,
        task: input.task,
        error: context?.cause ?? input.error,
        decision: input.decision,
        previousClaim: input.previousClaim,
        leaseExpiredAt: input.leaseExpiredAt,
        reason: input.reason,
        runID: context?.runID,
        sessionID: context?.sessionID,
        providerID: context?.providerID ?? agent?.mainModel.providerID,
        modelID: context?.modelID ?? agent?.mainModel.modelID,
        variant: context?.variant ?? agent?.mainModel.variant,
        startedAt,
        durationMs: startedAt !== undefined ? Math.max(0, now() - startedAt) : undefined,
        toolOutcomes: context?.toolOutcomes,
        lastMessages: messages,
        version: state.version,
        epoch: this.epochValue,
        content: logger.content,
      })
      logger.failure(record)
    } catch {}
  }

  /**
   * Park a failed run for a later attempt. The system event is the durable
   * explanation; the card countdown is the live one. No terminal state is
   * written here, so the group stays active through the backoff.
   */
  private async retryLater(input: {
    task: Subtask
    error: string
    live?: Message
    globalEpoch: number
    workspaceEpoch: number
    workspaceID: string
    streamText?: string
    failureClass?: FailureClass
    context?: TaskFailureContext
  }): Promise<void> {
    const delayMs = retryDelayMs(input.task.attempts)
    input.task.state = "pending"
    input.task.outcome = "pending"
    input.task.error = input.error
    input.task.activeRunID = undefined
    input.task.claimedBy = undefined
    input.task.leaseUntil = undefined
    input.task.retryAfter = now() + delayMs
    await this.store.saveSubtask(input.task)
    const attempt = nextRetryAttempt(input.task.attempts, MAX_ATTEMPTS)
    this.recordTaskFailure({
      event: "failure.attempt",
      level: "warn",
      failureClass: input.failureClass ?? classifyFailure(input.context?.cause ?? input.error, "internal"),
      task: input.task,
      error: input.error,
      decision: {
        type: "retry",
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        delayMs,
        retryAt: input.task.retryAfter,
      },
      context: input.context,
    })
    this.logger?.event("warn", "retry", "retry.scheduled", {
      workspaceID: input.task.workspaceID,
      taskID: input.task.id,
      dispatchGroupID: input.task.dispatchGroupID,
      attempt,
      maxAttempts: MAX_ATTEMPTS,
      delayMs,
      retryAfter: input.task.retryAfter,
      reason: input.error,
    })
    const seconds = Math.max(1, Math.round(delayMs / 1_000))
    const workspace = this.store.workspace(input.task.workspaceID)
    if (workspace) {
      await this.appendMessage(workspace, {
        author: "system",
        text: `Retrying in ${seconds}s (attempt ${attempt}/${MAX_ATTEMPTS}): ${input.error}`,
        kind: "system",
        taskID: input.task.id,
      })
    }
    if (input.live) {
      await this.finalizeStream(
        input.live,
        input.streamText ?? input.error,
        true,
        input.globalEpoch,
        input.workspaceEpoch,
        input.workspaceID,
      )
    }
    this.defer(delayMs, () => this.schedule())
  }

  /**
   * A tool outcome is uncertain: retrying could duplicate a side effect. Park
   * the run behind an interrupted approval so the user reviews the native
   * session and explicitly resumes or discards it.
   */
  private async parkUncertain(input: {
    task: Subtask
    error: string
    live?: Message
    globalEpoch: number
    workspaceEpoch: number
    workspaceID: string
    context?: TaskFailureContext
  }): Promise<void> {
    const workspace = this.store.workspace(input.task.workspaceID)
    if (!workspace) {
      await this.failTask(input.task, input.error, { context: input.context, failureClass: "uncertain" })
      if (input.live) {
        await this.finalizeStream(input.live, input.error, true, input.globalEpoch, input.workspaceEpoch, input.workspaceID)
      }
      return
    }
    const approval: Approval = {
      id: id("approval"),
      workspaceID: input.task.workspaceID,
      subtaskID: input.task.id,
      agentID: input.task.assigneeID,
      kind: "interrupted",
      source: "workspace",
      title: `Resume interrupted work: ${input.task.title}`,
      detail: input.error,
      payload: { subtaskID: input.task.id },
      status: "pending",
      createdAt: now(),
    }
    input.task.state = "pending"
    input.task.outcome = "pending"
    input.task.interrupted = true
    input.task.approvalID = approval.id
    input.task.error = input.error
    input.task.activeRunID = undefined
    input.task.claimedBy = undefined
    input.task.leaseUntil = undefined
    input.task.retryAfter = undefined
    await this.store.saveApproval(approval)
    await this.store.saveSubtask(input.task)
    this.recordTaskFailure({
      event: "failure.parked",
      level: "warn",
      failureClass: "uncertain",
      task: input.task,
      error: input.error,
      decision: { type: "park", reason: "uncertain-tool-outcome", approvalID: approval.id },
      context: input.context,
    })
    this.logger?.event("warn", "retry", "task.uncertain.parked", {
      workspaceID: input.task.workspaceID,
      taskID: input.task.id,
      dispatchGroupID: input.task.dispatchGroupID,
      approvalID: approval.id,
      reason: input.error,
    })
    await this.appendMessage(workspace, {
      author: "system",
      text: `Approval needed: ${input.error}`,
      kind: "approval",
      taskID: input.task.id,
    })
    if (input.live) {
      await this.finalizeStream(
        input.live,
        input.error,
        true,
        input.globalEpoch,
        input.workspaceEpoch,
        input.workspaceID,
      )
    }
  }

  private async failTask(
    task: Subtask,
    error: string,
    options: { context?: TaskFailureContext; failureClass?: FailureClass; reason?: string } = {},
  ): Promise<void> {
    const at = now()
    task.state = "replied"
    task.outcome = "failed"
    task.error = error
    task.activeRunID = undefined
    task.approvalID = undefined
    task.claimedBy = undefined
    task.leaseUntil = undefined
    task.retryAfter = undefined
    task.repliedAt = at
    task.finishedAt = at
    await this.store.saveSubtask(task)
    this.recordTaskFailure({
      event: "failure.terminal",
      level: "error",
      failureClass: options.failureClass ?? classifyFailure(options.context?.cause ?? error, "provider"),
      task,
      error,
      decision: {
        type: "terminal",
        reason: options.reason ?? "attempts-exhausted",
        attempt: task.attempts,
        maxAttempts: MAX_ATTEMPTS,
      },
      context: options.context,
    })
    this.noteWorkChanged(task)
    // Dead work surfaces as a failure, not a phantom continue prompt: settle
    // linked product decisions as superseded. Native mirrors are excluded —
    // only the host or an explicit resolve settles them.
    await this.settleLinkedApprovals(task.id, "Superseded: the linked work finished.", new Set(["native"]))
    const workspace = this.store.workspace(task.workspaceID)
    // A handoff that cannot be delivered produces a failure notice in the
    // conversation that asked, attributed to the intended recipient.
    if (workspace && task.workKind === "handoff" && task.handoff) {
      const recipientName = this.store.agent(task.handoff.recipientID)?.name ?? "Unknown agent"
      await this.appendMessage(workspace, { author: "system", text: handoffFailureText(recipientName, error, task.handoff.correlationID), kind: "system", taskID: task.id, correlationID: task.handoff.correlationID })
    } else if (workspace && task.workKind === "turn" && task.turn) {
      const recipientName = this.store.agent(task.assigneeID ?? "")?.name ?? "Unknown agent"
      await this.appendMessage(workspace, { author: "system", text: `Peer turn for $${recipientName} failed: ${error} (ref ${task.turn.correlationID}).`, kind: "system", taskID: task.id, correlationID: task.turn.correlationID })
    }
    // Ticket #136: one canonical terminal event per task. A plain failure is
    // announced from the terminal task row like success; a generic duplicate
    // system line made failure feel secondary. Correlation-specific notices
    // above remain.
    if (task.parentID) await this.maybeSynthesize(task.parentID)
  }

  private async maybeSynthesize(parentID: string): Promise<void> {
    const stored = this.store.subtask(parentID)
    if (!stored || stored.stage === "synthesis" || stored.state === "replied") return
    // Ticket #71: batch reviews close only via the review tool once every
    // item is acted on or dismissed — never by child completion.
    if (stored.handoff?.batch === true) return
    // Completion deliveries are post-turn hops, not synthesis inputs; counting
    // them here would let an auto-handoff keep its finisher waiting forever.
    const children = this.store.subtasks().filter((item) => item.parentID === parentID && item.handoff?.completion !== true)
    if (children.length === 0 || children.some((child) => child.state !== "replied")) return
    const workspace = this.store.workspace(stored.workspaceID)
    if (!workspace) return
    const parent = this.store.cloneSubtask(parentID)
    if (!parent) return
    if (workspace.synthesis) {
      parent.state = "pending"
      parent.stage = "synthesis"
      parent.awaitingChildren = false
      parent.outcome = "pending"
      parent.assigneeID = workspace.leaderID
      parent.deadlineAt = now() + DEADLINE_MS
      await this.store.saveSubtask(parent)
    } else {
      const at = now()
      parent.state = "replied"
      parent.outcome = "succeeded"
      parent.repliedAt = at
      parent.finishedAt = at
      await this.store.saveSubtask(parent)
      await this.appendMessage(workspace, { author: "system", text: "Delegated subtasks completed.", kind: "system", taskID: parent.id })
    }
  }
}
