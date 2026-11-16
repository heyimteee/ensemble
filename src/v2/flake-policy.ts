/**
 * Pure flake classification and reporting for the live harness.
 *
 * The harness writes one structured failure record per failed attempt. The
 * matrix runner classifies that record before deciding whether to retry. A
 * retry is allowed only for an explicit timing signal: a readiness or input
 * wait that did not settle. Product assertions, unknown failures, and
 * infrastructure failures never retry.
 *
 * Keep this module free of filesystem and process access. The shell runner and
 * the small CLI wrapper own I/O.
 */

export type FlakeClassification = "timing" | "product" | "infrastructure" | "unknown"

export type FailureKind = "timing" | "product" | "infrastructure"

export type AttemptStatus = "passed" | "failed" | "skipped" | "quarantined"

export type AttemptRecord = {
  suite: string
  /** 1-based attempt number within one matrix run. */
  attempt: number
  status: AttemptStatus
  classification?: FlakeClassification
  message?: string
  artifactPath?: string
  durationSeconds?: number
}

export type QuarantineEntry = {
  suite: string
  issue: string
  owner: string
  reason?: string
  since?: string
}

export type QuarantineValidation = { ok: boolean; errors: string[] }

export type RetryDecision = { retry: boolean; reason: string }

export type FlakeReportRow = {
  suite: string
  attempt: number
  status: AttemptStatus
  classification: FlakeClassification | "none"
  artifactPath: string
  retried: boolean
}

export type FlakeSuiteSummary = {
  suite: string
  attempts: number
  failures: number
  retries: number
  flakeRate: number
}

export type FlakeBudget = {
  maxRetriesPerSuite: number
  maxUnclassifiedRetries: number
  unclassifiedRetries: number
  unclassifiedFailures: number
  retriesFailed: number
  ok: boolean
}

export type FlakeReport = {
  rows: FlakeReportRow[]
  suites: FlakeSuiteSummary[]
  budget: FlakeBudget
}

export const FLAKE_BUDGET = {
  /** One classified timing retry per suite per matrix run. */
  maxRetriesPerSuite: 1,
  /** A retry that is not backed by a timing classification is a policy breach. */
  maxUnclassifiedRetries: 0,
  /** Fix or quarantine a suite that needs more than this rate over 20 runs. */
  windowRuns: 20,
  windowFlakeRate: 0.1,
} as const

const TIMING_MESSAGE = [
  /timed out after .* waiting for/i,
  /typed text did not reach the TUI/i,
  /could not select the .* pane/i,
  /did not become ready/i,
]

const INFRASTRUCTURE_MESSAGE = [
  /server did not print its URL/i,
  /plugin is not active/i,
  /fake provider/i,
  /is not installed or on PATH/i,
  /ECONNREFUSED/i,
  /address already in use/i,
  /permission denied/i,
  /No space left on device/i,
]

/**
 * Classify one failure. A harness-supplied `kind` wins because the harness
 * knows whether a wait or an assertion failed. Message matching is the
 * conservative fallback for synthetic records: unrecognized text is
 * `unknown`, which never retries.
 */
export function classifyFailure(input: { message?: string; kind?: FailureKind }): FlakeClassification {
  if (input.kind) return input.kind
  const message = String(input.message ?? "")
  if (TIMING_MESSAGE.some((pattern) => pattern.test(message))) return "timing"
  if (INFRASTRUCTURE_MESSAGE.some((pattern) => pattern.test(message))) return "infrastructure"
  return "unknown"
}

/** Retry only a timing failure, and only while the flake budget allows it. */
export function retryDecision(
  record: AttemptRecord,
  options: { maxRetries?: number } = {},
): RetryDecision {
  const maxRetries = Math.max(0, Math.trunc(options.maxRetries ?? FLAKE_BUDGET.maxRetriesPerSuite))
  if (record.status !== "failed") return { retry: false, reason: "attempt did not fail" }
  const classification = record.classification ?? classifyFailure({ message: record.message })
  if (classification !== "timing") return { retry: false, reason: `${classification} failure never retries` }
  if (record.attempt > maxRetries) return { retry: false, reason: `retry budget exhausted (${maxRetries})` }
  return { retry: true, reason: `timing failure on attempt ${record.attempt}` }
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0
}

/**
 * A quarantine entry is valid only with a linked issue and a named owner. The
 * matrix refuses to run with an anonymous or unlinked quarantine.
 */
export function validateQuarantine(entries: unknown): QuarantineValidation {
  if (!Array.isArray(entries)) return { ok: false, errors: ["quarantine must be an array"] }
  const errors: string[] = []
  const seen = new Set<string>()
  entries.forEach((entry, index) => {
    const value = entry as Partial<QuarantineEntry> | null
    const at = `entry ${index + 1}`
    if (!value || typeof value !== "object") {
      errors.push(`${at}: must be an object`)
      return
    }
    if (!nonEmpty(value.suite)) errors.push(`${at}: suite is required`)
    else if (seen.has(String(value.suite).trim())) errors.push(`${at}: duplicate suite ${String(value.suite).trim()}`)
    else seen.add(String(value.suite).trim())
    if (!nonEmpty(value.issue)) errors.push(`${at}: a linked issue is required`)
    if (!nonEmpty(value.owner)) errors.push(`${at}: an owner is required`)
  })
  return { ok: errors.length === 0, errors }
}

export function buildFlakeReport(records: readonly AttemptRecord[]): FlakeReport {
  const ordered = [...records].sort((left, right) => left.suite.localeCompare(right.suite) || left.attempt - right.attempt)
  const lastAttempt = new Map<string, number>()
  for (const record of ordered) lastAttempt.set(record.suite, Math.max(lastAttempt.get(record.suite) ?? 0, record.attempt))
  const rows: FlakeReportRow[] = ordered.map((record) => ({
    suite: record.suite,
    attempt: record.attempt,
    status: record.status,
    classification: record.classification ?? "none",
    artifactPath: record.artifactPath ?? "",
    retried: (lastAttempt.get(record.suite) ?? 0) > 1,
  }))

  const suites = [...new Set(ordered.map((record) => record.suite))].map((suite) => {
    const items = ordered.filter((record) => record.suite === suite)
    const failures = items.filter((record) => record.status === "failed").length
    const retries = items.filter((record) => record.attempt > 1).length
    return {
      suite,
      attempts: items.length,
      failures,
      retries,
      flakeRate: items.length === 0 ? 0 : retries / items.length,
    }
  })

  const unclassifiedRetries = ordered.filter((record) => {
    if (record.attempt <= 1) return false
    const previous = ordered.find((item) => item.suite === record.suite && item.attempt === record.attempt - 1)
    return !previous || (previous.classification ?? classifyFailure({ message: previous.message })) !== "timing"
  }).length
  const unclassifiedFailures = ordered.filter((record) => {
    if (record.status !== "failed") return false
    const classification = record.classification ?? classifyFailure({ message: record.message })
    return classification !== "timing"
  }).length
  const retriesOverBudget = suites.some((suite) => suite.retries > FLAKE_BUDGET.maxRetriesPerSuite)
  const retriesFailed = ordered.filter((record) => record.status === "failed" && record.attempt > FLAKE_BUDGET.maxRetriesPerSuite).length
  const budget: FlakeBudget = {
    maxRetriesPerSuite: FLAKE_BUDGET.maxRetriesPerSuite,
    maxUnclassifiedRetries: FLAKE_BUDGET.maxUnclassifiedRetries,
    unclassifiedRetries,
    unclassifiedFailures,
    retriesFailed,
    ok: unclassifiedRetries <= FLAKE_BUDGET.maxUnclassifiedRetries && unclassifiedFailures === 0 && !retriesOverBudget && retriesFailed === 0,
  }
  return { rows, suites, budget }
}

export function formatFlakeReport(report: FlakeReport): string {
  const lines = report.rows.map(
    (row) =>
      `flake-report: suite=${row.suite} attempt=${row.attempt} classification=${row.classification} artifact=${row.artifactPath || "<none>"}`,
  )
  for (const suite of report.suites) {
    lines.push(
      `flake-report: suite=${suite.suite} attempts=${suite.attempts} failures=${suite.failures} retries=${suite.retries} flakeRate=${Math.round(suite.flakeRate * 100)}%`,
    )
  }
  lines.push(
    `flake-report: flake budget: maxRetriesPerSuite=${report.budget.maxRetriesPerSuite} maxUnclassifiedRetries=${report.budget.maxUnclassifiedRetries} unclassifiedRetries=${report.budget.unclassifiedRetries} unclassifiedFailures=${report.budget.unclassifiedFailures} retriesFailed=${report.budget.retriesFailed} windowRuns=${FLAKE_BUDGET.windowRuns} windowFlakeRate=${Math.round(FLAKE_BUDGET.windowFlakeRate * 100)}% budget=${report.budget.ok ? "ok" : "over"}`,
  )
  return lines.join("\n")
}
