import test from "node:test"
import assert from "node:assert/strict"
import type { Approval } from "../types.ts"
import {
  APPROVAL_EMPHASIS_MS,
  APPROVAL_RESOLVE_EMPHASIS_MS,
  APPROVAL_RESOLVE_SETTLE_MS,
  approvalResolvedTone,
  createApprovalInboxTrack,
  updateApprovalInboxMotion,
} from "./approvals.ts"

function approval(id: string, status: Approval["status"] = "pending", title = id): Approval {
  return {
    id,
    kind: "ask_person",
    title,
    detail: `${title} detail`,
    status,
    createdAt: 1,
  }
}

test("ticket126: a newly arrived approval emphasizes once and then settles", () => {
  const track = createApprovalInboxTrack()
  assert.equal(updateApprovalInboxMotion(track, [], 100, {}).emphasized.size, 0, "an empty inbox has nothing to emphasize")

  const arrived = updateApprovalInboxMotion(track, [approval("ap-1")], 200, {})
  assert.deepEqual([...arrived.emphasized], ["ap-1"], "the new approval is emphasized on arrival")
  assert.equal(arrived.active, true, "the one-shot window keeps the approval clock active")

  const stillEmphasized = updateApprovalInboxMotion(track, [approval("ap-1")], 200 + APPROVAL_EMPHASIS_MS - 1, {})
  assert.deepEqual([...stillEmphasized.emphasized], ["ap-1"], "the emphasis holds for its short window")

  const settled = updateApprovalInboxMotion(track, [approval("ap-1")], 200 + APPROVAL_EMPHASIS_MS, {})
  assert.equal(settled.emphasized.size, 0, "the emphasis ends at the window boundary")
  const later = updateApprovalInboxMotion(track, [approval("ap-1")], 200 + APPROVAL_EMPHASIS_MS * 10, {})
  assert.equal(later.emphasized.size, 0, "a later snapshot never restarts the emphasis")
  assert.equal(later.active, false, "an idle inbox holds no settle window")
})

test("ticket126: approvals already present on mount never flash a synthetic arrival", () => {
  const track = createApprovalInboxTrack()
  const mounted = updateApprovalInboxMotion(track, [approval("ap-old")], 1_000, {})
  assert.equal(mounted.emphasized.size, 0, "the first observation is the baseline")
  const repeated = updateApprovalInboxMotion(track, [approval("ap-old")], 1_100, {})
  assert.equal(repeated.emphasized.size, 0, "repeated snapshots of the baseline stay quiet")
})

test("ticket126: reduced motion keeps the approval arrival without decorative emphasis", () => {
  const track = createApprovalInboxTrack()
  updateApprovalInboxMotion(track, [], 100, { ENSEMBLE_REDUCED_MOTION: "1" })
  const view = updateApprovalInboxMotion(track, [approval("ap-1")], 200, { ENSEMBLE_REDUCED_MOTION: "1" })
  assert.equal(view.emphasized.size, 0, "the final state mounts directly")
  assert.equal(view.active, false, "no decorative settle runs")
})

test("ticket126: a resolved approval settles once and then leaves the inbox", () => {
  const track = createApprovalInboxTrack()
  updateApprovalInboxMotion(track, [approval("ap-1", "pending", "Contact Echo")], 100, {})

  const resolved = updateApprovalInboxMotion(track, [approval("ap-1", "approved", "Contact Echo")], 200, {})
  assert.equal(resolved.resolved.length, 1, "the resolved row settles into the inbox")
  assert.equal(resolved.resolved[0].approval.title, "Contact Echo", "the settle keeps the approval identity")
  assert.equal(resolved.resolved[0].ageMs, 0, "the settle starts now")
  assert.equal(resolved.active, true, "the settle window keeps updating")

  const repeated = updateApprovalInboxMotion(track, [approval("ap-1", "approved", "Contact Echo")], 250, {})
  assert.equal(repeated.resolved.length, 1, "snapshot refreshes do not duplicate the settled row")

  const ending = updateApprovalInboxMotion(track, [approval("ap-1", "approved", "Contact Echo")], 200 + APPROVAL_RESOLVE_SETTLE_MS - 1, {})
  assert.equal(ending.resolved.length, 1, "the settle holds for its window")

  const gone = updateApprovalInboxMotion(track, [approval("ap-1", "approved", "Contact Echo")], 200 + APPROVAL_RESOLVE_SETTLE_MS, {})
  assert.equal(gone.resolved.length, 0, "the settle ends instead of becoming a permanent history row")
  assert.equal(gone.active, false, "the settle clock stops")
})

test("ticket126: historical resolutions and archived pending rows do not settle", () => {
  const track = createApprovalInboxTrack()
  const historical = updateApprovalInboxMotion(track, [approval("ap-old", "approved")], 100, {})
  assert.equal(historical.resolved.length, 0, "pre-existing resolved approvals stay history")

  const pendingTrack = createApprovalInboxTrack()
  updateApprovalInboxMotion(pendingTrack, [approval("ap-1")], 100, {})
  const archived = updateApprovalInboxMotion(pendingTrack, [], 200, {})
  assert.equal(archived.resolved.length, 0, "a row removed without resolving does not settle as resolved")
})

test("ticket126: the resolved settle tone is one-shot and reduced motion mounts the final tone", () => {
  assert.equal(approvalResolvedTone(0, {}), "good", "resolution starts with the confirmation tone")
  assert.equal(approvalResolvedTone(APPROVAL_RESOLVE_EMPHASIS_MS - 1, {}), "good", "the confirmation holds briefly")
  assert.equal(approvalResolvedTone(APPROVAL_RESOLVE_EMPHASIS_MS, {}), "muted", "the row settles to the quiet tone")
  assert.equal(approvalResolvedTone(APPROVAL_RESOLVE_SETTLE_MS, {}), "muted", "the tone never moves again")
  assert.equal(approvalResolvedTone(0, { ENSEMBLE_REDUCED_MOTION: "1" }), "muted", "reduced motion mounts the final tone")
})
