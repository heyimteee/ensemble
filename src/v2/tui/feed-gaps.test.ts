import test from "node:test"
import assert from "node:assert/strict"
import { createFeedGapReporter } from "./feed-gaps.ts"

type Emitted = {
  level: string
  event: string
  fields: Record<string, unknown>
}

function harness(windowMs = 10_000) {
  const emitted: Emitted[] = []
  let counted = 0
  const reporter = createFeedGapReporter({
    windowMs,
    now: () => 1_000,
    emit: (level, event, fields) => emitted.push({ level, event, fields }),
    count: () => { counted += 1 },
  })
  return { reporter, emitted, counted: () => counted }
}

test("a recoverable gap counts once and logs debug, not warn", () => {
  const { reporter, emitted, counted } = harness()

  reporter.record({ reason: "gap", from: 5, version: 6, entries: 1, reset: false })
  reporter.settle("recovered")

  assert.equal(counted(), 1, "every observed gap reaches the diagnostic counter")
  assert.equal(emitted.length, 0, "the summary waits for the trailing window")
  reporter.flush()

  assert.equal(emitted.length, 1)
  const [summary] = emitted
  assert.equal(summary.level, "debug", "a caught-up gap is not a warning")
  assert.equal(summary.event, "feed.gap.recovered")
  assert.equal(summary.fields.gaps, 1)
  assert.equal(summary.fields.reason, "gap")
  assert.equal(summary.fields.from, 5)
  assert.equal(summary.fields.version, 6)
  assert.equal(summary.fields.entries, 1)
  assert.equal(summary.fields.fallbacks, 0)
})

test("a reset or full-snapshot fallback still warns with its reason", () => {
  const { reporter, emitted } = harness()

  reporter.record({ reason: "reset", version: 9, entries: 0, reset: true })
  reporter.settle("full")
  reporter.flush()

  assert.equal(emitted.length, 1)
  const [summary] = emitted
  assert.equal(summary.level, "warn")
  assert.equal(summary.event, "feed.gap")
  assert.equal(summary.fields.reason, "reset")
  assert.equal(summary.fields.reset, true)
  assert.equal(summary.fields.fullSnapshot, true)
  assert.equal(summary.fields.fallbacks, 1)
})

test("a burst produces one summary, not one line per gap", () => {
  const { reporter, emitted, counted } = harness()

  for (let index = 0; index < 6; index++) {
    reporter.record({ reason: "gap", from: index + 2, version: index + 3, entries: 1 })
    reporter.settle("recovered")
  }
  reporter.flush()

  assert.equal(counted(), 6, "the counter keeps the true rate")
  assert.equal(emitted.length, 1, "the window coalesces the burst")
  assert.equal(emitted[0].level, "debug")
  assert.equal(emitted[0].fields.gaps, 6)
})

test("repeated hard gaps coalesce into one warning with their reasons", () => {
  const { reporter, emitted, counted } = harness()

  reporter.record({ reason: "malformed", version: 4 })
  reporter.settle("full")
  reporter.record({ reason: "other", version: 5 })
  reporter.settle("full")
  reporter.flush()

  assert.equal(counted(), 2)
  assert.equal(emitted.length, 1, "a hard burst still emits one warning")
  const [summary] = emitted
  assert.equal(summary.level, "warn")
  assert.equal(summary.event, "feed.gap")
  assert.equal(summary.fields.gaps, 2)
  assert.deepEqual(summary.fields.reasons, ["malformed", "other"])
  assert.equal(summary.fields.reason, "other")
  assert.equal(summary.fields.fallbacks, 2)
})

test("the window closes on its own so a stopped burst still reports", async () => {
  const emitted: Emitted[] = []
  const reporter = createFeedGapReporter({
    windowMs: 20,
    emit: (level, event, fields) => emitted.push({ level, event, fields }),
  })

  reporter.record({ reason: "gap", from: 2, version: 3, entries: 1 })
  reporter.settle("recovered")
  await new Promise<void>((resolve) => setTimeout(resolve, 80))

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].event, "feed.gap.recovered")
  assert.equal(emitted[0].fields.gaps, 1)
  reporter.dispose()
})
