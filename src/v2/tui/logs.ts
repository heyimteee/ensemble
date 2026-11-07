import type { LogEntry, LogLevel } from "../logging.ts"

/**
 * Pure helpers for the `:logs` viewer (ticket #145). Rendering stays in the
 * app; filtering and one-line formatting live here so they can be tested
 * without a terminal.
 */
export type LogsViewFilter =
  | { kind: "all" }
  | { kind: "failures" }
  | { kind: "task"; taskID: string }

export function parseLogsCommand(args: readonly string[]): LogsViewFilter | { error: string } {
  if (args.length === 0) return { kind: "all" }
  if (args[0] === "failures" && args.length === 1) return { kind: "failures" }
  if (args[0] === "task") {
    const taskID = args[1]
    if (!taskID) return { error: "usage: :logs task <id>" }
    return { kind: "task", taskID }
  }
  return { error: "usage: :logs [failures | task <id>]" }
}

export function logsRpcInput(filter: LogsViewFilter, limit = 200): Record<string, unknown> {
  return {
    limit,
    ...(filter.kind === "failures" ? { cat: "failure" } : {}),
    ...(filter.kind === "task" ? { taskID: filter.taskID } : {}),
  }
}

export function logsTitle(filter: LogsViewFilter): string {
  if (filter.kind === "failures") return "Logs · failures"
  if (filter.kind === "task") return `Logs · ${filter.taskID}`
  return "Logs · recent"
}

const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 }

export function logEntryTone(level: LogLevel): "bad" | "warn" | "info" | "muted" | "faint" {
  if (level === "error") return "bad"
  if (level === "warn") return "warn"
  if (level === "info") return "info"
  if (level === "debug") return "muted"
  return "faint"
}

/** Compact one-line form: time, level, event, then only useful fields. */
export function formatLogEntry(entry: LogEntry): string {
  const time = typeof entry.ts === "string" ? entry.ts.slice(11, 19) : ""
  const head = `${time} ${String(entry.level).toUpperCase().padEnd(5)} ${String(entry.event ?? "")}`
  const details: string[] = []
  const error = entry.error
  if (error && typeof error === "object") {
    const message = (error as any).message
    if (message) details.push(`error=${String(message)}`)
  } else if (typeof error === "string" && error) {
    details.push(`error=${error}`)
  }
  const fields: Array<[string, unknown]> = [
    ["task", entry.taskID],
    ["ws", entry.workspaceID],
    ["group", entry.dispatchGroupID],
    ["attempt", entry.attempt],
    ["delay", entry.delayMs],
    ["retryAt", entry.retryAfter],
    ["state", entry.toState ?? entry.state],
    ["outcome", entry.toOutcome ?? entry.outcome],
    ["failure", entry.failureClass],
    ["decision", (entry.decision as any)?.type],
    ["approval", entry.approvalID],
    ["run", entry.runID],
    ["session", entry.sessionID],
    ["version", entry.version],
    ["entries", entry.entries],
    ["ms", entry.durationMs],
    ["reason", entry.reason],
  ]
  for (const [name, value] of fields) {
    if (value === undefined || value === null || value === "") continue
    const text = typeof value === "number" ? (Number.isInteger(value) ? String(value) : value.toFixed(1)) : String(value)
    details.push(`${name}=${text.length > 120 ? `${text.slice(0, 117)}…` : text}`)
  }
  return details.length > 0 ? `${head} · ${details.join(" ")}` : head
}

export function formatLogStats(stats: any): string {
  if (!stats) return "logs unavailable"
  const parts = [
    `level=${stats.level ?? "info"}`,
    `content=${stats.content ? "on" : "off"}`,
    `ring=${stats.ringSize ?? 0}`,
    `dropped=${stats.dropped ?? 0}`,
    `written=${stats.written ?? 0}`,
    `failedWrites=${stats.failedWrites ?? 0}`,
    stats.dir ? `dir=${stats.dir}` : "dir=(disabled)",
    stats.mainFile ? `main=${stats.mainFile}` : "",
    stats.failureFile ? `failures=${stats.failureFile}` : "",
    stats.lastError ? `lastError=${stats.lastError}` : "",
  ]
  return parts.filter(Boolean).join(" ")
}

/** Stable ordering for the viewer: oldest first, then level severity. */
export function sortLogEntries(entries: readonly LogEntry[]): LogEntry[] {
  return [...entries].sort((left, right) => {
    const time = String(left.ts).localeCompare(String(right.ts))
    if (time !== 0) return time
    return LEVEL_ORDER[left.level] - LEVEL_ORDER[right.level]
  })
}
