import type { EnsembleLogger } from "./logging.ts"
import type { DispatchRefusal } from "./dispatch-budget.ts"
import type { StoreObserver } from "./store.ts"
import type { Approval, DispatchGroup, InitJob, Message, Subtask } from "./types.ts"

/**
 * Domain-event projection for the store (ticket #145).
 *
 * The store is the one place every lifecycle mutation passes through: direct
 * RPC actions, retries, reaping, approvals, and agent tool calls all persist
 * through `saveSubtask`/`saveMessage`. Observing there means logging cannot
 * drift from the durable row, and no service branch can forget to log.
 *
 * Heartbeat writes only touch `leaseUntil`; they are deliberately ignored so
 * a long-running task produces one claim line, not one line per renewal.
 */
const TASK_STATE_FIELDS = ["state", "outcome", "interrupted", "stoppedAt", "finishedAt", "repliedAt"] as const
const TASK_CONTEXT_FIELDS = [
  "approvalID",
  "activeRunID",
  "awaitingChildren",
  "resultMessageID",
  "runSummary",
  "error",
  "attempts",
  "assigneeID",
  "stage",
  "retryAfter",
  "deadlineAt",
] as const

function changedFields(previous: Subtask, next: Subtask): string[] {
  const changed: string[] = []
  for (const field of TASK_STATE_FIELDS) {
    if (previous[field] !== next[field]) changed.push(field)
  }
  for (const field of TASK_CONTEXT_FIELDS) {
    if (previous[field] !== next[field]) changed.push(field)
  }
  return changed
}

function taskIdentity(task: Subtask): Record<string, unknown> {
  return {
    workspaceID: task.workspaceID,
    taskID: task.id,
    dispatchGroupID: task.dispatchGroupID,
    parentID: task.parentID,
    assigneeID: task.assigneeID,
    workKind: task.workKind ?? "delegation",
    mode: task.mode,
    stage: task.stage,
  }
}

function approvalEvent(previous: Approval | undefined, next: Approval): string {
  if (!previous) return "approval.requested"
  if (previous.status !== next.status) {
    if (next.resolution?.toLowerCase().includes("superseded")) return "approval.superseded"
    return "approval.resolved"
  }
  return "approval.updated"
}

function initEvent(previous: InitJob | undefined, next: InitJob): string {
  if (!previous) return "init.started"
  if (previous.state !== next.state && next.state !== "running") return "init.finished"
  return "init.updated"
}

/**
 * Dispatch ledger fields are IDs, counts, and limits only (ticket #160).
 * Task titles, instructions, handoff paths, file content, and conversation
 * text must never enter a dispatch event.
 */
function dispatchGroupFields(group: DispatchGroup, previous?: DispatchGroup): Record<string, unknown> {
  return {
    workspaceID: group.workspaceID,
    dispatchGroupID: group.id,
    rootID: group.rootID,
    parentID: group.parentID,
    continuationIndex: group.continuationIndex,
    fromUsedHops: previous?.usedHops,
    usedHops: group.usedHops,
    maxHops: group.maxHops,
    depthMax: group.depthMax,
    commandUsedHops: group.commandUsedHops,
    commandMaxHops: group.commandMaxHops,
    continuationsUsed: group.continuationsUsed,
    maxContinuations: group.maxContinuations,
    reconciled: group.reconciled === true,
    ...(group.closedAt !== undefined
      ? { closedAt: group.closedAt, durationMs: Math.max(0, group.closedAt - group.createdAt), closeReason: group.closeReason }
      : {}),
  }
}

function messageFields(message: Message): Record<string, unknown> {
  return {
    workspaceID: message.workspaceID,
    messageID: message.id,
    seq: message.seq,
    author: message.author,
    agentID: message.agentID,
    kind: message.kind,
    taskID: message.taskID,
    correlationID: message.correlationID,
    chars: message.text.length,
    streaming: message.streaming === true,
  }
}

/**
 * Ticket #161 hop projection: consumption and refusal are IDs, counts, and
 * reason codes only. Task titles, instructions, handoff paths, file content,
 * and conversation text must never enter these rows.
 */
export function dispatchHopEvent(input: {
  outcome: "consumed" | "refused"
  task: Pick<Subtask, "id" | "workspaceID" | "parentID" | "assigneeID" | "creatorAgentID" | "workKind" | "dispatchGroupID" | "taskMaxHops" | "dispatchDepth">
  group?: DispatchGroup
  refusal?: DispatchRefusal
}): { level: "info" | "warn"; event: string; fields: Record<string, unknown> } {
  const consumed = input.outcome === "consumed"
  const group = input.group
  const fields: Record<string, unknown> = {
    workspaceID: input.task.workspaceID,
    dispatchGroupID: input.task.dispatchGroupID,
    rootID: group?.rootID,
    taskID: input.task.id,
    parentID: input.task.parentID,
    actorID: input.task.creatorAgentID,
    recipientID: input.task.assigneeID,
    workKind: input.task.workKind ?? "delegation",
    taskMaxHops: input.task.taskMaxHops,
    dispatchDepth: input.task.dispatchDepth,
    usedHops: group?.usedHops,
    maxHops: group?.maxHops,
    groupRemaining: group ? Math.max(0, group.maxHops - group.usedHops) : undefined,
    commandUsedHops: group?.commandUsedHops,
    commandMaxHops: group?.commandMaxHops,
    commandRemaining: group?.commandMaxHops !== undefined && group.commandUsedHops !== undefined
      ? Math.max(0, group.commandMaxHops - group.commandUsedHops)
      : undefined,
    depthMax: group?.depthMax,
    continuationIndex: group?.continuationIndex,
  }
  if (consumed) {
    return { level: "info", event: "dispatch.hop.consumed", fields }
  }
  const refusal = input.refusal
  return {
    level: "warn",
    event: "dispatch.hop.refused",
    fields: {
      ...fields,
      reason: refusal ? `${refusal.layer}-exhausted` : "refused",
      refusedLayer: refusal?.layer,
      refusedUsed: refusal?.used,
      refusedMax: refusal?.max,
    },
  }
}

export function createStoreObserver(logger: EnsembleLogger): StoreObserver {
  return {
    subtask(next, previous) {
      const base = taskIdentity(next)
      if (!previous) {
        logger.event("info", "task", "task.created", {
          ...base,
          title: next.title,
          queueKey: next.queueKey,
          state: next.state,
          outcome: next.outcome,
        })
        return
      }
      const changed = changedFields(previous, next)
      if (changed.length === 0) return
      const fields: Record<string, unknown> = {
        ...base,
        fromState: previous.state,
        toState: next.state,
        fromOutcome: previous.outcome,
        toOutcome: next.outcome,
        changed,
        attempts: next.attempts,
        retryAfter: next.retryAfter,
        deadlineAt: next.deadlineAt,
      }
      if (next.state !== previous.state || next.outcome !== previous.outcome) {
        if (next.outcome === "failed" && previous.outcome !== "failed") {
          if (next.stoppedAt && next.stoppedAt !== previous.stoppedAt) {
            logger.event("info", "task", "task.cancelled", { ...fields, reason: next.error })
          } else {
            logger.event("error", "task", "task.failed", { ...fields, error: next.error })
          }
          return
        }
        if (next.state === "replied" && next.outcome === "succeeded" && previous.state !== "replied") {
          logger.event("info", "task", "task.completed", {
            ...fields,
            resultMessageID: next.resultMessageID,
            runSummary: next.runSummary,
          })
          return
        }
        logger.event("info", "task", "task.transition", fields)
        return
      }
      // Context-only changes (assignment, approval link, retry bookkeeping)
      // are debug detail; state/outcome transitions stay at info.
      logger.event("debug", "task", "task.updated", fields)
    },

    subtaskRemoved(previous) {
      logger.event("debug", "task", "task.removed", {
        ...taskIdentity(previous),
        state: previous.state,
        outcome: previous.outcome,
      })
    },

    dispatchGroup(next, previous) {
      const fields = dispatchGroupFields(next, previous)
      if (!previous) {
        logger.event("info", "dispatch", next.reconciled ? "dispatch.group.reconciled" : "dispatch.group.created", fields)
        return
      }
      logger.event("debug", "dispatch", "dispatch.group.updated", fields)
    },

    messageAppended(message) {
      logger.event("info", "message", "message.appended", messageFields(message))
    },

    messageSaved(next, previous) {
      if (!previous) {
        logger.event("info", "message", "message.appended", messageFields(next))
        return
      }
      if (previous.streaming && !next.streaming) {
        logger.event("info", "message", "message.finalized", {
          ...messageFields(next),
          interrupted: next.interrupted === true,
          durationMs: Math.max(0, (next.updatedAt ?? next.createdAt) - next.createdAt),
        })
        return
      }
      if (previous.text.length !== next.text.length || previous.interrupted !== next.interrupted) {
        logger.event("debug", "message", "message.updated", {
          ...messageFields(next),
          previousChars: previous.text.length,
        })
      }
    },

    approval(next, previous) {
      const event = approvalEvent(previous, next)
      const fields: Record<string, unknown> = {
        approvalID: next.id,
        workspaceID: next.workspaceID,
        taskID: next.subtaskID,
        agentID: next.agentID,
        kind: next.kind,
        source: next.source,
        fromStatus: previous?.status,
        status: next.status,
        resolution: next.resolution,
      }
      if (event === "approval.updated") logger.event("debug", "approval", event, fields)
      else if (event === "approval.superseded") logger.event("warn", "approval", event, fields)
      else logger.event("info", "approval", event, fields)
    },

    initJob(next, previous) {
      const event = initEvent(previous, next)
      const fields: Record<string, unknown> = {
        workspaceID: next.workspaceID,
        initJobID: next.id,
        messageID: next.messageID,
        sessionID: next.sessionID,
        fromState: previous?.state,
        state: next.state,
        error: next.error,
      }
      if (event === "init.finished" && next.state === "failed") logger.event("error", "task", event, fields)
      else if (event === "init.finished") logger.event("info", "task", event, fields)
      else if (event === "init.started") logger.event("info", "task", event, fields)
      else logger.event("debug", "task", event, fields)
    },
  }
}
