/**
 * Retry backoff policy for work outside its attempt budget.
 *
 * The first retry is quick, later retries back off more, and the cap stays
 * bounded so a provider outage cannot turn into a tight retry loop. Jitter
 * keeps a fan-out that failed together from retrying in lockstep.
 */
export const RETRY_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000] as const
export const RETRY_BACKOFF_CAP_MS = 60_000

/** Delay after a failed run. `attempts` is the attempt that just failed. */
export function retryDelayMs(attempts: number, random: () => number = Math.random): number {
  const index = Math.max(0, Math.min(RETRY_BACKOFF_MS.length - 1, Math.floor(attempts) - 1))
  const base = RETRY_BACKOFF_MS[index]!
  const raw = random()
  const roll = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.5
  return Math.min(RETRY_BACKOFF_CAP_MS, Math.max(1_000, Math.round(base * (0.9 + roll * 0.2))))
}

/** The next attempt number shown to the user, capped at the attempt budget. */
export function nextRetryAttempt(attempts: number, maxAttempts: number): number {
  return Math.max(1, Math.min(Math.max(1, Math.floor(maxAttempts)), Math.floor(attempts) + 1))
}
