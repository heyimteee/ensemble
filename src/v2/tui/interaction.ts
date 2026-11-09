/**
 * v5.6 interaction foundation (tickets #79 and #86).
 *
 * A pure modal state machine: Normal, Insert, Visual (char/line), and Command
 * modes, focus, overlay, command input, pending chord, selection, and a
 * transient message. The reducer maps normalized events to the next state plus
 * adapter intents, so tests never render OpenTUI and the adapter stays thin.
 */

import {
  cyclePaneFocus,
  composeFromPane,
  enterPane,
  leaveComposerToPane,
  leavePaneInteraction,
  movePaneFocus,
  PANE_ORDER,
  recoverPaneFocus,
  type PaneFocus,
  type PaneID,
  type PaneMode,
  type PaneMove,
  type PaneVisibility,
} from "./panefocus.ts"

export type InteractionMode = "normal" | "insert" | "visual" | "command"

/**
 * Focus is separate from mode. Settings, wizards, dialogs, and help are
 * contexts, not extra modes; they reuse the same Normal grammar. The five
 * shell panes own select/interact; the composer is the one text target that
 * chat exposes deliberately with `i`.
 */
export type InteractionFocus =
  | PaneID
  | "composer"
  | "settings"
  | "wizard"
  | "dialog"
  | "help"

const PANE_IDS: ReadonlySet<string> = new Set(PANE_ORDER)

/** True for the five shell panes; false for composer and overlay contexts. */
export function isPaneFocus(focus: InteractionFocus): focus is PaneID {
  return PANE_IDS.has(focus)
}

export type InteractionOverlay = "none" | "settings" | "wizard" | "dialog" | "approvals" | "help" | "logs"

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
  /** Selected shell pane, independent of overlay/composer focus. */
  pane: PaneID
  /** Select chooses a pane; interact acts inside it. */
  paneMode: PaneMode
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
  | { type: "pane.move"; direction: PaneMove; visible?: PaneVisibility; workAtLast?: boolean; approvalsAtFirst?: boolean }
  | { type: "pane.enter" }
  | { type: "pane.escape" }
  | { type: "pane.compose" }
  | { type: "pane.cycle"; direction: 1 | -1; visible?: PaneVisibility }
  | { type: "pane.set"; pane: PaneID; mode?: PaneMode }
  | { type: "pane.recover"; visible?: PaneVisibility }
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
    focus: "agents",
    pane: "agents",
    paneMode: "select",
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

/** The pure pane state embedded in the interaction state. */
export function paneFocusOf(state: InteractionState): PaneFocus {
  return { pane: state.pane, mode: state.paneMode }
}

/** Apply one pure pane transition and mirror the focused pane into `focus`. */
function applyPaneFocus(state: InteractionState, next: PaneFocus): InteractionState {
  return { ...state, pane: next.pane, paneMode: next.mode, focus: next.pane }
}

/** A pane focus move blurs any editor and lands in select or interact as given. */
function setPane(state: InteractionState, next: PaneFocus): InteractionResult {
  return {
    state: applyPaneFocus(state, next),
    intents: [{ type: "blur-editor" }],
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
  // Ticket #180: the composer first returns to chat interaction; a pane in
  // interact returns to select. A select-mode Esc never moves focus.
  if (state.focus === "composer") {
    return {
      state: { ...state, ...paneFocusShell(leaveComposerToPane()), focus: "chat" },
      intents: [{ type: "blur-editor" }],
    }
  }
  if (isPaneFocus(state.focus)) {
    const next = leavePaneInteraction(paneFocusOf(state))
    if (next.mode === state.paneMode) return { state, intents: [{ type: "noop" }] }
    return { state: applyPaneFocus(state, next), intents: [{ type: "blur-editor" }] }
  }
  return { state, intents: [{ type: "noop" }] }
}

function paneFocusShell(next: PaneFocus): Pick<InteractionState, "pane" | "paneMode"> {
  return { pane: next.pane, paneMode: next.mode }
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
          // The composer only lives in chat; entering it is chat interaction.
          ...(target === "composer" ? { pane: "chat" as const, paneMode: "interact" as const } : {}),
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
          focus: "agents",
          pane: "agents",
          paneMode: "select",
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
          state: {
            ...state,
            mode: "normal",
            focus: "chat",
            ...paneFocusShell(leaveComposerToPane()),
            field: null,
            selection: null,
          },
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
      // Ticket #180: focus.set reaches a pane in select mode; Enter is the
      // only path into interaction, and composer focus is chat interaction.
      if (isPaneFocus(event.focus)) {
        return setPane(state, { pane: event.focus, mode: "select" })
      }
      if (event.focus === "composer") {
        return {
          state: { ...state, focus: "composer", pane: "chat", paneMode: "interact" },
          intents: [{ type: "focus-editor", target: "composer" }],
        }
      }
      return {
        state: { ...state, focus: event.focus },
        intents: [{ type: "blur-editor" }],
      }
    }
    case "pane.move": {
      const next = movePaneFocus(paneFocusOf(state), event.direction, {
        visible: event.visible,
        workAtLast: event.workAtLast,
        approvalsAtFirst: event.approvalsAtFirst,
      })
      return setPane(state, next)
    }
    case "pane.enter":
      return setPane(state, enterPane(paneFocusOf(state)))
    case "pane.escape": {
      const next = leavePaneInteraction(paneFocusOf(state))
      return setPane(state, next)
    }
    case "pane.compose": {
      const next = composeFromPane(paneFocusOf(state))
      if (!next.composer) return { state, intents: [{ type: "noop" }] }
      return {
        state: { ...applyPaneFocus(state, next.state), focus: "composer" },
        intents: [{ type: "focus-editor", target: "composer" }],
      }
    }
    case "pane.cycle":
      return setPane(state, cyclePaneFocus(paneFocusOf(state), event.direction, event.visible))
    case "pane.set":
      return setPane(state, { pane: event.pane, mode: event.mode ?? "select" })
    case "pane.recover": {
      const current = paneFocusOf(state)
      const next = recoverPaneFocus(current, event.visible)
      return next.pane === current.pane && next.mode === current.mode ? { state, intents: [] } : setPane(state, next)
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
