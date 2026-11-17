import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const checkScript = fileURLToPath(new URL("../../scripts/reference-check.mjs", import.meta.url))
const repoRoot = fileURLToPath(new URL("../..", import.meta.url))

const COPIED_PATHS = [
  "package.json",
  "README.md",
  "LICENSE",
  "docs",
  ".github/workflows/verify.yml",
  ".github/workflows/node-matrix.yml",
]

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ensemble-reference-"))
  for (const path of COPIED_PATHS) {
    cpSync(join(repoRoot, path), join(root, path), { recursive: true })
  }
  return root
}

function read(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8")
}

function replace(root: string, path: string, from: string, to: string): void {
  const text = read(root, path)
  assert.ok(text.includes(from), `${path} must contain ${JSON.stringify(from)} for the fixture`)
  writeFileSync(join(root, path), text.replace(from, to))
}

function run(args: readonly string[]) {
  return spawnSync(process.execPath, ["--experimental-strip-types", ...args], {
    encoding: "utf8",
  })
}

function check(root: string) {
  return run([checkScript, "--root", root])
}

test("reference-check accepts generated reference that covers native and migration tools", () => {
  const root = fixtureRepo()
  try {
    const result = check(root)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /reference:check: ok/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reference-check rejects an undocumented native tool", () => {
  const root = fixtureRepo()
  try {
    replace(root, "docs/reference/tools.md", "## `ensemble_review`", "## `ensemble_review_missing`")
    const result = check(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /ensemble_review/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reference-check rejects an undocumented migration tool", () => {
  const root = fixtureRepo()
  try {
    replace(root, "docs/reference/migration-tools.md", "## `ensemble_handoff`", "## `ensemble_handoff_missing`")
    const result = check(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /ensemble_handoff/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reference-check rejects an undocumented colon command", () => {
  const root = fixtureRepo()
  try {
    replace(root, "docs/reference/commands.md", "### `:limits`", "### `:limits-missing`")
    const result = check(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /:limits/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reference-check rejects a missing keyboard context section", () => {
  const root = fixtureRepo()
  try {
    replace(root, "docs/reference/keyboard.md", "## Roster", "## Roster-missing")
    const result = check(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Roster/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reference-check rejects a missing custom overlay key", () => {
  const root = fixtureRepo()
  try {
    replace(root, "docs/reference/keyboard.md", "PageDown / Ctrl+d", "PageDown-missing")
    const result = check(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /PageDown/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reference-check rejects a missing binding that shares a key id with another context", () => {
  const root = fixtureRepo()
  try {
    replace(root, "docs/reference/keyboard.md", "| Clear search |", "| Clear search-missing |")
    const result = check(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Clear search/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reference-check rejects an undocumented stored setting", () => {
  const root = fixtureRepo()
  try {
    replace(root, "docs/reference/configuration.md", "`maxActiveRuns`", "`maxActiveRuns_missing`")
    const result = check(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /maxActiveRuns/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reference-check rejects an undocumented environment variable", () => {
  const root = fixtureRepo()
  try {
    replace(root, "docs/reference/environment.md", "`ENSEMBLE_LOG_CONTENT`", "`ENSEMBLE_LOG_CONTENT_missing`")
    const result = check(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /ENSEMBLE_LOG_CONTENT/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reference-check rejects a missing generated page", () => {
  const root = fixtureRepo()
  try {
    rmSync(join(root, "docs/reference/files.md"))
    const result = check(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /files\.md.*missing/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reference-check rejects stale generated content", () => {
  const root = fixtureRepo()
  try {
    const path = join(root, "docs/reference/tools.md")
    writeFileSync(path, `${readFileSync(path, "utf8")}\nHand-written line.\n`)
    const result = check(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /tools\.md.*stale/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reference-check rejects an undocumented operator CLI command", () => {
  const root = fixtureRepo()
  try {
    replace(root, "docs/reference/cli.md", "## `npm run support:bundle`", "## `npm run support-bundle`")
    const result = check(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /support:bundle/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reference-check rejects a supported host that is not in the canonical set", () => {
  const root = fixtureRepo()
  try {
    replace(root, "docs/reference/supported.md", "**2.3.0**", "**2.4.0**")
    const result = check(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /2\.4\.0|2\.3\.0/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs:check fails when generated reference drifts", () => {
  const root = fixtureRepo()
  try {
    replace(root, "docs/reference/tools.md", "## `ensemble_review`", "## `ensemble_review_missing`")
    const docsCheck = fileURLToPath(new URL("../../scripts/docs-check.mjs", import.meta.url))
    const result = run([docsCheck, "--root", root])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /reference:check|ensemble_review/)
    assert.doesNotMatch(result.stderr, /docs:check: media:/)
    assert.doesNotMatch(result.stderr, /^docs:check: README\.md: file is missing$/m)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs:check reports a missing root README as a failure, not an internal error", () => {
  const root = fixtureRepo()
  try {
    rmSync(join(root, "README.md"))
    const docsCheck = fileURLToPath(new URL("../../scripts/docs-check.mjs", import.meta.url))
    const result = run([docsCheck, "--root", root])
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /README\.md: file is missing/)
    assert.doesNotMatch(result.stderr, /ENOENT/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reference-check rejects the stale five-tool implementation list", () => {
  const root = fixtureRepo()
  try {
    replace(root, "docs/implementation.md", "- `ensemble_dispatch`\n", "")
    const result = check(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /ensemble_dispatch/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reference-check rejects the stale native-first reset claim", () => {
  const root = fixtureRepo()
  try {
    const path = join(root, "docs/implementation.md")
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\nThe docs claim that :native-first on also clears a legacy tool-surface override so the native list returns.\n`,
    )
    const result = check(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /native-first/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("reference-check rejects a stale current-release claim", () => {
  const root = fixtureRepo()
  try {
    const path = join(root, "docs/implementation.md")
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\nThe package is not a published release yet.\n`,
    )
    const result = check(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /published release/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
