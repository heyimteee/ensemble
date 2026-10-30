import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import { parseGitStatus, readGitState } from "./git.ts"

test("git status parsing covers clean, dirty, ahead/behind, no-commit, and detached repos", () => {
  assert.deepEqual(parseGitStatus("## main...origin/main [ahead 1, behind 2]\n M src/app.ts\n"), {
    branch: "main",
    dirty: true,
    ahead: 1,
    behind: 2,
  })
  assert.deepEqual(parseGitStatus("## main\n"), { branch: "main", dirty: false, ahead: 0, behind: 0 })
  assert.deepEqual(parseGitStatus("## No commits yet on master\n"), { branch: "master", dirty: false, ahead: 0, behind: 0 })
  assert.deepEqual(parseGitStatus("## HEAD (no branch)\n"), { branch: "detached", dirty: false, ahead: 0, behind: 0 })
  assert.equal(parseGitStatus(""), null)
})

test("non-git directories return no git state without throwing", () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-nongit-"))
  try {
    assert.equal(readGitState(directory), null)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("git directories report the branch and dirty state", () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-git-"))
  try {
    const init = spawnSync("git", ["init", "-q", directory], { encoding: "utf8" })
    if (init.status !== 0) return
    const clean = readGitState(directory)
    assert.ok(clean)
    assert.equal(clean.dirty, false)
    writeFileSync(join(directory, "change.txt"), "dirty\n")
    const dirty = readGitState(directory)
    assert.ok(dirty)
    assert.equal(dirty.dirty, true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})


test("non-git lookups do not leak git stderr into the TUI", () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-nongit-stderr-"))
  try {
    const module = pathToFileURL(join(import.meta.dirname, "git.ts")).href
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import { readGitState } from ${JSON.stringify(module)}; console.log(readGitState(${JSON.stringify(directory)}))`], { encoding: "utf8" })
    assert.equal(result.status, 0)
    assert.equal(result.stderr, "")
    assert.match(result.stdout, /null/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
