import type { Agent, SnapshotState } from "./types.ts"
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

/** Spec handoff cap: one run fans out at most three hops. */
export const HANDOFF_MAX_PER_RUN = 3

/**
 * Ticket #71 mandatory completion handoff: every non-leader turn ends with a
 * handoff to another member (explicit, or automatic default to the workspace
 * leader). Completion chains are loop-guarded separately from the explicit
 * single-hop cap above: at most COMPLETION_CHAIN_MAX holders, no immediate
 * back-and-forth, repeated recipients reroute to the leader, and the depth
 * cap terminates the chain. Pending completions for one recipient coalesce
 * after COMPLETION_QUIET_WINDOW_MS into a single batch review turn.
 */
export const COMPLETION_CHAIN_MAX = 3
export const COMPLETION_QUIET_WINDOW_MS = 1_000

/** Per-item review actions for a batch review turn (ticket #71). */
export const REVIEW_ACTIONS = ["delegate", "start", "end", "dismiss"] as const
export type ReviewAction = (typeof REVIEW_ACTIONS)[number]

export type ReviewDecision = {
  item: string
  action: ReviewAction
  assignee?: string
  note?: string
  /** Required for `delegate`: direct dispatches the recipient may make. */
  maxHops?: number
}

export type CompletionRoute =
  | { decision: "route"; to: string }
  | { decision: "reroute"; to: string; reason: "ping-pong" | "repeated-recipient" }
  | { decision: "terminate"; reason: "depth-cap" }

/**
 * Loop-guard routing for a completion handoff. The default candidate is the
 * workspace leader; the leader stays the accountable end of the line (routing
 * home is never a ping-pong refusal), while any other repeating candidate
 * reroutes to the leader. Past the chain cap the handoff terminates instead
 * of queueing. Pure.
 */
export function checkCompletionRoute(input: {
  chain: string[]
  senderID: string
  candidateID: string
  leaderID: string
}): CompletionRoute {
  const chain = input.chain ?? []
  if (chain.length + 1 > COMPLETION_CHAIN_MAX) return { decision: "terminate", reason: "depth-cap" }
  const previous = chain.length > 0 ? chain[chain.length - 1] : undefined
  if (input.candidateID !== input.leaderID) {
    if (previous !== undefined && input.candidateID === previous) return { decision: "reroute", to: input.leaderID, reason: "ping-pong" }
    if (chain.includes(input.candidateID)) return { decision: "reroute", to: input.leaderID, reason: "repeated-recipient" }
  }
  return { decision: "route", to: input.candidateID }
}

/**
 * Idempotency key for one mandatory completion handoff: exactly one hop per
 * finished task per recipient for the row's lifetime. Pure.
 */
export function completionWorkKey(input: { workspaceID: string; finishedTaskID: string; recipientID: string }): string {
  return `completion:${input.workspaceID}:${input.finishedTaskID}:${input.recipientID}`
}

export type CompletionCandidate = {
  id: string
  workspaceID: string
  state: string
  workKind?: string
  assigneeID?: string
  createdAt: number
  /** Resolved dispatch group for this candidate (ticket #135). */
  dispatchGroupID?: string
  handoff?: { completion?: boolean; batch?: boolean; batchedIn?: string }
}

/**
 * Pending unbatched completion handoffs for one recipient, oldest first.
 * Only live completion hops count — replied rows, grouped items, batch
 * reviews, and other work kinds never consolidate. When a dispatch group is
 * given, only that group's completions are eligible: one command's review can
 * never keep another command's group alive. Pure.
 */
export function groupCompletionCandidates(
  tasks: CompletionCandidate[],
  workspaceID: string,
  recipientID: string,
  dispatchGroupID?: string,
): string[] {
  return tasks
    .filter(
      (task) =>
        task.workspaceID === workspaceID &&
        task.state === "pending" &&
        task.workKind === "handoff" &&
        task.assigneeID === recipientID &&
        task.handoff?.completion === true &&
        task.handoff?.batch !== true &&
        !task.handoff?.batchedIn &&
        (dispatchGroupID === undefined || task.dispatchGroupID === dispatchGroupID),
    )
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((task) => task.id)
}

export type CompletionItem = {
  id: string
  senderName: string
  title: string
  outcome: string
  path?: string
}

export function batchReviewTitle(count: number): string {
  return `Review ${count} completion${count === 1 ? "" : "s"}`
}

/**
 * Consolidated review listing: one line per pending completion with sender,
 * task title, outcome, and handoff path, plus the per-item action grammar.
 * Agents use `$Name`; `@` is file-only. Pure.
 */
export function batchReviewText(items: CompletionItem[], reviewerName: string): string {
  const lines = items.map((item) => {
    const path = item.path ? ` (@${item.path})` : ""
    return `- $${item.senderName} — ${item.title} (${item.outcome}, ref ${item.id})${path}`
  })
  return [
    `$${reviewerName}, ${batchReviewTitle(items.length).toLowerCase()} before continuing:`,
    ...lines,
    `Act per item with ensemble_review: delegate (name an assignee and a required maxHops budget), start, end, or dismiss. The batch closes only when every item is acted on or dismissed.`,
  ].join("\n")
}

/**
 * Structured per-item decisions for the review tool. `delegate` names an
 * assignee; `start`/`end`/`dismiss` take an optional note. Duplicate items
 * and unknown actions are refused. Pure.
 */
export function parseReviewDecisions(input: unknown): { ok: true; decisions: ReviewDecision[] } | { ok: false; reason: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, reason: "Review decisions must be an object with a decisions list." }
  const raw = (input as { decisions?: unknown }).decisions
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, reason: "Review decisions must name at least one item." }
  const seen = new Set<string>()
  const decisions: ReviewDecision[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { ok: false, reason: "Each review decision must name an item and an action." }
    const { item, action, assignee, note, maxHops } = entry as Record<string, unknown>
    if (typeof item !== "string" || !item.trim()) return { ok: false, reason: "Each review decision must name an item." }
    if (typeof action !== "string" || !(REVIEW_ACTIONS as readonly string[]).includes(action)) {
      return { ok: false, reason: `Unknown review action "${String(action)}"; use delegate, start, end, or dismiss.` }
    }
    if (seen.has(item)) return { ok: false, reason: `Item "${item}" is decided twice; decide each item once.` }
    seen.add(item)
    if (action === "delegate") {
      if (typeof assignee !== "string" || !assignee.trim()) {
        return { ok: false, reason: `Delegating item "${item}" must name an assignee.` }
      }
      // Ticket #162: review delegation follows the same required-budget path
      // as ensemble_delegate. A missing value is an explicit validation error,
      // never a silent group-remaining default.
      if (maxHops === undefined || maxHops === null) {
        return {
          ok: false,
          reason: `Delegating item "${item}" must include maxHops: the number of direct dispatches the recipient may make. Use maxHops: 0 for a one-shot ask.`,
        }
      }
      if (typeof maxHops !== "number" || !Number.isInteger(maxHops) || maxHops < 0) {
        return {
          ok: false,
          reason: `Delegating item "${item}" maxHops must be a non-negative integer. Use maxHops: 0 for a one-shot ask.`,
        }
      }
    }
    const decision: ReviewDecision = { item, action: action as ReviewAction }
    if (typeof assignee === "string" && assignee.trim()) decision.assignee = assignee.trim()
    if (typeof note === "string" && note.trim()) decision.note = note.trim()
    if (action === "delegate") decision.maxHops = maxHops as number
    decisions.push(decision)
  }
  return { ok: true, decisions }
}

/** The batch closes only when every consolidated item carries a disposition. Pure. */
export function batchAllDecided(itemIDs: string[], decidedBy: Record<string, string | undefined>): boolean {
  return itemIDs.every((id) => decidedBy[id] !== undefined)
}

export type HandoffFileData = {
  task: string
  /** Recipient-facing brief, self-authored by the sender. Never the user's verbatim words. */
  instruction?: string
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
      instruction: fields.instruction?.trim() || undefined,
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
 * ask from a different run is a different unit of work. A distinct tailored
 * brief is a distinct unit of work. Relay and failure-notice legs are
 * messages keyed by the hop correlation, not work rows, so control legs
 * never consume the run's fan-out budget.
 */
export function handoffWorkKey(input: {
  actor: string
  workspaceID: string
  parentID?: string
  recipientID: string
  task: string
  instruction?: string
  constraints?: string
  expected?: string
}): string {
  const run = runPrefixHash(input.parentID)
  const body = stableHash(
    [input.recipientID, (input.task ?? "").trim(), (input.instruction ?? "").trim(), (input.constraints ?? "").trim(), (input.expected ?? "").trim()].join("\0"),
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
  return `Handed to $${recipientName} for ${task} (ref ${correlationID}). Your turn stays open until the answer arrives here — do not call ensemble_delegate after a handoff (leader-only; would double-queue).`
}

/**
 * Ticket #73 concise group acknowledgement. Posted as `author: "system"`,
 * never as an agent bubble: a short `Handed to $Name · <label>` line with
 * no policy sentence and no correlation ref. Policy and the ref stay in the
 * tool result for the calling model. Pure. `$Name`, never `@Name`.
 */
export function handoffGroupAckText(recipientName: string, label: string): string {
  return `Handed to $${recipientName} · ${label}`
}

/**
 * Ticket #73 review framing for a single completion handoff. The leader
 * receives review work — who finished what, with what outcome, and where —
 * not a verbatim forward of the finished title and reply. Pure. `$Name`
 * for agents, `@` for the file reference only.
 */
export function completionReviewInstruction(input: { finisherName: string; title: string; content: string; path?: string }): string {
  const where = input.path ? ` (@${input.path})` : ""
  return `$${input.finisherName} finished "${input.title}"${where}. Review the finished turn and decide what happens next:\n\n${input.content}`
}

export function handoffDuplicateText(recipientName: string, task: string): string {
  return `Already handed to $${recipientName} for ${task}; your turn stays open until the answer arrives here.`
}

export function handoffFailureText(recipientName: string, reason: string, correlationID: string): string {
  return `Handoff to $${recipientName} failed: ${reason} (ref ${correlationID}).`
}

/**
 * Ticket #71 chain-cap notice: the mandatory completion handoff terminates
 * instead of queueing, so the chain cannot loop forever. The finished reply
 * already in the transcript stands as the record. `$Name`, never `@Name`.
 */
export function completionClosedText(finisherName: string, title: string, reason: string): string {
  return `Completion closed for $${finisherName}: ${title} — ${reason}. The finished reply above stands as the record.`
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
