import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../..", import.meta.url))
const soak = fileURLToPath(new URL("../../scripts/soak-fake.sh", import.meta.url))
const report = fileURLToPath(new URL("../../scripts/soak-report.mjs", import.meta.url))
const sampler = fileURLToPath(new URL("../../scripts/soak-sample.mjs", import.meta.url))
const bash = process.env.BASH || "/bin/bash"

function run(command: string, args: string[], stdin?: string) {
  return spawnSync(command, args, { encoding: "utf8", input: stdin, cwd: root })
}

test("ticket276: the soak harness defaults to a multi-hour run and has a short smoke mode", () => {
  const text = readFileSync(soak, "utf8")
  assert.match(text, /ENSEMBLE_SOAK_DURATION_SECONDS:-14400/)
  assert.match(text, /--smoke\)/)
  assert.match(text, /duration=180/)
  assert.match(text, /observe-only/)
})

test("ticket276: the soak harness help works without a live host", () => {
  const result = run(bash, [soak, "--help"])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /--smoke/)
  assert.match(result.stdout, /--duration/)
  assert.match(result.stdout, /--enforce/)
})

test("ticket276: the soak sampler reduces a diagnostic without copying content", () => {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-soak-sample-"))
  try {
    const diagnostic = join(dir, "diagnostic.json")
    writeFileSync(diagnostic, JSON.stringify({
      output: {
        state: {
          messages: { ws: [{ id: "m1", text: "SECRET_MESSAGE" }, { id: "m2", text: "SECRET_REPLY", native: { inboxID: "i1" } }] },
          subtasks: { t1: { id: "t1", state: "pending", status: "pending" } },
          approvals: {},
          dmQueue: {},
          nativeSubagents: {},
          dispatchGroups: { g1: { id: "g1" } },
        },
        native: { watchdog: { turns: {} }, shadow: { activeTurns: 0, activeSessions: 0 } },
        logs: { ringSize: 2, dropped: 0, written: 4, failedWrites: 0 },
      },
    }))
    const result = run(process.execPath, ["--experimental-strip-types", sampler, "--diagnostic", diagnostic, "--at", "1000", "--elapsed", "10"])
    assert.equal(result.status, 0, result.stderr)
    const sample = JSON.parse(result.stdout)
    assert.equal(sample.messages, 2)
    assert.equal(sample.tasks, 1)
    assert.equal(sample.queue.pending, 1)
    assert.equal(sample.native.rows, 1)
    assert.equal(sample.dispatchGroups, 1)
    assert.equal(result.stdout.includes("SECRET"), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ticket276: the soak report enforces the growth gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-soak-report-"))
  try {
    const samples = join(dir, "soak.jsonl")
    const rows = [
      { at: 0, elapsedSeconds: 0, rss: { serviceBytes: 100 * 1024 * 1024, tuiBytes: 0, totalBytes: 100 * 1024 * 1024 }, messages: 10, tasks: 1, tasksByState: {}, queue: { pending: 0, working: 0, retrying: 0, stalled: 0, approvals: 0, dm: 0, activeRuns: 0 }, native: { subagents: 0, activeSubagents: 0, rows: 0, watchdogTurns: 0, shadowTurns: 0, shadowSessions: 0 }, dispatchGroups: 1, storageBytes: 1, diagnosticBytes: 1, diagnosticMs: 1, log: { ring: 1, dropped: 0, written: 1, failedWrites: 0 } },
      { at: 3_600_000, elapsedSeconds: 3_600, rss: { serviceBytes: 400 * 1024 * 1024, tuiBytes: 0, totalBytes: 400 * 1024 * 1024 }, messages: 100, tasks: 10, tasksByState: {}, queue: { pending: 0, working: 0, retrying: 0, stalled: 0, approvals: 0, dm: 0, activeRuns: 0 }, native: { subagents: 0, activeSubagents: 0, rows: 0, watchdogTurns: 0, shadowTurns: 0, shadowSessions: 0 }, dispatchGroups: 10, storageBytes: 1, diagnosticBytes: 1, diagnosticMs: 1, log: { ring: 1, dropped: 0, written: 1, failedWrites: 0 } },
    ]
    writeFileSync(samples, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)
    const observed = run(process.execPath, ["--experimental-strip-types", report, "--samples", samples, "--warmup-seconds", "0"])
    assert.equal(observed.status, 0, observed.stderr)
    assert.match(observed.stdout, /gate=observe-only/)
    assert.match(observed.stdout, /finding rss-growth/)
    assert.match(observed.stdout, /result OBSERVED \(not a release pass\)/)

    const enforced = run(process.execPath, ["--experimental-strip-types", report, "--samples", samples, "--warmup-seconds", "0", "--enforce"])
    assert.equal(enforced.status, 1)
    assert.match(enforced.stdout, /result FAIL/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
