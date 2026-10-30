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

export function assistantResult(messages: any[], since: number): { text: string; tools: string[]; failure?: any } {
  const texts: string[] = []
  const tools: string[] = []
  let failure: any
  for (const message of messages) {
    if (!message || message.time?.created < since) continue
    if (message.type === "idle" && message.outcome === "failed") failure = message.error
    if (message.type !== "assistant" || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part?.type === "text" && part.text) texts.push(part.text)
      if (part?.type === "tool") tools.push(`${part.name}:${part.state?.status ?? "unknown"}`)
    }
  }
  return { text: texts.join("\n").trim(), tools, failure }
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

export function promptForTask(task: Subtask): string {
  if (task.stage === "synthesis") {
    return `Synthesize the completed subtasks into one clear answer for the user.\n\nOriginal request: ${task.instruction}`
  }
  return [task.instruction, task.constraints ? `Constraints: ${task.constraints}` : "", task.expected ? `Expected: ${task.expected}` : ""].filter(Boolean).join("\n\n")
}

export function contextForTask(state: SnapshotState, task: Subtask, workspace: Workspace, agent: Agent): string {
  const memories = visibleMemories(state, agent.id, workspace.id)
  const recent = (state.messages[workspace.id] ?? []).slice(-20).map((message) => `${message.author === "user" ? "You" : state.agents[message.agentID ?? ""]?.name ?? "Agent"}: ${message.text}`).join("\n")
  const children = Object.values(state.subtasks).filter((item) => item.parentID === task.id)
  const childResults = task.stage === "synthesis"
    ? children.map((child) => `- ${state.agents[child.assigneeID ?? ""]?.name ?? "Agent"}: ${state.messages[workspace.id]?.find((message) => message.id === child.resultMessageID)?.text ?? child.error ?? "(no reply)"}`).join("\n")
    : ""
  return [
    `<ensemble_persona name="${agent.name}">\n${agent.role}\n</ensemble_persona>`,
    memoryContext(memories),
    `<ensemble_workspace name="${workspace.name}" directory="${workspace.directory}">`,
    `Leader: ${state.agents[workspace.leaderID]?.name ?? workspace.leaderID}`,
    `Members: ${workspace.memberIDs.map((memberID) => state.agents[memberID]?.name ?? memberID).join(", ")}`,
    "Recent group messages:",
    recent || "(none)",
    "</ensemble_workspace>",
    `<ensemble_subtask title="${task.title}">\n${task.instruction}\n</ensemble_subtask>`,
    childResults ? `<ensemble_child_results>\n${childResults}\n</ensemble_child_results>` : "",
  ].filter(Boolean).join("\n\n")
}
