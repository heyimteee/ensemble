import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("../../scripts/issue-hygiene.mjs", import.meta.url))

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ensemble-issue-hygiene-"))
  mkdirSync(join(root, "docs", "verification"), { recursive: true })
  writeFileSync(join(root, "docs", "verification", "2026-11-05-v58.md"), "# v5.8\n")
  return root
}

function issuesFile(root: string): string {
  const path = join(root, "issues.json")
  writeFileSync(path, JSON.stringify([
    {
      number: 200,
      title: "Spec: Ensemble v6.0 - open but finished",
      state: "OPEN",
      subIssuesSummary: { completed: 3, total: 3 },
    },
    {
      number: 99,
      title: "Spec: Ensemble v5.8 - delivered version spec",
      state: "CLOSED",
      subIssuesSummary: { completed: 5, total: 5 },
    },
    {
      number: 105,
      title: "Spec: Ensemble v5.9 - children still open",
      state: "OPEN",
      subIssuesSummary: { completed: 0, total: 7 },
    },
    {
      number: 201,
      title: "Spec: Ensemble v5.7 - one child open",
      state: "OPEN",
      subIssuesSummary: { completed: 4, total: 5 },
    },
    {
      number: 202,
      title: "Not a parent",
      state: "OPEN",
      subIssuesSummary: { completed: 0, total: 0 },
    },
    {
      number: 42,
      title: "Ensemble v5: developer guardrails and runtime diagnosis",
      state: "CLOSED",
      subIssuesSummary: { completed: 5, total: 5 },
    },
  ]))
  return path
}

function run(root: string, args: string[]) {
  return spawnSync(process.execPath, [script, "--input", issuesFile(root), "--root", root, ...args], {
    encoding: "utf8",
  })
}

test("the hygiene listing reports open parents whose children are all closed", () => {
  const root = fixtureRoot()
  try {
    const result = run(root, [])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /#200\b/)
    assert.match(result.stdout, /3\/3 closed/)
    assert.doesNotMatch(result.stdout, /#105\b/)
    assert.doesNotMatch(result.stdout, /#99\b/)
    assert.doesNotMatch(result.stdout, /#202\b/)
    assert.match(result.stdout, /1 parent issue with all sub-issues closed/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("--all includes closed parents and names their verification record", () => {
  const root = fixtureRoot()
  try {
    const result = run(root, ["--all"])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /#99\b/)
    assert.match(result.stdout, /5\/5 closed/)
    assert.match(result.stdout, /docs\/verification\/2026-11-05-v58\.md/)
    assert.match(result.stdout, /#200\b/)
    assert.doesNotMatch(result.stdout, /#105\b/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a version spec without a verification record is marked missing", () => {
  const root = fixtureRoot()
  try {
    const result = run(root, ["--all"])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /#200.*missing/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a base version does not match a later minor record", () => {
  const root = fixtureRoot()
  try {
    const result = run(root, ["--all"])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /#42.*verification: missing/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
