import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const preflight = fileURLToPath(new URL("../../scripts/live-preflight.sh", import.meta.url))
const bash = existsSync("/bin/bash") ? "/bin/bash" : "/usr/bin/bash"

type Sandbox = { root: string; home: string; bin: string; tools: string }

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "ensemble-live-preflight-"))
  const home = join(root, "home")
  const bin = join(root, "bin")
  const tools = join(root, "tools")
  mkdirSync(home)
  mkdirSync(bin)
  mkdirSync(tools)
  for (const tool of ["curl", "dirname", "git"]) {
    const source = [`/usr/bin/${tool}`, `/bin/${tool}`].find((candidate) => existsSync(candidate))
    if (!source) throw new Error(`test needs ${tool} on the host`)
    symlinkSync(source, join(tools, tool))
  }
  return { root, home, bin, tools }
}

function stub(box: Sandbox, name: string, output: string): string {
  const path = join(box.bin, name)
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`)
  chmodSync(path, 0o755)
  return path
}

// A minimal PATH keeps fd absent even on hosts that install it under /usr/bin.
// curl, dirname, and git stay available for the harness support-tool gate.
function environment(box: Sandbox, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: box.tools,
    HOME: box.home,
    NODE_BIN: stub(box, "node", "v26.12.1"),
    OPENCODE_BIN: stub(box, "opencode", "opencode v2.2.5"),
    TMUX_BIN: stub(box, "tmux", "tmux 3.5a"),
    ...extra,
  }
}

test("the fake suite preflight does not require fd", () => {
  const box = sandbox()
  try {
    const result = spawnSync(bash, [preflight], { encoding: "utf8", env: environment(box) })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /preflight: node v26\.12\.1/)
    assert.match(result.stdout, /preflight: opencode opencode v2\.2\.5/)
    assert.match(result.stdout, /preflight: tmux 3\.5a/)
    assert.doesNotMatch(result.stdout, /fd is not installed/)
    assert.doesNotMatch(result.stdout, /preflight: fdfind/)
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

test("the full-matrix preflight requires fd and honours require mode", () => {
  const box = sandbox()
  try {
    const local = spawnSync(bash, [preflight, "all"], { encoding: "utf8", env: environment(box) })
    assert.equal(local.status, 0, local.stderr)
    assert.match(local.stdout, /fd is not installed/)
    assert.match(local.stdout, /; skipping/)

    const required = spawnSync(bash, [preflight, "all"], {
      encoding: "utf8",
      env: environment(box, { ENSEMBLE_LIVE_REQUIRE: "1" }),
    })
    assert.notEqual(required.status, 0)
    assert.match(required.stderr, /fd is not installed/)
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

test("a pinned version must match exactly, not as a substring", () => {
  const box = sandbox()
  try {
    const env = environment(box, {
      ENSEMBLE_LIVE_EXPECT_NODE: "26.12.1",
      ENSEMBLE_LIVE_EXPECT_OPENCODE: "2.2.5",
    })
    env.OPENCODE_BIN = stub(box, "opencode-2.2.50", "opencode v2.2.50")
    const result = spawnSync(bash, [preflight], { encoding: "utf8", env })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /expected OpenCode 2\.2\.5/)
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})
