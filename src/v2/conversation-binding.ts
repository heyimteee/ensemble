import type { BindingConversation, Id, SessionBinding } from "./types.ts"

/**
 * Resolve the conversation a stored binding serves (ADR 0009). Pre-#213 rows
 * carry no `kind`: a `home` pseudo-workspace is the home direct conversation,
 * every other workspace is the workspace group conversation. A direct
 * conversation requires a real workspace; there is no direct binding at the
 * `home` pseudo-workspace.
 *
 * Returns undefined for a malformed row rather than guessing a conversation.
 */
export function bindingConversation(
  binding: Pick<SessionBinding, "workspaceID" | "agentID" | "kind">,
): BindingConversation | undefined {
  const workspaceID = String(binding.workspaceID ?? "")
  const agentID = String(binding.agentID ?? "")
  if (!agentID) return undefined
  if (binding.kind === "direct") {
    if (!workspaceID || workspaceID === "home") return undefined
    return { kind: "direct", workspaceID, agentID }
  }
  if (binding.kind === "home" || workspaceID === "home") return { kind: "home", agentID }
  if (binding.kind !== undefined && binding.kind !== "workspace") return undefined
  if (!workspaceID) return undefined
  return { kind: "workspace", workspaceID, agentID }
}

/**
 * The stable key for one agent's binding conversation. Workspace group and
 * home direct keys are the legacy `workspace:agent` keys, so existing
 * snapshots, patches, and clients keep their identity. A workspace direct
 * conversation adds its own `dm:agent:workspace` key.
 */
export function conversationStateKey(conversation: BindingConversation): string {
  switch (conversation.kind) {
    case "workspace":
      return `${conversation.workspaceID}:${conversation.agentID}`
    case "direct":
      return `dm:${conversation.agentID}:${conversation.workspaceID}`
    case "home":
      return `home:${conversation.agentID}`
  }
}

/** Binding state key, derived from the conversation the row represents. */
export function bindingStateKey(binding: SessionBinding): string {
  const conversation = bindingConversation(binding)
  if (!conversation) throw Object.assign(new Error("Binding does not identify a conversation."), { code: "invalid_binding" })
  return conversationStateKey(conversation)
}

/** True when the two conversations are the same agent's same channel. */
export function sameBindingConversation(a: BindingConversation, b: BindingConversation): boolean {
  return conversationStateKey(a) === conversationStateKey(b)
}

/** A stable, non-content diagnostic label. */
export function conversationKindLabel(conversation: BindingConversation): string {
  if (conversation.kind === "workspace") return `workspace:${conversation.workspaceID}`
  if (conversation.kind === "direct") return `dm:${conversation.workspaceID}`
  return "home"
}

export function bindingStateKeyFor(workspaceID: Id, agentID: Id, kind?: SessionBinding["kind"]): string {
  const conversation = bindingConversation({ workspaceID, agentID, kind })
  if (!conversation) throw Object.assign(new Error("Binding does not identify a conversation."), { code: "invalid_binding" })
  return conversationStateKey(conversation)
}
