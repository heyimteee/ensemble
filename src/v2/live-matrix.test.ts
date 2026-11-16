import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
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

test("a failed attempt writes a classified record and redacted pane/log artifacts", () => {
  const box = sandbox()
  try {
    const artifacts = join(box.root, "artifacts")
    const command = [
      'source "$1"',
      'live_setup "artifact"',
      'LIVE_FAILURE_KIND=timing',
      'printf "server listening on http://127.0.0.1:1\\npath=%s\\n" "$LIVE_BASE" > "$LIVE_LOGS/server.log"',
      'live_fail_timing "typed text did not reach the TUI: AlignProbe"',
    ].join("; ")
    const result = spawnSync(bash, ["-c", command, "--", harness], {
      encoding: "utf8",
      env: environment(box, {
        ENSEMBLE_LIVE_ARTIFACTS: artifacts,
        ENSEMBLE_LIVE_SUITE: "fake",
        ENSEMBLE_LIVE_ATTEMPT: "1",
      }),
    })
    assert.notEqual(result.status, 0)
    const record = JSON.parse(readFileSync(join(artifacts, "failure.json"), "utf8"))
    assert.equal(record.suite, "fake")
    assert.equal(record.attempt, 1)
    assert.equal(record.kind, "timing")
    assert.match(record.message, /typed text did not reach the TUI/)
    const log = readFileSync(join(artifacts, "logs", "server.log"), "utf8")
    assert.match(log, /<live-base>/, "the live base path is redacted")
    assert.doesNotMatch(log, new RegExp(box.tmp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

function scenarioStub(dir: string, name: string, body: string): void {
  const path = join(dir, name)
  writeFileSync(path, `#!/usr/bin/env bash\nset -u\n${body}\n`, { mode: 0o755 })
}

test("the matrix retries one classified timing failure and reports it", () => {
  const box = sandbox()
  try {
    const stubs = join(box.root, "scenarios")
    mkdirSync(stubs)
    scenarioStub(
      stubs,
      "live-check-fake.sh",
      [
        'attempt="${ENSEMBLE_LIVE_ATTEMPT:-1}"',
        'artifacts="${ENSEMBLE_LIVE_ARTIFACTS:-}"',
        'mkdir -p "$artifacts"',
        'if [[ "$attempt" == "1" ]]; then',
        '  printf \'{"suite":"fake","attempt":1,"status":"failed","kind":"timing","message":"timed out after 10s waiting for members step","artifactPath":"%s","exitCode":1}\\n\' "$artifacts" > "$artifacts/failure.json"',
        '  echo "live: TUI did not become ready: members step" >&2',
        '  exit 1',
        'fi',
        'echo "live: stub pass"',
      ].join("\n"),
    )
    scenarioStub(stubs, "live-check-fake-empty.sh", 'echo "live: stub empty pass"')
    const nodePath = `${dirname(process.execPath)}:/usr/bin:/bin`
    const result = spawnSync(bash, [matrix, "fake"], {
      encoding: "utf8",
      env: environment(box, { ENSEMBLE_LIVE_SCENARIO_ROOT: stubs, PATH: nodePath }),
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /fake: RETRY \(attempt 1; timing failure on attempt 1\)/)
    assert.match(result.stdout, /PASS {2}fake .*flaky, retried once/)
    assert.match(result.stdout, /PASS {2}fake-empty/)
    assert.match(result.stdout, /1 retries/)
    assert.match(result.stdout, /flake-report: suite=fake attempt=1 classification=timing artifact=/)
    assert.match(result.stdout, /flake-report: suite=fake attempt=2 classification=none artifact=/)
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

test("the matrix never retries a product assertion failure", () => {
  const box = sandbox()
  try {
    const stubs = join(box.root, "scenarios")
    mkdirSync(stubs)
    scenarioStub(
      stubs,
      "live-check-fake.sh",
      [
        'artifacts="${ENSEMBLE_LIVE_ARTIFACTS:-}"',
        'mkdir -p "$artifacts"',
        'printf \'{"suite":"fake","attempt":1,"status":"failed","kind":"product","message":"member wizard separators do not align in one column","artifactPath":"%s","exitCode":1}\\n\' "$artifacts" > "$artifacts/failure.json"',
        'echo "live: member wizard separators do not align in one column" >&2',
        'exit 1',
      ].join("\n"),
    )
    scenarioStub(stubs, "live-check-fake-empty.sh", 'echo "live: stub empty pass"')
    const nodePath = `${dirname(process.execPath)}:/usr/bin:/bin`
    const result = spawnSync(bash, [matrix, "fake"], {
      encoding: "utf8",
      env: environment(box, { ENSEMBLE_LIVE_SCENARIO_ROOT: stubs, PATH: nodePath }),
    })
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.stderr, /RETRY/)
    assert.match(result.stdout, /FAIL {2}fake/)
    assert.match(result.stdout, /NOT RUN fake-empty/)
    assert.match(result.stdout, /0 retries/)
    assert.match(result.stdout, /classification=product/)
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})
