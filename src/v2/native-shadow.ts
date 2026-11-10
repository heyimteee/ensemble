import { stableHash } from "./queue.ts"
import type { BindingConversation, Id, NativeTurnPhase } from "./types.ts"
import type { NativeTextState } from "./native-turn.ts"

/**
 * Ticket #230: invisible shadow ingestion for `nativeFirst: "shadow"`.
 *
 * The shadow sink reuses the #215/#216 turn identities and pure text/router
 * helpers, but it never writes a durable row, publishes a patch, or routes
 * work. Only bounded, content-free comparison rows leave the sink.
 */

export const SHADOW_COMPARISON_LIMIT = 32

export type ShadowTurn = {
  turnID: Id
  sessionID: Id
  inboxID: Id
  conversation: BindingConversation
  channel: Id
  agentID: Id
  phase: NativeTurnPhase
  text: NativeTextState
  assistantMessageIDs: Id[]
  startedAt: number
  /** Routes the #219 planner would admit for the user message. */
  userRoutes: number
  /** Routes the planner would admit for the final agent text. */
  finalRoutes: number
}

/** In-memory shadow bookkeeping for one bound native session. */
export type ShadowSession = {
  /** Host enqueue order: shadow turns and skipped service prompts. */
  pending: Array<{ inboxID: Id; turn: boolean }>
  /** Turns answered by the session's current host execution. */
  executionTurns: Id[]
  /** The current execution belongs to a skipped/internal prompt. */
  executionSkip: boolean
  /** Assistant id -> the shadow turn it answers. */
  assistantTurns: Record<Id, Id>
  /** Queued turns delivered into a running execution (#229 parity). */
  steered: Id[]
  /** Execution starts observed before their enqueue (reordered host events). */
  pendingExecutions: number
}

/** One content-free comparison row. Never carries message text or paths. */
export type ShadowComparison = {
  sessionID: Id
  turnID: Id
  inboxID: Id
  conversationID: Id
  channelKind: "workspace" | "direct" | "home"
  phase: NativeTurnPhase
  /** Phase the terminal host event implies; a state-machine check. */
  expectedPhase: NativeTurnPhase
  phaseMatch: boolean
  textLength: number
  textDigest: string
  visibleTextLength?: number
  visibleTextDigest?: string
  /** Shadow never creates a visible durable turn. */
  visibleHasTurn: false
  textMatch: boolean
  plannedUserRoutes: number
  plannedFinalRoutes: number
  plannedRoutes: number
  /** The visible path routes nothing under shadow. */
  visibleRoutes: 0
  routingMatch: boolean
  at: number
}

/** Digest-only text identity. The caller must never pass this content on. */
export function shadowTextDigest(text: string): string {
  return stableHash(String(text ?? ""))
}

export function shadowChannelKind(conversation: BindingConversation): "workspace" | "direct" | "home" {
  return conversation.kind
}

/**
 * Build one bounded comparison row. `visibleText` is the pre-cutover native
 * context answer, used only to derive a length and digest here.
 */
export function buildShadowComparison(input: {
  turn: Pick<ShadowTurn, "turnID" | "sessionID" | "inboxID" | "conversation" | "channel" | "phase" | "userRoutes" | "finalRoutes">
  text: string
  visibleText?: string
  expectedPhase: NativeTurnPhase
  at: number
}): ShadowComparison {
  const text = String(input.text ?? "")
  const visible = input.visibleText === undefined ? undefined : String(input.visibleText)
  const plannedRoutes = input.turn.userRoutes + input.turn.finalRoutes
  const visibleRoutes = 0 as const
  return {
    sessionID: input.turn.sessionID,
    turnID: input.turn.turnID,
    inboxID: input.turn.inboxID,
    conversationID: input.turn.channel,
    channelKind: shadowChannelKind(input.turn.conversation),
    phase: input.turn.phase,
    expectedPhase: input.expectedPhase,
    phaseMatch: input.turn.phase === input.expectedPhase,
    textLength: text.length,
    textDigest: shadowTextDigest(text),
    ...(visible !== undefined
      ? { visibleTextLength: visible.length, visibleTextDigest: shadowTextDigest(visible) }
      : {}),
    visibleHasTurn: false,
    textMatch: visible !== undefined
      && visible.length === text.length
      && shadowTextDigest(visible) === shadowTextDigest(text),
    plannedUserRoutes: input.turn.userRoutes,
    plannedFinalRoutes: input.turn.finalRoutes,
    plannedRoutes,
    visibleRoutes,
    routingMatch: plannedRoutes === visibleRoutes,
    at: input.at,
  }
}
