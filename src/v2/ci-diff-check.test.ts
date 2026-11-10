import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("../../scripts/ci-diff-check.sh", import.meta.url))
const bash = existsSync("/bin/bash") ? "/bin/bash" : "/usr/bin/bash"
const zero = "0000000000000000000000000000000000000000"

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
  return result.stdout.trim()
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "ensemble-ci-diff-"))
  git(root, ["init", "-q", "-b", "main"])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  return root
}

function commit(root: string, file: string, body: string): string {
  writeFileSync(join(root, file), body)
  git(root, ["add", file])
  git(root, ["commit", "-q", "-m", `update ${file}`])
  return git(root, ["rev-parse", "HEAD"])
}

function check(root: string, env: Record<string, string>) {
  return spawnSync(bash, [script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PR_BASE_SHA: "", PUSH_BEFORE_SHA: "", ...env },
  })
}

function output(result: ReturnType<typeof check>): string {
  return `${result.stdout}${result.stderr}`
}

test("the diff check passes for a clean pushed range", () => {
  const root = repository()
  try {
    const base = commit(root, "base.txt", "base\n")
    commit(root, "next.txt", "next\n")
    const result = check(root, { PUSH_BEFORE_SHA: base })
    assert.equal(result.status, 0, output(result))
    assert.match(result.stdout, new RegExp(`checking ${base}\\.\\.HEAD`))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the diff check fails on committed trailing whitespace", () => {
  const root = repository()
  try {
    const base = commit(root, "base.txt", "base\n")
    commit(root, "space.txt", "trailing \n")
    const result = check(root, { PUSH_BEFORE_SHA: base })
    assert.notEqual(result.status, 0)
    assert.match(output(result), /trailing whitespace/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the diff check fails on committed conflict residue", () => {
  const root = repository()
  try {
    const base = commit(root, "base.txt", "base\n")
    commit(root, "conflict.txt", "<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> branch\n")
    const result = check(root, { PR_BASE_SHA: base })
    assert.notEqual(result.status, 0)
    assert.match(output(result), /leftover conflict marker/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the diff check ignores whitespace that predates the pushed range", () => {
  const root = repository()
  try {
    commit(root, "old.txt", "preexisting \n")
    const base = commit(root, "base.txt", "base\n")
    commit(root, "next.txt", "next\n")
    const result = check(root, { PUSH_BEFORE_SHA: base })
    assert.equal(result.status, 0, output(result))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the diff check inspects the full tree for an initial push", () => {
  const root = repository()
  try {
    commit(root, "space.txt", "trailing \n")
    const result = check(root, { PUSH_BEFORE_SHA: zero })
    assert.notEqual(result.status, 0)
    assert.match(result.stdout, /initial push/)
    assert.match(output(result), /trailing whitespace/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the diff check falls back to the full tree when the base is unavailable", () => {
  const root = repository()
  try {
    commit(root, "space.txt", "trailing \n")
    const result = check(root, { PUSH_BEFORE_SHA: "deadbeef".repeat(5) })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /base .* is unavailable/)
    assert.match(output(result), /trailing whitespace/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
