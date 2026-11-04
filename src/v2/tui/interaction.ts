/**
 * v5.6 interaction foundation (ticket #79).
 *
 * A pure modal state machine: Normal and Insert modes, focus, overlay,
 * command input, pending chord, selection, and a transient message. The
 * reducer maps normalized events to the next state plus adapter intents, so
 * tests never render OpenTUI and the adapter stays thin.
 */

export type InteractionMode = "normal" | "insert"

/**
 * Focus is separate from mode. Settings, wizards, dialogs, approvals, and
 * help are contexts, not extra modes; they reuse the same Normal grammar.
 */
export type InteractionFocus =
  | "rail"
  | "chat"
  | "composer"
  | "settings"
  | "wizard"
  | "dialog"
  | "approvals"
  | "help"

export type InteractionOverlay = "none" | "settings" | "wizard" | "dialog" | "approvals" | "help"

export type CommandInput = { kind: ":" | "/"; text: string }

export type InteractionSelection = { kind: "char" | "line"; anchor: number; cursor: number }

export type TransientTone = "info" | "success" | "error"

export type TransientMessage = { text: string; tone: TransientTone; at: number }

export type InteractionState = {
  mode: InteractionMode
  focus: InteractionFocus
  overlay: InteractionOverlay
  command: CommandInput | null
  pendingChord: string | null
  selection: InteractionSelection | null
  message: TransientMessage | null
}

export type InteractionEvent =
  | { type: "insert.enter" }
  | { type: "escape" }
  | { type: "leave.editor" }
  | { type: "focus.set"; focus: InteractionFocus }
  | { type: "overlay.set"; overlay: InteractionOverlay }
  | { type: "command.open"; kind: CommandInput["kind"]; text?: string }
  | { type: "command.update"; text: string }
  | { type: "command.close" }
  | { type: "chord.set"; chord: string }
  | { type: "chord.clear" }
  | { type: "selection.set"; selection: InteractionSelection }
  | { type: "selection.clear" }
  | { type: "message.show"; text: string; tone?: TransientTone; at: number }
  | { type: "message.clear" }

export type InteractionIntent =
  | { type: "focus-editor" }
  | { type: "blur-editor" }
  | { type: "close-overlay"; overlay: InteractionOverlay }
  | { type: "noop" }

export type InteractionResult = { state: InteractionState; intents: InteractionIntent[] }

/** Default message lifetime: about three seconds, like a Vim status message. */
export const TRANSIENT_MESSAGE_MS = 3_000

export function initialInteractionState(overrides: Partial<InteractionState> = {}): InteractionState {
  return {
    mode: "normal",
    focus: "rail",
    overlay: "none",
    command: null,
    pendingChord: null,
    selection: null,
    message: null,
    ...overrides,
  }
}

/**
 * The Esc ladder. Esc always goes up one level and never quits:
 * command/selection/overlay first, then Insert -> composer Normal, then
 * composer Normal -> chat Normal, otherwise a no-op.
 */
function escape(state: InteractionState): InteractionResult {
  if (state.command) {
    return {
      state: { ...state, command: null, mode: "normal" },
      intents: [{ type: "blur-editor" }],
    }
  }
  if (state.selection) {
    return {
      state: { ...state, selection: null, mode: "normal" },
      intents: [{ type: "blur-editor" }],
    }
  }
  if (state.overlay !== "none") {
    return {
      state: { ...state, overlay: "none", mode: "normal" },
      intents: [{ type: "close-overlay", overlay: state.overlay }],
    }
  }
  if (state.focus === "composer") {
    if (state.mode === "insert") {
      return { state: { ...state, mode: "normal" }, intents: [{ type: "blur-editor" }] }
    }
    return { state: { ...state, mode: "normal", focus: "chat" }, intents: [{ type: "blur-editor" }] }
  }
  return { state, intents: [{ type: "noop" }] }
}

export function interactionReducer(state: InteractionState, event: InteractionEvent): InteractionResult {
  switch (event.type) {
    case "insert.enter":
      return { state: { ...state, mode: "insert", focus: "composer" }, intents: [{ type: "focus-editor" }] }
    case "escape":
      return escape(state)
    case "leave.editor":
      return { state: { ...state, mode: "normal", focus: "chat" }, intents: [{ type: "blur-editor" }] }
    case "focus.set": {
      const composer = event.focus === "composer"
      const mode = composer ? state.mode : "normal"
      return {
        state: { ...state, focus: event.focus, mode },
        intents: [{ type: composer && mode === "insert" ? "focus-editor" : "blur-editor" }],
      }
    }
    case "overlay.set":
      return {
        state: { ...state, overlay: event.overlay, mode: event.overlay === "none" ? state.mode : "normal" },
        intents: event.overlay === "none" ? [] : [{ type: "blur-editor" }],
      }
    case "command.open":
      return {
        state: { ...state, command: { kind: event.kind, text: event.text ?? "" }, mode: "normal" },
        intents: [{ type: "blur-editor" }],
      }
    case "command.update":
      return {
        state: state.command ? { ...state, command: { ...state.command, text: event.text } } : state,
        intents: [],
      }
    case "command.close":
      return { state: { ...state, command: null, mode: "normal" }, intents: [] }
    case "chord.set":
      return { state: { ...state, pendingChord: event.chord }, intents: [] }
    case "chord.clear":
      return { state: { ...state, pendingChord: null }, intents: [] }
    case "selection.set":
      return { state: { ...state, selection: event.selection }, intents: [] }
    case "selection.clear":
      return { state: { ...state, selection: null }, intents: [] }
    case "message.show":
      return {
        state: { ...state, message: { text: event.text, tone: event.tone ?? "info", at: event.at } },
        intents: [],
      }
    case "message.clear":
      return { state: { ...state, message: null }, intents: [] }
  }
}

/** The latest transient message, or null once its ~3 s lifetime has elapsed. */
export function visibleMessage(
  state: InteractionState,
  now: number,
  ttlMs: number = TRANSIENT_MESSAGE_MS,
): TransientMessage | null {
  const message = state.message
  if (!message) return null
  if (now - message.at > ttlMs) return null
  return message
}
