import type { Agent, BindingConversation, Message } from "./types.ts"
import { nativeTextForParts, type NativeTextState } from "./native-turn.ts"

/**
 * Ticket #231: one in-memory value owns a native session's turn lifecycle.
 *
 * The service keeps only two async gates outside this module: the per-session
 * event queue and the reconcile-run coalescer. Everything else — enqueue order,
 * execution owner, active turn, steering, text parts, row checkpoints, the
 * watchdog, delivery state, assistant-message mapping, and deferred child
 * settlement — lives in the per-session value below and mutates only through
 * the named transitions on `NativeIngestionState`.
 */

export const NATIVE_INBOX_ORDER_LIMIT = 64

export type NativeExecutionOwner = "turn" | "skip"

export type NativeInboxOrderEntry = { inboxID: string; turn: boolean }

/** The durable settlement target kept while a background child holds a turn. */
export type NativeSettlementTarget = {
  conversation: BindingConversation
  channel: string
  agent: Agent
  directory?: string
}

export type NativeRowState = {
  message: Message
  channel: string
  lastSave: number
  checkpointTimer?: ReturnType<typeof setTimeout>
}

export type NativeWatchdogState = { lastActivityAt: number; passes: number }

export type NativeDeferredSettlement = {
  target: NativeSettlementTarget
  at: number
  deadline: number
  timer?: ReturnType<typeof setTimeout>
}

/** Mutable per-session state. Read fields directly; mutate through transitions. */
export class NativeSessionState {
  /** Host enqueue order: native turns vs skipped service prompts. */
  order: NativeInboxOrderEntry[] = []
  /** Queued native inboxes not yet claimed by an execution. */
  pending: string[] = []
  /** Which kind owns the session's current host execution. */
  owner: NativeExecutionOwner | undefined
  /** Turns answered by the session's current host execution, in answer order. */
  executionTurns: string[] = []
  /** Queued turns the host delivered into an already-running execution. */
  steered: string[] = []
  /** Run id whose execution terminal was already observed on this session. */
  runSettled: string | undefined
  /** The turn currently answering in the session's execution. */
  activeTurn: string | undefined
  /** Execution starts seen before their enqueue. */
  pendingExecutions = 0
  /** Assistant message id to the native turn it answers. */
  assistantTurns = new Map<string, string>()
  /** In-memory authoritative text parts per turn; durable only at settle. */
  text = new Map<string, NativeTextState>()
  /** Durable streaming row per turn, so deltas never open a second row. */
  rows = new Map<string, NativeRowState>()
  /** Last local receipt and reconciliation count per open turn. */
  watchdog = new Map<string, NativeWatchdogState>()
  /** Parent turns held for a live background child, bounded. */
  deferred = new Map<string, NativeDeferredSettlement>()
  /** Delivery state per inbox; informational for now. */
  delivery = new Map<string, string>()

  orderHead(): NativeInboxOrderEntry | undefined {
    return this.order[0]
  }

  pendingHead(): string | undefined {
    return this.pending[0]
  }
}

export class NativeIngestionState {
  private readonly sessions = new Map<string, NativeSessionState>()

  /** Read without creating; most host events for unbound sessions use this. */
  peek(sessionID: string): NativeSessionState | undefined {
    return this.sessions.get(sessionID)
  }

  /** Read or create the one per-session value. */
  session(sessionID: string): NativeSessionState {
    let state = this.sessions.get(sessionID)
    if (!state) {
      state = new NativeSessionState()
      this.sessions.set(sessionID, state)
    }
    return state
  }

  sessionsSnapshot(): Array<[string, NativeSessionState]> {
    return [...this.sessions]
  }

  // ---- session.inbox.enqueued --------------------------------------------

  /**
   * Remember an enqueued prompt in host order. A native turn also joins the
   * pending queue; a skipped service prompt only occupies its order slot.
   */
  enqueue(sessionID: string, input: { inboxID: string; turn: boolean; pending?: boolean }): void {
    const state = this.session(sessionID)
    if (!state.order.some((item) => item.inboxID === input.inboxID)) {
      state.order.push({ inboxID: input.inboxID, turn: input.turn })
      while (state.order.length > NATIVE_INBOX_ORDER_LIMIT) state.order.shift()
    }
    if (input.pending && !state.pending.includes(input.inboxID)) state.pending.push(input.inboxID)
  }

  /** Claim the next execution's inbox in host order. */
  takeInbox(sessionID: string): NativeInboxOrderEntry | undefined {
    return this.session(sessionID).order.shift()
  }

  /** Drop one inbox that settled or cancelled before an execution claimed it. */
  forgetInbox(sessionID: string, inboxID: string): void {
    const state = this.peek(sessionID)
    if (!state) return
    state.order = state.order.filter((item) => item.inboxID !== inboxID)
  }

  /** Consume the pending queue through one inbox, matching host order. */
  consume(sessionID: string, inboxID: string): void {
    const state = this.peek(sessionID)
    if (!state) return
    const index = state.pending.indexOf(inboxID)
    if (index >= 0) state.pending.splice(0, index + 1)
  }

  /** An execution start arrived before its enqueue. */
  waitForExecution(sessionID: string): void {
    this.session(sessionID).pendingExecutions += 1
  }

  /** The matching enqueue consumes one reordered execution start. */
  takePendingExecution(sessionID: string): boolean {
    const state = this.peek(sessionID)
    if (!state || state.pendingExecutions <= 0) return false
    state.pendingExecutions -= 1
    return true
  }

  // ---- session.execution.started -----------------------------------------

  /**
   * Open a host execution. A new execution replaces the settled participants
   * and clears steering; a repeated start joins the open execution and keeps
   * steering. `owner` is always written so a skipped execution can be cleared
   * with `start(sessionID, {})`.
   */
  start(sessionID: string, input: { owner?: NativeExecutionOwner; turnID?: string; join?: boolean }): void {
    const state = this.session(sessionID)
    if (input.join) {
      if (input.turnID && !state.executionTurns.includes(input.turnID)) state.executionTurns.push(input.turnID)
    } else {
      state.executionTurns = input.turnID ? [input.turnID] : []
      state.steered = []
    }
    state.owner = input.owner
  }

  /**
   * Add a turn to the current execution without changing the owner. `replace`
   * mirrors the open-participant check: a settled execution is replaced, an
   * open one is joined.
   */
  joinExecution(sessionID: string, turnID: string, replace: boolean): void {
    const state = this.session(sessionID)
    if (replace) {
      state.executionTurns = [turnID]
      state.steered = []
      return
    }
    if (!state.executionTurns.includes(turnID)) state.executionTurns.push(turnID)
  }

  setActiveTurn(sessionID: string, turnID: string): void {
    this.session(sessionID).activeTurn = turnID
  }

  clearActiveTurn(sessionID: string): void {
    const state = this.peek(sessionID)
    if (state) state.activeTurn = undefined
  }

  markRunSettled(sessionID: string, runID: string): void {
    this.session(sessionID).runSettled = runID
  }

  // ---- session.text.started/delta/ended ----------------------------------

  /** Accumulate one text part and map its assistant message to the turn. */
  answer(
    sessionID: string,
    input: {
      turnID: string
      assistantID: string
      ordinal: number
      type: "started" | "delta" | "ended"
      text?: string
    },
  ): void {
    const state = this.session(sessionID)
    let text = state.text.get(input.turnID)
    if (!text) {
      text = {}
      state.text.set(input.turnID, text)
    }
    const part = (text[input.assistantID] ??= { started: [], deltas: {}, ended: {} })
    if (!part.started.includes(input.ordinal)) part.started.push(input.ordinal)
    if (input.type === "delta") {
      part.deltas[input.ordinal] = (part.deltas[input.ordinal] ?? "") + String(input.text ?? "")
    } else if (input.type === "ended") {
      part.ended[input.ordinal] = String(input.text ?? "")
    }
    state.assistantTurns.set(input.assistantID, input.turnID)
  }

  /** Rebuild only the final answer for a turn recovered from the transcript. */
  seedAnswer(sessionID: string, turnID: string, assistantID: string, answer: string): void {
    const state = this.session(sessionID)
    let text = state.text.get(turnID)
    if (!text) {
      text = {}
      state.text.set(turnID, text)
    }
    // The transcript answer is authoritative; discard any partial stream state
    // so settlement cannot read the transcript a second time.
    for (const key of Object.keys(text)) delete text[key]
    text[assistantID] = { started: [0], deltas: {}, ended: { 0: answer } }
  }

  textState(sessionID: string, turnID: string): NativeTextState | undefined {
    return this.peek(sessionID)?.text.get(turnID)
  }

  displayText(sessionID: string, turnID: string): string {
    return nativeTextForParts(this.textState(sessionID, turnID) ?? {})
  }

  // ---- session.inbox.delivered / delivery.changed ------------------------

  deliver(sessionID: string, inboxID: string, delivery: string): void {
    this.session(sessionID).delivery.set(inboxID, delivery)
  }

  /** Remember a queued turn the host delivered into a running execution. */
  steer(sessionID: string, inboxID: string): void {
    const state = this.session(sessionID)
    if (!state.steered.includes(inboxID)) state.steered.push(inboxID)
  }

  takeSteer(sessionID: string): string | undefined {
    return this.peek(sessionID)?.steered.shift()
  }

  // ---- settlement --------------------------------------------------------

  /**
   * Release execution or per-turn bookkeeping. Execution settlement clears
   * the participants and steering before the turns settle; per-turn settlement
   * releases text, the live row, the watchdog, a held child, assistant
   * mappings, the active marker, and any pending/order slot for its inbox.
   */
  settle(sessionID: string, input: {
    turnID?: string
    inboxID?: string
    assistantIDs?: readonly string[]
    execution?: boolean
  }): void {
    const state = this.peek(sessionID)
    if (!state) return
    if (input.execution) {
      state.executionTurns = []
      state.steered = []
    }
    if (input.turnID) {
      this.deleteTurn(sessionID, input.turnID, input.assistantIDs)
      // A settled turn always ends the session's current execution ownership.
      state.owner = undefined
    }
    if (input.inboxID) {
      state.steered = state.steered.filter((candidate) => candidate !== input.inboxID)
      this.consume(sessionID, input.inboxID)
      this.forgetInbox(sessionID, input.inboxID)
    }
  }

  /**
   * Drop every in-memory trace of one turn. The durable turn names the
   * assistant ids it recorded; without that list, remove every mapping owned by
   * the turn.
   */
  deleteTurn(sessionID: string, turnID: string, assistantIDs?: readonly string[]): void {
    const state = this.peek(sessionID)
    if (!state) return
    state.text.delete(turnID)
    state.watchdog.delete(turnID)
    const deferred = state.deferred.get(turnID)
    if (deferred?.timer !== undefined) clearTimeout(deferred.timer)
    state.deferred.delete(turnID)
    this.clearRow(sessionID, turnID)
    state.executionTurns = state.executionTurns.filter((id) => id !== turnID)
    if (state.activeTurn === turnID) state.activeTurn = undefined
    if (assistantIDs) {
      for (const assistantID of assistantIDs) state.assistantTurns.delete(assistantID)
      return
    }
    for (const [assistantID, mapped] of state.assistantTurns) {
      if (mapped === turnID) state.assistantTurns.delete(assistantID)
    }
  }

  // ---- reconciliation / adoption -----------------------------------------

  /** Adoption re-queues a recovered inbox and re-arms its watchdog. */
  reconcile(sessionID: string, input: { inboxID: string; turnID: string; turn?: boolean; at: number }): void {
    this.enqueue(sessionID, { inboxID: input.inboxID, turn: input.turn ?? true, pending: true })
    this.touchWatchdog(sessionID, input.turnID, input.at)
  }

  // ---- watchdog ----------------------------------------------------------

  touchWatchdog(sessionID: string, turnID: string, at: number): void {
    this.session(sessionID).watchdog.set(turnID, { lastActivityAt: at, passes: 0 })
  }

  /** Count one reconciliation read for a turn and return its new pass count. */
  beginWatchdogPass(sessionID: string, turnID: string, at: number): number {
    const state = this.session(sessionID)
    const watchdog = state.watchdog.get(turnID)
    if (!watchdog) return 0
    watchdog.passes += 1
    watchdog.lastActivityAt = at
    return watchdog.passes
  }

  forgetWatchdog(sessionID: string, turnID: string): void {
    this.peek(sessionID)?.watchdog.delete(turnID)
  }

  watchdog(sessionID: string, turnID: string): NativeWatchdogState | undefined {
    return this.peek(sessionID)?.watchdog.get(turnID)
  }

  /** Content-free support view of every watched turn, keyed by turn id. */
  watchdogDiagnostics(): Record<string, { passes: number; lastActivityAt: number; held?: boolean }> {
    const turns: Record<string, { passes: number; lastActivityAt: number; held?: boolean }> = {}
    for (const state of this.sessions.values()) {
      for (const [turnID, watchdog] of state.watchdog) {
        turns[turnID] = {
          passes: watchdog.passes,
          lastActivityAt: watchdog.lastActivityAt,
          ...(state.deferred.has(turnID) ? { held: true } : {}),
        }
      }
    }
    return turns
  }

  // ---- live row checkpoints ----------------------------------------------

  row(sessionID: string, turnID: string): NativeRowState | undefined {
    return this.peek(sessionID)?.rows.get(turnID)
  }

  setRow(sessionID: string, turnID: string, row: NativeRowState): void {
    this.session(sessionID).rows.set(turnID, row)
  }

  /** Cancel a pending trailing checkpoint and drop the live row bookkeeping. */
  clearRow(sessionID: string, turnID: string): void {
    const state = this.peek(sessionID)
    const row = state?.rows.get(turnID)
    if (!state || !row) return
    if (row.checkpointTimer !== undefined) clearTimeout(row.checkpointTimer)
    state.rows.delete(turnID)
  }

  // ---- deferred child settlement -----------------------------------------

  defer(sessionID: string, turnID: string, pending: NativeDeferredSettlement): void {
    this.session(sessionID).deferred.set(turnID, pending)
  }

  deferred(sessionID: string, turnID: string): NativeDeferredSettlement | undefined {
    return this.peek(sessionID)?.deferred.get(turnID)
  }

  /** Release one held turn, clearing its timer. Returns the held value. */
  releaseDeferred(sessionID: string, turnID: string): NativeDeferredSettlement | undefined {
    const state = this.peek(sessionID)
    const pending = state?.deferred.get(turnID)
    if (!state || !pending) return undefined
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    state.deferred.delete(turnID)
    return pending
  }

  hasDeferred(): boolean {
    for (const state of this.sessions.values()) {
      if (state.deferred.size > 0) return true
    }
    return false
  }

  /** Held turns for one session, or every held turn when no session is named. */
  deferredEntries(sessionID?: string): Array<{ sessionID: string; turnID: string; pending: NativeDeferredSettlement }> {
    const entries: Array<{ sessionID: string; turnID: string; pending: NativeDeferredSettlement }> = []
    for (const [currentSessionID, state] of this.sessions) {
      if (sessionID !== undefined && currentSessionID !== sessionID) continue
      for (const [turnID, pending] of state.deferred) {
        entries.push({ sessionID: currentSessionID, turnID, pending })
      }
    }
    return entries
  }

  // ---- session lifecycle -------------------------------------------------

  deleteSession(sessionID: string): void {
    const state = this.sessions.get(sessionID)
    if (!state) return
    for (const row of state.rows.values()) {
      if (row.checkpointTimer !== undefined) clearTimeout(row.checkpointTimer)
    }
    for (const pending of state.deferred.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer)
    }
    this.sessions.delete(sessionID)
  }

  /** Service stop: release every timer and drop every session value. */
  clear(): void {
    for (const sessionID of [...this.sessions.keys()]) this.deleteSession(sessionID)
  }
}
