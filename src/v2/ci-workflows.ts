/**
 * CI job-graph check (ticket #261).
 *
 * The PR matrix is split by cost so feedback stays fast, and the nightly
 * workflow owns the expensive reference-host and real-model runs. This module
 * keeps that contract in one pure place: the tests mutate workflow text to
 * prove a missing suite, job, artifact upload, timeout, or host pin fails, and
 * `checkCiRepository` applies the same rules to the checked-in workflows.
 *
 * This is a structural check over the workflow subset the repository uses. It
 * deliberately does not try to be a general YAML parser.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { MINIMUM_NODE_VERSION } from "./node-version.ts"
import { SUPPORTED_OPENCODE_VERSIONS } from "./host-compatibility.ts"

/** PR job budgets in minutes. Every PR job must set a timeout at or under it. */
export const PR_JOB_BUDGET_MINUTES: Readonly<Record<string, number>> = {
  verify: 15,
  "live-fake": 45,
  "live-native": 20,
  "live-multilocation": 20,
  "latency-smoke": 20,
}

/** Nightly job budgets in minutes. */
export const NIGHTLY_JOB_BUDGET_MINUTES: Readonly<Record<string, number>> = {
  "latency-reference": 30,
  "soak-smoke": 20,
  real: 30,
}

/** Deterministic suites owned by each PR live job. A suite runs in exactly one. */
export const PR_LIVE_SUITES: Readonly<Record<string, readonly string[]>> = {
  "live-fake": ["test:live:fake:all", "test:live:sizes", "test:live:lifecycle", "test:live:subagent"],
  "live-native": ["test:live:native-first", "test:live:vera", "test:live:tool-surface"],
  "live-multilocation": ["test:live:multilocation"],
  "latency-smoke": ["test:live:latency"],
}

const VERIFY_WORKFLOW = ".github/workflows/verify.yml"
const NIGHTLY_WORKFLOW = ".github/workflows/nightly.yml"
const LIVE_HOST_ACTION = ".github/actions/live-host/action.yml"
const COMPATIBILITY_WORKFLOW = ".github/workflows/compatibility.yml"
const NODE_MATRIX_WORKFLOW = ".github/workflows/node-matrix.yml"
const DOCS_WORKFLOW = ".github/workflows/docs.yml"
const RELEASE_WORKFLOW = ".github/workflows/release.yml"
const LATENCY_WORKFLOW = ".github/workflows/latency.yml"
const ARTIFACTS_PATH = "${{ runner.temp }}/ensemble-live-artifacts"

/**
 * Release job budgets in minutes. The release workflow is tag/dispatch only;
 * it never runs on a pull request, so it is not part of the PR matrix.
 */
export const RELEASE_JOB_BUDGET_MINUTES: Readonly<Record<string, number>> = {
  preflight: 5,
  package: 30,
  "publish-dry-run": 15,
  publish: 15,
  "github-release": 10,
}

/**
 * The status contexts `main` requires before merge (ticket #275). These are
 * the real GitHub Actions check names: the job `name:` with the matrix value
 * substituted, not the workflow file or job id. `docs/operations/release.md`
 * records the same list, and the contract test proves every name comes from a
 * checked-in workflow. Change a job name or matrix entry and this list must
 * change with it; a required context that no workflow produces blocks every
 * pull request forever.
 */
export const REQUIRED_STATUS_CHECKS: readonly string[] = [
  "verify",
  "live-fake",
  "live-native",
  "live-multilocation",
  "latency-smoke",
  "docs:check",
  "verify (Node 22.23.4)",
  "verify (Node 24.22.1)",
  "verify (Node 26.12.1)",
  "OpenCode 2.2.6",
  "OpenCode 2.2.7",
]

/** Split the `jobs:` block into job id -> job body. Top-level keys end it. */
export function workflowJobs(text: string): Map<string, string> {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line))
  const jobs = new Map<string, string>()
  if (start < 0) return jobs

  let name: string | undefined
  let body: string[] = []
  const flush = () => {
    if (name) jobs.set(name, body.join("\n"))
  }

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!
    if (/^#/.test(line)) continue
    if (/^\S/.test(line)) break
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (match) {
      flush()
      name = match[1]!
      body = [line]
      continue
    }
    if (name) body.push(line)
  }
  flush()
  return jobs
}

/** Read a quoted top-level or env value such as NODE_VERSION. */
export function workflowValue(text: string, name: string): string | undefined {
  const match = new RegExp(`^\\s*${name}:\\s*"([^"]+)"`, "m").exec(text)
  return match?.[1]
}

function hasEnv(block: string, name: string, value: string): boolean {
  return new RegExp(`^\\s*${name}:\\s*["']?${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*$`, "m").test(block)
}

function hasArtifacts(block: string): boolean {
  return block.includes(`ENSEMBLE_LIVE_ARTIFACTS: ${ARTIFACTS_PATH}`)
}

function hasFailureUpload(block: string): boolean {
  return /uses:\s*actions\/upload-artifact@v4/.test(block) && /^\s*if:\s*failure\(\)\s*$/m.test(block)
}

/** One upload step for `path` that runs only on failure. */
function hasFailureUploadOf(block: string, path: string): boolean {
  const steps = block.split(/\n\s*-\s+(?:name|uses):/)
  return steps.some(
    (step) =>
      step.includes(`path: ${path}`) &&
      /^\s*if:\s*failure\(\)\s*$/m.test(step) &&
      /uses:\s*actions\/upload-artifact@v4/.test(step),
  )
}

function hasLiveHostAction(block: string): boolean {
  return /uses:\s*\.\/\.github\/actions\/live-host\s*$/m.test(block)
}

function hasPreflight(block: string): boolean {
  return /\bnpm run test:live:preflight\b/.test(block)
}

/**
 * Ticket #285: package exports load `dist/`, so a live workflow or composite
 * action must build the runtime after `npm ci` and before the first host
 * command. A fresh checkout otherwise has no `dist` and the plugin never
 * activates.
 */
function hasRuntimeBuild(block: string): boolean {
  const install = block.search(/\bnpm ci\b/)
  const build = block.search(/\bnpm run build\b/)
  const firstLive = block.search(/\bnpm run test:live:/)
  return install >= 0 && build > install && (firstLive < 0 || build < firstLive)
}

function suitesIn(block: string): string[] {
  const suites = [...block.matchAll(/npm run (test:live:[a-z0-9:-]+)/g)]
    .map((match) => match[1]!)
    .filter((suite) => suite !== "test:live:preflight")
  return [...new Set(suites)]
}

function checkTimeout(
  file: string,
  job: string,
  block: string,
  budget: number,
  failures: string[],
): void {
  const match = /^ {4}timeout-minutes:\s*(\d+)\s*$/m.exec(block)
  if (!match) {
    failures.push(`${file}: ${job} has no timeout-minutes (budget ${budget})`)
  } else if (Number(match[1]) > budget) {
    failures.push(`${file}: ${job} timeout-minutes ${match[1]} exceeds the ${budget}-minute budget`)
  }
}

function checkLiveJob(
  file: string,
  job: string,
  block: string,
  failures: string[],
): void {
  if (!hasEnv(block, "ENSEMBLE_LIVE_REQUIRE", "1")) {
    failures.push(`${file}: ${job} must set ENSEMBLE_LIVE_REQUIRE=1`)
  }
  if (!hasArtifacts(block)) {
    failures.push(`${file}: ${job} must set ENSEMBLE_LIVE_ARTIFACTS to ${ARTIFACTS_PATH}`)
  }
  if (!hasFailureUpload(block)) {
    failures.push(`${file}: ${job} must upload failure artifacts with actions/upload-artifact@v4`)
  }
  if (!hasLiveHostAction(block)) {
    failures.push(`${file}: ${job} must use ./.github/actions/live-host`)
  }
  if (!hasPreflight(block)) {
    failures.push(`${file}: ${job} must run npm run test:live:preflight`)
  }
}

function checkHostPin(file: string, text: string, supportedHosts: readonly string[], failures: string[]): void {
  const latest = supportedHosts[supportedHosts.length - 1]
  const version = workflowValue(text, "OPENCODE_VERSION")
  if (!latest) {
    failures.push(`${file}: no supported OpenCode host is declared`)
    return
  }
  if (version !== latest) {
    failures.push(
      `${file}: OPENCODE_VERSION ${version ?? "unset"} must be the latest tested host ${latest}`,
    )
  }
}

function checkConcurrency(file: string, text: string, failures: string[]): void {
  if (!/^concurrency:/m.test(text)) {
    failures.push(`${file}: workflow concurrency is missing`)
  }
}

export function checkVerifyWorkflow(text: string, supportedHosts: readonly string[]): string[] {
  const failures: string[] = []
  const file = "verify.yml"
  checkConcurrency(file, text, failures)
  checkHostPin(file, text, supportedHosts, failures)

  const jobs = workflowJobs(text)
  for (const [job, budget] of Object.entries(PR_JOB_BUDGET_MINUTES)) {
    const block = jobs.get(job)
    if (!block) {
      failures.push(`${file}: job ${job} is missing`)
      continue
    }
    checkTimeout(file, job, block, budget, failures)
    if (job === "verify") {
      if (!/\bnpm run verify\b/.test(block)) failures.push(`${file}: verify must run npm run verify`)
      continue
    }
    checkLiveJob(file, job, block, failures)
    const expected = PR_LIVE_SUITES[job] ?? []
    const suites = suitesIn(block)
    for (const suite of expected) {
      if (!suites.includes(suite)) failures.push(`${file}: ${job} must run ${suite}`)
    }
    for (const suite of suites) {
      if (!expected.includes(suite)) failures.push(`${file}: ${job} must not run ${suite}`)
    }
    if (job === "latency-smoke" && !/ENSEMBLE_LATENCY_PROFILE:\s*["']?smoke["']?/.test(block)) {
      failures.push(`${file}: latency-smoke must set ENSEMBLE_LATENCY_PROFILE=smoke`)
    }
  }
  for (const job of jobs.keys()) {
    if (!(job in PR_JOB_BUDGET_MINUTES)) failures.push(`${file}: unexpected job ${job}`)
  }
  return failures
}

export function checkNightlyWorkflow(text: string, supportedHosts: readonly string[]): string[] {
  const failures: string[] = []
  const file = "nightly.yml"
  if (!/^\s+schedule:/m.test(text) || !/^\s+- cron:/m.test(text)) {
    failures.push(`${file}: a nightly schedule trigger is missing`)
  }
  if (!/^\s+workflow_dispatch:/m.test(text)) {
    failures.push(`${file}: workflow_dispatch is missing`)
  }
  if (/^\s+pull_request:/m.test(text)) {
    failures.push(`${file}: nightly workflow must not run on pull requests`)
  }
  checkConcurrency(file, text, failures)
  checkHostPin(file, text, supportedHosts, failures)

  const jobs = workflowJobs(text)
  for (const [job, budget] of Object.entries(NIGHTLY_JOB_BUDGET_MINUTES)) {
    const block = jobs.get(job)
    if (!block) {
      failures.push(`${file}: job ${job} is missing`)
      continue
    }
    checkTimeout(file, job, block, budget, failures)
    checkLiveJob(file, job, block, failures)
  }
  for (const job of jobs.keys()) {
    if (!(job in NIGHTLY_JOB_BUDGET_MINUTES)) failures.push(`${file}: unexpected job ${job}`)
  }

  const reference = jobs.get("latency-reference")
  if (reference) {
    if (!/\bnpm run test:live:latency\b/.test(reference)) {
      failures.push(`${file}: latency-reference must run npm run test:live:latency`)
    }
    if (!/ENSEMBLE_LATENCY_PROFILE:\s*["']?reference["']?/.test(reference)) {
      failures.push(`${file}: latency-reference must set ENSEMBLE_LATENCY_PROFILE=reference`)
    }
  }

  const real = jobs.get("real")
  if (real) {
    if (!/\bnpm run test:live\s*$/m.test(real)) {
      failures.push(`${file}: real must run npm run test:live`)
    }
    if (!/test:live:preflight -- all/.test(real)) {
      failures.push(`${file}: real preflight must include -- all (fd is required)`)
    }
    if (!/vars\.ENSEMBLE_NIGHTLY_REAL/.test(real) || !/inputs\.real/.test(real)) {
      failures.push(
        `${file}: real must be gated by the opt-in (inputs.real or vars.ENSEMBLE_NIGHTLY_REAL=1)`,
      )
    }
  }

  // `test:live:latency` is intentionally shared: PRs run the generous smoke
  // profile and nightly runs the strict reference profile. The duplicate job
  // this ticket removes is the separate latency workflow, checked by
  // `checkCiRepository`; the other deterministic suites stay PR-only.
  for (const suite of Object.values(PR_LIVE_SUITES).flat()) {
    if (suite === "test:live:latency") continue
    if (new RegExp(`npm run ${suite.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9:-])`).test(text)) {
      failures.push(`${file}: must not duplicate the PR suite ${suite}`)
    }
  }
  return failures
}

/** Read a top-level YAML block such as `on:` or `permissions:`. */
function topLevelBlock(text: string, key: string): string {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => new RegExp(`^${key}:\\s*$`).test(line))
  if (start < 0) return ""
  const body: string[] = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!
    if (/^#/.test(line)) continue
    if (/^\S/.test(line)) break
    body.push(line)
  }
  return body.join("\n")
}

/**
 * Ticket #275: the release workflow is the only place that can publish. This
 * checks the trigger, the token boundary, provenance, the SBOM, and the GitHub
 * release shape. It is a structural check over the workflow subset the
 * repository uses, not a general YAML parser.
 */
export function checkReleaseWorkflow(text: string): string[] {
  const failures: string[] = []
  const file = "release.yml"

  const trigger = topLevelBlock(text, "on")
  if (!trigger) failures.push(`${file}: the trigger block is missing`)
  if (/^\s+pull_request:/m.test(trigger)) {
    failures.push(`${file}: the release workflow must not run on pull_request events`)
  }
  if (/^\s+branches:/m.test(trigger)) {
    failures.push(`${file}: a release push must be a version tag, not a branch`)
  }
  if (!/^\s+push:\s*$/m.test(trigger)) {
    failures.push(`${file}: the tag push trigger is missing`)
  }
  if (!/^\s+tags:\s*$/m.test(trigger) || !/^\s+- "v\*"\s*$/m.test(trigger)) {
    failures.push(`${file}: the release trigger must select v* tags`)
  }
  if (!/^\s+workflow_dispatch:\s*$/m.test(trigger)) {
    failures.push(`${file}: workflow_dispatch is missing`)
  }

  if (topLevelBlock(text, "permissions").trim() !== "contents: read") {
    failures.push(`${file}: the default permission must be contents: read`)
  }
  checkConcurrency(file, text, failures)

  const jobs = workflowJobs(text)
  for (const [job, budget] of Object.entries(RELEASE_JOB_BUDGET_MINUTES)) {
    const block = jobs.get(job)
    if (!block) {
      failures.push(`${file}: job ${job} is missing`)
      continue
    }
    checkTimeout(file, job, block, budget, failures)
  }
  for (const job of jobs.keys()) {
    if (!(job in RELEASE_JOB_BUDGET_MINUTES)) failures.push(`${file}: unexpected job ${job}`)
  }

  const preflight = jobs.get("preflight")
  if (preflight) {
    if (!preflight.includes("scripts/release-guard.mjs")) {
      failures.push(`${file}: preflight must validate the ref with scripts/release-guard.mjs`)
    }
    for (const output of ["version", "tag", "dry-run", "dist-tag"]) {
      if (!preflight.includes(`steps.mode.outputs.${output}`)) {
        failures.push(`${file}: preflight must export the ${output} output`)
      }
    }
  }

  const pkg = jobs.get("package")
  if (pkg) {
    for (const command of [
      "npm ci",
      "npm run verify",
      "npm run docs:check",
      "npm run build",
      "npm pack",
      "npm sbom --sbom-format=cyclonedx",
    ]) {
      if (!pkg.includes(command)) failures.push(`${file}: package must run ${command}`)
    }
    if (!/uses:\s*actions\/upload-artifact@v4/.test(pkg)) {
      failures.push(`${file}: package must upload the tarball and the SBOM`)
    }
  }

  const dryRun = jobs.get("publish-dry-run")
  if (dryRun) {
    if (!/npm publish --dry-run\b/.test(dryRun)) {
      failures.push(`${file}: publish-dry-run must run npm publish --dry-run`)
    }
    if (dryRun.includes("secrets.")) {
      failures.push(`${file}: publish-dry-run must not need a secret`)
    }
    if (!/needs\.preflight\.outputs\.dry-run/.test(dryRun)) {
      failures.push(`${file}: publish-dry-run must follow the preflight dry-run mode`)
    }
    if (!/--tag\s+"\$DIST_TAG"/.test(dryRun) || !dryRun.includes("needs.preflight.outputs.dist-tag")) {
      failures.push(`${file}: publish-dry-run must use the preflight dist-tag`)
    }
  }

  const publish = jobs.get("publish")
  if (publish) {
    if (!/npm publish --provenance --access public/.test(publish)) {
      failures.push(`${file}: publish must run npm publish --provenance --access public`)
    }
    if (/--dry-run/.test(publish)) {
      failures.push(`${file}: the publish job must not run in dry-run mode`)
    }
    if (!/NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/.test(publish)) {
      failures.push(`${file}: publish must authenticate with NODE_AUTH_TOKEN from the NPM_TOKEN secret`)
    }
    if (!/^\s+id-token:\s*write\s*$/m.test(publish)) {
      failures.push(`${file}: publish must grant id-token: write for provenance`)
    }
    if (!/--tag\s+"\$DIST_TAG"/.test(publish) || !publish.includes("needs.preflight.outputs.dist-tag")) {
      failures.push(`${file}: publish must use the preflight dist-tag so a prerelease is not tagged latest`)
    }
    const gate = /^ {4}if:\s*(.+)$/m.exec(publish)?.[1] ?? ""
    if (!/github\.event_name == 'push'/.test(gate) || !/startsWith\(github\.ref, 'refs\/tags\/v'\)/.test(gate)) {
      failures.push(`${file}: publish must only run for a version tag push`)
    }
  }

  const release = jobs.get("github-release")
  if (release) {
    if (!/gh release create/.test(release)) {
      failures.push(`${file}: github-release must create the GitHub release`)
    }
    if (!/--notes-file\b/.test(release)) {
      failures.push(`${file}: the GitHub release must publish the release notes from the changelog`)
    }
    if (!/\.cdx\.json/.test(release)) {
      failures.push(`${file}: the GitHub release must attach the SBOM`)
    }
    if (!/^\s+contents:\s*write\s*$/m.test(release)) {
      failures.push(`${file}: github-release needs contents: write`)
    }
    const gate = /^ {4}if:\s*(.+)$/m.exec(release)?.[1] ?? ""
    if (!/github\.event_name == 'push'/.test(gate) || !/startsWith\(github\.ref, 'refs\/tags\/v'\)/.test(gate)) {
      failures.push(`${file}: github-release must only run for a version tag push`)
    }
  }

  if (/\bset\s+-x\b/.test(text)) {
    failures.push(`${file}: command tracing would print the npm token`)
  }
  if (/(?:echo|printf)[^\n]*secrets\./.test(text)) {
    failures.push(`${file}: the workflow must not print a secret`)
  }
  if (/\/home\/|\/Users\//.test(text)) {
    failures.push(`${file}: the workflow must not contain private absolute paths`)
  }

  return failures
}

export function checkLiveHostAction(text: string): string[] {
  const failures: string[] = []
  const file = "action.yml"
  if (!/^runs:\s*$/m.test(text) || !/using:\s*composite\s*$/m.test(text)) {
    failures.push(`${file}: the live host action must be a composite action`)
  }
  for (const input of ["node-version", "opencode-version", "fd-version"]) {
    if (!new RegExp(`^ {2}${input}:\\s*$`, "m").test(text)) {
      failures.push(`${file}: input ${input} is missing`)
    }
  }
  if (!/node-version:\s*\$\{\{\s*inputs\.node-version\s*\}\}/.test(text)) {
    failures.push(`${file}: setup-node must use inputs.node-version`)
  }
  if (!/OPENCODE_VERSION:\s*\$\{\{\s*inputs\.opencode-version\s*\}\}/.test(text)) {
    failures.push(`${file}: OpenCode install must use inputs.opencode-version`)
  }
  if (!/@opencode\/cli@\$\{OPENCODE_VERSION\}/.test(text)) {
    failures.push(`${file}: OpenCode install must read the OPENCODE_VERSION env input`)
  }
  if (!/FD_VERSION:\s*\$\{\{\s*inputs\.fd-version\s*\}\}/.test(text)) {
    failures.push(`${file}: fd install must use inputs.fd-version`)
  }
  if (!/fd-v\$\{FD_VERSION\}/.test(text)) {
    failures.push(`${file}: fd archive must read the FD_VERSION env input`)
  }
  if (!/\bnpm ci\b/.test(text)) {
    failures.push(`${file}: npm ci is missing`)
  }
  if (!hasRuntimeBuild(text)) {
    failures.push(`${file}: npm run build must follow npm ci (package exports load dist/)`)
  }
  if (/@opencode\/cli@\d/.test(text) || /fd-v\d+\.\d+\.\d+/.test(text)) {
    failures.push(`${file}: tool versions must not be hardcoded`)
  }
  return failures
}

function readWorkflow(root: string, path: string, failures: string[]): string {
  const full = join(root, path)
  if (!existsSync(full)) {
    failures.push(`${path}: file is missing`)
    return ""
  }
  return readFileSync(full, "utf8")
}

/**
 * Ticket #257/#261 contract: every supported host runs the native probe and
 * the deterministic fake smoke, and the fake smoke keeps its harness artifacts
 * for a failure diagnosis. The job graph (cost split, timeouts, host pin) and
 * the docs/package checks live here because they are the CI contract this
 * ticket owns, not a restatement of a product helper.
 */
export function checkCompatibilityWorkflow(text: string, supportedHosts: readonly string[]): string[] {
  const failures: string[] = []
  const file = "compatibility.yml"
  for (const host of supportedHosts) {
    if (!text.includes(`"${host}"`)) {
      failures.push(`${file}: supported host ${host} is not in the matrix`)
    }
  }
  for (const required of ["npm run test:live:probe", "npm run test:live:fake:all"]) {
    if (!text.includes(required)) failures.push(`${file}: missing ${required}`)
  }
  if (!hasRuntimeBuild(text)) {
    failures.push(`${file}: npm run build must follow npm ci and precede the host probe (exports load dist/)`)
  }
  if (!/ENSEMBLE_LIVE_EXPECT_OPENCODE:\s*\$\{\{\s*matrix\.opencode\s*\}\}/.test(text)) {
    failures.push(`${file}: preflight must expect matrix.opencode`)
  }
  if (!hasArtifacts(text)) {
    failures.push(`${file}: the fake smoke must set ENSEMBLE_LIVE_ARTIFACTS to ${ARTIFACTS_PATH}`)
  }
  if (!text.includes(`path: ${ARTIFACTS_PATH}`)) {
    failures.push(`${file}: failure artifacts must be uploaded from ${ARTIFACTS_PATH}`)
  } else if (!hasFailureUploadOf(text, ARTIFACTS_PATH)) {
    failures.push(`${file}: live artifacts must use actions/upload-artifact@v4 with if: failure()`)
  }
  return failures
}

export function checkCiRepository(
  root: string,
  supportedHosts: readonly string[] = SUPPORTED_OPENCODE_VERSIONS,
): string[] {
  const failures: string[] = []
  const verify = readWorkflow(root, VERIFY_WORKFLOW, failures)
  const nightly = readWorkflow(root, NIGHTLY_WORKFLOW, failures)
  const action = readWorkflow(root, LIVE_HOST_ACTION, failures)
  const compatibility = readWorkflow(root, COMPATIBILITY_WORKFLOW, failures)
  const nodeMatrix = readWorkflow(root, NODE_MATRIX_WORKFLOW, failures)
  const docs = readWorkflow(root, DOCS_WORKFLOW, failures)
  const release = readWorkflow(root, RELEASE_WORKFLOW, failures)

  if (existsSync(join(root, LATENCY_WORKFLOW))) {
    failures.push(`${LATENCY_WORKFLOW}: the PR smoke and nightly reference gate live in verify.yml and nightly.yml`)
  }
  if (verify) failures.push(...checkVerifyWorkflow(verify, supportedHosts))
  if (nightly) failures.push(...checkNightlyWorkflow(nightly, supportedHosts))
  if (action) failures.push(...checkLiveHostAction(action))
  if (compatibility) failures.push(...checkCompatibilityWorkflow(compatibility, supportedHosts))
  if (release) failures.push(...checkReleaseWorkflow(release))

  // Ticket #262 owns the docs/package contract: `engines.node`, the Node
  // matrix, and `docs:check` must agree with the canonical version constants.
  // The job-graph checks above stay here because #261 owns the CI cost split.
  const liveNode = workflowValue(verify, "NODE_VERSION")
  if (nodeMatrix) {
    for (const node of [MINIMUM_NODE_VERSION, liveNode].filter((value): value is string => Boolean(value))) {
      if (!nodeMatrix.includes(`"${node}"`)) {
        failures.push(`${NODE_MATRIX_WORKFLOW}: tested Node ${node} is not in the matrix`)
      }
    }
  }
  if (docs && !docs.includes("npm run docs:check")) {
    failures.push(`${DOCS_WORKFLOW}: missing npm run docs:check`)
  }
  return failures
}
