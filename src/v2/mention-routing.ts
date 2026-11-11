import { DISPATCH_LIMIT_DEFAULTS, type DispatchLimits } from "./dispatch-budget.ts"

/**
 * Mention-safe routing grammar and policy (ADR 0011).
 *
 * Grammar:
 * - `$Name` routes work to a roster agent; `!Name` is the accepted legacy alias.
 * - A bare name is only a reference, and `@` stays a workspace file reference.
 * - `\$Name` / `\!Name` are literal text; an even number of backslashes leaves
 *   the operator live.
 *
 * Routing input is sanitized prose: fenced code blocks, inline code, URLs, and
 * file paths never produce a route. Names and IDs match a roster entry
 * case-insensitively and exactly; the longest candidate wins. Self, duplicate,
 * immediate reply-to-sender, fan-out, cycle, and ledger guards are applied by
 * `planMentionRouting`. A terminal turn (synthesis or review) treats every
 * mention as a reference and suppresses it before those guards run.
 *
 * This module is pure: it reads no store, clock, host, or environment. Callers
 * supply the message text, roster, conversation scope, settings, and ledger
 * snapshot. The message keeps its original text; sanitization only decides
 * where a routing operator is live.
 */

export type MentionOperator = "$" | "!"

export type MentionExclusionKind = "fenced-code" | "inline-code" | "url" | "file-path"

export type MentionExclusion = {
  kind: MentionExclusionKind
  /** Inclusive start offset in the original text. */
  start: number
  /** Exclusive end offset in the original text. */
  end: number
}

export type SanitizedMentionText = {
  /** Same length as the input; excluded spans become spaces, line breaks stay. */
  text: string
  excluded: MentionExclusion[]
}

export type MentionRosterEntry = {
  id: string
  name: string
  /** Workspace membership; absent means a member. The parser ignores it, the policy refuses non-members. */
  member?: boolean
  archived?: boolean
}

export type MentionMatchSource = "name" | "id"

export type MentionMatch = {
  agentID: string
  operator: MentionOperator
  source: MentionMatchSource
  /** The exact roster name or ID that matched, without the operator. */
  token: string
  start: number
  end: number
}

export type UnknownMention = {
  operator: MentionOperator
  token: string
  start: number
  end: number
}

export type SafeMentionParse = {
  /** Known roster references in prose order; duplicates are retained. */
  mentions: MentionMatch[]
  /** Unknown operator references in prose order, deduplicated by token. */
  unknown: UnknownMention[]
  excluded: MentionExclusion[]
}

type Candidate = {
  agentID: string
  token: string
  source: MentionMatchSource
  length: number
}

/**
 * Parse routing operators from sanitized prose only. A known roster name or ID
 * is a match; everything else with a live operator is an unknown reference.
 * Bare names and `@` never match. Escaped operators are literal text.
 */
export function parseSafeMentions(text: string, roster: readonly MentionRosterEntry[]): SafeMentionParse {
  const sanitized = sanitizeMentionText(text)
  const prose = sanitized.text
  const candidates = mentionCandidates(roster)
  const mentions: MentionMatch[] = []
  const unknown: UnknownMention[] = []
  const seenUnknown = new Set<string>()

  let index = 0
  while (index < prose.length) {
    const operator = prose[index]
    if ((operator !== "$" && operator !== "!") || escapedAt(prose, index) || !leftBoundary(prose, index)) {
      index++
      continue
    }

    const match = matchCandidate(prose, index + 1, candidates)
    if (match) {
      mentions.push({
        agentID: match.agentID,
        operator,
        source: match.source,
        token: match.token,
        start: index,
        end: index + 1 + match.token.length,
      })
      index += 1 + match.token.length
      continue
    }

    const word = /^[\p{L}][\p{L}\p{N}_]*(?:[.-][\p{L}\p{N}_]+)*/u.exec(prose.slice(index + 1))?.[0]
    if (!word || (operator === "$" && word === word.toUpperCase() && word.length > 1)) {
      index++
      continue
    }
    const key = `${operator}${word.toLowerCase()}`
    if (!seenUnknown.has(key)) {
      seenUnknown.add(key)
      unknown.push({ operator, token: word, start: index, end: index + 1 + word.length })
    }
    index += 1 + word.length
  }

  return { mentions, unknown, excluded: sanitized.excluded }
}

function mentionCandidates(roster: readonly MentionRosterEntry[]): Candidate[] {
  const candidates: Candidate[] = []
  for (const entry of roster) {
    for (const [source, token] of [["name", entry.name], ["id", entry.id]] as const) {
      if (!token) continue
      candidates.push({ agentID: entry.id, token, source, length: token.length })
    }
  }
  return candidates.sort(
    (a, b) =>
      b.length - a.length ||
      (a.source === b.source ? 0 : a.source === "name" ? -1 : 1) ||
      a.agentID.localeCompare(b.agentID),
  )
}

function matchCandidate(text: string, start: number, candidates: readonly Candidate[]): Candidate | undefined {
  for (const candidate of candidates) {
    const end = start + candidate.length
    if (end > text.length) continue
    if (text.slice(start, end).toLowerCase() !== candidate.token.toLowerCase()) continue
    if (rightBoundary(text, end)) return candidate
  }
  return undefined
}

/** A character before the operator that would make it part of a larger word. */
function leftBoundary(text: string, index: number): boolean {
  if (index === 0) return true
  return !/[$!]/u.test(text[index - 1]) && !/[\p{L}\p{N}_]/u.test(text[index - 1])
}

/** A character after a name that would extend it, so the name is only a prefix. */
function rightBoundary(text: string, end: number): boolean {
  const next = text[end]
  if (next === undefined) return true
  if (/[\p{L}\p{N}_-]/u.test(next)) return false
  if (next === "." && /[\p{L}\p{N}_]/u.test(text[end + 1] ?? "")) return false
  return true
}

function escapedAt(text: string, index: number): boolean {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) backslashes++
  return backslashes % 2 === 1
}

export type MentionConversation =
  | { kind: "group"; workspaceID: string; sessionAgentID: string }
  | { kind: "direct"; agentID: string; workspaceID?: string }

export type MentionLedgerSnapshot = {
  /** Hops consumed in the conversation's dispatch group. */
  groupUsed: number
  groupMax: number
  /** Depth the routed peer turn would occupy. */
  depth: number
  depthMax: number
  commandUsed?: number
  commandMax?: number
  closed?: boolean
}

export type MentionLedgerState = {
  groupUsed: number
  groupMax: number
  groupRemaining: number
  depth: number
  depthMax: number
  commandUsed?: number
  commandMax?: number
  commandRemaining?: number
  closed: boolean
}

/**
 * A `$Name` route is a peer turn: it consumes no hop and carries no
 * agent-authored task budget (ADR 0004, ADR 0011). The server derives any
 * budget for work the recipient starts; see `delegationTaskMaxHops`.
 */
export type PeerTurnBudget = {
  kind: "peer-turn"
  consumesHop: false
  taskMaxHops?: undefined
}

export const PEER_TURN_BUDGET: PeerTurnBudget = Object.freeze({ kind: "peer-turn", consumesHop: false })

export type MentionRoute = MentionMatch & { budget: PeerTurnBudget }

export type MentionSuppressionReason = "self" | "reply-to-sender" | "duplicate" | "already-routed" | "terminal-turn"

export type MentionSuppression = {
  agentID: string
  operator: MentionOperator
  token: string
  start: number
  end: number
  reason: MentionSuppressionReason
}

export type MentionRefusalReason =
  | "unknown"
  | "archived"
  | "not-a-member"
  | "direct-conversation"
  | "routing-disabled"
  | "cycle"
  | "budget"
  | "fan-out"

export type MentionBudgetLayer = "closed" | "group" | "depth" | "command"

export type MentionRefusal = {
  /** Absent for an unknown reference: no roster agent matched. */
  agentID?: string
  agentName?: string
  token: string
  operator: MentionOperator
  start: number
  end: number
  reason: MentionRefusalReason
  /** Present when reason is `budget`. */
  layer?: MentionBudgetLayer
  used?: number
  max?: number
}

export type MentionTurnBudget =
  | {
      kind: "workspace"
      limits: DispatchLimits
      ledger: MentionLedgerState
      groupRemaining: number
      commandRemaining?: number
      route: PeerTurnBudget
      /** Server-derived `maxHops` for a delegation or handoff inside a routed peer turn. */
      delegationTaskMaxHops: number
    }
  | {
      kind: "none"
      route: PeerTurnBudget
      delegationTaskMaxHops?: undefined
    }

export type MentionRoutingInput = {
  text: string
  conversation: MentionConversation
  /** The workspace roster, including non-members and archived agents for visible refusals. */
  roster: readonly MentionRosterEntry[]
  /** Per-message recipient cap. Normalized to at least one, matching the existing composer path. */
  fanOutCap: number
  /** Ceilings captured by the conversation's root dispatch group. */
  limits?: DispatchLimits
  /** Current ledger position. Omit for a fresh root group. */
  ledger?: MentionLedgerSnapshot
  /** Native mention-routing kill switch. Defaults on. */
  enabled?: boolean
  /** Author of the message. Sender matches are self-routes and are suppressed. */
  senderID?: string
  /** Sender of the turn this message answers; an immediate echo is suppressed. */
  replyToSenderID?: string
  /** Ancestor agents in the same dispatch group; routing back closes a cycle. */
  groupTrail?: readonly string[]
  /**
   * Ticket #236: recipients this native turn already contacted through a user
   * `$Name` route, an explicit delegation/handoff, a group post, or an
   * outside-roster approval. Suppressed with the distinct `already-routed`
   * reason so one turn contacts each recipient at most once.
   */
  alreadyRouted?: readonly string[]
  /**
   * Ticket #248: a synthesis, completion-review, or batch-review turn. Its
   * mentions are references, not work. Every roster mention is suppressed with
   * `terminal-turn` before the self, reply, roster, cycle, fan-out, and budget
   * guards; the final text still posts as the group message.
   */
  terminal?: boolean
}

export type MentionRoutingPlan = {
  /** The native turn's own recipient: the session agent in a group, or the direct agent. */
  addressee: string
  routes: MentionRoute[]
  suppressed: MentionSuppression[]
  refusals: MentionRefusal[]
  /**
   * Unknown operator references. Non-terminal plans also represent them in
   * `refusals` with reason `unknown`; a terminal turn leaves them as references.
   */
  unknown: UnknownMention[]
  excluded: MentionExclusion[]
  budget: MentionTurnBudget
}

/**
 * Apply the ADR 0011 routing policy to one message. Pure: all state is passed
 * in. The store's dispatch admission remains the authoritative ledger check;
 * this preflight exists so a refused route creates no work and can be shown
 * before any side effect.
 */
export function planMentionRouting(input: MentionRoutingInput): MentionRoutingPlan {
  const parse = parseSafeMentions(input.text, input.roster)
  const addressee = input.conversation.kind === "group" ? input.conversation.sessionAgentID : input.conversation.agentID
  const budget = mentionTurnBudget(input)
  const refusals: MentionRefusal[] = []
  const routes: MentionRoute[] = []
  const suppressed: MentionSuppression[] = []
  const seen = new Set<string>()
  const selfIDs = new Set([addressee, input.senderID].filter((value): value is string => Boolean(value)))
  const trail = new Set(input.groupTrail ?? [])

  if (input.conversation.kind === "direct") {
    for (const mention of uniqueByAgent(parse.mentions)) {
      refusals.push(refusalFor(mention, "direct-conversation"))
    }
    for (const unknown of parse.unknown) refusals.push(unknownRefusal(unknown))
    return {
      addressee,
      routes,
      suppressed,
      refusals: byPosition(refusals),
      unknown: parse.unknown,
      excluded: parse.excluded,
      budget,
    }
  }

  // Ticket #248: a terminal turn references recipients; it never routes them.
  // Suppress every occurrence before roster, cycle, fan-out, and budget checks
  // so a review cannot fan out into acknowledgments or visible refusals.
  if (input.terminal === true) {
    for (const mention of parse.mentions) {
      suppressed.push(suppressionFor(mention, "terminal-turn"))
    }
    return {
      addressee,
      routes,
      suppressed: byPosition(suppressed),
      refusals: byPosition(refusals),
      unknown: parse.unknown,
      excluded: parse.excluded,
      budget,
    }
  }

  if (input.enabled === false) {
    for (const mention of uniqueByAgent(parse.mentions)) {
      refusals.push(refusalFor(mention, "routing-disabled"))
    }
    for (const unknown of parse.unknown) refusals.push(unknownRefusal(unknown))
    return {
      addressee,
      routes,
      suppressed,
      refusals: byPosition(refusals),
      unknown: parse.unknown,
      excluded: parse.excluded,
      budget,
    }
  }

  const rosterByID = new Map(input.roster.map((entry) => [entry.id, entry]))
  const alreadyRouted = new Set(input.alreadyRouted ?? [])
  const budgetRefusal = ledgerRefusal(budget)
  const cap = normalizeFanOutCap(input.fanOutCap)

  for (const mention of parse.mentions) {
    if (seen.has(mention.agentID)) {
      suppressed.push(suppressionFor(mention, "duplicate"))
      continue
    }
    seen.add(mention.agentID)

    if (selfIDs.has(mention.agentID)) {
      suppressed.push(suppressionFor(mention, "self"))
      continue
    }
    if (input.replyToSenderID === mention.agentID) {
      suppressed.push(suppressionFor(mention, "reply-to-sender"))
      continue
    }
    // Contact already happened through an explicit tool, an earlier user
    // route, a group post, or an approval. Suppress before roster checks: the
    // work exists, so a later archive/membership change must not refuse it.
    if (alreadyRouted.has(mention.agentID)) {
      suppressed.push(suppressionFor(mention, "already-routed"))
      continue
    }

    const agent = rosterByID.get(mention.agentID)
    if (agent?.archived) {
      refusals.push(refusalFor(mention, "archived", agent.name))
      continue
    }
    if (agent?.member === false) {
      refusals.push(refusalFor(mention, "not-a-member", agent.name))
      continue
    }
    if (trail.has(mention.agentID)) {
      refusals.push(refusalFor(mention, "cycle", agent?.name))
      continue
    }
    if (budgetRefusal) {
      refusals.push({ ...refusalFor(mention, "budget", agent?.name), ...budgetRefusal })
      continue
    }
    if (routes.length >= cap) {
      refusals.push(refusalFor(mention, "fan-out", agent?.name))
      continue
    }
    routes.push({ ...mention, budget: PEER_TURN_BUDGET })
  }

  for (const unknown of parse.unknown) refusals.push(unknownRefusal(unknown))

  return {
    addressee,
    routes,
    suppressed: byPosition(suppressed),
    refusals: byPosition(refusals),
    unknown: parse.unknown,
    excluded: parse.excluded,
    budget,
  }
}

/**
 * Server-owned budget assignment. A peer turn spends no hop and carries no
 * task budget. Work the recipient starts is bounded by the smaller of the
 * group and command remaining, never by an agent-supplied value.
 */
export function assignPeerTurnBudget(input: {
  groupRemaining: number
  commandRemaining?: number
}): { route: PeerTurnBudget; delegationTaskMaxHops: number } {
  const groupRemaining = nonNegativeInteger(input.groupRemaining)
  const commandRemaining = input.commandRemaining === undefined ? undefined : nonNegativeInteger(input.commandRemaining)
  return {
    route: PEER_TURN_BUDGET,
    delegationTaskMaxHops: Math.min(groupRemaining, commandRemaining ?? groupRemaining),
  }
}

function mentionTurnBudget(input: MentionRoutingInput): MentionTurnBudget {
  if (input.conversation.kind === "direct" && input.conversation.workspaceID === undefined) {
    return { kind: "none", route: PEER_TURN_BUDGET }
  }
  const limits = input.limits ?? DISPATCH_LIMIT_DEFAULTS
  const ledger = normalizeLedger(input.ledger, limits)
  const assigned = assignPeerTurnBudget({
    groupRemaining: ledger.groupRemaining,
    commandRemaining: ledger.commandRemaining,
  })
  return {
    kind: "workspace",
    limits: { ...limits },
    ledger,
    groupRemaining: ledger.groupRemaining,
    ...(ledger.commandRemaining !== undefined ? { commandRemaining: ledger.commandRemaining } : {}),
    route: assigned.route,
    delegationTaskMaxHops: assigned.delegationTaskMaxHops,
  }
}

function normalizeLedger(
  ledger: MentionLedgerSnapshot | undefined,
  limits: DispatchLimits,
): MentionLedgerState {
  const groupMax = ledger ? nonNegativeInteger(ledger.groupMax) : nonNegativeInteger(limits.groupMaxHops)
  const groupUsed = ledger ? nonNegativeInteger(ledger.groupUsed) : 0
  const depth = ledger ? nonNegativeInteger(ledger.depth) : 1
  const depthMax = ledger ? nonNegativeInteger(ledger.depthMax) : nonNegativeInteger(limits.depth)
  const commandMax = nonNegativeInteger(ledger?.commandMax ?? limits.commandMaxHops)
  const commandUsed = nonNegativeInteger(ledger?.commandUsed ?? 0)
  return {
    groupUsed,
    groupMax,
    groupRemaining: Math.max(0, groupMax - groupUsed),
    depth,
    depthMax,
    commandUsed,
    commandMax,
    commandRemaining: Math.max(0, commandMax - commandUsed),
    closed: ledger?.closed === true,
  }
}

function ledgerRefusal(budget: MentionTurnBudget): Pick<MentionRefusal, "layer" | "used" | "max"> | undefined {
  if (budget.kind !== "workspace") return undefined
  const ledger = budget.ledger
  if (ledger.closed) return { layer: "closed", used: ledger.groupUsed, max: ledger.groupMax }
  if (ledger.groupUsed >= ledger.groupMax) return { layer: "group", used: ledger.groupUsed, max: ledger.groupMax }
  if (ledger.depth > ledger.depthMax) return { layer: "depth", used: ledger.depth, max: ledger.depthMax }
  if (
    ledger.commandUsed !== undefined &&
    ledger.commandMax !== undefined &&
    ledger.commandUsed >= ledger.commandMax
  ) {
    return { layer: "command", used: ledger.commandUsed, max: ledger.commandMax }
  }
  return undefined
}

function normalizeFanOutCap(value: number): number {
  return Math.max(1, nonNegativeInteger(value))
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

function uniqueByAgent(mentions: readonly MentionMatch[]): MentionMatch[] {
  const seen = new Set<string>()
  return mentions.filter((mention) => {
    if (seen.has(mention.agentID)) return false
    seen.add(mention.agentID)
    return true
  })
}

function refusalFor(
  mention: MentionMatch,
  reason: MentionRefusalReason,
  agentName?: string,
): MentionRefusal {
  return {
    agentID: mention.agentID,
    ...(agentName !== undefined ? { agentName } : {}),
    token: mention.token,
    operator: mention.operator,
    start: mention.start,
    end: mention.end,
    reason,
  }
}

function unknownRefusal(unknown: UnknownMention): MentionRefusal {
  return {
    token: unknown.token,
    operator: unknown.operator,
    start: unknown.start,
    end: unknown.end,
    reason: "unknown",
  }
}

function suppressionFor(mention: MentionMatch, reason: MentionSuppressionReason): MentionSuppression {
  return {
    agentID: mention.agentID,
    token: mention.token,
    operator: mention.operator,
    start: mention.start,
    end: mention.end,
    reason,
  }
}

function byPosition<T extends { start: number }>(items: T[]): T[] {
  return items.sort((a, b) => a.start - b.start)
}

/**
 * Mask fenced code blocks in place so offsets continue to address the original
 * text. Backtick and tilde fences close only with the same character and at
 * least the opening run length, per CommonMark. An unclosed fence masks to the
 * end of the message.
 */
export function sanitizeMentionText(text: string): SanitizedMentionText {
  const chars = text.split("")
  const excluded: MentionExclusion[] = []
  const mask = (start: number, end: number) => {
    for (let index = start; index < end; index++) {
      if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " "
    }
  }

  let open: { marker: string; length: number; start: number } | undefined
  let offset = 0
  for (const line of text.split("\n")) {
    const lineEnd = offset + line.length
    if (!open) {
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      if (match) open = { marker: match[1][0], length: match[1].length, start: offset }
    } else {
      const closer = new RegExp(`^ {0,3}${open.marker}{${open.length},}\\s*$`)
      if (closer.test(line)) {
        mask(open.start, lineEnd)
        excluded.push({ kind: "fenced-code", start: open.start, end: lineEnd })
        open = undefined
      }
    }
    offset = lineEnd + 1
  }
  if (open) {
    mask(open.start, text.length)
    excluded.push({ kind: "fenced-code", start: open.start, end: text.length })
  }

  const inlineMasked = chars.join("")
  maskInlineCode(inlineMasked, mask, excluded)
  const urlMasked = chars.join("")
  maskMarkdownDestinations(urlMasked, mask, excluded)
  const pathMasked = chars.join("")
  maskUrlsAndPaths(pathMasked, mask, excluded)
  excluded.sort((a, b) => a.start - b.start || a.end - b.end)
  return { text: chars.join(""), excluded }
}

function maskInlineCode(
  text: string,
  mask: (start: number, end: number) => void,
  excluded: MentionExclusion[],
): void {
  const inFence = (index: number) => excluded.some((span) => span.kind === "fenced-code" && index >= span.start && index < span.end)
  let index = 0
  while (index < text.length) {
    if (inFence(index) || text[index] !== "`") {
      index++
      continue
    }
    let openerLength = 0
    while (text[index + openerLength] === "`") openerLength++
    let cursor = index + openerLength
    let closed = -1
    while (cursor < text.length) {
      if (inFence(cursor) || text[cursor] !== "`") {
        cursor++
        continue
      }
      let run = 0
      while (text[cursor + run] === "`") run++
      if (run === openerLength) {
        closed = cursor
        break
      }
      cursor += run
    }
    if (closed < 0) {
      // CommonMark: an unmatched backtick run is literal text, not an opener.
      index += openerLength
      continue
    }
    const end = closed + openerLength
    mask(index, end)
    excluded.push({ kind: "inline-code", start: index, end })
    index = end
  }
}

function maskMarkdownDestinations(
  text: string,
  mask: (start: number, end: number) => void,
  excluded: MentionExclusion[],
): void {
  for (const match of text.matchAll(/\]\(\s*([^)\s]+)\s*\)/g)) {
    const destination = match[1]
    const start = (match.index ?? 0) + match[0].indexOf(destination)
    const end = start + destination.length
    mask(start, end)
    excluded.push({ kind: "url", start, end })
  }
}

function maskUrlsAndPaths(
  text: string,
  mask: (start: number, end: number) => void,
  excluded: MentionExclusion[],
): void {
  const url = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:|tel:)[^\s<>"']+/gi
  for (const match of text.matchAll(url)) {
    const start = match.index ?? 0
    const end = trimTrailingPunctuation(text, start, start + match[0].length)
    if (end <= start) continue
    mask(start, end)
    excluded.push({ kind: "url", start, end })
  }

  for (const match of text.matchAll(/\S+/g)) {
    const rawStart = match.index ?? 0
    const rawEnd = rawStart + match[0].length
    const start = trimLeadingPunctuation(text, rawStart, rawEnd)
    const end = trimTrailingPunctuation(text, start, rawEnd)
    if (end <= start) continue
    const token = text.slice(start, end)
    if (!looksLikePath(token)) continue
    if (token.replace(/[\\/]+/g, "").length === 0) continue
    const kind: MentionExclusionKind = /^(?:\/\/|(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?[\\/])/i.test(token)
      ? "url"
      : "file-path"
    mask(start, end)
    excluded.push({ kind, start, end })
  }
}

function looksLikePath(token: string): boolean {
  if (token.includes("/")) return true
  if (/^[A-Za-z]:\\/.test(token)) return true
  if (/^\\\\[^\\]+\\/.test(token)) return true
  return /[^\\]\\[^\\]/.test(token)
}

function trimLeadingPunctuation(text: string, start: number, end: number): number {
  let index = start
  while (index < end && /[([{'"`]/.test(text[index])) index++
  return index
}

function trimTrailingPunctuation(text: string, start: number, end: number): number {
  let index = end
  while (index > start && /[.,;:!?'")\]}>]/.test(text[index - 1])) index--
  return index
}
