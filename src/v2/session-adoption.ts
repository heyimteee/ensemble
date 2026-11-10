import type { BindingConversation, Id } from "./types.ts"
import { normalizeSessionDirectory } from "./session-picker.ts"

/**
 * Ticket #224: adoption is the only explicit way to bind an existing native
 * session to a conversation (ADR 0009, decision 5). The rules are pure so the
 * refusals, move confirmation, and reassignment decision are testable without
 * a host. The service performs the host calls and writes the binding only
 * after every check passes.
 */
export type AdoptionConversationKind = "workspace" | "direct" | "home"

export type AdoptionTarget = {
  kind: AdoptionConversationKind
  agentID: Id
  workspaceID?: Id
}

export type AdoptionTargetInput = {
  agentID: Id
  workspaceID?: Id | null
  conversation?: unknown
  /** True when the agent currently belongs to the requested workspace. */
  workspaceMember?: boolean
}

export type AdoptionTargetResolution =
  | { ok: true; target: AdoptionTarget; conversation: BindingConversation }
  | { ok: false; code: "invalid_conversation" | "workspace_required" | "agent_not_member"; message: string }

/**
 * The target is always an agent's conversation, never a bare session. A direct
 * conversation in an active workspace keeps workspace file access; an agent
 * outside the workspace (or with no workspace) adopts into home direct.
 */
export function resolveAdoptionTarget(input: AdoptionTargetInput): AdoptionTargetResolution {
  const agentID = String(input.agentID ?? "").trim()
  if (!agentID) return { ok: false, code: "invalid_conversation", message: "Choose an agent first." }
  const requestedWorkspace = input.workspaceID === undefined || input.workspaceID === null
    ? ""
    : String(input.workspaceID).trim()
  const workspaceID = requestedWorkspace && requestedWorkspace !== "home" ? requestedWorkspace : undefined
  const member = Boolean(workspaceID && input.workspaceMember)

  if (input.conversation === "workspace") {
    if (!workspaceID) return { ok: false, code: "workspace_required", message: "A workspace group conversation requires a workspace." }
    if (!member) return { ok: false, code: "agent_not_member", message: "The agent is not a member of that workspace." }
    const target: AdoptionTarget = { kind: "workspace", workspaceID, agentID }
    return { ok: true, target, conversation: { kind: "workspace", workspaceID, agentID } }
  }
  if (input.conversation === "direct" || input.conversation === undefined || input.conversation === null) {
    if (workspaceID && member) {
      const target: AdoptionTarget = { kind: "direct", workspaceID, agentID }
      return { ok: true, target, conversation: { kind: "direct", workspaceID, agentID } }
    }
    const target: AdoptionTarget = { kind: "home", agentID }
    return { ok: true, target, conversation: { kind: "home", agentID } }
  }
  if (input.conversation === "home") {
    const target: AdoptionTarget = { kind: "home", agentID }
    return { ok: true, target, conversation: { kind: "home", agentID } }
  }
  return { ok: false, code: "invalid_conversation", message: "Unknown conversation target." }
}

/** Where the adopted session must live for this conversation. */
export function adoptionTargetDirectory(
  target: AdoptionTarget,
  directories: { workspaceDirectory?: string; homeDirectory?: string },
): string | undefined {
  const directory = target.kind === "home" ? directories.homeDirectory : directories.workspaceDirectory
  return normalizeSessionDirectory(directory)
}

export type AdoptionSessionState = {
  sessionID: string
  found: boolean
  archived?: boolean
  /** A subagent child session is not a conversation root. */
  parentID?: string | null
  directory?: string
  /** Host-reported or service-known busy state. */
  busy?: boolean
}

export type AdoptionBindingOwner = {
  agentID: Id
  conversation: BindingConversation
}

export type AdoptionBlocker =
  | "missing"
  | "archived"
  | "child"
  | "busy"
  | "bound_elsewhere"
  | "move_confirmation"

export type AdoptionPlan = {
  target: AdoptionTarget
  sessionID: string
  moveRequired: boolean
  moveFrom?: string
  moveTo?: string
  needsReassign: boolean
  blockers: AdoptionBlocker[]
  /** A hard blocker (missing/archived/child/busy) refuses adoption outright. */
  rejected: boolean
  /** True when the caller still has to confirm a move or a reassignment. */
  confirmationRequired: boolean
  /** True when the session is already the target conversation's session. */
  unchanged: boolean
  canAdopt: boolean
}

export type AdoptionPlanInput = {
  target: AdoptionTarget
  session: AdoptionSessionState
  /** The conversation's directory; a move is required when they differ. */
  targetDirectory?: string
  currentSessionID?: string
  /** A current binding owned by another conversation. */
  boundElsewhere?: AdoptionBindingOwner
  /** Explicit reassignment confirmation from the user. */
  reassign?: boolean
  /** Explicit directory-move confirmation from the user. */
  confirmMove?: boolean
}

export function sessionMoveRequired(from: string | undefined, to: string | undefined): boolean {
  const left = normalizeSessionDirectory(from)
  const right = normalizeSessionDirectory(to)
  if (!right) return false
  return left === undefined || left !== right
}

/** A move is applied only when the host reports the target location. */
export function sessionMoveConfirmed(reportedDirectory: string | undefined, targetDirectory: string | undefined): boolean {
  const reported = normalizeSessionDirectory(reportedDirectory)
  const target = normalizeSessionDirectory(targetDirectory)
  return reported !== undefined && target !== undefined && reported === target
}

export function planSessionAdoption(input: AdoptionPlanInput): AdoptionPlan {
  const session = input.session
  const blockers: AdoptionBlocker[] = []
  if (!session.found) blockers.push("missing")
  if (session.archived) blockers.push("archived")
  if (session.parentID) blockers.push("child")
  if (session.busy) blockers.push("busy")
  const needsReassign = Boolean(input.boundElsewhere)
  if (needsReassign && !input.reassign) blockers.push("bound_elsewhere")
  const moveRequired = sessionMoveRequired(session.directory, input.targetDirectory)
  if (moveRequired && !input.confirmMove) blockers.push("move_confirmation")
  // A busy session is refused even when no move is needed: the host queues a
  // move for a busy session, and adoption must never split or delay work.
  const hardRejected = blockers.some((blocker) => blocker === "missing" || blocker === "archived" || blocker === "child" || blocker === "busy")
  const unchanged = session.found && input.currentSessionID !== undefined && input.currentSessionID === session.sessionID
  const confirmationRequired = needsReassign || moveRequired
  return {
    target: input.target,
    sessionID: session.sessionID,
    moveRequired,
    ...(session.directory ? { moveFrom: session.directory } : {}),
    ...(input.targetDirectory ? { moveTo: input.targetDirectory } : {}),
    needsReassign,
    blockers,
    rejected: hardRejected,
    confirmationRequired,
    unchanged,
    canAdopt: !hardRejected && !unchanged && (!needsReassign || Boolean(input.reassign)) && (!moveRequired || Boolean(input.confirmMove)),
  }
}

/** The refusal code the service reports for the first hard blocker. */
export function adoptionBlockerCode(plan: AdoptionPlan): string | undefined {
  if (plan.rejected) {
    if (plan.blockers.includes("missing")) return "session_not_found"
    if (plan.blockers.includes("archived")) return "session_archived"
    if (plan.blockers.includes("child")) return "session_child"
    if (plan.blockers.includes("busy")) return "session_busy"
  }
  if (plan.blockers.includes("bound_elsewhere")) return "session_already_bound"
  if (plan.blockers.includes("move_confirmation")) return "move_confirmation_required"
  return undefined
}

export type AdoptionConversationNames = {
  agentName: string
  workspaceName?: string
}

/** The human conversation name used in confirmations and the native heads-up. */
export function adoptionConversationName(target: AdoptionTarget, names: AdoptionConversationNames): string {
  const agent = names.agentName.trim() || target.agentID
  const workspace = (names.workspaceName ?? "").trim()
  if (target.kind === "workspace") {
    return workspace ? `#${workspace} group chat` : "workspace group chat"
  }
  if (target.kind === "direct") {
    return workspace ? `#${workspace} direct conversation with ${agent}` : `direct conversation with ${agent}`
  }
  return `home direct conversation with ${agent}`
}

/**
 * The visible native heads-up after adoption. It names the Ensemble
 * conversation and nothing else: no directory, prompt, credential, or
 * transcript content.
 */
export function adoptionHeadsUp(target: AdoptionTarget, names: AdoptionConversationNames): string {
  const conversation = adoptionConversationName(target, names)
  return `Ensemble: this native session now serves the ${conversation}. Ensemble will keep its messages on that conversation's transcript.`
}
