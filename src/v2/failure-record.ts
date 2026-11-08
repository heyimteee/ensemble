import type { LogEntry, LogLevel } from "./logging.ts"
import type { Message, Subtask } from "./types.ts"

/**
 * Self-contained failure records (ticket #145).
 *
 * A task row keeps only a short `error` string. Evidence needed to answer
 * "why did this fail?" — the error chain, provider/model, attempt, session,
 * tool outcomes, and surrounding messages — lives here instead, in one JSONL
 * record per failed attempt, park, and terminal failure.
 */
export type FailureClass =
  | "provider"
  | "timeout"
  | "tool"
  | "uncertain"
  | "approval"
  | "session"
  | "binding"
  | "handoff"
  | "init"
  | "empty-reply"
  | "internal"

export type FailureDecision =
  | { type: "retry"; attempt: number; maxAttempts: number; delayMs: number; retryAt: number }
  | { type: "terminal"; reason: string; attempt: number; maxAttempts: number }
  | { type: "park"; reason: string; approvalID?: string }
  | { type: "cancelled"; reason: string }

export type FailureEvent = "failure.attempt" | "failure.parked" | "failure.terminal"

export type ToolOutcome = {
  name: string
  status: string
  error?: string
  code?: string
}

export type FailureRecordInput = {
  event: FailureEvent
  level: LogLevel
  incidentID: string
  failureClass: FailureClass
  task: Subtask
  error: unknown
  decision: FailureDecision
  runID?: string
  sessionID?: string
  providerID?: string
  modelID?: string
  variant?: string
  startedAt?: number
  durationMs?: number
  toolOutcomes?: ToolOutcome[]
  lastMessages?: Message[]
  version?: number
  epoch?: number
  content?: boolean
}

const MAX_MESSAGE_TEXT = 4_000

/** Classify the error without pretending to know more than the host exposes. */
export function classifyFailure(error: unknown, fallback: FailureClass = "internal"): FailureClass {
  const source = (error ?? {}) as Record<string, any>
  const type = String(source.type ?? "")
  const code = String(source.code ?? "")
  const name = String(source.name ?? "")
  const message = String(source.message ?? error ?? "")
  const haystack = `${type} ${code} ${name} ${message}`.toLowerCase()
  if (/timeout|timed out|etimedout|deadline exceeded/.test(haystack)) return "timeout"
  if (type.startsWith("provider.") || /provider/.test(name.toLowerCase())) return "provider"
  if (/tool/.test(haystack)) return "tool"
  return fallback
}

function normalizeError(error: unknown, depth = 0): Record<string, unknown> {
  if (depth > 4) return { message: "[cause depth limit]" }
  if (error === undefined || error === null) return { message: "unknown error" }
  if (typeof error === "string") return { message: error }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(typeof (error as any).code === "string" ? { code: (error as any).code } : {}),
      ...(typeof (error as any).type === "string" ? { type: (error as any).type } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
      ...(error.cause !== undefined ? { cause: normalizeError(error.cause, depth + 1) } : {}),
    }
  }
  if (typeof error === "object") {
    const source = error as Record<string, unknown>
    return {
      name: typeof source.name === "string" ? source.name : undefined,
      message: typeof source.message === "string" ? source.message : "non-error failure",
      ...(typeof source.code === "string" ? { code: source.code } : {}),
      ...(typeof source.type === "string" ? { type: source.type } : {}),
      ...(typeof source.stack === "string" ? { stack: source.stack } : {}),
      ...(source.cause !== undefined ? { cause: normalizeError(source.cause, depth + 1) } : {}),
    }
  }
  return { message: String(error) }
}

function messageMetadata(messages: Message[], content: boolean): Array<Record<string, unknown>> {
  return messages.map((message) => ({
    messageID: message.id,
    seq: message.seq,
    author: message.author,
    agentID: message.agentID,
    kind: message.kind,
    taskID: message.taskID,
    correlationID: message.correlationID,
    chars: message.text.length,
    createdAt: message.createdAt,
    streaming: message.streaming === true,
    ...(content ? { text: message.text.slice(0, MAX_MESSAGE_TEXT) } : {}),
  }))
}

export function buildFailureRecord(input: FailureRecordInput): Omit<LogEntry, "ts" | "pid" | "role" | "instanceID" | "threadID"> & { ts?: string } {
  const { task } = input
  return {
    level: input.level as LogLevel,
    event: input.event,
    cat: "failure",
    incidentID: input.incidentID,
    failureClass: input.failureClass,
    taskID: task.id,
    workspaceID: task.workspaceID,
    dispatchGroupID: task.dispatchGroupID,
    parentID: task.parentID,
    title: task.title,
    workKind: task.workKind ?? "delegation",
    mode: task.mode,
    stage: task.stage,
    state: task.state,
    outcome: task.outcome,
    interrupted: task.interrupted,
    attempts: task.attempts,
    queueKey: task.queueKey,
    assigneeID: task.assigneeID,
    deadlineAt: task.deadlineAt,
    retryAfter: task.retryAfter,
    approvalID: task.approvalID,
    handling: task.handoff
      ? {
          correlationID: task.handoff.correlationID,
          senderID: task.handoff.senderID,
          recipientID: task.handoff.recipientID,
          depth: task.handoff.depth,
          completion: task.handoff.completion === true,
          batch: task.handoff.batch === true,
        }
      : task.turn
        ? {
            correlationID: task.turn.correlationID,
            askerKind: task.turn.askerKind,
            askerID: task.turn.askerID,
          }
        : undefined,
    error: normalizeError(input.error),
    runID: input.runID,
    sessionID: input.sessionID,
    model: input.providerID || input.modelID
      ? { providerID: input.providerID, modelID: input.modelID, variant: input.variant }
      : undefined,
    startedAt: input.startedAt,
    durationMs: input.durationMs,
    toolOutcomes: input.toolOutcomes,
    lastMessages: input.lastMessages ? messageMetadata(input.lastMessages, input.content === true) : undefined,
    decision: input.decision,
    version: input.version,
    epoch: input.epoch,
    ...(input.content
      ? {
          content: {
            instruction: task.instruction,
            constraints: task.constraints,
            expected: task.expected,
          },
        }
      : {}),
  }
}
