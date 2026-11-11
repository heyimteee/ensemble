import { collectBranchResults, formatBranchDigest } from "./branch-digest.ts"
import { dispatchBudgetContext, dispatchBudgetState, dispatchDepthFor } from "./dispatch-budget.ts"
import { ensembleTurnContext } from "./turn-context.ts"
import type { Agent, Memory, SnapshotState, Subtask, Workspace } from "./types.ts"

export function skillPermissions(skillbox: string[]): Array<{ action: string; resource: string; effect: "allow" | "deny" }> {
  return [
    { action: "skill", resource: "*", effect: "deny" },
    ...skillbox.map((skill) => ({ action: "skill" as const, resource: skill, effect: "allow" as const })),
  ]
}

export function availabilityFailure(error: any): boolean {
  if (!error) return false
  const type = String(error.type ?? "")
  const message = String(error.message ?? "").toLowerCase()
  return type.startsWith("provider.") && /rate|limit|quota|unavailable|overload|timeout|network|no-route|connection|model|outage|internal|server|500|502|503|504/.test(message) || type === "provider.internal" || type === "provider.no-route"
}

export function anyToolCall(messages: any[], since: number): boolean {
  return messages.some(
    (message) =>
      message?.type === "assistant" &&
      message?.time?.created >= since &&
      Array.isArray(message.content) &&
      message.content.some((part: any) => part?.type === "tool"),
  )
}

export type ToolOutcome = {
  name: string
  status: string
  error?: string
  code?: string
}

export const REPLY_COMPLETED = "Reply completed."
export const REPLY_INTERRUPTED = "Reply interrupted."
export const REPLY_INTERRUPTED_BEFORE_COMPLETION = "Reply interrupted before completion."

/** Internal stream-settlement text (ticket #149). These strings exist only to
 * keep an interrupted row from rendering blank; they are never a successful
 * answer and must never be stored as `resultMessageID`.
 */
export const FALLBACK_REPLIES: ReadonlySet<string> = new Set([
  REPLY_COMPLETED,
  REPLY_INTERRUPTED,
  REPLY_INTERRUPTED_BEFORE_COMPLETION,
])

export function isFallbackReply(text: string | undefined | null): boolean {
  return typeof text === "string" && FALLBACK_REPLIES.has(text.trim())
}

export function assistantResult(messages: any[], since: number): { text: string; tools: string[]; toolOutcomes: ToolOutcome[]; failure?: any } {
  const texts: string[] = []
  const tools: string[] = []
  const toolOutcomes: ToolOutcome[] = []
  let failure: any
  for (const message of messages) {
    if (!message || message.time?.created < since) continue
    if (message.type === "idle" && message.outcome === "failed") failure = message.error
    if (message.type !== "assistant" || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part?.type === "text" && part.text) texts.push(part.text)
      if (part?.type !== "tool") continue
      const status = String(part.state?.status ?? "unknown")
      tools.push(`${part.name}:${status}`)
      const error = part.state?.error
      const errorMessage = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : undefined
      const errorCode = typeof error?.code === "string" ? error.code : undefined
      toolOutcomes.push({
        name: String(part.name ?? "tool"),
        status,
        ...(errorMessage ? { error: errorMessage } : {}),
        ...(errorCode ? { code: errorCode } : {}),
      })
    }
  }
  return { text: texts.join("\n").trim(), tools, toolOutcomes, failure }
}

export function visibleMemories(state: SnapshotState, agentID: string, workspaceID: string): Memory[] {
  return Object.values(state.memories)
    .filter((memory) => !memory.deletedAt)
    .filter((memory) => {
      if (memory.scope === "workspace") return memory.workspaceID === workspaceID
      if (memory.scope === "global") return memory.agentID === agentID
      return memory.agentID === agentID && memory.workspaceID === workspaceID
    })
    .sort((a, b) => a.createdAt - b.createdAt)
}

export function memoryContext(memories: Memory[]): string {
  if (memories.length === 0) return ""
  return ["<ensemble_memory>", ...memories.map((memory) => `- [${memory.scope}] ${memory.text}`), "</ensemble_memory>"].join("\n")
}

export function promptForTask(task: Subtask, senderName?: string): string {
  if (task.stage === "synthesis") {
    // Ticket #249: the root synthesis is terminal, so it answers the original
    // request in one group message instead of retelling the branch history.
    return `Synthesize the completed branches into one concise group summary for the user. Answer the original request, name the workers who contributed, and note anything still open; do not retell each hop. Mentions are references here: $Name names a worker and starts no new work.\n\nOriginal request: ${task.instruction}`
  }
  const body = [task.instruction, task.constraints ? `Constraints: ${task.constraints}` : "", task.expected ? `Expected: ${task.expected}` : ""].filter(Boolean).join("\n\n")
  const triageSkills = task.skillGrants ?? []
  const oneTriage = triageSkills.length === 1
  const triagePronoun = oneTriage ? "it" : "them"
  const triage = triageSkills.length > 0
    ? `\n\nLeader triage: this turn invoked General skill${oneTriage ? "" : "s"} ${triageSkills.map((skill) => `/${skill}`).join(", ")}. You have a one-run native skill grant for ${triagePronoun}. Read ${triagePronoun} with the native skill tool, then use ${triagePronoun} yourself if ${oneTriage ? "it fits" : "they fit"}, or delegate with a self-authored instruction. A delegatee receives your guidance, not a host skill grant.`
    : ""
  if (task.workKind === "handoff" && senderName) {
    const ref = task.handoff?.correlationID ? ` (ref ${task.handoff.correlationID})` : ""
    return `$${senderName} has asked you to help with this${ref}.\n\n${body}${triage}\n\nAnswer in this conversation as yourself.`
  }
  if (task.workKind === "turn" && task.turn) {
    const asker = senderName ? `$${senderName}` : "the group chat"
    const ref = ` (ref ${task.turn.correlationID})`
    return `${asker} asked in the group chat${ref}:\n\n${body}${triage}\n\nAnswer in this conversation as yourself.`
  }
  return `${body}${triage}`
}

/** The bounded recent group transcript injected into a delegated prompt. */
export function recentGroupMessages(state: SnapshotState, workspace: Workspace, limit = 20): string {
  return (state.messages[workspace.id] ?? [])
    .slice(-Math.max(0, limit))
    .map((message) => `${message.author === "user" ? "You" : state.agents[message.agentID ?? ""]?.name ?? "Agent"}: ${message.text}`)
    .join("\n")
}

export function contextForTask(state: SnapshotState, task: Subtask, workspace: Workspace, agent: Agent): string {
  const memories = visibleMemories(state, agent.id, workspace.id)
  const synthesis = task.stage === "synthesis"
  // Ticket #249: a synthesis turn is terminal and summarizes the whole command.
  // It gets the original request plus the bounded branch digest, never the
  // last-20 transcript that grows with every hop. Worker turns keep it.
  const recent = synthesis ? "" : recentGroupMessages(state, workspace)
  // Ticket #246: only the command root synthesizes, so its context carries a
  // bounded digest of terminal leaves (worker path + final result), never an
  // intermediate parent's own reply.
  const branchResults = synthesis
    ? formatBranchDigest(
        collectBranchResults({
          rootID: task.id,
          subtasks: state.subtasks,
          messages: state.messages[workspace.id] ?? [],
        }),
        state.agents,
      )
    : ""
  const dispatchGroup = task.dispatchGroupID ? state.dispatchGroups[task.dispatchGroupID] : undefined
  const dispatchBudget = dispatchGroup
    ? dispatchBudgetContext(
        dispatchBudgetState({
          group: dispatchGroup,
          groups: state.dispatchGroups,
          task,
          subtasks: state.subtasks,
          nextDepth: task.dispatchDepth ?? dispatchDepthFor(task, state.subtasks),
        }),
        task,
      )
    : ""
  return [
    ensembleTurnContext({
      agent,
      conversation: { kind: "workspace", workspaceID: workspace.id },
      workspace,
      agents: state.agents,
      // Ticket #248 makes a synthesis turn terminal; its mentions are
      // references, so the turn block says so instead of advertising routes.
      routing: !synthesis,
    }),
    memoryContext(memories),
    dispatchBudget,
    task.workKind === "handoff" && task.handoff
      ? `<ensemble_handoff from="${state.agents[task.handoff.senderID]?.name ?? task.handoff.senderID}" ref="${task.handoff.correlationID}" depth="${task.handoff.depth}">\nThis turn is a handoff hop. Answer in this conversation as yourself; the reply is relayed to the asking conversation.\n</ensemble_handoff>`
      : "",
    task.workKind === "turn" && task.turn
      ? `<ensemble_peer_turn ref="${task.turn.correlationID}">\nThis turn is a group-chat peer turn. Answer in this conversation as yourself; the reply lands in the asking transcript, attributed to you.\n</ensemble_peer_turn>`
      : "",
    // Ticket #225 removed the read-only roster tools, not the group context.
    // Keep the bounded last-20 transcript alongside the compact roster so a
    // delegated worker still knows what the chat just said. Ticket #249 gives
    // synthesis the root request instead; it never needs the hop history.
    synthesis
      ? `<ensemble_root_request>\n${task.instruction}\n</ensemble_root_request>`
      : `<ensemble_recent_messages>\n${recent || "(none)"}\n</ensemble_recent_messages>`,
    synthesis ? "" : `<ensemble_subtask title="${task.title}">\n${task.instruction}\n</ensemble_subtask>`,
    branchResults ? `<ensemble_branch_results>\n${branchResults}\n</ensemble_branch_results>` : "",
  ].filter(Boolean).join("\n\n")
}
