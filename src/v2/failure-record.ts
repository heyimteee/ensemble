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
  | "restart"
  | "budget"
  | "internal"

/**
 * Ticket #163: a controlled dispatch-budget stop is a reason code, not a
 * generic task failure. Only the layer and counts are recorded; refusal copy,
 * task titles, instructions, and conversation text never enter the record.
 */
export type BudgetFailureLayer = "task" | "group" | "command" | "depth" | "fanout" | "continuation" | "closed"

export type BudgetFailure = {
  layer: BudgetFailureLayer
  used?: number
  max?: number
}

export const BUDGET_FAILURE_CODE = "budget-exhausted"

const BUDGET_LAYERS: readonly BudgetFailureLayer[] = ["task", "group", "command", "depth", "fanout", "continuation", "closed"]

function budgetNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : undefined
}

/**
 * Recognize a dispatch-budget refusal from either a structured error or the
 * shipped refusal copy. The result is deliberately narrow: a layer and, when
 * the copy carries it, the used/max pair.
 */
export function budgetFailureReason(error: unknown): BudgetFailure | undefined {
  const source = (error ?? {}) as Record<string, any>
  const code = String(source.code ?? "")
  const type = String(source.type ?? "")
  const structured = code === "dispatch_budget_exhausted"
    || type === "dispatch.budget.exhausted"
    || type === "dispatch.budget.refused"
  if (structured) {
    const layer = BUDGET_LAYERS.find((item) => item === source.layer) ?? "group"
    const used = budgetNumber(source.used)
    const max = budgetNumber(source.max)
    return {
      layer,
      ...(used !== undefined ? { used } : {}),
      ...(max !== undefined ? { max } : {}),
    }
  }
  const message = String(source.message ?? error ?? "")
  if (!/(dispatch budget|task budget|dispatch group|command budget|continuation limit|dispatch depth|per run)/i.test(message)) return undefined
  if (!/(exhausted|limit is reached|limit reached|limit is|less than|is closed)/i.test(message)) return undefined
  let layer: BudgetFailureLayer = "group"
  if (/task budget/i.test(message)) layer = "task"
  else if (/continuation limit|continuation group/i.test(message)) layer = "continuation"
  else if (/command budget/i.test(message)) layer = "command"
  else if (/dispatch group/i.test(message)) layer = "group"
  else if (/dispatch depth|depth limit/i.test(message)) layer = "depth"
  else if (/per run|fan-?out|delegation limit|handoff limit/i.test(message)) layer = "fanout"
  const counts = /\((\d+)\s*\/\s*(\d+)/.exec(message)
  return {
    layer,
    ...(counts ? { used: budgetNumber(Number(counts[1])), max: budgetNumber(Number(counts[2])) } : {}),
  }
}

export type FailureDecision =
  | { type: "retry"; attempt: number; maxAttempts: number; delayMs: number; retryAt: number; reason?: string }
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
  /** Restart/lease recovery evidence (ticket #149). */
  previousClaim?: string
  leaseExpiredAt?: number
  runID?: string
  sessionID?: string
  providerID?: string
  modelID?: string
  variant?: string
  startedAt?: number
  durationMs?: number
  toolOutcomes?: ToolOutcome[]
  lastMessages?: Message[]
  /** Explicit budget stop; inferred from a structured error or refusal copy when omitted. */
  budget?: BudgetFailure
  version?: number
  epoch?: number
  content?: boolean
}

const MAX_MESSAGE_TEXT = 4_000

/** Classify the error without pretending to know more than the host exposes. */
export function classifyFailure(error: unknown, fallback: FailureClass = "internal"): FailureClass {
  // Ticket #163: an explicit budget refusal is a controlled stop, never a
  // generic internal/provider failure.
  if (budgetFailureReason(error)) return "budget"
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
  const budget = input.budget ?? budgetFailureReason(input.error)
  // A recognized budget stop is never reported as a generic failure class.
  const failureClass: FailureClass = budget ? "budget" : input.failureClass
  return {
    level: input.level as LogLevel,
    event: input.event,
    cat: "failure",
    incidentID: input.incidentID,
    failureClass,
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
    // IDs, counts, and a reason code only; never the refusal copy or task content.
    ...(budget
      ? {
          reasonCode: BUDGET_FAILURE_CODE,
          budget: {
            layer: budget.layer,
            ...(budget.used !== undefined ? { used: budget.used } : {}),
            ...(budget.max !== undefined ? { max: budget.max } : {}),
          },
        }
      : {}),
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
    previousClaim: input.previousClaim,
    leaseExpiredAt: input.leaseExpiredAt,
    // The decision is the single source of truth for the retry/terminal cause.
    reason: input.decision.reason,
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
