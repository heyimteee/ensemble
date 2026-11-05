/**
 * v5.6 interaction foundation (tickets #79 and #86).
 *
 * A pure modal state machine: Normal, Insert, Visual (char/line), and Command
 * modes, focus, overlay, command input, pending chord, selection, and a
 * transient message. The reducer maps normalized events to the next state plus
 * adapter intents, so tests never render OpenTUI and the adapter stays thin.
 */

export type InteractionMode = "normal" | "insert" | "visual" | "command"

/**
 * Focus is separate from mode. Settings, wizards, dialogs, approvals, and
 * help are contexts, not extra modes; they reuse the same Normal grammar.
 */
export type InteractionFocus =
  | "rail"
  | "chat"
  | "work"
  | "composer"
  | "settings"
  | "wizard"
  | "dialog"
  | "approvals"
  | "help"

export type InteractionOverlay = "none" | "settings" | "wizard" | "dialog" | "approvals" | "help"

export type CommandInput = { kind: ":" | "/"; text: string }

import type { VimVisualSelection } from "./vim.ts"

/** The interaction selection is the Vim Visual range type (one shape). */
export type InteractionSelection = VimVisualSelection

/** The focused text buffer inside an overlay context, if any. */
export type InteractionField = "settings" | null

export type TransientTone = "info" | "success" | "error"

export type TransientMessage = { text: string; tone: TransientTone; at: number }

export type InteractionState = {
  mode: InteractionMode
  focus: InteractionFocus
  overlay: InteractionOverlay
  field: InteractionField
  command: CommandInput | null
  pendingChord: string | null
  selection: InteractionSelection | null
  message: TransientMessage | null
}

/** Which text buffer a dialog adapter should focus: a prompt or a wizard field. */
export type DialogFieldTarget = "prompt" | "wizard"

export type InteractionEvent =
  | { type: "insert.enter" }
  | { type: "field.enter"; target: DialogFieldTarget }
  | { type: "field.leave" }
  | { type: "escape" }
  | { type: "leave.editor" }
  | { type: "route.leave" }
  | { type: "settings.field.open" }
  | { type: "settings.field.close" }
  | { type: "focus.set"; focus: InteractionFocus }
  | { type: "overlay.set"; overlay: InteractionOverlay }
  | { type: "command.open"; kind: CommandInput["kind"]; text?: string }
  | { type: "command.update"; text: string }
  | { type: "command.close" }
  | { type: "chord.set"; chord: string }
  | { type: "chord.clear" }
  | { type: "selection.set"; selection: InteractionSelection }
  | { type: "selection.clear" }
  | { type: "visual.set"; selection: InteractionSelection }
  | { type: "visual.leave" }
  | { type: "message.show"; text: string; tone?: TransientTone; at: number }
  | { type: "message.clear" }

export type InteractionIntent =
  | { type: "focus-editor"; target?: DialogFieldTarget }
  | { type: "blur-editor" }
  | { type: "close-overlay"; overlay: InteractionOverlay }
  | { type: "wizard-back" }
  | { type: "noop" }

export type InteractionResult = { state: InteractionState; intents: InteractionIntent[] }

/** Default message lifetime: about three seconds, like a Vim status message. */
export const TRANSIENT_MESSAGE_MS = 3_000

export function initialInteractionState(overrides: Partial<InteractionState> = {}): InteractionState {
  return {
    mode: "normal",
    focus: "rail",
    overlay: "none",
    field: null,
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
 *
 * Dialogs follow the same ladder with one dialog-specific step: an Insert
 * field goes to field Normal first. Wizard field Normal then goes back one
 * step; every other dialog cancels. Closing never leaves Insert behind.
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
      intents: [],
    }
  }
  // Settings text fields sit above the settings overlay: Insert -> field
  // Normal -> settings Normal, and only then does the overlay close.
  if (state.field === "settings") {
    if (state.mode === "insert") {
      return { state: { ...state, mode: "normal" }, intents: [{ type: "blur-editor" }] }
    }
    return { state: { ...state, mode: "normal", field: null }, intents: [{ type: "blur-editor" }] }
  }
  if (state.overlay !== "none") {
    if (state.mode === "insert") {
      return { state: { ...state, mode: "normal" }, intents: [] }
    }
    if (state.overlay === "wizard") {
      return { state: { ...state, mode: "normal" }, intents: [{ type: "wizard-back" }] }
    }
    return {
      state: { ...state, overlay: "none", mode: "normal" },
      intents: [{ type: "close-overlay", overlay: state.overlay }],
    }
  }
  if (state.focus === "work") {
    return { state: { ...state, mode: "normal", focus: "chat" }, intents: [{ type: "blur-editor" }] }
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
      return {
        state: { ...state, mode: "insert", focus: "composer", selection: null },
        intents: [{ type: "focus-editor" }],
      }
    case "field.enter":
      return {
        state: { ...state, mode: "insert", selection: null },
        intents: [{ type: "focus-editor", target: event.target }],
      }
    case "field.leave":
      return { state: { ...state, mode: "normal", selection: null }, intents: [] }
    case "escape":
      return escape(state)
    case "route.leave":
      // Ticket #91: the page stays mounted for F2, but the native route owns
      // the keyboard. Drop every transient surface so a hidden Ensemble page
      // cannot consume a key or revisit a stale command/overlay on return.
      return {
        state: {
          ...state,
          mode: "normal",
          focus: state.focus === "rail" || state.focus === "chat" || state.focus === "work" || state.focus === "composer"
            ? state.focus
            : "rail",
          overlay: "none",
          field: null,
          command: null,
          pendingChord: null,
          selection: null,
          message: null,
        },
        intents: [{ type: "blur-editor" }],
      }
    case "leave.editor":
      if (state.field === "settings") {
        return {
          state: { ...state, mode: "normal", focus: "settings", field: null, selection: null },
          intents: [{ type: "blur-editor" }],
        }
      }
      // Wizards and prompt dialogs own the editor as their whole surface:
      // Ctrl+G leaves the field by going back a wizard step or cancelling the
      // prompt through the same typed intents Esc uses.
      if (state.overlay === "wizard") {
        return {
          state: { ...state, mode: "normal", selection: null },
          intents: [{ type: "blur-editor" }, { type: "wizard-back" }],
        }
      }
      if (state.overlay === "dialog") {
        return {
          state: { ...state, mode: "normal", overlay: "none", selection: null },
          intents: [{ type: "blur-editor" }, { type: "close-overlay", overlay: "dialog" }],
        }
      }
      return {
        state: { ...state, mode: "normal", focus: "chat", selection: null },
        intents: [{ type: "blur-editor" }],
      }
    case "settings.field.open":
      return {
        state: {
          ...state,
          mode: "insert",
          focus: "settings",
          overlay: "settings",
          field: "settings",
          selection: null,
        },
        intents: [{ type: "focus-editor" }],
      }
    case "settings.field.close":
      return {
        state: { ...state, mode: "normal", focus: "settings", field: null, selection: null },
        intents: [{ type: "blur-editor" }],
      }
    case "focus.set": {
      const composer = event.focus === "composer"
      const mode = composer && state.mode !== "visual" ? state.mode : "normal"
      const field = state.field !== null && event.focus !== "settings" ? null : state.field
      return {
        state: { ...state, focus: event.focus, mode, field, selection: null },
        intents: [{ type: composer && mode === "insert" ? "focus-editor" : "blur-editor" }],
      }
    }
    case "overlay.set": {
      const closing = state.overlay !== "none" && event.overlay === "none"
      const opening = event.overlay !== "none"
      return {
        state: {
          ...state,
          overlay: event.overlay,
          mode: opening || closing ? "normal" : state.mode,
          field: event.overlay === "none" || event.overlay !== "settings" ? null : state.field,
          selection: opening || closing ? null : state.selection,
        },
        intents: opening ? [{ type: "blur-editor" }] : [],
      }
    }
    case "command.open":
      return {
        state: {
          ...state,
          command: { kind: event.kind, text: event.text ?? "" },
          mode: "command",
          selection: null,
        },
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
    case "visual.set":
      return {
        state: { ...state, mode: "visual", selection: event.selection },
        intents: [],
      }
    case "visual.leave":
      return { state: { ...state, mode: "normal", selection: null }, intents: [] }
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
