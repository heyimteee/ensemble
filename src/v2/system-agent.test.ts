import test from "node:test"
import assert from "node:assert/strict"
import {
  initCancelReport,
  initComposerIssue,
  initFailureReport,
  initInterruptedReport,
  initSuccessReport,
} from "./system-agent.ts"

test("init is accepted only as the exact solo composer command", () => {
  assert.equal(initComposerIssue("/init"), undefined)
  assert.equal(initComposerIssue("/ensemble-init"), undefined)
  assert.equal(initComposerIssue(":init"), undefined)
  for (const text of [
    "$Nova /init",
    "/init /plan",
    "$Nova /plan /init",
    ":init $Nova",
    ":init extra",
    "/ensemble-init /review",
    "$Nova /ensemble-init",
  ]) {
    assert.match(initComposerIssue(text) ?? "", /solo/i, text)
  }
})

test("prose /init is ordinary text, not an init trigger", () => {
  for (const text of [
    "hello /init",
    "please run /init later",
    "hello :init",
    "/initialise",
    "read /init/notes.md",
  ]) {
    assert.equal(initComposerIssue(text), undefined, text)
  }
})

test("success report names the native run and the files it installed", () => {
  const report = initSuccessReport("/repo/site", "Inspected the project and wrote guidance.")
  assert.match(report, /Ensemble init complete/)
  assert.match(report, /Inspected the project and wrote guidance\./)
  assert.match(report, /\/repo\/site/)
  assert.match(report, /AGENTS\.md/)
  assert.match(report, /\.ensemble\/init\.json/)
})

test("failure and interruption reports tell the user whether AGENTS.md was rolled back", () => {
  const failed = initFailureReport("native command failed", true)
  assert.match(failed, /Ensemble init failed/)
  assert.match(failed, /native command failed/)
  assert.match(failed, /restored/)
  const created = initFailureReport("native command failed", false)
  assert.match(created, /removed/)
  const cancelled = initCancelReport("Workspace archived.")
  assert.match(cancelled, /cancelled/i)
  assert.match(cancelled, /Workspace archived\./)
  assert.match(cancelled, /AGENTS\.md/)
  assert.match(cancelled, /rerun/i)
})

test("restart recovery settles to an explicit report with the rollback outcome", () => {
  const restored = initInterruptedReport(true)
  assert.match(restored, /interrupted by a service restart/i)
  assert.match(restored, /restored/)
  assert.match(restored, /Rerun \/init/)
  const removed = initInterruptedReport(false)
  assert.match(removed, /removed/)
})
