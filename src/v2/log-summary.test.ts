import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("../../scripts/log-summary.mjs", import.meta.url))

const row = (patch: Record<string, unknown>) => ({
  ts: "2026-01-01T00:00:00.000Z",
  level: "info",
  cat: "dispatch",
  role: "service",
  instanceID: "svc-1",
  ...patch,
})

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-log-summary-"))
  const rows = [
    row({ event: "dispatch.group.created", dispatchGroupID: "dispatch_root", rootID: "dispatch_root", usedHops: 0, maxHops: 8 }),
    row({ event: "dispatch.hop.consumed", dispatchGroupID: "dispatch_root", rootID: "dispatch_root", taskID: "t1", usedHops: 1, maxHops: 8, title: "SECRET_TITLE" }),
    row({ event: "dispatch.group.exhausted", level: "warn", dispatchGroupID: "dispatch_root", rootID: "dispatch_root", reason: "group-exhausted", usedHops: 8, maxHops: 8 }),
    row({ event: "dispatch.group.continued", dispatchGroupID: "dispatch_cont", rootID: "dispatch_root", parentID: "dispatch_root", continuationIndex: 1, usedHops: 0, maxHops: 8 }),
    row({ event: "dispatch.group.closed", dispatchGroupID: "dispatch_root", rootID: "dispatch_root", closeReason: "continued", durationMs: 5 }),
    row({ event: "dispatch.hop.refused", level: "warn", dispatchGroupID: "dispatch_cont", rootID: "dispatch_root", reason: "task-exhausted", usedHops: 1, maxHops: 8 }),
    row({ event: "dispatch.hop.consumed", dispatchGroupID: "dispatch_other", rootID: "dispatch_other", taskID: "t2", usedHops: 1, maxHops: 8 }),
    row({ event: "task.failed", level: "error", cat: "task", taskID: "t2", error: "boom", title: "SECRET_TITLE" }),
  ]
  writeFileSync(join(dir, "service-20260101.jsonl"), `${rows.map((entry) => JSON.stringify(entry)).join("\n")}\n`)
  return dir
}

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

test("ticket163: log summary reports dispatch counts and recent warnings", () => {
  const dir = fixture()
  try {
    const json = run(["--dir", dir, "--json"])
    assert.equal(json.status, 0, json.stderr)
    const summary = JSON.parse(json.stdout)
    assert.equal(summary.rows, 8)
    assert.equal(summary.dispatch.groups, 3)
    assert.equal(summary.dispatch.hops, 2)
    assert.equal(summary.dispatch.exhausted, 1)
    assert.equal(summary.dispatch.continued, 1)
    assert.equal(summary.dispatch.refused, 1)
    assert.equal(summary.dispatch.closed, 1)
    assert.equal(summary.dispatch.created, 1)
    assert.equal(summary.dispatch.reconciled, 0)
    assert.equal(summary.dispatch.invalidSettings, 0)
    assert.deepEqual(summary.dispatch.groupIDs, ["dispatch_cont", "dispatch_other", "dispatch_root"])
    assert.equal(summary.dispatch.recentExhaustions.length, 1)
    assert.equal(summary.dispatch.recentExhaustions[0].reason, "group-exhausted")
    assert.equal(summary.dispatch.recentRefusals.length, 1)
    assert.equal(summary.dispatch.recentRefusals[0].reason, "task-exhausted")
    assert.equal(json.stdout.includes("SECRET_TITLE"), false)

    const text = run(["--dir", dir])
    assert.equal(text.status, 0, text.stderr)
    assert.match(text.stdout, /^dispatch: groups=3 hops=2 exhausted=1 continued=1 refused=1 closed=1$/m)
    assert.match(text.stdout, /dispatch warnings: 2/)
    assert.equal(text.stdout.includes("SECRET_TITLE"), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ticket163: --group audits one command without changing existing filters", () => {
  const dir = fixture()
  try {
    const filtered = run(["--dir", dir, "--group", "dispatch_root", "--json"])
    assert.equal(filtered.status, 0, filtered.stderr)
    const summary = JSON.parse(filtered.stdout)
    assert.equal(summary.filters.group, "dispatch_root")
    assert.equal(summary.rows, 6, "the other command and its unrelated task row are excluded")
    assert.equal(summary.dispatch.groups, 2, "the root command includes its continuation group")
    assert.equal(summary.dispatch.hops, 1)
    assert.equal(summary.dispatch.exhausted, 1)
    assert.equal(summary.dispatch.continued, 1)
    assert.equal(summary.dispatch.refused, 1)
    assert.equal(summary.dispatch.closed, 1)
    assert.equal(summary.dispatch.recentExhaustions.length, 1)
    assert.equal(summary.dispatch.recentRefusals.length, 1)

    const byEvent = run(["--dir", dir, "--event", "dispatch.hop.consumed", "--json"])
    assert.equal(byEvent.status, 0, byEvent.stderr)
    assert.equal(JSON.parse(byEvent.stdout).rows, 2, "the existing --event prefix filter still works")

    const byLevel = run(["--dir", dir, "--level", "warn", "--json"])
    assert.equal(byLevel.status, 0, byLevel.stderr)
    assert.equal(JSON.parse(byLevel.stdout).rows, 3, "the existing --level filter still works")

    assert.equal(run(["--dir", dir, "--group"]).status, 1, "a missing group id is a usage error")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
