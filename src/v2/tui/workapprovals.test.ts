import test from "node:test"
import assert from "node:assert/strict"
import type { Approval } from "../types.ts"
import { chromeJoin } from "./separators.ts"
import {
  approvalsColumnMode,
  approvalsForWorkspace,
  approvalsPaneLayout,
  closeFullApprovals,
  fullApprovalsHeader,
  openFullApprovals,
  workApprovalLimit,
  workApprovalSection,
  workApprovalsHeader,
} from "./workapprovals.ts"
import { workPaneBodyHeight, workspacePaneWidths } from "./workpane.ts"

const approval = (index: number, patch: Partial<Approval> = {}): Approval => ({
  id: `ap-${index}`,
  kind: "ask_person",
  title: `Approval ${index}`,
  detail: `Detail ${index}`,
  status: "pending",
  createdAt: index,
  ...patch,
})

test("ticket173: the inline approvals list stays bounded by the pane body", () => {
  assert.equal(workApprovalLimit(2), 1)
  assert.equal(workApprovalLimit(4), 3)
  assert.equal(workApprovalLimit(20), 3)
  assert.equal(workApprovalLimit(0), 1)
})

test("ticket173: the sticky section shows pending rows and counts its overflow", () => {
  const approvals = [approval(0), approval(1), approval(2), approval(3), approval(4)]
  const section = workApprovalSection(approvals, 0, 3)
  assert.equal(section.total, 5)
  assert.deepEqual(section.rows.map((row) => [row.index, row.approval.id]), [[0, "ap-0"], [1, "ap-1"], [2, "ap-2"]])
  assert.equal(section.overflow, 2)
  assert.equal(section.cursor, 0)
  assert.equal(section.rows.some((row) => row.index === section.cursor), true)
})

test("ticket173: the window follows the cursor so a focused approval stays visible", () => {
  const approvals = [approval(0), approval(1), approval(2), approval(3), approval(4)]
  const section = workApprovalSection(approvals, 4, 3)
  assert.deepEqual(section.rows.map((row) => row.index), [2, 3, 4])
  assert.equal(section.overflow, 2)
  assert.equal(section.rows.at(-1)?.index, 4)
  const middle = workApprovalSection(approvals, 2, 3)
  assert.deepEqual(middle.rows.map((row) => row.index), [1, 2, 3])
})

test("ticket173: an empty approvals section advertises nothing", () => {
  const section = workApprovalSection([], 0, 3)
  assert.equal(section.total, 0)
  assert.deepEqual(section.rows, [])
  assert.equal(section.overflow, 0)
  assert.equal(section.cursor, undefined)
})

test("ticket185: the small approvals summary names the count, the +N more overflow, and the open key", () => {
  const compact = workApprovalSection([approval(0), approval(1)], 0, 3)
  assert.equal(workApprovalsHeader(compact, false), chromeJoin(["APPROVALS 2 pending", "v open"]))
  assert.equal(workApprovalsHeader(compact, true), chromeJoin(["APPROVALS 2 pending", "enter open"]))

  const overflow = workApprovalSection([approval(0), approval(1), approval(2), approval(3)], 0, 3)
  assert.equal(workApprovalsHeader(overflow, false), chromeJoin(["APPROVALS 4 pending", "+1 more", "v open"]))
  assert.equal(workApprovalsHeader(overflow, true), chromeJoin(["APPROVALS 4 pending", "+1 more", "enter open"]))
})

test("ticket185: approvals stay scoped to the visible workspace", () => {
  const rows = {
    one: approval(0, { workspaceID: "w1" }),
    two: approval(1, { workspaceID: "w2" }),
    unscoped: approval(2),
  }
  assert.deepEqual(approvalsForWorkspace(rows, "w1").map((row) => row.id), ["ap-0"])
  assert.deepEqual(approvalsForWorkspace(rows, "w2").map((row) => row.id), ["ap-1"])
  assert.deepEqual(approvalsForWorkspace(rows, undefined).map((row) => row.id), ["ap-2"], "no workspace shows only unattributed rows")
})

test("ticket185: the right column is closed, split, or full", () => {
  assert.equal(approvalsColumnMode({ full: false }, false), "closed")
  assert.equal(approvalsColumnMode({ full: true }, false), "closed")
  assert.equal(approvalsColumnMode({ full: false }, true), "split")
  assert.equal(approvalsColumnMode({ full: true }, true), "full")
})

test("ticket185: v opens full, Esc returns to split, and closing the column hides approvals", () => {
  const full = openFullApprovals({ full: false })
  assert.equal(approvalsColumnMode(full, true), "full")
  const split = closeFullApprovals(full)
  assert.equal(approvalsColumnMode(split, true), "split", "Esc lands back in split mode")
  assert.equal(approvalsColumnMode(split, false), "closed", "closing the right pane hides approvals")
})

test("ticket185: split reserves a small approvals window while full replaces Work", () => {
  const split = approvalsPaneLayout("split", 10, 5)
  assert.equal(split.approvalRows, 3)
  assert.ok(split.workBodyHeight > 0, "split keeps a Work body above the small pane")
  assert.ok(split.workBodyHeight < 10, "the small pane reserves rows from Work")

  const full = approvalsPaneLayout("full", 10, 5)
  assert.equal(full.workBodyHeight, 0, "full approvals hide Work")
  assert.ok(full.approvalRows > split.approvalRows, "full shows more of the inbox")
  assert.equal(approvalsPaneLayout("split", 10, 0).approvalRows, 0, "an empty list has no small pane")
  assert.equal(approvalsPaneLayout("split", 10, 0).workBodyHeight, 10, "Work reclaims the body when nothing is pending")
})

test("ticket185: full approvals fills the 80-column right drawer", () => {
  const widths = workspacePaneWidths(80)
  assert.equal(widths.mode, "drawer")
  assert.ok(widths.workWidth >= 30, "the drawer remains wide enough for approval rows")
  const layout = approvalsPaneLayout("full", workPaneBodyHeight(24), 5)
  assert.equal(layout.workBodyHeight, 0)
  assert.ok(layout.approvalRows >= 2, "the drawer body still shows approval rows")
})

test("ticket185: the full inbox header teaches resolve and returns to split", () => {
  const section = workApprovalSection([approval(0), approval(1), approval(2), approval(3)], 1, 4)
  assert.equal(
    fullApprovalsHeader(section),
    chromeJoin(["APPROVALS 4 pending", "2/4", "j/k move", "enter resolve", "esc split"]),
  )
})
