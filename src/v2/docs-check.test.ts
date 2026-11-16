import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("../../scripts/docs-check.mjs", import.meta.url))
const repoRoot = fileURLToPath(new URL("../..", import.meta.url))

const COPIED_PATHS = [
  "package.json",
  "README.md",
  "scripts/README.md",
  "docs/README.md",
  "docs/implementation.md",
  "docs/adr/0011-mention-routing-and-budgets.md",
  "docs/compatibility/opencode-host-range.md",
  "docs/verification",
  ".github/workflows/verify.yml",
  ".github/workflows/compatibility.yml",
  ".github/workflows/node-matrix.yml",
]

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ensemble-docs-check-"))
  for (const path of COPIED_PATHS) {
    cpSync(join(repoRoot, path), join(root, path), { recursive: true })
  }
  return root
}

function read(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8")
}

function write(root: string, path: string, text: string): void {
  writeFileSync(join(root, path), text)
}

function replace(root: string, path: string, from: string, to: string): void {
  const text = read(root, path)
  assert.ok(text.includes(from), `${path} must contain ${JSON.stringify(from)} for the fixture`)
  write(root, path, text.replace(from, to))
}

function run(root: string) {
  return spawnSync(process.execPath, ["--experimental-strip-types", script, "--root", root], {
    encoding: "utf8",
  })
}

test("docs-check accepts the current docs and canonical versions", () => {
  const root = fixtureRepo()
  try {
    const result = run(root)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /docs:check: ok/)
    assert.match(result.stdout, /contract v7/)
    assert.match(result.stdout, /OpenCode 2\.2\.6, 2\.2\.7/)
    assert.match(result.stdout, /Node >=22\.23\.4/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check rejects a stale contract-version claim", () => {
  const root = fixtureRepo()
  try {
    replace(root, "README.md", "contract v7", "contract v6")
    const result = run(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /README\.md.*contract v6/)
    assert.match(result.stderr, /contract v7/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check rejects a stale Node floor claim", () => {
  const root = fixtureRepo()
  try {
    replace(root, "scripts/README.md", "Node 22.23.4+", "Node 26.4+")
    const result = run(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /scripts\/README\.md.*Node 26\.4\+/)
    assert.match(result.stderr, /22\.23\.4/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check rejects an untested OpenCode host claim", () => {
  const root = fixtureRepo()
  try {
    replace(root, "README.md", "OpenCode **2.2.6** and **2.2.7**", "OpenCode **2.2.5** and **2.2.7**")
    const result = run(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /README\.md/)
    assert.match(result.stderr, /2\.2\.6/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check rejects a current verification record missing from the index", () => {
  const root = fixtureRepo()
  try {
    write(root, "docs/verification/2026-11-13-unlinked.md", "# Unlinked\n")
    const result = run(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /2026-11-13-unlinked\.md/)
    assert.match(result.stderr, /docs\/README\.md/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
