import type { EnsembleLogger } from "./logging.ts"
import { dispatchCommandRemainingFromRoot, dispatchRefusalReasonCode, type DispatchRefusal } from "./dispatch-budget.ts"
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
  root?: DispatchGroup
  refusal?: DispatchRefusal
}): { level: "info" | "warn"; event: string; fields: Record<string, unknown> } {
  const consumed = input.outcome === "consumed"
  const group = input.group
  const root = input.root ?? group
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
    commandUsedHops: root?.commandUsedHops,
    commandMaxHops: root?.commandMaxHops,
    commandRemaining: dispatchCommandRemainingFromRoot(root),
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
      reason: refusal ? dispatchRefusalReasonCode(refusal) : "refused",
      refusedLayer: refusal?.layer,
      refusedUsed: refusal?.used,
      refusedMax: refusal?.max,
    },
  }
}

/**
 * Ticket #162 dispatch-group lifecycle projection: continuation creation and
 * exhaustion are IDs, counts, and reason codes only. Task titles,
 * instructions, handoff paths, and conversation text must never enter these
 * rows.
 */
export function dispatchGroupEvent(input: {
  event: "continued" | "exhausted"
  group: DispatchGroup
  root?: DispatchGroup
  parent?: DispatchGroup
  reason: "continued" | "group-exhausted" | "command-exhausted"
}): { level: "info" | "warn"; event: string; fields: Record<string, unknown> } {
  const root = input.root ?? input.group
  const fields: Record<string, unknown> = {
    workspaceID: input.group.workspaceID,
    dispatchGroupID: input.group.id,
    rootID: input.group.rootID,
    parentID: input.group.parentID,
    continuationIndex: input.group.continuationIndex,
    usedHops: input.group.usedHops,
    maxHops: input.group.maxHops,
    groupRemaining: Math.max(0, input.group.maxHops - input.group.usedHops),
    commandUsedHops: root.commandUsedHops,
    commandMaxHops: root.commandMaxHops,
    commandRemaining: dispatchCommandRemainingFromRoot(root),
    continuationsUsed: root.continuationsUsed,
    maxContinuations: root.maxContinuations,
    reason: input.reason,
  }
  if (input.parent) {
    fields.parentUsedHops = input.parent.usedHops
    fields.parentMaxHops = input.parent.maxHops
    fields.parentCloseReason = input.parent.closeReason
  }
  if (input.event === "continued") {
    return { level: "info", event: "dispatch.group.continued", fields }
  }
  return { level: "warn", event: "dispatch.group.exhausted", fields }
}

export function createStoreObserver(logger: EnsembleLogger): StoreObserver {
  return {
    subtask(next, previous) {
      const base = taskIdentity(next)
      if (!previous) {
        logger.event("info", "task", "task.created", {
          ...base,
          // Ticket #218: a native turn's title is conversation content. Native
          // reconciliation and support logs carry ids, counts, and reason
          // codes only, so the title never enters this row.
          ...(next.origin === "native" ? {} : { title: next.title }),
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
          } else if (next.failure !== undefined && next.failure.kind !== "native") {
            // Ticket #170: delivery, lease, and attempt exhaustion are queue
            // causes. They derive `stalled`, stay mounted, and are never a
            // native failure. Emit structured codes only; error copy can carry
            // task or provider content and belongs in the failure sink.
            logger.event("warn", "task", "task.stalled", {
              ...fields,
              failureKind: next.failure.kind,
              reason: next.failure.reason,
              leaseUntil: next.leaseUntil,
              claimedBy: next.claimedBy,
            })
          } else {
            // `task.failed` is native-only. A legacy terminal row without the
            // structured field stays conservatively failed (#168).
            logger.event("error", "task", "task.failed", {
              ...fields,
              error: next.error,
              failureKind: next.failure?.kind,
              reason: next.failure?.reason,
            })
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
      // Ticket #163: sealing a group (a continuation seals its parent) is a
      // lifecycle event, not routine counter churn. Emit it at info with the
      // duration and reason code; exempt completion rows may still save later.
      if (next.closedAt !== undefined && previous.closedAt === undefined) {
        logger.event("info", "dispatch", "dispatch.group.closed", fields)
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

    messageRemoved(previous) {
      // Ticket #170: a superseded retry/failure notice is removed by its
      // structured field, never by copy matching. Only identity, counts, and
      // the notice kind enter the log.
      logger.event("info", "message", "message.removed", {
        ...messageFields(previous),
        notice: previous.notice,
      })
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
