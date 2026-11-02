import type { Agent, SnapshotState, Workspace } from "./types.ts"
import { runPrefixHash, stableHash } from "./queue.ts"

/**
 * Typed handoff protocol helpers (ticket #55), adapted from OpenBot's
 * handoff mechanics to Ensemble's subtask-as-work-item model.
 *
 * Adaptation notes (why these differ from OpenBot, if at all):
 * - OpenBot's durable unit is a generic `work_items` row with a `bot.message`
 *   kind and a derived lifecycle; the hop key is `hop:<runHash>:<bodyHash>`
 *   with `relay:`/`notice:` legs keyed on the hop. Ensemble persists one
 *   subtask row per unit of work, so the handoff hop IS a subtask with
 *   `workKind: "handoff"` and the same idempotency-key mechanics
 *   (`handoff:<workspace>:<actor>:<runHash>:<recipient>:<bodyHash>`; the run
 *   prefix is hashed, never raw). There is no parallel table and no second
 *   leg: the recipient's run posts its reply in the asking workspace
 *   transcript, which is the relay, attributed via the message `agentID`.
 *   Failure exhaustion posts a visible notice in the same transcript. Relay
 *   and notice legs are messages keyed by the hop correlation — not work
 *   rows — so control legs never consume the run's fan-out budget. One
 *   source of truth; no join, no drift.
 * - Agent mentions in chat use `$Name` (or `!Name`); `@` is reserved for
 *   workspace file references only. All copy built here follows that rule.
 */

export const HANDOFF_MARKER = "ensemble: handoff"
export const HANDOFF_CORRELATION_PREFIX = "handoff"

/** Spec handoff caps: chains stop after one hop, and one run fans out at most three hops. */
export const HANDOFF_MAX_DEPTH = 1
export const HANDOFF_MAX_PER_RUN = 3

export type HandoffFileData = {
  task: string
  summary?: string
  constraints?: string
  expected?: string
  to?: string
  correlationID?: string
}

export type HandoffParseOk = { ok: true; data: HandoffFileData }
export type HandoffParseFail = { ok: false; reason: string }
export type HandoffParse = HandoffParseOk | HandoffParseFail

function frontmatterBlock(content: string): string | undefined {
  const lines = content.split("\n")
  if (lines[0]?.trim() !== "---") return undefined
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (end <= 0) return undefined
  return lines.slice(1, end).join("\n")
}

function parseScalarFields(block: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of block.split("\n")) {
    const match = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/)
    if (!match) continue
    fields[match[1].toLowerCase()] = match[2].trim()
  }
  return fields
}

/**
 * Structural validation of a handoff file. Never a substring check: the file
 * must carry YAML-style frontmatter with `ensemble: handoff` and a non-empty
 * `task`. Returns the typed record or a human-readable refusal reason.
 */
export function parseHandoffFile(content: string): HandoffParse {
  const block = frontmatterBlock(content)
  if (!block) return { ok: false, reason: "The handoff file is missing valid frontmatter between --- markers." }
  const fields = parseScalarFields(block)
  if (fields.ensemble !== "handoff") return { ok: false, reason: "The handoff file must declare ensemble: handoff in its frontmatter." }
  const task = (fields.task ?? "").trim()
  if (!task) return { ok: false, reason: "The handoff file must include a non-empty task field." }
  return {
    ok: true,
    data: {
      task,
      summary: fields.summary?.trim() || undefined,
      constraints: fields.constraints?.trim() || undefined,
      expected: fields.expected?.trim() || undefined,
      to: fields.to?.trim() || undefined,
      correlationID: fields.correlation?.trim() || fields.correlationid?.trim() || undefined,
    },
  }
}

/**
 * Idempotency key for one handoff hop. Segments, in order: workspace scope,
 * the asking actor (sender), the hashed run prefix (never the raw parent
 * id), the addressed recipient, and a hash of the canonical typed
 * instruction. A retried or resubmitted handoff from the same run delivers
 * once — including against terminal rows, for the row's lifetime — while an
 * ask from a different run is a different unit of work. Relay and
 * failure-notice legs are messages keyed by the hop correlation, not work
 * rows, so control legs never consume the run's fan-out budget.
 */
export function handoffWorkKey(input: {
  actor: string
  workspaceID: string
  parentID?: string
  recipientID: string
  task: string
  constraints?: string
  expected?: string
}): string {
  const run = runPrefixHash(input.parentID)
  const body = stableHash(
    [input.recipientID, (input.task ?? "").trim(), (input.constraints ?? "").trim(), (input.expected ?? "").trim()].join("\0"),
  )
  return `handoff:${input.workspaceID}:${input.actor}:${run}:${input.recipientID}:${body}`
}

export function newCorrelationID(): string {
  return `${HANDOFF_CORRELATION_PREFIX}_${stableHash(`${Date.now()}\0${Math.random()}`)}`
}

export type HandoffRecipient =
  | { status: "ok"; agent: Agent }
  | { status: "unknown"; ref: string }
  | { status: "archived"; agent: Agent }
  | { status: "ambiguous"; ref: string; ids: string[] }

/**
 * Recipient resolution uses explicit naming only: id exact-match wins, else
 * one case-insensitive name match. Archived members resolve as archived
 * (refused, never routed); unknown or ambiguous refs are refused with the
 * name echoed, never guessed. Bare prose never assigns work.
 */
export function resolveHandoffRecipient(
  state: SnapshotState,
  workspace: Workspace,
  ref: string,
): HandoffRecipient {
  const trimmed = ref.trim()
  if (!trimmed) return { status: "unknown", ref }
  const byID = state.agents[trimmed]
  if (byID) {
    if (byID.archived) return { status: "archived", agent: byID }
    return { status: "ok", agent: byID }
  }
  const lowered = trimmed.toLowerCase()
  const named = Object.values(state.agents).filter((agent) => agent.name.toLowerCase() === lowered)
  if (named.length === 1) {
    const single = named[0]
    if (single.archived) return { status: "archived", agent: single }
    return { status: "ok", agent: single }
  }
  if (named.length > 1) return { status: "ambiguous", ref: trimmed, ids: named.map((agent) => agent.id) }
  return { status: "unknown", ref: trimmed }
}

export function handoffAckText(recipientName: string, task: string, correlationID: string): string {
  return `Handed to $${recipientName} for ${task} (ref ${correlationID}). The answer will arrive here.`
}

export function handoffDuplicateText(recipientName: string, task: string): string {
  return `Already handed to $${recipientName} for ${task}; the answer will arrive here.`
}

export function handoffFailureText(recipientName: string, reason: string, correlationID: string): string {
  return `Handoff to $${recipientName} failed: ${reason} (ref ${correlationID}).`
}

/**
 * Typed agent-to-agent direct-message envelope. Addressing (sender,
 * recipient, conversation scope), correlation (carried through queue legs),
 * ordering (per-conversation FIFO by `createdAt`), and delivery state
 * (`queued`/`sent`/`failed`, same vocabulary as the DM queue) travel with
 * the message instead of living in prose.
 */
export type DirectEnvelope = {
  messageID: string
  correlationID: string
  fromID: string
  toID: string
  workspaceID?: string
  text: string
  status: "queued" | "sent" | "failed"
  createdAt: number
}

export function newDirectEnvelope(input: {
  messageID: string
  fromID: string
  toID: string
  workspaceID?: string
  text: string
  status?: DirectEnvelope["status"]
  createdAt?: number
  correlationID?: string
}): DirectEnvelope {
  return {
    messageID: input.messageID,
    correlationID: input.correlationID ?? newCorrelationID(),
    fromID: input.fromID,
    toID: input.toID,
    workspaceID: input.workspaceID,
    text: input.text,
    status: input.status ?? "queued",
    createdAt: input.createdAt ?? Date.now(),
  }
}
