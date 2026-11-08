import { appendFile, rename } from "node:fs/promises"
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { threadId } from "node:worker_threads"

/**
 * Structured operational logging for Ensemble.
 *
 * The logger is deliberately small and dependency-free: a bounded ring for
 * live inspection plus per-process JSONL files for post-mortem. A failure
 * record is written to its own longer-retention sink so "why did this fail?"
 * never depends on reconstructing several unrelated lines.
 *
 * Callers log domain events, not implementation steps. Heartbeats, streaming
 * deltas, and render ticks belong in counters or trace-only entries.
 */

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace"
export type LogCategory =
  | "service"
  | "task"
  | "retry"
  | "approval"
  | "message"
  | "feed"
  | "refresh"
  | "tui"
  | "host"
  | "failure"

export type LogFields = Record<string, unknown>

export type LogEntry = {
  ts: string
  level: LogLevel
  cat: LogCategory
  event: string
  pid: number
  role: string
  /** Boot/mount identity; ticket #150 keeps one service log per role. */
  instanceID: string
  /** `node:worker_threads` thread id, so a hot-reload can be attributed. */
  threadID: number
  [key: string]: unknown
}

export type LoggerStats = {
  enabled: boolean
  level: LogLevel
  role: string
  instanceID: string
  threadID: number
  dir?: string
  mainFile?: string
  failureFile?: string
  ringSize: number
  dropped: number
  written: number
  failedWrites: number
  content: boolean
  /** `feed.gap` events observed by this logger (ticket #150 diagnostics). */
  feedGaps: number
  lastError?: string
}

export type LoggerOptions = {
  role: "service" | "tui"
  /** Stable identity for every row (service boot epoch / TUI mount UUID). */
  instanceID?: string
  enabled?: boolean
  level?: LogLevel
  /** Explicit directory; null disables file sinks while keeping the ring. */
  dir?: string | null
  /** Explicit main file; overrides the generated per-process path. */
  file?: string
  /** Explicit failure file; defaults beside the main file. */
  failureFile?: string
  ringSize?: number
  maxBytes?: number
  maxFiles?: number
  retentionDays?: number
  content?: boolean
  stderr?: boolean
  now?: () => number
}

const LEVELS: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 }
const MAX_STRING = 16_384
const FLUSH_DELAY_MS = 50
const FLUSH_BATCH = 256

function isTestRuntime(): boolean {
  return process.env.NODE_TEST_CONTEXT !== undefined
    || process.execArgv.includes("--test")
    || process.argv.includes("--test")
}

/** The default local state directory; never inside the repository. */
export function defaultLogDirectory(): string {
  const explicit = process.env.ENSEMBLE_LOG_DIR
  if (explicit) return explicit
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(state, "ensemble", "logs")
}

function dateStamp(now: number): string {
  return new Date(now).toISOString().slice(0, 10).replaceAll("-", "")
}

function redactText(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, "//[redacted]@")
    .replace(/\bsk-[A-Za-z0-9._-]{8,}/g, "[redacted]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{12,})\b/g, "[redacted]")
    .replace(/(password|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)\s*[:=]?\s*\S+/gi, "$1=[redacted]")
    .slice(0, MAX_STRING)
}

function redactValue(value: unknown, key = "", depth = 0): unknown {
  if (depth > 6) return "[depth-limit]"
  if (typeof value === "string") {
    if (/^(password|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|token)$/i.test(key)) return "[redacted]"
    return redactText(value)
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value
  if (typeof value === "bigint") return String(value)
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      ...(typeof (value as any).code === "string" ? { code: (value as any).code } : {}),
      ...(value.stack ? { stack: redactText(value.stack) } : {}),
      ...(value.cause !== undefined ? { cause: redactValue(value.cause, "cause", depth + 1) } : {}),
    }
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactValue(item, key, depth + 1))
  if (typeof value === "object") {
    const result: Record<string, unknown> = {}
    let count = 0
    for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
      if (count++ >= 80) {
        result.truncated = true
        break
      }
      result[name] = redactValue(item, name, depth + 1)
    }
    return result
  }
  return redactText(String(value))
}

export function redactLogFields(fields: LogFields): LogFields {
  return redactValue(fields) as LogFields
}

function filePrefix(role: string, failure = false): string {
  return failure ? `${role}-failures-` : `${role}-`
}

export class EnsembleLogger {
  readonly role: string
  readonly instanceID: string
  readonly threadID: number
  readonly level: LogLevel
  readonly content: boolean
  readonly enabled: boolean
  private readonly ringLimit: number
  private readonly maxBytes: number
  private readonly maxFiles: number
  private readonly retentionDays: number
  private readonly stderr: boolean
  private readonly now: () => number
  private readonly dir?: string
  private readonly mainFile?: string
  private readonly failureFile?: string
  private readonly ring: LogEntry[] = []
  private queue: string[] = []
  private failureQueue: string[] = []
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private flushChain: Promise<void> = Promise.resolve()
  private closed = false
  private droppedCount = 0
  private writtenCount = 0
  private failedWriteCount = 0
  private feedGapCount = 0
  private lastErrorText?: string
  private warnedWrite = false

  constructor(options: LoggerOptions) {
    this.role = options.role
    this.instanceID = options.instanceID ?? String(process.pid)
    this.threadID = threadId
    this.enabled = options.enabled ?? process.env.ENSEMBLE_LOG !== "0"
    const requested = options.level ?? (process.env.ENSEMBLE_LOG_LEVEL as LogLevel | undefined) ?? "info"
    this.level = requested in LEVELS ? requested : "info"
    this.content = options.content ?? process.env.ENSEMBLE_LOG_CONTENT === "1"
    this.ringLimit = Math.max(1, options.ringSize ?? 2_000)
    this.maxBytes = Math.max(1_024, options.maxBytes ?? 10 * 1024 * 1024)
    this.maxFiles = Math.max(1, options.maxFiles ?? 5)
    this.retentionDays = Math.max(0, options.retentionDays ?? 7)
    this.stderr = options.stderr ?? process.env.ENSEMBLE_LOG_STDERR === "1"
    this.now = options.now ?? Date.now
    // Tests keep the ring but do not write into the user's state directory
    // unless a test explicitly supplies a directory/file.
    const testDefaultOff = isTestRuntime() && options.dir === undefined && options.file === undefined
    const dir = options.dir === null || testDefaultOff
      ? undefined
      : (options.dir ?? defaultLogDirectory())
    if (dir) {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        this.dir = dir
        this.mainFile = options.file ?? join(dir, `${filePrefix(this.role)}${dateStamp(this.now())}-${process.pid}.jsonl`)
        this.failureFile = options.failureFile ?? join(dir, `${filePrefix(this.role, true)}${dateStamp(this.now())}-${process.pid}.jsonl`)
        this.prune()
      } catch (error: any) {
        this.dir = undefined
        this.mainFile = undefined
        this.failureFile = undefined
        this.failedWriteCount++
        this.lastErrorText = redactText(String(error?.message ?? error))
      }
    }
  }

  enabledFor(level: LogLevel): boolean {
    return this.enabled && LEVELS[level] <= LEVELS[this.level]
  }

  event(level: LogLevel, cat: LogCategory, event: string, fields: LogFields = {}): void {
    if (!this.enabledFor(level)) return
    if (event === "feed.gap") this.feedGapCount += 1
    const entry: LogEntry = {
      ...redactLogFields(fields),
      ts: new Date(this.now()).toISOString(),
      level,
      cat,
      event,
      pid: process.pid,
      role: this.role,
      instanceID: this.instanceID,
      threadID: this.threadID,
    }
    this.pushRing(entry)
    const line = `${JSON.stringify(entry)}\n`
    if (this.stderr) {
      try { process.stderr.write(line) } catch {}
    }
    this.queue.push(line)
    this.scheduleFlush(false)
  }

  /** A self-contained failure record; written to the failure sink even at warn. */
  failure(entry: Omit<LogEntry, "ts" | "pid" | "role" | "instanceID" | "threadID"> & { ts?: string }): void {
    if (!this.enabled) return
    const record: LogEntry = {
      ...redactLogFields(entry as LogFields),
      ts: entry.ts ?? new Date(this.now()).toISOString(),
      level: (entry.level ?? "error") as LogLevel,
      cat: "failure",
      event: String(entry.event),
      pid: process.pid,
      role: this.role,
      instanceID: this.instanceID,
      threadID: this.threadID,
    }
    this.pushRing(record)
    const line = `${JSON.stringify(record)}\n`
    if (this.stderr) {
      try { process.stderr.write(line) } catch {}
    }
    this.failureQueue.push(line)
    this.queue.push(line)
    this.scheduleFlush(true)
  }

  recent(filter: {
    limit?: number
    level?: LogLevel
    cat?: LogCategory
    event?: string
    taskID?: string
    instanceID?: string
  } = {}): LogEntry[] {
    const limit = Math.max(1, Math.min(this.ringLimit, Math.floor(filter.limit ?? 200)))
    const minLevel = filter.level ? LEVELS[filter.level] : 0
    const matches = this.ring.filter((entry) =>
      LEVELS[entry.level] >= minLevel
      && (!filter.cat || entry.cat === filter.cat)
      && (!filter.event || entry.event === filter.event || entry.event.startsWith(`${filter.event}.`))
      && (!filter.taskID || entry.taskID === filter.taskID)
      && (!filter.instanceID || entry.instanceID === filter.instanceID),
    )
    return matches.slice(-limit)
  }

  stats(): LoggerStats {
    return {
      enabled: this.enabled,
      level: this.level,
      role: this.role,
      instanceID: this.instanceID,
      threadID: this.threadID,
      ...(this.dir ? { dir: this.dir } : {}),
      ...(this.mainFile ? { mainFile: this.mainFile } : {}),
      ...(this.failureFile ? { failureFile: this.failureFile } : {}),
      ringSize: this.ring.length,
      dropped: this.droppedCount,
      written: this.writtenCount,
      failedWrites: this.failedWriteCount,
      content: this.content,
      feedGaps: this.feedGapCount,
      ...(this.lastErrorText ? { lastError: this.lastErrorText } : {}),
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    // A single flush processes one 256-line batch. Drain every batch so a
    // crash-path shutdown never loses the tail of a burst.
    for (let pass = 0; pass < 1_000; pass++) {
      await this.enqueueFlush()
      if (this.queue.length === 0 && this.failureQueue.length === 0) return
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.flush()
  }

  private pushRing(entry: LogEntry): void {
    this.ring.push(entry)
    if (this.ring.length > this.ringLimit) {
      const overflow = this.ring.length - this.ringLimit
      this.ring.splice(0, overflow)
      this.droppedCount += overflow
    }
  }

  private scheduleFlush(urgent: boolean): void {
    if (this.flushTimer !== undefined) {
      if (!urgent) return
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    if (this.closed) {
      void this.enqueueFlush()
      return
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.enqueueFlush()
    }, urgent ? 0 : FLUSH_DELAY_MS)
    this.flushTimer.unref?.()
  }

  private enqueueFlush(): Promise<void> {
    const run = this.flushChain.then(() => this.flushQueues())
    this.flushChain = run.catch(() => undefined)
    return this.flushChain
  }

  private async flushQueues(): Promise<void> {
    if (!this.dir || !this.mainFile) {
      this.queue = []
      this.failureQueue = []
      return
    }
    if (this.queue.length === 0 && this.failureQueue.length === 0) return
    const mainLines = this.queue.splice(0, Math.min(FLUSH_BATCH, this.queue.length))
    const failureLines = this.failureQueue.splice(0, Math.min(FLUSH_BATCH, this.failureQueue.length))
    try {
      if (mainLines.length > 0) {
        const payload = mainLines.join("")
        await this.rotateIfNeeded(this.mainFile, false, Buffer.byteLength(payload))
        await appendFile(this.mainFile, payload, { encoding: "utf8", mode: 0o600 })
        this.writtenCount += mainLines.length
        if (statSync(this.mainFile).size >= this.maxBytes) await this.rotateIfNeeded(this.mainFile, false, 1)
      }
      if (failureLines.length > 0 && this.failureFile) {
        const payload = failureLines.join("")
        await this.rotateIfNeeded(this.failureFile, true, Buffer.byteLength(payload))
        await appendFile(this.failureFile, payload, { encoding: "utf8", mode: 0o600 })
        this.writtenCount += failureLines.length
        if (statSync(this.failureFile).size >= this.maxBytes) await this.rotateIfNeeded(this.failureFile, true, 1)
      }
    } catch (error: any) {
      this.failedWriteCount += mainLines.length + failureLines.length
      this.lastErrorText = redactText(String(error?.message ?? error))
      if (!this.warnedWrite) {
        this.warnedWrite = true
        try { process.stderr.write(`ensemble: log write failed: ${this.lastErrorText}\n`) } catch {}
      }
    }
    if (this.queue.length > 0 || this.failureQueue.length > 0) {
      // Keep the queue bounded; a slow disk must not grow without limit.
      if (this.queue.length > 10_000) {
        this.droppedCount += this.queue.length - 10_000
        this.queue = this.queue.slice(-10_000)
      }
      if (this.failureQueue.length > 2_000) {
        this.droppedCount += this.failureQueue.length - 2_000
        this.failureQueue = this.failureQueue.slice(-2_000)
      }
      this.scheduleFlush(true)
    }
  }

  private async rotateIfNeeded(file: string, failure: boolean, incomingBytes = 0): Promise<void> {
    if (!existsSync(file)) return
    const size = statSync(file).size
    if (size + incomingBytes < this.maxBytes) return
    for (let index = this.maxFiles - 1; index >= 1; index--) {
      const from = `${file}.${index}`
      const to = `${file}.${index + 1}`
      if (existsSync(from)) await rename(from, to).catch(() => undefined)
    }
    await rename(file, `${file}.1`).catch(() => undefined)
    if (failure) this.lastErrorText = undefined
  }

  private prune(): void {
    if (!this.dir) return
    try {
      const names = readdirSync(this.dir)
      const prefixes = [filePrefix(this.role), filePrefix(this.role, true)]
      const candidates = names
        .filter((name) => prefixes.some((prefix) => name.startsWith(prefix)))
        .map((name) => {
          const path = join(this.dir!, name)
          try { return { path, mtime: statSync(path).mtimeMs } } catch { return undefined }
        })
        .filter((item): item is { path: string; mtime: number } => Boolean(item))
      const cutoff = this.now() - this.retentionDays * 24 * 60 * 60_000
      const keep = new Map<string, number>()
      // Longest prefix first: `service-failures-` must not be counted as a
      // main `service-` file.
      const orderedPrefixes = [...prefixes].sort((a, b) => b.length - a.length)
      for (const item of candidates.sort((a, b) => b.mtime - a.mtime)) {
        const prefix = orderedPrefixes.find((value) => item.path.includes(value)) ?? filePrefix(this.role)
        const count = keep.get(prefix) ?? 0
        if (item.mtime < cutoff || count >= this.maxFiles) {
          try { unlinkSync(item.path) } catch {}
          continue
        }
        keep.set(prefix, count + 1)
      }
    } catch {}
  }
}

export type LogRateLimitDecision = {
  /** True when this event should be emitted and its window restarted. */
  allowed: boolean
  /** Identical events suppressed since the last emitted one. */
  suppressed: number
}

export type LogRateLimiterOptions = {
  windowMs?: number
  now?: () => number
  /**
   * Trailing summary for a burst that stops inside its window. Called once at
   * window close with the suppressed total, so the count is never lost.
   */
  report?: (key: string, suppressed: number) => void
}

export type LogRateLimiter = {
  admit: (key: string) => LogRateLimitDecision
  /** Report and clear every window with a suppressed count (viewer/shutdown). */
  flush: () => void
}

/**
 * Ticket #150: identical warnings (notably `feed.reset`) collapse to one per
 * window per instance. The first event emits immediately; the next allowed
 * event reports how many identical events it swallowed, and a burst that stops
 * reports its suppressed total when the window closes (or on `flush`).
 */
export function createLogRateLimiter(options: LogRateLimiterOptions = {}): LogRateLimiter {
  const windowMs = Math.max(1, options.windowMs ?? 10_000)
  const now = options.now ?? Date.now
  const windows = new Map<string, { last: number; suppressed: number; timer?: ReturnType<typeof setTimeout> }>()

  const report = (key: string, suppressed: number) => {
    if (suppressed <= 0) return
    options.report?.(key, suppressed)
  }

  const clearTimer = (state: { timer?: ReturnType<typeof setTimeout> }) => {
    if (state.timer === undefined) return
    clearTimeout(state.timer)
    state.timer = undefined
  }

  const scheduleTrailing = (key: string, state: { last: number; suppressed: number; timer?: ReturnType<typeof setTimeout> }) => {
    if (!options.report || state.timer !== undefined) return
    const delay = Math.max(1, state.last + windowMs - now())
    state.timer = setTimeout(() => {
      state.timer = undefined
      const suppressed = state.suppressed
      state.suppressed = 0
      state.last = now()
      report(key, suppressed)
    }, delay)
    state.timer.unref?.()
  }

  return {
    admit(key: string): LogRateLimitDecision {
      const at = now()
      const state = windows.get(key)
      if (!state) {
        windows.set(key, { last: at, suppressed: 0 })
        return { allowed: true, suppressed: 0 }
      }
      if (at - state.last >= windowMs) {
        const suppressed = state.suppressed
        clearTimer(state)
        state.last = at
        state.suppressed = 0
        return { allowed: true, suppressed }
      }
      state.suppressed += 1
      scheduleTrailing(key, state)
      return { allowed: false, suppressed: state.suppressed }
    },
    flush(): void {
      for (const [key, state] of windows) {
        const suppressed = state.suppressed
        if (suppressed <= 0) continue
        clearTimer(state)
        state.suppressed = 0
        state.last = now()
        report(key, suppressed)
      }
    },
  }
}

let globalLogger: EnsembleLogger | undefined

export function createLogger(options: LoggerOptions): EnsembleLogger {
  return new EnsembleLogger(options)
}

export function setGlobalLogger(logger: EnsembleLogger | undefined): void {
  globalLogger = logger
}

export function getGlobalLogger(): EnsembleLogger | undefined {
  return globalLogger
}
