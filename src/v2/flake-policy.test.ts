import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import {
  buildFlakeReport,
  classifyFailure,
  formatFlakeReport,
  retryDecision,
  validateQuarantine,
  type AttemptRecord,
} from "./flake-policy.ts"

const cli = fileURLToPath(new URL("../../scripts/flake-report.mjs", import.meta.url))

const attempt = (patch: Partial<AttemptRecord> = {}): AttemptRecord => ({
  suite: "fake",
  attempt: 1,
  status: "failed",
  classification: "timing",
  message: "timed out after 10s waiting for members step",
  artifactPath: "/tmp/opencode/ensemble-live-artifacts/fake/attempt-1",
  durationSeconds: 12,
  ...patch,
})

test("a readiness timeout is a timing failure", () => {
  assert.equal(classifyFailure({ message: "timed out after 10s waiting for members step" }), "timing")
  assert.equal(classifyFailure({ message: "typed text did not reach the TUI: AlignProbe" }), "timing")
  assert.equal(classifyFailure({ message: "could not select the chat pane (last context other)" }), "timing")
  assert.equal(classifyFailure({ kind: "timing" }), "timing")
})

test("a product assertion is never classified as timing", () => {
  assert.equal(classifyFailure({ message: "member wizard separators do not align in one column" }), "unknown")
  assert.equal(classifyFailure({ message: "unexpected roster leader (got \"Helper\")" }), "unknown")
  assert.equal(classifyFailure({ message: "TUI does not show: leader label on the name row" }), "unknown")
  assert.equal(classifyFailure({ kind: "product" }), "product")
})

test("infrastructure failures are named, not retried", () => {
  assert.equal(classifyFailure({ message: "OpenCode server did not print its URL" }), "infrastructure")
  assert.equal(classifyFailure({ kind: "infrastructure" }), "infrastructure")
})

test("only a classified timing failure retries, and only once", () => {
  assert.deepEqual(retryDecision(attempt()), { retry: true, reason: "timing failure on attempt 1" })
  assert.equal(retryDecision(attempt({ attempt: 2 })).retry, false)
  assert.equal(retryDecision(attempt({ classification: "product", message: "separators do not align" })).retry, false)
  assert.equal(retryDecision(attempt({ classification: "unknown" })).retry, false)
  assert.equal(retryDecision(attempt({ classification: "infrastructure" })).retry, false)
  assert.equal(retryDecision(attempt({ status: "passed" })).retry, false)
})

test("quarantine requires a linked issue and an owner", () => {
  assert.deepEqual(validateQuarantine([]), { ok: true, errors: [] })
  assert.equal(validateQuarantine([{ suite: "fake", issue: "https://github.com/heyimteee/ensemble/issues/256", owner: "Tristan" }]).ok, true)
  const missingIssue = validateQuarantine([{ suite: "fake", owner: "Tristan" }])
  assert.equal(missingIssue.ok, false)
  assert.match(missingIssue.errors[0], /issue/)
  const missingOwner = validateQuarantine([{ suite: "fake", issue: "#256" }])
  assert.equal(missingOwner.ok, false)
  assert.match(missingOwner.errors[0], /owner/)
  const bad = validateQuarantine([{ suite: "", issue: "  ", owner: "" }])
  assert.equal(bad.ok, false)
  assert.equal(bad.errors.length >= 2, true)
})

test("the report lists suite, retry, classification, and artifact path", () => {
  const records: AttemptRecord[] = [
    attempt({ suite: "fake", attempt: 1, status: "failed", classification: "timing", message: "timed out after 10s waiting for members step", artifactPath: "/artifacts/fake/attempt-1" }),
    attempt({ suite: "fake", attempt: 2, status: "passed", classification: undefined, message: undefined, artifactPath: "/artifacts/fake/attempt-2" }),
    attempt({ suite: "fake-empty", attempt: 1, status: "passed", classification: undefined, message: undefined, artifactPath: "/artifacts/fake-empty/attempt-1" }),
  ]
  const report = buildFlakeReport(records)
  assert.equal(report.rows.length, 3)
  assert.deepEqual(report.rows[0], {
    suite: "fake",
    attempt: 1,
    status: "failed",
    classification: "timing",
    artifactPath: "/artifacts/fake/attempt-1",
    retried: true,
  })
  assert.deepEqual(report.rows[1], {
    suite: "fake",
    attempt: 2,
    status: "passed",
    classification: "none",
    artifactPath: "/artifacts/fake/attempt-2",
    retried: true,
  })
  assert.equal(report.suites.find((suite) => suite.suite === "fake")?.retries, 1)
  assert.equal(report.suites.find((suite) => suite.suite === "fake")?.flakeRate, 0.5)
  const text = formatFlakeReport(report)
  assert.match(text, /suite=fake attempt=1 classification=timing artifact=\/artifacts\/fake\/attempt-1/)
  assert.match(text, /suite=fake attempt=2 classification=none artifact=\/artifacts\/fake\/attempt-2/)
  assert.match(text, /flake budget/)
})

test("an unclassified retry is outside the budget", () => {
  const report = buildFlakeReport([
    attempt({ suite: "fake", attempt: 1, classification: "unknown", message: "separators do not align" }),
  ])
  assert.equal(report.budget.unclassifiedRetries, 0)
  assert.equal(report.budget.ok, false)
  assert.match(formatFlakeReport(report), /budget=over/)
})

test("the CLI classifies a failure record and refuses an unlinked quarantine", () => {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-flake-cli-"))
  try {
    const failure = join(dir, "failure.json")
    writeFileSync(failure, JSON.stringify({ suite: "fake", attempt: 1, kind: "timing", message: "timed out after 10s waiting for members step" }))
    const classified = spawnSync(process.execPath, ["--experimental-strip-types", cli, "classify", "--file", failure], { encoding: "utf8" })
    assert.equal(classified.status, 0, classified.stderr)
    assert.equal(classified.stdout.trim(), "timing")

    const retry = spawnSync(process.execPath, ["--experimental-strip-types", cli, "retry", "--file", failure, "--attempt", "1"], { encoding: "utf8" })
    assert.equal(retry.status, 0, retry.stderr)
    assert.match(retry.stdout, /^retry /)

    const product = spawnSync(
      process.execPath,
      ["--experimental-strip-types", cli, "decide", "--classification", "product", "--attempt", "1", "--quarantined", "1"],
      { encoding: "utf8" },
    )
    assert.equal(product.status, 0, product.stderr)
    assert.match(product.stdout, /^fail .*never retries or quarantines/)

    const quarantinedTiming = spawnSync(
      process.execPath,
      ["--experimental-strip-types", cli, "decide", "--classification", "timing", "--attempt", "1", "--quarantined", "1"],
      { encoding: "utf8" },
    )
    assert.equal(quarantinedTiming.status, 0, quarantinedTiming.stderr)
    assert.match(quarantinedTiming.stdout, /^quarantine /)

    const quarantine = join(dir, "quarantine.json")
    writeFileSync(quarantine, JSON.stringify([{ suite: "fake" }]))
    const invalid = spawnSync(process.execPath, ["--experimental-strip-types", cli, "quarantine", "--file", quarantine], { encoding: "utf8" })
    assert.notEqual(invalid.status, 0)
    assert.match(invalid.stderr, /linked issue is required/)
    assert.match(invalid.stderr, /owner is required/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a failed retry exhausts the budget even when the classification is timing", () => {
  const report = buildFlakeReport([
    attempt({ suite: "fake", attempt: 1, status: "failed", classification: "timing" }),
    attempt({ suite: "fake", attempt: 2, status: "failed", classification: "timing" }),
  ])
  assert.equal(report.budget.retriesFailed, 1)
  assert.equal(report.budget.ok, false)
  assert.match(formatFlakeReport(report), /retriesFailed=1 .*budget=over/)
})
