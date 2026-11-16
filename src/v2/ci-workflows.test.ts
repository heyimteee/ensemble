import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  NIGHTLY_JOB_BUDGET_MINUTES,
  PR_JOB_BUDGET_MINUTES,
  PR_LIVE_SUITES,
  checkCiRepository,
  checkCompatibilityWorkflow,
  checkLiveHostAction,
  checkNightlyWorkflow,
  checkVerifyWorkflow,
  workflowJobs,
} from "./ci-workflows.ts"
import { SUPPORTED_OPENCODE_VERSIONS } from "./host-compatibility.ts"

const repoRoot = fileURLToPath(new URL("../..", import.meta.url))
const supported = [...SUPPORTED_OPENCODE_VERSIONS]
const latest = supported[supported.length - 1]!
const verifyWorkflowPath = ".github/workflows/verify.yml"
const nightlyWorkflowPath = ".github/workflows/nightly.yml"
const liveHostActionPath = ".github/actions/live-host/action.yml"

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8")
}

function removeLine(text: string, needle: string): string {
  const lines = text.split("\n")
  const index = lines.findIndex((line) => line.includes(needle))
  assert.notEqual(index, -1, `fixture must contain ${JSON.stringify(needle)}`)
  lines.splice(index, 1)
  return lines.join("\n")
}

function failuresMatching(failures: string[], pattern: RegExp): string[] {
  return failures.filter((failure) => pattern.test(failure))
}

test("the PR job graph is split by cost and runs every deterministic suite", () => {
  const text = read(verifyWorkflowPath)
  assert.deepEqual(checkVerifyWorkflow(text, supported), [])
  assert.deepEqual(
    [...workflowJobs(text).keys()].sort(),
    ["latency-smoke", "live-fake", "live-multilocation", "live-native", "verify"],
  )
})

test("the documented PR budgets cover every PR job", () => {
  assert.deepEqual(Object.keys(PR_JOB_BUDGET_MINUTES).sort(), [
    "latency-smoke",
    "live-fake",
    "live-multilocation",
    "live-native",
    "verify",
  ])
  for (const [job, suites] of Object.entries(PR_LIVE_SUITES)) {
    assert.ok(job in PR_JOB_BUDGET_MINUTES, `${job} has a budget`)
    assert.ok(suites.length > 0, `${job} runs at least one suite`)
  }
})

test("a deterministic suite missing from its cost-split job is rejected", () => {
  const text = removeLine(read(verifyWorkflowPath), "run: npm run test:live:subagent")
  const failures = checkVerifyWorkflow(text, supported)
  assert.equal(failuresMatching(failures, /live-fake.*test:live:subagent/).length, 1)
})

test("a deterministic suite duplicated into another PR job is rejected", () => {
  const text = read(verifyWorkflowPath).replace(
    "        run: npm run test:live:tool-surface\n",
    "        run: npm run test:live:tool-surface\n"
      + "      - name: Duplicate size matrix\n        run: npm run test:live:sizes\n",
  )
  const failures = checkVerifyWorkflow(text, supported)
  assert.equal(failuresMatching(failures, /live-native.*test:live:sizes/).length, 1)
})

test("a live job without the require-mode contract is rejected", () => {
  const text = removeLine(read(verifyWorkflowPath), 'ENSEMBLE_LIVE_REQUIRE: "1"')
  const failures = checkVerifyWorkflow(text, supported)
  assert.ok(failuresMatching(failures, /live-fake.*ENSEMBLE_LIVE_REQUIRE/).length > 0)
})

test("a live job without failure artifact upload is rejected", () => {
  const text = read(verifyWorkflowPath).replace("actions/upload-artifact@v4", "actions/upload-artifact@v3")
  const failures = checkVerifyWorkflow(text, supported)
  assert.ok(failuresMatching(failures, /live-fake.*upload-artifact@v4/).length > 0)
})

test("a PR job over its documented time budget is rejected", () => {
  const text = read(verifyWorkflowPath).replace("timeout-minutes: 45", "timeout-minutes: 90")
  const failures = checkVerifyWorkflow(text, supported)
  assert.ok(failuresMatching(failures, /live-fake.*45/).length > 0)
})

test("a PR job without a timeout is rejected", () => {
  const text = removeLine(read(verifyWorkflowPath), "timeout-minutes: 20")
  const failures = checkVerifyWorkflow(text, supported)
  assert.ok(failuresMatching(failures, /live-native.*timeout/).length > 0)
})

test("the PR host pin follows the compatibility matrix's latest tested host", () => {
  const text = read(verifyWorkflowPath).replace(`OPENCODE_VERSION: "${latest}"`, 'OPENCODE_VERSION: "2.2.6"')
  const failures = checkVerifyWorkflow(text, supported)
  assert.ok(failuresMatching(failures, new RegExp(`OPENCODE_VERSION.*${latest.replaceAll(".", "\\.")}`)).length > 0)
})

test("a PR workflow without concurrency is rejected", () => {
  const text = read(verifyWorkflowPath).replace(
    /^concurrency:\n  group: [^\n]*\n  cancel-in-progress: [^\n]*\n/m,
    "",
  )
  const failures = checkVerifyWorkflow(text, supported)
  assert.ok(failuresMatching(failures, /concurrency/).length > 0)
})

test("the nightly job graph gates latency on the reference profile and keeps the real model opt-in", () => {
  const text = read(nightlyWorkflowPath)
  assert.deepEqual(checkNightlyWorkflow(text, supported), [])
  assert.deepEqual(
    [...workflowJobs(text).keys()].sort(),
    ["latency-reference", "real", "soak-smoke"],
  )
  for (const [job, budget] of Object.entries(NIGHTLY_JOB_BUDGET_MINUTES)) {
    assert.ok(job in NIGHTLY_JOB_BUDGET_MINUTES, `${job} has a budget`)
    assert.ok(budget > 0)
  }
})

test("a nightly reference job on the smoke profile is rejected", () => {
  const text = read(nightlyWorkflowPath).replace(
    "ENSEMBLE_LATENCY_PROFILE: reference",
    "ENSEMBLE_LATENCY_PROFILE: smoke",
  )
  const failures = checkNightlyWorkflow(text, supported)
  assert.ok(failuresMatching(failures, /latency-reference.*reference/).length > 0)
})

test("a nightly real-model job without the opt-in gate is rejected", () => {
  const text = removeLine(read(nightlyWorkflowPath), "vars.ENSEMBLE_NIGHTLY_REAL")
  const failures = checkNightlyWorkflow(text, supported)
  assert.ok(failuresMatching(failures, /real.*opt-in/).length > 0)
})

test("a nightly workflow triggered by pull requests is rejected", () => {
  const text = read(nightlyWorkflowPath).replace("on:\n", "on:\n  pull_request:\n")
  const failures = checkNightlyWorkflow(text, supported)
  assert.ok(failuresMatching(failures, /nightly.*pull request/).length > 0)
})

test("the compatibility fake smoke keeps harness artifacts for a failure diagnosis", () => {
  const text = read(".github/workflows/compatibility.yml")
  assert.deepEqual(checkCompatibilityWorkflow(text, supported), [])

  const noArtifactDir = removeLine(text, "ENSEMBLE_LIVE_ARTIFACTS:")
  assert.ok(
    failuresMatching(checkCompatibilityWorkflow(noArtifactDir, supported), /ENSEMBLE_LIVE_ARTIFACTS/).length > 0,
  )

  const noUpload = text.replace("        if: failure()\n        uses: actions/upload-artifact@v4\n        with:\n          name: live-artifacts-${{ matrix.opencode }}", "        uses: actions/upload-artifact@v4\n        with:\n          name: live-artifacts-${{ matrix.opencode }}")
  assert.ok(
    failuresMatching(checkCompatibilityWorkflow(noUpload, supported), /live artifacts.*if: failure\(\)/).length > 0,
  )
})

test("the live host action pins every tool through its inputs", () => {
  const text = read(liveHostActionPath)
  assert.deepEqual(checkLiveHostAction(text), [])
})

test("a hardcoded host version in the live host action is rejected", () => {
  const text = read(liveHostActionPath).replace(
    "OPENCODE_VERSION: ${{ inputs.opencode-version }}",
    `OPENCODE_VERSION: "${latest}"`,
  )
  const failures = checkLiveHostAction(text)
  assert.ok(failuresMatching(failures, /opencode-version/).length > 0)
})

test("the repository keeps the compatibility, Node, and docs workflows and drops the duplicate latency workflow", () => {
  assert.deepEqual(checkCiRepository(repoRoot, supported), [])
  assert.equal(existsSync(join(repoRoot, ".github/workflows/latency.yml")), false)
})
