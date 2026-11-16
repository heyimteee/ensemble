/**
 * Pure latency-budget evaluation for the live probe.
 *
 * The probe measures three separate things:
 * - `rail`: UI keypress-to-repaint on the rail (tmux send -> visible cursor).
 * - `patchCard`: durable RPC -> patch application -> Work-card render.
 * - `firstToken`: first visible model reply; report only because the model
 *   delay is not a UI cost.
 *
 * Keep this module free of timers, files, and process access. The shell probe
 * and the small CLI wrapper own I/O.
 */

export type LatencyProfile = "reference" | "smoke" | "report"

export type LatencyMetric = "rail" | "patchCard" | "firstToken"

export type LatencyMetricKind = "gate" | "report"

export type LatencySamples = {
  rail?: readonly number[]
  patchCard?: readonly number[]
  firstToken?: readonly number[]
}

export type LatencySummary = {
  count: number
  min: number
  p50: number
  p95: number
  max: number
  mean: number
}

export type LatencyMetricSummary = {
  metric: LatencyMetric
  kind: LatencyMetricKind
  count: number
  min?: number
  p50?: number
  p95?: number
  max?: number
  mean?: number
  budgetMs?: number
  ok: boolean
}

export type LatencyEvaluation = {
  profile: LatencyProfile
  ok: boolean
  metrics: LatencyMetricSummary[]
  failures: string[]
}

export const LATENCY_BUDGETS = {
  reference: {
    /** Keypress -> visible rail repaint. */
    railP95Ms: 50,
    /** Durable task patch -> visible Work card. */
    patchCardP95Ms: 250,
  },
  smoke: {
    /** Generous PR threshold; a noisy shared runner is not a reference host. */
    railP95Ms: 500,
    patchCardP95Ms: 5_000,
  },
} as const

const METRIC_ORDER: readonly LatencyMetric[] = ["rail", "patchCard", "firstToken"]

const METRIC_LABEL: Record<LatencyMetric, string> = {
  rail: "rail",
  patchCard: "patchCard",
  firstToken: "firstToken",
}

/** Nearest-rank percentiles, matching the shell probe's previous awk summary. */
export function summarizeSamples(samples: readonly number[]): LatencySummary | undefined {
  if (samples.length === 0) return undefined
  const values = [...samples].sort((left, right) => left - right)
  const n = values.length
  const p50 = values[Math.max(0, Math.floor((n + 1) / 2) - 1)]!
  const p95 = values[Math.max(0, Math.min(n - 1, Math.floor((n * 95 + 99) / 100) - 1))]!
  const total = values.reduce((sum, value) => sum + value, 0)
  return {
    count: n,
    min: values[0]!,
    p50,
    p95,
    max: values[n - 1]!,
    mean: total / n,
  }
}

function budgetFor(profile: LatencyProfile, metric: LatencyMetric): number | undefined {
  if (profile === "report") return undefined
  if (metric === "rail") return LATENCY_BUDGETS[profile].railP95Ms
  if (metric === "patchCard") return LATENCY_BUDGETS[profile].patchCardP95Ms
  return undefined
}

function kindFor(profile: LatencyProfile, metric: LatencyMetric): LatencyMetricKind {
  if (profile === "report") return "report"
  return metric === "firstToken" ? "report" : "gate"
}

/**
 * Evaluate one probe result. Gate metrics need at least one sample and must
 * keep their p95 at or below the profile budget. First-token is summarized but
 * never gated: a slow model is not a slow UI.
 */
export function evaluateLatencyBudget(input: {
  profile?: LatencyProfile
  samples: LatencySamples
}): LatencyEvaluation {
  const profile = input.profile ?? "smoke"
  const failures: string[] = []
  const metrics: LatencyMetricSummary[] = []

  for (const metric of METRIC_ORDER) {
    const samples = input.samples[metric] ?? []
    const valid: number[] = []
    samples.forEach((sample, index) => {
      if (typeof sample !== "number" || !Number.isFinite(sample) || sample < 0) {
        failures.push(`${METRIC_LABEL[metric]}: sample ${index + 1} is not a finite non-negative number`)
        return
      }
      valid.push(sample)
    })
    const summary = summarizeSamples(valid)
    const kind = kindFor(profile, metric)
    const budgetMs = budgetFor(profile, metric)
    let ok = true
    if (kind === "gate") {
      if (!summary) {
        ok = false
        failures.push(`${METRIC_LABEL[metric]}: no samples`)
      } else if (budgetMs !== undefined && summary.p95 > budgetMs) {
        ok = false
        failures.push(`${METRIC_LABEL[metric]} p95=${summary.p95}ms exceeds ${budgetMs}ms`)
      }
    }
    metrics.push({
      metric,
      kind,
      count: summary?.count ?? 0,
      ...(summary
        ? { min: summary.min, p50: summary.p50, p95: summary.p95, max: summary.max, mean: summary.mean }
        : {}),
      ...(budgetMs !== undefined ? { budgetMs } : {}),
      ok,
    })
  }

  return { profile, ok: failures.length === 0, metrics, failures }
}

export function formatLatencyEvaluation(evaluation: LatencyEvaluation): string {
  const lines = evaluation.metrics.map((metric) => {
    const gate = metric.kind === "report" ? "report" : metric.ok ? "pass" : "fail"
    if (metric.count === 0) {
      return `latency-budget: profile=${evaluation.profile} metric=${metric.metric} gate=${gate} n=0`
    }
    return [
      `latency-budget: profile=${evaluation.profile}`,
      `metric=${metric.metric}`,
      `p95=${metric.p95}ms`,
      metric.budgetMs !== undefined ? `budget=${metric.budgetMs}ms` : "budget=none",
      `gate=${gate}`,
      `n=${metric.count}`,
      `p50=${metric.p50}ms`,
      `min=${metric.min}ms`,
      `max=${metric.max}ms`,
      `mean=${metric.mean!.toFixed(1)}ms`,
    ].join(" ")
  })
  for (const failure of evaluation.failures) lines.push(`latency-budget: failure: ${failure}`)
  lines.push(`latency-budget: gate=${evaluation.ok ? "pass" : "fail"}`)
  return lines.join("\n")
}
