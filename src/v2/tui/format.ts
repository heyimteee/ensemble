import { homedir } from "node:os"
import type { Agent, Message, SnapshotState, Subtask, Workspace } from "../types.ts"
import { chromeSeparator } from "./separators.ts"

export function short(value: string, width = 60): string {
  const single = value.replaceAll("\n", " ")
  return single.length > width ? `${single.slice(0, width - 1).trimEnd()}…` : single
}

/** One label/detail row for the aligned table grammar (ticket #174). */
export type AlignedDetailRow = { label: string; detail?: string }

export type AlignedDetailOptions = {
  /** Maximum label column; longer labels truncate with an ellipsis. */
  maxWidth?: number
  /** Separator between the padded label and the detail; chrome bar by default. */
  separator?: string
}

/**
 * Ticket #174: pad one label column across the visible rows and render
 * `label │ detail`. The separator therefore sits at exactly one column for
 * every visible row, regardless of label length. Labels longer than the
 * column truncate consistently; rows without a detail keep their label
 * unpadded. Pure, so the wizard and every other list row share one grammar.
 */
export function alignedDetailRows(rows: readonly AlignedDetailRow[], options: AlignedDetailOptions = {}): string[] {
  const separator = options.separator ?? chromeSeparator()
  const cap = options.maxWidth === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(options.maxWidth))
  // Only label/detail rows define the table. A plain row (a custom directory,
  // a manual step) is not part of the column and never widens or truncates it.
  const width = Math.min(cap, rows.reduce((longest, row) => (row.detail ?? "").trim() ? Math.max(longest, row.label.length) : longest, 0))
  return rows.map((row) => {
    const detail = (row.detail ?? "").trim()
    if (!detail) return row.label
    const label = truncateAlignedLabel(row.label, width)
    return `${label.padEnd(width)} ${separator} ${detail}`
  })
}

function truncateAlignedLabel(label: string, width: number): string {
  if (label.length <= width) return label
  if (width <= 0) return ""
  if (width === 1) return "…"
  return `${label.slice(0, width - 1)}…`
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

export function agentColor(agent: Agent | undefined, fallback: string, index = 0, categorical: readonly any[] = []): any {
  if (!agent) return fallback
  if (/^#[0-9a-f]{6}$/i.test(agent.color)) return agent.color
  const scale: any = categorical[index % Math.max(1, categorical.length)]
  const themed = scale?.[200] ?? scale
  if (themed) return themed
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

/**
 * Verbatim line breaking for user text (slice C): wraps on width without
 * interpreting any Markdown — asterisks, backticks, and brackets survive
 * literally. Never pass user text through renderMarkdownLines.
 */
export function renderVerbatimLines(value: string, width: number): string[] {
  const raw = value.replace(/\r\n/g, "\n").split("\n")
  const output: string[] = []
  for (const line of raw) output.push(...wrapLine(line || " ", width))
  return output
}


export function transcriptRole(role: string): "user" | "agent" | "system" {
  if (role === "user") return "user"
  if (role === "system") return "system"
  return "agent"
}

/**
 * Slice C attribution grammar (ticket #59, brief §2.2 — verbatim strings).
 * Every helper is pure and returns the exact line/header text; callers
 * render it once per assignment/turn/answer and never re-derive it.
 */

/** One system line per assignment, naming the owning agent. */
export function assignmentLine(agentName: string, title: string): string {
  return `→ Assigned to $${agentName}: ${title || "(untitled)"}`
}

/** Live activity variant while a peer turn is in flight. */
export function askingLine(agentName: string): string {
  return `Asking $${agentName}…`
}

/** Header for a landed relayed answer, keeping author attribution. */
export function answerHeader(agentName: string): string {
  return `Answer from $${agentName}`
}

export type SystemLineKind = "routine" | "failure" | "notice"

/**
 * System-line glyph grammar (brief §2.2): routine/queue events use `◷`,
 * failures use `✕`, notices use `ⓘ`. Terminal work announcements keep
 * their own `●/✕/⊘` grammar in workrows.ts; this covers the rest.
 */
export function systemLine(kind: SystemLineKind, text: string): string {
  if (kind === "failure") return `✕ ${text}`
  if (kind === "notice") return `ⓘ ${text}`
  return `◷ ${text}`
}

/** Queued suffix for parked user lines; user-owned lines add `[x remove]`. */
export function queuedSuffix(removable: boolean): string {
  return removable ? " · queued · [x remove]" : " · queued"
}

/** Which transcript surface a line renders on. Only direct (DM) surfaces own
 * parked user input; group messages (`Message`) carry no queued flag at all,
 * so a queued group row is impossible by construction. */
export type TranscriptSurface = "agent" | "workspace"

/** The `[x remove]` affordance renders on direct surfaces only. Group rows
 * keep the plain `· queued` flag even if a line carried the bit, so no dead
 * affordance is ever offered where `x` keeps its cancel-task binding. */
export function queuedRemovable(role: "user" | "agent" | "system", surface: TranscriptSurface): boolean {
  return role === "user" && surface === "agent"
}

/** Header suffix for a transcript line on a surface: empty unless queued. */
export function headerQueuedSuffix(line: { queued?: boolean; role: "user" | "agent" | "system" }, surface: TranscriptSurface): string {
  if (!line.queued) return ""
  return queuedSuffix(queuedRemovable(line.role, surface))
}

/** True for the persisted per-assignment event (kind task with a task link). */
export function isAssignmentEvent(message: { kind?: string; taskID?: string }): boolean {
  return message.kind === "task" && Boolean(message.taskID)
}

/**
 * Correlation link for relayed answers (ticket #55 legs). A transcript
 * message with a correlation ID that matches a turn/handoff subtask answered
 * by the same agent IS the relay — render it once with the `Answer from`
 * header, never as a second independent turn or an extra task row.
 */
export function relayTaskForMessage(
  message: { correlationID?: string; agentID?: string },
  tasks: Subtask[],
): Subtask | undefined {
  if (!message.correlationID) return undefined
  return tasks.find((task) => {
    if (task.workKind !== "turn" && task.workKind !== "handoff") return false
    const correlation = task.turn?.correlationID ?? task.handoff?.correlationID
    if (!correlation || correlation !== message.correlationID) return false
    if (!message.agentID) return true
    const answeredBy = task.turn?.answeredByID ?? task.handoff?.answeredByID
    return message.agentID === (answeredBy ?? task.assigneeID)
  })
}
