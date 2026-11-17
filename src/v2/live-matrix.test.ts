import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

import { FLAKE_BUDGET } from "./flake-policy.ts"
import { decideFailedAttempt } from "./live-matrix.ts"

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

test("the matrix runs every scenario in order through its public CLI", () => {
  const box = sandbox()
  try {
    const result = spawnSync(bash, [matrix, "all"], {
      encoding: "utf8",
      env: environment(box),
    })
    assert.equal(result.status, 0, result.stderr)
    const fake = result.stdout.search(/SKIP {2}fake\b/)
    const empty = result.stdout.search(/SKIP {2}fake-empty\b/)
    const real = result.stdout.search(/SKIP {2}real\b/)
    assert.ok(fake >= 0 && empty > fake && real > empty, "the matrix keeps the declared scenario order")
    assert.match(result.stdout, /3 skipped/)
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

test("only a timing failure may retry, and the budget comes from the flake policy", () => {
  assert.equal(decideFailedAttempt({ classification: "timing", attempt: 1 }).outcome, "retry")
  assert.equal(
    decideFailedAttempt({ classification: "timing", attempt: FLAKE_BUDGET.maxRetriesPerSuite }).outcome,
    "retry",
    "the retry ceiling is the flake budget, not a second literal",
  )
  assert.equal(
    decideFailedAttempt({ classification: "timing", attempt: FLAKE_BUDGET.maxRetriesPerSuite + 1 }).outcome,
    "fail",
    "a timing retry past the budget fails",
  )
})

test("product, unknown, and infrastructure failures always fail, even when quarantined", () => {
  for (const classification of ["product", "unknown", "infrastructure"] as const) {
    assert.equal(decideFailedAttempt({ classification, attempt: 1 }).outcome, "fail")
    assert.equal(
      decideFailedAttempt({ classification, attempt: 1, quarantined: true }).outcome,
      "fail",
      `${classification} must never be masked by a quarantine`,
    )
  }
})

test("a quarantined timing failure is quarantined, never passed or retried", () => {
  const decision = decideFailedAttempt({ classification: "timing", attempt: 1, quarantined: true })
  assert.equal(decision.outcome, "quarantine")
  assert.notEqual(decision.outcome, "pass")
  assert.match(decision.reason, /quarantined/)
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

function reducedMotionFrame(box: Sandbox, pane: string): number | null {
  const result = spawnSync(
    bash,
    [
      "-c",
      'source "$1"; PANE="$2"; live_capture() { cat "$PANE"; }; live_capture_reduced_motion_frame0 probe FAKEAGENT WORKING "#LiveSite"',
      "--",
      harness,
      pane,
    ],
    { encoding: "utf8", env: environment(box) },
  )
  return result.status
}

test("the reduced-motion frame asserts the Ensemble card, not host chrome", () => {
  const box = sandbox()
  try {
    const still = join(box.root, "still.txt")
    writeFileSync(
      still,
      [
        "│  FAKEAGENT   hops 0/8 · cmd 24 left ⠋ WORKING │",
        "│  #LiveSite ⠋1 ●1 │",
        " Message sent                              ⠏ Finishing startup…",
        "",
      ].join("\n"),
    )
    assert.equal(
      reducedMotionFrame(box, still),
      0,
      "a host footer spinner does not turn the Ensemble still frame into a failure",
    )

    const animated = join(box.root, "animated.txt")
    writeFileSync(
      animated,
      [
        "│  FAKEAGENT   hops 0/8 · cmd 24 left ⠏ WORKING │",
        "│  #LiveSite ⠋1 ●1 │",
        "",
      ].join("\n"),
    )
    assert.notEqual(
      reducedMotionFrame(box, animated),
      0,
      "a non-zero Work-card frame still fails under reduced motion",
    )

    const animatedRail = join(box.root, "animated-rail.txt")
    writeFileSync(
      animatedRail,
      [
        "│  FAKEAGENT   hops 0/8 · cmd 24 left ⠋ WORKING │",
        "│  #LiveSite ⠏1 ●1 │",
        "",
      ].join("\n"),
    )
    assert.notEqual(
      reducedMotionFrame(box, animatedRail),
      0,
      "a non-zero rail busy frame still fails under reduced motion",
    )

    const missing = join(box.root, "missing.txt")
    writeFileSync(missing, "│  Nothing active yet │\n")
    assert.notEqual(reducedMotionFrame(box, missing), 0, "the assertion needs a visible Work card")
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

function openEnsemble(box: Sandbox, pane: string, tmuxStatus = 0) {
  const tmuxLog = join(box.root, "tmux.log")
  const tmux = join(box.root, "tmux-stub.sh")
  writeFileSync(tmux, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >>"$TMUX_STUB_LOG"\nexit "$TMUX_STUB_STATUS"\n', {
    mode: 0o755,
  })
  const command = [
    'source "$1"',
    'PANE="$2"',
    'LIVE_TMUX_BIN="$3"',
    'LIVE_TUI_SESSION="ensemble-probe"',
    'live_capture() { cat "$PANE"; }',
    'live_type() { :; }',
    'live_key() { :; }',
    'live_open_ensemble',
  ].join('; ')
  const result = spawnSync(bash, ["-c", command, "--", harness, pane, tmux], {
    encoding: "utf8",
    env: environment(box, {
      ENSEMBLE_LIVE_STEP_TIMEOUT: "1",
      ENSEMBLE_LIVE_TUI_WIDTH: "132",
      ENSEMBLE_LIVE_TUI_HEIGHT: "44",
      TMUX_STUB_LOG: tmuxLog,
      TMUX_STUB_STATUS: String(tmuxStatus),
    }),
  })
  return { result, resize: existsSync(tmuxLog) ? readFileSync(tmuxLog, "utf8") : "" }
}

test("opening Ensemble waits for the statusline, not just the page header", () => {
  // Ticket #287: OpenCode 2.3.0 in CI painted this header a frame before the
  // statusline and composer, and the suite's first typed key was lost. The
  // page is only open when the mode chip row exists; the resize forces that
  // frame at the declared geometry.
  const box = sandbox()
  const header = ["│ ENSEMBLE │ no workspace │", "│ AGENTS (0) │ CHAT │", "│ No currently opened session │"]
  try {
    const partial = join(box.root, "header-only.txt")
    writeFileSync(partial, [...header, ""].join("\n"))
    const closed = openEnsemble(box, partial)
    assert.notEqual(closed.result.status, 0, "a header-only page is not ready for input")
    assert.match(closed.result.stderr, /TUI did not become ready: Ensemble statusline/)
    assert.match(closed.resize, /resize-window -t ensemble-probe -x 132 -y 44/)

    const transcriptOnly = join(box.root, "transcript-only.txt")
    writeFileSync(transcriptOnly, [...header, "│ → earlier NORMAL │ Agents mention │", ""].join("\n"))
    assert.notEqual(
      openEnsemble(box, transcriptOnly).result.status,
      0,
      "a mode word inside another row does not prove the statusline rendered",
    )

    const ready = join(box.root, "ready.txt")
    writeFileSync(ready, [...header, " NORMAL  │ Agents │ j/k move │", ""].join("\n"))
    const opened = openEnsemble(box, ready, 1)
    assert.equal(opened.result.status, 0, opened.result.stderr)
    assert.match(opened.resize, /resize-window -t ensemble-probe -x 132 -y 44/)
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

function captureChatHeader(box: Sandbox, pane: string): number | null {
  const result = spawnSync(
    bash,
    [
      "-c",
      'source "$1"; LIVE_NODE_BIN="$2"; PANE="$3"; live_capture() { cat "$PANE"; }; live_chat_columns() { printf "%s\\n" "1 80"; }; live_chat_header_contains "$4" "leader FakeAgent"',
      "--",
      harness,
      process.execPath,
      pane,
      "fixture",
    ],
    { encoding: "utf8", env: environment(box) },
  )
  return result.status
}

test("the group header assertion joins a wrapped title but ignores transcript rows", () => {
  const box = sandbox()
  try {
    const wrapped = join(box.root, "wrapped.txt")
    writeFileSync(
      wrapped,
      ["#LiveSite │ /tmp/project │ leader", "FakeAgent", "", "→ Assigned to $Helper: transcript row", ""].join("\n"),
    )
    assert.equal(captureChatHeader(box, wrapped), 0, "a wrapped header names the leader and leader agent")

    const missingAgent = join(box.root, "missing-agent.txt")
    writeFileSync(
      missingAgent,
      ["#LiveSite │ /tmp/project │ leader", "", "→ Assigned to $FakeAgent: leader FakeAgent elsewhere", ""].join("\n"),
    )
    assert.notEqual(
      captureChatHeader(box, missingAgent),
      0,
      "a missing header leader agent cannot be satisfied by a transcript row",
    )

    const missingLeader = join(box.root, "missing-leader.txt")
    writeFileSync(
      missingLeader,
      ["#LiveSite │ /tmp/project │ leader Helper", "", "→ Assigned to $FakeAgent: transcript row", ""].join("\n"),
    )
    assert.notEqual(
      captureChatHeader(box, missingLeader),
      0,
      "a header naming a different leader does not pass",
    )
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

function colorPredicate(box: Sandbox, name: string, color: string): boolean {
  const result = spawnSync(bash, ["-c", `source "$1"; ${name} "$2"`, "--", harness, color], {
    encoding: "utf8",
    env: environment(box),
  })
  assert.ok(result.status === 0 || result.status === 1, result.stderr)
  return result.status === 0
}

test("focus white accepts the host high-contrast text tone but not unfocused grey", () => {
  // Ticket #286: OpenCode 2.3.0 themes draw focused headings and borders with
  // the host's high-contrast text (#eeeeee), while unfocused chrome stays grey.
  const box = sandbox()
  try {
    for (const color of ["38;2;255;255;255", "38;2;238;238;238", "38;5;15", "38;5;231", "38;5;255"]) {
      assert.equal(colorPredicate(box, "live_color_is_white", color), true, `${color} is focus white`)
    }
    for (const color of ["default", "38;5;240", "38;2;128;128;128"]) {
      assert.equal(colorPredicate(box, "live_color_is_white", color), false, `${color} is not focus white`)
    }
    for (const color of ["38;5;240", "38;2;128;128;128"]) {
      assert.equal(colorPredicate(box, "live_color_is_grey", color), true, `${color} is unfocused grey`)
    }
    assert.equal(
      colorPredicate(box, "live_color_is_grey", "38;2;238;238;238"),
      false,
      "the high-contrast focus tone is not unfocused grey",
    )
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})
