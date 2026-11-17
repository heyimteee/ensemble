import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  NIGHTLY_JOB_BUDGET_MINUTES,
  PR_JOB_BUDGET_MINUTES,
  PR_LIVE_SUITES,
  REQUIRED_STATUS_CHECKS,
  checkCiRepository,
  checkCompatibilityWorkflow,
  checkLiveHostAction,
  checkNightlyWorkflow,
  checkReleaseWorkflow,
  checkVerifyWorkflow,
  workflowJobs,
} from "./ci-workflows.ts"
import { SUPPORTED_OPENCODE_VERSIONS } from "./host-compatibility.ts"

const repoRoot = fileURLToPath(new URL("../..", import.meta.url))
const supported = [...SUPPORTED_OPENCODE_VERSIONS]
const latest = supported[supported.length - 1]!
const verifyWorkflowPath = ".github/workflows/verify.yml"
const nightlyWorkflowPath = ".github/workflows/nightly.yml"
const releaseWorkflowPath = ".github/workflows/release.yml"
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

/** Drop a whole `- name: ...` step so the fixture stays valid YAML. */
function removeStep(text: string, name: string, indent = "    "): string {
  const lines = text.split("\n")
  const prefix = `${indent}- `
  const index = lines.findIndex((line) => line.startsWith(prefix) && line.includes(name))
  assert.notEqual(index, -1, `fixture must contain a step named ${JSON.stringify(name)}`)
  let end = index + 1
  while (end < lines.length && !lines[end]!.startsWith(prefix)) end += 1
  lines.splice(index, end - index)
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
  const text = read(verifyWorkflowPath).replace("actions/upload-artifact@v7", "actions/upload-artifact@v3")
  const failures = checkVerifyWorkflow(text, supported)
  assert.ok(failuresMatching(failures, /live-fake.*upload-artifact@v7/).length > 0)
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

  const noUpload = text.replace("        if: failure()\n        uses: actions/upload-artifact@v7\n        with:\n          name: live-artifacts-${{ matrix.opencode }}", "        uses: actions/upload-artifact@v7\n        with:\n          name: live-artifacts-${{ matrix.opencode }}")
  assert.ok(
    failuresMatching(checkCompatibilityWorkflow(noUpload, supported), /live artifacts.*if: failure\(\)/).length > 0,
  )
})

test("the live host action pins every tool through its inputs", () => {
  const text = read(liveHostActionPath)
  assert.deepEqual(checkLiveHostAction(text), [])
})

test("a live host action that installs dependencies without building the runtime is rejected", () => {
  const text = read(liveHostActionPath)
  assert.match(text, /npm run build/, "the live host action builds the runtime")

  const withoutBuild = removeStep(text, "Build runtime")
  assert.ok(failuresMatching(checkLiveHostAction(withoutBuild), /npm run build/).length > 0)

  // The package exports load dist/, so the build has to survive the install.
  const beforeInstall = removeStep(text, "Build runtime").replace(
    "    - name: Install npm dependencies",
    "    - name: Build runtime\n      shell: bash\n      run: npm run build\n    - name: Install npm dependencies",
  )
  assert.ok(failuresMatching(checkLiveHostAction(beforeInstall), /npm run build/).length > 0)
})

test("a compatibility job that probes or fakes the host without a dist build is rejected", () => {
  const text = read(".github/workflows/compatibility.yml")
  assert.match(text, /npm run build/, "the compatibility job builds the runtime")

  const withoutBuild = removeStep(text, "Build runtime", "      ")
  assert.ok(failuresMatching(checkCompatibilityWorkflow(withoutBuild, supported), /npm run build/).length > 0)

  // A build after the fake smoke is too late: the host already loaded the plugin.
  const afterSuites = removeStep(text, "Build runtime", "      ").replace(
    "      - name: Upload sanitized host contract record",
    "      - name: Build runtime\n        run: npm run build\n      - name: Upload sanitized host contract record",
  )
  assert.ok(failuresMatching(checkCompatibilityWorkflow(afterSuites, supported), /npm run build/).length > 0)
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

test("the docs job runs the fast gate while the docs-site job owns the one PR build", () => {
  const text = read(".github/workflows/docs.yml")
  assert.match(text, /run: npm ci/)
  assert.match(text, /run: npm run docs:check:fast/)
  assert.doesNotMatch(text, /run: npm run docs:check\s*$/)
  assert.doesNotMatch(text, /docs:site:build/)
  assert.doesNotMatch(text, /--skip-site-build/)

  const site = read(".github/workflows/docs-site.yml")
  assert.match(site, /run: npm run docs:site:build/)
  assert.doesNotMatch(site, /run: npm run docs:check/)
})

test("the live-fake job owns the deterministic packed quickstart E2E", () => {
  assert.ok(PR_LIVE_SUITES["live-fake"]?.includes("test:live:quickstart"))
  const block = workflowJobs(read(verifyWorkflowPath)).get("live-fake") ?? ""
  assert.match(block, /run: npm run test:live:quickstart/)
})

test("the release workflow is tag-driven and dry-runs a manual dispatch", () => {
  const text = read(releaseWorkflowPath)
  assert.deepEqual(checkReleaseWorkflow(text), [])
  assert.deepEqual(
    [...workflowJobs(text).keys()].sort(),
    ["github-release", "package", "preflight", "publish", "publish-dry-run"],
  )

  const noDispatch = text.replace("  workflow_dispatch:\n", "")
  assert.ok(failuresMatching(checkReleaseWorkflow(noDispatch), /workflow_dispatch/).length > 0)
})

test("a release workflow that can run on a branch push or pull request is rejected", () => {
  const text = read(releaseWorkflowPath)

  const withPullRequest = text.replace("on:\n", "on:\n  pull_request:\n")
  assert.ok(failuresMatching(checkReleaseWorkflow(withPullRequest), /pull_request/).length > 0)

  const withBranch = text.replace('      - "v*"', '      - "v*"\n    branches:\n      - main')
  assert.ok(failuresMatching(checkReleaseWorkflow(withBranch), /tag|branch/).length > 0)

  const barePush = text.replace('  push:\n    tags:\n      - "v*"\n', "  push:\n")
  assert.ok(failuresMatching(checkReleaseWorkflow(barePush), /tag/).length > 0)
})

test("a real publish uses OIDC and refuses the NPM_TOKEN path", () => {
  const text = read(releaseWorkflowPath)

  const withoutProvenance = text.replace(
    "npm publish --provenance --access public",
    "npm publish --access public",
  )
  assert.ok(failuresMatching(checkReleaseWorkflow(withoutProvenance), /provenance/).length > 0)

  const withToken = text.replace(
    "      - name: Publish with OIDC provenance\n        run: npm publish",
    "      - name: Publish with OIDC provenance\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n        run: npm publish",
  )
  assert.ok(failuresMatching(checkReleaseWorkflow(withToken), /OIDC|NPM_TOKEN/).length > 0)

  const withoutOidc = removeLine(text, "id-token: write")
  assert.ok(failuresMatching(checkReleaseWorkflow(withoutOidc), /id-token/).length > 0)

  const branchPublish = text.replace(
    "    if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')",
    "    if: github.ref == 'refs/heads/main'",
  )
  assert.ok(failuresMatching(checkReleaseWorkflow(branchPublish), /tag/).length > 0)
})

test("the dry run publishes without a token and never performs a real publish", () => {
  const text = read(releaseWorkflowPath)

  const realPublish = text.replace(
    "npm publish --dry-run --access public",
    "npm publish --access public",
  )
  assert.ok(failuresMatching(checkReleaseWorkflow(realPublish), /dry-run/).length > 0)

  const dryRunJob = workflowJobs(text).get("publish-dry-run")!
  assert.doesNotMatch(dryRunJob, /secrets\./, "the dry run must not need a secret")

  const withoutDistTag = text.replace(' --tag "$DIST_TAG"', "")
  assert.ok(failuresMatching(checkReleaseWorkflow(withoutDistTag), /dist-tag/).length > 0)
})

test("the release produces an SBOM and publishes the notes on the GitHub release", () => {
  const text = read(releaseWorkflowPath)

  const noSbom = removeLine(text, "npm sbom --sbom-format=cyclonedx")
  assert.ok(failuresMatching(checkReleaseWorkflow(noSbom), /SBOM|sbom/).length > 0)

  const noNotes = removeLine(text, "--notes-file")
  assert.ok(failuresMatching(checkReleaseWorkflow(noNotes), /notes/).length > 0)

  const noRelease = removeLine(text, "gh release create")
  assert.ok(failuresMatching(checkReleaseWorkflow(noRelease), /GitHub release/).length > 0)

  const noPrerelease = removeLine(text, 'prerelease="--prerelease"')
  assert.ok(failuresMatching(checkReleaseWorkflow(noPrerelease), /prerelease/).length > 0)
})

test("the required main checks are exactly the workflow job names", () => {
  const expected = new Set<string>([
    ...["verify", "live-fake", "live-native", "live-multilocation", "latency-smoke"],
    "docs:check",
  ])
  for (const node of [...read(".github/workflows/node-matrix.yml").matchAll(/^\s+- "(\d+\.\d+\.\d+)"$/gm)]) {
    expected.add(`verify (Node ${node[1]})`)
  }
  for (const host of supported) expected.add(`OpenCode ${host}`)

  assert.deepEqual([...REQUIRED_STATUS_CHECKS].sort(), [...expected].sort())
  assert.equal(REQUIRED_STATUS_CHECKS.includes("docs-rationale"), false)
  assert.match(
    read("docs/contributing/README.md"),
    /not yet a required status check/i,
    "the docs must not claim the rationale workflow is externally required",
  )

  const verifyNames = [...workflowJobs(read(verifyWorkflowPath)).values()].map(
    (block) => /^ {4}name:\s*(.+)$/m.exec(block)?.[1],
  )
  for (const name of ["verify", "live-fake", "live-native", "live-multilocation", "latency-smoke"]) {
    assert.ok(verifyNames.includes(name), `${name} is a real verify.yml job name`)
  }
  assert.match(read(".github/workflows/docs.yml"), /^ {4}name: docs:check$/m)
  assert.match(read(".github/workflows/node-matrix.yml"), /^ {4}name: verify \(Node \$\{\{ matrix\.node \}\}\)$/m)
  assert.match(
    read(".github/workflows/compatibility.yml"),
    /^ {4}name: OpenCode \$\{\{ matrix\.opencode \}\}$/m,
  )
})

test("the operations docs record every required check and the applied protection", () => {
  const doc = read("docs/operations/release.md")
  for (const context of REQUIRED_STATUS_CHECKS) {
    assert.ok(doc.includes(context), `docs/operations/release.md must list ${context}`)
  }
  assert.match(doc, /require.*review|required_approving_review_count/i)
  assert.match(doc, /ruleset|branch protection/i)
})
