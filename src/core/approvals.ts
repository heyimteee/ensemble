import type { Approval, ApprovalKind, EnsembleState } from "./types.ts"
import { newId, now } from "./ids.ts"

export function createApproval(
  state: EnsembleState,
  input: {
    kind: ApprovalKind
    title: string
    detail: string
    channelID?: string
    agentID?: string
    workID?: string
    handoffID?: string
    memoryID?: string
  },
): Approval {
  const approval: Approval = {
    id: newId("appr"),
    ...input,
    status: "pending",
    createdAt: now(),
  }
  state.approvals[approval.id] = approval
  return approval
}

export function pendingApprovals(state: EnsembleState): Approval[] {
  return Object.values(state.approvals)
    .filter((approval) => approval.status === "pending")
    .sort((a, b) => a.createdAt - b.createdAt)
}

export function resolveApproval(state: EnsembleState, approvalID: string, status: "approved" | "rejected", resolution?: string): Approval | undefined {
  const approval = state.approvals[approvalID]
  if (!approval || approval.status !== "pending") return undefined
  approval.status = status
  approval.resolvedAt = now()
  approval.resolution = resolution
  return approval
}
