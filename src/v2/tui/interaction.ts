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

export type CommandInput = { kind: ":" | "/"; text: string; cursor: number; returnMode: InteractionMode }

import { clampLineCursor } from "./line-editor.ts"
import type { VimVisualSelection } from "./vim.ts"

/** The interaction selection is the Vim Visual range type (one shape). */
export type InteractionSelection = VimVisualSelection

/** The focused text buffer inside an overlay context, if any. */
export type InteractionField = "settings" | "prompt" | "wizard" | null

/** Every text editor that can own the caret. */
export type InteractionEditor = "composer" | "settings" | "prompt" | "wizard"

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
  /** Editor that owned the caret when the current overlay opened. */
  overlayReturnEditor: InteractionEditor | null
}

/** Which text buffer a dialog adapter should focus: a prompt or a wizard field. */
export type DialogFieldTarget = "prompt" | "wizard"

export type InteractionEvent =
  | { type: "insert.enter"; target?: InteractionEditor }
  | { type: "field.enter"; target: DialogFieldTarget }
  | { type: "field.leave" }
  | { type: "editor.normal" }
  | { type: "escape" }
  | { type: "leave.editor" }
  | { type: "route.leave" }
  | { type: "settings.field.open" }
  | { type: "settings.field.close" }
  | { type: "focus.set"; focus: InteractionFocus }
  | { type: "overlay.set"; overlay: InteractionOverlay; returnEditor?: InteractionEditor }
  | { type: "command.open"; kind: CommandInput["kind"]; text?: string; cursor?: number }
  | { type: "command.update"; text: string; cursor?: number }
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
  | { type: "focus-editor"; target?: InteractionEditor }
  | { type: "blur-editor" }
  | { type: "close-overlay"; overlay: InteractionOverlay }
  | { type: "wizard-back" }
  | { type: "wizard-cancel" }
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
    overlayReturnEditor: null,
    ...overrides,
  }
}

/**
 * The editor that currently owns typing. A focused settings/prompt/wizard
 * field wins; otherwise the composer owns it only while no overlay covers it.
 * Wizard list steps, roster, chat, and the work list expose no text target.
 */
export function textTargetOf(state: InteractionState): InteractionEditor | null {
  if (state.field !== null) return state.field
  if (state.overlay === "none" && state.focus === "composer") return "composer"
  return null
}

/** True when Insert is honest but has nowhere to type. */
export function insertWithoutTarget(state: InteractionState): boolean {
  return state.mode === "insert" && textTargetOf(state) === null
}

export type CaretStyle = { style: "block" | "line"; blinking: boolean }

/**
 * Every text editor shares one caret model: a block in Normal so Vim motions
 * act on a visible character, and a line in Insert, Visual, and Command.
 * Carets never blink, and an unfocused editor paints none.
 */
export function caretStyleForMode(mode: InteractionMode): CaretStyle {
  return mode === "normal"
    ? { style: "block", blinking: false }
    : { style: "line", blinking: false }
}

export function caretForEditor(mode: InteractionMode, focused: boolean): CaretStyle | null {
  return focused ? caretStyleForMode(mode) : null
}

/**
 * The Esc ladder. Esc always goes up one level and never quits:
 * command closes to its return mode, a selection cancels, Insert/Visual
 * returns to Normal without blurring the focused editor, a focused field
 * returns to field Normal, then overlays close, then the composer returns to
 * chat. Nothing here assigns Normal except the explicit Esc keys.
 *
 * A field's first Esc leaves Insert but keeps the field focused; the next
 * leaves the field. Closing a wizard step goes back through a typed intent.
 */
function escape(state: InteractionState): InteractionResult {
  if (state.command) return closeCommand(state)
  if (state.selection) {
    return {
      state: { ...state, selection: null, mode: "normal" },
      intents: [],
    }
  }
  if (state.field !== null) {
    if (state.mode !== "normal") {
      return {
        state: { ...state, mode: "normal", selection: null },
        intents: [],
      }
    }
    // Field Normal: a settings field returns to the settings rows; a prompt
    // cancels; a wizard text field goes back one step. Only settings keeps
    // its overlay open.
    if (state.field === "prompt") {
      return {
        state: { ...state, field: null, overlay: "none" },
        intents: [{ type: "blur-editor" }, { type: "close-overlay", overlay: "dialog" }],
      }
    }
    if (state.field === "wizard") {
      return {
        state: { ...state, field: null },
        intents: [{ type: "blur-editor" }, { type: "wizard-cancel" }],
      }
    }
    return {
      state: { ...state, mode: "normal", field: null },
      intents: [{ type: "blur-editor" }],
    }
  }
  // Insert or Visual without a selection lands in Normal before any surface
  // movement. The focused editor (if any) keeps the caret.
  if (state.mode !== "normal") {
    return {
      state: { ...state, mode: "normal", selection: null },
      intents: [],
    }
  }
  if (state.overlay !== "none") {
    if (state.overlay === "wizard") {
      return { state, intents: [{ type: "wizard-cancel" }] }
    }
    return {
      state: { ...state, overlay: "none" },
      intents: [{ type: "close-overlay", overlay: state.overlay }],
    }
  }
  if (state.focus === "work") {
    return { state: { ...state, focus: "chat" }, intents: [{ type: "blur-editor" }] }
  }
  if (state.focus === "composer") {
    return { state: { ...state, focus: "chat" }, intents: [{ type: "blur-editor" }] }
  }
  return { state, intents: [{ type: "noop" }] }
}

/** Close the one-line command input and restore the mode it interrupted. */
function closeCommand(state: InteractionState): InteractionResult {
  if (!state.command) return { state, intents: [] }
  const next: InteractionState = { ...state, command: null, mode: state.command.returnMode }
  const target = textTargetOf(next)
  return {
    state: next,
    intents: target ? [{ type: "focus-editor", target }] : [],
  }
}

export function interactionReducer(state: InteractionState, event: InteractionEvent): InteractionResult {
  switch (event.type) {
    case "insert.enter": {
      const target = event.target ?? "composer"
      return {
        state: {
          ...state,
          mode: "insert",
          focus: target === "composer" ? "composer" : target === "settings" ? "settings" : state.focus,
          overlay: target === "settings" ? "settings" : state.overlay,
          field: target === "composer" ? null : target,
          selection: null,
        },
        intents: [{ type: "focus-editor", target }],
      }
    }
    case "field.enter":
      return {
        state: { ...state, field: event.target },
        intents: [{ type: "focus-editor", target: event.target }],
      }
    case "field.leave":
      return { state: { ...state, field: null, selection: null }, intents: [{ type: "blur-editor" }] }
    case "editor.normal":
      // Esc from an Insert or Visual field keeps the field focused: the raw
      // handler owns keys in Normal, so the caret must stay visible.
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
          overlayReturnEditor: null,
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
      if (state.field === "wizard" && state.overlay === "wizard") {
        return {
          state: { ...state, mode: "normal", field: null, selection: null },
          intents: [{ type: "blur-editor" }, { type: "wizard-back" }],
        }
      }
      if (state.field === "prompt" && state.overlay === "dialog") {
        return {
          state: { ...state, mode: "normal", field: null, overlay: "none", selection: null },
          intents: [{ type: "blur-editor" }, { type: "close-overlay", overlay: "dialog" }],
        }
      }
      if (state.focus === "composer") {
        return {
          state: { ...state, mode: "normal", focus: "chat", field: null, selection: null },
          intents: [{ type: "blur-editor" }],
        }
      }
      // Insert with no editor, or Ctrl+G outside an editor: leave Normal
      // behind without moving focus or closing the surrounding context.
      return {
        state: { ...state, mode: "normal", field: null, selection: null },
        intents: [{ type: "blur-editor" }],
      }
    case "settings.field.open":
      // Opening a field is a focus move, not an insert entry: it keeps the
      // current mode so the user presses i/a deliberately.
      return {
        state: {
          ...state,
          focus: "settings",
          overlay: "settings",
          field: "settings",
          selection: null,
        },
        intents: [{ type: "focus-editor", target: "settings" }],
      }
    case "settings.field.close":
      return {
        state: { ...state, focus: "settings", field: null, selection: null },
        intents: [{ type: "blur-editor" }],
      }
    case "focus.set": {
      // Mode is global: moving focus never assigns it. The editor focus moves
      // with the target; leaving an editor blurs it but keeps the mode.
      const target = event.focus === "composer" ? "composer" : null
      return {
        state: { ...state, focus: event.focus },
        intents: target ? [{ type: "focus-editor", target }] : [{ type: "blur-editor" }],
      }
    }
    case "overlay.set": {
      const opening = state.overlay !== event.overlay
      const closing = opening && event.overlay === "none"
      // Opening or closing an overlay leaves the editor context. The mode is
      // never assigned here; a field must be re-focused deliberately. Remember
      // which editor owned the caret so closing the overlay in Insert can put
      // the user back where they were instead of leaving every editor blurred.
      const returnEditor = opening
        ? event.returnEditor ?? state.overlayReturnEditor ?? (state.overlay === "none" && state.focus === "composer" ? "composer" : null)
        : state.overlayReturnEditor
      const next: InteractionState = {
        ...state,
        overlay: event.overlay,
        field: opening ? null : state.field,
        overlayReturnEditor: closing ? null : returnEditor,
      }
      const intents: InteractionIntent[] = opening ? [{ type: "blur-editor" }] : []
      if (closing) {
        const target = state.mode === "insert" ? state.overlayReturnEditor : null
        if (target) {
          next.field = target === "composer" ? null : target
          if (target === "composer" || target === "settings") next.focus = target
          intents.push({ type: "focus-editor", target })
        } else {
          const fallback = textTargetOf(next)
          if (fallback) intents.push({ type: "focus-editor", target: fallback })
        }
      }
      return { state: next, intents }
    }
    case "command.open": {
      const returnMode = state.mode === "command" ? state.command?.returnMode ?? "normal" : state.mode
      const text = event.text ?? ""
      return {
        state: {
          ...state,
          command: { kind: event.kind, text, cursor: clampLineCursor(text, event.cursor ?? text.length), returnMode },
          mode: "command",
          selection: null,
        },
        intents: [{ type: "blur-editor" }],
      }
    }
    case "command.update":
      return {
        state: state.command
          ? {
              ...state,
              command: {
                ...state.command,
                text: event.text,
                cursor: clampLineCursor(event.text, event.cursor ?? event.text.length),
              },
            }
          : state,
        intents: [],
      }
    case "command.close":
      return closeCommand(state)
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
