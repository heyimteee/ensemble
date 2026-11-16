#!/usr/bin/env node
/**
 * Ticket #276: summarize a soak record.
 *
 *   node --experimental-strip-types scripts/soak-report.mjs --samples FILE \
 *     [--out FILE] [--enforce] [--max-rss-mb-per-hour N] [--warmup-seconds N]
 *
 * The report is content-free: samples contain counts and process RSS only.
 */
import { readFileSync, writeFileSync } from "node:fs"

import { summarizeSoak } from "../src/v2/soak-metrics.ts"

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`)
  return value
}

function number(name, fallback) {
  const raw = arg(name, "")
  if (raw === "") return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`)
  return value
}

function main() {
  const samplesPath = arg("--samples")
  if (!samplesPath) throw new Error("--samples is required")
  const samples = []
  for (const line of readFileSync(samplesPath, "utf8").split("\n")) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line)
      if (value && typeof value.at === "number" && value.rss && typeof value.rss.totalBytes === "number") samples.push(value)
    } catch {
      // A partial line from a killed sampler is ignored; the summary reports
      // the sample count it actually used.
    }
  }
  const summary = summarizeSoak(samples, {
    enforce: process.argv.includes("--enforce"),
    maxRssGrowthMbPerHour: number("--max-rss-mb-per-hour", 256),
    maxRssMbPer1000Messages: number("--max-rss-mb-per-1000-messages", 64),
    warmupSeconds: number("--warmup-seconds", undefined),
    requireSettled: !process.argv.includes("--allow-unsettled"),
  })
  const out = arg("--out")
  if (out) writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 })
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    return summary
  }
  console.log(`soak: samples=${summary.samples} duration=${summary.durationSeconds}s window=${summary.windowSeconds}s gate=${summary.gate}`)
  console.log(`soak: baseline rss=${summary.baseline.rssMb}MiB messages=${summary.baseline.messages} tasks=${summary.baseline.tasks}`)
  console.log(`soak: tail     rss=${summary.tail.rssMb}MiB messages=${summary.tail.messages} tasks=${summary.tail.tasks}`)
  console.log(`soak: peak     rss=${summary.peak.rssMb}MiB queue=${summary.peak.queueDepth} native=${summary.peak.nativeTurns} runs=${summary.peak.activeRuns}`)
  console.log(`soak: growth   rss=${summary.growth.rssMbPerHour}MiB/h messages=${summary.growth.messagesPerHour}/h tasks=${summary.growth.tasksPerHour}/h dispatchGroups=${summary.growth.dispatchGroupsPerHour}/h rss=${summary.growth.rssMbPer1000Messages}MiB/1k-msg`)
  if (summary.findings.length === 0) {
    console.log("soak: findings none")
  } else {
    for (const finding of summary.findings) console.log(`soak: finding ${finding.code}: ${finding.message}`)
  }
  console.log(`soak: result ${summary.gate === "enforced" ? (summary.ok ? "PASS" : "FAIL") : "OBSERVED (not a release pass)"} (${summary.gate})`)
  return summary
}

try {
  const summary = main()
  process.exit(summary.ok ? 0 : 1)
} catch (error) {
  console.error(`soak-report: ${error?.message ?? error}`)
  process.exit(2)
}
