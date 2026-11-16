/**
 * Pure matrix policy for `scripts/live-matrix.sh` (ticket #256 review fix).
 *
 * The shell runner executes each scenario and records the attempt; this module
 * owns the one decision that must never drift: a failed attempt may retry or
 * quarantine only when the harness classified it as a timing failure. Product,
 * unknown, and infrastructure failures always fail, even when the suite has a
 * quarantine entry. The retry ceiling is `FLAKE_BUDGET.maxRetriesPerSuite`, so
 * the shell and the flake report cannot disagree.
 */
import { retryDecision, type FlakeClassification } from "./flake-policy.ts"

export type FailedAttemptOutcome = "retry" | "quarantine" | "fail"

export type FailedAttemptDecision = {
  outcome: FailedAttemptOutcome
  reason: string
}

/**
 * Decide what to do after one failed scenario attempt. Classification comes
 * first: a quarantine can never mask a product, unknown, or infrastructure
 * failure. A quarantined timing failure is its own outcome, not a pass.
 */
export function decideFailedAttempt(input: {
  classification: FlakeClassification
  attempt: number
  quarantined?: boolean
}): FailedAttemptDecision {
  const attempt = Math.max(1, Math.trunc(input.attempt))
  if (input.classification !== "timing") {
    return {
      outcome: "fail",
      reason: `${input.classification} failure never retries or quarantines`,
    }
  }
  if (input.quarantined) {
    return { outcome: "quarantine", reason: "timing failure in a quarantined suite" }
  }
  const decision = retryDecision({
    suite: "matrix",
    attempt,
    status: "failed",
    classification: input.classification,
  })
  if (decision.retry) return { outcome: "retry", reason: decision.reason }
  return { outcome: "fail", reason: `${decision.reason}; flake budget unchanged` }
}
