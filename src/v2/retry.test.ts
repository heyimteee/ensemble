import test from "node:test"
import assert from "node:assert/strict"
import { RETRY_BACKOFF_CAP_MS, RETRY_BACKOFF_MS, nextRetryAttempt, retryDelayMs } from "./retry.ts"

test("retry backoff follows 5/15/30/60 seconds and caps at 60", () => {
  assert.deepEqual([...RETRY_BACKOFF_MS], [5_000, 15_000, 30_000, 60_000])
  assert.equal(retryDelayMs(1, () => 0.5), 5_000)
  assert.equal(retryDelayMs(2, () => 0.5), 15_000)
  assert.equal(retryDelayMs(3, () => 0.5), 30_000)
  assert.equal(retryDelayMs(4, () => 0.5), 60_000)
  assert.equal(retryDelayMs(99, () => 0.5), RETRY_BACKOFF_CAP_MS)
})

test("retry backoff jitters but never exceeds the cap", () => {
  assert.ok(retryDelayMs(1, () => 0) >= 4_500)
  assert.ok(retryDelayMs(1, () => 1) <= 5_500)
  assert.ok(retryDelayMs(99, () => 1) <= RETRY_BACKOFF_CAP_MS)
  assert.ok(retryDelayMs(99, () => 0) <= RETRY_BACKOFF_CAP_MS)
  assert.equal(retryDelayMs(2, () => Number.NaN), 15_000)
})

test("the retry attempt shown is the next attempt, capped at the budget", () => {
  assert.equal(nextRetryAttempt(1, 5), 2)
  assert.equal(nextRetryAttempt(4, 5), 5)
  assert.equal(nextRetryAttempt(9, 5), 5)
})
