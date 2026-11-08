import test from "node:test"
import assert from "node:assert/strict"
import type { Approval } from "../types.ts"
import { chromeJoin } from "./separators.ts"
import { workApprovalLimit, workApprovalSection, workApprovalsHeader } from "./workapprovals.ts"

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

test("ticket173: the approvals header names the count, overflow, and the V-only inbox", () => {
  const compact = workApprovalSection([approval(0), approval(1)], 0, 3)
  assert.equal(workApprovalsHeader(compact, false), chromeJoin(["APPROVALS 2 pending", "v focus"]))
  assert.equal(workApprovalsHeader(compact, true), chromeJoin(["APPROVALS 2 pending", "j/k select", "enter resolve", "esc work"]))

  const overflow = workApprovalSection([approval(0), approval(1), approval(2), approval(3)], 0, 3)
  assert.equal(workApprovalsHeader(overflow, false), chromeJoin(["APPROVALS 4 pending", "1 more", "V inbox", "v focus"]))
  assert.equal(workApprovalsHeader(overflow, true), chromeJoin(["APPROVALS 4 pending", "1 more", "V inbox", "j/k select", "enter resolve", "esc work"]))
})
