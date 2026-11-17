/**
 * Ticket #276: content-free metrics for the soak/leak harness and support
 * bundle.
 *
 * The sampler never persists a diagnostic response. It reduces one durable
 * state read to counts, then discards the payload. Every field here is a
 * number, a state name, or a log-sink statistic; titles, instructions,
 * messages, session ids, and file paths never enter a sample.
 */

const MB = 1024 * 1024

export type DiagnosticCounts = {
  messages: number
  tasks: number
  tasksByState: Record<string, number>
  queue: {
    pending: number
    working: number
    retrying: number
    stalled: number
    approvals: number
    dm: number
    activeRuns: number
  }
  native: {
    subagents: number
    activeSubagents: number
    rows: number
    watchdogTurns: number
    shadowTurns: number
    shadowSessions: number
  }
  dispatchGroups: number
  log: {
    ring: number
    dropped: number
    written: number
    failedWrites: number
  }
}

export type SoakSample = DiagnosticCounts & {
  /** Epoch milliseconds for the sample. */
  at: number
  /** Seconds since the soak baseline. */
  elapsedSeconds: number
  rss: {
    serviceBytes: number
    tuiBytes: number
    totalBytes: number
  }
  storageBytes: number
  diagnosticBytes: number
  diagnosticMs: number
}

export type SoakFinding = {
  code: "rss-growth" | "rss-per-message" | "queue-not-settled" | "native-not-settled"
  message: string
}

export type SoakSummary = {
  samples: number
  durationSeconds: number
  warmupSeconds: number
  windowSeconds: number
  baseline: { rssMb: number; messages: number; tasks: number }
  tail: { rssMb: number; messages: number; tasks: number }
  peak: { rssMb: number; queueDepth: number; nativeTurns: number; activeRuns: number }
  growth: {
    rssMbPerHour: number
    messagesPerHour: number
    tasksPerHour: number
    dispatchGroupsPerHour: number
    rssMbPer1000Messages: number
  }
  findings: SoakFinding[]
  gate: "observe-only" | "enforced"
  ok: boolean
}

export type SoakOptions = {
  /** Samples older than this are JIT/connection warmup, not growth. */
  warmupSeconds?: number
  /** Fail an enforced run above this slope. Default 256 MiB/hour. */
  maxRssGrowthMbPerHour?: number
  /** Fail an enforced run above this normalized slope. Default 64 MiB/1k messages. */
  maxRssMbPer1000Messages?: number
  /** Enforce the gate; observe-only still reports every finding. */
  enforce?: boolean
  /** Fail when durable queue or native work has not settled by the tail. */
  requireSettled?: boolean
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}
}

function list(value: unknown): any[] {
  return Array.isArray(value) ? value : []
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function count(value: unknown): number {
  if (Array.isArray(value)) return value.length
  if (value && typeof value === "object") return Object.keys(value).length
  return 0
}

function workState(task: any): string {
  const derived = typeof task?.status === "string" ? task.status : undefined
  if (derived === "retrying" || derived === "stalled") return derived
  return typeof task?.state === "string" ? task.state : "unknown"
}

/**
 * Reduce one `diagnostic` output to growth counters. The caller may pass the
 * whole RPC envelope or its `output`; content keys are ignored either way.
 */
export function diagnosticCounts(output: unknown): DiagnosticCounts {
  const root = record(output)
  const state = record(root.state ?? root)
  const messages: Record<string, any[]> = record(state.messages)
  const tasks: Record<string, any> = record(state.subtasks)
  const approvals: Record<string, any> = record(state.approvals)
  const nativeSubagents: Record<string, any> = record(state.nativeSubagents)
  const dispatchGroups: Record<string, any> = record(state.dispatchGroups)
  const support = record(root.native)
  const watchdog = record(record(support.watchdog).turns)
  const shadow = record(support.shadow)
  const logs = record(root.logs)

  const tasksByState: Record<string, number> = {}
  let pending = 0
  let working = 0
  let retrying = 0
  let stalled = 0
  let nativeRows = 0
  for (const task of Object.values(tasks)) {
    const rawState = typeof task?.state === "string" ? task.state : "unknown"
    const stateName = workState(task)
    tasksByState[rawState] = (tasksByState[rawState] ?? 0) + 1
    if (rawState === "pending") pending += 1
    if (rawState === "working") working += 1
    if (stateName === "retrying") retrying += 1
    if (stateName === "stalled") stalled += 1
  }
  for (const rows of Object.values(messages)) {
    for (const message of list(rows)) {
      if (message?.native && typeof message.native === "object") nativeRows += 1
    }
  }

  return {
    messages: Object.values(messages).reduce((total, rows) => total + list(rows).length, 0),
    tasks: Object.keys(tasks).length,
    tasksByState,
    queue: {
      pending,
      working,
      retrying,
      stalled,
      approvals: Object.values(approvals).filter((approval) => approval?.status === "pending").length,
      dm: count(state.dmQueue),
      activeRuns: count(state.runs),
    },
    native: {
      subagents: Object.keys(nativeSubagents).length,
      activeSubagents: Object.values(nativeSubagents).filter((run) => run?.state === "working").length,
      rows: nativeRows,
      watchdogTurns: Object.keys(watchdog).length,
      shadowTurns: finite(shadow.activeTurns),
      shadowSessions: finite(shadow.activeSessions),
    },
    dispatchGroups: Object.keys(dispatchGroups).length,
    log: {
      ring: finite(logs.ringSize),
      dropped: finite(logs.dropped),
      written: finite(logs.written),
      failedWrites: finite(logs.failedWrites),
    },
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const ordered = [...values].sort((a, b) => a - b)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 0 ? (ordered[middle - 1]! + ordered[middle]!) / 2 : ordered[middle]!
}

function rssMb(sample: SoakSample): number {
  return sample.rss.totalBytes / MB
}

function perHour(delta: number, seconds: number): number {
  if (seconds <= 0) return 0
  return (delta / seconds) * 3600
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Summarize the record produced by `scripts/soak-fake.sh`. The baseline is the
 * first stable window after warmup, not the first sample: JIT, host connection,
 * and the first snapshot are one-time costs, not a leak.
 */
export function summarizeSoak(samples: readonly SoakSample[], options: SoakOptions = {}): SoakSummary {
  const ordered = [...samples].sort((a, b) => a.at - b.at)
  const durationSeconds = ordered.length === 0 ? 0 : Math.max(0, ordered[ordered.length - 1]!.elapsedSeconds - ordered[0]!.elapsedSeconds)
  const warmupSeconds = Math.max(0, options.warmupSeconds ?? Math.min(60, durationSeconds / 10))
  const eligible = ordered.filter((sample) => sample.elapsedSeconds >= warmupSeconds)
  const used = eligible.length >= 2 ? eligible : ordered
  const baselineCount = Math.max(1, Math.min(3, Math.floor(used.length / 3)))
  const tailCount = Math.max(1, Math.min(5, Math.floor(used.length / 3)))
  const baselineSamples = used.slice(0, baselineCount)
  const tailSamples = used.slice(-tailCount)
  const baseline = baselineSamples[baselineSamples.length - 1]!
  const tail = tailSamples[tailSamples.length - 1]!
  const windowSeconds = Math.max(0, tail.elapsedSeconds - baseline.elapsedSeconds)
  const baselineRss = median(baselineSamples.map(rssMb))
  const tailRss = median(tailSamples.map(rssMb))
  const baselineMessages = median(baselineSamples.map((sample) => sample.messages))
  const tailMessages = median(tailSamples.map((sample) => sample.messages))
  const baselineTasks = median(baselineSamples.map((sample) => sample.tasks))
  const tailTasks = median(tailSamples.map((sample) => sample.tasks))
  const baselineGroups = median(baselineSamples.map((sample) => sample.dispatchGroups))

  const peak = ordered.reduce(
    (current, sample) => ({
      rssMb: Math.max(current.rssMb, rssMb(sample)),
      queueDepth: Math.max(current.queueDepth, sample.queue.pending + sample.queue.working),
      nativeTurns: Math.max(current.nativeTurns, finite(sample.native.watchdogTurns) + finite(sample.native.activeSubagents)),
      activeRuns: Math.max(current.activeRuns, finite(sample.queue.activeRuns)),
    }),
    { rssMb: 0, queueDepth: 0, nativeTurns: 0, activeRuns: 0 },
  )

  const growth = {
    rssMbPerHour: round(perHour(tailRss - baselineRss, windowSeconds)),
    messagesPerHour: round(perHour(tailMessages - baselineMessages, windowSeconds)),
    tasksPerHour: round(perHour(tailTasks - baselineTasks, windowSeconds)),
    dispatchGroupsPerHour: round(perHour(tail.dispatchGroups - baselineGroups, windowSeconds)),
    rssMbPer1000Messages: 0,
  }
  growth.rssMbPer1000Messages = growth.messagesPerHour > 0
    ? round((growth.rssMbPerHour / growth.messagesPerHour) * 1000)
    : 0

  const findings: SoakFinding[] = []
  const maximum = options.maxRssGrowthMbPerHour ?? 256
  if (growth.rssMbPerHour > maximum) {
    findings.push({
      code: "rss-growth",
      message: `RSS grew ${growth.rssMbPerHour} MiB/hour, above the ${maximum} MiB/hour gate.`,
    })
  }
  const normalizedMaximum = options.maxRssMbPer1000Messages ?? 64
  if (growth.messagesPerHour > 0 && growth.rssMbPer1000Messages > normalizedMaximum) {
    findings.push({
      code: "rss-per-message",
      message: `RSS grew ${growth.rssMbPer1000Messages} MiB per 1,000 messages, above the ${normalizedMaximum} MiB/1k gate.`,
    })
  }
  const queueDepth = finite(tail.queue.pending) + finite(tail.queue.working)
  if (options.requireSettled !== false && queueDepth > 0) {
    findings.push({
      code: "queue-not-settled",
      message: `Durable queue still had ${queueDepth} pending/working item(s) at the tail.`,
    })
  }
  const nativeTurns = finite(tail.native.watchdogTurns) + finite(tail.native.activeSubagents)
  if (options.requireSettled !== false && nativeTurns > 0) {
    findings.push({
      code: "native-not-settled",
      message: `Native state still had ${nativeTurns} watched turn(s)/subagent(s) at the tail.`,
    })
  }

  const enforced = options.enforce === true
  return {
    samples: ordered.length,
    durationSeconds,
    warmupSeconds,
    windowSeconds,
    baseline: { rssMb: round(baselineRss), messages: Math.round(baselineMessages), tasks: Math.round(baselineTasks) },
    tail: { rssMb: round(tailRss), messages: Math.round(tailMessages), tasks: Math.round(tailTasks) },
    peak: { rssMb: round(peak.rssMb), queueDepth: peak.queueDepth, nativeTurns: peak.nativeTurns, activeRuns: peak.activeRuns },
    growth,
    findings,
    gate: enforced ? "enforced" : "observe-only",
    ok: !enforced || findings.length === 0,
  }
}
