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

export function markdownText(value: string): string {
  return value
    .replace(/```[\w-]*\n?/g, "\n")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
}

export function wrapText(value: string, width: number, maxLines = 6): string[] {
  const words = markdownText(value).replaceAll("\n", " ").split(/\s+/).filter(Boolean)
  if (words.length === 0) return [""]
  const lines: string[] = []
  let line = ""
  for (const word of words) {
    if (!line) {
      line = word
      continue
    }
    if (line.length + 1 + word.length <= width) {
      line += ` ${word}`
    } else {
      lines.push(line)
      line = word
      if (lines.length === maxLines) break
    }
  }
  if (lines.length < maxLines && line) lines.push(line)
  if (lines.length === maxLines) {
    const joined = lines.join(" ")
    if (joined.length < value.length) lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, Math.max(0, width - 1))}…`
  }
  return lines
}


const namedColors: Record<string, string> = {
  cyan: "#8be9fd",
  magenta: "#ff79c6",
  pink: "#ff79c6",
  green: "#50fa7b",
  yellow: "#f1fa8c",
  red: "#ff5555",
  blue: "#6272a4",
  purple: "#bd93f9",
  orange: "#ffb86c",
}

export function agentColor(agent: Agent | undefined, fallback: string): string {
  if (!agent) return fallback
  if (/^#[0-9a-f]{6}$/i.test(agent.color)) return agent.color
  return namedColors[agent.color.toLowerCase()] ?? fallback
}

export function fuzzyMatch(query: string, text: string): boolean {
  const needle = query.toLowerCase()
  if (!needle) return true
  const haystack = text.toLowerCase()
  let position = 0
  for (const character of needle) {
    position = haystack.indexOf(character, position)
    if (position < 0) return false
    position++
  }
  return true
}

export function ageLabel(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
}

export function renderMarkdownLines(value: string, width: number): string[] {
  const raw = value.replace(/\r\n/g, "\n").split("\n")
  const output: string[] = []
  let inCode = false
  for (let index = 0; index < raw.length; index++) {
    let line = raw[index]
    if (line.trimStart().startsWith("```")) {
      inCode = !inCode
      continue
    }
    if (inCode) {
      output.push(...wrapLine(line || " ", width).map((part) => `  ${part}`))
      continue
    }
    if (/^\s*\|/.test(line) && index + 1 < raw.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(raw[index + 1])) {
      const rows: string[][] = []
      let cursor = index
      while (cursor < raw.length && /^\s*\|/.test(raw[cursor])) {
        rows.push(raw[cursor].trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()))
        cursor++
      }
      index = cursor - 1
      if (rows.length > 1) {
        const header = rows[0]
        const body = rows.slice(2)
        const widths = header.map((cell, column) => Math.max(cell.length, ...body.map((row) => (row[column] ?? "").length)))
        const format = (row: string[]) => row.map((cell, column) => (cell ?? "").padEnd(widths[column] ?? 0)).join(" │ ")
        output.push(...wrapLine(format(header), width), ...body.flatMap((row) => wrapLine(format(row), width)))
        continue
      }
    }
    line = line
      .replace(/^#{1,6}\s*/, "")
      .replace(/^(\s*)[-*]\s+/, "$1• ")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    output.push(...wrapLine(line || " ", width))
  }
  return output
}

function wrapLine(value: string, width: number): string[] {
  if (value.length <= width) return [value]
  const words = value.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ""
  for (const word of words) {
    if (!line) line = word
    else if (line.length + 1 + word.length <= width) line += ` ${word}`
    else { lines.push(line); line = word }
  }
  if (line) lines.push(line)
  return lines.length > 0 ? lines : [""]
}
