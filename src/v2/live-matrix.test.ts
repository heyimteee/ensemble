import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const matrix = fileURLToPath(new URL("../../scripts/live-matrix.sh", import.meta.url))
const harness = fileURLToPath(new URL("../../scripts/lib/live-harness.sh", import.meta.url))
const bash = existsSync("/bin/bash") ? "/bin/bash" : "/usr/bin/bash"

type Sandbox = { root: string; tmp: string; home: string }

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "ensemble-live-matrix-"))
  const tmp = join(root, "tmp")
  const home = join(root, "home")
  mkdirSync(tmp)
  mkdirSync(home)
  return { root, tmp, home }
}

// A PATH without the nvm OpenCode install makes the scenarios resolve to the
// local skip contract. HOME is isolated for the same reason.
function environment(box: Sandbox, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: box.home,
    TMPDIR: box.tmp,
    ...extra,
  }
}

test("the matrix creates its temp root on a clean host", () => {
  const box = sandbox()
  try {
    const result = spawnSync(bash, [matrix, "fake"], {
      encoding: "utf8",
      env: environment(box),
    })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(
      existsSync(join(box.tmp, "opencode")),
      "the matrix creates the opencode temp parent instead of assuming it exists",
    )
    assert.match(result.stdout, /SKIP {2}fake\b/)
    assert.match(result.stdout, /SKIP {2}fake-empty\b/)
    assert.match(result.stdout, /2 skipped/)
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

test("the harness skip is a structural marker, not log text", () => {
  const box = sandbox()
  try {
    const marker = join(box.root, "skip.marker")
    const command = 'source "$1"; live_skip "node is missing"'
    const local = spawnSync(bash, ["-c", command, "--", harness], {
      encoding: "utf8",
      env: environment(box, { ENSEMBLE_LIVE_SKIP_MARKER: marker }),
    })
    assert.equal(local.status, 0, local.stderr)
    assert.match(local.stdout, /; skipping/)
    assert.ok(existsSync(marker), "local skip writes the structural marker")

    rmSync(marker, { force: true })
    const required = spawnSync(bash, ["-c", command, "--", harness], {
      encoding: "utf8",
      env: environment(box, { ENSEMBLE_LIVE_SKIP_MARKER: marker, ENSEMBLE_LIVE_REQUIRE: "1" }),
    })
    assert.notEqual(required.status, 0)
    assert.doesNotMatch(required.stdout, /; skipping/)
    assert.ok(!existsSync(marker), "require mode fails before the marker is written")
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

test("failure artifact retention cannot copy an ambient log directory", () => {
  const box = sandbox()
  try {
    const state = join(box.root, "state")
    const harnessLogs = join(box.root, "harness-logs")
    const ambientLogs = join(box.root, "ambient-logs")
    const artifacts = join(box.root, "artifacts")
    mkdirSync(join(state, "ensemble", "logs"), { recursive: true })
    mkdirSync(harnessLogs)
    mkdirSync(ambientLogs)
    writeFileSync(join(state, "ensemble", "logs", "service.jsonl"), '{"event":"isolated-state"}\n')
    writeFileSync(join(ambientLogs, "service.jsonl"), '{"event":"ambient-host-log"}\n')
    const command = [
      'source "$1"',
      "LIVE_KIND=privacy",
      "LIVE_EXIT_STATUS=1",
      'LIVE_STATE="$2"',
      'LIVE_LOGS="$3"',
      'LIVE_SERVER_URL=""',
      'LIVE_NODE_BIN=""',
      'LIVE_TMUX_BIN=""',
      "LIVE_SESSION_NAMES=()",
      'live_retain_failure_artifacts "$4/privacy"',
    ].join("\n")
    const result = spawnSync(bash, ["-c", command, "--", harness, state, harnessLogs, artifacts], {
      encoding: "utf8",
      env: environment(box, { ENSEMBLE_LOG_DIR: ambientLogs }),
    })
    assert.equal(result.status, 0, result.stderr)
    const copied = readFileSync(join(artifacts, "privacy", "service-logs", "service.jsonl"), "utf8")
    assert.match(copied, /isolated-state/)
    assert.doesNotMatch(copied, /ambient-host-log/)
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

test("the matrix treats a required skip as a failure", () => {
  const box = sandbox()
  try {
    const result = spawnSync(bash, [matrix, "fake"], {
      encoding: "utf8",
      env: environment(box, { ENSEMBLE_LIVE_REQUIRE: "1" }),
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stdout, /FAIL {2}fake\b/)
    assert.match(result.stdout, /NOT RUN fake-empty/)
    assert.doesNotMatch(result.stdout, /0 failed/)
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})
