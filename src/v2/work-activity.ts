/**
 * Version-neutral native work activity for Work cards (ticket #155).
 *
 * OpenCode exposes tool lifecycle events on the host bus. The service forwards
 * a bounded, privacy-safe label beside the durable patch feed; the TUI keeps a
 * per-task map and prefers the live label over the generic `working…` copy.
 * This module is dependency-free so the service bridge, the TUI, and their
 * tests share one mapper.
 */

/** One coalescing window: roughly four activity updates per second. */
export const WORK_ACTIVITY_COALESCE_MS = 250
/** Long enough for a readable card line, short enough for a narrow card. */
export const WORK_ACTIVITY_LABEL_MAX = 60
/** Leak bound when a clear event is lost; normal turns end far sooner. */
export const WORK_ACTIVITY_STALE_AFTER_MS = 10 * 60_000

export type WorkActivityStatus =
  | "called"
  | "progress"
  | "success"
  | "failed"
  | "thinking"
  | "writing"
  | "idle"
  | "terminal"

export type WorkActivity = {
  /** Service boot epoch; the TUI ignores foreign-epoch activity. */
  epoch: number
  workspaceID: string
  taskID: string
  sessionID: string
  /** Short display label, already bounded by this module. */
  label: string
  /** Tool name when the label came from a tool call. */
  tool?: string
  status: WorkActivityStatus | string
  /** Wall-clock update time in milliseconds. */
  updatedAt: number
}

export function thinkingActivityLabel(): string {
  return "thinking…"
}

export function writingReplyLabel(): string {
  return "writing reply…"
}

/** A terminal/idle/empty label never renders as live work. */
export function activityLabelIsClear(status: string | undefined, label: string | undefined): boolean {
  if (status === "idle" || status === "terminal") return true
  return typeof label !== "string" || label.trim().length === 0
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim().replace(/\s+/g, " ") ?? ""
}

function head(value: string, max: number): string {
  const line = firstLine(value)
  return line.length > max ? line.slice(0, max) : line
}

function basename(value: string): string {
  const trimmed = value.trim().replace(/[\\/]+$/, "")
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return index >= 0 ? trimmed.slice(index + 1) : trimmed
}

function agentRef(value: unknown): string {
  const raw = text(value).trim().replace(/^\$/, "")
  const first = raw.split(/\s+/, 1)[0]?.replace(/[^A-Za-z0-9._-]/g, "") ?? ""
  return first ? `$${first.slice(0, 32)}` : ""
}

function bound(label: string): string {
  return label.length > WORK_ACTIVITY_LABEL_MAX ? label.slice(0, WORK_ACTIVITY_LABEL_MAX) : label
}

/** Bound the tool name carried beside the label; never retain unbounded host text. */
export function boundedToolName(tool: string | undefined): string | undefined {
  const name = text(tool).trim()
  return name ? head(name, 40) : undefined
}

/**
 * Reduce a host tool input to the few display-only fields the mapper reads.
 * The service never retains raw file contents, patches, or command bodies:
 * path fields are stored as basenames and every string is bounded here.
 */
export function limitToolInput(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  const record = input as Record<string, unknown>
  const limited: Record<string, string> = {}
  const command = commandHead(record)
  if (command) limited.command = command
  const file = pathBase(record)
  if (file) limited.filePath = file
  const pattern = head(text(record.pattern), 44)
  if (pattern) limited.pattern = pattern
  const to = head(text(record.to), 32)
  if (to) limited.to = to
  const assignee = head(text(record.assignee), 32)
  if (assignee) limited.assignee = assignee
  return limited
}

/** Normalize namespaced tools: `ensemble_handoff`, `ensemble.handoff`, `handoff`. */
function toolKind(tool: string): string {
  return tool
    .trim()
    .toLowerCase()
    .replace(/^ensemble[._]/, "")
}

function commandHead(input: Record<string, unknown> | undefined): string {
  return head(text(input?.command), 44)
}

function pathBase(input: Record<string, unknown> | undefined): string {
  const file = basename(text(input?.filePath) || text(input?.path))
  return file.length > 64 ? file.slice(0, 64) : file
}

/**
 * Map a host tool name and its bounded input head to one short card label.
 * Only selected fields are read: command heads, basenames, search patterns,
 * and handoff/delegation recipients. File contents, patches, raw conversation
 * text, and full command lines never reach the label.
 */
export function toolActivityLabel(tool: string | undefined, input?: Record<string, unknown>): string {
  const name = text(tool).trim()
  if (!name) return thinkingActivityLabel()
  const kind = toolKind(name)
  switch (kind) {
    case "bash":
    case "shell":
    case "sh":
    case "zsh": {
      const command = commandHead(input)
      return bound(command ? `running ${command}…` : "running…")
    }
    case "read": {
      const file = pathBase(input)
      return bound(file ? `reading ${file}…` : "reading…")
    }
    case "grep":
    case "glob": {
      const pattern = head(text(input?.pattern), 44)
      return bound(pattern ? `searching ${pattern}…` : "searching…")
    }
    case "edit":
    case "write":
    case "patch":
    case "multiedit":
    case "apply_patch": {
      const file = pathBase(input)
      return bound(file ? `editing ${file}…` : "editing…")
    }
    case "handoff": {
      const target = agentRef(input?.to)
      return bound(target ? `handing off to ${target}…` : "handing off…")
    }
    case "delegate": {
      const target = agentRef(input?.assignee)
      return bound(target ? `delegating to ${target}…` : "delegating…")
    }
    case "task_status":
      return "checking task status…"
    default:
      return bound(`using ${head(name, 32)}…`)
  }
}

export function isWorkActivity(value: unknown): value is WorkActivity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  if (typeof entry.epoch !== "number" || !Number.isFinite(entry.epoch)) return false
  if (typeof entry.updatedAt !== "number" || !Number.isFinite(entry.updatedAt)) return false
  for (const field of ["workspaceID", "taskID", "sessionID", "label", "status"] as const) {
    if (typeof entry[field] !== "string" || (field !== "label" && entry[field].length === 0)) return false
  }
  if (entry.tool !== undefined && typeof entry.tool !== "string") return false
  return true
}

function isStale(entry: WorkActivity, now: number): boolean {
  return now - entry.updatedAt > WORK_ACTIVITY_STALE_AFTER_MS
}

/**
 * Apply one activity event to the TUI map. Clear statuses and empty labels
 * delete the task's entry. Identical duplicates keep the existing map
 * identity so a coalesced burst cannot repaint an unchanged card.
 */
export function applyWorkActivity(
  current: ReadonlyMap<string, WorkActivity>,
  event: WorkActivity,
  now = Date.now(),
): Map<string, WorkActivity> {
  const next = new Map(current)
  let changed = false
  for (const [taskID, entry] of next) {
    if (!isStale(entry, now)) continue
    next.delete(taskID)
    changed = true
  }
  const existing = next.get(event.taskID)
  // A late replayed event must never replace newer live activity.
  if (existing && event.updatedAt < existing.updatedAt) {
    return changed ? next : (current as Map<string, WorkActivity>)
  }
  if (activityLabelIsClear(event.status, event.label)) {
    if (!existing) return changed ? next : (current as Map<string, WorkActivity>)
    next.delete(event.taskID)
    return next
  }
  const label = bound(event.label)
  const updated: WorkActivity = { ...event, label }
  if (
    existing &&
    existing.label === updated.label &&
    existing.status === updated.status &&
    existing.tool === updated.tool &&
    existing.epoch === updated.epoch &&
    existing.sessionID === updated.sessionID
  ) {
    if (existing.updatedAt === updated.updatedAt) return changed ? next : (current as Map<string, WorkActivity>)
    next.set(event.taskID, { ...existing, updatedAt: updated.updatedAt })
    return next
  }
  next.set(event.taskID, updated)
  return next
}

/** Clear every task entry owned by one native session (idle/terminal races). */
export function clearWorkActivitiesForSession(
  current: ReadonlyMap<string, WorkActivity>,
  sessionID: string,
): Map<string, WorkActivity> {
  if (![...current.values()].some((entry) => entry.sessionID === sessionID)) {
    return current as Map<string, WorkActivity>
  }
  const next = new Map(current)
  for (const [taskID, entry] of next) {
    if (entry.sessionID === sessionID) next.delete(taskID)
  }
  return next
}

/**
 * Drop entries whose task is gone, terminal, or blocked on the user. Returns
 * the existing map when nothing changed, so a polling effect cannot repaint.
 */
export function pruneWorkActivities(
  current: ReadonlyMap<string, WorkActivity>,
  shouldClear: (entry: WorkActivity) => boolean,
): Map<string, WorkActivity> {
  let next: Map<string, WorkActivity> | undefined
  for (const [taskID, entry] of current) {
    if (!shouldClear(entry)) continue
    next ??= new Map(current)
    next.delete(taskID)
  }
  return next ?? (current as Map<string, WorkActivity>)
}

/** The live label for a task, or undefined when absent, cleared, or stale. */
export function workActivityLabel(
  entries: ReadonlyMap<string, WorkActivity>,
  taskID: string,
  now = Date.now(),
): string | undefined {
  const entry = entries.get(taskID)
  if (!entry) return undefined
  if (activityLabelIsClear(entry.status, entry.label)) return undefined
  if (isStale(entry, now)) return undefined
  return bound(entry.label)
}
