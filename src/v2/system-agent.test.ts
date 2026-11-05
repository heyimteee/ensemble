import test from "node:test"
import assert from "node:assert/strict"
import {
  INIT_COMMAND,
  SYSTEM_AGENT_NAME,
  initCancelReport,
  initComposerIssue,
  initFailureReport,
  initSuccessReport,
} from "./system-agent.ts"

test("System Agent is a named transcript author, not a slash command", () => {
  assert.equal(SYSTEM_AGENT_NAME, "System Agent")
  assert.equal(INIT_COMMAND, "/init")
})

test("init is accepted only as the exact solo composer command", () => {
  assert.equal(initComposerIssue("/init"), undefined)
  assert.match(initComposerIssue("$Nova /init") ?? "", /solo/i)
  assert.match(initComposerIssue("/init /plan") ?? "", /solo/i)
  assert.match(initComposerIssue("$Nova /plan /init") ?? "", /solo/i)
  assert.match(initComposerIssue("hello /init") ?? "", /solo/i)
  assert.equal(initComposerIssue("hello"), undefined)
  assert.equal(initComposerIssue("/initialise"), undefined)
  assert.equal(initComposerIssue("read /init/notes.md"), undefined)
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
