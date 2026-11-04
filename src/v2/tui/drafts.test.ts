import test from "node:test"
import assert from "node:assert/strict"
import {
  applySendResult,
  clearDraft,
  draftFor,
  draftKey,
  updateDraft,
} from "./drafts.ts"

test("draft keys separate each Workspace from each Direct conversation", () => {
  assert.equal(draftKey({ kind: "workspace", workspaceID: "w1" }), "workspace:w1")
  assert.equal(draftKey({ kind: "agent", agentID: "a1" }), "direct:a1")
  assert.notEqual(
    draftKey({ kind: "workspace", workspaceID: "w1" }),
    draftKey({ kind: "agent", agentID: "a1" }),
  )
  assert.equal(draftKey(null), null)
})

test("switching surfaces restores that surface's own draft", () => {
  let drafts = {}
  const workspace = { kind: "workspace" as const, workspaceID: "w1" }
  const direct = { kind: "agent" as const, agentID: "a1" }
  drafts = updateDraft(drafts, draftKey(workspace)!, "group thought")
  drafts = updateDraft(drafts, draftKey(direct)!, "direct thought")

  assert.equal(draftFor(drafts, draftKey(workspace)!), "group thought")
  assert.equal(draftFor(drafts, draftKey(direct)!), "direct thought")
  assert.equal(draftFor(drafts, draftKey({ kind: "workspace", workspaceID: "w2" })!), "")
})

test("editing one draft never touches another surface's text", () => {
  let drafts = {}
  drafts = updateDraft(drafts, "workspace:w1", "keep me")
  drafts = updateDraft(drafts, "direct:a1", "change me")
  drafts = updateDraft(drafts, "direct:a1", "changed")
  assert.equal(draftFor(drafts, "workspace:w1"), "keep me")
  assert.equal(draftFor(drafts, "direct:a1"), "changed")
})

test("clearing one surface's draft leaves every other surface intact", () => {
  let drafts = {}
  drafts = updateDraft(drafts, "workspace:w1", "keep me")
  drafts = updateDraft(drafts, "direct:a1", "drop me")
  const cleared = clearDraft(drafts, "direct:a1")
  assert.equal(draftFor(cleared, "workspace:w1"), "keep me")
  assert.equal(draftFor(cleared, "direct:a1"), "")
})

test("a failed or busy send keeps the draft; only a successful send clears its surface", () => {
  let drafts = {}
  drafts = updateDraft(drafts, "workspace:w1", "unsent")
  drafts = updateDraft(drafts, "direct:a1", "other")

  const failed = applySendResult(drafts, "workspace:w1", false)
  assert.equal(failed, drafts, "failure leaves the store untouched")
  assert.equal(draftFor(failed, "workspace:w1"), "unsent")

  const sent = applySendResult(failed, "workspace:w1", true)
  assert.equal(draftFor(sent, "workspace:w1"), "")
  assert.equal(draftFor(sent, "direct:a1"), "other", "other surfaces keep their drafts")
})
