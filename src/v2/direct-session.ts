import type { BindingConversation, Id, NativeFirstMode } from "./types.ts"

/**
 * Ticket #214: direct chat owns its own native session once native-first is
 * `on`. `off` keeps the pre-#214 selection and `shadow` keeps the visible path
 * unchanged while ingestion is compared, so rolling back is a settings change
 * rather than a code revert (ADR 0009, ADR 0011).
 */
export function directSessionCutover(mode: NativeFirstMode): boolean {
  return mode === "on"
}

export type DirectSessionSelectionInput = {
  agentID: Id
  workspaceID?: Id
  /** True when the agent is currently a member of the requested workspace. */
  workspaceMember?: boolean
  mode: NativeFirstMode
}

/**
 * The one conversation a direct chat resolves for this request.
 *
 * - `on` and a workspace member: the workspace-direct conversation, bound to
 *   the workspace directory but distinct from the group session.
 * - `off`/`shadow` and a workspace member: the pre-#214 group conversation.
 * - No active membership (or a stale workspace id): the home-direct
 *   conversation. Membership never retargets or deletes another session.
 */
export function selectDirectConversation(input: DirectSessionSelectionInput): BindingConversation {
  const agentID = String(input.agentID)
  const requested = input.workspaceID === undefined || input.workspaceID === null ? "" : String(input.workspaceID)
  const workspaceID = requested && requested !== "home" ? requested : undefined
  if (!workspaceID || !input.workspaceMember) return { kind: "home", agentID }
  return directSessionCutover(input.mode)
    ? { kind: "direct", workspaceID, agentID }
    : { kind: "workspace", workspaceID, agentID }
}
