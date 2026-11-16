#!/usr/bin/env node
/**
 * Flake report CLI for the live harness.
 *
 * The harness writes a structured failure record (failure.json) on a failed
 * attempt. The matrix runner calls `classify` to decide whether a retry is
 * allowed, then appends an attempt record to a JSONL history and calls
 * `report` to print and persist the per-suite flake report.
 *
 * Usage:
 *   node scripts/flake-report.mjs classify --file FAILURE.json
 *   node scripts/flake-report.mjs retry --file FAILURE.json [--attempt N] [--quarantined]
 *   node scripts/flake-report.mjs report --records RECORDS.jsonl [--out REPORT.json]
 *   node scripts/flake-report.mjs quarantine --file QUARANTINE.json
 *
 * Exit codes: 0 success, 1 invalid input or a policy breach, 2 usage.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import {
  buildFlakeReport,
  classifyFailure,
  formatFlakeReport,
  retryDecision,
  validateQuarantine,
} from "../src/v2/flake-policy.ts"

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`)
  return value
}

function has(name) {
  return process.argv.includes(name)
}

function readJson(path) {
  if (!path || !existsSync(path)) throw new Error(`file not found: ${path ?? "<missing>"}`)
  return JSON.parse(readFileSync(path, "utf8"))
}

function readRecords(path) {
  if (!path || !existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function main() {
  const command = process.argv[2]
  if (command === "classify") {
    const record = readJson(arg("--file"))
    const classification = classifyFailure({ message: String(record.message ?? ""), kind: record.kind })
    process.stdout.write(`${classification}\n`)
    return 0
  }
  if (command === "retry") {
    const record = readJson(arg("--file"))
    const attempt = Number(arg("--attempt", String(record.attempt ?? 1)))
    const classification = classifyFailure({ message: String(record.message ?? ""), kind: record.kind })
    const decision = retryDecision(
      { suite: String(record.suite ?? "unknown"), attempt, status: "failed", classification, message: record.message },
      { quarantined: has("--quarantined") },
    )
    process.stdout.write(`${decision.retry ? "retry" : "no-retry"} ${decision.reason}\n`)
    return 0
  }
  if (command === "report") {
    const records = readRecords(arg("--records"))
    const report = buildFlakeReport(records)
    const text = formatFlakeReport(report)
    process.stdout.write(`${text}\n`)
    const out = arg("--out", "")
    if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
    return report.budget.ok ? 0 : 1
  }
  if (command === "quarantine") {
    const entries = readJson(arg("--file", "scripts/flake-quarantine.json"))
    const validation = validateQuarantine(entries)
    if (!validation.ok) {
      for (const error of validation.errors) process.stderr.write(`flake-report: quarantine: ${error}\n`)
      return 1
    }
    if (has("--list")) {
      for (const entry of entries) process.stdout.write(`${entry.suite}\t${entry.issue}\t${entry.owner}\n`)
      return 0
    }
    process.stdout.write(`flake-report: quarantine: ${entries.length} entr${entries.length === 1 ? "y" : "ies"} valid\n`)
    return 0
  }
  process.stderr.write("usage: flake-report.mjs classify|retry|report|quarantine ...\n")
  return 2
}

try {
  process.exitCode = main()
} catch (error) {
  process.stderr.write(`flake-report: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
}
