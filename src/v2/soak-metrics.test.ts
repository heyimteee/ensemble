import test from "node:test"
import assert from "node:assert/strict"

import {
  diagnosticCounts,
  summarizeSoak,
  type SoakSample,
} from "./soak-metrics.ts"

const MB = 1024 * 1024

function sample(patch: Partial<SoakSample> = {}): SoakSample {
  const base: SoakSample = {
    at: 1_000,
    elapsedSeconds: 0,
    rss: { serviceBytes: 100 * MB, tuiBytes: 50 * MB, totalBytes: 150 * MB },
    messages: 10,
    tasks: 2,
    tasksByState: { pending: 0, working: 0, replied: 2 },
    queue: { pending: 0, working: 0, retrying: 0, stalled: 0, approvals: 0, dm: 0, activeRuns: 0 },
    native: { subagents: 0, activeSubagents: 0, rows: 0, watchdogTurns: 0, shadowTurns: 0, shadowSessions: 0 },
    dispatchGroups: 1,
    storageBytes: 1024,
    diagnosticBytes: 2048,
    diagnosticMs: 5,
    log: { ring: 10, dropped: 0, written: 10, failedWrites: 0 },
  }
  return {
    ...base,
    ...patch,
    rss: { ...base.rss, ...(patch.rss ?? {}) },
    queue: { ...base.queue, ...(patch.queue ?? {}) },
    native: { ...base.native, ...(patch.native ?? {}) },
    log: { ...base.log, ...(patch.log ?? {}) },
    tasksByState: { ...base.tasksByState, ...(patch.tasksByState ?? {}) },
  }
}

test("ticket276: diagnostic counts read durable and in-memory growth without content", () => {
  const counts = diagnosticCounts({
    state: {
      messages: {
        ws1: [
          { id: "m1", text: "SECRET_MESSAGE", author: "user" },
          { id: "m2", text: "SECRET_REPLY", author: "agent", native: { inboxID: "in1" } },
        ],
        dm: [{ id: "m3", author: "agent", native: { turnID: "t1" } }],
      },
      subtasks: {
        t1: { id: "t1", state: "pending", status: "pending" },
        t2: { id: "t2", state: "working", status: "retrying" },
        t3: { id: "t3", state: "replied", status: "stalled" },
        t4: { id: "t4", state: "replied", status: "replied" },
      },
      approvals: {
        a1: { id: "a1", status: "pending" },
        a2: { id: "a2", status: "resolved" },
      },
      dmQueue: [{ id: "d1" }, { id: "d2" }],
      nativeSubagents: { s1: { childSessionID: "s1", state: "working" }, s2: { childSessionID: "s2", state: "replied" } },
      dispatchGroups: { g1: { id: "g1" }, g2: { id: "g2" } },
      runs: { r1: { id: "r1" }, r2: { id: "r2" }, r3: { id: "r3" } },
    },
    native: {
      watchdog: { turns: { t1: { passes: 1 } } },
      shadow: { activeTurns: 2, activeSessions: 1 },
    },
    logs: { ringSize: 12, dropped: 3, written: 40, failedWrites: 1 },
  })

  assert.equal(counts.messages, 3)
  assert.equal(counts.tasks, 4)
  assert.deepEqual(counts.tasksByState, { pending: 1, working: 1, replied: 2 })
  assert.equal(counts.queue.pending, 1)
  assert.equal(counts.queue.working, 1)
  assert.equal(counts.queue.retrying, 1)
  assert.equal(counts.queue.stalled, 1)
  assert.equal(counts.queue.approvals, 1)
  assert.equal(counts.queue.dm, 2)
  assert.equal(counts.queue.activeRuns, 3)
  assert.equal(counts.native.subagents, 2)
  assert.equal(counts.native.activeSubagents, 1)
  assert.equal(counts.native.rows, 2)
  assert.equal(counts.native.watchdogTurns, 1)
  assert.equal(counts.native.shadowTurns, 2)
  assert.equal(counts.native.shadowSessions, 1)
  assert.equal(counts.dispatchGroups, 2)
  assert.deepEqual(counts.log, { ring: 12, dropped: 3, written: 40, failedWrites: 1 })
  assert.equal(JSON.stringify(counts).includes("SECRET"), false)
})

test("ticket276: diagnostic counts tolerate a pre-metric or empty diagnostic", () => {
  const counts = diagnosticCounts({ state: {} })
  assert.equal(counts.messages, 0)
  assert.equal(counts.tasks, 0)
  assert.deepEqual(counts.tasksByState, {})
  assert.equal(counts.queue.pending, 0)
  assert.equal(counts.native.watchdogTurns, 0)
  assert.deepEqual(counts.log, { ring: 0, dropped: 0, written: 0, failedWrites: 0 })
})

test("ticket276: soak growth uses a warmup baseline and reports per-hour slope", () => {
  const samples: SoakSample[] = [
    sample({ at: 0, elapsedSeconds: 0, rss: { serviceBytes: 200 * MB, tuiBytes: 0, totalBytes: 200 * MB } }),
    sample({ at: 1_800_000, elapsedSeconds: 1_800, rss: { serviceBytes: 140 * MB, tuiBytes: 0, totalBytes: 140 * MB } }),
    sample({ at: 3_600_000, elapsedSeconds: 3_600, rss: { serviceBytes: 140 * MB, tuiBytes: 0, totalBytes: 140 * MB }, messages: 100, tasks: 20 }),
    sample({ at: 10_800_000, elapsedSeconds: 10_800, rss: { serviceBytes: 170 * MB, tuiBytes: 0, totalBytes: 170 * MB }, messages: 400, tasks: 40 }),
    sample({ at: 18_000_000, elapsedSeconds: 18_000, rss: { serviceBytes: 200 * MB, tuiBytes: 0, totalBytes: 200 * MB }, messages: 700, tasks: 60 }),
  ]

  const summary = summarizeSoak(samples, { warmupSeconds: 3_600, maxRssGrowthMbPerHour: 20, maxRssMbPer1000Messages: 200 })
  assert.equal(summary.samples, 5)
  assert.equal(summary.durationSeconds, 18_000)
  assert.equal(summary.windowSeconds, 14_400)
  assert.equal(summary.baseline.rssMb, 140)
  assert.equal(summary.tail.rssMb, 200)
  assert.equal(summary.growth.rssMbPerHour, 15)
  assert.equal(summary.growth.messagesPerHour, 150)
  assert.equal(summary.growth.tasksPerHour, 10)
  assert.equal(summary.peak.rssMb, 200)
  assert.deepEqual(summary.findings, [])
  assert.equal(summary.ok, true)
  assert.equal(summary.gate, "observe-only")
})

test("ticket276: an enforced soak fails on RSS growth, an unsettled queue, or native turns", () => {
  const samples: SoakSample[] = [
    sample({ at: 0, elapsedSeconds: 0 }),
    sample({ at: 60_000, elapsedSeconds: 60 }),
    sample({
      at: 3_600_000,
      elapsedSeconds: 3600,
      rss: { serviceBytes: 400 * MB, tuiBytes: 50 * MB, totalBytes: 450 * MB },
      messages: 2_000,
      tasks: 500,
      queue: { pending: 3, working: 1, retrying: 0, stalled: 0, approvals: 0, dm: 0, activeRuns: 1 },
      native: { subagents: 1, activeSubagents: 1, rows: 2, watchdogTurns: 2, shadowTurns: 3, shadowSessions: 1 },
    }),
  ]

  const observed = summarizeSoak(samples, { warmupSeconds: 30 })
  assert.equal(observed.ok, true)
  assert.equal(observed.gate, "observe-only")
  assert.deepEqual(observed.findings.map((finding) => finding.code).sort(), [
    "native-not-settled",
    "queue-not-settled",
    "rss-growth",
    "rss-per-message",
  ])

  const enforced = summarizeSoak(samples, {
    warmupSeconds: 30,
    enforce: true,
    maxRssGrowthMbPerHour: 120,
    maxRssMbPer1000Messages: 500,
    requireSettled: true,
  })
  assert.equal(enforced.ok, false)
  assert.equal(enforced.gate, "enforced")
  assert.equal(enforced.findings.length, 3)
})

test("ticket276: normalized growth catches a leak that message retention explains", () => {
  const samples: SoakSample[] = [
    sample({ at: 0, elapsedSeconds: 0, messages: 0, tasks: 0 }),
    sample({ at: 1_800_000, elapsedSeconds: 1_800, messages: 1_000, tasks: 100, rss: { serviceBytes: 110 * MB, tuiBytes: 0, totalBytes: 110 * MB } }),
    sample({ at: 3_600_000, elapsedSeconds: 3_600, messages: 2_000, tasks: 200, rss: { serviceBytes: 120 * MB, tuiBytes: 0, totalBytes: 120 * MB } }),
  ]
  const explained = summarizeSoak(samples, {
    warmupSeconds: 1_800,
    enforce: true,
    maxRssGrowthMbPerHour: 256,
    maxRssMbPer1000Messages: 64,
  })
  assert.equal(explained.growth.rssMbPer1000Messages, 10)
  assert.deepEqual(explained.findings, [])
  assert.equal(explained.ok, true)

  const leaky = summarizeSoak(samples.map((entry) => ({
    ...entry,
    rss: { ...entry.rss, serviceBytes: entry.rss.serviceBytes + entry.elapsedSeconds * 0.1 * MB, totalBytes: entry.rss.totalBytes + entry.elapsedSeconds * 0.1 * MB },
  })), {
    warmupSeconds: 1_800,
    enforce: true,
    maxRssGrowthMbPerHour: 1_000,
    maxRssMbPer1000Messages: 64,
  })
  assert.equal(leaky.growth.rssMbPer1000Messages, 190)
  assert.deepEqual(leaky.findings.map((finding) => finding.code), ["rss-per-message"])
  assert.equal(leaky.ok, false)
})

test("ticket276: a short warmup cannot make a flat soak look unbounded", () => {
  const forHour = Array.from({ length: 13 }, (_, index) => sample({
    at: index * 300_000,
    elapsedSeconds: index * 300,
    rss: { serviceBytes: 100 * MB, tuiBytes: 25 * MB, totalBytes: 125 * MB },
    messages: 10 + index * 5,
  }))
  const summary = summarizeSoak(forHour, { warmupSeconds: 60, enforce: true, maxRssGrowthMbPerHour: 1 })
  assert.equal(summary.growth.rssMbPerHour, 0)
  assert.deepEqual(summary.findings, [])
  assert.equal(summary.ok, true)
})
