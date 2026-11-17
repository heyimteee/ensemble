import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("../../scripts/docs-check.mjs", import.meta.url))
const repoRoot = fileURLToPath(new URL("../..", import.meta.url))

const COPIED_PATHS = [
  "package.json",
  "README.md",
  "LICENSE",
  "AGENTS.md",
  "GLOSSARY.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "scripts/README.md",
  "docs",
  "src",
  "scripts",
  ".github/ISSUE_TEMPLATE",
  ".github/PULL_REQUEST_TEMPLATE.md",
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

function replaceAll(root: string, path: string, from: string, to: string): void {
  const text = read(root, path)
  assert.ok(text.includes(from), `${path} must contain ${JSON.stringify(from)} for the fixture`)
  write(root, path, text.replaceAll(from, to))
}

function append(root: string, path: string, text: string): void {
  writeFileSync(join(root, path), `${read(root, path)}${text}`)
}

function run(root: string, extraArgs: readonly string[] = []) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", script, "--root", root, "--skip-site-build", ...extraArgs],
    { encoding: "utf8" },
  )
}

test("docs-check accepts the current docs and canonical versions", () => {
  const root = fixtureRepo()
  try {
    const result = run(root)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /docs:check: ok/)
    assert.match(result.stdout, /contract v7/)
    assert.match(result.stdout, /OpenCode 2\.2\.6, 2\.2\.7, 2\.3\.0/)
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

test("docs-check rejects a tested Node line missing from the README", () => {
  const root = fixtureRepo()
  try {
    replaceAll(
      root,
      "README.md",
      "Node 22.23.4, 24.22.1, and 26.12.1",
      "Node 22.23.4, 24.22.1, and 25.0.0",
    )
    const result = run(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /README\.md: missing current claim "Node 22\.23\.4, 24\.22\.1, and 26\.12\.1"/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check derives the tested Node claim from the matrix workflow", () => {
  const root = fixtureRepo()
  try {
    replace(root, ".github/workflows/node-matrix.yml", '"26.12.1"', '"26.13.0"')
    const result = run(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /README\.md: missing current claim "Node 22\.23\.4, 24\.22\.1, and 26\.13\.0"/)
    assert.match(result.stderr, /tested Node 26\.12\.1 is not in the matrix/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check rejects an untested OpenCode host claim", () => {
  const root = fixtureRepo()
  try {
    replace(root, "README.md", "OpenCode **2.2.6**, **2.2.7**, and **2.3.0**", "OpenCode **2.2.5**, **2.2.7**, and **2.3.0**")
    const result = run(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /README\.md/)
    assert.match(result.stderr, /2\.2\.6/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check rejects a README that drops the MIT license claim", () => {
  const root = fixtureRepo()
  try {
    replace(root, "README.md", "Ensemble is released under the [MIT License](LICENSE).", "The license is undecided.")
    const result = run(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /README\.md.*MIT/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check rejects a stale no-license claim", () => {
  const root = fixtureRepo()
  try {
    replace(
      root,
      "README.md",
      "## License\n\nEnsemble is released under the [MIT License](LICENSE).",
      "## License\n\nA license has not been selected.",
    )
    const result = run(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /README\.md.*license has not been selected/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check rejects an install command that does not match the package name", () => {
  const root = fixtureRepo()
  try {
    replaceAll(root, "README.md", "opencode plugin add @heyimteee/ensemble", "opencode plugin add ensemble")
    const result = run(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /README\.md.*@heyimteee\/ensemble/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check rejects a package license that is not MIT", () => {
  const root = fixtureRepo()
  try {
    replace(root, "package.json", '"license": "MIT"', '"license": "Apache-2.0"')
    const result = run(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /package\.json.*MIT/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check rejects a missing LICENSE file", () => {
  const root = fixtureRepo()
  try {
    rmSync(join(root, "LICENSE"))
    const result = run(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /LICENSE: file is missing/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check rejects a current verification record missing from the evidence index", () => {
  const root = fixtureRepo()
  try {
    write(root, "docs/verification/2026-11-13-unlinked.md", "# Unlinked\n")
    const result = run(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /2026-11-13-unlinked\.md/)
    assert.match(result.stderr, /docs\/contributing\/evidence\.md/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check accepts a current verification record linked from the evidence index", () => {
  const root = fixtureRepo()
  try {
    write(root, "docs/verification/2026-11-13-linked.md", "# Linked\n")
    append(
      root,
      "docs/contributing/evidence.md",
      "\n- [Linked record](../verification/2026-11-13-linked.md)\n",
    )
    const result = run(root)
    assert.equal(result.status, 0, result.stderr)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check rejects a docs home that drops a section index", () => {
  const root = fixtureRepo()
  try {
    replaceAll(root, "docs/README.md", "getting-started/README.md", "getting-started.md")
    const result = run(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /docs\/README\.md.*getting-started\/README\.md/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check rejects a contributing hub without the evidence index", () => {
  const root = fixtureRepo()
  try {
    replaceAll(root, "docs/contributing/README.md", "evidence.md", "records.md")
    const result = run(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /docs\/contributing\/README\.md.*evidence\.md/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check rejects a missing documentation style guide", () => {
  const root = fixtureRepo()
  try {
    rmSync(join(root, "docs/style-guide.md"))
    const result = run(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /docs\/style-guide\.md: file is missing/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check rejects a missing documentation redirect map", () => {
  const root = fixtureRepo()
  try {
    rmSync(join(root, "docs/redirects.md"))
    const result = run(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /docs\/redirects\.md: file is missing/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check rejects a README without the support path", () => {
  const root = fixtureRepo()
  try {
    replace(root, "README.md", "docs/support/README.md", "docs/unsupported.md")
    const result = run(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /README\.md.*docs\/support\/README\.md/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check rejects a missing incident runbook", () => {
  const root = fixtureRepo()
  try {
    rmSync(join(root, "docs/support/incident-runbook.md"))
    const result = run(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /docs\/support\/incident-runbook\.md: file is missing/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check rejects a template without the redaction warning", () => {
  const root = fixtureRepo()
  try {
    replaceAll(root, ".github/ISSUE_TEMPLATE/bug.yml", "conversation content", "conversation text")
    const result = run(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /bug\.yml.*conversation content/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check fast mode explicitly skips the VitePress build", () => {
  const root = fixtureRepo()
  try {
    const result = run(root)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /site build: skipped \(--skip-site-build\)/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check reports a missing required page as a validation error, not an internal error", () => {
  const root = fixtureRepo()
  try {
    rmSync(join(root, "docs/getting-started/quickstart.md"))
    const result = run(root)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /docs\/getting-started\/quickstart\.md: required page is missing/)
    assert.doesNotMatch(result.stderr, /ENOENT|at .*docs-check\.mjs/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check rejects a broken internal link", () => {
  const root = fixtureRepo()
  try {
    append(root, "docs/concepts/README.md", "\n[Missing](missing-page.md)\n")
    const result = run(root)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /docs\/concepts\/README\.md.*missing-page\.md/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check rejects an unknown internal anchor", () => {
  const root = fixtureRepo()
  try {
    append(root, "docs/getting-started/quickstart.md", "\n[Missing anchor](install.md#no-such-section)\n")
    const result = run(root)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /quickstart\.md.*install\.md#no-such-section/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check accepts the VitePress ids for numeric, punctuation, emoji, and duplicate headings", () => {
  const root = fixtureRepo()
  try {
    append(
      root,
      "docs/getting-started/quickstart.md",
      [
        "",
        "## 2.2.7 rendered fixture",
        "",
        "[Numeric](quickstart.md#_2-2-7-rendered-fixture)",
        "",
        "## Release — 0.1.0-rc.2 (rendered fixture)",
        "",
        "[Punctuation](quickstart.md#release-—-0-1-0-rc-2-rendered-fixture)",
        "",
        "## 🚀 Rendered launch",
        "",
        "[Emoji](quickstart.md#🚀-rendered-launch)",
        "",
        "## Rendered setup",
        "",
        "## Rendered setup",
        "",
        "[Duplicate](quickstart.md#rendered-setup-1)",
        "",
      ].join("\n"),
    )
    const result = run(root)
    assert.equal(result.status, 0, result.stderr)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check does not weaken the rendered anchor contract to GitHub slugs", () => {
  const root = fixtureRepo()
  try {
    append(
      root,
      "docs/getting-started/quickstart.md",
      "\n## 2.2.8 rendered fixture\n\n[GitHub slug](quickstart.md#228-rendered-fixture)\n",
    )
    const result = run(root)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /broken anchor #228-rendered-fixture/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check does not accept a verification filename mentioned only in prose", () => {
  const root = fixtureRepo()
  try {
    write(root, "docs/verification/2026-11-13-prose-only.md", "# Prose only\n")
    append(root, "docs/contributing/evidence.md", "\nThe record 2026-11-13-prose-only.md is not a link.\n")
    const result = run(root)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /2026-11-13-prose-only\.md/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check requires frontmatter metadata on every user-facing page", () => {
  const root = fixtureRepo()
  try {
    replace(
      root,
      "docs/getting-started/quickstart.md",
      "---\ntitle: Quickstart\ndescription: Go from a fresh install to a first group reply and a finished work item, with expected output at each step.\nversion: 0.1.x\n---\n\n",
      "",
    )
    const result = run(root)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /quickstart\.md.*frontmatter/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check rejects a frontmatter version scope outside the stable line", () => {
  const root = fixtureRepo()
  try {
    replace(root, "docs/getting-started/quickstart.md", "version: 0.1.x", "version: 0.2.x")
    const result = run(root)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /quickstart\.md.*version/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check rejects an unclosed code fence", () => {
  const root = fixtureRepo()
  try {
    append(root, "docs/getting-started/quickstart.md", "\n```sh\nnpm run verify\n")
    const result = run(root)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /quickstart\.md.*unclosed code fence/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check rejects invalid shell syntax in a documented command", () => {
  const root = fixtureRepo()
  try {
    append(root, "docs/getting-started/quickstart.md", "\n```sh\nif true; then\n```\n")
    const result = run(root)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /quickstart\.md.*shell syntax/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("docs-check rejects a user page that is absent from its section inventory", () => {
  const root = fixtureRepo()
  try {
    write(
      root,
      "docs/concepts/orphan-page.md",
      "---\ntitle: Orphan page\ndescription: A page with no navigation entry.\nversion: 0.1.x\n---\n\n# Orphan page\n\nNo section index links here.\n",
    )
    const result = run(root)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /orphan-page\.md.*not reachable/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("package exposes the full, fast, and Markdown-lint documentation gates", () => {
  const pkg = JSON.parse(read(repoRoot, "package.json"))
  assert.match(pkg.scripts["docs:check"], /scripts\/docs-check\.mjs\s*$/)
  assert.match(pkg.scripts["docs:check:fast"], /docs-check\.mjs --fast$/)
  assert.match(pkg.scripts["docs:check:fast"], /npm run docs:lint/)
  assert.match(pkg.scripts["docs:lint"], /markdownlint-cli2/)
  assert.match(pkg.scripts["docs:site:build"], /docs-site-anchors\.mjs/)
  assert.ok(existsSync(join(repoRoot, ".markdownlint-cli2.jsonc")))
})
