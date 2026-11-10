import type { DispatchBudgetState } from "./dispatch-budget.ts"
import type { Agent, BindingKind, Id, Workspace } from "./types.ts"

/**
 * Ticket #225: the compact per-turn replacement for the read-only roster
 * tools. It carries only identity, conversation scope, roster names, routing
 * rules, and counts. Message text, task content, and absolute file detail stay
 * out of the block.
 */
export type TurnContextConversation = {
  kind: BindingKind
  workspaceID?: Id
}

export type TurnContextInput = {
  agent: Pick<Agent, "id" | "name"> & { role?: string }
  conversation: TurnContextConversation
  workspace?: Pick<Workspace, "id" | "name" | "directory" | "leaderID" | "memberIDs">
  agents: Record<Id, Pick<Agent, "id" | "name" | "archived">>
  routing?: boolean
  budget?: DispatchBudgetState
}

function budgetLine(budget: DispatchBudgetState): string {
  const group = `group ${budget.groupUsed}/${budget.groupMax} (${budget.groupRemaining} left)`
  const command = budget.commandUsed !== undefined && budget.commandMax !== undefined
    ? `command ${budget.commandUsed}/${budget.commandMax}${budget.commandRemaining !== undefined ? ` (${budget.commandRemaining} left)` : ""}`
    : "command untracked"
  const task = budget.taskMax === undefined || budget.taskRemaining === undefined
    ? `task ${budget.taskUsed} used (unlimited)`
    : `task ${budget.taskUsed}/${budget.taskMax} (${budget.taskRemaining} left)`
  return `Budget: ${group} · ${command} · ${task} · depth ${budget.depth}/${budget.depthMax}.`
}

function attribute(name: string, value: string | undefined): string {
  return value === undefined ? "" : ` ${name}="${value.replaceAll("\"", "'")}"`
}

/**
 * Render one compact turn block. A workspace group gets leader, members,
 * routing rules, and the budget; a direct conversation gets only its scope and
 * the one-to-one rule. Names are roster names, never message content.
 */
export function ensembleTurnContext(input: TurnContextInput): string {
  const workspace = input.workspace
  const conversation = input.conversation.kind === "workspace"
    ? "group"
    : input.conversation.kind === "direct"
      ? "direct"
      : "home"
  const leader = workspace ? input.agents[workspace.leaderID]?.name ?? workspace.leaderID : undefined
  const members = workspace
    ? workspace.memberIDs
        .map((memberID) => input.agents[memberID])
        .filter((agent): agent is Pick<Agent, "id" | "name" | "archived"> => Boolean(agent) && !agent!.archived)
        .map((agent) => agent.name)
    : []
  const lines = [
    `<ensemble_turn${attribute("agent", input.agent.name)}${attribute("conversation", conversation)}${attribute("workspace", workspace?.name)}${attribute("directory", workspace?.directory)}>`,
  ]
  if (workspace && conversation === "group") {
    lines.push(`Leader: ${leader ?? "unknown"}`)
    lines.push(`Members: ${members.length > 0 ? members.join(", ") : "(none)"}`)
    if (input.budget) lines.push(budgetLine(input.budget))
    lines.push(
      input.routing === false
        ? "Routing is off: `$Name` is a reference; the message still posts and no work is created."
        : "Final text is the group message. `$Name` asks a member; `@path` is file-only; code, URLs, and paths do not route.",
    )
  } else if (conversation === "direct") {
    lines.push(`Conversation: direct · ${workspace?.name ?? "workspace"}`)
    lines.push("Routing: one-to-one. `$Name` does not create work; direct chats stay private.")
  } else {
    lines.push("Conversation: home direct")
    lines.push("Routing: one-to-one. `$Name` does not create work; there is no workspace roster here.")
  }
  lines.push("</ensemble_turn>")
  return lines.join("\n")
}

/** Character count for the prompt-size benchmark and regression test. */
export function turnContextSize(context: string): number {
  return context.length
}
