import { homedir } from "node:os"
import type { Agent, Message, SnapshotState, Subtask, Workspace } from "../types.ts"

export function short(value: string, width = 60): string {
  const single = value.replaceAll("\n", " ")
  return single.length > width ? `${single.slice(0, width - 1)}…` : single
}

export function agentName(state: SnapshotState | null, agentID?: string): string {
  if (!agentID) return "Unassigned"
  return state?.agents[agentID]?.name ?? "Unknown agent"
}

export function workspaceLabel(directory: string): string {
  const home = homedir()
  return directory.startsWith(home) ? `~${directory.slice(home.length)}` : directory
}

export function workspaceGroupLabel(directory: string): string {
  const parts = workspaceLabel(directory).split("/").filter(Boolean)
  const label = parts.slice(-2).join("/")
  return label.length > 30 ? `…/${label.slice(-28)}` : label
}

export function unreadCount(state: SnapshotState | null, workspace: Workspace): number {
  const messages = state?.messages[workspace.id] ?? []
  return messages.filter((message) => message.createdAt > workspace.lastActiveAt && message.author !== "user").length
}

export function busyCount(state: SnapshotState | null, workspaceID: string): number {
  return Object.values(state?.subtasks ?? {}).filter((task) => task.workspaceID === workspaceID && task.state === "working").length
}

export function missingSkills(agent: Agent, catalog: Array<{ id: string }>): string[] {
  const available = new Set(catalog.map((skill) => skill.id))
  return agent.skillbox.filter((skill) => !available.has(skill))
}

export function isWorkingTask(state: SnapshotState | null, agentID: string, workspaceID?: string): boolean {
  return Object.values(state?.subtasks ?? {}).some(
    (task) => task.assigneeID === agentID && task.state === "working" && (!workspaceID || task.workspaceID === workspaceID),
  )
}

export function resultForTask(state: SnapshotState | null, task: Subtask): Message | undefined {
  if (!task.resultMessageID) return undefined
  return (state?.messages[task.workspaceID] ?? []).find((message) => message.id === task.resultMessageID)
}
