import assert from "node:assert/strict"
import { test } from "node:test"
import {
  LATENCY_BUDGETS,
  evaluateLatencyBudget,
  formatLatencyEvaluation,
  summarizeSamples,
} from "./latency-budget.ts"

test("summarizeSamples reports the probe percentiles for five ordered samples", () => {
  const summary = summarizeSamples([10, 20, 30, 40, 50])
  assert.deepEqual(summary, { count: 5, min: 10, p50: 30, p95: 50, max: 50, mean: 30 })
})

test("summarizeSamples sorts unsorted samples before taking percentiles", () => {
  const summary = summarizeSamples([50, 10, 40, 20, 30])
  assert.deepEqual(summary, { count: 5, min: 10, p50: 30, p95: 50, max: 50, mean: 30 })
})

test("summarizeSamples keeps the probe's nearest-rank percentiles for ten samples", () => {
  const summary = summarizeSamples([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.equal(summary?.p50, 5)
  assert.equal(summary?.p95, 10)
})

test("summarizeSamples returns undefined for no samples", () => {
  assert.equal(summarizeSamples([]), undefined)
})

test("the reference profile passes samples at the rail and patch-card budgets", () => {
  const evaluation = evaluateLatencyBudget({
    profile: "reference",
    samples: { rail: [49], patchCard: [249], firstToken: [4_000] },
  })
  assert.equal(evaluation.ok, true)
  assert.deepEqual(evaluation.failures, [])
  assert.equal(evaluation.metrics.find((metric) => metric.metric === "rail")?.budgetMs, 50)
  assert.equal(evaluation.metrics.find((metric) => metric.metric === "patchCard")?.budgetMs, 250)
})

test("the reference profile fails samples over the rail and patch-card budgets", () => {
  const evaluation = evaluateLatencyBudget({
    profile: "reference",
    samples: { rail: [51], patchCard: [251], firstToken: [4_000] },
  })
  assert.equal(evaluation.ok, false)
  assert.equal(evaluation.failures.length, 2)
  assert.match(evaluation.failures[0]!, /rail p95=51ms exceeds 50ms/)
  assert.match(evaluation.failures[1]!, /patchCard p95=251ms exceeds 250ms/)
})

test("first-token is report only and never fails a gate", () => {
  const evaluation = evaluateLatencyBudget({
    profile: "reference",
    samples: { rail: [9], patchCard: [40], firstToken: [60_000] },
  })
  assert.equal(evaluation.ok, true)
  const firstToken = evaluation.metrics.find((metric) => metric.metric === "firstToken")
  assert.equal(firstToken?.kind, "report")
  assert.equal(firstToken?.budgetMs, undefined)
  assert.equal(firstToken?.p95, 60_000)
})

test("the smoke profile uses the generous PR thresholds", () => {
  const passing = evaluateLatencyBudget({
    profile: "smoke",
    samples: { rail: [400], patchCard: [4_000] },
  })
  assert.equal(passing.ok, true)
  assert.equal(LATENCY_BUDGETS.smoke.railP95Ms, 500)
  assert.equal(LATENCY_BUDGETS.smoke.patchCardP95Ms, 5_000)

  const failing = evaluateLatencyBudget({
    profile: "smoke",
    samples: { rail: [501], patchCard: [5_001] },
  })
  assert.equal(failing.ok, false)
  assert.equal(failing.failures.length, 2)
})

test("a missing gate sample set fails instead of passing vacuously", () => {
  const evaluation = evaluateLatencyBudget({ profile: "reference", samples: { rail: [9] } })
  assert.equal(evaluation.ok, false)
  assert.match(evaluation.failures.join("\n"), /patchCard: no samples/)
})

test("an invalid sample fails with its metric and index", () => {
  const evaluation = evaluateLatencyBudget({
    profile: "reference",
    samples: { rail: [9, -1], patchCard: [40] },
  })
  assert.equal(evaluation.ok, false)
  assert.match(evaluation.failures.join("\n"), /rail: sample 2 is not a finite non-negative number/)
})

test("the report profile never gates and marks every metric report only", () => {
  const evaluation = evaluateLatencyBudget({
    profile: "report",
    samples: { rail: [999], patchCard: [9_999], firstToken: [60_000] },
  })
  assert.equal(evaluation.ok, true)
  assert.equal(evaluation.metrics.every((metric) => metric.kind === "report"), true)
  assert.equal(evaluation.metrics.every((metric) => metric.budgetMs === undefined), true)
})

test("a deliberate patch-card regression fails the reference gate", () => {
  const baseline = evaluateLatencyBudget({
    profile: "reference",
    samples: { rail: [9], patchCard: [40] },
  })
  assert.equal(baseline.ok, true)

  const regressionMs = 1_000
  const regressed = evaluateLatencyBudget({
    profile: "reference",
    samples: { rail: [9], patchCard: [40 + regressionMs] },
  })
  assert.equal(regressed.ok, false)
  assert.match(regressed.failures.join("\n"), /patchCard p95=1040ms exceeds 250ms/)
})

test("the formatted report names the profile, each metric, and the gate result", () => {
  const evaluation = evaluateLatencyBudget({
    profile: "reference",
    samples: { rail: [9, 11], patchCard: [40, 45], firstToken: [1_200] },
  })
  const text = formatLatencyEvaluation(evaluation)
  assert.match(text, /latency-budget: profile=reference/)
  assert.match(text, /metric=rail .*p95=11ms .*budget=50ms .*gate=pass/)
  assert.match(text, /metric=patchCard .*p95=45ms .*budget=250ms .*gate=pass/)
  assert.match(text, /metric=firstToken .*gate=report/)
  assert.match(text, /latency-budget: gate=pass/)
})
