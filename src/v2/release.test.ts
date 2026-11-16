import test from "node:test"
import assert from "node:assert/strict"

import { distTagFor, releaseNotesFor, releaseTagFor, validateReleaseRef } from "./release.ts"

/**
 * Ticket #275: the release workflow must not publish from a branch and must
 * not release a tag that disagrees with the package version. These pure checks
 * are the contract the workflow runs before it touches a registry.
 */
test("ticket275: a tag push releases exactly the package version", () => {
  assert.equal(releaseTagFor("0.1.0-rc.2"), "v0.1.0-rc.2")
  assert.deepEqual(validateReleaseRef({ eventName: "push", ref: "refs/tags/v0.1.0-rc.2" }, "0.1.0-rc.2"), {
    ok: true,
    dryRun: false,
    tag: "v0.1.0-rc.2",
  })
})

test("ticket275: a mismatched tag or a plain branch push is refused", () => {
  const mismatch = validateReleaseRef({ eventName: "push", ref: "refs/tags/v0.1.0" }, "0.1.0-rc.2")
  assert.equal(mismatch.ok, false)
  if (!mismatch.ok) assert.match(mismatch.error, /v0\.1\.0.*0\.1\.0-rc\.2/)

  for (const ref of ["refs/heads/main", "refs/heads/ticket/275-release"]) {
    const branch = validateReleaseRef({ eventName: "push", ref }, "0.1.0-rc.2")
    assert.equal(branch.ok, false)
    if (!branch.ok) assert.match(branch.error, /tag/)
  }
})

test("ticket275: a manual dispatch is always a dry run", () => {
  assert.deepEqual(validateReleaseRef({ eventName: "workflow_dispatch", ref: "refs/heads/main" }, "0.1.0-rc.2"), {
    ok: true,
    dryRun: true,
  })
})

test("ticket275: a prerelease uses the next dist-tag, a final release uses latest", () => {
  assert.equal(distTagFor("0.1.0-rc.2"), "next")
  assert.equal(distTagFor("1.0.0-beta.1"), "next")
  assert.equal(distTagFor("0.1.0"), "latest")
  assert.equal(distTagFor("1.2.3"), "latest")
})

test("ticket275: the release notes are the changelog section for the version", () => {
  const changelog = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "- later",
    "",
    "## [1.2.30] - 2026-02-01",
    "",
    "- wrong version",
    "",
    "## [1.2.3] - 2026-01-02",
    "",
    "### Added",
    "",
    "- thing",
    "",
    "## [1.2.2] - 2025-12-01",
    "",
    "- old",
    "",
  ].join("\n")

  assert.equal(releaseNotesFor(changelog, "1.2.3"), "### Added\n\n- thing")
  assert.equal(releaseNotesFor(changelog, "9.9.9"), null)
})
